// Runtime config: settings + code lists cached from the site's Supabase (editable in Admin tab).
// Falls back to config.js defaults until the first sync.
import * as D from './db.js';
import { DEFAULTS, DEFAULT_CODES } from './config.js';

let settings = { ...DEFAULTS };
let codeRows = null;

export async function loadCfg() {
  settings = { ...DEFAULTS };
  for (const r of await D.db.settings.toArray()) settings[r.key] = r.value;
  const rows = await D.db.codes.toArray();
  codeRows = rows.length ? rows : null;
}

export const setting = k => settings[k] ?? DEFAULTS[k];

function rowsOf(list) {
  if (codeRows) return codeRows.filter(r => r.list_code === list);
  return (DEFAULT_CODES[list] || []).map(r => ({ list_code: list, ...r }));
}

// Active codes of a list, sorted. `keep` = a code to include even if inactive (so old records still display).
export function codes(list, { keep } = {}) {
  return rowsOf(list)
    .filter(r => r.is_active || r.code === keep)
    .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
}
const find = (list, code) => rowsOf(list).find(r => r.code === code);
export const labelOf = (list, code) => find(list, code)?.label ?? code ?? '';
export const metaOf = (list, code) => find(list, code)?.meta ?? {};
export const codesWithFlag = (list, flag) => codes(list).filter(r => r.meta?.[flag]);

export function holeRegex() {
  try { return new RegExp(setting('hole_id_regex')); } catch { return new RegExp(DEFAULTS.hole_id_regex); }
}
