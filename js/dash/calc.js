// Pure functions: dataset in, numbers out. No DOM, no network (so they are testable in Node).
import { NPT_ACTIVITY, DRILL_ACTIVITY, STATUS_CLASS_FALLBACK } from './dashconfig.js';
import { thresholds, blankChecks, crmChecks, dupChecks } from '../qc/calc.js';
export const round = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
export const sum = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);

// ---- dates (all ISO yyyy-mm-dd strings, UTC maths so timezones never shift a day) ----
const D = s => new Date(s + 'T00:00:00Z');
export const iso = d => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const weekStart = s => { const d = D(s); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return iso(d); };   // Monday
export const todayIso = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
export const fmtDay = s => { const d = D(s); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }); };

// ---- filters -----------------------------------------------------------------------
// f = { sites:Set|null, prospect:string|null, from:iso|null, to:iso|null, rig:string|null }
export function holeIndex(d) {
  const m = new Map();
  for (const c of d.collar) m.set(c.site_code + '|' + c.hole_id, c);
  return m;
}
export const key = (site, hole) => site + '|' + hole;

export function codeIndex(d) {
  const m = new Map();
  for (const c of d.codes) m.set(`${c.site_code}|${c.list_code}|${c.code}`, c);
  return m;
}
export const labelOf = (ci, site, list, code) => ci.get(`${site}|${list}|${code}`)?.label ?? code ?? '';

export function mapClass(ci, c) {   // planned | coh | eoh
  const flag = ci.get(`${c.site_code}|collar_status|${c.status}`)?.meta?.map_class;
  return flag || STATUS_CLASS_FALLBACK[c.status] || 'coh';
}

export function rigName(d, site, rig) { return d.rigs.find(r => r.site_code === site && r.rig_id === rig)?.rig_name ?? rig; }

export function filterData(d, f) {
  const hi = holeIndex(d);
  const inSite = r => !f.sites || f.sites.has(r.site_code);
  const inRange = r => (!f.from || r.work_date >= f.from) && (!f.to || r.work_date <= f.to);
  const inProspect = r => !f.prospect || (hi.get(key(r.site_code, r.hole_id))?.prospect ?? '') === f.prospect;
  const inRig = r => !f.rig || r.rig_id === f.rig;
  return {
    ...d,
    collar: d.collar.filter(c => inSite(c) && (!f.prospect || (c.prospect ?? '') === f.prospect)),
    progress: d.progress.filter(r => inSite(r) && inRange(r) && inProspect(r) && inRig(r)),
    dist: d.dist.filter(r => inSite(r) && inRange(r) && inRig(r)),
    sample: d.sample.filter(r => inSite(r) && inProspect({ ...r, hole_id: r.hole_id })),
    plan: d.plan.filter(inSite),
  };
}

// ---- Overview ------------------------------------------------------------------------
// weekly series between the first and last week with data, plan and actual per week
export function weeklySeries(d, f) {
  const prog = d.progress.filter(r => (!f.sites || f.sites.has(r.site_code)));
  const hi = holeIndex(d);
  const rows = f.prospect ? prog.filter(r => (hi.get(key(r.site_code, r.hole_id))?.prospect ?? '') === f.prospect) : prog;
  const actual = new Map(), holes = new Map();
  for (const r of rows) {
    const w = weekStart(r.work_date);
    actual.set(w, (actual.get(w) || 0) + r.meters);
    if (!holes.has(w)) holes.set(w, new Set());
    holes.get(w).add(key(r.site_code, r.hole_id));
  }
  const plan = new Map();
  for (const p of d.plan) if (!f.sites || f.sites.has(p.site_code)) plan.set(p.week_start, (plan.get(p.week_start) || 0) + p.plan_m);
  const weeks = [...new Set([...actual.keys(), ...plan.keys()])].sort();
  if (!weeks.length) return [];
  const out = [];
  let cumA = 0, cumP = 0;
  for (let w = weeks[0]; w <= weeks[weeks.length - 1]; w = addDays(w, 7)) {
    const a = actual.get(w) || 0, p = plan.get(w) ?? null;
    cumA += a; cumP += p || 0;
    out.push({ week: w, actual: a, plan: p, cumActual: cumA, cumPlan: cumP, holes: holes.get(w)?.size || 0,
               pct: p ? (a / p) * 100 : null });
  }
  return out;
}

