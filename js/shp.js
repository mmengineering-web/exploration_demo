// File(s) -> GeoJSON in WGS84 lat/lon, ready to store as a map layer.
// Accepts: zipped shapefile (.zip with .shp .dbf .prj), loose .shp + .dbf (+ .prj), .geojson / .json.
// The .prj is used to reproject to lat/lon. A shapefile without .prj in UTM metres is converted with the given UTM zone.
import { utmToLatLon } from './utm.js';

let loading = null;
function loadShpLib() {
  if (window.shp) return Promise.resolve(window.shp);
  if (loading) return loading;
  loading = new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'js/vendor/shp.min.js';
    sc.onload = () => res(window.shp); sc.onerror = () => { loading = null; rej(new Error('Pustaka shapefile gagal dimuat.')); };
    document.head.appendChild(sc);
  });
  return loading;
}

const OK = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);
const KIND = { Point: 'point', MultiPoint: 'point', LineString: 'line', MultiLineString: 'line', Polygon: 'polygon', MultiPolygon: 'polygon' };
const r6 = x => Math.round(x * 1e6) / 1e6;
const walk = (a, f) => (typeof a[0] === 'number' ? f(a) : a.map(x => walk(x, f)));
const inRange = (x, y) => isFinite(x) && isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90;

// Douglas-Peucker (iterative), tolerance in degrees
function simplifyLine(pts, tol) {
  if (pts.length < 3 || tol <= 0) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let dmax = 0, idx = -1;
    const [x1, y1] = pts[a], [x2, y2] = pts[b], dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i];
      let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyGeom(g, tol) {
  if (tol <= 0 || g.type === 'Point' || g.type === 'MultiPoint') return g;
  const ring = r => { const s = simplifyLine(r, tol); return s.length >= 4 ? s : r; };
  const line = l => { const s = simplifyLine(l, tol); return s.length >= 2 ? s : l; };
  const c = g.coordinates;
  const out = g.type === 'LineString' ? line(c) : g.type === 'MultiLineString' ? c.map(line) : g.type === 'Polygon' ? c.map(ring) : c.map(p => p.map(ring));
  return { type: g.type, coordinates: out };
}

function cleanProps(p) {
  const out = {}; let n = 0;
  for (const [k, v] of Object.entries(p || {})) {
    if (v == null || v === '' || n >= 30) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 200) : (typeof v === 'number' || typeof v === 'boolean') ? v : String(v).slice(0, 200); n++;
  }
  return out;
}

// fcs: FeatureCollection(s) straight from the reader. opts: { utm: {zone, hemisphere} | null, maxBytes }
export function normalize(fcs, { utm = null, maxBytes = 8 * 1024 * 1024 } = {}) {
  const feats = [];
  for (const fc of [].concat(fcs)) for (const f of fc.features || (fc.type === 'Feature' ? [fc] : [])) {
    const geoms = f.geometry?.type === 'GeometryCollection' ? f.geometry.geometries : [f.geometry];
    for (const g of geoms) if (g && OK.has(g.type)) feats.push({ properties: f.properties, g });
  }
  if (!feats.length) throw new Error('Tidak ada titik, garis, atau poligon di file ini.');
  // coordinates: lat/lon already, or UTM metres (shapefile without .prj)
  const first = (() => { let p = null; const t = a => { if (p) return; if (typeof a[0] === 'number') p = a; else for (const x of a) t(x); }; t(feats[0].g.coordinates); return p; })();
  let conv = null, crs = 'EPSG:4326';
  if (!inRange(first[0], first[1])) {
    if (first[0] > 1e5 && first[0] < 9e5 && first[1] >= 0 && first[1] <= 1e7 && utm?.zone) { conv = ([x, y]) => { const c = utmToLatLon(x, y, utm.zone, utm.hemisphere || 'S'); return [c.lon, c.lat]; }; crs = `UTM ${utm.zone}${utm.hemisphere || 'S'} (diasumsikan, tidak ada .prj)`; }
    else throw new Error('Koordinat bukan lat/lon dan CRS tidak diketahui. Sertakan file .prj dalam zip, atau atur Zona UTM di Pengaturan > Parameter.');
  }
  const base = feats.map(({ properties, g }) => ({ type: 'Feature', properties: cleanProps(properties),
    geometry: { type: g.type, coordinates: walk(g.coordinates, p => { const q = conv ? conv(p) : p; if (!inRange(q[0], q[1])) throw new Error('Ada koordinat di luar rentang lat/lon setelah konversi. Cek CRS file.'); return [r6(q[0]), r6(q[1])]; }) } }));
  const kinds = new Set(base.map(f => KIND[f.geometry.type]));
  let tol = 0, fc, size, simplified = false;
  for (let i = 0; i < 12; i++) {
    fc = { type: 'FeatureCollection', features: tol ? base.map(f => ({ ...f, geometry: simplifyGeom(f.geometry, tol) })) : base };
    size = JSON.stringify(fc).length;
    if (size <= maxBytes) break;
    tol = tol ? tol * 2 : 2e-6; simplified = true;     // 2e-6 deg = about 0.2 m, doubling until it fits
  }
  if (size > maxBytes) throw new Error(`Layer terlalu besar (${(size / 1048576).toFixed(1)} MB) walau sudah disederhanakan. Potong area atau pecah jadi beberapa layer.`);
  return { geojson: fc, geom_type: kinds.size === 1 ? [...kinds][0] : 'mixed', feature_count: fc.features.length, bytes: size, crs, simplified, tol,
    fields: [...new Set(fc.features.flatMap(f => Object.keys(f.properties)))] };
}

export async function readFiles(files, opts = {}) {
  files = [...files];
  const ext = f => f.name.split('.').pop().toLowerCase();
  const geo = files.find(f => ['geojson', 'json'].includes(ext(f)));
  if (geo) {
    let obj; try { obj = JSON.parse(await geo.text()); } catch { throw new Error('File bukan JSON/GeoJSON yang valid.'); }
    return { ...normalize(obj, opts), source: geo.name };
  }
  const shp = await loadShpLib();
  const zip = files.find(f => ext(f) === 'zip');
  if (zip) return { ...normalize(await shp(await zip.arrayBuffer()), opts), source: zip.name };
  const fshp = files.find(f => ext(f) === 'shp');
  if (!fshp) throw new Error('Pilih file .zip (shapefile lengkap), atau .shp + .dbf + .prj sekaligus, atau .geojson.');
  const dbf = files.find(f => ext(f) === 'dbf'), prj = files.find(f => ext(f) === 'prj'), cpg = files.find(f => ext(f) === 'cpg');
  const geoms = shp.parseShp(await fshp.arrayBuffer(), prj ? await prj.text() : undefined);
  const props = dbf ? shp.parseDbf(await dbf.arrayBuffer(), cpg ? await cpg.text() : undefined) : [];
  return { ...normalize(shp.combine([geoms, props]), opts), source: fshp.name };
}
