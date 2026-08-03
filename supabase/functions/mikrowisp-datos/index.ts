// Edge Function: mikrowisp-datos  (versión "cache")
//
// La base MySQL de MikroWisp quedó SIN acceso externo. Ahora los datos se
// sincronizan a Supabase (tablas mw_tickets / mw_instalaciones) por un proceso
// que corre en una máquina de la red con acceso al MySQL (ver /sync-mikrowisp).
//
// Esta función lee de esas tablas y devuelve EXACTAMENTE el mismo formato que
// antes, para que el dashboard / alertas-operativas / avance-instalaciones no
// cambien. Query params:
//   ?modulo=tickets            (default) tickets abiertos+cerrados
//   ?modulo=tickets_cerrados   solo cerrados
//   ?modulo=instalaciones      INSTALADO + PENDIENTE
//   &desde=YYYY-MM-DD&hasta=YYYY-MM-DD  (opcional; 'hasta' inclusivo)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Lee una tabla de Supabase con paginación (PostgREST tope 1000/req).
async function readTable(table: string, select: string, filters: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const url = `${SUPA_URL}/rest/v1/${table}?select=${select}${filters}&limit=1000&offset=${offset}`;
    const res = await fetch(url, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    if (!res.ok) throw new Error(`${table} ${res.status}: ${await res.text()}`);
    const rows = await res.json() as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return out;
}

// 'hasta' se recibe como día simple; se compara con "< hasta+1día" para incluir el día completo.
function hastaExcl(hasta: string): string {
  const d = new Date(`${hasta}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!SUPA_URL || !SERVICE) {
      return new Response(JSON.stringify({ error: "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const url = new URL(req.url);
    const modulo = url.searchParams.get("modulo") ?? "tickets";
    const desde = url.searchParams.get("desde");
    const hastaRaw = url.searchParams.get("hasta");
    const hasta = hastaRaw ? hastaExcl(hastaRaw) : null;

    if (modulo === "instalaciones") {
      let filtros = "";
      if (desde && hasta) {
        filtros = `&or=(and(instalado.eq.INSTALADO,fecha_instalado.gte.${desde},fecha_instalado.lt.${hasta}),and(instalado.eq.PENDIENTE,fecha_anticipo_pagado.gte.${desde},fecha_anticipo_pagado.lt.${hasta}))`;
      } else if (desde) {
        filtros = `&or=(and(instalado.eq.INSTALADO,fecha_instalado.gte.${desde}),and(instalado.eq.PENDIENTE,fecha_anticipo_pagado.gte.${desde}))`;
      } else if (hasta) {
        filtros = `&or=(and(instalado.eq.INSTALADO,fecha_instalado.lt.${hasta}),and(instalado.eq.PENDIENTE,fecha_anticipo_pagado.lt.${hasta}))`;
      }
      const rows = await readTable("mw_instalaciones", "id,nombre,direccion_principal,zona,instalado,plan,fecha_generado,fecha_anticipo_pagado,fecha_instalado", filtros);
      return new Response(JSON.stringify({ count: rows.length, instalaciones: rows }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (modulo === "tickets_cerrados") {
      let filtros = "&estado=eq.cerrado";
      if (desde) filtros += `&fecha_cierre=gte.${desde}`;
      if (hasta) filtros += `&fecha_cierre=lt.${hasta}`;
      const rows = await readTable("mw_tickets", "id,nombre,fecha_generado,fecha_cierre,zona,motivo_asunto,telefono,direccion,coordenadas", filtros);
      return new Response(JSON.stringify({ count: rows.length, tickets_cerrados: rows }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // modulo=tickets (default): abiertos+cerrados. Fecha: cerrados por fecha_cierre, resto por fecha_generado.
    let filtros = "";
    if (desde && hasta) {
      filtros = `&or=(and(estado.eq.cerrado,fecha_cierre.gte.${desde},fecha_cierre.lt.${hasta}),and(estado.neq.cerrado,fecha_generado.gte.${desde},fecha_generado.lt.${hasta}))`;
    } else if (desde) {
      filtros = `&or=(and(estado.eq.cerrado,fecha_cierre.gte.${desde}),and(estado.neq.cerrado,fecha_generado.gte.${desde}))`;
    } else if (hasta) {
      filtros = `&or=(and(estado.eq.cerrado,fecha_cierre.lt.${hasta}),and(estado.neq.cerrado,fecha_generado.lt.${hasta}))`;
    }
    const rows = await readTable("mw_tickets", "id,id_cliente,nombre,fecha_generado,fecha_cierre,estado,zona,motivo_asunto,asunto,telefono,direccion,coordenadas", filtros);
    return new Response(JSON.stringify({ count: rows.length, tickets: rows }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
