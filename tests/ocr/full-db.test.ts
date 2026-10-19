// Regression cases from real scans, against the full card data. Run with CARDS_DB=/path/cards.sqlite3.
import { readFileSync } from 'node:fs';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Repo, migrateUserDb } from '../../src/db/repo';

const DB = process.env.CARDS_DB;

describe.skipIf(!DB)('full card data', () => {
  let repo: Repo;
  beforeAll(async () => {
    const s = await sqlite3InitModule();
    s.capi.sqlite3_js_posix_create_file('full2.db', new Uint8Array(readFileSync(DB!)));
    const user = new s.oo1.DB(':memory:', 'c');
    migrateUserDb(user);
    repo = new Repo(user, new s.oo1.DB('full2.db', 'r'));
  }, 60_000);

  it('Delver of Secrets never matches the Art Series card (scan 0071)', () => {
    const nameOnly = repo.identify({ nameTexts: ['Delver of Secrets'], collectorText: '' });
    expect(nameOnly.printing?.set_code).not.toBe('amid');
    expect(nameOnly.candidates.map((c) => c.set_code)).not.toContain('amid');
    const full = repo.identify({ nameTexts: ['Delver of Secrets'], collectorText: 'U 0047\nMID • EN' });
    expect(full.printing?.set_code).toBe('mid');
    expect(full.printing?.collector_number).toBe('47');
  });
});
