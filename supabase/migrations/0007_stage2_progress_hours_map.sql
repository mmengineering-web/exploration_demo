-- 0007 (v0.7): Drilling Progress core result, Distribution Hour, IUP boundary, pull-all setting. Safe to run twice.
-- Run 0005 and 0006 first.

-- ---------- Drilling Progress: core result ---------------------------------
alter table public.exp_drill_progress add column if not exists core_len_m numeric(7,2) check (core_len_m >= 0);
alter table public.exp_drill_progress add column if not exists core_recovery_pct numeric(6,1)
  generated always as (case when core_len_m is not null and to_m > from_m then round(core_len_m / (to_m - from_m) * 100, 1) end) stored;

-- ---------- code lists: new list "activity" + flags -------------------------
-- only when the list is not yet allowed: 0008 widens this check later, and a re-run of this file must not narrow it again
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'exp_code_list_list_code_check' and pg_get_constraintdef(oid) like '%activity%') then
    alter table public.exp_code_list drop constraint if exists exp_code_list_list_code_check;
    alter table public.exp_code_list add constraint exp_code_list_list_code_check
      check (list_code in ('hole_type','collar_status','shift','downtime_reason','activity'));
  end if;
end $c$;
alter table public.exp_code_list add column if not exists description text;

insert into public.exp_code_list (list_code, code, label, sort_order, meta, description) values
  ('activity','DRILLING','Drilling',10,'{}','Pengeboran aktif'),
  ('activity','MOVE_SETUP','Moving/Setup',20,'{}','Pindah titik, pasang/bongkar rig'),
  ('activity','SURVEY_LOG','Survey/Logging',30,'{}','Survey koordinat, logging core'),
  ('activity','STANDBY','Standby/BD/Weather',40,'{}','Standby, breakdown, cuaca')
on conflict (list_code, code) do nothing;

-- coring hole types show Core Result fields in the app
update public.exp_code_list set meta = meta || '{"is_coring":true}'::jsonb
 where list_code = 'hole_type' and code = 'DD' and not (meta ? 'is_coring');
-- map class for the Peta tab: planned | progress | eoh | coh  (adjust in Pengaturan > Daftar kode > Status collar)
update public.exp_code_list set meta = meta || '{"map_class":"planned"}'::jsonb  where list_code='collar_status' and code='planned'   and not (meta ? 'map_class');
update public.exp_code_list set meta = meta || '{"map_class":"progress"}'::jsonb where list_code='collar_status' and code='drilling'  and not (meta ? 'map_class');
update public.exp_code_list set meta = meta || '{"map_class":"eoh"}'::jsonb      where list_code='collar_status' and code='completed' and not (meta ? 'map_class');
update public.exp_code_list set meta = meta || '{"map_class":"coh"}'::jsonb      where list_code='collar_status' and code='abandoned' and not (meta ? 'map_class');

-- phones now keep ALL progress history (0 = no limit); only change it when it is still the old default
update public.exp_setting set value = '0' where key = 'progress_pull_days' and value = '90';

-- ---------- Distribution Hour ----------------------------------------------
create table if not exists public.exp_dist_hour (
  id          uuid primary key,
  work_date   date not null,
  rig_id      text not null,
  from_time   time not null,
  to_time     time not null,
  hours       numeric(5,2) generated always as (round(extract(epoch from (to_time - from_time)) / 3600.0, 2)) stored,
  activity    text not null,
  remarks     text,
  is_deleted  boolean not null default false,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  constraint chk_dist_time check (to_time > from_time)
);
create index if not exists ix_exp_dist_rig_date on public.exp_dist_hour (rig_id, work_date);
create index if not exists ix_exp_dist_server_upd on public.exp_dist_hour (server_updated_at);

drop trigger if exists trg_exp_dist_touch on public.exp_dist_hour;
create trigger trg_exp_dist_touch before insert or update on public.exp_dist_hour
  for each row execute function public.exp_touch();

-- activity must exist in the code list; one rig cannot have overlapping times on the same date
create or replace function public.exp_guard_dist_hour()
returns trigger language plpgsql as $$
declare o record;
begin
  if (tg_op = 'INSERT' or new.activity is distinct from old.activity)
     and not exists (select 1 from public.exp_code_list where list_code = 'activity' and code = new.activity) then
    raise exception 'Unknown activity: %', new.activity;
  end if;
  if not new.is_deleted then
    select * into o from public.exp_dist_hour
     where id <> new.id and not is_deleted and rig_id = new.rig_id and work_date = new.work_date
       and from_time < new.to_time and to_time > new.from_time limit 1;
    if found then
      raise exception 'Jam % - % bentrok dengan % - % (%) untuk rig % pada %.',
        to_char(new.from_time,'HH24:MI'), to_char(new.to_time,'HH24:MI'), to_char(o.from_time,'HH24:MI'), to_char(o.to_time,'HH24:MI'), o.activity, new.rig_id, new.work_date
        using errcode = '23P01';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_exp_dist_guard on public.exp_dist_hour;
