-- ============================================================================
-- EXPLOHUB — Phase 1 upgrade (run in the explohub SQL Editor, project nuymrirtigecyrosidga)
-- Not the production hub. Run AFTER hub_01 and hub_02. Safe to run twice.
-- Core / collar photos stay on each site (explohub never stores photo paths) and the
-- IUP boundary is not stored here (it is a map layer inside the app).
--
-- Order of work
--   1. A site runs migration 0008 (site SQL Editor).
--   2. Here, once: run this whole file.
--   3. Here, per upgraded site:  select hub_private.upgrade_site('WKM');
--      then:                     select hub_private.refresh_if_changed();
-- A site that has NOT run 0008 yet keeps refreshing the old way (schema_ver = 1); nothing breaks.
-- New sites: hub_private.add_site(...) now detects the site version by itself.
-- ============================================================================

-- ---------- state ------------------------------------------------------------
alter table hub_private.site_config add column if not exists schema_ver int not null default 1;
alter table hub_private.refresh_log add column if not exists rows_extra jsonb;

-- ---------- cache tables: new columns on existing tables ---------------------
alter table hub_private.collar
  add column if not exists dip_deg numeric(5,2),
  add column if not exists azimuth_deg numeric(5,2);
alter table hub_private.drill_progress
  add column if not exists core_len_m numeric(7,2),
  add column if not exists core_recovery_pct numeric(6,1),
  add column if not exists layer text,
  add column if not exists fuel_l numeric(7,1),
  add column if not exists polymer_l numeric(7,1),
  add column if not exists oil_hyd_l numeric(7,1);

-- ---------- cache tables: new ------------------------------------------------
create table if not exists hub_private.dist_hour (
  site_code text not null, id uuid not null,
  work_date date not null, rig_id text not null, from_time time not null, to_time time not null,
  hours numeric(5,2), activity text not null, remarks text, is_deleted boolean not null,
  created_at timestamptz, updated_at timestamptz, server_updated_at timestamptz,
  refreshed_at timestamptz not null default now(), primary key (site_code, id));
create index if not exists ix_hub_dist_rig_date on hub_private.dist_hour (site_code, rig_id, work_date);

create table if not exists hub_private.survey (
  site_code text not null, id uuid not null,
  hole_id text not null, depth_m numeric(7,2) not null, dip_deg numeric(5,2) not null, azimuth_deg numeric(5,2) not null,
  method text, survey_date date, remarks text, is_deleted boolean not null,
  created_at timestamptz, updated_at timestamptz, server_updated_at timestamptz,
  refreshed_at timestamptz not null default now(), primary key (site_code, id));
create index if not exists ix_hub_survey_hole on hub_private.survey (site_code, hole_id, depth_m);

create table if not exists hub_private.sample (
  site_code text not null, id uuid not null,
  sample_no text not null, hole_id text not null, from_m numeric(7,2) not null, to_m numeric(7,2) not null,
  sample_type text not null, status text not null, sampled_date date, sent_date date,
  lab text, batch_id text, remarks text, is_deleted boolean not null,
  created_at timestamptz, updated_at timestamptz, server_updated_at timestamptz,
  refreshed_at timestamptz not null default now(), primary key (site_code, id));
create index if not exists ix_hub_sample_hole on hub_private.sample (site_code, hole_id, from_m);
create index if not exists ix_hub_sample_no on hub_private.sample (site_code, sample_no);

create table if not exists hub_private.assay (
  site_code text not null, id uuid not null,
  hole_id text not null, from_m numeric(7,2) not null, to_m numeric(7,2) not null,
  sample_no text, layer text,
  ni_pct numeric(7,3), co_pct numeric(7,3), fe_pct numeric(7,3), mgo_pct numeric(7,3), sio2_pct numeric(7,3),
  extra jsonb, sample_type text not null, batch_id text, lab text, certificate_no text,
  crm_name text, crm_element text, crm_expected numeric(9,4), duplicate_type text, duplicate_of_sample_no text,
  source_type text, source_file text, remarks text, is_deleted boolean not null,
  created_at timestamptz, updated_at timestamptz, server_updated_at timestamptz,
  refreshed_at timestamptz not null default now(), primary key (site_code, id));
create index if not exists ix_hub_assay_hole on hub_private.assay (site_code, hole_id, from_m);
create index if not exists ix_hub_assay_sample on hub_private.assay (site_code, sample_no);

