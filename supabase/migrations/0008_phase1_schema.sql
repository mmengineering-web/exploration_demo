-- ============================================================================
-- 0008 (Phase 1 schema): survey, sample status, assay, weekly plan, drill consumables,
-- collar dip/azimuth, UTM zone setting, and a complete export to explohub.
-- Run AFTER 0001-0007, once per site project. Safe to run twice.
-- The explohub export part needs 0003 (schema hub_export); without 0003 it is skipped with a NOTICE.
--
-- What this adds
--   exp_collar          + dip_deg, azimuth_deg (null = vertical, -90 / 0)
--   exp_drill_progress  + layer (Horizon in GeoExploration)
--   code list 'layer'   SED, LIM, SAP, BRK, BLD (editable in Pengaturan > Daftar kode)
--   exp_survey          downhole survey (depth, dip, azimuth)
--   exp_sample          sample registry + lab status (pending / sent / analyzed)
--   exp_assay           assay intervals (Ni Co Fe MgO SiO2 + extra), QAQC fields, source file
--   exp_weekly_plan     planned metres per week (week starts Monday)
--   exp_setting         utm_zone, utm_hemisphere (site level; collar coordinates stay lat/lon)
--   hub_export.*        now also exports rig hours, core result, layer, survey, sample,
--                       assay, weekly plan and the UTM settings to explohub.
--                       Core / collar photos stay on the site (photo_path is exported as null);
--                       the IUP boundary is not exported (map layer inside the app only).
-- ============================================================================

-- ---------- site settings: UTM -----------------------------------------------
-- Collar coordinates stay WGS84 lat/lon (map, duplicate guard). UTM x/y for 3D,
-- sections and estimation are derived from lat/lon with this zone, so the two
-- can never disagree. SET THE ZONE PER SITE (Indonesia spans zones 46-54), e.g.:
--   insert into public.exp_setting (key, value) values ('utm_zone', '51')
--   on conflict (key) do update set value = excluded.value;
insert into public.exp_setting (key, value) values ('utm_hemisphere', '"S"') on conflict (key) do nothing;

-- ---------- collar: dip / azimuth --------------------------------------------
alter table public.exp_collar add column if not exists dip_deg     numeric(5,2) default -90;
alter table public.exp_collar add column if not exists azimuth_deg numeric(5,2) default 0;
alter table public.exp_collar drop constraint if exists chk_collar_dip;
alter table public.exp_collar add  constraint chk_collar_dip check (dip_deg is null or dip_deg between -90 and 90);
alter table public.exp_collar drop constraint if exists chk_collar_azimuth;
alter table public.exp_collar add  constraint chk_collar_azimuth check (azimuth_deg is null or azimuth_deg between 0 and 360);

-- ---------- drilling progress: layer + consumables ----------------------------
alter table public.exp_drill_progress add column if not exists layer     text;      -- Horizon: code from list 'layer'
-- (fuel / polymer / hyd oil are recorded per rig entry in exp_dist_hour, see 0013)

-- ---------- code lists: layer, sample type, sample status ---------------------
alter table public.exp_code_list drop constraint if exists exp_code_list_list_code_check;
alter table public.exp_code_list add constraint exp_code_list_list_code_check
  check (list_code in ('hole_type','collar_status','shift','downtime_reason','activity','sample_type','sample_status','layer'));

insert into public.exp_code_list (list_code, code, label, sort_order, meta, description) values
  ('layer','SED','Sedimen',10,'{}','Lapisan sedimen / overburden'),
  ('layer','LIM','Limonit',20,'{}','Zona limonit'),
  ('layer','SAP','Saprolit',30,'{}','Zona saprolit'),
  ('layer','BRK','Bedrock',40,'{}','Batuan dasar'),
  ('layer','BLD','Boulder',50,'{}','Boulder / fragmen keras'),
  ('sample_type','NORMAL','Normal',10,'{}','Sampel core/cuttings biasa dari interval lubang'),
  ('sample_type','DUPLICATE','Duplicate',20,'{"is_qaqc":true}','Duplikat lapangan atau lab'),
  ('sample_type','CRM','CRM/Standard',30,'{"is_qaqc":true}','Certified reference material'),
  ('sample_type','BLANK','Blank',40,'{"is_qaqc":true}','Sampel blank'),
  ('sample_status','PENDING','Belum dikirim',10,'{}','Sampel sudah diambil, belum dikirim ke lab'),
  ('sample_status','SENT','Terkirim ke lab',20,'{}','Sudah dikirim, hasil belum diterima'),
  ('sample_status','ANALYZED','Sudah dianalisis',30,'{}','Hasil assay sudah diterima')
