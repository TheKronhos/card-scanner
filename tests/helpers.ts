import { readFileSync } from 'node:fs';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Repo, migrateUserDb } from '../src/db/repo';

const sqlite3Promise = sqlite3InitModule();

/** A Repo over the small fixture card DB and a fresh in-memory user DB. */
export async function makeRepo(): Promise<Repo> {
  const sqlite3 = await sqlite3Promise;
  const bytes = readFileSync(new URL('./fixtures/cards-mini.sqlite3', import.meta.url));
  const name = `cards-${Math.random().toString(36).slice(2)}.db`;
  sqlite3.capi.sqlite3_js_posix_create_file(name, new Uint8Array(bytes));
  const cards = new sqlite3.oo1.DB(name, 'r');
  const user = new sqlite3.oo1.DB(':memory:', 'c');
  migrateUserDb(user);
  return new Repo(user, cards);
}
