import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import { chooseFinish, masterColorLabel, normName, priceFor, sessionFinishFlag } from '../lib/cards';
import type { DiffRow, Holding } from '../lib/diff';
import { verifyDiff } from '../lib/diff';
import { differencesCsv, manaboxCsv, masterPasteCsv, reviewCsv } from '../lib/exports';
import { matchRows, parseMasterCsv } from '../lib/importMaster';
import { photoPath, scanFileCsv, wantsPhoto } from '../lib/scanFile';
import { identify, type IdentifyInput, type Identification, type NameHit } from '../scan/decide';
import { similarity } from '../scan/parse';
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { MatchedRow } from '../lib/importMaster';
import type {
  Candidate, Condition, Finish, FoilMode, Printing, Scan, ScanRow, ScanStatus, Session, SessionKind, SessionSummary,
} from '../lib/types';

/** Card-data pack schema this app understands (see mtg-scanner-data/scripts/build-pack.mjs). */
export const PACK_SCHEMA_VERSION = 1;

type Row = Record<string, SqlValue>;

export const USER_MIGRATIONS: string[] = [
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
  // v2: "Just scan" support: scan numbers, recognition candidates, Replace last, fixed-by-hand, card photos.
  `ALTER TABLE sessions ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE scans ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE scans ADD COLUMN candidates TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE scans ADD COLUMN replaces_id INTEGER;
   ALTER TABLE scans ADD COLUMN fixed_by_hand INTEGER NOT NULL DEFAULT 0;
   UPDATE scans SET seq = (SELECT COUNT(*) FROM scans s2 WHERE s2.session_id = scans.session_id AND s2.id <= scans.id);
   UPDATE sessions SET next_seq = 1 + (SELECT COALESCE(MAX(seq), 0) FROM scans WHERE scans.session_id = sessions.id);
   CREATE INDEX scans_replaces ON scans (replaces_id);
   CREATE TABLE scan_photos (
     scan_id INTEGER PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
     jpeg BLOB NOT NULL);`,
];

/** Scans hidden because a later "Replace last" scan corrected them. */
const VISIBLE = 'NOT EXISTS (SELECT 1 FROM scans r WHERE r.replaces_id = scans.id)';

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
    seq: Number(r.seq),
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
    candidates: JSON.parse(String(r.candidates ?? '[]')) as Candidate[],
    replaces_id: r.replaces_id == null ? null : Number(r.replaces_id),
    fixed_by_hand: !!r.fixed_by_hand,
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

interface NameEntry {
  oracle_id: string;
  name: string;
  norm: string;
  /** Normalized face names of double-faced, split and adventure cards (OCR reads one face). */
  faces: string[];
  printings: number;
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

export interface ScanFileExport {
  filename: string;
  bytes: Uint8Array;
  /** Review-queue cards; they are in the file with Status = review. */
  review_count: number;
  rows: number;
  photos: number;
}

export interface Settings {
  /** Scan file export: include a photo for every card, not only check/review ones. */
  scanfile_all_photos: boolean;
}

export interface DeletedScan {
  scan: Scan;
  photo: Uint8Array | null;
}

export interface AddScanInput {
  /** null = not sure which printing: the card goes to the review queue with its candidates. */
  printing_id: string | null;
  candidates?: Candidate[];
  /** Straightened card image (JPEG). */
  photo?: Uint8Array;
  replaces_id?: number;
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
    // Exact name first, then names starting with the query, then names containing it.
    const rank = (e: NameEntry) => (e.norm === n ? 0 : e.norm.startsWith(n) ? 1 : 2);
    const hits = this.nameIndex()
      .filter((e) => e.norm.includes(n))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .slice(0, limit);
    const names: SearchHit[] = hits.map((e) => {
      const newest = db.selectObject(`${PRINTING_SELECT} WHERE p.oracle_id = ? ORDER BY p.released_at DESC, p.collector_number LIMIT 1`, [e.oracle_id]);
      return { oracle_id: e.oracle_id, name: e.name, printings: e.printings, newest: toPrinting(newest!) };
    });
    return { exact, names };
  }

  private names: { db: Database; list: NameEntry[] } | null = null;

