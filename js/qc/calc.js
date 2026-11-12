// Data QC maths: pure functions, no DOM, no network. Thresholds follow the TPB lab-analysis workbook (Parameter sheet):
// CRM by Z-score, duplicates by ARD, blanks by an absolute Ni limit. Every threshold can be overridden through exp_setting 'qaqc_thresholds'.
import { COLUMN_OF, extraKey, ANALYTES } from '../roa/parse.js';

export const DEFAULTS = {
  blank_ni_max: 0.05,                                  // % Ni in a blank above this = carry-over / contamination
  dup_ard_ni_max: { PD: 0.05, CD: 0.10, RD: 0.10 },    // ARD = |dup - orig| / mean ; PD pulp dup, CD coarse (crush) dup, RD reject dup
  crm_z_warn: 2, crm_z_fail: 3,                        // Z = (measured - certified) / SD
  fe2o3_tol_pct: 3,                                    // Fe2O3 must be within 3 % of Fe x 1.4297
  mc_max: 45,                                          // moisture content above this is flagged
  cutoff_ni: 0.8,                                      // Ni cut-off for the ore tables
  sent_warn_days: 7, sent_fail_days: 14,               // sample sent to lab, no result yet
  dip_dev_warn: 10,                                    // deg between collar dip and survey dip
  gps_warn_m: 5,
  lab_resolution: 0.01,                                // the lab reports 2 decimals: a CRM Z-score is not meaningful when SD is below this
};
export const FE_TO_FE2O3 = 1.4297;

export function thresholds(setting) {
  const s = setting && typeof setting === 'object' ? setting : {};
  return { ...DEFAULTS, ...s, dup_ard_ni_max: { ...DEFAULTS.dup_ard_ni_max, ...(s.dup_ard_ni_max || {}) } };
}

const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export const assayValue = (a, an) => num(COLUMN_OF[an] ? a[COLUMN_OF[an]] : a.extra?.[extraKey(an)]);
export const valuesOf = a => Object.fromEntries(ANALYTES.map(n => [n, assayValue(a, n)]));
const status = (z, T) => { const m = Math.abs(z); return m > T.crm_z_fail ? 'fail' : m > T.crm_z_warn ? 'warn' : 'pass'; };
const crmKey = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').replace(/[\s-]\d+$/, '').trim();
const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const live = rows => (rows || []).filter(r => !r.is_deleted);

/* ---------- ore classification and sample flags (workbook rules) ---------- */
export function classify(ni, fe, mgo) {
  if ([ni, fe, mgo].some(v => v == null)) return null;
  if (ni < 0.8 && mgo >= 30 && fe < 10) return 'BRK';
  if (mgo >= 20 && fe < 15) return 'RSAP';
  if (mgo >= 10 || (fe < 25 && mgo >= 5)) return 'SAP';
  if (fe < 25 && mgo < 5) return 'CEK';
  return 'LIM';
}
export function lateriteLevel(al, cr) {
  if ((al ?? 0) >= 8 || (cr ?? 0) >= 2) return 'high';
  if ((al ?? 0) >= 4 || (cr ?? 0) >= 1) return 'medium';
  return 'low';
}
export function assayFlags(a, T) {
  const v = valuesOf(a), out = [];
  if (v.Fe != null && v.Fe2O3 != null && v.Fe > 0) {
    const exp = v.Fe * FE_TO_FE2O3, dev = Math.abs(v.Fe2O3 - exp) / exp * 100;
    if (dev > T.fe2o3_tol_pct) out.push({ code: 'FE2O3', msg: `Fe2O3 ${v.Fe2O3} differs ${round(dev, 1)}% from Fe x ${FE_TO_FE2O3} (${round(exp, 2)}); limit ${T.fe2o3_tol_pct}%` });
  }
  if (v.MC != null && v.MC >= T.mc_max) out.push({ code: 'MC', msg: `Moisture ${v.MC}% is at or above ${T.mc_max}%` });
  if ((v.Cr2O3 ?? 0) >= 4) out.push({ code: 'CHROMITE', msg: `Cr2O3 ${v.Cr2O3}% suggests chromite` });
  if ((v.Al2O3 ?? 0) >= 15) out.push({ code: 'CLAY', msg: `Al2O3 ${v.Al2O3}% suggests clay` });
  return out;
}

