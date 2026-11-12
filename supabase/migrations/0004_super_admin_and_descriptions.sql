-- ============================================================================
-- Exploration PWA — migration 0004: super_admin, descriptions ("Keterangan"), delete guards
-- Run AFTER 0001, 0002 (0003 is independent), once per site project. Safe to re-run.
--
--  * new permission flag can_super + role 'super_admin'
--      super admin = everything a site admin can do, PLUS: permanently delete master data
--      (rig, prospect, code list, role), add/delete users (through the Edge Function), manage super roles
--  * description column on rig, prospect, code list, role  (shown in the "Keterangan" tab)
--  * seeds Indonesian descriptions for the default codes
--  * safety guards (apply to app users; the SQL Editor / postgres bypasses the "who may" checks):
--      - only a super admin may create/change a super role or assign it to someone
--      - never remove or deactivate the last active super admin
--      - a master-data row that is still used by records cannot be deleted (deactivate it instead)
--  Collar and progress records stay soft-delete (is_deleted) so phones and the hub stay consistent.
-- ============================================================================

-- ---------- fix: last-admin guard should only fire when a change really REMOVES admin rights ----------
-- (0002's version also fired on harmless updates, which broke migrations on a site with no admin yet)
create or replace function public.exp_guard_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
declare was_admin boolean := false; still_admin boolean := false;
begin
  if tg_table_name = 'exp_profile' then
    select (d.can_admin and d.is_active) and old.is_active into was_admin from public.exp_role_def d where d.role = old.role;
    if tg_op = 'UPDATE' then
      select (d.can_admin and d.is_active) and new.is_active into still_admin from public.exp_role_def d where d.role = new.role;
    end if;
  else  -- exp_role_def
    was_admin := old.can_admin and old.is_active;
    if tg_op = 'UPDATE' then still_admin := new.can_admin and new.is_active; end if;
  end if;
  if coalesce(was_admin, false) and not coalesce(still_admin, false) and not exists (
    select 1 from public.exp_profile p join public.exp_role_def d on d.role = p.role
    where p.is_active and d.is_active and d.can_admin) then
    raise exception 'Cannot remove the last active site admin.';
  end if;
  return null;
end $$;

-- ---------- columns ---------------------------------------------------------
alter table public.exp_role_def add column if not exists can_super   boolean not null default false;
alter table public.exp_role_def add column if not exists description text;
alter table public.exp_code_list add column if not exists description text;
alter table public.exp_rig       add column if not exists description text;
alter table public.exp_prospect  add column if not exists description text;

-- ---------- roles -----------------------------------------------------------
insert into public.exp_role_def (role, label, can_write, can_admin, can_super, description) values
  ('super_admin', 'Super admin', true, true, true,
   'Semua hak site admin, ditambah hapus permanen data master, tambah/hapus user, dan kelola role super.')
on conflict (role) do update set can_super = true, can_admin = true, can_write = true;

update public.exp_role_def set description = 'Mengisi progress harian dan collar; melihat semua data.' where role = 'geologist'  and description is null;
update public.exp_role_def set description = 'Geologist + mengelola data master (rig, prospect, daftar kode, parameter) dan menautkan user.' where role = 'site_admin' and description is null;
update public.exp_role_def set description = 'Hanya melihat data; tidak bisa input atau mengubah.' where role = 'viewer' and description is null;

-- ---------- default code descriptions (only where still empty) ---------------
update public.exp_code_list c set description = d.t
from (values
  ('hole_type','AG','Auger: bor tangan/mesin ringan untuk lapisan lunak dangkal (saprolit/limonit atas).'),
  ('hole_type','TP','Test pit: galian uji berupa parit/sumur dangkal untuk memeriksa profil dan mengambil sampel.'),
  ('hole_type','RC','Reverse circulation: bor dengan sampel serbuk (chip) dari sirkulasi udara.'),
  ('hole_type','DD','Diamond drilling: bor inti (core) untuk sampel inti batuan utuh.'),
  ('collar_status','planned','Lubang bor yang direncanakan; belum dikerjakan di lapangan.'),
  ('collar_status','drilling','Sedang dibor; koordinat as-built wajib sudah diambil.'),
  ('collar_status','completed','Pengeboran selesai; koordinat as-built dan total depth wajib terisi.'),
  ('collar_status','abandoned','Dihentikan/ditinggalkan; tidak muncul lagi di pilihan input progress.'),
  ('shift','DAY','Shift siang.'),
  ('shift','NIGHT','Shift malam.'),
  ('downtime_reason','RAIN','Pengeboran berhenti karena hujan.'),
  ('downtime_reason','RIG_BREAKDOWN','Rig atau peralatan bor rusak.'),
  ('downtime_reason','WAIT_WATER','Menunggu suplai air untuk pengeboran.'),
  ('downtime_reason','RIG_MOVE','Waktu pindah rig antar titik bor.'),
  ('downtime_reason','WAIT_MATERIAL','Menunggu material atau BBM.'),
  ('downtime_reason','SAFETY_STOP','Berhenti karena alasan keselamatan (K3).'),
  ('downtime_reason','ACCESS','Akses atau jalan ke titik bor terhambat.'),
  ('downtime_reason','OTHER','Alasan lain; jelaskan di kolom catatan.')
) as d(list_code, code, t)
where c.list_code = d.list_code and c.code = d.code and c.description is null;

-- ---------- helper ----------------------------------------------------------
create or replace function public.exp_is_super()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select d.can_super from public.exp_profile p
    join public.exp_role_def d on d.role = p.role
    where p.user_id = auth.uid() and p.is_active and d.is_active), false)
