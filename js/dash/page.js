// One-page dashboard (layout follows the "Exploration Progress" reference artifact):
// header + month-to-date take, controls, Drilling Progress, Hour Distribution, Samples.
import * as C from './calc.js';
import { renderCollarMap, destroyMap, CLASSES } from './map.js';
import { chartCard, baseOptions, hBarStyle, COLOR, SERIES, GAP, nf, nid, pct, esc } from './ui.js';

// fixed categorical order (validated: lightness band, chroma, CVD/normal separation); colour follows the entity, never its rank
const sc = i => SERIES[i % SERIES.length];
const kpi = (label, value, sub, cls = '') => `<div class="ex-card"><div class="k">${esc(label)}</div><div class="v ${cls}">${value}</div><div class="s">${esc(sub)}</div></div>`;
const achCls = v => (v === null || v === undefined ? '' : v >= 100 ? 'ex-good' : v < 90 ? 'ex-bad' : '');

export function renderPage(root, d, f, state) {
  destroyMap();
  const hub = !!state.hub;                     // All-sites view: rows from several sites, no assay data
  const period = state.period || 'daily';
  const mtd = C.monthToDate(d, f);
  if (!mtd) { root.innerHTML = '<div class="ex-wrap"><div class="ex-card"><div class="empty">No drilling progress yet for this site.</div></div></div>'; return; }
  const siteList = hub ? [...new Set(d.collar.map(c => c.site_code))].sort() : [];
  const scope = (hub ? (f.sites ? [...f.sites].join(', ') : 'all sites') + ', ' : '') + (f.prospect ? 'prospect ' + f.prospect : 'all prospects');
  const rigOpts = [...new Map(d.rigs.filter(r => !f.sites || f.sites.has(r.site_code)).map(r => [r.rig_id, r.rig_name])).entries()];
  const prospectOpts = C.prospectsOf({ ...d, collar: d.collar.filter(c => !f.sites || f.sites.has(c.site_code)) });

  root.innerHTML = `<div class="ex-wrap">
  <div class="ex-head"><h1>Exploration Progress${hub ? ' (all sites)' : ''}</h1>
    <p class="ex-sub">Drilling progress, rig hour distribution and sample status, live from the site database.</p>
    <p class="ex-take">Month to date (<b>${esc(mtd.month)}</b>): drilled <b>${nf(mtd.meters, 0)}</b> m${mtd.plan ? ` of plan <b>${nf(mtd.plan, 0)}</b> m (achievement <b class="${achCls(mtd.pct)}">${nf(mtd.pct, 1)}%</b>)` : ' (no weekly plan entered)'}, ${esc(scope)}, all rigs.</p></header>
  <div class="ex-controls" role="group" aria-label="Dashboard filters">
    ${hub ? `<label for="fSite">Site</label><select id="fSite"><option value="">All sites</option>${siteList.map(x => `<option value="${esc(x)}" ${f.sites?.has(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : ''}
    <label for="fProspect">Prospect</label>
    <select id="fProspect"><option value="">All prospects</option>${prospectOpts.map(p => `<option value="${esc(p.code)}" ${f.prospect === p.code ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <label for="fRig">Rig</label>
    <select id="fRig"><option value="">All rigs</option>${rigOpts.map(([id, n]) => `<option value="${esc(id)}" ${f.rig === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <span class="ex-seg" id="period" role="group" aria-label="Aggregation period">${Object.entries(C.PERIODS).map(([k, v]) => `<button type="button" data-period="${k}" aria-pressed="${k === period}">${v.label}</button>`).join('')}</span>
    <button type="button" class="ex-reset" id="fReset">Reset</button>
  </div>
  <section class="ex-sec"><h2>Drilling Progress</h2>
    <p class="ex-note">Meters per period, stacked by rig; dashed line = plan. Filters and the period buttons apply to the chart; the cards are always month to date, all rigs.</p>
    <div class="ex-kpis">
      ${kpi('Meters drilled (MTD)', nf(mtd.meters, 0), 'Current month, all rigs')}
      ${kpi('Plan (MTD)', mtd.plan ? nf(mtd.plan, 0) : '-', 'Weekly plan spread over days')}
      ${kpi('Achievement', mtd.pct === null ? '-' : nf(mtd.pct, 1) + '%', 'Actual / plan, MTD', achCls(mtd.pct))}
      ${kpi('Holes drilled (MTD)', nf(mtd.holes), 'Distinct holes, current month')}
    </div>
    <div id="g-prog"></div>
    <div id="g-rig"></div>
  </section>
  <section class="ex-sec"><h2>Hour Distribution</h2>
    <p class="ex-note">Hours per activity per rig, last 60 days. Prospect and rig filters apply; the period buttons do not.</p>
    <div id="g-hours"></div>
  </section>
  <section class="ex-sec"><h2>Samples</h2>
    <p class="ex-note">Lab status of samples (Pending, Sent, Analyzed). Prospect filter applies.</p>
    <div id="g-samples"></div>
  </section>
  <section class="ex-sec"><h2>Collar Map</h2>
    <p class="ex-note">Collars by class (Planned, EOH, COH) at their as-built position, or the planned position when there is none. Prospect${hub ? ', Site' : ''} filter applies.</p>
    <div class="ex-legend" id="g-maplegend"></div><div class="dmap" id="g-map"></div>
  </section>
  ${hub ? `<section class="ex-sec"><h2>Site status</h2><p class="ex-note">Last pull of each site into explohub. QAQC needs the assay tables, which the hub dashboard views do not expose, so it is on each site's own Dashboard.</p><div id="g-status"></div></section>` : `<section class="ex-sec"><h2>QAQC Geokimia</h2>
    <p class="ex-note">Terkirim = sampel dengan tanggal kirim ke lab. ROA diinput = hasil lab yang sudah di-import dari PDF RoA. Excel QAQC selesai = batch lab sudah punya minimal 1 blank, 1 CRM dan 1 duplikat. Filter Prospect berlaku untuk grafik alur, kartu gagal dan kedua grafik QC (duplikat mengikuti lubang; blank dan CRM mengikuti batch lab yang memuat sampel prospect itu). Empat kartu teratas selalu mencakup semua prospect.</p>
    <div id="g-qaqc"></div>
  </section>`}
  </div>`;

  // --- stacked meters per rig + plan line
  const pb = C.progressBuckets(d, f, period);
  const labels = pb.rows.map(r => C.bucketLabel(period, r.b));
  chartCard({ root: root.querySelector('#g-prog'), title: 'Meters vs plan',
    sub: `${C.PERIODS[period].label} aggregation, ${C.PERIODS[period].note}${pb.hasPlan ? '' : '. Plan is a site total, hidden while a prospect or rig is selected'}.`,
    head: ['Period', ...pb.rigs.map(r => r.name + ' (m)'), 'Total (m)', 'Plan (m)'],
    rows: pb.rows.filter(r => r.total > 0 || r.plan > 0).map(r => [C.bucketLabel(period, r.b), ...pb.rigs.map(g => nf(r.rig[g.id], 1)), nf(r.total, 1), r.plan ? nf(r.plan, 1) : '-']),
    make: cv => {
      const o = baseOptions({ legend: true, yTitle: 'm', stacked: true });
      o.plugins.legend.position = 'bottom'; o.plugins.legend.align = 'start';
      o.plugins.tooltip.callbacks = { footer: items => { const r = pb.rows[items[0].dataIndex]; return `Total ${nf(r.total, 1)} m` + (r.plan ? ` / plan ${nf(r.plan, 1)} m` : ''); } };
      return new Chart(cv, { data: { labels, datasets: [
        ...pb.rigs.map((g, i) => ({ type: 'bar', label: g.name, data: pb.rows.map(r => Math.round(r.rig[g.id] * 10) / 10), backgroundColor: sc(i), ...GAP, maxBarThickness: 22, stack: 's', order: 2 })),
        ...(pb.hasPlan ? [{ type: 'line', label: 'Plan', data: pb.rows.map(r => (r.plan ? Math.round(r.plan * 10) / 10 : null)), borderColor: '#64748B', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, spanGaps: true, order: 1 }] : [])] }, options: o });
    } });
  root.querySelector('#g-prog .chart-box').classList.add('tall');

  // --- per-rig summary (month to date, all rigs)
  const dd = C.filterData(d, { ...f, from: mtd.from, to: mtd.to, rig: null });
  const hrs = new Map(); for (const r of dd.dist) { const x = hrs.get(r.rig_id) || { t: 0, dr: 0 }; x.t += r.hours || 0; if (r.activity === 'DRILLING') x.dr += r.hours || 0; hrs.set(r.rig_id, x); }
  const rigs = mtd.rigs;
  root.querySelector('#g-rig').innerHTML = `<div class="ex-chartcard"><h3>Rig summary, month to date</h3>
    <p class="ex-note">Share = rig meters / total meters. Drilling hours % = Drilling share of the rig's logged hours this month. Plan is a site total, so there is no per-rig plan.</p>
    <div class="ex-tablewrap">${rigs.length ? `<table class="ex-table"><thead><tr><th>Rig</th><th>Meters</th><th>Share</th><th>Holes</th><th>Days</th><th>m/day</th><th>Recovery</th><th>% Drilling hours</th></tr></thead><tbody>
    ${rigs.map(r => { const h = hrs.get(r.rig); return `<tr><td>${esc(r.name)}</td><td>${nf(r.meters, 0)}</td><td>${pct(mtd.meters ? (r.meters / mtd.meters) * 100 : null)}</td><td>${nf(r.holes)}</td><td>${nf(r.days)}</td><td>${nf(r.perDay, 1)}</td><td>${pct(r.recovery)}</td><td>${h && h.t ? pct((h.dr / h.t) * 100) : '-'}</td></tr>`; }).join('')}
    </tbody></table>` : '<div class="empty">No drilling this month</div>'}</div></div>`;

  // --- hours per activity per rig (horizontal stacked)
  const hb = C.hoursByRig(d, f);
  chartCard({ root: root.querySelector('#g-hours'), title: 'Hours per activity per rig', sub: 'Last 60 days, Distribution Hour',
    head: ['Rig', ...hb.acts.map(a => a.label + ' (h)'), 'Total (h)'],
    rows: hb.rigs.map(r => [r.name, ...hb.acts.map(a => nf(r.h[a.code] || 0, 1)), nf(Object.values(r.h).reduce((t, x) => t + x, 0), 1)]),
    make: cv => {
      const o = baseOptions({ horizontal: true, legend: true, stacked: true, yTitle: '' });
      o.scales.x.title = { display: true, text: 'hours', color: COLOR.ink };
      o.plugins.legend.position = 'bottom'; o.plugins.legend.align = 'start';
      return new Chart(cv, { type: 'bar', data: { labels: hb.rigs.map(r => r.name), datasets: hb.acts.map((a, i) => ({ label: a.label, data: hb.rigs.map(r => Math.round((r.h[a.code] || 0) * 10) / 10), backgroundColor: sc(i), ...GAP, maxBarThickness: 22 })) }, options: o });
    } });

  // --- samples by status per prospect
  const sp = C.samplesByProspect(d, f);
  const tot = sp.reduce((t, x) => t + x.PENDING + x.SENT + x.ANALYZED, 0);
  const sum = k => sp.reduce((t, x) => t + (x[k] || 0), 0);
  root.querySelector('#g-samples').innerHTML = `<div class="ex-kpis">
    ${kpi('Samples', nf(tot), 'In this selection')}
    ${kpi('Not sent to lab', nf(sum('PENDING')), 'Status Pending', sum('PENDING') ? 'ex-bad' : '')}
    ${kpi('Sent', nf(sum('SENT')), 'Awaiting results')}
    ${kpi('Analyzed', nf(sum('ANALYZED')), tot ? pct((sum('ANALYZED') / tot) * 100, 0) + ' of samples' : '')}
  </div><div id="g-sp"></div>`;
  const STAT = [['PENDING', 'Pending', SERIES[1]], ['SENT', 'Sent', SERIES[2]], ['ANALYZED', 'Analyzed', SERIES[0]]];
  chartCard({ root: root.querySelector('#g-sp'), title: 'Sample status by prospect', sub: 'Count of samples',
    head: ['Prospect', ...STAT.map(s => s[1])], rows: sp.map(x => [x.prospect, ...STAT.map(s => nf(x[s[0]]))]),
    make: cv => { const o = baseOptions({ horizontal: true, legend: true, stacked: true }); o.plugins.legend.position = 'bottom'; o.plugins.legend.align = 'start'; o.scales.x.ticks.precision = 0;
      return new Chart(cv, { type: 'bar', data: { labels: sp.map(x => x.prospect), datasets: STAT.map(([k, l, c]) => ({ label: l, data: sp.map(x => x[k]), backgroundColor: c, ...GAP, maxBarThickness: 22 })) }, options: o }); } });

  // --- collar map
  const cc = C.collarClassCounts(d, f);
  root.querySelector('#g-maplegend').innerHTML = Object.entries(CLASSES).map(([k, c]) => `<span class="ex-lg"><i style="background:${c.fill};border-color:${c.color}"></i>${c.label} <b>${nf(cc.counts[k] || 0)}</b></span>`).join('')
    + `<span class="ex-lg muted">${nf(cc.mapped)} of ${nf(cc.total)} collars have coordinates</span>`;
  if (!state.noMap) renderCollarMap(root.querySelector('#g-map'), C.collarPoints(d, f));
  else root.querySelector('#g-map').remove();

  if (hub) {
    const rowsS = (d.status || []).filter(x => !f.sites || f.sites.has(x.site_code));
    root.querySelector('#g-status').innerHTML = rowsS.length ? `<div class="ex-tablewrap"><table class="ex-table"><thead><tr><th>Site</th><th>Last OK pull</th><th>Hours since</th><th>Latest progress</th><th>Collars</th><th>Progress rows</th><th>Samples</th><th>Assay rows</th><th>State</th></tr></thead><tbody>
      ${rowsS.map(x => `<tr><td>${esc(x.site_code)}</td><td>${esc(String(x.last_ok_at || '-').slice(0, 16).replace('T', ' '))}</td><td>${x.hours_since_ok == null ? '-' : nf(x.hours_since_ok, 1)}</td><td>${esc(x.latest_progress_date || '-')}</td><td>${nf(x.collars)}</td><td>${nf(x.progress_rows)}</td><td>${nf(x.samples)}</td><td>${nf(x.assay_rows)}</td><td>${x.has_error ? '<span class="pill fail">Error</span>' : '<span class="pill pass">OK</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No site status available</div>';
    return;
  }
  renderQaqc(root.querySelector('#g-qaqc'), d, f);
}

// --- QAQC Geokimia (labels in Indonesian, numbers as 8.782 and 8,0%)
const dayNum = s => Date.parse(s + 'T00:00:00Z') / 864e5;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];   // same short month names as the reference chart
const dayId = n => { const x = new Date(Math.round(n) * 864e5); return `${String(x.getUTCDate()).padStart(2, '0')} ${MON[x.getUTCMonth()]}`; };
const STAT_ID = { pass: 'Lolos', fail: 'Gagal', warn: 'Perlu dicek' };
const failCard = (label, bad, total, sub) => `<div class="ex-card"><div class="k">${esc(label)}</div><div class="v ${bad ? 'ex-bad' : ''}">${nid(bad)}<span class="of"> / ${nid(total)}</span></div><div class="s">${esc(sub)}</div></div>`;

// draws a text label just above a horizontal reference value, at the right edge of the plot
const refLabel = items => ({ id: 'refLabel', afterDatasetsDraw(ch) {
  const { ctx, chartArea: a, scales: { y } } = ch; ctx.save(); ctx.fillStyle = COLOR.ink; ctx.font = '11px Geist, system-ui, sans-serif'; ctx.textAlign = 'right';
  for (const [v, t] of items) ctx.fillText(t, a.right - 4, y.getPixelForValue(v) - 5);
  ctx.restore(); } });

function scatterOptions(xTitle, yTitle, tipFn) {
  const o = baseOptions({ legend: true });
  o.interaction = { mode: 'nearest', intersect: true };
  o.plugins.legend.position = 'bottom'; o.plugins.legend.align = 'start';
  o.plugins.legend.labels.filter = it => !it.text.startsWith('_');
  o.plugins.tooltip.filter = it => !it.dataset.label.startsWith('_');
  o.plugins.tooltip.callbacks = { title: () => '', label: tipFn };
  o.scales.x.type = 'linear'; o.scales.y.type = 'linear';
  o.scales.x.beginAtZero = o.scales.y.beginAtZero = true;
  o.scales.x.grid = { color: COLOR.grid, drawTicks: false }; o.scales.x.border = { display: false };
  o.scales.x.title = xTitle ? { display: true, text: xTitle, color: COLOR.ink } : undefined;
  o.scales.y.title = yTitle ? { display: true, text: yTitle, color: COLOR.ink } : undefined;
  return o;
}
const dot = (label, color, data) => ({ type: 'scatter', label, data, backgroundColor: color, borderColor: color, pointRadius: 3.5, pointHoverRadius: 6, pointHitRadius: 8 });
const guide = (label, data, color, dash) => ({ type: 'line', label: '_' + label, data, borderColor: color, borderWidth: 1, borderDash: dash || [], pointRadius: 0, pointHitRadius: 0, fill: false, order: 9 });

function renderQaqc(root, d, f) {
  if (d.qaqcError) { root.innerHTML = `<div class="ex-card"><div class="empty">Data QAQC tidak bisa dimuat: ${esc(d.qaqcError)}</div></div>`; return; }
  const fl = C.qaqcFlow(d, f), t = fl.totals, ck = C.qaqcChecks(d), T = ck.T;
  root.innerHTML = `<div class="ex-kpis">
    ${kpi('Sampel terkirim', nid(t.sent), `${nid(t.roa)} sudah ROA, ${nid(t.qaqc)} Excel QAQC selesai`)}
    ${kpi('ROA belum diinput', nid(t.roaPending), 'Terkirim, belum ada RoA PDF', t.roaPending ? 'ex-bad' : '')}
    ${kpi('Excel QAQC tertunda', nid(t.qaqcPending), 'Batch belum punya blank + CRM + duplikat', t.qaqcPending ? 'ex-bad' : '')}
    ${kpi('Insertion rate QC', t.rate === null ? '-' : nid(t.rate, 1) + '%', `${nid(t.qc)} sampel QC dari ${nid(t.sent)} terkirim`)}
  </div>
  <div id="q-flow"></div>
  <div class="ex-kpis q-fail">
    ${failCard('Blank gagal', ck.fail.blank, ck.blanks.length, `Ni > ${nid(T.blank_ni_max, 2)}% dianggap terkontaminasi`)}
    ${failCard('CRM gagal', ck.fail.crm, ck.crms.length, `Di luar ±${nid(T.crm_z_fail)}SD nilai sertifikat`)}
    ${failCard('Duplikat gagal', ck.fail.dup, ck.dups.length, 'Selisih relatif pasangan > ' + [...new Set(Object.values(T.dup_ard_ni_max).map(v => nid(v * 100) + '%'))].join(' / '))}
  </div>
  <div id="q-blank"></div><div id="q-dup"></div>`;

  // alur sampel: terkirim vs ROA vs excel QAQC (daily, last 60 days)
  const rows = fl.labels.map((x, i) => [x, fl.sent[i], fl.roa[i], fl.qaqc[i]]).filter(r => r[1] || r[2] || r[3]);
  chartCard({ root: root.querySelector('#q-flow'), title: 'Alur sampel: terkirim vs ROA vs excel QAQC', sub: 'Sampel per hari, 60 hari terakhir. ROA dan Excel QAQC dihitung pada tanggal data masuk.',
    head: ['Tanggal', 'Terkirim', 'ROA diinput', 'Excel QAQC selesai'], rows: rows.map(r => [r[0], ...r.slice(1).map(v => nid(v))]),
    make: cv => { const o = baseOptions({ legend: true, yTitle: 'sampel per hari' }); o.plugins.legend.position = 'bottom'; o.plugins.legend.align = 'start'; o.scales.y.ticks.precision = 0;
      o.scales.x.ticks.callback = function (v) { return dayId(dayNum(this.getLabelForValue(v))); }; o.plugins.tooltip.callbacks = { title: it => dayId(dayNum(fl.labels[it[0].dataIndex])) };
      const ln = (label, data, c) => ({ label, data, borderColor: c, backgroundColor: c, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0 });
      return new Chart(cv, { type: 'line', data: { labels: fl.labels, datasets: [ln('Terkirim', fl.sent, SERIES[0]), ln('ROA diinput', fl.roa, SERIES[1]), ln('Excel QAQC selesai', fl.qaqc, SERIES[2])] }, options: o }); } })
    .querySelector('.chart-box')?.classList.add('tall');

  // blank: Ni per sample over time
  const bl = ck.blanks.filter(b => b.date);
  const xs = bl.map(b => dayNum(b.date)), x0 = xs.length ? Math.min(...xs) : 0, x1 = xs.length ? Math.max(...xs) : 1;
  const bPt = st => bl.filter(b => (b.status === 'fail') === (st === 'fail')).map(b => ({ x: dayNum(b.date), y: b.ni, n: b.sample_no, b: b.batch }));
  const bCard = chartCard({ root: root.querySelector('#q-blank'), title: 'Blank — Ni (%)', sub: `Setiap titik satu sampel blank; garis merah = ambang kontaminasi.`,
    head: ['Lab report', 'Blank', 'Tanggal', 'Ni (%)', 'Status'], rows: ck.blanks.map(b => [b.batch || '', b.sample_no, b.date || '', nid(b.ni, 3), STAT_ID[b.status] || b.status]),
    make: cv => { const o = scatterOptions('', '', c => `${c.raw.n}: Ni ${nid(c.raw.y, 3)}% (${c.raw.b || 'tanpa batch'}, ${dayId(c.raw.x)})`);
      o.scales.x.beginAtZero = false; o.scales.x.min = x0 - 1; o.scales.x.max = x1 + 1; o.scales.x.ticks = { ...o.scales.x.ticks, precision: 0, maxTicksLimit: 8, callback: v => dayId(v) };
      o.scales.y.ticks.callback = v => nid(v, 2).replace(/,?0+$/, '') || '0';
      return new Chart(cv, { type: 'scatter', data: { datasets: [dot('Lolos', SERIES[0], bPt('pass')), dot('Gagal', COLOR.fail, bPt('fail')), guide('ambang', [{ x: x0 - 1, y: T.blank_ni_max }, { x: x1 + 1, y: T.blank_ni_max }], COLOR.ink, [5, 4])] }, options: o,
        plugins: [refLabel([[T.blank_ni_max, `ambang ${nid(T.blank_ni_max, 2)}% Ni`]])] }); } });
  bCard.querySelector('.chart-box')?.classList.add('tall');

  // duplicate: original vs duplicate Ni with y = x and the relative-difference limits
  const dd = ck.dups, mx = Math.max(0.1, ...dd.flatMap(x => [x.orig_ni, x.dup_ni])) * 1.08;
  const dPt = st => dd.filter(x => (x.status === 'fail') === (st === 'fail')).map(x => ({ x: x.orig_ni, y: x.dup_ni, n: x.sample_no, t: x.type, a: x.ard, m: x.max }));
  const lims = [...new Set(dd.map(x => x.max))].sort((a, b) => a - b);
  const slope = a => (2 + a) / (2 - a);                     // ARD = |dup - orig| / mean  =>  dup = orig * (2 + a) / (2 - a) at the limit
  const dCard = chartCard({ root: root.querySelector('#q-dup'), title: 'Duplikat — original vs duplicate Ni (%)',
    sub: `Garis tengah = kesetaraan (y = x); garis putus-putus = batas selisih relatif (${lims.map(v => nid(v * 100) + '%').join(' / ') || '-'}).`,
    head: ['Lab report', 'Duplikat', 'Tipe', 'Ni asli (%)', 'Ni duplikat (%)', 'Selisih relatif (%)', 'Batas (%)', 'Status'],
    rows: dd.map(x => [x.batch || '', x.sample_no, x.type, nid(x.orig_ni, 3), nid(x.dup_ni, 3), nid(x.ard * 100, 1), nid(x.max * 100), STAT_ID[x.status] || x.status]),
    make: cv => { const o = scatterOptions('Original (% Ni)', 'Duplicate (% Ni)', c => `${c.raw.n} (${c.raw.t}): asli ${nid(c.raw.x, 3)}, duplikat ${nid(c.raw.y, 3)}, selisih ${nid(c.raw.a * 100, 1)}% (batas ${nid(c.raw.m * 100)}%)`);
      o.scales.x.max = o.scales.y.max = mx; o.scales.x.ticks = { ...o.scales.x.ticks, callback: v => nid(v, 1).replace(/,0$/, '') }; o.scales.y.ticks.callback = o.scales.x.ticks.callback;
      const line = (k, color, dash, lab) => guide(lab, [{ x: 0, y: 0 }, { x: mx, y: mx * k }], color, dash);
      return new Chart(cv, { type: 'scatter', data: { datasets: [dot('Lolos', SERIES[0], dPt('pass')), dot('Gagal', COLOR.fail, dPt('fail')), line(1, COLOR.ink, [], 'y=x'),
        ...lims.flatMap(a => [line(slope(a), COLOR.fail, [5, 4], 'atas ' + a), line(1 / slope(a), COLOR.fail, [5, 4], 'bawah ' + a)])] }, options: o }); } });
  dCard.querySelector('.chart-box')?.classList.add('tall');
}
