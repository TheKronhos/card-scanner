/// <reference lib="webworker" />
// Owns both SQLite databases (card data + the user's sessions), stored in the browser's private file system.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import * as Comlink from 'comlink';
import { PACK_SCHEMA_VERSION, Repo, migrateUserDb } from './repo';

const USER_DB = '/user.sqlite3';

let sqlite3: Sqlite3Static;
let pool: SAHPoolUtil;
let repo: Repo;

function setMeta(key: string, value: string) {
  repo.user.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { bind: [key, value] });
}
const getMeta = (db: Database, key: string) => db.selectValue('SELECT value FROM meta WHERE key = ?', [key]) as string | undefined;

/** Reads from browser file storage are slow; keep pages and temp tables in memory. */
function tune(db: Database) {
  db.exec('PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY');
}

function openCards(user: Database): Database | null {
  const name = getMeta(user, 'cards_file');
  if (!name || !pool.getFileNames().includes(name)) return null;
  const db = new pool.OpfsSAHPoolDb(name);
  tune(db);
  if (Number(getMeta(db, 'schema_version')) !== PACK_SCHEMA_VERSION) {
    db.close();
    return null;
  }
  return db;
}

export interface InitResult {
  ok: boolean;
  error?: string;
}

async function init(): Promise<InitResult> {
  try {
    sqlite3 = await sqlite3InitModule();
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'card-scanner', initialCapacity: 10 });
    await pool.reserveMinimumCapacity(10);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // Each file can only be held by one tab at a time.
    if (/NoModificationAllowed|locked|access handle/i.test(msg)) {
      return { ok: false, error: 'Card Scanner is already open in another tab or window. Close it there, then reload.' };
    }
    return { ok: false, error: `This browser can't store the app's data (${msg}).` };
  }
  const user = new pool.OpfsSAHPoolDb(USER_DB);
  tune(user);
  migrateUserDb(user);
  repo = new Repo(user, null);
  repo.cards = openCards(user);
  // Build the name search index right after startup so the first search is instant.
  setTimeout(() => repo.warmUp(), 500);
  return { ok: true };
}

export interface Manifest {
  schema_version: number;
  version: string;
  built_at: string;
  card_count: number;
  cards: { file: string; bytes: number; raw_bytes: number; sha256: string };
}

export interface RefreshProgress {
  phase: 'checking' | 'downloading' | 'installing' | 'done';
  loaded?: number;
  total?: number;
}

export interface RefreshResult {
  updated: boolean;
  version: string;
  rematched: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Download the latest data pack if it's newer than what's installed. Old data stays usable until the swap. */
async function refresh(baseUrl: string, onProgress: (p: RefreshProgress) => void, force = false): Promise<RefreshResult> {
  onProgress({ phase: 'checking' });
  const res = await fetch(new URL('manifest.json', baseUrl), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't reach the card data server (HTTP ${res.status}).`);
  const manifest = (await res.json()) as Manifest;
  if (manifest.schema_version !== PACK_SCHEMA_VERSION) {
    throw new Error('The card data needs a newer version of the app. Reload the app to update it, then try again.');
  }
  const current = repo.cards ? getMeta(repo.cards, 'version') : undefined;
  if (!force && current === manifest.version) return { updated: false, version: manifest.version, rematched: 0 };

  const dl = await fetch(new URL(manifest.cards.file, baseUrl));
  if (!dl.ok || !dl.body) throw new Error(`Card data download failed (HTTP ${dl.status}).`);
  const total = manifest.cards.bytes;
  const parts: Uint8Array[] = [];
  let loaded = 0;
  const reader = dl.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress({ phase: 'downloading', loaded, total });
  }
  const gz = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) {
    gz.set(p, o);
    o += p.length;
  }
  if ((await sha256Hex(gz)) !== manifest.cards.sha256) throw new Error('The card data download was corrupted. Try again.');

  onProgress({ phase: 'installing' });
  const name = `/cards-${manifest.version}.sqlite3`;
  const unzipped = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  await pool.importDb(name, async () => {
    const { done, value } = await unzipped.read();
    return done ? undefined : value;
  });
  const fresh = new pool.OpfsSAHPoolDb(name);
  tune(fresh);
  const count = Number(fresh.selectValue('SELECT COUNT(*) FROM printings'));
  if (count !== manifest.card_count) {
    fresh.close();
    pool.unlink(name);
    throw new Error('The card data looks incomplete. Try again.');
  }

  const old = repo.cards;
  const oldName = getMeta(repo.user, 'cards_file');
  repo.cards = fresh;
  setMeta('cards_file', name);
  if (old) old.close();
  if (oldName && oldName !== name) pool.unlink(oldName);
  // Drop any leftover files from interrupted installs.
  for (const f of pool.getFileNames()) if (f.startsWith('/cards-') && f !== name) pool.unlink(f);

  const rematched = repo.rematchImports();
  repo.warmUp();
  onProgress({ phase: 'done' });
  return { updated: true, version: manifest.version, rematched };
}

type RepoMethod = { [K in keyof Repo]: Repo[K] extends (...a: never[]) => unknown ? K : never }[keyof Repo];

const api = {
  init,
  refresh: (baseUrl: string, onProgress: (p: RefreshProgress) => void, force?: boolean) => refresh(baseUrl, onProgress, force),
  call(method: RepoMethod, args: unknown[]) {
    const fn = repo[method] as (...a: unknown[]) => unknown;
    return fn.apply(repo, args);
  },
};

export type WorkerApi = typeof api;
export type { RepoMethod };

Comlink.expose(api);
