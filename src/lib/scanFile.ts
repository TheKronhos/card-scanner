import { colorLabel } from './cards';
import { toCsv } from './csv';
import type { ScanRow } from './types';
import { FINISH_LABEL } from './types';

export const SCAN_FILE_HEADER = [
  'Scan #', 'Time', 'Color', 'Card', 'Set', 'Set name', 'Collector #', 'Finish', 'Condition', 'Scryfall ID', 'Price',
  'Confidence', 'Status', 'Flag reason', 'Top 3 candidates', 'Photo file',
];

export const scanNumber = (seq: number) => String(seq).padStart(4, '0');
export const photoPath = (seq: number) => `photos/${scanNumber(seq)}.jpg`;

/** Local date and time, e.g. "2026-10-19 21:43:05". */
export function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Whether a scan's photo goes in the ZIP: always for check/review cards and cards fixed by hand (so the photo stays
 * next to the correction), for every card when the setting is on.
 */
export function wantsPhoto(r: Pick<ScanRow, 'status' | 'fixed_by_hand'>, allPhotos: boolean): boolean {
  return allPhotos || r.status === 'check' || r.status === 'review' || r.fixed_by_hand;
}

/**
 * Card name and color for a review-queue row, which has no printing yet. Filled in only when every candidate agrees
 * (e.g. same card, unsure which printing); otherwise the name is blank and the color "Unknown".
 */
function reviewIdentity(r: ScanRow): { name: string; color: string } {
  const c = r.candidates;
  if (!c.length) return { name: '', color: 'Unknown' };
  const name = c.every((x) => x.name === c[0].name) ? c[0].name : '';
  const labels = new Set(c.map((x) => colorLabel(x.colors, x.front_type)));
  return { name, color: labels.size === 1 ? [...labels][0] : 'Unknown' };
}

/**
 * scan.csv for a "Just scan" session: one row per copy, in scan order. Extra copies of one entry are numbered
 * 0042-2, 0042-3... and share its photo. `hasPhoto` says which scans have a photo stored.
 */
export function scanFileCsv(rows: ScanRow[], hasPhoto: (scanId: number) => boolean, allPhotos: boolean): string {
  const out: (string | number | null)[][] = [SCAN_FILE_HEADER];
  const ordered = [...rows].sort((a, b) => a.seq - b.seq || a.id - b.id);
  for (const r of ordered) {
    const review = r.status === 'review' || !r.printing_id;
    const who = review ? reviewIdentity(r) : { name: r.name, color: colorLabel(r.colors, r.front_type) };
    const photo = hasPhoto(r.id) && wantsPhoto(r, allPhotos) ? photoPath(r.seq) : '';
    const candidates = r.candidates.slice(0, 3).map((c) => `${c.set_code.toUpperCase()} ${c.collector_number}`).join(' | ');
    const confidence = r.source === 'manual' ? 'Manual' : r.confidence == null ? '' : `${Math.round(r.confidence * 100)}%`;
    const flag = r.fixed_by_hand ? 'fixed by hand' : r.flag_reason;
    for (let copy = 1; copy <= r.qty; copy++) {
      out.push([
        copy === 1 ? scanNumber(r.seq) : `${scanNumber(r.seq)}-${copy}`,
        localTime(r.created_at),
        who.color,
        who.name,
        review ? '' : r.set_code.toUpperCase(),
        review ? '' : r.set_name,
        review ? '' : r.collector_number,
        FINISH_LABEL[r.finish],
        r.condition,
        review ? '' : r.printing_id,
        review || r.unit_price == null ? '' : r.unit_price.toFixed(2),
        confidence,
        review ? 'review' : r.status,
        flag,
        candidates,
        photo,
      ]);
    }
  }
  return toCsv(out);
}
