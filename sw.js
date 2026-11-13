// Service worker: app shell offline + runtime cache for CDN libs. API Supabase tidak pernah di-cache.
const V = 'exp-pwa-v37';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'css/ds/tokens.css', 'css/ds/base.css', 'css/ds/components.css', 'css/ds/shell.css', 'css/screens.css', 'css/dash.css', 'styleguide.html', 'js/ui.js',
  'js/app.js', 'js/config.js', 'js/cfg.js', 'js/db.js', 'js/sync.js', 'js/validate.js', 'js/admin.js', 'js/xlsx-lite.js', 'js/template.js', 'js/records.js', 'js/icons.js', 'js/map.js', 'js/importer.js', 'js/utm.js', 'js/shp.js', 'js/printmap.js', 'js/zip.js', 'js/report.js', 'js/dash/dash.js', 'js/dash/map.js', 'js/dash/export.js', 'js/dash/hub.js', 'js/dash/calc.js', 'js/dash/ui.js', 'js/dash/page.js', 'js/dash/data.js', 'js/dash/dashconfig.js', 'js/lab/xlsxw.js', 'js/lab/workbook.js', 'js/qc/calc.js', 'js/qc/data.js', 'js/qc/view.js', 'js/roa/parse.js', 'js/roa/pdf.js', 'js/roa/commit.js', 'js/roa/view.js', 'js/vendor/pdf.min.mjs', 'js/vendor/pdf.worker.min.mjs', 'js/vendor/chart.umd.min.js', 'js/vendor/xlsx.mini.min.js',
  'fonts/geist-latin-wght-normal.woff2', 'fonts/geist-latin-ext-wght-normal.woff2', 'fonts/geist-mono-latin-wght-normal.woff2', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));   // one missing file must not block the whole update
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return; // API/Storage: network only
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && url.hostname !== 'cdn.jsdelivr.net') return;
  e.respondWith((async () => {
    const cache = await caches.open(V);
    const hit = await cache.match(req, { ignoreSearch: sameOrigin });
    const net = fetch(req).then(r => { if (r && r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }          // stale-while-revalidate
    const r = await net;
    if (r) return r;
    if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
    return Response.error();
  })());
});
self.addEventListener('sync', e => {
  if (e.tag === 'exp-sync') e.waitUntil(self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage('exp-sync'))));
});