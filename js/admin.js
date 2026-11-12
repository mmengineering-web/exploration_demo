// "Pengaturan" tab: reference data with explanations (rig, prospect, code lists, parameters, users, roles).
// Permission levels (the server enforces the same rules with RLS; the UI just matches them):
//   view only   : everyone with an active role. Plain table, nothing editable.
//   site admin  : (can_admin) edit cells in place, add rows, deactivate. No delete.
//   super admin : (can_super) everything above + permanent delete of master data,
//                 add / delete / reset-password of users (through the Edge Function exp-admin-users),
//                 and manage super roles.
import * as S from './sync.js';
import * as ui from './ui.js';
import { LIST_DEFS, SETTING_DEFS, DEFAULTS } from './config.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SUBS = [['rigs', 'Rig'], ['prospects', 'Prospect'], ['lists', 'Daftar kode'], ['settings', 'Parameter'], ['users', 'User', true], ['roles', 'Role']]; // 3rd = admin only
let sub = 'rigs';
let listSel = 'hole_type';

export async function viewAdmin(root, toast) {
  const info = S.getInfo() || {};
  const canEdit = !!info.can_admin;
  const canSuper = !!info.can_super;
  const subs = SUBS.filter(s => canEdit || !s[2]);
  if (!subs.some(s => s[0] === sub)) sub = 'rigs';
  const offline = !navigator.onLine;
  const badge = canSuper ? '<span class="chip super">super admin</span>' : canEdit ? '<span class="chip good">bisa edit</span>' : '<span class="chip">view only</span>';
  root.innerHTML = `
  <div class="card">
    <div class="kethead"><h2>Pengaturan</h2>${badge}</div>
    <p class="muted small" style="margin:0 0 10px">Arti setiap kode, rig, prospect, dan role yang dipakai di aplikasi ini.</p>
    ${offline ? '<div class="msg warn">Menu ini butuh internet untuk dibuka. Perubahan langsung tersimpan di server site.</div>' : ''}
    <div class="subnav">${subs.map(([k, l]) => `<button data-s="${k}" class="${k === sub ? 'on' : ''}">${l}</button>`).join('')}</div>
  </div><div id="adm"></div>`;
  root.querySelectorAll('.subnav button').forEach(b => b.onclick = () => { sub = b.dataset.s; viewAdmin(root, toast); });
  if (offline) return;
  const box = root.querySelector('#adm');
  const reload = () => viewAdmin(root, toast);
  const ctx = { box, c: S.getClient(), toast, reload, canEdit, canSuper, info };
  try { await ({ rigs: secRigs, prospects: secProspects, lists: secLists, settings: secSettings, users: secUsers, roles: secRoles }[sub])(ctx); }
  catch (e) { box.innerHTML = `<div class="msg err">${esc(e.message || e)}</div>`; }
}

/* ---------- spreadsheet-like grid editor ---------- */
const getv = (row, k) => k.startsWith('meta.') ? (row.meta || {})[k.slice(5)] : k.startsWith('f.') ? (row._f || {})[k.slice(2)] : row[k];
// column dependency: c.dep = { k: 'role', test: v => bool } -> the cell is only active when the test passes for that field of the row

// opts: title, note, help(html), rows, cols[{k,label,type,pk,wide,hint,allOptions}], blank, save(row,isNew), reload, toast,
//       canEdit, locked(row)->bool, actions[{id,label,danger,show(row),confirm(row),run(row),ok}],
//       reorder(orderedRows) -> shows a drag handle column (admins) and saves the new order after a drop
const GRIP = '<svg width="14" height="20" viewBox="0 0 14 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="1.7"/><circle cx="10" cy="4" r="1.7"/><circle cx="4" cy="10" r="1.7"/><circle cx="10" cy="10" r="1.7"/><circle cx="4" cy="16" r="1.7"/><circle cx="10" cy="16" r="1.7"/></svg>';

