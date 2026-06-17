// Incrémente ce numéro à CHAQUE déploiement pour forcer la mise à jour du cache.
const SW_VERSION = 'v2';
const CACHE_NAME = 'ospmanager-' + SW_VERSION;

// Fichiers "lourds" peu changeants -> cache-first (libs externes)
const LIB_ASSETS = [
  './pdf.min.mjs',
  './pdf.worker.min.mjs',
  './jszip.min.js',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

// Fichiers de l'app (code/HTML) -> toujours réessayer le réseau d'abord
const APP_ASSETS = [
  './',
  './index.html',
  './app.js'
];

self.addEventListener('install', e=>{
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(c=>c.addAll([...APP_ASSETS, ...LIB_ASSETS]))
  );
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  const isAppFile = url.origin===self.location.origin &&
    APP_ASSETS.some(a=>url.pathname.endsWith(a.replace('./','')) || (a==='./' && (url.pathname.endsWith('/'))));

  if(isAppFile){
    // NETWORK-FIRST : toujours essayer la dernière version en ligne,
    // ne retomber sur le cache (mode hors-ligne) qu'en cas d'échec réseau.
    e.respondWith(
      fetch(req).then(resp=>{
        if(resp.ok){
          const clone=resp.clone();
          caches.open(CACHE_NAME).then(c=>c.put(req, clone));
        }
        return resp;
      }).catch(()=>caches.match(req))
    );
  } else {
    // CACHE-FIRST pour les librairies externes (gros fichiers, changent rarement)
    e.respondWith(
      caches.match(req).then(cached=>{
        if(cached) return cached;
        return fetch(req).then(resp=>{
          if(resp.ok && url.origin===self.location.origin){
            const clone=resp.clone();
            caches.open(CACHE_NAME).then(c=>c.put(req, clone));
          }
          return resp;
        }).catch(()=>cached);
      })
    );
  }
});
