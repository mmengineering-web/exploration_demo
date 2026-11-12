// Map -> PDF (QGIS-print-layout style): map frame with coordinate ticks, title, legend, scale bar, north arrow, info block.
// The map is drawn by this file (Web Mercator tiles + the visible layers with their current styles), so the PDF does not
// depend on what Leaflet shows on screen. The page arrangement is data (LAYOUTS): another template = another items list.
import { latLonToUtm, utmToLatLon, zoneOf } from './utm.js';
let jspdfLoading = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
  if (jspdfLoading) return jspdfLoading;
  jspdfLoading = new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'js/vendor/jspdf.umd.min.js';
    sc.onload = () => res(window.jspdf.jsPDF); sc.onerror = () => { jspdfLoading = null; rej(new Error('Pustaka PDF gagal dimuat.')); };
    document.head.appendChild(sc);
  });
  return jspdfLoading;
}

const R = 6378137, HALF = Math.PI * R;
const mx = lon => R * lon * Math.PI / 180;
const my = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
export const PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };
const BASES = {
  sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', credit: 'Esri, Maxar, Earthstar Geographics' },
  topo: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', credit: 'Esri, HERE, Garmin, USGS, OpenStreetMap contributors' },
  otm: { url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', credit: 'OpenStreetMap contributors, SRTM | OpenTopoMap (CC-BY-SA)', maxZ: 17 },
};

// ---- page layouts (mm, landscape). type: map | label | legend | scalebar | north | info | rect ----
// Placeholders in text: {title} {subtitle} {site} {date} {author} {scale} {zone}
export const LAYOUTS = {
  default: (W, H) => {
    const sw = Math.min(80, Math.max(62, W * 0.24)), mw = W - 20 - sw - 6, sx = W - 10 - sw;
    return { name: 'Standar', items: [
      { type: 'map', x: 14, y: 14, w: mw - 4, h: H - 28, frame: true },
      { type: 'rect', x: sx, y: 10, w: sw, h: H - 20 },
      { type: 'label', x: sx + 3, y: 14, w: sw - 6, h: 20, text: '{title}', size: 14, bold: true },
      { type: 'label', x: sx + 3, y: 34, w: sw - 6, h: 14, text: '{subtitle}', size: 8.5 },
      { type: 'legend', x: sx + 3, y: 52, w: sw - 6, h: H - 52 - 66 },
      { type: 'north', x: sx + sw - 16, y: H - 10 - 62, size: 12 },
      { type: 'scalebar', x: sx + 3, y: H - 10 - 38, w: sw - 6 },
      { type: 'label', x: sx + 3, y: H - 10 - 22, w: sw - 6, h: 20, text: 'Skala 1 : {scale} (cetak asli)\nSite {site}  ·  {date}\n{author}\n{zone}', size: 7, color: '#475569' },
    ] };
  },
};

const hex = c => { c = String(c || '#000000').replace('#', ''); if (c.length === 3) c = c.split('').map(x => x + x).join(''); return [parseInt(c.slice(0, 2), 16) || 0, parseInt(c.slice(2, 4), 16) || 0, parseInt(c.slice(4, 6), 16) || 0]; };
const niceNum = v => { const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p; };

async function fetchTile(url) {
  try { const r = await fetch(url, { mode: 'cors' }); if (!r.ok) return null; return await createImageBitmap(await r.blob()); } catch { return null; }
}

// af = affine map mercator metres -> canvas pixels: x = a*mx + c*my + e, y = b*mx + d*my + f (y of mercator points up)
// (plain Web Mercator view: a = ppm, d = -ppm; UTM view: slightly rotated/scaled so the page matches the UTM grid)
function drawBase(ctx, af, pxW, pxH, base) {
  const det = af.a * af.d - af.c * af.b;
  const inv = (x, y) => { const X = x - af.e, Y = y - af.f; return [(af.d * X - af.c * Y) / det, (-af.b * X + af.a * Y) / det]; };
  const cs = [inv(0, 0), inv(pxW, 0), inv(0, pxH), inv(pxW, pxH)];
  const bx0 = Math.min(...cs.map(p => p[0])), bx1 = Math.max(...cs.map(p => p[0])), by0 = Math.min(...cs.map(p => p[1])), by1 = Math.max(...cs.map(p => p[1]));
  const pxPerM = Math.hypot(af.a, af.b), mpp = 1 / pxPerM;
  let z = Math.min(BASES[base].maxZ || 18, Math.max(0, Math.ceil(Math.log2(156543.03392 / mpp))));
  const range = z => { const t = 2 * HALF / 2 ** z; return { t, c0: Math.floor((bx0 + HALF) / t), c1: Math.floor((bx1 + HALF) / t), r0: Math.floor((HALF - by1) / t), r1: Math.floor((HALF - by0) / t) }; };
  let rg = range(z);
  while (z > 0 && (rg.c1 - rg.c0 + 1) * (rg.r1 - rg.r0 + 1) > 140) { z--; rg = range(z); }
  const jobs = [];
  for (let tc = rg.c0; tc <= rg.c1; tc++) for (let tr = rg.r0; tr <= rg.r1; tr++) jobs.push([tc, tr]);
  let ok = 0, fail = 0, i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const [tc, tr] = jobs[i++];
      const bmp = await fetchTile(BASES[base].url.replace('{z}', z).replace('{x}', tc).replace('{y}', tr));
      if (!bmp) { fail++; continue; }
      ok++;
      ctx.save(); ctx.setTransform(af.a, af.b, -af.c, -af.d, af.e, af.f);      // tile-local axes: u = mx, v = -my (image rows go down)
      ctx.drawImage(bmp, tc * rg.t - HALF, tr * rg.t - HALF, rg.t + 0.6 * mpp, rg.t + 0.6 * mpp);
      ctx.restore();
    }
  };
  return Promise.all(Array.from({ length: 8 }, worker)).then(() => ({ ok, fail }));
}

