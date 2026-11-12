-- ============================================================================
-- Exploration PWA — migration 0002: everything configurable from the Admin UI
-- Run AFTER 0001, once per site project.
--  * roles become data (exp_role_def) with two permission flags: can_write, can_admin
--  * code lists (hole types, collar statuses, shifts, downtime reasons) become data
--  * numeric/text parameters become data (exp_setting)
--  * admin RPC to attach an existing Supabase Auth user to a role
-- Nothing is hard-deleted: config rows are deactivated (is_active=false), never removed.
-- ============================================================================

-- ---------- roles as data ---------------------------------------------------
create table if not exists public.exp_role_def (
  role      text primary key check (role ~ '^[a-z][a-z0-9_]{1,30}$'),
  label     text not null,
  can_write boolean not null default false,   -- may insert/update collar + progress
  can_admin boolean not null default false,   -- may manage config, roles and users
  is_active boolean not null default true
);
insert into public.exp_role_def (role, label, can_write, can_admin) values
  ('geologist', 'Geologist',  true,  false),
  ('site_admin','Site admin', true,  true),
  ('viewer',    'Viewer',     false, false)
on conflict (role) do nothing;

alter table public.exp_profile drop constraint if exists exp_profile_role_check;
alter table public.exp_profile add column if not exists email text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_exp_profile_role') then
    alter table public.exp_profile
      add constraint fk_exp_profile_role foreign key (role)
      references public.exp_role_def(role) on update cascade;
  end if;
end $$;

-- ---------- code lists as data ---------------------------------------------
create table if not exists public.exp_code_list (
  list_code  text not null check (list_code in ('hole_type','collar_status','shift','downtime_reason')),
  code       text not null check (code ~ '^[A-Za-z0-9_-]{1,30}$'),
  label      text not null,
  sort_order int  not null default 100,
  is_active  boolean not null default true,
  meta       jsonb not null default '{}'::jsonb,
  primary key (list_code, code)
);

insert into public.exp_code_list (list_code, code, label, sort_order, meta) values
  ('hole_type','AG','Auger',10,'{}'),
  ('hole_type','TP','Test pit',20,'{}'),
  ('hole_type','RC','RC',30,'{}'),
  ('hole_type','DD','Diamond',40,'{}'),
  ('collar_status','planned','Planned',10,'{"is_plan":true}'),
  ('collar_status','drilling','Drilling',20,'{"requires_asbuilt":true}'),
  ('collar_status','completed','Completed',30,'{"requires_asbuilt":true,"requires_total_depth":true}'),
  ('collar_status','abandoned','Abandoned',40,'{"hide_from_progress":true}'),
  ('shift','DAY','Day',10,'{}'),
  ('shift','NIGHT','Night',20,'{}'),
  ('downtime_reason','RAIN','Hujan',10,'{}'),
  ('downtime_reason','RIG_BREAKDOWN','Breakdown rig',20,'{}'),
  ('downtime_reason','WAIT_WATER','Tunggu air',30,'{}'),
  ('downtime_reason','RIG_MOVE','Pindah titik (rig move)',40,'{}'),
  ('downtime_reason','WAIT_MATERIAL','Tunggu material/BBM',50,'{}'),
  ('downtime_reason','SAFETY_STOP','Safety stop',60,'{}'),
  ('downtime_reason','ACCESS','Akses/jalan',70,'{}'),
  ('downtime_reason','OTHER','Lainnya',99,'{}')
on conflict (list_code, code) do nothing;

-- drop the hard-coded checks from 0001; validity is now checked against exp_code_list
alter table public.exp_collar          drop constraint if exists exp_collar_hole_type_check;
alter table public.exp_collar          drop constraint if exists exp_collar_status_check;
alter table public.exp_drill_progress  drop constraint if exists exp_drill_progress_shift_check;

create or replace function public.exp_check_codes()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'exp_collar' then
    if (tg_op = 'INSERT' or new.hole_type is distinct from old.hole_type)
       and not exists (select 1 from public.exp_code_list where list_code='hole_type' and code=new.hole_type) then
      raise exception 'Unknown hole_type: %', new.hole_type;
    end if;
    if (tg_op = 'INSERT' or new.status is distinct from old.status)
       and not exists (select 1 from public.exp_code_list where list_code='collar_status' and code=new.status) then
      raise exception 'Unknown collar status: %', new.status;
    end if;
  elsif tg_table_name = 'exp_drill_progress' then
    if (tg_op = 'INSERT' or new.shift is distinct from old.shift)
       and not exists (select 1 from public.exp_code_list where list_code='shift' and code=new.shift) then
      raise exception 'Unknown shift: %', new.shift;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_exp_collar_codes on public.exp_collar;
create trigger trg_exp_collar_codes before insert or update on public.exp_collar
  for each row execute function public.exp_check_codes();
drop trigger if exists trg_exp_prog_codes on public.exp_drill_progress;
create trigger trg_exp_prog_codes before insert or update on public.exp_drill_progress
  for each row execute function public.exp_check_codes();

