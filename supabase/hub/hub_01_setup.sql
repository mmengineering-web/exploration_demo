-- ============================================================================
-- EXPLORATION HUB (project nuymrirtigecyrosidga) — setup v1
-- Run ONCE in the hub's SQL Editor. Separate from the production hub.
--
-- Pattern (same as the production hub): the hub PULLS.
--   pg_cron every 3 min -> hub_private.refresh_if_changed()
--     -> read a small change signature from each site over postgres_fdw
--     -> if changed, replace that site's rows in the hub cache (hub_private.*)
--   Looker Studio / WebGIS read schema `hub` only (views on the cache).
--
-- Extra safeguards vs. the production hub notes:
--   R1  floor guard: refuse to replace a site if the remote row count collapses
--   R2  explicit column lists on both sides: a changed site view errors, never shifts columns
--   R3  change signature covers the data tables themselves (not only a load log)
--   R9  refresh_log and cron history are pruned weekly
-- ============================================================================

-- ---------- extensions (enable pg_cron / postgres_fdw / postgis under Database > Extensions if this errors) ----------
create extension if not exists postgis with schema extensions;
create extension if not exists postgres_fdw with schema extensions;
create extension if not exists pg_cron;

create schema if not exists hub_private;   -- cache, state, functions (no external access)
create schema if not exists hub;           -- Looker / WebGIS facing views

-- ---------- registry + state ------------------------------------------------
create table if not exists hub_private.site_config (
  site_code   text primary key,
  fdw_server  text not null,
  project_ref text,
  enabled     boolean not null default true,
  note        text
);
create table if not exists hub_private.refresh_state (
  site_code       text primary key references hub_private.site_config(site_code) on delete cascade,
  sig             text,
  last_checked_at timestamptz,
  last_ok_at      timestamptz,
  last_fail_at    timestamptz,
  last_error      text
);
create table if not exists hub_private.refresh_log (
  id             bigint generated always as identity primary key,
  site_code      text not null,
  status         text not null,            -- running | ok | error
  rows_collar    int, rows_progress int, rows_rig int, rows_prospect int, rows_code int,
  error_message  text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);

-- ---------- cache tables (one copy of every site, site_code in the key) -----
create table if not exists hub_private.collar (
  site_code        text not null,
  id               uuid not null,
  hole_id          text not null,
  hole_type        text not null,
  prospect         text,
  status           text not null,
  planned_lat      numeric(10,7), planned_lon numeric(10,7), planned_elev numeric(8,2), planned_depth_m numeric(7,2),
  asbuilt_lat      numeric(10,7), asbuilt_lon numeric(10,7), asbuilt_elev numeric(8,2), gps_accuracy_m numeric(6,2),
  total_depth_m    numeric(7,2),
  photo_path       text,
  remarks          text,
  is_deleted       boolean not null,
  created_at       timestamptz, updated_at timestamptz, server_updated_at timestamptz,
  refreshed_at     timestamptz not null default now(),
  geom_planned     extensions.geometry(Point,4326) generated always as (
    case when planned_lat is not null and planned_lon is not null
      then extensions.st_setsrid(extensions.st_makepoint(planned_lon::float8, planned_lat::float8), 4326) end) stored,
  geom_asbuilt     extensions.geometry(Point,4326) generated always as (
    case when asbuilt_lat is not null and asbuilt_lon is not null
      then extensions.st_setsrid(extensions.st_makepoint(asbuilt_lon::float8, asbuilt_lat::float8), 4326) end) stored,
  primary key (site_code, id)
);
create index if not exists ix_hub_collar_hole on hub_private.collar (site_code, hole_id);
create index if not exists ix_hub_collar_geom_a on hub_private.collar using gist (geom_asbuilt);
create index if not exists ix_hub_collar_geom_p on hub_private.collar using gist (geom_planned);