function editor(box, { title, note, help, rows, cols, blank, save, reload, toast, canEdit, locked = () => false, actions = [], reorder = null }) {
  const dragOn = !!(canEdit && reorder);
  const cell = (c, row, isNew, ro) => {
    const val = getv(row, c.k);
    const k = esc(c.k);
    const off = c.dep && !c.dep.test(row[c.dep.k]);
    if (ro) { // read-only: plain text, no inputs
      if (off) return '<td class="c-bool muted">–</td>';
      if (c.type === 'bool') return `<td class="c-bool">${val ? '✓' : '–'}</td>`;
      if (c.type === 'select') return `<td>${esc(((c.allOptions || c.options).find(o => o.v === val) || {}).t ?? val ?? '')}</td>`;
      const cls = [c.type === 'number' ? 'c-num' : '', c.k === 'description' ? 'c-desc' : '', c.pk ? 'c-pk' : ''].filter(Boolean).join(' ');
      return `<td class="${cls}">${esc(val ?? '')}</td>`;
    }
    if (c.type === 'bool') return `<td class="c-bool"><input type="checkbox" data-k="${k}" data-o="${val ? 1 : 0}" ${c.dep ? `data-dep="${esc(c.dep.k)}"` : ''} ${val ? 'checked' : ''} ${off ? 'disabled' : ''}></td>`;
    if (c.type === 'select') return `<td><select data-k="${k}" data-o="${esc(val ?? '')}">${c.options.map(o => `<option value="${esc(o.v)}" ${o.v === val ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select></td>`;
    const lock = c.pk && !isNew;
    const cls = [c.type === 'number' ? 'c-num' : '', c.wide ? 'c-wide' : '', lock ? 'c-pk' : ''].filter(Boolean).join(' ');
    return `<td class="${cls}"><input data-k="${k}" data-o="${esc(val ?? '')}" type="${c.type === 'number' ? 'number' : 'text'}" ${c.type === 'number' ? 'step="any"' : ''} value="${esc(val ?? '')}" ${lock ? 'readonly tabindex="-1"' : ''} ${c.wide ? 'placeholder="Jelaskan artinya…"' : ''}></td>`;
  };
  const head = `<tr><th class="c-n">#</th>${dragOn ? '<th class="c-drag" title="Seret untuk mengubah urutan"></th>' : ''}${cols.map(c => `<th>${esc(c.label)}${c.hint ? ` <span class="hint" title="${esc(c.hint)}">?</span>` : ''}</th>`).join('')}${canEdit ? '<th class="c-act"></th>' : ''}</tr>`;
  const actBtns = row => actions.filter(a => !a.show || a.show(row)).map(a => `<button class="btn small ${a.danger ? 'danger' : ''}" data-act="${esc(a.id)}">${esc(a.label)}</button>`).join('');
  const bodyRows = rows.map((r, i) => {
    const lk = !canEdit || locked(r);
    const act = canEdit ? `<td class="c-act">${lk ? '' : '<button class="btn small" data-save>Simpan</button>'}${actBtns(r)}</td>` : '';
    const dg = dragOn ? `<td class="c-drag">${lk ? '' : `<span class="drag" tabindex="0" role="button" title="Seret untuk mengubah urutan (atau fokus lalu tekan ↑ ↓)" aria-label="Ubah urutan">${GRIP}</span>`}</td>` : '';
    return `<tr data-i="${i}" class="${canEdit && lk ? 'locked' : ''}"><td class="c-n">${i + 1}</td>${dg}${cols.map(c => cell(c, r, false, lk)).join('')}${act}</tr>`;
  }).join('');
  const newRow = canEdit ? `<tr class="newrow" data-i="-1"><td class="c-n">+</td>${dragOn ? '<td class="c-drag"></td>' : ''}${cols.map(c => cell(c, blank, true, false)).join('')}<td class="c-act"><button class="btn small primary" data-add>Tambah</button></td></tr>` : '';

  box.innerHTML = `
    <div class="card">
      <div class="gridbar"><h3>${esc(title)} (${rows.length})</h3>
        ${canEdit ? '<button class="btn small primary" id="saveall" disabled>Simpan semua perubahan</button>' : ''}</div>
      ${help ? `<div class="helpbox">${help}</div>` : ''}
      ${note ? `<p class="muted small">${note}</p>` : ''}
      ${canEdit ? '<p class="muted small">Edit langsung di tabel; baris yang berubah berwarna kuning. Enter / ↑ ↓ pindah baris, Tab pindah kolom. Baris paling bawah (+) untuk data baru.</p>' : ''}
      <div class="gridwrap"><table class="grid"><thead>${head}</thead><tbody>${bodyRows}${newRow}</tbody></table></div>
      ${rows.length || canEdit ? '' : '<p class="muted">Belum ada data.</p>'}
    </div>`;
  if (!canEdit) return;

  const tbody = box.querySelector('tbody');
  const saveAllBtn = box.querySelector('#saveall');
  const inputsOf = tr => [...tr.querySelectorAll('[data-k]')];
  const curVal = el => el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
  const isDirty = tr => inputsOf(tr).some(el => curVal(el) !== String(el.dataset.o));
  const refreshDirty = () => {
    let n = 0;
    tbody.querySelectorAll('tr:not(.newrow):not(.locked)').forEach(tr => { const d = isDirty(tr); tr.classList.toggle('dirty', d); if (d) n++; else tr.classList.remove('err'); });
    saveAllBtn.disabled = n === 0; saveAllBtn.textContent = n ? `Simpan semua perubahan (${n})` : 'Simpan semua perubahan';
  };
  const collect = (tr, orig) => {
    const out = { ...orig }; const meta = { ...(orig.meta || {}) }; let hasMeta = false;
    for (const c of cols) {
      const el = tr.querySelector(`[data-k="${CSS.escape(c.k)}"]`);
      const v = c.type === 'bool' ? el.checked : c.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value.trim();
      if (c.k.startsWith('meta.')) { hasMeta = true; meta[c.k.slice(5)] = v; } else if (c.k.startsWith('f.')) { out._f = { ...(out._f || orig._f || {}), [c.k.slice(2)]: v }; } else out[c.k] = v;
    }
    if (hasMeta) out.meta = meta;
    return out;
  };
  const markSaved = (tr, out) => { inputsOf(tr).forEach(el => { el.dataset.o = curVal(el); }); rows[+tr.dataset.i] = out; };

  async function saveRows(trs) {
    let ok = 0, fail = 0, firstErr = '';
    for (const tr of trs) {
      const out = collect(tr, rows[+tr.dataset.i]);
      try { await save(out, false); markSaved(tr, out); tr.classList.remove('err'); tr.removeAttribute('title'); ok++; }
      catch (err) { fail++; tr.classList.add('err'); tr.title = err.message || String(err); firstErr = firstErr || `${out[cols[0].k]}: ${err.message || err}`; }
    }
    if (ok) S.syncSoon(300);
    refreshDirty();
    if (fail) toast(`${ok} tersimpan, ${fail} gagal — ${firstErr}`, 'err');
    else toast(`Tersimpan (${ok})`);
    return fail === 0;
  }

  const applyDeps = tr => {
    for (const c of cols) if (c.dep) {
      const dv = tr.querySelector(`[data-k="${CSS.escape(c.dep.k)}"]`), el = tr.querySelector(`[data-k="${CSS.escape(c.k)}"]`);
      if (dv && el) el.disabled = !c.dep.test(dv.value);
    }
  };
  tbody.addEventListener('input', refreshDirty);
  tbody.addEventListener('change', e => { const tr = e.target.closest('tr'); if (tr) applyDeps(tr); refreshDirty(); });
  tbody.addEventListener('keydown', e => {
    const el = e.target; if (!el.dataset || !el.dataset.k) return;
    const tr = el.closest('tr');
    if (e.key === 'Enter' && tr.classList.contains('newrow')) { e.preventDefault(); tr.querySelector('[data-add]').click(); return; }
    if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key) || el.tagName === 'SELECT') return;
    e.preventDefault();
    const trs = [...tbody.querySelectorAll('tr')];
    let i = trs.indexOf(tr); const step = e.key === 'ArrowUp' ? -1 : 1;
    for (i += step; trs[i]; i += step) { // skip locked rows
      const target = trs[i].querySelector(`[data-k="${CSS.escape(el.dataset.k)}"]`);
      if (target) { target.focus(); if (target.select) target.select(); break; }
    }
  });
  tbody.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const tr = b.closest('tr');
    if (b.hasAttribute('data-save')) { b.disabled = true; await saveRows([tr]); b.disabled = false; return; }
    if (b.hasAttribute('data-add')) {
      b.disabled = true;
      const out = collect(tr, blank);
      try { await save(out, true); toast('Tersimpan'); S.syncSoon(300); await reload(); }
      catch (err) { toast(err.message || String(err), 'err'); b.disabled = false; }
      return;
    }
    if (b.dataset.act) {
      const a = actions.find(x => x.id === b.dataset.act); const row = rows[+tr.dataset.i];
      const msg = a.confirm && a.confirm(row);
      if (msg && !await ui.confirm(msg, { title: 'Konfirmasi', ok: a.danger ? 'Lanjut' : 'OK', danger: !!a.danger })) return;
      b.disabled = true;
      try { const res = await a.run(row); if (res !== false) { toast(a.ok || 'Selesai'); S.syncSoon(300); await reload(); } else b.disabled = false; }
      catch (err) { toast(err.message || String(err), 'err'); b.disabled = false; }
    }
  });
  if (dragOn) {
    // ---- drag & drop reorder (pointer events: works with mouse and touch) ----
    const rowEls = () => [...tbody.querySelectorAll('tr[data-i]:not(.newrow)')];
    const renum = () => rowEls().forEach((tr, i) => { tr.querySelector('.c-n').textContent = i + 1; });
    let timer = null;
    const commit = async () => {
      const els = rowEls(); const ordered = els.map(tr => rows[+tr.dataset.i]);
      if (ordered.every((r, i) => r === rows[i])) return;
      try { await reorder(ordered); rows.splice(0, rows.length, ...ordered); els.forEach((tr, i) => { tr.dataset.i = i; }); renum(); toast('Urutan tersimpan'); S.syncSoon(300); }
      catch (err) { toast(err.message || String(err), 'err'); reload(); }
    };
    const blocked = () => { if (tbody.querySelector('tr.dirty')) { toast('Simpan perubahan di tabel dulu, baru ubah urutan.', 'err'); return true; } return false; };
    let drag = null;
    const onMove = e => {
      if (!drag) return;
      const y = e.clientY, wrap = box.querySelector('.gridwrap'), wr = wrap.getBoundingClientRect();
      if (y < wr.top + 36) wrap.scrollTop -= 14; else if (y > wr.bottom - 36) wrap.scrollTop += 14;
      for (const o of rowEls()) {
        if (o === drag) continue;
        const r = o.getBoundingClientRect(); if (y < r.top || y > r.bottom) continue;
        const below = !!(drag.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING);   // o comes after the dragged row
        if (below && y > r.top + r.height / 2) o.after(drag); else if (!below && y < r.top + r.height / 2) o.before(drag);
        renum(); break;
      }
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); if (drag) { drag.classList.remove('dragging'); drag = null; commit(); } };
    tbody.addEventListener('pointerdown', e => {
      const h = e.target.closest('.drag'); if (!h || e.button > 0) return;
      e.preventDefault(); if (blocked()) return;
      drag = h.closest('tr'); drag.classList.add('dragging');
      window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
    });
    tbody.addEventListener('keydown', e => {   // keyboard: focus the handle, press ↑ / ↓
      const h = e.target.closest && e.target.closest('.drag'); if (!h || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault(); if (blocked()) return;
      const tr = h.closest('tr'), els = rowEls(), i = els.indexOf(tr);
      if (e.key === 'ArrowUp' && i > 0) els[i - 1].before(tr); else if (e.key === 'ArrowDown' && i < els.length - 1) els[i + 1].after(tr); else return;
      renum(); h.focus(); clearTimeout(timer); timer = setTimeout(commit, 600);
    });
  }
  saveAllBtn.onclick = async () => {
    saveAllBtn.disabled = true;
    const allOk = await saveRows([...tbody.querySelectorAll('tr.dirty')]);
    if (allOk) reload();
  };
}

