// Peta: collar points by class + any number of uploaded layers (IUP boundary, shapefile, GeoJSON), with a QGIS-style layer panel:
// show/hide, order, colour, line width, dash, fill, opacity, point size, label field, zoom to layer, export to PDF.
// Per-user changes stay on this device; an admin can save the current look as the default for everybody.
// Leaflet is loaded on demand (only when the Peta tab is opened). Collar data comes from the phone's local copy.
import * as D from './db.js';
import * as S from './sync.js';
import { labelOf, metaOf, setting } from './cfg.js';

const LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
const CLASSES = {
  planned:  { label: 'Planned',  color: '#64748B', fill: '#FFFFFF' },
  eoh:      { label: 'EOH',      color: '#15803D', fill: '#22C55E' },
  coh:      { label: 'COH',      color: '#B45309', fill: '#F59E0B' },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 1) => (n == null || isNaN(n)) ? '—' : (Math.round(n * 10 ** d) / 10 ** d).toString();
const DASHES = [['', 'Solid'], ['8 5', 'Putus-putus'], ['2 5', 'Titik']];
const PALETTE = ['#FACC15', '#2563EB', '#DC2626', '#16A34A', '#9333EA', '#EA580C', '#0891B2', '#DB2777'];

let loading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.crossOrigin = 'anonymous'; css.href = LEAFLET + 'leaflet.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.crossOrigin = 'anonymous'; js.src = LEAFLET + 'leaflet.js'; js.onload = res; js.onerror = () => { loading = null; rej(new Error('leaflet')); };
    document.head.appendChild(js);
  });
  return loading;
}

export function classOf(c) {
  const m = metaOf('collar_status', c.status);
  if (m.map_class === 'progress') return 'coh';          // old name of the same class
  if (CLASSES[m.map_class]) return m.map_class;
  return m.is_plan ? 'planned' : 'coh';
}

const defaultStyle = (type, i) => type === 'polygon' ? { stroke: PALETTE[i % PALETTE.length], weight: 2.5, dash: '', fill: PALETTE[i % PALETTE.length], fillOpacity: 0, opacity: 1, radius: 5, labelField: '' }
  : type === 'line' ? { stroke: PALETTE[(i + 1) % PALETTE.length], weight: 2.5, dash: '', fill: '#ffffff', fillOpacity: 0, opacity: 1, radius: 5, labelField: '' }
  : { stroke: '#ffffff', weight: 1.5, dash: '', fill: PALETTE[(i + 2) % PALETTE.length], fillOpacity: .9, opacity: 1, radius: 5, labelField: '' };

let map = null, state = null;
const storeKey = site => `exp_mapstyle_${site}`;
const loadPrefs = site => { try { return JSON.parse(localStorage.getItem(storeKey(site)) || '{}'); } catch { return {}; } };
const savePrefs = () => { try { localStorage.setItem(storeKey(state.site), JSON.stringify(state.prefs)); } catch {} };

