// Edge Function: avance-instalaciones
//
// Informe detallado de las instalaciones REALIZADAS HOY, combinando:
//   1) Base desde mikrowisp-datos (?modulo=instalaciones de hoy, INSTALADO):
//      id, nombre, dirección principal, zona, plan, fecha instalado.
//   2) Campos personalizados por cliente desde la API oficial de MikroWisp
//      (GetClientsDetails): tecnico_instalador, Puerto_OLT (incluye la caja NAP),
//      marca/modelo/serie del equipo instalado, y el nodo del servicio.
//   3) Nombre del router de red (NAS) resolviendo el nodo con GetRouters.
//
// Requiere el secret MIKROWISP_API_TOKEN (token de la API de MikroWisp) además
// de SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Deploy con --no-verify-jwt.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jsonResp(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const API_TOKEN = Deno.env.get("MIKROWISP_API_TOKEN") ?? "";
const API_BASE = "https://clientes.nidix.mx/api/v1";

async function apiPost(endpoint: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: API_TOKEN, ...extra }),
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { estado: "error", mensaje: txt.slice(0, 200) }; }
}

// Ejecuta promesas en lotes para no saturar la API.
async function enLotes<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!SUPA_URL || !SERVICE) return jsonResp({ error: "Faltan SUPABASE_URL / SERVICE_ROLE_KEY" }, 500);
    if (!API_TOKEN) return jsonResp({ error: "Falta el secret MIKROWISP_API_TOKEN" }, 500);

    const body = await req.json().catch(() => ({}));
    // Fecha objetivo: por defecto HOY (Chihuahua); se puede pasar {fecha:'YYYY-MM-DD'}.
    const fecha = body.fecha || new Date().toLocaleDateString("en-CA", { timeZone: "America/Chihuahua" });

    // 1) Base: instalaciones INSTALADO de esa fecha.
    const instRes = await fetch(`${SUPA_URL}/functions/v1/mikrowisp-datos?modulo=instalaciones&desde=${fecha}&hasta=${fecha}`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    const instData = await instRes.json();
    const base = (instData.instalaciones || []).filter((x: Record<string, unknown>) => x.instalado === "INSTALADO");

    // 2) Mapa de routers (nodo id -> nombre) para el "router de red".
    const rt = await apiPost("GetRouters", {});
    const nodoMap = new Map<string, string>();
    for (const r of (rt.routers as Record<string, unknown>[] || [])) nodoMap.set(String(r.id), String(r.nombre ?? ""));

    // 3) Enriquecer cada instalación con los campos personalizados del cliente.
    const rows = await enLotes(base as Record<string, unknown>[], 8, async (b) => {
      const det = await apiPost("GetClientsDetails", { idcliente: String(b.id) });
      const c = ((det.datos as Record<string, unknown>[]) || [])[0] || {};
      const serv = ((c.servicios as Record<string, unknown>[]) || [])[0] || {};
      const marca = String(c.Marca_de_equipo_instalado ?? "").trim();
      const modelo = String(c.Modelo_de_equipo_instalado ?? "").trim();
      const serie = String(c.No_de_serie_de_equipo_instalado ?? "").trim();
      const equipo = [marca, modelo].filter(Boolean).join(" ") + (serie ? ` · ${serie}` : "");
      const nas = serv.nodo != null ? (nodoMap.get(String(serv.nodo)) || `Nodo ${serv.nodo}`) : "";
      return {
        id: b.id,
        nombre: b.nombre,
        direccion_principal: b.direccion_principal,
        zona: b.zona,
        instalado: b.fecha_instalado,
        tecnico_instalador: String(c.tecnico_instalador ?? "").trim(),
        plan: b.plan,
        puerto_olt: String(c.Puerto_OLT ?? "").trim(),
        equipo_instalado: equipo,
        router_red: nas,
      };
    });

    return jsonResp({ fecha, count: rows.length, instalaciones: rows });
  } catch (e) {
    return jsonResp({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
