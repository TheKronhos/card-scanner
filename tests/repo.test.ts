import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/lib/csv';
import { makeRepo } from './helpers';

const MASTER = `Card Name,Set Code,Collector #,Finish,Quantity,Colors,Condition
Dragon Whelp,PLST,DMR-116,Non-foil,1,R,NM
"Abigale, Eloquent First-Year",PECL,204p,Promo Foil,1,B/W,NM
Sol Ring,SLD,1074,Etched,2,C,NM
Lightning Bolt,M10,146,Foil,3,R,LP
Lightning Bolt,M10,146,Non-foil,1,R,NM
Lightning Hounds,PMEI,2000-01-01,Promo,1,R,NM
Crypt Feaster,FDN,59b,Non-foil,1,B,NM
Mystery Card,,,Non-foil,1,U,NM
Counterspell,M10,146,Non-foil,1,U,NM
`;

describe('Repo: search and lookup', () => {
  it('finds names and set+number', async () => {
    const repo = await makeRepo();
    const r = repo.search('lightning bo');
    expect(r.names[0].name).toBe('Lightning Bolt');
    expect(repo.search('plst dmr-116').exact[0].name).toBe('Dragon Whelp');
    expect(repo.search('Invasion of Tolvada').names[0].name).toBe('Invasion of Tolvada // The Broken Sky');
  });
});

describe('Repo: sessions and scans', () => {
  it('adds with session finish rules, edits, deletes and restores', async () => {
    const repo = await makeRepo();
    const s = repo.createSession('Foil pile', 'add', 'foil');
    const bolt = repo.lookup('m10', '146')[0];
    const etchedRing = repo.lookup('sld', '1074')[0];
    const a = repo.addScan(s.id, { printing_id: bolt.id });
    expect(a).toMatchObject({ finish: 'foil', status: 'saved', condition: 'NM', name: 'Lightning Bolt' });
    const b = repo.addScan(s.id, { printing_id: etchedRing.id });
    expect(b.finish).toBe('etched');

    const forest = repo.lookup('lea', '294')[0];
    const c = repo.addScan(s.id, { printing_id: forest.id });
    expect(c).toMatchObject({ finish: 'nonfoil', status: 'check' });
    expect(c.flag_reason).toMatch(/no foil/);

    const edited = repo.updateScan(a.id, { qty: 3, condition: 'LP' });
    expect(edited).toMatchObject({ qty: 3, condition: 'LP' });

    const summary = repo.listSessions()[0];
    expect(summary.copies).toBe(5);
    expect(summary.total_usd).toBeGreaterThan(0);

    const gone = repo.deleteScan(b.id)!;
    expect(repo.scanRows(s.id)).toHaveLength(2);
    repo.restoreScan(gone);
    expect(repo.scanRows(s.id).map((r) => r.id)).toContain(b.id);
    expect(repo.lastScan(s.id)!.id).toBe(c.id);
  });

  it('refuses a finish the printing does not have', async () => {
    const repo = await makeRepo();
    const s = repo.createSession('x', 'add', 'nonfoil');
    const forest = repo.lookup('lea', '294')[0];
    expect(() => repo.addScan(s.id, { printing_id: forest.id, finish: 'foil' })).toThrow(/no foil/);
  });
});