  /**
   * Card names closest to an OCR reading, best first. Compares against the full name and each face name, so a
   * double-faced card's front name matches "Front // Back".
   */
  matchName(text: string, limit = 5): NameHit[] {
    const q = normName(text);
    if (q.length < 3) return [];
    const hits: NameHit[] = [];
    for (const e of this.nameIndex()) {
      let best = 0;
      for (const n of e.faces.length ? [e.norm, ...e.faces] : [e.norm]) {
        // Cheap length filter before the edit distance.
        if (Math.abs(n.length - q.length) > Math.max(n.length, q.length) * 0.4) continue;
        const sc = similarity(q, n);
        if (sc > best) best = sc;
      }
      if (best >= 0.5) hits.push({ oracle_id: e.oracle_id, name: e.name, score: best });
    }
    return hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length).slice(0, limit);
  }

  private sets: { db: Database; codes: Set<string> } | null = null;

  /** Every set code in the card data (lowercase). */
  setCodes(): Set<string> {
    const db = this.requireCards();
    if (this.sets?.db !== db) {
      const codes = new Set(db.selectObjects('SELECT DISTINCT set_code FROM printings').map((r) => String(r.set_code)));
      this.sets = { db, codes };
    }
    return this.sets.codes;
  }

  /** Recognize a card from its OCR text (see scan/decide.ts for the rules). */
  identify(input: IdentifyInput): Identification {
    return identify(input, {
      knownSets: this.setCodes(),
      lookup: (s, n) => this.lookup(s, n),
      matchName: (t, l) => this.matchName(t, l),
      printingsOf: (o) => this.printingsOf(o),
    });
  }

  /** Load the name index ahead of the first search (no-op without card data). */
  warmUp(): void {
    if (this.cards) {
      this.nameIndex();
      this.setCodes();
    }
  }

  /** One entry per card (oracle id), built once per card-data install; searching it is much faster than SQL LIKE. */
  private nameIndex(): NameEntry[] {
    const db = this.requireCards();
    if (this.names?.db !== db) {
      // One sequential pass over the table, grouped here: in the browser's file storage a GROUP BY (index order, random
      // page reads) took ~9 s against ~0.1 s for this.
      const byOracle = new Map<string, NameEntry>();
      db.exec({
        sql: 'SELECT oracle_id, name, name_norm FROM printings WHERE oracle_id IS NOT NULL',
        rowMode: 'array',
        callback: (r) => {
          const id = String(r[0]);
          const e = byOracle.get(id);
          if (e) e.printings++;
          else {
            const name = String(r[1]);
            const faces = name.includes(' // ') ? name.split(' // ').map(normName) : [];
            byOracle.set(id, { oracle_id: id, name, norm: String(r[2]), faces, printings: 1 });
          }
        },
      });
      this.names = { db, list: [...byOracle.values()] };
    }
    return this.names.list;
  }

  printingsOf(oracleId: string): Printing[] {
    return this.requireCards()
      .selectObjects(`${PRINTING_SELECT} WHERE p.oracle_id = ? ORDER BY p.released_at DESC, s.name, length(p.collector_number), p.collector_number`, [oracleId])
      .map(toPrinting);
  }

  // ---- sessions ----

  listSessions(): SessionSummary[] {
    const sessions = this.user.selectObjects('SELECT * FROM sessions ORDER BY updated_at DESC').map(toSession);
    const scans = this.user.selectObjects(`SELECT session_id, printing_id, finish, qty, status FROM scans WHERE ${VISIBLE}`);
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

  /** The session's cards, newest first. Scans replaced with "Replace last" are left out. */
  scanRows(sessionId: number): ScanRow[] {
    const scans = this.user.selectObjects(`SELECT * FROM scans WHERE session_id = ? AND ${VISIBLE} ORDER BY seq DESC, id DESC`, [sessionId]).map(toScan);
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

  /**
   * Save a card. With a printing it is saved (green) or saved-but-check (yellow); with printing_id null it goes to the
   * review queue (red) holding its candidates, and is not counted until a printing is picked.
   */
  addScan(sessionId: number, input: AddScanInput): Scan {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const p = input.printing_id ? this.getPrinting(input.printing_id) : null;
    if (input.printing_id && !p) throw new Error(`Unknown printing ${input.printing_id}`);

    let finish: Finish;
    let flags: string[];
    let status: ScanStatus;
    if (p) {
      const chosen = input.finish ?? chooseFinish(p.finishes, session.foil_mode).finish;
      if (!chosen) throw new Error('Pick a finish for this card');
      if (p.finishes.length && !p.finishes.includes(chosen)) throw new Error(`${p.name} [${p.set_code.toUpperCase()} ${p.collector_number}] has no ${chosen} version`);
      finish = chosen;
      flags = [input.flag_reason ?? '', sessionFinishFlag(finish, p.finishes, session.foil_mode)].filter(Boolean);
      status = input.status ?? (flags.length ? 'check' : 'saved');
    } else {
      finish = input.finish ?? (session.foil_mode === 'foil' ? 'foil' : 'nonfoil');
      flags = [input.flag_reason || 'Not sure which printing'];
      status = 'review';
    }

    const id = this.tx(() => {
      const seq = Number(this.user.selectValue('SELECT next_seq FROM sessions WHERE id = ?', [sessionId]));
      this.user.exec('UPDATE sessions SET next_seq = next_seq + 1 WHERE id = ?', { bind: [sessionId] });
      this.user.exec(
        `INSERT INTO scans (session_id, seq, printing_id, name, set_code, set_name, collector_number, rarity, colors, front_type,
           img_ver, finish, condition, qty, status, confidence, source, flag_reason, candidates, replaces_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        {
          bind: [sessionId, seq, p?.id ?? null, p?.name ?? '', p?.set_code ?? '', p?.set_name ?? '', p?.collector_number ?? '',
            p?.rarity ?? '', p?.colors ?? '', p?.front_type ?? '', p?.img_ver ?? null, finish,
            input.condition ?? session.default_condition, Math.max(1, input.qty ?? 1), status, input.confidence ?? null,
            input.source ?? 'manual', flags.join('; '), JSON.stringify(input.candidates ?? []), input.replaces_id ?? null, now()],
        },
      );
      const newId = Number(this.user.selectValue('SELECT last_insert_rowid()'));
      if (input.photo) this.user.exec('INSERT INTO scan_photos (scan_id, jpeg) VALUES (?, ?)', { bind: [newId, input.photo] });
      this.touch(sessionId);
      return newId;
    });
    return this.getScan(id)!;
  }

  /** "Replace last": the new scan takes the place of a misread one, which is then hidden everywhere. */
  replaceScan(oldId: number, input: AddScanInput): Scan {
    const old = this.getScan(oldId);
    if (!old) throw new Error('Card to replace not found');
    return this.addScan(old.session_id, { ...input, replaces_id: oldId });
  }

  /**
   * Change printing, finish, condition or quantity. A new printing re-snapshots the card fields. Picking the printing of
   * a review-queue card, or changing the printing of any scanned card, marks it fixed by hand.
   */
  updateScan(id: number, patch: { printing_id?: string; finish?: Finish; condition?: Condition; qty?: number }): Scan {
    const scan = this.getScan(id);
    if (!scan) throw new Error('Card not found');
    const session = this.getSession(scan.session_id)!;
    const p = this.getPrinting(patch.printing_id ?? scan.printing_id ?? '');
    if (!p) throw new Error('Pick a printing first');
    const printingChanged = p.id !== scan.printing_id;
    let finish = patch.finish ?? scan.finish;
    if (p.finishes.length && !p.finishes.includes(finish)) finish = chooseFinish(p.finishes, session.foil_mode).finish ?? p.finishes[0];
    const fixed = scan.fixed_by_hand || scan.status === 'review' || (scan.source === 'scan' && printingChanged);
    // A manual edit is the user confirming the card, so it clears the review/check state.
    const flag = fixed ? 'fixed by hand' : sessionFinishFlag(finish, p.finishes, session.foil_mode);
    const status: ScanStatus = fixed || !flag ? 'saved' : 'check';
    this.tx(() => {
      this.user.exec(
        `UPDATE scans SET printing_id = ?, name = ?, set_code = ?, set_name = ?, collector_number = ?, rarity = ?, colors = ?,
           front_type = ?, img_ver = ?, finish = ?, condition = ?, qty = ?, status = ?, flag_reason = ?, fixed_by_hand = ? WHERE id = ?`,
        {
          bind: [p.id, p.name, p.set_code, p.set_name, p.collector_number, p.rarity, p.colors, p.front_type, p.img_ver, finish,
            patch.condition ?? scan.condition, Math.max(1, patch.qty ?? scan.qty), status, flag, fixed ? 1 : 0, id],
        },
      );
      this.touch(scan.session_id);
    });
    return this.getScan(id)!;
  }

  /** Delete and return the row (with its photo), so the UI can offer to restore it. */
  deleteScan(id: number): DeletedScan | null {
    const scan = this.getScan(id);
    if (!scan) return null;
    const photo = this.getPhoto(id);
    this.tx(() => {
      this.user.exec('DELETE FROM scans WHERE id = ?', { bind: [id] });
      this.touch(scan.session_id);
    });
    return { scan, photo };
  }

  /** Put a deleted scan back (same scan number). Returns its id, which is new if the old id was reused meanwhile. */
  restoreScan(deleted: DeletedScan): number {
    const { scan, photo } = deleted;
    const row: Record<string, SqlValue> = {
      ...scan,
      candidates: JSON.stringify(scan.candidates),
      fixed_by_hand: scan.fixed_by_hand ? 1 : 0,
    };
    if (this.getScan(scan.id)) delete row.id;
    const cols = Object.keys(row);
    return this.tx(() => {
      this.user.exec(`INSERT INTO scans (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, { bind: cols.map((c) => row[c]) });
      const id = Number(this.user.selectValue('SELECT last_insert_rowid()'));
      if (photo) this.user.exec('INSERT INTO scan_photos (scan_id, jpeg) VALUES (?, ?)', { bind: [id, photo] });
      this.touch(scan.session_id);
      return id;
    });
  }

  /** The most recent visible scan: what Undo removes and Replace last corrects. */
  lastScan(sessionId: number): Scan | null {
    const r = this.user.selectObject(`SELECT * FROM scans WHERE session_id = ? AND ${VISIBLE} ORDER BY seq DESC, id DESC LIMIT 1`, [sessionId]);
    return r ? toScan(r) : null;
  }

  /** The straightened card photo (JPEG), if one was captured. */
  getPhoto(scanId: number): Uint8Array | null {
    const v = this.user.selectValue('SELECT jpeg FROM scan_photos WHERE scan_id = ?', [scanId]);
    return v instanceof Uint8Array ? v : null;
  }

  // ---- settings ----

  getSettings(): Settings {
    const m = Object.fromEntries(this.user.selectObjects('SELECT key, value FROM meta').map((r) => [r.key, r.value]));
    return { scanfile_all_photos: m.scanfile_all_photos === '1' };
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Settings {
    const v = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    this.user.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { bind: [key, v] });
    return this.getSettings();
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

  /**
   * "Scan file" ZIP for a Just-scan session: scan.csv (one row per copy) plus photos/NNNN.jpg for check and review
   * cards (or every card, per settings). Review-queue cards are included with their candidates, never blocked.
   */
  exportScanFile(sessionId: number): ScanFileExport {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const rows = this.scanRows(sessionId);
    const { scanfile_all_photos: all } = this.getSettings();
    const withPhoto = new Set(
      this.user
        .selectObjects(`SELECT p.scan_id FROM scan_photos p JOIN scans ON scans.id = p.scan_id WHERE scans.session_id = ?`, [sessionId])
        .map((r) => Number(r.scan_id)),
    );
    const files: Zippable = { 'scan.csv': [strToU8(scanFileCsv(rows, (id) => withPhoto.has(id), all)), { level: 6 }], 'photos/': new Uint8Array(0) };
    let photos = 0;
    for (const r of rows) {
      if (!withPhoto.has(r.id) || !wantsPhoto(r, all)) continue;
      const jpeg = this.getPhoto(r.id);
      if (jpeg) {
        files[photoPath(r.seq)] = [jpeg, { level: 0 }]; // already compressed
        photos++;
      }
    }
    return {
      filename: `${slug(session.name)}-scan-file.zip`,
      bytes: zipSync(files),
      review_count: rows.filter((r) => r.status === 'review').length,
      rows: rows.reduce((n, r) => n + r.qty, 0),
      photos,
    };
  }
}