/* ---------- QAQC ---------- */
export function blankChecks(assays, T) {
  return live(assays).filter(a => a.sample_type === 'BLANK').map(a => {
    const ni = assayValue(a, 'Ni');
    return { batch: a.batch_id, sample_no: a.sample_no, ni, limit: T.blank_ni_max, status: ni == null ? 'warn' : ni > T.blank_ni_max ? 'fail' : 'pass', date: a.reported_date || null };
  });
}
export function crmChecks(assays, crm, T) {
  const cert = new Map(); for (const c of live(crm)) cert.set(crmKey(c.crm_name) + '|' + c.analyte, c);
  const out = [];
  for (const a of live(assays).filter(x => x.sample_type === 'CRM')) {
    for (const an of ANALYTES) {
      const c = cert.get(crmKey(a.crm_name) + '|' + an); const m = assayValue(a, an);
      if (!c || m == null) continue;
      const z = (m - Number(c.certified_value)) / Number(c.sd);
      const coarse = Number(c.sd) < T.lab_resolution;   // e.g. Co SD 0.0016 vs 0.01 rounding: Z only reflects rounding
      out.push({ batch: a.batch_id, sample_no: a.sample_no, crm: a.crm_name, analyte: an, measured: m, certified: Number(c.certified_value), sd: Number(c.sd), z: round(z, 2), status: coarse ? 'n/a' : status(z, T), note: coarse ? 'SD is below the lab reporting resolution; Z not used' : '', date: a.reported_date || null });
    }
  }
  return out;
}
// mean Z per batch + CRM + analyte: a persistent sign means lab bias, a large spread means poor precision
export function crmBias(checks) {
  const g = new Map();
  for (const c of checks) { const k = `${c.batch}|${c.crm}|${c.analyte}`; (g.get(k) || g.set(k, []).get(k)).push(c); }
  return [...g.values()].map(rs => { const zs = rs.map(r => r.z), mean = zs.reduce((s, x) => s + x, 0) / zs.length;
    return { batch: rs[0].batch, crm: rs[0].crm, analyte: rs[0].analyte, n: rs.length, meanZ: round(mean, 2), maxAbsZ: round(Math.max(...zs.map(Math.abs)), 2), bias: Math.abs(mean) > 1 ? (mean > 0 ? 'high' : 'low') : 'none' }; });
}
export function dupChecks(assays, T) {
  const rows = live(assays), byNo = new Map(rows.filter(a => a.sample_type === 'NORMAL' && a.sample_no).map(a => [a.sample_no, a]));
  const out = [];
  for (const d of rows.filter(a => a.sample_type === 'DUPLICATE')) {
    const o = byNo.get(d.duplicate_of_sample_no), dn = assayValue(d, 'Ni'), on = o ? assayValue(o, 'Ni') : null;
    const type = d.duplicate_type || 'RD', max = T.dup_ard_ni_max[type] ?? T.dup_ard_ni_max.RD;
    if (!o || dn == null || on == null || dn + on <= 0) { out.push({ batch: d.batch_id, sample_no: d.sample_no, original: d.duplicate_of_sample_no, type, hole: d.hole_id, status: 'warn', note: !o ? 'original not found' : 'Ni missing', ard: null, max }); continue; }
    const ard = Math.abs(dn - on) / ((dn + on) / 2);
    out.push({ batch: d.batch_id, sample_no: d.sample_no, original: d.duplicate_of_sample_no, type, hole: d.hole_id, orig_ni: on, dup_ni: dn, ard: round(ard, 4), max, status: ard > max ? 'fail' : 'pass', lowConc: (dn + on) / 2 < 0.1, note: '' });
  }
  return out;
}
const fp = a => ANALYTES.map(n => { const v = assayValue(a, n); return v == null ? '' : v.toFixed(4); }).join('|');
// identical blank/CRM results in different reports: the lab may have copied a QC result instead of measuring it
export function fingerprintClashes(assays) {
  const g = new Map();
  for (const a of live(assays).filter(x => x.sample_type === 'BLANK' || x.sample_type === 'CRM')) {
    const f = fp(a); if (!f.replace(/\|/g, '')) continue;
    const k = a.sample_type + f; (g.get(k) || g.set(k, []).get(k)).push(a);
  }
  return [...g.values()].filter(rs => new Set(rs.map(r => r.batch_id)).size > 1)
    .map(rs => ({ type: rs[0].sample_type, rows: rs.map(r => ({ batch: r.batch_id, sample_no: r.sample_no })) }));
}
export function batchSummary(assays, blanks, crms, dups) {
  const by = new Map();
  for (const a of live(assays)) { const k = a.batch_id || '(no batch)'; (by.get(k) || by.set(k, []).get(k)).push(a); }
  return [...by.entries()].map(([batch, rs]) => {
    const n = t => rs.filter(r => r.sample_type === t).length;
    const f = (xs, s) => xs.filter(x => (x.batch || '(no batch)') === batch && x.status === s).length;
    const fails = f(blanks, 'fail') + f(crms, 'fail') + f(dups, 'fail'), warns = f(blanks, 'warn') + f(crms, 'warn') + f(dups, 'warn');
    const primary = n('NORMAL'), qc = n('BLANK') + n('CRM') + n('DUPLICATE');
    const missing = [n('BLANK') ? null : 'blank', n('CRM') ? null : 'CRM', n('DUPLICATE') ? null : 'duplicate'].filter(Boolean);
    const dates = rs.map(r => r.reported_date).filter(Boolean).sort();
    return { batch, primary, blank: n('BLANK'), crm: n('CRM'), dup: n('DUPLICATE'), qcRate: primary ? round(qc / primary * 100, 1) : null, fails, warns, missing, reported: dates[0] || null,
      status: fails ? 'fail' : (warns || missing.length) ? 'warn' : 'pass' };
  }).sort((a, b) => String(b.reported).localeCompare(String(a.reported)) || a.batch.localeCompare(b.batch));
}