on conflict (list_code, code) do nothing;

-- in-use guard (replaces the 0007 version; adds sample type and sample status)
create or replace function public.exp_guard_in_use()
returns trigger language plpgsql security definer set search_path = public as $$
declare n bigint := 0; what text;
begin
  if tg_table_name = 'exp_rig' then
    select count(*) into n from public.exp_drill_progress where rig_id = old.rig_id; what := 'record progress';
    n := n + (select count(*) from public.exp_dist_hour where rig_id = old.rig_id);
  elsif tg_table_name = 'exp_prospect' then
    select count(*) into n from public.exp_collar where prospect = old.prospect_code; what := 'collar';
  elsif tg_table_name = 'exp_code_list' then
    what := case old.list_code
              when 'hole_type' then 'collar' when 'collar_status' then 'collar'
              when 'activity' then 'record jam rig'
              when 'sample_type' then 'sampel' when 'sample_status' then 'sampel'
              when 'layer' then 'record progress/assay'
              else 'record progress' end;
    if old.list_code = 'hole_type'       then select count(*) into n from public.exp_collar         where hole_type = old.code; end if;
    if old.list_code = 'collar_status'   then select count(*) into n from public.exp_collar         where status = old.code; end if;
    if old.list_code = 'shift'           then select count(*) into n from public.exp_drill_progress where shift = old.code; end if;
    if old.list_code = 'downtime_reason' then select count(*) into n from public.exp_drill_progress where downtime_reason = old.code; end if;
    if old.list_code = 'activity'        then select count(*) into n from public.exp_dist_hour      where activity = old.code; end if;
    if old.list_code = 'sample_type'     then n := (select count(*) from public.exp_sample where sample_type = old.code)
                                                 + (select count(*) from public.exp_assay  where sample_type = old.code); end if;
    if old.list_code = 'sample_status'   then select count(*) into n from public.exp_sample where status = old.code; end if;
    if old.list_code = 'layer'           then n := (select count(*) from public.exp_drill_progress where layer = old.code)
                                                 + (select count(*) from public.exp_assay where layer = old.code); end if;
  elsif tg_table_name = 'exp_role_def' then
    select count(*) into n from public.exp_profile where role = old.role; what := 'user';
  end if;
  if n > 0 then
    raise exception 'Tidak bisa dihapus: masih dipakai % %. Nonaktifkan saja (hilangkan centang Aktif).', n, what;
  end if;
  return old;
end $$;

-- ---------- survey ------------------------------------------------------------
create table if not exists public.exp_survey (
  id          uuid primary key default gen_random_uuid(),
  hole_id     text not null,
  depth_m     numeric(7,2) not null check (depth_m >= 0),
  dip_deg     numeric(5,2) not null check (dip_deg between -90 and 90),
  azimuth_deg numeric(5,2) not null check (azimuth_deg between 0 and 360),
  method      text,
  survey_date date,
  remarks     text,
  is_deleted  boolean not null default false,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  constraint chk_survey_hole_fmt check (hole_id ~ '^[A-Z0-9-]{4,30}$')
);
create unique index if not exists uq_exp_survey_live on public.exp_survey (hole_id, depth_m) where not is_deleted;
create index if not exists ix_exp_survey_server_upd on public.exp_survey (server_updated_at);

