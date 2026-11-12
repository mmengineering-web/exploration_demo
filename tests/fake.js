// Deterministic fake dataset (two sites) used by unit and browser tests.
export function fake() {
  const rows = { exp_collar: [], exp_drill_progress: [], exp_dist_hour: [], exp_sample: [], exp_weekly_plan: [], exp_rig: [], exp_prospect: [], exp_code_list: [], exp_assay: [], exp_survey: [], exp_crm: [], exp_setting: [], exp_profile: [{ role: 'geologist', is_active: true }] };
  let n = 0; const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  rows.exp_rig.push({ rig_id: 'R1', rig_name: 'Rig 1', rig_type: 'DD', is_active: true }, { rig_id: 'R2', rig_name: 'Rig 2', rig_type: 'DD', is_active: true });
  rows.exp_prospect.push({ prospect_code: 'N1', prospect_name: 'North One', is_active: true }, { prospect_code: 'S2', prospect_name: 'South Two', is_active: true });
  const cl = (l, c, lab, meta = {}) => rows.exp_code_list.push({ list_code: l, code: c, label: lab, sort_order: 1, is_active: true, meta });
  cl('collar_status', 'planned', 'Planned', { map_class: 'planned' }); cl('collar_status', 'drilling', 'Drilling', { map_class: 'coh' }); cl('collar_status', 'completed', 'Completed', { map_class: 'eoh' });
  cl('activity', 'DRILLING', 'Drilling'); cl('activity', 'STANDBY', 'Standby/BD/Weather'); cl('activity', 'MOVE_SETUP', 'Moving/Setup');
  cl('downtime_reason', 'RAIN', 'Rain'); cl('downtime_reason', 'RIG_BREAKDOWN', 'Rig breakdown'); cl('layer', 'LIM', 'Limonite'); cl('layer', 'SAP', 'Saprolite');
  const holes = [['WKM-DD-0001', 'N1', 'completed', 30], ['WKM-DD-0002', 'N1', 'completed', 24], ['WKM-DD-0003', 'S2', 'drilling', 40], ['WKM-DD-0004', 'S2', 'planned', 30]];
  for (const [h, p, s, td] of holes) rows.exp_collar.push({ id: id(), hole_id: h, hole_type: 'DD', prospect: p, status: s, planned_depth_m: td, total_depth_m: s === 'completed' ? td : null, asbuilt_lat: -3.1, asbuilt_lon: 121.1, is_deleted: false });
  // progress: 2025-10-06 (Mon) .. 2025-10-19, 6 m per row
  let day = new Date(Date.UTC(2025, 9, 6));
  for (let i = 0; i < 14; i++, day = new Date(day.getTime() + 864e5)) {
    const d = day.toISOString().slice(0, 10);
    const hi = i < 5 ? 0 : i < 9 ? 1 : 2;
    rows.exp_drill_progress.push({ id: id(), work_date: d, shift: 'DAY', rig_id: i % 2 ? 'R2' : 'R1', hole_id: holes[hi][0], from_m: i * 3, to_m: i * 3 + 6, meters: 6, downtime_hours: i % 4 === 0 ? 2 : 0, downtime_reason: i % 4 === 0 ? 'RAIN' : null, core_len_m: 5.4, core_recovery_pct: 90, layer: i % 3 ? 'LIM' : 'SAP', is_deleted: false });
    rows.exp_dist_hour.push({ id: id(), work_date: d, rig_id: i % 2 ? 'R2' : 'R1', from_time: '07:00:00', to_time: '17:00:00', hours: 10, activity: 'DRILLING', fuel_l: i === 0 ? 100 : null, polymer_l: null, oil_hyd_l: null, is_deleted: false });
    rows.exp_dist_hour.push({ id: id(), work_date: d, rig_id: i % 2 ? 'R2' : 'R1', from_time: '17:00:00', to_time: '19:00:00', hours: 2, activity: i % 3 ? 'STANDBY' : 'MOVE_SETUP', fuel_l: null, polymer_l: null, oil_hyd_l: null, is_deleted: false });
  }
  rows.exp_weekly_plan.push({ id: id(), week_start: '2025-10-06', plan_m: 50, plan_holes: 2, is_deleted: false }, { id: id(), week_start: '2025-10-13', plan_m: 30, plan_holes: 1, is_deleted: false });
  rows.exp_sample.push({ id: id(), sample_no: 'S1', hole_id: 'WKM-DD-0001', from_m: 0, to_m: 1, sample_type: 'NORMAL', status: 'PENDING', is_deleted: false }, { id: id(), sample_no: 'S2', hole_id: 'WKM-DD-0001', from_m: 1, to_m: 2, sample_type: 'NORMAL', status: 'SENT', sent_date: '2026-10-20', is_deleted: false });
  // lab QC fixtures: one blank over the limit, CRM Z 2.5 (warn) and 3.5 (fail), a failing PD and a passing CD, one normal assay beyond total depth
  const as = o => rows.exp_assay.push({ id: id(), is_deleted: false, extra: {}, batch_id: 'LAB/26-1', reported_date: '2026-10-22', created_at: '2026-10-22T05:00:00Z', source_type: 'pdf', hole_id: null, from_m: null, to_m: null, ...o });
  as({ sample_type: 'BLANK', sample_no: 'BLANK-1', ni_pct: 0.06, fe_pct: 1 });
  as({ sample_type: 'CRM', sample_no: 'OREAS 182B-1', crm_name: 'OREAS 182b', ni_pct: 0.802, fe_pct: 22, extra: { fe2o3_pct: 32.5 } });
  as({ sample_type: 'CRM', sample_no: 'OREAS 182B-2', crm_name: 'OREAS 182b', ni_pct: 0.82, fe_pct: 22.9, extra: { fe2o3_pct: 32.7 } });
  as({ sample_type: 'NORMAL', sample_no: 'S1', hole_id: 'WKM-DD-0001', from_m: 0, to_m: 1, ni_pct: 1.0, fe_pct: 40, mgo_pct: 3 });
  as({ sample_type: 'NORMAL', sample_no: 'S9', hole_id: 'WKM-DD-0002', from_m: 23, to_m: 26, ni_pct: 1.4, fe_pct: 20, mgo_pct: 14 });
  as({ sample_type: 'DUPLICATE', sample_no: 'S1-PD', hole_id: 'WKM-DD-0001', from_m: 0, to_m: 1, duplicate_of_sample_no: 'S1', duplicate_type: 'PD', ni_pct: 1.07, fe_pct: 40 });
  as({ sample_type: 'DUPLICATE', sample_no: 'S1-CD', hole_id: 'WKM-DD-0001', from_m: 0, to_m: 1, duplicate_of_sample_no: 'S1', duplicate_type: 'CD', ni_pct: 1.07, fe_pct: 40 });
  rows.exp_crm.push(...[['Ni', 0.757, 0.018], ['Fe2O3', 32.78, 0.283]].map(([analyte, certified_value, sd]) => ({ id: id(), crm_name: 'OREAS 182b', analyte, certified_value, sd, is_deleted: false })));
  return rows;
}
