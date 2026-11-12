// Dashboard tabs inside the input app: "Dashboard" (this site, live from its own Supabase) and "All sites" (explohub dash views, separate login).
// Both paint the same page. Needs internet. Excel and PDF export follow the current filters.
import * as S from '../sync.js';
import { toast } from '../ui.js';
import { loadSiteData, loadChartJs } from './data.js';
import { destroyCharts, esc } from './ui.js';
import { renderPage } from './page.js';
import { destroyMap } from './map.js';
import { buildDashWorkbook, buildDashPdf } from './export.js';
import { hubReady, hubClient, hubSignIn, hubSignOut, hubMember, loadHubData } from './hub.js';

const mk = hub => ({ site: null, data: null, loadedAt: 0, prospect: '', rig: '', siteSel: '', period: 'daily', hub, member: null });
const st = mk(false), hubSt = mk(true);
const STALE_MS = 2 * 60 * 1000;

const reset = s => { s.data = null; s.site = null; s.prospect = s.rig = s.siteSel = ''; s.period = 'daily'; s.member = null; };
export function resetDash() { reset(st); destroyCharts(); destroyMap(); }
export async function resetHub() { reset(hubSt); if (hubReady()) await hubSignOut(); destroyCharts(); destroyMap(); }

const card = (h, body) => `<div class="dash"><div class="card"><h2>${h}</h2>${body}</div></div>`;
const errCard = (title, e, retryId) => card(title, `<div class="msg err">${esc(e?.message || e)}</div>
  ${/permission denied/i.test(e?.message || '') ? '<p class="muted small">"permission denied for table" means the database refused the role, not the row. Either the request ran without a login (session lost), or the table has no SELECT grant for the authenticated role at this site. Ask the database admin to check the grants (docs: Troubleshooting).</p>' : ''}
  <div class="row actions"><button class="btn" id="${retryId}">Try again</button></div>`);

export async function viewDash(root) {
  const info = S.getInfo();
  const mine = root.dataset.tab;   // tab key at call time: drop late results if the user switched tab meanwhile
  destroyCharts();
  root.innerHTML = '<div class="dash"><div class="card"><p class="muted">Loading dashboard...</p></div></div>';
  if (!navigator.onLine) {
    root.innerHTML = card('Dashboard needs internet', '<div class="msg warn">The dashboard reads live data from the site database. Input and sync keep working offline.</div>');
    return;
  }
  const sb = S.getClient();
  if (!sb || info.guest) { root.innerHTML = card('', '<div class="msg warn">Log in to see the dashboard.</div>'); return; }
  try {
    const { data: sess } = await sb.auth.getSession();
    if (!sess?.session) throw new Error('Your login session has expired. Sign out, then sign in again while online.');
    await loadChartJs();
    if (st.site !== info.site) resetDash();
    if (!st.data || Date.now() - st.loadedAt > STALE_MS) {
      st.data = await loadSiteData(sb, info.site); st.site = info.site; st.loadedAt = Date.now();
    }
  } catch (e) {
    if (root.dataset.tab !== mine) return;
    root.innerHTML = errCard('Dashboard could not load', e, 'd-retry');
    root.querySelector('#d-retry').onclick = () => viewDash(root);
    return;
  }
  if (root.dataset.tab !== mine) return;
  paint(root, st);
}

// All sites (explohub). Needs HUB.url + HUB.anon in js/config.js and an explohub account listed in dash.member.
export async function viewHub(root) {
  const mine = root.dataset.tab;
  destroyCharts();
  if (!hubReady()) { root.innerHTML = card('All sites is not set up', '<div class="msg warn">Put the explohub project URL and anon key in <code>HUB</code> in js/config.js (docs: section 3.15), then reload.</div>'); return; }
  if (!navigator.onLine) { root.innerHTML = card('All sites needs internet', '<div class="msg warn">It reads the explohub database. Input and sync keep working offline.</div>'); return; }
  root.innerHTML = '<div class="dash"><div class="card"><p class="muted">Loading all sites...</p></div></div>';
  try {
    await loadChartJs();
    const sb = hubClient();
    const { data: sess } = await sb.auth.getSession();
    if (!sess?.session) { if (root.dataset.tab === mine) hubLogin(root); return; }
    if (!hubSt.data || Date.now() - hubSt.loadedAt > STALE_MS) {
      hubSt.member = await hubMember(sb);
      if (!hubSt.member) { if (root.dataset.tab === mine) notMember(root); return; }
      hubSt.data = await loadHubData(sb); hubSt.loadedAt = Date.now();
    }
  } catch (e) {
    if (root.dataset.tab !== mine) return;
    root.innerHTML = errCard('All sites could not load', e, 'd-retry');
    root.querySelector('#d-retry').onclick = () => viewHub(root);
    return;
  }
  if (root.dataset.tab !== mine) return;
  paint(root, hubSt);
}

