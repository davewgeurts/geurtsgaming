/**
 * Zero-dependency WebAudio micro-synth for tactile arcade UI on the game showcase pages.
 * Muted by default so classrooms and quiet browsers are never surprised; toggling sound ON
 * remembers the choice for the browser session. Never plays if reduced motion is requested.
 */

const STORAGE_KEY = 'gg_showcase_sfx';

let ctx: AudioContext | null = null;
let enabled = false;

try {
  enabled = sessionStorage.getItem(STORAGE_KEY) === '1';
} catch {
  enabled = false;
}

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function ensureContext(): AudioContext | null {
  if (!enabled || reducedMotion() || typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

export function isSfxEnabled(): boolean {
  return enabled;
}

export function setSfxEnabled(next: boolean): boolean {
  enabled = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {}
  if (next) {
    const ac = ensureContext();
    if (ac) playTone(ac, 660, 880, 0.07, 'triangle', 0.08);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('gg-sfx-change', { detail: { enabled } }));
  }
  return enabled;
}

export function toggleSfx(): boolean {
  return setSfxEnabled(!enabled);
}

function playTone(
  ac: AudioContext,
  startHz: number,
  endHz: number,
  durationSec: number,
  type: OscillatorType = 'triangle',
  peakGain = 0.08,
  delaySec = 0,
): void {
  const t0 = ac.currentTime + delaySec;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(startHz, t0);
  if (endHz !== startHz) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), t0 + durationSec);
  }
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + durationSec + 0.01);
}

/** Tactile arcade button click. */
export function sfxClick(): void {
  const ac = ensureContext();
  if (!ac) return;
  playTone(ac, 520, 260, 0.045, 'triangle', 0.07);
}

/** Mechanical keycap clack (bright pop on hit, low thud on typo). */
export function sfxKey(correct: boolean): void {
  const ac = ensureContext();
  if (!ac) return;
  if (correct) {
    playTone(ac, 920, 480, 0.038, 'triangle', 0.065);
  } else {
    playTone(ac, 170, 110, 0.09, 'sawtooth', 0.06);
  }
}

/** Neon cyan laser zap for background word-blasting Easter egg. */
export function sfxLaser(): void {
  const ac = ensureContext();
  if (!ac) return;
  playTone(ac, 1180, 220, 0.11, 'sawtooth', 0.055);
}

/** Short celebratory 4-note arcade arpeggio. */
export function sfxFanfare(): void {
  const ac = ensureContext();
  if (!ac) return;
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((hz, i) => {
    playTone(ac, hz, hz * 1.01, 0.13, 'triangle', 0.08, i * 0.075);
  });
}

/** Wasteland V8 overdrive rev growl. */
export function sfxRev(): void {
  const ac = ensureContext();
  if (!ac) return;
  playTone(ac, 85, 215, 0.24, 'sawtooth', 0.08);
  playTone(ac, 128, 310, 0.22, 'square', 0.04, 0.02);
}

/** Twin-stick blaster impact for the Mutant Boss Bounty Arena. */
export function sfxBlast(crit: boolean): void {
  const ac = ensureContext();
  if (!ac) return;
  playTone(ac, crit ? 680 : 440, 75, crit ? 0.14 : 0.095, 'sawtooth', crit ? 0.095 : 0.07);
  if (crit) {
    playTone(ac, 980, 1320, 0.08, 'triangle', 0.07, 0.03);
  }
}

/** Boss exterminated bounty chime. */
export function sfxBossDown(): void {
  const ac = ensureContext();
  if (!ac) return;
  playTone(ac, 190, 45, 0.25, 'sawtooth', 0.09);
  playTone(ac, 587.33, 880, 0.14, 'triangle', 0.08, 0.09);
  playTone(ac, 880, 1174.66, 0.18, 'triangle', 0.085, 0.18);
}