function drawVectors(ctx, items, P, dpi) {          // P(lon, lat) -> [px, py]
  const mmpx = dpi / 25.4, k = dpi / 96 * 0.6;
  const labels = []; const placed = [];
  const dash = d => (d ? String(d).split(/[ ,]+/).map(Number).map(n => n * k) : []);
  for (const it of [...items].reverse()) {                       // list is top-first, paint bottom-first
    if (!it.visible) continue;
    const st = it.style, op = st.opacity ?? 1;
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = st.stroke; ctx.fillStyle = st.fill; ctx.lineWidth = (st.weight ?? 2) * k; ctx.setLineDash(dash(st.dash));
    if (it.kind === 'collar') {
      ctx.globalAlpha = op; const r = (st.radius ?? 8) * k;
      for (const p of it.points) {
        const [x, y] = P(p.lon, p.lat);
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.globalAlpha = op * (st.fillOpacity ?? .9); ctx.fill(); ctx.globalAlpha = op; ctx.setLineDash([]); ctx.stroke();
        if (st.labelField) labels.push({ x: x + r + 2, y, t: p.hole_id, size: 8 });
      }
    } else {
      for (const f of it.geojson.features) {
        const g = f.geometry; if (!g) continue;
        const draw = (g) => {
          if (g.type === 'Point' || g.type === 'MultiPoint') {
            const pts = g.type === 'Point' ? [g.coordinates] : g.coordinates, r = (st.radius ?? 5) * k;
            for (const c of pts) { const [x, y] = P(c[0], c[1]); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.globalAlpha = op * (st.fillOpacity ?? .8); ctx.fill(); ctx.globalAlpha = op; ctx.setLineDash([]); ctx.stroke(); }
          } else {
            const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
            const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : null;
            if (polys) for (const rings of polys) {
              ctx.beginPath(); for (const ring of rings) { ring.forEach((c, i) => { const [x, y] = P(c[0], c[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); }
              if ((st.fillOpacity ?? 0) > 0) { ctx.globalAlpha = op * st.fillOpacity; ctx.fill('evenodd'); }
              ctx.globalAlpha = op; ctx.stroke();
            }
            if (lines) for (const l of lines) { ctx.beginPath(); l.forEach((c, i) => { const [x, y] = P(c[0], c[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.globalAlpha = op; ctx.stroke(); }
          }
        };
        if (g.type === 'GeometryCollection') g.geometries.forEach(draw); else draw(g);
        if (st.labelField && f.properties?.[st.labelField] != null) {
          const c = centre(g); if (c) { const [x, y] = P(c[0], c[1]); labels.push({ x, y, t: String(f.properties[st.labelField]), size: 8, mid: true }); }
        }
      }
    }
    ctx.restore();
  }
  ctx.font = `${8 * dpi / 72}px Helvetica, Arial, sans-serif`; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const l of labels.slice(0, 4000)) {
    const w = ctx.measureText(l.t).width, h = 8 * dpi / 72, x = l.mid ? l.x - w / 2 : l.x;
    if (x < 0 || l.y < 0 || x + w > ctx.canvas.width || l.y > ctx.canvas.height) continue;
    if (placed.some(b => x < b[2] && x + w > b[0] && l.y - h / 2 < b[3] && l.y + h / 2 > b[1])) continue;
    placed.push([x, l.y - h / 2, x + w, l.y + h / 2]);
    ctx.lineWidth = 3 * dpi / 96 * .6; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(l.t, x, l.y); ctx.fillStyle = '#0F172A'; ctx.fillText(l.t, x, l.y);
  }
}
function centre(g) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  const w = a => { if (typeof a[0] === 'number') { x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]); } else a.forEach(w); };
  if (g.coordinates) w(g.coordinates); return x1 >= x0 ? [(x0 + x1) / 2, (y0 + y1) / 2] : null;
}

// ---- main ----
// opts: { items (top-first, with visible/style/geojson|points), bounds:[w,s,e,n] lon/lat, title, subtitle, site, author, zoneNote,
//         paper:'A4', base:'sat'|'topo'|'otm'|'none', dpi, layout:'default', filename }
export async function exportPdf(opts) {
  if (opts.layout === 'can') return exportCan(opts);
  const JsPDF = await loadJsPdf();
  const [pw, ph] = PAPERS[opts.paper] || PAPERS.A4;
  const lay = (LAYOUTS[opts.layout] || LAYOUTS.default)(pw, ph);
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: [pw, ph] });
  const mapIt = lay.items.find(i => i.type === 'map');
  // view extent in mercator, same aspect as the frame, 6% padding
  const [w, s, e, n] = opts.bounds;
  let x0 = mx(w), x1 = mx(e), y0 = my(s), y1 = my(n);
  const padX = Math.max((x1 - x0) * .06, 20), padY = Math.max((y1 - y0) * .06, 20);
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
  const asp = mapIt.w / mapIt.h; let cw = x1 - x0, ch = y1 - y0;
  if (cw / ch > asp) { const nh = cw / asp, d = (nh - ch) / 2; y0 -= d; y1 += d; } else { const nw = ch * asp, d = (nw - cw) / 2; x0 -= d; x1 += d; }
  const ext = { x0, x1, y0, y1 };
  const dpi = Math.min(opts.dpi || 200, 4600 / (mapIt.w / 25.4));
  const pxW = Math.round(mapIt.w / 25.4 * dpi), pxH = Math.round(mapIt.h / 25.4 * dpi);
  const cv = document.createElement('canvas'); cv.width = pxW; cv.height = pxH;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pxW, pxH);
  let tiles = { ok: 0, fail: 0 };
  const ppm0 = pxW / (x1 - x0);
  if (opts.base && opts.base !== 'none') tiles = await drawBase(ctx, { a: ppm0, b: 0, c: 0, d: -ppm0, e: -x0 * ppm0, f: y1 * ppm0 }, pxW, pxH, opts.base);
  drawVectors(ctx, opts.items, (lon, lat) => [(mx(lon) - x0) * ppm0, (y1 - my(lat)) * ppm0], dpi);

  const latC = (Math.atan(Math.sinh(((y0 + y1) / 2) / R)) * 180 / Math.PI);
  const mPerMm = (x1 - x0) / mapIt.w * Math.cos(latC * Math.PI / 180);            // true metres per paper mm
  const scaleN = Math.round(mPerMm * 1000 / 100) * 100 || Math.round(mPerMm * 1000);
  const vars = { title: opts.title || 'Peta', subtitle: opts.subtitle || '', site: opts.site || '', author: opts.author || '', zone: opts.zoneNote || '',
    date: new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }), scale: scaleN.toLocaleString('id-ID') };
  const fill = t => String(t).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  const toLonLat = (X, Y) => [X / R * 180 / Math.PI, Math.atan(Math.sinh(Y / R)) * 180 / Math.PI];

  for (const it of lay.items) {
    if (it.type === 'rect') { doc.setDrawColor(203, 213, 225); doc.setLineWidth(.3); doc.roundedRect(it.x, it.y, it.w, it.h, 2, 2, 'S'); }
    else if (it.type === 'map') {
      doc.addImage(cv.toDataURL('image/jpeg', .92), 'JPEG', it.x, it.y, it.w, it.h);
      doc.setDrawColor(15, 23, 42); doc.setLineWidth(.4); doc.rect(it.x, it.y, it.w, it.h, 'S');
      // coordinate ticks (lat/lon, decimal degrees)
      const [lw, , le] = [toLonLat(x0, y0)[0], 0, toLonLat(x1, y0)[0]], tl = toLonLat(x0, y1), bl = toLonLat(x0, y0);
      const step = [.0005, .001, .002, .005, .01, .02, .05, .1, .2, .5, 1, 2, 5].find(st => (le - lw) / st <= 6) || 5;
      const dec = Math.max(0, Math.ceil(-Math.log10(step)));
      doc.setFontSize(6); doc.setTextColor(71, 85, 105); doc.setDrawColor(71, 85, 105); doc.setLineWidth(.2);
      for (let lo = Math.ceil(lw / step) * step; lo < le; lo += step) {
        const X = it.x + (mx(lo) - x0) / (x1 - x0) * it.w;
        doc.line(X, it.y, X, it.y - 1.5); doc.line(X, it.y + it.h, X, it.y + it.h + 1.5);
        doc.text(`${Math.abs(lo).toFixed(dec)}°${lo < 0 ? 'W' : 'E'}`, X, it.y + it.h + 4.5, { align: 'center' });
      }
      for (let la = Math.ceil(bl[1] / step) * step; la < tl[1]; la += step) {
        const Y = it.y + (y1 - my(la)) / (y1 - y0) * it.h;
        doc.line(it.x, Y, it.x - 1.5, Y); doc.line(it.x + it.w, Y, it.x + it.w + 1.5, Y);
        doc.text(`${Math.abs(la).toFixed(dec)}°${la < 0 ? 'S' : 'N'}`, it.x - 2.2, Y, { align: 'center', angle: 90 });
      }
      doc.setTextColor(0); doc.setDrawColor(0);
      if (opts.base && opts.base !== 'none') { doc.setFontSize(5); doc.setTextColor(100); doc.text(tiles.ok ? `Basemap: ${BASES[opts.base].credit}` : 'Basemap tidak berhasil dimuat (offline atau diblokir)', it.x + 1, it.y + it.h - 1); doc.setTextColor(0); }
    } else if (it.type === 'label') {
      doc.setFont('helvetica', it.bold ? 'bold' : 'normal'); doc.setFontSize(it.size || 9); const c = hex(it.color || '#0F172A'); doc.setTextColor(c[0], c[1], c[2]);
      doc.text(doc.splitTextToSize(fill(it.text), it.w), it.x, it.y + (it.size || 9) * .35, { baseline: 'top', lineHeightFactor: 1.25 });
      doc.setFont('helvetica', 'normal'); doc.setTextColor(0);
    } else if (it.type === 'legend') {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('Legenda', it.x, it.y + 2, { baseline: 'top' });
      let y = it.y + 9; doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      for (const l of opts.items.filter(i => i.visible)) {
        if (y > it.y + it.h - 4) { doc.setFontSize(7); doc.text('… (legenda dipotong)', it.x, y); break; }
        const st = l.style, sc = hex(st.stroke), fc = hex(st.fill), cy = y + 1.5;
        doc.setLineWidth(Math.min(.8, (st.weight ?? 2) * .12)); doc.setDrawColor(sc[0], sc[1], sc[2]); doc.setFillColor(fc[0], fc[1], fc[2]);
        const op = (st.opacity ?? 1); doc.setGState(new doc.GState({ opacity: Math.max(.15, op), 'stroke-opacity': op }));
        const kind = l.kind === 'collar' ? 'point' : l.geom_type;
        if (kind === 'point') doc.circle(it.x + 3, cy, 1.6, 'FD');
        else if (kind === 'line') { doc.setLineDashPattern(st.dash ? st.dash.split(' ').map(n => Number(n) * .35) : [], 0); doc.line(it.x, cy, it.x + 6, cy); doc.setLineDashPattern([], 0); }
        else { doc.setGState(new doc.GState({ opacity: Math.max(.2, (st.fillOpacity ?? .2) * op), 'stroke-opacity': op })); doc.rect(it.x, cy - 1.6, 6, 3.2, (st.fillOpacity ?? 0) > 0 ? 'FD' : 'S'); }
        doc.setGState(new doc.GState({ opacity: 1, 'stroke-opacity': 1 }));
        doc.setTextColor(15, 23, 42); doc.text(doc.splitTextToSize(l.name, it.w - 9)[0], it.x + 8.5, cy, { baseline: 'middle' });
        y += 5.2;
      }
      doc.setDrawColor(0);
    } else if (it.type === 'scalebar') {
      const L = niceNum(mPerMm * 40);                       // at most ~40 mm long
      const len = L / mPerMm; let x = it.x, y = it.y + 6;
      doc.setLineWidth(.25); doc.setDrawColor(15, 23, 42);
      for (let i = 0; i < 4; i++) { doc.setFillColor(...(i % 2 ? [255, 255, 255] : [15, 23, 42])); doc.rect(x + i * len / 4, y, len / 4, 2, 'FD'); }
      doc.setFontSize(7); doc.setTextColor(15, 23, 42);
      const lab = v => (L >= 1000 ? `${(v / 1000)} km` : `${v} m`);
      doc.text('0', x, y - 1, { align: 'center' }); doc.text(String(L / 2 >= 1000 ? L / 2000 : L / 2), x + len / 2, y - 1, { align: 'center' }); doc.text(lab(L), x + len, y - 1, { align: 'center' });
      doc.setFontSize(6.5); doc.text('Skala grafis (jarak sebenarnya)', x, y + 6);
    } else if (it.type === 'north') {
      const cx = it.x, top = it.y, s = it.size;
      doc.setFillColor(15, 23, 42); doc.setDrawColor(15, 23, 42); doc.triangle(cx, top, cx - s * .35, top + s, cx, top + s * .75, 'F');
      doc.setFillColor(255, 255, 255); doc.triangle(cx, top, cx + s * .35, top + s, cx, top + s * .75, 'FD');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(15, 23, 42); doc.text('U', cx, top + s + 5, { align: 'center' }); doc.setFont('helvetica', 'normal');
    }
  }
  const name = opts.filename || `peta_${opts.site || 'site'}_${new Date().toISOString().slice(0, 10)}.pdf`;
  const blob = doc.output('blob');
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return { name, bytes: blob.size, tiles, scale: scaleN };
}

