// RoA (lab Report of Analysis) parser: text items from a PDF -> report header + one row per table line.
// Pure functions, no DOM and no PDF library here, so Node can test them. Layout learnt from CDSM reports
// (header block, then a table: No | Sample ID | Ni Fe Co MgO CaO SiO2 Al2O3 Cr2O3 MnO P2O5 Fe2O3 TiO2 Zn MC).
export const ANALYTES = ['Ni', 'Fe', 'Co', 'MgO', 'CaO', 'SiO2', 'Al2O3', 'Cr2O3', 'MnO', 'P2O5', 'Fe2O3', 'TiO2', 'Zn', 'MC'];
// analyte -> exp_assay column (first five are real columns, the rest go to the `extra` JSON)
export const COLUMN_OF = { Ni: 'ni_pct', Co: 'co_pct', Fe: 'fe_pct', MgO: 'mgo_pct', SiO2: 'sio2_pct' };
export const extraKey = a => a.toLowerCase() + '_pct';
export const DL = 0.01;                    // XRF detection limit printed by the lab as "<0.01"
export const BELOW_DL_VALUE = DL / 2;      // half-DL substitution (same rule as the TPB analysis workbook)

const MONTHS = { januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6, juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, august: 8, october: 10, december: 12 };
export function parseDate(s) {
  const m = String(s || '').trim().match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null; const mo = MONTHS[m[2].toLowerCase()]; if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
}