export function holeStatusCounts(d, f) {
  const ci = codeIndex(d);
  const c = { planned: 0, coh: 0, eoh: 0 };
  for (const h of d.collar) if (!f.sites || f.sites.has(h.site_code)) if (!f.prospect || (h.prospect ?? '') === f.prospect) c[mapClass(ci, h)]++;
  return c;
}

// per rig: meters, holes, avg depth per hole, days worked
export function rigTable(d) {
  const m = new Map();
  for (const r of d.progress) {
    const k = r.site_code + '|' + r.rig_id;
    if (!m.has(k)) m.set(k, { site: r.site_code, rig: r.rig_id, name: rigName(d, r.site_code, r.rig_id), meters: 0, holes: new Set(), days: new Set(), core: 0, coreM: 0, downtime: 0 });
    const x = m.get(k);
    x.meters += r.meters; x.holes.add(r.hole_id); x.days.add(r.work_date); x.downtime += r.downtime_hours || 0;
    if (r.core_len_m !== null) { x.core += r.core_len_m; x.coreM += r.meters; }
  }
  return [...m.values()].map(x => ({ ...x, holes: x.holes.size, days: x.days.size,
    avgDepth: x.holes.size ? x.meters / x.holes.size : 0, perDay: x.days.size ? x.meters / x.days.size : 0,
    recovery: x.coreM > 0 ? (x.core / x.coreM) * 100 : null })).sort((a, b) => b.meters - a.meters);
}

// recovery of the last n completed (EOH) holes, by date of last progress
export function recentRecovery(d, n = 8) {
  const ci = codeIndex(d);
  const eoh = new Set(d.collar.filter(c => mapClass(ci, c) === 'eoh').map(c => key(c.site_code, c.hole_id)));
  const m = new Map();
  for (const r of d.progress) {
    const k = key(r.site_code, r.hole_id);
    if (!eoh.has(k)) continue;
    if (!m.has(k)) m.set(k, { hole: r.hole_id, site: r.site_code, last: r.work_date, core: 0, meters: 0 });
    const x = m.get(k);
    if (r.work_date > x.last) x.last = r.work_date;
    if (r.core_len_m !== null) { x.core += r.core_len_m; x.meters += r.meters; }
  }
  return [...m.values()].filter(x => x.meters > 0).sort((a, b) => b.last.localeCompare(a.last)).slice(0, n)
    .map(x => ({ ...x, recovery: (x.core / x.meters) * 100 })).reverse();
}

export function finishByProspect(d, f) {
  const ci = codeIndex(d);
  const names = new Map(d.prospects.map(p => [p.site_code + '|' + p.prospect_code, p.prospect_name]));
  const m = new Map();
  for (const c of d.collar) {
    if (f.sites && !f.sites.has(c.site_code)) continue;
    if (mapClass(ci, c) !== 'eoh') continue;
    const label = c.prospect ? (names.get(c.site_code + '|' + c.prospect) ?? c.prospect) : '(no prospect)';
    m.set(label, (m.get(label) || 0) + 1);
  }
  return [...m].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}

// ---- Progress RIG ---------------------------------------------------------------------
export function dailySeries(d, f) {
  const m = new Map();
  for (const r of d.progress) m.set(r.work_date, (m.get(r.work_date) || 0) + r.meters);
  const days = [...m.keys()].sort();
  if (!days.length) return [];
  const from = f.from || days[0], to = f.to || days[days.length - 1];
  const out = [];
  for (let x = from; x <= to; x = addDays(x, 1)) out.push({ date: x, meters: m.get(x) || 0 });
  return out;
}

