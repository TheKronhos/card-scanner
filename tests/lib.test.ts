import { describe, expect, it } from 'vitest';
import { chooseFinish, colorLabel, masterColorLabel, nameMatches, sessionFinishFlag } from '../src/lib/cards';
import { csvField, parseCsv, toCsv } from '../src/lib/csv';
import { verifyDiff, type Holding } from '../src/lib/diff';
import { masterLine, masterPasteCsv } from '../src/lib/exports';
import { collectorNumberCandidates, finishFromLabel, parseMasterCsv } from '../src/lib/importMaster';
import type { ScanRow } from '../src/lib/types';

describe('colorLabel', () => {
  it('matches the tracker words', () => {
    expect(colorLabel('W', 'Creature')).toBe('White');
    expect(colorLabel('U', 'Instant')).toBe('Blue');
    expect(colorLabel('B', 'Instant')).toBe('Black');
    expect(colorLabel('R', 'Instant')).toBe('Red');
    expect(colorLabel('G', 'Instant')).toBe('Green');
  });
  it('orders multicolor in WUBRG', () => {
    expect(colorLabel('BRU', 'Creature')).toBe('Multicolor (U/B/R)');
    expect(colorLabel('WB', 'Battle')).toBe('Multicolor (W/B)');
    expect(colorLabel('GW', 'Creature')).toBe('Multicolor (W/G)');
  });
  it('separates colorless lands from other colorless cards', () => {
    expect(colorLabel('', 'Artifact')).toBe('Colorless');
    expect(colorLabel('', 'Land — Town')).toBe('Land');
    expect(colorLabel('', 'Basic Land — Forest')).toBe('Land');
    expect(colorLabel('', 'Legendary Artifact')).toBe('Colorless');
  });
  it('converts Master letter colors for unmatched rows', () => {
    expect(masterColorLabel('B')).toBe('Black');
    expect(masterColorLabel('B/W')).toBe('Multicolor (W/B)');
    expect(masterColorLabel('')).toBe('Unknown');
    expect(masterColorLabel('C')).toBe('Colorless');
  });
});

describe('nameMatches', () => {
  const dfc = { name: 'Invasion of Tolvada // The Broken Sky', face_names: ['Invasion of Tolvada', 'The Broken Sky'] };
  it('accepts full, front, back and accent-free names', () => {
    expect(nameMatches(dfc, 'Invasion of Tolvada // The Broken Sky')).toBe(true);
    expect(nameMatches(dfc, 'Invasion of Tolvada')).toBe(true);
    expect(nameMatches(dfc, 'the broken sky')).toBe(true);
    expect(nameMatches({ name: 'Lim-Dûl the Necromancer', face_names: null }, 'Lim-Dul the Necromancer')).toBe(true);
    expect(nameMatches(dfc, 'Lightning Bolt')).toBe(false);
  });
});

describe('finish rules', () => {
  it('foil session saves foil, etched when that is the only foil kind', () => {
    expect(chooseFinish(['nonfoil', 'foil'], 'foil')).toEqual({ finish: 'foil', flag: '' });
    expect(chooseFinish(['nonfoil', 'etched'], 'foil')).toEqual({ finish: 'etched', flag: '' });
    expect(chooseFinish(['nonfoil'], 'foil').flag).toMatch(/no foil/);
  });
  it('single-finish printings are set automatically', () => {
    expect(chooseFinish(['foil'], 'nonfoil')).toEqual({ finish: 'foil', flag: '' });
    expect(chooseFinish(['etched'], 'ask')).toEqual({ finish: 'etched', flag: '' });
  });
  it('ask mode defers when there is a choice', () => {
    expect(chooseFinish(['nonfoil', 'foil'], 'ask').finish).toBeNull();
  });
  it('flags mismatches with the session', () => {
    expect(sessionFinishFlag('foil', ['nonfoil', 'foil'], 'nonfoil')).toMatch(/non-foil session/);
    expect(sessionFinishFlag('foil', ['foil'], 'nonfoil')).toBe('');
  });
});

describe('csv', () => {
  it('quotes commas and quotes, round-trips', () => {
    expect(csvField('Jace, the Mind Sculptor [2XM 56]')).toBe('"Jace, the Mind Sculptor [2XM 56]"');
    const text = toCsv([['a', 'b,c', 'say "hi"'], ['1', '', 'x\ny']]);
    expect(parseCsv(text)).toEqual([['a', 'b,c', 'say "hi"'], ['1', '', 'x\ny']]);
  });
  it('strips BOM and handles LF', () => {
    expect(parseCsv('﻿Name,Qty\nBolt,2\n\n')).toEqual([['Name', 'Qty'], ['Bolt', '2']]);
  });
});

