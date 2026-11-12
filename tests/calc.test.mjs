import assert from 'node:assert/strict';
import * as C from '../js/dash/calc.js';
import { buildDashWorkbook } from '../js/dash/export.js';
import { fake } from './fake.js';

const r = fake();
const tag = a => a.map(x => ({ site_code: 'WKM', ...x }));
const d = { collar: tag(r.exp_collar), progress: tag(r.exp_drill_progress), dist: tag(r.exp_dist_hour), sample: tag(r.exp_sample), plan: tag(r.exp_weekly_plan),
            rigs: tag(r.exp_rig), prospects: tag(r.exp_prospect), codes: tag(r.exp_code_list), assay: tag(r.exp_assay), crm: tag(r.exp_crm) };
const f = { sites: null, prospect: null, from: null, to: null, rig: null };

// dates
assert.equal(C.weekStart('2025-10-12'), '2025-10-06');   // Sunday -> Monday before
assert.equal(C.weekStart('2025-10-13'), '2025-10-13');
assert.equal(C.addDays('2025-10-31', 1), '2025-11-01');

// weekly series: week 1 has 7 days x 6 m = 42 m, week 2 = 42 m
const ws = C.weeklySeries(d, f);
assert.equal(ws.length, 2);
assert.equal(ws[0].actual, 42); assert.equal(ws[0].plan, 50); assert.equal(Math.round(ws[0].pct), 84);
assert.equal(ws[1].cumActual, 84); assert.equal(ws[1].cumPlan, 80);
// prospect filter: N1 holes are 0001/0002 = rows i<9 -> 9 days = 54 m total
const n1 = C.weeklySeries(d, { ...f, prospect: 'N1' });
assert.equal(n1[n1.length - 1].cumActual, 54);

// status counts: 2 completed (eoh), 1 drilling (coh), 1 planned
assert.deepEqual(C.holeStatusCounts(d, f), { planned: 1, coh: 1, eoh: 2 });

// rigs
const rt = C.rigTable(d);
assert.equal(rt.length, 2); assert.equal(C.sum(rt, x => x.meters), 84);
assert.equal(Math.round(rt[0].recovery), 90);

// activity + NPT (10 h drilling + 2 h standby/move per day, 14 days = 168 h)
const npt = C.nptShare(d);
assert.equal(npt.total, 168); assert.equal(npt.drill, 140); assert.equal(npt.npt, 28);
// downtime: i = 0,4,8,12 -> 4 rows x 2 h = 8 h of Rain
assert.deepEqual(C.downtimeByReason(d), [{ label: 'Rain', hours: 8 }]);
// consumables: only the rows that carry a value count; no consumables = no row
const cons = C.consumables(d, rt);
assert.equal(cons.length, 1); assert.equal(cons[0].fuel, 100);
assert.equal(C.consumables({ ...d, dist: d.dist.map(x => ({ ...x, fuel_l: null })) }, rt).length, 0);
// samples
assert.deepEqual([C.samplePipeline(d).total, C.samplePipeline(d).unsent], [2, 1]);
// recovery
assert.equal(Math.round(C.coreRecovery(d)), 90);
// filters: date range and rig
const fd = C.filterData(d, { ...f, from: '2025-10-06', to: '2025-10-08', rig: 'R1' });
assert.equal(fd.progress.length, 2);   // days 0 and 2 are R1
// daily series fills gaps with 0
assert.equal(C.dailySeries(C.filterData(d, { ...f, from: '2025-10-06', to: '2025-10-08' }), { from: '2025-10-06', to: '2025-10-10' }).length, 5);
// empty dataset must not throw
const empty = { collar: [], progress: [], dist: [], sample: [], plan: [], rigs: [], prospects: [], codes: [] };
assert.deepEqual(C.weeklySeries(empty, f), []); assert.equal(C.coreRecovery(empty), null); assert.equal(C.nptShare(empty).nptPct, null);
// QAQC section: flow, completeness of a lab batch, failed counts
const sent = '2026-10-20';
const dq = { ...d, sample: tag([{ sample_no: 'S1', hole_id: 'WKM-DD-0001', sample_type: 'NORMAL', sent_date: sent }, { sample_no: 'S2', hole_id: 'WKM-DD-0001', sample_type: 'NORMAL', sent_date: sent },
  { sample_no: 'BLANK-1', hole_id: null, sample_type: 'BLANK', sent_date: sent }, { sample_no: 'S3', hole_id: 'WKM-DD-0001', sample_type: 'NORMAL', sent_date: null }]) };
