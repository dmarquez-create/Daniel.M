const ODOO_URL = "https://nidix.odoo.com";
const ODOO_DB = "assetelodoo-nidix-main-17936904";
const ODOO_USER = "iarreola@nidix.mx";
const ODOO_PASSWORD = Deno.env.get("ODOO_PASSWORD") ?? "";

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

async function odooCall(service: string, method: string, args: unknown[]) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Math.floor(Math.random() * 1000000),
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message || "Error en Odoo");
  return data.result;
}

async function authenticate(): Promise<number> {
  const uid = await odooCall("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}]);
  if (!uid) throw new Error("Autenticación fallida con Odoo.");
  return uid;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "list_orders";
    const uid = await authenticate();

    if (action === "list_orders") {
      // Get FSM project IDs first
      const fsmProjects = await odooCall("object", "execute_kw", [
        ODOO_DB, uid, ODOO_PASSWORD,
        "project.project", "search_read",
        [[["is_fsm", "=", true]]],
        { fields: ["id", "name", "type_ids"], limit: 20 },
      ]);

      // Get all stage IDs from FSM projects that are not folded
      const allTypeIds = fsmProjects.flatMap((p: Record<string, unknown>) => 
        Array.isArray(p.type_ids) ? p.type_ids as number[] : []
      );

      const openStages = allTypeIds.length > 0 ? await odooCall("object", "execute_kw", [
        ODOO_DB, uid, ODOO_PASSWORD,
        "project.task.type", "search",
        [[["id", "in", allTypeIds], ["fold", "=", false]]],
        { limit: 100 },
      ]) : [];

      // Fetch orders and users in parallel
      const domain: unknown[] = [["is_fsm", "=", true], ["active", "=", true]];
      if (openStages.length > 0) domain.push(["stage_id", "in", openStages]);

      const [orders, users] = await Promise.all([
        odooCall("object", "execute_kw", [
          ODOO_DB, uid, ODOO_PASSWORD,
          "project.task", "search_read",
          [domain],
          {
            fields: ["id", "name", "partner_id", "stage_id", "user_ids",
              "planned_date_begin", "date_deadline", "fsm_done",
              "project_id", "priority", "partner_phone", "partner_street", "create_date", "tag_ids"],
            limit: 500,
            order: "create_date desc",
          },
        ]),
        odooCall("object", "execute_kw", [
          ODOO_DB, uid, ODOO_PASSWORD,
          "res.users", "search_read",
          [[]],
          { fields: ["id", "name"], limit: 200 },
        ]),
      ]);

      // Build user map id -> name
      const userMap: Record<number, string> = {};
      for (const u of users) userMap[u.id] = u.name;

      // Get all tag IDs used in orders
      const allTagIds = [...new Set(orders.flatMap((o: Record<string, unknown>) =>
        Array.isArray(o.tag_ids) ? o.tag_ids as number[] : []
      ))];

      // Fetch tag names
      const tagMap: Record<number, string> = {};
      if (allTagIds.length > 0) {
        const tags = await odooCall("object", "execute_kw", [
          ODOO_DB, uid, ODOO_PASSWORD,
          "project.tags", "search_read",
          [[["id", "in", allTagIds]]],
          { fields: ["id", "name"], limit: 100 },
        ]);
        for (const t of tags) tagMap[t.id] = t.name;
      }

      // Filter out orders tagged "Creada por facturación ya instalado" OR con etiqueta Cancelado
      const filteredOrders = orders.filter((o: Record<string, unknown>) => {
        const tagIds = Array.isArray(o.tag_ids) ? o.tag_ids as number[] : [];
        const hasExcludeTag = tagIds.some(id => 
          tagMap[id]?.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").includes("creada por facturacion")
        );
        const hasCancelledTag = tagIds.some(id =>
          tagMap[id]?.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").includes("cancelado")
        );
        return !hasExcludeTag && !hasCancelledTag;
      });

      // Enrich orders with technician names and tags
      const enriched = filteredOrders.map((o: Record<string, unknown>) => ({
        ...o,
        technician_names: Array.isArray(o.user_ids)
          ? (o.user_ids as number[]).map((id) => userMap[id] || `ID:${id}`)
          : [],
        tag_names: Array.isArray(o.tag_ids)
          ? (o.tag_ids as number[]).map((id) => tagMap[id] || "")
          : [],
      }));

      // Get unique stages for filter
      const stages = Array.from(
        new Map(filteredOrders.map((o: Record<string, unknown>) => {
          const s = o.stage_id as [number, string];
          return [s[0], { id: s[0], name: s[1] }];
        })).values()
      );

      return jsonResp({ orders: enriched, stages });
    }

    return jsonResp({ error: "Acción no reconocida" }, 400);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return jsonResp({ error: msg }, 500);
  }
});