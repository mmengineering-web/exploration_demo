// "Data QC" tab: QC & Survey issues, QAQC geochemistry (blank / CRM / duplicate), and the thresholds in use. Live read, needs internet.
import * as S from '../sync.js';
import { loadChartJs } from '../dash/data.js';
import { loadQcData } from './data.js';
import { chartCard, destroyCharts, baseOptions, esc, nf, COLOR } from '../dash/ui.js';
import { buildXlsx } from '../xlsx-lite.js';
import * as Q from './calc.js';
import { buildLabWorkbook } from '../lab/workbook.js';

const st = { site: null, data: null, loadedAt: 0, sub: 'geo', sev: '', cat: '', q: '', analyte: 'Ni', sort: ['sev', 1] };
const STALE_MS = 2 * 60 * 1000;
const SEV = { critical: ['✖', 'Critical'], warning: ['⚠', 'Warning'], info: ['ℹ', 'Info'], fail: ['✖', 'Fail'], warn: ['⚠', 'Warn'], pass: ['✓', 'Pass'], 'n/a': ['–', 'n/a'] };
const pill = s => `<span class="pill ${s === 'n/a' ? 'na' : s}">${SEV[s][0]} ${SEV[s][1]}</span>`;
// status colours are read from the tokens at render time (light/dark safe)

export function resetQc() { st.data = null; st.site = null; destroyCharts(); }

export async function viewQc(root) {
  const info = S.getInfo(), mine = root.dataset.tab;
  destroyCharts();
  root.innerHTML = '<div class="dash"><div class="card"><p class="muted">Loading Data QC...</p></div></div>';
  if (!navigator.onLine) { root.innerHTML = '<div class="dash"><div class="card"><h2>Data QC needs internet</h2><div class="msg warn">It reads live data from the site database. Input and sync keep working offline.</div></div></div>'; return; }
  const sb = S.getClient();
  if (!sb || info.guest) { root.innerHTML = '<div class="dash"><div class="card"><div class="msg warn">Log in to see Data QC.</div></div></div>'; return; }
  try {
    const { data: sess } = await sb.auth.getSession();
    if (!sess?.session) throw new Error('Your login session has expired. Sign out, then sign in again while online.');
    await loadChartJs();
    if (st.site !== info.site) resetQc();
    if (!st.data || Date.now() - st.loadedAt > STALE_MS) { st.data = await loadQcData(sb, info.site); st.site = info.site; st.loadedAt = Date.now(); }
  } catch (e) {
    if (root.dataset.tab !== mine) return;
    root.innerHTML = `<div class="dash"><div class="card"><h2>Data QC could not load</h2><div class="msg err">${esc(e.message || e)}</div><div class="row actions"><button class="btn" id="q-retry">Try again</button></div></div></div>`;
    root.querySelector('#q-retry').onclick = () => viewQc(root); return;
  }
  if (root.dataset.tab !== mine) return;
  paint(root);
}

