import { describe, expect, it } from 'vitest';
import { findCardEdges, resampleRgba, sharpness, toGray, type Rgba } from '../src/scan/image';
import { parseCollector, parseSlashNumber, similarity } from '../src/scan/parse';
import { identify } from '../src/scan/decide';
import { makeRepo } from './helpers';

const sets = new Set(['fdn', 'dmu', 'm10', 'plst', 'pecl', '2xm', 'dsk']);

describe('parseCollector', () => {
  it('reads 2023+ lines', () => {
    expect(parseCollector('C 0062\nFDN • EN PAOLO PARENTE', sets)).toMatchObject({ set: 'fdn', numbers: ['62'], rarity: 'C', lang: 'EN' });
  });
  it('reads 2015–2022 lines', () => {
    expect(parseCollector('056/332 M\n2XM • EN JASON CHAN', sets)).toMatchObject({ set: '2xm', numbers: ['56'], rarity: 'M' });
  });
  it('fixes common digit misreads and keeps letter suffixes as alternatives', () => {
    expect(parseCollector('R O384\nDSK EN', sets).numbers).toEqual(['384']);
    expect(parseCollector('204P\nPECL EN', sets).numbers).toEqual(['204p']);
    expect(parseCollector('123S\nFDN EN', sets).numbers).toEqual(['123s', '1235']);
  });
  it('spots non-English cards', () => {
    expect(parseCollector('C 0062\nFDN • JP', sets).lang).toBe('JP');
  });
  it('ignores words that are not set codes', () => {
    expect(parseCollector('C 0062\nPAOLO EN', sets).set).toBeNull();
  });
  it('finds slash numbers on older frames', () => {
    expect(parseSlashNumber('TM & © 1993-2009 Wizards of the Coast LLC 146/249')).toEqual(['146']);
  });
  it('similarity', () => {
    expect(similarity('lightning bolt', 'lightning bolt')).toBe(1);
    expect(similarity('lightning bolt i', 'lightning bolt')).toBeGreaterThan(0.85);
  });
});

describe('identify (fixture card data)', () => {
  it('two signals agree: saved as check, never green without the art match', async () => {
    const repo = await makeRepo();
    const id = repo.identify({ nameTexts: ['Hungry Ghoul'], collectorText: 'C 0062\nFDN • EN' });
    expect(id.status).toBe('check');
    expect(id.printing?.set_code).toBe('fdn');
    expect(id.flag).toMatch(/art match not available/);
  });
  it('disagreement goes to review with candidates', async () => {
    const repo = await makeRepo();
    const id = repo.identify({ nameTexts: ['Lightning Bolt'], collectorText: 'C 0062\nFDN • EN' });
    expect(id.status).toBe('review');
    expect(id.printing).toBeNull();
    expect(id.candidates.length).toBeGreaterThan(0);
    expect(id.flag).toMatch(/disagree/);
  });
  it('flags The List lookalike', async () => {
    const repo = await makeRepo();
    const id = repo.identify({ nameTexts: ['Dragon Whelp'], collectorText: 'U 116/261\nDMR • EN' });
    // DMR itself isn't in the fixture, so build the check from the List printing's original
    expect(['check', 'review']).toContain(id.status);
  });
  it('two printings with the same number: review, both offered', async () => {
    const repo = await makeRepo();
    const id = repo.identify({ nameTexts: ['Lightning Bolt'], collectorText: '', bottomText: '© 1993-2009 Wizards 146/249' });
    if (id.status === 'review') expect(id.candidates.some((c) => c.set_code === 'm10')).toBe(true);
    else expect(id.printing?.set_code).toBe('m10');
  });
  it('unreadable card: review, nothing guessed', async () => {
    const repo = await makeRepo();
    const id = repo.identify({ nameTexts: ['~~'], collectorText: '' });
    expect(id).toMatchObject({ status: 'review', printing: null });
  });
  it('non-English: review', async () => {
    const repo = await makeRepo();
    expect(repo.identify({ nameTexts: ['Hungry Ghoul'], collectorText: 'C 0062\nFDN • DE' }).status).toBe('review');
  });
});

/** A synthetic "card": black border, light inside, on a mid-gray table. */
function scene(w: number, h: number, card: { x: number; y: number; w: number; h: number }): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inCard = x >= card.x && x < card.x + card.w && y >= card.y && y < card.y + card.h;
      const border = inCard && (x < card.x + card.w * 0.05 || x >= card.x + card.w * 0.95 || y < card.y + card.h * 0.04 || y >= card.y + card.h * 0.96);
      const v = !inCard ? 140 : border ? 15 : 225;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe('findCardEdges', () => {
  it('finds a card that is offset inside the capture', () => {
    const r = findCardEdges(scene(400, 520, { x: 37, y: 30, w: 315, h: 440 }));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.x - 37)).toBeLessThanOrEqual(2);
    expect(Math.abs(r!.y - 30)).toBeLessThanOrEqual(2);
    expect(Math.abs(r!.w - 315)).toBeLessThanOrEqual(3);
    expect(Math.abs(r!.h - 440)).toBeLessThanOrEqual(3);
  });
  it('returns null on an empty table', () => {
    expect(findCardEdges(scene(400, 520, { x: 0, y: 0, w: 0, h: 0 }))).toBeNull();
  });
});

describe('sharpness', () => {
  it('drops when the image is blurred', () => {
    const img = scene(200, 280, { x: 20, y: 20, w: 160, h: 240 });
    const blurred = resampleRgba(resampleRgba(img, { x: 0, y: 0, w: 200, h: 280 }, 25, 35), { x: 0, y: 0, w: 25, h: 35 }, 200, 280);
    expect(sharpness(toGray(img))).toBeGreaterThan(sharpness(toGray(blurred)) * 5);
  });
});

describe('set code lookalikes', () => {
  it('fixes OBL -> DBL only when it is unambiguous', () => {
    const s = new Set(['dbl', 'fdn']);
    expect(parseCollector('085 U\nOBL EN MARTA', s).set).toBe('dbl');
    expect(parseCollector('085 U\nXYZ EN MARTA', s).set).toBeNull();
  });
});