// join text items of one line left to right; glue fragments that touch (e.g. "26" "1022" "-" "21")
function joinLine(items) {
  const s = [...items].sort((a, b) => a.x - b.x); let out = '', end = null;
  for (const it of s) { out += (end !== null && it.x - end > 1.8 ? ' ' : '') + it.str; end = it.x + it.w; }
  return out.trim();
}
function groupLines(items, tol = 4) {
  const lines = [];
  for (const it of [...items].sort((a, b) => b.y - a.y)) {
    const L = lines.find(l => Math.abs(l.y - it.y) <= tol);
    if (L) L.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  return lines;
}

const LABELS = [['report_no', /Nomor\s*Laporan\s*[:：]\s*(.+)$/i], ['client', /Pemohon\s*[:：]\s*(.+)$/i], ['client_ref', /Referensi\s*Pelanggan\s*[:：]\s*(.+)$/i],
  ['description', /Deskripsi\s*Sampel\s*[:：]\s*(.+)$/i], ['declared_count', /Jumlah\s*Sampel\s*[:：]\s*(\d+)/i], ['condition', /Kondisi\s*Sampel\s*[:：]\s*(.+)$/i],
  ['received', /Penerimaan\s*[:：]?\s*(.*)$/i], ['tested', /Tanggal\s*Tes\s*[:：]?\s*(.*)$/i], ['reported', /Tanggal\s*Laporan\s*[:：]?\s*(.*)$/i], ['basis', /Status\s*Analisis\s*[:：]\s*(.+)$/i]];

export function parseHeader(page1) {
  const lines = groupLines(page1.items).map(l => ({ y: l.y, t: joinLine(l.items) }));
  const h = {};
  const ref = lines.map(l => l.t.match(/REF\.?\s*NO\s*[:：]?\s*([A-Z0-9/.\-]+)/i)).find(Boolean);
  if (ref) h.ref_no = ref[1].replace(/\s+/g, '');
  lines.forEach((l, i) => {
    for (const [k, re] of LABELS) {
      const m = l.t.match(re); if (!m || h[k] !== undefined) continue;
      let v = (m[1] || '').trim();
      if (['received', 'tested', 'reported'].includes(k) && !parseDate(v)) { const nx = lines[i + 1]?.t || ''; v = (nx.match(/[:：]\s*(.+)$/) || [, nx])[1]; }   // value sits on the next line in some layouts
      h[k] = k === 'declared_count' ? +v : v;
    }
  });
  for (const k of ['received', 'tested', 'reported']) if (h[k]) h[k + '_date'] = parseDate(h[k]);
  h.batch_id = h.ref_no || h.report_no || null;       // the lab's own reference is the batch key
  return h;
}

// header row: tokens whose text is an analyte name, glued from fragments; returns { y, cols:[{name, cx}] }
function headerColumns(items) {
  const lines = groupLines(items);
  for (const l of lines) {
    const toks = []; let cur = null;
    for (const it of [...l.items].sort((a, b) => a.x - b.x)) {
      if (cur && it.x - cur.end < 2.2) { cur.str += it.str; cur.end = it.x + it.w; } else { cur = { str: it.str, x: it.x, end: it.x + it.w }; toks.push(cur); }
    }
    const hits = toks.filter(t => ANALYTES.includes(t.str.replace(/\s+/g, '')));
    if (hits.length >= 10 && hits.some(t => t.str === 'Ni') && hits.some(t => t.str === 'MC')) return { y: l.y, cols: hits.map(t => ({ name: t.str.replace(/\s+/g, ''), cx: (t.x + t.end) / 2 })) };
  }
  return null;
}

// Parse the table of every page. pages: [{ items:[{x,y,w,str}] }]
export function parseTable(pages) {
  const rows = [];
  for (const [pi, pg] of pages.entries()) {
    const hd = headerColumns(pg.items); if (!hd) continue;           // pages without the table header (notes, signatures) hold no rows
    const cols = hd.cols;
    const firstCx = Math.min(...cols.map(c => c.cx));
    const isInt = it => /^\d{1,4}$/.test(it.str.trim());
    const noX = Math.min(...pg.items.filter(it => isInt(it) && it.x < firstCx - 40).map(it => it.x).concat([Infinity]));
    if (!isFinite(noX)) continue;
    // anchors: integers in the No column
    const noCell = groupLines(pg.items.filter(it => it.y < hd.y - 3 && it.x < noX + 14 && it.x > noX - 14 && /^\d+$/.test(it.str.trim())), 2);   // "125" may come as "12"+"5"
    const anchors = noCell.map(l => ({ no: +l.items.sort((a, b) => a.x - b.x).map(i => i.str.trim()).join(''), y: l.y, id: [], vals: {} }));
    if (!anchors.length) continue;
    const idMax = firstCx - 14;
    for (const it of pg.items) {
      const s = it.str.trim(); if (!s || it.y >= hd.y - 3) continue;   // everything above the first row is header text
      if (/[\u4e00-\u9fff]|Metode|deteksi/i.test(s)) continue;          // bilingual labels and the method footnote
      if (it.x > noX + 14 && it.x < idMax) {                       // sample id fragment -> nearest anchor row
        let best = null; for (const a of anchors) if (!best || Math.abs(a.y - it.y) < Math.abs(best.y - it.y)) best = a;
        if (best && Math.abs(best.y - it.y) <= 26) best.id.push(it);
      } else if (it.x >= idMax) {                                 // value -> nearest analyte column, same line as anchor
        const a = anchors.find(a => Math.abs(a.y - it.y) <= 4); if (!a) continue;
        const cx = it.x + it.w / 2; let best = cols[0]; for (const c of cols) if (Math.abs(c.cx - cx) < Math.abs(best.cx - cx)) best = c;
        (a.vals[best.name] ||= []).push(it);
      }
    }
    for (const a of anchors) {
      const raw = {}; for (const [k, v] of Object.entries(a.vals)) raw[k] = joinLine(v);
      const id = groupLines(a.id).map(l => joinLine(l.items)).join('').replace(/\s+/g, ' ').trim();   // wrapped ids: lines are glued, words on one line keep their space
      rows.push({ no: a.no, page: pi + 1, id, raw });
    }
  }
  return rows;
}

// "<0.01" -> half DL, "-" "/" "" -> null; returns {v, flag}
export function readValue(s) {
  const t = String(s ?? '').trim().replace(',', '.');
  if (t === '' || t === '-' || t === '/' || t === '—') return { v: null };
  const lt = t.match(/^<\s*(\d*\.?\d+)$/); if (lt) return { v: +lt[1] / 2, flag: 'below_dl', dl: +lt[1] };
  if (/^-?\d*\.?\d+$/.test(t)) return { v: +t };
  return { v: null, flag: 'bad', raw: t };
}

// classify the lab sample id: PRIMARY | BLANK | CRM | DUPLICATE
export function classify(id) {
  const s = String(id).trim();
  if (/^BLANK/i.test(s)) return { kind: 'BLANK' };
  const c = s.match(/^OREAS[\s-]*(\d+)\s*([A-Za-z]?)(?:[\s-]+(\d+))?$/i);
  if (c) return { kind: 'CRM', crm_name: `OREAS ${c[1]}${c[2].toLowerCase()}`, crm_seq: c[3] ? +c[3] : null };
  const d = s.match(/^(.+?)-(RD|CD|PD)$/i);
  if (d) return { kind: 'DUPLICATE', original: d[1], dup_type: d[2].toUpperCase() };
  return { kind: 'PRIMARY' };
}
// primary id "TPB-A001-13.45" / "TPB-A001-0,40" -> { hole, to }
export function splitPrimary(id) {
  const m = String(id).match(/^(.+?)-(\d+(?:[.,]\d+)?)$/); if (!m) return null;
  return { hole: m[1], to: +m[2].replace(',', '.') };
}

// Full report: header + typed rows. `register` (optional) = existing exp_sample rows to resolve exact intervals.
export function parseReport(pages, register = []) {
  const header = parseHeader(pages[0]);
  const rows = parseTable(pages);
  const bySample = new Map(register.map(s => [s.sample_no, s]));
  const prevTo = new Map();
  const out = rows.map(r => {
    const fixed = r.id.replace(/-{2,}/g, '-');                      // lab typo: "TPB-A007--48" is sample TPB-A007-48 (its duplicates already say so)
    const k = classify(fixed); const o = { lab_seq: r.no, page: r.page, sample_id: fixed, ...k, values: {}, flags: [], notes: [] };
    if (fixed !== r.id) o.notes.push(`id typo "${r.id}" read as ${fixed}`);
    if (k.kind === 'BLANK') o.sample_id = 'BLANK-' + (r.id.match(/(\d+)\s*$/)?.[1] ?? '?');        // "BLANK3" / "BLANK 3" -> BLANK-3
    for (const a of ANALYTES) {
      const x = readValue(r.raw[a]);
      if (x.flag === 'bad') o.flags.push(`${a}: unreadable "${x.raw}"`);
      if (x.flag === 'below_dl') o.notes.push(`${a} <${x.dl} -> ${x.v}`);
      o.values[a] = x.v;
    }
    if (k.kind === 'PRIMARY') {
      const reg = bySample.get(o.sample_id); const sp = splitPrimary(o.sample_id);
      if (reg) { o.hole_id = reg.hole_id; o.from_m = Number(reg.from_m); o.to_m = Number(reg.to_m); o.matched = 'register'; }
      else if (sp) { o.hole_id = sp.hole; o.to_m = sp.to; o.from_m = prevTo.has(sp.hole) ? prevTo.get(sp.hole) : 0; o.matched = 'derived'; o.flags.push('not in sample register: interval derived from the id'); }
      else o.flags.push('sample id is not HOLE-DEPTH');
      if (o.hole_id) prevTo.set(o.hole_id, o.to_m);
    }
    return o;
  });
  // duplicates: attach to their original
  const prim = new Map(out.filter(o => o.kind === 'PRIMARY').map(o => [o.sample_id, o]));
  for (const o of out) if (o.kind === 'DUPLICATE') {
    const orig = prim.get(o.original);
    if (orig) { o.hole_id = orig.hole_id; o.from_m = orig.from_m; o.to_m = orig.to_m; } else o.flags.push(`original ${o.original} not found in this report`);
  }
  return { header, rows: out };
}

// Report-level checks the lab cannot be asked about row by row
export function checkReport(rep) {
  const msgs = []; const h = rep.header, n = rep.rows.length;
  const prim = rep.rows.filter(r => r.kind === 'PRIMARY').length;     // the lab's "Jumlah Sampel" counts submitted samples, not the QC it inserted
  // labs differ: report 26-21 declares primary samples only, report 26-27 declares every row including QC; either is accepted
  if (h.declared_count != null && h.declared_count !== prim && h.declared_count !== n) msgs.push({ sev: 'warning', text: `Report says ${h.declared_count} samples but ${prim} primary rows (${n} rows in total, ${n - prim} QC: blank, CRM, duplicate) were read. Check for a missing or merged row.` });
  const seq = rep.rows.map(r => r.lab_seq); for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1] + 1) { msgs.push({ sev: 'warning', text: `Row numbers jump from ${seq[i - 1]} to ${seq[i]}: a row may be missing or unread.` }); break; }
  if (!h.batch_id) msgs.push({ sev: 'critical', text: 'Report number (REF. NO) not found.' });
  return msgs;
}