const need = (v, label) => { if (v == null || String(v).trim() === '') throw new Error(`${label} wajib diisi.`); };
const must = async p => { const { data, error } = await p; if (error) throw error; return data || []; };
const must1 = async p => { const { error } = await p; if (error) throw error; };
// permanent delete; RLS silently returns 0 rows when not allowed, so check the result
const mustDelete = async p => { const { data, error } = await p.select(); if (error) throw error; if (!data || !data.length) throw new Error('Tidak ada baris yang terhapus (izin ditolak?).'); };
const d = v => (v == null || String(v).trim() === '') ? null : String(v).trim();
const DESC = { k: 'description', label: 'Deskripsi', type: 'text', wide: true };

// Edge Function call (create / delete / reset password of login accounts)
async function callUserFn(c, body) {
  const { data, error } = await c.functions.invoke('exp-admin-users', { body });
  if (error) {
    let msg = error.message || 'Gagal memanggil server.';
    const st = error.context && error.context.status;
    if (st === 404) msg = 'Edge Function "exp-admin-users" belum di-deploy di project Supabase ini (lihat docs/SUPER_ADMIN_GUIDE.md).';
    else if (error.context && typeof error.context.json === 'function') { try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch { /* keep msg */ } }
    else if (/Failed to send/i.test(msg)) msg = 'Tidak bisa menghubungi Edge Function exp-admin-users (belum di-deploy, atau offline).';
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}
const randomPassword = (n = 16) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 54]).join('');

