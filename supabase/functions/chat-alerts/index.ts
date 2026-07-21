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

// Agentes con sus webhooks de Google Chat. Viven en el secret
// AGENT_WEBHOOKS_JSON (Supabase → Edge Functions → Manage secrets), nunca
// hardcodeados aquí — son credenciales (key+token de Google Chat).
// Formato del secret: {"Nombre":"https://chat.googleapis.com/...","..."}
function loadAgentWebhooks(): Record<string, string> {
  const raw = Deno.env.get("AGENT_WEBHOOKS_JSON");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
const AGENT_WEBHOOKS: Record<string, string> = loadAgentWebhooks();

function semaforoEmoji(pct: number): string {
  if (pct >= 80) return "🟢";
  if (pct >= 70) return "🟡";
  return "🔴";
}

interface TopMotivo {
  motivo: string;
  count: number;
  pct: number;
}

function buildMessage(agente: string, kpis: {
  total: number;
  realizadas: number;
  pct: number;
  instalaciones: number;
  instalacionesPct: number;
  tickets: number;
  ticketsPct: number;
  topMotivosNoRealizado: TopMotivo[];
  topImposibilidad: string | null;
  topZonaBaja: string;
  mes: string;
}): object {
  const { total, realizadas, pct, instalaciones, instalacionesPct, tickets, ticketsPct, topMotivosNoRealizado, topImposibilidad, topZonaBaja, mes } = kpis;

  // Compatibilidad: si llega el formato viejo (topMotivoNoRealizado como string),
  // lo convertimos a la forma de arreglo para no romper llamadas antiguas.
  const motivos: TopMotivo[] = Array.isArray(topMotivosNoRealizado) ? topMotivosNoRealizado : [];

  const motivoWidgets = motivos.length > 0
    ? motivos.map((m, i) => ({
        keyValue: {
          topLabel: i === 0 ? "Principal motivo de no realizado" : "Segundo motivo de no realizado",
          content: `${m.motivo} (${m.pct}%)`,
          icon: "DESCRIPTION",
        },
      }))
    : [{
        keyValue: {
          topLabel: "Principal motivo de no realizado",
          content: "Sin datos",
          icon: "DESCRIPTION",
        },
      }];

  return {
    cards: [{
      header: {
        title: `📊 Reporte de desempeño — ${agente}`,
        subtitle: `Mes: ${mes} · Generado por Dashboard Nidix`,
        imageUrl: "https://operaciones-nidix.vercel.app/icon-192.png",
      },
      sections: [
        {
          header: "KPIs del mes",
          widgets: [
            {
              keyValue: {
                topLabel: "Cumplimiento general",
                content: `${semaforoEmoji(pct)} ${pct}%`,
                bottomLabel: `${realizadas} realizadas de ${total} órdenes`,
              },
            },
            {
              keyValue: {
                topLabel: "Instalaciones",
                content: `${semaforoEmoji(instalacionesPct)} ${instalacionesPct}%`,
                bottomLabel: `${instalaciones} instalaciones asignadas`,
              },
            },
            {
              keyValue: {
                topLabel: "Tickets",
                content: `${semaforoEmoji(ticketsPct)} ${ticketsPct}%`,
                bottomLabel: `${tickets} tickets asignados`,
              },
            },
          ],
        },
        {
          header: "Áreas de mejora",
          widgets: [
            ...motivoWidgets,
            ...(topImposibilidad ? [{
              keyValue: {
                topLabel: "Motivo de imposibilidad técnica",
                content: topImposibilidad,
                icon: "STAR",
              },
            }] : []),
            {
              keyValue: {
                topLabel: "Zona con menor cumplimiento",
                content: topZonaBaja || "Sin datos",
                icon: "MAP_PIN",
              },
            },
          ],
        },
        {
          widgets: [{
            buttons: [{
              textButton: {
                text: "Ver Dashboard",
                onClick: { openLink: { url: "https://operaciones-nidix.vercel.app" } },
              },
            }],
          }],
        },
      ],
    }],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = await req.json();
    const { agente, kpis, test } = body;

    // Modo prueba: envía mensaje simple
    if (test) {
      const testKey = Object.keys(AGENT_WEBHOOKS).find(k => k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"") === agente.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,""));
      if (!testKey) return jsonResp({ error: `No hay webhook para: ${agente}` }, 404);
      const webhook = AGENT_WEBHOOKS[testKey];

      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `✅ *Prueba de conexión exitosa* — Dashboard Nidix\nHola ${agente}, este es un mensaje de prueba del sistema de alertas.`,
        }),
      });

      if (!res.ok) throw new Error(`Error al enviar: ${res.status} ${await res.text()}`);
      return jsonResp({ ok: true, message: `Mensaje enviado a ${agente}` });
    }

    // Envío real con tarjeta de KPIs
    if (!agente || !kpis) return jsonResp({ error: "Faltan parámetros: agente y kpis" }, 400);

    // Buscar webhook de forma case-insensitive
    const webhookKey = Object.keys(AGENT_WEBHOOKS).find(k => k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"") === agente.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,""));
    if (!webhookKey) return jsonResp({ error: `No hay webhook configurado para: ${agente}` }, 404);
    const webhook = AGENT_WEBHOOKS[webhookKey];

    const message = buildMessage(agente, kpis);
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    if (!res.ok) throw new Error(`Error al enviar: ${res.status} ${await res.text()}`);
    return jsonResp({ ok: true, message: `Alerta enviada a ${agente}` });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return jsonResp({ error: msg }, 500);
  }
});