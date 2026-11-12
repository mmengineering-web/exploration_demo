# Setup Guide: Exploration Data Entry PWA (for beginners)

Goal: get the app running for ONE pilot site, test it on your computer, put it online, and install it on a phone.
Time needed: about 2 to 3 hours the first time. Do the parts in order. Do not skip Part 9 (security check).

Screens and button names in Supabase and GitHub change from time to time. If a button is not where I say, look for the closest name. If you get stuck, copy the exact error message and send it to me.

---

## Part 0. What you are building (5-minute read)

| Piece | What it is | Why you need it |
|---|---|---|
| **The app** | The folder `exploration-pwa` (HTML, CSS, JS files) | What geologists open on their phones |
| **Supabase** | A free online database + login system | Stores the data. One Supabase project per site |
| **GitHub Pages** | Free hosting for the app files | Gives the app a web address (https://...) |
| **Anon key** | A "public" key that lets the app talk to Supabase | Safe to put in the app. Your data is protected by login + RLS rules, not by hiding this key |
| **Service-role key** | A "master" key in Supabase | NEVER put it in the app, GitHub, chat or screenshots |

Flow: phone app → Supabase (site database). Everything else (hub, Looker) comes later.

Words you will see:
- **SQL Editor**: a page in Supabase where you paste database commands and click Run.
- **RLS (Row Level Security)**: rules that decide who can read/write each table.
- **Repository (repo)**: a folder of project files stored on GitHub.

---

## Part 1. Accounts and tools

1. **GitHub account**: https://github.com (free).
2. **Supabase account**: https://supabase.com (free tier is fine for the pilot). Sign in with your GitHub account for simplicity.
3. **A code editor**: install **Visual Studio Code** (https://code.visualstudio.com). Free.
4. **A password manager** (or a safe notes file) to store: Supabase database password, admin login.
5. **Google Chrome** on your computer (best for testing).
6. **Python 3** (only to run a tiny local web server). Check: open Terminal (Mac/Linux) or Command Prompt (Windows) and type `python --version` (Windows) or `python3 --version`. If it fails, install from https://python.org. (Alternative with no Python: install the VS Code extension "Live Server", then right-click `index.html` > Open with Live Server.)

Unzip `exploration-pwa-v0.2.zip` to a folder you can find, for example `Documents/exploration-pwa`. Open that folder in VS Code (File > Open Folder). You should see: `index.html`, `sw.js`, `manifest.webmanifest`, and folders `js`, `css`, `icons`, `supabase`.

---

## Part 2. Create the pilot site's Supabase project

Pick ONE site to start (for example WKM).

1. Supabase dashboard > **New project**.
2. **Name**: `exploration-wkm` (pattern: `exploration-<site>`).
3. **Database password**: click Generate, then **copy it into your password manager now**. You cannot see it again.
4. **Region**: choose Southeast Asia (Singapore).
5. Click **Create new project**. Wait 1 to 2 minutes until it finishes.

---

## Part 3. Create the tables (one SQL file)

1. In the left menu click **SQL Editor** > **New query**.
2. In VS Code open `supabase/migrations/ALL_new_site.sql`. Select all (Ctrl+A), copy (Ctrl+C).
3. Paste into the Supabase query box, click **Run**. Expected: "Success. No rows returned".
   - This file is migrations 0001 to 0013 joined in the right order. The order and what each file does are listed in `supabase/migrations/README.md`.
   - If you prefer, run the numbered files one by one in that order instead. Every file is safe to run twice.
4. Check: left menu > **Table Editor**. You should see `exp_collar`, `exp_drill_progress`, `exp_rig`, `exp_prospect`, `exp_profile`, `exp_role_def`, `exp_code_list`, `exp_setting`.
5. Click `exp_code_list`: you should see rows for hole types, statuses, shifts and downtime reasons.

If Run shows a red error: do not run it again. Copy the full error text and send it to me.

---

## Part 4. Create the first admin login

The app logs in with an email and password stored in Supabase **Authentication**.

1. Left menu > **Authentication** > **Users** > **Add user** > **Create new user**.
2. Enter your email and a strong password. Tick **Auto Confirm User** if shown. Click Create.
3. In the users list, find your user and **copy the User UID** (a long code like `3f2a...`).
4. Go to **SQL Editor** > New query. Paste this, replacing the three values, then Run:

```sql
insert into public.exp_profile (user_id, full_name, role, email)
values ('PASTE-THE-USER-UID-HERE', 'Your Name', 'site_admin', 'your-email@example.com');
```

5. Check Table Editor > `exp_profile`: one row with role `site_admin`.
6. Make this first account a **super admin** (see `docs/SUPER_ADMIN_GUIDE.md`, Part 2): after running 0004, run `update public.exp_profile set role = 'super_admin' where lower(email) = lower('your-email@example.com');`

**Important, same page area:** Authentication > Sign In / Providers (or Settings) > turn OFF "Allow new users to sign up". This stops strangers from creating accounts on your database.

---

## Part 5. Get the project URL and anon key

1. Left menu > **Project Settings** (gear icon) > **API** (or "API Keys").
2. Copy the **Project URL** (looks like `https://abcdxyz.supabase.co`).
3. Copy the key labelled **anon** / **public** / **publishable**.
4. **Do not** copy the key labelled `service_role` or `secret`. If you ever paste that one into the app by mistake, tell me immediately and we rotate it.

---

## Part 6. Put the URL and key into the app

1. In VS Code open `js/config.js`.
2. Find the line for your site and fill both values:

```js
WKM:  { name: 'WKM',  url: 'https://abcdxyz.supabase.co', anonKey: 'eyJhbGciOi...your anon key...' },
```

3. Save (Ctrl+S). Leave the other sites empty for now.

---

## Part 7. Test on your computer

1. Open Terminal/Command Prompt **inside the project folder**. In VS Code: Terminal > New Terminal (it opens in the right folder).
2. Run:
   - Windows: `python -m http.server 8080`
   - Mac/Linux: `python3 -m http.server 8080`
3. Open Chrome and go to `http://localhost:8080`.
4. Log in: choose site WKM, your admin email and password. You should see tabs: F1 Progress, F2 Collar, Riwayat, **Pengaturan**.

### 7a. Set up reference data in the Pengaturan tab
1. Pengaturan > **Rig**: add `RIG-01`, name `Rig 01`, click Tambah.
2. Pengaturan > **Prospect**: add a code and name.
3. Look at **Daftar kode** and **Parameter** (defaults are fine for now).

### 7b. Test forms
1. F2 Collar: tap "Buat Hole ID baru", choose a type, enter planned depth `100`, Save.
2. F1 Progress: pick the rig, type the hole ID, from `0` to `5`, Save.
3. Try a mistake on purpose (from `5` to `3`). You should see a red error.
4. Check Supabase > Table Editor > `exp_collar` and `exp_drill_progress`: your rows should appear after a few seconds.

### 7c. Test offline (the most important feature)
1. In Chrome press F12 > **Network** tab > change "No throttling" to **Offline**.
2. Enter another F1 record and Save. The chip at the top should say "○ offline · 1 pending".
3. Set Network back to **No throttling**. Within a few seconds the chip should show "0 pending" and the row appears in Supabase.

If this works, the core of the system works.

---

## Part 8. Publish the app online (GitHub Pages)

Phones need an `https://` address. GitHub Pages gives you one for free.

1. GitHub > top right **+** > **New repository**. Name: `exploration-entry`. Choose **Public** (free GitHub Pages needs public unless you have a paid plan). Click Create.
   - Public is acceptable here because the repo contains no secrets: the anon key is public by design, and your data is protected by login and RLS. Do not commit passwords or the service-role key, ever.
2. On the new repo page click **uploading an existing file**. Open your project folder and drag **everything inside it** (not the folder itself): `index.html`, `sw.js`, `manifest.webmanifest`, and the folders `js`, `css`, `icons`, `supabase`. Click **Commit changes**.
   - Check on GitHub that `index.html` is at the top level of the repo, not inside another folder.
3. Repo > **Settings** > **Pages**. Under "Build and deployment" choose **Deploy from a branch**, branch `main`, folder `/ (root)`, Save.
4. Wait 1 to 3 minutes. The page shows your address: `https://<your-username>.github.io/exploration-entry/`.
5. Open that address in Chrome. Log in again. It should behave like on localhost.

When you change a file later (for example `config.js`), re-upload it to GitHub (open the file on GitHub > pencil icon > paste > Commit). Phones get the update the next time they open the app online (you may need to close and reopen once).

---

## Part 9. Security check before any real data

Do all of these. They take 10 minutes.

1. **Sign-ups disabled** (Part 4). Confirm the toggle is OFF.
2. **Anonymous access is blocked.** In Terminal run (replace URL and key with yours):

```
curl "https://abcdxyz.supabase.co/rest/v1/exp_collar?select=*" -H "apikey: YOUR_ANON_KEY"
```

   Expected result: `[]` (empty list) or a permission error. If you see real rows, STOP and message me.
3. **Service-role key** appears nowhere in your files. In VS Code: Edit > Find in Files, search `service_role`. No results expected.
4. **Role test** (after Part 10): log in as a Viewer and confirm there are no input tabs.
5. Store the database password and admin login only in your password manager.

---

## Part 10. Add real users

**Easiest (super admin):** in the app go to Pengaturan > User > "Tambah user baru", fill email, name, role and a password, click Buat akun. This needs the Edge Function from `docs/SUPER_ADMIN_GUIDE.md` (Part 3). The steps below are the manual way and still work.

1. Supabase > Authentication > Users > Add user (email + password, auto confirm). Do this for each geologist.
2. In the app, log in as admin > Pengaturan > **User**: type the same email, full name, choose role `geologist`, click Tambah.
3. Give each person their email and password privately (not in a group chat if you can avoid it). Ask them to keep it private.
4. To stop someone: Pengaturan > User > untick "Aktif" > Simpan.

---

## Part 11. Install on phones

Do this once per phone, with internet.

**Android (Chrome):** open the GitHub Pages address > menu (three dots) > **Install app** / **Add to Home screen**.
**iPhone (Safari only):** open the address in Safari > Share button > **Add to Home Screen**.

Then:
1. Open the app from the home screen icon, log in (needs internet this first time).
2. Allow Location and Camera when asked.
3. Wait until the chip says "0 pending, sync HH:MM" (this means reference data is cached).
4. Turn on airplane mode, enter a record, turn airplane mode off, confirm it uploads.

iPhone notes: uploads happen when the app is open (iOS has no background sync). If a phone is not used for about 7 days, Safari can erase stored data, so tell people to open the app and let it sync at least weekly.

---

### Upload the IUP boundary (admin)
1. Export the IUP polygon from ArcGIS/QGIS as **GeoJSON** with CRS **EPSG:4326** (lat/lon).
2. In the app: Pengaturan > **Batas IUP**, type a name, choose the file, **Unggah**. It then shows on the Peta tab for everyone.

### Working without internet at site
1. Open the app. If there is no signal, tap **Input tanpa login (offline)** and pick the site.
2. Enter F1 / F2 data as normal. It is stored on the phone. In a never-logged-in phone the rig is typed by hand and the default codes are used.
3. When internet is back, tap **Login sekarang**, log in. Unsent data is uploaded automatically. Rejected rows are marked in the outbox.
4. Safety net: Riwayat > Backup ke Excel downloads an .xlsx of unsent data.

## Part 12. Pilot checklist (1 to 2 weeks)

- [ ] 2 or 3 geologists use it daily
- [ ] Compare app data with their Excel for 5 days; numbers match
- [ ] Offline test done in the real field (no signal)
- [ ] GPS accuracy limit (10 m) is realistic; adjust in Pengaturan > Parameter if not
- [ ] Rig list, prospects, downtime reasons agreed with the site geology data owner
- [ ] Write down every complaint and confusing screen; send them to me

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Blank page on localhost | Server not running or wrong address | Re-run the server command; use exactly `http://localhost:8080` |
| "Site WKM belum dikonfigurasi" | `url` or `anonKey` empty in `config.js` | Part 6; save; hard refresh (Ctrl+Shift+R) |
| "Invalid login credentials" | Wrong password, or user not confirmed | Reset in Supabase Auth > Users; tick Auto Confirm |
| "Akun belum terdaftar/aktif" | User exists in Auth but not in `exp_profile` | Part 4 step 4 (first admin) or Pengaturan > User |
| Cannot edit in Pengaturan (view only) | Role does not have the admin flag | Check `exp_role_def` / Pengaturan > Role |
| Save works but nothing in Supabase | Still offline, or error on the record | Chip shows pending; Riwayat tab shows an "error" badge, hover it to read the reason |
| "Unknown hole_type / status / shift" | Code not in the list, or deactivated | Pengaturan > Daftar kode |
| GPS button does nothing | Page is not https, or location permission denied | Use GitHub Pages address; allow location in browser/phone settings |
| Change not visible after update | Old version cached | Close the app fully and reopen online; or in Chrome F12 > Application > Service Workers > Unregister |
| SQL error on Run | Order or typo | Send me the full error text |

---

## What is NOT in this version (so it is not a surprise)
- F3 sample registry, F4 lab dispatch, F5 assay import, collar map page
- Creating login accounts from inside the app (done in Supabase Auth)
- Offline map tiles
- The hub, Looker dashboard and one-time Excel history import
