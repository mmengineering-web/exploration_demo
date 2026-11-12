// Excel import: read workbook -> check every row -> list what is ready / warned / refused.
// Nothing is written here. The caller saves the accepted rows (D.saveMany) so they go through the normal outbox.
// Rule: a row that already exists (same hole / interval / sample no ...) is REFUSED, never overwritten.
import { setting, codes } from './cfg.js';
import { validateProgress, validateCollar, validateDist } from './validate.js';
import { utmToLatLon } from './utm.js';

const rad = x => x * Math.PI / 180;
const distKm = (a, b) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
// centre of a GeoJSON object's bounding box (used as a location reference when the site has no collars yet)
function geoCentre(g) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  const walk = a => { if (typeof a[0] === 'number') { x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]); } else a.forEach(walk); };
  for (const f of g?.features || []) if (f.geometry?.coordinates) walk(f.geometry.coordinates);
  return x1 >= x0 ? { lat: (y0 + y1) / 2, lon: (x0 + x1) / 2 } : null;
}
// Where is this site? From collars already stored, else from uploaded map layers. null = unknown.
export function siteReference(ctx) {
  const lats = [], lons = [];
  for (const c of ctx.collars || []) { if (c.is_deleted) continue; const la = c.asbuilt_lat ?? c.planned_lat, lo = c.asbuilt_lon ?? c.planned_lon; if (la != null && lo != null) { lats.push(la); lons.push(lo); } }
  if (lats.length) return { lat: median(lats), lon: median(lons), from: 'data collar di HP' };
  for (const l of ctx.layers || []) { const c = geoCentre(l.geojson); if (c) return { ...c, from: `layer peta "${l.name}"` }; }
  return null;
}

