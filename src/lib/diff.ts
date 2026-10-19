import { colorLabel } from './cards';
import type { Finish } from './types';
import { FINISH_LABEL } from './types';

/** Copies of one printing + finish, from either the imported list (expected) or the session (found). */
export interface Holding {
  printing_id: string;
  finish: Finish;
  qty: number;
  name: string;
  set_code: string;
  collector_number: string;
  colors: string;
  front_type: string;
}

export type DiffType = 'Missing' | 'Extra' | 'Wrong printing' | 'Wrong finish' | 'Not checked';

export interface DiffRow {
  type: DiffType;
  color: string;
  name: string;
  expected: string;
  found: string;
  /** Found minus expected. Wrong printing/finish rows carry the number of copies that were swapped. */
  qty_diff: number;
}

export const holdingLabel = (h: Pick<Holding, 'set_code' | 'collector_number' | 'finish'>) =>
  `[${h.set_code.toUpperCase()} ${h.collector_number}] ${FINISH_LABEL[h.finish]}`;

function total(list: Holding[]): Map<string, Holding> {
  const m = new Map<string, Holding>();
  for (const h of list) {
    const k = `${h.printing_id}|${h.finish}`;
    const cur = m.get(k);
    if (cur) cur.qty += h.qty;
    else m.set(k, { ...h });
  }
  return m;
}

/**
 * Compare total copies per printing + finish. Shortfalls and surpluses of the same card name are paired up as
 * "Wrong finish" (same printing) or "Wrong printing"; whatever is left over is Missing or Extra.
 */
export function verifyDiff(expected: Holding[], found: Holding[]): DiffRow[] {
  const exp = total(expected);
  const got = total(found);
  const missing: Holding[] = [];
  const extra: Holding[] = [];
  for (const k of new Set([...exp.keys(), ...got.keys()])) {
    const e = exp.get(k);
    const g = got.get(k);
    const delta = (g?.qty ?? 0) - (e?.qty ?? 0);
    if (delta < 0) missing.push({ ...e!, qty: -delta });
    if (delta > 0) extra.push({ ...g!, qty: delta });
  }

  const rows: DiffRow[] = [];
  const pair = (sameprinting: boolean) => {
    for (const m of missing) {
      for (const x of extra) {
        if (m.qty === 0) break;
        if (x.qty === 0 || x.name !== m.name || (x.printing_id === m.printing_id) !== sameprinting) continue;
        const n = Math.min(m.qty, x.qty);
        rows.push({
          type: sameprinting ? 'Wrong finish' : 'Wrong printing',
          color: colorLabel(m.colors, m.front_type),
          name: m.name,
          expected: holdingLabel(m),
          found: holdingLabel(x),
          qty_diff: n,
        });
        m.qty -= n;
        x.qty -= n;
      }
    }
  };
  pair(true);
  pair(false);

  for (const m of missing) {
    if (m.qty) rows.push({ type: 'Missing', color: colorLabel(m.colors, m.front_type), name: m.name, expected: holdingLabel(m), found: '', qty_diff: -m.qty });
  }
  for (const x of extra) {
    if (x.qty) rows.push({ type: 'Extra', color: colorLabel(x.colors, x.front_type), name: x.name, expected: '', found: holdingLabel(x), qty_diff: x.qty });
  }
  const order: Record<DiffType, number> = { 'Wrong printing': 0, 'Wrong finish': 1, Missing: 2, Extra: 3, 'Not checked': 4 };
  return rows.sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name));
}
