# Super Admin Guide (v0.4)

What changed: a new role **super_admin**, a **Pengaturan** tab with descriptions, permanent delete, and creating/deleting users from the app.
Do the parts in order, once per site (start with the pilot site). About 30 minutes.

## Who can do what

| Action | Viewer | Geologist | Site admin | Super admin |
|---|:-:|:-:|:-:|:-:|
| Read Pengaturan (descriptions, codes, rigs, prospects, roles) | yes | yes | yes | yes |
| Enter collar and progress | no | yes | yes | yes |
| Edit descriptions, labels, order, active flags; add rows | no | no | yes | yes |
| Link an existing login to a role; deactivate a user | no | no | yes (not super admin accounts) | yes |
| Permanently delete rig / prospect / code / role | no | no | no | yes |
| Create a new login account, delete an account, reset a password | no | no | no | yes |
| Create or change super roles | no | no | no | yes |

Safety rules the database enforces (even if the app is bypassed):
- A rig, prospect, code or role that is still used by data cannot be deleted. Deactivate it (untick Aktif) instead. The error says how many records use it.
- The last active super admin (and the last active admin) can never be deleted, deactivated or demoted.
- A site admin cannot make themselves, or anyone else, a super admin.
- Collar and progress records stay soft-delete (Hapus in the form). They are not permanently erased, so phones and the hub stay consistent.
- The browser never holds a master key. "As postgres" power stays in the Supabase SQL Editor and in the Edge Function; the app only gets the controlled actions above.

## Part 1. Run migration 0004

1. Supabase (the site project) > SQL Editor > New query.
2. Paste all of `supabase/migrations/0004_super_admin_and_descriptions.sql`, Run. Expected: success. Safe to run twice.
3. Table Editor > `exp_role_def`: you should see a row `super_admin`. `exp_code_list` rows now have a `description`.

## Part 2. Make yourself super admin

In SQL Editor, replace the email with the one you log in to the app with, then Run:

```sql
update public.exp_profile set role = 'super_admin' where lower(email) = lower('your-email@example.com');
select user_id, full_name, email, role from public.exp_profile;   -- check: your row shows super_admin
```

If your row has an empty `email` column, use your name instead: `where full_name = 'Your Name'`.
Then in the app tap the sync button (or log out and in). The header shows "Super admin".

## Part 3. Deploy the Edge Function (needed to add/delete users from the app)

Why: creating or deleting login accounts needs the service-role key. That key must never be in the app, so a small server function does it, and it first checks that the caller is a super admin.

1. Supabase > left menu **Edge Functions** > **Deploy a new function** > **Via Editor**.
2. Function name: exactly `exp-admin-users`.
3. Delete the sample code. Paste all of `supabase/functions/exp-admin-users/index.ts`. Click **Deploy**.
4. Open the function's **Settings** and turn **OFF "Verify JWT"**. (The function verifies the caller itself, and new-style API keys are not JWTs, so the built-in check can reject valid calls.)
5. Nothing else to configure: Supabase gives the function its URL and keys automatically.
6. Test in the app: Pengaturan > User > "Tambah user baru". Use a test email, click "Buat password acak", Buat akun. The user appears in the table. Delete it again with the red Hapus button.

If you see "Edge Function exp-admin-users belum di-deploy", step 2 name is wrong or deploy did not finish.
Repeat Part 3 for every site project (each site has its own Supabase account).

## Part 4. Update the app files

Replace the app with `exploration-pwa-v0.4.zip` contents (or the changed files), then hard refresh (Ctrl+Shift+R). Always run the SQL (Parts 1-2) first, then update the app.
New in the app:
- Tab **Admin** is now **Pengaturan** for everyone; admins edit, others only view.
- **Deskripsi** column on every list, so people can see what each code means.
- **Order** in dropdowns = order of rows in the table. Drag the dotted handle at the left of a row up or down (or focus it and press Up/Down). It saves automatically. Save pending edits first.
- Dropdowns show Labels only (for example Role shows "Geologist", Prospect shows its name). Codes stay in the data.
- Light design with the Tahoma font.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Login works but Pengaturan Role/User errors "column can_super" | 0004 not run yet | Part 1 |
| Header still says Site admin | App has not refreshed your permissions | Tap sync or log out/in |
| Hapus says "masih dipakai N ..." | Data still uses that item | Untick Aktif instead |
| "Hanya super admin yang boleh ..." | Action reserved for super admin | Ask a super admin |
| Create user says password too short | Minimum 10 characters | Use "Buat password acak" |
| Create user says email already registered | Account exists in Supabase Auth | Link it: Pengaturan > User > add row with the same email |
