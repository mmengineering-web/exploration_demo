// Validasi di perangkat (sebelum masuk outbox). Semua batas dibaca dari cfg (diatur di Admin).
import { setting, metaOf, holeRegex } from './cfg.js';

const rad = x => x * Math.PI / 180;
export function distM(a1, o1, a2, o2) {
  const h = Math.sin(rad(a2 - a1) / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(rad(o2 - o1) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function validateProgress(r, { collar, siblings }) {
  const errors = [], warns = [];
  const shiftHours = setting('shift_hours');
  if (!r.work_date) errors.push('Tanggal wajib diisi.');
  else {
    const d = new Date(r.work_date + 'T00:00:00');
    const max = new Date(); max.setDate(max.getDate() + 1);
    if (d > max) errors.push('Tanggal tidak boleh di masa depan.');
  }
  if (!r.shift) errors.push('Shift wajib diisi.');
  if (!r.rig_id) errors.push('Rig wajib dipilih.');
  if (!r.hole_id) errors.push('Hole ID wajib diisi.');
  else if (!collar) warns.push(`Hole ${r.hole_id} belum ada di daftar collar. Buat collar-nya (tab Collar) sebelum/sesudah ini.`);

  const f = r.from_m, t = r.to_m;
  if (f == null || t == null) errors.push('Kedalaman dari–sampai wajib diisi.');
  else {
    if (f < 0) errors.push('Dari (m) tidak boleh negatif.');
    if (!(f < t)) errors.push('Dari harus lebih kecil dari Sampai.');
    if (collar) {
      if (collar.total_depth_m != null && t > collar.total_depth_m)
        errors.push(`Sampai (${t} m) melebihi total depth lubang (${collar.total_depth_m} m).`);
      else if (collar.planned_depth_m != null && t > collar.planned_depth_m)
        warns.push(`Sampai (${t} m) melebihi planned depth (${collar.planned_depth_m} m).`);
    }
    for (const s of siblings || []) {
      if (s.id === r.id || s.is_deleted) continue;
      if (f < s.to_m && t > s.from_m)
        errors.push(`Overlap dengan interval ${s.from_m}–${s.to_m} m (${s.work_date}, ${s.shift}).`);
    }
  }
  if (r.core_len_m != null) {
    if (r.core_len_m < 0) errors.push('Core length tidak boleh negatif.');
    else if (f != null && t != null && t > f && r.core_len_m > (t - f) + 0.005)
      warns.push(`Core length (${r.core_len_m} m) lebih besar dari meter yang dibor (${(t - f).toFixed(2)} m) — recovery > 100%. Cek ulang.`);
  }
  const dh = r.downtime_hours ?? 0;
  if (dh < 0 || dh > shiftHours) errors.push(`Downtime harus 0–${shiftHours} jam.`);
  if (dh > 0 && !r.downtime_reason) errors.push('Alasan downtime wajib diisi bila downtime > 0.');
  return { errors, warns };
}

export function validateCollar(r, { others }) {
  const errors = [], warns = [];
  const gpsMax = setting('gps_max_acc_m');
  const meta = metaOf('collar_status', r.status);
  if (!r.hole_id) errors.push('Hole ID wajib diisi.');
  else {
    if (!holeRegex().test(r.hole_id)) errors.push(`Hole ID tidak sesuai pola site (${setting('hole_id_regex')}).`);
    if ((others || []).some(o => o.id !== r.id && !o.is_deleted && o.hole_id === r.hole_id))
      errors.push(`Hole ID ${r.hole_id} sudah dipakai.`);
  }
  if (!r.hole_type) errors.push('Tipe lubang wajib dipilih.');
  if (!r.status) errors.push('Status wajib dipilih.');
  if (r.planned_depth_m != null && !(r.planned_depth_m > 0)) errors.push('Planned depth harus > 0.');
  if (r.dip_deg != null && (r.dip_deg < -90 || r.dip_deg > 90)) errors.push('Dip harus -90 sampai 90.');
  if (r.azimuth_deg != null && (r.azimuth_deg < 0 || r.azimuth_deg > 360)) errors.push('Azimuth harus 0 sampai 360.');
  if (r.total_depth_m != null && !(r.total_depth_m > 0)) errors.push('Total depth harus > 0.');
  const k = setting('depth_overrun_warn_factor');
  if (r.total_depth_m != null && r.planned_depth_m != null && r.total_depth_m > r.planned_depth_m * k)
    warns.push(`Total depth > ${Math.round(k * 100)}% planned depth — cek ulang.`);

  const chk = (lat, lon, label, req) => {
    if (lat == null && lon == null) { if (req) errors.push(`${label}: koordinat wajib.`); return; }
    if (lat == null || lon == null) { errors.push(`${label}: lat dan lon harus diisi keduanya.`); return; }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) errors.push(`${label}: koordinat di luar rentang.`);
    else if (lat < -11.5 || lat > 6.5 || lon < 94 || lon > 142)
      warns.push(`${label}: koordinat di luar wilayah Indonesia — cek tanda +/- dan urutan lat/lon.`);
  };
  chk(r.planned_lat, r.planned_lon, 'Planned', false);
  const asb = r.asbuilt_lat != null || r.asbuilt_lon != null;
  chk(r.asbuilt_lat, r.asbuilt_lon, 'As-built', !!meta.requires_asbuilt);
  if (asb) {
    if (r.gps_accuracy_m == null) warns.push('Akurasi GPS belum tercatat (isi manual atau ambil dari GPS).');
    else if (r.gps_accuracy_m > gpsMax)
      errors.push(`Akurasi GPS ${r.gps_accuracy_m} m melebihi batas ${gpsMax} m. Ambil ulang GPS di area terbuka.`);
  }
  // duplicate / too-close coordinates (planned and as-built, against every other live hole)
  const lim = Number(setting('collar_min_dist_m'));
  if (lim > 0) {
    const pts = [['Planned', r.planned_lat, r.planned_lon], ['As-built', r.asbuilt_lat, r.asbuilt_lon]];
    for (const o of others || []) {
      if (o.id === r.id || o.is_deleted) continue;
      for (const [la, a1, a2] of pts) {
        if (a1 == null || a2 == null) continue;
        for (const [lb, b1, b2] of [['planned', o.planned_lat, o.planned_lon], ['as-built', o.asbuilt_lat, o.asbuilt_lon]]) {
          if (b1 == null || b2 == null) continue;
          const d = distM(a1, a2, b1, b2);
          if (d < lim) errors.push(`${la}: koordinat terlalu dekat (${d.toFixed(1)} m) dengan ${lb} lubang ${o.hole_id}. Minimal ${lim} m. Cek apakah ini lubang yang sama atau salah ketik.`);
        }
      }
    }
  }
  if (meta.requires_total_depth && r.total_depth_m == null) errors.push(`Status ${r.status} butuh total depth.`);
  return { errors, warns };
}

const tmin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
export const hoursOf = r => { const a = tmin(r.from_time), b = tmin(r.to_time); return (a != null && b != null && b > a) ? (b - a) / 60 : 0; };

// Distribution hour: one rig cannot have two activities at the same time on the same date
export function validateDist(r, { siblings }) {
  const errors = [], warns = [];
  if (!r.work_date) errors.push('Tanggal wajib diisi.');
  else { const max = new Date(); max.setDate(max.getDate() + 1); if (new Date(r.work_date + 'T00:00:00') > max) errors.push('Tanggal tidak boleh di masa depan.'); }
  if (!r.rig_id) errors.push('Rig wajib dipilih.');
  if (!r.activity) errors.push('Aktivitas wajib dipilih.');
  for (const [f, l] of [['fuel_l', 'Fuel'], ['polymer_l', 'Polymer'], ['oil_hyd_l', 'Hyd oil']]) if (r[f] != null && r[f] < 0) errors.push(`${l}: tidak boleh negatif.`);
  const a = tmin(r.from_time), b = tmin(r.to_time);
  if (a == null || b == null) errors.push('Jam From dan To wajib diisi.');
  else if (!(b > a)) errors.push('Jam To harus lebih besar dari From (satu record tidak boleh melewati tengah malam; pecah jadi dua record).');
  else {
    for (const s of siblings || []) {
      if (s.id === r.id || s.is_deleted || s.rig_id !== r.rig_id || s.work_date !== r.work_date) continue;
      const c = tmin(s.from_time), d = tmin(s.to_time);
      if (a < d && b > c) errors.push(`Bentrok dengan ${s.from_time.slice(0, 5)}–${s.to_time.slice(0, 5)} (${s.activity}) di rig yang sama.`);
    }
  }
  return { errors, warns };
}

// Sample register: unique sample no; NORMAL samples of one hole must not overlap; dates in order
export function validateSample(r, { siblings, collar, deepest }) {
  const errors = [], warns = [];
  const from = r.from_m, to = r.to_m;
  if (!r.sample_no) errors.push('Nomor sampel wajib diisi.');
  if (!r.hole_id) errors.push('Hole ID wajib diisi.');
  else if (!holeRegex().test(r.hole_id)) errors.push('Format Hole ID tidak sesuai pola site.');
  if (from == null || to == null) errors.push('Dari dan Sampai wajib diisi.');
  else {
    if (from < 0) errors.push('Dari tidak boleh negatif.');
    if (to <= from) errors.push('Sampai harus lebih besar dari Dari.');
    if (collar?.total_depth_m != null && to > Number(collar.total_depth_m)) warns.push(`Sampai (${to} m) melebihi total depth lubang (${collar.total_depth_m} m).`);
    else if (deepest != null && to > deepest + 1e-9) warns.push(`Sampai (${to} m) lebih dalam dari progress pengeboran yang tercatat (${deepest} m).`);
  }
  if (!r.sample_type) errors.push('Tipe sampel wajib dipilih.');
  if (!r.status) errors.push('Status wajib dipilih.');
  if (r.sampled_date && r.sent_date && r.sent_date < r.sampled_date) errors.push('Tanggal kirim tidak boleh sebelum tanggal ambil.');
  if (r.hole_id && !collar) warns.push('Hole ID belum ada di daftar collar di HP ini.');
  const others = (siblings || []).filter(s => s.id !== r.id && !s.is_deleted);
  if (r.sample_no && others.some(s => s.sample_no === r.sample_no)) errors.push(`Nomor sampel ${r.sample_no} sudah ada.`);
  if (r.sample_type === 'NORMAL' && from != null && to != null && to > from) {
    const o = others.find(s => s.hole_id === r.hole_id && s.sample_type === 'NORMAL' && from < Number(s.to_m) - 1e-9 && to > Number(s.from_m) + 1e-9);
    if (o) errors.push(`Overlap dengan sampel ${o.sample_no} (${o.from_m}–${o.to_m} m) di lubang yang sama.`);
  }
  return { errors, warns };
}