create table if not exists hub_private.weekly_plan (
  site_code text not null, id uuid not null,
  week_start date not null, plan_m numeric(8,1) not null, plan_holes int, remarks text, is_deleted boolean not null,
  created_at timestamptz, updated_at timestamptz, server_updated_at timestamptz,
  refreshed_at timestamptz not null default now(), primary key (site_code, id));

create table if not exists hub_private.site_setting (
  site_code text not null, key text not null, value jsonb,
  refreshed_at timestamptz not null default now(), primary key (site_code, key));

-- ---------- import the site's export views (drop + re-import, so column changes are picked up) ----------
create or replace function hub_private.import_site_tables(p_site text)
returns int language plpgsql as $fn$
declare
  srv text := 'site_' || lower(p_site);
  sch text := 'src_'  || lower(p_site);
  r record;
begin
  execute format('create schema if not exists %I', sch);
  for r in select foreign_table_name as n from information_schema.foreign_tables where foreign_table_schema = sch loop
    execute format('drop foreign table if exists %I.%I', sch, r.n);
  end loop;
  execute format($q$import foreign schema hub_export
      limit to (collar, drill_progress, rig, prospect, code_list, change_sig,
                dist_hour, survey, sample, assay, weekly_plan, site_setting, schema_version)
      from server %I into %I$q$, srv, sch);
  -- schema_version only exists on a site that ran 0008
  return case when to_regclass(format('%I.schema_version', sch)) is not null then 8 else 1 end;
end $fn$;

-- ---------- add_site: same signature as hub_02, now version-aware ----------
create or replace function hub_private.add_site(
  p_site text, p_ref text, p_host text, p_password text, p_port int default 5432, p_sslmode text default 'require')
returns text language plpgsql as $fn$
declare
  srv text := 'site_' || lower(p_site);
  ver int;
begin
  if p_site !~ '^[A-Z0-9]{2,6}$' then raise exception 'Site code must be 2-6 capital letters/digits, got %', p_site; end if;
  if p_ref  !~ '^[a-z0-9]{15,30}$' then raise exception 'Project ref looks wrong: %', p_ref; end if;

  execute format($q$create server if not exists %I foreign data wrapper postgres_fdw
    options (host %L, port %L, dbname 'postgres', sslmode %L, fetch_size '10000',
             application_name 'can_explo_hub', keep_connections 'off')$q$, srv, p_host, p_port::text, p_sslmode);

  if exists (select 1 from pg_user_mappings where srvname = srv and usename = current_user) then
    execute format('alter user mapping for current_user server %I options (set user %L, set password %L)', srv, 'hub_reader.' || p_ref, p_password);
  else
    execute format('create user mapping for current_user server %I options (user %L, password %L)', srv, 'hub_reader.' || p_ref, p_password);
  end if;

  ver := hub_private.import_site_tables(p_site);

  insert into hub_private.site_config (site_code, fdw_server, project_ref, enabled, schema_ver)
  values (p_site, srv, p_ref, true, ver)
  on conflict (site_code) do update set fdw_server = excluded.fdw_server, project_ref = excluded.project_ref,
                                        enabled = true, schema_ver = excluded.schema_ver;
  insert into hub_private.refresh_state (site_code) values (p_site) on conflict do nothing;

  return 'site ' || p_site || ' connected (schema ' || ver || case when ver < 8 then ', site has not run 0008 yet' else '' end
         || '). Next: select hub_private.refresh_if_changed();';
end $fn$;

-- ---------- upgrade an existing site after it ran 0008 ----------
create or replace function hub_private.upgrade_site(p_site text)
returns text language plpgsql as $fn$
declare ver int;
begin
  if not exists (select 1 from hub_private.site_config where site_code = p_site) then
    raise exception 'Unknown site %. Use add_site first.', p_site;
  end if;
  ver := hub_private.import_site_tables(p_site);
  if ver < 8 then
    raise exception 'Site % has not run migration 0008 yet (hub_export.schema_version is missing). Run 0008 on the site first.', p_site;
  end if;
  update hub_private.site_config set schema_ver = ver where site_code = p_site;
  update hub_private.refresh_state set sig = null, last_fail_at = null where site_code = p_site;   -- force a full pull
  return 'site ' || p_site || ' upgraded to schema ' || ver || '. Next: select hub_private.refresh_if_changed();';
end $fn$;

