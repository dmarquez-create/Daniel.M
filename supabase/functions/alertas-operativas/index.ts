// Edge Function: alertas-operativas
//
// Resumen OPERATIVO diario (adicional al de KPIs de chat-alerts). Para cada
// agente, junta el trabajo pendiente en las zonas que trabaja y lo manda a su
// webhook de Google Chat:
//   1) Tickets ABIERTOS, sin visita registrada, con MÁS de 3 días sin atención.
//   2) Instalaciones PENDIENTES (anticipo pagado, sin servicio) sin visita.
//
// Fuentes de datos:
//   - En vivo desde MikroWisp vía la función mikrowisp-datos (tickets e
//     instalaciones). Reusa sus exclusiones de zona/motivo/R-E.
//   - BD Agenda (tabla `ordenes` en Supabase) para: (a) el mapa agente↔zona
//     del MES EN CURSO -> "agente principal" de cada zona (el que más órdenes
//     tiene ahí), y (b) el cruce de visita por id_cliente.
//
// Decisiones de negocio (confirmadas):
//   - "No visitado" (ticket)      = no existe orden tipo=Ticket para ese
//                                    id_cliente con fecha POSTERIOR a la del ticket.
//   - "Sin visita" (instalación)  = no existe orden tipo=Instalación para ese
//                                    id_cliente con fecha >= fecha_anticipo_pagado.
//   - Ruteo                        = solo al agente principal de la zona.
//   - Ventana del mapa de zonas    = solo el mes en curso.
//   - ">3 días"                    = hoy - fecha_generado (fecha_soporte) > 3.
//
// Body opcional (POST JSON):
//   { "dryRun": true }        -> calcula y devuelve el desglose SIN enviar.
//   { "agente": "Nombre" }    -> envía (o previsualiza) solo a ese agente.
//
// El disparo diario lo hace pg_cron (net.http_post) a las 16:00 UTC = 9:00 AM
// Chihuahua (UTC-7, sin horario de verano). Deploy con --no-verify-jwt.
//
// Requiere (ya presentes en Edge Functions): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, y el secret AGENT_WEBHOOKS_JSON (mismo de chat-alerts).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResp(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Solo se alertan instalaciones PENDIENTE cuyo anticipo se pagó en los últimos
// N días (evita repartir todo el backlog histórico de anticipos abandonados).
const INST_MAX_DIAS = 30;

// Recordatorio de servicio que acompaña cada alerta a los agentes.
const MENSAJE_SERVICIO =
  "Atender y dar solución a cada cliente es nuestra prioridad. Demos seguimiento a estos pendientes y mantengamos siempre informado al cliente del estatus de su servicio — la buena comunicación marca la diferencia. 💪";

