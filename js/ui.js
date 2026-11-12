// Design-system runtime: theme, toast, confirm dialog, bottom sheet, empty state, skeleton.
// Styles live in css/ds/*.css. Nothing here knows about drilling data.
import { icon } from './icons.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- theme: system by default, user choice is remembered per device ---------- */
const KEY = 'exp_theme';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set();
export const theme = {
  pref() { try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; } },
  resolved() { const p = this.pref(); return p === 'system' ? (mq?.matches ? 'dark' : 'light') : p; },
  apply() {
    const r = this.resolved();
    document.documentElement.dataset.theme = r;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', r === 'dark' ? '#0a0a0a' : '#ffffff');
    listeners.forEach(f => f(r));
    return r;
  },
  set(p) { try { p === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, p); } catch {} return this.apply(); },
  toggle() { return this.set(this.resolved() === 'dark' ? 'light' : 'dark'); },
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
};
mq?.addEventListener?.('change', () => { if (theme.pref() === 'system') theme.apply(); });
export const themeButtonHtml = () => `<button class="btn ghost icon small" id="b-theme" type="button" aria-label="Ganti tema terang/gelap" title="Ganti tema">${icon(theme.resolved() === 'dark' ? 'sun' : 'moon')}</button>`;
export function bindThemeButton(root = document) {
  const b = root.querySelector('#b-theme'); if (!b) return;
  const paint = () => { b.innerHTML = icon(theme.resolved() === 'dark' ? 'sun' : 'moon'); };
  b.onclick = () => { theme.toggle(); paint(); };
  theme.onChange(paint);
}

/* ---------- toast (ARIA live region) ---------- */
let toastTimer;
export function toast(msg, kind = 'ok') {
  const t = document.getElementById('toast'); if (!t) return;
  t.innerHTML = `${icon(kind === 'err' ? 'circle-alert' : 'circle-check')}<span>${esc(msg)}</span>`;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, kind === 'err' ? 6000 : 3500);
}

/* ---------- overlay base: Esc and backdrop close, focus returns to the opener ---------- */
function overlay(inner, { sheet = false, label = '' } = {}) {
  const prev = document.activeElement;
  const ov = document.createElement('div');
  ov.className = 'ui-overlay' + (sheet ? ' sheet' : '');
  ov.innerHTML = `<div class="ui-dialog" role="dialog" aria-modal="true" aria-label="${esc(label)}">${sheet ? '<div class="ui-grabber"></div>' : ''}${inner}</div>`;
  document.body.appendChild(ov);
  const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
  let done = false;
  const close = v => { if (done) return; done = true; document.removeEventListener('keydown', onKey, true); document.body.style.overflow = prevOverflow; ov.remove(); try { prev?.focus?.(); } catch {} ov._resolve?.(v); };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(false); }
    if (e.key === 'Tab') {                                    // keep focus inside the dialog
      const f = [...ov.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent !== null);
      if (!f.length) return; const a = f[0], z = f.at(-1);
      if (e.shiftKey && document.activeElement === a) { z.focus(); e.preventDefault(); } else if (!e.shiftKey && document.activeElement === z) { a.focus(); e.preventDefault(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(false); });
  return { ov, close, dialog: ov.firstElementChild };
}

/* ---------- confirm dialog: replaces window.confirm. await ui.confirm(text, { title, ok, cancel, danger }) -> boolean ---------- */
export function confirm(message, { title = 'Konfirmasi', ok = 'Lanjut', cancel = 'Batal', danger = false } = {}) {
  return new Promise(res => {
    const { ov, close, dialog } = overlay(`<h2>${esc(title)}</h2><p class="ui-body">${esc(message)}</p>
      <div class="ui-foot"><button class="btn" data-no type="button">${esc(cancel)}</button><button class="btn primary${danger ? ' danger solid' : ''}" data-yes type="button">${esc(ok)}</button></div>`, { label: title });
    ov._resolve = res;
    dialog.querySelector('[data-no]').onclick = () => close(false);
    const y = dialog.querySelector('[data-yes]'); y.onclick = () => close(true); y.focus();
  });
}

/* ---------- bottom sheet: ui.sheet(html, { title, onMount(el, close) }) ---------- */
export function sheet(html, { title = '', onMount } = {}) {
  const { close, dialog } = overlay(`${title ? `<h2>${esc(title)}</h2>` : ''}${html}`, { sheet: true, label: title });
  onMount?.(dialog, close);
  return close;
}

/* ---------- empty + skeleton blocks ---------- */
export const empty = (ic, title, text = '') => `<div class="empty">${icon(ic)}<b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
export const skeleton = (n = 3) => `<div class="card" aria-busy="true" aria-label="Memuat">${Array.from({ length: n }, (_, i) => `<span class="skeleton" style="width:${i === 0 ? 40 : 90 - i * 12}%;margin-bottom:.75rem"></span>`).join('')}</div>`;