describe('Repo: Master import', () => {
  it('matches by set + number, checks the name, never guesses', async () => {
    const repo = await makeRepo();
    const sum = repo.importCsv(MASTER, 'master.csv', 'collection');
    expect(sum.rows).toBe(9);
    const rows = repo.importRows(sum.id);
    const by = (n: number) => rows.find((r) => r.row_num === n)!;
    expect(by(2).printing_id).not.toBeNull(); // PLST DMR-116
    expect(by(3).printing_id).not.toBeNull(); // PECL 204p
    expect(by(4).printing_id).not.toBeNull(); // SLD 1074 etched
    expect(by(7).printing_id).not.toBeNull(); // date-mangled 2000-1
    expect(by(7).note).toMatch(/read as 2000-1/);
    expect(by(7).note).toMatch(/only exists as foil/);
    expect(by(8).printing_id).toBeNull(); // FDN 59b doesn't exist
    expect(by(8).note).toMatch(/No printing FDN 59b/);
    expect(by(9).note).toMatch(/No set or collector number/);
    expect(by(10).printing_id).toBeNull(); // M10 146 is Lightning Bolt, not Counterspell
    expect(by(10).note).toMatch(/is "Lightning Bolt"/);

    const bolt = repo.lookup('m10', '146')[0];
    expect(repo.owned([bolt.id])[bolt.id]).toEqual({ nonfoil: 1, foil: 3, etched: 0 });
  });

  it('verify session exports only the differences, with color', async () => {
    const repo = await makeRepo();
    const s = repo.createSession('Box 3', 'verify', 'ask');
    repo.importCsv(MASTER, 'box3.csv', 'verify', s.id);
    const bolt = repo.lookup('m10', '146')[0];
    const whelp = repo.lookup('plst', 'DMR-116')[0];
    const abigale = repo.lookup('pecl', '204p')[0];
    const ring = repo.lookup('sld', '1074')[0];
    const hounds = repo.lookup('pmei', '2000-1')[0];
    repo.addScan(s.id, { printing_id: bolt.id, finish: 'foil', qty: 3 });
    repo.addScan(s.id, { printing_id: bolt.id, finish: 'nonfoil' });
    repo.addScan(s.id, { printing_id: whelp.id, finish: 'nonfoil' });
    repo.addScan(s.id, { printing_id: abigale.id, finish: 'nonfoil' }); // sheet says foil
    repo.addScan(s.id, { printing_id: ring.id, finish: 'etched' }); // one of two copies
    repo.addScan(s.id, { printing_id: hounds.id }); // foil-only promo, sheet says "Promo"
    repo.addScan(s.id, { printing_id: hounds.id }); // one extra

    const csv = parseCsv(repo.exportSession(s.id, 'differences').text);
    expect(csv[0]).toEqual(['Type', 'Color', 'Card', 'Expected', 'Found', 'Qty difference']);
    const body = csv.slice(1).map((r) => [r[0], r[1], r[2], r[5]]);
    expect(body).toEqual([
      ['Wrong finish', 'Multicolor (W/B)', 'Abigale, Eloquent First-Year', '1'],
      ['Missing', 'Colorless', 'Sol Ring', '-1'],
      ['Extra', 'Red', 'Lightning Hounds', '+1'],
      ['Not checked', 'Black', 'Crypt Feaster', ''],
      ['Not checked', 'Blue', 'Mystery Card', ''],
      ['Not checked', 'Blue', 'Counterspell', ''],
    ]);
    for (const r of csv.slice(1)) expect(r[1]).not.toBe('');
  });

  it('review and ManaBox exports carry every column', async () => {
    const repo = await makeRepo();
    const s = repo.createSession('Oct 18', 'add', 'nonfoil');
    const jace = repo.lookup('2xm', '56')[0];
    repo.addScan(s.id, { printing_id: jace.id, qty: 2 });
    const review = parseCsv(repo.exportSession(s.id, 'review').text);
    expect(review[0]).toEqual(['Color', 'Card', 'Set', 'Set name', 'Collector #', 'Finish', 'Condition', 'Qty', 'Price', 'Scryfall ID', 'Confidence', 'Flag reason']);
    expect(review[1].slice(0, 8)).toEqual(['Blue', 'Jace, the Mind Sculptor', '2XM', 'Double Masters', '56', 'Non-foil', 'NM', '2']);
    const mb = parseCsv(repo.exportSession(s.id, 'manabox').text);
    expect(mb[0]).toEqual(['Name', 'Set code', 'Set name', 'Collector number', 'Foil', 'Rarity', 'Quantity', 'Scryfall ID', 'Condition', 'Language']);
    expect(mb[1]).toEqual(['Jace, the Mind Sculptor', '2XM', 'Double Masters', '56', 'normal', 'mythic', '2', jace.id, 'near_mint', 'en']);
    expect(repo.exportSession(s.id, 'master').text).toBe('"Jace, the Mind Sculptor [2XM 56]"\r\n"Jace, the Mind Sculptor [2XM 56]"\r\n');
  });
});

describe('Repo: real Master sample (tests/fixtures/master-sample.csv)', () => {
  it('matches 16 of 18 rows and agrees with the sheet’s Colors column', async () => {
    const { readFileSync } = await import('node:fs');
    const { colorLabel, masterColorLabel } = await import('../src/lib/cards');
    const text = readFileSync(new URL('./fixtures/master-sample.csv', import.meta.url), 'utf8');
    const repo = await makeRepo();
    const sum = repo.importCsv(text, 'master-sample.csv', 'collection');
    expect(sum).toMatchObject({ rows: 18, matched_rows: 16, copies: 42, matched_copies: 40 });

    const rows = repo.importRows(sum.id);
    const unmatched = rows.filter((r) => !r.printing_id).map((r) => [r.card_name, r.note]);
    expect(unmatched).toEqual([
      ['Enormous Rat', 'No printing FDN 59b in the card data'],
      ['Olna Ally Shopkeep', 'No set or collector number in the sheet'],
    ]);

    const sheetColors = new Map(parseCsv(text).slice(1).map((r) => [r[0], r[3]]));
    for (const r of rows.filter((x) => x.printing_id)) {
      const p = repo.getPrinting(r.printing_id!)!;
      expect(colorLabel(p.colors, p.front_type), r.card_name).toBe(masterColorLabel(sheetColors.get(r.card_name)!));
    }

    // Treatment words are labels only: "Full Art Foil" is foil, "Japanese Alt-Art" is non-foil.
    const fracture = repo.lookup('soa', '65')[0];
    const zombify = repo.lookup('fdn', '187')[0];
    expect(repo.owned([fracture.id])[fracture.id]).toEqual({ nonfoil: 0, foil: 1, etched: 0 });
    expect(repo.owned([zombify.id])[zombify.id]).toEqual({ nonfoil: 3, foil: 0, etched: 0 });
  });
});