/* ---------- sections ---------- */
async function secRigs({ box, c, toast, reload, canEdit, canSuper }) {
  const rows = await must(c.from('exp_rig').select('*').order('rig_id'));
  editor(box, {
    title: 'Rig', rows, reload, toast, canEdit,
    note: 'Rig yang bisa dipilih di form Drilling Progress. Nonaktifkan rig yang sudah tidak dipakai.',
    blank: { rig_id: '', rig_name: '', rig_type: '', description: '', is_active: true },
    cols: [{ k: 'rig_id', label: 'Rig ID', type: 'text', pk: true }, { k: 'rig_name', label: 'Nama', type: 'text' },
      { k: 'rig_type', label: 'Tipe', type: 'text' }, DESC, { k: 'is_active', label: 'Aktif', type: 'bool' }],
    save: async (r, isNew) => { need(r.rig_id, 'Rig ID'); need(r.rig_name, 'Nama');
      if (isNew && rows.some(x => x.rig_id === r.rig_id)) throw new Error('Rig ID sudah ada.');
      await must1(c.from('exp_rig').upsert({ rig_id: r.rig_id, rig_name: r.rig_name, rig_type: d(r.rig_type), description: d(r.description), is_active: r.is_active }, { onConflict: 'rig_id' })); },
    actions: canSuper ? [{ id: 'del', label: 'Hapus', danger: true, ok: 'Dihapus',
      confirm: r => `Hapus rig "${r.rig_id}" secara permanen? Tidak bisa dibatalkan.`,
      run: r => mustDelete(c.from('exp_rig').delete().eq('rig_id', r.rig_id)) }] : [],
  });
}

