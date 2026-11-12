-- ============================================================================
-- EXPLOHUB: consumables reach the hub. Run in the explohub SQL Editor (project nuymrirtigecyrosidga).
-- Run AFTER hub_01, hub_02, hub_03. Safe to run twice. Does not touch the production hub.
--
-- Adds fuel, polymer and hyd oil (Distribution Hour) to the hub cache, the pull and hub.v_dist_hour.
--
-- After running (per site that has run 0013):
--   select hub_private.upgrade_site('WKM');      -- re-imports the export views so fuel_l etc. are visible
--   select hub_private.refresh_if_changed();
-- A site that has NOT run 0013 keeps syncing; its consumables stay NULL.
--
-- ============================================================================

-- ---------- guard: this file belongs in explohub only ------------------------------
do $g$
begin
  if to_regnamespace('hub_private') is null or to_regclass('hub_private.dist_hour') is null then
    raise exception 'Wrong project or hub_01..hub_03 not run: schema hub_private / table hub_private.dist_hour is missing. Run this file only in explohub (nuymrirtigecyrosidga), after hub_01, hub_02 and hub_03. Nothing was changed.';
  end if;
end $g$;

-- ---------- 1. cache columns ------------------------------------------------
alter table hub_private.dist_hour
  add column if not exists fuel_l    numeric(7,1),
  add column if not exists polymer_l numeric(7,1),
  add column if not exists oil_hyd_l numeric(7,1);

-- ---------- 2. refresh: same as hub_03 except the dist_hour column list ------
create or replace function hub_private.refresh_site_v8(p_site text, p_force boolean default false)
returns jsonb language plpgsql as $fn$
declare
  v_src text := 'src_' || lower(p_site);
  v_log bigint;
  t record;
  rem int; cur int; n int;
  counts jsonb := '{}'::jsonb;
  dist_cols text := 'id, work_date, rig_id, from_time, to_time, hours, activity, remarks, is_deleted, created_at, updated_at, server_updated_at';
begin
  -- hub_04: take the consumables only from a site whose export view has them (site ran 0013 and was re-imported)
  if exists (select 1 from pg_attribute where attrelid = to_regclass(format('%I.dist_hour', v_src)) and attname = 'fuel_l' and not attisdropped) then
    dist_cols := dist_cols || ', fuel_l, polymer_l, oil_hyd_l';
  end if;
  insert into hub_private.refresh_log (site_code, status) values (p_site, 'running') returning id into v_log;
  begin
    -- R1 floor guard on the tables that only ever grow (soft delete): refuse a collapsed source
    for t in select unnest(array['collar','drill_progress','sample','assay']) as tname loop
      execute format('select count(*) from %I.%I', v_src, t.tname) into rem;
      execute format('select count(*) from hub_private.%I where site_code = %L', t.tname, p_site) into cur;
      if not p_force and cur >= 20 and rem < cur * 0.5 then
        raise exception 'floor guard: % rows at site % are < 50%% of hub cache', t.tname, p_site;
      end if;
    end loop;

    -- R2 explicit column lists on both sides: a changed site view errors, it never shifts columns
    for t in select * from (values
      ('collar', 'id, hole_id, hole_type, prospect, status, planned_lat, planned_lon, planned_elev, planned_depth_m, asbuilt_lat, asbuilt_lon, asbuilt_elev, gps_accuracy_m, total_depth_m, remarks, is_deleted, created_at, updated_at, server_updated_at, dip_deg, azimuth_deg'),
      ('drill_progress', 'id, work_date, shift, rig_id, hole_id, from_m, to_m, meters, downtime_hours, downtime_reason, remarks, is_deleted, created_at, updated_at, server_updated_at, core_len_m, core_recovery_pct, layer, fuel_l, polymer_l, oil_hyd_l'),
      ('rig', 'rig_id, rig_name, rig_type, is_active'),
      ('prospect', 'prospect_code, prospect_name, is_active'),
      ('code_list', 'list_code, code, label, sort_order, is_active, meta'),
      ('dist_hour', dist_cols),
      ('survey', 'id, hole_id, depth_m, dip_deg, azimuth_deg, method, survey_date, remarks, is_deleted, created_at, updated_at, server_updated_at'),
      ('sample', 'id, sample_no, hole_id, from_m, to_m, sample_type, status, sampled_date, sent_date, lab, batch_id, remarks, is_deleted, created_at, updated_at, server_updated_at'),
      ('assay', 'id, hole_id, from_m, to_m, sample_no, layer, ni_pct, co_pct, fe_pct, mgo_pct, sio2_pct, extra, sample_type, batch_id, lab, certificate_no, crm_name, crm_element, crm_expected, duplicate_type, duplicate_of_sample_no, source_type, source_file, remarks, is_deleted, created_at, updated_at, server_updated_at'),
      ('weekly_plan', 'id, week_start, plan_m, plan_holes, remarks, is_deleted, created_at, updated_at, server_updated_at'),
      ('site_setting', 'key, value')
    ) as v(tbl, cols) loop
      execute format('delete from hub_private.%I where site_code = %L', t.tbl, p_site);
      execute format('insert into hub_private.%I (site_code, %s) select %L, %s from %I.%I',
                     t.tbl, t.cols, p_site, t.cols, v_src, t.tbl);
      get diagnostics n = row_count;
      counts := counts || jsonb_build_object(t.tbl, n);
    end loop;

    update hub_private.refresh_log
       set status = 'ok', finished_at = now(),
           rows_collar = (counts->>'collar')::int, rows_progress = (counts->>'drill_progress')::int,
           rows_rig = (counts->>'rig')::int, rows_prospect = (counts->>'prospect')::int,
           rows_code = (counts->>'code_list')::int, rows_extra = counts
     where id = v_log;
    return jsonb_build_object('status', 'ok') || counts;
  exception when others then
    update hub_private.refresh_log set status = 'error', error_message = sqlerrm, finished_at = now() where id = v_log;
    return jsonb_build_object('status', 'error', 'error', sqlerrm);
  end;
end $fn$;

-- ---------- 3. Looker view: columns are only ever appended -------------------
create or replace view hub.v_dist_hour as
select d.site_code, d.id, d.work_date, d.rig_id, coalesce(r.rig_name, d.rig_id) as rig_name,
       d.from_time, d.to_time, d.hours,
       d.activity, coalesce(a.label, d.activity) as activity_label,
       d.remarks, d.updated_at,
       d.fuel_l, d.polymer_l, d.oil_hyd_l
from hub_private.dist_hour d
left join hub_private.rig r on r.site_code = d.site_code and r.rig_id = d.rig_id
left join hub_private.code_list a on a.site_code = d.site_code and a.list_code = 'activity' and a.code = d.activity
where not d.is_deleted;
grant select on hub.v_dist_hour to looker_reader;
