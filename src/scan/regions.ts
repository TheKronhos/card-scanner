import type { Rect } from './image';

// Regions of a straightened card, as fractions of its width and height. Measured on modern (2015+) frames; the
// collector line is generous so older layouts (number only, e.g. "146/249") still fall inside it.

/**
 * Card title. Wide enough for long names; the mana cost on the right may come along as junk words, which the name
 * matcher ignores (it matches the name against word runs of the OCR text).
 */
export const NAME_REGION: Rect = { x: 0.065, y: 0.045, w: 0.8, h: 0.06 };

/** Bottom-left collector info: "C 0062" / "FDN • EN" (or "146/249 R" / "M10 • EN" on 2015–2022 cards). */
export const COLLECTOR_REGION: Rect = { x: 0.035, y: 0.905, w: 0.4, h: 0.075 };

/** Full-width bottom strip: 2003–2014 frames print "146/249" at the right end of the copyright line. */
export const BOTTOM_REGION: Rect = { x: 0.03, y: 0.925, w: 0.94, h: 0.055 };

/** Wider search areas, used when the tight boxes read nothing (the crop may be a little off). */
export const COLLECTOR_WIDE: Rect = { x: 0.0, y: 0.86, w: 0.62, h: 0.14 };
export const NAME_WIDE: Rect = { x: 0.02, y: 0.01, w: 0.9, h: 0.13 };

/** The illustration on a normal frame (used for the art match). */
export const ART_REGION: Rect = { x: 0.08, y: 0.115, w: 0.84, h: 0.44 };

/** Size of the straightened card image kept as the scan photo and used for OCR. */
export const CARD_W = 744;
export const CARD_H = 1039;