/* ---------- QC & survey: geometry and process checks ---------- */
export function geoIssues(d, T, now = new Date()) {
  const issues = [], add = (sev, cat, hole, ref, msg) => issues.push({ sev, cat, hole: hole || '', ref: ref || '', msg });
  const collars = live(d.collar), holes = new Map(collars.map(c => [c.hole_id, c]));
  const surveys = live(d.survey), samples = live(d.sample), assays = live(d.assay);
  const svBy = new Map(); for (const s of surveys) (svBy.get(s.hole_id) || svBy.set(s.hole_id, []).get(s.hole_id)).push(s);
  const normal = assays.filter(a => a.sample_type === 'NORMAL' && a.hole_id);
  const asBy = new Map(); for (const a of normal) (asBy.get(a.hole_id) || asBy.set(a.hole_id, []).get(a.hole_id)).push(a);

  for (const c of collars) {
    const done = c.status === 'completed', td = num(c.total_depth_m);
    if (done && td == null) add('critical', 'Collar', c.hole_id, '', 'Completed hole has no total depth');
    if (done && (c.asbuilt_lat == null || c.asbuilt_lon == null)) add('warning', 'Collar', c.hole_id, '', 'Completed hole has no as-built coordinate');
    if (num(c.gps_accuracy_m) > T.gps_warn_m) add('warning', 'Collar', c.hole_id, '', `GPS accuracy ${c.gps_accuracy_m} m is worse than ${T.gps_warn_m} m`);
    if (done && !svBy.has(c.hole_id)) add('warning', 'Survey', c.hole_id, '', 'Completed hole has no downhole survey (collar dip/azimuth are assumed)');
  }
  for (const [h, rs] of svBy) {
    const c = holes.get(h); const td = num(c?.total_depth_m);
    if (!c) { add('critical', 'Survey', h, '', 'Survey belongs to a hole with no collar'); continue; }
    const sorted = [...rs].sort((a, b) => num(a.depth_m) - num(b.depth_m));
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i], dep = num(s.depth_m);
      if (td != null && dep > td + 0.05) add('critical', 'Survey', h, dep + ' m', `Survey depth ${dep} m is deeper than total depth ${td} m`);
      if (i && dep === num(sorted[i - 1].depth_m)) add('warning', 'Survey', h, dep + ' m', 'Two surveys at the same depth');
      if (c.dip_deg != null && Math.abs(num(s.dip_deg) - num(c.dip_deg)) > T.dip_dev_warn) add('warning', 'Survey', h, dep + ' m', `Dip ${s.dip_deg}° differs ${round(Math.abs(s.dip_deg - c.dip_deg), 1)}° from collar dip ${c.dip_deg}° (limit ${T.dip_dev_warn}°)`);
    }
  }
  for (const [h, rs] of asBy) {
    const c = holes.get(h), td = num(c?.total_depth_m);
    if (!c) { add('critical', 'Assay', h, '', `${rs.length} assay rows belong to a hole with no collar`); continue; }
    const sorted = [...rs].sort((a, b) => num(a.from_m) - num(b.from_m));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (td != null && num(a.to_m) > td + 0.05) add('critical', 'Assay', h, a.sample_no, `Interval ends at ${a.to_m} m, deeper than total depth ${td} m`);
      if (i) { const p = sorted[i - 1];
        if (num(a.from_m) < num(p.to_m) - 0.001) add('critical', 'Assay', h, a.sample_no, `Overlaps ${p.sample_no || 'previous interval'} (${p.from_m}-${p.to_m} m)`);
        else if (num(a.from_m) > num(p.to_m) + 0.001) add('info', 'Assay', h, a.sample_no, `Gap of ${round(a.from_m - p.to_m, 2)} m after ${p.to_m} m (not sampled)`); }
    }
  }
  const nos = new Set(normal.map(a => a.sample_no));
  const regNos = new Set(samples.filter(s => s.sample_type === 'NORMAL').map(s => s.sample_no));
  for (const s of samples) {
    if (s.sample_type !== 'NORMAL') continue;
    if (s.status === 'SENT' && s.sent_date) {
      const days = Math.floor((now - new Date(s.sent_date)) / 864e5);
      if (days > T.sent_fail_days) add('critical', 'Sample', s.hole_id, s.sample_no, `Sent to lab ${days} days ago, no result (limit ${T.sent_fail_days} days)`);
      else if (days > T.sent_warn_days) add('warning', 'Sample', s.hole_id, s.sample_no, `Sent to lab ${days} days ago, no result (limit ${T.sent_warn_days} days)`);
    }
    if (s.status === 'ANALYZED' && !nos.has(s.sample_no)) add('warning', 'Sample', s.hole_id, s.sample_no, 'Marked ANALYZED but no assay row exists');
    if (s.status !== 'ANALYZED' && nos.has(s.sample_no)) add('info', 'Sample', s.hole_id, s.sample_no, `Assay exists but sample status is ${s.status}`);
  }
  if (regNos.size) for (const a of normal) if (a.sample_no && !regNos.has(a.sample_no)) add('info', 'Assay', a.hole_id, a.sample_no, 'Assay sample number is not in the sample register');
  return issues;
}

