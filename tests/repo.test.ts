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

describe('Repo: Just scan session and Scan file export', () => {
  const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9]);

  it('records what was scanned, one row per copy, with photos for check/review', async () => {
    const { unzipSync, strFromU8 } = await import('fflate');
    const repo = await makeRepo();
    const s = repo.createSession('Bulk box', 'scan', 'nonfoil');
    const cand = (set: string, num: string) => {
      const p = repo.lookup(set, num)[0];
      return { printing_id: p.id, name: p.name, set_code: p.set_code, collector_number: p.collector_number, colors: p.colors, front_type: p.front_type, score: 0.5 };
    };
    const bolt = repo.lookup('m10', '146')[0];
    const jace = repo.lookup('2xm', '56')[0];

    // 1: saved scan with a photo (photo only exported when "all photos" is on)
    const a = repo.addScan(s.id, { printing_id: bolt.id, source: 'scan', confidence: 0.99, photo: jpeg(1) });
    // 2: misread, then replaced (3) -> 2 is left out of everything
    const misread = repo.addScan(s.id, { printing_id: bolt.id, source: 'scan', confidence: 0.97, photo: jpeg(2) });
    const fixed = repo.replaceScan(misread.id, { printing_id: jace.id, source: 'scan', confidence: 0.98, photo: jpeg(3), qty: 2 });
    // 4: check (two signals agreed)
    repo.addScan(s.id, { printing_id: jace.id, source: 'scan', confidence: 0.8, status: 'check', flag_reason: 'Art match weak', photo: jpeg(4), candidates: [cand('2xm', '56'), cand('2xm', '334')] });
    // 5: review queue, same card name across candidates
    repo.addScan(s.id, { printing_id: null, source: 'scan', confidence: 0.4, photo: jpeg(5), candidates: [cand('2xm', '56'), cand('a25', '62'), cand('wwk', '31')] });
    // 6: review queue, later fixed by hand
    const r6 = repo.addScan(s.id, { printing_id: null, source: 'scan', confidence: 0.3, photo: jpeg(6), candidates: [cand('m10', '146'), cand('2xm', '56')] });
    repo.updateScan(r6.id, { printing_id: bolt.id });

    expect(repo.scanRows(s.id).map((r) => r.seq)).toEqual([6, 5, 4, 3, 1]);
    expect(repo.lastScan(s.id)!.seq).toBe(6);

    const out = repo.exportScanFile(s.id);
    expect(out).toMatchObject({ filename: 'Bulk-box-scan-file.zip', review_count: 1, rows: 6, photos: 3 });
    const zip = unzipSync(out.bytes);
    expect(Object.keys(zip).sort()).toEqual(['photos/', 'photos/0004.jpg', 'photos/0005.jpg', 'photos/0006.jpg', 'scan.csv']);
    expect([...zip['photos/0005.jpg']]).toEqual([...jpeg(5)]);

    const csv = parseCsv(strFromU8(zip['scan.csv']));
    expect(csv[0]).toEqual(['Scan #', 'Time', 'Color', 'Card', 'Set', 'Set name', 'Collector #', 'Finish', 'Condition', 'Scryfall ID', 'Price', 'Confidence', 'Status', 'Flag reason', 'Top 3 candidates', 'Photo file']);
    const col = (row: string[], name: string) => row[csv[0].indexOf(name)];
    const body = csv.slice(1);
    expect(body.map((r) => [r[0], col(r, 'Card'), col(r, 'Set'), col(r, 'Status'), col(r, 'Flag reason'), col(r, 'Photo file')])).toEqual([
      ['0001', 'Lightning Bolt', 'M10', 'saved', '', ''],
      ['0003', 'Jace, the Mind Sculptor', '2XM', 'saved', '', ''],
      ['0003-2', 'Jace, the Mind Sculptor', '2XM', 'saved', '', ''],
      ['0004', 'Jace, the Mind Sculptor', '2XM', 'check', 'Art match weak', 'photos/0004.jpg'],
      ['0005', 'Jace, the Mind Sculptor', '', 'review', 'Not sure which printing', 'photos/0005.jpg'],
      ['0006', 'Lightning Bolt', 'M10', 'saved', 'fixed by hand', 'photos/0006.jpg'],
    ]);
    const review = body[4];
    expect(col(review, 'Top 3 candidates')).toBe('2XM 56 | A25 62 | WWK 31');
    expect(col(review, 'Color')).toBe('Blue');
    expect(col(review, 'Scryfall ID')).toBe('');
    expect(col(body[0], 'Color')).toBe('Red');
    expect(col(body[0], 'Scryfall ID')).toBe(a.printing_id);
    expect(col(body[0], 'Confidence')).toBe('99%');
    expect(col(body[0], 'Time')).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(fixed.replaces_id).toBe(misread.id);

    repo.setSetting('scanfile_all_photos', true);
    const all = unzipSync(repo.exportScanFile(s.id).bytes);
    expect(Object.keys(all)).toContain('photos/0001.jpg');
    expect(Object.keys(all)).toContain('photos/0003.jpg');
    expect(Object.keys(all)).not.toContain('photos/0002.jpg');
  });

  it('undo removes the latest card and restore brings back its photo; scan numbers are never reused', async () => {
    const repo = await makeRepo();
    const s = repo.createSession('x', 'scan', 'nonfoil');
    const bolt = repo.lookup('m10', '146')[0];
    repo.addScan(s.id, { printing_id: bolt.id, source: 'scan', photo: jpeg(1) });
    const second = repo.addScan(s.id, { printing_id: bolt.id, source: 'scan', photo: jpeg(2) });
    const gone = repo.deleteScan(repo.lastScan(s.id)!.id)!;
    expect(gone.scan.id).toBe(second.id);
    expect(repo.addScan(s.id, { printing_id: bolt.id }).seq).toBe(3);
    const restored = repo.restoreScan(gone);
    expect([...repo.getPhoto(restored)!]).toEqual([...jpeg(2)]);
    expect(repo.scanRows(s.id).map((r) => r.seq)).toEqual([3, 2, 1]);
  });

  it('undoing a Replace last brings the replaced scan back', async () => {
    const repo = await makeRepo();
    const s = repo.createSession('x', 'scan', 'nonfoil');
    const bolt = repo.lookup('m10', '146')[0];
    const jace = repo.lookup('2xm', '56')[0];
    const first = repo.addScan(s.id, { printing_id: bolt.id, source: 'scan' });
    const fix = repo.replaceScan(first.id, { printing_id: jace.id, source: 'scan' });
    expect(repo.scanRows(s.id).map((r) => r.id)).toEqual([fix.id]);
    repo.deleteScan(fix.id);
    expect(repo.scanRows(s.id).map((r) => r.id)).toEqual([first.id]);
  });
});

describe('user DB migration', () => {
  it('upgrades a v1 database: existing scans get scan numbers in order', async () => {
    const sqlite3InitModule = (await import('@sqlite.org/sqlite-wasm')).default;
    const { USER_MIGRATIONS, migrateUserDb } = await import('../src/db/repo');
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    db.exec(USER_MIGRATIONS[0]);
    db.exec('PRAGMA user_version = 1');
    db.exec("INSERT INTO sessions (id, name, created_at, updated_at) VALUES (1, 'old', 't', 't'), (2, 'other', 't', 't')");
    db.exec("INSERT INTO scans (id, session_id, created_at) VALUES (10, 1, 't'), (11, 2, 't'), (12, 1, 't')");
    migrateUserDb(db);
    expect(db.selectObjects('SELECT id, seq FROM scans ORDER BY id')).toEqual([{ id: 10, seq: 1 }, { id: 11, seq: 1 }, { id: 12, seq: 2 }]);
    expect(db.selectObjects('SELECT id, next_seq FROM sessions ORDER BY id')).toEqual([{ id: 1, next_seq: 3 }, { id: 2, next_seq: 2 }]);
  });
});
