import { CARD_RATIO, cutCard, type CardCut, type Rect, type Rgba } from './image';
import { CARD_H, CARD_W } from './regions';

export type CameraErrorKind = 'insecure' | 'unsupported' | 'denied' | 'no-camera' | 'busy' | 'other';

export class CameraError extends Error {
  kind: CameraErrorKind;
  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const isAndroid = () => /Android/i.test(navigator.userAgent);
// iPadOS reports itself as a Mac with a touchscreen.
const isIos = () => !isAndroid() && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** What to do when the camera is blocked, worded for the device in hand. */
export function permissionHelp(): string {
  if (isIos()) {
    return 'On iPad/iPhone: open Settings › Apps › Safari › Camera and choose Allow (or Ask). In Safari you can also tap the “aA” or page-settings button in the address bar › Website Settings › Camera › Allow. Then come back and tap Try again.';
  }
  if (isStandalone()) {
    return 'On Android: long-press the Card Scanner icon › App info › Permissions › Camera › Allow. Then come back and tap Try again.';
  }
  return 'On Android Chrome: tap the settings icon left of the address bar › Permissions › Camera › Allow, then tap Try again.';
}

/** Open the back camera at the highest practical resolution. Throws CameraError with a plain-language message. */
export async function openCamera(): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new CameraError('insecure', `The camera only works on a secure (https) page. Open https://thekronhos.github.io/card-scanner/ instead of ${location.origin}.`);
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('unsupported', 'This browser can’t use the camera. Use Chrome on Android or Safari on iPad.');
  }
  const ask = (video: MediaTrackConstraints) => navigator.mediaDevices.getUserMedia({ audio: false, video });
  try {
    return await ask({ facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === 'OverconstrainedError') {
      try {
        return await ask({ facingMode: 'environment' });
      } catch {
        /* handled below */
      }
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError('denied', `Camera permission is blocked. ${permissionHelp()}`);
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('no-camera', 'No camera was found on this device.');
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      throw new CameraError('busy', 'The camera is in use by another app or tab. Close it there, then tap Try again.');
    }
    throw new CameraError('other', `The camera couldn’t start (${name || String(e)}).`);
  }
}

export function stopCamera(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function torchSupported(stream: MediaStream | null): boolean {
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
  return !!caps?.torch;
}

export async function setTorch(stream: MediaStream | null, on: boolean): Promise<boolean> {
  const track = stream?.getVideoTracks()[0];
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

/** The on-screen guide: a card-shaped box centered in the preview, as a fraction of the preview size. */
export function guideRect(viewW: number, viewH: number): Rect {
  const h = Math.min(viewH * 0.8, (viewW * 0.88) / CARD_RATIO);
  const w = h * CARD_RATIO;
  return { x: (viewW - w) / 2, y: (viewH - h) / 2, w, h };
}

/** Map a rectangle on the preview (object-fit: cover) to pixels in the camera frame. */
export function viewToFrame(r: Rect, viewW: number, viewH: number, frameW: number, frameH: number): Rect {
  const scale = Math.max(viewW / frameW, viewH / frameH);
  const offX = (frameW * scale - viewW) / 2;
  const offY = (frameH * scale - viewH) / 2;
  return { x: (r.x + offX) / scale, y: (r.y + offY) / scale, w: r.w / scale, h: r.h / scale };
}

/** Grab the current camera frame and cut candidate card images out of the guide box (see cutCard). */
export function captureCard(video: HTMLVideoElement): CardCut[] {
  const fw = video.videoWidth;
  const fh = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = fw;
  canvas.height = fh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, fw, fh);
  const frame: Rgba = ctx.getImageData(0, 0, fw, fh);
  const guide = viewToFrame(guideRect(video.clientWidth, video.clientHeight), video.clientWidth, video.clientHeight, fw, fh);
  return cutCard(frame, guide, CARD_W, CARD_H);
}

const SAMPLE_W = 24;
const SAMPLE_H = 34;

/** A tiny grayscale thumbnail of what's inside the guide box, for cheap motion and "same card" checks. */
export function sampleGuide(video: HTMLVideoElement, canvas: HTMLCanvasElement): Uint8Array | null {
  if (!video.videoWidth || !video.clientWidth) return null;
  const g = viewToFrame(guideRect(video.clientWidth, video.clientHeight), video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, g.x, g.y, g.w, g.h, 0, 0, SAMPLE_W, SAMPLE_H);
  const d = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
  const out = new Uint8Array(SAMPLE_W * SAMPLE_H);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return out;
}

/** Mean absolute difference of two samples (0 = identical, 255 = opposite). */
export function sampleDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** JPEG of the straightened card, stored as the scan photo. */
export async function cardJpeg(card: Rgba): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = card.width;
  c.height = card.height;
  c.getContext('2d')!.putImageData(new ImageData(card.data as ImageDataArray, card.width, card.height), 0, 0);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('JPEG encode failed'))), 'image/jpeg', 0.85));
  return new Uint8Array(await blob.arrayBuffer());
}
