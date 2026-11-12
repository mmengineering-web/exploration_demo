-- ============================================================================
-- EXPLORATION HUB — connect ONE site (run in the HUB's SQL Editor, once per site)
-- Prerequisite: that site has run migrations 0001, 0002, 0003 and you set the
-- hub_reader password there (see the end of 0003).
--
-- Fill the 4 values, run, done. The helper is idempotent: running it twice is safe.
--   site code   : WKM, BM, TMS, CDSM, IBN, TPB, AJB or CDS
--   project ref : the site project's reference (Project Settings > General > Reference ID)
--   pooler host : from the SITE project: Connect > Session pooler, e.g. aws-0-ap-southeast-1.pooler.supabase.com
--                 (sites in other regions have a different host; copy it, do not guess)
--   password    : the site's hub_reader password
-- Do NOT save this file with real values in Git.
-- ============================================================================

create or replace function hub_private.add_site(
  p_site text, p_ref text, p_host text, p_password text, p_port int default 5432, p_sslmode text default 'require')
returns text language plpgsql as $fn$
declare
  srv text := 'site_' || lower(p_site);
  sch text := 'src_'  || lower(p_site);
begin
  if p_site !~ '^[A-Z0-9]{2,6}$' then raise exception 'Site code must be 2-6 capital letters/digits, got %', p_site; end if;
  if p_ref  !~ '^[a-z0-9]{15,30}$' then raise exception 'Project ref looks wrong: %', p_ref; end if;

  execute format($q$create server if not exists %I foreign data wrapper postgres_fdw
    options (host %L, port %L, dbname 'postgres', sslmode %L, fetch_size '10000',
             application_name 'can_explo_hub', keep_connections 'off')$q$, srv, p_host, p_port::text, p_sslmode);

  if exists (select 1 from pg_user_mappings where srvname = srv and usename = current_user) then
    execute format('alter user mapping for current_user server %I options (set user %L, set password %L)', srv, 'hub_reader.' || p_ref, p_password);
  else
    execute format('create user mapping for current_user server %I options (user %L, password %L)', srv, 'hub_reader.' || p_ref, p_password);
  end if;

  execute format('create schema if not exists %I', sch);
  if not exists (select 1 from information_schema.foreign_tables where foreign_table_schema = sch and foreign_table_name = 'change_sig') then
    execute format('import foreign schema hub_export limit to (collar, drill_progress, rig, prospect, code_list, change_sig) from server %I into %I', srv, sch);
  end if;

  insert into hub_private.site_config (site_code, fdw_server, project_ref, enabled)
  values (p_site, srv, p_ref, true)
  on conflict (site_code) do update set fdw_server = excluded.fdw_server, project_ref = excluded.project_ref, enabled = true;
  insert into hub_private.refresh_state (site_code) values (p_site) on conflict do nothing;

  return 'site ' || p_site || ' connected. Next: select hub_private.refresh_if_changed();';
end $fn$;

-- >>> EDIT THE 4 VALUES, THEN RUN (this line only) <<<
-- select hub_private.add_site('WKM', 'abcdefghijklmnopqrst', 'aws-0-ap-southeast-1.pooler.supabase.com', 'THE-HUB-READER-PASSWORD');

-- First pull and check:
-- select hub_private.refresh_if_changed();
-- select * from hub.site_status;
-- select * from hub_private.refresh_log order by started_at desc limit 10;

-- Change a site's hub_reader password later (change it on the site FIRST, then here):
-- alter user mapping for current_user server site_wkm options (set password 'NEW-PASSWORD');

-- Pause / resume a site without deleting its cached rows:
-- update hub_private.site_config set enabled = false where site_code = 'WKM';

-- Force a full re-pull of everything at the next tick:
-- update hub_private.refresh_state set sig = null;