-- ---------- refresh: keep the old function for sites still on schema 1 ----------
do $$ begin
  if to_regprocedure('hub_private.refresh_site_v1(text,boolean)') is null
     and to_regprocedure('hub_private.refresh_site(text,boolean)') is not null then
    alter function hub_private.refresh_site(text, boolean) rename to refresh_site_v1;
  end if;
end $$;

create or replace function hub_private.refresh_site(p_site text, p_force boolean default false)
returns jsonb language plpgsql as $fn$
declare v int;
begin
  select schema_ver into v from hub_private.site_config where site_code = p_site;
  if coalesce(v, 1) >= 8 then
    return hub_private.refresh_site_v8(p_site, p_force);
  end if;
  return hub_private.refresh_site_v1(p_site, p_force);
end $fn$;

-- full replace of ONE site inside a sub-transaction: any failure rolls back all of that site's deletes
create or replace function hub_private.refresh_site_v8(p_site text, p_force boolean default false)
returns jsonb language plpgsql as $fn$
declare
  v_src text := 'src_' || lower(p_site);
  v_log bigint;
  t record;
  rem int; cur int; n int;
  counts jsonb := '{}'::jsonb;
begin
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
      ('dist_hour', 'id, work_date, rig_id, from_time, to_time, hours, activity, remarks, is_deleted, created_at, updated_at, server_updated_at'),
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

-- ---------- Looker / WebGIS views (schema hub) ----------------------------------
-- Existing views keep their columns; new columns are appended.
create or replace view hub.site_status as
select c.site_code, c.enabled,
       s.last_checked_at, s.last_ok_at, s.last_error,
       (select max(work_date) from hub_private.drill_progress p where p.site_code = c.site_code and not p.is_deleted) as latest_progress_date,
       (select count(*) from hub_private.collar x where x.site_code = c.site_code and not x.is_deleted) as collars,
       (select count(*) from hub_private.drill_progress p where p.site_code = c.site_code and not p.is_deleted) as progress_rows,
       round(extract(epoch from (now() - s.last_ok_at)) / 3600.0, 1) as hours_since_ok,
       c.schema_ver,
       (select count(*) from hub_private.sample x where x.site_code = c.site_code and not x.is_deleted) as samples,
       (select count(*) from hub_private.assay x where x.site_code = c.site_code and not x.is_deleted) as assay_rows
from hub_private.site_config c
left join hub_private.refresh_state s using (site_code);

create or replace view hub.v_collar as
select c.site_code, c.id, c.hole_id,
       c.hole_type, coalesce(ht.label, c.hole_type) as hole_type_label,
       c.prospect,
       c.status, coalesce(st.label, c.status) as status_label,
       c.planned_lat, c.planned_lon, c.planned_elev, c.planned_depth_m,
       c.asbuilt_lat, c.asbuilt_lon, c.asbuilt_elev, c.gps_accuracy_m,
       c.total_depth_m,
       coalesce(c.asbuilt_lat, c.planned_lat) as lat,
       coalesce(c.asbuilt_lon, c.planned_lon) as lon,
       (c.asbuilt_lat is not null) as has_asbuilt,
       coalesce(c.geom_asbuilt, c.geom_planned) as geom,
       null::text as photo_path, c.remarks, c.updated_at, c.refreshed_at,   -- photos stay on the site
       coalesce(c.dip_deg, -90) as dip_deg,
       coalesce(c.azimuth_deg, 0) as azimuth_deg
from hub_private.collar c
left join hub_private.code_list ht on ht.site_code = c.site_code and ht.list_code = 'hole_type' and ht.code = c.hole_type
left join hub_private.code_list st on st.site_code = c.site_code and st.list_code = 'collar_status' and st.code = c.status
where not c.is_deleted;

create or replace view hub.v_drill_progress as
select p.site_code, p.id, p.work_date, date_trunc('month', p.work_date)::date as month,
       p.shift, coalesce(sh.label, p.shift) as shift_label,
       p.rig_id, coalesce(r.rig_name, p.rig_id) as rig_name,
       p.hole_id, c.hole_type, c.hole_type_label, c.prospect,
       p.from_m, p.to_m, p.meters,
       p.downtime_hours, p.downtime_reason, coalesce(dr.label, p.downtime_reason) as downtime_reason_label,
       p.remarks, p.updated_at,
       p.core_len_m, p.core_recovery_pct, p.layer, p.fuel_l, p.polymer_l, p.oil_hyd_l
