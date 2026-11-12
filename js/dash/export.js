// Dashboard export: an Excel workbook with the numbers behind every chart, and a PDF summary with the charts.
// Both follow the current filters. The workbook is built by pure functions (testable in Node); the PDF draws the charts
// the page itself renders, in the light theme, off screen, so a dark-theme user still gets a readable print.
import * as C from './calc.js';
import { buildWorkbook } from '../lab/xlsxw.js';

const H = t => ({ v: t, s: 'hdr' });
const num = (v, s = 'n0') => (v === null || v === undefined || Number.isNaN(v) ? '' : { v, s });
const T1 = t => [{ v: t, s: 'title' }];
const NOTE = t => [{ v: t, s: 'note' }];
const BAND = t => [{ v: t, s: 'band' }];
const widths = (first, n, w = 14) => [first, ...Array(n).fill(w)];

export function scopeText(d, f, hub) {
  const sites = f.sites ? [...f.sites].join(', ') : (hub ? 'all sites' : [...new Set(d.collar.map(c => c.site_code))].join(', '));
  return `${sites}; ${f.prospect ? 'prospect ' + f.prospect : 'all prospects'}${f.rig ? '; rig ' + C.rigName(d, [...(f.sites || [])][0] || d.collar[0]?.site_code, f.rig) : ''}`;
}

export function buildDashWorkbook(d, f, { period = 'daily', hub = false, today = C.todayIso() } = {}) {
  const sheets = [];
  const mtd = C.monthToDate(d, f);
  const sp = C.samplesByProspect(d, f);
  const sum = k => sp.reduce((t, x) => t + (x[k] || 0), 0);
  const cc = C.collarClassCounts(d, f);

  const rows = [T1('Exploration Dashboard'), NOTE(`Scope: ${scopeText(d, f, hub)}. Generated ${today}. Period for the progress sheet: ${C.PERIODS[period].label}.`), []];
  rows.push(BAND('Month to date'));
  if (mtd) rows.push(['Month', mtd.month], ['Meters drilled', num(mtd.meters, 'n2')], ['Plan (m)', mtd.plan ? num(mtd.plan, 'n2') : ''], ['Achievement (%)', mtd.pct == null ? '' : num(mtd.pct, 'n2')], ['Holes drilled', num(mtd.holes)]);
  else rows.push(['No drilling progress yet']);
  rows.push([], BAND('Samples'), ['Pending', num(sum('PENDING'))], ['Sent', num(sum('SENT'))], ['Analyzed', num(sum('ANALYZED'))]);
  rows.push([], BAND('Collars'), ['Planned', num(cc.counts.planned)], ['EOH', num(cc.counts.eoh)], ['COH', num(cc.counts.coh)], ['With coordinates', num(cc.mapped)], ['Total', num(cc.total)]);
  if (!hub && d.assay) {
    const fl = C.qaqcFlow(d, f, today).totals, ck = C.qaqcChecks(d, f);
    rows.push([], BAND('QAQC (all prospects for the first four lines)'), ['Sampel terkirim', num(fl.sent)], ['ROA belum diinput', num(fl.roaPending)], ['Excel QAQC tertunda', num(fl.qaqcPending)], ['Insertion rate QC (%)', fl.rate == null ? '' : num(fl.rate, 'n2')],
      ['Blank gagal / dicek', `${ck.fail.blank} / ${ck.blanks.length}`], ['CRM gagal / dicek', `${ck.fail.crm} / ${ck.crms.length}`], ['Duplikat gagal / dicek', `${ck.fail.dup} / ${ck.dups.length}`]);
  }
  sheets.push({ name: 'Summary', rows, widths: [26, 30], tab: 'FF1F3A5F' });

  const pb = C.progressBuckets(d, f, period);
  sheets.push({ name: 'Progress', freeze: [1, 1], widths: widths(14, pb.rigs.length + 2), tab: 'FF2563EB',
    rows: [[H('Period'), ...pb.rigs.map(r => H(r.name + ' (m)')), H('Total (m)'), H('Plan (m)')],
      ...pb.rows.map(r => [C.bucketLabel(period, r.b), ...pb.rigs.map(g => num(Math.round(r.rig[g.id] * 10) / 10, 'n2')), num(Math.round(r.total * 10) / 10, 'n2'), r.plan ? num(Math.round(r.plan * 10) / 10, 'n2') : ''])] });

  const hb = C.hoursByRig(d, f);
  sheets.push({ name: 'Hours', freeze: [1, 1], widths: widths(18, hb.acts.length + 1), tab: 'FFD97706',
    rows: [[H('Rig'), ...hb.acts.map(a => H(a.label + ' (h)')), H('Total (h)')],
      ...hb.rigs.map(r => [r.name, ...hb.acts.map(a => num(Math.round((r.h[a.code] || 0) * 10) / 10, 'n2')), num(Math.round(Object.values(r.h).reduce((t, x) => t + x, 0) * 10) / 10, 'n2')])] });

  sheets.push({ name: 'Samples', freeze: [1, 1], widths: [18, 12, 12, 12], tab: 'FF0D9488',
    rows: [[H('Prospect'), H('Pending'), H('Sent'), H('Analyzed')], ...sp.map(x => [x.prospect, num(x.PENDING), num(x.SENT), num(x.ANALYZED)])] });

  const pts = C.collarPoints(d, f);
  sheets.push({ name: 'Collars', freeze: [1, 2], widths: [8, 20, 14, 14, 12, 12, 12, 12, 12, 10], tab: 'FF16A34A',
    rows: [[H('Site'), H('Hole'), H('Prospect'), H('Status'), H('Class'), H('Latitude'), H('Longitude'), H('Position'), H('Depth (m)')],
      ...pts.map(p => [p.site, p.hole, p.prospect, p.statusLabel || p.status, p.cls.toUpperCase(), num(p.lat, 'n4'), num(p.lon, 'n4'), p.basis, num(p.depth, 'n2')])] });

  if (!hub && d.assay) {
    const fl = C.qaqcFlow(d, f, today);
    sheets.push({ name: 'QAQC_Flow', freeze: [1, 1], widths: [14, 12, 14, 18], tab: 'FF9333EA',
      rows: [[H('Date'), H('Terkirim'), H('ROA diinput'), H('Excel QAQC selesai')], ...fl.labels.map((x, i) => [x, num(fl.sent[i]), num(fl.roa[i]), num(fl.qaqc[i])]).filter(r => r[1].v || r[2].v || r[3].v)] });
    const ck = C.qaqcChecks(d, f), ST = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' };
    const qrows = [[H('Check'), H('Lab report'), H('Sample'), H('Value / orig Ni (%)'), H('Dup Ni (%)'), H('ARD / Z'), H('Limit'), H('Status')]];
    for (const b of ck.blanks) qrows.push(['Blank', b.batch || '', b.sample_no, num(b.ni, 'n3'), '', '', num(b.limit, 'n3'), ST[b.status]]);
    for (const c of ck.crms) qrows.push(['CRM Ni', c.batch || '', c.sample_no, num(c.measured, 'n3'), '', num(c.z, 'n2'), `±${ck.T.crm_z_fail} SD`, ST[c.status]]);
    for (const x of ck.dups) qrows.push([`Duplicate ${x.type}`, x.batch || '', x.sample_no, num(x.orig_ni, 'n3'), num(x.dup_ni, 'n3'), num(x.ard, 'pct'), num(x.max, 'pct'), ST[x.status]]);
    sheets.push({ name: 'QAQC_Checks', freeze: [1, 0], widths: [16, 14, 18, 16, 12, 12, 12, 10], tab: 'FFDC2626', rows: qrows, cf: [{ sqref: `H2:H${qrows.length + 1}`, fail: ['FAIL'], warn: ['WARN'], pass: ['PASS'] }] });
  }
  return buildWorkbook(sheets);
}

