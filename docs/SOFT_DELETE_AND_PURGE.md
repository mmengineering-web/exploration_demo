# Soft delete and purge: how deleted data works, and how to free server space

Applies to: Exploration PWA v0.8 and later, one Supabase project per site (WKM, BM, TMS, CDSM, IBN, TPB, AJB, CDS) and the combined **explohub**.
Audience: site admins and the data engineer. Run all SQL in the **SQL Editor of the site's own Supabase project**, as the project owner.

---

## 1. Summary

- Pressing **Hapus** in the app does not remove the row on the server. It sets `is_deleted = true` (a *soft delete*). The row stays in the table but disappears from the app, Riwayat, the map, dashboards and every data-quality view.
- Soft-deleted rows are tiny text rows. They are almost never the reason a Supabase project fills up. The usual causes are **photos** in the `exp-photos` bucket and, to a smaller degree, **map layers** and **assay** volume.
- The app has **no permanent delete** for field data. Permanent removal is a deliberate admin action done in the SQL Editor (section 6).
- Never purge a row that a phone might still send back. Wait until every phone has synced the deletion (default rule: **90 days**).

---

## 2. Why the app uses soft delete

| Reason | Explanation |
|---|---|
| Offline sync | Each phone keeps its own copy. If the server row were physically deleted, a phone that was offline would still hold the record, push it again as "new", and the deleted data would come back. A soft delete is a *message* every phone can pull: "this record is deleted". |
| Conflict rule | The app uses last-write-wins by `updated_at`. A delete is just an update, so it follows the same rule and is never silently lost. |
| Mistakes | A wrong tap on Hapus can be undone by an admin (set `is_deleted = false`). |
| Audit trail | You can still answer "who drilled this hole, and when was it removed". |
| explohub history | The hub reads the same flag, so the combined view stays consistent with each site. |
| Permissions | Field users and geologists can never destroy data. Only the project owner can, in SQL. |

---

## 3. What happens, step by step

1. A user deletes a record in the app. The phone sets `is_deleted = true`, updates `updated_at`, and queues the change in the outbox.
2. On the next sync the server row is updated (not removed). RLS allows this for users who can write; there is no DELETE policy for the app.
3. Other phones pull the change and hide the record.
4. explohub (every 3 minutes) copies the site tables, including `is_deleted`, so its views hide the record too.
5. The row stays on the server until an admin purges it (section 6).

Important consequences:

- **Reusing IDs works.** The unique rules (Hole ID, sample number, survey depth, assay interval) only apply to rows where `is_deleted = false`. After a delete you may create a new collar with the same Hole ID.
- **Overlap checks ignore deleted rows**, so a deleted sample or assay interval no longer blocks a new one.
- **The app's lists, report and exports exclude deleted rows.**
- **Master data (rigs, prospects, code lists) is not soft-deleted.** It is deactivated (`is_active = false`). Only a super admin can delete it, and only if nothing uses it (the "in use" guard).
- **Map layers are not stored on the server at all.** They live only on the device that uploaded them (Peta > Tambah / kelola layer peta).

---

## 4. What really uses space

Check before you purge. Soft-deleted text rows are usually a small part.

```sql
-- biggest tables (data + indexes)
select relname as tabel, pg_size_pretty(pg_total_relation_size(c.oid)) as ukuran
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc limit 10;

-- how much of each table is soft-deleted
select 'exp_collar' t, count(*) filter (where is_deleted) deleted, count(*) total from public.exp_collar
union all select 'exp_drill_progress', count(*) filter (where is_deleted), count(*) from public.exp_drill_progress
union all select 'exp_dist_hour',      count(*) filter (where is_deleted), count(*) from public.exp_dist_hour
union all select 'exp_survey',         count(*) filter (where is_deleted), count(*) from public.exp_survey
union all select 'exp_sample',         count(*) filter (where is_deleted), count(*) from public.exp_sample
union all select 'exp_assay',          count(*) filter (where is_deleted), count(*) from public.exp_assay;

-- file storage (photos), per bucket
select bucket_id, count(*) files, pg_size_pretty(sum((metadata->>'size')::bigint)) as ukuran
from storage.objects group by bucket_id;
```

