-- 0012: per-form input permission.
-- A role with can_write may input every form. A user can be limited to some forms:
--   exp_profile.input_forms = NULL                   -> all forms the role allows
--   exp_profile.input_forms = '{progress,collar}'    -> only those forms
-- Forms: progress (exp_drill_progress), collar (exp_collar + exp_survey), hours (exp_dist_hour), sample (exp_sample + exp_assay).
-- Reading is unchanged (any active role reads everything). Run per site, safe to re-run.

alter table public.exp_profile add column if not exists input_forms text[];
alter table public.exp_profile drop constraint if exists exp_profile_input_forms_chk;
alter table public.exp_profile add constraint exp_profile_input_forms_chk
  check (input_forms is null or input_forms <@ array['progress','collar','hours','sample']::text[]);

create or replace function public.exp_can_input(p_form text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select d.can_write and (p.input_forms is null or p_form = any(p.input_forms))
    from public.exp_profile p join public.exp_role_def d on d.role = p.role
    where p.user_id = auth.uid() and p.is_active and d.is_active), false)
$$;
grant execute on function public.exp_can_input(text) to authenticated;

-- table policies: write = may input that form
do $$
declare t text; f text;
begin
  for t, f in select * from (values
    ('exp_collar','collar'), ('exp_survey','collar'), ('exp_drill_progress','progress'),
    ('exp_dist_hour','hours'), ('exp_sample','sample'), ('exp_assay','sample')) v(tbl, frm)
  loop
    execute format('drop policy if exists %I on public.%I', t||'_ins', t);
    execute format('drop policy if exists %I on public.%I', t||'_upd', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.exp_can_input(%L))', t||'_ins', t, f);
    execute format('create policy %I on public.%I for update to authenticated using (public.exp_can_input(%L)) with check (public.exp_can_input(%L))', t||'_upd', t, f, f);
  end loop;
end $$;

-- photos: collar/ needs the collar form, core/ needs the progress form
drop policy if exists exp_photos_ins on storage.objects;
create policy exp_photos_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'exp-photos' and (
    (name like 'collar/%' and public.exp_can_input('collar')) or (name like 'core/%' and public.exp_can_input('progress'))));
drop policy if exists exp_photos_upd on storage.objects;
create policy exp_photos_upd on storage.objects for update to authenticated
  using (bucket_id = 'exp-photos' and (
    (name like 'collar/%' and public.exp_can_input('collar')) or (name like 'core/%' and public.exp_can_input('progress'))));

-- admin RPC: p_forms = NULL (all) or the allowed forms. Only meaningful for roles with can_write.
drop function if exists public.exp_admin_upsert_profile(text, text, text, boolean);
create or replace function public.exp_admin_upsert_profile(
  p_email text, p_name text, p_role text, p_active boolean default true, p_forms text[] default null)
returns void language plpgsql security definer set search_path = public, auth as $$
declare uid uuid; target_super boolean; current_super boolean; writer boolean;
begin
  if not public.exp_can_admin() then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.exp_role_def where role = p_role and is_active) then
    raise exception 'Role % tidak ada atau tidak aktif.', p_role;
  end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then
    raise exception 'No Auth user with email %. Create the user in Supabase Auth first (or ask a super admin to add the user).', p_email;
  end if;
  select coalesce(can_super, false), coalesce(can_write, false) into target_super, writer from public.exp_role_def where role = p_role;
  select coalesce(d.can_super, false) into current_super from public.exp_profile p join public.exp_role_def d on d.role = p.role where p.user_id = uid;
  if (target_super or coalesce(current_super, false)) and not public.exp_is_super() then
    raise exception 'Hanya super admin yang boleh menetapkan atau mengubah akun super admin.';
  end if;
  insert into public.exp_profile (user_id, full_name, role, is_active, email, input_forms)
  values (uid, trim(p_name), p_role, p_active, lower(trim(p_email)), case when writer then p_forms else null end)
  on conflict (user_id) do update
    set full_name = excluded.full_name, role = excluded.role, is_active = excluded.is_active, email = excluded.email,
        input_forms = case when writer then excluded.input_forms else null end;
end $$;
revoke all on function public.exp_admin_upsert_profile(text, text, text, boolean, text[]) from public, anon;
grant execute on function public.exp_admin_upsert_profile(text, text, text, boolean, text[]) to authenticated;
