// Collar map for the Dashboard: points by class (Planned / EOH / COH), Esri satellite or topo basemap, popup per hole.
// Leaflet is loaded on demand from the CDN (cached by the service worker after the first online visit), like the Peta tab.
import { esc } from './ui.js';

const LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
export const CLASSES = {
  planned: { label: 'Planned', color: '#64748B', fill: '#FFFFFF' },
  eoh: { label: 'EOH', color: '#15803D', fill: '#22C55E' },
  coh: { label: 'COH', color: '#B45309', fill: '#F59E0B' },
};
let loading = null, cur = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.crossOrigin = 'anonymous'; css.href = LEAFLET + 'leaflet.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.crossOrigin = 'anonymous'; js.src = LEAFLET + 'leaflet.js'; js.onload = res;
    js.onerror = () => { loading = null; rej(new Error('leaflet')); };
    document.head.appendChild(js);
  });
  return loading;
}
export function destroyMap() { if (cur) { try { cur.remove(); } catch {} cur = null; } }

export async function renderCollarMap(el, pts) {
  destroyMap();
  if (!pts.length) { el.innerHTML = '<div class="empty">No collar with coordinates for this selection</div>'; return; }
  try { await loadLeaflet(); }
  catch { el.innerHTML = '<div class="empty">The map needs internet the first time it opens (map library and Esri tiles). Try again when online.</div>'; return; }
  if (!el.isConnected) return;                       // the page was repainted while the library loaded
  const L = window.L;
  el.innerHTML = ''; delete el._leaflet_id;
  const map = cur = L.map(el, { zoomControl: true, preferCanvas: true });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics' });
  const topo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, OpenStreetMap contributors' });
  sat.addTo(map); L.control.layers({ 'Esri satellite': sat, 'Esri topographic': topo }, {}, { collapsed: true }).addTo(map);
  const grp = L.featureGroup();
  for (const p of pts) {
    const c = CLASSES[p.cls] || CLASSES.coh;
    L.circleMarker([p.lat, p.lon], { radius: 6, color: c.color, weight: 1.5, fillColor: c.fill, fillOpacity: 0.95 })
      .bindPopup(`<b>${esc(p.hole)}</b><br>${esc(p.site)}${p.prospect ? ' · ' + esc(p.prospect) : ''}<br>${esc(p.statusLabel || p.status)} (${esc(c.label)})<br>${p.depth != null ? 'Depth ' + (Math.round(p.depth * 10) / 10) + ' m<br>' : ''}<span style="opacity:.7">${esc(p.basis)} position</span>`)
      .addTo(grp);
  }
  grp.addTo(map);
  map.fitBounds(grp.getBounds().pad(0.15), { maxZoom: 17 });
  setTimeout(() => { try { map.invalidateSize(); } catch {} }, 150);
}
