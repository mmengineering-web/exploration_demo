import * as D from './db.js';
import * as S from './sync.js';
import { icon } from './icons.js';
import * as ui from './ui.js';
import { loadCfg, setting, codes, labelOf, metaOf, codesWithFlag, holeRegex } from './cfg.js';
import { validateProgress, validateCollar, validateDist, validateSample, hoursOf } from './validate.js';
import { buildReport } from './report.js';
import { showMap } from './map.js';
import { viewAdmin, viewMapLayers } from './admin.js';
import { buildXlsx } from './xlsx-lite.js';
import { buildTemplate } from './template.js';
import * as IMP from './importer.js';
import { makeZip } from './zip.js';
import { recordList } from './records.js';
import { viewDash, resetDash, viewHub, resetHub } from './dash/dash.js';
import { hubReady } from './dash/hub.js';
import { viewRoa } from './roa/view.js';
import { viewQc, resetQc } from './qc/view.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, jam lokal
const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
const txt = v => { v = (v ?? '').toString().trim(); return v === '' ? null : v; };
const opt = (rows, sel, keep) => rows.map(r => `<option value="${esc(r.code)}" ${r.code === sel ? 'selected' : ''}>${esc(r.label)}</option>`).join('');

let tab = 'progress';
const editing = { progress: null, collars: null, samples: null };
let info = null;
let pendingPhoto = null;

/* ---------- helpers ---------- */
const toast = ui.toast;
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '—'; }
function renderMsgs(box, { errors = [], warns = [] }) {
  box.innerHTML = errors.map(e => `<div class="msg err">${esc(e)}</div>`).join('') + warns.map(w => `<div class="msg warn">${esc(w)}</div>`).join('');
}
async function compressImage(file) {
  const px = setting('photo_max_px');
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, px / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return new Promise(res => cv.toBlob(res, 'image/jpeg', 0.8));
}