Typical order of impact: **photos** (hundreds of KB each) far above **assay rows** above **layers** above **other rows**.

---

## 5. Before you purge: checklist

1. **Sync every phone** that has pending data (header shows "0 pending"). Ask site users to open the app online once.
2. **Choose the retention.** Default **90 days** since `updated_at`. Use a longer period if any phone can be offline for months.
3. **Export what you may need later.** In the SQL Editor run a `select ... where is_deleted` and use *Download CSV* on the result, or keep a copy through Supabase backups (availability depends on your plan; check Dashboard > Database > Backups).
4. **Dry-run the counts** (section 6, step A) and read them.
5. **Choose a quiet hour** (no one syncing).
6. **Know the explohub floor guard** (section 8) if you are about to remove more than half of a table.

---

## 6. Purge procedure (per site)

### Step A. Dry run: how many rows would go

```sql
select 'exp_collar' t, count(*) from public.exp_collar          where is_deleted and updated_at < now() - interval '90 days'
union all select 'exp_drill_progress', count(*) from public.exp_drill_progress where is_deleted and updated_at < now() - interval '90 days'
union all select 'exp_dist_hour',      count(*) from public.exp_dist_hour      where is_deleted and updated_at < now() - interval '90 days'
union all select 'exp_survey',         count(*) from public.exp_survey         where is_deleted and updated_at < now() - interval '90 days'
union all select 'exp_sample',         count(*) from public.exp_sample         where is_deleted and updated_at < now() - interval '90 days'
union all select 'exp_assay',          count(*) from public.exp_assay          where is_deleted and updated_at < now() - interval '90 days';
```

### Step B. List the photo files that become orphans (do this BEFORE step C)

A hole that was deleted and created again with the same Hole ID uses the **same photo path** (`collar/<HOLE_ID>.jpg`). The query below skips paths still used by a live record, so you never delete a photo that is in use.

```sql
select src, photo_path from (
  select 'collar' as src, photo_path from public.exp_collar
   where is_deleted and photo_path is not null and updated_at < now() - interval '90 days'
     and photo_path not in (select photo_path from public.exp_collar where not is_deleted and photo_path is not null)
  union all
  select 'progress', photo_path from public.exp_drill_progress
   where is_deleted and photo_path is not null and updated_at < now() - interval '90 days'
     and photo_path not in (select photo_path from public.exp_drill_progress where not is_deleted and photo_path is not null)
) x order by 1, 2;
```

Save the result (Download CSV). You need it in step E, because after step C the rows that hold these paths are gone.

### Step C. Delete the rows

```sql
begin;
delete from public.exp_assay          where is_deleted and updated_at < now() - interval '90 days';
delete from public.exp_sample         where is_deleted and updated_at < now() - interval '90 days';
delete from public.exp_survey         where is_deleted and updated_at < now() - interval '90 days';
delete from public.exp_dist_hour      where is_deleted and updated_at < now() - interval '90 days';
delete from public.exp_drill_progress where is_deleted and updated_at < now() - interval '90 days';
delete from public.exp_collar         where is_deleted and updated_at < now() - interval '90 days';
commit;   -- use "rollback;" instead to cancel
```

This is **permanent**. No foreign keys tie these tables together (progress and assay refer to the Hole ID as plain text), so the order is only a convention: children first, collars last.

### Step D. Let Postgres reuse the space

Deleted rows free space inside the table; Postgres reuses it for new data automatically (autovacuum). Two honest limits:

- A normal `VACUUM` makes space reusable but **does not shrink** the files, so the dashboard's disk figure may not drop.
- `VACUUM FULL` shrinks the files but locks the table while it runs. These tables are small, so it takes seconds; run it off-hours, one table at a time, one statement per run:

```sql
vacuum (full, analyze) public.exp_assay;
```

