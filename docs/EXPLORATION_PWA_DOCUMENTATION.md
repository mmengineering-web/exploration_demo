# Exploration Offline Data Entry PWA: Documentation

**Version:** v1.2.2 (cache `exp-pwa-v36`)
**Owner:** Database Engineering, PT Central Abadi Nusantara
**Pilot site:** WKM. **Sites planned:** WKM, BM, TMS, CDSM, IBN, TPB, AJB, CDS (one Supabase project per site, combined in **explohub**)
**Status:** Phase 1 (data input) is feature complete. Phase 2 is feature complete: the one-page **Dashboard** (with QAQC Geokimia, a collar map by class, Excel and PDF export), the **All sites** view on explohub, the **Data QC** tab and the lab RoA PDF import are built. All were tested in a headless browser with a fake Supabase (and the map with a local Leaflet copy) and on a local Postgres 16. **Not yet tested on real phones, real Supabase storage, the dashboard on a live site, a real explohub login, real map tiles, real Excel or the Edge Function.**

> Security rule: never commit API keys, service-role keys, database passwords or user passwords. `js/config.js` may only hold each site's project URL and **public anon key** (protected by Row Level Security).

---

## 1. Purpose and roadmap

Exploration crews at remote sites often have no internet. The app lets geologists and site admins record exploration data on a phone or laptop with or without signal, then sends it to the site's Supabase database when a connection is available. The same data later feeds dashboards and geological modelling.

| Phase | Scope | Status |
|---|---|---|
| **1. Data input** | Drilling Progress, Collar, Distribution Hour (with Consumables), Sample register, Excel import, Map and PDF plan map, daily report, settings and roles | Done (this document) |
| **2. Dashboard** | **Drilling Dashboard** | Done (v1.2): one-page Dashboard with QAQC, collar map, Excel and PDF export (3.11), Data QC tab (3.13), All sites view on explohub (3.15). Live verification pending |
| **3A. Geological Model Module** | **Auto Domain**, **Compositing & EDA**, **Geological Model**, **3D & Section** | Planned |
| **3B. Resource Estimation Module** | **Resource Estimation** | Planned |
| **4. Reporting** | **Comprehensive report** | Planned |

Note: the roadmap lists "Phase 3" twice (Geological Model, Resource Estimation); they are labelled 3A and 3B here. Rename if you prefer 3 and 4 (the report then becomes Phase 5).

Details of the planned phases are in section 15. Out of scope for the field app itself: geological logging (lithology, RQD). The lab PDF reader exists (section 3.12).

---

## 2. Architecture

```
 Phone / laptop (PWA)                    Site Supabase project (one per site)         explohub (production hub, separate)
 ┌─────────────────────┐   HTTPS+login   ┌───────────────────────────────┐   pull via   ┌─────────────────────────┐
 │ Vanilla JS modules  │ ──────────────▶ │ Postgres + RLS + triggers      │ ───────────▶ │ views, Looker / WebGIS  │
 │ IndexedDB (Dexie)   │ ◀────────────── │ Auth (email + password)        │ hub_export.* │ (do not edit hub files) │
 │ Service worker      │                 │ Storage bucket exp-photos      │              └─────────────────────────┘
 │ Outbox queue        │                 │ Edge Function exp-admin-users  │
 └─────────────────────┘                 └───────────────────────────────┘
```

- **No build step.** Plain ES modules, hosted as static files (GitHub Pages).
- **One app, input and dashboard together.** The dashboard tabs live in the same shell, login and install. They read the site's own Supabase live through the logged-in client (online only); input and sync stay offline-first.
- **One Supabase project per site.** The site is chosen at login; the local database on the device is per site (`exploration_<SITE>`), so data from different sites never mixes.
- **Offline-first.** Every save goes to the device (IndexedDB) and an **outbox**; sync sends the outbox when online.
- **Rules as data.** Roles, code lists and parameters are database rows editable by admins in the app.
- **Database enforces the rules too.** The app validates on the device; triggers and RLS validate again on the server.
- **Hub contract.** The hub never reads `public.exp_*`. It reads schema `hub_export` through explicit column lists, so those column lists are only ever appended to, never reduced.
- **Libraries** (CDN, cached by the service worker): Dexie 4, supabase-js 2, Leaflet 1.9.4 (loaded when Peta opens). Vendored in `js/vendor`: jsPDF, shp, a SheetJS mini build, Chart.js 4 (loaded when a dashboard tab opens). Map tiles: Esri and OpenTopoMap.

---

## 3. Features by tab

Tabs shown depend on the user's role and per-form permission (section 4). On a desktop they appear in a sidebar grouped Input, Analisis, Data and Sistem; on a phone the first four are in a bottom bar and the rest are under **Lainnya**. The top bar has the sync chip, a sync button and a light/dark toggle. Guests (not logged in) only see the input forms they are allowed, Laporan and Data Records. The dashboard tabs (3.11) need a login and internet.

### 3.1 Login
- Choose the **site**, enter email and password. Login needs internet (disabled offline).
- **Input tanpa login (offline)**: guest mode. Data stays on the phone and is sent after a normal login; records are attributed to whoever logs in.
- While unsent data exists, the site selector is locked so data cannot go to the wrong site.

### 3.2 Drilling Progress
Date, shift, rig, hole, From / To, layer, core length (recovery % calculated), downtime hours and reason, core photo (`core/HOLEID_from_to.jpg`), EOH checkbox, remarks. Planned depth ("Rencana") and achieved depth ("Capaian") are calculated per hole. Consumables are **not** on this form (they are on Distribution Hour). Below the form: the collapsible, searchable **record list** of all progress rows (tap a row to edit).