/* =====================================================================================================
   Layout "can": Drillhole Plan Map in UTM, modelled on the company's ArcMap A3 layout
   (map frame with UTM grid crosses + labels on four sides; right column with title, company, north/scale/CRS,
   legend, two location insets, data sources, copyright, info table, address). Geometry is written for A3
   (420 x 297 mm) and scaled for A4 / A2.
   ===================================================================================================== */
const NICE_SCALES = [500, 1000, 1500, 2000, 2500, 5000, 7500, 10000, 12500, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000, 150000, 200000, 250000, 500000, 1000000];

// mercator metres -> canvas pixels for a UTM-aligned page (local affine about the centre; error is far below a pixel for blocks of tens of km)
export function mercatorToUtmAffine(E0, N1, ppm, zone, hemi, lat, lon) {
  const h = 1e-4, p0 = latLonToUtm(lat, lon, zone, hemi), pl = latLonToUtm(lat, lon + h, zone, hemi), pp = latLonToUtm(lat + h, lon, zone, hemi);
  const mxl = (mx(lon + h) - mx(lon)) / h, myp = (my(lat + h) - my(lat)) / h;
  const M00 = (pl.e - p0.e) / h / mxl, M01 = (pp.e - p0.e) / h / myp, M10 = (pl.n - p0.n) / h / mxl, M11 = (pp.n - p0.n) / h / myp;
  const mxc = mx(lon), myc = my(lat);
  return { a: ppm * M00, c: ppm * M01, e: ppm * (p0.e - E0 - M00 * mxc - M01 * myc), b: -ppm * M10, d: -ppm * M11, f: ppm * (N1 - p0.n + M10 * mxc + M11 * myc) };
}