-- ---------- settings as data -----------------------------------------------
create table if not exists public.exp_setting (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.exp_setting (key, value) values
  ('gps_max_acc_m',             '10'),
  ('shift_hours',               '12'),
  ('photo_max_px',              '1280'),
  ('progress_pull_days',        '90'),
  ('depth_overrun_warn_factor', '1.5'),
  ('hole_id_regex',             '"^[A-Z0-9-]{4,30}$"')
on conflict (key) do nothing;
-- NOTE: the server keeps a fixed safety rule on hole_id (A-Z, 0-9, "-", 4-30 chars, from 0001).
-- hole_id_regex in settings must be equal to or stricter than that rule.

-- ---------- permission helpers ---------------------------------------------
create or replace function public.exp_role()
returns text language sql stable security definer set search_path = public as $$
  select p.role from public.exp_profile p
  join public.exp_role_def d on d.role = p.role
  where p.user_id = auth.uid() and p.is_active and d.is_active
$$;
create or replace function public.exp_can_write()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select d.can_write from public.exp_profile p
    join public.exp_role_def d on d.role = p.role
    where p.user_id = auth.uid() and p.is_active and d.is_active), false)
$$;
create or replace function public.exp_can_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select d.can_admin from public.exp_profile p
    join public.exp_role_def d on d.role = p.role
    where p.user_id = auth.uid() and p.is_active and d.is_active), false)
$$;

-- ---------- guard: never leave the site without an active admin -------------
create or replace function public.exp_guard_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.exp_profile p join public.exp_role_def d on d.role = p.role
    where p.is_active and d.is_active and d.can_admin) then
    raise exception 'Cannot remove the last active site admin.';
  end if;
  return null;
end $$;
drop trigger if exists trg_guard_admin_profile on public.exp_profile;
create trigger trg_guard_admin_profile after update or delete on public.exp_profile
  for each row execute function public.exp_guard_last_admin();
drop trigger if exists trg_guard_admin_role on public.exp_role_def;
create trigger trg_guard_admin_role after update or delete on public.exp_role_def
  for each row execute function public.exp_guard_last_admin();

-- ---------- admin RPC: attach an existing Auth user to a role ---------------
-- The Auth user itself is still created in Supabase Dashboard > Authentication
-- (creating users from the browser would need the service-role key, which must never be in the app).
create or replace function public.exp_admin_upsert_profile(
  p_email text, p_name text, p_role text, p_active boolean default true)
returns void language plpgsql security definer set search_path = public, auth as $$
declare uid uuid;
begin
  if not public.exp_can_admin() then raise exception 'Not allowed'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then
    raise exception 'No Auth user with email %. Create the user in Supabase Auth first.', p_email;
  end if;
  insert into public.exp_profile (user_id, full_name, role, is_active, email)
  values (uid, trim(p_name), p_role, p_active, lower(trim(p_email)))
  on conflict (user_id) do update
    set full_name = excluded.full_name, role = excluded.role,
        is_active = excluded.is_active, email = excluded.email;
end $$;
revoke all on function public.exp_admin_upsert_profile(text,text,text,boolean) from public, anon;
grant execute on function public.exp_admin_upsert_profile(text,text,text,boolean) to authenticated;

-- ---------- RLS (re-created on top of the role flags) -----------------------
alter table public.exp_role_def  enable row level security;
alter table public.exp_code_list enable row level security;
alter table public.exp_setting   enable row level security;

-- clear every policy from 0001 on tables we are redefining
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname='public' and tablename in
             ('exp_profile','exp_rig','exp_prospect','exp_collar','exp_drill_progress','exp_role_def','exp_code_list','exp_setting')
  loop execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename); end loop;
end $$;

-- profile: own row; admin sees all (edits go through the RPC)
create policy exp_profile_self  on public.exp_profile for select to authenticated using (user_id = auth.uid());
create policy exp_profile_admin on public.exp_profile for select to authenticated using (public.exp_can_admin());

-- config tables: any active role reads; admin writes (no delete)
do $$
declare t text;
begin
  foreach t in array array['exp_rig','exp_prospect','exp_role_def','exp_code_list','exp_setting'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.exp_role() is not null)', t||'_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.exp_can_admin())', t||'_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.exp_can_admin()) with check (public.exp_can_admin())', t||'_upd', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke delete on public.%I from authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;

-- data tables: read = any active role; write = role with can_write
do $$
declare t text;
begin
  foreach t in array array['exp_collar','exp_drill_progress'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.exp_role() is not null)', t||'_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.exp_can_write())', t||'_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.exp_can_write()) with check (public.exp_can_write())', t||'_upd', t);
  end loop;
end $$;

-- storage: photos
drop policy if exists exp_photos_read on storage.objects;
create policy exp_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'exp-photos' and public.exp_role() is not null);
drop policy if exists exp_photos_ins on storage.objects;
create policy exp_photos_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'exp-photos' and public.exp_can_write());
drop policy if exists exp_photos_upd on storage.objects;
create policy exp_photos_upd on storage.objects for update to authenticated
  using (bucket_id = 'exp-photos' and public.exp_can_write());

-- ---------- bootstrap: the first admin (run manually once per site) ---------
-- insert into public.exp_profile (user_id, full_name, role, email)
-- values ('<auth user uuid>', 'Nama Admin', 'site_admin', 'admin@example.com');
-- After that, everything else is managed from the app (Admin tab).
