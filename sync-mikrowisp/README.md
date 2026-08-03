# Sync MikroWisp → Supabase (máquina Windows con acceso a la base)

Este programa corre en una máquina de tu red que **sí puede conectarse a la
base MySQL de MikroWisp**. Lee tickets e instalaciones y los sube a Supabase
(`mw_tickets`, `mw_instalaciones`). El dashboard ya lee de esas tablas, así que
no necesita conexión directa a MikroWisp.

## 1. Requisitos
- **Node.js 18+** en esa máquina → https://nodejs.org (instalar el LTS).
- Que desde esa máquina se pueda conectar al MySQL de MikroWisp
  (`199.85.210.108:3306`, o el proxy `:4001` si el 3306 no abre).

## 2. Instalación
Copia esta carpeta `sync-mikrowisp` a la máquina Windows (ej. `C:\sync-mikrowisp`).
Abre **PowerShell** o **CMD** en esa carpeta y:

```
npm install
```

## 3. Configuración
1. Copia `.env.example` a `.env`.
2. Rellena en `.env`:
   - El **password** del usuario `devs` de MikroWisp.
   - El **SUPABASE_SERVICE_KEY** (Supabase → Project Settings → API → `service_role`).
   - Si el puerto `3306` no conecta desde esa máquina, cambia `MIKROWISP_DB_PORT=4001`.

## 4. Probar
```
npm start
```
Debe imprimir algo como:
```
tickets sincronizados: 20012
instalaciones sincronizadas: 26380
SYNC OK 2026-07-31T...
```
Si sale error de conexión, revisa host/puerto/credenciales.

## 5. Programar cada 15 minutos (Programador de tareas de Windows)
1. Abre **Programador de tareas** → **Crear tarea básica**.
2. Nombre: `Sync MikroWisp`.
3. Desencadenador: **Diariamente**, luego en propiedades marca **Repetir cada 15 minutos**
   durante **1 día** (o "indefinidamente").
4. Acción: **Iniciar un programa**
   - Programa/script: `node`  (o la ruta completa: `C:\Program Files\nodejs\node.exe`)
   - Argumentos: `sync.js`
   - Iniciar en: `C:\sync-mikrowisp`  (la carpeta donde está el proyecto)
5. En **Condiciones**, desmarca "Iniciar solo si el equipo usa CA" si es una PC/servidor fijo.
6. En **Configuración**, marca "Ejecutar la tarea lo antes posible si se perdió un inicio".
7. Guardar. (Si pide usuario/contraseña, usa una cuenta que quede logueada o marca
   "Ejecutar tanto si el usuario inició sesión como si no".)

## Notas
- La máquina debe quedarse **encendida** para que el sync corra.
- Los datos del dashboard se actualizan según la frecuencia del sync (15 min).
- El `.env` tiene credenciales: **no lo subas a git** (ya está en `.gitignore`).
- Rota el password de MikroWisp y el token/API que se hayan expuesto en el chat.
