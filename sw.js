const V='gc-v2';const FILES=['./','index.html','style.css','config.js','manifest.webmanifest','js/pubkey.js','js/license.js','js/geo.js','js/cloud.js','js/app.js','vendor/leaflet.js','vendor/leaflet.css','icons/icon-192.png','icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET')return;
 if(u.origin!==location.origin){ if(u.hostname.endsWith('tile.openstreetmap.org')){e.respondWith(caches.open('gc-tiles').then(async c=>{const m=await c.match(e.request);if(m)return m;try{const r=await fetch(e.request);c.put(e.request,r.clone());return r}catch(_){return new Response('',{status:504})}}))} return;}
 e.respondWith(caches.match(e.request).then(m=>m||fetch(e.request)))});