create table if not exists hub_private.drill_progress (
  site_code       text not null,
  id              uuid not null,
  work_date       date not null,
  shift           text not null,
  rig_id          text not null,
  hole_id         text not null,
  from_m          numeric(7,2) not null, to_m numeric(7,2) not null, meters numeric(7,2),
  downtime_hours  numeric(4,2), downtime_reason text, remarks text,
  is_deleted      boolean not null,
  created_at      timestamptz, updated_at timestamptz, server_updated_at timestamptz,
  refreshed_at    timestamptz not null default now(),
  primary key (site_code, id)
);
create index if not exists ix_hub_prog_hole on hub_private.drill_progress (site_code, hole_id);
create index if not exists ix_hub_prog_date on hub_private.drill_progress (site_code, work_date);

create table if not exists hub_private.rig (
  site_code text not null, rig_id text not null, rig_name text, rig_type text, is_active boolean,
  refreshed_at timestamptz not null default now(), primary key (site_code, rig_id));
create table if not exists hub_private.prospect (
  site_code text not null, prospect_code text not null, prospect_name text, is_active boolean,
  refreshed_at timestamptz not null default now(), primary key (site_code, prospect_code));
create table if not exists hub_private.code_list (
  site_code text not null, list_code text not null, code text not null, label text, sort_order int,
  is_active boolean, meta jsonb, refreshed_at timestamptz not null default now(),
  primary key (site_code, list_code, code));

-- ---------- functions -------------------------------------------------------
-- change signature of one site (reads hub_export.change_sig over FDW)
create or replace function hub_private.log_signature(p_site text)
returns text language plpgsql as $fn$
declare s text;
begin
  execute format('select sig from %I.change_sig', 'src_' || lower(p_site)) into s;
  return s;
end $fn$;

-- full replace of ONE site inside a sub-transaction: any failure rolls back all of that site's deletes
create or replace function hub_private.refresh_site(p_site text, p_force boolean default false)
returns jsonb language plpgsql as $fn$
declare
  v_src text := 'src_' || lower(p_site);
  v_log bigint;
  rem int; cur int;
  n_c int; n_p int; n_r int; n_pr int; n_cl int;
begin
  insert into hub_private.refresh_log (site_code, status) values (p_site, 'running') returning id into v_log;
  begin
    -- R1 floor guard (data tables only; soft delete means counts should never shrink)
    execute format('select count(*) from %I.collar', v_src) into rem;
    select count(*) into cur from hub_private.collar where site_code = p_site;
    if not p_force and cur >= 20 and rem < cur * 0.5 then
      raise exception 'floor guard: collar rows at site % are < 50%% of hub cache %', rem, cur;
    end if;
    execute format('select count(*) from %I.drill_progress', v_src) into rem;
    select count(*) into cur from hub_private.drill_progress where site_code = p_site;
    if not p_force and cur >= 20 and rem < cur * 0.5 then
      raise exception 'floor guard: drill_progress rows at site % are < 50%% of hub cache %', rem, cur;
    end if;

    -- R2 explicit column lists on both sides
    delete from hub_private.collar where site_code = p_site;
    execute format($q$
      insert into hub_private.collar (site_code, id, hole_id, hole_type, prospect, status,
        planned_lat, planned_lon, planned_elev, planned_depth_m, asbuilt_lat, asbuilt_lon, asbuilt_elev,
        gps_accuracy_m, total_depth_m, photo_path, remarks, is_deleted, created_at, updated_at, server_updated_at)
      select %L, id, hole_id, hole_type, prospect, status,
        planned_lat, planned_lon, planned_elev, planned_depth_m, asbuilt_lat, asbuilt_lon, asbuilt_elev,
        gps_accuracy_m, total_depth_m, photo_path, remarks, is_deleted, created_at, updated_at, server_updated_at
      from %I.collar$q$, p_site, v_src);
    get diagnostics n_c = row_count;

    delete from hub_private.drill_progress where site_code = p_site;
    execute format($q$
      insert into hub_private.drill_progress (site_code, id, work_date, shift, rig_id, hole_id, from_m, to_m, meters,
        downtime_hours, downtime_reason, remarks, is_deleted, created_at, updated_at, server_updated_at)
      select %L, id, work_date, shift, rig_id, hole_id, from_m, to_m, meters,
        downtime_hours, downtime_reason, remarks, is_deleted, created_at, updated_at, server_updated_at
      from %I.drill_progress$q$, p_site, v_src);
    get diagnostics n_p = row_count;

    delete from hub_private.rig where site_code = p_site;
    execute format('insert into hub_private.rig (site_code, rig_id, rig_name, rig_type, is_active) select %L, rig_id, rig_name, rig_type, is_active from %I.rig', p_site, v_src);
    get diagnostics n_r = row_count;

    delete from hub_private.prospect where site_code = p_site;
    execute format('insert into hub_private.prospect (site_code, prospect_code, prospect_name, is_active) select %L, prospect_code, prospect_name, is_active from %I.prospect', p_site, v_src);
    get diagnostics n_pr = row_count;

    delete from hub_private.code_list where site_code = p_site;
    execute format('insert into hub_private.code_list (site_code, list_code, code, label, sort_order, is_active, meta) select %L, list_code, code, label, sort_order, is_active, meta from %I.code_list', p_site, v_src);
    get diagnostics n_cl = row_count;

    update hub_private.refresh_log
       set status = 'ok', finished_at = now(), rows_collar = n_c, rows_progress = n_p,
           rows_rig = n_r, rows_prospect = n_pr, rows_code = n_cl
     where id = v_log;
    return jsonb_build_object('status', 'ok', 'collar', n_c, 'progress', n_p);
  exception when others then
    update hub_private.refresh_log set status = 'error', error_message = sqlerrm, finished_at = now() where id = v_log;
    return jsonb_build_object('status', 'error', 'error', sqlerrm);
  end;
