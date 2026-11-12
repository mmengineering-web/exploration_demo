// Pure: parsed RoA report -> exp_assay records + import checks. No DOM, no DB (the view passes existing data in).
import { COLUMN_OF, extraKey, ANALYTES, checkReport } from './parse.js';

const r3 = v => (v == null ? null : Math.round(v * 1000) / 1000);
const r4 = v => (v == null ? null : Math.round(v * 10000) / 10000);

// Order-insensitive fingerprint of a QC row's analyte values: identical values in two different reports = copied results.
export const fingerprint = values => ANALYTES.map(a => (values[a] == null ? '' : Number(values[a]).toFixed(4))).join('|');

export function toRecord(row, hdr, file) {
  const rec = {
    id: crypto.randomUUID(), hole_id: null, from_m: null, to_m: null, sample_no: row.sample_id, layer: null,
    ni_pct: null, co_pct: null, fe_pct: null, mgo_pct: null, sio2_pct: null, extra: {},
    sample_type: row.kind === 'PRIMARY' ? 'NORMAL' : row.kind,
    batch_id: hdr.batch_id, lab: hdr.lab || null, certificate_no: hdr.report_no || null,
    crm_name: null, crm_element: null, crm_expected: null, duplicate_type: null, duplicate_of_sample_no: null,
    source_type: 'pdf', source_file: file, remarks: row.notes.length ? row.notes.join('; ') : null,
    lab_seq: row.lab_seq, client_ref: hdr.client_ref || null,
    received_date: hdr.received_date || null, tested_date: hdr.tested_date || null, reported_date: hdr.reported_date || null,
    is_deleted: false,
  };
  for (const a of ANALYTES) {
    const v = row.values[a]; if (v == null) continue;
    if (COLUMN_OF[a]) rec[COLUMN_OF[a]] = r3(v); else rec.extra[extraKey(a)] = r4(v);
  }
  if (row.kind === 'PRIMARY' || row.kind === 'DUPLICATE') { rec.hole_id = row.hole_id; rec.from_m = row.from_m; rec.to_m = row.to_m; }
  if (row.kind === 'CRM') rec.crm_name = row.crm_name;
  if (row.kind === 'DUPLICATE') { rec.duplicate_type = row.dup_type; rec.duplicate_of_sample_no = row.original; }
  return rec;
}

// Decide what can be saved. ctx = { collars:Set(hole_id), assays:[existing exp_assay rows], file }
// Row status: ok | warn (saved, but look at it) | skip (already imported / unusable)
export function plan(rep, ctx) {
  const hdr = { ...rep.header, lab: ctx.lab || null };
  const msgs = checkReport(rep);
  const liveAssays = (ctx.assays || []).filter(a => !a.is_deleted);
  const haveNormal = new Set(liveAssays.filter(a => a.sample_type === 'NORMAL' && a.sample_no).map(a => a.sample_no));
  const haveQc = new Set(liveAssays.filter(a => a.hole_id == null && a.sample_no).map(a => `${a.batch_id || ''}|${a.sample_no}`));
  const haveDupe = new Set(liveAssays.filter(a => a.sample_type === 'DUPLICATE' && a.sample_no).map(a => `${a.batch_id || ''}|${a.sample_no}`));
  const prevFp = new Map();   // fingerprint -> batch of an earlier import
  for (const a of liveAssays) if (a.sample_type === 'BLANK' || a.sample_type === 'CRM') {
    const vals = Object.fromEntries(ANALYTES.map(n => [n, COLUMN_OF[n] ? a[COLUMN_OF[n]] : a.extra?.[extraKey(n)]]));
    const fp = fingerprint(vals); if (a.batch_id && fp.replace(/\|/g, '')) if (!prevFp.has(fp)) prevFp.set(fp, a.batch_id);
  }
  const items = rep.rows.map(row => {
    const flags = [...row.flags]; let status = row.flags.length ? 'warn' : 'ok';
    if (row.kind === 'PRIMARY') {
      if (!row.hole_id) status = 'skip';
      else if (ctx.collars && !ctx.collars.has(row.hole_id)) { flags.push(`hole ${row.hole_id} has no collar`); status = 'warn'; }
      if (haveNormal.has(row.sample_id)) { flags.push('sample no. already imported'); status = 'skip'; }
    } else if (row.kind === 'DUPLICATE') {
      if (haveDupe.has(`${hdr.batch_id || ''}|${row.sample_id}`)) { flags.push('already imported in this batch'); status = 'skip'; }
      if (!row.hole_id && status !== 'skip') status = 'warn';
    } else if (haveQc.has(`${hdr.batch_id || ''}|${row.sample_id}`)) { flags.push('already imported in this batch'); status = 'skip'; }
    if ((row.kind === 'BLANK' || row.kind === 'CRM')) {
      const fp = fingerprint(row.values); const b = prevFp.get(fp);
      if (b && b !== hdr.batch_id) { flags.push(`values identical to ${row.kind} in batch ${b}: possible copied QC result`); if (status === 'ok') status = 'warn'; }
    }
    if (ANALYTES.every(a => row.values[a] == null)) { flags.push('no values read'); status = 'skip'; }
    return { row, flags, status, rec: status === 'skip' ? null : toRecord(row, hdr, ctx.file) };
  });
  // the same QC fingerprint twice inside one report is just as suspicious
  const seen = new Map();
  for (const it of items) if (it.row.kind === 'BLANK' || it.row.kind === 'CRM') {
    const fp = fingerprint(it.row.values); if (!fp.replace(/\|/g, '')) continue;
    const k = it.row.kind + fp; if (seen.has(k)) { it.flags.push(`same values as row ${seen.get(k)} in this report`); if (it.status === 'ok') it.status = 'warn'; } else seen.set(k, it.row.lab_seq);
  }
  if (haveQc.size === 0 && liveAssays.some(a => a.batch_id === hdr.batch_id) && items.every(i => i.status === 'skip'))
    msgs.push({ sev: 'warning', text: `Batch ${hdr.batch_id} is already imported.` });
  return { header: hdr, msgs, items, counts: count(items) };
}
const count = items => items.reduce((c, i) => { c[i.status]++; c[i.row.kind] = (c[i.row.kind] || 0) + 1; return c; }, { ok: 0, warn: 0, skip: 0 });
