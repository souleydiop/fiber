const CACHE_NAME='ospmanager-v5';
const ASSETS=[
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS)));
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
  );
});

self.addEventListener('fetch', e=>{
  e.respondWith(
    caches.match(e.request).then(cached=>{
      if(cached) return cached;
      return fetch(e.request).then(resp=>{
        if(e.request.method==='GET' && resp.ok && e.request.url.startsWith(self.location.origin)){
          const clone=resp.clone();
          caches.open(CACHE_NAME).then(c=>c.put(e.request, clone));
        }
        return resp;
      }).catch(()=>cached);
    })
  );
});