end $fn$;

-- the cron entry point
create or replace function hub_private.refresh_if_changed()
returns jsonb language plpgsql as $fn$
declare
  r record; v_sig text; res jsonb; out jsonb := '{}'::jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('explo_hub_refresh')) then
    return jsonb_build_object('skipped', 'previous run still active');
  end if;

  for r in
    select c.site_code, s.sig as old_sig, s.last_fail_at
    from hub_private.site_config c
    join hub_private.refresh_state s using (site_code)
    where c.enabled
    order by c.site_code
  loop
    begin
      v_sig := hub_private.log_signature(r.site_code);
    exception when others then
      update hub_private.refresh_state set last_checked_at = now(), last_error = 'poll: ' || sqlerrm
       where site_code = r.site_code;
      out := out || jsonb_build_object(r.site_code, 'poll error');
      continue;
    end;

    if v_sig is not distinct from r.old_sig then
      update hub_private.refresh_state set last_checked_at = now() where site_code = r.site_code;
      out := out || jsonb_build_object(r.site_code, 'unchanged');
      continue;
    end if;

    if r.last_fail_at is not null and r.last_fail_at > now() - interval '30 minutes' then
      update hub_private.refresh_state set last_checked_at = now() where site_code = r.site_code;
      out := out || jsonb_build_object(r.site_code, 'backoff');
      continue;
    end if;

    res := hub_private.refresh_site(r.site_code);
    if res->>'status' = 'ok' then
      update hub_private.refresh_state
         set sig = v_sig, last_checked_at = now(), last_ok_at = now(), last_fail_at = null, last_error = null
       where site_code = r.site_code;
    else
      update hub_private.refresh_state
         set last_checked_at = now(), last_fail_at = now(), last_error = res->>'error'
       where site_code = r.site_code;
    end if;
    out := out || jsonb_build_object(r.site_code, res->>'status');
  end loop;
  return out;
end $fn$;

-- Sunday 02:07 WIB: force a full re-pull of every site, prune logs (R9)
create or replace function hub_private.weekly_maintenance()
returns jsonb language plpgsql as $fn$
begin
  update hub_private.refresh_state set sig = null;
  delete from hub_private.refresh_log where started_at < now() - interval '30 days';
  begin
    delete from cron.job_run_details where end_time < now() - interval '7 days';
  exception when others then null;
  end;
  return hub_private.refresh_if_changed();
end $fn$;

