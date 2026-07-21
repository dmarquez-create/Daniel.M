// Edge Function: asignar-ordenes
// Agenda Técnica (Fase 1) — gestiona la tabla public.agenda_servicios
// (antes asignaciones_cuadrilla; ver migración
// supabase/migrations/20260721101440_agenda_tecnica_fase1.sql).
//
// Estados (10, ver CHECK agenda_servicios_estatus_check):
//   pendiente | asignado | confirmado | en_ruta | en_sitio | trabajando |
//   finalizado | reprogramado | cancelado | no_realizado
// Activos (protegidos por el índice único parcial ux_agenda_orden_activa,
// impiden duplicar (tipo, orden_id)): todos excepto finalizado/cancelado/
// no_realizado, que son terminales.
//
// Además crea/borra el evento correspondiente en la agenda (Google Calendar)
// de la cuadrilla, delegando en la función `calendar-events`. Si Calendar
// falla, la operación en la base se conserva igual y el motivo queda en la
// columna `evento_error` (un problema de Calendar no debe bloquear la
// operación — decisión de negocio ya documentada en CLAUDE.md).
//
// Acciones (via body.action):
//   "listar"       -> devuelve los servicios (opcionalmente filtrados por estatus/tipo)
//   "asignar"      -> inserta servicios para varias órdenes de golpe (desde candidatos
//                      MikroWisp) + crea eventos. Requiere admin.
//   "crear_manual" -> crea un servicio nuevo sin origen MikroWisp. Requiere admin.
//   "cambiar_estado" -> transición de estado de un servicio existente (genereliza la
//                      antigua "actualizar"). Si el destino es "no_realizado", exige
//                      motivo_no_realizado (FK validada por la base). Requiere admin.
//   "reprogramar"  -> cambia técnico/fecha/ventana de un servicio activo (UPDATE en la
//                      misma fila, no INSERT — sigue siendo el mismo servicio). Requiere admin.
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
const TABLA = "agenda_servicios";

