// Auth + sync (outbox push, config/reference/plan pull). Satu client Supabase per site.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SITES, PHOTO_BUCKET } from './config.js';
import * as D from './db.js';
import { loadCfg, setting } from './cfg.js';

const COLLAR_COLS = ['id','hole_id','hole_type','prospect','status','planned_lat','planned_lon','planned_elev',
  'planned_depth_m','asbuilt_lat','asbuilt_lon','asbuilt_elev','gps_accuracy_m','total_depth_m','photo_path',
  'remarks','dip_deg','azimuth_deg','is_deleted','updated_at'];
const PROGRESS_COLS = ['id','work_date','shift','rig_id','hole_id','from_m','to_m','downtime_hours',
  'downtime_reason','core_len_m','remarks','photo_path','layer','is_deleted','updated_at'];
const DIST_COLS = ['id','work_date','rig_id','from_time','to_time','activity','fuel_l','polymer_l','oil_hyd_l','remarks','is_deleted','updated_at'];
const SURVEY_COLS = ['id','hole_id','depth_m','dip_deg','azimuth_deg','method','survey_date','remarks','is_deleted','updated_at'];
const SAMPLE_COLS = ['id','sample_no','hole_id','from_m','to_m','sample_type','status','sampled_date','sent_date','lab','batch_id','remarks','is_deleted','updated_at'];
const ASSAY_COLS = ['id','hole_id','from_m','to_m','sample_no','layer','ni_pct','co_pct','fe_pct','mgo_pct','sio2_pct','extra','sample_type','batch_id','lab',
  'certificate_no','crm_name','crm_element','crm_expected','duplicate_type','duplicate_of_sample_no','source_type','source_file','remarks','is_deleted','updated_at',
  'lab_seq','client_ref','received_date','tested_date','reported_date'];
const COLS = { collars: COLLAR_COLS, progress: PROGRESS_COLS, disthours: DIST_COLS, surveys: SURVEY_COLS, samples: SAMPLE_COLS, assays: ASSAY_COLS };
const TABLE = { collars: 'exp_collar', progress: 'exp_drill_progress', disthours: 'exp_dist_hour', surveys: 'exp_survey', samples: 'exp_sample', assays: 'exp_assay' };
const BATCH = new Set(['surveys', 'samples', 'assays']);   // imported in bulk: sent in chunks
// progress columns added by later migrations are sent only when filled, so a site that has not run them yet still syncs normal rows
const OPTIONAL = { collars: ['dip_deg', 'azimuth_deg'], progress: ['photo_path', 'core_len_m', 'layer'], disthours: ['fuel_l', 'polymer_l', 'oil_hyd_l'],
  assays: ['lab_seq', 'client_ref', 'received_date', 'tested_date', 'reported_date'] };

let client = null;
let info = null;          // {site, email, name, role, role_label, can_write, can_admin, revoked?}
let syncing = false;
let lastError = '';
const listeners = new Set();
const permListeners = new Set();

const GUEST_KEY = 'exp_guest_site';
export const getInfo = () => info;
export const isGuest = () => !!info?.guest;
export const EXPORT_COLS = COLS;
export async function signedPhotoUrl(path) {
  if (!client || !navigator.onLine || !path) return null;
  try { const { data, error } = await client.storage.from(PHOTO_BUCKET).createSignedUrl(path, 300); return error ? null : data.signedUrl; } catch { return null; }
}

// "No login" mode: the user picked a site but has not logged in (no internet, or simply not yet).
// Data is saved on the phone (outbox) and is sent automatically after a normal login while online.
// A guest has no server session: nothing is read from or sent to the server until login.
export function enterGuest(site) {
  if (!SITES[site]) throw new Error(`Site ${site} tidak dikenal.`);
  localStorage.setItem(GUEST_KEY, site);
  client = null;
  info = { site, email: null, name: 'Belum login', role: 'guest', role_label: 'Mode offline', can_write: true, can_admin: false, can_super: false, guest: true };
  return info;
}
export function leaveGuest() { localStorage.removeItem(GUEST_KEY); if (info?.guest) info = null; }
export const getClient = () => client;
export const onStatus = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const onPerms = fn => { permListeners.add(fn); return () => permListeners.delete(fn); };