If the editor refuses (it may wrap statements in a transaction), skip it. It only matters when you are close to the plan's disk limit.

### Step E. Delete the orphaned photos (Storage)

Use the CSV from step B.

- **Dashboard > Storage > `exp-photos`:** open the folder, select the files, delete.
- Or use the Storage API / a script with the service key (never put that key in the app or the repository).
- **Do not use `delete from storage.objects`.** It removes the database record but the file itself can remain in object storage and still count toward your usage.

### Step F. Refresh explohub (if the site feeds it)

See section 8.

### Step G. Verify

```sql
select count(*) filter (where is_deleted) as masih_ada_deleted, count(*) as total from public.exp_collar;
```

Open the app online, sync, and check Riwayat and the Peta tab. Nothing live should have changed.

---

## 7. Recommended routine

| When | What |
|---|---|
| Every quarter | Run section 4 (size check) and step A. Purge if soft-deleted rows or photos are a meaningful share. |
| After a big import mistake | You may purge sooner for that batch: delete by `source_file` (assay) or by the exact ids, and make sure no phone holds the same rows in its outbox. |
| When disk > 70% of plan | Look at photos first (section 4), then lower `photo_max_px` (Pengaturan > Parameter, e.g. 1024) so new photos are smaller. |
| Always | Keep one export of anything you purge, for the retention period your company requires. |

Purge only what you intend. Prefer `where id in (...)` for one-off cleanups over broad conditions.

---

## 8. explohub

explohub copies each site as a **full replace** every 3 minutes (only when the site reports a change). Therefore:

- Purging rows at the site also removes them from explohub at the next refresh. You do not purge explohub separately.
- explohub has a **floor guard** on `collar`, `drill_progress`, `sample` and `assay`. If the site table suddenly has **less than 50% of the rows the hub holds** (and the hub holds 20 or more), the refresh refuses with `floor guard: ... rows at site ... are < 50% of hub cache`. This protects the hub from a broken or wiped site.
- If your purge was genuinely large and you expect this, force the refresh once, in the **explohub** SQL Editor:

```sql
select hub_private.refresh_site_v8('WKM', true);   -- replace WKM with the site code
```

Then check `select * from hub.site_status;`. Do not force it for a site if you did not purge: a collapsed source must be investigated, not forced.

---

## 9. Undoing a soft delete (before it is purged)

If a record was deleted by mistake and is still on the server:

```sql
update public.exp_collar set is_deleted = false, updated_at = now() where hole_id = 'WKM-DD-0001' and is_deleted;
```

`updated_at = now()` is required, otherwise phones that already pulled the deletion will not take the restore (last-write-wins). If a live record now has the same Hole ID, the unique rule will refuse the restore: fix or delete the new one first.

---

## 10. Troubleshooting

| Symptom | Cause and action |
|---|---|
| Deleted record came back after a purge | A phone was offline and pushed its old copy. Delete it again in the app (online), and extend your retention period. |
| `floor guard` error on explohub after a purge | Expected when more than half of a table was purged. Force once (section 8). |
| Disk figure did not drop | Normal. Plain vacuum does not shrink files. Consider `VACUUM FULL` on the large table, or check that photos, not rows, are the real cause. |
| A photo is missing for a live hole after cleanup | The photo path was shared with a deleted hole and removed. Re-take the photo in the app (Collar > edit > Foto). Use step B exactly as written to avoid this. |
| Restore with `is_deleted = false` fails with a duplicate error | A live row already has that Hole ID, sample number or interval. Resolve the live row first. |
| SQL Editor says permission denied | You are not the project owner / using the wrong project. The SQL Editor of the *site's own* project is required. |

---

## 11. What not to do

- Do not run `truncate` or `delete` without `where is_deleted`. That wipes real data.
- Do not delete in explohub tables by hand (`hub_private.*`). They are rebuilt from the sites.
- Do not remove storage files with SQL (section 6, step E).
- Do not put the service-role key in the app, the repository or a shared chat.
- Do not purge a site whose phones have unsynced data.
