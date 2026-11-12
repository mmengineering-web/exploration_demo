// Import template built per site, so Excel enforces what the app forms enforce:
// dropdowns from the site's own code lists / rigs / prospects, number ranges, no future dates, From < To,
// and red highlighting for what a cell rule cannot express (duplicates, overlaps, required-but-empty, status rules).
// Pure function: buildTemplate(opts) -> Uint8Array (.xlsx). No DOM, no imports from the app.
import { zip, xml, colName, enc } from './xlsx-lite.js';

const MAXR = 2000;
const L = i => colName(i);
// column kinds -> data validation (stop style = same as the app: refuse the value)
export function buildTemplate(o) {
  const lists = o.lists || {}, rigs = o.rigs || [], prospects = o.prospects || [], holes = o.holes || [];
  const shiftH = Number(o.shiftHours) || 12, factor = Number(o.depthFactor) || 1.5;
  const reqAs = (o.requiresAsbuilt || []), reqTd = (o.requiresTotalDepth || []);

  /* ---- LISTS sheet (hidden): one column per list ---- */
  const lcols = []; // {name, values}
  const addList = (name, values) => { lcols.push({ name, values }); return lcols.length; };
  const ref = {};
  for (const k of ['hole_type', 'collar_status', 'sample_type', 'sample_status', 'layer', 'shift', 'downtime_reason', 'activity']) if ((lists[k] || []).length) ref[k] = addList(k, lists[k]);
  if (rigs.length) ref.rig = addList('rig_id', rigs);
  if (prospects.length) ref.prospect = addList('prospect', prospects);
  ref.hole = addList('existing_holes', holes);
  const rng = k => { const c = lcols[ref[k] - 1]; return `LISTS!$${L(ref[k] - 1)}$2:$${L(ref[k] - 1)}$${Math.max(2, c.values.length + 1)}`; };

  /* ---- sheet definitions ---- */
  // col: { h, req, w, fmt: 'date'|'time'|undefined, dv: {type, ...} | null }
  const DVN = (op, f1, f2, title, msg) => ({ type: 'decimal', op, f1, f2, title, msg });
  const num0 = DVN('greaterThanOrEqual', 0, null, 'Number', 'Enter a number of 0 or more.');
  const numPos = DVN('greaterThan', 0, null, 'Number', 'Must be greater than 0.');
  const pct = DVN('between', 0, 100, 'Percent', 'Enter 0 to 100.');
  const list = (k, title, msg) => ref[k] ? ({ type: 'list', f1: rng(k), title, msg }) : null;
  const date = { type: 'date', op: 'between', f1: 36526, f2: 'TODAY()+1', title: 'Date', msg: 'Enter a valid date, not in the future.' };
  const dateAny = { type: 'date', op: 'between', f1: 36526, f2: 73050, title: 'Date', msg: 'Enter a valid date.' };
  const time = { type: 'time', op: 'between', f1: 0, f2: 0.999988, title: 'Time', msg: 'Enter a time as HH:MM (00:00 to 23:59).' };
  const holeNew = c => ({ type: 'custom', f1: `AND(LEN(${c}2)>=4,LEN(${c}2)<=30,ISERROR(FIND(" ",${c}2)),COUNTIF($${c}$2:$${c}$${MAXR},${c}2)=1,COUNTIF(${rng('hole')},${c}2)=0)`, title: 'Hole ID', msg: 'Hole ID must be unique (not already in the app or in this sheet), 4-30 characters, no spaces. Pattern: ' + (o.holePattern || '') });
  const holeKnown = c => ({ type: 'custom', f1: `OR(COUNTIF(${rng('hole')},${c}2)>0,COUNTIF(COLLAR!$A$2:$A$${MAXR},${c}2)>0)`, title: 'Hole ID', msg: 'This hole is not registered. Add it in the COLLAR sheet, or register it in the app first.' });
  const gt = (c, other, msg) => ({ type: 'custom', f1: `AND(ISNUMBER(${c}2),ISNUMBER(${other}2),${c}2>${other}2)`, title: 'Range', msg });

  const S = {};
  S.COLLAR = {
    cols: [
      { h: 'Hole ID', req: 1, w: 16, dv: holeNew('A') }, { h: 'Hole Type', req: 1, w: 11, dv: list('hole_type', 'Hole type', 'Pick a hole type from the list.') },
      { h: 'Prospect', w: 14, dv: list('prospect', 'Prospect', 'Pick a registered prospect.') }, { h: 'Status', req: 1, w: 12, dv: list('collar_status', 'Status', 'Pick a status from the list.') },
      { h: 'Planned X (E)', w: 14, dv: DVN('between', 100000, 900000, 'UTM easting', 'UTM easting is 100000 to 900000 m. Check X/Y are not swapped.') },
      { h: 'Planned Y (N)', w: 14, dv: DVN('between', 0, 10000000, 'UTM northing', 'UTM northing is 0 to 10000000 m. Check X/Y are not swapped.') },
      { h: 'Planned Elev (m)', w: 14, dv: DVN('between', -1000, 10000, 'Elevation', 'Enter a number in metres.') }, { h: 'Planned Depth (m)', w: 15, dv: numPos },
      { h: 'As-built X (E)', w: 14, dv: DVN('between', 100000, 900000, 'UTM easting', 'UTM easting is 100000 to 900000 m. Check X/Y are not swapped.') },
      { h: 'As-built Y (N)', w: 14, dv: DVN('between', 0, 10000000, 'UTM northing', 'UTM northing is 0 to 10000000 m. Check X/Y are not swapped.') },
      { h: 'As-built Elev (m)', w: 15, dv: DVN('between', -1000, 10000, 'Elevation', 'Enter a number in metres.') }, { h: 'Total Depth (m)', w: 14, dv: numPos },
      { h: 'Dip (deg)', w: 10, dv: DVN('between', -90, 90, 'Dip', 'Dip is -90 to 90 (vertical down = -90).') }, { h: 'Azimuth (deg)', w: 13, dv: DVN('between', 0, 360, 'Azimuth', 'Azimuth is 0 to 360.') },
      { h: 'Remarks', w: 28 }],
    cf: [
      ['E2:F' + MAXR, 'AND(OR($E2<>"",$F2<>""),OR($E2="",$F2=""))', 0],
      ['I2:J' + MAXR, 'AND(OR($I2<>"",$J2<>""),OR($I2="",$J2=""))', 0],
      reqAs.length ? ['I2:J' + MAXR, `AND(OR(${reqAs.map(x => `$D2="${x}"`).join(',')}),OR($I2="",$J2=""))`, 0] : null,
      reqTd.length ? ['L2:L' + MAXR, `AND(OR(${reqTd.map(x => `$D2="${x}"`).join(',')}),$L2="")`, 0] : null,
      ['L2:L' + MAXR, `AND(ISNUMBER($L2),ISNUMBER($H2),$L2>$H2*${factor})`, 1],
      ['A2:A' + MAXR, `AND($A2<>"",COUNTIF($A$2:$A$${MAXR},$A2)>1)`, 0],
    ],
  };
  S.PROGRESS = {
    cols: [
      { h: 'Date', req: 1, w: 12, fmt: 'date', dv: date }, { h: 'Shift', req: 1, w: 9, dv: list('shift', 'Shift', 'Pick a shift from the list.') },
      { h: 'Rig ID', req: 1, w: 11, dv: list('rig', 'Rig', 'Pick a registered rig.') }, { h: 'Hole ID', req: 1, w: 16, dv: holeKnown('D') },
      { h: 'From (m)', req: 1, w: 10, dv: num0 }, { h: 'To (m)', req: 1, w: 10, dv: gt('F', 'E', 'To must be greater than From.') },
      { h: 'Layer', w: 10, dv: list('layer', 'Layer', 'Pick a layer from the list.') }, { h: 'Core Length (m)', w: 15, dv: num0 },
      { h: 'Downtime (h)', w: 13, dv: DVN('between', 0, shiftH, 'Downtime', `Downtime is 0 to ${shiftH} hours.`) },
      { h: 'Downtime Reason', w: 16, dv: list('downtime_reason', 'Reason', 'Pick a reason from the list.') },
      { h: 'Remarks', w: 28 }],
    cf: [
      ['E2:F' + MAXR, `AND($D2<>"",ISNUMBER($E2),ISNUMBER($F2),COUNTIFS($D$2:$D$${MAXR},$D2,$E$2:$E$${MAXR},"<"&$F2,$F$2:$F$${MAXR},">"&$E2)>1)`, 0],
      ['H2:H' + MAXR, 'AND(ISNUMBER($H2),ISNUMBER($E2),ISNUMBER($F2),$H2>$F2-$E2+0.005)', 1],
      ['J2:J' + MAXR, 'AND(N($I2)>0,$J2="")', 0],
    ],
  };
  S.DIST_HOUR = {
    cols: [
      { h: 'Date', req: 1, w: 12, fmt: 'date', dv: date }, { h: 'Rig ID', req: 1, w: 11, dv: list('rig', 'Rig', 'Pick a registered rig.') },
      { h: 'From Time', req: 1, w: 11, fmt: 'time', dv: time }, { h: 'To Time', req: 1, w: 11, fmt: 'time', dv: { type: 'custom', f1: 'AND(ISNUMBER(D2),ISNUMBER(C2),D2>C2,D2<1)', title: 'Time', msg: 'To must be later than From, on the same day (split records that pass midnight).' } },
      { h: 'Activity', req: 1, w: 14, dv: list('activity', 'Activity', 'Pick an activity from the list.') },
      { h: 'Fuel (L)', w: 10, dv: num0 }, { h: 'Polymer (L)', w: 11, dv: num0 }, { h: 'Hyd Oil (L)', w: 11, dv: num0 }, { h: 'Remarks', w: 28 }],
    cf: [['C2:D' + MAXR, `AND(ISNUMBER($C2),ISNUMBER($D2),COUNTIFS($A$2:$A$${MAXR},$A2,$B$2:$B$${MAXR},$B2,$C$2:$C$${MAXR},"<"&$D2,$D$2:$D$${MAXR},">"&$C2)>1)`, 0]],
  };
  S.SURVEY = {
    cols: [
      { h: 'Hole ID', req: 1, w: 16, dv: holeKnown('A') }, { h: 'Depth (m)', req: 1, w: 11, dv: num0 },
      { h: 'Dip (deg)', req: 1, w: 10, dv: DVN('between', -90, 90, 'Dip', 'Dip is -90 to 90 (vertical down = -90).') },
      { h: 'Azimuth (deg)', req: 1, w: 13, dv: DVN('between', 0, 360, 'Azimuth', 'Azimuth is 0 to 360.') },
      { h: 'Method', w: 14 }, { h: 'Date', w: 12, fmt: 'date', dv: dateAny }, { h: 'Remarks', w: 28 }],
    cf: [['B2:B' + MAXR, `AND($A2<>"",ISNUMBER($B2),COUNTIFS($A$2:$A$${MAXR},$A2,$B$2:$B$${MAXR},$B2)>1)`, 0]],
  };
  const overlapNormal = (hc, fc, tc, ty) => `AND(OR($${ty}2="",$${ty}2="NORMAL"),$${hc}2<>"",ISNUMBER($${fc}2),ISNUMBER($${tc}2),COUNTIFS($${hc}$2:$${hc}$${MAXR},$${hc}2,$${ty}$2:$${ty}$${MAXR},"NORMAL",$${fc}$2:$${fc}$${MAXR},"<"&$${tc}2,$${tc}$2:$${tc}$${MAXR},">"&$${fc}2)+COUNTIFS($${hc}$2:$${hc}$${MAXR},$${hc}2,$${ty}$2:$${ty}$${MAXR},"=",$${fc}$2:$${fc}$${MAXR},"<"&$${tc}2,$${tc}$2:$${tc}$${MAXR},">"&$${fc}2)>1)`;
  S.SAMPLE = {
    cols: [
      { h: 'Sample No', req: 1, w: 14, dv: { type: 'custom', f1: `COUNTIF($A$2:$A$${MAXR},A2)=1`, title: 'Sample No', msg: 'Sample No must be unique in this sheet.' } },
      { h: 'Hole ID', req: 1, w: 16, dv: holeKnown('B') }, { h: 'From (m)', req: 1, w: 10, dv: num0 }, { h: 'To (m)', req: 1, w: 10, dv: gt('D', 'C', 'To must be greater than From.') },
      { h: 'Type', w: 13, dv: list('sample_type', 'Type', 'Pick a type from the list.') }, { h: 'Status', w: 12, dv: list('sample_status', 'Status', 'Pick a status from the list.') },
      { h: 'Sampled Date', w: 13, fmt: 'date', dv: dateAny },
      { h: 'Sent Date', w: 12, fmt: 'date', dv: { type: 'custom', f1: 'AND(ISNUMBER(H2),OR(G2="",H2>=G2))', title: 'Sent date', msg: 'Sent date cannot be before sampled date.' } },
      { h: 'Lab', w: 14 }, { h: 'Batch ID', w: 12 }, { h: 'Remarks', w: 28 }],
    cf: [['C2:D' + MAXR, overlapNormal('B', 'C', 'D', 'E'), 0]],
  };
  S.ASSAY = {
    cols: [
      { h: 'Hole ID', req: 1, w: 16, dv: holeKnown('A') }, { h: 'From (m)', req: 1, w: 10, dv: num0 }, { h: 'To (m)', req: 1, w: 10, dv: gt('C', 'B', 'To must be greater than From.') },
      { h: 'Sample No', w: 14 }, { h: 'Layer', w: 10, dv: list('layer', 'Layer', 'Pick a layer from the list.') },
      { h: 'Ni (%)', w: 9, dv: pct }, { h: 'Co (%)', w: 9, dv: pct }, { h: 'Fe (%)', w: 9, dv: pct }, { h: 'MgO (%)', w: 9, dv: pct }, { h: 'SiO2 (%)', w: 9, dv: pct },
      { h: 'Sample Type', w: 13, dv: list('sample_type', 'Type', 'Pick a type from the list.') }, { h: 'Batch ID', w: 12 }, { h: 'Lab', w: 14 }, { h: 'Certificate No', w: 15 },
      { h: 'CRM Name', w: 14 }, { h: 'CRM Element', w: 12 }, { h: 'CRM Expected', w: 13, dv: num0 },
      { h: 'Duplicate Type', w: 14 }, { h: 'Duplicate Of Sample No', w: 20 }, { h: 'Remarks', w: 28 }],
    cf: [['B2:C' + MAXR, overlapNormal('A', 'B', 'C', 'K'), 0]],
  };
  // required cell empty while the row has other data
  for (const [name, sh] of Object.entries(S)) {
    const last = L(sh.cols.length - 1);
    sh.cols.forEach((c, i) => { if (c.req) sh.cf.push([`${L(i)}2:${L(i)}${MAXR}`, `AND(COUNTA($A2:$${last}2)>0,${L(i)}2="")`, 0]); });
    sh.cf = sh.cf.filter(Boolean);
  }
  // holes of other sheets that are not registered (pasted values bypass the cell rule)
  for (const [name, col] of [['PROGRESS', 'D'], ['SURVEY', 'A'], ['SAMPLE', 'B'], ['ASSAY', 'A']])
    S[name].cf.push([`${col}2:${col}${MAXR}`, `AND(${col}2<>"",COUNTIF(${rng('hole')},${col}2)=0,COUNTIF(COLLAR!$A$2:$A$${MAXR},${col}2)=0)`, 0]);

  /* ---- XML ---- */
  const ST = { reqH: 1, optH: 2, date: 3, time: 4, wrap: 5, bold: 6, title: 7, text: 8 };
  const cell = (v, r, c, st) => {
    if (v == null || v === '') return '';
    const ref = L(c) + r, s = st ? ` s="${st}"` : '';
    if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  };
  const dvXml = (c, i) => {
    const d = c.dv; if (!d) return '';
    const sq = `${L(i)}2:${L(i)}${MAXR}`;
    const at = `type="${d.type}"${d.op ? ` operator="${d.op}"` : ''} errorStyle="stop" allowBlank="1" showErrorMessage="1" errorTitle="${xml(d.title.slice(0, 32))}" error="${xml(d.msg.slice(0, 255))}" sqref="${sq}"`;
    return `<dataValidation ${at}><formula1>${xml(d.f1)}</formula1>${d.f2 != null ? `<formula2>${xml(d.f2)}</formula2>` : ''}</dataValidation>`;
  };
  const sheetXml = sh => {
    const cols = sh.cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"${c.fmt ? ` style="${ST[c.fmt]}"` : ''}/>`).join('');
    const head = `<row r="1" ht="22" customHeight="1">${sh.cols.map((c, i) => cell(c.h, 1, i, c.req ? ST.reqH : ST.optH)).join('')}</row>`;
    const dvs = sh.cols.map(dvXml).filter(Boolean);
    let pr = 1; const cfx = sh.cf.map(([sq, f, d]) => `<conditionalFormatting sqref="${sq}"><cfRule type="expression" dxfId="${d}" priority="${pr++}"><formula>${xml(f)}</formula></cfRule></conditionalFormatting>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${head}</sheetData>${cfx}<dataValidations count="${dvs.length}">${dvs.join('')}</dataValidations></worksheet>`;
  };
  const infoRows = [
    ['Import template' + (o.site ? ' - ' + o.site : ''), null], [null, null],
    ['Built for', `${o.site || 'this site'} on ${o.generated || ''}. Dropdowns, rigs, prospects and limits come from the site's current settings, so download it again after the admin changes them.`],
    ['Sheets', 'COLLAR, PROGRESS, DIST_HOUR, SURVEY, SAMPLE, ASSAY. Fill only what you need; empty sheets are skipped.'],
    ['Header colour', 'Dark blue = required. Light blue = optional. Do not rename sheets or headers.'],
    ['Cell rules', 'Excel refuses values the app would refuse: not in the list, out of range, future date, To not greater than From, unregistered hole, duplicate Hole ID or Sample No.'],
    ['Red cells', 'Rules a single cell cannot enforce are highlighted red: overlapping intervals or times, duplicate survey depth, required cell empty, downtime without reason, X without Y, status that needs as-built / total depth. Amber = warning (core longer than drilled, total depth over ' + Math.round(factor * 100) + '% of planned).'],
    ['Pasting', 'Pasting over cells skips the cell rules. The red highlighting still shows the problem, and the app checks every row again on import.'],
    ['Holes', `Progress, Survey, Sample and Assay rows need a hole that exists in the app (${holes.length} now) or in the COLLAR sheet of this file. Hole ID pattern: ${o.holePattern || '-'}.`],
    ['Coordinates', `UTM easting / northing in metres. Zone: ${o.utmZone ? o.utmZone + (o.utmHemi || '') : 'not set (assumed from existing data; set it under Settings > Parameter)'}.`],
    ['Dates / numbers', 'Dates as YYYY-MM-DD or an Excel date; time as HH:MM. Use a dot for decimals (19.6).'],
    ['Downtime', `0 to ${shiftH} hours per shift; a reason is needed when above 0.`],
    ['Assay', "Elements not listed here can be added as extra columns named like 'Al2O3 (%)'."],
    ['Duplicates', 'Rows that already exist (same hole ID, same interval, same sample no) are refused on import, not overwritten.'],
  ];
  const infoXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="100" customWidth="1"/></cols><sheetData>${infoRows.map((r, i) => `<row r="${i + 1}">${cell(r[0], i + 1, 0, i ? ST.bold : ST.title)}${cell(r[1], i + 1, 1, ST.wrap)}</row>`).join('')}</sheetData></worksheet>`;
  const maxLen = Math.max(...lcols.map(c => c.values.length), 0);
  const listXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[...Array(maxLen + 1).keys()].map(r => `<row r="${r + 1}">${lcols.map((c, i) => cell(r === 0 ? c.name : c.values[r - 1], r + 1, i, 0)).join('')}</row>`).join('')}</sheetData></worksheet>`;

  const order = ['COLLAR', 'PROGRESS', 'DIST_HOUR', 'SURVEY', 'SAMPLE', 'ASSAY'];
  const sheets = [{ name: 'INFO', xml: infoXml }, ...order.map(n => ({ name: n, xml: sheetXml(S[n]) })), { name: 'LISTS', xml: listXml, hidden: true }];
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="hh:mm"/></numFmts><fonts count="5"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FF0D47A1"/><name val="Arial"/></font><font><b/><sz val="14"/><color rgb="FF0F172A"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FF0F172A"/><name val="Arial"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1565C0"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF2FD"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="2"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf><dxf><font><color rgb="FF7A4F00"/></font><fill><patternFill><bgColor rgb="FFFFEB9C"/></patternFill></fill></dxf></dxfs></styleSheet>`;
  const n = sheets.length;
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', styles],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml]),
  ].map(([name, text]) => [name, enc.encode(text)]);
  return zip(files);
}
