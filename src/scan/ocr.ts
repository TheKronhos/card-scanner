import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { grayToRgba, type Gray } from './image';
import type { OcrFn } from './pipeline';

// Tesseract runs in its own web worker. All of its files ship with the app (public/ocr/), so OCR works offline.
const BASE = `${import.meta.env.BASE_URL}ocr/`;

let workerPromise: Promise<Worker> | null = null;

/** Start loading OCR early (e.g. when the camera opens) so the first capture isn't slow. */
export function warmUpOcr(): Promise<Worker> {
  workerPromise ??= createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: `${BASE}worker.min.js`,
    corePath: BASE,
    langPath: BASE,
    gzip: true,
    cacheMethod: 'none',
  }).catch((e) => {
    workerPromise = null;
    throw e;
  });
  return workerPromise;
}

function toCanvas(g: Gray): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = g.width;
  c.height = g.height;
  const rgba = grayToRgba(g);
  c.getContext('2d')!.putImageData(new ImageData(rgba.data as ImageDataArray, g.width, g.height), 0, 0);
  return c;
}

export const browserOcr: OcrFn = async (img, kind) => {
  const worker = await warmUpOcr();
  await worker.setParameters({
    tessedit_pageseg_mode: kind === 'name' ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: kind === 'collector' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-• ' : '',
  });
  const r = await worker.recognize(toCanvas(img), {}, { text: true, blocks: kind === 'collector' });
  const lines = (r.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text, ...l.bbox }))));
  return { text: r.data.text, confidence: r.data.confidence / 100, lines };
};
