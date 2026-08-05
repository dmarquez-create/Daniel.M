const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ADMIN_EMAIL = "dmarquez@nidix.mx";
 
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
 
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
 
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
 
  try {
    // Verify caller is logged in and is admin
    const authHeader = req.headers.get("Authorization") ?? "";
    const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "Authorization": authHeader,
        "apikey": SERVICE_ROLE_KEY,
      },
    });
    const caller = await verifyRes.json();
    if (caller?.email !== ADMIN_EMAIL) {
      return json({ error: "No autorizado" }, 403);
    }
 
    const { action, email, password, uid } = await req.json();
 
    const adminHeaders = {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
 
    if (action === "list") {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
        headers: adminHeaders,
      });
      const data = await res.json();
      return json(data);
    }
 
    if (action === "create") {
      if (!email || !password) return json({ error: "Correo y contraseña requeridos" }, 400);
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const data = await res.json();
      if (data.error || data.msg) throw new Error(data.msg || data.error);
      return json({ ok: true, user: data });
    }
 
    if (action === "delete") {
      if (!uid) return json({ error: "uid requerido" }, 400);
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
        method: "DELETE",
        headers: adminHeaders,
      });
      if (!res.ok) throw new Error("No se pudo eliminar el usuario");
      return json({ ok: true });
    }
 
    return json({ error: "Acción no reconocida" }, 400);
 
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return json({ error: msg }, 500);
  }
});