function paint(root) {
  destroyCharts();
  const d = st.data, T = Q.thresholds(d.setting), R = Q.analyze(d, T);
  const s = R.summary, age = Math.round((Date.now() - st.loadedAt) / 60000);
  const crmNi = R.crms.filter(c => c.analyte === 'Ni' && c.status !== 'n/a'), dupN = R.dups.filter(x => x.ard != null);
  const kp = (l, v, sub) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${v}</div><div class="s">${esc(sub)}</div></div>`;
  root.innerHTML = `<div class="dash"><div class="dash-bar"><span class="chip good">Live from ${esc(st.site)}${age ? ` · ${age} min ago` : ''}</span>
      <span><button class="btn small" id="q-lab" title="Assay, QAQC, collar, XYZ and parameters as one workbook with live formulas">Download lab analysis (Excel)</button> <button class="btn small" id="q-xls">Download issues (Excel)</button> <button class="btn small" id="q-refresh">Refresh</button></span></div>
    <div class="kpis">
      ${kp('Critical issues', `<span class="${s.critical ? 'ex-bad' : ''}">${nf(s.critical)}</span>`, 'must be fixed or explained')}
      ${kp('Warnings', nf(s.warning), 'check, may be acceptable')}
      ${kp('Lab batches', nf(s.batches), `${R.batches.filter(b => b.status === 'fail').length} failed, ${R.batches.filter(b => b.status === 'warn').length} with warnings`)}
      ${kp('QAQC checks failed', s.qaqcTotal ? nf(s.qaqcFail / s.qaqcTotal * 100, 1) + '%' : '-', `${nf(s.qaqcFail)} of ${nf(s.qaqcTotal)} (blank, CRM, duplicate)`)}
      ${kp('CRM Ni Z (mean)', crmNi.length ? nf(crmNi.reduce((a, c) => a + c.z, 0) / crmNi.length, 2) : '-', `${crmNi.length} CRM results; |Z| ≤ ${T.crm_z_warn} is good`)}
      ${kp('Duplicates within limit', dupN.length ? nf(dupN.filter(x => x.status === 'pass').length / dupN.length * 100, 0) + '%' : '-', `${dupN.length} pairs, Ni ARD`)}
    </div>
    <div class="ex-controls" style="margin-bottom:12px"><span class="seg" id="q-sub">
      ${[['geo', 'QC & Survey'], ['qaqc', 'QAQC Geochemistry'], ['thr', 'Thresholds']].map(([k, l]) => `<button data-s="${k}" class="${st.sub === k ? 'on' : ''}">${l}</button>`).join('')}</span></div>
    <div id="q-body"></div></div>`;
  const body = root.querySelector('#q-body');
  ({ geo: () => geoTab(body, R), qaqc: () => qaqcTab(body, R, T, d), thr: () => thrTab(body, T, d) })[st.sub]();
  root.querySelector('#q-sub').onclick = e => { const k = e.target.dataset.s; if (k) { st.sub = k; paint(root); } };
  root.querySelector('#q-refresh').onclick = () => { st.data = null; viewQc(root); };
  root.querySelector('#q-xls').onclick = () => download(R);
  root.querySelector('#q-lab').onclick = () => {
    try {
      const u8 = buildLabWorkbook({ site: st.site, generated: new Date().toLocaleDateString('sv-SE'), collars: d.collar, assays: d.assay, crm: d.crm, setting: d.setting, utm: d.utm });
      save(u8, `lab_analysis_${st.site}_${new Date().toLocaleDateString('sv-SE')}.xlsx`);
    } catch (e) { console.error(e); alert('Workbook failed: ' + (e.message || e)); }
  };
}

/* ---------- QC & Survey ---------- */
function geoTab(body, R) {
  const cats = [...new Set(R.issues.map(i => i.cat))].sort();
  const rank = { critical: 0, warning: 1, info: 2 };
  const rows = R.issues.filter(i => (!st.sev || i.sev === st.sev) && (!st.cat || i.cat === st.cat) && (!st.q || `${i.hole} ${i.ref} ${i.msg}`.toLowerCase().includes(st.q.toLowerCase())))
    .sort((a, b) => { const [k, dir] = st.sort; const va = k === 'sev' ? rank[a.sev] : String(a[k]), vb = k === 'sev' ? rank[b.sev] : String(b[k]); return (va > vb ? 1 : va < vb ? -1 : 0) * dir; });
  const th = (k, l) => `<th data-sort="${k}" style="cursor:pointer;text-align:left">${l}${st.sort[0] === k ? (st.sort[1] > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  body.innerHTML = `<div class="card w12"><div class="card-head"><div><h3>Issues</h3><p class="sub">Collar, survey, sample register and assay interval checks, plus every failed QAQC result. ${nf(rows.length)} of ${nf(R.issues.length)} shown.</p></div></div>
    <div class="ex-controls" style="margin-bottom:8px">
      <select id="f-sev"><option value="">All severities</option>${['critical', 'warning', 'info'].map(k => `<option value="${k}" ${st.sev === k ? 'selected' : ''}>${SEV[k][1]}</option>`).join('')}</select>
      <select id="f-cat"><option value="">All categories</option>${cats.map(c => `<option ${st.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <input id="f-q" type="search" placeholder="Search hole, sample, message" value="${esc(st.q)}" style="max-width:260px"></div>
    ${rows.length ? `<div class="tw" style="max-height:60vh;overflow:auto"><table class="qc-tbl"><thead><tr>${th('sev', 'Severity')}${th('cat', 'Category')}${th('hole', 'Hole')}${th('ref', 'Reference')}${th('msg', 'Issue')}</tr></thead>
      <tbody>${rows.slice(0, 500).map(i => `<tr><td>${pill(i.sev)}</td><td>${esc(i.cat)}</td><td>${esc(i.hole)}</td><td>${esc(i.ref)}</td><td>${esc(i.msg)}</td></tr>`).join('')}</tbody></table>
      ${rows.length > 500 ? `<p class="muted small">First 500 shown. Narrow the filter or download the Excel file for all ${nf(rows.length)}.</p>` : ''}</div>` : '<div class="empty">No issues for this filter ✓</div>'}</div>`;
  const re = () => geoTab(body, R);
  body.querySelector('#f-sev').onchange = e => { st.sev = e.target.value; re(); };
  body.querySelector('#f-cat').onchange = e => { st.cat = e.target.value; re(); };
  body.querySelector('#f-q').oninput = e => { st.q = e.target.value; clearTimeout(geoTab.t); geoTab.t = setTimeout(() => { re(); const i = body.querySelector('#f-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
  body.querySelectorAll('th[data-sort]').forEach(h => h.onclick = () => { const k = h.dataset.sort; st.sort = [k, st.sort[0] === k ? -st.sort[1] : 1]; re(); });
}

/* ---------- QAQC geochemistry ---------- */
function qaqcTab(body, R, T, d) {
  const hasQc = R.blanks.length + R.crms.length + R.dups.length > 0;
  if (!hasQc) { body.innerHTML = `<div class="card w12"><div class="empty">No lab QC data yet. Import a lab Report of Analysis (RoA Lab tab) to see blank, CRM and duplicate results.${d.crm.length ? '' : '<br>The CRM certificate table is empty (run migration 0014 on this site).'}</div></div>`; return; }
  const analytes = [...new Set(R.crms.filter(c => c.status !== 'n/a').map(c => c.analyte))];
  if (!analytes.includes(st.analyte)) st.analyte = analytes.includes('Ni') ? 'Ni' : analytes[0] || 'Ni';
  const crmRows = R.crms.filter(c => c.analyte === st.analyte);
  body.innerHTML = `<div class="grid" id="q-grid"></div>`; const g = body.querySelector('#q-grid');
  // batch table
  const bt = document.createElement('div'); bt.className = 'card w12';
  bt.innerHTML = `<h3>Batch status</h3><p class="sub">One row per lab report. A batch fails when any blank, CRM or duplicate fails; it warns when a QC type is missing or a result is borderline.</p>
    <div class="tw"><table class="qc-tbl"><thead><tr><th>Lab report</th><th>Reported</th><th>Samples</th><th>Blank</th><th>CRM</th><th>Dup</th><th>QC rate</th><th>Fails</th><th>Warns</th><th>Status</th></tr></thead>
    <tbody>${R.batches.map(b => `<tr><td>${esc(b.batch)}</td><td>${esc(b.reported || '-')}</td><td>${b.primary}</td><td>${b.blank}</td><td>${b.crm}</td><td>${b.dup}</td><td>${b.qcRate == null ? '-' : b.qcRate + '%'}</td><td>${b.fails}</td><td>${b.warns}</td><td>${pill(b.status)}${b.missing.length ? ` <span class="muted small">no ${esc(b.missing.join(', '))}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  g.appendChild(bt);
  // blank
  chartCard({ title: 'Blank: Ni', sub: `Limit ${T.blank_ni_max}% Ni. A blank above the limit means carry-over or contamination in preparation.`, w: 'w6', root: g,
    head: ['Batch', 'Sample', 'Ni %', 'Status'], rows: R.blanks.map(b => [b.batch, b.sample_no, b.ni, SEV[b.status][1]]),
    make: cv => new Chart(cv, { type: 'bar', data: { labels: R.blanks.map(b => `${b.batch.slice(-5)} ${b.sample_no}`), datasets: [
      { label: 'Ni %', data: R.blanks.map(b => b.ni), backgroundColor: R.blanks.map(b => b.status === 'fail' ? COLOR.fail : COLOR.ok), maxBarThickness: 18, borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: 'bottom' },
      { type: 'line', label: `Limit ${T.blank_ni_max}`, data: R.blanks.map(() => T.blank_ni_max), borderColor: COLOR.fail, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 }] },
      options: { ...baseOptions({ legend: true, yTitle: 'Ni %' }) } }) });
  // duplicates
  const dd = R.dups.filter(x => x.ard != null);
  chartCard({ title: 'Duplicates: Ni ARD', sub: `ARD = |dup - orig| / mean. Limits: PD ${T.dup_ard_ni_max.PD * 100}%, CD ${T.dup_ard_ni_max.CD * 100}%, RD ${T.dup_ard_ni_max.RD * 100}%.`, w: 'w6', root: g,
    head: ['Batch', 'Duplicate', 'Type', 'Orig Ni', 'Dup Ni', 'ARD %', 'Limit %', 'Status'], rows: R.dups.map(x => [x.batch, x.sample_no, x.type, x.orig_ni ?? '', x.dup_ni ?? '', x.ard == null ? '' : +(x.ard * 100).toFixed(1), x.max * 100, SEV[x.status][1] + (x.note ? ' (' + x.note + ')' : '')]),
    make: cv => new Chart(cv, { type: 'bar', data: { labels: dd.map(x => x.sample_no), datasets: [
      { label: 'ARD %', data: dd.map(x => +(x.ard * 100).toFixed(2)), backgroundColor: dd.map(x => x.status === 'fail' ? COLOR.fail : COLOR.ok), maxBarThickness: 14, borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: 'bottom' },
      { type: 'line', label: 'Limit', data: dd.map(x => x.max * 100), borderColor: COLOR.fail, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, stepped: true }] },
      options: { ...baseOptions({ legend: true, yTitle: 'ARD %' }), scales: { x: { ticks: { display: false }, grid: { display: false } }, y: baseOptions({ yTitle: 'ARD %' }).scales.y } } }) });
  // CRM
  const sel = `<select id="q-an" style="width:auto">${analytes.map(a => `<option ${a === st.analyte ? 'selected' : ''}>${a}</option>`).join('')}</select>`;
  const crmCard = chartCard({ title: `CRM Z-score: ${st.analyte}`, sub: `Z = (measured - certified) / SD. Warn beyond ±${T.crm_z_warn}, fail beyond ±${T.crm_z_fail}. Persistent same-sign Z means lab bias.`, w: 'w12', root: g,
    head: ['Batch', 'CRM sample', 'Measured', 'Certified', 'SD', 'Z', 'Status'], rows: crmRows.map(c => [c.batch, c.sample_no, c.measured, c.certified, c.sd, c.z, SEV[c.status][1]]),
    make: cv => new Chart(cv, { type: 'bar', data: { labels: crmRows.map(c => `${c.batch.slice(-5)} ${c.sample_no.replace(/OREAS\s*/i, '')}`), datasets: [
      { label: 'Z', data: crmRows.map(c => c.z), backgroundColor: crmRows.map(c => c.status === 'fail' ? COLOR.fail : c.status === 'warn' ? COLOR.warn : COLOR.ok), maxBarThickness: 18 },
      ...[T.crm_z_warn, -T.crm_z_warn].map(v => ({ type: 'line', label: `±${T.crm_z_warn} warn`, data: crmRows.map(() => v), borderColor: COLOR.warn, borderDash: [4, 4], pointRadius: 0, borderWidth: 1.2 })),
      ...[T.crm_z_fail, -T.crm_z_fail].map(v => ({ type: 'line', label: `±${T.crm_z_fail} fail`, data: crmRows.map(() => v), borderColor: COLOR.fail, borderDash: [6, 3], pointRadius: 0, borderWidth: 1.2 }))] },
      options: { ...baseOptions({ legend: false, yTitle: 'Z' }), scales: { x: { ticks: { maxRotation: 60, font: { size: 10 }, color: COLOR.ink }, grid: { display: false } }, y: { grid: { color: COLOR.grid }, border: { display: false }, title: { display: true, text: 'Z' }, suggestedMin: -4, suggestedMax: 4 } } } }) });
  crmCard.querySelector('.card-head').insertAdjacentHTML('beforeend', `<label class="small muted" style="margin:0">Analyte ${sel}</label>`);
  crmCard.querySelector('#q-an').onchange = e => { st.analyte = e.target.value; paint(body.closest('.dash').parentElement); };
  // bias table
  const bi = document.createElement('div'); bi.className = 'card w12';
  const skipped = [...new Set(R.crms.filter(c => c.status === 'n/a').map(c => c.analyte))];
  bi.innerHTML = `<h3>Lab bias per batch</h3><p class="sub">Mean Z per CRM analyte. |mean Z| above 1 is flagged as bias.${skipped.length ? ` ${esc(skipped.join(', '))} is not scored: its certified SD is below the lab's 2-decimal reporting resolution, so Z would only reflect rounding.` : ''}</p>
    <div class="tw"><table class="qc-tbl"><thead><tr><th>Lab report</th><th>CRM</th><th>Analyte</th><th>n</th><th>Mean Z</th><th>Max |Z|</th><th>Bias</th></tr></thead><tbody>
    ${R.bias.filter(b => !skipped.includes(b.analyte)).map(b => `<tr><td>${esc(b.batch)}</td><td>${esc(b.crm)}</td><td>${esc(b.analyte)}</td><td>${b.n}</td><td>${b.meanZ}</td><td>${b.maxAbsZ}</td><td>${b.bias === 'none' ? '-' : b.bias === 'high' ? '▲ reads high' : '▼ reads low'}</td></tr>`).join('')}</tbody></table></div>`;
  g.appendChild(bi);
  if (R.clashes.length) {
    const cl = document.createElement('div'); cl.className = 'card w12';
    cl.innerHTML = `<h3>Identical QC results across reports</h3><p class="sub">A blank or CRM that returns exactly the same values in two reports may have been copied instead of measured. Ask the lab to confirm.</p>
      <ul class="small">${R.clashes.map(c => `<li><b>${esc(c.type)}</b>: ${c.rows.map(r => esc(r.batch + ' ' + r.sample_no)).join(' = ')}</li>`).join('')}</ul>`;
    g.appendChild(cl);
  }
  // classes
  const order = ['BRK', 'RSAP', 'SAP', 'CEK', 'LIM'], cl = order.map(k => R.classes[k] || 0);
  chartCard({ title: 'Samples by geochemical class', sub: 'BRK/RSAP/SAP/CEK/LIM from Ni, Fe, MgO (rules on the Thresholds tab). A quick sanity check on a new batch.', w: 'w6', root: g, head: ['Class', 'Samples'], rows: order.map((k, i) => [k, cl[i]]),
    make: cv => new Chart(cv, { type: 'bar', data: { labels: order, datasets: [{ label: 'Samples', data: cl, backgroundColor: COLOR.ok, maxBarThickness: 36, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom' }] }, options: baseOptions({ yTitle: 'Samples' }) }) });
}

/* ---------- thresholds ---------- */
function thrTab(body, T, d) {
  const src = d.setting ? 'site setting "qaqc_thresholds" (edited by an admin)' : 'built-in defaults (same as migration 0014)';
  const rows = [
    ['Blank: Ni maximum', `${T.blank_ni_max} %`, 'About 5 × the detection limit (0.01 %). A blank is clean material; anything above means carry-over or contamination in crushing/pulverising.'],
    ['Pulp duplicate (PD): Ni ARD', `${T.dup_ard_ni_max.PD * 100} %`, 'ARD = |dup − orig| / mean. Pulp is homogenised, so the tightest limit: it measures the lab analysis alone.'],
    ['Coarse duplicate (CD): Ni ARD', `${T.dup_ard_ni_max.CD * 100} %`, 'Includes crushing and splitting error, so a looser limit.'],
    ['Reject duplicate (RD): Ni ARD', `${T.dup_ard_ni_max.RD * 100} %`, 'RD is not defined by the lab yet (reject or repeat); it uses the CD limit until confirmed.'],
    ['CRM warn |Z|', `${T.crm_z_warn} SD`, 'Z = (measured − certified) / certified SD. Beyond 2 SD happens by chance about 1 time in 20: look, do not reject.'],
    ['CRM fail |Z|', `${T.crm_z_fail} SD`, 'Beyond 3 SD is rare by chance: the batch result is suspect (bias, mix-up, drift).'],
    ['CRM resolution rule', `SD < ${T.lab_resolution}`, 'The lab prints 2 decimals. If a certified SD is smaller than that (Co: 0.0016), Z only measures rounding, so it is not scored.'],
    ['Fe₂O₃ vs Fe × 1.4297', `${T.fe2o3_tol_pct} %`, 'The two are the same iron in different units; a larger gap points to a data entry or analysis problem.'],
    ['Moisture (MC) high', `≥ ${T.mc_max} %`, 'Extreme moisture: re-check preparation and weighing.'],
    ['Sample sent, no result', `${T.sent_warn_days} / ${T.sent_fail_days} days`, 'Warning after 7 days, critical after 14: chase the lab.'],
    ['Dip deviation (collar vs survey)', `${T.dip_dev_warn}°`, 'A survey dip far from the collar dip often means a wrong sign or a mistyped value.'],
    ['GPS accuracy', `${T.gps_warn_m} m`, 'Collar position worse than this is flagged.'],
    ['Ni cut-off', `${T.cutoff_ni} %`, 'Used for ore composites in the lab-analysis workbook.'],
  ];
  body.innerHTML = `<div class="card w12"><h3>Thresholds in use</h3>
    <p class="sub">Source: ${esc(src)}. They follow the TPB lab-analysis workbook (Parameter sheet): CRM by Z-score against the certificate, duplicates by relative difference (ARD), blank by an absolute Ni limit. GeoExploration uses percent deviation instead (CRM ±10/20 %, RPD 10/20 %); Z-score is stricter because it uses the CRM's own SD.</p>
    <div class="tw"><table class="qc-tbl"><thead><tr><th>Check</th><th>Limit</th><th>Why</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r[0])}</td><td><b>${esc(r[1])}</b></td><td>${esc(r[2])}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small" style="margin-top:10px"><b>Classification</b> (in order): BRK Ni&lt;0.8 and MgO≥30 and Fe&lt;10; RSAP MgO≥20 and Fe&lt;15; SAP MgO≥10, or Fe&lt;25 with MgO≥5; CEK Fe&lt;25 and MgO&lt;5; otherwise LIM. <b>Laterite indication</b>: Al₂O₃ ≥8 high, ≥4 medium; Cr₂O₃ ≥2 high, ≥1 medium; Cr₂O₃ ≥4 chromite; Al₂O₃ ≥15 clay. These are common Sulawesi laterite practice, not a standard: adjust to your SOP.</p>
    <p class="muted small"><b>CRM certificate values</b> (${d.crm.length} rows in the site table): ${esc([...new Set(d.crm.map(c => c.crm_name))].join(', ') || 'none')}. Admins edit them in Supabase (table exp_crm). Never use the OREAS 182 certificate for 182b.</p></div>`;
}

/* ---------- Excel of the issues + QAQC results ---------- */
function download(R) {
  const sheets = [
    { name: 'Issues', header: ['Severity', 'Category', 'Hole', 'Reference', 'Issue'], rows: R.issues.map(i => [SEV[i.sev][1], i.cat, i.hole, i.ref, i.msg]) },
    { name: 'Batches', header: ['Lab report', 'Reported', 'Samples', 'Blank', 'CRM', 'Dup', 'QC rate %', 'Fails', 'Warns', 'Status', 'Missing QC'], rows: R.batches.map(b => [b.batch, b.reported, b.primary, b.blank, b.crm, b.dup, b.qcRate, b.fails, b.warns, SEV[b.status][1], b.missing.join(', ')]) },
    { name: 'Blank', header: ['Lab report', 'Sample', 'Ni %', 'Limit %', 'Status'], rows: R.blanks.map(b => [b.batch, b.sample_no, b.ni, b.limit, SEV[b.status][1]]) },
    { name: 'CRM', header: ['Lab report', 'Sample', 'Analyte', 'Measured', 'Certified', 'SD', 'Z', 'Status'], rows: R.crms.map(c => [c.batch, c.sample_no, c.analyte, c.measured, c.certified, c.sd, c.z, SEV[c.status][1]]) },
    { name: 'Duplicate', header: ['Lab report', 'Duplicate', 'Original', 'Type', 'Ni orig', 'Ni dup', 'ARD', 'Limit', 'Status'], rows: R.dups.map(x => [x.batch, x.sample_no, x.original, x.type, x.orig_ni, x.dup_ni, x.ard, x.max, SEV[x.status][1]]) },
  ];
  save(buildXlsx(sheets), `data_qc_${st.site}_${new Date().toLocaleDateString('sv-SE')}.xlsx`);
}
function save(u8, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([u8], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
