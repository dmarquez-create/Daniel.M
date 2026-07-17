# Dashboard de Operaciones · Nidix Networks

ISP en Chihuahua, México. Dashboard interno de operaciones para instalaciones,
tickets, agenda de cuadrillas y SLA de ingeniería.

- **Producción:** https://operaciones-nidix.vercel.app
- **Repo:** `dmarquez-create/Daniel.M` → Vercel despliega automático desde `main`
- **Supabase:** proyecto `alisslhkyxblpvwzutcx`
- **Admin único:** `dmarquez@nidix.mx` (las políticas RLS de escritura lo tienen hardcodeado)
- **Idioma:** todo en español — UI, comentarios, commits.

---

## Restricción principal: NO hay build step

`index.html` es un **archivo único** (~2,000 líneas) con React 18 + Babel standalone
cargados por CDN. No hay npm, ni bundler, ni `package.json`. El navegador transpila
el JSX en tiempo de ejecución.

Esto es **intencional**, no deuda técnica. Antes de proponer modularizar, considerar
que el despliegue actual es "commit y listo" y que eso tiene valor propio.

Implicaciones prácticas:
- Todo el JSX vive dentro de `<script type="text/babel">`.
- No se pueden usar imports de ES modules dentro de ese bloque.
- Las librerías se agregan como `<script src="cdn...">` y se leen del global.
- Un error de sintaxis rompe la app entera en silencio (Babel falla en runtime).

### Validar antes de commitear

Un desbalance de llaves no da error hasta que la página carga en blanco. Verificar
siempre el balance de `{}`, `()` y `[]` dentro del bloque de Babel después de editar,
ignorando los que aparecen dentro de strings, template literals y comentarios.

---

## Librerías disponibles (vía CDN)

React 18, Recharts, SheetJS (`XLSX`), PapaParse, Supabase JS.

Destructuring de Recharts en la línea ~34:
```js
const { BarChart, Bar, PieChart, Pie, Cell, LabelList, XAxis, YAxis, CartesianGrid,
        Tooltip, ResponsiveContainer, Legend, ScatterChart, Scatter, ZAxis, ReferenceLine } = Recharts;
```
Si se necesita otro componente de Recharts, hay que agregarlo ahí primero.

---

## Edge Functions (Supabase)

Todas con **"Verify JWT with legacy secret" DESACTIVADO**. La validación de identidad
se hace dentro de la función, leyendo el header `Authorization` que manda el frontend.

| Función | Qué hace |
|---|---|
| `mikrowisp-datos` | MySQL directo contra MikroWisp. Módulos: `instalaciones`, `tickets`, `tickets_cerrados` |
| `calendar-events` | Google Calendar: `list`, `crear`, `borrar`, `diagnostico` |
| `asignar-ordenes` | Asignación de órdenes a cuadrillas: `asignar`, `listar`, `actualizar` |
| `chat-alerts` | Alertas por webhook de Google Chat, personalizadas por agente |
| `odoo-orders` | Odoo Field Service vía JSON-RPC (`project.task` con `is_fsm=true`) |
| `manage-users` | Gestión de usuarios |
| `directory-photo` | Fotos de perfil vía Google Admin SDK |

### Despliegue de Edge Functions

El conector MCP de Supabase apunta a **otra cuenta**, no al proyecto
`alisslhkyxblpvwzutcx`. Históricamente se han desplegado pegando el código en la UI web.
Con el CLI de Supabase autenticado en la cuenta correcta esto se puede automatizar.

### Secrets (nunca hardcodear credenciales)

Viven en Supabase → Edge Functions → Manage secrets:

```
MIKROWISP_DB_HOST, MIKROWISP_DB_PORT, MIKROWISP_DB_USER,
MIKROWISP_DB_PASSWORD, MIKROWISP_DB_NAME
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
```

`SUPABASE_URL` y `SUPABASE_ANON_KEY` existen por default en todo proyecto.

El refresh token de Google tiene scope `calendar.events` (lectura **y** escritura).
Ojo: `calendar-events` tiene una acción `diagnostico` que valida secrets y scope sin
tocar calendarios — útil cuando algo falla con Google.

---

## Tablas de Supabase

| Tabla | Contenido |
|---|---|
| `ordenes` | Órdenes importadas del Excel "BD Agenda" |
| `asignaciones_cuadrilla` | Asignación de órdenes a cuadrillas (ver abajo) |
| `zonas_sla` | 138 subzonas, tipos "24/7" y "Riesgo Operativo" |
| `perfiles` | Fotos de perfil de Google Workspace |

RLS en todas: lectura para `authenticated`, escritura solo para `dmarquez@nidix.mx`.

### `asignaciones_cuadrilla`

Estatus: `asignada` | `completada` | `cancelada` | `devuelta`.

Índice único **parcial** `ux_asignacion_orden_activa` sobre `(tipo, orden_id)` que solo
aplica cuando `estatus='asignada'`. Esto permite reasignar una orden devuelta creando
un registro nuevo, sin pisar el histórico. Por eso se usa `insert`, **no** `upsert`.

Al asignar se crea un evento en el Google Calendar de la cuadrilla y se guarda su
`evento_id`. Si Google falla, la asignación se guarda igual y el motivo queda en
`evento_error` — un problema de Calendar no debe bloquear la operación.
Al devolver o cancelar se borra el evento; al completar se conserva.

---

## MikroWisp: lo que hay que saber

Base `Mikrowisp6` (MariaDB 10.11). **Esta sección costó una sesión entera de ingeniería
inversa. Leerla antes de tocar `mikrowisp-datos`.**