-- ---------- sample registry + lab status --------------------------------------
create table if not exists public.exp_sample (
  id           uuid primary key default gen_random_uuid(),
  sample_no    text not null,
  hole_id      text not null,
  from_m       numeric(7,2) not null check (from_m >= 0),
  to_m         numeric(7,2) not null,
  sample_type  text not null default 'NORMAL',
  status       text not null default 'PENDING',
  sampled_date date,
  sent_date    date,
  lab          text,
  batch_id     text,
  remarks      text,
  is_deleted   boolean not null default false,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  constraint chk_sample_interval check (to_m > from_m),
  constraint chk_sample_dates    check (sent_date is null or sampled_date is null or sent_date >= sampled_date),
  constraint chk_sample_hole_fmt check (hole_id ~ '^[A-Z0-9-]{4,30}$')
);
create unique index if not exists uq_exp_sample_no_live on public.exp_sample (sample_no) where not is_deleted;
create index if not exists ix_exp_sample_hole on public.exp_sample (hole_id, from_m);
create index if not exists ix_exp_sample_server_upd on public.exp_sample (server_updated_at);

-- ---------- assay (loaded by import: Excel or lab PDF) ------------------------
create table if not exists public.exp_assay (
  id            uuid primary key default gen_random_uuid(),
  hole_id       text not null,
  from_m        numeric(7,2) not null check (from_m >= 0),
  to_m          numeric(7,2) not null,
  sample_no     text,
  layer         text,                                       -- Horizon in GeoExploration; code from list 'layer'
  ni_pct        numeric(7,3) check (ni_pct   between 0 and 100),
  co_pct        numeric(7,3) check (co_pct   between 0 and 100),
  fe_pct        numeric(7,3) check (fe_pct   between 0 and 100),
  mgo_pct       numeric(7,3) check (mgo_pct  between 0 and 100),
  sio2_pct      numeric(7,3) check (sio2_pct between 0 and 100),
  extra         jsonb not null default '{}'::jsonb,        -- other elements, e.g. {"al2o3_pct": 4.2}
  sample_type   text not null default 'NORMAL',
  batch_id      text,
  lab           text,
  certificate_no text,
  crm_name      text,
  crm_element   text,
  crm_expected  numeric(9,4),
  duplicate_type text,
  duplicate_of_sample_no text,
  source_type   text check (source_type in ('excel','pdf','manual')),
  source_file   text,
  remarks       text,
  is_deleted    boolean not null default false,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  constraint chk_assay_interval check (to_m > from_m),
  constraint chk_assay_hole_fmt check (hole_id ~ '^[A-Z0-9-]{4,30}$')
);
-- natural key: one live row per hole + interval + sample number (QAQC duplicates share the interval but have their own sample_no)
create unique index if not exists uq_exp_assay_live on public.exp_assay (hole_id, from_m, to_m, coalesce(sample_no, '')) where not is_deleted;
create index if not exists ix_exp_assay_hole on public.exp_assay (hole_id, from_m);
create index if not exists ix_exp_assay_server_upd on public.exp_assay (server_updated_at);

