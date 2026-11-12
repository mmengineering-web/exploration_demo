// IndexedDB (Dexie). Satu database per site supaya data site tidak tercampur.
import Dexie from 'https://cdn.jsdelivr.net/npm/dexie@4/+esm';

export let db = null;

export function openDb(site) {
  if (db) { try { db.close(); } catch {} }
  db = new Dexie(`exploration_${site}`);
  db.version(1).stores({
    collars: 'id, hole_id, status, updated_at',
    progress: 'id, hole_id, work_date, updated_at',
    rigs: 'rig_id',
    prospects: 'prospect_code',
    photos: 'id',
    outbox: '++seq, &key, tbl',
  });
  db.version(2).stores({            // v2: cache config dari server
    collars: 'id, hole_id, status, updated_at',
    progress: 'id, hole_id, work_date, updated_at',
    rigs: 'rig_id',
    prospects: 'prospect_code',
    photos: 'id',
    outbox: '++seq, &key, tbl',
    settings: 'key',
    codes: '[list_code+code]',
  });
  db.version(3).stores({            // v3: jam rig + batas IUP
    collars: 'id, hole_id, status, updated_at',
    progress: 'id, hole_id, work_date, updated_at',
    disthours: 'id, rig_id, work_date, updated_at',
    rigs: 'rig_id',
    prospects: 'prospect_code',
    photos: 'id',
    outbox: '++seq, &key, tbl',
    settings: 'key',
    codes: '[list_code+code]',
    iup: 'id',
  });
  db.version(4).stores({            // v4: survey, sample, assay (loaded by Excel import)
    collars: 'id, hole_id, status, updated_at',
    progress: 'id, hole_id, work_date, updated_at',
    disthours: 'id, rig_id, work_date, updated_at',
    surveys: 'id, hole_id, updated_at',
    samples: 'id, hole_id, sample_no, updated_at',
    assays: 'id, hole_id, updated_at',
    rigs: 'rig_id',
    prospects: 'prospect_code',
    photos: 'id',
    outbox: '++seq, &key, tbl',
    settings: 'key',
    codes: '[list_code+code]',
    iup: 'id',
  });
  db.version(5).stores({            // v5: map layers (shapefile / GeoJSON), replaces the IUP-only table in the UI
    collars: 'id, hole_id, status, updated_at',
    progress: 'id, hole_id, work_date, updated_at',
    disthours: 'id, rig_id, work_date, updated_at',
    surveys: 'id, hole_id, updated_at',
    samples: 'id, hole_id, sample_no, updated_at',
    assays: 'id, hole_id, updated_at',
    rigs: 'rig_id',
    prospects: 'prospect_code',
    photos: 'id',
    outbox: '++seq, &key, tbl',
    settings: 'key',
    codes: '[list_code+code]',
    iup: 'id',
    maplayers: 'id',
  });
  return db;
}

export const nowIso = () => new Date().toISOString();

// Simpan record + masukkan ke outbox dalam satu transaksi (atomik).
export async function saveRecord(tbl, rec) {
  rec.updated_at = nowIso();
  await db.transaction('rw', db[tbl], db.outbox, async () => {
    await db[tbl].put(rec);
    await db.outbox.where('key').equals(`${tbl}:${rec.id}`).delete();
    await db.outbox.add({ key: `${tbl}:${rec.id}`, tbl, rec_id: rec.id });
  });
  return rec;
}

// Many records at once (Excel import): one transaction, one outbox entry per record.
export async function saveMany(tbl, recs) {
  const ts = nowIso();
  recs.forEach(r => { r.updated_at = ts; });
  await db.transaction('rw', db[tbl], db.outbox, async () => {
    await db.outbox.where('key').anyOf(recs.map(r => `${tbl}:${r.id}`)).delete();
    await db[tbl].bulkPut(recs);
    await db.outbox.bulkAdd(recs.map(r => ({ key: `${tbl}:${r.id}`, tbl, rec_id: r.id })));
  });
  return recs.length;
}

// After an explicit logout: remove cached SERVER data (collars/progress/photos) from the phone, but keep everything
// that is still waiting to be sent (outbox) and the low-sensitivity reference data (rigs, prospects, codes, settings).
// This is what lets the app open in "no login" mode without exposing the site's data to whoever holds the phone.
export async function purgeServerData() {
  const ob = await db.outbox.toArray();
  const keep = new Set(ob.map(o => o.key));
  const photoKeep = new Set(ob.map(o => o.rec_id));
  for (const tbl of ['collars', 'progress', 'disthours', 'surveys', 'samples', 'assays']) {
    const ids = (await db[tbl].toCollection().primaryKeys()).filter(id => !keep.has(`${tbl}:${id}`));
    await db[tbl].bulkDelete(ids);
  }
  // map layers are NOT touched: they are uploaded on this device only (never stored on the server)
  const pids = (await db.photos.toCollection().primaryKeys()).filter(id => !photoKeep.has(id));
  await db.photos.bulkDelete(pids);
}
