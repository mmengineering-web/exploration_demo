-- ============================================================================
-- Exploration PWA — migration 0003 (SITE side): read-only interface for the hub
-- Run AFTER 0001 and 0002, once per site project.
--
-- The hub never reads public.exp_* directly. It reads schema hub_export, whose
-- column lists are fixed here. The site may change its internal tables later as
-- long as these views keep the same columns.
-- ============================================================================

create schema if not exists hub_export;

-- collar and drill_progress are created only once: 0008 and 0013 later extend them, and re-running this file must not shrink them.
do $v$
begin
  if to_regclass('hub_export.collar') is null then
    execute $q$create view hub_export.collar as
select id, hole_id, hole_type, prospect, status,
       planned_lat, planned_lon, planned_elev, planned_depth_m,
       asbuilt_lat, asbuilt_lon, asbuilt_elev, gps_accuracy_m,
       total_depth_m, photo_path, remarks, is_deleted,
       created_at, updated_at, server_updated_at
from public.exp_collar;
$q$;
  end if;
  if to_regclass('hub_export.drill_progress') is null then
    execute $q$create view hub_export.drill_progress as
select id, work_date, shift, rig_id, hole_id, from_m, to_m, meters,
       downtime_hours, downtime_reason, remarks, is_deleted,
       created_at, updated_at, server_updated_at
from public.exp_drill_progress;
$q$;
  end if;
end $v$;

create or replace view hub_export.rig as
select rig_id, rig_name, rig_type, is_active from public.exp_rig;

create or replace view hub_export.prospect as
select prospect_code, prospect_name, is_active from public.exp_prospect;

create or replace view hub_export.code_list as
select list_code, code, label, sort_order, is_active, meta from public.exp_code_list;

-- Change detection: ONE text value that changes whenever anything the hub copies changes.
-- Row count catches deletes; max(server_updated_at) catches inserts/updates (incl. soft delete);
-- md5 of the small config tables catches admin edits.
create or replace view hub_export.change_sig as
select
  (select count(*)::text || '|' || coalesce(max(server_updated_at)::text, '') from public.exp_collar)
  || '#' ||
  (select count(*)::text || '|' || coalesce(max(server_updated_at)::text, '') from public.exp_drill_progress)
  || '#' ||
  (select md5(coalesce(string_agg(rig_id || '|' || rig_name || '|' || coalesce(rig_type, '') || '|' || is_active::text, ',' order by rig_id), '')) from public.exp_rig)
  || '#' ||
  (select md5(coalesce(string_agg(prospect_code || '|' || prospect_name || '|' || is_active::text, ',' order by prospect_code), '')) from public.exp_prospect)
  || '#' ||
  (select md5(coalesce(string_agg(list_code || '|' || code || '|' || label || '|' || sort_order::text || '|' || is_active::text || '|' || meta::text, ',' order by list_code, code), '')) from public.exp_code_list)
  as sig;

-- ---------- read-only role used ONLY by the hub ------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hub_reader') then
    create role hub_reader login;
  end if;
end $$;

-- hub_reader sees hub_export and nothing else
revoke all on all tables in schema public from hub_reader;
revoke all on schema public from hub_reader;
grant usage on schema hub_export to hub_reader;
revoke all on all tables in schema hub_export from hub_reader;
grant select on all tables in schema hub_export to hub_reader;   -- includes views
alter default privileges in schema hub_export grant select on tables to hub_reader;
alter role hub_reader connection limit 3;
alter role hub_reader set statement_timeout = '60s';
alter role hub_reader set default_transaction_read_only = on;

-- ---------- SET THE PASSWORD SEPARATELY (never commit it) --------------------
-- Run this in the SQL Editor with a long random password, then paste the same
-- password into hub_02_add_site.sql when you connect this site to the hub:
--   set password_encryption = 'scram-sha-256';
--   alter role hub_reader with password 'PASTE-A-LONG-RANDOM-PASSWORD';
-- (The Supabase pooler rejects non-SCRAM passwords: "unsupported or invalid secret format".)
