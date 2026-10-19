import { adaptiveBinarize, cropFraction, grayToRgba, sharpness, stretch, textBinarize, toGray, type Gray, type Rect, type Rgba } from './image';
import { findMarks, type Marks, type TextAnchor } from './marks';
import { parseCollector } from './parse';
import { ART_REGION, BOTTOM_REGION, COLLECTOR_REGION, COLLECTOR_WIDE, NAME_REGION, NAME_WIDE } from './regions';

export interface OcrLine {
  text: string;
  /** Line box in the OCR'd image's pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** OCR one prepared crop. Implemented with Tesseract.js in the browser and in tests. Lines are needed for 'collector'. */
export type OcrFn = (img: Gray, kind: 'name' | 'collector') => Promise<{ text: string; confidence: number; lines?: OcrLine[] }>;

/** Text height targets: Tesseract reads best around 30 px capitals. */
const NAME_H = 84;
const COLLECTOR_H = 240;

export interface Crops {
  card: Rgba;
  /** Name bar, black-and-white. */
  name: Gray;
  /** Further ways to read the name, tried in order when the first read is weak. */
  nameRetries: Gray[];
  /** Collector line, tried in order until one gives a set code and number. */
  collector: Gray[];
  /** The card region each collector image was cut from (to map OCR boxes back onto the card). */
  collectorRegions: Rect[];
  bottom: Gray;
  art: Rgba;
  /** Sharpness of the collector line, the smallest text we read. */
  sharpness: number;
}

/** Cut the name bar, collector line and art out of a straightened card image. */
export function prepareCrops(card: Rgba): Crops {
  const collectorGray = toGray(cropFraction(card, COLLECTOR_REGION, COLLECTOR_H));
  const nameGray = toGray(cropFraction(card, NAME_REGION, NAME_H));
  const collectorWide = toGray(cropFraction(card, COLLECTOR_WIDE, Math.round(COLLECTOR_H * 1.8)));
  return {
    card,
    name: textBinarize(nameGray),
    nameRetries: [stretch(nameGray), adaptiveBinarize(toGray(cropFraction(card, NAME_WIDE, Math.round(NAME_H * 2.1))))],
    collector: [textBinarize(collectorGray), adaptiveBinarize(collectorGray), adaptiveBinarize(collectorWide)],
    collectorRegions: [COLLECTOR_REGION, COLLECTOR_REGION, COLLECTOR_WIDE],
    bottom: textBinarize(toGray(cropFraction(card, BOTTOM_REGION, 120))),
    art: cropFraction(card, ART_REGION, 256),
    sharpness: sharpness(collectorGray),
  };
}

export interface OcrReadings {
  /** Name readings to try, best-looking first. */
  nameTexts: string[];
  collectorText: string;
  /** Bottom strip, read only when the collector box had no set code (older frames). */
  bottomText: string;
  marks: Marks;
  /** Which of the candidate crops was used (its card image is the one to save as the photo). */
  cropIndex: number;
  ms: number;
}

/** Below this OCR confidence the name is also read another way. */
const NAME_RETRY = 0.8;

const looksModern = (text: string) => /\b[A-Z0-9]{3,5}\s*[•·*.-]?\s*EN\b/.test(text.toUpperCase());

/**
 * Read the name and collector line, trying each candidate crop (see cutCard) and each way of preparing the text until
 * the collector line gives a real set code and number. Easy cards take two or three OCR calls; hard ones take more.
 */
export async function readCard(cropsList: Crops[], ocr: OcrFn, knownSets: Set<string>): Promise<OcrReadings> {
  const t0 = performance.now();
  const allNames: string[] = [];
  let fallback: Omit<OcrReadings, 'ms' | 'nameTexts'> | null = null;
  for (let i = 0; i < cropsList.length; i++) {
    const crops = cropsList[i];
    const name = await ocr(crops.name, 'name');
    allNames.push(name.text.trim());
    if (name.confidence < NAME_RETRY) {
      for (const g of crops.nameRetries) {
        const r = await ocr(g, 'name');
        allNames.push(r.text.trim());
        if (r.confidence >= NAME_RETRY) break;
      }
    }
    let collectorText = '';
    for (let k = 0; k < crops.collector.length; k++) {
      const g = crops.collector[k];
      const r = await ocr(g, 'collector');
      collectorText = r.text.trim();
      const info = parseCollector(collectorText, knownSets);
      if (info.set && info.numbers.length) {
        const anchor = textAnchor(r.lines ?? [], g, crops.collectorRegions[k]);
        const marks = findMarks(crops.card, anchor);
        return { nameTexts: dedupe(allNames), collectorText, bottomText: '', marks, cropIndex: i, ms: performance.now() - t0 };
      }
    }
    if (!fallback) {
      // Older frames print "146/249" on the copyright line instead.
      const bottomText = looksModern(collectorText) ? '' : (await ocr(crops.bottom, 'collector')).text.trim();
      fallback = { collectorText, bottomText, marks: { listBright: null }, cropIndex: i };
    }
  }
  return { nameTexts: dedupe(allNames), ...fallback!, ms: performance.now() - t0 };
}

const dedupe = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/**
 * Locate the collector info on the card from the OCR line boxes: the left edge of the line holding the number, and
 * the vertical span of that line and the one below it (set code + language).
 */
function textAnchor(lines: OcrLine[], img: Gray, region: Rect): TextAnchor | null {
  const withNumber = lines.findIndex((l) => /\d{2,}/.test(l.text) && l.x1 - l.x0 > img.width * 0.08);
  if (withNumber < 0) return null;
  const a = lines[withNumber];
  const b = lines[withNumber + 1];
  const toX = (px: number) => region.x + (px / img.width) * region.w;
  const toY = (py: number) => region.y + (py / img.height) * region.h;
  // The set-code line's left edge is where the text starts; the number line's box can stretch over the List symbol
  // (OCR reads it as a letter), so it's only used when there is no second line.
  const left = b ? b.x0 : a.x0;
  return { left: toX(left), top: toY(a.y0), bottom: toY(b ? b.y1 : a.y1 + (a.y1 - a.y0) * 1.2) };
}

export { grayToRgba };
