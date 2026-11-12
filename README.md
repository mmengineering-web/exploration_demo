# Exploration Data Entry PWA (v0.8)

Offline-first PWA for exploration data entry. Static files (GitHub Pages) plus one Supabase project per site; sites feed the combined explohub. The thorough documentation is still to be written; this page is the current state only.

## What the app does
| Tab | Purpose |
|---|---|
| Drilling Progress | interval per hole, shift and rig: from/to, layer, core length and recovery, downtime and reason, core photo, EOH checkbox |
| Collar | planned and as-built position (GPS), status, depth, dip/azimuth, collar photo, duplicate guard |
| Distribution Hour | rig hours per activity (From/To or duration) with optional Consumables: fuel, polymer, hyd oil (L) |
| Sampel | sample register (split per N m), status SENT / ANALYZED / PENDING, bulk status change |
| Import | Excel import (COLLAR, PROGRESS, DIST_HOUR, SURVEY, SAMPLE, ASSAY) with a preview, register-missing values and holes; the template is built in the app per site, with the same rules as the forms |
| Peta | collars by class (Planned / EOH / COH), IUP boundary, basemaps (Esri satellite, Esri topo, OpenTopoMap), device-only layers (shapefile / GeoJSON), PDF "Drillhole Plan Map" layout |
| Laporan | daily drilling report text (WhatsApp format) |
| Data Records | combined list of all forms plus one list per form; every list can be collapsed, searched, filtered per column and sorted; Excel and photo backups |
| Pengaturan | rigs, prospects, code lists, parameters, roles, users (incl. per-form input permission) |

## Folder
```
index.html, manifest.webmanifest, sw.js   shell and offline cache (bump the cache name in sw.js on every release)
css/ds/ (tokens, base, components, shell), css/screens.css
js/                                        app code (ES modules); js/vendor = third-party libs (jsPDF, shp, SheetJS mini)
icons/                                     PWA icons
licenses/                                  font and icon licenses (Geist, Lucide, pdf.js)
docs/                                      setup, super admin, hub setup, soft delete and purge guides
supabase/migrations/                       site schema, run in order per site
supabase/functions/exp-admin-users/        Edge Function for creating users (super admin)
supabase/hub/                              explohub scripts (production hub: do not edit)
```

## Setup (per site)
1. New site: paste `supabase/migrations/ALL_new_site.sql` in the SQL Editor and Run (it is `0001` to `0013` in order; the table in `supabase/migrations/README.md` explains each file). Existing site: run only the numbered files newer than the last one you ran. There is no 0009. All are safe to run twice. `0003` creates the `hub_export` views and is only needed for explohub. `0013` stops with a message if any Progress row still holds consumables (export them first).
2. Supabase > Authentication > Users: create the first admin, then once in SQL: `insert into exp_profile (user_id, full_name, role, email) values ('<auth uuid>','Nama','site_admin','email');`
3. Fill `url` and `anonKey` of the site in `js/config.js` (anon key only, never the service-role key).
4. Host over HTTPS (service worker, GPS, camera need it), open the app, log in, configure in Pengaturan.
5. Explohub (once): `supabase/hub/hub_03_phase1_upgrade.sql`, then `select hub_private.upgrade_site('<SITE>')` per site. See `docs/HUB_SETUP_GUIDE.md`.

Local test: `cd exploration-pwa && python3 -m http.server 8080`.

## Notes and limits
- Accounts (email + password) are created in Supabase Auth or by the Edge Function; the browser never holds the service-role key.
- Hole ID: the server rule is A-Z, 0-9, "-", 4-30 characters; the Hole ID regex setting must be equal or stricter.
- Per-form input permission (Pengaturan > User) is enforced by the tabs, the import and the server (migration 0012).
- Map layers are stored only on the device that uploaded them, never on the server. IUP boundary comes from `exp_iup`.
- iOS has no Background Sync (uploads while the app is open); Safari may purge storage after about 7 days of non-use.
- First load needs internet (CDN libs are cached afterwards); the map needs internet for Esri tiles.
- Hub pull should use `server_updated_at`. Consumables in Distribution Hour reach the hub only after the hub's pull list for `dist_hour` is extended (`hub_export.dist_hour` already exposes the columns; `drill_progress` keeps three always-NULL consumables columns so the hub's column list still matches).