export function activityHours(d) {
  const ci = codeIndex(d);
  const m = new Map();
  for (const r of d.dist) {
    const lab = labelOf(ci, r.site_code, 'activity', r.activity);
    const x = m.get(r.activity) || { code: r.activity, label: lab, hours: 0 };
    x.hours += r.hours || 0; m.set(r.activity, x);
  }
  const total = sum([...m.values()], x => x.hours);
  return { total, rows: [...m.values()].sort((a, b) => b.hours - a.hours).map(x => ({ ...x, pct: total ? (x.hours / total) * 100 : 0 })) };
}
export function nptShare(d) {
  const a = activityHours(d);
  const npt = sum(a.rows.filter(x => NPT_ACTIVITY.includes(x.code)), x => x.hours);
  const drill = a.rows.find(x => x.code === DRILL_ACTIVITY)?.hours || 0;
  return { total: a.total, npt, drill, nptPct: a.total ? (npt / a.total) * 100 : null, drillPct: a.total ? (drill / a.total) * 100 : null };
}

export function downtimeByReason(d) {
  const ci = codeIndex(d);
  const m = new Map();
  for (const r of d.progress) if (r.downtime_hours > 0) {
    const lab = labelOf(ci, r.site_code, 'downtime_reason', r.downtime_reason);
    m.set(lab, (m.get(lab) || 0) + r.downtime_hours);
  }
  return [...m].map(([label, hours]) => ({ label, hours })).sort((a, b) => b.hours - a.hours);
}

export function metersByLayer(d) {
  const ci = codeIndex(d);
  const m = new Map();
  for (const r of d.progress) {
    const lab = r.layer ? labelOf(ci, r.site_code, 'layer', r.layer) : '(no layer)';
    m.set(lab, (m.get(lab) || 0) + r.meters);
  }
  return [...m].map(([label, meters]) => ({ label, meters })).sort((a, b) => b.meters - a.meters);
}

export function consumables(d, rigs) {
  const m = new Map();
  for (const r of d.dist) {
    const k = r.site_code + '|' + r.rig_id;
    if (!m.has(k)) m.set(k, { site: r.site_code, rig: r.rig_id, name: rigName(d, r.site_code, r.rig_id), fuel: 0, polymer: 0, oil: 0, any: false });
    const x = m.get(k);
    if (r.fuel_l !== null || r.polymer_l !== null || r.oil_hyd_l !== null) x.any = true;
    x.fuel += r.fuel_l || 0; x.polymer += r.polymer_l || 0; x.oil += r.oil_hyd_l || 0;
  }
  const meters = new Map(rigs.map(r => [r.site + '|' + r.rig, r.meters]));
  return [...m.values()].filter(x => x.any).map(x => ({ ...x, meters: meters.get(x.site + '|' + x.rig) || 0,
    fuelPerM: (meters.get(x.site + '|' + x.rig) || 0) > 0 ? x.fuel / meters.get(x.site + '|' + x.rig) : null }))
    .sort((a, b) => b.fuel - a.fuel);
}

export function samplePipeline(d) {
  const by = { PENDING: 0, SENT: 0, ANALYZED: 0 };
  const holes = new Set();
  for (const s of d.sample) { by[s.status] = (by[s.status] || 0) + 1; holes.add(key(s.site_code, s.hole_id)); }
  return { total: d.sample.length, holes: holes.size, ...by, unsent: by.PENDING || 0 };
}

export function coreRecovery(d) {
  const rows = d.progress.filter(r => r.core_len_m !== null);
  const m = sum(rows, r => r.meters);
  return m > 0 ? (sum(rows, r => r.core_len_m) / m) * 100 : null;
}

export function dateBounds(d) {
  const ds = d.progress.map(r => r.work_date).sort();
  return ds.length ? { min: ds[0], max: ds[ds.length - 1] } : null;
}
export const prospectsOf = d => {
  const names = new Map(d.prospects.map(p => [p.prospect_code, p.prospect_name]));
  return [...new Set(d.collar.map(c => c.prospect).filter(Boolean))].sort().map(c => ({ code: c, name: names.get(c) || c }));
};