const q = C.qaqcFlow(dq, f, '2026-10-25');
assert.equal(q.labels.length, 60); assert.equal(q.labels.at(-1), '2026-10-25');
assert.deepEqual([q.totals.sent, q.totals.roa, q.totals.qaqc, q.totals.qc], [3, 2, 2, 1]);     // S2 has no RoA; batch LAB/26-1 has blank + CRM + duplicate
assert.deepEqual([q.totals.roaPending, q.totals.qaqcPending], [1, 1]); assert.equal(Math.round(q.totals.rate * 10) / 10, 33.3);
assert.equal(q.sent[q.labels.indexOf(sent)], 3); assert.equal(q.roa[q.labels.indexOf('2026-10-22')], 2); assert.equal(q.qaqc[q.labels.indexOf('2026-10-22')], 2);
assert.equal(C.qaqcFlow(dq, { ...f, prospect: 'S2' }, '2026-10-25').sent.reduce((a, b) => a + b, 0), 0);   // filter hits the chart
assert.equal(C.qaqcFlow(dq, { ...f, prospect: 'S2' }, '2026-10-25').totals.sent, 3);                       // ...but not the cards
// stale site: the window moves back to the last activity
assert.ok(C.qaqcFlow(dq, f, '2027-03-01').labels.includes(sent));
// batch without a duplicate is not QAQC-complete
const noDup = { ...dq, assay: dq.assay.filter(a => a.sample_type !== 'DUPLICATE') };
assert.equal(C.qaqcFlow(noDup, f, '2026-10-25').totals.qaqc, 0);
const ck = C.qaqcChecks(d);
assert.deepEqual([ck.blanks.length, ck.fail.blank, ck.crms.length, ck.fail.crm, ck.dups.length, ck.fail.dup], [1, 1, 2, 1, 2, 1]);
// prospect filter: fixture holes WKM-DD-0001 is in N1, so S2 prospect keeps no duplicates and drops the batch's blank and CRM
const ckS = C.qaqcChecks(d, { ...f, prospect: 'S2' }); assert.deepEqual([ckS.blanks.length, ckS.crms.length, ckS.dups.length], [0, 0, 0]);
const ckN = C.qaqcChecks(d, { ...f, prospect: 'N1' }); assert.deepEqual([ckN.blanks.length, ckN.crms.length, ckN.dups.length], [1, 2, 2]);
// collar map points
const pts = C.collarPoints(d, f); assert.ok(pts.length >= 1 && pts.every(p => Number.isFinite(p.lat) && ['planned', 'eoh', 'coh'].includes(p.cls)));
const cc = C.collarClassCounts(d, f); assert.equal(cc.total, d.collar.length); assert.equal(cc.mapped, pts.length); assert.equal(cc.counts.planned + cc.counts.eoh + cc.counts.coh, pts.length);
const noXY = { ...d, collar: d.collar.map(c => ({ ...c, asbuilt_lat: null, asbuilt_lon: null, planned_lat: 0, planned_lon: 0 })) };
assert.equal(C.collarPoints(noXY, f).length, 0);                                    // no coordinates, or 0/0, is not mapped
assert.equal(C.collarPoints(d, { ...f, prospect: 'S2' }).every(p => p.prospect === 'S2'), true);
// export workbook builds for site and hub mode (zip holds the sheet names as plain text because the zip is stored, not compressed)
const wbSite = buildDashWorkbook(dq, f, { period: 'weekly', today: '2026-10-25' });
const txt = Buffer.from(wbSite).toString('latin1');
assert.equal(txt.slice(0, 2), 'PK'); for (const n of ['Summary', 'Progress', 'Hours', 'Samples', 'Collars', 'QAQC_Flow', 'QAQC_Checks']) assert.ok(txt.includes(n), n);
const txtHub = Buffer.from(buildDashWorkbook(d, f, { hub: true, today: '2026-10-25' })).toString('latin1');
assert.ok(txtHub.includes('Collars') && !txtHub.includes('QAQC_Checks'));
assert.doesNotThrow(() => buildDashWorkbook(empty, f, { today: '2026-10-25' }));
// no assay at all must not throw
const e2 = C.qaqcFlow(empty, f, '2026-10-25'); assert.equal(e2.totals.rate, null); assert.deepEqual(C.qaqcChecks(empty).fail, { blank: 0, crm: 0, dup: 0 });
console.log('calc tests passed');
