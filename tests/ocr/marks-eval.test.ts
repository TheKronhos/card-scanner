// Calibration check for the List symbol detector (located from the OCR'd collector text). Run with
//   STAMPS=/dir npx vitest run tests/ocr/marks-eval
// Files are named kind__set_number.jpg with kind = list | reg (others are ignored).
import { readdirSync, readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { createWorker, OEM, PSM } from 'tesseract.js';
import { expect, it } from 'vitest';
import { grayToRgba, resampleRgba } from '../../src/scan/image';
import { LIST_NO, LIST_YES } from '../../src/scan/marks';
import { prepareCrops, readCard, type OcrFn } from '../../src/scan/pipeline';

it.skipIf(!process.env.STAMPS)('List symbol separates List from regular printings', async () => {
  const dir = process.env.STAMPS!;
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    langPath: new URL('../../node_modules/@tesseract.js-data/eng/4.0.0_best_int', import.meta.url).pathname,
    gzip: true,
    cacheMethod: 'none',
  });
  const ocr: OcrFn = async (g, kind) => {
    await worker.setParameters({
      tessedit_pageseg_mode: kind === 'name' ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: kind === 'collector' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-• ' : '',
    });
    const rgba = grayToRgba(g);
    const r = await worker.recognize(jpeg.encode({ width: rgba.width, height: rgba.height, data: Buffer.from(rgba.data.buffer) }, 95).data, {}, { text: true, blocks: kind === 'collector' });
    const lines = (r.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text, ...l.bbox }))));
    return { text: r.data.text, confidence: r.data.confidence / 100, lines };
  };
  const sets = new Set(['afr', 'blb', 'c21', 'cmm', 'emn', 'fdn', 'fut', 'kld', 'm14', 'ori', 'shm', 'uds', 'vis', 'xln', 'cm2', 'znr']);
  const tally: Record<string, number> = {};
  const rows: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /^(list|reg)__.*\.jpg$/.test(x)).sort()) {
    const kind = f.split('__')[0];
    const r = jpeg.decode(readFileSync(`${dir}/${f}`), { useTArray: true });
    const img = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data.buffer) };
    const out = await readCard([prepareCrops(resampleRgba(img, { x: 0, y: 0, w: img.width, h: img.height }, 744, 1039))], ocr, sets);
    const b = out.marks.listBright;
    const verdict = b == null ? 'unlocated' : b >= LIST_YES ? 'yes' : b <= LIST_NO ? 'no' : '?';
    const oldFrame = /(m14|shm|fut|uds|vis)/i.test(f);
    const key = `${kind}${oldFrame ? ' (old frame)' : ''}: ${verdict}`;
    tally[key] = (tally[key] ?? 0) + 1;
    rows.push(`${f.padEnd(32)} ${b?.toFixed(2) ?? '-'}`);
  }
  await worker.terminate();
  console.log(`${rows.join('\n')}\n${JSON.stringify(tally, null, 1)}`);
  // Never a "yes" on a modern-frame regular printing.
  expect(tally['reg: yes'] ?? 0).toBe(0);
}, 600_000);
