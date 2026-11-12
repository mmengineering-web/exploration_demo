// "RoA Lab" tab: pick a lab Report of Analysis PDF, preview what was read, save it into exp_assay (offline-first, synced later).
import * as D from '../db.js';
import * as S from '../sync.js';
import { readPdf } from './pdf.js';
import { parseReport } from './parse.js';
import { plan } from './commit.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f2 = v => (v == null ? '' : (Math.round(v * 100) / 100).toString());
const ui = { file: '', plan: null, lab: '', withWarn: true, shown: 150 };

export async function viewRoa(root, { toast, canSave }) {
  root.innerHTML = `
  <div class="card"><h2>RoA Lab (PDF)</h2>
    <p class="muted small">Baca Report of Analysis dari lab: sampel utama, blank, CRM, dan duplikat ikut terbaca. Baris yang sudah pernah diimport (nomor sampel atau batch sama) dilewati, jadi aman diulang. Data disimpan di HP dan dikirim saat online.</p>
    <div class="row actions">
      <label class="btn primary">Pilih file RoA (PDF)<input id="roa-file" type="file" accept="application/pdf,.pdf" style="display:none"></label>
      <label class="muted small">Nama lab <input id="roa-lab" type="text" style="width:9em" placeholder="mis. CDSM" value="${esc(ui.lab)}"></label>
    </div>
    <div id="roa-msg"></div>
  </div>
  <div id="roa-out"></div>`;
  const msg = $ => root.querySelector($);
  msg('#roa-lab').oninput = e => { ui.lab = e.target.value.trim(); };
  msg('#roa-file').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    msg('#roa-msg').innerHTML = '<div class="msg">Membaca PDF…</div>'; msg('#roa-out').innerHTML = '';
    try {
      const [pages, samples, collars, assays] = await Promise.all([readPdf(f), D.db.samples.filter(s => !s.is_deleted).toArray(), D.db.collars.filter(c => !c.is_deleted).toArray(), D.db.assays.toArray()]);
      const rep = parseReport(pages, samples);
      if (!rep.rows.length) throw new Error('Tabel hasil tidak ditemukan. Pastikan ini PDF asli dari lab (bukan hasil scan/foto).');
      ui.file = f.name; ui.lab = ui.lab || (rep.header.ref_no || '').split('/')[0] || '';
      msg('#roa-lab').value = ui.lab;
      ui.plan = plan(rep, { collars: new Set(collars.map(c => c.hole_id)), assays, file: f.name, lab: ui.lab });
      ui.shown = 150; msg('#roa-msg').innerHTML = ''; draw();
    } catch (err) { console.error(err); msg('#roa-msg').innerHTML = `<div class="msg err">${esc(err.message || err)}</div>`; }
  };

  function draw() {
    const p = ui.plan, h = p.header, c = p.counts;
    const save = p.items.filter(i => i.rec && (ui.withWarn || i.status === 'ok'));
    const rows = p.items.slice(0, ui.shown).map(i => {
      const r = i.row, v = r.values;
      return `<tr class="roa-${i.status}"><td>${r.lab_seq}</td><td>${esc(r.sample_id)}</td><td>${esc(r.kind)}</td><td>${esc(r.hole_id || '')}</td><td>${r.from_m != null ? f2(r.from_m) + '–' + f2(r.to_m) : ''}</td>
        <td>${f2(v.Ni)}</td><td>${f2(v.Fe)}</td><td>${f2(v.MgO)}</td><td>${f2(v.SiO2)}</td><td class="small">${i.status === 'skip' ? 'dilewati' : i.status === 'warn' ? '⚠' : '✓'} ${esc(i.flags.join('; '))}</td></tr>`;
    }).join('');
    msg('#roa-out').innerHTML = `
    <div class="card"><h3>${esc(h.batch_id || '?')} <span class="muted small">laporan ${esc(h.report_no || '-')} · terima ${esc(h.received_date || '-')} · uji ${esc(h.tested_date || '-')} · terbit ${esc(h.reported_date || '-')}</span></h3>
      <p class="small">${c.PRIMARY || 0} sampel utama · ${c.DUPLICATE || 0} duplikat · ${c.CRM || 0} CRM · ${c.BLANK || 0} blank — <b>${save.length}</b> akan disimpan, ${c.skip} dilewati, ${c.warn} perlu dicek.</p>
      ${p.msgs.map(m => `<div class="msg ${m.sev === 'critical' ? 'err' : 'warn'}">${esc(m.text)}</div>`).join('')}
      <label class="small"><input type="checkbox" id="roa-warn" ${ui.withWarn ? 'checked' : ''}> Simpan juga baris bertanda ⚠ (interval diturunkan dari ID, hole belum ada collar, dll.)</label>
      <div class="row actions"><button class="btn primary" id="roa-go" ${canSave && save.length && !p.msgs.some(m => m.sev === 'critical') ? '' : 'disabled'}>Simpan ${save.length} baris</button></div>
      ${canSave ? '' : '<div class="msg warn">Akun ini tidak boleh input data sampel.</div>'}
    </div>
    <div class="card" style="overflow:auto;max-height:60vh"><table class="tbl small"><thead><tr><th>#</th><th>Sampel</th><th>Tipe</th><th>Hole</th><th>Interval</th><th>Ni</th><th>Fe</th><th>MgO</th><th>SiO₂</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
      ${p.items.length > ui.shown ? `<div class="row actions"><button class="btn small" id="roa-more">Tampilkan lebih banyak (${p.items.length - ui.shown} lagi)</button></div>` : ''}</div>`;
    msg('#roa-warn').onchange = e => { ui.withWarn = e.target.checked; draw(); };
    const more = msg('#roa-more'); if (more) more.onclick = () => { ui.shown += 400; draw(); };
    msg('#roa-go').onclick = async () => {
      const b = msg('#roa-go'); b.disabled = true;
      try {
        const recs = save.map(i => ({ ...i.rec, lab: ui.lab || null }));
        await D.saveMany('assays', recs); S.syncSoon(300);
        msg('#roa-out').innerHTML = `<div class="card"><div class="msg ok">${recs.length} baris disimpan dari ${esc(ui.file)}. Terkirim ke server saat online. Lihat hasil QC di Dashboard › Data QC.</div></div>`;
        ui.plan = null; toast(`${recs.length} baris RoA disimpan`);
      } catch (err) { toast(err.message || String(err), 'err'); b.disabled = false; }
    };
  }
  if (ui.plan) draw();
}
