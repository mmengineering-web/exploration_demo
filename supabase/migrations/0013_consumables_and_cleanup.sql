-- ============================================================================
-- 0013: consumables move to Distribution Hour + drop what the app no longer uses.
-- Run once per site, after 0012. Safe to run twice. Does not touch the hub (supabase/hub/*).
--
-- 1. exp_dist_hour gets fuel_l, polymer_l, oil_hyd_l (per rig entry, optional).
--    exp_drill_progress loses the same three columns (the app never filled them on that form).
--    The run STOPS, changing nothing, if any Progress row still holds a consumables value:
--    export those rows first (they cannot be moved to rig entries automatically).
-- 2. hub_export keeps its contract: drill_progress still exposes fuel_l / polymer_l / oil_hyd_l
--    (always NULL now) so the hub's explicit column list keeps matching; dist_hour gets the three
--    columns appended (the hub ignores them until its own pull list is extended).
-- 3. Dropped because the app does not read them: exp_map_layer (map layers are device-only) and the
--    seven site views v_exp_* (the dashboard reads the hub, not these).
--    Kept on purpose: exp_weekly_plan (the hub pulls it), exp_iup (boundary shown on the map).
-- ============================================================================

-- 1a. new columns on rig entries
alter table public.exp_dist_hour add column if not exists fuel_l    numeric(7,1) check (fuel_l    >= 0);
alter table public.exp_dist_hour add column if not exists polymer_l numeric(7,1) check (polymer_l >= 0);
alter table public.exp_dist_hour add column if not exists oil_hyd_l numeric(7,1) check (oil_hyd_l >= 0);

-- 1b. refuse to drop consumables that hold data
do $$
declare n bigint;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'exp_drill_progress' and column_name = 'fuel_l') then
    execute 'select count(*) from public.exp_drill_progress where fuel_l is not null or polymer_l is not null or oil_hyd_l is not null' into n;
    if n > 0 then
      raise exception '% Progress rows still hold consumables (fuel / polymer / hyd oil). Export them first (select id, work_date, rig_id, hole_id, fuel_l, polymer_l, oil_hyd_l from public.exp_drill_progress where fuel_l is not null or polymer_l is not null or oil_hyd_l is not null), then run again. Nothing was changed.', n;
    end if;
  end if;
end $$;

-- 2. hub export views first (they depend on the columns being dropped)
do $exp$
begin
  if to_regnamespace('hub_export') is null or not exists (select 1 from pg_roles where rolname = 'hub_reader') then
    raise notice 'hub_export / hub_reader not found: export views skipped.';
    return;
  end if;
  create or replace view hub_export.drill_progress as
    select id, work_date, shift, rig_id, hole_id, from_m, to_m, meters,
           downtime_hours, downtime_reason, remarks, is_deleted,
           created_at, updated_at, server_updated_at,
           core_len_m, core_recovery_pct, layer,
           null::numeric(7,1) as fuel_l, null::numeric(7,1) as polymer_l, null::numeric(7,1) as oil_hyd_l
    from public.exp_drill_progress;
  create or replace view hub_export.dist_hour as
    select id, work_date, rig_id, from_time, to_time, hours, activity, remarks, is_deleted,
           created_at, updated_at, server_updated_at,
           fuel_l, polymer_l, oil_hyd_l
    from public.exp_dist_hour;
  grant select on hub_export.drill_progress, hub_export.dist_hour to hub_reader;
end
$exp$;

-- 1c. drop the old columns
alter table public.exp_drill_progress
  drop column if exists fuel_l, drop column if exists polymer_l, drop column if exists oil_hyd_l;

-- 3. objects the app does not use
drop table if exists public.exp_map_layer;
drop view if exists public.v_exp_hole_progress, public.v_exp_dist_hour_summary, public.v_exp_sample_status,
                    public.v_exp_weekly_plan_actual, public.v_exp_dq_progress_unknown_hole,
                    public.v_exp_dq_sample_unknown_hole, public.v_exp_dq_assay_unknown_hole;

-- check: select column_name from information_schema.columns where table_name = 'exp_dist_hour' and column_name in ('fuel_l','polymer_l','oil_hyd_l');
