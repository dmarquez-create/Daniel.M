const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("No se pudo obtener access token: " + JSON.stringify(data));
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { email } = await req.json();
    if (!email) throw new Error("Falta el correo electrónico.");

    const accessToken = await getAccessToken();

    const res = await fetch(
      `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}?fields=thumbnailPhotoUrl,name`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();

    if (data.error) {
      throw new Error(data.error.message || "No se encontró el usuario en el directorio.");
    }

    // Google entrega la URL con tamaño pequeño (s96); pedimos una más grande.
    let photoUrl: string | null = data.thumbnailPhotoUrl || null;
    if (photoUrl) {
      photoUrl = photoUrl.replace(/sz=\d+|=s\d+(-c)?$/, "").trim();
      photoUrl = photoUrl.includes("?") ? `${photoUrl}&sz=200` : `${photoUrl}=s200`;
    }

    return new Response(JSON.stringify({ photoUrl, name: data.name || null }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});