const isNet = e => !navigator.onLine || /fetch|network|timeout|load failed/i.test(String(e?.message || e));
const isAuth = e => e?.status === 401 || /jwt|token|not authenticated/i.test(String(e?.message || ''));

function makeClient(site) {
  const cfg = SITES[site];
  if (!cfg?.url || !cfg?.anonKey) throw new Error(`Site ${site} belum dikonfigurasi (url/anonKey di js/config.js).`);
  return createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: `sb-exp-${site}` },
  });
}

async function emit() {
  let pending = 0;
  try { pending = D.db ? await D.db.outbox.count() : 0; } catch {}
  const st = {
    pending, online: navigator.onLine, syncing, error: lastError,
    last: info ? localStorage.getItem(`exp_last_sync_${info.site}`) : null,
  };
  listeners.forEach(f => f(st));
}
export { emit as refreshStatus };

// Profil + izin dari role (role bisa diubah admin kapan saja)
async function fetchProfile(c, uid) {
  let { data: prof, error } = await c.from('exp_profile').select('full_name, role, is_active, input_forms').eq('user_id', uid).maybeSingle();
  if (error) ({ data: prof, error } = await c.from('exp_profile').select('full_name, role, is_active').eq('user_id', uid).maybeSingle());   // before migration 0012 (no input_forms column)
  if (error) throw error;
  if (!prof || !prof.is_active) return null;
  const { data: def, error: e2 } = await c.from('exp_role_def').select('*').eq('role', prof.role).maybeSingle();   // * so it still works before migration 0004 (can_super missing = false)
  if (e2) throw e2;
  if (!def || !def.is_active) return null;
  return { name: prof.full_name, role: prof.role, role_label: def.label, can_write: !!def.can_write, can_admin: !!def.can_admin, can_super: !!def.can_super,
    forms: Array.isArray(prof.input_forms) ? prof.input_forms : null };   // null = may use every form the role allows
}

function setInfo(next) {
  const changed = !info || ['can_write', 'can_admin', 'can_super', 'role', 'revoked'].some(k => info[k] !== next[k]) || JSON.stringify(info.forms ?? null) !== JSON.stringify(next.forms ?? null);
  info = next;
  localStorage.setItem('exp_session', JSON.stringify(info));
  if (changed) permListeners.forEach(f => f(info));
}

export async function login(site, email, password) {
  const c = makeClient(site);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const p = await fetchProfile(c, data.user.id);
  if (!p) { await c.auth.signOut(); throw new Error('Akun belum terdaftar/aktif di site ini, atau role-nya nonaktif. Hubungi site admin.'); }
  client = c;
  info = null;
  localStorage.removeItem(GUEST_KEY);
  setInfo({ site, email, ...p });
  return info;
}

// Dipanggil saat app dibuka (bisa offline): pakai info lokal + session tersimpan.
export async function restore() {
  const raw = localStorage.getItem('exp_session');
  if (!raw) {
    const g = localStorage.getItem(GUEST_KEY);
    return g && SITES[g] ? enterGuest(g) : null;
  }
  try {
    const s = JSON.parse(raw);
    client = makeClient(s.site);
    await client.auth.getSession();
    info = s;
    return info;
  } catch { return null; }
}

export async function logout() {
  try { await client?.auth.signOut(); } catch {}
  localStorage.removeItem('exp_session');
  localStorage.removeItem(GUEST_KEY);
  client = null; info = null;
}

async function refreshProfile() {
  const { data } = await client.auth.getSession();
  const uid = data.session?.user?.id;
  if (!uid) return;
  const p = await fetchProfile(client, uid);
  if (!p) setInfo({ ...info, can_write: false, can_admin: false, revoked: true });
  else setInfo({ ...info, ...p, revoked: false });
}

