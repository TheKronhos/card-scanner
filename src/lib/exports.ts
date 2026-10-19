import { colorLabel } from './cards';
import { csvField, toCsv } from './csv';
import type { Condition, Finish, ScanRow } from './types';
import { FINISH_LABEL } from './types';
import type { DiffRow } from './diff';

const SET = (code: string) => code.toUpperCase();

/** "Card Name [SET NUM]" plus " Foil" or " Etched". */
export function masterLine(name: string, setCode: string, num: string, finish: Finish): string {
  const tag = finish === 'foil' ? ' Foil' : finish === 'etched' ? ' Etched' : '';
  return `${name} [${SET(setCode)} ${num}]${tag}`;
}

/** Only scans that are saved (green or yellow) go into exports; review-queue scans have no printing yet. */
const exportable = (rows: ScanRow[]) => rows.filter((r) => r.status !== 'review' && r.printing_id);

/** Export 1: one column, no header, one row per copy. */
export function masterPasteCsv(rows: ScanRow[]): string {
  const lines: string[] = [];
  for (const r of exportable(rows)) {
    const line = csvField(masterLine(r.name, r.set_code, r.collector_number, r.finish));
    for (let i = 0; i < r.qty; i++) lines.push(line);
  }
  return lines.map((l) => l + '\r\n').join('');
}

const money = (v: number | null) => (v == null ? '' : v.toFixed(2));

function confidenceText(r: ScanRow): string {
  if (r.source === 'manual') return 'Manual';
  return r.confidence == null ? '' : `${Math.round(r.confidence * 100)}%`;
}

/** Export 2: the review sheet. Color is always filled in. */
export function reviewCsv(rows: ScanRow[]): string {
  const header = ['Color', 'Card', 'Set', 'Set name', 'Collector #', 'Finish', 'Condition', 'Qty', 'Price', 'Scryfall ID', 'Confidence', 'Flag reason'];
  return toCsv([
    header,
    ...exportable(rows).map((r) => [
      colorLabel(r.colors, r.front_type),
      r.name,
      SET(r.set_code),
      r.set_name,
      r.collector_number,
      FINISH_LABEL[r.finish],
      r.condition,
      r.qty,
      money(r.unit_price),
      r.printing_id,
      confidenceText(r),
      r.flag_reason,
    ]),
  ]);
}

// ManaBox uses Cardmarket-style grades; this maps the five TCGplayer-style grades onto them.
const MANABOX_CONDITION: Record<Condition, string> = {
  NM: 'near_mint',
  LP: 'excellent',
  MP: 'good',
  HP: 'played',
  DMG: 'poor',
};
const MANABOX_FOIL: Record<Finish, string> = { nonfoil: 'normal', foil: 'foil', etched: 'etched' };

/** Export 3: ManaBox import format. */
export function manaboxCsv(rows: ScanRow[]): string {
  const header = ['Name', 'Set code', 'Set name', 'Collector number', 'Foil', 'Rarity', 'Quantity', 'Scryfall ID', 'Condition', 'Language'];
  return toCsv([
    header,
    ...exportable(rows).map((r) => [
      r.name,
      SET(r.set_code),
      r.set_name,
      r.collector_number,
      MANABOX_FOIL[r.finish],
      r.rarity,
      r.qty,
      r.printing_id,
      MANABOX_CONDITION[r.condition],
      'en',
    ]),
  ]);
}

/** Signed for Missing/Extra, plain count of swapped copies for Wrong printing/finish, blank when not compared. */
function diffQty(d: DiffRow): string {
  if (d.type === 'Not checked') return '';
  if (d.type === 'Missing' || d.type === 'Extra') return d.qty_diff > 0 ? `+${d.qty_diff}` : String(d.qty_diff);
  return String(d.qty_diff);
}

/** Verify-session export: only the differences from the imported list. */
export function differencesCsv(rows: DiffRow[]): string {
  return toCsv([
    ['Type', 'Color', 'Card', 'Expected', 'Found', 'Qty difference'],
    ...rows.map((d) => [d.type, d.color, d.name, d.expected, d.found, diffQty(d)]),
  ]);
}