// ---- PDF ------------------------------------------------------------------------------------------
let jspdfLoading = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
  if (jspdfLoading) return jspdfLoading;
  jspdfLoading = new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'js/vendor/jspdf.umd.min.js';
    sc.onload = () => res(window.jspdf.jsPDF); sc.onerror = () => { jspdfLoading = null; rej(new Error('The PDF library could not be loaded.')); };
    document.head.appendChild(sc);
  });
  return jspdfLoading;
}

// renders the page off screen in the light theme and collects it as plain sections: KPI cards, chart images, tables
function capture(d, f, state, renderPage, destroyCharts) {
  const off = document.createElement('div');
  off.className = 'dash'; off.style.cssText = 'position:fixed;left:-12000px;top:0;width:1100px';
  document.body.appendChild(off);
  const html = document.documentElement, prev = html.getAttribute('data-theme');
  html.setAttribute('data-theme', 'light'); destroyCharts();
  const out = [];
  try {
    renderPage(off, d, f, { ...state, noMap: true });
    for (const sec of off.querySelectorAll('.ex-sec')) {
      if (sec.querySelector('.dmap')) continue;
      const o = { title: sec.querySelector('h2')?.textContent || '', note: sec.querySelector('.ex-note')?.textContent || '', items: [] };
      for (const el of sec.querySelectorAll('.ex-card, .card, .ex-chartcard')) {
        if (el.classList.contains('ex-card')) { if (!el.closest('.card')) o.items.push({ kpi: { k: el.querySelector('.k')?.textContent, v: el.querySelector('.v')?.textContent, s: el.querySelector('.s')?.textContent } }); continue; }
        const cv = el.querySelector('canvas'), tb = el.querySelector('table');
        const title = el.querySelector('h3')?.textContent || '';
        if (cv) o.items.push({ img: cv.toDataURL('image/png'), w: cv.width, h: cv.height, title });
        else if (tb) o.items.push({ title, table: [...tb.rows].map(r => [...r.cells].map(c => c.textContent.trim())) });
      }
      out.push(o);
    }
  } finally {
    if (prev === null) html.removeAttribute('data-theme'); else html.setAttribute('data-theme', prev);
    destroyCharts(); off.remove();
  }
  return out;
}