export async function showMap(el, noteEl, { info, canAdmin }) {
  if (map) { try { map.remove(); } catch {} map = null; }
  el.innerHTML = ''; delete el._leaflet_id;                       // a refresh must not stack a second layer panel on the first
  try { await loadLeaflet(); }
  catch { el.innerHTML = '<div class="msg warn" style="margin:14px">Peta butuh internet untuk dibuka pertama kali (pustaka peta dan peta dasar Esri). Coba lagi saat online.</div>'; return; }
  const L = window.L;
  const [collars, progress, layerRows] = await Promise.all([D.db.collars.filter(c => !c.is_deleted).toArray(), D.db.progress.filter(p => !p.is_deleted).toArray(), D.db.maplayers.toArray()]);
  const byHole = new Map();
  for (const p of progress) { if (!byHole.has(p.hole_id)) byHole.set(p.hole_id, []); byHole.get(p.hole_id).push(p); }
  const site = info.site;
  const prefs = loadPrefs(site);
  prefs.items = prefs.items || {};
  state = { site, prefs, items: [], canAdmin, info };

  map = L.map(el, { zoomControl: true, attributionControl: true, preferCanvas: false }).setView([-2.5, 118], 5);
  const bases = {
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics' }),
    topo: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, OpenStreetMap contributors' }),
    otm: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc', attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' }),
  };
  const setBase = k => { for (const [n, t] of Object.entries(bases)) (n === k ? t.addTo(map) : map.removeLayer(t)); prefs.base = k; savePrefs(); el.style.background = k === 'none' ? '#fff' : ''; };

  /* ---- items: collar classes + vector layers ---- */
  const bounds = [];
  const counts = Object.fromEntries(Object.keys(CLASSES).map(k => [k, 0]));
  const collarPts = Object.fromEntries(Object.keys(CLASSES).map(k => [k, []]));
  let noCoord = 0;
  for (const c of collars) {
    const asb = c.asbuilt_lat != null && c.asbuilt_lon != null;
    const lat = asb ? c.asbuilt_lat : c.planned_lat, lon = asb ? c.asbuilt_lon : c.planned_lon;
    if (lat == null || lon == null) { noCoord++; continue; }
    const k = classOf(c); counts[k]++; collarPts[k].push({ c, lat, lon, asb });
  }
  const items = [];
  for (const [k, cl] of Object.entries(CLASSES)) items.push({ key: 'c:' + k, kind: 'collar', cls: k, name: `${cl.label} (${counts[k]})`, base: { stroke: cl.color, fill: cl.fill, weight: 2.5, dash: '', fillOpacity: k === 'planned' ? .35 : .95, opacity: 1, radius: 8, labelField: '' }, visible: true });
  const sorted = [...layerRows].sort((a, b) => (b.sort_order ?? 0) - (a.sort_order ?? 0));
  sorted.forEach((r, i) => items.push({ key: 'l:' + r.id, kind: 'vector', id: r.id, name: r.name, geom_type: r.geom_type, geojson: r.geojson, fields: [...new Set((r.geojson?.features || []).slice(0, 200).flatMap(f => Object.keys(f.properties || {})))],
    base: { ...defaultStyle(r.geom_type, i), ...(r.style || {}) }, visible: true, serverSort: r.sort_order }));
  for (const it of items) { const o = prefs.items[it.key] || {}; it.style = { ...it.base, ...(o.style || {}) }; it.visible = o.visible ?? true; }
  // order: user's saved order first, new layers on top of the collars' own default position
  const saved = prefs.order || [];
  items.sort((a, b) => { const ia = saved.indexOf(a.key), ib = saved.indexOf(b.key); if (ia < 0 && ib < 0) return 0; if (ia < 0) return 1; if (ib < 0) return -1; return ia - ib; });
  state.items = items;

  const popupCollar = ({ c, lat, lon, asb }, st) => {
    const runs = (byHole.get(c.hole_id) || []).sort((a, b) => (b.work_date + b.to_m).toString().localeCompare((a.work_date + a.to_m).toString()));
    const ach = runs.length ? Math.max(...runs.map(r => r.to_m)) : null;
    const withCore = runs.filter(r => r.core_len_m != null);
    const coreLen = withCore.reduce((t, r) => t + r.core_len_m, 0), coreM = withCore.reduce((t, r) => t + (r.to_m - r.from_m), 0);
    const pct = c.planned_depth_m > 0 && ach != null ? ach / c.planned_depth_m * 100 : null;
    return `<div class="mp"><b>${esc(c.hole_id)}</b> <span class="mp-tag" style="background:${st.fill};border-color:${st.color}">${st.label}</span>
      <table>
      <tr><td>Tipe</td><td>${esc(labelOf('hole_type', c.hole_type))}</td></tr>
      <tr><td>Prospect</td><td>${esc(c.prospect || '—')}</td></tr>
      <tr><td>Status</td><td>${esc(labelOf('collar_status', c.status))}</td></tr>
      <tr><td>Rencana</td><td>${fmt(c.planned_depth_m, 2)} m</td></tr>
      <tr><td>Capaian</td><td>${fmt(ach, 2)} m${pct != null ? ` (${fmt(pct)}%)` : ''}</td></tr>
      <tr><td>Total depth</td><td>${fmt(c.total_depth_m, 2)} m</td></tr>
      <tr><td>Core</td><td>${withCore.length ? `${fmt(coreLen, 2)} m · recovery ${fmt(coreLen / coreM * 100)}%` : '—'}</td></tr>
      <tr><td>Koordinat</td><td>${asb ? 'as-built' : 'planned'} ${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}</td></tr>
      </table>
      ${runs.length ? `<div class="mp-h">Progress terakhir</div>` + runs.slice(0, 5).map(r => `<div class="mp-r">${esc(r.work_date)} · ${r.from_m}–${r.to_m} m · ${esc(r.rig_id)}${r.core_len_m != null ? ` · core ${r.core_len_m} m` : ''}</div>`).join('') + (runs.length > 5 ? `<div class="mp-r muted">+${runs.length - 5} lainnya (lihat Riwayat)</div>` : '') : '<div class="mp-r muted">Belum ada progress.</div>'}
    </div>`;
  };
  const popupFeature = (name, p) => { const e = Object.entries(p || {}).slice(0, 20); return `<div class="mp"><b>${esc(name)}</b>${e.length ? `<table>${e.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : '<div class="mp-r muted">Tanpa atribut.</div>'}</div>`; };

  const lstyle = it => { const s = it.style; return { color: s.stroke, weight: s.weight, dashArray: s.dash || null, opacity: s.opacity, fillColor: s.fill, fillOpacity: (s.fillOpacity ?? 0) * s.opacity }; };
  const label = (lyr, text, st) => { lyr.unbindTooltip(); if (st.labelField && text != null && text !== '') lyr.bindTooltip(esc(text), { permanent: true, direction: 'center', className: 'maplabel', opacity: st.opacity }); };
  const build = it => {
    it.pane = 'p_' + it.key.replace(/\W/g, '_'); map.createPane(it.pane);
    const renderer = L.svg({ pane: it.pane });
    if (it.kind === 'collar') {
      it.leaflet = L.layerGroup(); const st = CLASSES[it.cls]; it.markers = [];
      for (const pt of collarPts[it.cls]) {
        const m = L.circleMarker([pt.lat, pt.lon], { pane: it.pane, renderer, radius: it.style.radius, ...lstyle(it) });
        m.bindTooltip(`${esc(pt.c.hole_id)} · ${st.label}`, { direction: 'top', offset: [0, -6] });
        m.bindPopup(popupCollar(pt, st), { maxWidth: 300 });
        m.hole = pt.c.hole_id; it.markers.push(m); m.addTo(it.leaflet); bounds.push(L.latLngBounds([[pt.lat, pt.lon], [pt.lat, pt.lon]]));
      }
    } else {
      it.leaflet = L.geoJSON(it.geojson, { pane: it.pane, renderer, style: () => lstyle(it),
        pointToLayer: (f, ll) => L.circleMarker(ll, { pane: it.pane, renderer, radius: it.style.radius, ...lstyle(it) }),
        onEachFeature: (f, lyr) => lyr.bindPopup(popupFeature(it.name, f.properties), { maxWidth: 300 }) });
      try { const b = it.leaflet.getBounds(); if (b.isValid()) bounds.push(b); } catch {}
    }
    apply(it);
  };
  const apply = it => {   // push the current style to the drawn layer
    const fn = () => lstyle(it);
    if (it.kind === 'collar') { it.markers.forEach(m => { m.setStyle(fn()); m.setRadius(it.style.radius); label(m, it.style.labelField ? m.hole : null, it.style); }); }
    else it.leaflet.eachLayer(l => { l.setStyle(fn()); if (l.setRadius) l.setRadius(it.style.radius); label(l, it.style.labelField ? l.feature?.properties?.[it.style.labelField] : null, it.style); });
    if (it.visible) it.leaflet.addTo(map); else map.removeLayer(it.leaflet);
  };
  const zorder = () => { const n = items.length; items.forEach((it, i) => { const p = map.getPane(it.pane); if (p) p.style.zIndex = 410 + (n - i) * 2; }); };
  items.forEach(build); zorder();
  setBase(prefs.base || 'sat');
  if (bounds.length) map.fitBounds(bounds.reduce((a, b) => a.extend(b), L.latLngBounds(bounds[0].getSouthWest(), bounds[0].getNorthEast())), { padding: [30, 30], maxZoom: 17 });

  /* ---- panel ---- */
  const open = new Set();
  const panelBox = document.createElement('div'); panelBox.className = 'mlp'; panelBox.hidden = prefs.panel === undefined ? innerWidth < 560 : prefs.panel === false;   // phones start with the panel closed
  const toggle = document.createElement('button'); toggle.className = 'mlp-toggle'; toggle.type = 'button'; toggle.textContent = 'Layer';
  toggle.onclick = () => { panelBox.hidden = !panelBox.hidden; prefs.panel = !panelBox.hidden; savePrefs(); };
  el.appendChild(toggle); el.appendChild(panelBox);
  L.DomEvent.disableClickPropagation(panelBox); L.DomEvent.disableScrollPropagation(panelBox); L.DomEvent.disableClickPropagation(toggle);

  const persist = () => { prefs.order = items.map(i => i.key); items.forEach(i => { prefs.items[i.key] = { visible: i.visible, style: diff(i.style, i.base) }; }); savePrefs(); };
  const diff = (a, b) => Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== b[k]));
  const swatch = it => `<i class="sw" style="background:${it.style.fillOpacity > 0 || it.kind === 'collar' || it.geom_type === 'point' ? it.style.fill : 'transparent'};border:${Math.min(3, Math.max(1.5, it.style.weight))}px ${it.style.dash ? 'dashed' : 'solid'} ${it.style.stroke}"></i>`;

  const paint = () => {
    panelBox.innerHTML = `
    <div class="mlp-h"><b>Layer</b><select id="mlp-base">${[['sat', 'Satelit (Esri)'], ['topo', 'Topografi (Esri)'], ['otm', 'OpenTopoMap (OpenStreetMap)'], ['none', 'Tanpa peta dasar']].map(([k, t]) => `<option value="${k}" ${(prefs.base || 'sat') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="mlp-list">${items.map((it, i) => {
      const s = it.style, isV = it.kind === 'vector', pt = it.kind === 'collar' || it.geom_type === 'point' || it.geom_type === 'mixed', ar = it.geom_type === 'polygon' || it.geom_type === 'mixed';
      return `<div class="mlp-row" data-k="${esc(it.key)}">
        <div class="mlp-top"><input type="checkbox" data-a="vis" ${it.visible ? 'checked' : ''} aria-label="Tampilkan"> ${swatch(it)}<span class="mlp-name" data-a="open" title="Atur tampilan">${esc(it.name)}</span>
          <button data-a="up" ${i === 0 ? 'disabled' : ''} aria-label="Naik">↑</button><button data-a="down" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Turun">↓</button></div>
        ${open.has(it.key) ? `<div class="mlp-ed">
          <label>Garis<input type="color" data-s="stroke" value="${esc(s.stroke)}"></label>
          <label>Tebal<input type="range" data-s="weight" min="0.5" max="8" step="0.5" value="${s.weight}"></label>
          <label>Pola<select data-s="dash">${DASHES.map(([v, t]) => `<option value="${v}" ${s.dash === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          ${ar || pt ? `<label>Isi<input type="color" data-s="fill" value="${esc(s.fill)}"></label><label>Isi transparan<input type="range" data-s="fillOpacity" min="0" max="1" step="0.05" value="${s.fillOpacity}"></label>` : ''}
          ${pt ? `<label>Ukuran titik<input type="range" data-s="radius" min="2" max="14" step="1" value="${s.radius}"></label>` : ''}
          <label>Opasitas layer<input type="range" data-s="opacity" min="0.1" max="1" step="0.05" value="${s.opacity}"></label>
          <label>Label<select data-s="labelField"><option value="">(tanpa)</option>${(isV ? it.fields : ['hole_id']).map(f => `<option value="${esc(f)}" ${s.labelField === f ? 'selected' : ''}>${esc(f === 'hole_id' ? 'Hole ID' : f)}</option>`).join('')}</select></label>
          <div class="mlp-btns"><button class="btn small" data-a="zoom">Zoom ke layer</button><button class="btn small" data-a="reset">Reset</button></div>
        </div>` : ''}</div>`;
    }).join('')}</div>
    <div class="mlp-f"><button class="btn small primary" id="mlp-pdf">Ekspor PDF</button></div>`;
    panelBox.querySelector('#mlp-base').onchange = e => setBase(e.target.value);
    panelBox.querySelector('#mlp-pdf').onclick = () => openPdf();
    panelBox.querySelectorAll('.mlp-row').forEach(row => {
      const it = items.find(x => x.key === row.dataset.k);
      row.querySelectorAll('[data-a]').forEach(b => { const a = b.dataset.a;
        if (a === 'vis') b.onchange = () => { it.visible = b.checked; apply(it); persist(); };
        else b.onclick = async () => {
          const i = items.indexOf(it);
          if (a === 'open') { open.has(it.key) ? open.delete(it.key) : open.add(it.key); paint(); }
          else if (a === 'up' || a === 'down') { const j = a === 'up' ? i - 1 : i + 1; [items[i], items[j]] = [items[j], items[i]]; zorder(); persist(); paint(); }
          else if (a === 'zoom') { try { const bb = it.kind === 'collar' ? L.latLngBounds(it.markers.map(m => m.getLatLng())) : it.leaflet.getBounds(); if (bb.isValid()) map.fitBounds(bb, { padding: [30, 30], maxZoom: 17 }); } catch {} }
          else if (a === 'reset') { it.style = { ...it.base }; it.visible = true; apply(it); persist(); paint(); }
        };
      });
      row.querySelectorAll('[data-s]').forEach(inp => {
        const f = inp.dataset.s;
        const set = () => { it.style[f] = inp.type === 'range' ? Number(inp.value) : inp.value; apply(it); persist(); const sw = row.querySelector('.sw'); if (sw) sw.outerHTML = swatch(it); };
        inp.oninput = set; if (inp.tagName === 'SELECT') inp.onchange = set;
      });
    });
  };
  paint();

  /* ---- PDF dialog ---- */
  const openPdf = () => {
    const vis = items.filter(i => i.visible);
    const metaKey = `exp_pdfmeta_${site}`;
    let meta = {}; try { meta = JSON.parse(localStorage.getItem(metaKey) || '{}'); } catch {}
    meta.copyright = meta.copyright ?? 'This document and its content is copyright of PT Central Abadi Nusantara Any redistribution or reproduction of part or all of the contents in any form is prohibited.';
    meta.sources = meta.sources ?? '1. Badan Informasi Geospasial, Scale 50.000, Year 2019\n2. Rupa Bumi Indonesia, Scale 50.000, Year 2019';
    const wrap = document.createElement('div'); wrap.className = 'mpdf';
    wrap.innerHTML = `<form class="card"><h2>Ekspor peta ke PDF</h2>
      <label>Judul<input name="title" value="Peta eksplorasi ${esc(site)}" required></label>
      <label>Sub-judul<input name="subtitle" placeholder="mis. Progress pengeboran per ${new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })}"></label>
      <div class="row"><label>Layout<select name="layout"><option value="can">Drillhole Plan Map (grid UTM, A3)</option><option value="default">Standar</option></select></label>
        <label>Skala 1 :<input name="scale" type="number" min="500" step="100" placeholder="otomatis"></label></div>
      <div class="row"><label>Kertas<select name="paper"><option>A4</option><option selected>A3</option><option>A2</option></select></label>
        <label>Cakupan<select name="extent"><option value="view">Tampilan peta sekarang</option><option value="all">Semua layer terlihat</option></select></label></div>
      <div class="row"><label>Peta dasar<select name="base"><option value="${prefs.base || 'sat'}">Sama seperti di layar</option><option value="none">Tanpa peta dasar</option></select></label>
        <label>Resolusi<select name="dpi"><option value="150">Ringan (150 dpi)</option><option value="200" selected>Standar (200 dpi)</option><option value="300">Tajam (300 dpi)</option></select></label></div>
      <details><summary class="small"><b>Teks layout</b> (layout Drillhole Plan Map)</summary>
        <div class="row"><label>Lokasi baris 1<input name="loc1" value="${esc(meta.loc1 || '')}" placeholder="mis. TOWUTI, EAST LUWU DISTRICT"></label><label>Lokasi baris 2<input name="loc2" value="${esc(meta.loc2 || '')}" placeholder="mis. SOUTH SULAWESI PROVINCE"></label></div>
        <label>Nama perusahaan<input name="company" value="${esc(meta.company || '')}"></label>
        <label>Alamat perusahaan<textarea name="address" rows="2">${esc(meta.address || '')}</textarea></label>
        <label>Sumber data<textarea name="sources" rows="3">${esc(meta.sources || '')}</textarea></label>
        <label>Copyright<textarea name="copyright" rows="3">${esc(meta.copyright || '')}</textarea></label>
        <div class="row"><label>Map No<input name="mapNo" value="${esc(meta.mapNo || '')}"></label><label>File<input name="file" value="${esc(meta.file || site)}"></label></div>
        <div class="row"><label>Drafted By<input name="drafted" value="${esc(meta.drafted || '')}"></label><label>Checked By<input name="checked" value="${esc(meta.checked || '')}"></label></div>
      </details>
      <p class="muted small">${vis.length} layer ikut tercetak sesuai urutan dan tampilan di panel. Peta dasar butuh internet. Layout Drillhole Plan memakai grid UTM (zona dari Pengaturan, atau dibaca dari lokasi).</p>
      <div id="pdfmsg"></div>
      <div class="row actions"><button class="btn primary" type="submit">Buat PDF</button><button class="btn" type="button" id="pdf-x">Batal</button></div></form>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#pdf-x').onclick = () => wrap.remove();
    wrap.querySelector('form').onsubmit = async e => {
      e.preventDefault(); const f = e.target.elements, btn = e.target.querySelector('.primary'), msg = wrap.querySelector('#pdfmsg');
      btn.disabled = true; msg.innerHTML = '<div class="msg ok">Membuat PDF…</div>';
      try {
        let bb;
        if (f.extent.value === 'view') { const b = map.getBounds(); bb = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; }
        else { const bs = vis.map(i => i.kind === 'collar' ? (i.markers.length ? L.latLngBounds(i.markers.map(m => m.getLatLng())) : null) : i.leaflet.getBounds()).filter(b => b && b.isValid()); if (!bs.length) throw new Error('Tidak ada layer terlihat.'); const u = bs.reduce((a, b) => a.extend(b), L.latLngBounds(bs[0].getSouthWest(), bs[0].getNorthEast())); bb = [u.getWest(), u.getSouth(), u.getEast(), u.getNorth()]; }
        const { exportPdf } = await import('./printmap.js');
        const pr = items.map(i => i.kind === 'collar' ? { ...i, points: collarPts[i.cls].map(p => ({ lat: p.lat, lon: p.lon, hole_id: p.c.hole_id })), name: CLASSES[i.cls].label } : i);
        const mt = Object.fromEntries(['loc1', 'loc2', 'company', 'address', 'sources', 'copyright', 'mapNo', 'file', 'drafted', 'checked'].map(k => [k, f[k].value.trim()]));
        try { localStorage.setItem(metaKey, JSON.stringify(mt)); } catch {}
        const zn = setting('utm_zone');
        const r = await exportPdf({ items: pr, bounds: bb, title: f.title.value, subtitle: f.subtitle.value, paper: f.paper.value, base: f.base.value, dpi: Number(f.dpi.value), site, author: info.guest ? '' : `Dibuat oleh ${info.name}`,
          layout: f.layout.value, scale: Number(f.scale.value) || 0, meta: { ...mt, drafted: mt.drafted || (info.guest ? '' : info.name) }, utm: zn ? { zone: Number(zn), hemisphere: setting('utm_hemisphere') || 'S' } : null });
        msg.innerHTML = `<div class="msg ok">PDF dibuat (${(r.bytes / 1048576).toFixed(1)} MB, skala 1 : ${r.scale.toLocaleString('id-ID')})${f.base.value !== 'none' && !r.tiles.ok ? '. Peta dasar tidak berhasil dimuat; layer tetap tercetak.' : ''}</div>`;
        btn.disabled = false;
      } catch (err) { msg.innerHTML = `<div class="msg err">${esc(err.message || err)}</div>`; btn.disabled = false; }
    };
  };

  noteEl.innerHTML = `<p class="muted small" style="margin:8px 14px">${collars.length} collar${noCoord ? `, ${noCoord} tanpa koordinat (tidak tampil)` : ''}. Titik memakai koordinat as-built bila ada, kalau tidak planned. Ketuk titik atau objek untuk detail. ${layerRows.length ? '' : canAdmin ? 'Belum ada layer: unggah batas IUP atau shapefile di Pengaturan &gt; Layer peta.' : 'Belum ada layer yang diunggah admin.'} Pengaturan tampilan tersimpan di perangkat ini.</p>`;
  setTimeout(() => map && map.invalidateSize(), 150);
}
