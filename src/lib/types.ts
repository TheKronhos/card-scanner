export type Finish = 'nonfoil' | 'foil' | 'etched';
export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';
export type FoilMode = 'nonfoil' | 'foil' | 'ask';
/** scan = "Just scan": records exactly what was scanned, no collection and no comparison. */
export type SessionKind = 'scan' | 'add' | 'verify';
/** saved = green, check = saved but flagged (yellow), review = not saved yet, needs a pick (red). */
export type ScanStatus = 'saved' | 'check' | 'review';

export const CONDITIONS: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const FINISH_LABEL: Record<Finish, string> = { nonfoil: 'Non-foil', foil: 'Foil', etched: 'Etched' };

/** A printing from the card data pack. */
export interface Printing {
  id: string;
  oracle_id: string | null;
  name: string;
  face_names: string[] | null;
  set_code: string; // lowercase Scryfall code
  set_name: string;
  collector_number: string;
  rarity: string;
  lang: string;
  released_at: string;
  layout: string;
  type_line: string;
  front_type: string;
  finishes: Finish[];
  frame: string;
  frame_effects: string[];
  border_color: string;
  full_art: boolean;
  promo: boolean;
  promo_types: string[];
  colors: string; // WUBRG letters, '' = colorless
  usd: number | null;
  usd_foil: number | null;
  usd_etched: number | null;
  img_ver: string | null;
  img_back: boolean;
}

export interface Session {
  id: number;
  name: string;
  kind: SessionKind;
  foil_mode: FoilMode;
  default_condition: Condition;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary extends Session {
  copies: number;
  review: number;
  total_usd: number;
}

/** A possible printing for a scan the recognizer wasn't sure about (best first). */
export interface Candidate {
  printing_id: string;
  name: string;
  set_code: string;
  collector_number: string;
  colors: string;
  front_type: string;
  img_ver?: string | null;
  score: number | null; // 0..1
}

/** One entry in a session: a physical card (or qty copies of it). Card fields are a snapshot of the printing. */
export interface Scan {
  id: number;
  session_id: number;
  /** Scan number within the session (1, 2, 3...). Never reused, so photo names stay stable. */
  seq: number;
  printing_id: string | null; // null while it's in the review queue
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  colors: string;
  front_type: string;
  img_ver: string | null;
  finish: Finish;
  condition: Condition;
  qty: number;
  status: ScanStatus;
  confidence: number | null; // 0..1, null for manual adds
  source: 'manual' | 'scan';
  flag_reason: string;
  /** Top candidate printings from recognition, best first (empty for manual adds). */
  candidates: Candidate[];
  /** Set when this scan was a "Replace last" correction: the scan it replaced is hidden everywhere. */
  replaces_id: number | null;
  /** The user picked or changed the printing of a scanned card by hand (e.g. in the review queue). */
  fixed_by_hand: boolean;
  created_at: string;
}

/** A scan joined with the current price for its finish. */
export interface ScanRow extends Scan {
  unit_price: number | null;
}
