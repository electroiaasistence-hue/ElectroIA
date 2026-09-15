/* ============================================================
   SERVICE WORKER — ElectroIA
   ------------------------------------------------------------
   POR QUÉ IMPORTA AQUÍ MÁS QUE EN OTRAS APPS
   Una urgencia eléctrica suele venir con la luz cortada. Sin luz
   no hay wifi, y con datos móviles la cobertura dentro de un
   cuarto de contadores es mala. Justo cuando más se necesita la
   app es cuando peor está la conexión.

   El diagnóstico guiado es lógica local: no necesita servidor.
   Con este fichero, la app abre y diagnostica sin internet.

   ESTRATEGIA
   · Documento HTML: red primero, caché de respaldo. Así un
     despliegue nuevo llega enseguida, pero si no hay conexión
     se abre la última versión guardada.
   · Imágenes y estáticos: caché primero. No cambian casi nunca
     y son lo más pesado.
   · /api/: NUNCA se cachea. Devolver un diagnóstico viejo o un
     plan caducado sería peor que fallar.
   ============================================================ */

const VERSION = 'eia-v1';
const CACHE_APP = `${VERSION}-app`;
const CACHE_EST = `${VERSION}-estaticos`;

// Lo mínimo para que la app arranque sin conexión.
const ESENCIALES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_APP)
      // addAll falla entero si un recurso falla; se piden de a uno
      // para que un 404 aislado no impida instalar el worker.
      .then(cache => Promise.all(
        ESENCIALES.map(url =>
          cache.add(url).catch(err => console.warn('SW no pudo cachear', url, err))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(claves => Promise.all(
        claves.filter(c => !c.startsWith(VERSION)).map(c => caches.delete(c))
      ))
      .then(() => self.clients.claim())
  );
});

function esEstatico(url) {
  return /\.(png|jpe?g|svg|webp|ico|woff2?|css)$/i.test(url.pathname)
      || url.pathname.startsWith('/img/');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Solo el propio origen: no interceptamos llamadas a terceros.
  if (url.origin !== self.location.origin) return;

  // La API nunca se cachea: un plan o un diagnóstico obsoleto
  // confunde más de lo que ayuda.
  if (url.pathname.startsWith('/api/')) return;

  // Documentos: red primero para que un despliegue llegue ya.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then(resp => {
          const copia = resp.clone();
          caches.open(CACHE_APP).then(c => c.put(req, copia)).catch(() => {});
          return resp;
        })
        .catch(() =>
          caches.match(req)
            .then(r => r || caches.match('/index.html'))
            .then(r => r || new Response(
              '<!doctype html><meta charset="utf-8"><title>Sin conexión</title>' +
              '<body style="font-family:system-ui;background:#0b1220;color:#e8eef6;padding:32px;line-height:1.6">' +
              '<h1 style="font-size:22px">Sin conexión</h1>' +
              '<p>No se pudo cargar ElectroIA y todavía no hay una copia guardada en este dispositivo.</p>' +
              '<p><b>Si hay humo, olor a quemado, chispas o alguien recibió una descarga:</b> cortá la corriente ' +
              'si podés hacerlo con seguridad y llamá a emergencias.</p></body>',
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            ))
        )
    );
    return;
  }

  // Estáticos: caché primero, y se refresca por detrás.
  if (esEstatico(url)) {
    event.respondWith(
      caches.match(req).then(cacheado => {
        const red = fetch(req).then(resp => {
          if (resp && resp.status === 200) {
            const copia = resp.clone();
            caches.open(CACHE_EST).then(c => c.put(req, copia)).catch(() => {});
          }
          return resp;
        }).catch(() => cacheado);
        return cacheado || red;
      })
    );
    return;
  }

  // El resto: red con respaldo en caché.
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
