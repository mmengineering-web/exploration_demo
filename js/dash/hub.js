// All-sites dashboard data: reads the explohub `dash` views (read-only, filtered per person by dash.my_sites()).
// Separate login (explohub account listed in dash.member), separate session storage, never mixed with the site login.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { HUB } from '../config.js';
import { fetchAll, normalizeSiteData } from './data.js';

let client = null;
export const hubReady = () => !!(HUB?.url && HUB?.anon);
export function hubClient() {
  if (!client) client = createClient(HUB.url, HUB.anon, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'exp_hub_auth' } });
  return client;
}
export async function hubSignIn(email, password) {
  const { error } = await hubClient().auth.signInWithPassword({ email, password });
  return error ? error.message : null;
}
export async function hubSignOut() { try { await hubClient().auth.signOut(); } catch {} }

// null when the account is not an active dash.member
export async function hubMember(sb) {
  const { data, error } = await sb.schema('dash').rpc('me');
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data[0] ?? null : data ?? null;
}

export async function loadHubData(sb) {
  const dash = sb.schema('dash');
  const q = (t, ...ord) => () => ord.reduce((x, o) => x.order(o), dash.from(t).select('*'));
  const [collar, progress, dist, sample, plan, rigs, prospects, codes, status] = await Promise.all([
    fetchAll(q('collar', 'id')), fetchAll(q('drill_progress', 'id')), fetchAll(q('dist_hour', 'id')), fetchAll(q('sample', 'id')), fetchAll(q('weekly_plan', 'id')),
    fetchAll(q('rig', 'site_code', 'rig_id')), fetchAll(q('prospect', 'site_code', 'prospect_code')), fetchAll(q('code_list', 'site_code', 'list_code', 'code')),
    fetchAll(q('site_status', 'site_code')).catch(() => []),
  ]);
  // rig ids repeat across sites (R1, R2...): prefix them so every rig stays its own bar
  const rid = r => ({ ...r, rig_id: `${r.site_code}:${r.rig_id}` });
  const d = { collar, progress: progress.map(rid), dist: dist.map(rid), sample, plan,
    rigs: rigs.map(r => ({ ...rid(r), rig_name: `${r.site_code} ${r.rig_name}` })), prospects, codes, status, loadedAt: new Date() };
  return normalizeSiteData(d);
}