async function uploadPhoto(rec) {
  const ph = await D.db.photos.get(rec.id);
  if (!ph || ph.uploaded) return;
  const { error } = await client.storage.from(PHOTO_BUCKET).upload(rec.photo_path, ph.blob, { upsert: true, contentType: 'image/jpeg' });
  if (error) throw error;
  await D.db.photos.update(rec.id, { uploaded: true });
}

const payloadOf = (tbl, rec) => Object.fromEntries(COLS[tbl].filter(k => !((OPTIONAL[tbl] || []).includes(k) && rec[k] == null)).map(k => [k, rec[k] ?? null]));

async function pushOne(it) {
  const rec = await D.db[it.tbl].get(it.rec_id);
  if (!rec) { await D.db.outbox.delete(it.seq); return; }
  try {
    if (rec.photo_path && it.tbl !== 'disthours' && !BATCH.has(it.tbl)) await uploadPhoto(rec);
    const { error } = await client.from(TABLE[it.tbl]).upsert(payloadOf(it.tbl, rec), { onConflict: 'id' });
    if (error) throw error;
    const cur = await D.db[it.tbl].get(it.rec_id);
    if (cur && cur.updated_at === rec.updated_at) await D.db.outbox.delete(it.seq);
  } catch (e) {
    if (isNet(e) || isAuth(e)) throw e;
    await D.db.outbox.update(it.seq, { err: String(e.message || e) }); // data/RLS error: mark and continue
  }
}

// Bulk tables: up to 200 rows per request; if the server refuses the chunk, fall back to row by row so only the bad row is marked
async function pushChunk(tbl, chunk) {
  const recs = (await Promise.all(chunk.map(it => D.db[tbl].get(it.rec_id))));
  const live = chunk.map((it, i) => [it, recs[i]]).filter(([it, r]) => { if (!r) D.db.outbox.delete(it.seq); return !!r; });
  if (!live.length) return;
  try {
    const { error } = await client.from(TABLE[tbl]).upsert(live.map(([, r]) => payloadOf(tbl, r)), { onConflict: 'id' });
    if (error) throw error;
    for (const [it, r] of live) {
      const cur = await D.db[tbl].get(it.rec_id);
      if (cur && cur.updated_at === r.updated_at) await D.db.outbox.delete(it.seq);
    }
  } catch (e) {
    if (isNet(e) || isAuth(e)) throw e;
    for (const [it] of live) await pushOne(it);
  }
}

async function push() {
  const items = await D.db.outbox.toArray();
  const ord = { collars: 0, progress: 1, disthours: 2, surveys: 3, samples: 4, assays: 5 };
  items.sort((a, b) => (a.tbl === b.tbl ? a.seq - b.seq : ord[a.tbl] - ord[b.tbl])); // collar first
  for (let i = 0; i < items.length;) {
    const it = items[i];
    if (BATCH.has(it.tbl)) {
      const chunk = [];
      while (i < items.length && items[i].tbl === it.tbl && chunk.length < 200) chunk.push(items[i++]);
      await pushChunk(it.tbl, chunk);
    } else { await pushOne(it); i++; }
  }
}

