// Lab-analysis workbook (same structure as the TPB "Analisis Geokimia" Excel): model -> sheets for xlsxw.js.
// Every classification / QAQC cell is a live formula that reads the Parameter sheet (yellow cells = editable), with the value
// pre-computed here so the file also reads correctly in viewers that do not recalculate.
// Left out on purpose: charts (QAQC_Charts, Downhole_Plot, EDA_Scatter), Composite_Ni and the IDW maps (Map_*).
import { buildWorkbook, serial } from './xlsxw.js';
import { latLonToUtm } from '../utm.js';
import { assayValue, classify, thresholds, analyze, FE_TO_FE2O3, lateriteLevel } from '../qc/calc.js';

const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const col = i => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
const f = (formula, v, s) => ({ f: formula, v, s });
const HDR = (arr) => arr.map(v => ({ v, s: 'hdr' }));
const crmKey = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').replace(/[\s-]\d+$/, '').trim();
const dm = iso => { const s = serial(iso); return s == null ? '' : { v: s, s: 'date' }; };
const sevText = { critical: 'KRITIS', warning: 'PERINGATAN', info: 'INFO' };
const ADVICE = {
  Blank: ['Kontaminasi/carry-over preparasi; hasil sampel di batch ini bias tinggi.', 'Minta lab ulang preparasi blank dan sampel sesudahnya.'],
  CRM: ['Akurasi analit tidak terjamin; hasil batch bisa bias.', 'Minta re-assay batch atau koreksi bias bila konsisten.'],
  Duplicate: ['Presisi preparasi/analisis rendah pada pasangan ini.', 'Cek homogenisasi/pembagian sampel; minta analisis ulang bila perlu.'],
  Integrity: ['QC tidak independen: hasil bisa disalin antar laporan.', 'Minta raw XRF output (file instrumen + timestamp) dari lab.'],
  Batch: ['Jaminan mutu batch tidak lengkap.', 'Minta lab menyisipkan blank, CRM, dan duplikat di batch berikutnya.'],
  'Assay value': ['Nilai tidak konsisten secara kimia.', 'Cek ulang input/analisis sampel ini.'],
  Collar: ['Data collar tidak lengkap.', 'Lengkapi di tab Collar.'], Survey: ['Geometri lubang tidak pasti.', 'Lengkapi/perbaiki survey downhole.'],
  Assay: ['Interval assay tidak konsisten dengan lubang.', 'Perbaiki interval atau data collar.'], Sample: ['Alur sampel ke lab tertunda.', 'Tindak lanjuti ke lab / perbarui status.'],
};

