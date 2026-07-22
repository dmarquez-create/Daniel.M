// Service Worker · Dashboard Nidix
//
// Objetivo: acelerar las visitas repetidas cacheando las librerías pesadas de
// CDN (React, Babel, Recharts, XLSX, Supabase JS) que hoy se re-descargan en
// cada carga. La primera visita queda igual; las siguientes cargan casi
// instantáneo porque esas librerías salen de la caché local.
//
// Estrategia por tipo de petición:
//   - Librerías de CDN (unpkg, jsdelivr): CACHE-FIRST. Son URLs con versión fija
//     (inmutables), así que servirlas de caché es seguro y es el mayor ahorro.
//   - HTML / assets propios (mismo origen): NETWORK-FIRST con fallback a caché.
//     Así un deploy nuevo SIEMPRE se ve al recargar estando en línea, y la app
//     sigue abriendo sin conexión. (Importante: no volver a introducir el
//     problema de "no veo los cambios".)
//   - Supabase / Google / cualquier otra API: passthrough, NUNCA se cachea
//     (son datos y autenticación dinámicos).
//
// Al cambiar algo aquí, subir CACHE_VERSION para invalidar la caché vieja.

const CACHE_VERSION = "nidix-cache-v1";
const CDN_HOSTS = ["unpkg.com", "cdn.jsdelivr.net"];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 1) Librerías de CDN inmutables → cache-first.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(req).then((hit) =>
          hit || fetch(req).then((res) => {
            // res.ok para respuestas CORS; type "opaque" para no-cors (scripts CDN clásicos).
            if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
            return res;
          })
        )
      )
    );
    return;
  }

  // 2) Mismo origen (HTML, manifest, iconos) → network-first, caché como respaldo offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 3) Todo lo demás (Supabase, Google, etc.) → sin interceptar, nunca se cachea.
});
