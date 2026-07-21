-- Agenda Técnica · Fase 1
--
-- NO APLICAR contra el proyecto en vivo hasta que el frontend de 1B esté
-- listo para desplegarse junto con esta migración. El frontend actual en
-- producción (Vercel) todavía espera los 4 estados viejos
-- (asignada/completada/cancelada/devuelta) sobre asignaciones_cuadrilla.
-- Ver plan: Agenda Técnica — Fase 1, sección "Nota de despliegue importante".
--
-- Verificado contra el esquema real de alisslhkyxblpvwzutcx antes de escribir
-- esta migración (supabase db query --linked):
--   - constraint real del estatus viejo: asignaciones_cuadrilla_estatus_check
--   - columnas reales: id bigint, tipo, orden_id, cliente, motivo, zona,
--     cuadrilla, fecha_prog, prioridad, notas, estatus, asignado_por,
--     creado_en, actualizado_en, evento_id, evento_cal_id, evento_error
--   - políticas RLS reales: asignaciones_select_auth (SELECT, authenticated,
--     true), asignaciones_insert_admin / update_admin / delete_admin
--     (auth.jwt()->>'email' = 'dmarquez@nidix.mx')

begin;

-- ============================================================
-- 1. agenda_servicios (renombra y extiende asignaciones_cuadrilla)
-- ============================================================

alter table asignaciones_cuadrilla rename to agenda_servicios;

-- Postgres conserva RLS/índices/constraints en un RENAME; solo renombramos
-- las políticas para que el nombre sea consistente con la tabla nueva.
alter policy asignaciones_select_auth on agenda_servicios rename to agenda_servicios_select_auth;
alter policy asignaciones_insert_admin on agenda_servicios rename to agenda_servicios_insert_admin;
alter policy asignaciones_update_admin on agenda_servicios rename to agenda_servicios_update_admin;
alter policy asignaciones_delete_admin on agenda_servicios rename to agenda_servicios_delete_admin;

-- El CHECK viejo debe quitarse ANTES del backfill: los valores nuevos
-- ('pendiente', 'finalizado', etc.) no están en la lista permitida del
-- constraint original y el UPDATE fallaría si corriera primero.
alter table agenda_servicios drop constraint asignaciones_cuadrilla_estatus_check;

-- Backfill de los 4 estados viejos a los 10 nuevos.
-- 'devuelta' -> 'cancelado' (NO 'pendiente'): verificado contra los datos
-- reales que 'devuelta' siempre fue terminal/histórico — el índice único
-- parcial viejo solo protegía 'asignada', así que pueden existir varias
-- filas 'devuelta' para la misma (tipo, orden_id) (confirmado: orden_id
-- 178508 tiene 2). Si se mapearan a 'pendiente', que sí queda dentro del
-- nuevo índice único de "activos", esas filas duplicadas violarían el
-- índice. 'cancelado' preserva el mismo comportamiento terminal/histórico
-- que 'devuelta' ya tenía.
update agenda_servicios set estatus = case estatus
  when 'asignada'   then 'asignado'
  when 'completada' then 'finalizado'
  when 'cancelada'  then 'cancelado'
  when 'devuelta'   then 'cancelado'
end;

alter table agenda_servicios add constraint agenda_servicios_estatus_check
  check (estatus in (
    'pendiente','asignado','confirmado','en_ruta','en_sitio',
    'trabajando','finalizado','reprogramado','cancelado','no_realizado'
  ));
alter table agenda_servicios alter column estatus set default 'pendiente';

-- Generaliza el índice único parcial de un solo valor "activo" a todo el
-- conjunto de estados no terminales. Los terminales (finalizado, cancelado,
-- no_realizado) quedan fuera, igual que antes con 'completada'/'cancelada'.
drop index ux_asignacion_orden_activa;
create unique index ux_agenda_orden_activa on agenda_servicios(tipo, orden_id)
  where estatus in ('pendiente','asignado','confirmado','en_ruta','en_sitio','trabajando','reprogramado');

-- Campos operativos nuevos (sin GPS/distancia/tiempo de traslado — ver plan,
-- se agregan cuando exista la fase de mapas con captura real).
alter table agenda_servicios
  add column direccion text,
  add column ventana_inicio time,
  add column ventana_fin time,
  add column tiempo_estimado_min integer,
  add column material_requerido text;
  -- motivo_no_realizado y tecnico_id se agregan más abajo, después de crear
  -- las tablas que referencian (motivos_no_realizado, tecnicos).

comment on table agenda_servicios is 'Agenda Técnica · servicios (antes asignaciones_cuadrilla). Fase 1: estados unificados + campos operativos.';

-- ============================================================
-- 2. tecnicos + tecnico_ausencias
-- ============================================================

create table tecnicos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,        -- debe calzar con el nombre del calendario de Google (CAL_CALENDARS)
  activo boolean not null default true,
  especialidad text,
  zona_asignada text,                 -- texto libre; sin FK a zonas_sla (riesgo de mismatch de nombres, ver CLAUDE.md)
  capacidad_diaria integer not null default 6,
  horario_inicio time,
  horario_fin time,
  dias_laborales int[] not null default '{1,2,3,4,5,6}',  -- 1=lunes .. 7=domingo
  creado_en timestamptz not null default now()
);

comment on table tecnicos is 'Agenda Técnica · roster de técnicos/cuadrillas. No reemplaza los nombres libres de "Agentes y Técnicos" (reporteo sobre Excel importado) — son dos calidades de dato distintas, ver plan Fase 1.';

