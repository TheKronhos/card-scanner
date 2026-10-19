import { nameMatches } from './cards';
import { parseCsv } from './csv';
import type { Condition, Finish, Printing } from './types';

export interface ParsedRow {
  row_num: number; // 1-based line in the file, header = 1
  card_name: string;
  set_code: string;
  collector_number: string;
  finish_label: string;
  finish: Finish;
  qty: number;
  condition: Condition;
  /** Master's Colors column as written (e.g. "B/W"), used only when the row can't be matched to a printing. */
  colors: string;
  /** Set when the row can't be used at all (bad quantity etc.). */
  error: string;
}

export interface MatchedRow extends ParsedRow {
  printing: Printing | null;
  /** Why it didn't match, or a note about how it matched (e.g. a recovered collector number). */
  note: string;
}

const HEADERS: Record<keyof Pick<ParsedRow, 'card_name' | 'set_code' | 'collector_number' | 'finish_label' | 'qty' | 'condition' | 'colors'>, string[]> = {
  card_name: ['card name', 'name', 'card'],
  set_code: ['set code', 'set'],
  collector_number: ['collector #', 'collector number', 'collector no', 'collector no.', 'number', 'cn', '#'],
  finish_label: ['finish', 'foil'],
  qty: ['quantity', 'qty', 'count'],
  condition: ['condition', 'cond'],
  colors: ['colors', 'color'],
};

/**
 * Master writes finishes like "Borderless Foil" or "Promo". Anything ending in Etched is etched, anything ending in
 * Foil is foil, everything else is non-foil. The treatment words are labels only.
 */
export function finishFromLabel(label: string): Finish {
  const s = label.trim().toLowerCase();
  if (/etched$/.test(s)) return 'etched';
  if (/foil$/.test(s) && !/non-?foil$/.test(s)) return 'foil';
  return 'nonfoil';
}

const CONDITION_WORDS: Record<string, Condition> = {
  nm: 'NM', 'near mint': 'NM', near_mint: 'NM', m: 'NM', mint: 'NM',
  lp: 'LP', 'lightly played': 'LP', 'light played': 'LP', sp: 'LP', ex: 'LP', excellent: 'LP',
  mp: 'MP', 'moderately played': 'MP', played: 'MP', gd: 'MP', good: 'MP',
  hp: 'HP', 'heavily played': 'HP',
  dmg: 'DMG', damaged: 'DMG', poor: 'DMG', po: 'DMG',
};

export function parseCondition(s: string): Condition | null {
  const k = s.trim().toLowerCase();
  if (!k) return 'NM';
  return CONDITION_WORDS[k] ?? null;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Fatal problem with the file as a whole (missing columns). */
  error: string;
}

export function parseMasterCsv(text: string): ParseResult {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], error: 'The file is empty.' };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = {} as Record<keyof typeof HEADERS, number>;
  for (const [key, names] of Object.entries(HEADERS) as [keyof typeof HEADERS, string[]][]) {
    col[key] = header.findIndex((h) => names.includes(h));
  }
  const missing = (['card_name', 'set_code', 'collector_number'] as const).filter((k) => col[k] < 0);
  if (missing.length) {
    return { rows: [], error: `Missing column(s): ${missing.map((k) => HEADERS[k][0]).join(', ')}. Found: ${table[0].join(', ')}` };
  }
  const cell = (r: string[], k: keyof typeof HEADERS) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '');

  const rows = table.slice(1).map((r, i): ParsedRow => {
    const qtyText = cell(r, 'qty');
    const qty = qtyText === '' ? 1 : Number(qtyText);
    const condText = cell(r, 'condition');
    const condition = parseCondition(condText);
    const finish_label = cell(r, 'finish_label');
    let error = '';
    if (!Number.isInteger(qty) || qty < 1) error = `Quantity "${qtyText}" isn't a whole number of copies`;
    else if (!condition) error = `Unknown condition "${condText}"`;
    return {
      row_num: i + 2,
      card_name: cell(r, 'card_name'),
      set_code: cell(r, 'set_code'),
      collector_number: cell(r, 'collector_number'),
      finish_label,
      finish: finishFromLabel(finish_label),
      qty: error ? 0 : qty,
      condition: condition ?? 'NM',
      colors: cell(r, 'colors'),
      error,
    };
  });
  return { rows, error: '' };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Number parts of a cell that a spreadsheet may have turned into a date, or [] if it doesn't look like one. */