// PostgREST returns at most 1000 rows per request: read in pages
async function fetchAll(make) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await make().order('id').range(i, i + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
// tables added by newer migrations: a site that has not run them yet must not break the whole sync
const missingTable = e => /does not exist|schema cache|PGRST205|42P01/i.test(String(e?.code || '') + ' ' + String(e?.message || ''));
async function fetchOptional(make) {
  try { return await fetchAll(make); } catch (e) { if (missingTable(e)) return null; throw e; }
}

async function pull() {
  const q = async p => { const { data, error } = await p; if (error) throw error; return data || []; };
  // ambil semua dulu (jaringan), baru tulis ke IndexedDB dalam satu transaksi
  const [rigs, prospects, settings, codes] = await Promise.all([
    q(client.from('exp_rig').select('*').eq('is_active', true)),
    q(client.from('exp_prospect').select('*').eq('is_active', true)),
    q(client.from('exp_setting').select('key,value')),
    q(client.from('exp_code_list').select('*')),
  ]);
  const collars = await fetchAll(() => client.from('exp_collar').select('*').eq('is_deleted', false));
  const days = Number(settings.find(x => x.key === 'progress_pull_days')?.value ?? setting('progress_pull_days')) || 0;   // 0 = all history
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const progress = await fetchAll(() => { let r = client.from('exp_drill_progress').select('*').eq('is_deleted', false); if (days > 0) r = r.gte('work_date', since); return r; });
  const dist = await fetchOptional(() => { let r = client.from('exp_dist_hour').select('*').eq('is_deleted', false); if (days > 0) r = r.gte('work_date', since); return r; });
  const iup = await fetchOptional(() => client.from('exp_iup').select('*'));
  const lone = t => fetchOptional(() => client.from(t).select('*').eq('is_deleted', false));
  const [surveys, samples, assays] = [await lone('exp_survey'), await lone('exp_sample'), await lone('exp_assay')];   // null = site has not run migration 0008

  const pendingKeys = new Set((await D.db.outbox.toArray()).map(o => o.key));
  const keep = (tbl, rows) => rows.filter(r => !pendingKeys.has(`${tbl}:${r.id}`));
  await D.db.transaction('rw', D.db.rigs, D.db.prospects, D.db.settings, D.db.codes, D.db.collars, D.db.progress, D.db.disthours, D.db.iup, D.db.surveys, D.db.samples, D.db.assays, async () => {
    await D.db.rigs.clear(); await D.db.rigs.bulkPut(rigs);
    await D.db.prospects.clear(); await D.db.prospects.bulkPut(prospects);
    await D.db.settings.clear(); await D.db.settings.bulkPut(settings);
    await D.db.codes.clear(); await D.db.codes.bulkPut(codes);
    await D.db.collars.bulkPut(keep('collars', collars));
    await D.db.progress.bulkPut(keep('progress', progress));
    if (dist) await D.db.disthours.bulkPut(keep('disthours', dist));
    if (surveys) await D.db.surveys.bulkPut(keep('surveys', surveys));
    if (samples) await D.db.samples.bulkPut(keep('samples', samples));
    if (assays) await D.db.assays.bulkPut(keep('assays', assays));
    if (iup) { await D.db.iup.clear(); await D.db.iup.bulkPut(iup); }   // boundary: full replace so deletes propagate
  });
  await loadCfg();
}

export async function syncNow() {
  if (syncing || !client || !info || !navigator.onLine) { await emit(); return; }
  syncing = true; lastError = ''; await emit();
  try {
    await refreshProfile();          // izin bisa berubah (admin ganti role)
    await push();
    await pull();
    localStorage.setItem(`exp_last_sync_${info.site}`, new Date().toISOString());
  } catch (e) {
    lastError = isAuth(e) ? 'Sesi habis — login ulang (data lokal aman).'
      : isNet(e) ? '' : String(e.message || e);
  } finally { syncing = false; await emit(); }
}

let t = null;
export const syncSoon = (ms = 800) => { clearTimeout(t); t = setTimeout(syncNow, ms); };

let started = false;
export function startAutoSync() {
  if (!started) {
    started = true;
    window.addEventListener('online', () => syncNow());
    window.addEventListener('offline', () => emit());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
    navigator.serviceWorker?.addEventListener('message', e => { if (e.data === 'exp-sync') syncNow(); });
    navigator.serviceWorker?.ready.then(r => r.sync?.register('exp-sync')).catch(() => {});
    setInterval(() => { if (navigator.onLine) syncNow(); }, 5 * 60 * 1000);
  }
  syncNow();
}
