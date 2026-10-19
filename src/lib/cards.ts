import type { Finish, FoilMode, Printing } from './types';

const COLOR_WORD: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const WUBRG = ['W', 'U', 'B', 'R', 'G'];

/**
 * The Color column, matching the tracker: White, Blue, Black, Red, Green, "Multicolor (W/U)" in WUBRG order,
 * Colorless, or Land for colorless lands. Never empty.
 */
export function colorLabel(colors: string, frontType: string): string {
  const letters = WUBRG.filter((c) => colors.includes(c));
  if (letters.length === 1) return COLOR_WORD[letters[0]];
  if (letters.length > 1) return `Multicolor (${letters.join('/')})`;
  return /\bLand\b/.test(frontType) ? 'Land' : 'Colorless';
}

/**
 * Color label for a row that isn't matched to a printing, from Master's Colors column ("B", "B/W", "C", "L", or
 * already a word). Never empty: falls back to "Unknown".
 */
export function masterColorLabel(raw: string): string {
  const s = raw.trim();
  if (!s) return 'Unknown';
  if (/^(white|blue|black|red|green|colorless|land|multicolor.*)$/i.test(s)) return s;
  const parts = s.toUpperCase().split(/[\s/,]+/).filter(Boolean);
  if (parts.length === 1 && (parts[0] === 'L' || parts[0] === 'LAND')) return 'Land';
  if (parts.length === 1 && (parts[0] === 'C' || parts[0] === 'COLORLESS')) return 'Colorless';
  const letters = parts.join('');
  if (/^[WUBRG]+$/.test(letters)) return colorLabel(letters, '');
  return s;
}

/** Lowercase, accents stripped, punctuation collapsed. Same as normName in the data pack builder. */
export function normName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if a name from a sheet or OCR refers to this printing: full name, or any face name. */
export function nameMatches(p: Pick<Printing, 'name' | 'face_names'>, name: string): boolean {
  const n = normName(name);
  if (!n) return false;
  const options = [p.name, ...(p.face_names ?? []), ...p.name.split(' // ')].map(normName);
  return options.includes(n) || options.includes(normName(name.split('//')[0]));
}

export function priceFor(p: Pick<Printing, 'usd' | 'usd_foil' | 'usd_etched'>, finish: Finish): number | null {
  return finish === 'etched' ? p.usd_etched : finish === 'foil' ? p.usd_foil : p.usd;
}

export interface FinishChoice {
  /** null means ask the user (Ask-each-card mode and more than one finish exists). */
  finish: Finish | null;
  flag: string;
}

/**
 * Finish for a newly added card. Foil sessions save every card as foil (etched if that's the only foil kind);
 * a printing that only exists in one finish always gets that finish.
 */
export function chooseFinish(finishes: Finish[], mode: FoilMode): FinishChoice {
  if (finishes.length === 0) return { finish: 'nonfoil', flag: '' };
  const noFoilFlag = mode === 'foil' && !finishes.some((f) => f !== 'nonfoil') ? 'Foil session, but this printing has no foil version' : '';
  if (finishes.length === 1) return { finish: finishes[0], flag: noFoilFlag };
  if (mode === 'ask') return { finish: null, flag: '' };
  if (mode === 'nonfoil') {
    if (finishes.includes('nonfoil')) return { finish: 'nonfoil', flag: '' };
    return { finish: finishes.includes('foil') ? 'foil' : 'etched', flag: '' };
  }
  if (finishes.includes('foil')) return { finish: 'foil', flag: '' };
  return { finish: 'etched', flag: '' };
}

/** Flag when a saved finish doesn't fit the session mode (e.g. a foil-only printing in a non-foil session). */
export function sessionFinishFlag(finish: Finish, finishes: Finish[], mode: FoilMode): string {
  if (finishes.length === 1) return mode === 'foil' && finish === 'nonfoil' ? 'Foil session, but this printing has no foil version' : '';
  if (mode === 'foil' && finish === 'nonfoil') return 'Non-foil card in a foil session';
  if (mode === 'nonfoil' && finish !== 'nonfoil') return 'Foil card in a non-foil session';
  return '';
}

export type ImageSize = 'small' | 'normal' | 'large' | 'art_crop';

/** Scryfall image URL rebuilt from the printing id and image version stored in the pack. */
export function imageUrl(id: string, ver: string | null, size: ImageSize = 'small', back = false): string | null {
  if (!ver) return null;
  return `https://cards.scryfall.io/${size}/${back ? 'back' : 'front'}/${id[0]}/${id[1]}/${id}.jpg?${ver}`;
}

export function formatUsd(v: number | null): string {
  return v == null ? '—' : `$${v.toFixed(2)}`;
}