async function insetCanvas({ lat, lon, z, pxW, pxH, widthM, heightM }) {
  const cv = document.createElement('canvas'); cv.width = pxW; cv.height = pxH;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#e5e7eb'; ctx.fillRect(0, 0, pxW, pxH);
  const worldPx = 256 * 2 ** z, cx = (mx(lon) + HALF) / (2 * HALF) * worldPx, cy = (HALF - my(lat)) / (2 * HALF) * worldPx;
  const x0 = cx - pxW / 2, y0 = cy - pxH / 2, jobs = [];
  for (let c = Math.floor(x0 / 256); c <= Math.floor((x0 + pxW) / 256); c++) for (let r = Math.floor(y0 / 256); r <= Math.floor((y0 + pxH) / 256); r++) if (r >= 0 && r < 2 ** z) jobs.push([c, r]);
  let ok = 0;
  await Promise.all(jobs.map(async ([c, r]) => {
    const bmp = await fetchTile(BASES.topo.url.replace('{z}', z).replace('{x}', ((c % 2 ** z) + 2 ** z) % 2 ** z).replace('{y}', r));
    if (bmp) { ok++; ctx.drawImage(bmp, c * 256 - x0, r * 256 - y0, 256.6, 256.6); }
  }));
  const k = worldPx / (2 * HALF) / Math.cos(lat * Math.PI / 180);               // pixels per ground metre
  const rw = Math.max(widthM * k, pxW * 0.04), rh = Math.max(heightM * k, pxW * 0.04);
  ctx.fillStyle = 'rgba(220,38,38,.35)'; ctx.strokeStyle = '#DC2626'; ctx.lineWidth = Math.max(2, pxW / 90);
  ctx.fillRect(pxW / 2 - rw / 2, pxH / 2 - rh / 2, rw, rh); ctx.strokeRect(pxW / 2 - rw / 2, pxH / 2 - rh / 2, rw, rh);
  return { cv, ok };
}

