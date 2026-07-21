// Edge Function: asignar-ordenes
// Recibe una selección de órdenes (instalaciones pendientes o tickets abiertos)
// y las guarda como asignaciones a una cuadrilla en la tabla
// public.asignaciones_cuadrilla de Supabase.
//
// Además crea el evento correspondiente en la agenda (Google Calendar) de la
// cuadrilla, delegando en la función `calendar-events`. Si Calendar falla, la
// asignación se guarda igual y el motivo queda en la columna `evento_error`.
// Al devolver o cancelar una asignación, el evento se borra de la agenda.
//
// Acciones (via body.action):
//   "asignar"    -> inserta asignaciones para varias órdenes de golpe + crea eventos
//   "listar"     -> devuelve las asignaciones (opcionalmente filtradas por estatus)
//   "actualizar" -> cambia estatus (completada/devuelta/cancelada) o reasigna
//
// Seguridad: valida que el usuario autenticado sea el admin, del lado servidor,
// además del RLS de la tabla. Mantener "Verify JWT with legacy secret" DESACTIVADO
// (igual que las demás funciones del proyecto); la validación se hace con el token
// que envía el dashboard en el header Authorization.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_EMAIL = "dmarquez@nidix.mx";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ---- Integración con Google Calendar ----
// Se delega en la función `calendar-events`, que ya maneja las credenciales
// (secrets GOOGLE_*) y el mapeo cuadrilla -> calendarId.
const CALENDAR_FN = `${Deno.env.get("SUPABASE_URL")}/functions/v1/calendar-events`;

interface EventoCreado {
  evento_id?: string;
  evento_cal_id?: string;
  evento_error?: string;
}

async function crearEventoCalendar(
  fila: Record<string, unknown>,
): Promise<EventoCreado> {
  try {
    const esInst = fila.tipo === "instalacion";
    const etiqueta = esInst ? "Instalación" : "Ticket";
    const titulo = `[${etiqueta}] ${fila.cliente ?? "Sin nombre"}`;
    const partes = [
      `Orden: ${fila.orden_id}`,
      fila.motivo ? `Motivo: ${fila.motivo}` : null,
      fila.zona ? `Zona: ${fila.zona}` : null,
      `Prioridad: ${fila.prioridad}`,
      fila.notas ? `\nNotas: ${fila.notas}` : null,
      `\nAsignado desde el Dashboard Nidix por ${fila.asignado_por}`,
    ].filter(Boolean);

    const res = await fetch(CALENDAR_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "crear",
        cuadrilla: fila.cuadrilla,
        fecha: fila.fecha_prog,
        titulo,
        descripcion: partes.join("\n"),
        ubicacion: fila.zona ?? "",
      }),
    });
    const d = await res.json();
    if (!res.ok || d.error) {
      return { evento_error: String(d.error ?? `HTTP ${res.status}`) };
    }
    return { evento_id: d.evento_id, evento_cal_id: d.evento_cal_id };
  } catch (e) {
    return { evento_error: String(e instanceof Error ? e.message : e) };
  }
}

