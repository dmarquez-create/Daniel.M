// Edge Function: calendar-events
// Lee y escribe eventos en los calendarios de las cuadrillas de Nidix.
//
// Acciones (body.action, default "list"):
//   "list"        -> eventos del mes (comportamiento original: {year, month})
//   "crear"       -> crea un evento en el calendario de una cuadrilla
//   "borrar"      -> borra un evento por su id
//   "diagnostico" -> valida secrets y el scope del token (no toca calendarios)
//
// Credenciales: se leen de los secrets de Supabase (ya NO van hardcodeadas).
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN   <- debe tener scope calendar.events (escritura)

const CALENDARS = [
  { id: "c_1edbeb97a198a1cec87a1e808d9b982afc428a97c2affde722aebd9435716c31@group.calendar.google.com", name: "Cuadrilla Luis Caro", color: "#1A73E8" },
  { id: "c_9c2d5d4f40fb994bed4c548dd91f0ece5043367d04f85229c939a96ea44c3e7b@group.calendar.google.com", name: "Cuadrilla Basaseachi", color: "#33B679" },
  { id: "c_87649f53d183fe616dc70485f73166dd2a1d70d34e388f3398aa493e1b02720f@group.calendar.google.com", name: "Cuadrilla Said Jaimes", color: "#8E24AA" },
  { id: "c_165f8632661e59c2dc1cfb062ad05c1815485982270315d3bf1ca7697ecc241a@group.calendar.google.com", name: "Daniel Ruiz Cuadrilla FO y Antena", color: "#E67C73" },
  { id: "c_af671ab21857e571768e4133b3185ff88290f41268f01b933f22df40f159a67c@group.calendar.google.com", name: "Dany Gerardo Ortiz Cuadrilla FO", color: "#F6BF26" },
  { id: "c_3ed3dc327e19b64c555b81b7593af1bb3949f8a1cff30561b90f564950b8dfbc@group.calendar.google.com", name: "Efren Abud FO", color: "#F4511E" },
  { id: "c_51e961f956e87c8d052ea53fe803ad29f8a11613d053c1cbfbd814edebe96813@group.calendar.google.com", name: "Gerardo Amparan", color: "#039BE5" },
  { id: "c_75e1790d929787afc41412866e886a9a4ad6fc8d03497b485c11ac1886b79afb@group.calendar.google.com", name: "Ethel Perea", color: "#616161" },
  { id: "c_tmt7kohbbpkpek4eooq02mes10@group.calendar.google.com", name: "Gabriel Urita", color: "#3F51B5" },
  { id: "c_6sjru8sumf88ngl3e9o8kgnb8s@group.calendar.google.com", name: "Antena y FO Eduardo Sanchez", color: "#0B8043" },
  { id: "c_3cgi2npsnur9pu623l00o03eqg@group.calendar.google.com", name: "Antena y FO Zona 7", color: "#D50000" },
  { id: "c_4e4c490044729d309a744d097d0c7b034c11925c2cc34afe19d3a24e7005ca45@group.calendar.google.com", name: "Yair Jaquez", color: "#E91E63" },
  { id: "c_d00474f483ba91b6b25d4edccf31dbb53ee94d9812f7c77f663f4d2ea84a6b32@group.calendar.google.com", name: "Alfredo Loya", color: "#795548" },
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function creds() {
  return {
    clientId: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
    refreshToken: Deno.env.get("GOOGLE_REFRESH_TOKEN") ?? "",
  };
}

async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = creds();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Faltan secrets: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("No se pudo obtener access token: " + JSON.stringify(data));
  }
  return data.access_token;
}