$$;

-- ---------- permanent delete: super admin only, config tables ----------------
do $$
declare t text;
begin
  foreach t in array array['exp_rig','exp_prospect','exp_role_def','exp_code_list'] loop
    execute format('drop policy if exists %I on public.%I', t||'_del', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.exp_is_super())', t||'_del', t);
    execute format('grant delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------- guard: master-data rows that are still in use cannot be deleted --
create or replace function public.exp_guard_in_use()
returns trigger language plpgsql security definer set search_path = public as $$
declare n bigint := 0; what text;
begin
  if tg_table_name = 'exp_rig' then
    select count(*) into n from public.exp_drill_progress where rig_id = old.rig_id; what := 'record progress';
  elsif tg_table_name = 'exp_prospect' then
    select count(*) into n from public.exp_collar where prospect = old.prospect_code; what := 'collar';
  elsif tg_table_name = 'exp_code_list' then
    what := case old.list_code when 'hole_type' then 'collar' when 'collar_status' then 'collar' else 'record progress' end;
    if old.list_code = 'hole_type'       then select count(*) into n from public.exp_collar         where hole_type = old.code; end if;
    if old.list_code = 'collar_status'   then select count(*) into n from public.exp_collar         where status = old.code; end if;
    if old.list_code = 'shift'           then select count(*) into n from public.exp_drill_progress where shift = old.code; end if;
    if old.list_code = 'downtime_reason' then select count(*) into n from public.exp_drill_progress where downtime_reason = old.code; end if;
  elsif tg_table_name = 'exp_role_def' then
    select count(*) into n from public.exp_profile where role = old.role; what := 'user';
  end if;
  if n > 0 then
    raise exception 'Tidak bisa dihapus: masih dipakai % %. Nonaktifkan saja (hilangkan centang Aktif).', n, what;
  end if;
  return old;
end $$;
do $$
declare t text;
begin
  foreach t in array array['exp_rig','exp_prospect','exp_code_list','exp_role_def'] loop
    execute format('drop trigger if exists trg_%s_inuse on public.%I', t, t);
    execute format('create trigger trg_%s_inuse before delete on public.%I for each row execute function public.exp_guard_in_use()', t, t);
  end loop;
end $$;

-- ---------- guard: only a super admin may touch super roles ------------------
create or replace function public.exp_guard_super_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare others bigint;
begin
  if auth.uid() is not null and not public.exp_is_super() then
    if tg_op = 'INSERT' and new.can_super then raise exception 'Hanya super admin yang boleh membuat role super.'; end if;
    if tg_op = 'UPDATE' and (old.can_super or new.can_super) then raise exception 'Hanya super admin yang boleh mengubah role super.'; end if;
    if tg_op = 'DELETE' and old.can_super then raise exception 'Hanya super admin yang boleh menghapus role super.'; end if;
  end if;
  -- never lose the last active super admin through a role change
  if tg_op in ('UPDATE','DELETE') and old.can_super and old.is_active
     and (tg_op = 'DELETE' or not new.can_super or not new.is_active) then
    select count(*) into others from public.exp_profile p join public.exp_role_def d on d.role = p.role
      where p.is_active and d.is_active and d.can_super and d.role <> old.role;
    if others = 0 and exists (select 1 from public.exp_profile where role = old.role and is_active) then
      raise exception 'Tidak bisa menonaktifkan/menghapus role super terakhir yang dipakai.';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_exp_role_super on public.exp_role_def;
create trigger trg_exp_role_super before insert or update or delete on public.exp_role_def
  for each row execute function public.exp_guard_super_role();

-- ---------- guard: never lose the last active super admin (profile level) ----
create or replace function public.exp_guard_last_super()
returns trigger language plpgsql security definer set search_path = public as $$
declare was_super boolean; still_super boolean := false; others bigint;
begin
  select (d.can_super and d.is_active) into was_super from public.exp_role_def d where d.role = old.role;
  if not coalesce(was_super, false) or not old.is_active then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' then
    select (d.can_super and d.is_active) into still_super from public.exp_role_def d where d.role = new.role;
    if coalesce(still_super, false) and new.is_active then return new; end if;
  end if;
  select count(*) into others from public.exp_profile p join public.exp_role_def d on d.role = p.role
    where p.is_active and d.is_active and d.can_super and p.user_id <> old.user_id;
  if others = 0 then raise exception 'Tidak bisa menghapus/menonaktifkan super admin terakhir.'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_exp_profile_last_super on public.exp_profile;
create trigger trg_exp_profile_last_super before update or delete on public.exp_profile
  for each row execute function public.exp_guard_last_super();

-- ---------- RPC: link an existing Auth user (site admin may; super roles = super only) ----
create or replace function public.exp_admin_upsert_profile(
  p_email text, p_name text, p_role text, p_active boolean default true)
returns void language plpgsql security definer set search_path = public, auth as $$
declare uid uuid; target_super boolean; current_super boolean;
begin
  if not public.exp_can_admin() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.exp_role_def where role = p_role and is_active) then
    raise exception 'Role % tidak ada atau tidak aktif.', p_role;
  end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then
    raise exception 'No Auth user with email %. Create the user in Supabase Auth first (or ask a super admin to add the user).', p_email;
  end if;
  select coalesce(can_super, false) into target_super from public.exp_role_def where role = p_role;
  select coalesce(d.can_super, false) into current_super from public.exp_profile p join public.exp_role_def d on d.role = p.role where p.user_id = uid;
  if (target_super or coalesce(current_super, false)) and not public.exp_is_super() then
    raise exception 'Hanya super admin yang boleh menetapkan atau mengubah akun super admin.';
  end if;
  insert into public.exp_profile (user_id, full_name, role, is_active, email)
  values (uid, trim(p_name), p_role, p_active, lower(trim(p_email)))
  on conflict (user_id) do update
    set full_name = excluded.full_name, role = excluded.role,
        is_active = excluded.is_active, email = excluded.email;
end $$;
revoke all on function public.exp_admin_upsert_profile(text,text,text,boolean) from public, anon;
grant execute on function public.exp_admin_upsert_profile(text,text,text,boolean) to authenticated;

-- ---------- make YOURSELF super admin (run ONCE in the SQL Editor, replace the email) ----------
-- update public.exp_profile set role = 'super_admin' where lower(email) = lower('your-email@example.com');
-- select user_id, full_name, email, role from public.exp_profile;   -- check