### Trampas confirmadas

**La tabla `instalaciones` está CONGELADA desde 2026-01-26.** No recibe registros
nuevos. Su campo `estate` (INSTALADO/NO INSTALADO/PENDIENTE/…) es obsoleto.
**No usarla como fuente de nada**, incluida la zona.

**El departamento es `soporte.dp`, NO `soporte.idsoporte`.** `idsoporte` es otra cosa y
sus valores no corresponden a la tabla `departamentos`. Mapeo real:

```
dp=1  Soporte técnico     dp=5  Despacho  ← aquí viven los motivos de campo
dp=4  Instalacion         dp=8  Atención Especializada
```

**La zona del cliente NO está en `instalaciones.zona`.** La cadena correcta es:
```
soporte.idcliente → usuarios.id → tblavisouser.cliente → tblavisouser.zona → zonas.zona
```

**El anticipo de instalación se identifica por MONTO, no por texto.**
`facturas.total BETWEEN 98 AND 120 AND estado='pagado'`. Buscar `'%INSTALA%'` en
`facturaitems.descripcion` subcuenta mucho — ese criterio de monto es único y exclusivo
de este concepto (confirmado con el negocio).

**El texto de los motivos es inconsistente.** Existen "Revision" y "Revisión",
"Antena no enlaza" y "Antena no Enlaza", singular y plural. Toda comparación de motivos
debe ser insensible a acentos y mayúsculas.

### Definiciones del módulo de instalaciones

- **INSTALADO** = el cliente tiene fila en `tblservicios` (fuente de verdad).
  Se filtra por `tblservicios.instalado` (fecha real de instalación).
- **PENDIENTE** = pagó el anticipo **y** no tiene fila en `tblservicios`.
  Se filtra por la fecha de pago del anticipo.

El filtro de fecha aplica el campo correcto según el estado de cada fila.

### Definiciones del módulo de tickets

- Solo `dp = 5` (Despacho)
- Se excluye `estado = 'respondido'`
- Se excluyen motivos que contengan `retiro` o `baja de servicio`
- Se excluyen las zonas San Juanito, Creel, Tomochic y Divisadero (pedido del
  negocio, 2026-07-17). Comparación por `LIKE` normalizado (sin acentos/mayúsculas)
  sobre `zonas.zona`, igual criterio que los motivos — ver `ZONAS_EXCLUIDAS_TICKETS`
  en `mikrowisp-datos.ts`. Aplica a `tickets` y `tickets_cerrados`, no a `instalaciones`.
- La lista blanca de motivos está **desactivada** (modo prueba para comparar contra
  Grafana). El código y los comentarios para reactivarla siguen en el archivo.
- Filtro de fecha: los cerrados por `fecha_cerrado`, el resto por `fecha_soporte`

### Bug clásico: el parámetro `hasta`

Todas las comparaciones SQL usan `< hasta` (exclusivo). Si llega una fecha simple
(`2026-07-11`), hay que **sumarle un día** antes de comparar; si no, seleccionar
Desde = Hasta = 11/07 excluye por completo el día 11.

---

## Excel "BD Agenda" (fuente del módulo General)

Se importa por la UI: login como admin → Importar CSV/Excel.

**Calidad de datos conocida:**
- La columna `Zona` **solo existe desde mayo 2026**. Antes: 0% de cobertura
  (abril: 6%). De ~9,963 órdenes válidas, solo ~2,814 tienen zona.
  Cualquier análisis por zona arranca en mayo 2026.
- `ESTATUS FINAL` viene en mayúsculas y minúsculas ("Realizado" / "REALIZADO").
  El parseo normaliza, pero cuidado al analizar el Excel crudo.
- `MES` tiene el mismo problema ("junio" / "Junio").
- Existe la zona literal `"SIN ZONA"` en mayúsculas. Al excluir "sin zona" hay que
  comparar normalizado, no con igualdad exacta.

---

## Convenciones de UI

**Colores:** azul corporativo `#2256C9`, naranja `#F2780C`, rojo para crítico.
Semáforo: ≥80% verde, 70–79% naranja, <69% rojo.
Tema oscuro por variables CSS bajo `[data-theme="dark"]`, persistido en localStorage.

**Nunca un porcentaje sin su volumen.** Un 66.7% que son 2 de 3 órdenes no es
comparable con un 5.7% que son 8 de 140. Las etiquetas y tooltips deben mostrar el
conteo (`86% · 100 órd`). La matriz de impacto del módulo General existe justamente
por esto.

**Cortes calculados, no fijos.** La matriz usa el promedio real de la empresa en el eje
Y. El corte de volumen es un mínimo de fiabilidad configurable (default 30).
Se probó la mediana y **no sirve**: con ~58 zonas donde la mayoría tiene menos de 10
órdenes, la mediana cae a ~5 y deja de discriminar.

**Tablas grandes:** paginación de 50 filas, `useMemo` para filtrar. Sin esto la app se
siente lenta con 6 meses de datos.

---

## Pendientes conocidos

- **Rotar credenciales:** el password de MySQL (`dmarquez`) y el `GOOGLE_CLIENT_SECRET`
  quedaron expuestos en un chat. Rotar ambos.
- **Usuario MySQL de solo lectura** para el dashboard (hoy usa uno con escritura).
- La pestaña Histórico del módulo de asignación no tiene paginación todavía.
- El dominio `operaciones.nidix.mx` quedó pendiente por falta de acceso al DNS.