// Core photo name: HOLEID_from_to (e.g. WKM-AG-0100_12.5_15)
const mnum = x => (x == null || isNaN(x)) ? '' : String(Math.round(x * 100) / 100);
const corePhotoName = r => (r.hole_id && r.from_m != null && r.to_m != null) ? `${r.hole_id}_${mnum(r.from_m)}_${mnum(r.to_m)}` : '';
let _pvUrl = null;
// Shows a thumbnail: new blob, else the copy on this phone, else a short-lived server link (online only)
async function showPreview(box, { blob, id, path, caption }) {
  if (_pvUrl) { URL.revokeObjectURL(_pvUrl); _pvUrl = null; }
  let url = null;
  if (blob) url = _pvUrl = URL.createObjectURL(blob);
  else if (id) { const ph = await D.db.photos.get(id); if (ph?.blob) url = _pvUrl = URL.createObjectURL(ph.blob); }
  if (!url && path) url = await S.signedPhotoUrl(path);
  box.innerHTML = url ? `<img class="pv" src="${url}" alt="Foto">` : (path ? '<span class="muted small">Foto sudah terkirim (pratinjau butuh internet).</span>' : '');
  if (caption) box.insertAdjacentHTML('beforeend', `<div class="muted small">${esc(caption)}</div>`);
}
function deviceCode() {
  let c = localStorage.getItem('exp_device');
  if (!c) { c = Array.from(crypto.getRandomValues(new Uint8Array(2)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 24]).join(''); localStorage.setItem('exp_device', c); }
  return c;
}
// Hole ID lubang tak terencana: SITE-TYPE-<device><nnn>, mis. WKM-AG-KP001
async function nextUnplannedId(type) {
  const prefix = `${info.site}-${type}-${deviceCode()}`;
  const all = await D.db.collars.where('hole_id').startsWith(prefix).toArray();
  const max = all.reduce((m, c) => Math.max(m, parseInt(c.hole_id.slice(prefix.length), 10) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

/* ---------- login / start ---------- */
// Workflow: the app never blocks data entry for lack of internet.
//   - Login needs internet (it is disabled while offline).
//   - "Input tanpa login" opens the entry forms right away; data is stored on the phone and is sent
//     automatically after the user logs in while online.
let loginAbort = null;
function showLogin({ site = null, fromGuest = false } = {}) {
  loginAbort?.abort(); const ac = loginAbort = new AbortController();
  $('#app').innerHTML = `
  <div class="login-wrap"><div class="login card">
    <div class="brand"><span class="brand-mark">${icon('mountain-snow')}</span><div><h1>Exploration Data Entry</h1><p class="sub">CAN · offline-first</p></div></div>
    <div id="netmsg"></div>
    <form id="lf">
      <label>Site<select id="l-site" ${site ? 'disabled' : ''}>${SITE_KEYS().map(s => `<option ${s === site ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>Email<input id="l-email" type="email" autocomplete="username" inputmode="email" required></label>
      <label>Password<input id="l-pw" type="password" autocomplete="current-password" required></label>
      <div id="l-msg"></div>
      <button class="btn primary block lg" type="submit" id="l-go">${icon('log-in')} Masuk</button>
    </form>
    <div class="or"><span>atau</span></div>
    <button class="btn block" id="l-guest" type="button">${fromGuest ? 'Kembali ke input offline' : 'Input tanpa login (offline)'}</button>
    <p class="muted small" style="margin-top:12px">Login butuh internet. Tidak ada sinyal? Pilih <b>Input tanpa login</b>: data disimpan di HP dan terkirim otomatis setelah Anda login saat internet tersedia.</p>
    <div class="row keep" style="justify-content:space-between;align-items:center;margin-top:12px"><span class="muted credit" style="margin:0">Ikon: Lucide · Font: Geist</span>${ui.themeButtonHtml()}</div>
  </div></div>`;
  ui.bindThemeButton($('#app'));
  const paint = () => {
    const on = navigator.onLine;
    $('#netmsg').innerHTML = on ? '' : '<div class="msg warn">Tidak ada internet, login belum bisa. Anda tetap bisa input data tanpa login.</div>';
    $('#l-go').disabled = !on;
  };
  paint();
  window.addEventListener('online', paint, { signal: ac.signal });
  window.addEventListener('offline', paint, { signal: ac.signal });
  $('#l-guest').onclick = async () => {
    const s = site || $('#l-site').value;
    ac.abort();
    info = S.enterGuest(s); D.openDb(s); await loadCfg(); startMain();
  };
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    if (!navigator.onLine) { renderMsgs($('#l-msg'), { errors: ['Tidak ada internet. Login baru bisa saat online.'] }); return; }
    const b = $('#l-go'); b.disabled = true; $('#l-msg').innerHTML = '';
    try {
      info = await S.login(site || $('#l-site').value, $('#l-email').value.trim(), $('#l-pw').value);
      D.openDb(info.site); await loadCfg();
      ac.abort(); startMain();          // startMain -> auto sync -> pending guest data is sent now
    } catch (err) {
      renderMsgs($('#l-msg'), { errors: [err.message || String(err)] });
      b.disabled = !navigator.onLine;
    }
  };
}
import { SITES } from './config.js';
const SITE_KEYS = () => Object.keys(SITES);

/* ---------- shell ---------- */
// per-form input permission: role must allow input, and the user may be limited to some forms (info.forms = null means all)
const FORMS = ['progress', 'collar', 'hours', 'sample'];
const canForm = (i, f) => !!i?.can_write && (!i.forms || i.forms.includes(f));
const canIn = f => canForm(info, f);
function tabsFor(i) {
  const t = [];
  if (canForm(i, 'progress')) t.push(['progress', 'Drilling Progress']);
  if (canForm(i, 'collar')) t.push(['collars', 'Collar']);
  if (canForm(i, 'hours')) t.push(['hours', 'Distribution Hour']);
  if (canForm(i, 'sample')) t.push(['samples', 'Sampel']);
  if (!i.guest) t.push(['dash', 'Dashboard'], ['qc', 'Data QC']);
  if (!i.guest && hubReady()) t.push(['hubdash', 'All sites']);   // explohub dashboard, separate login   // dashboard + data QC: live read, any active role
  if (FORMS.some(f => canForm(i, f)) && !i.guest) t.push(['import', 'Import']);
  if (canForm(i, 'sample') && !i.guest) t.push(['roa', 'RoA Lab']);
  if (!i.guest) t.push(['map', 'Peta']);
  t.push(['report', 'Laporan'], ['list', 'Data Records']);
  if (!i.guest) t.push(['admin', 'Pengaturan']);   // everyone logged in can read it; admins edit, super admin can also delete
  return t;
}
// icon + group per tab (sidebar groups; the bottom bar shows the first four tabs and "Lainnya" for the rest)
const TAB_META = {
  progress: ['pickaxe', 'Input'], collars: ['map-pin', 'Input'], hours: ['clock', 'Input'], samples: ['flask-conical', 'Input'], import: ['file-up', 'Input'], roa: ['file-text', 'Input'],
  dash: ['layout-dashboard', 'Analisis'], hubdash: ['layers', 'Analisis'], qc: ['shield-check', 'Analisis'], map: ['map', 'Analisis'], report: ['file-chart-column', 'Analisis'],
  list: ['database', 'Data'], admin: ['settings', 'Sistem'],
};
const GROUPS = ['Input', 'Analisis', 'Data', 'Sistem'];
const SHORT = { progress: 'Progress', hours: 'Jam rig', samples: 'Sampel', import: 'Import', dash: 'Dashboard', list: 'Records', admin: 'Setelan' };   // bottom-bar labels, kept short so they never truncate
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('') || '?';
const tabBtn = (k, l, cls, extra = '') => `<button class="${cls}${k === tab ? ' on' : ''}" data-t="${k}" ${k === tab ? 'aria-current="page"' : ''} ${cls === 'tab' && SHORT[k] ? `aria-label="${esc(l)}"` : ''} ${extra}>${icon(TAB_META[k]?.[0] || 'layers')}<span>${esc(cls === 'tab' && SHORT[k] ? SHORT[k] : l)}</span></button>`;

function renderNav() {
  info = S.getInfo() || info;
  const tabs = tabsFor(info);
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  // sidebar (desktop)
  $('#nav').innerHTML = GROUPS.map(g => {
    const items = tabs.filter(([k]) => (TAB_META[k]?.[1] || 'Data') === g);
    return items.length ? `<div class="nav-label">${g}</div>` + items.map(([k, l]) => tabBtn(k, l, 'nav-btn')).join('') : '';
  }).join('');
  $('#nav').querySelectorAll('button').forEach(b => b.onclick = () => go(b.dataset.t));
  // bottom bar (mobile): first four tabs, then "Lainnya" (lit when the open tab is not one of the four)
  const main4 = tabs.slice(0, tabs.length > 5 ? 4 : 5), rest = tabs.slice(main4.length);
  $('#tabbar').innerHTML = main4.map(([k, l]) => tabBtn(k, l, 'tab')).join('')
    + (rest.length ? `<button class="tab${rest.some(([k]) => k === tab) ? ' on' : ''}" id="b-more" aria-haspopup="dialog">${icon('ellipsis')}<span>Lainnya</span></button>` : '');
  $('#tabbar').querySelectorAll('button[data-t]').forEach(b => b.onclick = () => go(b.dataset.t));
  const more = $('#b-more'); if (more) more.onclick = () => openMore(tabs);
  const t = tabs.find(([k]) => k === tab); $('#page-title').textContent = t ? t[1] : '';
  const role = info.role_label || info.role;
  $('#who').innerHTML = `<strong>${esc(info.site)}</strong><span class="muted small">${esc(info.name)} · ${esc(role)}</span>`;
  $('#side-user').innerHTML = `<span class="avatar" aria-hidden="true">${esc(initials(info.name))}</span><div class="who"><b>${esc(info.name || info.site)}</b><span>${esc(info.site)} · ${esc(role)}</span></div>`;
  $('#revoked').innerHTML = info.revoked ? '<div class="msg err">Akses akun ini dinonaktifkan oleh admin. Data lokal tetap aman; hubungi site admin.</div>' : '';
}

function openMore(tabs) {
  const body = GROUPS.map(g => {
    const items = tabs.filter(([k]) => (TAB_META[k]?.[1] || 'Data') === g);
    return items.length ? `<div class="more-label">${g}</div><div class="more-grid">${items.map(([k, l]) => tabBtn(k, l, 'tab more')).join('')}</div>` : '';
  }).join('');
  const foot = info.guest ? '' : `<div class="ui-foot" style="justify-content:space-between"><span class="muted small" style="align-self:center">${esc(info.name || '')} · ${esc(info.site)}</span><button class="btn danger" id="m-out">${icon('log-out')} Keluar</button></div>`;
  ui.sheet(body + foot, { title: 'Menu', onMount: (el, close) => {
    el.querySelectorAll('button[data-t]').forEach(b => b.onclick = () => { close(true); go(b.dataset.t); });
    const o = el.querySelector('#m-out'); if (o) o.onclick = () => { close(true); doLogout(); };
  } });
}

async function doLogout() {
  const n = await D.db.outbox.count();
  if (!await ui.confirm(n ? `Masih ada ${n} data belum terkirim. Data itu tetap aman di HP dan terkirim setelah login & online lagi. Data server yang tersimpan di HP akan dihapus saat keluar.`
    : 'Data server yang tersimpan di HP akan dihapus (diunduh lagi saat login).', { title: 'Keluar dari akun?', ok: 'Keluar', danger: !!n })) return;
  await S.logout(); await D.purgeServerData(); resetDash(); resetQc(); await resetHub(); info = null; showLogin();
}

function startMain() {
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand"><span class="brand-mark">${icon('mountain-snow')}</span><div><div class="brand-name">Explo Entry</div><small>${esc(info.site)}</small></div></div>
      <nav id="nav" aria-label="Menu utama"></nav>
      <div class="side-foot">
        <div class="side-user" id="side-user"></div>
        ${info.guest ? '<button class="btn small" id="b-login-side">Login</button>' : '<button class="btn small" id="b-out" type="button">' + icon('log-out') + ' Keluar</button>'}
      </div>
    </aside>
    <div class="main-col">
      <header class="topbar">
        <div class="brand-mini"><span class="brand-mark">${icon('mountain-snow')}</span><div id="who"></div></div>
        <h1 class="page-title" id="page-title"></h1>
        <div class="hdr-r"><span id="chip" class="chip">…</span>
          ${info.guest ? '<button class="btn small primary" id="b-login">Login</button>'
            : '<button class="btn ghost icon small" id="b-sync" type="button" title="Sync sekarang" aria-label="Sync sekarang">' + icon('refresh-cw') + '</button>'}
          ${ui.themeButtonHtml()}</div>
      </header>
      <div id="banner"></div>
      <div id="revoked"></div>
      <main id="view"></main>
    </div>
    <nav class="tabbar" id="tabbar" aria-label="Menu bawah"></nav>
  </div>`;
  ui.bindThemeButton($('#app'));
  if (!startMain._th) { startMain._th = true; ui.theme.onChange(() => { if (['dash', 'qc', 'hubdash'].includes(tab) && $('#view')) go(tab); }); }
  const toLogin = async () => { const n = await D.db.outbox.count(); showLogin({ site: n ? info.site : null, fromGuest: true }); };   // pending data belongs to this site: keep it locked
  if (info.guest) { $('#b-login').onclick = toLogin; $('#b-login-side').onclick = toLogin; }
  else {
    const sync = $('#b-sync'); sync.onclick = () => S.syncNow();
    $('#b-out').onclick = doLogout;
  }
  S.onStatus(st => {
    const chip = $('#chip'); if (!chip) return;
    chip.innerHTML = `${icon(st.syncing ? 'loader-circle' : st.online ? 'wifi' : 'wifi-off', st.syncing ? 'spin' : '')}<span class="hide-s">${st.online ? 'online' : 'offline'} · </span>${st.syncing ? 'syncing…' : `${st.pending} pending`}<span class="hide-s"> · sync ${fmtTime(st.last)}</span>`;
    chip.className = 'chip ' + (st.error ? 'bad' : st.pending ? 'warn' : st.online ? 'good' : 'idle');
    chip.title = st.error || '';
    $('#b-sync')?.classList.toggle('loading', !!st.syncing);
    const bn = $('#banner');
    if (bn) {
      bn.innerHTML = !info?.guest ? '' : st.online
        ? `<div class="msg warn banner" style="margin:12px 16px 0"><span><b>Internet tersedia.</b> Login untuk ${st.pending ? `mengirim ${st.pending} data` : 'menyinkronkan data'}.</span><button class="btn small primary" id="b-login2">Login sekarang</button></div>`
        : `<div class="msg warn banner" style="margin:12px 16px 0"><span><b>Mode offline, belum login.</b> Data disimpan di HP${st.pending ? ` (${st.pending} menunggu)` : ''} dan dikirim setelah login saat ada internet.</span></div>`;
      const l2 = $('#b-login2'); if (l2) l2.onclick = toLogin;
    }
  });
  S.onPerms(() => { if ($('#nav')) { const before = tab; renderNav(); if (tab !== before) go(tab); } });
  renderNav();
  S.startAutoSync();
  S.refreshStatus();
  go(tab);
}

async function go(t) {
  if (t !== tab) window.scrollTo(0, 0);
  tab = t;
  $('#view').dataset.tab = t;
  renderNav();
  try {
    await ({ progress: viewProgress, collars: viewCollar, hours: viewHours, samples: viewSample, report: viewReport, import: viewImport, qc: () => viewQc($('#view')), hubdash: () => viewHub($('#view')), roa: () => viewRoa($('#view'), { toast, canSave: canIn('sample') }), map: viewMap, list: viewList, admin: () => viewAdmin($('#view'), toast), dash: () => viewDash($('#view')) })[t]();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="card"><h2>Tab tidak bisa dibuka</h2><div class="msg err">${esc(e?.message || e)}</div>
      <p class="muted small">Data di HP aman. Coba muat ulang; bila tetap gagal, bersihkan cache aplikasi (data yang belum terkirim tidak terhapus).</p>
      <div class="row actions"><button class="btn" id="b-reload">Muat ulang</button><button class="btn" id="b-clearcache">Bersihkan cache aplikasi</button></div></div>`;
    $('#b-reload').onclick = () => location.reload();
    $('#b-clearcache').onclick = async () => {
      try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); } catch {}
      location.reload();
    };
  }
}
window.addEventListener('unhandledrejection', e => { const m = String(e.reason?.message || e.reason || ''); if (m && !/fetch|network|load failed/i.test(m)) toast(m, 'err'); });

/* ---------- Drilling Progress ---------- */
async function viewProgress() {
  pendingPhoto = null;
  const rec = editing.progress || { id: crypto.randomUUID(), work_date: today(), shift: codes('shift')[0]?.code || '', rig_id: '', hole_id: '', from_m: null, to_m: null, downtime_hours: 0, downtime_reason: '', core_len_m: null, remarks: '', photo_path: null, layer: '', is_deleted: false };
  const isEdit = !!editing.progress;
  const [rigs, collarsAll, progAll] = await Promise.all([D.db.rigs.toArray(), D.db.collars.filter(c => !c.is_deleted).toArray(), D.db.progress.filter(p => !p.is_deleted).toArray()]);
  const collars = collarsAll.filter(c => !metaOf('collar_status', c.status).hide_from_progress);
  const lastRig = localStorage.getItem('exp_last_rig');
  const rigSel = rec.rig_id || lastRig;
  const rigOpts = [...rigs]; if (rec.rig_id && !rigs.some(r => r.rig_id === rec.rig_id)) rigOpts.push({ rig_id: rec.rig_id, rig_name: rec.rig_id + ' (nonaktif)' });
  const maxDt = setting('shift_hours');
  $('#view').innerHTML = `
  <form id="f" class="card" autocomplete="off">
    <h2>${isEdit ? 'Edit' : 'Input'} drilling progress</h2>
    <div class="row">
      <label>Tanggal<span class="datewrap"><input name="work_date" type="date" value="${esc(rec.work_date)}" required>${icon('calendar')}</span></label>
      <label>Shift<select name="shift">${opt(codes('shift', { keep: rec.shift }), rec.shift)}</select></label>
    </div>
    ${rigs.length || rec.rig_id ? `<label>Rig<select name="rig_id" required><option value="">— pilih —</option>
      ${rigOpts.map(r => `<option value="${esc(r.rig_id)}" ${r.rig_id === rigSel ? 'selected' : ''}>${esc(r.rig_name || r.rig_id)}</option>`).join('')}</select></label>`
    : `<label>Rig<input name="rig_id" required autocapitalize="characters" placeholder="mis. RIG-01" value="${esc(rigSel || '')}"><span class="muted small">Daftar rig belum tersedia di HP ini (belum pernah login). Ketik ID rig; dicocokkan setelah login.</span></label>`}
    <label>Hole ID<input name="hole_id" list="holes" value="${esc(rec.hole_id)}" autocapitalize="characters" required>
      <datalist id="holes">${collars.map(c => `<option value="${esc(c.hole_id)}">${esc(labelOf('collar_status', c.status))}</option>`).join('')}${[...new Set(progAll.map(p => p.hole_id))].filter(h => !collars.some(c => c.hole_id === h)).sort().map(h => `<option value="${esc(h)}"></option>`).join('')}</datalist></label>
    <div id="holeinfo" class="muted small"></div>
    <label class="chk"><input type="checkbox" name="eoh" ${(() => { const c = collarsAll.find(x => x.hole_id === rec.hole_id); return isEdit && c && statusClassOf(c.status) === 'eoh' && Number(rec.to_m) === Number(c.total_depth_m) ? 'checked' : ''; })()}>&nbsp;Lubang selesai (EOH) di kedalaman Sampai</label>
    <div class="row">
      <label>Dari (m)<input name="from_m" type="number" step="0.01" inputmode="decimal" value="${rec.from_m ?? ''}" required></label>
      <label>Sampai (m)<input name="to_m" type="number" step="0.01" inputmode="decimal" value="${rec.to_m ?? ''}" required></label>
      <label>Meter<input name="meters" readonly value=""></label>
    </div>
    <div class="row">
      <label>Rencana (m)<input name="plan_m" readonly value="" placeholder="dari collar"></label>
      <label>Capaian (m)<input name="ach_m" readonly value=""></label>
      <label>Capaian (%)<input name="ach_pct" readonly value=""></label>
    </div>
    <label>Layer<select name="layer"><option value="">—</option>${opt(codes('layer', { keep: rec.layer }), rec.layer)}</select></label>
    <fieldset id="corebox"><legend>Core result</legend>
      <div class="row">
        <label>Core length (m)<input name="core_len_m" type="number" step="0.01" min="0" inputmode="decimal" value="${rec.core_len_m ?? ''}"></label>
        <label>Recovery (%)<input name="core_rec" readonly value=""></label>
      </div>
    </fieldset>
    <div class="row">
      <label>Downtime (jam)<input name="downtime_hours" type="number" step="0.25" min="0" max="${maxDt}" inputmode="decimal" value="${rec.downtime_hours ?? 0}"></label>
      <label>Alasan downtime<select name="downtime_reason"><option value="">—</option>${opt(codes('downtime_reason', { keep: rec.downtime_reason }), rec.downtime_reason)}</select></label>
    </div>
    <label>Foto core<input id="photo" type="file" accept="image/*" capture="environment"></label>
    <div id="pname" class="muted small"></div>
    <div id="pv"></div>
    <label>Catatan<textarea name="remarks" rows="2">${esc(rec.remarks)}</textarea></label>
    <div id="msgs"></div>
    <div class="row actions">
      <button class="btn primary" type="submit">Simpan</button>
      ${isEdit ? '<button class="btn" type="button" id="b-cancel">Batal</button><button class="btn danger" type="button" id="b-del">Hapus</button>' : ''}
    </div>
  </form>`;
  const f = $('#f');
  $('#view').insertAdjacentHTML('beforeend', '<div id="prec"></div>');
  mountRecords($('#prec'), 'progress', { id: 'f:progress', title: 'Data Drilling Progress', rows: progAll, sort: { k: 'work_date', dir: -1 } }).catch(console.error);
  const read = () => {
    const fd = new FormData(f);
    return { ...rec, work_date: fd.get('work_date'), shift: fd.get('shift'), rig_id: (fd.get('rig_id') || '').trim(),
      hole_id: (fd.get('hole_id') || '').trim().toUpperCase(), from_m: num(fd.get('from_m')), to_m: num(fd.get('to_m')),
      downtime_hours: num(fd.get('downtime_hours')) ?? 0, downtime_reason: txt(fd.get('downtime_reason')), layer: txt(fd.get('layer')), core_len_m: num(fd.get('core_len_m')), remarks: txt(fd.get('remarks')) };
  };
  const refresh = () => {
    const r = read();
    f.meters.value = (r.from_m != null && r.to_m != null) ? (r.to_m - r.from_m).toFixed(2) : '';
    const c = collarsAll.find(x => x.hole_id === r.hole_id);
    // Rencana = planned depth of the collar; Capaian = deepest Sampai of this hole (including what is typed now)
    const deepest = Math.max(0, ...progAll.filter(p => p.hole_id === r.hole_id && p.id !== r.id).map(p => p.to_m), r.to_m ?? 0);
    f.plan_m.value = c?.planned_depth_m ?? '';
    f.ach_m.value = r.hole_id ? deepest.toFixed(2) : '';
    f.ach_pct.value = (c?.planned_depth_m > 0 && r.hole_id) ? (deepest / c.planned_depth_m * 100).toFixed(1) : '';
    const mm = (r.from_m != null && r.to_m != null) ? r.to_m - r.from_m : 0;
    f.core_rec.value = (r.core_len_m != null && mm > 0) ? (r.core_len_m / mm * 100).toFixed(1) : '';
    const nm = corePhotoName(r);
    $('#pname').textContent = nm ? `Nama file otomatis: ${nm}.jpg` : 'Nama file otomatis: isi Hole ID, Dari dan Sampai dulu (HoleID_dari_sampai).';
    $('#holeinfo').textContent = c ? `${labelOf('hole_type', c.hole_type)} · ${c.prospect || '—'} · ${labelOf('collar_status', c.status)} · planned ${c.planned_depth_m ?? '—'} m · total ${c.total_depth_m ?? '—'} m` : (r.hole_id ? 'Hole tidak ada di daftar collar.' : '');
  };
  f.addEventListener('input', refresh); refresh();
  if (rec.photo_path) showPreview($('#pv'), { id: rec.id, path: rec.photo_path, caption: rec.photo_path.split('/').pop() });
  $('#photo').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try { pendingPhoto = await compressImage(file); showPreview($('#pv'), { blob: pendingPhoto, caption: `Siap disimpan (${Math.round(pendingPhoto.size / 1024)} KB)` }); }
    catch { toast('Gagal memproses foto', 'err'); }
  };
  const dw = $('.datewrap'); if (dw) dw.addEventListener('click', e => { if (e.target.tagName !== 'INPUT') { try { dw.querySelector('input').showPicker(); } catch { dw.querySelector('input').focus(); } } });
  f.onsubmit = async e => {
    e.preventDefault();
    const r = read();
    const collar = collarsAll.find(x => x.hole_id === r.hole_id);
    const siblings = r.hole_id ? await D.db.progress.where('hole_id').equals(r.hole_id).toArray() : [];
    const v = validateProgress(r, { collar, siblings });
    renderMsgs($('#msgs'), v);
    if (v.errors.length) return;
    if (v.warns.length && !await ui.confirm(v.warns.join('\n'), { title: 'Ada peringatan. Tetap simpan?', ok: 'Tetap simpan' })) return;
    const nm = corePhotoName(r);
    if (pendingPhoto) {
      r.photo_path = `core/${nm}.jpg`;
      await D.db.photos.put({ id: r.id, blob: pendingPhoto, uploaded: false });
    } else if (r.photo_path && r.photo_path !== `core/${nm}.jpg`) {
      // interval or hole changed: rename and re-upload the copy kept on this phone (if it is still here)
      const ph = await D.db.photos.get(r.id);
      if (ph?.blob) { r.photo_path = `core/${nm}.jpg`; await D.db.photos.put({ id: r.id, blob: ph.blob, uploaded: false }); }
    }
    await D.saveRecord('progress', r);
    // collar follows progress: first interval -> Drilling, EOH ticked -> Completed with total depth = Sampai
    const cl = collarsAll.find(x => x.hole_id === r.hole_id); let note = '';
    if (cl) {
      const want = f.eoh.checked ? 'eoh' : (statusClassOf(cl.status) === 'planned' ? 'coh' : null);
      const code = want && codes('collar_status').find(x => statusClassOf(x.code) === want)?.code;
      if (code && cl.status !== code) {
        await D.saveRecord('collars', { ...cl, status: code, total_depth_m: want === 'eoh' ? r.to_m : cl.total_depth_m });
        if (cl.asbuilt_lat == null) note = ` Status collar jadi ${labelOf('collar_status', code)}; lengkapi koordinat as-built di tab Collar.`;
      } else if (want === 'eoh' && code && Number(cl.total_depth_m) !== Number(r.to_m)) await D.saveRecord('collars', { ...cl, total_depth_m: r.to_m });
    }
    if (r.rig_id) localStorage.setItem('exp_last_rig', r.rig_id);
    editing.progress = null; toast('Tersimpan di perangkat' + note); S.syncSoon();
    viewProgress();
  };
  if (isEdit) {
    $('#b-cancel').onclick = () => { editing.progress = null; viewProgress(); };
    $('#b-del').onclick = async () => {
      if (!await ui.confirm('Hapus record ini? (soft delete, tetap tercatat di server)', { title: 'Hapus data?', ok: 'Hapus', danger: true })) return;
      await D.saveRecord('progress', { ...read(), is_deleted: true });
      editing.progress = null; toast('Dihapus'); S.syncSoon(); viewProgress();
    };
  }
}

/* ---------- Collar ---------- */
async function viewCollar() {
  pendingPhoto = null;
  const rec = editing.collars || { id: crypto.randomUUID(), hole_id: '', hole_type: codes('hole_type')[0]?.code || '', prospect: '',
    status: (codesWithFlag('collar_status', 'is_plan')[0] || codes('collar_status')[0])?.code || '',
    planned_lat: null, planned_lon: null, planned_elev: null, planned_depth_m: null,
    asbuilt_lat: null, asbuilt_lon: null, asbuilt_elev: null, gps_accuracy_m: null, total_depth_m: null,
    photo_path: null, remarks: '', dip_deg: null, azimuth_deg: null, is_deleted: false };
  const isEdit = !!editing.collars;
  const [all, prospects] = await Promise.all([D.db.collars.toArray(), D.db.prospects.toArray()]);
  const planned = all.filter(c => !c.is_deleted && metaOf('collar_status', c.status).is_plan);
  const gpsMax = setting('gps_max_acc_m');
  // dropdown shows the NAME only (the code is stored behind the scenes); keep an unknown old value selectable
  const prospectList = [...prospects].sort((a, b) => String(a.prospect_name).localeCompare(String(b.prospect_name)));
  let prospectOpts = prospectList.map(p => `<option value="${esc(p.prospect_code)}" ${p.prospect_code === rec.prospect ? 'selected' : ''}>${esc(p.prospect_name)}</option>`).join('');
  if (rec.prospect && !prospectList.some(p => p.prospect_code === rec.prospect)) prospectOpts += `<option value="${esc(rec.prospect)}" selected>${esc(rec.prospect)} (tidak terdaftar)</option>`;
  const v = x => x ?? '';
  $('#view').innerHTML = `
  <form id="f" class="card" autocomplete="off">
    <h2>${isEdit ? 'Edit' : 'Input'} collar</h2>
    <label>Pilih dari rencana (opsional)
      <select id="pick"><option value="">— lubang baru / tak terencana —</option>
        ${planned.map(c => `<option value="${c.id}" ${c.id === rec.id ? 'selected' : ''}>${esc(c.hole_id)}</option>`).join('')}</select>
      <span class="muted small">${planned.length ? `${planned.length} lubang rencana (status "rencana"). Pilih untuk melengkapi lubang yang sudah direncanakan (koordinat as-built, status), atau biarkan untuk lubang baru.`
        : 'Belum ada lubang rencana di HP ini. Daftar ini terisi dari collar berstatus "rencana" (mis. Planned); tambahkan lewat form ini atau sinkronkan setelah login.'}</span></label>
    <div class="row">
      <label>Hole ID<input name="hole_id" value="${esc(rec.hole_id)}" autocapitalize="characters" required></label>
      <label>Tipe<select name="hole_type">${opt(codes('hole_type', { keep: rec.hole_type }), rec.hole_type)}</select></label>
    </div>
    <button type="button" class="btn small" id="b-genid">Buat Hole ID baru (tak terencana)</button>
    <div class="row">
      <label>Prospect<select name="prospect"><option value="">— pilih —</option>${prospectOpts}</select></label>
      <label>Status<select name="status">${opt(codes('collar_status', { keep: rec.status }), rec.status)}</select></label>
    </div>
    <fieldset><legend>Planned</legend>
      <div class="row"><label>Lat<input name="planned_lat" type="number" step="any" inputmode="decimal" value="${v(rec.planned_lat)}"></label>
      <label>Lon<input name="planned_lon" type="number" step="any" inputmode="decimal" value="${v(rec.planned_lon)}"></label></div>
      <div class="row"><label>Elevasi (m)<input name="planned_elev" type="number" step="any" inputmode="decimal" value="${v(rec.planned_elev)}"></label>
      <label>Planned depth (m)<input name="planned_depth_m" type="number" step="any" inputmode="decimal" value="${v(rec.planned_depth_m)}"></label></div>
    </fieldset>
    <fieldset><legend>As-built (GPS)</legend>
      <button type="button" class="btn" id="b-gps">${icon('compass')} Ambil GPS</button> <span id="gpsmsg" class="muted small"></span>
      <div class="row"><label>Lat<input name="asbuilt_lat" type="number" step="any" inputmode="decimal" value="${v(rec.asbuilt_lat)}"></label>
      <label>Lon<input name="asbuilt_lon" type="number" step="any" inputmode="decimal" value="${v(rec.asbuilt_lon)}"></label></div>
      <div class="row"><label>Elevasi (m)<input name="asbuilt_elev" type="number" step="any" inputmode="decimal" value="${v(rec.asbuilt_elev)}"></label>
      <label>Akurasi GPS (m)<input name="gps_accuracy_m" type="number" step="any" inputmode="decimal" value="${v(rec.gps_accuracy_m)}"></label></div>
      <label>Total depth (m)<input name="total_depth_m" type="number" step="any" inputmode="decimal" value="${v(rec.total_depth_m)}"></label>
    </fieldset>
    <div class="row"><label>Dip (°)<input name="dip_deg" type="number" step="any" min="-90" max="90" inputmode="decimal" value="${v(rec.dip_deg)}" placeholder="-90"></label>
      <label>Azimuth (°)<input name="azimuth_deg" type="number" step="any" min="0" max="360" inputmode="decimal" value="${v(rec.azimuth_deg)}" placeholder="0"></label></div>
    <p class="muted small" style="margin-top:-4px">Kosong = lubang vertikal (dip -90, azimuth 0).</p>
    <label>Foto collar<input id="photo" type="file" accept="image/*" capture="environment"></label>
    <div id="cname" class="muted small"></div>
    <div id="pv"></div>
    <label>Catatan<textarea name="remarks" rows="2">${esc(rec.remarks)}</textarea></label>
    <div id="msgs"></div>
    <div class="row actions">
      <button class="btn primary" type="submit">Simpan</button>
      ${isEdit ? '<button class="btn" type="button" id="b-cancel">Batal</button><button class="btn danger" type="button" id="b-del">Hapus</button>' : ''}
    </div>
  </form>`;
  const f = $('#f');
  $('#view').insertAdjacentHTML('beforeend', '<div id="crec"></div>');
  mountRecords($('#crec'), 'collars', { id: 'f:collars', title: 'Data Collar', sort: { k: 'hole_id', dir: 1 } }).catch(console.error);
  const read = () => {
    const fd = new FormData(f);
    return { ...rec, hole_id: (fd.get('hole_id') || '').trim().toUpperCase(), hole_type: fd.get('hole_type'), prospect: txt(fd.get('prospect')),
      status: fd.get('status'), planned_lat: num(fd.get('planned_lat')), planned_lon: num(fd.get('planned_lon')), planned_elev: num(fd.get('planned_elev')),
      planned_depth_m: num(fd.get('planned_depth_m')), asbuilt_lat: num(fd.get('asbuilt_lat')), asbuilt_lon: num(fd.get('asbuilt_lon')),
      asbuilt_elev: num(fd.get('asbuilt_elev')), gps_accuracy_m: num(fd.get('gps_accuracy_m')), total_depth_m: num(fd.get('total_depth_m')),
      dip_deg: num(fd.get('dip_deg')), azimuth_deg: num(fd.get('azimuth_deg')), remarks: txt(fd.get('remarks')) };
  };
  const cname = () => { $('#cname').textContent = f.hole_id.value.trim() ? `Nama file otomatis: ${f.hole_id.value.trim().toUpperCase()}.jpg` : 'Nama file otomatis: sama dengan Hole ID (isi Hole ID dulu).'; };
  f.addEventListener('input', cname); cname();
  $('#pick').onchange = e => { editing.collars = all.find(x => x.id === e.target.value) || null; viewCollar(); };
  $('#b-genid').onclick = async () => { f.hole_id.value = await nextUnplannedId(f.hole_type.value); };
  $('#b-gps').onclick = () => {
    if (!navigator.geolocation) return toast('GPS tidak tersedia di perangkat ini', 'err');
    $('#gpsmsg').textContent = 'Mengambil posisi…';
    navigator.geolocation.getCurrentPosition(p => {
      f.asbuilt_lat.value = p.coords.latitude.toFixed(7);
      f.asbuilt_lon.value = p.coords.longitude.toFixed(7);
      if (p.coords.altitude != null) f.asbuilt_elev.value = p.coords.altitude.toFixed(1);
      f.gps_accuracy_m.value = p.coords.accuracy.toFixed(1);
      $('#gpsmsg').textContent = `Akurasi ±${p.coords.accuracy.toFixed(1)} m` + (p.coords.accuracy > gpsMax ? ` — melebihi batas ${gpsMax} m, ulangi di area terbuka` : '');
    }, err => { $('#gpsmsg').textContent = 'Gagal: ' + err.message; }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
  };
  if (rec.photo_path) showPreview($('#pv'), { id: rec.id, path: rec.photo_path });
  $('#photo').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try { pendingPhoto = await compressImage(file); showPreview($('#pv'), { blob: pendingPhoto, caption: `Siap disimpan (${Math.round(pendingPhoto.size / 1024)} KB)` }); }
    catch { toast('Gagal memproses foto', 'err'); }
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const r = read();
    const v2 = validateCollar(r, { others: all });
    renderMsgs($('#msgs'), v2);
    if (v2.errors.length) return;
    if (v2.warns.length && !await ui.confirm(v2.warns.join('\n'), { title: 'Ada peringatan. Tetap simpan?', ok: 'Tetap simpan' })) return;
    const want = `collar/${r.hole_id}.jpg`;     // photo is named after the Hole ID
    if (pendingPhoto) {
      r.photo_path = want;
      await D.db.photos.put({ id: r.id, blob: pendingPhoto, uploaded: false });
    } else if (r.photo_path && r.photo_path !== want) {
      const ph = await D.db.photos.get(r.id);   // Hole ID changed: rename + re-upload if the copy is still on this phone
      if (ph?.blob) { r.photo_path = want; await D.db.photos.put({ id: r.id, blob: ph.blob, uploaded: false }); }
    }
    await D.saveRecord('collars', r);
    editing.collars = null; toast('Tersimpan di perangkat'); S.syncSoon();
    viewCollar();
  };
  if (isEdit) {
    $('#b-cancel').onclick = () => { editing.collars = null; viewCollar(); };
    $('#b-del').onclick = async () => {
      if (!await ui.confirm('Hapus collar ini? (soft delete)', { title: 'Hapus data?', ok: 'Hapus', danger: true })) return;
      await D.saveRecord('collars', { ...read(), is_deleted: true });
      editing.collars = null; toast('Dihapus'); S.syncSoon(); viewCollar();
    };
  }
}

/* ---------- Distribution Hour (jam rig per aktivitas) ---------- */
/* ---------- record lists: one definition per table, used on the form pages and in Data Records ---------- */
const FORM_OF = { progress: 'progress', collars: 'collar', disthours: 'hours', samples: 'sample' };
const TAB_OF = { progress: 'progress', collars: 'collars', disthours: 'hours', samples: 'samples' };
const r2 = x => (x == null || x === '' || isNaN(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const lbl = l => v => labelOf(l, v);
const SYNC_LAB = { synced: 'synced', pending: 'pending', error: 'error' };
const chipOf = v => `<span class="chip ${v === 'error' ? 'bad' : v === 'pending' ? 'warn' : 'good'}">${esc(SYNC_LAB[v] || v)}</span>`;
const SYNC = { k: '_sync', label: 'Sync', type: 'enum', get: r => r._sync, lab: v => SYNC_LAB[v] || v, html: r => chipOf(r._sync) };
const T = (k, label, get, extra = {}) => ({ k, label, type: 'text', get, ...extra });
const N = (k, label, get, extra = {}) => ({ k, label, type: 'num', get, ...extra });
const DT = (k, label, get, extra = {}) => ({ k, label, type: 'date', get, ...extra });
const E = (k, label, get, list, extra = {}) => ({ k, label, type: 'enum', get, lab: list ? lbl(list) : undefined, ...extra });
const REC_COLS = {
  progress: [DT('work_date', 'Tanggal', r => r.work_date), E('shift', 'Shift', r => r.shift, 'shift'), E('rig_id', 'Rig', r => r.rig_id), T('hole_id', 'Hole ID', r => r.hole_id, { cls: 'c-pk' }),
    N('from_m', 'Dari (m)', r => r.from_m), N('to_m', 'Sampai (m)', r => r.to_m), N('len', 'Meter', r => r2(r.to_m - r.from_m)), E('layer', 'Layer', r => r.layer || '', 'layer'),
    N('core_len_m', 'Core (m)', r => r.core_len_m), N('downtime_hours', 'Downtime (jam)', r => r.downtime_hours), E('downtime_reason', 'Alasan downtime', r => r.downtime_reason || '', 'downtime_reason'),
    T('remarks', 'Remarks', r => r.remarks), SYNC],
  collars: [T('hole_id', 'Hole ID', r => r.hole_id, { cls: 'c-pk' }), E('hole_type', 'Tipe', r => r.hole_type, 'hole_type'), E('prospect', 'Prospect', r => r.prospect || ''),
    E('status', 'Status', r => r.status, 'collar_status'), N('planned_depth_m', 'Planned depth (m)', r => r.planned_depth_m), N('total_depth_m', 'Total depth (m)', r => r.total_depth_m),
    E('asbuilt', 'As-built', r => (r.asbuilt_lat != null ? 'ada' : 'belum'), null, { lab: v => (v === 'ada' ? 'Ada' : 'Belum') }), T('remarks', 'Remarks', r => r.remarks), SYNC],
  disthours: [DT('work_date', 'Tanggal', r => r.work_date), E('rig_id', 'Rig', r => r.rig_id), T('from_time', 'From', r => t5(r.from_time)), T('to_time', 'To', r => t5(r.to_time)),
    N('hrs', 'Jam', r => r2(hoursOf(r))), E('activity', 'Aktivitas', r => r.activity, 'activity'),
    N('fuel_l', 'Fuel (L)', r => r.fuel_l), N('polymer_l', 'Polymer (L)', r => r.polymer_l), N('oil_hyd_l', 'Hyd oil (L)', r => r.oil_hyd_l), T('remarks', 'Remarks', r => r.remarks), SYNC],
  surveys: [T('hole_id', 'Hole ID', r => r.hole_id, { cls: 'c-pk' }), N('depth_m', 'Depth (m)', r => r.depth_m), N('dip_deg', 'Dip (°)', r => r.dip_deg), N('azimuth_deg', 'Azimuth (°)', r => r.azimuth_deg),
    E('method', 'Metode', r => r.method || ''), DT('survey_date', 'Tanggal', r => r.survey_date), T('remarks', 'Remarks', r => r.remarks), SYNC],
  samples: [T('sample_no', 'No. sampel', r => r.sample_no, { cls: 'c-pk' }), T('hole_id', 'Hole ID', r => r.hole_id), N('from_m', 'Dari (m)', r => r.from_m), N('to_m', 'Sampai (m)', r => r.to_m),
    E('sample_type', 'Tipe', r => r.sample_type, 'sample_type'), E('status', 'Status', r => r.status, 'sample_status'), DT('sampled_date', 'Tgl ambil', r => r.sampled_date), DT('sent_date', 'Tgl kirim', r => r.sent_date),
    E('lab', 'Lab', r => r.lab || ''), T('batch_id', 'Batch', r => r.batch_id), T('remarks', 'Remarks', r => r.remarks), SYNC],
  assays: [T('hole_id', 'Hole ID', r => r.hole_id, { cls: 'c-pk' }), N('from_m', 'Dari (m)', r => r.from_m), N('to_m', 'Sampai (m)', r => r.to_m), T('sample_no', 'No. sampel', r => r.sample_no),
    E('layer', 'Layer', r => r.layer || '', 'layer'), N('ni_pct', 'Ni (%)', r => r.ni_pct), N('co_pct', 'Co (%)', r => r.co_pct), N('fe_pct', 'Fe (%)', r => r.fe_pct), N('mgo_pct', 'MgO (%)', r => r.mgo_pct), N('sio2_pct', 'SiO2 (%)', r => r.sio2_pct),
    E('sample_type', 'Tipe', r => r.sample_type || '', 'sample_type'), T('batch_id', 'Batch', r => r.batch_id), E('lab', 'Lab', r => r.lab || ''), SYNC],
};
const syncState = async () => { const m = new Map((await D.db.outbox.toArray()).map(o => [o.key, o])); return (tbl, r) => { const o = m.get(`${tbl}:${r.id}`); return o ? (o.err ? 'error' : 'pending') : 'synced'; }; };
const decorate = (tbl, rows, st) => rows.map(r => ({ ...r, _sync: st(tbl, r) }));
async function openRecord(tbl, id) {
  const rec = await D.db[tbl].get(id); if (!rec) return;
  editing[tbl] = rec; go(TAB_OF[tbl]); window.scrollTo(0, 0);
}
// rows = records of one table (all live rows when omitted). Returns the list controller (shown() = rows after search/filter).
async function mountRecords(host, tbl, { id, title, rows, open = true, sort }) {
  const st = await syncState();
  rows = rows || await D.db[tbl].filter(x => !x.is_deleted).toArray();
  const form = FORM_OF[tbl];
  return recordList(host, { id, title, rows: decorate(tbl, rows, st), cols: REC_COLS[tbl], sort, open,
    onOpen: form ? r => openRecord(tbl, r.id) : null, canOpen: () => !!form && canIn(form) });
}

const hUi = { date: '', rig: '' };
const t5 = t => String(t || '').slice(0, 5);
const statusClassOf = code => { const m = metaOf('collar_status', code); return m.map_class === 'planned' || (!m.map_class && m.is_plan) ? 'planned' : (m.map_class === 'progress' ? 'coh' : (m.map_class || 'coh')); };
const fmtH = h => (Math.round(h * 100) / 100).toString();
async function viewHours() {
  const [rigs, all] = await Promise.all([D.db.rigs.toArray(), D.db.disthours.filter(x => !x.is_deleted).toArray()]);
  const rec = editing.disthours || { id: crypto.randomUUID(), work_date: hUi.date || today(), rig_id: hUi.rig || localStorage.getItem('exp_last_rig') || '',
    from_time: '', to_time: '', activity: codes('activity')[0]?.code || '', fuel_l: null, polymer_l: null, oil_hyd_l: null, remarks: '', is_deleted: false };
  const isEdit = !!editing.disthours;
  const rigOpts = [...rigs]; if (rec.rig_id && !rigs.some(r => r.rig_id === rec.rig_id)) rigOpts.push({ rig_id: rec.rig_id, rig_name: rec.rig_id });
  const acts = codes('activity', { keep: rec.activity });
  $('#view').innerHTML = `
  <form id="f" class="card" autocomplete="off">
    <h2>${isEdit ? 'Edit' : 'Input'} distribution hour</h2>
    <div class="row">
      <label>Waktu (tanggal)<span class="datewrap"><input name="work_date" type="date" value="${esc(rec.work_date)}" required>${icon('calendar')}</span></label>
      ${rigs.length || rec.rig_id ? `<label>Rig<select name="rig_id" required><option value="">— pilih —</option>${rigOpts.map(r => `<option value="${esc(r.rig_id)}" ${r.rig_id === rec.rig_id ? 'selected' : ''}>${esc(r.rig_name || r.rig_id)}</option>`).join('')}</select></label>`
        : `<label>Rig<input name="rig_id" required autocapitalize="characters" placeholder="mis. RIG-01" value="${esc(rec.rig_id)}"></label>`}
    </div>
    <div class="row">
      <label>From<input name="from_time" type="time" value="${esc(t5(rec.from_time))}" required></label>
      <label>To<input name="to_time" type="time" value="${esc(t5(rec.to_time))}" required></label>
      <label>Durasi (menit)<input name="dur" type="number" min="1" max="1440" step="1" inputmode="numeric" placeholder="atau isi ini"></label>
      <label>Jam<input name="hrs" readonly></label>
    </div>
    <label>Activity<select name="activity">${acts.map(a => `<option value="${esc(a.code)}" ${a.code === rec.activity ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></label>
    <fieldset class="grp"><legend>Consumables (opsional)</legend>
      <div class="row">
        <label>Fuel (L)<input name="fuel_l" type="number" step="0.1" min="0" inputmode="decimal" value="${rec.fuel_l ?? ''}"></label>
        <label>Polymer (L)<input name="polymer_l" type="number" step="0.1" min="0" inputmode="decimal" value="${rec.polymer_l ?? ''}"></label>
        <label>Hyd oil (L)<input name="oil_hyd_l" type="number" step="0.1" min="0" inputmode="decimal" value="${rec.oil_hyd_l ?? ''}"></label>
      </div>
    </fieldset>
    <label>Remarks<textarea name="remarks" rows="2">${esc(rec.remarks)}</textarea></label>
    <div id="msgs"></div>
    <div class="row actions">
      <button class="btn primary" type="submit">Simpan</button>
      ${isEdit ? '<button class="btn" type="button" id="b-cancel">Batal</button><button class="btn danger" type="button" id="b-del">Hapus</button>' : ''}
    </div>
  </form>
  <div id="hlists"></div><div id="hrec"></div>`;
  const f = $('#f');
  const read = () => {
    const fd = new FormData(f);
    return { ...rec, work_date: fd.get('work_date'), rig_id: (fd.get('rig_id') || '').trim(), from_time: fd.get('from_time') || '', to_time: fd.get('to_time') || '',
      activity: fd.get('activity'), fuel_l: num(fd.get('fuel_l')), polymer_l: num(fd.get('polymer_l')), oil_hyd_l: num(fd.get('oil_hyd_l')), remarks: txt(fd.get('remarks')) };
  };
  const lists = () => {
    const r = read();
    f.hrs.value = hoursOf(r) ? fmtH(hoursOf(r)) : '';
    const day = all.filter(x => x.work_date === r.work_date);
    const actAll = codes('activity');
    const known = new Set(actAll.map(a => a.code));
    const cols = [...actAll, ...[...new Set(day.map(x => x.activity))].filter(a => !known.has(a)).map(a => ({ code: a, label: a }))];
    const rigIds = [...new Set(day.map(x => x.rig_id))].sort();
    const sum = (rg, ac) => day.filter(x => x.rig_id === rg && x.activity === ac).reduce((t, x) => t + hoursOf(x), 0);
    $('#hlists').innerHTML = `
    <div class="card"><h2>Akumulasi jam per aktivitas · ${esc(r.work_date || '')}</h2>
      ${rigIds.length ? `<div class="gridwrap"><table class="grid"><thead><tr><th>Rig</th>${cols.map(a => `<th>${esc(a.label)}</th>`).join('')}<th>Total</th></tr></thead><tbody>
        ${rigIds.map(rg => `<tr><td class="c-pk">${esc(rg)}</td>${cols.map(a => `<td class="c-num">${sum(rg, a.code) ? fmtH(sum(rg, a.code)) : '–'}</td>`).join('')}<td class="c-num"><b>${fmtH(cols.reduce((t, a) => t + sum(rg, a.code), 0))}</b></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Belum ada jam rig di tanggal ini.</p>'}
    </div>`;
  };
  // Durasi: typing minutes fills To = From + minutes (From = end of previous entry, else 07:00); editing From/To updates the minutes
  const mm = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
  const hhmm = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  f.dur.addEventListener('input', () => {
    const d = Number(f.dur.value); if (!d || d <= 0) return;
    if (!f.from_time.value) { const prev = all.filter(x => x.work_date === f.work_date.value && x.rig_id === f.rig_id.value).map(x => t5(x.to_time)).sort().pop(); f.from_time.value = prev || '07:00'; }
    f.to_time.value = hhmm(Math.min(mm(f.from_time.value) + Math.round(d), 1439));
    lists();
  });
  const syncDur = () => { const a = mm(f.from_time.value), b = mm(f.to_time.value); f.dur.value = (a != null && b != null && b > a) ? b - a : ''; };
  f.from_time.addEventListener('input', syncDur); f.to_time.addEventListener('input', syncDur); syncDur();
  f.addEventListener('input', lists);
  // convenience: a new entry starts where the previous one of this rig/day ended
  const prefill = () => {
    if (isEdit || f.from_time.value) return;
    const prev = all.filter(x => x.work_date === f.work_date.value && x.rig_id === f.rig_id.value).map(x => t5(x.to_time)).sort().pop();
    if (prev) f.from_time.value = prev;
  };
  f.work_date.addEventListener('change', () => { if (!isEdit) f.from_time.value = ''; prefill(); lists(); });
  f.rig_id.addEventListener('change', () => { if (!isEdit) f.from_time.value = ''; prefill(); lists(); });
  prefill(); lists();
  mountRecords($('#hrec'), 'disthours', { id: 'f:disthours', title: 'Data Distribution Hour', rows: all, sort: { k: 'work_date', dir: -1 } }).catch(console.error);
  const dw = $('.datewrap'); if (dw) dw.addEventListener('click', e => { if (e.target.tagName !== 'INPUT') { try { dw.querySelector('input').showPicker(); } catch { dw.querySelector('input').focus(); } } });
  f.onsubmit = async e => {
    e.preventDefault();
    const r = read();
    const v = validateDist(r, { siblings: all });
    renderMsgs($('#msgs'), v);
    if (v.errors.length) return;
    await D.saveRecord('disthours', r);
    if (r.rig_id) localStorage.setItem('exp_last_rig', r.rig_id);
    hUi.date = r.work_date; hUi.rig = r.rig_id;
    editing.disthours = null; toast('Tersimpan di perangkat'); S.syncSoon();
    viewHours();
  };
  if (isEdit) {
    $('#b-cancel').onclick = () => { editing.disthours = null; viewHours(); };
    $('#b-del').onclick = async () => {
      if (!await ui.confirm('Hapus entri ini?', { title: 'Hapus data?', ok: 'Hapus', danger: true })) return;
      await D.saveRecord('disthours', { ...read(), is_deleted: true });
      editing.disthours = null; toast('Dihapus'); S.syncSoon(); viewHours();
    };
  }
}


/* ---------- Sampel (register + status lab) ---------- */
const sUi = { hole: '', status: '', sel: new Set() };
const nextSampleNo = list => {
  const last = [...list].filter(s => /\d+$/.test(s.sample_no || '')).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!last) return '';
  const m = /^(.*?)(\d+)$/.exec(last.sample_no);
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
};
async function viewSample() {
  const [collarsAll, progAll, all] = await Promise.all([D.db.collars.filter(c => !c.is_deleted).toArray(), D.db.progress.filter(p => !p.is_deleted).toArray(), D.db.samples.filter(s => !s.is_deleted).toArray()]);
  const isEdit = !!editing.samples;
  const lastTo = h => Math.max(0, ...all.filter(s => s.hole_id === h && s.sample_type === 'NORMAL').map(s => Number(s.to_m)));
  const rec = editing.samples || { id: crypto.randomUUID(), sample_no: nextSampleNo(all), hole_id: sUi.hole, from_m: sUi.hole ? lastTo(sUi.hole) : null, to_m: null,
    sample_type: codes('sample_type')[0]?.code || 'NORMAL', status: codes('sample_status')[0]?.code || 'PENDING', sampled_date: today(), sent_date: null, lab: null, batch_id: null, remarks: null, is_deleted: false };
  const types = codes('sample_type', { keep: rec.sample_type }), stats = codes('sample_status', { keep: rec.status });
  const holes = [...new Set([...collarsAll.map(c => c.hole_id), ...progAll.map(p => p.hole_id)])].sort();
  const dp = (d, v) => `<span class="datewrap"><input name="${d}" type="date" value="${esc(v || '')}">${icon('calendar')}</span>`;
  $('#view').innerHTML = `
  <form id="f" class="card" autocomplete="off">
    <h2>${isEdit ? 'Edit' : 'Register'} sampel</h2>
    <label>Hole ID<input name="hole_id" list="sholes" value="${esc(rec.hole_id)}" autocapitalize="characters" required>
      <datalist id="sholes">${holes.map(h => `<option value="${esc(h)}">`).join('')}</datalist></label>
    <div id="sinfo" class="muted small"></div>
    <label>Nomor sampel<input name="sample_no" value="${esc(rec.sample_no)}" autocapitalize="characters" required></label>
    <div class="row">
      <label>Dari (m)<input name="from_m" type="number" step="0.01" inputmode="decimal" value="${rec.from_m ?? ''}" required></label>
      <label>Sampai (m)<input name="to_m" type="number" step="0.01" inputmode="decimal" value="${rec.to_m ?? ''}" required></label>
      <label>Panjang<input name="len" readonly></label>
    </div>
    <div class="row">
      <label>Tipe<select name="sample_type">${types.map(t => `<option value="${esc(t.code)}" ${t.code === rec.sample_type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
      <label>Status<select name="status">${stats.map(t => `<option value="${esc(t.code)}" ${t.code === rec.status ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
    </div>
    <div class="row">
      <label>Tanggal ambil${dp('sampled_date', rec.sampled_date)}</label>
      <label>Tanggal kirim${dp('sent_date', rec.sent_date)}</label>
    </div>
    <div class="row">
      <label>Lab<input name="lab" value="${esc(rec.lab || '')}"></label>
      <label>Batch<input name="batch_id" value="${esc(rec.batch_id || '')}"></label>
    </div>
    <label>Remarks<textarea name="remarks" rows="2">${esc(rec.remarks || '')}</textarea></label>
    ${isEdit ? '' : `<label>Pecah per (m)<input name="step" type="number" step="0.01" min="0.05" inputmode="decimal" placeholder="mis. 1"></label>
      <div class="row actions"><button class="btn" type="button" id="b-split">Simpan sebagai banyak sampel</button></div>
      <p class="muted small">Isi Dari dan Sampai, lalu Pecah per. Nomor berlanjut dari nomor di atas (harus berakhir angka). Potongan terakhir boleh lebih pendek.</p>`}
    <div id="msgs"></div>
    <div class="row actions">
      <button class="btn primary" type="submit">Simpan</button>
      ${isEdit ? '<button class="btn" type="button" id="b-cancel">Batal</button><button class="btn danger" type="button" id="b-del">Hapus</button>' : ''}
    </div>
  </form>
  <div id="srec"></div><div id="slist"></div>`;
  const f = $('#f');
  const read = () => {
    const fd = new FormData(f);
    return { ...rec, sample_no: (fd.get('sample_no') || '').trim(), hole_id: (fd.get('hole_id') || '').trim().toUpperCase(), from_m: num(fd.get('from_m')), to_m: num(fd.get('to_m')),
      sample_type: fd.get('sample_type'), status: fd.get('status'), sampled_date: fd.get('sampled_date') || null, sent_date: fd.get('sent_date') || null,
      lab: txt(fd.get('lab')), batch_id: txt(fd.get('batch_id')), remarks: txt(fd.get('remarks')) };
  };
  const ctx = r => {
    const collar = collarsAll.find(c => c.hole_id === r.hole_id), pr = progAll.filter(p => p.hole_id === r.hole_id);
    return { collar, siblings: all, deepest: pr.length ? Math.max(...pr.map(p => Number(p.to_m))) : null };
  };
  const status = () => {
    const r = read(), c = ctx(r);
    f.len.value = (r.from_m != null && r.to_m != null && r.to_m > r.from_m) ? (Math.round((r.to_m - r.from_m) * 100) / 100) : '';
    const mine = all.filter(s => s.hole_id === r.hole_id);
    $('#sinfo').textContent = r.hole_id ? `Dibor sampai ${c.deepest ?? '—'} m · sampel terdaftar ${mine.length}${mine.length ? ` (sampai ${lastTo(r.hole_id)} m)` : ''}` : '';
  };
  // bulk-status card (built once) + the searchable record list (built once; filters/search survive a redraw)
  const cs = codes('sample_status'), can = c => cs.some(x => x.code === c);
  let sRec = null;
  const selNote = () => { const n = $('#s-n'); if (n) n.textContent = sUi.sel.size; };
  const list = () => {};
  $('#slist').innerHTML = `
    <div class="card"><h2>Ubah status terpilih</h2>
      <p class="muted small">Centang sampel di daftar. <button class="btn small" type="button" id="s-all">Pilih semua yang tampil</button> <button class="btn small" type="button" id="s-none">Kosongkan</button> · terpilih <span id="s-n">${sUi.sel.size}</span></p>
      <label>Tanggal kirim${dp('b_date', today())}</label>
      <div class="row"><label>Lab<input id="b-lab"></label><label>Batch<input id="b-batch"></label></div>
      <div class="row actions">${can('SENT') ? '<button class="btn primary" type="button" data-set="SENT">Tandai terkirim ke lab</button>' : ''}${can('ANALYZED') ? '<button class="btn" type="button" data-set="ANALYZED">Tandai sudah dianalisis</button>' : ''}${can('PENDING') ? '<button class="btn" type="button" data-set="PENDING">Kembalikan ke belum dikirim</button>' : ''}</div>
    </div>`;
  syncState().then(st => {
    sRec = recordList($('#srec'), { id: 'f:samples', title: 'Daftar sampel', rows: decorate('samples', all, st), cols: REC_COLS.samples, sort: { k: 'hole_id', dir: 1 },
      onOpen: r => { editing.samples = all.find(x => x.id === r.id); viewSample(); window.scrollTo(0, 0); },
      select: { set: sUi.sel, id: r => r.id, onChange: selNote } });
  }).catch(console.error);
  $('#s-all').onclick = () => { (sRec?.shown() || []).forEach(s => sUi.sel.add(s.id)); sRec?.redraw(); selNote(); };
  $('#s-none').onclick = () => { sUi.sel.clear(); sRec?.redraw(); selNote(); };
  $('#slist').querySelectorAll('[data-set]').forEach(b => b.onclick = async () => {
    const ids = [...sUi.sel].filter(id => all.some(s => s.id === id)); if (!ids.length) { toast('Centang sampel dulu.', 'err'); return; }
    const st = b.dataset.set, dt = $('#slist [name=b_date]').value || today(), lab = txt($('#b-lab').value), batch = txt($('#b-batch').value);
    const recs = ids.map(id => { const s = all.find(x => x.id === id); const n = { ...s, status: st };
      if (st === 'SENT') { n.sent_date = dt; if (lab) n.lab = lab; if (batch) n.batch_id = batch; if (n.sampled_date && n.sent_date < n.sampled_date) n.sent_date = n.sampled_date; }
      if (st === 'PENDING') n.sent_date = null;
      return n; });
    await D.saveMany('samples', recs); sUi.sel.clear(); toast(`${recs.length} sampel diperbarui`); S.syncSoon(); viewSample();
  });
  f.addEventListener('input', status);
  f.hole_id.addEventListener('change', () => { sUi.hole = read().hole_id; if (!isEdit && f.from_m.value === '') f.from_m.value = lastTo(sUi.hole) || ''; status(); list(); });
  status(); list();
  const dw = [...document.querySelectorAll('#f .datewrap')]; dw.forEach(w => w.addEventListener('click', e => { if (e.target.tagName !== 'INPUT') { try { w.querySelector('input').showPicker(); } catch { w.querySelector('input').focus(); } } }));
  f.onsubmit = async e => {
    e.preventDefault();
    const r = read(), v = validateSample(r, ctx(r));
    renderMsgs($('#msgs'), v);
    if (v.errors.length) return;
    if (v.warns.length && !await ui.confirm(v.warns.join('\n'), { title: 'Ada peringatan. Tetap simpan?', ok: 'Tetap simpan' })) return;
    await D.saveRecord('samples', r);
    sUi.hole = r.hole_id; editing.samples = null; toast('Tersimpan di perangkat'); S.syncSoon(); viewSample();
  };
  if (isEdit) {
    $('#b-cancel').onclick = () => { editing.samples = null; viewSample(); };
    $('#b-del').onclick = async () => {
      if (!await ui.confirm('Hapus sampel ini?', { title: 'Hapus data?', ok: 'Hapus', danger: true })) return;
      await D.saveRecord('samples', { ...read(), is_deleted: true });
      editing.samples = null; toast('Dihapus'); S.syncSoon(); viewSample();
    };
  } else {
    $('#b-split').onclick = async () => {
      const r = read(), step = num(f.step.value), m = /^(.*?)(\d+)$/.exec(r.sample_no || '');
      const errs = [];
      if (!step || step <= 0) errs.push('Isi "Pecah per (m)".');
      if (!m) errs.push('Nomor sampel harus berakhir angka agar bisa dilanjutkan (mis. CDSM-0001).');
      if (r.from_m == null || r.to_m == null || r.to_m <= r.from_m) errs.push('Isi Dari dan Sampai yang valid.');
      if (errs.length) { renderMsgs($('#msgs'), { errors: errs }); return; }
      const recs = []; let a = r.from_m, n = Number(m[2]);
      while (a < r.to_m - 1e-9) {
        const b = Math.min(Math.round((a + step) * 100) / 100, r.to_m);
        recs.push({ ...r, id: crypto.randomUUID(), sample_no: m[1] + String(n++).padStart(m[2].length, '0'), from_m: Math.round(a * 100) / 100, to_m: b }); a = b;
      }
      if (recs.length > 500) { renderMsgs($('#msgs'), { errors: ['Maksimal 500 sampel sekali pecah.'] }); return; }
      const pool = [...all], errors = [], warns = [];
      for (const x of recs) { const v = validateSample(x, { ...ctx(x), siblings: pool }); errors.push(...v.errors.map(e => `${x.sample_no}: ${e}`)); warns.push(...v.warns); pool.push(x); }
      renderMsgs($('#msgs'), { errors: errors.slice(0, 5).concat(errors.length > 5 ? [`… dan ${errors.length - 5} error lain`] : []), warns: [...new Set(warns)] });
      if (errors.length) return;
      if (!await ui.confirm(`Simpan ${recs.length} sampel: ${recs[0].sample_no} … ${recs.at(-1).sample_no} (${r.from_m}–${r.to_m} m, per ${step} m)?`)) return;
      await D.saveMany('samples', recs);
      sUi.hole = r.hole_id; toast(`${recs.length} sampel tersimpan di perangkat`); S.syncSoon(); viewSample();
    };
  }
}

/* ---------- Laporan harian (teks untuk WhatsApp) ---------- */
const rUi = { date: '' };
async function viewReport() {
  const [collars, progress, disthours, samples, rigs] = await Promise.all([D.db.collars.toArray(), D.db.progress.toArray(), D.db.disthours.toArray(), D.db.samples.toArray(), D.db.rigs.toArray()]);
  const date = rUi.date || today();
  const title = localStorage.getItem(`exp_report_title_${info.site}`) ?? info.site, company = localStorage.getItem(`exp_report_company_${info.site}`) ?? '';
  const stClass = statusClassOf;
  const gen = () => buildReport({ date: $('#r-date').value || date, title: $('#r-title').value, company: $('#r-co').value, collars, progress, disthours, samples, rigs,
    statusClass: stClass, actLabel: a => labelOf('activity', a), reasonLabel: a => labelOf('downtime_reason', a) });
  $('#view').innerHTML = `
  <div class="card"><h2>Laporan harian</h2>
    <div class="row">
      <label>Tanggal<span class="datewrap"><input id="r-date" type="date" value="${esc(date)}">${icon('calendar')}</span></label>
      <label>Judul<input id="r-title" value="${esc(title)}" placeholder="mis. GMS-CDSM"></label>
      <label>Perusahaan<input id="r-co" value="${esc(company)}" placeholder="mis. PT GMS"></label>
    </div>
    <p class="muted small">Disusun dari data di HP ini (sync dulu agar lengkap). Teks boleh diedit sebelum disalin.</p>
    <div id="r-warn"></div>
    <textarea id="r-text" rows="26" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;width:100%"></textarea>
    <div class="row actions"><button class="btn primary" id="r-copy">Salin</button>${navigator.share ? '<button class="btn" id="r-share">Bagikan</button>' : ''}<button class="btn" id="r-regen">Susun ulang</button></div>
  </div>`;
  const dw = $('.datewrap'); dw.addEventListener('click', e => { if (e.target.tagName !== 'INPUT') { try { dw.querySelector('input').showPicker(); } catch { dw.querySelector('input').focus(); } } });
  const draw = () => {
    rUi.date = $('#r-date').value || date;
    try { localStorage.setItem(`exp_report_title_${info.site}`, $('#r-title').value); localStorage.setItem(`exp_report_company_${info.site}`, $('#r-co').value); } catch {}
    const r = gen(); $('#r-text').value = r.text;
    $('#r-warn').innerHTML = r.warnings.map(w => `<div class="msg warn">${esc(w)}</div>`).join('');
  };
  ['#r-date', '#r-title', '#r-co'].forEach(s => $(s).addEventListener('input', draw)); $('#r-regen').onclick = draw;
  $('#r-copy').onclick = async () => {
    const t = $('#r-text').value;
    try { await navigator.clipboard.writeText(t); } catch { $('#r-text').select(); document.execCommand('copy'); }
    toast('Teks laporan disalin');
  };
  if (navigator.share) $('#r-share').onclick = () => navigator.share({ text: $('#r-text').value }).catch(() => {});
  draw();
}

/* ---------- Import (Excel) ---------- */
let XLSXLIB = null;
function loadXlsxLib() {
  if (XLSXLIB) return Promise.resolve(XLSXLIB);
  return new Promise((res, rej) => {
    if (window.XLSX) return res(XLSXLIB = window.XLSX);
    const sc = document.createElement('script'); sc.src = 'js/vendor/xlsx.mini.min.js';
    sc.onload = () => res(XLSXLIB = window.XLSX); sc.onerror = () => rej(new Error('Pustaka Excel gagal dimuat (cek koneksi sekali, lalu tersimpan offline).'));
    document.head.appendChild(sc);
  });
}
const impUi = { parsed: null, file: '', withWarn: false };
const SHEET_LABEL = { COLLAR: 'Collar', PROGRESS: 'Progress', DIST_HOUR: 'Jam rig', SURVEY: 'Survey', SAMPLE: 'Sample', ASSAY: 'Assay' };

async function importCtx() {
  const [rigs, prospects, collars, progress, disthours, surveys, samples, assays] = await Promise.all(
    ['rigs', 'prospects', 'collars', 'progress', 'disthours', 'surveys', 'samples', 'assays'].map(t => D.db[t].toArray()));
  const layers = D.db.maplayers ? await D.db.maplayers.toArray() : [];
  return { file: impUi.file, rigs, prospects, collars, progress, disthours, surveys, samples, assays, layers };
}

async function viewImport() {
  const pend = await D.db.outbox.count();
  const last = localStorage.getItem(`exp_last_sync_${info.site}`);
  $('#view').innerHTML = `
  <div class="card"><h2>Import dari Excel</h2>
    <p class="muted small">Baris yang sudah ada (Hole ID, interval, atau nomor sampel yang sama) ditolak, tidak menimpa data. Pengecekan memakai data di HP ini; sinkron dulu agar terbaru (sinkron terakhir ${last ? fmtTime(last) : 'belum pernah'}${pend ? `, ${pend} data belum terkirim` : ''}).</p>
    <div class="row actions">
      <button class="btn" id="tpl-dl">Unduh template</button>
      <label class="btn primary">Pilih file Excel<input id="imp-file" type="file" accept=".xlsx,.xls" style="display:none"></label>
    </div>
    <div id="imp-msg"></div>
  </div>
  <div id="imp-out"></div>`;
  $('#tpl-dl').onclick = async () => {
    const save = (u8, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([u8], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); };
    try {
      const live = a => (a || []).filter(x => !x.is_deleted && x.is_active !== false);
      const L = k => codes(k).map(r => r.code);
      const [rigs, prospects, collars] = await Promise.all([D.db.rigs.toArray(), D.db.prospects.toArray(), D.db.collars.toArray()]);
      const u8 = buildTemplate({
        site: info.site, generated: today(), holePattern: setting('hole_id_regex'), shiftHours: setting('shift_hours'), depthFactor: setting('depth_overrun_warn_factor'),
        utmZone: setting('utm_zone'), utmHemi: setting('utm_hemisphere'),
        lists: Object.fromEntries(['hole_type', 'collar_status', 'sample_type', 'sample_status', 'layer', 'shift', 'downtime_reason', 'activity'].map(k => [k, L(k)])),
        rigs: live(rigs).map(r => r.rig_id), prospects: live(prospects).map(p => p.prospect_code),
        holes: collars.filter(c => !c.is_deleted).map(c => c.hole_id).sort(),
        requiresAsbuilt: codesWithFlag('collar_status', 'requires_asbuilt').map(r => r.code), requiresTotalDepth: codesWithFlag('collar_status', 'requires_total_depth').map(r => r.code),
      });
      save(u8, `exploration_import_template_${info.site}.xlsx`);
    } catch (e) { console.error(e); toast('Template gagal dibuat: ' + (e.message || e), 'err'); }
  };
  $('#imp-file').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const X = await loadXlsxLib();
      impUi.file = file.name; impUi.withWarn = false;
      impUi.parsed = IMP.parseWorkbook(X, await file.arrayBuffer());
      renderImport();
    } catch (err) { impUi.parsed = null; $('#imp-out').innerHTML = ''; renderMsgs($('#imp-msg'), { errors: [err.message || String(err)] }); }
  };
  if (impUi.parsed) renderImport();
}

async function renderImport() {
  const parsed = impUi.parsed;
  const ictx = await importCtx();
  const res = IMP.analyze(parsed, ictx, { allow: impUi.withWarn });
  const SHEET_FORM = { COLLAR: 'collar', SURVEY: 'collar', PROGRESS: 'progress', DIST_HOUR: 'hours', SAMPLE: 'sample', ASSAY: 'sample' };
  for (const r of res) if (!canIn(SHEET_FORM[r.sheet])) for (const x of r.rows) { x.rec = null; x.warns = []; x.errors = ['Tidak punya izin input untuk form ini (diatur admin di Pengaturan > User).']; x.kind = 'invalid'; }
  const unregAll = IMP.findUnregistered(parsed, ictx);
  const unreg = unregAll.filter(u => u.kind !== 'hole'), unregH = unregAll.filter(u => u.kind === 'hole');
  const canHole = canIn('collar');
  const canReg = !!info.can_admin && !info.guest && navigator.onLine;
  const cleanCode = (v, rig) => String(v).trim().toUpperCase().replace(/\s+/g, rig ? '-' : '_').replace(rig ? /[^A-Z0-9_-]/g : /[^A-Z0-9_-]/g, '').slice(0, 30);
  const sum = IMP.summarize(res);
  const tot = k => sum.reduce((t, s) => t + s[k], 0);
  const acc = IMP.accepted(res, impUi.withWarn);
  const nAcc = Object.values(acc).reduce((t, a) => t + a.length, 0);
  const notes = [...parsed.notes, ...res.flatMap(r => [...r.errors.map(e => `${r.name}: ${e}`), ...(r.ignored.length ? [`${r.name}: kolom diabaikan: ${r.ignored.join(', ')}.`] : []), ...(r.extras.length ? [`${r.name}: kolom unsur tambahan: ${r.extras.join(', ')}.`] : [])])];
  const issues = res.flatMap(r => r.rows.filter(x => x.kind !== 'ok').map(x => ({ sheet: r.sheet, ...x })));
  if (!res.length) { $('#imp-out').innerHTML = '<div class="card"><p class="muted">Tidak ada sheet COLLAR, PROGRESS, DIST_HOUR, SURVEY, SAMPLE, atau ASSAY di file ini. Pakai template.</p></div>'; return; }
  $('#imp-out').innerHTML = `
  <div class="card"><h2>${esc(impUi.file)}</h2>
    <div class="gridwrap"><table class="grid"><thead><tr><th>Sheet</th><th>Baris</th><th>Siap</th><th>Peringatan</th><th>Ditolak</th></tr></thead><tbody>
      ${sum.map(s => `<tr><td class="c-pk">${esc(SHEET_LABEL[s.sheet])}</td><td class="c-num">${s.total}</td><td class="c-num">${s.ok}</td><td class="c-num">${s.warn || '–'}</td><td class="c-num">${s.dup + s.invalid || '–'}${s.dup ? ` <span class="muted small">(${s.dup} duplikat)</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    ${res.zone ? `<p class="muted small">Zona UTM dipakai: ${res.zone.zone}${res.zone.hemisphere} (${esc(res.zone.source)}).</p>` : ''}
    ${notes.map(n => `<div class="msg warn">${esc(n)}</div>`).join('')}
    ${!(ictx.rigs || []).length && unreg.some(u => u.kind === 'rig') ? '<div class="msg warn">Belum ada rig di HP ini. Sinkron dulu supaya rig yang sudah terdaftar di server ikut terbaca, baru daftarkan yang benar-benar baru.</div>' : ''}
    ${tot('warn') ? `<label class="chk"><input type="checkbox" id="imp-warn" ${impUi.withWarn ? 'checked' : ''}> Sertakan ${tot('warn')} baris yang hanya berperingatan</label>` : ''}
    <div class="row actions">
      <button class="btn primary" id="imp-go" ${nAcc ? '' : 'disabled'}>Import ${nAcc} baris</button>
      ${tot('dup') + tot('invalid') ? '<button class="btn" id="imp-rej">Unduh baris ditolak</button>' : ''}
    </div>
  </div>
  ${unregH.length ? `<div class="card"><h2>Hole belum ada di Collar (${unregH.length})</h2>
    <p class="muted small">Hole ini dipakai di file tetapi belum ada di data collar, jadi barisnya ditolak. ${canHole ? 'Centang untuk membuat collar kosong (tanpa koordinat), lalu lengkapi nanti di tab Collar. Pemeriksaan diulang otomatis.' : 'Hanya user dengan hak input yang bisa membuatnya.'}</p>
    <div class="gridwrap"><table class="grid" id="unregh"><thead><tr>${canHole ? '<th></th>' : ''}<th>Hole ID</th><th>Baris</th><th>Dipakai di</th>${canHole ? '<th>Tipe</th><th>Status</th>' : ''}</tr></thead><tbody>
      ${unregH.map((u, i) => { const ok = holeRegex().test(u.value), guess = (codes('hole_type').find(t => u.value.split('-').some(sg => sg === String(t.code).toUpperCase())) || codes('hole_type')[0] || {}).code,
        stDef = (codes('collar_status').find(x => u.sheets.includes('PROGRESS') ? statusClassOf(x.code) === 'coh' && !metaOf('collar_status', x.code).hide_from_progress : statusClassOf(x.code) === 'planned') || codes('collar_status')[0] || {}).code;
        return `<tr data-i="${i}">${canHole ? `<td class="c-bool"><input type="checkbox" class="h-on" ${ok ? 'checked' : 'disabled'}></td>` : ''}<td class="c-pk">${esc(u.value)}${ok ? '' : ' <span class="muted small">(format ID tidak valid)</span>'}</td><td class="c-num">${u.count}</td><td>${esc(u.sheets.map(x => SHEET_LABEL[x]).join(', '))}</td>${canHole ? `<td><select class="h-type">${codes('hole_type').map(t => `<option value="${esc(t.code)}" ${t.code === guess ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></td><td><select class="h-st">${codes('collar_status').map(t => `<option value="${esc(t.code)}" ${t.code === stDef ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></td>` : ''}</tr>`; }).join('')}
    </tbody></table></div>
    ${canHole ? '<div class="row actions"><button class="btn primary" id="h-go">Buat collar untuk yang dicentang</button></div><div id="h-msg"></div>' : ''}</div>` : ''}
  ${unreg.length ? `<div class="card"><h2>Belum terdaftar (${unreg.length})</h2>
    <p class="muted small">Nilai ini ada di file tapi belum terdaftar di site, jadi barisnya ditolak. ${canReg ? 'Centang yang mau didaftarkan (kode dan nama boleh diubah), lalu daftarkan. Pemeriksaan diulang otomatis.' : 'Hanya admin yang online yang bisa mendaftarkan. Minta site admin mendaftarkannya di Pengaturan, atau perbaiki penulisannya di file.'}</p>
    <div class="gridwrap"><table class="grid" id="unreg"><thead><tr>${canReg ? '<th></th>' : ''}<th>Jenis</th><th>Di file</th><th>Baris</th>${canReg ? '<th>Kode</th><th>Nama</th>' : ''}</tr></thead><tbody>
      ${unreg.map((u, i) => `<tr data-i="${i}">${canReg ? '<td class="c-bool"><input type="checkbox" class="u-on" checked></td>' : ''}<td>${esc(u.kind === 'rig' ? 'Rig' : u.kind === 'prospect' ? 'Prospect' : IMP.LIST_TITLE[u.list] || u.list)}</td><td class="c-pk">${esc(u.value)}</td><td class="c-num">${u.count}</td>${canReg ? `<td><input class="u-code" value="${esc(cleanCode(u.value, u.kind === 'rig'))}"></td><td><input class="u-name" value="${esc(u.value)}"></td>` : ''}</tr>`).join('')}
    </tbody></table></div>
    ${canReg ? '<div class="row actions"><button class="btn primary" id="u-go">Daftarkan terpilih</button></div><div id="u-msg"></div>' : ''}</div>` : ''}
  ${issues.length ? `<div class="card"><h2>Perlu dicek (${issues.length})</h2>
    ${issues.slice(0, 150).map(x => `<div class="item"><div><b>${esc(SHEET_LABEL[x.sheet])} baris ${x.row}</b>${x.errors.map(m => `<div class="msg err">${esc(m)}</div>`).join('')}${x.warns.map(m => `<div class="msg warn">${esc(m)}</div>`).join('')}</div></div>`).join('')}
    ${issues.length > 150 ? `<p class="muted small">${issues.length - 150} baris lain tidak ditampilkan. Unduh baris ditolak untuk daftar lengkap.</p>` : ''}</div>` : ''}`;
  const hg = $('#h-go');
  if (hg) hg.onclick = async () => {
    const recs = [...document.querySelectorAll('#unregh tbody tr')].filter(tr => tr.querySelector('.h-on')?.checked).map(tr => ({ id: crypto.randomUUID(), hole_id: unregH[+tr.dataset.i].value, hole_type: tr.querySelector('.h-type').value, prospect: null, status: tr.querySelector('.h-st').value,
      planned_lat: null, planned_lon: null, planned_elev: null, planned_depth_m: null, asbuilt_lat: null, asbuilt_lon: null, asbuilt_elev: null, gps_accuracy_m: null, total_depth_m: null, photo_path: null, remarks: 'Dibuat dari import Excel, lengkapi data collar', dip_deg: null, azimuth_deg: null, is_deleted: false }));
    if (!recs.length) { $('#h-msg').innerHTML = '<div class="msg warn">Centang minimal satu.</div>'; return; }
    hg.disabled = true;
    try { await D.saveMany('collars', recs); S.syncSoon(300); toast(`${recs.length} collar dibuat (lengkapi di tab Collar)`); renderImport(); }
    catch (err) { $('#h-msg').innerHTML = `<div class="msg err">${esc(err.message || err)}</div>`; hg.disabled = false; }
  };
  const ug = $('#u-go');
  if (ug) ug.onclick = async () => {
    const todo = [...document.querySelectorAll('#unreg tbody tr')].filter(tr => tr.querySelector('.u-on').checked).map(tr => ({ u: unreg[+tr.dataset.i], code: tr.querySelector('.u-code').value.trim(), name: tr.querySelector('.u-name').value.trim() }));
    if (!todo.length) { $('#u-msg').innerHTML = '<div class="msg warn">Centang minimal satu.</div>'; return; }
    const bad = todo.find(t => !t.code || !t.name); if (bad) { $('#u-msg').innerHTML = `<div class="msg err">Kode dan nama wajib diisi (${esc(bad.u.value)}).</div>`; return; }
    ug.disabled = true;
    try {
      const c = S.getClient(), chk = r => { if (r.error) throw new Error(r.error.message); };
      for (const { u, code, name } of todo) {
        if (u.kind === 'rig') chk(await c.from('exp_rig').upsert({ rig_id: code, rig_name: name, is_active: true }, { onConflict: 'rig_id', ignoreDuplicates: true }));
        else if (u.kind === 'prospect') chk(await c.from('exp_prospect').upsert({ prospect_code: code, prospect_name: name, is_active: true }, { onConflict: 'prospect_code' }));
        else { const so = Math.max(0, ...codes(u.list).map(x => x.sort_order || 0)) + 10;
          chk(await c.from('exp_code_list').upsert({ list_code: u.list, code, label: name, sort_order: so, is_active: true, meta: {}, description: 'Ditambah dari import Excel' }, { onConflict: 'list_code,code' })); }
      }
      await S.syncNow(); await loadCfg();
      toast(`${todo.length} nilai didaftarkan`); renderImport();
    } catch (err) { $('#u-msg').innerHTML = `<div class="msg err">${esc(err.message || err)}</div>`; ug.disabled = false; }
  };
  const w = $('#imp-warn'); if (w) w.onchange = () => { impUi.withWarn = w.checked; renderImport(); };
  const rej = $('#imp-rej');
  if (rej) rej.onclick = () => {
    const sheets = res.map(r => {
      const bad = r.rows.filter(x => x.kind === 'dup' || x.kind === 'invalid');
      const p = parsed.sheets[r.sheet];
      return bad.length ? { name: p.name, header: [...p.head, 'REASON'], rows: bad.map(x => { const cells = p.rows.find(q => q.row === x.row).cells; return [...p.head.map((_, i) => cells[i] ?? null), x.errors.join(' | ')]; }) } : null;
    }).filter(Boolean);
    const blob = new Blob([buildXlsx(sheets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `ditolak_${impUi.file.replace(/\.[^.]+$/, '')}.xlsx`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  };
  $('#imp-go').onclick = async () => {
    const refused = tot('dup') + tot('invalid') + (impUi.withWarn ? 0 : tot('warn'));
    if (refused && !await ui.confirm(`${refused} baris tidak ikut diimport (ditolak atau menunggu persetujuan). Lanjut import ${nAcc} baris?`)) return;
    $('#imp-go').disabled = true;
    try {
      for (const sheet of IMP.SHEET_ORDER) if (acc[sheet]?.length) await D.saveMany(IMP.TABLE_OF[sheet], acc[sheet]);
      impUi.parsed = null; S.syncSoon(300);
      $('#imp-out').innerHTML = `<div class="card"><div class="msg ok">Selesai: ${nAcc} baris disimpan di HP dan dikirim ke server saat online.${refused ? ` ${refused} baris tidak diimport.` : ''}</div></div>`;
      toast('Import selesai');
    } catch (err) { toast(err.message || String(err), 'err'); $('#imp-go').disabled = false; }
  };
}

/* ---------- Peta ---------- */
async function viewMap() {
  $('#view').innerHTML = '<div class="card" style="padding:0;overflow:hidden"><div id="map"></div></div><div id="mapnote"></div>';
  await showMap($('#map'), $('#mapnote'), { info, canAdmin: !!info.can_admin });
  {
    $('#view').insertAdjacentHTML('beforeend', '<details class="card" id="mlm"><summary><b>Tambah / kelola layer peta (hanya di perangkat ini)</b><span class="chev" aria-hidden="true"></span></summary><div id="mlm-box" style="margin-top:10px"></div></details>');
    const refreshMap = () => showMap($('#map'), $('#mapnote'), { info, canAdmin: true });
    $('#mlm').addEventListener('toggle', () => { if ($('#mlm').open && !$('#mlm-box').innerHTML) viewMapLayers($('#mlm-box'), toast, info, refreshMap); });
  }
}

/* ---------- Data Records ---------- */
let listRefs = {};
async function viewList() {
  const [prog, col, dist, sv, sm, as] = await Promise.all([
    D.db.progress.filter(p => !p.is_deleted).toArray(),
    D.db.collars.filter(c => !c.is_deleted).toArray(),
    D.db.disthours.filter(x => !x.is_deleted).toArray(),
    D.db.surveys.filter(x => !x.is_deleted).toArray(),
    D.db.samples.filter(x => !x.is_deleted).toArray(),
    D.db.assays.filter(x => !x.is_deleted).toArray(),
  ]);
  const ob = await D.db.outbox.toArray();
  const st = await syncState();
  const dOf = r => (r.updated_at || '').slice(0, 10);
  // every record of every form as one row: Form, date, hole, rig, detail, status, sync
  const FORM_LAB = { progress: 'Drilling Progress', collars: 'Collar', disthours: 'Distribution Hour', surveys: 'Survey', samples: 'Sample', assays: 'Assay' };
  const comb = [
    ...prog.map(r => ({ _tbl: 'progress', id: r.id, date: r.work_date, hole: r.hole_id, rig: r.rig_id, detail: `${r.from_m}–${r.to_m} m${r.layer ? ' · ' + labelOf('layer', r.layer) : ''} · ${labelOf('shift', r.shift)}`, status: '', _sync: st('progress', r) })),
    ...col.map(r => ({ _tbl: 'collars', id: r.id, date: dOf(r), hole: r.hole_id, rig: '', detail: `${labelOf('hole_type', r.hole_type)}${r.prospect ? ' · ' + r.prospect : ''}${r.total_depth_m != null ? ' · TD ' + r.total_depth_m + ' m' : ''}`, status: labelOf('collar_status', r.status), _sync: st('collars', r) })),
    ...dist.map(r => ({ _tbl: 'disthours', id: r.id, date: r.work_date, hole: '', rig: r.rig_id, detail: `${t5(r.from_time)}–${t5(r.to_time)} · ${labelOf('activity', r.activity)} (${fmtH(hoursOf(r))} jam)`, status: '', _sync: st('disthours', r) })),
    ...sv.map(r => ({ _tbl: 'surveys', id: r.id, date: r.survey_date || dOf(r), hole: r.hole_id, rig: '', detail: `${r.depth_m} m · dip ${r.dip_deg}° · az ${r.azimuth_deg}°${r.method ? ' · ' + r.method : ''}`, status: '', _sync: st('surveys', r) })),
    ...sm.map(r => ({ _tbl: 'samples', id: r.id, date: r.sampled_date || dOf(r), hole: r.hole_id, rig: '', detail: `${r.sample_no} · ${r.from_m}–${r.to_m} m · ${labelOf('sample_type', r.sample_type)}`, status: labelOf('sample_status', r.status), _sync: st('samples', r) })),
    ...as.map(r => ({ _tbl: 'assays', id: r.id, date: dOf(r), hole: r.hole_id || '', rig: '', detail: `${r.from_m != null ? `${r.from_m}–${r.to_m} m` : r.sample_type}${r.sample_no ? ' · ' + r.sample_no : ''} · Ni ${r.ni_pct ?? '–'} · Fe ${r.fe_pct ?? '–'}`, status: '', _sync: st('assays', r) })),
  ];
  const combCols = [
    { k: '_tbl', label: 'Form', type: 'enum', get: r => r._tbl, lab: v => FORM_LAB[v] || v }, DT('date', 'Tanggal / update', r => r.date), T('hole', 'Hole ID', r => r.hole, { cls: 'c-pk' }),
    E('rig', 'Rig', r => r.rig), T('detail', 'Detail', r => r.detail), E('status', 'Status', r => r.status), SYNC];
  $('#view').innerHTML = `
  <div class="card"><h2>Data Records</h2>
    <p class="muted small">Data di HP ini: collar ${col.length}, progress ${prog.length}, jam rig ${dist.length}${sv.length || sm.length || as.length ? `, survey ${sv.length}, sample ${sm.length}, assay ${as.length}` : ''}. Termasuk data dari server setelah login dan sinkron. Tiap daftar bisa dilipat (tanda v), dicari, difilter per kolom, dan diurutkan dengan mengetuk judul kolom.</p>
  </div>
  <div id="r-all"></div>
  ${['progress', 'collars', 'disthours', 'surveys', 'samples', 'assays'].map(k => `<div id="r-${k}"></div>`).join('')}
  <div class="card"><h2>Backup ke Excel</h2>
    <p class="muted small">Salinan data di HP sebagai file .xlsx. Simpan atau kirim ke site admin bila lama tidak ada internet. Foto tidak ikut; foto tetap di HP sampai terkirim.</p>
    <div class="row actions one-line"><button class="btn primary" id="x-pend" ${ob.length ? '' : 'disabled'}>Unduh yang belum terkirim (${ob.length})</button><button class="btn" id="x-all">Unduh semua</button></div>
  </div>
  <div class="card"><h2>Backup foto (zip)</h2>
    <p class="muted small">Semua foto collar dan core dalam satu file .zip (folder collar/ dan core/). Ikut filter di daftar Drilling Progress dan Collar di atas. Foto yang hanya ada di server diunduh dulu, jadi perlu internet.</p>
    <div class="row actions"><button class="btn primary" id="x-photo">Unduh foto (.zip)</button></div><p class="muted small" id="x-photo-msg"></p>
  </div>`;
  listRefs = {};
  recordList($('#r-all'), { id: 'd:all', title: 'Semua data', rows: comb, cols: combCols, sort: { k: 'date', dir: -1 }, open: true,
    onOpen: r => openRecord(r._tbl, r.id), canOpen: r => !!FORM_OF[r._tbl] && canIn(FORM_OF[r._tbl]) });
  const sorts = { progress: { k: 'work_date', dir: -1 }, collars: { k: 'hole_id', dir: 1 }, disthours: { k: 'work_date', dir: -1 }, surveys: { k: 'hole_id', dir: 1 }, samples: { k: 'hole_id', dir: 1 }, assays: { k: 'hole_id', dir: 1 } };
  const data = { progress: prog, collars: col, disthours: dist, surveys: sv, samples: sm, assays: as };
  for (const k of Object.keys(data)) {
    const form = FORM_OF[k];
    listRefs[k] = recordList($(`#r-${k}`), { id: `d:${k}`, title: FORM_LAB[k], rows: decorate(k, data[k], st), cols: REC_COLS[k], sort: sorts[k], open: false,
      onOpen: form ? r => openRecord(k, r.id) : null, canOpen: () => !!form && canIn(form) });
  }
  $('#x-pend').onclick = () => exportExcel(true);
  $('#x-all').onclick = () => exportExcel(false);
  $('#x-photo').onclick = () => exportPhotos($('#x-photo'), $('#x-photo-msg'));
}

async function exportPhotos(btn, msg) {
  const keep = ref => (ref ? new Set(ref.shown().map(r => r.id)) : null);
  const kc = keep(listRefs.collars), kp = keep(listRefs.progress);
  const items = [...(await D.db.collars.toArray()).filter(r => !kc || kc.has(r.id)), ...(await D.db.progress.toArray()).filter(r => !kp || kp.has(r.id))]
    .filter(r => !r.deleted_at && !r.is_deleted && r.photo_path);
  if (!items.length) { msg.textContent = 'Tidak ada foto yang cocok.'; return; }
  btn.disabled = true; const files = []; let miss = 0, i = 0;
  for (const r of items) {
    msg.textContent = `Menyiapkan foto ${++i} / ${items.length}…`;
    let blob = (await D.db.photos.get(r.id))?.blob;
    if (!blob && navigator.onLine) {
      try { const u = await S.signedPhotoUrl(r.photo_path); const res = u && await fetch(u); if (res?.ok) blob = await res.blob(); } catch { /* counted as missing */ }
    }
    if (blob) files.push({ name: r.photo_path, blob }); else miss++;
  }
  if (!files.length) { msg.textContent = 'Foto tidak bisa diambil (offline atau belum terkirim).'; btn.disabled = false; return; }
  const seen = new Set(); for (const f of files) { while (seen.has(f.name)) f.name = f.name.replace(/(\.jpg)?$/, '_2.jpg'); seen.add(f.name); }
  const zip = await makeZip(files);
  const a = document.createElement('a'); a.href = URL.createObjectURL(zip);
  a.download = `foto_${info.site}_${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  msg.textContent = `${files.length} foto diunduh${miss ? `, ${miss} tidak tersedia (offline/belum terkirim)` : ''}.`; btn.disabled = false;
}

async function exportExcel(onlyPending) {
  const ob = await D.db.outbox.toArray();
  const pend = new Map(ob.map(o => [o.key, o]));
  const sheet = async (tbl, name) => {
    const cols = S.EXPORT_COLS[tbl];
    const rows = (await D.db[tbl].toArray()).filter(r => !onlyPending || pend.has(`${tbl}:${r.id}`))
      .sort((a, b) => String(a.hole_id).localeCompare(String(b.hole_id)) || String(a.work_date || '').localeCompare(String(b.work_date || '')));
    return { name, header: [...cols, 'status_kirim', 'error'], rows: rows.map(r => { const o = pend.get(`${tbl}:${r.id}`); return [...cols.map(c => r[c] ?? null), o ? (o.err ? 'error' : 'pending') : 'synced', o?.err || '']; }) };
  };
  const [c, p, h] = [await sheet('collars', 'Collar'), await sheet('progress', 'Progress'), await sheet('disthours', 'Jam rig')];
  const extra = (await Promise.all([['surveys', 'Survey'], ['samples', 'Sample'], ['assays', 'Assay']].map(([t, n]) => sheet(t, n)))).filter(x => x.rows.length);
  if (!c.rows.length && !p.rows.length && !h.rows.length && !extra.length) return toast(onlyPending ? 'Tidak ada data yang belum terkirim.' : 'Belum ada data di HP.', 'err');
  const stamp = new Date().toLocaleString('sv-SE').replace(/[-:]/g, '').replace(' ', '-').slice(0, 13);
  const meta = { name: 'Info', header: ['item', 'nilai'], rows: [['Site', info.site], ['Pengguna', info.guest ? '(belum login)' : `${info.name} <${info.email}>`], ['Diekspor', new Date().toISOString()], ['Isi', onlyPending ? 'Hanya data yang belum terkirim' : 'Semua data di HP'], ['Kode perangkat', deviceCode()]] };
  const blob = new Blob([buildXlsx([c, p, h, ...extra, meta])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `exploration_${info.site}_${onlyPending ? 'belum-terkirim' : 'semua'}_${stamp}.xlsx`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast('File Excel diunduh');
}

/* ---------- boot ---------- */
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
  info = await S.restore();
  if (info) { D.openDb(info.site); await loadCfg(); startMain(); } else showLogin();
})();
