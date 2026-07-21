// Edge Function: mikrowisp-datos
// Consulta la base MySQL de MikroWisp (Mikrowisp6) y devuelve, según el
// query param ?modulo=, instalaciones o tickets en formato compatible
// con el dashboard de Nidix.
//
//   ?modulo=instalaciones     -> ID (idcliente), nombre, dirección principal, zona,
//                                 instalado (INSTALADO si ya existe en tblservicios,
//                                 PENDIENTE si pagó anticipo pero aún no tiene servicio
//                                 creado), plan, fecha generado (emisión de la factura
//                                 de anticipo), fecha de anticipo pagado
//   ?modulo=tickets           -> (default) todos los tickets, abiertos y cerrados:
//                                 ID, nombre, fecha generado, fecha cierre (null si
//                                 sigue abierto), estado, zona, motivo/asunto,
//                                 teléfono (telefono o movil si telefono está vacío),
//                                 dirección (usuarios.direccion_principal), coordenadas
//                                 (usuarios.coordenadas_venta, formato "lat,lng" en texto)
//   ?modulo=tickets_cerrados  -> solo tickets con estado='cerrado', mismas columnas
//
// Filtros opcionales: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD (sobre fecha de generado)
//
// Variables de entorno requeridas (configurar en Supabase → Edge Functions → Secrets):
//   MIKROWISP_DB_HOST      = 199.85.210.108
//   MIKROWISP_DB_PORT      = 3306
//   MIKROWISP_DB_USER      = dmarquez
//   MIKROWISP_DB_PASSWORD  = ********  (NO hardcodear aquí)
//   MIKROWISP_DB_NAME      = Mikrowisp6
//
// Recuerda: "Verify JWT with legacy secret" debe estar DESACTIVADO para esta función,
// igual que en manage-users / calendar-events / chat-alerts / odoo-orders.

import mysql from "npm:mysql2@3/promise";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Lista blanca de motivo/asunto: los módulos de tickets solo deben incluir
// tickets cuyo motivo/asunto esté en esta lista (definida por el negocio).
// La comparación es insensible a acentos y mayúsculas (ver normalizeMotivo /
// NORM_MOTIVO_SQL) porque el texto real en MikroWisp es inconsistente
// (ej. "Revision" vs "Revisión", "enlaza" vs "Enlaza").
const MOTIVOS_TICKETS_PERMITIDOS = [
  "Antena no Enlaza",
  "Cambio de domicilio FO",
  "Cambio de domicilio Inalambrico",
  "Migración a FO",
  "Problema en Potencia",
  "Reconfiguración de Equipo FO",
  "Recuperar o Cambio De Contraseña",
  "Reemplazo de Equipo o Material Dañado FO",
  "Reubicación de Equipos Inalambrico",
  "Reubicación de Equipo Inalambrico",
  "Reubicación de equipos inalambricos",
  "Reubicación y Reacomodo de Fibra Optica",
  "Revisión de Estado de Equipos FO",
  "Revisión de Estado de Equipos Inalambrico",
  "Señal Baja o Intermitencia en el Servicio Inalámbrico",
  "Visita Para Firma de Contrato",
  "Visita Tecnica/Sin Servicio Inalambrico",
  "Visita técnica AE",
  "Visita Tecnica / AE",
  "Reubicación de Equipos FO",
  "Reemplazo de equipo o Material Dañado Inalambrico",
  "Firma de contrato",
  "Instalación FO",
  "Fibra rota",
];
function normalizeMotivo(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .toLowerCase()
    .trim();
}
const MOTIVOS_NORMALIZADOS = MOTIVOS_TICKETS_PERMITIDOS.map(normalizeMotivo);
const MOTIVOS_PLACEHOLDERS = MOTIVOS_NORMALIZADOS.map(() => "?").join(",");
// Expresión SQL que normaliza (minúsculas + sin acentos) el motivo/asunto real
// para compararlo contra MOTIVOS_NORMALIZADOS.
const NORM_MOTIVO_SQL = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(NULLIF(s.motivo_cierre, ''), s.asunto)),'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ñ','n')`;

// Zonas excluidas del módulo de tickets (tickets y tickets_cerrados) por
// pedido del negocio: San Juanito, Creel, Tomochic y Divisadero no deben
// contarse aquí. Comparación por LIKE normalizado (sin acentos/mayúsculas)
// porque el nombre de zona real varía en capitalización, igual que el motivo.
const ZONAS_EXCLUIDAS_TICKETS = ["san juanito", "creel", "tomochi", "divisadero"];
// Expresión SQL que normaliza (minúsculas + sin acentos) el nombre de zona real.
const NORM_ZONA_SQL = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(z.zona, '')),'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ñ','n')`;
const ZONAS_EXCLUIDAS_SQL = ZONAS_EXCLUIDAS_TICKETS.map(() => `${NORM_ZONA_SQL} NOT LIKE ?`).join(" AND ");
const ZONAS_EXCLUIDAS_PARAMS = ZONAS_EXCLUIDAS_TICKETS.map((z) => `%${z}%`);

