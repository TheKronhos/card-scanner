import { cropFraction, toGray, type Rect, type Rgba } from './image';

// The List: a small white planeswalker symbol printed just left of the collector info at the bottom-left of the card.
// On the modern black-border frame that spot is otherwise plain black. It is located relative to the collector text
// (found by OCR), not at a fixed spot, because a capture can be cropped a little off.
//
// Promo-pack and prerelease stamps (in the art) are NOT detected yet: a generic template couldn't separate them from
// busy art on Scryfall scans. Cards that have such a twin go to review with both printings offered.

export interface Marks {
  /**
   * Share of bright pixels just left of the collector text (≥0.06 = List symbol, ≤0.03 = none), or null when the
   * collector text couldn't be located.
   */
  listBright: number | null;
}

/** Where the collector info sits on the card, as fractions of the card (from the OCR word boxes). */
export interface TextAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** Calibrated on Scryfall scans: List printings ≥ 0.10, modern-frame regular printings ≤ 0.02. */
export const LIST_YES = 0.06;
export const LIST_NO = 0.03;

/** The symbol's box: about 3 % of the card wide, ending just before the text, spanning both collector lines. */
export function listSymbolRect(a: TextAnchor): Rect {
  const lineH = a.bottom - a.top;
  return { x: a.left - 0.042, y: a.top - lineH * 0.1, w: 0.034, h: lineH * 1.2 };
}

export function findMarks(card: Rgba, anchor: TextAnchor | null): Marks {
  if (!anchor) return { listBright: null };
  const r = listSymbolRect(anchor);
  if (r.x < 0 || r.y < 0 || r.y + r.h > 1) return { listBright: null };
  const g = toGray(cropFraction(card, r, 40));
  let bright = 0;
  for (const v of g.data) if (v > 140) bright++;
  return { listBright: bright / g.data.length };
}
