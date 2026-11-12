# Site database migrations (one Supabase project per site)

## New site: fastest way
Supabase > SQL Editor > New query > paste the whole `ALL_new_site.sql` > Run. It is 0001 to 0014 joined in the order below.
Then run the optional step for the hub if the site feeds explohub (see the table).
If Run shows a red error, stop and send the full message; the file is safe to run again after the cause is fixed.

## Order (also if you run the files one by one)
| # | File | What it does | Needed for |
|---|---|---|---|
| 1 | `0001_exploration_site_schema.sql` | tables collar + progress, rigs, prospects, profiles, roles, RLS, photo bucket | all sites |
| 2 | `0002_configurable_params.sql` | roles, code lists and parameters as data (editable in Pengaturan) | all sites |
| 3 | `0003_site_hub_export.sql` | schema `hub_export` (read-only views for explohub) | all sites; run before 0008 so its export part is not skipped |
| 4 | `0004_super_admin_and_descriptions.sql` | super_admin role, descriptions, delete guards | all sites |
| 5 | `0005_collar_duplicate_guard.sql` | blocks duplicate / too-close collars | all sites |
| 6 | `0006_progress_core_photo.sql` | core photo per interval | all sites |
| 7 | `0007_stage2_progress_hours_map.sql` | core result, Distribution Hour, IUP boundary | all sites |
| 8 | `0008_phase1_schema.sql` | survey, sample status, assay, weekly plan, dip/azimuth, UTM zone, hub export | all sites |
| 9 | `0010_daily_report_codes.sql` | codes for the daily report | all sites |
| 10 | `0011_map_class_coh.sql` | map class COH | all sites |
| 11 | `0012_input_forms.sql` | per-form input permission | all sites |
| 12 | `0013_consumables_and_cleanup.sql` | consumables on Distribution Hour, drops unused objects | all sites |
| 13 | `0014_lab_roa_qaqc.sql` | lab RoA import columns, nullable hole for BLANK/CRM, `exp_crm`, QAQC threshold defaults | all sites |

Numbers are only an order: there is no 0009 (removed). Every file is safe to run twice.
Existing sites: run only the files newer than the last one you ran.

## After the SQL (new site)
1. Authentication > Users: create the first admin, then once in SQL: `insert into exp_profile (user_id, full_name, role, email) values ('<auth uuid>','Name','site_admin','email');`
2. Fill `url` and `anonKey` of the site in `js/config.js` (anon key only).
3. Optional, to create users from the app: deploy the Edge Function `supabase/functions/exp-admin-users` (see `docs/SUPER_ADMIN_GUIDE.md`).
4. Optional, for explohub: `supabase/hub/hub_02_add_site.sql` (see `docs/HUB_SETUP_GUIDE.md`).

## Adding a new migration
Name it `00NN_what_it_does.sql` with the next number, make it safe to run twice, add it to the table above, then run `./build_all.sh` to refresh `ALL_new_site.sql`.