export async function buildDashPdf(d, f, state, { title = 'Exploration Dashboard', today = C.todayIso() } = {}) {
  const JsPDF = await loadJsPdf();
  const [{ renderPage }, { destroyCharts }] = await Promise.all([import('./page.js'), import('./ui.js')]);   // browser-only modules, loaded here so the workbook builder runs in Node
  const secs = capture(d, f, state, renderPage, destroyCharts);
  const pdf = new JsPDF({ unit: 'mm', format: 'a4' });
  const PW = 210, PH = 297, M = 14, CW = PW - 2 * M;
  let y = M;
  const need = h => { if (y + h > PH - M) { pdf.addPage(); y = M; } };
  const text = (t, size, bold, color = 20) => { pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(size); pdf.setTextColor(color); };
  text(0, 18, true); pdf.text(title, M, y + 6); y += 11;
  text(0, 9, false, 100); for (const l of pdf.splitTextToSize(`${scopeText(d, f, state.hub)}. Generated ${today}.`, CW)) { pdf.text(l, M, y + 3); y += 4.5; }
  y += 3;
  for (const s of secs) {
    need(24); text(0, 13, true); pdf.text(s.title, M, y + 5); y += 8;
    if (s.note) { text(0, 8, false, 110); for (const l of pdf.splitTextToSize(s.note, CW)) { need(5); pdf.text(l, M, y + 3); y += 4; } y += 2; }
    const kp = s.items.filter(i => i.kpi);
    if (kp.length) {
      const cols = Math.min(4, kp.length), w = (CW - (cols - 1) * 3) / cols;
      kp.forEach((i, n) => {
        const c = n % cols, r = Math.floor(n / cols), x = M + c * (w + 3), top = y + r * 22;
        if (c === 0) need(22);
        pdf.setDrawColor(210); pdf.roundedRect(x, top, w, 19, 2, 2);
        text(0, 7.5, false, 110); pdf.text(pdf.splitTextToSize(i.kpi.k || '', w - 4)[0] || '', x + 2.5, top + 5);
        text(0, 13, true); pdf.text(String(i.kpi.v || '').replace(/\s+/g, ' ').slice(0, 22), x + 2.5, top + 11.5);
        text(0, 6.5, false, 120); pdf.text(pdf.splitTextToSize(i.kpi.s || '', w - 4)[0] || '', x + 2.5, top + 16.5);
      });
      y += Math.ceil(kp.length / cols) * 22 + 2;
    }
    for (const i of s.items.filter(x => !x.kpi)) {
      if (i.img) {
        const h = Math.min(CW * i.h / i.w, 95);
        need(h + 9); text(0, 10, true); pdf.text(i.title, M, y + 4); y += 6;
        pdf.addImage(i.img, 'PNG', M, y, h * i.w / i.h, h); y += h + 5;
      } else if (i.table?.length) {
        need(14); text(0, 10, true); pdf.text(i.title, M, y + 4); y += 7;
        const cols = i.table[0].length, cw = [CW * 0.2, ...Array(cols - 1).fill((CW * 0.8) / (cols - 1))];
        i.table.slice(0, 40).forEach((r, ri) => {
          need(6); text(0, 7, ri === 0, ri === 0 ? 20 : 40);
          if (ri === 0) { pdf.setFillColor(238, 242, 247); pdf.rect(M, y, CW, 5.2, 'F'); }
          let x = M; r.forEach((c, ci) => { pdf.text(String(c).slice(0, 18), ci === 0 ? x + 1 : x + cw[ci] - 1, y + 3.7, { align: ci === 0 ? 'left' : 'right' }); x += cw[ci]; });
          y += 5.2;
        });
        y += 4;
      }
    }
    y += 4;
  }
  const n = pdf.getNumberOfPages();
  for (let p = 1; p <= n; p++) { pdf.setPage(p); text(0, 7, false, 130); pdf.text(`${title} - page ${p} of ${n}`, M, PH - 7); }
  return pdf;
}