-- ---------- weekly plan (week starts Monday) ----------------------------------
create table if not exists public.exp_weekly_plan (
  id          uuid primary key default gen_random_uuid(),
  week_start  date not null check (extract(isodow from week_start) = 1),
  plan_m      numeric(8,1) not null check (plan_m >= 0),
  plan_holes  int check (plan_holes >= 0),
  remarks     text,
  is_deleted  boolean not null default false,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
create unique index if not exists uq_exp_weekly_plan_live on public.exp_weekly_plan (week_start) where not is_deleted;
create index if not exists ix_exp_weekly_plan_server_upd on public.exp_weekly_plan (server_updated_at);

-- ---------- guards ------------------------------------------------------------
-- trim / normalise text so the same assay never differs only by case or spaces
create or replace function public.exp_normalize_p1()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'exp_assay' then
    new.crm_element := nullif(lower(btrim(new.crm_element)), '');
    new.sample_no   := nullif(btrim(new.sample_no), '');
  elsif tg_table_name = 'exp_sample' then
    new.sample_no   := btrim(new.sample_no);
  end if;
  return new;
end $$;

-- codes must exist in the code list
create or replace function public.exp_check_codes_p1()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.sample_type is distinct from old.sample_type then
    if not exists (select 1 from public.exp_code_list where list_code = 'sample_type' and code = new.sample_type) then
      raise exception 'Unknown sample_type: %', new.sample_type;
    end if;
  end if;
  -- nested on purpose: plpgsql resolves new.status even behind "and", and exp_assay has no status column
  if tg_table_name = 'exp_sample' then
    if tg_op = 'INSERT' or new.status is distinct from old.status then
      if not exists (select 1 from public.exp_code_list where list_code = 'sample_status' and code = new.status) then
        raise exception 'Unknown sample status: %', new.status;
      end if;
    end if;
  end if;
  return new;
end $$;

-- layer (progress and assay): trimmed, upper-cased, must exist in the code list
create or replace function public.exp_check_layer()
returns trigger language plpgsql as $$
begin
  new.layer := nullif(upper(btrim(new.layer)), '');
  if new.layer is not null and (tg_op = 'INSERT' or new.layer is distinct from old.layer)
     and not exists (select 1 from public.exp_code_list where list_code = 'layer' and code = new.layer) then
    raise exception 'Layer tidak dikenal: %', new.layer;
  end if;
  return new;
end $$;
drop trigger if exists trg_exp_prog_layer on public.exp_drill_progress;
create trigger trg_exp_prog_layer before insert or update on public.exp_drill_progress
  for each row execute function public.exp_check_layer();

-- NORMAL samples / assays of one hole must not overlap (QAQC rows share intervals on purpose)
create or replace function public.exp_guard_interval()
returns trigger language plpgsql as $$
declare o record;
begin
  if new.is_deleted or new.sample_type <> 'NORMAL' then return new; end if;
  if tg_table_name = 'exp_sample' then
    select sample_no as ref, from_m, to_m into o from public.exp_sample
     where id <> new.id and not is_deleted and sample_type = 'NORMAL' and hole_id = new.hole_id
       and from_m < new.to_m and to_m > new.from_m limit 1;
  else
    select coalesce(sample_no, 'tanpa nomor') as ref, from_m, to_m into o from public.exp_assay
     where id <> new.id and not is_deleted and sample_type = 'NORMAL' and hole_id = new.hole_id
       and from_m < new.to_m and to_m > new.from_m limit 1;
  end if;
  if found then
    raise exception 'Interval % - % m overlap dengan % (% - % m) di lubang %.',
      new.from_m, new.to_m, o.ref, o.from_m, o.to_m, new.hole_id using errcode = '23P01';
  end if;
  return new;
end $$;

-- triggers (fire in name order: normalise, touch, codes, guard)
do $$
declare t text;
begin
  foreach t in array array['exp_survey','exp_sample','exp_assay','exp_weekly_plan'] loop
    execute format('drop trigger if exists %I on public.%I', 'trg_'||t||'_2_touch', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.exp_touch()', 'trg_'||t||'_2_touch', t);
  end loop;
  drop trigger if exists trg_exp_assay_3b_layer on public.exp_assay;
  create trigger trg_exp_assay_3b_layer before insert or update on public.exp_assay
    for each row execute function public.exp_check_layer();
  foreach t in array array['exp_sample','exp_assay'] loop
    execute format('drop trigger if exists %I on public.%I', 'trg_'||t||'_1_norm', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.exp_normalize_p1()', 'trg_'||t||'_1_norm', t);
    execute format('drop trigger if exists %I on public.%I', 'trg_'||t||'_3_codes', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.exp_check_codes_p1()', 'trg_'||t||'_3_codes', t);
    execute format('drop trigger if exists %I on public.%I', 'trg_'||t||'_4_guard', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.exp_guard_interval()', 'trg_'||t||'_4_guard', t);
  end loop;
end $$;

-- ---------- RLS ---------------------------------------------------------------
-- read: any active role. write: writers (survey, sample, assay); admins only (weekly plan). No hard delete.
alter table public.exp_survey      enable row level security;
alter table public.exp_sample      enable row level security;
alter table public.exp_assay       enable row level security;
alter table public.exp_weekly_plan enable row level security;

do $$
declare t text; w text;
begin
  foreach t in array array['exp_survey','exp_sample','exp_assay','exp_weekly_plan'] loop
    w := case when t = 'exp_weekly_plan' then 'public.exp_can_admin()' else 'public.exp_can_write()' end;
    execute format('drop policy if exists %I on public.%I', t||'_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.exp_role() is not null)', t||'_read', t);
    execute format('drop policy if exists %I on public.%I', t||'_ins', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', t||'_ins', t, w);
    execute format('drop policy if exists %I on public.%I', t||'_upd', t);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', t||'_upd', t, w, w);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke delete on public.%I from authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------- data-quality and summary views ------------------------------------
create or replace view public.v_exp_dq_assay_unknown_hole with (security_invoker = true) as
select a.* from public.exp_assay a
left join public.exp_collar c on c.hole_id = a.hole_id and not c.is_deleted
where not a.is_deleted and c.id is null;

create or replace view public.v_exp_dq_sample_unknown_hole with (security_invoker = true) as
select s.* from public.exp_sample s
left join public.exp_collar c on c.hole_id = s.hole_id and not c.is_deleted
where not s.is_deleted and c.id is null;

-- samples per hole and status (long format: stays correct if an admin renames or adds statuses)
create or replace view public.v_exp_sample_status with (security_invoker = true) as
select hole_id, status, count(*) as samples,
       sum(case when sample_type = 'NORMAL' then to_m - from_m else 0 end) as metres_sampled,
       min(sampled_date) as first_sampled, max(sent_date) as last_sent
from public.exp_sample where not is_deleted
group by hole_id, status;

-- planned vs actual metres per week (week = Monday start, same rule as the plan)
create or replace view public.v_exp_weekly_plan_actual with (security_invoker = true) as
with act as (
  select date_trunc('week', work_date)::date as week_start, sum(meters) as actual_m, count(distinct hole_id) as holes_drilled
  from public.exp_drill_progress where not is_deleted group by 1
), pl as (
  select week_start, plan_m, plan_holes from public.exp_weekly_plan where not is_deleted
)
select week_start, pl.plan_m, coalesce(act.actual_m, 0) as actual_m,
       case when pl.plan_m > 0 then round(coalesce(act.actual_m, 0) / pl.plan_m * 100, 1) end as achievement_pct,
       pl.plan_holes, coalesce(act.holes_drilled, 0) as holes_drilled
from pl full join act using (week_start);

grant select on public.v_exp_dq_assay_unknown_hole, public.v_exp_dq_sample_unknown_hole,
                public.v_exp_sample_status, public.v_exp_weekly_plan_actual to authenticated;
revoke all on public.v_exp_dq_assay_unknown_hole, public.v_exp_dq_sample_unknown_hole,
              public.v_exp_sample_status, public.v_exp_weekly_plan_actual from anon;

-- ---------- export to explohub (schema hub_export) ----------------------------
-- Only runs when the site already has the explohub export (migration 0003 created schema hub_export).
-- A site that does not use explohub yet skips this block (NOTICE). When you set up explohub later:
-- run 0003 first, then run this file again.
do $exp$
begin
  if to_regnamespace('hub_export') is null or not exists (select 1 from pg_roles where rolname = 'hub_reader') then
    raise notice 'hub_export / hub_reader not found: export views skipped. Run 0003_site_hub_export.sql, then run 0008 again.';
    return;
  end if;
  execute $sql$
-- Existing views keep their columns and order; new columns are appended, so an explohub that
-- has not been upgraded yet keeps working. New views are added.
create or replace view hub_export.collar as
select id, hole_id, hole_type, prospect, status,
       planned_lat, planned_lon, planned_elev, planned_depth_m,
       asbuilt_lat, asbuilt_lon, asbuilt_elev, gps_accuracy_m,
       total_depth_m, null::text as photo_path, remarks, is_deleted,    -- photos stay on the site
       created_at, updated_at, server_updated_at,
       dip_deg, azimuth_deg
from public.exp_collar;

create or replace view hub_export.drill_progress as
select id, work_date, shift, rig_id, hole_id, from_m, to_m, meters,
       downtime_hours, downtime_reason, remarks, is_deleted,
       created_at, updated_at, server_updated_at,
       core_len_m, core_recovery_pct, layer,
       null::numeric(7,1) as fuel_l, null::numeric(7,1) as polymer_l, null::numeric(7,1) as oil_hyd_l   -- kept so the hub's column list still matches; consumables live in dist_hour
from public.exp_drill_progress;

drop view if exists hub_export.dist_hour;   -- 0013 appends consumables columns; re-created there on every run
create view hub_export.dist_hour as
select id, work_date, rig_id, from_time, to_time, hours, activity, remarks, is_deleted,
       created_at, updated_at, server_updated_at
from public.exp_dist_hour;

create or replace view hub_export.survey as
select id, hole_id, depth_m, dip_deg, azimuth_deg, method, survey_date, remarks, is_deleted,
       created_at, updated_at, server_updated_at
from public.exp_survey;

create or replace view hub_export.sample as
select id, sample_no, hole_id, from_m, to_m, sample_type, status, sampled_date, sent_date,
       lab, batch_id, remarks, is_deleted, created_at, updated_at, server_updated_at
from public.exp_sample;

drop view if exists hub_export.assay;   -- 0014 appends columns; re-created there on every run (same pattern as dist_hour)
create view hub_export.assay as
select id, hole_id, from_m, to_m, sample_no, layer,
       ni_pct, co_pct, fe_pct, mgo_pct, sio2_pct, extra,
       sample_type, batch_id, lab, certificate_no, crm_name, crm_element, crm_expected,
       duplicate_type, duplicate_of_sample_no, source_type, source_file, remarks, is_deleted,
       created_at, updated_at, server_updated_at
from public.exp_assay;

create or replace view hub_export.weekly_plan as
select id, week_start, plan_m, plan_holes, remarks, is_deleted, created_at, updated_at, server_updated_at
from public.exp_weekly_plan;

-- only what explohub needs (UTM for 3D / sections); other settings stay on the site
create or replace view hub_export.site_setting as
select key, value from public.exp_setting where key in ('utm_zone', 'utm_hemisphere');

-- explohub checks this before it reads the new views; bump it when the export changes again
create or replace view hub_export.schema_version as select 8 as version;

-- one change signature over everything explohub copies (adds the new tables)
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
  || '#' ||
  (select count(*)::text || '|' || coalesce(max(server_updated_at)::text, '') from public.exp_dist_hour)
  || '#' ||
  (select count(*)::text || '|' || coalesce(max(server_updated_at)::text, '') from public.exp_survey)
  || '#' ||
  (select count(*)::text || '|' || coalesce(max(server_updated_at)::text, '') from public.exp_sample)
  || '#' ||
  (select count(*)::text || '|' || coalesce(max(server_updated_at)::text, '') from public.exp_assay)
  || '#' ||
  (select count(*)::text || '|' || coalesce(max(server_updated_at)::text, '') from public.exp_weekly_plan)
  || '#' ||
  (select md5(coalesce(string_agg(key || '|' || value::text, ',' order by key), '')) from public.exp_setting where key in ('utm_zone', 'utm_hemisphere'))
  as sig;

-- hub_reader (created in 0003) may read the new views
grant usage on schema hub_export to hub_reader;
grant select on all tables in schema hub_export to hub_reader;
  $sql$;
end
$exp$;

-- ---------- optional: tighten the Hole ID pattern (not applied) ---------------
-- Convention SITE-TYPE-NNNN, e.g. WKM-DD-0001. Unplanned holes created on a phone look like
-- WKM-AG-KP001 (device letters + 3 digits), so the default pattern stays loose. To enforce 4 digits only:
-- update public.exp_setting set value = '"^[A-Z0-9]{2,6}-[A-Z]{2}-[0-9]{4}$"' where key = 'hole_id_regex';

-- ---------- check after running ----------------------------------------------
-- select * from hub_export.schema_version;                -- 8
-- select * from public.exp_setting where key like 'utm%'; -- set utm_zone for this site