### 3.3 Collar
Hole ID, type, prospect, status, planned and as-built position (**Ambil GPS** with accuracy), elevation, depths, dip and azimuth, collar photo (`collar/HOLEID.jpg`), remarks.
- **Register missing holes:** holes found in Progress, Sample or Import but absent from Collar can be registered.
- **Duplicate guard:** planned and as-built coordinates are compared with every other live hole; closer than the limit (default 2 m) blocks saving. The server repeats the check.
- **Pilih dari rencana** completes a planned hole instead of creating a duplicate; **Buat Hole ID baru** generates `SITE-TYPE-<device><nnn>` for unplanned holes so two offline phones never collide.
- Record list with filters below the form.

### 3.4 Distribution Hour
Date, rig, From / To (hours calculated), activity, remarks and optional **Consumables**: fuel, polymer, hyd oil (litres, one entry per rig activity). A rig cannot have overlapping times on a date; a record cannot cross midnight (split in two). A new entry starts at the end of the previous one. A table shows accumulated hours per rig and activity for the date. Full record list below the form.

### 3.5 Sampel
Sample register: sample number, hole, From / To, type (Normal, Duplicate, CRM, Blank), status (Pending, Sent, Analyzed), sampled and sent dates, lab, batch, remarks.
- **Pecah per (m):** one interval is split into many samples; numbering continues from the number entered, the last piece may be shorter.
- **Bulk status change** for the ticked samples.
- Rules: unique sample number; Normal samples of one hole must not overlap; sent date not before sampled date; warnings when deeper than total depth or drilled depth.
- Collapsible "Daftar Sampel" with search, per-column filters and sorting.

