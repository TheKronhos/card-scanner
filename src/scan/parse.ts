// Turning raw OCR text from the collector line into set code, collector number, rarity and language.

export interface CollectorInfo {
  set: string | null; // lowercase Scryfall-style code as printed, e.g. "fdn"
  /** Readings of the collector number, most likely first, without leading zeros (e.g. ["62"], ["204p"]). */
  numbers: string[];
  rarity: string | null; // C U R M S L T P
  lang: string | null; // printed language code, e.g. "EN", "JP"
  /** True when the line looks like the 2015+ layout (set code printed). Older cards only print a number. */
  hasSetCode: boolean;
}

const LANGS = ['EN', 'ES', 'FR', 'DE', 'IT', 'PT', 'JP', 'JA', 'KO', 'RU', 'CS', 'CT', 'ZHS', 'ZHT', 'PH'];

/** Common OCR confusions inside a set code or number. */
const DIGIT_FIX: Record<string, string> = { O: '0', D: '0', Q: '0', I: '1', L: '1', '|': '1', Z: '2', S: '5', B: '8', G: '6' };

function fixDigits(s: string): string {
  return s.replace(/[ODQIL|ZSBG]/g, (c) => DIGIT_FIX[c] ?? c);
}

/**
 * Parse the collector line. `knownSets` (lowercase codes) lets us pick the set code out of noisy text: only tokens
 * that are real set codes count.
 */
export function parseCollector(text: string, knownSets: Set<string>): CollectorInfo {
  const clean = text.toUpperCase().replace(/[•·*°]/g, ' ').replace(/[^A-Z0-9/\-★ \n]/g, ' ');
  const tokens = clean.split(/[\s]+/).filter(Boolean);

  let set: string | null = null;
  let lang: string | null = null;
  // Set code misread like "OBL" for DBL: when the token sits right before a language code, try lookalike swaps and
  // accept only if exactly one real set code results.
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (!/^[A-Z0-9]{3,5}$/.test(t) || knownSets.has(t.toLowerCase()) || !LANGS.includes(tokens[i + 1])) continue;
    const fixed = lookalikeCodes(t).filter((c) => knownSets.has(c));
    if (fixed.length === 1) tokens[i] = fixed[0].toUpperCase();
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!set && /^[A-Z0-9]{3,5}$/.test(t) && /[A-Z]/.test(t) && knownSets.has(t.toLowerCase())) {
      set = t.toLowerCase();
      // The language code follows the set code: "FDN • EN".
      const next = tokens[i + 1];
      if (next && LANGS.includes(next)) lang = next;
      continue;
    }
    if (!lang && LANGS.includes(t) && set) lang = t;
  }

  // Collector number: digits (optionally with a letter suffix, e.g. "204p"), possibly "146/249". Prefer a token next to
  // a rarity letter ("C 0062", "146/249 R"). A trailing S/B/... could be a suffix or a misread digit, so every plausible
  // reading is returned and the card data decides.
  let numbers: string[] = [];
  let rarity: string | null = null;
  for (let i = 0; i < tokens.length && !numbers.length; i++) {
    const t = tokens[i];
    if (set && t.toLowerCase() === set) continue;
    const m = t.match(/^([0-9ODQILZSBG|]{1,4}[A-Z]?)(?:\/[0-9ODQILZSBG]{1,4})?$/);
    if (!m || !/[0-9]/.test(m[1])) continue;
    const strip = (x: string) => x.replace(/^0+(?=\d)/, '');
    const out = new Set<string>();
    const raw = m[1];
    // Trailing letter: a suffix ("204p", "123s") or a misread digit ("123S" for 1235). Offer both.
    if (raw.length > 1 && /[A-Z]$/.test(raw)) {
      const head = fixDigits(raw.slice(0, -1));
      if (/^\d+$/.test(head)) out.add(strip(head) + raw.slice(-1).toLowerCase());
    }
    const all = fixDigits(raw);
    if (/^\d+$/.test(all)) out.add(strip(all));
    if (!out.size) continue;
    numbers = [...out];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (prev && /^[CURMSLTP]$/.test(prev)) rarity = prev;
    else if (next && /^[CURMSLTP]$/.test(next)) rarity = next;
  }
  return { set, numbers, rarity, lang, hasSetCode: !!set };
}

const LOOKALIKE: Record<string, string[]> = {
  O: ['D', '0', 'Q'], D: ['O', '0'], '0': ['O', 'D'], Q: ['O'],
  I: ['L', '1', 'T'], L: ['I', '1'], '1': ['I', 'L'], T: ['I'],
  S: ['5'], '5': ['S'], B: ['8'], '8': ['B'], G: ['6', 'C'], '6': ['G'], C: ['G'], Z: ['2'], '2': ['Z'],
  M: ['N', 'W'], N: ['M'], W: ['M', 'V'], V: ['W', 'Y'], Y: ['V'],
};

/** Every code reachable by swapping up to two lookalike characters (lowercase). */
function lookalikeCodes(t: string): string[] {
  const out = new Set<string>();
  const chars = t.split('');
  for (let i = 0; i < chars.length; i++) {
    for (const a of LOOKALIKE[chars[i]] ?? []) {
      const one = [...chars];
      one[i] = a;
      out.add(one.join('').toLowerCase());
      for (let j = i + 1; j < chars.length; j++) {
        for (const b of LOOKALIKE[chars[j]] ?? []) {
          const two = [...one];
          two[j] = b;
          out.add(two.join('').toLowerCase());
        }
      }
    }
  }
  return [...out];
}

/** "146/249"-style numbers (2003–2014 frames print no set code). Returns readings without leading zeros. */
export function parseSlashNumber(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(/([0-9ODQIL]{1,4})\s*\/\s*[0-9ODQIL]{2,4}/g)) {
    const n = m[1].replace(/[ODQIL]/g, (c) => ({ O: '0', D: '0', Q: '0', I: '1', L: '1' })[c] ?? c).replace(/^0+(?=\d)/, '');
    if (/^\d+$/.test(n)) out.add(n);
  }
  return [...out];
}

/** Levenshtein distance, early exit when it exceeds `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** 1 = identical, 0 = nothing in common. */
export function similarity(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  if (!len) return 0;
  return 1 - editDistance(a, b) / len;
}
