-- ============================================================================
-- Exploration PWA — site database schema (run once PER SITE Supabase project)
-- v0.1  |  Scope v1: collar (F2) + daily drill progress (F1)
-- Sample registry / lab dispatch / assay receipt (F3-F5) come in the next slice.
-- ============================================================================

-- ---------- helper: updated_at last-write-wins + server timestamp -----------
-- Device clock = updated_at (used for last-write-wins).
-- server_updated_at = server clock (use THIS for the hub incremental pull,
-- because phone clocks can be wrong).
create or replace function public.exp_touch()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;                       -- older edit arrives late: ignore silently
  end if;
  new.server_updated_at := now();
  return new;
end;
$$;

-- ---------- profile / role --------------------------------------------------
create table if not exists public.exp_profile (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null,
  role       text not null check (role in ('geologist','site_admin','viewer')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.exp_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from public.exp_profile where user_id = auth.uid() and is_active
$$;

-- ---------- reference tables (cached on the phone) --------------------------
create table if not exists public.exp_rig (
  rig_id    text primary key,
  rig_name  text not null,
  rig_type  text,
  is_active boolean not null default true
);

create table if not exists public.exp_prospect (
  prospect_code text primary key,
  prospect_name text not null,
  is_active     boolean not null default true
);

-- ---------- F2 collar -------------------------------------------------------
create table if not exists public.exp_collar (
  id               uuid primary key,                       -- generated on device
  hole_id          text not null,
  hole_type        text not null check (hole_type in ('AG','TP','RC','DD')),
  prospect         text,
  status           text not null default 'planned'
                   check (status in ('planned','drilling','completed','abandoned')),
  planned_lat      numeric(10,7),
  planned_lon      numeric(10,7),
  planned_elev     numeric(8,2),
  planned_depth_m  numeric(7,2) check (planned_depth_m > 0),
  asbuilt_lat      numeric(10,7),
  asbuilt_lon      numeric(10,7),
  asbuilt_elev     numeric(8,2),
  gps_accuracy_m   numeric(6,2),
  total_depth_m    numeric(7,2) check (total_depth_m > 0),
  photo_path       text,
  remarks          text,
  is_deleted       boolean not null default false,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),    -- device clock
  server_updated_at timestamptz not null default now(),   -- server clock
  constraint chk_hole_id_fmt check (hole_id ~ '^[A-Z0-9-]{4,30}$')
);
-- one live hole_id per site; soft-deleted rows don't block re-use
create unique index if not exists uq_exp_collar_hole_live
  on public.exp_collar (hole_id) where not is_deleted;
create index if not exists ix_exp_collar_server_upd on public.exp_collar (server_updated_at);

-- ---------- F1 daily drill progress ----------------------------------------
-- No FK to exp_collar on purpose: offline records can arrive in any order.
-- A data-quality view below flags progress rows whose hole is unknown.
create table if not exists public.exp_drill_progress (
  id               uuid primary key,
  work_date        date not null,
  shift            text not null check (shift in ('DAY','NIGHT')),
  rig_id           text not null,
  hole_id          text not null,
  from_m           numeric(7,2) not null check (from_m >= 0),
  to_m             numeric(7,2) not null,
  meters           numeric(7,2) generated always as (to_m - from_m) stored,
  downtime_hours   numeric(4,2) not null default 0 check (downtime_hours >= 0 and downtime_hours <= 24),
  downtime_reason  text,
  remarks          text,
  is_deleted       boolean not null default false,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  constraint chk_interval check (to_m > from_m),
  constraint chk_downtime_reason check (downtime_hours = 0 or downtime_reason is not null)
);
create index if not exists ix_exp_prog_hole_date on public.exp_drill_progress (hole_id, work_date);
create index if not exists ix_exp_prog_server_upd on public.exp_drill_progress (server_updated_at);

-- triggers
drop trigger if exists trg_exp_collar_touch on public.exp_collar;
create trigger trg_exp_collar_touch before insert or update on public.exp_collar
  for each row execute function public.exp_touch();

drop trigger if exists trg_exp_prog_touch on public.exp_drill_progress;
create trigger trg_exp_prog_touch before insert or update on public.exp_drill_progress
  for each row execute function public.exp_touch();

-- no hard deletes from the app: block DELETE for everyone except postgres owner
revoke delete on public.exp_collar, public.exp_drill_progress from anon, authenticated;

-- ---------- data-quality view ----------------------------------------------
create or replace view public.v_exp_dq_progress_unknown_hole
with (security_invoker = true) as
select p.*
from public.exp_drill_progress p
left join public.exp_collar c on c.hole_id = p.hole_id and not c.is_deleted
where not p.is_deleted and c.id is null;

-- ---------- RLS -------------------------------------------------------------
alter table public.exp_profile        enable row level security;
alter table public.exp_rig            enable row level security;
alter table public.exp_prospect       enable row level security;
alter table public.exp_collar         enable row level security;
alter table public.exp_drill_progress enable row level security;

-- profile: user reads own row only (admin manages profiles from the dashboard / SQL)
drop policy if exists exp_profile_self on public.exp_profile;
create policy exp_profile_self on public.exp_profile
  for select to authenticated using (user_id = auth.uid());

-- reference tables: any active role reads, only site_admin writes
do $$
declare t text;
begin
  foreach t in array array['exp_rig','exp_prospect'] loop
    execute format('drop policy if exists %I on public.%I', t||'_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.exp_role() is not null)', t||'_read', t);
    execute format('drop policy if exists %I on public.%I', t||'_write', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.exp_role() = ''site_admin'') with check (public.exp_role() = ''site_admin'')', t||'_write', t);
  end loop;
end $$;

-- collar + progress: read = any active role; insert/update = geologist or site_admin
do $$
declare t text;
begin
  foreach t in array array['exp_collar','exp_drill_progress'] loop
    execute format('drop policy if exists %I on public.%I', t||'_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.exp_role() is not null)', t||'_read', t);
    execute format('drop policy if exists %I on public.%I', t||'_ins', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.exp_role() in (''geologist'',''site_admin''))', t||'_ins', t);
    execute format('drop policy if exists %I on public.%I', t||'_upd', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.exp_role() in (''geologist'',''site_admin'')) with check (public.exp_role() in (''geologist'',''site_admin''))', t||'_upd', t);
  end loop;
end $$;

-- anon gets nothing
revoke all on public.exp_profile, public.exp_rig, public.exp_prospect,
              public.exp_collar, public.exp_drill_progress from anon;
grant select on public.exp_profile, public.exp_rig, public.exp_prospect to authenticated;
grant insert, update, select on public.exp_collar, public.exp_drill_progress to authenticated;
grant insert, update, delete on public.exp_rig, public.exp_prospect to authenticated; -- gated by RLS to site_admin

-- ---------- private storage bucket for collar photos ------------------------
insert into storage.buckets (id, name, public)
values ('exp-photos', 'exp-photos', false)
on conflict (id) do nothing;

drop policy if exists exp_photos_read on storage.objects;
create policy exp_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'exp-photos' and public.exp_role() is not null);

drop policy if exists exp_photos_ins on storage.objects;
create policy exp_photos_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'exp-photos' and public.exp_role() in ('geologist','site_admin'));

drop policy if exists exp_photos_upd on storage.objects;
create policy exp_photos_upd on storage.objects for update to authenticated
  using (bucket_id = 'exp-photos' and public.exp_role() in ('geologist','site_admin'));

-- ---------- seed example (edit per site, then run) --------------------------
-- insert into public.exp_prospect values ('PRS-A','Prospect A',true);
-- insert into public.exp_rig values ('RIG-01','Rig 01','Auger',true);
-- After creating a user in Supabase Auth:
-- insert into public.exp_profile (user_id, full_name, role) values ('<auth user uuid>','Nama Geologist','geologist');

-- ---------- hub reader (hub pull uses server_updated_at) --------------------
-- create role hub_reader login password '...';   -- set via Vault/secrets, not in git
-- grant select on public.exp_collar, public.exp_drill_progress, public.exp_rig, public.exp_prospect to hub_reader;
