// Accuracy on real scans: runs the recognition pipeline on the straightened photos from a Scan file export and
// compares with a hand-checked answer key. Not part of `npm test`:
//   CARDS_DB=/path/cards.sqlite3 KEY=/path/Scan_Answer_Key.csv PHOTOS=/path/unzipped-scan-file npx vitest run tests/ocr/answer-key
// KEY columns: Scan #, Photo file, Correct card, Correct set, Correct collector #, ...
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { parseCsv } from '../../src/lib/csv';
import { Repo, migrateUserDb } from '../../src/db/repo';
import { grayToRgba, resampleRgba, type Gray, type Rgba } from '../../src/scan/image';
import { CARD_H, CARD_W } from '../../src/scan/regions';
import { prepareCrops, readCard, type OcrFn } from '../../src/scan/pipeline';

const { CARDS_DB: DB, KEY, PHOTOS, REPORT, DUMP } = process.env;

describe.skipIf(!DB || !KEY || !PHOTOS)('answer key', () => {
  let repo: Repo;
  let worker: Awaited<ReturnType<typeof createWorker>>;

  beforeAll(async () => {
    const s = await sqlite3InitModule();
    s.capi.sqlite3_js_posix_create_file('full3.db', new Uint8Array(readFileSync(DB!)));
    const user = new s.oo1.DB(':memory:', 'c');
    migrateUserDb(user);
    repo = new Repo(user, new s.oo1.DB('full3.db', 'r'));
    worker = await createWorker('eng', OEM.LSTM_ONLY, {
      langPath: new URL('../../node_modules/@tesseract.js-data/eng/4.0.0_best_int', import.meta.url).pathname,
      gzip: true,
      cacheMethod: 'none',
    });
  }, 60_000);
  afterAll(async () => worker?.terminate());

  it('scores every scan', async () => {
    const ocr: OcrFn = async (g: Gray, kind) => {
      await worker.setParameters({
        tessedit_pageseg_mode: kind === 'name' ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
        tessedit_char_whitelist: kind === 'collector' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-• ' : '',
      });
      const rgba = grayToRgba(g);
      const r = await worker.recognize(jpeg.encode({ width: rgba.width, height: rgba.height, data: Buffer.from(rgba.data.buffer) }, 95).data, {}, { text: true, blocks: kind === 'collector' });
      const lines = (r.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text, ...l.bbox }))));
      return { text: r.data.text, confidence: r.data.confidence / 100, lines };
    };

    const table = parseCsv(readFileSync(KEY!, 'utf8'));
    const col = (name: string) => table[0].indexOf(name);
    const tally: Record<string, number> = {};
    const lines: string[] = [];
    for (const row of table.slice(1)) {
      const file = `${PHOTOS}/${row[col('Photo file')]}`;
      if (!existsSync(file)) continue;
      const set = row[col('Correct set')].toLowerCase();
      const num = row[col('Correct collector #')];
      const expected = repo.lookup(set, num)[0];
      const raw = jpeg.decode(readFileSync(file), { useTArray: true });
      const img: Rgba = { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data.buffer) };
      const card = resampleRgba(img, { x: 0, y: 0, w: img.width, h: img.height }, CARD_W, CARD_H);
      const crops = prepareCrops(card);
      if (DUMP) {
        for (const [k, gr] of [['name', crops.name], ['collector', crops.collector[0]], ['bottom', crops.bottom]] as const) {
          const g = grayToRgba(gr);
          writeFileSync(`${DUMP}/${row[0]}.${k}.jpg`, jpeg.encode({ width: g.width, height: g.height, data: Buffer.from(g.data.buffer) }, 90).data);
        }
      }
      const r = await readCard([crops], ocr, repo.setCodes());
      const id = repo.identify(r);
      const nameRight = id.read.name?.name === expected?.name;
      const verdict = !expected
        ? 'no-such-printing'
        : id.printing
          ? id.printing.id === expected.id
            ? `saved-right-${id.status}`
            : `SAVED-WRONG-${id.status}`
          : id.candidates.some((c) => c.id === expected.id)
            ? 'review-in-top3'
            : nameRight
              ? 'review-right-name'
              : id.read.name
                ? 'review-wrong-name'
                : 'review-unreadable';
      tally[verdict] = (tally[verdict] ?? 0) + 1;
      lines.push(
        `${row[0]} ${verdict.padEnd(22)} ${(expected ? `${expected.name} [${set.toUpperCase()} ${num}]` : `${set} ${num}`).slice(0, 48).padEnd(48)} ` +
          `name="${r.nameTexts.join(' ~ ')}" coll="${r.collectorText.replace(/\n/g, ' | ')}"${r.bottomText ? ` bottom="${r.bottomText.replace(/\n/g, ' | ')}"` : ''} ` +
          `-> ${id.read.collector.set ?? '-'} ${id.read.collector.numbers.join('/') || '-'} ${Math.round(r.ms)}ms`,
      );
    }
    const summary = Object.entries(tally).sort().map(([k, v]) => `${k}: ${v}`).join('\n');
    const out = `${lines.join('\n')}\n\n${summary}\n`;
    console.log(out);
    if (REPORT) writeFileSync(REPORT, out);
  }, 900_000);
});