// Estados terminales: no ocupan el índice único de "activos", así que una
// orden puede reasignarse creando una fila nueva sin pisar el histórico.
const ESTADOS_TERMINALES = new Set(["finalizado", "cancelado", "no_realizado"]);
const ESTADOS_VALIDOS = new Set([
  "pendiente", "asignado", "confirmado", "en_ruta", "en_sitio",
  "trabajando", "finalizado", "reprogramado", "cancelado", "no_realizado",
]);

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
    const ventana = fila.ventana_inicio
      ? `Ventana: ${fila.ventana_inicio}${fila.ventana_fin ? ` - ${fila.ventana_fin}` : ""}`
      : null;
    const partes = [
      `Orden: ${fila.orden_id}`,
      fila.motivo ? `Motivo: ${fila.motivo}` : null,
      fila.zona ? `Zona: ${fila.zona}` : null,
      fila.direccion ? `Dirección: ${fila.direccion}` : null,
      `Prioridad: ${fila.prioridad}`,
      ventana,
      fila.material_requerido ? `Material: ${fila.material_requerido}` : null,
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
        ubicacion: fila.direccion || fila.zona || "",
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

// Genera un orden_id sintético para servicios creados manualmente (sin
// origen MikroWisp), que no tienen un ID de instalación/ticket real.
// Prefijo "M" para distinguirlos a simple vista de los IDs reales de
// MikroWisp (numéricos).
function ordenIdManual(): string {
  return `M${Date.now()}${Math.floor(Math.random() * 1000)}`;
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
      let q = supabase.from(TABLA).select("*").order("creado_en", { ascending: false });
      if (body.estatus) q = q.eq("estatus", body.estatus);
      if (body.tipo) q = q.eq("tipo", body.tipo);
      const { data, error } = await q;
      if (error) return json({ error: error.message }, 500);
      return json({ servicios: data ?? [] });
    }

    // A partir de aquí se requiere admin (escritura)
    if (!esAdmin) return json({ error: "Solo el administrador puede modificar la agenda" }, 403);

    // ---- CAMBIAR ESTADO ----
    if (action === "cambiar_estado") {
      const { id, nuevo_estatus, cambios } = body;
      if (!id || !nuevo_estatus) return json({ error: "Faltan id o nuevo_estatus" }, 400);
      if (!ESTADOS_VALIDOS.has(nuevo_estatus)) {
        return json({ error: `Estado no reconocido: ${nuevo_estatus}` }, 400);
      }
      if (nuevo_estatus === "no_realizado" && !cambios?.motivo_no_realizado) {
        return json({ error: "Falta motivo_no_realizado para marcar como no realizado" }, 400);
      }

      // Si el destino es terminal y NO conserva el trabajo hecho (cancelado /
      // no_realizado), el evento debe salir de la agenda de la cuadrilla.
      // "finalizado" conserva el evento: es el registro de que el trabajo se hizo.
      let eventoBorrado = false;
      let eventoBorradoError: string | null = null;
      const permitido: Record<string, unknown> = { estatus: nuevo_estatus };
      if (nuevo_estatus === "cancelado" || nuevo_estatus === "no_realizado") {
        const { data: actual } = await supabase
          .from(TABLA)
          .select("evento_id, evento_cal_id")
          .eq("id", id)
          .single();
        if (actual?.evento_id && actual?.evento_cal_id) {
          eventoBorradoError = await borrarEventoCalendar(actual.evento_id, actual.evento_cal_id);
          if (!eventoBorradoError) {
            eventoBorrado = true;
            permitido.evento_id = null;
            permitido.evento_cal_id = null;
          }
        }
      }

      for (const k of ["notas", "motivo_no_realizado"]) {
        if (cambios?.[k] !== undefined) permitido[k] = cambios[k];
      }
      permitido["actualizado_en"] = new Date().toISOString();

      const { data, error } = await supabase
        .from(TABLA)
        .update(permitido)
        .eq("id", id)
        .select();
      if (error) {
        if (error.code === "23503") {
          return json({ error: "motivo_no_realizado no existe en el catálogo" }, 400);
        }
        return json({ error: error.message }, 500);
      }
      return json({
        ok: true,
        servicio: data?.[0] ?? null,
        evento_borrado: eventoBorrado,
        evento_borrado_error: eventoBorradoError,
      });
    }

    // ---- REPROGRAMAR (técnico y/o fecha/ventana de un servicio activo) ----
    if (action === "reprogramar") {
      const { id, tecnico_id, cuadrilla, fecha_prog, ventana_inicio, ventana_fin, notas } = body;
      if (!id) return json({ error: "Falta id" }, 400);
      if (!fecha_prog && !tecnico_id && !cuadrilla) {
        return json({ error: "Nada que reprogramar: falta fecha_prog, tecnico_id o cuadrilla" }, 400);
      }

      const { data: actual, error: actualErr } = await supabase
        .from(TABLA)
        .select("*")
        .eq("id", id)
        .single();
      if (actualErr || !actual) return json({ error: "Servicio no encontrado" }, 404);

      const permitido: Record<string, unknown> = { estatus: "reprogramado" };
      if (tecnico_id !== undefined) permitido.tecnico_id = tecnico_id;
      if (cuadrilla !== undefined) permitido.cuadrilla = cuadrilla;
      if (fecha_prog !== undefined) permitido.fecha_prog = fecha_prog;
      if (ventana_inicio !== undefined) permitido.ventana_inicio = ventana_inicio;
      if (ventana_fin !== undefined) permitido.ventana_fin = ventana_fin;
      if (notas !== undefined) permitido.notas = notas;
      permitido["actualizado_en"] = new Date().toISOString();

      // Si ya había evento en Calendar, se borra el viejo y se crea uno nuevo
      // con los datos actualizados (misma resiliencia: si Calendar falla, el
      // cambio en la base se conserva igual y el motivo queda en evento_error).
      if (actual.evento_id && actual.evento_cal_id) {
        await borrarEventoCalendar(actual.evento_id, actual.evento_cal_id);
        permitido.evento_id = null;
        permitido.evento_cal_id = null;
        permitido.evento_error = null;
      }

      const { data, error } = await supabase
        .from(TABLA)
        .update(permitido)
        .eq("id", id)
        .select();
      if (error) return json({ error: error.message }, 500);

      const filaNueva = data?.[0];
      let eventoOk = false;
      let eventoError: string | null = null;
      if (filaNueva) {
        const r = await crearEventoCalendar(filaNueva);
        eventoError = r.evento_error ?? null;
        eventoOk = !eventoError;
        await supabase
          .from(TABLA)
          .update({
            evento_id: r.evento_id ?? null,
            evento_cal_id: r.evento_cal_id ?? null,
            evento_error: r.evento_error ?? null,
          })
          .eq("id", id);
      }

      return json({ ok: true, servicio: filaNueva ?? null, evento_creado: eventoOk, evento_error: eventoError });
    }

    // ---- CREAR MANUAL (servicio nuevo, sin origen MikroWisp) ----
    if (action === "crear_manual") {
      const {
        tipo, cliente, zona, direccion, motivo, cuadrilla, tecnico_id,
        fecha_prog, ventana_inicio, ventana_fin, tiempo_estimado_min,
        material_requerido, prioridad, notas,
      } = body;
      if (!tipo || !cliente || !cuadrilla || !fecha_prog) {
        return json({ error: "Faltan tipo, cliente, cuadrilla o fecha_prog" }, 400);
      }
      if (tipo !== "instalacion" && tipo !== "ticket") {
        return json({ error: "tipo debe ser 'instalacion' o 'ticket'" }, 400);
      }

      const fila = {
        tipo,
        orden_id: ordenIdManual(),
        cliente,
        motivo: motivo ?? null,
        zona: zona ?? null,
        direccion: direccion ?? null,
        cuadrilla,
        tecnico_id: tecnico_id ?? null,
        fecha_prog,
        ventana_inicio: ventana_inicio ?? null,
        ventana_fin: ventana_fin ?? null,
        tiempo_estimado_min: tiempo_estimado_min ?? null,
        material_requerido: material_requerido ?? null,
        prioridad: prioridad ?? "Media",
        notas: notas ?? null,
        estatus: "asignado",
        asignado_por: email,
      };

      const { data, error } = await supabase.from(TABLA).insert([fila]).select();
      if (error) return json({ error: error.message }, 500);

      const guardada = data?.[0];
      let eventoOk = false;
      let eventoError: string | null = null;
      if (guardada) {
        const r = await crearEventoCalendar(guardada);
        eventoError = r.evento_error ?? null;
        eventoOk = !eventoError;
        await supabase
          .from(TABLA)
          .update({ evento_id: r.evento_id ?? null, evento_cal_id: r.evento_cal_id ?? null, evento_error: r.evento_error ?? null })
          .eq("id", guardada.id);
      }

      return json({ ok: true, servicio: guardada ?? null, evento_creado: eventoOk, evento_error: eventoError });
    }

    // ---- ASIGNAR (varias órdenes candidatas de MikroWisp de golpe) ----
    if (action === "asignar") {
      const { ordenes, cuadrilla, tecnico_id, fecha_prog, prioridad, notas } = body;
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
        tecnico_id: tecnico_id ?? null,
        fecha_prog,
        prioridad: prioridad ?? "Media",
        notas: notas ?? null,
        estatus: "asignado",
        asignado_por: email,
      }));

      // insert normal: el índice único parcial (estados activos) impide
      // duplicar una orden ya activa, pero permite reasignar una cancelada/
      // no_realizada/finalizada conservando el registro histórico anterior.
      const { data, error } = await supabase
        .from(TABLA)
        .insert(filas)
        .select();

      if (error) {
        if (error.code === "23505") {
          return json({ error: "Una o más de las órdenes seleccionadas ya están activas en la agenda. Actualiza la vista e inténtalo de nuevo." }, 409);
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
          .from(TABLA)
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
        servicios: guardadas,
      });
    }

    return json({ error: `Acción no reconocida: ${action}` }, 400);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
