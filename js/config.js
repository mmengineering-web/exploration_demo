// ===== Static config. Business parameters now live in the DATABASE (Admin tab). =====
// This file only holds: site connections, and FALLBACK defaults used until the
// first sync has cached the site's own settings/lists.
// Use the anon key only. Never the service-role key.
export const SITES = {
  WKM:  { name: 'WKM',  url: 'https://yjhjlyeckoljhzjkxmmh.supabase.co', anonKey: 'sb_publishable_SN28oCcSLQj3epo4NAla2g_U_fLq58I' },
  BM:   { name: 'BM',   url: '', anonKey: '' },
  TMS:  { name: 'TMS',  url: '', anonKey: '' },
  CDSM: { name: 'CDSM', url: '', anonKey: '' },
  IBN:  { name: 'IBN',  url: '', anonKey: '' },
  TPB:  { name: 'TPB',  url: '', anonKey: '' },
  AJB:  { name: 'AJB',  url: '', anonKey: '' },
  CDS:  { name: 'CDS',  url: '', anonKey: '' },
};

// explohub (production hub): used only by the "All sites" tab. Anon key only, never the service-role key.
// Each person signs in with an explohub account that has a row in dash.member (supabase/hub/hub_05_dash_access.sql). Leave anon empty to hide the tab.
export const HUB = { url: 'https://nuymrirtigecyrosidga.supabase.co', anon: '' };

export const PHOTO_BUCKET = 'exp-photos';

// Fallback defaults (same values as the seed in migration 0002)
export const DEFAULTS = {
  gps_max_acc_m: 10,
  shift_hours: 12,
  photo_max_px: 1280,
  progress_pull_days: 0,
  depth_overrun_warn_factor: 1.5,
  hole_id_regex: '^[A-Z0-9-]{4,30}$',
  collar_min_dist_m: 2,
  utm_zone: null,
  utm_hemisphere: 'S',
};

// Describes each setting for the Admin form
export const SETTING_DEFS = [
  { key: 'gps_max_acc_m', label: 'Batas akurasi GPS as-built (m)', type: 'number', min: 1, max: 100,
    hint: 'Collar as-built ditolak bila akurasi GPS lebih buruk dari ini.' },
  { key: 'shift_hours', label: 'Jam per shift', type: 'number', min: 1, max: 24,
    hint: 'Batas maksimum downtime per record.' },
  { key: 'depth_overrun_warn_factor', label: 'Faktor peringatan total depth vs planned', type: 'number', min: 1, max: 10, step: 0.1,
    hint: 'Peringatan bila total depth > planned × faktor ini.' },
  { key: 'photo_max_px', label: 'Ukuran maks foto (px, sisi terpanjang)', type: 'number', min: 480, max: 4096,
    hint: 'Foto dikompres ke ukuran ini sebelum disimpan/diupload.' },
  { key: 'progress_pull_days', label: 'Data progress di-cache (hari, 0 = semua)', type: 'number', min: 0, max: 3650,
    hint: '0 = semua riwayat progress dibawa ke HP (dipakai untuk Data Records, Capaian, dan cek overlap interval).' },
  { key: 'collar_min_dist_m', label: 'Jarak minimum antar collar (m)', type: 'number', min: 0, max: 100, step: 0.5,
    hint: 'Koordinat planned/as-built yang lebih dekat dari ini ke lubang lain ditolak (cegah koordinat ganda). 0 = nonaktif.' },
  { key: 'utm_zone', label: 'Zona UTM site', type: 'number', min: 1, max: 60, step: 1, optional: true,
    hint: 'Untuk kolom X/Y (UTM) saat import Excel. Boleh dikosongkan: aplikasi menyimpulkan zona dari lubang/layer yang sudah ada di site ini. Isi bila site belum punya data atau dekat batas zona.' },
  { key: 'utm_hemisphere', label: 'Belahan UTM', type: 'choice', choices: [{ v: 'S', t: 'Selatan (S)' }, { v: 'N', t: 'Utara (N)' }],
    hint: 'Indonesia di selatan ekuator: S. Utara ekuator (mis. Sumatra utara): N.' },
  { key: 'hole_id_regex', label: 'Pola Hole ID (regex)', type: 'regex',
    hint: 'Harus sama atau lebih ketat dari aturan server: A–Z, 0–9, "-", 4–30 karakter. Contoh sempit: ^[A-Z0-9]{2,5}-(AG|TP|RC|DD)-[A-Z0-9]{4,8}$' },
];