async function secProspects({ box, c, toast, reload, canEdit, canSuper }) {
  const rows = await must(c.from('exp_prospect').select('*').order('prospect_code'));
  editor(box, {
    title: 'Prospect', rows, reload, toast, canEdit,
    note: 'Area/prospek yang bisa dipilih di form Collar (yang tampil di dropdown adalah Nama).',
    blank: { prospect_code: '', prospect_name: '', description: '', is_active: true },
    cols: [{ k: 'prospect_code', label: 'Kode', type: 'text', pk: true }, { k: 'prospect_name', label: 'Nama', type: 'text' }, DESC, { k: 'is_active', label: 'Aktif', type: 'bool' }],
    save: async (r, isNew) => { need(r.prospect_code, 'Kode'); need(r.prospect_name, 'Nama');
      if (isNew && rows.some(x => x.prospect_code === r.prospect_code)) throw new Error('Kode sudah ada.');
      await must1(c.from('exp_prospect').upsert({ prospect_code: r.prospect_code, prospect_name: r.prospect_name, description: d(r.description), is_active: r.is_active }, { onConflict: 'prospect_code' })); },
    actions: canSuper ? [{ id: 'del', label: 'Hapus', danger: true, ok: 'Dihapus',
      confirm: r => `Hapus prospect "${r.prospect_code}" secara permanen? Tidak bisa dibatalkan.`,
      run: r => mustDelete(c.from('exp_prospect').delete().eq('prospect_code', r.prospect_code)) }] : [],
  });
}

async function secLists({ box, c, toast, reload, canEdit, canSuper }) {
  const def = LIST_DEFS[listSel];
  const rows = await must(c.from('exp_code_list').select('*').eq('list_code', listSel).order('sort_order'));
  box.innerHTML = `<div class="card"><div class="subnav">${Object.entries(LIST_DEFS).map(([k, dd]) => `<button data-l="${k}" class="${k === listSel ? 'on' : ''}">${esc(dd.label)}</button>`).join('')}</div></div><div id="ed"></div>`;
  box.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { listSel = b.dataset.l; reload(); });
  const upper = ['hole_type', 'shift', 'layer'].includes(listSel);
  editor(box.querySelector('#ed'), {
    title: def.label, rows, reload, toast, canEdit,
    help: canEdit ? '<b>Urutan</b> pilihan di dropdown form = urutan baris di tabel ini. <b>Seret ikon titik-titik</b> di kiri baris ke atas/bawah untuk mengubahnya (atau fokus ikon lalu tekan ↑ ↓). Tersimpan otomatis.'
      : '<b>Urutan</b> pilihan di dropdown form = urutan baris di tabel ini (atas = muncul pertama).',
    note: listSel === 'hole_type' ? 'Kode tipe dipakai di Hole ID (mis. AG, TP). Kode tidak bisa diubah setelah dibuat; nonaktifkan bila tak dipakai lagi.' : 'Kode tidak bisa diubah setelah dibuat; nonaktifkan bila tak dipakai lagi. Dropdown hanya menampilkan Label.',
    blank: { code: '', label: '', description: '', sort_order: (rows.at(-1)?.sort_order ?? 0) + 10, is_active: true, meta: {} },
    cols: [{ k: 'code', label: 'Kode', type: 'text', pk: true }, { k: 'label', label: 'Label', type: 'text' }, DESC,
      { k: 'is_active', label: 'Aktif', type: 'bool' },
      ...def.flags.map(f => f.choices ? ({ k: 'meta.' + f.k, label: f.label, type: 'select', options: f.choices }) : ({ k: 'meta.' + f.k, label: f.label, type: 'bool' }))],
    save: async (r, isNew) => {
      need(r.code, 'Kode'); need(r.label, 'Label');
      const code = upper ? r.code.toUpperCase() : r.code;
      if (!/^[A-Za-z0-9_-]{1,30}$/.test(code)) throw new Error('Kode: huruf/angka/_/- saja (maks 30).');
      if (isNew && rows.some(x => x.code === code)) throw new Error('Kode sudah ada.');
      await must1(c.from('exp_code_list').upsert({ list_code: listSel, code, label: r.label, description: d(r.description), sort_order: r.sort_order ?? 100, is_active: r.is_active, meta: r.meta || {} }, { onConflict: 'list_code,code' }));
    },
    reorder: async ordered => {   // save new positions as 10, 20, 30, ... (only rows that moved)
      const ups = [];
      ordered.forEach((r, i) => { const n = (i + 1) * 10; if (r.sort_order !== n) { ups.push([r.code, n]); r.sort_order = n; } });
      await Promise.all(ups.map(([code, n]) => must1(c.from('exp_code_list').update({ sort_order: n }).eq('list_code', listSel).eq('code', code))));
    },
    actions: canSuper ? [{ id: 'del', label: 'Hapus', danger: true, ok: 'Dihapus',
      confirm: r => `Hapus kode "${r.code}" (${r.label}) secara permanen? Tidak bisa dibatalkan.`,
      run: r => mustDelete(c.from('exp_code_list').delete().eq('list_code', listSel).eq('code', r.code)) }] : [],
  });
}


