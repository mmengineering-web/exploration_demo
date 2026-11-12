// Collapsible record table: search bar + one filter per column + sortable headers + "show more".
// Used by every list in the app (sample register, Distribution Hour / Progress / Collar record lists, Data Records).
// The shell is drawn once; typing in a filter only redraws the rows, so the cursor stays in the box.
//
// recordList(host, {
//   id,            // key: search / filters / sort / open state survive a redraw of the page
//   title, rows,
//   cols: [{ k, label, type: 'text'|'enum'|'num'|'date', get(r) -> raw value, show?(r) -> text, html?(r) -> markup (not searched), lab?(v) -> label of an enum value, cls? }],
//   sort: { k, dir: 1|-1 },  open: true|false (first time only),
//   onOpen?(row), canOpen?(row),         // row click
//   select?: { set: Set, id(r), onChange() },   // adds a checkbox column
//   note?: html shown under the toolbar,
// }) -> { shown(), rows(next), redraw() }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATE = new Map();
const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);

export function recordList(host, o) {
  let rows = o.rows || [];
  const cols = o.cols;
  const st = STATE.get(o.id) || { q: '', f: {}, sort: o.sort || null, open: o.open !== false, limit: 100 };
  STATE.set(o.id, st);

  const text = (c, r) => { const v = c.show ? c.show(r) : (c.type === 'enum' && c.lab ? c.lab(c.get(r)) : c.get(r)); return v == null ? '' : String(v); };
  const cmp = (a, b) => {
    if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  };
  const enumOpts = c => [...new Set(rows.map(r => c.get(r)).filter(v => v != null && v !== ''))].sort(cmp).map(v => ({ v: String(v), t: c.lab ? c.lab(v) : String(v) }));

  const filtered = () => {
    const toks = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    const act = cols.filter(c => { const f = st.f[c.k]; return f && Object.values(f).some(v => v !== '' && v != null); });
    let out = rows.filter(r => {
      if (toks.length) { const h = cols.map(c => text(c, r)).join(' ').toLowerCase(); if (!toks.every(t => h.includes(t))) return false; }
      for (const c of act) {
        const f = st.f[c.k], v = c.get(r);
        if (c.type === 'enum') { if (f.v !== '' && String(v ?? '') !== f.v) return false; }
        else if (c.type === 'num') { const n = num(v); if (f.min !== '' && f.min != null && !(n != null && n >= Number(f.min))) return false; if (f.max !== '' && f.max != null && !(n != null && n <= Number(f.max))) return false; }
        else if (c.type === 'date') { const d = v ? String(v).slice(0, 10) : ''; if (f.from && !(d && d >= f.from)) return false; if (f.to && !(d && d <= f.to)) return false; }
        else if (f.v && !text(c, r).toLowerCase().includes(String(f.v).toLowerCase())) return false;
      }
      return true;
    });
    if (st.sort) { const c = cols.find(x => x.k === st.sort.k); if (c) out = out.map((r, i) => [r, i]).sort((a, b) => st.sort.dir * cmp(c.get(a[0]), c.get(b[0])) || a[1] - b[1]).map(x => x[0]); }
    return out;
  };

  const fval = (k, p) => esc(st.f[k]?.[p] ?? '');
  const filterCell = c => {
    if (c.type === 'enum') return `<th><select data-f="${esc(c.k)}" data-p="v" aria-label="Filter ${esc(c.label)}"><option value="">Semua</option>${(() => { const op = enumOpts(c), cv = st.f[c.k]?.v; if (cv && !op.some(x => x.v === cv)) op.push({ v: cv, t: c.lab ? c.lab(cv) : cv }); return op; })().map(x => `<option value="${esc(x.v)}" ${st.f[c.k]?.v === x.v ? 'selected' : ''}>${esc(x.t)}</option>`).join('')}</select></th>`;
    if (c.type === 'num') return `<th><div class="rng"><input data-f="${esc(c.k)}" data-p="min" type="number" step="any" placeholder="min" value="${fval(c.k, 'min')}" aria-label="${esc(c.label)} minimum"><input data-f="${esc(c.k)}" data-p="max" type="number" step="any" placeholder="max" value="${fval(c.k, 'max')}" aria-label="${esc(c.label)} maksimum"></div></th>`;
    if (c.type === 'date') return `<th><div class="rng"><input data-f="${esc(c.k)}" data-p="from" type="date" value="${fval(c.k, 'from')}" aria-label="${esc(c.label)} dari"><input data-f="${esc(c.k)}" data-p="to" type="date" value="${fval(c.k, 'to')}" aria-label="${esc(c.label)} sampai"></div></th>`;
    return `<th><input data-f="${esc(c.k)}" data-p="v" type="search" placeholder="cari" value="${fval(c.k, 'v')}" aria-label="Filter ${esc(c.label)}"></th>`;
  };
  const arrow = c => st.sort?.k === c.k ? (st.sort.dir > 0 ? ' ▲' : ' ▼') : '';

  host.innerHTML = `
  <details class="card reclist" ${st.open ? 'open' : ''}>
    <summary><h2>${esc(o.title)} <span class="cnt"></span></h2><span class="chev" aria-hidden="true"></span></summary>
    <div class="rl-bar"><input type="search" class="rl-q" placeholder="Cari di ${esc(o.title)}…" value="${esc(st.q)}" autocomplete="off">
      <button class="btn small rl-reset" type="button">Reset filter</button></div>
    ${o.note ? `<div class="muted small rl-note">${o.note}</div>` : ''}
    <div class="gridwrap rl-wrap"><table class="grid rec"><thead>
      <tr class="hr">${o.select ? '<th class="c-sel"><input type="checkbox" class="rl-all" aria-label="Pilih semua yang tampil"></th>' : ''}${cols.map(c => `<th data-s="${esc(c.k)}" class="sortable">${esc(c.label)}<span class="ar">${arrow(c)}</span></th>`).join('')}</tr>
      <tr class="fr">${o.select ? '<th></th>' : ''}${cols.map(filterCell).join('')}</tr>
    </thead><tbody></tbody></table></div>
    <div class="rl-foot muted small"></div>
  </details>`;
  const $ = s => host.querySelector(s);
  const tbody = $('tbody');
  let cur = [];

  const rowHtml = (r, i) => {
    const sel = o.select ? `<td class="c-sel"><input type="checkbox" data-sel="${i}" ${o.select.set.has(o.select.id(r)) ? 'checked' : ''}></td>` : '';
    const open = o.onOpen && (!o.canOpen || o.canOpen(r));
    return `<tr data-i="${i}" class="${open ? 'clk' : ''}">${sel}${cols.map(c => `<td class="${esc(c.cls || (c.type === 'num' ? 'c-num' : ''))}">${c.html ? c.html(r) : esc(text(c, r))}</td>`).join('')}</tr>`;
  };
  const syncAll = () => { const a = $('.rl-all'); if (a) { const n = cur.filter(r => o.select.set.has(o.select.id(r))).length; a.checked = cur.length > 0 && n === cur.length; a.indeterminate = n > 0 && n < cur.length; } };
  const draw = () => {
    cur = filtered();
    const shownRows = cur.slice(0, st.limit);
    tbody.innerHTML = shownRows.map((r, i) => rowHtml(r, i)).join('') || `<tr><td colspan="${cols.length + (o.select ? 1 : 0)}" class="muted">${rows.length ? 'Tidak ada data yang cocok dengan filter.' : 'Belum ada data.'}</td></tr>`;
    $('.cnt').textContent = `(${cur.length === rows.length ? rows.length : cur.length + ' dari ' + rows.length})`;
    $('.rl-foot').innerHTML = cur.length > st.limit ? `${st.limit} dari ${cur.length} baris tampil. <button class="btn small" type="button" data-more>Tampilkan lebih banyak</button>` : (o.open_foot ? '' : (cur.length && o.onOpen ? 'Ketuk baris untuk membuka.' : ''));
    if (o.select) syncAll();
  };

  host.querySelector('details').addEventListener('toggle', e => { st.open = e.target.open; });
  let tm = null;
  const reDraw = () => { st.limit = 100; clearTimeout(tm); tm = setTimeout(draw, 120); };
  $('.rl-q').addEventListener('input', e => { st.q = e.target.value; reDraw(); });
  $('.rl-reset').addEventListener('click', () => {
    st.q = ''; st.f = {}; $('.rl-q').value = ''; host.querySelectorAll('[data-f]').forEach(el => { el.value = ''; }); st.limit = 100; draw();
  });
  const onF = e => { const el = e.target.closest('[data-f]'); if (!el) return; (st.f[el.dataset.f] ||= {})[el.dataset.p] = el.value; reDraw(); };
  $('thead').addEventListener('input', onF); $('thead').addEventListener('change', onF);
  $('thead').addEventListener('click', e => {
    const a = e.target.closest('.rl-all');
    if (a && o.select) { cur.forEach(r => (a.checked ? o.select.set.add(o.select.id(r)) : o.select.set.delete(o.select.id(r)))); draw(); o.select.onChange?.(); return; }
    const th = e.target.closest('th[data-s]'); if (!th) return;
    const k = th.dataset.s; st.sort = st.sort?.k === k ? { k, dir: -st.sort.dir } : { k, dir: 1 };
    host.querySelectorAll('th[data-s]').forEach(x => { x.querySelector('.ar').textContent = x.dataset.s === st.sort.k ? (st.sort.dir > 0 ? ' ▲' : ' ▼') : ''; });
    draw();
  });
  host.addEventListener('click', e => {
    if (e.target.closest('[data-more]')) { st.limit += 200; draw(); return; }
    const cb = e.target.closest('[data-sel]');
    if (cb && o.select) { const r = cur[+cb.dataset.sel]; cb.checked ? o.select.set.add(o.select.id(r)) : o.select.set.delete(o.select.id(r)); syncAll(); o.select.onChange?.(); return; }
    const tr = e.target.closest('tbody tr[data-i]'); if (!tr || !o.onOpen || e.target.closest('input,select,button,a')) return;
    const r = cur[+tr.dataset.i]; if (r && (!o.canOpen || o.canOpen(r))) o.onOpen(r);
  });
  draw();
  return { shown: () => cur, rows: next => { rows = next; draw(); }, redraw: draw };
}