// ---- Single-page dashboard (artifact layout) ---------------------------------------
export const PERIODS = { daily: { days: 60, label: 'Daily', note: 'last 60 days' }, weekly: { days: 182, label: 'Weekly', note: 'last 26 weeks' }, monthly: { days: 365, label: 'Monthly', note: 'last 12 months' } };
const monthStart = s => s.slice(0, 7) + '-01';
const bucketOf = (period, day) => (period === 'monthly' ? monthStart(day) : period === 'weekly' ? weekStart(day) : day);
export function bucketLabel(period, b) {
  const dt = D(b);
  if (period === 'monthly') return dt.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (period === 'weekly') return 'Wk ' + fmtDay(b);
  return fmtDay(b);
}
// weekly plan is a site total; spread it evenly over the 7 days of its week so any period can sum it
function planByDay(d, f) {
  const m = new Map();
  for (const p of d.plan) { if (f.sites && !f.sites.has(p.site_code)) continue; if (!p.plan_m) continue; for (let i = 0; i < 7; i++) { const x = addDays(p.week_start, i); m.set(x, (m.get(x) || 0) + p.plan_m / 7); } }
  return m;
}
export const lastDay = d => dateBounds(d)?.max ?? null;

// meters per bucket, stacked per rig, with plan; window ends on the last day with data
export function progressBuckets(d, f, period) {
  const end = lastDay(d); if (!end) return { rigs: [], rows: [] };
  const start = addDays(end, -(PERIODS[period].days - 1));
  const fd = filterData(d, { ...f, from: start, to: end });
  const rigs = [...new Map(fd.progress.map(r => [r.site_code + '|' + r.rig_id, { id: r.rig_id, name: rigName(d, r.site_code, r.rig_id) }])).values()]
    .filter((r, i, a) => a.findIndex(x => x.id === r.id) === i).sort((a, b) => a.name.localeCompare(b.name));
  const rows = new Map();
  const get = b => { if (!rows.has(b)) rows.set(b, { b, plan: 0, total: 0, rig: Object.fromEntries(rigs.map(r => [r.id, 0])) }); return rows.get(b); };
  for (let x = start; x <= end; x = addDays(x, 1)) get(bucketOf(period, x));
  for (const r of fd.progress) { const o = get(bucketOf(period, r.work_date)); o.rig[r.rig_id] += r.meters; o.total += r.meters; }
  if (!f.prospect && !f.rig) for (const [x, v] of planByDay(d, f)) if (x >= start && x <= end) get(bucketOf(period, x)).plan += v;
  return { rigs, rows: [...rows.values()].sort((a, b) => (a.b < b.b ? -1 : 1)), hasPlan: !f.prospect && !f.rig };
}

// month to date: month of the last day with data, all rigs (not filtered by period)
export function monthToDate(d, f) {
  const end = lastDay(d); if (!end) return null;
  const m0 = monthStart(end);
  const fd = filterData(d, { ...f, from: m0, to: end, rig: null });
  const meters = sum(fd.progress, r => r.meters);
  const pl = f.prospect ? null : [...planByDay(d, f)].filter(([x]) => x >= m0 && x <= end).reduce((t, [, v]) => t + v, 0);
  const holes = new Set(fd.progress.map(r => key(r.site_code, r.hole_id))).size;
  return { month: D(m0).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), from: m0, to: end, meters, plan: pl || null, pct: pl ? (meters / pl) * 100 : null, holes, rigs: rigTable(fd) };
}