// Webhooks por agente (mismo secret que chat-alerts). Ver chat-alerts/index.ts.
function loadAgentWebhooks(): Record<string, string> {
  const raw = Deno.env.get("AGENT_WEBHOOKS_JSON");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// Normaliza nombres (agentes) para comparar sin acentos/mayúsculas/espacios.
function normName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}
// Normaliza nombres de ZONA (varían de capitalización/acentos entre MikroWisp y la BD Agenda).
function normZona(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

// Días desde epoch (UTC) a partir de una fecha ISO/date/datetime. Sólo se usa
// para DIFERENCIAS de días, así que cualquier desfase constante se cancela.
function dayNum(v: unknown): number | null {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  const t = Date.parse(`${s}T00:00:00Z`);
  return isNaN(t) ? null : Math.floor(t / 86400000);
}

interface OrdenRow { zona?: string; agente?: string; id_cliente?: string | number; tipo?: string; fecha?: string; }

// Trae filas de `ordenes` con paginación (PostgREST tope 1000/req).
async function fetchOrdenes(query: string): Promise<OrdenRow[]> {
  const out: OrdenRow[] = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`${SUPA_URL}/rest/v1/ordenes?${query}&limit=1000&offset=${offset}`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    if (!res.ok) throw new Error(`ordenes ${res.status}: ${await res.text()}`);
    const rows = await res.json() as OrdenRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return out;
}

async function fetchMW(modulo: "tickets" | "instalaciones"): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${SUPA_URL}/functions/v1/mikrowisp-datos?modulo=${modulo}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  if (!res.ok) throw new Error(`mikrowisp-datos ${modulo} ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return (modulo === "tickets" ? d.tickets : d.instalaciones) ?? [];
}

interface TicketItem { cliente: string; zona: string; dias: number; motivo: string; id: string | number; }
interface InstItem { cliente: string; zona: string; dias: number | null; plan: string; id: string | number; }
interface AgenteBucket { tickets: TicketItem[]; inst: InstItem[]; }

function buildCard(agente: string, d: AgenteBucket, fechaLabel: string): object {
  const MAX = 10;
  const secciones: object[] = [];

  const ticketWidgets = d.tickets.slice(0, MAX).map((t) => ({
    keyValue: {
      topLabel: `${t.cliente} · ${t.zona}`,
      content: `🎫 #${t.id} · ${t.dias} días · ${t.motivo || "Sin motivo"}`,
      icon: "CLOCK",
    },
  }));
  if (d.tickets.length > MAX) ticketWidgets.push({ textParagraph: { text: `<i>+${d.tickets.length - MAX} tickets más…</i>` } } as never);
  secciones.push({
    header: `🔴 Tickets abiertos sin visita &gt;3 días (${d.tickets.length})`,
    widgets: ticketWidgets.length ? ticketWidgets : [{ textParagraph: { text: "Sin pendientes 🎉" } }],
  });

  const instWidgets = d.inst.slice(0, MAX).map((x) => ({
    keyValue: {
      topLabel: `${x.cliente} · ${x.zona}`,
      content: `📦 #${x.id} · ${x.dias != null ? `${x.dias} días` : "sin fecha"}`,
      icon: "DESCRIPTION",
    },
  }));
  if (d.inst.length > MAX) instWidgets.push({ textParagraph: { text: `<i>+${d.inst.length - MAX} instalaciones más…</i>` } } as never);
  secciones.push({
    header: `🟠 Instalaciones con anticipo sin visita (${d.inst.length})`,
    widgets: instWidgets.length ? instWidgets : [{ textParagraph: { text: "Sin pendientes 🎉" } }],
  });

  secciones.push({
    widgets: [{ textParagraph: { text: `<b>📣 Recordatorio de servicio</b><br>${MENSAJE_SERVICIO}` } }],
  });

  secciones.push({
    widgets: [{
      buttons: [{
        textButton: { text: "Ver Dashboard", onClick: { openLink: { url: "https://operaciones-nidix.vercel.app" } } },
      }],
    }],
  });

  return {
    cards: [{
      header: {
        title: `🔔 Pendientes del día — ${agente}`,
        subtitle: `${fechaLabel} · Dashboard Nidix`,
        imageUrl: "https://operaciones-nidix.vercel.app/icon-192.png",
      },
      sections: secciones,
    }],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    if (!SUPA_URL || !SERVICE) return jsonResp({ error: "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }, 500);

    const body = await req.json().catch(() => ({}));
    const dryRun = !!body.dryRun;
    const onlyAgente: string | null = body.agente ?? null;

    // Ventana del mes en curso (UTC; el cron corre 16:00 UTC = mismo día natural).
    const now = new Date();
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    const pad = (n: number) => String(n).padStart(2, "0");
    const monthStart = `${y}-${pad(m + 1)}-01`;
    const monthEnd = m === 11 ? `${y + 1}-01-01` : `${y}-${pad(m + 2)}-01`;
    const todayNum = dayNum(now.toISOString())!;
    const fechaLabel = now.toLocaleDateString("es-MX", { day: "2-digit", month: "long", year: "numeric", timeZone: "America/Chihuahua" });

    // Trae todo en paralelo.
    const [tickets, insts, mesRows, allRows] = await Promise.all([
      fetchMW("tickets"),
      fetchMW("instalaciones"),
      fetchOrdenes(`select=zona,agente&fecha=gte.${monthStart}&fecha=lt.${monthEnd}`),
      fetchOrdenes(`select=id_cliente,tipo,fecha&id_cliente=not.is.null`),
    ]);

    // Agente principal por zona (mes en curso): el agente con más órdenes en la zona.
    const zonaAgentes = new Map<string, Map<string, number>>();
    for (const r of mesRows) {
      const z = normZona(r.zona);
      const a = (r.agente ?? "").trim();
      if (!z || !a || normName(a) === "sin asignar") continue;
      if (!zonaAgentes.has(z)) zonaAgentes.set(z, new Map());
      const mm = zonaAgentes.get(z)!;
      mm.set(a, (mm.get(a) ?? 0) + 1);
    }
    const principal = new Map<string, string>(); // normZona -> agente canónico
    for (const [z, mm] of zonaAgentes) {
      let best: string | null = null, bc = -1;
      for (const [a, c] of mm) { if (c > bc) { bc = c; best = a; } }
      if (best) principal.set(z, best);
    }

    // Índice de visitas por cliente (TODO el histórico): días de órdenes Ticket / Instalación.
    const vis = new Map<string, { t: number[]; i: number[] }>();
    for (const r of allRows) {
      const id = String(r.id_cliente).trim();
      const dn = dayNum(r.fecha);
      if (dn == null) continue;
      if (!vis.has(id)) vis.set(id, { t: [], i: [] });
      const v = vis.get(id)!;
      if (r.tipo === "Ticket") v.t.push(dn);
      else if ((r.tipo ?? "").startsWith("Instalaci")) v.i.push(dn);
    }

    // Tickets pendientes: abiertos, >3 días, sin visita posterior.
    const ticketPend = (tickets as Record<string, unknown>[]).filter((t) => {
      if (t.estado === "cerrado") return false;
      const gd = dayNum(t.fecha_generado);
      if (gd == null) return false;
      if (todayNum - gd <= 3) return false;
      const v = vis.get(String(t.id).trim());
      if (v && v.t.some((d) => d > gd)) return false; // visitado después de abrir el ticket
      return true;
    });

    // Instalaciones pendientes: PENDIENTE, anticipo de los últimos INST_MAX_DIAS
    // días, sin visita de instalación tras el anticipo.
    const instPend = (insts as Record<string, unknown>[]).filter((x) => {
      if (x.instalado !== "PENDIENTE") return false;
      const ad = dayNum(x.fecha_anticipo_pagado);
      if (ad == null || todayNum - ad > INST_MAX_DIAS) return false;
      const v = vis.get(String(x.id).trim());
      if (v && v.i.some((d) => d >= ad)) return false;
      return true;
    });

    // Ruteo al agente principal de la zona.
    const perAgente = new Map<string, AgenteBucket>();
    const sinAsignar = { tickets: [] as TicketItem[], inst: [] as InstItem[] };
    const bucketOf = (a: string) => {
      if (!perAgente.has(a)) perAgente.set(a, { tickets: [], inst: [] });
      return perAgente.get(a)!;
    };
    for (const t of ticketPend) {
      const item: TicketItem = {
        cliente: String(t.nombre ?? "Sin nombre"), zona: String(t.zona ?? "Sin zona"),
        dias: todayNum - dayNum(t.fecha_generado)!, motivo: String(t.motivo_asunto ?? ""), id: t.id as string,
      };
      const a = principal.get(normZona(t.zona as string));
      if (a) bucketOf(a).tickets.push(item); else sinAsignar.tickets.push(item);
    }
    for (const x of instPend) {
      const ad = dayNum(x.fecha_anticipo_pagado);
      const item: InstItem = {
        cliente: String(x.nombre ?? "Sin nombre"), zona: String(x.zona ?? "Sin zona"),
        dias: ad != null ? todayNum - ad : null, plan: String(x.plan ?? ""), id: x.id as string,
      };
      const a = principal.get(normZona(x.zona as string));
      if (a) bucketOf(a).inst.push(item); else sinAsignar.inst.push(item);
    }

    // Orden interno: más días primero.
    for (const d of perAgente.values()) {
      d.tickets.sort((a, b) => b.dias - a.dias);
      d.inst.sort((a, b) => (b.dias ?? 0) - (a.dias ?? 0));
    }

    const resumen = [...perAgente.entries()]
      .map(([agente, d]) => ({ agente, tickets: d.tickets.length, instalaciones: d.inst.length, detalle: d }))
      .sort((a, b) => (b.tickets + b.instalaciones) - (a.tickets + a.instalaciones));

    if (dryRun) {
      return jsonResp({
        dryRun: true,
        mes: `${monthStart}..${monthEnd}`,
        totalTicketsAbiertosPend: ticketPend.length,
        totalInstPend: instPend.length,
        zonasConPrincipal: principal.size,
        sinAsignar: { tickets: sinAsignar.tickets.length, instalaciones: sinAsignar.inst.length, zonas: [...new Set([...sinAsignar.tickets, ...sinAsignar.inst].map((z) => z.zona))] },
        agentes: onlyAgente ? resumen.filter((r) => normName(r.agente) === normName(onlyAgente)) : resumen,
      });
    }

    // Envío real.
    const webhooks = loadAgentWebhooks();
    const whKeys = Object.keys(webhooks);
    let enviados = 0;
    const sinWebhook: string[] = [];
    const errores: string[] = [];
    for (const [agente, d] of perAgente) {
      if (d.tickets.length === 0 && d.inst.length === 0) continue;
      if (onlyAgente && normName(onlyAgente) !== normName(agente)) continue;
      const key = whKeys.find((k) => normName(k) === normName(agente));
      if (!key) { sinWebhook.push(agente); continue; }
      const res = await fetch(webhooks[key], {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCard(agente, d, fechaLabel)),
      });
      if (res.ok) enviados++; else errores.push(`${agente}: ${res.status}`);
    }

    return jsonResp({
      ok: true, enviados, sinWebhook, errores,
      sinAsignar: { tickets: sinAsignar.tickets.length, instalaciones: sinAsignar.inst.length },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return jsonResp({ error: msg }, 500);
  }
});
