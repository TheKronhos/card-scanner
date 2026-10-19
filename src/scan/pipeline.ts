import { cropFraction, grayToRgba, sharpness, stretch, textBinarize, toGray, type Gray, type Rgba } from './image';
import { ART_REGION, BOTTOM_REGION, COLLECTOR_REGION, NAME_REGION } from './regions';

/** OCR one prepared crop. Implemented with Tesseract.js in the browser and in tests. */
export type OcrFn = (img: Gray, kind: 'name' | 'collector') => Promise<{ text: string; confidence: number }>;

export interface Crops {
  name: Gray;
  /** Grayscale version of the name, for old frames where black-and-white loses the letters. */
  nameGray: Gray;
  collector: Gray;
  bottom: Gray;
  art: Rgba;
  /** Sharpness of the collector line, the smallest text we read. */
  sharpness: number;
}

/** Text height targets: Tesseract reads best around 30 px capitals. */
const NAME_H = 84;
const COLLECTOR_H = 240;

/** Cut the name bar, collector line and art out of a straightened card image. */
export function prepareCrops(card: Rgba): Crops {
  const collectorGray = toGray(cropFraction(card, COLLECTOR_REGION, COLLECTOR_H));
  const nameGray = toGray(cropFraction(card, NAME_REGION, NAME_H));
  return {
    name: textBinarize(nameGray),
    nameGray: stretch(nameGray),
    collector: textBinarize(collectorGray),
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
  ms: number;
}

/** Below this OCR confidence the name is also read from the grayscale crop. */
const NAME_RETRY = 0.8;

export async function readCard(crops: Crops, ocr: OcrFn): Promise<OcrReadings> {
  const t0 = performance.now();
  const name = await ocr(crops.name, 'name');
  const nameTexts = [name.text.trim()];
  if (name.confidence < NAME_RETRY) nameTexts.push((await ocr(crops.nameGray, 'name')).text.trim());
  const collector = await ocr(crops.collector, 'collector');
  // A 2015+ collector line has a 3–5 letter set code followed by a language code; without one, try the bottom strip.
  const looksModern = /\b[A-Z0-9]{3,5}\s*[•·*.-]?\s*EN\b/.test(collector.text.toUpperCase());
  const bottomText = looksModern ? '' : (await ocr(crops.bottom, 'collector')).text.trim();
  return { nameTexts: nameTexts.filter(Boolean), collectorText: collector.text.trim(), bottomText, ms: performance.now() - t0 };
}

export { grayToRgba };