function hubLogin(root, msg = '', email = '') {
  root.innerHTML = card('All sites: sign in', `<p class="muted">Sign in with your explohub account (not the site login). Access is limited to the sites listed for you.</p>
    <form id="h-form" class="stack" style="max-width:22rem"><label>Email<input id="h-email" type="email" autocomplete="username" value="${esc(email)}" required></label>
    <label>Password<input id="h-pw" type="password" autocomplete="current-password" required></label>
    ${msg ? `<div class="msg err">${esc(msg)}</div>` : ''}<div class="row actions"><button class="btn primary" id="h-go" type="submit">Sign in</button></div></form>`);
  root.querySelector('#h-form').onsubmit = async e => {
    e.preventDefault(); const b = root.querySelector('#h-go'); b.disabled = true;
    const em = root.querySelector('#h-email').value.trim();
    const err = await hubSignIn(em, root.querySelector('#h-pw').value);
    if (err) hubLogin(root, err, em); else viewHub(root);
  };
}
function notMember(root) {
  root.innerHTML = card('No access to All sites', `<div class="msg warn">This explohub account is not an active dashboard member. Ask the database admin to add it to <code>dash.member</code> (hub_05_dash_access.sql).</div>
    <div class="row actions"><button class="btn" id="h-out">Sign out</button></div>`);
  root.querySelector('#h-out').onclick = async () => { await resetHub(); hubLogin(root); };
}

const download = (name, blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
const stamp = () => new Date().toISOString().slice(0, 10);

function paint(root, s) {
  destroyCharts();
  const f = { sites: s.hub && s.siteSel ? new Set([s.siteSel]) : null, prospect: s.prospect || null, rig: s.rig || null };
  const age = Math.round((Date.now() - s.loadedAt) / 60000);
  const label = s.hub ? `Explohub, ${s.member?.sites ? s.member.sites.join(', ') : 'all sites'}` : `Live from ${s.site}`;
  const name = s.hub ? 'all-sites' : s.site;
  root.innerHTML = `<div class="dash"><div class="dash-bar"><span class="chip good">${esc(label)}${age ? ` · ${age} min ago` : ''}</span>
    <span class="row" style="gap:.4rem"><button class="btn small" id="d-xlsx">Excel</button><button class="btn small" id="d-pdf">PDF</button><button class="btn small" id="d-refresh">Refresh</button>${s.hub ? '<button class="btn small" id="d-out">Sign out</button>' : ''}</span></div><div id="d-body"></div></div>`;
  renderPage(root.querySelector('#d-body'), s.data, f, s);
  const on = (id, fn) => { const el = root.querySelector('#' + id); if (el) el.onchange = fn; };
  on('fSite', e => { s.siteSel = e.target.value; s.prospect = s.rig = ''; paint(root, s); });
  on('fProspect', e => { s.prospect = e.target.value; paint(root, s); });
  on('fRig', e => { s.rig = e.target.value; paint(root, s); });
  const per = root.querySelector('#period');
  if (per) per.onclick = e => { const v = e.target.dataset.period; if (v) { s.period = v; paint(root, s); } };
  const rs = root.querySelector('#fReset');
  if (rs) rs.onclick = () => { s.prospect = s.rig = s.siteSel = ''; s.period = 'daily'; paint(root, s); };
  root.querySelector('#d-refresh').onclick = () => { s.data = null; (s.hub ? viewHub : viewDash)(root); };
  const out = root.querySelector('#d-out');
  if (out) out.onclick = async () => { await resetHub(); hubLogin(root); };
  root.querySelector('#d-xlsx').onclick = () => {
    try { download(`exploration_dashboard_${name}_${stamp()}.xlsx`, new Blob([buildDashWorkbook(s.data, f, { period: s.period, hub: s.hub })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); }
    catch (e) { toast('Excel export failed: ' + (e.message || e), 'err'); }
  };
  root.querySelector('#d-pdf').onclick = async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'PDF...';
    try { const pdf = await buildDashPdf(s.data, f, s, { title: s.hub ? 'Exploration Dashboard (all sites)' : `Exploration Dashboard ${s.site}` }); download(`exploration_dashboard_${name}_${stamp()}.pdf`, pdf.output('blob')); }
    catch (err) { toast('PDF export failed: ' + (err.message || err), 'err'); }
    paint(root, s);          // the export redraws charts off screen; repaint the visible ones
  };
}
