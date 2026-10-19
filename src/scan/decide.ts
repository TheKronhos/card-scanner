import { nameMatches } from '../lib/cards';
import type { Printing, ScanStatus } from '../lib/types';
import { parseCollector, parseSlashNumber, type CollectorInfo } from './parse';

export interface NameHit {
  oracle_id: string;
  name: string;
  /** 0..1 similarity between the OCR text and this name (or one of its faces). */
  score: number;
}

/** What the decision needs from the card data. */
export interface Lookups {
  knownSets: Set<string>;
  lookup(setCode: string, collectorNumber: string): Printing[];
  matchName(text: string, limit?: number): NameHit[];
  printingsOf(oracleId: string): Printing[];
}

export interface IdentifyInput {
  /** One or more OCR readings of the name; the best match wins. */
  nameTexts: string[];
  collectorText: string;
  bottomText?: string;
}

export interface Identification {
  status: ScanStatus;
  /** The printing to save; null when the card goes to the review queue. */
  printing: Printing | null;
  /** Best guesses, best first (up to 3), for the one-tap pick. */
  candidates: Printing[];
  confidence: number;
  flag: string;
  /** What was read, for display and debugging. */
  read: { name: NameHit | null; collector: CollectorInfo };
}

/** A name OCR match this good counts as a signal. */
export const NAME_OK = 0.82;
/** Below this the name isn't used even to suggest candidates. */
const NAME_HINT = 0.6;

const ART_PENDING = 'art match not available yet';

function uniqueById(list: Printing[]): Printing[] {
  return [...new Map(list.map((p) => [p.id, p])).values()];
}

/**
 * Other printings that look the same from the collector line: The List reprint ("PLST DMR-116" prints as DMR 116 plus a
 * planeswalker symbol) and stamped promos ("PDMU 107s"/"107p" print as DMU 107 plus a stamp). The card can't tell
 * them apart from the text, so they're flagged, never silently ignored.
 */
function lookalikes(p: Printing, L: Lookups): Printing[] {
  const set = p.set_code;
  const num = p.collector_number;
  return [
    ...L.lookup('plst', `${set.toUpperCase()}-${num}`),
    ...L.lookup(`p${set}`, `${num}s`),
    ...L.lookup(`p${set}`, `${num}p`),
  ].filter((x) => x.id !== p.id);
}

function result(
  status: ScanStatus,
  printing: Printing | null,
  candidates: Printing[],
  confidence: number,
  flags: string[],
  read: Identification['read'],
): Identification {
  const list = uniqueById(printing ? [printing, ...candidates] : candidates).slice(0, 3);
  return { status, printing, candidates: list, confidence: Math.max(0, Math.min(1, confidence)), flag: flags.filter(Boolean).join('; '), read };
}

/**
 * Decide what a captured card is. Signals: the name OCR and the collector line OCR (set + number). The third signal,
 * the art match, is not built yet, so a card where both agree is saved but marked "check" and never shown as green.
 * Anything that disagrees or can't be read goes to the review queue with its best candidates. Never guesses silently.
 */
export function identify(input: IdentifyInput, L: Lookups): Identification {
  const collector = parseCollector(input.collectorText, L.knownSets);
  if (!collector.set) {
    // Older frames: the number is printed as "146/249" elsewhere on the bottom line.
    const slash = parseSlashNumber(`${input.collectorText}\n${input.bottomText ?? ''}`);
    // A clean "146/249" reading beats stray digits from the copyright line ("1993-2009").
    if (slash.length) collector.numbers = slash;
  }
  const hits = input.nameTexts
    .filter((t) => t.trim().length >= 3)
    .flatMap((t) => L.matchName(t, 5))
    .sort((a, b) => b.score - a.score);
  const best = hits[0] && hits[0].score >= NAME_HINT ? hits[0] : null;
  const nameOk = !!best && best.score >= NAME_OK;
  const read = { name: best, collector };

  if (collector.lang && collector.lang !== 'EN') {
    const cands = best ? L.printingsOf(best.oracle_id) : [];
    return result('review', null, cands, 0.3, [`Non-English card (${collector.lang}); only English is supported for now`], read);
  }

  // 1. Set code + number on the card (2015+ layout).
  const byCollector = collector.set ? uniqueById(collector.numbers.flatMap((n) => L.lookup(collector.set!, n))) : [];
  if (byCollector.length) {
    const agree = nameOk ? byCollector.find((p) => nameMatches(p, best!.name)) : undefined;
    if (agree) {
      const alike = lookalikes(agree, L);
      const flags = [
        alike.some((p) => p.set_code === 'plst') ? 'could be The List (check for a planeswalker symbol)' : '',
        alike.some((p) => p.set_code !== 'plst') ? 'could be a stamped promo (check for a stamp)' : '',
        ART_PENDING,
      ];
      return result('check', agree, alike, 0.6 + best!.score * 0.3, ['Name and set/number agree', ...flags], read);
    }
    const others = best ? L.printingsOf(best.oracle_id).filter((p) => p.set_code === collector.set) : [];
    const why = !best ? 'Name unreadable' : !nameOk ? 'Name only partly readable' : 'Name and set/number disagree';
    return result('review', null, [...byCollector, ...others, ...(best ? L.printingsOf(best.oracle_id) : [])], 0.35, [why], read);
  }

  if (!best) {
    return result('review', null, [], 0.05, ["Couldn't read the name or the collector line"], read);
  }

  const printings = L.printingsOf(best.oracle_id);

  // 2. Set code read but the number didn't match: use set + name.
  if (collector.set) {
    const inSet = printings.filter((p) => p.set_code === collector.set);
    if (inSet.length === 1 && nameOk) {
      return result('check', inSet[0], [], 0.55, ['Matched by set and name; collector number unreadable', ART_PENDING], read);
    }
    return result('review', null, [...inSet, ...printings], 0.3, ['Collector number unreadable'], read);
  }

  // 3. No set code (older cards, or unreadable): name, plus the number if one was printed ("146/249").
  if (nameOk && printings.length === 1) {
    return result('check', printings[0], [], 0.6, ['Only one printing exists', ART_PENDING], read);
  }
  // A number without a set code isn't specific (stray digits from the copyright line match other printings), so a
  // name + number match is only offered first, never saved on its own.
  const byNumber = printings.filter((p) => collector.numbers.includes(p.collector_number));
  // Older frames first when no collector line was read at all.
  const oldFirst = collector.numbers.length ? printings : [...printings].sort((a, b) => Number(isOldFrame(b)) - Number(isOldFrame(a)));
  const flag = printings.length > 1 ? `${printings.length} printings of ${best.name}; pick the right one` : 'Name only partly readable';
  return result('review', null, [...byNumber, ...oldFirst], best.score * 0.4, [flag], read);
}

const isOldFrame = (p: Printing) => p.frame === '1993' || p.frame === '1997';
