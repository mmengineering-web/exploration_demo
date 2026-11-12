// Live read for the Data QC tab (RLS: any active role may read). Needs internet and a login session.
import { fetchAll } from '../dash/data.js';
const num = v => (v === null || v === undefined ? null : Number(v));

export async function loadQcData(sb, site) {
  const live = t => () => sb.from(t).select('*').eq('is_deleted', false).order('id');
  const [collar, survey, sample, assay, crm, setting] = await Promise.all([
    fetchAll(live('exp_collar')), fetchAll(live('exp_survey')), fetchAll(live('exp_sample')), fetchAll(live('exp_assay')),
    fetchAll(live('exp_crm')).catch(() => []),           // site not on migration 0014 yet: QAQC then has no CRM table
    fetchAll(() => sb.from('exp_setting').select('*').in('key', ['qaqc_thresholds', 'utm_zone', 'utm_hemisphere'])).catch(() => []),
  ]);
  for (const r of collar) for (const k of ['planned_depth_m', 'total_depth_m', 'dip_deg', 'azimuth_deg', 'gps_accuracy_m', 'planned_lat', 'planned_lon', 'planned_elev', 'asbuilt_lat', 'asbuilt_lon', 'asbuilt_elev']) r[k] = num(r[k]);
  for (const r of survey) for (const k of ['depth_m', 'dip_deg', 'azimuth_deg']) r[k] = num(r[k]);
  for (const r of sample) for (const k of ['from_m', 'to_m']) r[k] = num(r[k]);
  for (const r of assay) for (const k of ['from_m', 'to_m', 'ni_pct', 'co_pct', 'fe_pct', 'mgo_pct', 'sio2_pct']) r[k] = num(r[k]);
  for (const r of crm) for (const k of ['certified_value', 'sd']) r[k] = num(r[k]);
  const sv = k => setting.find(x => x.key === k)?.value ?? null;
  return { collar, survey, sample, assay, crm, setting: sv('qaqc_thresholds'), utm: { zone: sv('utm_zone'), hemi: sv('utm_hemisphere') || 'S' }, loadedAt: new Date(), site };
}