-- ---------- Looker / WebGIS views (schema hub) -----------------------------
create or replace view hub.site_status as
select c.site_code, c.enabled,
       s.last_checked_at, s.last_ok_at, s.last_error,
       (select max(work_date) from hub_private.drill_progress p where p.site_code = c.site_code and not p.is_deleted) as latest_progress_date,
       (select count(*) from hub_private.collar x where x.site_code = c.site_code and not x.is_deleted) as collars,
       (select count(*) from hub_private.drill_progress p where p.site_code = c.site_code and not p.is_deleted) as progress_rows,
       round(extract(epoch from (now() - s.last_ok_at)) / 3600.0, 1) as hours_since_ok
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
       c.photo_path, c.remarks, c.updated_at, c.refreshed_at
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
       p.remarks, p.updated_at
from hub_private.drill_progress p
left join hub_private.rig r on r.site_code = p.site_code and r.rig_id = p.rig_id
left join hub_private.code_list sh on sh.site_code = p.site_code and sh.list_code = 'shift' and sh.code = p.shift
left join hub_private.code_list dr on dr.site_code = p.site_code and dr.list_code = 'downtime_reason' and dr.code = p.downtime_reason
left join hub.v_collar c on c.site_code = p.site_code and c.hole_id = p.hole_id
where not p.is_deleted;

create or replace view hub.v_daily_progress as
select site_code, work_date, count(distinct hole_id) as holes, count(distinct rig_id) as rigs,
       sum(meters) as meters, sum(downtime_hours) as downtime_hours
from hub_private.drill_progress
where not is_deleted
group by site_code, work_date;

create or replace view hub.v_hole_summary as
select c.site_code, c.hole_id, c.hole_type, c.hole_type_label, c.prospect, c.status, c.status_label,
       c.planned_depth_m, c.total_depth_m,
       p.meters_logged, p.max_depth_m, p.first_date, p.last_date, p.shifts_logged, p.downtime_hours,
       case when c.planned_depth_m > 0 then round(100 * p.max_depth_m / c.planned_depth_m, 1) end as pct_of_planned
from hub.v_collar c
left join (
  select site_code, hole_id, sum(meters) as meters_logged, max(to_m) as max_depth_m,
         min(work_date) as first_date, max(work_date) as last_date,
         count(*) as shifts_logged, sum(downtime_hours) as downtime_hours
  from hub_private.drill_progress where not is_deleted group by site_code, hole_id
) p on p.site_code = c.site_code and p.hole_id = c.hole_id;

-- GeoJSON for the WebGIS page (later): select hub.collars_geojson('WKM');  -- or null for all sites
create or replace function hub.collars_geojson(p_site text default null)
returns jsonb language sql stable as $fn$
  select jsonb_build_object('type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(jsonb_build_object(
       'type', 'Feature',
       'geometry', extensions.st_asgeojson(t.geom)::jsonb,
       'properties', to_jsonb(t) - 'geom')), '[]'::jsonb))
  from (select * from hub.v_collar where geom is not null and (p_site is null or site_code = p_site)) t
$fn$;

-- ---------- access ----------------------------------------------------------
revoke all on schema hub, hub_private from anon, authenticated;
revoke all on all tables in schema hub_private from anon, authenticated;
revoke all on all tables in schema hub from anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'looker_reader') then
    create role looker_reader login;
  end if;
end $$;
grant usage on schema hub to looker_reader;
grant select on all tables in schema hub to looker_reader;
alter default privileges in schema hub grant select on tables to looker_reader;
alter role looker_reader set default_transaction_read_only = on;
-- Set the password separately:  set password_encryption='scram-sha-256'; alter role looker_reader with password '...';

-- ---------- schedule --------------------------------------------------------
select cron.schedule('hub_refresh_if_changed', '*/3 * * * *', $$select hub_private.refresh_if_changed()$$);
select cron.schedule('hub_weekly_maintenance', '7 19 * * 6', $$select hub_private.weekly_maintenance()$$);   -- Sat 19:07 UTC = Sun 02:07 WIB