// Pool de conexiones a nivel de módulo: se crea una sola vez y se reutiliza
// entre invocaciones mientras el isolate de la Edge Function siga "caliente",
// evitando el costo de abrir una conexión TCP nueva a MySQL en cada request.
let pool: mysql.Pool | null = null;
function getPool() {
  if (pool) return pool;
  const host = Deno.env.get("MIKROWISP_DB_HOST");
  const port = Number(Deno.env.get("MIKROWISP_DB_PORT") ?? "3306");
  const user = Deno.env.get("MIKROWISP_DB_USER");
  const password = Deno.env.get("MIKROWISP_DB_PASSWORD");
  const database = Deno.env.get("MIKROWISP_DB_NAME") ?? "Mikrowisp6";
  if (!host || !user || !password) return null;
  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    connectionLimit: 3,
    connectTimeout: 10000,
    queueLimit: 0,
  });
  return pool;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const db = getPool();

    if (!db) {
      return new Response(
        JSON.stringify({ error: "Faltan variables de entorno de conexión a MikroWisp" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Filtros opcionales vía query params: ?desde=2026-06-01&hasta=2026-07-01
    const url = new URL(req.url);
    const desde = url.searchParams.get("desde");
    const hastaRaw = url.searchParams.get("hasta");
    // "hasta" se recibe como fecha simple (ej. "2026-07-11") y todas las
    // comparaciones SQL usan "< hasta" (exclusivo). Sin ajustar, seleccionar
    // Desde=Hasta=11/07 excluiría por completo los registros del día 11,
    // porque equivale a "< 2026-07-11 00:00:00". Sumamos un día para que
    // "hasta" incluya el día completo seleccionado.
    const hasta = hastaRaw
      ? (() => {
          const d = new Date(`${hastaRaw}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + 1);
          return d.toISOString().slice(0, 10);
        })()
      : null;
    const modulo = url.searchParams.get("modulo") ?? "tickets";

    if (modulo === "instalaciones") {
      // El filtro de fecha aplica a ambos estados, cada uno con su fecha
      // relevante: INSTALADO por fecha_instalado (real, en tblservicios),
      // PENDIENTE por fecha_anticipo_pagado (cuándo se pagó el anticipo,
      // no cuándo se emitió la factura). "Ver todo el histórico" (sin
      // desde/hasta) sigue mostrando el backlog completo de pendientes.
      let whereInst = "";
      let paramsInst: string[] = [];
      if (desde && hasta) {
        whereInst = ` AND (
          (u.instalado = 'INSTALADO' AND u.fecha_instalado >= ? AND u.fecha_instalado < ?)
          OR
          (u.instalado = 'PENDIENTE' AND u.fecha_anticipo_pagado >= ? AND u.fecha_anticipo_pagado < ?)
        )`;
        paramsInst = [desde, hasta, desde, hasta];
      } else if (desde) {
        whereInst = ` AND (
          (u.instalado = 'INSTALADO' AND u.fecha_instalado >= ?)
          OR
          (u.instalado = 'PENDIENTE' AND u.fecha_anticipo_pagado >= ?)
        )`;
        paramsInst = [desde, desde];
      } else if (hasta) {
        whereInst = ` AND (
          (u.instalado = 'INSTALADO' AND u.fecha_instalado < ?)
          OR
          (u.instalado = 'PENDIENTE' AND u.fecha_anticipo_pagado < ?)
        )`;
        paramsInst = [hasta, hasta];
      }

      // NOTA: la tabla `instalaciones` dejó de recibir registros nuevos desde
      // enero 2026 (verificado: MAX(fecha_ingreso) = 2026-01-26). El sistema real
      // usa `tblservicios` para dar de alta un servicio activo. Por eso:
      //  - INSTALADO  = el cliente tiene fila en tblservicios (fuente de verdad,
      //                 SIN requerir que exista un anticipo registrado con ese texto)
      //  - PENDIENTE  = pagó el anticipo de instalación pero aún no tiene fila en tblservicios
      //  - "Fecha generado" (solo aplica a PENDIENTE) = emisión de la factura del anticipo
      //  - "Fecha anticipo pagado" = fecha en que el anticipo quedó pagado (si existe)
      //  - El anticipo de instalación se identifica por su MONTO ($98-$120) y
      //    estatus 'pagado' en `facturas` (confirmado como criterio único y
      //    exclusivo de este concepto, no se traslapa con planes mensuales).
      const queryInst = `
        WITH servicio AS (
          SELECT idcliente,
                 MIN(instalado) AS fecha_instalado,
                 MIN(idperfil) AS idperfil,
                 MIN(direccion) AS direccion
          FROM tblservicios
          GROUP BY idcliente
        ),
        anticipos AS (
          SELECT f.idcliente,
                 MIN(f.emitido) AS fecha_generado,
                 MIN(f.pago) AS fecha_anticipo_pagado
          FROM facturas f
          WHERE f.total BETWEEN 98 AND 120
            AND f.estado = 'pagado'
          GROUP BY f.idcliente
        ),
        universo AS (
          SELECT s.idcliente AS idcliente, 'INSTALADO' AS instalado,
                 s.fecha_instalado, s.idperfil, s.direccion,
                 a.fecha_generado, a.fecha_anticipo_pagado
          FROM servicio s
          LEFT JOIN anticipos a ON a.idcliente = s.idcliente
          UNION ALL
          SELECT a.idcliente, 'PENDIENTE',
                 NULL, NULL, NULL,
                 a.fecha_generado, a.fecha_anticipo_pagado
          FROM anticipos a
          LEFT JOIN servicio s ON s.idcliente = a.idcliente
          WHERE s.idcliente IS NULL AND a.fecha_anticipo_pagado IS NOT NULL
        )
        SELECT
          u.idcliente AS id,
          us.nombre AS nombre,
          COALESCE(u.direccion, us.direccion_principal) AS direccion_principal,
          z.zona AS zona,
          u.instalado,
          p.plan AS plan,
          u.fecha_generado,
          u.fecha_anticipo_pagado,
          u.fecha_instalado
        FROM universo u
        LEFT JOIN usuarios us ON us.id = u.idcliente
        LEFT JOIN perfiles p ON p.id = u.idperfil
        LEFT JOIN tblavisouser tau ON tau.cliente = u.idcliente
        LEFT JOIN zonas z ON z.id = tau.zona
        WHERE 1=1 ${whereInst}
        ORDER BY COALESCE(u.fecha_instalado, u.fecha_generado) DESC
      `;

      const [rowsInst] = await db.execute(queryInst, paramsInst);

      const instalaciones = (rowsInst as Record<string, unknown>[]).map((r) => ({
        id: r.id,
        nombre: r.nombre,
        direccion_principal: r.direccion_principal,
        zona: r.zona ?? "Sin zona",
        instalado: r.instalado, // INSTALADO | PENDIENTE
        plan: r.plan ?? "Sin plan",
        fecha_generado: r.fecha_generado,
        fecha_anticipo_pagado: r.fecha_anticipo_pagado ?? null,
        fecha_instalado: r.fecha_instalado ?? null,
      }));

      return new Response(
        JSON.stringify({ count: instalaciones.length, instalaciones }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (modulo === "tickets_cerrados") {
      // dp=5 -> departamento "Despacho" (confirmado: aquí viven los motivos de la lista blanca)
      // PRUEBA: filtro de lista blanca de motivos DESACTIVADO temporalmente
      // (para comparar contra Grafana). Para reactivarlo, restaurar:
      //   AND ${NORM_MOTIVO_SQL} IN (${MOTIVOS_PLACEHOLDERS})  y  paramsTc = [...MOTIVOS_NORMALIZADOS, ...]
      // Se excluyen siempre los motivos que contengan "retiro" o "baja de servicio".
      // Se excluyen siempre las zonas de ZONAS_EXCLUIDAS_TICKETS (ver definición arriba).
      let whereTc = ` AND s.estado = 'cerrado' AND s.dp = 5 AND COALESCE(NULLIF(s.motivo_cierre, ''), s.asunto) NOT LIKE '%retiro%' AND COALESCE(NULLIF(s.motivo_cierre, ''), s.asunto) NOT LIKE '%baja de servicio%' AND ${ZONAS_EXCLUIDAS_SQL}`;
      const paramsTc: string[] = [...ZONAS_EXCLUIDAS_PARAMS];
      if (desde) {
        whereTc += " AND s.fecha_cerrado >= ?";
        paramsTc.push(desde);
      }
      if (hasta) {
        whereTc += " AND s.fecha_cerrado < ?";
        paramsTc.push(hasta);
      }

      const queryTc = `
        SELECT
          s.id AS id,
          u.nombre AS nombre,
          s.fecha_soporte AS fecha_generado,
          s.fecha_cerrado AS fecha_cierre,
          z.zona AS zona,
          COALESCE(NULLIF(s.motivo_cierre, ''), s.asunto) AS motivo_asunto,
          COALESCE(NULLIF(u.telefono, ''), u.movil) AS telefono,
          u.direccion_principal AS direccion,
          u.coordenadas_venta AS coordenadas
        FROM soporte s
        LEFT JOIN usuarios u ON u.id = s.idcliente
        LEFT JOIN tblavisouser tau ON tau.cliente = s.idcliente
        LEFT JOIN zonas z ON z.id = tau.zona
        WHERE 1=1 ${whereTc}
        ORDER BY s.fecha_cerrado DESC
      `;

      const [rowsTc] = await db.execute(queryTc, paramsTc);

      const ticketsCerrados = (rowsTc as Record<string, unknown>[]).map((r) => ({
        id: r.id,
        nombre: r.nombre,
        fecha_generado: r.fecha_generado,
        fecha_cierre: r.fecha_cierre,
        zona: r.zona ?? "Sin zona",
        motivo_asunto: r.motivo_asunto || null,
        telefono: r.telefono || null,
        direccion: r.direccion || null,
        coordenadas: r.coordenadas || null,
      }));

      return new Response(
        JSON.stringify({ count: ticketsCerrados.length, tickets_cerrados: ticketsCerrados }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // modulo=tickets (default): todos los tickets, abiertos y cerrados,
    // mismas columnas que tickets_cerrados; fecha_cierre viene NULL si sigue abierto.
    // El filtro de fecha usa fecha_cerrado para tickets CERRADOS (cuándo se
    // resolvieron) y fecha_soporte para el resto (única fecha disponible).
    // dp=5 -> departamento "Despacho" (confirmado: aquí viven los motivos de la lista blanca)
    // Se excluye estado='respondido' de todo el módulo (KPIs y tabla), por regla de negocio.
    // PRUEBA: filtro de lista blanca de motivos DESACTIVADO temporalmente
    // (para comparar contra Grafana). Para reactivarlo, restaurar:
    //   AND ${NORM_MOTIVO_SQL} IN (${MOTIVOS_PLACEHOLDERS})  y  params = [...MOTIVOS_NORMALIZADOS, ...]
    // Se excluyen siempre los motivos que contengan "retiro" o "baja de servicio".
    // Se excluyen siempre las zonas de ZONAS_EXCLUIDAS_TICKETS (ver definición arriba).
    let where = ` AND s.dp = 5 AND s.estado != 'respondido' AND COALESCE(NULLIF(s.motivo_cierre, ''), s.asunto) NOT LIKE '%retiro%' AND COALESCE(NULLIF(s.motivo_cierre, ''), s.asunto) NOT LIKE '%baja de servicio%' AND ${ZONAS_EXCLUIDAS_SQL}`;
    const params: string[] = [...ZONAS_EXCLUIDAS_PARAMS];
    if (desde && hasta) {
      where += ` AND (
        (s.estado = 'cerrado' AND s.fecha_cerrado >= ? AND s.fecha_cerrado < ?)
        OR
        (s.estado != 'cerrado' AND s.fecha_soporte >= ? AND s.fecha_soporte < ?)
      )`;
      params.push(desde, hasta, desde, hasta);
    } else if (desde) {
      where += ` AND (
        (s.estado = 'cerrado' AND s.fecha_cerrado >= ?)
        OR
        (s.estado != 'cerrado' AND s.fecha_soporte >= ?)
      )`;
      params.push(desde, desde);
    } else if (hasta) {
      where += ` AND (
        (s.estado = 'cerrado' AND s.fecha_cerrado < ?)
        OR
        (s.estado != 'cerrado' AND s.fecha_soporte < ?)
      )`;
      params.push(hasta, hasta);
    }

    const query = `
      SELECT
        s.id AS id,
        u.nombre AS nombre,
        s.fecha_soporte AS fecha_generado,
        s.fecha_cerrado AS fecha_cierre,
        s.estado,
        z.zona AS zona,
        COALESCE(NULLIF(s.motivo_cierre, ''), s.asunto) AS motivo_asunto,
        COALESCE(NULLIF(u.telefono, ''), u.movil) AS telefono,
        u.direccion_principal AS direccion,
        u.coordenadas_venta AS coordenadas
      FROM soporte s
      LEFT JOIN usuarios u ON u.id = s.idcliente
      LEFT JOIN tblavisouser tau ON tau.cliente = s.idcliente
      LEFT JOIN zonas z ON z.id = tau.zona
      WHERE 1=1 ${where}
      ORDER BY CASE WHEN s.estado = 'cerrado' THEN s.fecha_cerrado ELSE s.fecha_soporte END DESC
    `;

    const [rows] = await db.execute(query, params);

    const tickets = (rows as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      nombre: r.nombre,
      fecha_generado: r.fecha_generado,
      fecha_cierre: r.estado === "cerrado" ? r.fecha_cierre : null,
      estado: r.estado, // abierto | cerrado | respondido | respuesta cliente
      zona: r.zona ?? "Sin zona",
      motivo_asunto: r.motivo_asunto || null,
      telefono: r.telefono || null,
      direccion: r.direccion || null,
      coordenadas: r.coordenadas || null,
    }));

    return new Response(JSON.stringify({ count: tickets.length, tickets }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error consultando MikroWisp:", err);
    return new Response(
      JSON.stringify({ error: String(err instanceof Error ? err.message : err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});