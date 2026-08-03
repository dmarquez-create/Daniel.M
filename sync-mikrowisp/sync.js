// Sync MikroWisp -> Supabase
//
// Corre en una máquina de la red que SÍ tiene acceso a la base MySQL de
// MikroWisp. Lee tickets e instalaciones (mismas consultas que la Edge Function
// mikrowisp-datos) y los sube a las tablas mw_tickets / mw_instalaciones de
// Supabase. El dashboard lee de esas tablas (ya no se conecta al MySQL).
//
// Config en .env (ver .env.example). Programar con el Programador de tareas
// de Windows cada ~15 min (ver README.md).

require("dotenv").config();
const mysql = require("mysql2/promise");
const { createClient } = require("@supabase/supabase-js");

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// Normalización de zona (minúsculas + sin acentos) y zonas excluidas por negocio.
const NORM_ZONA = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(z.zona,'')),'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ñ','n')";
const ZONAS_EXCL = ["san juanito", "creel", "tomochi", "divisadero"];

const TICKETS_SQL = `
  SELECT s.id AS id, s.idcliente AS id_cliente, u.nombre AS nombre,
         s.fecha_soporte AS fecha_generado, s.fecha_cerrado AS fecha_cierre, s.estado,
         z.zona AS zona, COALESCE(NULLIF(s.motivo_cierre,''), s.asunto) AS motivo_asunto,
         s.asunto AS asunto, COALESCE(NULLIF(u.telefono,''), u.movil) AS telefono,
         u.direccion_principal AS direccion, u.coordenadas_venta AS coordenadas
  FROM soporte s
  LEFT JOIN usuarios u ON u.id = s.idcliente
  LEFT JOIN tblavisouser tau ON tau.cliente = s.idcliente
  LEFT JOIN zonas z ON z.id = tau.zona
  WHERE s.dp = 5 AND s.estado != 'respondido'
    AND COALESCE(NULLIF(s.motivo_cierre,''), s.asunto) NOT LIKE '%retiro%'
    AND COALESCE(NULLIF(s.motivo_cierre,''), s.asunto) NOT LIKE '%baja de servicio%'
    AND COALESCE(u.nombre,'') NOT LIKE '% R-E%'
    AND ${ZONAS_EXCL.map(() => `${NORM_ZONA} NOT LIKE ?`).join(" AND ")}
`;
const TICKETS_PARAMS = ZONAS_EXCL.map((z) => `%${z}%`);

const INST_SQL = `
  WITH servicio AS (
    SELECT idcliente, MIN(instalado) AS fecha_instalado, MIN(idperfil) AS idperfil, MIN(direccion) AS direccion
    FROM tblservicios GROUP BY idcliente
  ),
  anticipos AS (
    SELECT f.idcliente, MIN(f.emitido) AS fecha_generado, MIN(f.pago) AS fecha_anticipo_pagado
    FROM facturas f WHERE f.total BETWEEN 98 AND 120 AND f.estado = 'pagado' GROUP BY f.idcliente
  ),
  universo AS (
    SELECT s.idcliente AS idcliente, 'INSTALADO' AS instalado, s.fecha_instalado, s.idperfil, s.direccion, a.fecha_generado, a.fecha_anticipo_pagado
    FROM servicio s LEFT JOIN anticipos a ON a.idcliente = s.idcliente
    UNION ALL
    SELECT a.idcliente, 'PENDIENTE', NULL, NULL, NULL, a.fecha_generado, a.fecha_anticipo_pagado
    FROM anticipos a LEFT JOIN servicio s ON s.idcliente = a.idcliente
    WHERE s.idcliente IS NULL AND a.fecha_anticipo_pagado IS NOT NULL
  )
  SELECT u.idcliente AS id, us.nombre AS nombre,
         COALESCE(u.direccion, us.direccion_principal) AS direccion_principal,
         z.zona AS zona, u.instalado, p.plan AS plan,
         u.fecha_generado, u.fecha_anticipo_pagado, u.fecha_instalado
  FROM universo u
  LEFT JOIN usuarios us ON us.id = u.idcliente
  LEFT JOIN perfiles p ON p.id = u.idperfil
  LEFT JOIN tblavisouser tau ON tau.cliente = u.idcliente
  LEFT JOIN zonas z ON z.id = tau.zona
`;

const toISO = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };

async function pushTabla(table, rows, runTs) {
  // dedupe por id (por si acaso) y sella synced_at con el timestamp de esta corrida
  const uniq = [...new Map(rows.map((r) => [r.id, { ...r, synced_at: runTs }])).values()];
  const B = 500;
  for (let i = 0; i < uniq.length; i += B) {
    const { error } = await supa.from(table).upsert(uniq.slice(i, i + B), { onConflict: "id" });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
  // borra las filas que ya no vinieron en esta corrida (bajas/cambios)
  const { error: delErr } = await supa.from(table).delete().lt("synced_at", runTs);
  if (delErr) throw new Error(`${table} delete stale: ${delErr.message}`);
  return uniq.length;
}

async function main() {
  const runTs = new Date().toISOString();
  const db = await mysql.createConnection({
    host: process.env.MIKROWISP_DB_HOST,
    port: Number(process.env.MIKROWISP_DB_PORT || 3306),
    user: process.env.MIKROWISP_DB_USER,
    password: process.env.MIKROWISP_DB_PASSWORD,
    database: process.env.MIKROWISP_DB_NAME || "Mikrowisp6",
    connectTimeout: 15000,
  });
  try {
    const [tk] = await db.query(TICKETS_SQL, TICKETS_PARAMS);
    const tickets = tk.map((r) => ({
      id: Number(r.id), id_cliente: r.id_cliente != null ? Number(r.id_cliente) : null, nombre: r.nombre || null,
      fecha_generado: toISO(r.fecha_generado), fecha_cierre: r.estado === "cerrado" ? toISO(r.fecha_cierre) : null,
      estado: r.estado || null, zona: r.zona || "Sin zona", motivo_asunto: r.motivo_asunto || null, asunto: r.asunto || null,
      telefono: r.telefono || null, direccion: r.direccion || null, coordenadas: r.coordenadas || null,
    }));
    const nTk = await pushTabla("mw_tickets", tickets, runTs);
    await supa.from("mw_sync_meta").upsert({ recurso: "tickets", last_sync: runTs, filas: nTk }, { onConflict: "recurso" });
    console.log(`tickets sincronizados: ${nTk}`);

    const [ins] = await db.query(INST_SQL);
    const inst = ins.map((r) => ({
      id: Number(r.id), nombre: r.nombre || null, direccion_principal: r.direccion_principal || null,
      zona: r.zona || "Sin zona", instalado: r.instalado || null, plan: r.plan || "Sin plan",
      fecha_generado: toISO(r.fecha_generado), fecha_anticipo_pagado: toISO(r.fecha_anticipo_pagado), fecha_instalado: toISO(r.fecha_instalado),
    }));
    const nIn = await pushTabla("mw_instalaciones", inst, runTs);
    await supa.from("mw_sync_meta").upsert({ recurso: "instalaciones", last_sync: runTs, filas: nIn }, { onConflict: "recurso" });
    console.log(`instalaciones sincronizadas: ${nIn}`);

    console.log("SYNC OK", runTs);
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error("SYNC ERROR:", e.message); process.exit(1); });
