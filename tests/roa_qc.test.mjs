// Synthetic checks for the RoA parser helpers, the import plan and the QC maths (real lab PDFs are not kept in the repo).
import assert from 'node:assert/strict';
import { readValue, classify as kind, splitPrimary, parseDate, checkReport } from '../js/roa/parse.js';
import { toRecord, plan, fingerprint } from '../js/roa/commit.js';
import * as Q from '../js/qc/calc.js';

// --- parser helpers
assert.deepEqual(readValue('<0.01'), { v: 0.005, flag: 'below_dl', dl: 0.01 });
assert.equal(readValue('-').v, null); assert.equal(readValue('1,25').v, 1.25);
assert.deepEqual(kind('BLANK-3'), { kind: 'BLANK' }); assert.equal(kind('BLANK3').kind, 'BLANK');
assert.equal(kind('OREAS 182B-4').crm_name, 'OREAS 182b'); assert.equal(kind('OREAS-182B-1').crm_name, 'OREAS 182b');
assert.deepEqual(kind('TPB-A001-9-PD'), { kind: 'DUPLICATE', original: 'TPB-A001-9', dup_type: 'PD' });
assert.deepEqual(splitPrimary('TPB-A001-0,40'), { hole: 'TPB-A001', to: 0.4 });
assert.equal(parseDate('21 Oktober 2026'), '2026-10-21');
// declared count: accepted when it equals primary rows OR all rows
const rep = n => ({ header: { declared_count: n, batch_id: 'B' }, rows: [{ kind: 'PRIMARY', lab_seq: 1 }, { kind: 'PRIMARY', lab_seq: 2 }, { kind: 'BLANK', lab_seq: 3 }] });
assert.equal(checkReport(rep(2)).length, 0); assert.equal(checkReport(rep(3)).length, 0); assert.equal(checkReport(rep(9)).length, 1);

// --- import plan
const row = (kind, id, vals, extra = {}) => ({ lab_seq: 1, sample_id: id, kind, values: { Ni: null, Fe: null, Co: null, MgO: null, CaO: null, SiO2: null, Al2O3: null, Cr2O3: null, MnO: null, P2O5: null, Fe2O3: null, TiO2: null, Zn: null, MC: null, ...vals }, flags: [], notes: [], ...extra });
const hdr = { batch_id: 'CDSM/LAB/X/26-21', report_no: 'R-1', client_ref: 'REF', received_date: '2026-10-09', tested_date: '2026-10-12', reported_date: '2026-10-22' };
const P = row('PRIMARY', 'H-1', { Ni: 1.2, Fe: 40, MgO: 5, SiO2: 10, Al2O3: 6, MC: 30 }, { hole_id: 'H', from_m: 0, to_m: 1 });
const B = row('BLANK', 'BLANK-1', { Ni: 0.03, Fe: 1 });
const rec = toRecord(P, hdr, 'f.pdf');
assert.equal(rec.ni_pct, 1.2); assert.equal(rec.extra.al2o3_pct, 6); assert.equal(rec.extra.mc_pct, 30); assert.equal(rec.sample_type, 'NORMAL');
assert.equal(toRecord(B, hdr, 'f.pdf').hole_id, null);
const pl = plan({ header: hdr, rows: [P, B] }, { collars: new Set(['H']), assays: [], file: 'f.pdf' });
assert.equal(pl.counts.ok, 2); assert.equal(pl.items.filter(i => i.rec).length, 2);
const again = plan({ header: hdr, rows: [P, B] }, { collars: new Set(['H']), assays: pl.items.map(i => i.rec), file: 'f.pdf' });
assert.equal(again.counts.skip, 2, 're-import is skipped');
const noCollar = plan({ header: hdr, rows: [P] }, { collars: new Set(), assays: [], file: 'f.pdf' });
assert.equal(noCollar.items[0].status, 'warn');
// identical blank in another batch is flagged
const other = plan({ header: { ...hdr, batch_id: 'B2' }, rows: [B] }, { collars: new Set(), assays: pl.items.map(i => i.rec), file: 'g.pdf' });
assert.ok(other.items[0].flags.some(f => /identical/.test(f)));