async function borrarEventoCalendar(
  evento_id: string,
  evento_cal_id: string,
): Promise<string | null> {
  try {
    const res = await fetch(CALENDAR_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "borrar", evento_id, evento_cal_id }),
    });
    const d = await res.json();
    if (!res.ok || d.error) return String(d.error ?? `HTTP ${res.status}`);
    return null;
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json({ error: "Falta token de autenticación" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Cliente que actúa CON el token del usuario (respeta RLS)
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Validar identidad del usuario del lado servidor
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Sesión inválida" }, 401);
    const email = userData.user.email ?? "";
    const esAdmin = email === ADMIN_EMAIL;

    const body = await req.json();
    const action = body.action ?? "asignar";

    // ---- LISTAR ----
    if (action === "listar") {
      let q = supabase.from("asignaciones_cuadrilla").select("*").order("creado_en", { ascending: false });
      if (body.estatus) q = q.eq("estatus", body.estatus);
      if (body.tipo) q = q.eq("tipo", body.tipo);
      const { data, error } = await q;
      if (error) return json({ error: error.message }, 500);
      return json({ asignaciones: data ?? [] });
    }

    // A partir de aquí se requiere admin (escritura)
    if (!esAdmin) return json({ error: "Solo el administrador puede asignar órdenes" }, 403);

    // ---- ACTUALIZAR (estatus / reasignar) ----
    if (action === "actualizar") {
      const { id, cambios } = body;
      if (!id || !cambios) return json({ error: "Faltan id o cambios" }, 400);

      // Si se devuelve o cancela, el evento debe salir de la agenda de la cuadrilla.
      // (Al completarla el evento se conserva: es el registro de que el trabajo se hizo.)
      let eventoBorrado = false;
      let eventoBorradoError: string | null = null;
      if (cambios.estatus === "devuelta" || cambios.estatus === "cancelada") {
        const { data: actual } = await supabase
          .from("asignaciones_cuadrilla")
          .select("evento_id, evento_cal_id")
          .eq("id", id)
          .single();
        if (actual?.evento_id && actual?.evento_cal_id) {
          eventoBorradoError = await borrarEventoCalendar(actual.evento_id, actual.evento_cal_id);
          if (!eventoBorradoError) {
            eventoBorrado = true;
            cambios.evento_id = null;
            cambios.evento_cal_id = null;
          }
        }
      }

      const permitido: Record<string, unknown> = {};
      for (const k of ["cuadrilla", "fecha_prog", "prioridad", "notas", "estatus", "evento_id", "evento_cal_id"]) {
        if (cambios[k] !== undefined) permitido[k] = cambios[k];
      }
      permitido["actualizado_en"] = new Date().toISOString();
      const { data, error } = await supabase
        .from("asignaciones_cuadrilla")
        .update(permitido)
        .eq("id", id)
        .select();
      if (error) return json({ error: error.message }, 500);
      return json({
        ok: true,
        asignacion: data?.[0] ?? null,
        evento_borrado: eventoBorrado,
        evento_borrado_error: eventoBorradoError,
      });
    }

    // ---- ASIGNAR (varias órdenes de golpe) ----
    if (action === "asignar") {
      const { ordenes, cuadrilla, fecha_prog, prioridad, notas } = body;
      if (!Array.isArray(ordenes) || ordenes.length === 0) {
        return json({ error: "No se recibieron órdenes para asignar" }, 400);
      }
      if (!cuadrilla || !fecha_prog) {
        return json({ error: "Faltan cuadrilla o fecha" }, 400);
      }

      const filas = ordenes.map((o: Record<string, unknown>) => ({
        tipo: o.tipo,
        orden_id: String(o.orden_id),
        cliente: o.cliente ?? null,
        motivo: o.motivo ?? null,
        zona: o.zona ?? null,
        cuadrilla,
        fecha_prog,
        prioridad: prioridad ?? "Media",
        notas: notas ?? null,
        estatus: "asignada",
        asignado_por: email,
      }));

      // insert normal: el índice único parcial (solo estatus='asignada') impide
      // duplicar una orden ya asignada, pero permite reasignar una devuelta/cancelada
      // conservando el registro histórico anterior.
      const { data, error } = await supabase
        .from("asignaciones_cuadrilla")
        .insert(filas)
        .select();

      if (error) {
        if (error.code === "23505") {
          return json({ error: "Una o más de las órdenes seleccionadas ya están asignadas. Actualiza la vista e inténtalo de nuevo." }, 409);
        }
        return json({ error: error.message }, 500);
      }

      // Crear el evento en la agenda de la cuadrilla para cada orden asignada.
      // Si Google falla, la asignación se conserva y el motivo queda en evento_error
      // (decisión de negocio: un problema de Calendar no debe bloquear la operación).
      const guardadas = data ?? [];
      let eventosOk = 0;
      let eventosFallidos = 0;

      await Promise.all(guardadas.map(async (fila: Record<string, unknown>) => {
        const r = await crearEventoCalendar(fila);
        if (r.evento_error) eventosFallidos++; else eventosOk++;
        await supabase
          .from("asignaciones_cuadrilla")
          .update({
            evento_id: r.evento_id ?? null,
            evento_cal_id: r.evento_cal_id ?? null,
            evento_error: r.evento_error ?? null,
          })
          .eq("id", fila.id);
      }));

      return json({
        ok: true,
        asignadas: guardadas.length,
        eventos_creados: eventosOk,
        eventos_fallidos: eventosFallidos,
        asignaciones: guardadas,
      });
    }

    return json({ error: `Acción no reconocida: ${action}` }, 400);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});