export function buildLabWorkbook({ site, generated, collars, assays, crm, setting, utm }) {
  const T = thresholds(setting);
  const A = assays.filter(a => !a.is_deleted);
  const prim = A.filter(a => a.sample_type === 'NORMAL' && a.hole_id).sort((a, b) => String(a.batch_id).localeCompare(String(b.batch_id)) || (a.lab_seq ?? 1e9) - (b.lab_seq ?? 1e9) || a.hole_id.localeCompare(b.hole_id) || a.from_m - b.from_m);
  const N = prim.length, last = Math.max(N + 1, 2);

  /* ---- Parameter (built first: every other sheet points at these cells) ---- */
  const P = {}, prow = []; let pr = 0;
  const add = (cells) => { prow.push(cells); pr++; return pr; };
  add([{ v: 'Parameter Klasifikasi & QAQC', s: 'title' }]); add([{ v: 'Sel KUNING (huruf biru) = input yang boleh diubah. Semua formula di workbook membaca nilai dari sheet ini.', s: 'note' }]);
  add(HDR(['Parameter', 'Nilai', 'Satuan', 'Catatan / dasar']));
  const sec = t => add([{ v: t, s: 'band' }, { s: 'band' }, { s: 'band' }, { s: 'band' }]);
  const par = (key, label, v, unit, note, st = 'in') => { const r = add([label, { v, s: st }, unit, note ? { v: note, s: 'note' } : '']); P[key] = `Parameter!$B$${r}`; P[key + '_v'] = v; return r; };
  sec('A. Klasifikasi geokimia (berurutan: BRK → RSAP → SAP → CEK → LIM)');
  par('brk_ni', 'BRK: Ni kurang dari', 0.8, '%', 'BRK hanya jika ketiga syarat BRK terpenuhi (AND)');
  par('brk_mgo', 'BRK: MgO lebih dari/sama', 30, '%', 'Batuan ultramafik relatif segar'); par('brk_fe', 'BRK: Fe kurang dari', 10, '%', 'Fe rendah, belum terlaterisasi');
  par('rsap_mgo', 'RSAP: MgO lebih dari/sama', 20, '%', 'Rocky saprolite (AND)'); par('rsap_fe', 'RSAP: Fe kurang dari', 15, '%');
  par('sap_fe', 'SAP: Fe kurang dari', 25, '%', 'SAP jika Fe < nilai ini DAN MgO ≥ batas bawah, ATAU MgO ≥ batas SAP'); par('sap_mgo', 'SAP: MgO lebih dari/sama', 10, '%', 'Sisanya (Fe ≥ 25 dan MgO < 10) = LIM');
  par('sap_mgo_min', 'SAP via Fe rendah: MgO minimal', 5, '%', 'Fe < 25 tapi MgO < nilai ini = "CEK" (dilusi SiO2/Al2O3)');
  sec('B. Indikasi laterit (Al2O3 & Cr2O3)');
  par('al_hi', 'Al2O3 tinggi (≥)', 8, '%'); par('al_mid', 'Al2O3 sedang (≥)', 4, '%'); par('cr_hi', 'Cr2O3 tinggi (≥)', 2, '%'); par('cr_mid', 'Cr2O3 sedang (≥)', 1, '%');
  par('cr_vhi', 'Cr2O3 sangat tinggi (≥)', 4, '%', 'Flag kemungkinan kromit'); par('al_vhi', 'Al2O3 sangat tinggi (≥)', 15, '%', 'Flag clay/ferricrete');
  sec('C. Cek konsistensi data');
  par('fe_tol', 'Toleransi Fe vs Fe2O3/1.4297', T.fe2o3_tol_pct / 100, 'relatif', 'Fe2O3 = Fe × 1.4297; deviasi > toleransi di-flag', 'in3'); par('mc_hi', 'MC tinggi (≥)', T.mc_max, '%');
  sec('D. QAQC');
  par('blank', 'Blank: Ni maksimum', T.blank_ni_max, '%', '≈5× DL (DL Ni = 0.01%)', 'in3'); par('pd', 'Pulp duplicate (PD): ARD Ni maks', T.dup_ard_ni_max.PD, 'relatif', '', 'in3');
  par('cd', 'Coarse duplicate (CD): ARD Ni maks', T.dup_ard_ni_max.CD, 'relatif', '', 'in3'); par('rd', 'RD: ARD Ni maks', T.dup_ard_ni_max.RD, 'relatif', 'Definisi RD belum terkonfirmasi; dipakai batas CD', 'in3');
  par('zw', 'CRM: batas peringatan |Z|', T.crm_z_warn, 'SD'); par('zf', 'CRM: batas gagal |Z|', T.crm_z_fail, 'SD');
  par('res', 'Resolusi pelaporan lab', T.lab_resolution, '%', 'Z tidak dinilai bila SD sertifikat < resolusi ini (hasil hanya mencerminkan pembulatan)', 'in3');
  sec('E. Nilai sertifikat CRM (dari certificate of analysis)');
  add(HDR(['Analit', 'Certified value', '1SD', 'Sumber']));
  const crmRows = crm.filter(c => !c.is_deleted); const crmName = crmRows[0]?.crm_name || 'OREAS 182b';
  const CZ = {}; for (const an of ['Ni', 'Fe2O3', 'MgO', 'SiO2', 'Al2O3', 'Cr2O3', 'Co']) {
    const c = crmRows.find(x => x.analyte === an && crmKey(x.crm_name) === crmKey(crmName));
    const r = add([an, { v: c ? Number(c.certified_value) : null, s: 'in3' }, { v: c ? Number(c.sd) : null, s: 'in3' }, { v: c?.source || '', s: 'note' }]);
    CZ[an] = { cert: `Parameter!$B$${r}`, sd: `Parameter!$C$${r}`, certV: c ? Number(c.certified_value) : null, sdV: c ? Number(c.sd) : null };
  }
  add([{ v: `CRM yang dipakai: ${crmName}. Jangan memakai sertifikat OREAS 182 (tanpa "b") untuk 182b.`, s: 'note' }]);
  sec('F. Komposit ore'); par('cutoff', 'Cut-off Ni (≥)', T.cutoff_ni, '%', 'Sampel Ni ≥ cut-off = ore', 'in2');
  const parameter = { name: 'Parameter', rows: prow, widths: [38, 14, 10, 80], tab: 'FFFFC000', freeze: [3, 0] };
  const p = k => P[k], pv = k => P[k + '_v'];

  /* ---- Assay_Data ---- */
  const AH = ['Hole_ID', 'Sample_ID', 'From (m)', 'To (m)', 'Length (m)', 'Lab Report', 'Lab Seq', 'Ni (%)', 'Fe (%)', 'Co (%)', 'MgO (%)', 'CaO (%)', 'SiO2 (%)', 'Al2O3 (%)', 'Cr2O3 (%)', 'MnO (%)', 'P2O5 (%)', 'Fe2O3 (%)', 'TiO2 (%)', 'Zn (%)', 'MC (%)',
    'Geochem_Class', 'Al2O3_Status', 'Cr2O3_Status', 'Indikasi_Laterit', 'Catatan_Laterit', 'SiO2/MgO', 'Fe2O3 Dev', 'Flag_Otomatis', 'Catatan_Data'];
  const AN = ['Ni', 'Fe', 'Co', 'MgO', 'CaO', 'SiO2', 'Al2O3', 'Cr2O3', 'MnO', 'P2O5', 'Fe2O3', 'TiO2', 'Zn', 'MC'];
  const arow = [HDR(AH)];
  prim.forEach((a, i) => {
    const r = i + 2, v = Object.fromEntries(AN.map(n => [n, assayValue(a, n)])), Ni = v.Ni, Fe = v.Fe, Mg = v.MgO, Al = v.Al2O3, Cr = v.Cr2O3, Fo = v.Fe2O3, MC = v.MC;
    const cl = classify(Ni, Fe, Mg) ?? '';
    const dev = Fo != null && Fe != null && Fe > 0 ? Fo / (Fe * FE_TO_FE2O3) - 1 : '';
    const lv = lateriteLevel(Al, Cr), lvt = { high: 'Tinggi', medium: 'Sedang', low: 'Rendah' }[lv];
    const stat = (x, hi, mid) => (x == null ? '' : x >= hi ? 'Tinggi' : x >= mid ? 'Sedang' : 'Rendah');
    const catL = ((Cr ?? 0) >= pv('cr_vhi') ? 'Cr2O3 sangat tinggi (kromit?); ' : '') + ((Al ?? 0) >= pv('al_vhi') ? 'Al2O3 sangat tinggi (clay/ferricrete?); ' : '');
    const flag = (dev !== '' && Math.abs(dev) > pv('fe_tol') ? 'Fe vs Fe2O3 tidak konsisten; ' : '') + ((MC ?? 0) >= pv('mc_hi') && MC != null ? 'MC tinggi; ' : '');
    const nv = n => (v[n] == null ? null : { v: v[n], s: 'n2' });
    arow.push([a.hole_id, a.sample_no, { v: num(a.from_m), s: 'n2' }, { v: num(a.to_m), s: 'n2' }, f(`D${r}-C${r}`, num(a.to_m) - num(a.from_m), 'n2'), a.batch_id || '', a.lab_seq ?? '',
      ...AN.map(nv),
      f(`IF(OR(H${r}="",I${r}="",K${r}=""),"",IF(AND(H${r}<${p('brk_ni')},K${r}>=${p('brk_mgo')},I${r}<${p('brk_fe')}),"BRK",IF(AND(K${r}>=${p('rsap_mgo')},I${r}<${p('rsap_fe')}),"RSAP",IF(OR(K${r}>=${p('sap_mgo')},AND(I${r}<${p('sap_fe')},K${r}>=${p('sap_mgo_min')})),"SAP",IF(AND(I${r}<${p('sap_fe')},K${r}<${p('sap_mgo_min')}),"CEK","LIM")))))`, cl),
      f(`IF(N${r}="","",IF(N${r}>=${p('al_hi')},"Tinggi",IF(N${r}>=${p('al_mid')},"Sedang","Rendah")))`, stat(Al, pv('al_hi'), pv('al_mid'))),
      f(`IF(O${r}="","",IF(O${r}>=${p('cr_hi')},"Tinggi",IF(O${r}>=${p('cr_mid')},"Sedang","Rendah")))`, stat(Cr, pv('cr_hi'), pv('cr_mid'))),
      f(`IF(OR(N${r}>=${p('al_hi')},O${r}>=${p('cr_hi')}),"Tinggi",IF(OR(N${r}>=${p('al_mid')},O${r}>=${p('cr_mid')}),"Sedang","Rendah"))`, lvt),
      f(`TRIM(IF(O${r}>=${p('cr_vhi')},"Cr2O3 sangat tinggi (kromit?); ","")&IF(N${r}>=${p('al_vhi')},"Al2O3 sangat tinggi (clay/ferricrete?); ",""))`, catL.trim()),
      f(`IF(K${r}>0,M${r}/K${r},"")`, Mg > 0 && v.SiO2 != null ? v.SiO2 / Mg : '', 'n2'),
      f(`IF(AND(ISNUMBER(R${r}),ISNUMBER(I${r}),I${r}>0),R${r}/(I${r}*${FE_TO_FE2O3})-1,"")`, dev, 'pct'),
      f(`TRIM(IF(ISNUMBER(AB${r}),IF(ABS(AB${r})>${p('fe_tol')},"Fe vs Fe2O3 tidak konsisten; ",""),"")&IF(AND(ISNUMBER(U${r}),U${r}>=${p('mc_hi')}),"MC tinggi; ",""))`, flag.trim()),
      a.remarks || '']);
  });
  const asy = { name: 'Assay_Data', rows: arow, widths: [12, 18, 8, 8, 9, 18, 8, ...AN.map(() => 8), 12, 11, 11, 13, 30, 9, 9, 28, 30], freeze: [1, 2], tab: 'FF2E75B6',
    cf: [{ sqref: `W2:X${last}`, fail: ['Tinggi'], warn: ['Sedang'] }] };
  const R = (c) => `Assay_Data!$${c}$2:$${c}$${last}`;

  /* ---- Collar ---- */
  const holes = [...new Set([...collars.filter(c => !c.is_deleted).map(c => c.hole_id), ...prim.map(a => a.hole_id)])].sort();
  const cmap = new Map(collars.map(c => [c.hole_id, c]));
  const crow = [[{ v: 'Collar – Koordinat Lubang Bor', s: 'title' }], [{ v: 'Isi sel KUNING. X/Y dalam meter (UTM), RL = elevasi collar (m). Terisi otomatis dari koordinat as-built (atau rencana) di aplikasi bila ada.', s: 'note' }],
    ['Sistem koordinat (CRS):', `UTM WGS84 Zona ${utm?.zone ?? '?'}${utm?.hemi ?? 'S'}`], [], HDR(['Hole_ID', 'X / Easting (m)', 'Y / Northing (m)', 'RL (m)', 'Azimuth (°)', 'Dip (°)', 'EOH dari assay (m)', 'Ada data lab?', 'Catatan'])];
  const cfirst = 6, clast = cfirst + Math.max(holes.length, 1) - 1;
  holes.forEach((h, i) => {
    const r = cfirst + i, c = cmap.get(h) || {}; const lat = num(c.asbuilt_lat ?? c.planned_lat), lon = num(c.asbuilt_lon ?? c.planned_lon);
    let X = null, Y = null; if (lat != null && lon != null && utm?.zone) { const u = latLonToUtm(lat, lon, Number(utm.zone), utm.hemi || 'S'); X = Math.round(u.e * 1000) / 1000; Y = Math.round(u.n * 1000) / 1000; }
    const eoh = prim.filter(a => a.hole_id === h).reduce((m, a) => Math.max(m, num(a.to_m)), 0);
    crow.push([h, { v: X, s: 'in3' }, { v: Y, s: 'in3' }, { v: num(c.asbuilt_elev ?? c.planned_elev), s: 'in2' }, { v: num(c.azimuth_deg), s: 'in1' }, { v: num(c.dip_deg ?? -90), s: 'in1' },
      f(`IF(A${r}="","",IF(COUNTIF(${R('A')},A${r})=0,"",_xlfn.MAXIFS(${R('D')},${R('A')},A${r})))`, eoh || '', 'n2'),
      f(`IF(A${r}="","",IF(COUNTIF(${R('A')},A${r})>0,"Ya","Belum"))`, eoh ? 'Ya' : 'Belum'),
      { v: X == null ? 'Koordinat belum ada' : (c.dip_deg == null ? 'Asumsi vertikal (dip -90) bila kosong' : ''), s: 'note' }]);
  });
  const collar = { name: 'Collar', rows: crow, widths: [14, 16, 16, 10, 12, 10, 16, 14, 40], freeze: [5, 1], tab: 'FF70AD47' };
  const CR = c => `Collar!$${c}$${cfirst}:$${c}$${clast}`;

  /* ---- QAQC ---- */
  const q = [[{ v: 'QAQC – Blank, CRM, Duplikat', s: 'title' }], [{ v: 'Nilai <0.01 = 0.005. ARD = |dup − ori| / rata-rata(dup, ori). Batas dibaca dari sheet Parameter.', s: 'note' }], []];
  const cfq = []; const row = () => q.length + 1;
  const blanks = A.filter(a => a.sample_type === 'BLANK').sort((a, b) => String(a.batch_id).localeCompare(String(b.batch_id)) || (a.lab_seq ?? 0) - (b.lab_seq ?? 0));
  q.push([{ v: 'A. BLANK', s: 'band' }]); q.push(HDR(['Lab Report', 'Seq', 'Sample_ID', 'Ni', 'Fe', 'Co', 'MgO', 'SiO2', 'Al2O3', 'Cr2O3', 'Fe2O3', 'Batas Ni', 'Status Ni']));
  const b0 = row(); blanks.forEach(a => { const r = row(); const ni = assayValue(a, 'Ni');
    q.push([a.batch_id || '', a.lab_seq ?? '', a.sample_no, ...['Ni', 'Fe', 'Co', 'MgO', 'SiO2', 'Al2O3', 'Cr2O3', 'Fe2O3'].map(n => { const x = assayValue(a, n); return x == null ? null : { v: x, s: 'n2' }; }),
      f(p('blank'), pv('blank'), 'n3'), f(`IF(D${r}="","n/a",IF(D${r}<=L${r},"PASS","FAIL"))`, ni == null ? 'n/a' : ni <= pv('blank') ? 'PASS' : 'FAIL')]); });
  if (blanks.length) cfq.push({ sqref: `M${b0}:M${row() - 1}`, fail: ['FAIL'], pass: ['PASS'], warn: ['n/a'] });
  q.push([]); q.push([{ v: `B. CRM ${crmName}`, s: 'band' }]);
  const AZ = ['Ni', 'Fe2O3', 'MgO', 'SiO2', 'Al2O3', 'Cr2O3', 'Co'];
  q.push(HDR(['Lab Report', 'Seq', 'Sample_ID', ...AZ, ...AZ.map(a => 'Z ' + a), 'Fingerprint (7 analit, 2 desimal)', 'Duplikasi lintas laporan', 'Status CRM']));
  const crms = A.filter(a => a.sample_type === 'CRM').sort((a, b) => String(a.batch_id).localeCompare(String(b.batch_id)) || (a.lab_seq ?? 0) - (b.lab_seq ?? 0));
  const c0 = row(), c1 = c0 + crms.length - 1;
  const fpOf = a => AZ.map(n => { const x = assayValue(a, n); return x == null ? '0.00' : x.toFixed(2); }).join('|');
  const fpCount = new Map(); crms.forEach(a => { const k = fpOf(a); (fpCount.get(k) || fpCount.set(k, new Set()).get(k)).add(a.batch_id); });
  crms.forEach(a => { const r = row(); const meas = AZ.map(n => assayValue(a, n));
    const z = AZ.map((n, i) => { const c = CZ[n]; if (c.certV == null || meas[i] == null) return 'n/a'; if (c.sdV < pv('res')) return 'n/a'; return (meas[i] - c.certV) / c.sdV; });
    const zc = AZ.map((n, i) => { const cc = col(3 + i), c = CZ[n]; return f(`IF(OR(${c.cert}="",${c.sd}="",${cc}${r}=""),"n/a",IF(${c.sd}<${p('res')},"n/a",(${cc}${r}-${c.cert})/${c.sd}))`, z[i], 'n2'); });
    const mx = Math.max(0, ...z.map(x => (typeof x === 'number' ? Math.abs(x) : 0)));
    const abs = AZ.map((_, i) => `IFERROR(ABS(${col(10 + i)}${r}),0)`).join(',');
    const dup = fpCount.get(fpOf(a)).size > 1;
    q.push([a.batch_id || '', a.lab_seq ?? '', a.sample_no, ...meas.map(x => (x == null ? null : { v: x, s: 'n2' })), ...zc,
      f(AZ.map((_, i) => `TEXT(${col(3 + i)}${r},"0.00")`).join('&"|"&'), fpOf(a)),
      f(`IF(COUNTIFS($R$${c0}:$R$${c1},R${r},$A$${c0}:$A$${c1},"<>"&A${r})>0,"IDENTIK dgn laporan lain","-")`, dup ? 'IDENTIK dgn laporan lain' : '-'),
      f(`IF(MAX(${abs})>${p('zf')},"FAIL",IF(MAX(${abs})>${p('zw')},"WARN","PASS"))`, mx > pv('zf') ? 'FAIL' : mx > pv('zw') ? 'WARN' : 'PASS')]); });
  if (crms.length) cfq.push({ sqref: `K${c0}:Q${c1}`, fail: [], warn: [] }, { sqref: `T${c0}:T${c1}`, fail: ['FAIL'], warn: ['WARN'], pass: ['PASS'] }, { sqref: `S${c0}:S${c1}`, fail: ['IDENTIK dgn laporan lain'] });
  q.push([]); q.push([{ v: 'C. DUPLIKAT (RD / CD / PD)', s: 'band' }]);
  const DA = [['Ni', 'H'], ['Fe', 'I'], ['MgO', 'K'], ['SiO2', 'M']];
  q.push(HDR(['Lab Report', 'Tipe', 'Dup Sample_ID', 'Original Sample_ID', ...DA.flatMap(([n]) => [n + ' Ori', n + ' Dup', 'ARD ' + n]), 'Batas ARD Ni', 'Status Ni']));
  const dups = A.filter(a => a.sample_type === 'DUPLICATE').sort((a, b) => String(a.batch_id).localeCompare(String(b.batch_id)) || (a.lab_seq ?? 0) - (b.lab_seq ?? 0));
  const byNo = new Map(prim.map(a => [a.sample_no, a])); const d0 = row();
  dups.forEach(a => { const r = row(); const o = byNo.get(a.duplicate_of_sample_no); const type = a.duplicate_type || 'RD';
    const cells = DA.flatMap(([n, ac], k) => { const oc = col(4 + k * 3), dc = col(5 + k * 3), ov = o ? assayValue(o, n) : null, dv = assayValue(a, n); const ard = ov != null && dv != null && ov + dv > 0 ? Math.abs(dv - ov) / ((ov + dv) / 2) : '';
      return [f(`IFERROR(INDEX(${R(ac)},MATCH($D${r},${R('B')},0)),"")`, ov ?? '', 'n2'), dv == null ? null : { v: dv, s: 'n2' }, f(`IF(OR(${oc}${r}="",${dc}${r}=""),"",IF(${oc}${r}+${dc}${r}<=0,"",ABS(${dc}${r}-${oc}${r})/AVERAGE(${oc}${r},${dc}${r})))`, ard, 'pct')]; });
    const ardNi = cells[2].v, lim = type === 'PD' ? pv('pd') : type === 'CD' ? pv('cd') : pv('rd');
    q.push([a.batch_id || '', type, a.sample_no, a.duplicate_of_sample_no || '', ...cells,
      f(`IF(B${r}="PD",${p('pd')},IF(B${r}="CD",${p('cd')},${p('rd')}))`, lim, 'pct'), f(`IF(G${r}="","n/a",IF(G${r}<=Q${r},"PASS","FAIL"))`, ardNi === '' ? 'n/a' : ardNi <= lim ? 'PASS' : 'FAIL')]); });
  if (dups.length) cfq.push({ sqref: `R${d0}:R${row() - 1}`, fail: ['FAIL'], pass: ['PASS'], warn: ['n/a'] });
  const qaqc = { name: 'QAQC', rows: q, widths: [18, 8, 20, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 10, 28, 24, 11], freeze: [3, 3], cf: cfq, tab: 'FFC00000' };

  /* ---- Ringkasan_Lubang ---- */
  const hr = [[{ v: 'Ringkasan per Lubang', s: 'title' }], [{ v: 'Semua angka dihitung dari Assay_Data dengan formula (dibobot panjang).', s: 'note' }], [],
    HDR(['Hole_ID', 'Jumlah sampel', 'EOH sampel (m)', 'Panjang total (m)', 'Ni rata² (%)', 'Fe rata² (%)', 'MgO rata² (%)', 'Ni maks (%)', 'Panjang ore (m)', '% ore', 'BRK', 'RSAP', 'SAP', 'CEK', 'LIM'])];
  const hs = [...new Set(prim.map(a => a.hole_id))].sort();
  hs.forEach((h, i) => { const r = 5 + i, rows = prim.filter(a => a.hole_id === h); const len = rows.reduce((s, a) => s + (num(a.to_m) - num(a.from_m)), 0);
    const wavg = n => { let s = 0, w = 0; for (const a of rows) { const x = assayValue(a, n) ?? 0; const l = num(a.to_m) - num(a.from_m); s += x * l; w += l; } return w ? s / w : ''; };
    const ore = rows.filter(a => (assayValue(a, 'Ni') ?? -1) >= pv('cutoff')).reduce((s, a) => s + (num(a.to_m) - num(a.from_m)), 0);
    const cc = k => rows.filter(a => classify(assayValue(a, 'Ni'), assayValue(a, 'Fe'), assayValue(a, 'MgO')) === k).length;
    const wf = c => `IF($D${r}=0,"",SUMPRODUCT((${R('A')}=$A${r})*${R('E')}*${R(c)})/$D${r})`;
    hr.push([h, f(`COUNTIF(${R('A')},A${r})`, rows.length, 'n0'), f(`_xlfn.MAXIFS(${R('D')},${R('A')},A${r})`, Math.max(...rows.map(a => num(a.to_m))), 'n2'), f(`SUMIF(${R('A')},A${r},${R('E')})`, len, 'n2'),
      f(wf('H'), wavg('Ni'), 'n3'), f(wf('I'), wavg('Fe'), 'n2'), f(wf('K'), wavg('MgO'), 'n2'), f(`_xlfn.MAXIFS(${R('H')},${R('A')},A${r})`, Math.max(...rows.map(a => assayValue(a, 'Ni') ?? 0)), 'n2'),
      f(`SUMIFS(${R('E')},${R('A')},A${r},${R('H')},">="&${p('cutoff')})`, ore, 'n2'), f(`IF(D${r}=0,"",I${r}/D${r})`, len ? ore / len : '', 'pct'),
      ...['BRK', 'RSAP', 'SAP', 'CEK', 'LIM'].map(k => f(`COUNTIFS(${R('A')},$A${r},${R('V')},"${k}")`, cc(k), 'n0'))]); });
  const holeSheet = { name: 'Ringkasan_Lubang', rows: hr, widths: [14, 10, 12, 12, 11, 11, 11, 10, 12, 8, 7, 7, 7, 7, 7], freeze: [4, 1], tab: 'FF2E75B6' };

  /* ---- Ringkasan ---- */
  const batches = [...new Set(A.map(a => a.batch_id).filter(Boolean))].sort();
  const sm = [[{ v: `Analisis Hasil Lab Laterit Nikel – ${site}`, s: 'title' }], [{ v: `Dibuat ${generated}. Laporan: ${batches.join(', ') || '-'}`, s: 'note' }], [],
    HDR(['Laporan', 'No. Laporan', 'Ref. pelanggan', 'Lubang', 'Diterima', 'Dites', 'Dilaporkan', 'Baris tabel', 'Primer', 'QC'])];
  batches.forEach((b, i) => { const r = 5 + i, rs = A.filter(a => a.batch_id === b), one = rs.find(a => a.certificate_no || a.client_ref) || rs[0];
    const hh = [...new Set(rs.filter(a => a.sample_type === 'NORMAL' && a.hole_id).map(a => a.hole_id.replace(/^.*-/, '')))].join(', ');
    const np = rs.filter(a => a.sample_type === 'NORMAL' && a.hole_id).length;
    sm.push([b, one?.certificate_no || '', one?.client_ref || '', hh, dm(one?.received_date), dm(one?.tested_date), dm(one?.reported_date), rs.length, f(`COUNTIF(${R('F')},A${r})`, np, 'n0'), f(`H${r}-I${r}`, rs.length - np, 'n0')]); });
  const e1 = 5 + batches.length;
  sm.push([], [{ v: 'Distribusi kelas geokimia (sampel primer)', s: 'band' }], HDR(['Kelas', 'Jumlah', '%']));
  const cls = ['BRK', 'RSAP', 'SAP', 'CEK', 'LIM']; const cnt = Object.fromEntries(cls.map(k => [k, prim.filter(a => classify(assayValue(a, 'Ni'), assayValue(a, 'Fe'), assayValue(a, 'MgO')) === k).length]));
  const k0 = sm.length + 1; cls.forEach((k, i) => { const r = k0 + i; sm.push([k, f(`COUNTIF(${R('V')},A${r})`, cnt[k], 'n0'), f(`IF(${N}=0,"",B${r}/${N})`, N ? cnt[k] / N : '', 'pct')]); });
  const rr = analyze({ collar: collars, survey: [], sample: [], assay: A, crm: crmRows }, T);
  sm.push([], [{ v: 'Ringkasan QAQC', s: 'band' }], HDR(['Uji', 'Jumlah', 'Gagal']));
  const qs = sm.length + 1;
  sm.push(['Blank', blanks.length, f(`COUNTIF(QAQC!$M$${b0}:$M$${b0 + Math.max(blanks.length, 1) - 1},"FAIL")`, rr.blanks.filter(x => x.status === 'fail').length, 'n0')],
    ['CRM (sampel)', crms.length, f(`COUNTIF(QAQC!$T$${c0}:$T$${c0 + Math.max(crms.length, 1) - 1},"FAIL")`, crms.filter(a => { const m = AZ.map(n => assayValue(a, n)); return AZ.some((n, i) => CZ[n].certV != null && CZ[n].sdV >= pv('res') && m[i] != null && Math.abs((m[i] - CZ[n].certV) / CZ[n].sdV) > pv('zf')); }).length, 'n0')],
    ['Duplikat', dups.length, f(`COUNTIF(QAQC!$R$${d0}:$R$${d0 + Math.max(dups.length, 1) - 1},"FAIL")`, rr.dups.filter(x => x.status === 'fail').length, 'n0')]);
  sm.push([], [{ v: 'Sheet Downhole_Plot, EDA_Scatter, QAQC_Charts, Composite_Ni dan Map_* (peta IDW) tidak dibuat oleh aplikasi; gunakan XYZ_Samples di Surfer/QGIS/Leapfrog.', s: 'note' }]);
  const summary = { name: 'Ringkasan', rows: sm, widths: [20, 16, 18, 20, 11, 11, 11, 11, 9, 9], tab: 'FF1F3A5F' };

  /* ---- Data_Issues ---- */
  const di = [[{ v: 'Log Temuan Validasi Data', s: 'title' }], [{ v: 'Diurutkan dari severity tertinggi; semua temuan dari pengecekan otomatis aplikasi.', s: 'note' }], [], HDR(['No', 'Severity', 'Kategori', 'Lokasi / Sample', 'Temuan', 'Dampak', 'Rekomendasi'])];
  rr.issues.forEach((i, k) => { const ad = ADVICE[i.cat] || ['', '']; di.push([k + 1, sevText[i.sev], i.cat, [i.hole, i.ref].filter(Boolean).join(' / '), { v: i.msg, s: 'wrap' }, { v: ad[0], s: 'wrap' }, { v: ad[1], s: 'wrap' }]); });
  const issues = { name: 'Data_Issues', rows: di, widths: [6, 13, 14, 28, 60, 40, 40], freeze: [4, 0], tab: 'FFC00000', cf: [{ sqref: `B5:B${di.length}`, fail: ['KRITIS'], warn: ['PERINGATAN'] }] };

  /* ---- XYZ_Samples ---- */
  const xr = [HDR(['Hole_ID', 'Sample_ID', 'From (m)', 'To (m)', 'Mid (m)', 'X (m)', 'Y (m)', 'RL collar (m)', 'Z mid (m)', 'Ni (%)', 'Fe (%)', 'MgO (%)', 'Geochem_Class', 'Ore (Ni ≥ cut)'])];
  const look = (c, r) => `IFERROR(IF(ISNUMBER(INDEX(${CR(c)},MATCH(A${r},${CR('A')},0))),INDEX(${CR(c)},MATCH(A${r},${CR('A')},0)),""),"")`;
  prim.forEach((a, i) => { const r = i + 2, h = cmap.get(a.hole_id) || {}; const lat = num(h.asbuilt_lat ?? h.planned_lat), lon = num(h.asbuilt_lon ?? h.planned_lon);
    let X = '', Y = ''; if (lat != null && lon != null && utm?.zone) { const u = latLonToUtm(lat, lon, Number(utm.zone), utm.hemi || 'S'); X = Math.round(u.e * 1000) / 1000; Y = Math.round(u.n * 1000) / 1000; }
    const RL = num(h.asbuilt_elev ?? h.planned_elev) ?? '', mid = (num(a.from_m) + num(a.to_m)) / 2, ni = assayValue(a, 'Ni');
    xr.push([f(`Assay_Data!A${r}`, a.hole_id), f(`Assay_Data!B${r}`, a.sample_no), f(`Assay_Data!C${r}`, num(a.from_m), 'n2'), f(`Assay_Data!D${r}`, num(a.to_m), 'n2'), f(`(C${r}+D${r})/2`, mid, 'n2'),
      f(look('B', r), X, 'n2'), f(look('C', r), Y, 'n2'), f(look('D', r), RL, 'n2'), f(`IF(ISNUMBER(H${r}),H${r}-E${r},"")`, RL === '' ? '' : RL - mid, 'n2'),
      f(`Assay_Data!H${r}`, ni ?? '', 'n3'), f(`Assay_Data!I${r}`, assayValue(a, 'Fe') ?? '', 'n2'), f(`Assay_Data!K${r}`, assayValue(a, 'MgO') ?? '', 'n2'),
      f(`Assay_Data!V${r}`, classify(ni, assayValue(a, 'Fe'), assayValue(a, 'MgO')) ?? ''), f(`IF(J${r}>=${p('cutoff')},1,0)`, ni != null && ni >= pv('cutoff') ? 1 : 0, 'n0')]); });
  const xyz = { name: 'XYZ_Samples', rows: xr, widths: [12, 18, 8, 8, 8, 12, 12, 10, 10, 8, 8, 8, 12, 10], freeze: [1, 2], tab: 'FF70AD47' };

  return buildWorkbook([summary, asy, holeSheet, qaqc, collar, issues, parameter, xyz]);
}
