// Live read of one site's tables through the logged-in Supabase client (RLS: any active role may read).
// Needs internet. Returns the dataset shape the calc/view modules expect; every row carries site_code.
const PAGE = 1000;
export async function fetchAll(makeQuery) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}
const num = v => (v === null || v === undefined ? null : Number(v));

// numeric columns come back as strings from some PostgREST types: make them numbers once
export function normalizeSiteData(d) {
  for (const r of d.collar) for (const k of ['planned_depth_m', 'total_depth_m']) r[k] = num(r[k]);
  for (const r of d.progress) for (const k of ['from_m', 'to_m', 'meters', 'downtime_hours', 'core_len_m', 'core_recovery_pct']) r[k] = num(r[k]);
  for (const r of d.dist) for (const k of ['hours', 'fuel_l', 'polymer_l', 'oil_hyd_l']) r[k] = num(r[k]);
  for (const r of d.sample) for (const k of ['from_m', 'to_m']) r[k] = num(r[k]);
  for (const r of d.plan) for (const k of ['plan_m', 'plan_holes']) r[k] = num(r[k]);
  return d;
}

export async function loadSiteData(sb, site) {
  const live = t => () => sb.from(t).select('*').eq('is_deleted', false).order('id');
  const all = (t, o) => () => sb.from(t).select('*').order(o);
  const [collar, progress, dist, sample, plan, rigs, prospects, codes] = await Promise.all([
    fetchAll(live('exp_collar')), fetchAll(live('exp_drill_progress')), fetchAll(live('exp_dist_hour')),
    fetchAll(live('exp_sample')), fetchAll(live('exp_weekly_plan')),
    fetchAll(all('exp_rig', 'rig_id')), fetchAll(all('exp_prospect', 'prospect_code')), fetchAll(all('exp_code_list', 'code')),
  ]);
  const tag = rows => rows.map(r => ({ site_code: site, ...r }));
  // QAQC section: lab results and CRM certificates. A failure here must not take the whole dashboard down, so it is kept as qaqcError.
  let assay = [], crm = [], setting = [], qaqcError = null;
  try {
    [assay, crm, setting] = await Promise.all([
      fetchAll(() => sb.from('exp_assay').select('*')   // '*' so a site that has not run migration 0014 yet (no reported_date, batch_id...) still loads
        .eq('is_deleted', false).order('id')),
      fetchAll(live('exp_crm')).catch(() => []),     // site not on migration 0014 yet: no CRM certificates
      fetchAll(() => sb.from('exp_setting').select('*').eq('key', 'qaqc_thresholds')).catch(() => []),
    ]);
  } catch (e) { qaqcError = e.message || String(e); }
  const d = { collar: tag(collar), progress: tag(progress), dist: tag(dist), sample: tag(sample), plan: tag(plan),
              rigs: tag(rigs), prospects: tag(prospects), codes: tag(codes), assay: tag(assay), crm: tag(crm),
              qaqcSetting: setting.find(x => x.key === 'qaqc_thresholds')?.value ?? null, qaqcError, status: [], loadedAt: new Date() };
  for (const r of d.assay) r.ni_pct = num(r.ni_pct);
  for (const r of d.crm) for (const k of ['certified_value', 'sd']) r[k] = num(r[k]);
  normalizeSiteData(d);
  return d;
}

// Chart.js is loaded on demand (only when a dashboard tab opens), like Leaflet for Peta.
let chartLoading = null;
export function loadChartJs() {
  if (window.Chart) return Promise.resolve();
  if (!chartLoading) chartLoading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'js/vendor/chart.umd.min.js';
    s.onload = res; s.onerror = () => { chartLoading = null; rej(new Error('Could not load the chart library. Open this tab once while online.')); };
    document.head.appendChild(s);
  });
  return chartLoading;
}
