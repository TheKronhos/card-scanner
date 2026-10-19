// Small image toolkit on plain pixel arrays, so the same code runs in the browser and in Node tests.

/** RGBA pixels, same layout as the browser's ImageData. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** One byte of luminance per pixel. */
export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Card size ratio (63 × 88 mm). */
export const CARD_RATIO = 63 / 88;

export function toGray(img: Rgba): Gray {
  const out = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return { width: img.width, height: img.height, data: out };
}

/** Bilinear resample of a source rectangle (in source pixels) to w × h. */
export function resampleRgba(src: Rgba, r: Rect, w: number, h: number): Rgba {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = r.w / w;
  const sy = r.h / h;
  const maxX = src.width - 1;
  const maxY = src.height - 1;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(maxY, Math.max(0, r.y + (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(maxY, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(maxX, Math.max(0, r.x + (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(maxX, x0 + 1);
      const tx = fx - x0;
      const a = (y0 * src.width + x0) * 4;
      const b = (y0 * src.width + x1) * 4;
      const c = (y1 * src.width + x0) * 4;
      const d = (y1 * src.width + x1) * 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src.data[a + k] + (src.data[b + k] - src.data[a + k]) * tx;
        const bot = src.data[c + k] + (src.data[d + k] - src.data[c + k]) * tx;
        out[o + k] = top + (bot - top) * ty;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Crop a region given as fractions of the image (0..1), resampled so its height is `outH` pixels. */
export function cropFraction(src: Rgba, f: Rect, outH: number): Rgba {
  const r = { x: f.x * src.width, y: f.y * src.height, w: f.w * src.width, h: f.h * src.height };
  const outW = Math.max(1, Math.round((r.w / r.h) * outH));
  return resampleRgba(src, r, outW, outH);
}

/** Otsu threshold of a grayscale image. */
export function otsu(g: Gray): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of g.data) hist[v]++;
  const total = g.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Black text on white, as OCR likes it. Binarizes with Otsu and inverts when the text is light on dark (text is the
 * minority of pixels), e.g. the white collector line on a black border.
 */
export function textBinarize(g: Gray): Gray {
  const t = otsu(g);
  let dark = 0;
  for (const v of g.data) if (v <= t) dark++;
  const invert = dark > g.data.length / 2;
  const out = new Uint8Array(g.data.length);
  for (let i = 0; i < out.length; i++) {
    const isDark = g.data[i] <= t;
    out[i] = isDark !== invert ? 0 : 255;
  }
  return { width: g.width, height: g.height, data: out };
}

/** Stretch contrast to the full 0–255 range (ignoring the darkest/brightest 2%), keeping gray levels. */
export function stretch(g: Gray): Gray {
  const sorted = Uint8Array.from(g.data).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  const span = Math.max(1, hi - lo);
  const out = new Uint8Array(g.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, ((g.data[i] - lo) * 255) / span));
  return { width: g.width, height: g.height, data: out };
}

/** Variance of the Laplacian: higher is sharper. Used to reject blurry captures. */
export function sharpness(g: Gray): number {
  const { width: w, height: h, data: d } = g;
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = d[i - 1] + d[i + 1] + d[i - w] + d[i + w] - 4 * d[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function grayToRgba(g: Gray): Rgba {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
    out[j] = out[j + 1] = out[j + 2] = g.data[i];
    out[j + 3] = 255;
  }
  return { width: g.width, height: g.height, data: out };
}

/**
 * Find the card's edges inside a capture that roughly frames it (the on-screen guide plus a margin). Looks for the
 * strongest horizontal and vertical brightness edges near each side. Returns the card rectangle in pixels, or null if
 * the edges aren't clear (then the caller uses the guide rectangle as is).
 */
export function findCardEdges(img: Rgba): Rect | null {
  const g = toGray(img);
  const { width: w, height: h, data: d } = g;
  const rows = new Float64Array(h);
  const cols = new Float64Array(w);
  // Only the middle band of each side, to avoid the corners and anything outside the card.
  const x0 = Math.floor(w * 0.2);
  const x1 = Math.floor(w * 0.8);
  const y0 = Math.floor(h * 0.2);
  const y1 = Math.floor(h * 0.8);
  for (let y = 1; y < h - 1; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) s += Math.abs(d[(y + 1) * w + x] - d[(y - 1) * w + x]);
    rows[y] = s / (x1 - x0);
  }
  for (let x = 1; x < w - 1; x++) {
    let s = 0;
    for (let y = y0; y < y1; y++) s += Math.abs(d[y * w + x + 1] - d[y * w + x - 1]);
    cols[x] = s / (y1 - y0);
  }
  // The card's outer edge is the outermost strong edge in each band (a black border adds a second, inner edge).
  const outerEdge = (arr: Float64Array, from: number, to: number, inward: 1 | -1) => {
    let best = 0;
    let mean = 0;
    for (let i = from; i < to; i++) {
      mean += arr[i];
      if (arr[i] > best) best = arr[i];
    }
    mean /= Math.max(1, to - from);
    // A real card edge stands well above the average gradient in its search band.
    if (best <= mean * 2.5 || best <= 12) return -1;
    const start = inward === 1 ? from : to - 1;
    for (let i = start; i >= from && i < to; i += inward) {
      if (arr[i] >= best * 0.5) {
        // Settle on the local maximum of this edge.
        let j = i;
        while (j + inward >= from && j + inward < to && arr[j + inward] > arr[j]) j += inward;
        return j;
      }
    }
    return -1;
  };
  const top = outerEdge(rows, 1, Math.floor(h * 0.25), 1);
  const bottom = outerEdge(rows, Math.floor(h * 0.75), h - 1, -1);
  const left = outerEdge(cols, 1, Math.floor(w * 0.25), 1);
  const right = outerEdge(cols, Math.floor(w * 0.75), w - 1, -1);
  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;
  const r = { x: left, y: top, w: right - left, h: bottom - top };
  // Sanity check the shape: a card is 63:88.
  const ratio = r.w / r.h;
  if (Math.abs(ratio - CARD_RATIO) > 0.08) return null;
  return r;
}

/**
 * Black text on white using a local threshold (mean of the surrounding window), which copes with uneven light and
 * glare better than one global threshold. Inverts light-on-dark text like textBinarize.
 */
export function adaptiveBinarize(g: Gray, windowFrac = 0.5, c = 8): Gray {
  const { width: w, height: h, data: d } = g;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += d[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(4, Math.round((h * windowFrac) / 2));
  const mean = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      mean[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  // Light text on a mostly dark background (the collector line on a black border) is read inverted.
  const sorted = Uint8Array.from(d).sort();
  const lightText = sorted[sorted.length >> 1] < 110;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) {
    const isText = lightText ? d[i] > mean[i] + c : d[i] < mean[i] - c;
    out[i] = isText ? 0 : 255;
  }
  return { width: w, height: h, data: out };
}

/** Card border thickness as a fraction of the card's width and height (about 3 mm on 63 × 88 mm). */
const BORDER_X = 0.05;
const BORDER_Y = 0.036;

export interface CardCut {
  card: Rgba;
  /** How this crop was made: from the card's edges, edges grown by a border width, or the guide box. */
  how: 'edges' | 'edges+border' | 'guide';
}

/**
 * Cut the card out of a camera frame given where the on-screen guide box falls in it. Returns up to three candidate
 * crops, most likely first: the card's own edges; the same grown by one border width (on a dark mat the edge search
 * can find the inside of a black border instead of the card's outer edge); and the guide box as is.
 */
export function cutCard(frame: Rgba, guide: Rect, outW: number, outH: number): CardCut[] {
  const m = 0.08;
  const ax = Math.max(0, Math.round(guide.x - guide.w * m));
  const ay = Math.max(0, Math.round(guide.y - guide.h * m));
  const aw = Math.min(frame.width - ax, Math.round(guide.w * (1 + 2 * m)));
  const ah = Math.min(frame.height - ay, Math.round(guide.h * (1 + 2 * m)));
  // Edge search on a smaller copy for speed, then scale back up.
  const smallH = 480;
  const small = resampleRgba(frame, { x: ax, y: ay, w: aw, h: ah }, Math.round((aw / ah) * smallH), smallH);
  const edges = findCardEdges(small);
  const k = ah / smallH;
  const cuts: CardCut[] = [];
  if (edges) {
    const r = { x: ax + edges.x * k, y: ay + edges.y * k, w: edges.w * k, h: edges.h * k };
    cuts.push({ card: resampleRgba(frame, r, outW, outH), how: 'edges' });
    const grown = { x: r.x - r.w * BORDER_X, y: r.y - r.h * BORDER_Y, w: r.w * (1 + 2 * BORDER_X), h: r.h * (1 + 2 * BORDER_Y) };
    cuts.push({ card: resampleRgba(frame, grown, outW, outH), how: 'edges+border' });
  }
  cuts.push({ card: resampleRgba(frame, guide, outW, outH), how: 'guide' });
  return cuts;
}
