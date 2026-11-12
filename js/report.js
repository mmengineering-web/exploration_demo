// Daily drilling report (WhatsApp text). Pure function: builds the text from the data on the phone.
// Format follows the site's existing daily report (per rig, Daily & To Date, time sheet, issue, plan).
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = iso => { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return `${DAYS[dt.getUTCDay()]}, ${d} ${MONTHS[m - 1]} ${y}`; };
export const fmtNum = (n, d = 2) => (n == null || isNaN(n)) ? '' : String(Math.round(n * 10 ** d) / 10 ** d).replace('.', ',');
const N = v => (v == null || v === '' ? null : Number(v));
const tmin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
const rigName = id => String(id || '').toUpperCase().replace(/[-_]+/g, ' ');
const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);
export const spacingOf = holeId => { const m = /^[A-Za-z]+(\d+)-/.exec(holeId || ''); return m ? Number(m[1]) : null; };

// opts: { date, title, company, collars, progress, disthours, samples, rigs, statusClass(code)->'planned'|'progress'|'eoh'|'coh', actLabel(code), reasonLabel(code) }
export function buildReport(o) {
  const date = o.date, live = a => (a || []).filter(x => !x.is_deleted);
  const collars = live(o.collars), prog = live(o.progress).filter(p => p.work_date <= date), dist = live(o.disthours).filter(d => d.work_date === date);
  const samples = live(o.samples), cOf = id => collars.find(c => c.hole_id === id);
  const isEoh = id => { const c = cOf(id); return !!c && o.statusClass(c.status) === 'eoh'; };
  const day = prog.filter(p => p.work_date === date);
  const warnings = [];

  const rigIds = [...new Set([...(o.rigs || []).filter(r => r.is_active !== false).map(r => r.rig_id), ...day.map(p => p.rig_id), ...dist.map(d => d.rig_id)])].filter(Boolean).sort();

  // samples counted for a hole on the report date (sampled that day; if no date was filled: inside the interval drilled that day)
  const sampDay = (hole, lo, hi) => samples.filter(s => s.hole_id === hole && (s.sampled_date ? s.sampled_date === date : (Number(s.from_m) >= lo - 1e-9 && Number(s.to_m) <= hi + 1e-9))).length;
  const sampTot = hole => samples.filter(s => s.hole_id === hole && (!s.sampled_date || s.sampled_date <= date)).length;

  let sampleDayTotal = 0;
  const blocks = rigIds.map(rg => {
    const rows = day.filter(p => p.rig_id === rg).sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || a.from_m - b.from_m);
    const holes = [...new Set(rows.map(p => p.hole_id))];
    const head = `_* ${rigName(rg)}*_`;
    if (!holes.length) return { rg, text: `${head}\n-`, last: null };
    const parts = holes.map(h => {
      const r = rows.filter(p => p.hole_id === h).sort((a, b) => a.from_m - b.from_m);
      const from = Math.min(...r.map(p => N(p.from_m))), to = Math.max(...r.map(p => N(p.to_m)));
      const prod = sum(r, p => N(p.to_m) - N(p.from_m));
      const core = sum(r, p => N(p.core_len_m));
      const all = prog.filter(p => p.hole_id === h);
      const tDepth = Math.max(...all.map(p => N(p.to_m)));
      const tCore = sum(all, p => N(p.core_len_m));
      const sc = sampDay(h, from, to), st = sampTot(h);
      sampleDayTotal += sc;
      if (!sc) warnings.push(`Belum ada sampel terdaftar di tanggal ini untuk ${h} (Sampel Count = 0).`);
      const zones = [...new Set(r.map(p => p.layer).filter(Boolean))];
      const eoh = isEoh(h);
      return [h, `From = ${fmtNum(from)}  m`, `To = ${fmtNum(to)}  m`, `Production = ${fmtNum(prod)}  m`, `Core L. = ${fmtNum(core)}  m`, `T. Depth = ${fmtNum(tDepth)} m`,
        `T. Core L. = ${fmtNum(tCore)}  m`, `Sampel Count = ${sc} cth`, `T.Sampel = ${st} cth`, `Zona = ${zones.length ? zones.join(', ') : '-'}`, `EOH =  ${eoh ? fmtNum(N(cOf(h)?.total_depth_m) ?? tDepth) : 'COH'}`].join('\n');
    });
    return { rg, text: `${head}\n${parts.join('\n\n')}`, last: holes[holes.length - 1] };
  });

  // Daily & To Date
  const byHole = new Map(); prog.forEach(p => { (byHole.get(p.hole_id) || byHole.set(p.hole_id, []).get(p.hole_id)).push(p); });
  const finished = [...byHole.keys()].filter(isEoh).map(h => ({ h, last: byHole.get(h).reduce((m, p) => p.work_date > m ? p.work_date : m, ''), depth: Math.max(...byHole.get(h).map(p => N(p.to_m))) }));
  const finDay = finished.filter(f => f.last === date).length;
  const prodDay = sum(day, p => N(p.to_m) - N(p.from_m)), prodTot = sum(prog, p => N(p.to_m) - N(p.from_m));
  const sampTotAll = samples.filter(s => !s.sampled_date || s.sampled_date <= date).length;

  // Time sheet
  const ts = rigIds.map(rg => {
    const rows = dist.filter(d => d.rig_id === rg).sort((a, b) => String(a.from_time).localeCompare(String(b.from_time)));
    const by = new Map();
    rows.forEach(d => { const m = (tmin(d.to_time) ?? 0) - (tmin(d.from_time) ?? 0); by.set(d.activity, (by.get(d.activity) || 0) + Math.max(0, m)); });
    return `${rigName(rg)} : ${by.size ? [...by].map(([a, m]) => `${m} menit ${o.actLabel(a)}`).join(', ') : '-'}`;
  });

  // Issue: remarks and downtime of the day
  const issue = rigIds.map(rg => {
    const rows = day.filter(p => p.rig_id === rg), t = [];
    rows.forEach(p => { if (N(p.downtime_hours) > 0) t.push(`downtime ${fmtNum(N(p.downtime_hours))} jam${p.downtime_reason ? ' (' + o.reasonLabel(p.downtime_reason) + ')' : ''}`); if (p.remarks) t.push(p.remarks); });
    return `${rigName(rg)} : ${t.join('; ')}`;
  });

  // Plan tomorrow: hole not finished -> continue; finished -> move
  const plan = blocks.map(b => `${rigName(b.rg)} : ${b.last ? (isEoh(b.last) ? 'Moving & Drilling' : 'Continue Drilling') : '-'}`);

  // Remaining planned points grouped by grid spacing taken from the Hole ID (C50-018 -> 50 x 50)
  const planned = collars.filter(c => o.statusClass(c.status) === 'planned' && !byHole.has(c.hole_id));
  const g = new Map(); planned.forEach(c => { const s = spacingOf(c.hole_id); g.set(s, (g.get(s) || 0) + 1); });
  const rest = [...g].sort((a, b) => (a[0] ?? 1e9) - (b[0] ?? 1e9)).map(([s, n]) => `(${s == null ? 'Lainnya' : `${s} x ${s}`} = ${n} Hole)`);

  const text = [
    `*${o.title || ''}*`, longDate(date), '', '*DRILLING REPORT*', '',
    blocks.map(b => b.text).join('\n\n'), '',
    'Daily & To Date :',
    `# Hole Finish/Day = ${finDay} Hole`, `# Total Production/Day = ${fmtNum(prodDay)} Meter`, `# Total Sampel/Day = ${sampleDayTotal} Sampel`,
    `# Total Hole Finish= ${finished.length} Hole`, `# Total Production = ${fmtNum(prodTot)} Meter`, `# Total Sampel = ${sampTotAll} Sampel`,
    `# Total Depth Hole Finish = ${fmtNum(sum(finished, f => f.depth))} Meter`, '',
    ' * TIME SHEET :', ...ts, '', 'ISSUE :', ...issue, '', 'PLAN TOMORROW:', ...plan, '', 'PLAN TITIK TERSISA', ...(rest.length ? rest : ['-']), '',
    '_Best Regards_', '', `Exploration Team ${o.title || ''}`, ...(o.company ? [`*${o.company}*`] : []),
  ].join('\n');
  return { text, warnings: [...new Set(warnings)] };
}