// --- QC maths
const T = Q.thresholds();
assert.equal(Q.classify(0.5, 5, 35), 'BRK'); assert.equal(Q.classify(1, 12, 25), 'RSAP'); assert.equal(Q.classify(1, 20, 12), 'SAP');
assert.equal(Q.classify(1, 20, 2), 'CEK'); assert.equal(Q.classify(1.5, 45, 1), 'LIM'); assert.equal(Q.classify(null, 1, 1), null);
assert.equal(Q.lateriteLevel(9, 0), 'high'); assert.equal(Q.lateriteLevel(5, 0), 'medium'); assert.equal(Q.lateriteLevel(1, 0.1), 'low');
const crm = [{ crm_name: 'OREAS 182b', analyte: 'Ni', certified_value: 0.757, sd: 0.018 }, { crm_name: 'OREAS 182b', analyte: 'Co', certified_value: 0.0809, sd: 0.0016 }];
const A = (o) => ({ id: Math.random(), is_deleted: false, extra: {}, batch_id: 'B', ...o });
const assays = [
  A({ sample_type: 'CRM', sample_no: 'OREAS 182B-1', crm_name: 'OREAS 182b', ni_pct: 0.757 + 0.018 * 2.5, co_pct: 0.09 }),   // Z 2.5 warn; Co skipped (SD < resolution)
  A({ sample_type: 'CRM', sample_no: 'OREAS 182B-2', crm_name: 'OREAS 182b-2', ni_pct: 0.757 + 0.018 * 3.5 }),               // Z 3.5 fail; name with suffix still matches
  A({ sample_type: 'BLANK', sample_no: 'BLANK-1', ni_pct: 0.06 }),                                                         // fail
  A({ sample_type: 'NORMAL', sample_no: 'H-1', hole_id: 'H', from_m: 0, to_m: 1, ni_pct: 1.00 }),
  A({ sample_type: 'DUPLICATE', sample_no: 'H-1-PD', hole_id: 'H', duplicate_of_sample_no: 'H-1', duplicate_type: 'PD', ni_pct: 1.06 }),   // ARD 5.9% > 5% fail
  A({ sample_type: 'DUPLICATE', sample_no: 'H-1-CD', hole_id: 'H', duplicate_of_sample_no: 'H-1', duplicate_type: 'CD', ni_pct: 1.06 }),   // same ARD < 10% pass
];
const crmR = Q.crmChecks(assays, crm, T);
assert.equal(crmR.find(c => c.sample_no === 'OREAS 182B-1' && c.analyte === 'Ni').status, 'warn');
assert.equal(crmR.find(c => c.sample_no === 'OREAS 182B-2' && c.analyte === 'Ni').status, 'fail');
assert.equal(crmR.find(c => c.analyte === 'Co').status, 'n/a');
assert.equal(Q.blankChecks(assays, T)[0].status, 'fail');
const dr = Q.dupChecks(assays, T);
assert.equal(dr.find(x => x.type === 'PD').status, 'fail'); assert.equal(dr.find(x => x.type === 'CD').status, 'pass');
const res = Q.analyze({ collar: [{ hole_id: 'H', status: 'completed', total_depth_m: 0.5 }], survey: [], sample: [], assay: assays, crm }, T, new Date('2026-11-01'));
assert.ok(res.issues.some(i => i.cat === 'Assay' && /deeper than total depth/.test(i.msg)), 'interval beyond TD');
assert.ok(res.issues.some(i => i.cat === 'Collar' && /as-built/.test(i.msg)));
assert.ok(res.issues.some(i => i.cat === 'Survey' && /no downhole survey/.test(i.msg)));
assert.equal(res.batches[0].status, 'fail');
// overlap + sent overdue + fingerprint clash
const ov = Q.geoIssues({ collar: [{ hole_id: 'H', status: 'drilling' }], survey: [], sample: [{ sample_no: 'S1', sample_type: 'NORMAL', status: 'SENT', sent_date: '2026-10-01', hole_id: 'H' }],
  assay: [A({ sample_type: 'NORMAL', sample_no: 'a', hole_id: 'H', from_m: 0, to_m: 2 }), A({ sample_type: 'NORMAL', sample_no: 'b', hole_id: 'H', from_m: 1, to_m: 3 })] }, T, new Date('2026-11-01'));
assert.ok(ov.some(i => /Overlaps/.test(i.msg))); assert.ok(ov.some(i => /Sent to lab 31 days/.test(i.msg)));
const fpc = Q.fingerprintClashes([A({ batch_id: 'X', sample_type: 'BLANK', sample_no: 'BLANK-1', ni_pct: 0.03 }), A({ batch_id: 'Y', sample_type: 'BLANK', sample_no: 'BLANK-1', ni_pct: 0.03 })]);
assert.equal(fpc.length, 1);
assert.equal(Q.analyze({ collar: [], survey: [], sample: [], assay: [], crm: [] }, T).summary.critical, 0, 'empty data must not throw');
// Fe2O3 consistency
assert.equal(Q.assayFlags(A({ fe_pct: 40, extra: { fe2o3_pct: 57.188 } }), T).length, 0);
assert.equal(Q.assayFlags(A({ fe_pct: 40, extra: { fe2o3_pct: 50 } }), T)[0].code, 'FE2O3');
// --- lab workbook builds (formula values are checked against LibreOffice outside the repo)
import { buildLabWorkbook } from '../js/lab/workbook.js';
const u8 = buildLabWorkbook({ site: 'T', generated: '2026-11-12', collars: [{ hole_id: 'H', asbuilt_lat: -3.5, asbuilt_lon: 122.1, asbuilt_elev: 30, dip_deg: -90, azimuth_deg: 0 }], assays, crm, setting: null, utm: { zone: 51, hemi: 'S' } });
assert.equal(String.fromCharCode(u8[0], u8[1]), 'PK'); assert.ok(u8.length > 2000);
const empty = buildLabWorkbook({ site: 'T', generated: 'x', collars: [], assays: [], crm: [], setting: null, utm: null });
assert.ok(empty.length > 1000, 'empty site still builds');
console.log('roa/qc tests passed');