/* ---------- everything the tab needs ---------- */
export function analyze(d, T, now = new Date()) {
  const assays = live(d.assay);
  const blanks = blankChecks(assays, T), crms = crmChecks(assays, d.crm, T), dups = dupChecks(assays, T);
  const bias = crmBias(crms), clashes = fingerprintClashes(assays), batches = batchSummary(assays, blanks, crms, dups);
  const geo = geoIssues(d, T, now);
  const issues = [...geo];
  for (const b of blanks) if (b.status === 'fail') issues.push({ sev: 'critical', cat: 'Blank', hole: '', ref: `${b.batch} ${b.sample_no}`, msg: `Ni ${b.ni}% in blank, limit ${b.limit}%` });
  for (const c of crms) if (c.status !== 'pass') issues.push({ sev: c.status === 'fail' ? 'critical' : 'warning', cat: 'CRM', hole: '', ref: `${c.batch} ${c.sample_no}`, msg: `${c.analyte} Z=${c.z} (measured ${c.measured}, certified ${c.certified} ± ${c.sd})` });
  for (const x of dups) if (x.status !== 'pass') issues.push({ sev: x.status === 'fail' ? 'critical' : 'warning', cat: 'Duplicate', hole: x.hole || '', ref: `${x.batch} ${x.sample_no}`, msg: x.ard == null ? x.note : `Ni ARD ${round(x.ard * 100, 1)}% (${x.type}), limit ${round(x.max * 100, 0)}%${x.lowConc ? '; low Ni, ARD is noisy here' : ''}` });
  for (const c of clashes) issues.push({ sev: 'critical', cat: 'Integrity', hole: '', ref: c.rows.map(r => `${r.batch} ${r.sample_no}`).join(' = '), msg: `${c.type} results are identical across reports; the lab may have copied them` });
  for (const b of batches) if (b.missing.length && b.primary) issues.push({ sev: 'warning', cat: 'Batch', hole: '', ref: b.batch, msg: `No ${b.missing.join(', ')} QC in this batch` });
  const classes = {}, flags = [];
  for (const a of assays.filter(x => x.sample_type === 'NORMAL')) {
    const v = valuesOf(a), cl = classify(v.Ni, v.Fe, v.MgO);
    if (cl) classes[cl] = (classes[cl] || 0) + 1;
    for (const f of assayFlags(a, T)) flags.push({ hole: a.hole_id, sample_no: a.sample_no, batch: a.batch_id, ...f });
  }
  for (const f of flags) issues.push({ sev: 'warning', cat: 'Assay value', hole: f.hole, ref: f.sample_no, msg: f.msg });
  const rank = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => rank[a.sev] - rank[b.sev] || a.cat.localeCompare(b.cat) || String(a.hole).localeCompare(String(b.hole)));
  const count = s => issues.filter(i => i.sev === s).length;
  return { issues, blanks, crms, dups, bias, clashes, batches, classes, flags,
    summary: { critical: count('critical'), warning: count('warning'), info: count('info'), batches: batches.length,
      qaqcFail: blanks.filter(b => b.status === 'fail').length + crms.filter(c => c.status === 'fail').length + dups.filter(x => x.status === 'fail').length,
      qaqcTotal: blanks.length + crms.length + dups.length } };
}
