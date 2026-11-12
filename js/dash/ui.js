// Small UI helpers: escaping, number formats, KPI tiles, chart cards with a table view.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const nf = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
// Indonesian number format (8.782 and 8,0%), used by the QAQC section whose labels are Indonesian
export const nid = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const pct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '-' : nf(v, d) + '%');

export const kpi = (label, value, sub = '') =>
  `<div class="kpi"><div class="l">${esc(label)}</div><div class="v">${value}</div><div class="s">${esc(sub)}</div></div>`;

// chart colours come from the design tokens (--chart-N), so they follow light/dark. syncChartColors() runs before every render.
const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const COLOR = { actual: '', plan: '', grid: '', ink: '', surface: '', ok: '', warn: '', fail: '', tip: '', tipInk: '' };
export const SERIES = [];                                  // categorical order, fixed, never cycled (see docs/DESIGN_SYSTEM.md)
export const GAP = { borderColor: '', borderWidth: 1 };    // surface-coloured gap between stacked fills
export function syncChartColors() {
  Object.assign(COLOR, { actual: cv('--chart-1'), plan: cv('--chart-plan'), grid: cv('--chart-grid'), ink: cv('--chart-text'), surface: cv('--card'),
    ok: cv('--chart-1'), warn: cv('--chart-2'), fail: cv('--destructive'), tip: cv('--foreground'), tipInk: cv('--background') });
  SERIES.splice(0, SERIES.length, ...[1, 2, 3, 4, 5, 6].map(i => cv('--chart-' + i)));
  GAP.borderColor = COLOR.surface;
  if (typeof barStyle !== 'undefined') { barStyle.backgroundColor = COLOR.actual; hBarStyle.backgroundColor = COLOR.actual; }
}

let charts = [];
export function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; syncChartColors(); }

// card with a chart (canvas) and a Table toggle so values are never colour/hover only
let seq = 0;
export function chartCard({ title, sub = '', w = '', head = [], rows = [], make, root }) {
  const id = 'c' + (++seq);
  const el = document.createElement('div');
  el.className = 'card ' + w;
  const hasData = rows.length > 0;
  el.innerHTML = `<div class="card-head"><div><h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p></div>
      ${hasData ? '<button class="btn small" data-t>Table</button>' : ''}</div>
    ${hasData ? `<div class="chart-box"><canvas id="${id}" role="img" aria-label="${esc(title)}"></canvas></div>
      <div class="tbl hidden tw"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">No data for this selection</div>'}`;
  root.appendChild(el);
  if (hasData) {
    const chart = make(el.querySelector('canvas'));
    charts.push(chart);
    const btn = el.querySelector('[data-t]');
    btn.onclick = () => {
      const showT = el.querySelector('.tbl').classList.toggle('hidden') === false;
      el.querySelector('.chart-box').classList.toggle('hidden', showT);
      btn.textContent = showT ? 'Chart' : 'Table';
    };
  }
  return el;
}

// shared Chart.js defaults: thin marks, rounded data ends, recessive grid, no legend for a single series
export function baseOptions({ horizontal = false, legend = false, yTitle = '', stacked = false } = {}) {
  const grid = { color: COLOR.grid, drawTicks: false };
  const tick = { color: COLOR.ink, font: { size: 11 } };
  const valueAxis = { beginAtZero: true, grid, border: { display: false }, ticks: tick, title: yTitle ? { display: true, text: yTitle, color: COLOR.ink } : undefined, stacked };
  const catAxis = { grid: { display: false }, ticks: { ...tick, maxRotation: 0, autoSkipPadding: 12 }, stacked };
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: horizontal ? 'nearest' : 'index', intersect: false },
    plugins: { legend: { display: legend, position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, color: COLOR.ink, font: { size: 11 } } },
               tooltip: { backgroundColor: COLOR.tip, titleColor: COLOR.tipInk, bodyColor: COLOR.tipInk, padding: 8, cornerRadius: 8 } },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}
export const barStyle = { borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', maxBarThickness: 28, backgroundColor: COLOR.actual };
export const hBarStyle = { borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'left', maxBarThickness: 18, backgroundColor: COLOR.actual };

syncChartColors();
