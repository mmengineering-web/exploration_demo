// Richer .xlsx writer for the lab-analysis workbook: styles, formulas with cached values, freeze panes, column widths,
// merged cells and PASS/WARN/FAIL conditional colours. Reuses the zip/xml helpers of xlsx-lite. No dependencies, works offline.
import { zip, xml, colName, enc } from '../xlsx-lite.js';

// style name -> xf index. Fonts/fills/formats are listed once below.
const FONTS = ['<font><sz val="10"/><name val="Calibri"/></font>',
  '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',          // 1 header
  '<font><b/><sz val="14"/><color rgb="FF1F3A5F"/><name val="Calibri"/></font>',          // 2 title
  '<font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font>',          // 3 note
  '<font><sz val="10"/><color rgb="FF0000FF"/><name val="Calibri"/></font>',              // 4 input
  '<font><b/><sz val="10"/><name val="Calibri"/></font>'];                                // 5 bold
const FILLS = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/></patternFill></fill>',   // 2 header
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill>',   // 3 input yellow
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF6"/></patternFill></fill>'];  // 4 section band
const NUMFMT = { n2: [164, '0.00'], n3: [165, '0.000'], n4: [166, '0.0000'], pct: [167, '0.0%'], date: [168, 'dd-mmm-yy'] };
const BORDER = '<border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border>';
// [font, fill, numFmtId, border, wrap, hAlign]
const XF = {
  txt: [0, 0, 0, 0, 0], title: [2, 0, 0, 0, 0], note: [3, 0, 0, 0, 0], bold: [5, 0, 0, 0, 0],
  hdr: [1, 2, 0, 1, 1, 'center'], band: [5, 4, 0, 0, 0],
  in: [4, 3, 0, 1, 0], in2: [4, 3, 164, 1, 0], in3: [4, 3, 165, 1, 0], in1: [4, 3, 1, 1, 0], inpct: [4, 3, 167, 1, 0],
  n0: [0, 0, 1, 0, 0], n2: [0, 0, 164, 0, 0], n3: [0, 0, 165, 0, 0], n4: [0, 0, 166, 0, 0], pct: [0, 0, 167, 0, 0], date: [0, 0, 168, 0, 0], wrap: [0, 0, 0, 0, 1],
};
const NAMES = Object.keys(XF);
const stylesXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="${Object.keys(NUMFMT).length}">${Object.values(NUMFMT).map(([id, c]) => `<numFmt numFmtId="${id}" formatCode="${xml(c)}"/>`).join('')}</numFmts>
<fonts count="${FONTS.length}">${FONTS.join('')}</fonts><fills count="${FILLS.length}">${FILLS.join('')}</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${BORDER}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${NAMES.length}">${NAMES.map(n => { const [f, fi, nf, b, w, h] = XF[n];
  return `<xf numFmtId="${nf}" fontId="${f}" fillId="${fi}" borderId="${b}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"${w || h ? ` applyAlignment="1"><alignment vertical="top"${w ? ' wrapText="1"' : ''}${h ? ` horizontal="${h}"` : ''}/></xf>` : '/>'}`; }).join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="3"><dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>
<dxf><font><color rgb="FF9C5700"/></font><fill><patternFill><bgColor rgb="FFFFEB9C"/></patternFill></fill></dxf>
<dxf><font><color rgb="FF006100"/></font><fill><patternFill><bgColor rgb="FFC6EFCE"/></patternFill></fill></dxf></dxfs></styleSheet>`;
const SI = Object.fromEntries(NAMES.map((n, i) => [n, i]));

const ref = (r, c) => colName(c) + (r + 1);
function cellXml(v, r, c) {
  if (v === null || v === undefined || v === '') return '';
  const o = typeof v === 'object' && !(v instanceof Date) ? v : { v };
  const s = o.s && SI[o.s] ? ` s="${SI[o.s]}"` : '';
  const val = o.v;
  if (o.f) {
    const f = `<f>${xml(o.f.replace(/^=/, ''))}</f>`;
    if (typeof val === 'number' && isFinite(val)) return `<c r="${ref(r, c)}"${s}>${f}<v>${val}</v></c>`;
    if (val === undefined || val === null) return `<c r="${ref(r, c)}"${s}>${f}</c>`;
    return `<c r="${ref(r, c)}"${s} t="str">${f}<v>${xml(val)}</v></c>`;
  }
  if (typeof val === 'number' && isFinite(val)) return `<c r="${ref(r, c)}"${s}><v>${val}</v></c>`;
  if (val === undefined || val === null || val === '') return o.s ? `<c r="${ref(r, c)}"${s}/>` : '';
  return `<c r="${ref(r, c)}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(val)}</t></is></c>`;
}
// Excel date serial from an ISO date string
export const serial = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) + 25569 : null; };

// sheet: { name, widths:[...], rows:[[cell,...]], freeze:[row,col] (cells above/left stay), merges:['A1:J1'], cf:[{ sqref, fail:[texts], warn:[texts], pass:[texts] }], tab:'FF1F3A5F' }
function sheetXml(sh) {
  const rows = sh.rows.map((row, r) => { const cs = row.map((v, c) => cellXml(v, r, c)).join(''); return cs ? `<row r="${r + 1}">${cs}</row>` : ''; }).join('');
  const [fr, fc] = sh.freeze || [0, 0];
  const pane = fr || fc ? `<pane${fc ? ` xSplit="${fc}"` : ''}${fr ? ` ySplit="${fr}"` : ''} topLeftCell="${ref(fr, fc)}" activePane="${fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight'}" state="frozen"/>` : '';
  const cols = sh.widths ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  let pr = 1;
  const cf = (sh.cf || []).map(g => `<conditionalFormatting sqref="${g.sqref}">${[['fail', 0], ['warn', 1], ['pass', 2]].flatMap(([k, dx]) => (g[k] || []).map(t =>
    `<cfRule type="cellIs" dxfId="${dx}" priority="${pr++}" operator="equal"><formula>"${xml(t)}"</formula></cfRule>`)).join('')}</conditionalFormatting>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sh.tab ? `<sheetPr><tabColor rgb="${sh.tab}"/></sheetPr>` : ''}<sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="14"/>${cols}<sheetData>${rows}</sheetData>${merges}${cf}</worksheet>`;
}

export function buildWorkbook(sheets) {
  const n = sheets.length;
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', stylesXml()],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ].map(([name, text]) => [name, enc.encode(text)]);
  return zip(files);
}
