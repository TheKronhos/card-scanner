import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import { chooseFinish, masterColorLabel, normName, priceFor, sessionFinishFlag } from '../lib/cards';
import type { DiffRow, Holding } from '../lib/diff';
import { verifyDiff } from '../lib/diff';
import { differencesCsv, manaboxCsv, masterPasteCsv, reviewCsv } from '../lib/exports';
import { matchRows, parseMasterCsv } from '../lib/importMaster';
import type { MatchedRow } from '../lib/importMaster';
import type {
  Condition, Finish, FoilMode, Printing, Scan, ScanRow, ScanStatus, Session, SessionKind, SessionSummary,
} from '../lib/types';

/** Card-data pack schema this app understands (see mtg-scanner-data/scripts/build-pack.mjs). */
export const PACK_SCHEMA_VERSION = 1;

type Row = Record<string, SqlValue>;

const USER_MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE sessions (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'add',
     foil_mode TEXT NOT NULL DEFAULT 'nonfoil',
     default_condition TEXT NOT NULL DEFAULT 'NM',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL);
   CREATE TABLE scans (
     id INTEGER PRIMARY KEY,
     session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     printing_id TEXT,
     name TEXT NOT NULL DEFAULT '',
     set_code TEXT NOT NULL DEFAULT '',
     set_name TEXT NOT NULL DEFAULT '',
     collector_number TEXT NOT NULL DEFAULT '',
     rarity TEXT NOT NULL DEFAULT '',
     colors TEXT NOT NULL DEFAULT '',
     front_type TEXT NOT NULL DEFAULT '',
     img_ver TEXT,
     finish TEXT NOT NULL DEFAULT 'nonfoil',
     condition TEXT NOT NULL DEFAULT 'NM',
     qty INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'saved',
     confidence REAL,
     source TEXT NOT NULL DEFAULT 'manual',
     flag_reason TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL);
   CREATE INDEX scans_session ON scans (session_id, id);
   CREATE TABLE imports (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,              -- 'collection' or 'verify'
     session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
     filename TEXT NOT NULL,
     imported_at TEXT NOT NULL);
   CREATE TABLE import_rows (
     id INTEGER PRIMARY KEY,
     import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
     row_num INTEGER NOT NULL,
     card_name TEXT NOT NULL,
     set_code TEXT NOT NULL,
     collector_number TEXT NOT NULL,   -- as written in the sheet
     finish_label TEXT NOT NULL,
     finish TEXT NOT NULL,
     qty INTEGER NOT NULL,
     condition TEXT NOT NULL,
     colors TEXT NOT NULL DEFAULT '',  -- Master's Colors column, as written
     error TEXT NOT NULL DEFAULT '',
     printing_id TEXT,                 -- null = unmatched
     note TEXT NOT NULL DEFAULT '');
   CREATE INDEX import_rows_import ON import_rows (import_id);
   CREATE INDEX import_rows_printing ON import_rows (printing_id);`,
];

export function migrateUserDb(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');
  const version = Number(db.selectValue('PRAGMA user_version') ?? 0);
  for (let v = version; v < USER_MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(USER_MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

const PRINTING_SELECT = `SELECT p.*, COALESCE(s.name, upper(p.set_code)) AS set_name
  FROM printings p LEFT JOIN sets s ON s.code = p.set_code`;

const list = (v: SqlValue) => (v ? String(v).split(',').filter(Boolean) : []);
const num = (v: SqlValue) => (v == null ? null : Number(v));

function toPrinting(r: Row): Printing {
  return {
    id: String(r.id),
    oracle_id: r.oracle_id == null ? null : String(r.oracle_id),
    name: String(r.name),
    face_names: r.face_names ? JSON.parse(String(r.face_names)) : null,
    set_code: String(r.set_code),
    set_name: String(r.set_name),
    collector_number: String(r.collector_number),
    rarity: String(r.rarity ?? ''),
    lang: String(r.lang ?? 'en'),
    released_at: String(r.released_at ?? ''),
    layout: String(r.layout ?? ''),
    type_line: String(r.type_line ?? ''),
    front_type: String(r.front_type ?? ''),
    finishes: list(r.finishes) as Finish[],
    frame: String(r.frame ?? ''),
    frame_effects: list(r.frame_effects),
    border_color: String(r.border_color ?? ''),
    full_art: !!r.full_art,
    promo: !!r.promo,
    promo_types: list(r.promo_types),
    colors: String(r.colors ?? ''),
    usd: num(r.usd),
    usd_foil: num(r.usd_foil),
    usd_etched: num(r.usd_etched),
    img_ver: r.img_ver == null ? null : String(r.img_ver),
    img_back: !!r.img_back,
  };
}

function toScan(r: Row): Scan {
  return {
    id: Number(r.id),
    session_id: Number(r.session_id),
    printing_id: r.printing_id == null ? null : String(r.printing_id),
    name: String(r.name),
    set_code: String(r.set_code),
    set_name: String(r.set_name),
    collector_number: String(r.collector_number),
    rarity: String(r.rarity),
    colors: String(r.colors),
    front_type: String(r.front_type),
    img_ver: r.img_ver == null ? null : String(r.img_ver),
    finish: String(r.finish) as Finish,
    condition: String(r.condition) as Condition,
    qty: Number(r.qty),
    status: String(r.status) as ScanStatus,
    confidence: num(r.confidence),
    source: String(r.source) as Scan['source'],
    flag_reason: String(r.flag_reason),
    created_at: String(r.created_at),
  };
}

const toSession = (r: Row): Session => ({
  id: Number(r.id),
  name: String(r.name),
  kind: String(r.kind) as SessionKind,
  foil_mode: String(r.foil_mode) as FoilMode,
  default_condition: String(r.default_condition) as Condition,
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});

export interface CardsMeta {
  version: string;
  built_at: string;
  card_count: number;
  schema_version: number;
}

export interface SearchHit {
  oracle_id: string;
  name: string;
  printings: number;
  newest: Printing;
}

export interface Owned {
  nonfoil: number;
  foil: number;
  etched: number;
}

export interface ImportSummary {
  id: number;
  kind: 'collection' | 'verify';
  filename: string;
  imported_at: string;
  rows: number;
  matched_rows: number;
  copies: number;
  matched_copies: number;
}

export interface ImportRowView {
  row_num: number;
  card_name: string;
  set_code: string;
  collector_number: string;
  finish_label: string;
  qty: number;
  printing_id: string | null;
  note: string;
}

export type ExportKind = 'master' | 'review' | 'manabox' | 'differences';

export interface ExportFile {
  filename: string;
  text: string;
  /** Scans still in the review queue: they are left out of the export. */
  review_count: number;
}

export interface AddScanInput {
  printing_id: string;
  finish?: Finish;
  condition?: Condition;
  qty?: number;
  status?: ScanStatus;
  confidence?: number | null;
  source?: Scan['source'];
  flag_reason?: string;
}

const now = () => new Date().toISOString();
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';

/**
 * All data access. Works on plain sqlite-wasm Database handles so the same code runs in the browser worker
 * (OPFS-backed files) and in Node tests (in-memory).
 */
export class Repo {
  user: Database;
  cards: Database | null;

  constructor(user: Database, cards: Database | null) {
    this.user = user;
    this.cards = cards;
  }

  private tx<T>(fn: () => T): T {
    this.user.exec('BEGIN');
    try {
      const out = fn();
      this.user.exec('COMMIT');
      return out;
    } catch (e) {
      this.user.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- card data ----

  private requireCards(): Database {
    if (!this.cards) throw new Error('Card data is not installed yet. Open Card data and tap Refresh.');
    return this.cards;
  }

  cardsMeta(): CardsMeta | null {
    if (!this.cards) return null;
    const m = Object.fromEntries(this.cards.selectObjects('SELECT key, value FROM meta').map((r) => [r.key, r.value]));
    return {
      version: String(m.version ?? ''),
      built_at: String(m.built_at ?? ''),
      card_count: Number(m.card_count ?? 0),
      schema_version: Number(m.schema_version ?? 0),
    };
  }

  getPrinting(id: string): Printing | null {
    const r = this.requireCards().selectObject(`${PRINTING_SELECT} WHERE p.id = ?`, [id]);
    return r ? toPrinting(r) : null;
  }

  getPrintings(ids: string[]): Map<string, Printing> {
    const out = new Map<string, Printing>();
    if (!this.cards || ids.length === 0) return out;
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const rows = this.cards.selectObjects(`${PRINTING_SELECT} WHERE p.id IN (${chunk.map(() => '?').join(',')})`, chunk);
      for (const r of rows) out.set(String(r.id), toPrinting(r));
    }
    return out;
  }

  /** Exact set + collector number; falls back to ignoring case (List numbers are stored as e.g. "DMR-116"). */
  lookup(setCode: string, collectorNumber: string): Printing[] {
    const db = this.requireCards();
    const bind = [setCode.toLowerCase(), collectorNumber.trim()];
    let rows = db.selectObjects(`${PRINTING_SELECT} WHERE p.set_code = ? AND p.collector_number = ?`, bind);
    if (!rows.length) rows = db.selectObjects(`${PRINTING_SELECT} WHERE p.set_code = ? AND p.collector_number = ? COLLATE NOCASE`, bind);
    return rows.map(toPrinting);
  }

  /** Name search, newest printing first in each group. "SET NUM" (e.g. "plst dmr-116") jumps straight to printings. */
  search(query: string, limit = 30): { exact: Printing[]; names: SearchHit[] } {
    const db = this.requireCards();
    const q = query.trim();
    const exact: Printing[] = [];
    const m = q.match(/^([a-z0-9]{2,6})\s+(\S+)$/i);
    if (m) exact.push(...this.lookup(m[1], m[2]));
    const n = normName(q);
    if (n.length < 2) return { exact, names: [] };
    const rows = db.selectObjects(
      `SELECT oracle_id, name, COUNT(*) AS printings, MAX(released_at) AS newest_date,
              MIN(name_norm = $n) AS is_exact, MIN(name_norm LIKE $prefix) AS is_prefix
         FROM printings WHERE name_norm LIKE $any
        GROUP BY oracle_id
        ORDER BY is_exact DESC, is_prefix DESC, name
        LIMIT $limit`,
      { $n: n, $prefix: `${n}%`, $any: `%${n}%`, $limit: limit },
    );
    const names: SearchHit[] = rows.map((r) => {
      const newest = db.selectObject(`${PRINTING_SELECT} WHERE p.oracle_id = ? ORDER BY p.released_at DESC, p.collector_number LIMIT 1`, [r.oracle_id]);
      return { oracle_id: String(r.oracle_id), name: String(r.name), printings: Number(r.printings), newest: toPrinting(newest!) };
    });
    return { exact, names };
  }

  printingsOf(oracleId: string): Printing[] {
    return this.requireCards()
      .selectObjects(`${PRINTING_SELECT} WHERE p.oracle_id = ? ORDER BY p.released_at DESC, s.name, length(p.collector_number), p.collector_number`, [oracleId])
      .map(toPrinting);
  }

  // ---- sessions ----

  listSessions(): SessionSummary[] {
    const sessions = this.user.selectObjects('SELECT * FROM sessions ORDER BY updated_at DESC').map(toSession);
    const scans = this.user.selectObjects('SELECT session_id, printing_id, finish, qty, status FROM scans');
    const prices = this.getPrintings(scans.map((s) => s.printing_id).filter(Boolean).map(String));
    return sessions.map((s) => {
      let copies = 0;
      let review = 0;
      let total = 0;
      for (const r of scans) {
        if (Number(r.session_id) !== s.id) continue;
        if (r.status === 'review') {
          review++;
          continue;
        }
        copies += Number(r.qty);
        const p = prices.get(String(r.printing_id));
        if (p) total += (priceFor(p, r.finish as Finish) ?? 0) * Number(r.qty);
      }
      return { ...s, copies, review, total_usd: total };
    });
  }

  getSession(id: number): Session | null {
    const r = this.user.selectObject('SELECT * FROM sessions WHERE id = ?', [id]);
    return r ? toSession(r) : null;
  }

  createSession(name: string, kind: SessionKind, foilMode: FoilMode): Session {
    const t = now();
    this.user.exec('INSERT INTO sessions (name, kind, foil_mode, created_at, updated_at) VALUES (?,?,?,?,?)', {
      bind: [name.trim() || 'Session', kind, foilMode, t, t],
    });
    return this.getSession(Number(this.user.selectValue('SELECT last_insert_rowid()')))!;
  }

  updateSession(id: number, patch: Partial<Pick<Session, 'name' | 'foil_mode' | 'default_condition'>>): Session {
    const s = this.getSession(id);
    if (!s) throw new Error('Session not found');
    const next = { ...s, ...patch };
    this.user.exec('UPDATE sessions SET name = ?, foil_mode = ?, default_condition = ?, updated_at = ? WHERE id = ?', {
      bind: [next.name.trim() || s.name, next.foil_mode, next.default_condition, now(), id],
    });
    return this.getSession(id)!;
  }

  deleteSession(id: number): void {
    this.user.exec('DELETE FROM sessions WHERE id = ?', { bind: [id] });
  }

  private touch(sessionId: number) {
    this.user.exec('UPDATE sessions SET updated_at = ? WHERE id = ?', { bind: [now(), sessionId] });
  }

  // ---- scans ----

  scanRows(sessionId: number): ScanRow[] {
    const scans = this.user.selectObjects('SELECT * FROM scans WHERE session_id = ? ORDER BY id DESC', [sessionId]).map(toScan);
    const prices = this.getPrintings(scans.map((s) => s.printing_id).filter((x): x is string => !!x));
    return scans.map((s) => {
      const p = s.printing_id ? prices.get(s.printing_id) : undefined;
      return { ...s, unit_price: p ? priceFor(p, s.finish) : null };
    });
  }

  getScan(id: number): Scan | null {
    const r = this.user.selectObject('SELECT * FROM scans WHERE id = ?', [id]);
    return r ? toScan(r) : null;
  }

  addScan(sessionId: number, input: AddScanInput): Scan {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const p = this.getPrinting(input.printing_id);
    if (!p) throw new Error(`Unknown printing ${input.printing_id}`);
    const auto = chooseFinish(p.finishes, session.foil_mode);
    const finish = input.finish ?? auto.finish;
    if (!finish) throw new Error('Pick a finish for this card');
    if (p.finishes.length && !p.finishes.includes(finish)) throw new Error(`${p.name} [${p.set_code.toUpperCase()} ${p.collector_number}] has no ${finish} version`);
    const flags = [input.flag_reason, sessionFinishFlag(finish, p.finishes, session.foil_mode)].filter(Boolean);
    const status: ScanStatus = input.status ?? (flags.length ? 'check' : 'saved');
    this.tx(() => {
      this.user.exec(
        `INSERT INTO scans (session_id, printing_id, name, set_code, set_name, collector_number, rarity, colors, front_type,
           img_ver, finish, condition, qty, status, confidence, source, flag_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        {
          bind: [sessionId, p.id, p.name, p.set_code, p.set_name, p.collector_number, p.rarity, p.colors, p.front_type,
            p.img_ver, finish, input.condition ?? session.default_condition, Math.max(1, input.qty ?? 1), status,
            input.confidence ?? null, input.source ?? 'manual', flags.join('; '), now()],
        },
      );
      this.touch(sessionId);
    });
    return this.getScan(Number(this.user.selectValue('SELECT last_insert_rowid()')))!;
  }

  /** Change printing, finish, condition or quantity. A new printing re-snapshots the card fields. */
  updateScan(id: number, patch: { printing_id?: string; finish?: Finish; condition?: Condition; qty?: number }): Scan {
    const scan = this.getScan(id);
    if (!scan) throw new Error('Card not found');
    const session = this.getSession(scan.session_id)!;
    const p = this.getPrinting(patch.printing_id ?? scan.printing_id ?? '');
    if (!p) throw new Error('Pick a printing first');
    let finish = patch.finish ?? scan.finish;
    if (p.finishes.length && !p.finishes.includes(finish)) finish = chooseFinish(p.finishes, session.foil_mode).finish ?? p.finishes[0];
    const flag = sessionFinishFlag(finish, p.finishes, session.foil_mode);
    // A manual edit is the user confirming the card, so it clears the review/check state.
    this.tx(() => {
      this.user.exec(
        `UPDATE scans SET printing_id = ?, name = ?, set_code = ?, set_name = ?, collector_number = ?, rarity = ?, colors = ?,
           front_type = ?, img_ver = ?, finish = ?, condition = ?, qty = ?, status = ?, flag_reason = ? WHERE id = ?`,
        {
          bind: [p.id, p.name, p.set_code, p.set_name, p.collector_number, p.rarity, p.colors, p.front_type, p.img_ver, finish,
            patch.condition ?? scan.condition, Math.max(1, patch.qty ?? scan.qty), flag ? 'check' : 'saved', flag, id],
        },
      );
      this.touch(scan.session_id);
    });
    return this.getScan(id)!;
  }

  /** Delete and return the row, so the UI can offer to restore it. */
  deleteScan(id: number): Scan | null {
    const scan = this.getScan(id);
    if (!scan) return null;
    this.tx(() => {
      this.user.exec('DELETE FROM scans WHERE id = ?', { bind: [id] });
      this.touch(scan.session_id);
    });
    return scan;
  }

  restoreScan(scan: Scan): void {
    const cols = Object.keys(scan) as (keyof Scan)[];
    this.tx(() => {
      this.user.exec(`INSERT INTO scans (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, {
        bind: cols.map((c) => scan[c] as SqlValue),
      });
      this.touch(scan.session_id);
    });
  }

  lastScan(sessionId: number): Scan | null {
    const r = this.user.selectObject('SELECT * FROM scans WHERE session_id = ? ORDER BY id DESC LIMIT 1', [sessionId]);
    return r ? toScan(r) : null;
  }

  // ---- imports ----

  private storeImport(kind: 'collection' | 'verify', filename: string, sessionId: number | null, rows: MatchedRow[]): number {
    return this.tx(() => {
      if (kind === 'collection') this.user.exec("DELETE FROM imports WHERE kind = 'collection'");
      else this.user.exec("DELETE FROM imports WHERE kind = 'verify' AND session_id = ?", { bind: [sessionId] });
      this.user.exec('INSERT INTO imports (kind, session_id, filename, imported_at) VALUES (?,?,?,?)', { bind: [kind, sessionId, filename, now()] });
      const importId = Number(this.user.selectValue('SELECT last_insert_rowid()'));
      const stmt = this.user.prepare(
        `INSERT INTO import_rows (import_id, row_num, card_name, set_code, collector_number, finish_label, finish, qty, condition, colors, error, printing_id, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      try {
        for (const r of rows) {
          stmt.bind([importId, r.row_num, r.card_name, r.set_code, r.collector_number, r.finish_label, r.finish, r.qty, r.condition,
            r.colors, r.error, r.printing?.id ?? null, r.note]).stepReset();
        }
      } finally {
        stmt.finalize();
      }
      if (sessionId != null) this.touch(sessionId);
      return importId;
    });
  }

  /** Import a Master sheet export. kind 'collection' replaces the collection; 'verify' sets a verify session's expected list. */
  importCsv(text: string, filename: string, kind: 'collection' | 'verify', sessionId: number | null = null): ImportSummary {
    this.requireCards();
    const parsed = parseMasterCsv(text);
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.rows.length === 0) throw new Error('The file has a header but no card rows.');
    const matched = matchRows(parsed.rows, (s, n) => this.lookup(s, n));
    const id = this.storeImport(kind, filename, sessionId, matched);
    return this.importSummary(id)!;
  }

  /** After a card data refresh, rows that didn't match before (e.g. a brand new set) may match now. */
  rematchImports(): number {
    if (!this.cards) return 0;
    const rows = this.user.selectObjects("SELECT * FROM import_rows WHERE printing_id IS NULL AND error = ''");
    let fixed = 0;
    this.tx(() => {
      for (const r of rows) {
        const [m] = matchRows(
          [{ row_num: Number(r.row_num), card_name: String(r.card_name), set_code: String(r.set_code), collector_number: String(r.collector_number),
            finish_label: String(r.finish_label), finish: String(r.finish) as Finish, qty: Number(r.qty), condition: String(r.condition) as Condition, colors: String(r.colors), error: '' }],
          (s, n) => this.lookup(s, n),
        );
        if (m.printing) {
          this.user.exec('UPDATE import_rows SET printing_id = ?, finish = ?, note = ? WHERE id = ?', { bind: [m.printing.id, m.finish, m.note, r.id] });
          fixed++;
        } else if (m.note !== r.note) {
          this.user.exec('UPDATE import_rows SET note = ? WHERE id = ?', { bind: [m.note, r.id] });
        }
      }
    });
    return fixed;
  }

  importSummary(id: number): ImportSummary | null {
    const r = this.user.selectObject(
      `SELECT i.*, COUNT(r.id) AS rows, COUNT(r.printing_id) AS matched_rows,
              COALESCE(SUM(r.qty), 0) AS copies, COALESCE(SUM(CASE WHEN r.printing_id IS NOT NULL THEN r.qty END), 0) AS matched_copies
         FROM imports i LEFT JOIN import_rows r ON r.import_id = i.id WHERE i.id = ? GROUP BY i.id`,
      [id],
    );
    if (!r) return null;
    return {
      id: Number(r.id), kind: String(r.kind) as ImportSummary['kind'], filename: String(r.filename), imported_at: String(r.imported_at),
      rows: Number(r.rows), matched_rows: Number(r.matched_rows), copies: Number(r.copies), matched_copies: Number(r.matched_copies),
    };
  }

  collectionImport(): ImportSummary | null {
    const id = this.user.selectValue("SELECT id FROM imports WHERE kind = 'collection' ORDER BY id DESC LIMIT 1");
    return id == null ? null : this.importSummary(Number(id));
  }

  verifyImport(sessionId: number): ImportSummary | null {
    const id = this.user.selectValue("SELECT id FROM imports WHERE kind = 'verify' AND session_id = ? ORDER BY id DESC LIMIT 1", [sessionId]);
    return id == null ? null : this.importSummary(Number(id));
  }

  importRows(importId: number, unmatchedOnly = false): ImportRowView[] {
    return this.user
      .selectObjects(
        `SELECT row_num, card_name, set_code, collector_number, finish_label, qty, printing_id, note FROM import_rows
          WHERE import_id = ? ${unmatchedOnly ? 'AND printing_id IS NULL' : ''} ORDER BY row_num`,
        [importId],
      )
      .map((r) => ({
        row_num: Number(r.row_num), card_name: String(r.card_name), set_code: String(r.set_code), collector_number: String(r.collector_number),
        finish_label: String(r.finish_label), qty: Number(r.qty), printing_id: r.printing_id == null ? null : String(r.printing_id), note: String(r.note),
      }));
  }

  clearCollection(): void {
    this.user.exec("DELETE FROM imports WHERE kind = 'collection'");
  }

  /** Copies in the imported collection, per printing and finish. */
  owned(printingIds: string[]): Record<string, Owned> {
    const out: Record<string, Owned> = {};
    const unique = [...new Set(printingIds)];
    if (!unique.length) return out;
    const rows = this.user.selectObjects(
      `SELECT r.printing_id, r.finish, SUM(r.qty) AS qty FROM import_rows r JOIN imports i ON i.id = r.import_id
        WHERE i.kind = 'collection' AND r.printing_id IN (${unique.map(() => '?').join(',')}) GROUP BY r.printing_id, r.finish`,
      unique,
    );
    for (const r of rows) {
      const o = (out[String(r.printing_id)] ??= { nonfoil: 0, foil: 0, etched: 0 });
      o[String(r.finish) as Finish] += Number(r.qty);
    }
    return out;
  }

  // ---- verify ----

  differences(sessionId: number): DiffRow[] {
    const imp = this.verifyImport(sessionId);
    if (!imp) return [];
    const rows = this.user.selectObjects('SELECT * FROM import_rows WHERE import_id = ?', [imp.id]);
    const ids = rows.map((r) => r.printing_id).filter(Boolean).map(String);
    const printings = this.getPrintings(ids);
    const expected: Holding[] = [];
    const notChecked: DiffRow[] = [];
    for (const r of rows) {
      const p = r.printing_id ? printings.get(String(r.printing_id)) : undefined;
      if (!p) {
        notChecked.push({
          type: 'Not checked',
          color: masterColorLabel(String(r.colors)),
          name: String(r.card_name) || `(row ${r.row_num})`,
          expected: `[${String(r.set_code).toUpperCase()} ${r.collector_number}] ${r.finish_label}`.trim(),
          found: '',
          qty_diff: 0,
        });
        continue;
      }
      expected.push({
        printing_id: p.id, finish: String(r.finish) as Finish, qty: Number(r.qty), name: p.name, set_code: p.set_code,
        collector_number: p.collector_number, colors: p.colors, front_type: p.front_type,
      });
    }
    const found: Holding[] = this.scanRows(sessionId)
      .filter((s) => s.status !== 'review' && s.printing_id)
      .map((s) => ({
        printing_id: s.printing_id!, finish: s.finish, qty: s.qty, name: s.name, set_code: s.set_code,
        collector_number: s.collector_number, colors: s.colors, front_type: s.front_type,
      }));
    // Unmatched sheet rows can't be compared; they're listed so nothing is silently skipped.
    return [...verifyDiff(expected, found), ...notChecked];
  }

  // ---- export ----

  exportSession(sessionId: number, kind: ExportKind): ExportFile {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const rows = this.scanRows(sessionId);
    const review_count = rows.filter((r) => r.status === 'review').length;
    const base = slug(session.name);
    switch (kind) {
      case 'master':
        return { filename: `${base}-master-paste.csv`, text: masterPasteCsv([...rows].reverse()), review_count };
      case 'review':
        return { filename: `${base}-review.csv`, text: reviewCsv([...rows].reverse()), review_count };
      case 'manabox':
        return { filename: `${base}-manabox.csv`, text: manaboxCsv([...rows].reverse()), review_count };
      case 'differences':
        return { filename: `${base}-differences.csv`, text: differencesCsv(this.differences(sessionId)), review_count };
    }
  }
}