describe('master paste', () => {
  it('formats lines with Foil / Etched tags and uppercase set', () => {
    expect(masterLine('Dragon Whelp', 'plst', 'DMR-116', 'nonfoil')).toBe('Dragon Whelp [PLST DMR-116]');
    expect(masterLine('Abigale, Eloquent First-Year', 'pecl', '204p', 'foil')).toBe('Abigale, Eloquent First-Year [PECL 204p] Foil');
    expect(masterLine('Sol Ring', 'cmm', '123', 'etched')).toBe('Sol Ring [CMM 123] Etched');
  });
  it('one row per copy, review-queue scans left out', () => {
    const base = { printing_id: 'x', set_code: 'm10', collector_number: '146', finish: 'nonfoil', status: 'saved', qty: 1 } as ScanRow;
    const rows = [
      { ...base, name: 'Lightning Bolt', qty: 3 },
      { ...base, name: 'Jace, the Mind Sculptor', finish: 'foil' },
      { ...base, name: 'Unknown', status: 'review', printing_id: null },
    ] as ScanRow[];
    expect(masterPasteCsv(rows)).toBe(
      'Lightning Bolt [M10 146]\r\nLightning Bolt [M10 146]\r\nLightning Bolt [M10 146]\r\n"Jace, the Mind Sculptor [M10 146] Foil"\r\n',
    );
  });
});

describe('Master import parsing', () => {
  it('maps Master finish labels', () => {
    for (const l of ['Non-foil', 'Full Art', 'Promo', 'Alternate Art', 'Borderless', 'Japanese Alt-Art', '']) expect(finishFromLabel(l)).toBe('nonfoil');
    for (const l of ['Foil', 'Full Art Foil', 'Promo Foil', 'Alternate Art Foil', 'Borderless Foil']) expect(finishFromLabel(l)).toBe('foil');
    expect(finishFromLabel('Etched')).toBe('etched');
  });
  it('reads the columns and flags bad quantities', () => {
    const r = parseMasterCsv('Card Name,Set Code,Collector #,Finish,Quantity\nSol Ring,SLD,1074,Etched,2\nBolt,M10,146,Foil,x\n');
    expect(r.error).toBe('');
    expect(r.rows[0]).toMatchObject({ card_name: 'Sol Ring', set_code: 'SLD', collector_number: '1074', finish: 'etched', qty: 2, condition: 'NM' });
    expect(r.rows[1].error).toMatch(/Quantity/);
  });
  it('rejects a file without the key columns', () => {
    expect(parseMasterCsv('Foo,Bar\n1,2').error).toMatch(/Missing column/);
  });
  it('suggests collector numbers for date-mangled cells', () => {
    expect(collectorNumberCandidates('2025-01-17')).toContain('2025-17');
    expect(collectorNumberCandidates('1/17/2025')).toContain('2025-17');
    expect(collectorNumberCandidates('Jan-2026')).toContain('2026-1');
    expect(collectorNumberCandidates('146')).toEqual([]);
    expect(collectorNumberCandidates('DMR-116')).toEqual([]);
  });
});

describe('verifyDiff', () => {
  const h = (id: string, name: string, finish: Holding['finish'], qty: number, num = id): Holding => ({
    printing_id: id, finish, qty, name, set_code: 'm10', collector_number: num, colors: 'R', front_type: 'Instant',
  });
  it('compares total copies across multi-quantity rows', () => {
    const rows = verifyDiff([h('a', 'Bolt', 'nonfoil', 2), h('a', 'Bolt', 'nonfoil', 1)], [h('a', 'Bolt', 'nonfoil', 1), h('a', 'Bolt', 'nonfoil', 1)]);
    expect(rows).toEqual([{ type: 'Missing', color: 'Red', name: 'Bolt', expected: '[M10 a] Non-foil', found: '', qty_diff: -1 }]);
  });
  it('pairs wrong printing and wrong finish, leaves the rest as missing/extra', () => {
    const rows = verifyDiff(
      [h('a', 'Bolt', 'nonfoil', 2), h('c', 'Shock', 'foil', 1)],
      [h('b', 'Bolt', 'nonfoil', 1), h('c', 'Shock', 'nonfoil', 1), h('d', 'Opt', 'nonfoil', 1)],
    );
    expect(rows.map((r) => [r.type, r.name, r.qty_diff])).toEqual([
      ['Wrong printing', 'Bolt', 1],
      ['Wrong finish', 'Shock', 1],
      ['Missing', 'Bolt', -1],
      ['Extra', 'Opt', 1],
    ]);
  });
  it('identical lists give no rows', () => {
    expect(verifyDiff([h('a', 'Bolt', 'foil', 4)], [h('a', 'Bolt', 'foil', 4)])).toEqual([]);
  });
});
