-- ============================================================================
-- 0014: lab Report of Analysis (RoA) import + geochemical QAQC.
-- Run once per site, after 0013. Safe to run twice. Does not touch the hub tables (supabase/hub/*).
--
-- 1. exp_assay gets lab_seq, client_ref, received_date, tested_date, reported_date
--    (all optional; filled by the RoA PDF import).
-- 2. BLANK and CRM rows have no hole and no interval, so hole_id / from_m / to_m become nullable.
--    A check keeps NORMAL and DUPLICATE rows strict: they still need a hole and a valid interval.
-- 3. exp_crm: certified values and SD per reference material and analyte (used for the Z-score).
--    Read by every active role, written by admins only. Seeded with OREAS 182b.
-- 4. exp_setting: default QAQC thresholds (key 'qaqc_thresholds', editable by admins).
-- 5. hub_export.assay: new columns appended; rows without a hole are NOT exported
--    (the hub table requires a hole). The hub's explicit column list keeps working.
-- ============================================================================

-- 1. RoA columns
alter table public.exp_assay add column if not exists lab_seq       int;
alter table public.exp_assay add column if not exists client_ref    text;
alter table public.exp_assay add column if not exists received_date date;
alter table public.exp_assay add column if not exists tested_date   date;
alter table public.exp_assay add column if not exists reported_date date;

-- 2. nullable hole / interval for QC rows, strict for the rest
alter table public.exp_assay alter column hole_id drop not null;
alter table public.exp_assay alter column from_m  drop not null;
alter table public.exp_assay alter column to_m    drop not null;

alter table public.exp_assay drop constraint if exists chk_assay_interval;
alter table public.exp_assay add  constraint chk_assay_interval
  check (to_m is null or from_m is null or to_m > from_m);

alter table public.exp_assay drop constraint if exists chk_assay_hole_fmt;
alter table public.exp_assay add  constraint chk_assay_hole_fmt
  check (hole_id is null or hole_id ~ '^[A-Z0-9-]{4,30}$');

alter table public.exp_assay drop constraint if exists chk_assay_needs_interval;
alter table public.exp_assay add  constraint chk_assay_needs_interval
  check (sample_type in ('BLANK', 'CRM') or (hole_id is not null and from_m is not null and to_m is not null));

-- the live-row key stays; rows with a NULL hole never collide in a unique index, so
-- BLANK/CRM rows are protected by sample_no + batch instead:
create unique index if not exists uq_exp_assay_qc_live
  on public.exp_assay (coalesce(batch_id, ''), sample_no)
  where not is_deleted and hole_id is null and sample_no is not null;

-- the overlap guard compares hole + interval; QC rows without a hole are skipped
create or replace function public.exp_guard_interval()
returns trigger language plpgsql as $$
declare o record;
begin
  if new.is_deleted or new.sample_type <> 'NORMAL' or new.hole_id is null then return new; end if;
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

-- 3. certified reference materials
create table if not exists public.exp_crm (
  id              uuid primary key default gen_random_uuid(),
  crm_name        text not null,
  analyte         text not null,
  certified_value numeric(12,5) not null,
  sd              numeric(12,5) not null check (sd > 0),
  unit            text not null default '%',
  source          text,
  is_deleted      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
create unique index if not exists uq_exp_crm_live on public.exp_crm (upper(crm_name), analyte) where not is_deleted;

drop trigger if exists trg_exp_crm_2_touch on public.exp_crm;
create trigger trg_exp_crm_2_touch before insert or update on public.exp_crm
  for each row execute function public.exp_touch();

alter table public.exp_crm enable row level security;
drop policy if exists exp_crm_read on public.exp_crm;
create policy exp_crm_read on public.exp_crm for select to authenticated using (public.exp_role() is not null);
drop policy if exists exp_crm_ins on public.exp_crm;
create policy exp_crm_ins on public.exp_crm for insert to authenticated with check (public.exp_can_admin());
drop policy if exists exp_crm_upd on public.exp_crm;
create policy exp_crm_upd on public.exp_crm for update to authenticated using (public.exp_can_admin()) with check (public.exp_can_admin());

-- OREAS 182b (certificate values; Fe2O3 / MgO / SiO2 / Al2O3 / Cr2O3 are oxide %).
insert into public.exp_crm (crm_name, analyte, certified_value, sd, unit, source) values
  ('OREAS 182b', 'Ni',    0.757,  0.018,  '%', 'OREAS 182b certificate'),
  ('OREAS 182b', 'Co',    0.0809, 0.0016, '%', 'OREAS 182b certificate'),
  ('OREAS 182b', 'Fe2O3', 32.78,  0.283,  '%', 'OREAS 182b certificate'),
  ('OREAS 182b', 'MgO',   8.75,   0.149,  '%', 'OREAS 182b certificate'),
  ('OREAS 182b', 'SiO2',  32.33,  0.323,  '%', 'OREAS 182b certificate'),
  ('OREAS 182b', 'Al2O3', 6.91,   0.101,  '%', 'OREAS 182b certificate'),
  ('OREAS 182b', 'Cr2O3', 0.845,  0.012,  '%', 'OREAS 182b certificate')
on conflict do nothing;

-- 4. default thresholds (admins can edit the JSON; the app falls back to these values if the key is missing)
insert into public.exp_setting (key, value) values ('qaqc_thresholds', '{
  "blank_ni_max": 0.05,
  "dup_ard_ni_max": {"PD": 0.05, "CD": 0.10, "RD": 0.10},
  "crm_z_warn": 2,
  "crm_z_fail": 3,
  "fe2o3_tol_pct": 3,
  "mc_max": 45,
  "cutoff_ni": 0.8
}'::jsonb) on conflict (key) do nothing;

-- 5. hub export: append columns, hide hole-less QC rows (the hub requires a hole)
do $exp$
begin
  if to_regnamespace('hub_export') is null or not exists (select 1 from pg_roles where rolname = 'hub_reader') then
    raise notice 'hub_export / hub_reader not found: export view skipped.';
    return;
  end if;
  create or replace view hub_export.assay as
    select id, hole_id, from_m, to_m, sample_no, layer,
           ni_pct, co_pct, fe_pct, mgo_pct, sio2_pct, extra,
           sample_type, batch_id, lab, certificate_no, crm_name, crm_element, crm_expected,
           duplicate_type, duplicate_of_sample_no, source_type, source_file, remarks, is_deleted,
           created_at, updated_at, server_updated_at,
           lab_seq, client_ref, received_date, tested_date, reported_date
    from public.exp_assay
    where hole_id is not null;
  grant select on hub_export.assay to hub_reader;
end
$exp$;

-- check: select column_name from information_schema.columns where table_name = 'exp_assay' and column_name in ('lab_seq','client_ref','received_date','tested_date','reported_date');
-- check: select crm_name, analyte, certified_value, sd from public.exp_crm order by analyte;
