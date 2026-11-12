# Setup Guide: Exploration Hub (for beginners)

Goal: combine the 8 site databases into ONE exploration hub (`nuymrirtigecyrosidga`) that Looker Studio and the future WebGIS read.
Do it for ONE pilot site first (e.g. WKM), check it, then repeat Part 3 for the others.
Prerequisite: the pilot site already runs migrations 0001 + 0002 (SETUP_GUIDE.md, Parts 2-3).

How it works: the hub PULLS. Every 3 minutes the hub asks each site "did anything change?" (one tiny query). Only if yes, it replaces that site's cached rows. Sites never push and never know the hub exists.

---

## Part 1. On each SITE: create the read-only door

1. Site Supabase > SQL Editor > New query. Paste `supabase/migrations/0003_site_hub_export.sql`, Run. (Once per site.)
2. New query. Generate a long random password (30+ characters, letters+digits only, to avoid quoting problems) and save it in your password manager as "WKM hub_reader". Run:

```sql
set password_encryption = 'scram-sha-256';
alter role hub_reader with password 'PASTE-THE-PASSWORD';
```

3. Collect two values from this site (you need them in Part 3):
   - **Project ref**: Project Settings > General > Reference ID (about 20 lowercase letters).
   - **Session pooler host**: top of the page > **Connect** > Session pooler. Copy only the host, e.g. `aws-0-ap-southeast-1.pooler.supabase.com`. Copy it; do not guess (region differs per project). Use the **Session** pooler, port 5432. The "direct" host is IPv6-only and will fail.

## Part 2. On the HUB: one-time setup

1. Hub project > **Database > Extensions**: make sure `postgis`, `postgres_fdw`, `pg_cron` are enabled (search each name, switch on). If any is missing on the free tier, STOP and tell me which one.
2. SQL Editor > New query. Paste `supabase/hub/hub_01_setup.sql`, Run. Expected: success. If red error: do not rerun; send me the full text.
3. Set the password for Looker (save it in your password manager as "explo hub looker_reader"):

```sql
set password_encryption = 'scram-sha-256';
alter role looker_reader with password 'PASTE-ANOTHER-LONG-PASSWORD';
```

## Part 3. Connect each site to the hub

1. Hub SQL Editor > New query. Paste `supabase/hub/hub_02_add_site.sql` and run it once (this only creates the helper function).
2. New query, fill the 4 values and run ONLY this line:

```sql
select hub_private.add_site('WKM', 'SITE-PROJECT-REF', 'POOLER-HOST', 'SITE-HUB_READER-PASSWORD');
```

Do not save a file containing the real password in Git.
3. First pull:

```sql
select hub_private.refresh_if_changed();
```

Expected: `{"WKM": "ok"}`. Then:

```sql
select * from hub.site_status;
select * from hub_private.refresh_log order by started_at desc limit 10;
select count(*) from hub.v_collar;
```

4. Wait 3 to 4 minutes, run `refresh_if_changed()` again: `{"WKM": "unchanged"}` means change detection works. Enter a record on the site, wait 3 minutes, check it appears in `hub.v_collar` / `hub.v_drill_progress`.
5. Repeat Part 1 + Part 3 for each of the other sites (BM, TMS, CDSM, IBN, TPB, AJB, CDS).

## Part 4. Connect Looker Studio

1. Looker Studio > Create > Data source > **PostgreSQL**.
2. Host: hub **Session pooler** host (hub project > Connect). Port 5432. Database `postgres`. Username `looker_reader.nuymrirtigecyrosidga` (role name, a dot, the hub project ref). Password: the looker_reader password. Tick SSL if offered.
3. Pick views from schema `hub`: `v_daily_progress` (meters per day/rig/site), `v_hole_summary` (progress vs planned depth), `v_collar` (collars with coordinates), `site_status` (data freshness).
   `looker_reader` can read schema `hub` only; it cannot see site connection details and cannot write.
   If Looker's IP is blocked, see Supabase Database > Network restrictions (default is open).

## Part 5. Health checks (weekly, 2 minutes)

```sql
select * from hub.site_status;                       -- last_ok_at per site should be recent
select site_code, last_error, last_fail_at from hub_private.refresh_state where last_error is not null;
select cron.job.jobname, d.status, d.start_time from cron.job_run_details d join cron.job on job.jobid=d.jobid order by d.start_time desc limit 5;
select pg_size_pretty(pg_database_size('postgres'));  -- free tier cap 500 MB
```

## Built-in safeguards (what the hub does by itself)

| Situation | What happens |
|---|---|
| Site unreachable / wrong password | Error recorded in `refresh_state`; old data stays; retry after 30 min back-off |
| Site suddenly has <50% of the rows the hub cached | Refused ("floor guard"); old data stays. If it is real, force: `select hub_private.refresh_site('WKM', true);` |
| Site renames/removes a column in `hub_export` | Error, never shifted columns; fix the site view |
| Nothing changed | No data moved (cheap) |
| Weekly (Sat 19:07 UTC) | Forced full re-pull + log cleanup |

Pause a site: `update hub_private.site_config set enabled=false where site_code='WKM';`
Change a site password: change on the SITE first, then `alter user mapping for current_user server site_wkm options (set password 'NEW');` in the hub.

## Free-tier cautions (verify, they change)
- Free projects can be **paused after about a week of inactivity**. The hub's 3-minute pull keeps each SITE active (it queries them), but nothing wakes a paused hub: open it at least weekly or consider Pro for the hub.
- 500 MB database limit on the hub: check size monthly (Part 5). Photos stay in each site's storage; the hub only holds `photo_path`.
- If the hub is paused or a site is paused, the hub just shows stale `last_ok_at`; no data is lost.

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `extension "pg_cron" is not available` | Not enabled | Database > Extensions |
| `could not connect to server` | Wrong host/ref/password, or used direct host | Re-check Part 1 step 3; use Session pooler host |
| `password authentication failed` | hub_reader password differs from mapping | Set both again (SCRAM) |
| `unsupported or invalid secret format` | Password set without SCRAM | Run the `set password_encryption` line first |
| `floor guard` error | Site lost many rows | Investigate site; force only if intended |
| Looker shows nothing | Wrong username format | `looker_reader.<hub-ref>` |