function dateParts(raw: string): number[] {
  const s = raw.trim().toLowerCase();
  // Spreadsheet serial day number (days since 1899-12-30), e.g. 45674.
  if (/^\d{5}(\.0+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    }
    return [];
  }
  const parts = s.split(/[-/. ]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return [];
  const nums: number[] = [];
  for (const p of parts) {
    const m = MONTHS.indexOf(p.slice(0, 3));
    if (/^\d+$/.test(p)) nums.push(Number(p));
    else if (m >= 0 && /^[a-z]+$/.test(p)) nums.push(m + 1);
    else return [];
  }
  // Only something a spreadsheet would show as a date: month names, or a year/month/day shape.
  const looksLikeDate = parts.some((p) => /^[a-z]+$/.test(p)) || parts.length === 3;
  return looksLikeDate ? nums : [];
}

/**
 * Collector numbers that could have produced this cell, e.g. "2025-17" stored as a date. Candidates are only
 * hints: the caller must confirm one against the set's real numbers and the card name.
 */
export function collectorNumberCandidates(raw: string): string[] {
  const out = new Set<string>();
  const s = raw.trim();
  if (/^0+\d/.test(s)) out.add(s.replace(/^0+(?=\d)/, ''));
  const nums = dateParts(s);
  const forms = (n: number) => {
    const f = [String(n), String(n).padStart(2, '0')];
    if (n >= 2000) f.push(String(n % 100).padStart(2, '0'));
    if (n < 100 && n >= 0) f.push(String(2000 + n));
    return f;
  };
  for (let i = 0; i < nums.length; i++) {
    for (let j = 0; j < nums.length; j++) {
      if (i === j) continue;
      for (const a of forms(nums[i])) for (const b of forms(nums[j])) out.add(`${a}-${b}`);
    }
  }
  out.delete(s);
  return [...out];
}

/** Printings with this set + collector number. Set codes are compared case-insensitively. */
export type Lookup = (setCode: string, collectorNumber: string) => Printing[];

/**
 * A printing that only exists in one finish is that finish, whatever the sheet's label says (e.g. a foil-only promo
 * labelled "Promo"). Otherwise the label decides.
 */
function settleFinish(m: MatchedRow): MatchedRow {
  const only = m.printing?.finishes.length === 1 ? m.printing.finishes[0] : null;
  if (!only || only === m.finish) return m;
  const label = m.finish_label || 'blank';
  const note = `Finish "${label}" read as ${m.finish}, but this printing only exists as ${only}; counted as ${only}`;
  return { ...m, finish: only, note: m.note ? `${m.note}. ${note}` : note };
}

/** Match parsed rows to printings. Never guesses: anything uncertain stays unmatched with a reason. */
export function matchRows(rows: ParsedRow[], lookup: Lookup): MatchedRow[] {
  return rows.map((r) => settleFinish(matchRow(r, lookup)));
}

function matchRow(r: ParsedRow, lookup: Lookup): MatchedRow {
  {
    if (r.error) return { ...r, printing: null, note: r.error };
    if (!r.set_code || !r.collector_number) return { ...r, printing: null, note: 'No set or collector number in the sheet' };
    if (!/^[a-z0-9]{2,6}$/i.test(r.set_code)) return { ...r, printing: null, note: `"${r.set_code}" isn't a set code` };

    const exact = lookup(r.set_code, r.collector_number);
    if (exact.length) {
      const hit = exact.find((p) => nameMatches(p, r.card_name));
      if (hit) return { ...r, printing: hit, note: '' };
      if (!r.card_name) return { ...r, printing: null, note: 'No card name in the sheet to check against' };
      return { ...r, printing: null, note: `${r.set_code.toUpperCase()} ${r.collector_number} is "${exact[0].name}", not "${r.card_name}"` };
    }

    const recovered: { num: string; p: Printing }[] = [];
    for (const num of collectorNumberCandidates(r.collector_number)) {
      for (const p of lookup(r.set_code, num)) if (nameMatches(p, r.card_name)) recovered.push({ num, p });
    }
    const unique = [...new Map(recovered.map((x) => [x.p.id, x])).values()];
    if (unique.length === 1) {
      const { num, p } = unique[0];
      return { ...r, collector_number: num, printing: p, note: `Collector number "${r.collector_number}" read as ${num}` };
    }
    if (unique.length > 1) {
      return { ...r, printing: null, note: `"${r.collector_number}" could be ${unique.map((x) => x.num).join(' or ')}` };
    }
    return { ...r, printing: null, note: `No printing ${r.set_code.toUpperCase()} ${r.collector_number} in the card data` };
  }
}