// Which lists exist and which behaviour flags each one supports
export const LIST_DEFS = {
  hole_type: { label: 'Tipe lubang', flags: [{ k: 'is_coring', label: 'Lubang coring (tampilkan Core Result)' }] },
  collar_status: {
    label: 'Status collar',
    flags: [
      { k: 'is_plan', label: 'Status "rencana" (muncul di pilihan Collar)' },
      { k: 'requires_asbuilt', label: 'Wajib koordinat as-built' },
      { k: 'requires_total_depth', label: 'Wajib total depth' },
      { k: 'hide_from_progress', label: 'Sembunyikan dari pilihan Drilling Progress' },
      { k: 'map_class', label: 'Kelas di Peta', choices: [{ v: '', t: '(otomatis)' }, { v: 'planned', t: 'Planned' }, { v: 'eoh', t: 'EOH' }, { v: 'coh', t: 'COH' }] },
    ],
  },
  shift: { label: 'Shift', flags: [] },
  downtime_reason: { label: 'Alasan downtime', flags: [] },
  activity: { label: 'Aktivitas (jam rig)', flags: [] },
  layer: { label: 'Layer', flags: [] },
};

// Fallback lists (before first sync)
const c = (code, label, sort_order, meta = {}) => ({ code, label, sort_order, is_active: true, meta });
export const DEFAULT_CODES = {
  hole_type: [c('AG', 'Auger', 10), c('TP', 'Test pit', 20), c('RC', 'RC', 30), c('DD', 'Diamond', 40, { is_coring: true })],
  collar_status: [
    c('planned', 'Planned', 10, { is_plan: true, map_class: 'planned' }),
    c('drilling', 'Drilling', 20, { requires_asbuilt: true, map_class: 'coh' }),
    c('completed', 'Completed', 30, { requires_asbuilt: true, requires_total_depth: true, map_class: 'eoh' }),
    c('abandoned', 'Abandoned', 40, { hide_from_progress: true, map_class: 'eoh' }),
  ],
  shift: [c('DAY', 'Day', 10), c('NIGHT', 'Night', 20)],
  sample_type: [c('NORMAL', 'Normal', 10), c('DUPLICATE', 'Duplicate', 20), c('CRM', 'CRM', 30), c('BLANK', 'Blank', 40)],
  sample_status: [c('PENDING', 'Pending', 10), c('SENT', 'Sent', 20), c('ANALYZED', 'Analyzed', 30)],
  layer: [c('SED', 'Sedimen', 10), c('LIM', 'Limonit', 20), c('SAP', 'Saprolit', 30), c('BRK', 'Bedrock', 40), c('BLD', 'Boulder', 50), c('TS', 'Topsoil', 5), c('TRN', 'Transisi', 25)],
  activity: [c('DRILLING', 'Drilling', 10), c('MOVE_SETUP', 'Moving/Setup', 20), c('SURVEY_LOG', 'Survey/Logging', 30), c('STANDBY', 'Standby/BD/Weather', 40), c('TIME_TRIP', 'Time Trip', 50), c('BREAK', 'Break', 60), c('SETTING', 'Setting', 70)],
  downtime_reason: [c('RAIN', 'Hujan', 10), c('RIG_BREAKDOWN', 'Breakdown rig', 20), c('WAIT_WATER', 'Tunggu air', 30),
    c('RIG_MOVE', 'Pindah titik (rig move)', 40), c('WAIT_MATERIAL', 'Tunggu material/BBM', 50),
    c('SAFETY_STOP', 'Safety stop', 60), c('ACCESS', 'Akses/jalan', 70), c('OTHER', 'Lainnya', 99)],
};