async function secSettings({ box, c, toast, reload, canEdit }) {
  const rows = await must(c.from('exp_setting').select('key,value'));
  const cur = { ...DEFAULTS }; rows.forEach(r => { cur[r.key] = r.value; });
  const dis = canEdit ? '' : 'disabled';
  box.innerHTML = `<form class="card" id="sf"><h3>Parameter site ${canEdit ? '' : '<span class="chip">view only</span>'}</h3>
    ${SETTING_DEFS.map(dd => `<label>${esc(dd.label)}${dd.type === 'choice'
      ? `<select name="${dd.key}" ${dis}>${dd.choices.map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(cur[dd.key]) ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`
      : `<input name="${dd.key}" ${dis} type="${dd.type === 'number' ? 'number' : 'text'}" ${dd.type === 'number' ? `step="${dd.step || 'any'}" min="${dd.min}" max="${dd.max}"` : ''} value="${esc(cur[dd.key])}">`}<span class="muted small">${esc(dd.hint)}</span></label>`).join('')}
    ${canEdit ? '<div id="smsg"></div><button class="btn primary" type="submit">Simpan semua</button>' : ''}</form>`;
  if (!canEdit) return;
  box.querySelector('#sf').onsubmit = async e => {
    e.preventDefault();
    const out = [];
    try {
      for (const dd of SETTING_DEFS) {
        const raw = e.target.elements[dd.key].value.trim();
        if (dd.type === 'choice') {
          if (!dd.choices.some(o => o.v === raw)) throw new Error(`${dd.label}: pilihan tidak valid.`);
          out.push({ key: dd.key, value: raw });
        } else if (dd.type === 'number') {
          if (dd.optional && raw === '') continue;   // blank = leave the stored value alone
          const n = Number(raw);
          if (raw === '' || isNaN(n) || n < dd.min || n > dd.max || (dd.step === 1 && !Number.isInteger(n))) throw new Error(`${dd.label}: harus angka ${dd.min}–${dd.max}.`);
          out.push({ key: dd.key, value: n });
        } else {
          try { new RegExp(raw); } catch { throw new Error(`${dd.label}: regex tidak valid.`); }
          if (!new RegExp(raw).test('WKM-AG-0001') && !await ui.confirm('Pola ini tidak cocok dengan contoh "WKM-AG-0001". Tetap simpan?', { title: 'Pola tidak cocok', ok: 'Tetap simpan' })) return;
          out.push({ key: dd.key, value: raw });
        }
      }
      const now = new Date().toISOString();
      await must1(c.from('exp_setting').upsert(out.map(o => ({ ...o, updated_at: now })), { onConflict: 'key' }));
      toast('Parameter tersimpan'); S.syncSoon(300); reload();
    } catch (err) { toast(err.message || String(err), 'err'); }
  };
}

