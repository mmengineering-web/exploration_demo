// Writes tests/stub_supabase.mjs: an ES module standing in for the supabase-js CDN build, serving the fake dataset.
import { fake } from './fake.js';
import fs from 'node:fs';
const r = fake();
r.exp_role_def = [{ role: 'geologist', label: 'Geologist', can_write: true, can_admin: false, can_super: false, is_active: true },
                  { role: 'viewer', label: 'Viewer', can_write: false, can_admin: false, can_super: false, is_active: true }];
r.exp_profile = [{ full_name: 'Test User', role: 'geologist', is_active: true, input_forms: null }];
// explohub dash views: the same fake rows tagged with a site, plus a second site so the Site filter has something to switch
const tagS = (a, site = 'WKM') => a.map(x => ({ site_code: site, ...x }));
r.dash_collar = [...tagS(r.exp_collar), { site_code: 'BM', id: 'bm-1', hole_id: 'BM-DD-0001', hole_type: 'DD', prospect: 'B1', status: 'completed', planned_depth_m: 20, total_depth_m: 20, asbuilt_lat: -2.9, asbuilt_lon: 121.3 }];
r.dash_drill_progress = [...tagS(r.exp_drill_progress), { site_code: 'BM', id: 'bm-p1', work_date: '2025-10-18', shift: 'DAY', rig_id: 'R1', hole_id: 'BM-DD-0001', from_m: 0, to_m: 8, meters: 8 }];
r.dash_dist_hour = tagS(r.exp_dist_hour); r.dash_sample = tagS(r.exp_sample); r.dash_weekly_plan = tagS(r.exp_weekly_plan); r.dash_prospect = tagS(r.exp_prospect); r.dash_code_list = tagS(r.exp_code_list);
r.dash_rig = [...tagS(r.exp_rig), { site_code: 'BM', rig_id: 'R1', rig_name: 'Rig 1', rig_type: 'DD', is_active: true }];
r.dash_site_status = [{ site_code: 'WKM', last_ok_at: '2026-11-12T01:00:00Z', hours_since_ok: 2.5, latest_progress_date: '2025-10-19', collars: 4, progress_rows: 14, samples: 2, assay_rows: 7, has_error: false }, { site_code: 'BM', last_ok_at: null, hours_since_ok: null, latest_progress_date: '2025-10-18', collars: 1, progress_rows: 1, samples: 0, assay_rows: 0, has_error: true }];
const js = `const DATA = ${JSON.stringify(r)};
export function createClient(url, key, opts) {
  const sk = 'fake-' + (opts?.auth?.storageKey || 'x');
  let session = null; try { session = JSON.parse(localStorage.getItem(sk)); } catch {}
  const chain = table => {
    let rows = DATA[table] || [];
    if (table === 'exp_profile' && window.__role) rows = [{ ...rows[0], role: window.__role }];
    if (table === 'exp_role_def' && window.__role) rows = rows.filter(x => x.role === window.__role);
    if (table === 'exp_profile' && window.__noProfile) rows = [];
    if (window.__failTable === table) { const q = {}; q.then = (a, b) => Promise.resolve({ data: null, error: { message: 'permission denied for table ' + table } }).then(a, b); for (const m of ['select','eq','order','range','gte']) q[m] = () => q; return q; }
    const q = {};
    q.then = (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej);
    for (const m of ['select','eq','neq','order','gte','gt','lt','lte','in','limit','is','match','filter']) q[m] = () => q;
    q.range = (a, b) => { rows = rows.slice(a, b + 1); return q; };
    q.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    q.single = q.maybeSingle;
    for (const m of ['upsert','update','insert','delete']) q[m] = () => q;
    window.__calls = (window.__calls || []).concat(table);
    return q;
  };
  return {
    auth: {
      async signInWithPassword({ email, password }) { if (password !== 'good') return { data: null, error: { message: 'Invalid login credentials' } }; session = { user: { id: 'u1', email } }; localStorage.setItem(sk, JSON.stringify(session)); return { data: { user: session.user, session }, error: null }; },
      async getSession() { return { data: { session } }; },
      async getUser() { return { data: { user: session?.user ?? null } }; },
      async signOut() { session = null; localStorage.removeItem(sk); return {}; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: chain,
    schema: sc => ({ from: t => chain(sc === 'dash' ? 'dash_' + t : t),
      rpc: async fn => ({ data: fn === 'me' ? (window.__hubNoMember ? [] : [{ email: 'geo@x', role: 'viewer', sites: null }]) : null, error: null }) }),
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: { signedUrl: '' }, error: null }), remove: async () => ({}) }) },
  };
}
`;
fs.writeFileSync(new URL('./stub_supabase.mjs', import.meta.url), js);