alter table tecnicos enable row level security;
create policy tecnicos_select_auth on tecnicos for select to authenticated using (true);
create policy tecnicos_insert_admin on tecnicos for insert to authenticated with check ((auth.jwt()->>'email') = 'dmarquez@nidix.mx');
create policy tecnicos_update_admin on tecnicos for update to authenticated using ((auth.jwt()->>'email') = 'dmarquez@nidix.mx') with check ((auth.jwt()->>'email') = 'dmarquez@nidix.mx');
create policy tecnicos_delete_admin on tecnicos for delete to authenticated using ((auth.jwt()->>'email') = 'dmarquez@nidix.mx');

create table tecnico_ausencias (
  id uuid primary key default gen_random_uuid(),
  tecnico_id uuid not null references tecnicos(id) on delete cascade,
  fecha_inicio date not null,
  fecha_fin date not null,
  motivo text,                        -- "vacaciones", "incapacidad", etc. — texto libre, no catálogo en Fase 1
  creado_en timestamptz not null default now(),
  constraint tecnico_ausencias_rango_valido check (fecha_fin >= fecha_inicio)
);

alter table tecnico_ausencias enable row level security;
create policy tecnico_ausencias_select_auth on tecnico_ausencias for select to authenticated using (true);
create policy tecnico_ausencias_insert_admin on tecnico_ausencias for insert to authenticated with check ((auth.jwt()->>'email') = 'dmarquez@nidix.mx');
create policy tecnico_ausencias_update_admin on tecnico_ausencias for update to authenticated using ((auth.jwt()->>'email') = 'dmarquez@nidix.mx') with check ((auth.jwt()->>'email') = 'dmarquez@nidix.mx');
create policy tecnico_ausencias_delete_admin on tecnico_ausencias for delete to authenticated using ((auth.jwt()->>'email') = 'dmarquez@nidix.mx');

-- ============================================================
-- 3. motivos_no_realizado
-- ============================================================

create table motivos_no_realizado (
  codigo text primary key,
  etiqueta text not null,
  orden integer not null default 0,
  activo boolean not null default true
);

alter table motivos_no_realizado enable row level security;
create policy motivos_no_realizado_select_auth on motivos_no_realizado for select to authenticated using (true);
create policy motivos_no_realizado_insert_admin on motivos_no_realizado for insert to authenticated with check ((auth.jwt()->>'email') = 'dmarquez@nidix.mx');
create policy motivos_no_realizado_update_admin on motivos_no_realizado for update to authenticated using ((auth.jwt()->>'email') = 'dmarquez@nidix.mx') with check ((auth.jwt()->>'email') = 'dmarquez@nidix.mx');
create policy motivos_no_realizado_delete_admin on motivos_no_realizado for delete to authenticated using ((auth.jwt()->>'email') = 'dmarquez@nidix.mx');

-- ============================================================
-- 4. FKs pendientes en agenda_servicios (ahora que ya existen las tablas)
-- ============================================================

alter table agenda_servicios
  add column motivo_no_realizado text references motivos_no_realizado(codigo),
  add column tecnico_id uuid references tecnicos(id);

-- ============================================================
-- 5. Seeds
-- ============================================================

-- Roster inicial: las 13 cuadrillas ya usadas en CAL_CALENDARS (index.html).
-- Especialidad solo se llena cuando el nombre ya la indica explícitamente;
-- el resto se deja NULL para que el admin la complete (evita adivinar datos
-- de negocio, mismo criterio que "no stub GPS columns" del plan).
insert into tecnicos (nombre, especialidad) values
  ('Cuadrilla Luis Caro', null),
  ('Cuadrilla Basaseachi', null),
  ('Cuadrilla Said Jaimes', null),
  ('Daniel Ruiz Cuadrilla FO y Antena', 'FO y Antena'),
  ('Dany Gerardo Ortiz Cuadrilla FO', 'FO'),
  ('Efren Abud FO', 'FO'),
  ('Gerardo Amparan', null),
  ('Ethel Perea', null),
  ('Gabriel Urita', null),
  ('Antena y FO Eduardo Sanchez', 'Antena y FO'),
  ('Antena y FO Zona 7', 'Antena y FO'),
  ('Yair Jaquez', null),
  ('Alfredo Loya', null);

-- Catálogo de motivos de no realizado (16, pedido original del usuario).
insert into motivos_no_realizado (codigo, etiqueta, orden) values
  ('cliente_ausente',            'Cliente ausente',                      1),
  ('cliente_reprograma',         'Cliente solicita reprogramación',      2),
  ('sin_acceso',                 'Sin acceso',                           3),
  ('sin_energia',                'Sin energía',                          4),
  ('material_insuficiente',      'Material insuficiente',                5),
  ('sin_factibilidad',           'Sin factibilidad',                     6),
  ('poste_danado',               'Poste dañado',                         7),
  ('fibra_danada',                'Fibra dañada',                        8),
  ('falta_permisos',             'Falta de permisos',                    9),
  ('falla_masiva',               'Falla masiva',                        10),
  ('condiciones_climaticas',     'Condiciones climáticas',               11),
  ('direccion_incorrecta',       'Dirección incorrecta',                 12),
  ('error_administrativo',       'Error administrativo',                 13),
  ('tecnico_sin_tiempo',         'Técnico sin tiempo',                   14),
  ('vehiculo_averiado',          'Vehículo averiado',                    15),
  ('otro',                       'Otro',                                 16);

commit;