export const SHEET_ORDER = ['COLLAR', 'PROGRESS', 'DIST_HOUR', 'SURVEY', 'SAMPLE', 'ASSAY'];
export const TABLE_OF = { COLLAR: 'collars', PROGRESS: 'progress', DIST_HOUR: 'disthours', SURVEY: 'surveys', SAMPLE: 'samples', ASSAY: 'assays' };

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
// f = field, k = kind (text num date time), req = required, a = accepted header spellings (besides the field name)
const F = (f, k, req, ...a) => ({ f, k, req: !!req, a: [f, ...a].map(norm) });
const SPEC = {
  COLLAR: [F('hole_id', 'text', 1, 'hole id', 'holeid', 'bhid'), F('hole_type', 'text', 1, 'hole type', 'type'), F('prospect', 'text'), F('status', 'text', 1),
    F('planned_x', 'num', 0, 'planned x (e)', 'plan x'), F('planned_y', 'num', 0, 'planned y (n)', 'plan y'), F('planned_elev', 'num', 0, 'planned elev (m)', 'planned elevation'),
    F('planned_depth_m', 'num', 0, 'planned depth (m)', 'planned depth'),
    F('asbuilt_x', 'num', 0, 'as-built x (e)', 'asbuilt x', 'actual x'), F('asbuilt_y', 'num', 0, 'as-built y (n)', 'asbuilt y', 'actual y'),
    F('asbuilt_elev', 'num', 0, 'as-built elev (m)', 'asbuilt elevation'), F('total_depth_m', 'num', 0, 'total depth (m)', 'total depth'),
    F('planned_lat', 'num'), F('planned_lon', 'num'), F('asbuilt_lat', 'num'), F('asbuilt_lon', 'num'),
    F('dip_deg', 'num', 0, 'dip (deg)', 'dip'), F('azimuth_deg', 'num', 0, 'azimuth (deg)', 'azimuth'), F('remarks', 'text')],
  PROGRESS: [F('work_date', 'date', 1, 'date', 'tanggal'), F('shift', 'text', 1), F('rig_id', 'text', 1, 'rig id', 'rig'), F('hole_id', 'text', 1, 'hole id', 'holeid'),
    F('from_m', 'num', 1, 'from (m)', 'from'), F('to_m', 'num', 1, 'to (m)', 'to'), F('layer', 'text', 0, 'horizon'),
    F('core_len_m', 'num', 0, 'core length (m)', 'core length'), F('downtime_hours', 'num', 0, 'downtime (h)', 'downtime'),
    F('downtime_reason', 'text', 0, 'downtime reason'), F('remarks', 'text')],
  DIST_HOUR: [F('work_date', 'date', 1, 'date', 'tanggal'), F('rig_id', 'text', 1, 'rig id', 'rig'), F('from_time', 'time', 1, 'from time', 'from'),
    F('to_time', 'time', 1, 'to time', 'to'), F('activity', 'text', 1), F('fuel_l', 'num', 0, 'fuel (l)', 'fuel'), F('polymer_l', 'num', 0, 'polymer (l)', 'polymer'),
    F('oil_hyd_l', 'num', 0, 'hyd oil (l)', 'hydraulic oil'), F('remarks', 'text')],
  SURVEY: [F('hole_id', 'text', 1, 'hole id', 'holeid'), F('depth_m', 'num', 1, 'depth (m)', 'depth'), F('dip_deg', 'num', 1, 'dip (deg)', 'dip'),
    F('azimuth_deg', 'num', 1, 'azimuth (deg)', 'azimuth'), F('method', 'text'), F('survey_date', 'date', 0, 'date'), F('remarks', 'text')],
  SAMPLE: [F('sample_no', 'text', 1, 'sample no', 'sampleno', 'sample id'), F('hole_id', 'text', 1, 'hole id', 'holeid'), F('from_m', 'num', 1, 'from (m)', 'from'),
    F('to_m', 'num', 1, 'to (m)', 'to'), F('sample_type', 'text', 0, 'type'), F('status', 'text'), F('sampled_date', 'date', 0, 'sampled date'),
    F('sent_date', 'date', 0, 'sent date'), F('lab', 'text'), F('batch_id', 'text', 0, 'batch id', 'batch'), F('remarks', 'text')],
  ASSAY: [F('hole_id', 'text', 1, 'hole id', 'holeid'), F('from_m', 'num', 1, 'from (m)', 'from'), F('to_m', 'num', 1, 'to (m)', 'to'),
    F('sample_no', 'text', 0, 'sample no', 'sampleno'), F('layer', 'text', 0, 'horizon'),
    F('ni_pct', 'num', 0, 'ni (%)', 'ni'), F('co_pct', 'num', 0, 'co (%)', 'co'), F('fe_pct', 'num', 0, 'fe (%)', 'fe'),
    F('mgo_pct', 'num', 0, 'mgo (%)', 'mgo'), F('sio2_pct', 'num', 0, 'sio2 (%)', 'sio2'),
    F('sample_type', 'text', 0, 'sample type'), F('batch_id', 'text', 0, 'batch id'), F('lab', 'text'), F('certificate_no', 'text', 0, 'certificate no'),
    F('crm_name', 'text', 0, 'crm name'), F('crm_element', 'text', 0, 'crm element'), F('crm_expected', 'num', 0, 'crm expected'),
    F('duplicate_type', 'text', 0, 'duplicate type'), F('duplicate_of_sample_no', 'text', 0, 'duplicate of sample no'), F('remarks', 'text')],
};
export const REQUIRED = Object.fromEntries(Object.entries(SPEC).map(([k, v]) => [k, v.filter(x => x.req).map(x => x.f)]));