async function secUsers({ box, c, toast, reload, canEdit, canSuper, info }) {
  const roles = await must(c.from('exp_role_def').select('*').eq('is_active', true).order('role'));
  let formsReady = true, rows;
  { const r = await c.from('exp_profile').select('user_id,full_name,role,is_active,email,input_forms').order('full_name');
    if (r.error) { formsReady = false; rows = await must(c.from('exp_profile').select('user_id,full_name,role,is_active,email').order('full_name')); } else rows = r.data; }
  const writerRole = new Set(roles.filter(r => r.can_write).map(r => r.role));
  const FORMS = [['progress', 'Progress'], ['collar', 'Collar'], ['hours', 'Dist. Hour'], ['sample', 'Sampel']];
  for (const r of rows) r._f = Object.fromEntries(FORMS.map(([k]) => [k, !Array.isArray(r.input_forms) || r.input_forms.includes(k)]));
  const superRole = new Set(roles.filter(r => r.can_super).map(r => r.role));
  const allOpts = roles.map(r => ({ v: r.role, t: r.label }));                       // label only, no code
  const opts = roles.filter(r => canSuper || !r.can_super).map(r => ({ v: r.role, t: r.label }));
  const me = String(info.email || '').toLowerCase();
  box.innerHTML = `<div id="nu"></div><div id="ed"></div>`;

  if (canSuper) {
    box.querySelector('#nu').innerHTML = `<form class="card" id="nf"><h3>Tambah user baru</h3>
      <p class="muted small">Membuat akun login langsung dari sini (lewat Edge Function). Kirim email dan password ke orangnya secara pribadi.</p>
      <div class="newuser"><div class="row">
        <label>Email<input name="email" type="email" required autocomplete="off"></label>
        <label>Nama lengkap<input name="full_name" required autocomplete="off"></label></div>
      <div class="row">
        <label>Role<select name="role">${opts.map(o => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('')}</select></label>
        <label>Password (min. 10 karakter)<input name="password" type="text" minlength="10" required autocomplete="off"></label></div>
      <div class="row actions"><button type="button" class="btn small" id="genpw">Buat password acak</button><button class="btn primary" type="submit">Buat akun</button></div></div></form>`;
    const nf = box.querySelector('#nf');
    nf.querySelector('#genpw').onclick = () => { nf.elements.password.value = randomPassword(); };
    nf.onsubmit = async e => {
      e.preventDefault();
      const b = e.submitter; b.disabled = true;
      const f = nf.elements;
      try {
        await callUserFn(c, { action: 'create', email: f.email.value, full_name: f.full_name.value, role: f.role.value, password: f.password.value });
        toast(`Akun ${f.email.value.trim()} dibuat`); reload();
      } catch (err) { toast(err.message || String(err), 'err'); b.disabled = false; }
    };
  }

  editor(box.querySelector('#ed'), {
    title: 'User', rows, reload, toast, canEdit,
    note: (formsReady ? 'Kolom "Input …" membatasi form yang boleh diisi user (hanya untuk role dengan izin input; semua tercentang = semua form). ' : 'Pembatasan per form butuh migrasi 0012 di site ini (belum dijalankan). ') + (canSuper ? 'Super admin: tambah user di atas, hapus atau reset password per baris. Menonaktifkan (hilangkan centang Aktif) menahan akses tanpa menghapus akun.'
      : 'Akun login baru dibuat oleh super admin. Di sini Anda mengatur role dan menonaktifkan user yang sudah ada. Akun super admin hanya bisa diubah oleh super admin.'),
    blank: { email: '', full_name: '', role: opts[0]?.v || '', is_active: true, _f: { progress: true, collar: true, hours: true, sample: true } },
    cols: [{ k: 'email', label: 'Email', type: 'text', pk: true }, { k: 'full_name', label: 'Nama', type: 'text' },
      { k: 'role', label: 'Role', type: 'select', options: opts, allOptions: allOpts },
      ...(formsReady ? FORMS.map(([k, l]) => ({ k: 'f.' + k, label: 'Input ' + l, type: 'bool', dep: { k: 'role', test: v => writerRole.has(v) }, hint: 'Hanya untuk role yang boleh input data. Hilangkan centang untuk melarang user ini mengisi form tersebut.' })) : []),
      { k: 'is_active', label: 'Aktif', type: 'bool' }],
    locked: r => !canSuper && superRole.has(r.role),
    save: async r => { need(r.email, 'Email'); need(r.full_name, 'Nama'); need(r.role, 'Role');
      const args = { p_email: r.email, p_name: r.full_name, p_role: r.role, p_active: r.is_active };
      if (formsReady) { const on = FORMS.map(([k]) => k).filter(k => r._f?.[k]); args.p_forms = !writerRole.has(r.role) || on.length === FORMS.length ? null : on; }
      await must1(c.rpc('exp_admin_upsert_profile', args)); },
    actions: canSuper ? [
      { id: 'pw', label: 'Reset password', ok: 'Password diganti',
        run: async r => { const pw = prompt(`Password baru untuk ${r.email} (min. 10 karakter):`, randomPassword()); if (pw == null) return false; await callUserFn(c, { action: 'reset_password', user_id: r.user_id, password: pw }); alert(`Password baru untuk ${r.email}:\n\n${pw}\n\nSampaikan secara pribadi.`); } },
      { id: 'del', label: 'Hapus', danger: true, ok: 'User dihapus', show: r => String(r.email || '').toLowerCase() !== me,
        confirm: r => `Hapus akun "${r.full_name}" (${r.email}) secara permanen? Akun login ikut terhapus dan tidak bisa dibatalkan.`,
        run: r => callUserFn(c, { action: 'delete', user_id: r.user_id }) },
    ] : [],
  });
}

async function secRoles({ box, c, toast, reload, canEdit, canSuper }) {
  const rows = await must(c.from('exp_role_def').select('*').order('role'));
  editor(box, {
    title: 'Role', rows, reload, toast, canEdit,
    note: 'Izin: "Boleh input" = simpan data (form mana saja yang boleh diisi tiap user diatur di sub-tab User). "Admin" = kelola menu ini. ' + (canSuper ? '"Super" = hapus permanen data master, tambah/hapus user. ' : '') + 'Semua role aktif bisa melihat data. Sistem menolak bila admin atau super admin aktif terakhir akan hilang.',
    blank: { role: '', label: '', description: '', can_write: true, can_admin: false, can_super: false, is_active: true },
    cols: [{ k: 'role', label: 'Kode role (huruf kecil)', type: 'text', pk: true }, { k: 'label', label: 'Label', type: 'text' }, DESC,
      { k: 'can_write', label: 'Boleh input data', type: 'bool' }, { k: 'can_admin', label: 'Admin', type: 'bool' },
      ...(canSuper ? [{ k: 'can_super', label: 'Super', type: 'bool' }] : []), { k: 'is_active', label: 'Aktif', type: 'bool' }],
    locked: r => !canSuper && !!r.can_super,
    save: async (r, isNew) => { need(r.role, 'Kode role'); need(r.label, 'Label');
      if (!/^[a-z][a-z0-9_]{1,30}$/.test(r.role)) throw new Error('Kode role: huruf kecil/angka/_ (2–31 karakter, diawali huruf).');
      if (isNew && rows.some(x => x.role === r.role)) throw new Error('Kode role sudah ada.');
      const payload = { role: r.role, label: r.label, description: d(r.description), can_write: r.can_write, can_admin: r.can_admin || !!r.can_super, is_active: r.is_active };
      if (canSuper) payload.can_super = !!r.can_super;
      await must1(c.from('exp_role_def').upsert(payload, { onConflict: 'role' })); },
    actions: canSuper ? [{ id: 'del', label: 'Hapus', danger: true, ok: 'Dihapus',
      confirm: r => `Hapus role "${r.role}" secara permanen? (Ditolak bila masih dipakai user.)`,
      run: r => mustDelete(c.from('exp_role_def').delete().eq('role', r.role)) }] : [],
  });
}


