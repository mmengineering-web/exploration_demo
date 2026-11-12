-- ============================================================================
-- EXPLOHUB: dashboard access (schema dash). ONLY needed when the All-sites dashboard is built.
-- The dashboard tabs inside the app read each site's own Supabase and do NOT need this file.
-- Run in explohub after hub_01..hub_04. Safe to run twice.
-- Manual steps (not SQL): Authentication > Users > create each person;
--   Project Settings > Data API > Exposed schemas: add  dash  (never hub or hub_private).
-- ============================================================================

-- ---------- guard: this file belongs in explohub only ------------------------------
do $g$
begin
  if to_regnamespace('hub_private') is null or to_regclass('hub_private.dist_hour') is null then
    raise exception 'Wrong project or hub_01..hub_03 not run: schema hub_private / table hub_private.dist_hour is missing. Run this file only in explohub (nuymrirtigecyrosidga), after hub_01, hub_02 and hub_03. Nothing was changed.';
  end if;
end $g$;

-- ---------- B. dashboard access ----------------------------------------------
create schema if not exists dash;

create table if not exists dash.member (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       text not null default 'viewer' check (role in ('viewer', 'admin')),
  sites      text[],                                  -- NULL = all sites, else only these site codes
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
alter table dash.member enable row level security;   -- no policy on purpose: only the functions below read it

-- sites the caller may see (empty array = not a member)
create or replace function dash.my_sites()
returns text[] language sql stable security definer set search_path = '' as $f$
  select coalesce(
    (select case when m.sites is null
                 then coalesce((select array_agg(c.site_code) from hub_private.site_config c), array[]::text[])
                 else m.sites end
       from dash.member m
      where m.user_id = auth.uid() and m.is_active),
    array[]::text[])
$f$;

-- login check used by the dashboard right after sign-in
create or replace function dash.me()
returns table (email text, role text, sites text[]) language sql stable security definer set search_path = '' as $f$
  select m.email, m.role, m.sites from dash.member m where m.user_id = auth.uid() and m.is_active
$f$;

-- Views run as their owner and filter by caller. Explicit columns, no geometry, no connection details.
create or replace view dash.collar as
select site_code, id, hole_id, hole_type, prospect, status,
       planned_lat, planned_lon, planned_elev, planned_depth_m,
       asbuilt_lat, asbuilt_lon, asbuilt_elev, gps_accuracy_m, total_depth_m,
       dip_deg, azimuth_deg, updated_at
from hub_private.collar
where not is_deleted and site_code = any ((select dash.my_sites())::text[]);

create or replace view dash.drill_progress as
select site_code, id, work_date, shift, rig_id, hole_id, from_m, to_m, meters,
       downtime_hours, downtime_reason, core_len_m, core_recovery_pct, layer, updated_at
from hub_private.drill_progress
where not is_deleted and site_code = any ((select dash.my_sites())::text[]);

create or replace view dash.dist_hour as
select site_code, id, work_date, rig_id, from_time, to_time, hours, activity,
       fuel_l, polymer_l, oil_hyd_l, updated_at
from hub_private.dist_hour
where not is_deleted and site_code = any ((select dash.my_sites())::text[]);

create or replace view dash.sample as
select site_code, id, sample_no, hole_id, from_m, to_m, sample_type, status,
       sampled_date, sent_date, lab, batch_id, updated_at
from hub_private.sample
where not is_deleted and site_code = any ((select dash.my_sites())::text[]);

create or replace view dash.weekly_plan as
select site_code, id, week_start, plan_m, plan_holes
from hub_private.weekly_plan
where not is_deleted and site_code = any ((select dash.my_sites())::text[]);

create or replace view dash.rig as
select site_code, rig_id, rig_name, rig_type, is_active
from hub_private.rig where site_code = any ((select dash.my_sites())::text[]);

create or replace view dash.prospect as
select site_code, prospect_code, prospect_name, is_active
from hub_private.prospect where site_code = any ((select dash.my_sites())::text[]);

create or replace view dash.code_list as
select site_code, list_code, code, label, sort_order, is_active, meta
from hub_private.code_list where site_code = any ((select dash.my_sites())::text[]);

create or replace view dash.site_status as
select s.site_code, s.last_checked_at, s.last_ok_at, s.hours_since_ok, s.latest_progress_date,
       s.collars, s.progress_rows, s.samples, s.assay_rows, s.schema_ver,
       (s.last_error is not null) as has_error
from hub.site_status s
where s.enabled and s.site_code = any ((select dash.my_sites())::text[]);

-- privileges: signed-in users only, nothing for anon
revoke all on schema dash from public, anon;
revoke all on all tables in schema dash from public, anon;
revoke execute on all functions in schema dash from public, anon;
grant usage on schema dash to authenticated;
grant select on dash.collar, dash.drill_progress, dash.dist_hour, dash.sample, dash.weekly_plan,
                dash.rig, dash.prospect, dash.code_list, dash.site_status to authenticated;
grant execute on function dash.my_sites(), dash.me() to authenticated;

-- ---------- add a dashboard user (after creating them in Authentication > Users) ----------
--   insert into dash.member (user_id, email, role)                      -- all sites
--   select id, email, 'viewer' from auth.users where email = 'name@company.com';
--   insert into dash.member (user_id, email, role, sites)               -- two sites only
--   select id, email, 'viewer', array['WKM','BM'] from auth.users where email = 'name@company.com';
--   update dash.member set is_active = false where email = 'name@company.com';   -- switch off
-- ---------- check ----------------------------------------------------------------------
--   select * from hub.v_dist_hour where fuel_l is not null limit 5;
--   select count(*) from dash.drill_progress;       -- as postgres: 0 (not a member); as a member: their rows