/* ---------- cell readers (strict: nothing is guessed) ---------- */
const blank = v => v == null || (typeof v === 'string' && v.trim() === '');
function readNum(v, label) {
  if (blank(v)) return { v: null };
  if (typeof v === 'number') return isFinite(v) ? { v } : { err: `${label}: bukan angka.` };
  const s = String(v).trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return { v: Number(s) };
  return { err: `${label}: "${s}" bukan angka (pakai titik untuk desimal, tanpa simbol < atau >).` };
}
const pad = n => String(n).padStart(2, '0');
const validYmd = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
function readDate(v, label) {
  if (blank(v)) return { v: null };
  if (typeof v === 'number') {
    if (!(v > 20000 && v < 80000)) return { err: `${label}: tanggal tidak valid.` };
    const t = new Date(Math.round((Math.floor(v) - 25569) * 864e5));
    return { v: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (m && validYmd(+m[1], +m[2], +m[3])) return { v: m[0] };
  return { err: `${label}: "${String(v).trim()}" bukan tanggal. Pakai YYYY-MM-DD atau sel tanggal Excel.` };
}
function readTime(v, label) {
  if (blank(v)) return { v: null };
  if (typeof v === 'number') {
    if (!(v >= 0 && v < 1)) return { err: `${label}: jam tidak valid.` };
    const mins = Math.round(v * 1440);
    return mins >= 1440 ? { err: `${label}: jam tidak valid.` } : { v: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` };
  }
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v).trim());
  if (m && +m[1] < 24 && +m[2] < 60) return { v: `${pad(+m[1])}:${m[2]}` };
  return { err: `${label}: "${String(v).trim()}" bukan jam (HH:MM).` };
}
const readers = { num: readNum, date: readDate, time: readTime, text: (v) => ({ v: blank(v) ? null : String(v).trim() }) };

/* ---------- workbook -> raw rows ---------- */
// XLSX = SheetJS (window.XLSX in the browser, require('xlsx') in tests)
export function parseWorkbook(XLSX, buf) {
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const out = {}, notes = [];
  const byNorm = Object.fromEntries(SHEET_ORDER.map(s => [norm(s), s]));
  // other names people use for the same sheets (also the names written by Riwayat/Data Records > Backup ke Excel)
  Object.assign(byNorm, { jamrig: 'DIST_HOUR', distributionhour: 'DIST_HOUR', disthour: 'DIST_HOUR', drillingprogress: 'PROGRESS', drillprogress: 'PROGRESS' });
  for (const name of wb.SheetNames) {
    const key = byNorm[norm(name)];
    if (!key) { if (!['info', 'lists'].includes(norm(name))) notes.push(`Sheet "${name}" dilewati (bukan sheet import).`); continue; }
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
    if (!aoa.length) continue;
    const head = aoa[0].map(h => (h == null ? '' : String(h).trim()));
    const spec = SPEC[key];
    const colOf = {}, extras = [], ignored = [], errors = [];
    head.forEach((h, i) => {
      if (!h) return;
      const s = spec.find(x => x.a.includes(norm(h)));
      if (s) { if (colOf[s.f] != null) errors.push(`Kolom "${h}" muncul dua kali.`); else colOf[s.f] = i; }
      else if (key === 'ASSAY' && /^(.+?)\s*\(%\)$/.test(h)) extras.push({ i, key: norm(h.replace(/\(%\)\s*$/, '')) + '_pct', label: h });
      else ignored.push(h);
    });
    const missing = spec.filter(x => x.req && colOf[x.f] == null).map(x => x.f);
    if (missing.length) errors.push(`Kolom wajib tidak ditemukan: ${missing.join(', ')}.`);
    const rows = [];
    for (let r = 1; r < aoa.length; r++) {
      const cells = aoa[r];
      if (!cells || cells.every(blank)) continue;                      // empty line in Excel
      rows.push({ row: r + 1, cells });
    }
    out[key] = { name, head, colOf, extras, ignored, errors, rows };
  }
  return { sheets: out, notes };
}

/* ---------- analysis ---------- */
const DUP = /^Duplikat|Bentrok|Overlap|sudah dipakai|terlalu dekat/;
const up = s => (s == null ? null : String(s).toUpperCase());
function resolveCode(list, raw, label) {
  if (raw == null) return { v: null };
  const k = String(raw).trim().toLowerCase();
  const rows = codes(list);
  const hit = rows.find(r => r.code.toLowerCase() === k) || rows.find(r => String(r.label).toLowerCase() === k);
  return hit ? { v: hit.code } : { err: `${label} "${raw}" tidak ada di daftar (${rows.map(r => r.code).join(', ')}).` };
}
const overlap = (a1, a2, b1, b2) => a1 < b2 && a2 > b1;

// ctx: { file, rigs, prospects, collars, progress, disthours, surveys, samples, assays }  (the data already on this phone, after a sync)
// allow = rows with warnings count as imported (so later rows may depend on them); without it they do not
export function analyze(parsed, ctx, { allow = false } = {}) {
  const live = a => (a || []).filter(x => !x.is_deleted);
  const st = { collars: live(ctx.collars).slice(), progress: live(ctx.progress).slice(), disthours: live(ctx.disthours).slice(),
    surveys: live(ctx.surveys).slice(), samples: live(ctx.samples).slice(), assays: live(ctx.assays).slice() };
  st.ref = siteReference(ctx); st.held = new Map();   // collars from this file that only carry warnings (not counted until the user includes warned rows)
  const result = [];
  result.zone = null;
  for (const sheet of SHEET_ORDER) {
    const p = parsed.sheets[sheet]; if (!p) continue;
    const res = { sheet, name: p.name, ignored: p.ignored, extras: p.extras.map(e => e.label), errors: p.errors, rows: [] };
    result.push(res);
    const spec = SPEC[sheet];
    for (const { row, cells } of p.rows) {
      const errors = [], warns = [], v = {};
      if (p.errors.length) { res.rows.push({ row, rec: null, errors: ['Sheet ditolak: ' + p.errors[0]], warns, kind: 'invalid' }); continue; }
      for (const s of spec) {
        if (p.colOf[s.f] == null) { v[s.f] = null; continue; }
        const r = readers[s.k](cells[p.colOf[s.f]], s.f.replace(/_/g, ' '));
        if (r.err) errors.push(r.err);
        v[s.f] = r.v ?? null;
        if (s.req && r.v == null && !r.err) errors.push(`${s.f.replace(/_/g, ' ')} wajib diisi.`);
      }
      let rec = null;
      try { rec = BUILD[sheet](v, { errors, warns, st, ctx, p, cells, file: ctx.file, allow }); } catch (e) { errors.push(String(e.message || e)); }
      res.rows.push({ row, rec: errors.length ? null : rec, errors, warns, kind: errors.length ? (errors.some(e => DUP.test(e)) ? 'dup' : 'invalid') : (warns.length ? 'warn' : 'ok') });
    }
  }
  result.zone = st.zoneUsed || null;
  return result;
}

const holeOf = (st, h) => st.collars.find(c => c.hole_id === h);
// a hole whose COLLAR row is in this file but held back because of warnings: dependants are checked against it and become warnings, not refusals
function needCollar(st, h, errors, warns, msg) {
  const c = holeOf(st, h); if (c || !h) return c;
  const held = st.held.get(h);
  if (held) { warns.push(`Collar ${h} (sheet COLLAR) masih berperingatan; baris ini ikut diimport bersama collar bila "Sertakan baris berperingatan" dicentang.`); return held; }
  errors.push(msg); return null;
}
const rangeErr = (errors, label, x, lo, hi) => { if (x != null && (x < lo || x > hi)) errors.push(`${label}: harus ${lo}–${hi}.`); };

const BUILD = {
  COLLAR(v, { errors, warns, st, ctx, allow }) {
    v.hole_id = up(v.hole_id);
    for (const [f, list, label] of [['hole_type', 'hole_type', 'Tipe lubang'], ['status', 'collar_status', 'Status']]) {
      const r = resolveCode(list, v[f], label); if (r.err) errors.push(r.err); else v[f] = r.v;
    }
    if (v.prospect != null) {
      const k = v.prospect.toLowerCase(), pl = ctx.prospects || [];
      if (pl.length) { const hit = pl.find(x => String(x.prospect_code).toLowerCase() === k) || pl.find(x => String(x.prospect_name).toLowerCase() === k);
        if (hit) v.prospect = hit.prospect_code; else errors.push(`Prospect "${v.prospect}" tidak terdaftar (Pengaturan > Prospect).`); }
    }
    const zs = setting('utm_zone');
    // UTM zone: site setting first; else the zone that puts the point next to this site's existing holes / layers; else 51S (assumed)
    const pair = (x, y, la, lo, label) => {
      if (x == null && y == null) return;
      if (x == null || y == null) { errors.push(`${label}: X dan Y harus diisi keduanya.`); return; }
      if (x < 1e5 || x > 9e5 || y < 0 || y > 1e7) { errors.push(`${label}: X/Y di luar rentang UTM (X 100000–900000, Y 0–10000000). Mungkin tertukar atau bukan UTM.`); return; }
      let z, hemi, src;
      if (zs) { z = Number(zs); hemi = setting('utm_hemisphere') || 'S'; src = 'Pengaturan'; }
      else if (st.ref) {
        hemi = st.ref.lat >= 0 ? 'N' : 'S'; src = `disimpulkan dari ${st.ref.from}`;
        let best = 1e9; for (let k = 46; k <= 54; k++) { const d = distKm(utmToLatLon(x, y, k, hemi), st.ref); if (d < best) { best = d; z = k; } }
      } else { z = 51; hemi = 'S'; src = 'asumsi (belum ada data lain untuk dibandingkan)'; warns.push('Zona UTM tidak diketahui: dipakai 51S sebagai asumsi. Cek posisi di peta atau atur zona di Pengaturan > Parameter.'); }
      st.zoneUsed = st.zoneUsed || { zone: z, hemisphere: hemi, source: src };
      const c = utmToLatLon(x, y, z, hemi);
      if (st.ref && distKm(c, st.ref) > 150) warns.push(`${label}: posisi ${Math.round(distKm(c, st.ref))} km dari lubang/layer lain di site ini. Cek zona UTM (${z}${hemi}) dan urutan X/Y.`);
      v[la] = Math.round(c.lat * 1e7) / 1e7; v[lo] = Math.round(c.lon * 1e7) / 1e7;
    };
    pair(v.planned_x, v.planned_y, 'planned_lat', 'planned_lon', 'Planned');
    pair(v.asbuilt_x, v.asbuilt_y, 'asbuilt_lat', 'asbuilt_lon', 'As-built');
    rangeErr(errors, 'Dip', v.dip_deg, -90, 90); rangeErr(errors, 'Azimuth', v.azimuth_deg, 0, 360);
    if (v.hole_id && st.collars.some(c => c.hole_id === v.hole_id)) errors.push(`Duplikat — Hole ID ${v.hole_id} sudah ada (di data atau baris sebelumnya).`);
    const rec = { id: crypto.randomUUID(), hole_id: v.hole_id, hole_type: v.hole_type, prospect: v.prospect, status: v.status,
      planned_lat: v.planned_lat, planned_lon: v.planned_lon, planned_elev: v.planned_elev, planned_depth_m: v.planned_depth_m,
      asbuilt_lat: v.asbuilt_lat, asbuilt_lon: v.asbuilt_lon, asbuilt_elev: v.asbuilt_elev, gps_accuracy_m: null, total_depth_m: v.total_depth_m,
      photo_path: null, remarks: v.remarks, dip_deg: v.dip_deg, azimuth_deg: v.azimuth_deg, is_deleted: false };
    if (!errors.length) {
      const val = validateCollar(rec, { others: st.collars });
      errors.push(...val.errors.filter(e => !/sudah dipakai/.test(e))); warns.push(...val.warns.filter(w => !/^Akurasi GPS belum tercatat/.test(w)));
    }
    if (!errors.length) { if (allow || !warns.length) st.collars.push(rec); else st.held.set(rec.hole_id, rec); }
    return rec;
  },

  PROGRESS(v, { errors, warns, st, ctx, allow }) {
    v.hole_id = up(v.hole_id);
    const sh = resolveCode('shift', v.shift, 'Shift'); if (sh.err) errors.push(sh.err); else v.shift = sh.v;
    const ly = resolveCode('layer', v.layer, 'Layer'); if (ly.err) errors.push(ly.err); else v.layer = ly.v;
    const dr = resolveCode('downtime_reason', v.downtime_reason, 'Alasan downtime'); if (dr.err) errors.push(dr.err); else v.downtime_reason = dr.v;
    if (v.rig_id != null) {
      // an empty rig list is NOT a free pass: the rig must be registered (the "Belum terdaftar" card offers to register it)
      const rl = ctx.rigs || [], k = v.rig_id.toLowerCase(), hit = rl.find(r => r.rig_id.toLowerCase() === k) || rl.find(r => String(r.rig_name).toLowerCase() === k);
      if (hit) v.rig_id = hit.rig_id; else errors.push(`Rig "${v.rig_id}" tidak terdaftar (Pengaturan > Rig).`);
    }
    const collar = needCollar(st, v.hole_id, errors, warns, `Hole ${v.hole_id} tidak ada di data collar (atau sheet COLLAR file ini). Buat collar dulu.`);
    const rec = { id: crypto.randomUUID(), work_date: v.work_date, shift: v.shift, rig_id: v.rig_id, hole_id: v.hole_id, from_m: v.from_m, to_m: v.to_m,
      downtime_hours: v.downtime_hours ?? 0, downtime_reason: v.downtime_reason, core_len_m: v.core_len_m, remarks: v.remarks, photo_path: null,
      layer: v.layer, is_deleted: false };
    if (!errors.length) {
      const sibs = st.progress.filter(x => x.hole_id === rec.hole_id);
      const same = sibs.find(x => x.from_m === rec.from_m && x.to_m === rec.to_m && x.work_date === rec.work_date && x.shift === rec.shift);
      if (same) errors.push(`Duplikat — ${rec.hole_id} ${rec.from_m}–${rec.to_m} m, ${rec.work_date} ${rec.shift} sudah ada.`);
      else {
        const val = validateProgress(rec, { collar, siblings: sibs });
        errors.push(...val.errors); warns.push(...val.warns);
        if (rec.core_len_m != null && collar && !(ctxCoring(collar))) warns.push('Core length diisi untuk lubang non-coring.');
      }
    }
    if (!errors.length && (allow || !warns.length)) st.progress.push(rec);
    return rec;
  },

  DIST_HOUR(v, { errors, warns, st, ctx, allow }) {
    const ac = resolveCode('activity', v.activity, 'Aktivitas'); if (ac.err) errors.push(ac.err); else v.activity = ac.v;
    if (v.rig_id != null) {
      // an empty rig list is NOT a free pass: the rig must be registered (the "Belum terdaftar" card offers to register it)
      const rl = ctx.rigs || [], k = v.rig_id.toLowerCase(), hit = rl.find(r => r.rig_id.toLowerCase() === k) || rl.find(r => String(r.rig_name).toLowerCase() === k);
      if (hit) v.rig_id = hit.rig_id; else errors.push(`Rig "${v.rig_id}" tidak terdaftar (Pengaturan > Rig).`);
    }
    const rec = { id: crypto.randomUUID(), work_date: v.work_date, rig_id: v.rig_id, from_time: v.from_time, to_time: v.to_time, activity: v.activity, fuel_l: v.fuel_l, polymer_l: v.polymer_l, oil_hyd_l: v.oil_hyd_l, remarks: v.remarks, is_deleted: false };
    if (!errors.length) {
      const val = validateDist(rec, { siblings: st.disthours });
      errors.push(...val.errors); warns.push(...val.warns);
    }
    if (!errors.length && (allow || !warns.length)) st.disthours.push(rec);
    return rec;
  },

  SURVEY(v, { errors, warns, st, allow }) {
    v.hole_id = up(v.hole_id);
    rangeErr(errors, 'Dip', v.dip_deg, -90, 90); rangeErr(errors, 'Azimuth', v.azimuth_deg, 0, 360);
    if (v.depth_m != null && v.depth_m < 0) errors.push('Depth: tidak boleh negatif.');
    const collar = needCollar(st, v.hole_id, errors, warns, `Hole ${v.hole_id} tidak ada di data collar (atau sheet COLLAR file ini).`);
    if (!collar) { /* refused above, or no hole id */ }
    else if (collar?.total_depth_m != null && v.depth_m > collar.total_depth_m) errors.push(`Depth ${v.depth_m} m melebihi total depth lubang (${collar.total_depth_m} m).`);
    const rec = { id: crypto.randomUUID(), hole_id: v.hole_id, depth_m: v.depth_m, dip_deg: v.dip_deg, azimuth_deg: v.azimuth_deg, method: v.method, survey_date: v.survey_date, remarks: v.remarks, is_deleted: false };
    if (!errors.length && st.surveys.some(s => s.hole_id === rec.hole_id && Number(s.depth_m) === rec.depth_m)) errors.push(`Duplikat — survey ${rec.hole_id} pada ${rec.depth_m} m sudah ada.`);
    if (!errors.length && (allow || !warns.length)) st.surveys.push(rec);
    return rec;
  },

  SAMPLE(v, { errors, warns, st, allow }) {
    v.hole_id = up(v.hole_id);
    const ty = resolveCode('sample_type', v.sample_type ?? 'NORMAL', 'Tipe sampel'); if (ty.err) errors.push(ty.err); else v.sample_type = ty.v;
    const sc = resolveCode('sample_status', v.status ?? 'PENDING', 'Status sampel'); if (sc.err) errors.push(sc.err); else v.status = sc.v;
    if (v.from_m != null && v.from_m < 0) errors.push('From: tidak boleh negatif.');
    if (v.from_m != null && v.to_m != null && !(v.to_m > v.from_m)) errors.push('To harus lebih besar dari From.');
    if (v.sampled_date && v.sent_date && v.sent_date < v.sampled_date) errors.push('Sent date tidak boleh sebelum sampled date.');
    const collar = needCollar(st, v.hole_id, errors, warns, `Hole ${v.hole_id} tidak ada di data collar (atau sheet COLLAR file ini).`);
    if (!collar) { /* refused above, or no hole id */ }
    else if (collar?.total_depth_m != null && v.to_m > collar.total_depth_m) warns.push(`To (${v.to_m} m) melebihi total depth lubang (${collar.total_depth_m} m).`);
    const rec = { id: crypto.randomUUID(), sample_no: v.sample_no, hole_id: v.hole_id, from_m: v.from_m, to_m: v.to_m, sample_type: v.sample_type, status: v.status,
      sampled_date: v.sampled_date, sent_date: v.sent_date, lab: v.lab, batch_id: v.batch_id, remarks: v.remarks, is_deleted: false };
    if (!errors.length) {
      if (st.samples.some(s => s.sample_no === rec.sample_no)) errors.push(`Duplikat — sample no ${rec.sample_no} sudah ada.`);
      else if (rec.sample_type === 'NORMAL') {
        const o = st.samples.find(s => s.hole_id === rec.hole_id && s.sample_type === 'NORMAL' && overlap(rec.from_m, rec.to_m, Number(s.from_m), Number(s.to_m)));
        if (o) errors.push(`Overlap dengan sampel ${o.sample_no} (${o.from_m}–${o.to_m} m) di lubang yang sama.`);
      }
    }
    if (!errors.length && (allow || !warns.length)) st.samples.push(rec);
    return rec;
  },

  ASSAY(v, { errors, warns, st, p, cells, file, allow }) {
    v.hole_id = up(v.hole_id);
    const ty = resolveCode('sample_type', v.sample_type ?? 'NORMAL', 'Tipe sampel'); if (ty.err) errors.push(ty.err); else v.sample_type = ty.v;
    const ly = resolveCode('layer', v.layer, 'Layer'); if (ly.err) errors.push(ly.err); else v.layer = ly.v;
    if (v.from_m != null && v.from_m < 0) errors.push('From: tidak boleh negatif.');
    if (v.from_m != null && v.to_m != null && !(v.to_m > v.from_m)) errors.push('To harus lebih besar dari From.');
    for (const f of ['ni_pct', 'co_pct', 'fe_pct', 'mgo_pct', 'sio2_pct']) rangeErr(errors, f.replace('_pct', '').toUpperCase() + ' (%)', v[f], 0, 100);
    const extra = {};
    for (const e of p.extras) {
      const r = readNum(cells[e.i], e.label); if (r.err) errors.push(r.err);
      else if (r.v != null) { if (r.v < 0 || r.v > 100) errors.push(`${e.label}: harus 0–100.`); else extra[e.key] = r.v; }
    }
    const collar = needCollar(st, v.hole_id, errors, warns, `Hole ${v.hole_id} tidak ada di data collar (atau sheet COLLAR file ini).`);
    if (!collar) { /* refused above, or no hole id */ }
    else if (collar?.total_depth_m != null && v.to_m > collar.total_depth_m) warns.push(`To (${v.to_m} m) melebihi total depth lubang (${collar.total_depth_m} m).`);
    if (['ni_pct', 'co_pct', 'fe_pct', 'mgo_pct', 'sio2_pct'].every(f => v[f] == null) && !Object.keys(extra).length) warns.push('Tidak ada nilai kadar di baris ini.');
    if (v.crm_element) v.crm_element = v.crm_element.toLowerCase();
    const rec = { id: crypto.randomUUID(), hole_id: v.hole_id, from_m: v.from_m, to_m: v.to_m, sample_no: v.sample_no, layer: v.layer,
      ni_pct: v.ni_pct, co_pct: v.co_pct, fe_pct: v.fe_pct, mgo_pct: v.mgo_pct, sio2_pct: v.sio2_pct, extra, sample_type: v.sample_type,
      batch_id: v.batch_id, lab: v.lab, certificate_no: v.certificate_no, crm_name: v.crm_name, crm_element: v.crm_element, crm_expected: v.crm_expected,
      duplicate_type: v.duplicate_type, duplicate_of_sample_no: v.duplicate_of_sample_no, source_type: 'excel', source_file: file || null, remarks: v.remarks, is_deleted: false };
    if (!errors.length) {
      const same = st.assays.find(a => a.hole_id === rec.hole_id && Number(a.from_m) === rec.from_m && Number(a.to_m) === rec.to_m && (a.sample_no || '') === (rec.sample_no || ''));
      if (same) errors.push(`Duplikat — assay ${rec.hole_id} ${rec.from_m}–${rec.to_m} m${rec.sample_no ? ' (' + rec.sample_no + ')' : ''} sudah ada.`);
      else if (rec.sample_type === 'NORMAL') {
        const o = st.assays.find(a => a.hole_id === rec.hole_id && a.sample_type === 'NORMAL' && overlap(rec.from_m, rec.to_m, Number(a.from_m), Number(a.to_m)));
        if (o) errors.push(`Overlap dengan assay ${o.sample_no || 'tanpa nomor'} (${o.from_m}–${o.to_m} m) di lubang yang sama.`);
      }
    }
    if (!errors.length && (allow || !warns.length)) st.assays.push(rec);
    return rec;
  },
};
const ctxCoring = c => !!(codes('hole_type').find(r => r.code === c.hole_type)?.meta?.is_coring);

/* ---------- output helpers ---------- */
export function summarize(result) {
  return result.map(r => ({ sheet: r.sheet, total: r.rows.length,
    ok: r.rows.filter(x => x.kind === 'ok').length, warn: r.rows.filter(x => x.kind === 'warn').length,
    dup: r.rows.filter(x => x.kind === 'dup').length, invalid: r.rows.filter(x => x.kind === 'invalid').length }));
}
// records to save: ok rows (+ warned rows if the user allowed it)
export function accepted(result, withWarn) {
  const out = {};
  for (const r of result) out[r.sheet] = r.rows.filter(x => x.rec && (x.kind === 'ok' || (withWarn && x.kind === 'warn'))).map(x => x.rec);
  return out;
}


/* ---------- values that are not registered yet (rig, prospect, code lists) ---------- */
export const LIST_TITLE = { hole_type: 'Tipe lubang', collar_status: 'Status collar', shift: 'Shift', layer: 'Layer', downtime_reason: 'Alasan downtime', activity: 'Aktivitas', sample_type: 'Tipe sampel', sample_status: 'Status sampel' };
const REF_FIELDS = [
  ['COLLAR', 'prospect', 'prospect'], ['COLLAR', 'hole_type', 'hole_type'], ['COLLAR', 'status', 'collar_status'],
  ['PROGRESS', 'rig_id', 'rig'], ['PROGRESS', 'shift', 'shift'], ['PROGRESS', 'layer', 'layer'], ['PROGRESS', 'downtime_reason', 'downtime_reason'],
  ['DIST_HOUR', 'rig_id', 'rig'], ['DIST_HOUR', 'activity', 'activity'],
  ['SAMPLE', 'sample_type', 'sample_type'], ['SAMPLE', 'status', 'sample_status'], ['ASSAY', 'layer', 'layer'], ['ASSAY', 'sample_type', 'sample_type'],
];
// -> [{ kind: 'rig'|'prospect'|'code', list, value, count }]  values used in the file that the site has not registered
export function findUnregistered(parsed, ctx) {
  const out = new Map();
  for (const [sheet, field, target] of REF_FIELDS) {
    const p = parsed.sheets[sheet]; if (!p || p.errors.length || p.colOf[field] == null) continue;
    for (const { cells } of p.rows) {
      const raw = cells[p.colOf[field]]; if (blank(raw)) continue;
      const val = String(raw).trim(), k = val.toLowerCase();
      let known;
      if (target === 'rig') known = (ctx.rigs || []).some(r => r.rig_id.toLowerCase() === k || String(r.rig_name).toLowerCase() === k);
      else if (target === 'prospect') known = !(ctx.prospects || []).length || ctx.prospects.some(x => String(x.prospect_code).toLowerCase() === k || String(x.prospect_name).toLowerCase() === k);
      else known = !resolveCode(target, val, '').err;
      if (known) continue;
      const key = `${target}|${k}`;
      if (!out.has(key)) out.set(key, { kind: target === 'rig' || target === 'prospect' ? target : 'code', list: target, value: val, count: 0 });
      out.get(key).count++;
    }
  }
  // holes used by PROGRESS / SURVEY / SAMPLE / ASSAY rows that are neither in the site's collars nor in this file's COLLAR sheet
  const have = new Set([...live(ctx.collars).map(c => String(c.hole_id).toUpperCase())]);
  const pc = parsed.sheets.COLLAR;
  if (pc && !pc.errors.length && pc.colOf.hole_id != null) for (const { cells } of pc.rows) if (!blank(cells[pc.colOf.hole_id])) have.add(String(cells[pc.colOf.hole_id]).trim().toUpperCase());
  const holes = new Map();
  for (const sheet of ['PROGRESS', 'SURVEY', 'SAMPLE', 'ASSAY']) {
    const p = parsed.sheets[sheet]; if (!p || p.errors.length || p.colOf.hole_id == null) continue;
    for (const { cells } of p.rows) {
      const raw = cells[p.colOf.hole_id]; if (blank(raw)) continue;
      const id = String(raw).trim().toUpperCase(); if (have.has(id)) continue;
      if (!holes.has(id)) holes.set(id, { kind: 'hole', list: 'hole', value: id, count: 0, sheets: new Set() });
      const h = holes.get(id); h.count++; h.sheets.add(sheet);
    }
  }
  return [...out.values(), ...[...holes.values()].map(h => ({ ...h, sheets: [...h.sheets] }))];
}
function live(a) { return (a || []).filter(x => !x.is_deleted); }