create trigger trg_exp_dist_guard before insert or update on public.exp_dist_hour
  for each row execute function public.exp_guard_dist_hour();

alter table public.exp_dist_hour enable row level security;
drop policy if exists exp_dist_hour_read on public.exp_dist_hour;
drop policy if exists exp_dist_hour_ins on public.exp_dist_hour;
drop policy if exists exp_dist_hour_upd on public.exp_dist_hour;
create policy exp_dist_hour_read on public.exp_dist_hour for select to authenticated using (public.exp_role() is not null);
create policy exp_dist_hour_ins  on public.exp_dist_hour for insert to authenticated with check (public.exp_can_write());
create policy exp_dist_hour_upd  on public.exp_dist_hour for update to authenticated using (public.exp_can_write()) with check (public.exp_can_write());
revoke all on public.exp_dist_hour from anon;
revoke delete on public.exp_dist_hour from authenticated;
grant select, insert, update on public.exp_dist_hour to authenticated;

-- ---------- IUP boundary (GeoJSON), uploaded by admins ----------------------
create table if not exists public.exp_iup (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  geojson    jsonb not null,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
alter table public.exp_iup enable row level security;
drop policy if exists exp_iup_read on public.exp_iup;
drop policy if exists exp_iup_ins  on public.exp_iup;
drop policy if exists exp_iup_upd  on public.exp_iup;
drop policy if exists exp_iup_del  on public.exp_iup;
create policy exp_iup_read on public.exp_iup for select to authenticated using (public.exp_role() is not null);
create policy exp_iup_ins  on public.exp_iup for insert to authenticated with check (public.exp_can_admin());
create policy exp_iup_upd  on public.exp_iup for update to authenticated using (public.exp_can_admin()) with check (public.exp_can_admin());
create policy exp_iup_del  on public.exp_iup for delete to authenticated using (public.exp_can_admin());
revoke all on public.exp_iup from anon;
grant select, insert, update, delete on public.exp_iup to authenticated;

-- ---------- in-use guard: also protect activity codes -----------------------
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
    what := case old.list_code when 'hole_type' then 'collar' when 'collar_status' then 'collar' when 'activity' then 'record jam rig' else 'record progress' end;
    if old.list_code = 'hole_type'       then select count(*) into n from public.exp_collar         where hole_type = old.code; end if;
    if old.list_code = 'collar_status'   then select count(*) into n from public.exp_collar         where status = old.code; end if;
    if old.list_code = 'shift'           then select count(*) into n from public.exp_drill_progress where shift = old.code; end if;
    if old.list_code = 'downtime_reason' then select count(*) into n from public.exp_drill_progress where downtime_reason = old.code; end if;
    if old.list_code = 'activity'        then select count(*) into n from public.exp_dist_hour      where activity = old.code; end if;
  elsif tg_table_name = 'exp_role_def' then
    select count(*) into n from public.exp_profile where role = old.role; what := 'user';
  end if;
  if n > 0 then
    raise exception 'Tidak bisa dihapus: masih dipakai % %. Nonaktifkan saja (hilangkan centang Aktif).', n, what;
  end if;
  return old;
end $$;

-- ---------- per-hole summary (planned vs achieved, core recovery) -----------
create or replace view public.v_exp_hole_progress with (security_invoker = true) as
select c.hole_id, c.hole_type, c.prospect, c.status, c.planned_depth_m, c.total_depth_m,
       max(p.to_m)                                   as achieved_m,
       case when c.planned_depth_m > 0 then round(max(p.to_m) / c.planned_depth_m * 100, 1) end as achieved_pct,
       sum(p.core_len_m)                             as core_len_m,
       case when sum(case when p.core_len_m is not null then p.to_m - p.from_m end) > 0
            then round(sum(p.core_len_m) / sum(case when p.core_len_m is not null then p.to_m - p.from_m end) * 100, 1) end as core_recovery_pct,
       max(p.work_date)                              as last_work_date
from public.exp_collar c
left join public.exp_drill_progress p on p.hole_id = c.hole_id and not p.is_deleted
where not c.is_deleted
group by c.hole_id, c.hole_type, c.prospect, c.status, c.planned_depth_m, c.total_depth_m;

-- ---------- per rig / day / activity accumulation ---------------------------
create or replace view public.v_exp_dist_hour_summary with (security_invoker = true) as
select work_date, rig_id, activity, sum(hours) as hours
from public.exp_dist_hour where not is_deleted
group by work_date, rig_id, activity;