// Layer peta: uploaded and kept ON THIS DEVICE ONLY (IndexedDB). Nothing is sent to the server; every user adds their own layers.
export async function viewMapLayers(box, toast, info, onChange) {
  const D = await import('./db.js');
  const TYPE = { polygon: 'Poligon', line: 'Garis', point: 'Titik', mixed: 'Campuran' };
  const rows = (await D.db.maplayers.toArray()).sort((a, b) => (b.sort_order ?? 0) - (a.sort_order ?? 0));
  const reload = () => { viewMapLayers(box, toast, info, onChange); onChange?.(); };
  box.innerHTML = `<div class="card"><h3>Layer peta (hanya di perangkat ini)</h3>
    <div class="helpbox">Unggah <b>shapefile</b> (satu file <b>.zip</b> berisi .shp .dbf .prj, atau pilih .shp + .dbf + .prj sekaligus) atau <b>GeoJSON</b>. Koordinat dikonversi otomatis ke lat/lon (CRS dibaca dari .prj; tanpa .prj dianggap UTM sesuai zona di Pengaturan). <b>File tidak dikirim ke server</b>: hanya tersimpan di perangkat ini dan tidak ikut ke perangkat lain.</div>
    <div class="newuser"><div class="row"><label>Nama layer<input id="ml-name" placeholder="mis. IUP WKM, Jalan hauling, Geologi"></label><label>File<input id="ml-file" type="file" multiple accept=".zip,.shp,.dbf,.prj,.cpg,.geojson,.json"></label></div>
      <div id="ml-msg"></div><button class="btn primary" id="ml-go">Tampilkan di peta</button></div>
    ${rows.length ? `<div class="gridwrap"><table class="grid"><thead><tr><th>Nama</th><th>Jenis</th><th>Objek</th><th>Sumber</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td class="c-pk">${esc(r.name)}</td><td>${esc(TYPE[r.geom_type] || r.geom_type || '')}</td><td class="c-num">${r.feature_count ?? ''}</td><td>${esc(r.source_file || '')}${r.source_crs ? ` <span class="muted small">(${esc(r.source_crs)})</span>` : ''}</td>
        <td><button class="btn small" data-ren="${esc(r.id)}">Ganti nama</button> <button class="btn small danger" data-del="${esc(r.id)}">Hapus</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Belum ada layer.</p>'}</div>`;
  box.querySelector('#ml-go').onclick = async ev => {
    const msg = box.querySelector('#ml-msg'), btn = ev.target; msg.innerHTML = ''; btn.disabled = true;
    try {
      const files = box.querySelector('#ml-file').files;
      if (!files.length) throw new Error('Pilih file shapefile (.zip) atau GeoJSON.');
      const { setting } = await import('./cfg.js');
      const zn = setting('utm_zone');
      msg.innerHTML = '<div class="msg ok">Membaca file…</div>';
      const { readFiles } = await import('./shp.js');
      const r = await readFiles(files, { utm: zn ? { zone: Number(zn), hemisphere: setting('utm_hemisphere') || 'S' } : null });
      const name = box.querySelector('#ml-name').value.trim() || r.source.replace(/\.[^.]+$/, '');
      const top = rows.length ? Math.max(...rows.map(x => x.sort_order ?? 0)) : 0;
      await D.db.maplayers.put({ id: crypto.randomUUID(), name, geom_type: r.geom_type, feature_count: r.feature_count, geojson: r.geojson, style: {}, sort_order: top + 10, source_file: r.source, source_crs: r.crs, updated_at: new Date().toISOString() });
      toast(`Layer "${name}" ditambahkan (${r.feature_count} objek)`); reload();
    } catch (e) { msg.innerHTML = `<div class="msg err">${esc(e.message || e)}</div>`; btn.disabled = false; }
  };
  box.querySelectorAll('[data-ren]').forEach(b => b.onclick = async () => {
    const r = rows.find(x => x.id === b.dataset.ren); const n = prompt('Nama baru layer:', r.name); if (!n || !n.trim()) return;
    await D.db.maplayers.update(r.id, { name: n.trim(), updated_at: new Date().toISOString() }); toast('Nama diubah'); reload();
  });
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const r = rows.find(x => x.id === b.dataset.del);
    if (!await ui.confirm(`Hapus layer "${r.name}" dari perangkat ini? (file asli tetap ada di komputer Anda)`, { title: 'Hapus layer?', ok: 'Hapus', danger: true })) return;
    await D.db.maplayers.delete(r.id); toast('Dihapus'); reload();
  });
}
