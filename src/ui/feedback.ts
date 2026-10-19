import type { ScanStatus } from '../lib/types';

// Sound + full-screen color flash so results can be followed without looking closely at the screen.
// green = saved, yellow = saved but check, red = needs review.

let ctx: AudioContext | null = null;

// Browsers only allow audio after a user gesture; unlock on the first tap.
window.addEventListener(
  'pointerdown',
  () => {
    try {
      ctx ??= new AudioContext();
      void ctx.resume();
    } catch {
      ctx = null;
    }
  },
  { once: true },
);

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.25) {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export function beep(kind: ScanStatus) {
  if (kind === 'saved') tone(1046, 0, 0.12);
  else if (kind === 'check') {
    tone(784, 0, 0.1);
    tone(784, 0.14, 0.1);
  } else {
    tone(196, 0, 0.32, 'square', 0.18);
  }
}

export function flash(kind: ScanStatus) {
  const el = document.createElement('div');
  el.className = `flash ${kind}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 500);
}

export function feedback(kind: ScanStatus) {
  flash(kind);
  beep(kind);
  navigator.vibrate?.(kind === 'review' ? [90, 60, 90] : kind === 'check' ? [40, 60, 40] : 35);
}