// hours per activity per rig over the last 60 days (Distribution Hour)
export function hoursByRig(d, f) {
  const end = lastDay(d); if (!end) return { acts: [], rigs: [] };
  const fd = filterData(d, { ...f, from: addDays(end, -59), to: end });
  const ci = codeIndex(d);
  const acts = new Map(), by = new Map();
  for (const r of fd.dist) {
    const lab = labelOf(ci, r.site_code, 'activity', r.activity);
    acts.set(r.activity, lab);
    const k = r.rig_id; if (!by.has(k)) by.set(k, { id: k, name: rigName(d, r.site_code, k), h: {} });
    by.get(k).h[r.activity] = (by.get(k).h[r.activity] || 0) + (r.hours || 0);
  }
  const order = a => (a === DRILL_ACTIVITY ? 0 : NPT_ACTIVITY.includes(a) ? 2 : 1);
  return { acts: [...acts].map(([code, label]) => ({ code, label })).sort((a, b) => order(a.code) - order(b.code) || a.label.localeCompare(b.label)), rigs: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

// samples by lab status per prospect
export function samplesByProspect(d, f) {
  const hi = holeIndex(d);
  const m = new Map();
  for (const s of filterData(d, f).sample) {
    const p = hi.get(key(s.site_code, s.hole_id))?.prospect || '(none)';
    if (!m.has(p)) m.set(p, { prospect: p, PENDING: 0, SENT: 0, ANALYZED: 0 });
    const x = m.get(p); x[s.status] = (x[s.status] || 0) + 1;
  }
  return [...m.values()].sort((a, b) => a.prospect.localeCompare(b.prospect));
}

// ---- QAQC section -------------------------------------------------------------------------------
// The app has no field for "Excel QAQC done" (that work happens in the lab workbook). Working definition: a lab batch counts as
// QAQC-complete once it holds at least one blank, one CRM and one duplicate result. The date is when the last of the three arrived.
const pad2 = n => String(n).padStart(2, '0');
export const dayOf = ts => { if (!ts) return null; const x = new Date(ts); return Number.isNaN(+x) ? null : `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`; };
const QC_TYPES = ['BLANK', 'CRM', 'DUPLICATE'];

export function qaqcIndex(d) {
  const byNo = new Map(), batch = new Map();
  for (const a of d.assay || []) {
    if (a.is_deleted) continue;
    const day = dayOf(a.created_at);
    if (a.sample_no) {
      const o = byNo.get(a.sample_no);
      if (!o || (day && (!o.day || day < o.day))) byNo.set(a.sample_no, { day, batch: a.batch_id || null, pdf: a.source_type === 'pdf' });
    }
    if (a.batch_id && QC_TYPES.includes(a.sample_type) && day) {
      const b = batch.get(a.batch_id) || {};
      if (!b[a.sample_type] || day < b[a.sample_type]) b[a.sample_type] = day;
      batch.set(a.batch_id, b);
    }
  }
  const done = new Map();
  for (const [k, b] of batch) if (QC_TYPES.every(t => b[t])) done.set(k, QC_TYPES.map(t => b[t]).sort().pop());
  return { byNo, done };
}

// Sample flow: sent to lab -> RoA entered (PDF import) -> batch QAQC-complete. `samples` = register rows (already filtered by prospect if wanted).
function flowOf(samples, idx) {
  const sent = [], roa = [], qaqc = []; let qc = 0;
  for (const s of samples) {
    if (!s.sent_date) continue;
    sent.push(s.sent_date);
    if (s.sample_type && s.sample_type !== 'NORMAL') qc++;
    const a = idx.byNo.get(s.sample_no);
    if (a?.pdf) { roa.push(a.day); const dn = a.batch && idx.done.get(a.batch); if (dn) qaqc.push(dn); }
  }
  return { sent, roa, qaqc, qc };
}

export function qaqcFlow(d, f, today = todayIso(), days = 60) {
  const idx = qaqcIndex(d);
  const all = flowOf(d.sample.filter(s => !s.is_deleted), idx);                                   // cards: everything, no filter
  const sel = flowOf(filterData(d, { ...f, rig: null }).sample.filter(s => !s.is_deleted), idx);   // chart: prospect filter applies
  const latest = [...sel.sent, ...sel.roa, ...sel.qaqc].filter(Boolean).sort().pop();
  let end = today;
  const start0 = addDays(end, -(days - 1));
  if (latest && latest < start0) end = latest;                       // nothing recent: show the last 60 days that have activity
  const start = addDays(end, -(days - 1));
  const labels = Array.from({ length: days }, (_, i) => addDays(start, i));
  const at = new Map(labels.map((x, i) => [x, i]));
  const series = arr => { const o = new Array(days).fill(0); for (const x of arr) if (at.has(x)) o[at.get(x)]++; return o; };
  return { labels, sent: series(sel.sent), roa: series(sel.roa), qaqc: series(sel.qaqc),
    totals: { sent: all.sent.length, roa: all.roa.length, qaqc: all.qaqc.length, qc: all.qc,
      roaPending: all.sent.length - all.roa.length, qaqcPending: all.sent.length - all.qaqc.length, rate: all.sent.length ? (all.qc / all.sent.length) * 100 : null } };
}

// Blank / CRM (Ni) / duplicate results: the same rules as the Data QC tab. With a prospect selected, duplicates follow their hole; blanks and CRMs
// have no hole, so they follow their lab batch (kept when the batch holds at least one assay of a hole in that prospect).
export function qaqcChecks(d, f = {}) {
  const T = thresholds(d.qaqcSetting);
  let assay = d.assay || [], crm = d.crm || [];
  if (f.prospect) {
    const hi = holeIndex(d), inP = a => a.hole_id && hi.get(key(a.site_code, a.hole_id))?.prospect === f.prospect;
    const batches = new Set(assay.filter(inP).map(a => a.batch_id).filter(Boolean));
    assay = assay.filter(a => (a.sample_type === 'BLANK' || a.sample_type === 'CRM') ? batches.has(a.batch_id) : a.sample_type === 'DUPLICATE' ? inP(a) : true);
  }
  const blanks = blankChecks(assay, T).filter(b => b.ni != null);
  const crms = crmChecks(assay, crm, T).filter(c => c.analyte === 'Ni' && c.status !== 'n/a');
  const dups = dupChecks(assay, T).filter(x => x.ard != null);
  const bad = xs => xs.filter(x => x.status === 'fail').length;
  return { T, blanks, crms, dups, fail: { blank: bad(blanks), crm: bad(crms), dup: bad(dups) } };
}

// ---- Collar map ---------------------------------------------------------------------------------
// One point per collar that has usable coordinates: as-built when present, otherwise planned. Class (planned / eoh / coh) comes from the collar status map class.
const validLL = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
const numOrNull = v => (v === null || v === undefined || v === '' ? null : Number(v));
export function collarPoints(d, f = {}) {
  const ci = codeIndex(d), out = [];
  for (const c of filterData(d, { ...f, rig: null }).collar) {
    const a = [numOrNull(c.asbuilt_lat), numOrNull(c.asbuilt_lon)], p = [numOrNull(c.planned_lat), numOrNull(c.planned_lon)];
    const use = validLL(...a) ? [a, 'as-built'] : validLL(...p) ? [p, 'planned'] : null;
    if (!use) continue;
    out.push({ site: c.site_code, hole: c.hole_id, prospect: c.prospect || '', status: c.status, statusLabel: labelOf(ci, c.site_code, 'collar_status', c.status),
      cls: mapClass(ci, c), lat: use[0][0], lon: use[0][1], basis: use[1], depth: numOrNull(c.total_depth_m) ?? numOrNull(c.planned_depth_m) });
  }
  return out;
}
export function collarClassCounts(d, f = {}) {
  const pts = collarPoints(d, f), n = { planned: 0, eoh: 0, coh: 0 };
  for (const p of pts) n[p.cls] = (n[p.cls] || 0) + 1;
  const all = filterData(d, { ...f, rig: null }).collar.length;
  return { counts: n, mapped: pts.length, total: all };
}