### 3.6 Import (Excel)
Sheets: **COLLAR, PROGRESS, DIST_HOUR, SURVEY, SAMPLE, ASSAY** (assay from Excel; the lab PDF has its own tab, section 3.12).
- **Template** is generated in the app per site (`Unduh template`): same limits as the forms, via dropdown lists, stop-style data validation and conditional formatting, driven by that site's lists, rigs, prospects, hole pattern, shift hours and UTM zone.
- Coordinates may be given as X/Y (UTM, using the site's zone and hemisphere) or lat/lon.
- Every row is checked with the same validators as the forms and listed as **ready / warning / refused**. Nothing is written until confirmed. Rows that already exist are refused, never overwritten.
- **Register missing** values (rigs, prospects, codes) and holes during import. A collar row with only warnings is held back unless **Sertakan baris berperingatan** is ticked, and its dependants (progress, sample, survey, assay) are no longer refused because of it.
- A user can only import the sheets of forms they may input.

### 3.7 Peta
- Basemaps: **Esri satellite, Esri topographic, OpenTopoMap (OpenStreetMap)** or none; attribution shown.
- IUP boundary (from `exp_iup`), collar points by class (**Planned, EOH, COH**; class from Pengaturan > Daftar kode > Status collar), tap for details.
- **Tambah / kelola layer peta** (collapsible): upload shapefile (zip) or GeoJSON layers, style, order, visibility. These layers live **only on the device** that uploaded them.
- **PDF "Drillhole Plan Map"** layout (A4 / A3 / A2) with scale, north arrow, legend, insets and UTM grid, using the selected basemap.
- Needs internet for tiles and Leaflet.

### 3.8 Laporan
Daily drilling report text in the site's WhatsApp format: per rig, daily and to-date meters, time sheet, issues and plan.

### 3.9 Data Records
- **Semua data:** one combined list of every form.
- One list per form (Progress, Collar, Distribution Hour, Survey, Sample, Assay). Every list is **collapsible**, with a search bar, a filter per column (text, option, number range, date range), sortable headers, "show more" paging and a sync badge per row (synced / pending / error).
- **Backup ke Excel** and **Backup foto** follow the filters of the lists.

### 3.10 Pengaturan
Everyone logged in can view; admins edit; the super admin can also delete. Sections: Rig, Prospect, Daftar kode (with behaviour flags and drag-to-reorder), Parameter, Batas IUP, Role, User. In **User**, every writer role gets one checkbox per form (Progress, Collar, Hours, Sample) to limit that person to some forms.

**Code list flags:** coring hole type shows core fields; "planned" status feeds *Pilih dari rencana*; required as-built position or total depth per status; hide from progress; map class (Planned / EOH / COH).

### 3.11 Dashboard (one page)
Any logged-in user with an active role sees this tab (reading is open to every active role). A `viewer` has no input forms, so Dashboard is that user's first tab. Data is read live from the site database; offline the tab says it needs internet, and the rest of the app keeps working. Data is cached in memory for 2 minutes; **Refresh** reloads. Every chart has a **Table** button.
One scrolling page, layout taken from the "Exploration Progress" reference artifact (KPI tiles, chart cards, blue section markers), styled with the design system tokens (`docs/DESIGN_SYSTEM.md`), light and dark.
- **Header:** month-to-date sentence (month of the last day with data): meters, plan, achievement.
- **Controls:** Prospect, Rig, Daily / Weekly / Monthly, Reset.
- **Drilling Progress:** MTD cards (meters, plan, achievement, holes); meters per period stacked by rig with a dashed plan line (Daily = last 60 days, Weekly = 26 weeks, Monthly = 12 months); rig summary table (meters, share, holes, days, m/day, recovery, % drilling hours).
- **Hour Distribution:** hours per activity per rig, last 60 days, stacked.
- **Samples:** Pending / Sent / Analyzed cards and a status bar per prospect.
- **QAQC Geokimia** (labels in Indonesian, numbers as 8.782 and 8,0%): four cards (Sampel terkirim, ROA belum diinput, Excel QAQC tertunda, Insertion rate QC); line chart "Alur sampel: terkirim vs ROA vs excel QAQC" (per day, last 60 days; if nothing happened recently it shows the last 60 days that have activity); three cards Blank gagal, CRM gagal (Ni) and Duplikat gagal (failed / checked, same rules and thresholds as the Data QC tab, including `qaqc_thresholds` from `exp_setting`); scatter "Blank, Ni (%)" over report date with the contamination line; scatter "Duplikat, original vs duplicate Ni (%)" with the y = x line and dashed relative-difference limits (one pair per distinct limit, PD 5% and CD/RD 10% by default). Red points are failures. The Prospect filter applies to the flow chart, the three failed cards and both scatter charts: duplicates follow their hole's prospect; blanks and CRMs have no hole, so they follow their lab batch (kept when the batch holds an assay of a hole in that prospect). The four top cards always cover all prospects. If `exp_assay` cannot be read, only this section shows the error.
  - **Definitions** (the app has no field for the Excel QAQC step, which is done in the lab workbook): *Terkirim* = register rows with a sent date (blank, CRM and duplicate rows included). *ROA diinput* = those samples that have an assay row imported from a RoA PDF (`source_type = 'pdf'`), dated by the day it was saved. *Excel QAQC selesai* = their lab batch holds at least one blank, one CRM and one duplicate result, dated by the day the last of the three arrived. *ROA belum diinput* = terkirim minus ROA diinput. *Excel QAQC tertunda* = terkirim minus Excel QAQC selesai. *Insertion rate QC* = non-NORMAL register rows divided by terkirim. Change `qaqcIndex` in `js/dash/calc.js` if the lab confirms another rule.
- **Collar Map:** Leaflet map (loaded on demand from the jsDelivr CDN, so it needs internet) with Esri satellite as default and a topographic option. One circle per collar, coloured by class: Planned (hollow grey), EOH (green), COH (orange), at the as-built position, or the planned position when there is none. Legend shows the count per class and "n of N collars have coordinates". Collars with missing or 0,0 coordinates are skipped. The Prospect and Rig filters apply. Popup shows hole, prospect, status, depth and whether the position is as-built or planned.
- **Export (Excel and PDF):** two buttons in the controls row, both honour the current filters and scope.
  - **Excel** (`js/dash/export.js`, writer `js/lab/xlsxw.js`): one workbook with the scope and filter sheet, KPIs, progress per period, rig summary, hour distribution, samples, collar list with class and coordinates, and (site scope) QAQC flow and failed checks.
  - **PDF** (jsPDF, vendored): the page is rendered off screen in the light theme, then KPI cards, charts (as images) and tables are laid out on A4 pages. The map is not included. The theme is restored afterwards.
  - File names: `exploration_dashboard_<SITE or all-sites>_<date>.xlsx` or `.pdf`.
- **Plan:** the weekly plan is a site total, so it is spread evenly over the 7 days of its week; it is hidden while a prospect or rig is selected. NPT, downtime reasons, layers and consumables were removed from this page (calc functions kept).
- **QAQC detail** (control charts per batch, CRM Z-score, issues list) lives in the **Data QC** tab (section 3.13), fed by the **RoA Lab** import (section 3.12).
- **Definitions** (`js/dash/dashconfig.js`): EOH, COH and Planned come from the collar status map class; NPT is the share of Distribution Hour hours in `NPT_ACTIVITY` (default `STANDBY`, `MOVE_SETUP`; confirm per site); core recovery is core length over meters on rows with a core length; achievement is week meters over `exp_weekly_plan`.

### 3.12 RoA Lab (import of the lab Report of Analysis, PDF)
Visible to users who may enter sample data (form permission `sample`). The user picks the PDF the lab sends. The text is read inside the browser with pdf.js (vendored in `js/vendor`, loaded only when the tab is used, available offline once cached); no file leaves the phone. The app shows a preview and saves nothing until the user presses **Simpan**.
- **What is read:** the report header (REF. NO, report number, client reference, received / tested / reported dates, declared sample count) and one row per table line with 14 analytes (Ni, Fe, Co, MgO, CaO, SiO2, Al2O3, Cr2O3, MnO, P2O5, Fe2O3, TiO2, Zn, MC). `<0.01` is stored as 0.005 (half the detection limit; the remark says so). A dash means no value. The sample id `HOLE-DEPTH` gives the hole and the end depth; the start depth comes from the sample register (`exp_sample`) when the number exists there, otherwise from the previous sample of the same hole (0 for the first), and the row is marked with a warning. A lab typo such as `TPB-A007--48` is read as `TPB-A007-48` and noted.
- **Row types:** primary samples become `NORMAL`; `BLANK-n` becomes `BLANK`; `OREAS 182b-n` becomes `CRM` with its name; `<id>-RD`, `-CD` and `-PD` become `DUPLICATE` with the type and the original sample number. BLANK and CRM rows have no hole and no interval (migration 0014 allows this).
- **Where it is saved:** Ni, Co, Fe, MgO and SiO2 go to their columns in `exp_assay`; the other analytes go to the `extra` JSON as `<name>_pct` (for example `al2o3_pct`, `mc_pct`). The report number is the batch id (`batch_id`), and `certificate_no`, `client_ref`, `lab_seq` and the three dates are kept. `source_type` is `pdf` and `source_file` is the file name.
- **Checks before saving:** declared count against the rows read (the lab sometimes declares only primary samples, sometimes every row; both are accepted), row numbers without gaps, hole without collar, sample number already imported, the same blank or CRM already imported in this batch, and identical blank or CRM values in a different report (a possible copied QC result). Rows already imported are skipped, so importing the same PDF twice adds nothing.
- **Limits:** scanned PDFs (images) cannot be read; the tab says so. The parser was verified against two real reports (166 and 203 rows, 4,130 values, no difference from the lab workbook); a differently laid-out lab report may need an adjustment in `js/roa/parse.js`.

### 3.13 Data QC (Dashboard family, live read)
Any logged-in user with an active role sees it. Data comes from `exp_collar`, `exp_survey`, `exp_sample`, `exp_assay`, `exp_crm` and `exp_setting`, cached 2 minutes; offline it asks for internet. Header cards: critical issues, warnings, lab batches, QAQC checks failed, mean CRM Ni Z-score, duplicates within limit. Three sub-tabs:
- **QC & Survey:** a sortable, searchable issue list (filter by severity and category). Checks: completed hole without total depth, as-built coordinate or downhole survey; GPS accuracy; survey deeper than total depth, two surveys at one depth, dip far from the collar dip; assay on a hole without collar, interval deeper than total depth, overlapping intervals, gaps (information only); samples sent to the lab with no result after 7 / 14 days; sample marked ANALYZED without an assay; and every failed QAQC result and inconsistent assay value.
- **QAQC Geochemistry:** batch status table (blank, CRM, duplicate counts, QC rate, fails, missing QC types), blank Ni chart against its limit, duplicate ARD chart, CRM Z-score chart with a selector per analyte, lab bias table (mean Z per batch and analyte), identical-QC list across reports, and sample counts per geochemical class. Every chart has a Table button.
- **Thresholds:** every limit in use with a one-line reason.
- **Downloads:** *Download issues (Excel)* (issues, batches, blank, CRM, duplicate) and *Download lab analysis (Excel)* (section 3.14).

**Thresholds** (`js/qc/calc.js`, defaults match migration 0014; an admin can override them by editing the `qaqc_thresholds` JSON in `exp_setting`). They follow the TPB lab-analysis workbook, which is stricter than the percent-deviation limits of GeoExploration (CRM 10 / 20 %, RPD 10 / 20 %), because the CRM check uses the certificate's own standard deviation.
| Check | Limit | Reason |
|---|---|---|
| Blank, Ni | 0.05 % | About 5 times the detection limit (0.01 %); above it means carry-over or contamination |
| Pulp duplicate (PD), Ni ARD | 5 % | Pulp is homogenised, so this measures the lab analysis alone |
| Coarse duplicate (CD), Ni ARD | 10 % | Includes crushing and splitting error |
| Reject duplicate (RD), Ni ARD | 10 % | The lab has not defined RD yet; CD limit used until confirmed |
| CRM warn / fail | &#124;Z&#124; > 2 / > 3 | Z = (measured - certified) / SD; beyond 2 SD is about 1 in 20 by chance, beyond 3 SD is rare |
| CRM resolution rule | SD < 0.01 not scored | The lab prints 2 decimals; Co (SD 0.0016) would only reflect rounding |
| Fe2O3 against Fe x 1.4297 | 3 % | Same iron in two units; a larger gap is a data problem |
| Moisture (MC) | >= 45 % | Re-check preparation and weighing |
| Sample sent, no result | 7 / 14 days | Warning, then critical |
| Dip against collar dip | 10 degrees | Often a wrong sign or typing error |
ARD = &#124;dup - orig&#124; / mean(dup, orig). Class rules (in order): BRK Ni < 0.8 and MgO >= 30 and Fe < 10; RSAP MgO >= 20 and Fe < 15; SAP MgO >= 10, or Fe < 25 with MgO >= 5; CEK Fe < 25 and MgO < 5; otherwise LIM. Laterite indication: Al2O3 >= 8 high, >= 4 medium; Cr2O3 >= 2 high, >= 1 medium; Cr2O3 >= 4 chromite flag; Al2O3 >= 15 clay flag. These are common Sulawesi laterite practice, not a standard: adjust them to the site SOP.
**CRM certificates** are rows in `exp_crm` (name, analyte, certified value, SD); migration 0014 seeds OREAS 182b (Ni 0.757 +/- 0.018, Fe2O3 32.78 +/- 0.283, MgO 8.75 +/- 0.149, SiO2 32.33 +/- 0.323, Al2O3 6.91 +/- 0.101, Cr2O3 0.845 +/- 0.012, Co 0.0809 +/- 0.0016). Never use the OREAS 182 certificate for 182b.
**Result on the two sample reports:** the duplicate fails (1 in report 26-21, 6 in report 26-27) and the CRM Z-scores equal the lab workbook's; for example SiO2 -4.12 and Cr2O3 -5.42 on the first CRM of report 26-21, a systematic low bias for SiO2 and Cr2O3 in that report.

### 3.14 Lab analysis workbook (Excel export)
The button *Download lab analysis (Excel)* builds a workbook modelled on `TPB_Lab_Analisis_Geokimia_v4` in the browser, with live formulas that read the **Parameter** sheet (yellow cells are inputs; change a limit and every class and PASS / FAIL updates). Values are also stored, so viewers that do not recalculate still show numbers; the 7,518 formulas of the two sample reports were recalculated in LibreOffice and match with no error.
- **Sheets:** Ringkasan (reports, class counts, QAQC fails), Assay_Data (30 columns incl. geochemical class, laterite indication, Fe/Fe2O3 deviation, flags), Ringkasan_Lubang (length-weighted Ni / Fe / MgO, ore length at the Ni cut-off, class counts per hole), QAQC (A blank, B CRM with Z per analyte and fingerprint, C duplicates with ARD), Collar (X/Y from the as-built or planned coordinate with the site UTM zone, RL, azimuth, dip, EOH), Data_Issues, Parameter, XYZ_Samples.
- **Not included:** charts (QAQC_Charts, Downhole_Plot, EDA_Scatter), the composite sheet (Composite_Ni) and the IDW maps (Map_Ni, Map_Fe, Map_MgO, Map_Isopach_Ni). Use XYZ_Samples in Surfer, QGIS or Leapfrog for those.

---

### 3.15 All sites (explohub)
A second tab, **All sites**, shows the same Dashboard across every site a person may see. It reads the explohub `dash` schema (`supabase/hub/hub_05_dash_access.sql`), not the site databases.
- **Config:** `HUB = { url, anon }` in `js/config.js`. Anon key only. While `anon` is empty the tab is hidden. The explohub URL is filled in; **the anon key must be added by the owner** (never commit a service-role key).
- **Login:** separate from the site login, with an explohub account (Supabase Auth, session key `exp_hub_auth`). The account needs a row in `dash.member`; `dash.my_sites()` returns the allowed sites and `dash.me()` the profile. A signed-in user without a row sees a "not a member" message. Sign-out button in the controls row.
- **Server setup (once, on explohub):** run `hub_05_dash_access.sql` and add `dash` to the exposed schemas (Settings, API). Views read: collar, drill_progress, dist_hour, sample, weekly_plan, rig, prospect, code_list, site_status.
- **What it shows:** the same controls plus a **Site** selector (all allowed sites, or one), the same Drilling Progress, Hour Distribution, Samples and Collar Map sections, and a **Site status** table. Rig ids are prefixed with the site (`WKM:RIG01`) so rigs of different sites never merge. Excel and PDF export work here too (`all-sites` in the file name).
- **Not in this view:** QAQC Geokimia, because the `dash` schema has no assay view. It stays in the site-scope Dashboard.
- **Caveat:** prospect codes that exist in several sites merge in the Prospect filter.

## 4. Roles and permissions

Roles are data (`exp_role_def`) with switches `can_write`, `can_admin`, `can_super`.

| Role | Input data | Edit master data | Users, roles, hard delete |
|---|---|---|---|
| viewer | no | no | no |
| geologist | yes | no | no |
| site_admin | yes | yes | no |
| super_admin | yes | yes | yes |

**Per-form permission:** `exp_profile.input_forms` is NULL (all forms the role allows) or a list from `progress, collar, hours, sample`. It is enforced by the tabs, the import and the server (`exp_can_input(form)` in RLS and storage policies, migration 0012). Reading is unchanged (any active role reads everything, including the dashboard tabs). Database guards protect the last admin and last super admin.

---

## 5. Data model (site database)

All tables have RLS; `anon` has no access. Soft delete (`is_deleted`) so deletions sync to every phone (see `SOFT_DELETE_AND_PURGE.md`).

| Table | Purpose |
|---|---|
| `exp_profile`, `exp_role_def` | Users and roles (`input_forms` per user) |
| `exp_rig`, `exp_prospect` | Master data |
| `exp_code_list` | Lists: hole_type, collar_status, shift, downtime_reason, activity, layer, sample_type, sample_status (with `meta` flags) |
| `exp_setting` | Parameters (below) |
| `exp_collar` | One row per hole: planned and as-built position, depths, dip, azimuth, photo |
| `exp_drill_progress` | Drilled interval: date, shift, rig, hole, from/to, meters (generated), layer, core length and recovery, downtime, photo |
| `exp_dist_hour` | Rig activity hours (generated) plus `fuel_l`, `polymer_l`, `oil_hyd_l` |
| `exp_survey` | Downhole survey: depth, dip, azimuth |
| `exp_sample` | Sample register |
| `exp_assay` | Ni, Co, Fe, MgO, SiO2 (+ `extra` JSON), QAQC fields (CRM, duplicate), lab report fields (`batch_id`, `lab_seq`, `client_ref`, dates), source. BLANK and CRM rows have no hole |
| `exp_crm` | CRM certificates: name, analyte, certified value, SD (read by all roles, written by admins) |
| `exp_weekly_plan` | Planned meters per week (kept because the hub pulls it) |
| `exp_iup` | IUP boundary (GeoJSON) |

Storage: private bucket `exp-photos` (`collar/`, `core/`).
**Parameters** (`exp_setting`): `gps_max_acc_m` (10), `shift_hours` (12), `photo_max_px` (1280), `progress_pull_days`, `depth_overrun_warn_factor` (1.5), `hole_id_regex`, `collar_min_dist_m` (2), `utm_zone`, `utm_hemisphere` (S).
**Server guards:** Hole ID format and uniqueness, code existence, interval overlap, depth limits, duplicate coordinates, distribution-hour overlap per rig, last-admin protection, in-use protection before deleting master data.

---

## 6. Validation rules (phone and server)

**Progress:** date, shift, rig, hole, From and To required; date not after tomorrow; From < To; error if To exceeds total depth, warning above planned depth; no overlap per hole; downtime 0 to shift hours and a reason when above 0; warning if core length exceeds meters drilled.
**Collar:** Hole ID matches the site pattern and is unique; type and status required; depths above 0; dip -90 to 90; azimuth 0 to 360; coordinates in range (warning outside Indonesia); as-built position and total depth required for statuses with those flags; GPS accuracy within limit; duplicate or too-close coordinates blocked.
**Distribution Hour:** date, rig, activity, From and To required; To after From; no overlap for the same rig and date; consumables not negative.
**Sample:** see 3.5. **Import:** every row passes the same validators; existing rows refused.

---

## 7. Offline and sync

1. **Save** = one IndexedDB transaction writing the record and an outbox entry.
2. **Sync** on login, when the connection returns, when the app becomes visible, every 5 minutes and by button. Steps: refresh permissions, push the outbox (collars first, photos with their record), pull reference data and records.
3. **Idempotent:** device-generated UUIDs and upserts; a repeated send never duplicates.
4. **Conflicts:** last write wins by `updated_at`. Data errors mark that outbox item and the rest continue (badge "error").
5. **Pull:** reference data fully replaced; records pulled incrementally by `server_updated_at` in pages of 1000.
6. **Older sites:** optional new columns are sent only when filled and missing new tables are skipped, so a site that has not run the latest migration still syncs.
7. **Logout** removes server-sourced collars, progress and photos from the device but keeps unsent data.
8. **Service worker:** stale-while-revalidate for app files and CDN libraries; Supabase calls and map tiles are not cached. The cache name must change on every release; hard-reload twice to pick up a new version. iOS has no Background Sync (uploads while the app is open) and Safari may purge storage after about 7 days of non-use.

---

## 8. Photos
Compressed on the phone (default longest side 1280 px, JPEG), stored locally until uploaded with their record. Collar photo `collar/HOLEID.jpg`, core photo `core/HOLEID_from_to.jpg`. **Backup foto** exports them. OneDrive copy is designed but not built (needs an Azure app from IT).

---

## 9. Security
- The app holds only the project URL and anon key; access is controlled by RLS, triggers and active profile and role.
- The service-role key exists only inside the Edge Function `exp-admin-users` (Verify JWT off; the function verifies the caller is an active super admin itself). Actions: create, delete, reset password.
- Private photo bucket with role- and form-based policies. Passwords are never stored in the app.

---

## 10. Project structure

```
index.html, manifest.webmanifest, sw.js    shell and offline cache
css/ds/{tokens,base,components,shell}.css (design system, see docs/DESIGN_SYSTEM.md), css/screens.css, css/dash.css (dashboard and Data QC, scoped under .dash)
styleguide.html  live design system reference; js/ui.js theme, toast, confirm dialog, sheet
js/            app.js (UI), admin.js (Pengaturan), sync.js, db.js, validate.js, importer.js, template.js,
               records.js (record lists), map.js, printmap.js (PDF), report.js, shp.js, utm.js, cfg.js,
               config.js, xlsx-lite.js, zip.js, icons.js, vendor/
               dash/ (dash.js tab controllers for site and All sites, data.js live site read, hub.js explohub read and login, calc.js, page.js, map.js collar map, export.js Excel and PDF, ui.js, dashconfig.js)
               roa/ (parse.js PDF text to rows, pdf.js browser adapter, commit.js import plan, view.js RoA Lab tab)
               qc/ (calc.js QC maths and thresholds, data.js live read, view.js Data QC tab)
               lab/ (xlsxw.js workbook writer with formulas and styles, workbook.js lab-analysis sheets)
icons/         PWA icons
licenses/      Geist (OFL), Lucide (ISC), pdf.js licenses
docs/          this file, SETUP_GUIDE, SUPER_ADMIN_GUIDE, HUB_SETUP_GUIDE, SOFT_DELETE_AND_PURGE
supabase/migrations/   0001 to 0014, README.md (order), ALL_new_site.sql, build_all.sh
supabase/functions/exp-admin-users/
supabase/hub/          explohub scripts hub_01..hub_05 (production hub: do not edit)
tests/                 calc, RoA and QC unit tests and headless-browser test with a fake Supabase
```

### Migrations (run in this order per site)
| File | Adds |
|---|---|
| 0001 | Base schema: profile, rig, prospect, collar, progress, RLS, photo bucket |
| 0002 | Rules as data: roles, code lists, settings, guards |
| 0003 | Schema `hub_export` and read-only hub role |
| 0004 | Super admin, descriptions, delete guards |
| 0005 | Duplicate / too-close collar guard |
| 0006 | Core photo column |
| 0007 | Core result, Distribution Hour, IUP boundary |
| 0008 | Survey, sample status, assay, weekly plan, dip/azimuth, UTM setting, full hub export |
| 0010 | Daily report codes (there is no 0009) |
| 0011 | Map class COH |
| 0012 | Per-form input permission |
| 0013 | Consumables on Distribution Hour, drops everything unused |
| 0014 | Lab RoA columns on `exp_assay`, hole and interval optional for BLANK / CRM rows, `exp_crm` certificates (OREAS 182b), default QAQC thresholds, hub assay view without hole-less rows |

All files are safe to run twice. **New site:** paste `ALL_new_site.sql` (0001 to 0014 joined) into the SQL Editor and run. After changing a migration, run `build_all.sh`. `0013` stops with a message if Progress rows still hold consumables; `move_progress_consumables.sql` (one-off) moves them to Distribution Hour first.

---

## 11. Setup summary (full steps in `SETUP_GUIDE.md` and `supabase/migrations/README.md`)
1. Create the site Supabase project; note the URL and anon key.
2. SQL Editor: run `ALL_new_site.sql`.
3. Authentication > Users: create the first admin, then insert its `exp_profile` row (`site_admin`).
4. Put the URL and anon key in `js/config.js`.
5. Optional: deploy the Edge Function `exp-admin-users` (Verify JWT off) to create users from the app.
6. Host over HTTPS (GPS, camera and service worker need it).
7. Open the app, log in online once, add to home screen, then configure rigs, prospects, codes, parameters (including `utm_zone`) and the IUP boundary in Pengaturan.
8. Optional, explohub: `supabase/hub/hub_03_phase1_upgrade.sql`, then `select hub_private.upgrade_site('<SITE>')` per site. After a site runs 0013 also run `hub_04_consumables.sql` once, then `upgrade_site` again, so consumables reach the hub. `hub_05_dash_access.sql` powers the All sites tab (section 3.15): run it, expose the `dash` schema, add members to `dash.member`, and put the explohub anon key in `js/config.js`.

---

## 12. Daily use (field quick guide)
1. Open the app (works without signal); without login use **Input tanpa login**.
2. **Collar:** create or pick the hole, **Ambil GPS** outdoors until accuracy is good, photo, Simpan.
3. **Drilling Progress:** rig, hole, From and To, core length, core photo, Simpan.
4. **Distribution Hour:** every activity so the day adds up per rig; add consumables on the entry that used them.
5. **Sampel:** register samples (use *Pecah per* for regular intervals); update status when sent or analyzed.
6. When signal returns the data uploads; the top chip shows `online · 0 pending` when done. For long offline periods use **Data Records > Backup ke Excel**.

---

## 13. Testing status
**Done:** guest and offline flow, login lock, upload after login, logout purge; calculations and photo naming; overlap and duplicate guards (phone and database); record lists (collapse, search, filter, sort, bulk select); per-form permission (tabs, admin User checkboxes); consumables on Distribution Hour; Excel template headers and importer round trip; register-missing and held collars; map classes, layers, OpenTopoMap selection; migrations 0001 to 0014 on local Postgres 16, three runs in a row on a fresh database (0014: BLANK / CRM rows without a hole accepted, NORMAL row without a hole refused, QC row duplicate in a batch refused, overlap guard still works, hub assay view hides hole-less rows); the consumables move script.
**Dashboard tabs (v0.9):** calculations (weeks, plan versus actual, NPT, consumables, recovery, empty data); in a headless browser with a fake Supabase: tabs for geologist, viewer and guest, filters, table toggle, offline message, load failure with retry, late result after a quick tab change, mobile width, input tabs unchanged. `hub_04` and `hub_05` ran twice on a stub Postgres 16; `hub_05` was checked with four users (all sites, one site, no profile, inactive) and `anon` refused.
**RoA / Data QC (v1.0):** unit tests (`tests/roa_qc.test.mjs`: parser helpers, import plan, QC maths, workbook build) and browser tests (RoA parse, save and re-import skip with a real lab PDF, QC tabs, both downloads); the 7,518 workbook formulas match a LibreOffice recalculation. Not yet run on a live Supabase site.
**Phase 2 completion (v1.2):** unit tests for collar points and class counts, the dashboard workbook build and the scope text; browser tests with a fake site and a fake explohub (All sites tab hidden without anon key, login, not-a-member, site selector, rig prefixing, no QAQC in hub mode, Excel and PDF downloads, offline map fallback message). The real Leaflet map was rendered once in headless Chromium with a local Leaflet copy (container, zoom control, markers, legend); satellite tiles were not reachable from the test sandbox.
**Not done:** a real explohub login (the `dash.me` response shape is assumed to be a list of rows), real map tiles, the dashboard on a live Supabase site and real phones; real phones (GPS, camera, install, battery); real Supabase (storage upload, signed URLs, migrations 0012 and 0013 on a live site); real Excel opening of the generated template; the Edge Function; PDF map with OpenTopoMap; load test with thousands of rows.

---

## 14. Known limitations
| Item | Status |
|---|---|
| Hub pull of consumables | Solved by `supabase/hub/hub_04_consumables.sql` (run once, then `upgrade_site` per site). Not yet run on the live explohub |
| Dashboard needs internet | Reads live; it does not use the device database. Offline the tab shows a message |
| Dashboard loads whole tables | Fine for thousands of rows; for 100k+ progress rows add date-bounded queries |
| All-sites dashboard | Built (section 3.15). Needs the explohub anon key in `js/config.js`, `hub_05` run and `dash` exposed. No QAQC section (no assay view in `dash`); prospect codes shared across sites merge in the filter |
| Collar map needs internet | Leaflet and Esri tiles load from the network; offline the section shows a message |
| RoA PDF layout | The parser is verified on the CDSM lab format only (two reports); another lab's layout may need `js/roa/parse.js` adjusted. Scanned PDFs are not read |
| Lab workbook scope | No charts, composite or IDW maps in the Excel export (section 3.14) |
| Data QC needs migration 0014 | Without `exp_crm` the CRM Z-score has no certificate; the tab says so |
| Dashboard language | Dashboard labels are English; the input forms are Indonesian |
| Map layers | Stored only on the device that uploaded them |
| Offline map tiles | Not supported |
| Record crossing midnight | Split into two records |
| OneDrive photo copy | Not built |
| Esri tile terms | Check terms for commercial use |
| `exp_weekly_plan` | Kept only because the hub pulls it |

---

## 15. Next phases (proposed scope)

The items below are the agreed phase list; the descriptions are proposals to confirm before building.

### Phase 2: Drilling Dashboard
**Phase 2 is built (v1.2):** one-page Dashboard (section 3.11) with QAQC Geokimia, collar map by class, Excel and PDF export, and the All sites view on explohub (section 3.15). Remaining: live verification (explohub login, real tiles, a live site). Original proposal below for reference.

Web dashboard on the explohub `hub_export` views (read-only), for management and geologists.
- Meters drilled per day, week and month versus the weekly plan (`exp_weekly_plan`), per site, rig and prospect; hole counts by status.
- Rig time from Distribution Hour: utilisation, activity split, standby and breakdown, plus fuel, polymer and hyd oil per metre.
- Core recovery and layer thickness summaries; sample pipeline (pending, sent, analyzed) and assay arrival.
- Map of collars by class. Needs: the hub pull list for `dist_hour` extended, decision on direct-site versus hub reads, and login approach.

### Phase 3A: Geological Model Module
- **Auto Domain:** assign samples and intervals to geological domains automatically (layer codes, grade and thickness rules) with review and manual override.
- **Compositing & EDA:** composite assays to a chosen length per domain; statistics, histograms, probability plots, boxplots, contacts, outlier and QAQC review (CRM, duplicate, blank).
- **Geological Model:** surfaces and solids per layer from collars, survey and logs; validation against drillholes.
- **3D & Section:** 3D view of holes, assays and model; sections and plan slices; export.
- Inputs already captured in Phase 1: collar with dip and azimuth, downhole survey, layer per interval, assay with QAQC fields, sample register.

### Phase 3B: Resource Estimation Module
Block model and grade estimation (for example variography, kriging or inverse distance) per domain, with classification and tonnage and grade reports. Depends on 3A domains and composites.

### Phase 4: Comprehensive report
A single report combining drilling progress, QAQC, geological model and resource results (PDF and Excel), reusing the Drillhole Plan Map layout and the daily report data.

---

## 16. Troubleshooting
| Symptom | Likely cause and fix |
|---|---|
| App shows an old version after an update | Old service-worker cache: hard-reload twice or clear site data |
| Login disabled | No internet: use guest mode and log in later |
| Row shows **error** | Server rejected it (rule or permission); hover the badge for the reason |
| "Koordinat terlalu dekat" | Another hole is closer than the limit; check for a duplicate or lower the limit |
| Tab missing for a user | The user is limited to some forms (Pengaturan > User) |
| `0013` stops: "Progress rows still hold consumables" | Run `move_progress_consumables.sql`, then `0013` again |
| Import refuses a row | It already exists, or a rule failed; read the reason in the preview |
| Map empty | Open Peta once online; check the IUP boundary and layers |
| "Tidak bisa dihapus: masih dipakai" | Untick **Aktif** instead of deleting |
| Dashboard: "permission denied for table exp_..." | The role was refused (not a row filter). Session lost (sign out and in), or no SELECT grant for `authenticated` on that table at the site: `select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name like 'exp\_%' and grantee in ('anon','authenticated') order by 2,1;` then `grant select on public.exp_collar to authenticated;` (RLS still decides which rows) |

---

## 17. Credits and licences
Icons by Lucide (ISC) and fonts Geist and Geist Mono (SIL OFL), licenses in `licenses/`. Dexie, supabase-js, Leaflet, jsPDF, shp and SheetJS under their own licences. Map data: © Esri and providers; © OpenStreetMap contributors, SRTM, OpenTopoMap (CC-BY-SA).

---

## 18. Version history
| Version | Highlights |
|---|---|
| 0.1 to 0.3 | Base PWA, schema, rules as data, hub export |
| 0.4 | Super admin, spreadsheet-style Pengaturan, users via Edge Function |
| 0.5 | Offline and guest workflow, Excel backup, drag reorder |
| 0.6 | Duplicate-coordinate guard, core photo |
| 0.7 | Rencana / Capaian / core result, Distribution Hour, Peta with IUP |
| 0.8 | Sample register, survey and assay, Excel import and in-app template, map layers and PDF plan map, OpenTopoMap, daily report, per-form permission, searchable collapsible record lists and combined Data Records, consumables on Distribution Hour, schema cleanup, migration README and `ALL_new_site.sql` |
| 0.9 | One-page **Dashboard** tab (artifact layout) inside the app (live from the site database, Chart.js), `hub_04_consumables.sql`, `hub_05_dash_access.sql`, headless tests |
| 1.0 | **RoA Lab** (lab PDF import), **Data QC** tab (QC & Survey, QAQC with CRM Z-score and duplicate ARD, thresholds), lab-analysis Excel export, migration `0014` |
| 1.1 | UI rebuilt on a design system (shadcn Nova neutral tokens as plain CSS): light and dark theme, sidebar plus bottom tab bar, dialogs instead of confirm(), Lucide icons, Geist font, token-driven charts, style guide page |
| 1.1.1 | Dashboard section **QAQC Geokimia**: sample flow (sent vs RoA vs Excel QAQC), failed Blank / CRM / Duplikat cards, Blank Ni scatter, duplicate original-vs-duplicate scatter; dashboard loads `exp_assay`, `exp_crm` and `qaqc_thresholds` |
| 1.2 | **Phase 2 complete:** Dashboard collar map by class (Leaflet, Esri satellite and topo), Excel and PDF export of the dashboard, **All sites** tab on explohub (`js/dash/hub.js`, explohub login, Site selector, site status table), `HUB` config |