async function exportCan(opts) {
  const JsPDF = await loadJsPdf();
  const [pw, ph] = PAPERS[opts.paper] || PAPERS.A3, s = pw / 420, m = v => v * s;
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: [pw, ph] });
  const meta = opts.meta || {};
  const MAP = { x: m(10), y: m(10), w: m(304.5), h: m(277.6) };
  const PX = m(323.5), PW = m(94), CX = PX + PW / 2;

  // ---- extent in UTM ----
  const [w, so, e, no] = opts.bounds;
  const cLat = (so + no) / 2, cLon = (w + e) / 2;
  const zone = opts.utm?.zone || zoneOf(cLon), hemi = opts.utm?.hemisphere || (cLat < 0 ? 'S' : 'N');
  const pts = []; for (const la of [so, cLat, no]) for (const lo of [w, cLon, e]) pts.push(latLonToUtm(la, lo, zone, hemi));
  let eMin = Math.min(...pts.map(p => p.e)), eMax = Math.max(...pts.map(p => p.e)), nMin = Math.min(...pts.map(p => p.n)), nMax = Math.max(...pts.map(p => p.n));
  const padE = Math.max((eMax - eMin) * .06, 20), padN = Math.max((nMax - nMin) * .06, 20);
  eMin -= padE; eMax += padE; nMin -= padN; nMax += padN;
  const cE = (eMin + eMax) / 2, cN = (nMin + nMax) / 2, asp = MAP.w / MAP.h;
  let scaleN = Number(opts.scale) || 0;
  if (!scaleN) {
    let cw = eMax - eMin, ch = nMax - nMin; if (cw / ch > asp) ch = cw / asp; else cw = ch * asp;
    const need = cw / MAP.w * 1000;                                           // 1 : need  (A3 mm -> ground metres)
    scaleN = NICE_SCALES.find(v => v >= need) || Math.ceil(need / 1e5) * 1e5;
  }
  const widthM = scaleN * MAP.w / 1000, heightM = scaleN * MAP.h / 1000;
  const E0 = cE - widthM / 2, E1 = cE + widthM / 2, N0 = cN - heightM / 2, N1 = cN + heightM / 2;
  const dpi = Math.min(opts.dpi || 200, 4600 / (MAP.w / 25.4));
  const pxW = Math.round(MAP.w / 25.4 * dpi), pxH = Math.round(MAP.h / 25.4 * dpi), ppm = pxW / widthM;
  const cv = document.createElement('canvas'); cv.width = pxW; cv.height = pxH;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pxW, pxH);
  const cc = utmToLatLon(cE, cN, zone, hemi);
  let tiles = { ok: 0, fail: 0 };
  if (opts.base && opts.base !== 'none') tiles = await drawBase(ctx, mercatorToUtmAffine(E0, N1, ppm, zone, hemi, cc.lat, cc.lon), pxW, pxH, opts.base);
  drawVectors(ctx, opts.items, (lon, lat) => { const u = latLonToUtm(lat, lon, zone, hemi); return [(u.e - E0) * ppm, (N1 - u.n) * ppm]; }, dpi);

  // insets (regional + local), same basemap family, red rectangle = this map's extent
  const corner = [utmToLatLon(E0, N0, zone, hemi), utmToLatLon(E1, N1, zone, hemi)];
  const iw = (94 - 4.5) / 2, ih = 49, ipx = Math.round(iw / 25.4 * 150), ipy = Math.round(ih / 25.4 * 150);
  let zr = Math.round(Math.log2((0.22 * ipx) / (widthM / Math.cos(cc.lat * Math.PI / 180)) * 2 * HALF / 256));
  zr = Math.min(14, Math.max(5, zr));
  const insets = opts.base === 'none' ? [null, null] : await Promise.all([zr - 4, zr].map(z => insetCanvas({ lat: cc.lat, lon: cc.lon, z: Math.max(2, z), pxW: ipx, pxH: ipy, widthM, heightM })));

  // ---- page ----
  const today = new Date(), p2 = v => String(v).padStart(2, '0');
  const dateStr = `${p2(today.getDate())}/${p2(today.getMonth() + 1)}/${today.getFullYear()} ${p2(today.getHours())}:${p2(today.getMinutes())}:${p2(today.getSeconds())}`;
  const mPerMm = widthM / MAP.w;                                              // ground metres per paper mm
  doc.setDrawColor(0); doc.setTextColor(0); doc.setLineWidth(.5);
  doc.rect(m(2), m(2.8), m(320), m(293.2), 'S');                              // outer map box
  doc.addImage(cv.toDataURL('image/jpeg', .92), 'JPEG', MAP.x, MAP.y, MAP.w, MAP.h);
  doc.setLineWidth(.35); doc.rect(MAP.x, MAP.y, MAP.w, MAP.h, 'S');

  // UTM grid: crosses at intersections, ticks and labels on all four sides
  const gstep = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000].find(v => widthM / v <= 8) || 100000;
  const gx = E => MAP.x + (E - E0) / widthM * MAP.w, gy = N => MAP.y + (N1 - N) / heightM * MAP.h;
  const Es = [], Ns = [];
  for (let E = Math.ceil(E0 / gstep) * gstep; E < E1; E += gstep) Es.push(E);
  for (let N = Math.ceil(N0 / gstep) * gstep; N < N1; N += gstep) Ns.push(N);
  doc.setLineWidth(.18); doc.setDrawColor(40, 40, 40);
  const arm = m(1.6);
  for (const E of Es) for (const N of Ns) { const x = gx(E), y = gy(N); doc.line(x - arm, y, x + arm, y); doc.line(x, y - arm, x, y + arm); }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(Math.max(5, 7 * s)); doc.setTextColor(0);
  for (const E of Es) { const x = gx(E); doc.line(x, MAP.y, x, MAP.y - m(1.5)); doc.line(x, MAP.y + MAP.h, x, MAP.y + MAP.h + m(1.5));
    doc.text(String(E), x, MAP.y - m(3.2), { align: 'center' }); doc.text(String(E), x, MAP.y + MAP.h + m(5), { align: 'center' }); }
  for (const N of Ns) { const y = gy(N); doc.line(MAP.x, y, MAP.x - m(1.5), y); doc.line(MAP.x + MAP.w, y, MAP.x + MAP.w + m(1.5), y);
    const tw = doc.getTextWidth(String(N));                                  // rotated text: start half a width below the grid line (jsPDF cannot centre rotated text)
    doc.text(String(N), MAP.x - m(2.2), y + tw / 2, { angle: 90 }); doc.text(String(N), MAP.x + MAP.w + m(5.6), y + tw / 2, { angle: 90 }); }
  if (opts.base && opts.base !== 'none') { doc.setFontSize(Math.max(4, 5 * s)); doc.setTextColor(90); doc.text(tiles.ok ? `Basemap: ${BASES[opts.base].credit}` : 'Basemap tidak berhasil dimuat (offline atau diblokir)', MAP.x + m(1), MAP.y + MAP.h - m(1)); }
  doc.setTextColor(0);

  const box = (y, h, fillRgb) => { doc.setLineWidth(.3); doc.setDrawColor(0); if (fillRgb) { doc.setFillColor(...fillRgb); doc.rect(PX, m(y), PW, m(h), 'FD'); } else doc.rect(PX, m(y), PW, m(h), 'S'); };
  const txt = (t, x, y, o = {}) => {
    doc.setFont('helvetica', o.bold && o.italic ? 'bolditalic' : o.bold ? 'bold' : o.italic ? 'italic' : 'normal');
    let size = o.size || 9; doc.setFontSize(Math.max(4, size * s));
    if (o.fit) { while (doc.getTextWidth(String(t)) > o.fit && size > 5) { size -= .5; doc.setFontSize(Math.max(4, size * s)); } }
    const c = o.color || [0, 0, 0]; doc.setTextColor(c[0], c[1], c[2]);
    doc.text(String(t), x, y, { align: o.align || 'left', baseline: o.baseline || 'middle' });
  };
  const wrapped = (t, x, y, wmm, o = {}) => {
    doc.setFont('helvetica', o.italic ? 'italic' : 'normal'); doc.setFontSize(Math.max(4, (o.size || 7) * s));
    const lines = String(t || '').split('\n').flatMap(l => doc.splitTextToSize(l, m(wmm)));
    lines.forEach((l, i) => { const c = o.color || [0, 0, 0]; doc.setTextColor(c[0], c[1], c[2]); doc.text(l, x, y + i * m(o.lh || 3.2), { align: o.align || 'left', baseline: 'middle' }); });
    return lines.length;
  };

  // 1. title
  box(2.8, 21.5);
  txt(opts.title || 'PETA', CX, m(8), { bold: true, size: 17, align: 'center', fit: PW - m(4) });
  if (opts.subtitle) txt(opts.subtitle, CX, m(14), { bold: true, size: 14, align: 'center', fit: PW - m(4) });
  if (meta.loc1) txt(meta.loc1, CX, m(18.6), { bold: true, italic: true, size: 8, align: 'center', fit: PW - m(4) });
  if (meta.loc2) txt(meta.loc2, CX, m(21.8), { bold: true, italic: true, size: 8, align: 'center', fit: PW - m(4) });
  // 2. company
  box(25, 8.6, [217, 217, 217]);
  txt(meta.company || opts.site || '', CX, m(29.3), { bold: true, size: 15, align: 'center', color: [31, 95, 191], fit: PW - m(4) });
  // 3. north + scale + CRS
  box(34.4, 27);
  const nx = PX + m(8), nt = m(41), nb = m(57), nw = m(4.2);
  txt('U', nx, m(37.2), { bold: true, size: 12, align: 'center' });
  doc.setLineWidth(.25); doc.setDrawColor(0); doc.setFillColor(0, 0, 0); doc.triangle(nx, nt, nx - nw, nb, nx, nb - m(4.5), 'FD');
  doc.setFillColor(255, 255, 255); doc.triangle(nx, nt, nx + nw, nb, nx, nb - m(4.5), 'FD');
  const bx = PX + m(17);
  txt(`SKALA   1 : ${scaleN.toLocaleString('en-US')}`, bx, m(38), { bold: true, size: 11 });
  const L = niceNum(mPerMm * 60), len = L / mPerMm, by = m(43.5);
  doc.setLineWidth(.2);
  for (let i = 0; i < 4; i++) { doc.setFillColor(...(i % 2 ? [255, 255, 255] : [0, 0, 0])); doc.rect(bx + i * len / 4, by, len / 4, m(1.6), 'FD'); }
  for (const [f, lab] of [[0, '0'], [.5, String(L / 2)], [1, String(L)]]) txt(lab, bx + f * len, by - m(1.4), { size: 6, align: 'center' });
  txt('Meter', bx + len / 2, by + m(3.6), { size: 5.5, align: 'center' });
  txt(`Koordinat Sistem : WGS 1984 UTM Zone ${zone}${hemi}`, bx, m(51.4), { size: 6.5, fit: PW - m(19) });
  txt('Datum               : WGS 1984', bx, m(54.6), { size: 6.5 });
  txt('Unit                    : Meter', bx, m(57.8), { size: 6.5 });
  // 4. legend
  box(62.5, 102);
  txt('Legend', PX + m(3), m(68.5), { bold: true, size: 16 });
  const vis = opts.items.filter(i => i.visible), lay = vis.filter(i => i.kind !== 'collar'), col = vis.filter(i => i.kind === 'collar');
  const rowsN = lay.length + col.length + (col.length ? 1.6 : 0), step = Math.min(7.4, (102 - 16) / Math.max(1, rowsN));
  let ly = 76.5;
  const sym = (l, y) => {
    const st = l.style, sc = hex(st.stroke), fc = hex(st.fill), op = st.opacity ?? 1, kind = l.kind === 'collar' ? 'point' : l.geom_type, x = PX + m(3);
    doc.setDrawColor(sc[0], sc[1], sc[2]); doc.setFillColor(fc[0], fc[1], fc[2]); doc.setLineWidth(Math.max(.25, Math.min(.9, (st.weight ?? 2) * .13)));
    doc.setGState(new doc.GState({ opacity: Math.max(.2, op), 'stroke-opacity': op }));
    if (kind === 'point') doc.circle(x + m(5.5), m(y), m(1.4), 'FD');
    else if (kind === 'line') { doc.setLineDashPattern(st.dash ? st.dash.split(' ').map(n => Number(n) * .35) : [], 0); doc.line(x, m(y), x + m(11), m(y)); doc.setLineDashPattern([], 0); }
    else { if (st.dash) doc.setLineDashPattern(st.dash.split(' ').map(n => Number(n) * .35), 0); doc.setGState(new doc.GState({ opacity: Math.max(.2, (st.fillOpacity ?? .2) * op), 'stroke-opacity': op })); doc.rect(x, m(y) - m(2.5), m(11), m(5), (st.fillOpacity ?? 0) > 0 ? 'FD' : 'S'); doc.setLineDashPattern([], 0); }
    doc.setGState(new doc.GState({ opacity: 1, 'stroke-opacity': 1 }));
  };
  for (const l of lay) { sym(l, ly); txt(l.name, PX + m(17), m(ly), { size: 9.5, fit: PW - m(20) }); ly += step; }
  if (col.length) { ly += step * .3; txt('Drillhole', PX + m(3), m(ly), { bold: true, size: 12 }); ly += step * .9;
    for (const l of col) { sym(l, ly); txt(l.name, PX + m(17), m(ly), { size: 9.5, fit: PW - m(20) }); ly += step; } }
  // 5. insets
  box(166.2, 58);
  insets.forEach((ins, i) => {
    const x = PX + m(1.3 + i * (iw + 1.9)), y = m(167.4);
    if (ins) { doc.addImage(ins.cv.toDataURL('image/jpeg', .85), 'JPEG', x, y, m(iw), m(ih)); doc.setLineWidth(.2); doc.setDrawColor(0); doc.rect(x, y, m(iw), m(ih), 'S');
      if (!ins.ok) txt('Peta lokasi butuh internet', x + m(iw) / 2, y + m(ih) / 2, { size: 6, align: 'center', color: [100, 100, 100] }); }
    else { doc.setDrawColor(150); doc.rect(x, y, m(iw), m(ih), 'S'); txt('Tanpa peta dasar', x + m(iw) / 2, y + m(ih) / 2, { size: 6, align: 'center', color: [100, 100, 100] }); }
  });
  doc.setDrawColor(220, 38, 38); doc.setLineWidth(.5); doc.rect(PX + CX - PX - m(9), m(218.4), m(5), m(4), 'S');
  txt('Lokasi', CX - m(2), m(220.4), { bold: true, size: 9 });
  // 6. sources
  box(225.5, 19);
  txt('Sumber Data', PX + m(2), m(229.5), { bold: true, size: 10 });
  wrapped(meta.sources || '', PX + m(2), m(234.2), 90, { size: 6.5, lh: 3 });
  // 7. copyright
  box(246, 18.8);
  txt('Copyright', PX + m(2), m(250.5), { bold: true, italic: true, size: 11 });
  wrapped(meta.copyright || '', PX + m(2), m(255.4), 90, { size: 6.6, italic: true, lh: 3 });
  // 8. info table
  box(266, 16.3);
  const rows = [['Map No', meta.mapNo || '', 'Date', dateStr], ['Drafted By', meta.drafted || '', 'File', meta.file || opts.site || ''], ['Checked By', meta.checked || '', 'Layout Map', opts.paper || 'A3']];
  const cw = [.21, .34, .17, .28].map(f => f * PW), rh = 16.3 / 3;
  doc.setLineWidth(.2);
  rows.forEach((r, ri) => { let x = PX; r.forEach((v, ci) => { doc.rect(x, m(266 + ri * rh), cw[ci], m(rh), 'S'); txt(v, x + m(1.2), m(266 + ri * rh + rh / 2), { size: 6.5, bold: ci === 0 || ci === 2 ? ri === 0 && ci === 0 : false, fit: cw[ci] - m(2) }); x += cw[ci]; }); });
  // 9. company address
  box(284, 12.2);
  txt(meta.company || '', CX, m(287.3), { bold: true, italic: true, size: 8.5, align: 'center', fit: PW - m(4) });
  wrapped(meta.address || '', CX, m(291), 88, { size: 5.2, italic: true, align: 'center', lh: 2.4 });

  const name = opts.filename || `drillhole_plan_${opts.site || 'site'}_${new Date().toISOString().slice(0, 10)}.pdf`;
  const blob = doc.output('blob');
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return { name, bytes: blob.size, tiles, scale: scaleN };
}
