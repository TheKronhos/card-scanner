// Copies the Tesseract.js worker, wasm core and English model into public/ocr/ so OCR works offline
// (they are precached with the app instead of loaded from a CDN). Runs before dev and build.
import { copyFileSync, mkdirSync } from 'node:fs';

const out = new URL('../public/ocr/', import.meta.url);
mkdirSync(out, { recursive: true });
const nm = (p) => new URL(`../node_modules/${p}`, import.meta.url);
const files = {
  'worker.min.js': 'tesseract.js/dist/worker.min.js',
  // LSTM-only builds (we use the LSTM engine). Tesseract picks one by CPU support: relaxed SIMD (recent Chrome),
  // SIMD (Safari and older Chrome), or plain as a fallback. All three must ship.
  'tesseract-core-relaxedsimd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js': 'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'eng.traineddata.gz': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};
for (const [name, src] of Object.entries(files)) copyFileSync(nm(src), new URL(name, out));
console.log(`copied ${Object.keys(files).length} OCR files to public/ocr/`);