from hub_private.drill_progress p
left join hub_private.rig r on r.site_code = p.site_code and r.rig_id = p.rig_id
left join hub_private.code_list sh on sh.site_code = p.site_code and sh.list_code = 'shift' and sh.code = p.shift
left join hub_private.code_list dr on dr.site_code = p.site_code and dr.list_code = 'downtime_reason' and dr.code = p.downtime_reason
left join hub.v_collar c on c.site_code = p.site_code and c.hole_id = p.hole_id
where not p.is_deleted;

create or replace view hub.v_dist_hour as
select d.site_code, d.id, d.work_date, d.rig_id, coalesce(r.rig_name, d.rig_id) as rig_name,
       d.from_time, d.to_time, d.hours,
       d.activity, coalesce(a.label, d.activity) as activity_label,
       d.remarks, d.updated_at
from hub_private.dist_hour d
left join hub_private.rig r on r.site_code = d.site_code and r.rig_id = d.rig_id
left join hub_private.code_list a on a.site_code = d.site_code and a.list_code = 'activity' and a.code = d.activity
where not d.is_deleted;

create or replace view hub.v_survey as
select s.site_code, s.id, s.hole_id, s.depth_m, s.dip_deg, s.azimuth_deg, s.method, s.survey_date, s.remarks, s.updated_at
from hub_private.survey s where not s.is_deleted;

create or replace view hub.v_sample as
select s.site_code, s.id, s.sample_no, s.hole_id, c.hole_type, c.prospect,
       s.from_m, s.to_m, s.to_m - s.from_m as length_m,
       s.sample_type, coalesce(t.label, s.sample_type) as sample_type_label,
       s.status, coalesce(st.label, s.status) as status_label,
       s.sampled_date, s.sent_date, s.lab, s.batch_id,
       exists (select 1 from hub_private.assay a
                where a.site_code = s.site_code and a.sample_no = s.sample_no and not a.is_deleted) as has_assay,
       s.remarks, s.updated_at
from hub_private.sample s
left join hub_private.code_list t  on t.site_code  = s.site_code and t.list_code  = 'sample_type'   and t.code  = s.sample_type
left join hub_private.code_list st on st.site_code = s.site_code and st.list_code = 'sample_status' and st.code = s.status
left join hub.v_collar c on c.site_code = s.site_code and c.hole_id = s.hole_id
where not s.is_deleted;

create or replace view hub.v_assay as
select a.site_code, a.id, a.hole_id, c.hole_type, c.prospect, c.status as hole_status,
       a.from_m, a.to_m, a.to_m - a.from_m as length_m, round((a.from_m + a.to_m) / 2, 2) as mid_m,
       a.sample_no, a.layer,
       a.ni_pct, a.co_pct, a.fe_pct, a.mgo_pct, a.sio2_pct, a.extra,
       a.sample_type, a.batch_id, a.lab, a.certificate_no,
       a.crm_name, a.crm_element, a.crm_expected, a.duplicate_type, a.duplicate_of_sample_no,
       a.source_type, a.source_file, a.updated_at
from hub_private.assay a
left join hub.v_collar c on c.site_code = a.site_code and c.hole_id = a.hole_id
where not a.is_deleted;

create or replace view hub.v_weekly_plan_actual as
with act as (
  select site_code, date_trunc('week', work_date)::date as week_start,
         sum(meters) as actual_m, count(distinct hole_id) as holes_drilled
  from hub_private.drill_progress where not is_deleted group by 1, 2
), pl as (
  select site_code, week_start, plan_m, plan_holes from hub_private.weekly_plan where not is_deleted
)
select site_code, week_start, pl.plan_m, coalesce(act.actual_m, 0) as actual_m,
       case when pl.plan_m > 0 then round(coalesce(act.actual_m, 0) / pl.plan_m * 100, 1) end as achievement_pct,
       pl.plan_holes, coalesce(act.holes_drilled, 0) as holes_drilled
from pl full join act using (site_code, week_start);

create or replace view hub.v_site_setting as
select site_code, key, value from hub_private.site_setting;

-- Looker reader may read everything new in schema hub
grant select on all tables in schema hub to looker_reader;

-- ---------- next ---------------------------------------------------------------
-- 1. Site ran 0008?  select hub_private.upgrade_site('WKM');
-- 2.                 select hub_private.refresh_if_changed();     -- expect {"WKM": "ok"}
-- 3. Check:          select * from hub.site_status;
--                    select count(*) from hub.v_assay;
--                    select * from hub_private.refresh_log order by started_at desc limit 5;