function calIdPorNombre(nombre: string): string | null {
  const c = CALENDARS.find((x) => x.name === nombre);
  return c ? c.id : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "list";

    // ---------- DIAGNÓSTICO ----------
    // Valida secrets y scope sin tocar ningún calendario.
    if (action === "diagnostico") {
      const { clientId, clientSecret, refreshToken } = creds();
      const info: Record<string, unknown> = {
        secrets_presentes: {
          GOOGLE_CLIENT_ID: !!clientId,
          GOOGLE_CLIENT_SECRET: !!clientSecret,
          GOOGLE_REFRESH_TOKEN: !!refreshToken,
        },
        // Pistas sin exponer los valores completos
        refresh_token_empieza_con: refreshToken ? refreshToken.slice(0, 4) : null,
        refresh_token_parece_valido: refreshToken.startsWith("1//"),
        client_secret_empieza_con: clientSecret ? clientSecret.slice(0, 7) : null,
        refresh_token_es_igual_al_secret: !!refreshToken && refreshToken === clientSecret,
      };
      try {
        const token = await getAccessToken();
        const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
        const ti = await r.json();
        info.token_ok = true;
        info.scopes = ti.scope ?? null;
        info.puede_escribir = typeof ti.scope === "string" &&
          (ti.scope.includes("calendar.events") || ti.scope.split(" ").includes("https://www.googleapis.com/auth/calendar"));
      } catch (e) {
        info.token_ok = false;
        info.token_error = String(e instanceof Error ? e.message : e);
      }
      return json(info);
    }

    // ---------- CREAR EVENTO ----------
    if (action === "crear") {
      const { cuadrilla, fecha, titulo, descripcion, ubicacion } = body;
      if (!cuadrilla || !fecha || !titulo) {
        return json({ error: "Faltan parámetros: cuadrilla, fecha, titulo" }, 400);
      }
      const calId = calIdPorNombre(cuadrilla);
      if (!calId) return json({ error: `Cuadrilla no encontrada: ${cuadrilla}` }, 404);

      const token = await getAccessToken();
      // Evento de día completo: end.date es exclusivo, por eso se suma un día.
      const fin = new Date(`${fecha}T00:00:00Z`);
      fin.setUTCDate(fin.getUTCDate() + 1);

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: titulo,
            description: descripcion ?? "",
            location: ubicacion ?? "",
            start: { date: fecha },
            end: { date: fin.toISOString().slice(0, 10) },
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        return json({ error: `Google Calendar: ${data?.error?.message ?? res.status}` }, 502);
      }
      return json({ ok: true, evento_id: data.id, evento_cal_id: calId, html_link: data.htmlLink });
    }

    // ---------- BORRAR EVENTO ----------
    if (action === "borrar") {
      const { evento_id, evento_cal_id } = body;
      if (!evento_id || !evento_cal_id) {
        return json({ error: "Faltan parámetros: evento_id, evento_cal_id" }, 400);
      }
      const token = await getAccessToken();
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(evento_cal_id)}/events/${encodeURIComponent(evento_id)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      // 410 = ya estaba borrado; lo tratamos como éxito.
      if (!res.ok && res.status !== 410 && res.status !== 404) {
        const t = await res.text();
        return json({ error: `Google Calendar: ${res.status} ${t}` }, 502);
      }
      return json({ ok: true });
    }

    // ---------- LISTAR (comportamiento original) ----------
    const { year, month } = body;
    const y = parseInt(year);
    const m = parseInt(month);
    const timeMin = new Date(y, m - 1, 1).toISOString();
    const timeMax = new Date(y, m, 1).toISOString();

    const token = await getAccessToken();
    const todos: unknown[] = [];
    // Antes los fallos por calendario se ignoraban en silencio (`continue`),
    // lo que hacía imposible distinguir "no hay eventos" de "no tengo acceso".
    // Ahora se acumulan y se devuelven en `errores` para poder diagnosticar.
    const errores: { calendario: string; status: number; mensaje: string }[] = [];

    for (const cal of CALENDARS) {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`);
      url.searchParams.set("timeMin", timeMin);
      url.searchParams.set("timeMax", timeMax);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", "2500");

      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        let mensaje = `HTTP ${r.status}`;
        try {
          const err = await r.json();
          mensaje = err?.error?.message ?? mensaje;
        } catch { /* respuesta no-JSON */ }
        errores.push({ calendario: cal.name, status: r.status, mensaje });
        continue;
      }
      const d = await r.json();
      (d.items ?? []).forEach((ev: Record<string, unknown>) => {
        const start = ev.start as Record<string, string> | undefined;
        const end = ev.end as Record<string, string> | undefined;
        // allDay: Google usa `date` (sin hora) para eventos de día completo
        // y `dateTime` para los que tienen horario.
        const allDay = !!start?.date && !start?.dateTime;
        todos.push({
          id: ev.id,
          calendarName: cal.name,
          calendarColor: cal.color,
          title: ev.summary ?? "(sin título)",
          description: ev.description ?? "",
          location: ev.location ?? "",
          allDay,
          start: start?.dateTime ?? start?.date,
          end: end?.dateTime ?? end?.date,
        });
      });
    }

    return json({ events: todos, errores: errores.length ? errores : undefined });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});