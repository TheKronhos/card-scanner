// Recognition on card images, against the full card database. Not part of `npm test`: run with
//   CARDS_DB=/path/cards.sqlite3 IMAGES=/path/dir npx vitest run tests/ocr
// Images are named like "fdn_62.jpg" (set_number.jpg) and are assumed to be straightened card images.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Repo, migrateUserDb } from '../../src/db/repo';
import { cutCard, resampleRgba, grayToRgba, type Gray, type Rgba } from '../../src/scan/image';
import { CARD_H, CARD_W } from '../../src/scan/regions';
import { prepareCrops, readCard, type OcrFn } from '../../src/scan/pipeline';

const DB = process.env.CARDS_DB;
const DIR = process.env.IMAGES;
const DUMP = process.env.DUMP; // optional: directory to write the OCR crops to
// SIMULATE=1: place each card in a fake 1080×1920 camera frame (offset, smaller, on a table, slightly blurred and noisy)
// and cut it out with the same code the camera uses, instead of treating the image as already straightened.
const SIMULATE = process.env.SIMULATE === '1';

function fakeFrame(card: Rgba, seed: number): { frame: Rgba; guide: { x: number; y: number; w: number; h: number } } {
  const W = 1080;
  const H = 1920;
  const guide = { x: (W - 860) / 2, y: (H - 1201) / 2, w: 860, h: 1201 };
  // The card sits a bit off the guide and a bit smaller, like a real placement.
  const rnd = (n: number) => ((Math.sin(seed * 999 + n) + 1) / 2);
  const ch = Math.round(1201 * (0.9 + rnd(1) * 0.06));
  const cw = Math.round(ch * (63 / 88));
  const cx = Math.round(guide.x + (guide.w - cw) / 2 + (rnd(2) - 0.5) * 50);
  const cy = Math.round(guide.y + (guide.h - ch) / 2 + (rnd(3) - 0.5) * 50);
  // Soften the card first (camera blur), then paste.
  const soft = resampleRgba(resampleRgba(card, { x: 0, y: 0, w: card.width, h: card.height }, Math.round(cw * 0.7), Math.round(ch * 0.7)), { x: 0, y: 0, w: Math.round(cw * 0.7), h: Math.round(ch * 0.7) }, cw, ch);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inCard = x >= cx && x < cx + cw && y >= cy && y < cy + ch;
      const noise = (((x * 7919 + y * 104729 + seed) % 17) - 8) * 1.2;
      if (inCard) {
        const j = ((y - cy) * cw + (x - cx)) * 4;
        for (let k = 0; k < 3; k++) data[i + k] = soft.data[j + k] * 0.92 + 10 + noise;
      } else {
        data[i] = 120 + noise;
        data[i + 1] = 105 + noise;
        data[i + 2] = 90 + noise;
      }
      data[i + 3] = 255;
    }
  }
  return { frame: { width: W, height: H, data }, guide };
}

describe.skipIf(!DB || !DIR)('recognition on images', () => {
  let repo: Repo;
  let worker: Awaited<ReturnType<typeof createWorker>>;

  beforeAll(async () => {
    const s = await sqlite3InitModule();
    s.capi.sqlite3_js_posix_create_file('full.db', new Uint8Array(readFileSync(DB!)));
    const user = new s.oo1.DB(':memory:', 'c');
    migrateUserDb(user);
    repo = new Repo(user, new s.oo1.DB('full.db', 'r'));
    worker = await createWorker('eng', OEM.LSTM_ONLY, {
      langPath: new URL('../../node_modules/@tesseract.js-data/eng/4.0.0_best_int', import.meta.url).pathname,
      gzip: true,
    });
  }, 60_000);
  afterAll(async () => worker?.terminate());

  it('reads every image', async () => {
    const ocr: OcrFn = async (g: Gray, kind) => {
      await worker.setParameters({
        tessedit_pageseg_mode: kind === 'name' ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
        tessedit_char_whitelist: kind === 'collector' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-• ' : '',
      });
      const rgba = grayToRgba(g);
      const buf = jpeg.encode({ width: rgba.width, height: rgba.height, data: Buffer.from(rgba.data.buffer) }, 95).data;
      const r = await worker.recognize(buf);
      return { text: r.data.text, confidence: r.data.confidence / 100 };
    };
    const rows: string[] = [];
    let ok = 0;
    let total = 0;
    for (const f of readdirSync(DIR!).filter((x) => /\.jpe?g$/i.test(x)).sort()) {
      const raw = jpeg.decode(readFileSync(`${DIR}/${f}`), { useTArray: true });
      const img: Rgba = { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data.buffer) };
      let card: Rgba;
      let edgeNote = '';
      if (SIMULATE) {
        const { frame, guide } = fakeFrame(img, total + 1);
        const cut = cutCard(frame, guide, CARD_W, CARD_H);
        card = cut.card;
        edgeNote = cut.edgesFound ? 'edges' : 'NO-EDGES';
      } else {
        card = resampleRgba(img, { x: 0, y: 0, w: img.width, h: img.height }, CARD_W, CARD_H);
      }
      const crops = prepareCrops(card);
      if (DUMP) {
        for (const k of ['name', 'collector'] as const) {
          const rgba = grayToRgba(crops[k]);
          writeFileSync(`${DUMP}/${f}.${k}.jpg`, jpeg.encode({ width: rgba.width, height: rgba.height, data: Buffer.from(rgba.data.buffer) }, 90).data);
        }
      }
      const r = await readCard(crops, ocr);
      const id = repo.identify(r);
      const [es, en] = f.replace(/\.jpe?g$/i, '').split(/_(.+)/);
      const expected = repo.lookup(es, en)[0];
      const right = id.printing?.id === expected?.id;
      const inCands = id.candidates.some((c) => c.id === expected?.id);
      total++;
      if (right) ok++;
      rows.push(
        `${f.padEnd(20)} ${id.status.padEnd(6)} ${right ? 'RIGHT' : id.printing ? 'WRONG' : inCands ? 'in-cands' : 'missed'}  ` +
          `name="${r.nameTexts.join(" ~ ")}" (${id.read.name?.name ?? '-'} ${id.read.name?.score.toFixed(2) ?? ''})  ` +
          `coll="${r.collectorText.replace(/\n/g, ' | ')}" -> ${id.read.collector.set ?? '-'} ${id.read.collector.numbers.join('/') || '-'}  ` +
          `${Math.round(r.ms)}ms sharp=${Math.round(crops.sharpness)} ${edgeNote}  ${id.flag}`,
      );
    }
    console.log(`\n${rows.join('\n')}\n${ok}/${total} exact printing\n`);
    if (process.env.REPORT) writeFileSync(process.env.REPORT, `${rows.join('\n')}\n${ok}/${total} exact printing\n`);
  }, 300_000);
});
