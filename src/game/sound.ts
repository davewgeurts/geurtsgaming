/**
 * Unified Web Audio synthesizer for the arcade demo and `@funsociety/corepak`.
 * Everything is synthesised on the spot with Web Audio (oscillators, pitch sweeps, filtered white noise,
 * and a dynamics compressor limiter): there are no audio files to download.
 */
export type Sfx =
  | 'start' | 'wave' | 'shot' | 'enemyShot' | 'hit' | 'clang' | 'boom' | 'hurt' | 'over'
  | 'key' | 'slip' | 'tick' | 'right' | 'wrong' | 'power' | 'repair' | 'jam'
  | 'capsule' | 'bomb' | 'blast'
  | 'warning' | 'lock' | 'core' | 'armOff' | 'bossDown' | 'fanfare' | 'escape' | 'laugh' | 'taunt'
  | 'beam' | 'rocket' | 'nova' | 'shield' | 'shieldUp'
  | 'radio' | 'liftoff' | 'sonic' | 'bell' | 'step' | 'canopy'
  | 'free' | 'tanker' | 'hook' | 'snap' | 'pump' | 'alarm'
  | 'coin' | 'success' | 'terminalKey' | 'terminalError';

const STORE_KEY = 'gg-arcade-sound';
/** Overall loudness. Each sound's own level below is a fraction of this. */
const VOLUME = 0.55;
/** Seconds that must pass before the same sound may play again, for the ones that come in bursts. */
const GAP: Partial<Record<Sfx, number>> = {
  shot: 0.06, enemyShot: 0.12, step: 0.12, hit: 0.04, clang: 0.05, boom: 0.06, lock: 0.04, core: 0.04, laugh: 0.8, taunt: 0.3,
  free: 0.06, pump: 0.2,
};

let userInteracted = false;

if (typeof window !== 'undefined') {
  const markInteracted = () => {
    userInteracted = true;
  };
  const events = ['pointerdown', 'keydown', 'touchstart', 'mousedown', 'click'];
  for (const evt of events) {
    window.addEventListener(evt, markInteracted, { once: true, capture: true, passive: true });
  }
}

export function hasUserInteracted(): boolean {
  if (typeof window === 'undefined') return false;
  if (userInteracted) return true;
  const ua = (navigator as unknown as { userActivation?: { hasBeenActive?: boolean } }).userActivation;
  if (ua && ua.hasBeenActive) {
    userInteracted = true;
    return true;
  }
  return false;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private hiss: AudioBuffer | null = null;
  private last = new Map<Sfx, number>();
  private on = true;

  constructor(private readonly storeKey: string | null = STORE_KEY) {
    if (storeKey && typeof localStorage !== 'undefined') {
      try {
        this.on = localStorage.getItem(storeKey) !== 'off';
      } catch {
        /* storage can be blocked; sound simply starts switched on */
      }
    }
  }

  get enabled(): boolean {
    return this.on;
  }

  set enabled(on: boolean) {
    this.setEnabled(on);
  }

  setEnabled(on: boolean): void {
    this.on = on;
    if (this.storeKey && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.storeKey, on ? 'on' : 'off');
      } catch {
        /* see constructor */
      }
    }
    if (on) this.unlock();
    else void this.ctx?.suspend().catch(() => {});
  }

  /** Toggle mute state (corepak compatibility); returns whether sound is now muted. */
  toggleMute(): boolean {
    this.setEnabled(!this.on);
    return !this.on;
  }

  /** Browsers only let a page make sound after a key press, click or tap, so the game calls this from each of those. */
  unlock(): void {
    userInteracted = true;
    this.ensureContext();
  }

  private ensureContext(): boolean {
    if (!this.on || typeof window === 'undefined') return false;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return false;
    try {
      if (!this.ctx) {
        const ctx = new AudioCtx();
        // A limiter, so several sounds landing together get quieter instead of crackling.
        const limiter = ctx.createDynamicsCompressor();
        const out = ctx.createGain();
        out.gain.value = VOLUME;
        out.connect(limiter).connect(ctx.destination);
        // Two seconds of white noise, reused by every explosion.
        const hiss = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const data = hiss.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        this.ctx = ctx;
        this.out = out;
        this.hiss = hiss;
      }
      // Anything but running: suspended until a first tap, or interrupted (a phone call, the app switcher on an iPhone).
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
      return true;
    } catch {
      /* no sound on this device; the game plays on without it */
      return false;
    }
  }

  /** Free the audio device. */
  dispose(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.out = null;
    this.hiss = null;
  }

  play(name: Sfx): void {
    if (!this.on) return;
    if (!this.ctx && hasUserInteracted()) this.ensureContext();
    const ctx = this.ctx;
    // Sounds asked for while the audio is not running are dropped. Queued up, they would all go off at once later.
    if (!ctx || ctx.state !== 'running') return;
    const gap = GAP[name];
    if (gap !== undefined) {
      if (ctx.currentTime - (this.last.get(name) ?? -1) < gap) return;
      this.last.set(name, ctx.currentTime);
    }
    try {
      this.recipe(name);
    } catch {
      /* a sound that cannot be made must never interrupt the game */
    }
  }

  // `@funsociety/corepak` SoundEffects convenience aliases (preserving original retro terminal recipes)
  playKey(): void { this.play('terminalKey'); }
  playSuccess(): void { this.play('success'); }
  playWin(): void { this.play('fanfare'); }
  playError(): void { this.play('terminalError'); }
  playCoin(): void { this.play('coin'); }

  private recipe(name: Sfx): void {
    const tone = this.tone;
    const noise = this.noise;
    switch (name) {
      case 'start':
        tone('triangle', 330, 330, 0.09, 0.06);
        tone('triangle', 494, 494, 0.09, 0.06, 0.08);
        tone('triangle', 659, 659, 0.16, 0.06, 0.16);
        break;
      case 'wave':
        tone('triangle', 392, 392, 0.1, 0.05);
        tone('triangle', 523, 523, 0.18, 0.05, 0.1);
        break;
      case 'shot':
        tone('square', 900, 420, 0.07, 0.018);
        break;
      case 'enemyShot':
        tone('sawtooth', 320, 170, 0.09, 0.014);
        break;
      case 'hit':
        tone('square', 1300, 800, 0.035, 0.02);
        break;
      case 'clang':
        tone('triangle', 2300, 2100, 0.05, 0.022);
        tone('triangle', 3400, 3200, 0.04, 0.012);
        break;
      case 'boom':
        noise(0.22, 0.09, 1800, 200);
        tone('triangle', 170, 50, 0.18, 0.06);
        break;
      case 'hurt':
        noise(0.32, 0.15, 900, 120);
        tone('sawtooth', 220, 55, 0.3, 0.06);
        break;
      case 'over':
        noise(0.9, 0.16, 1400, 60);
        tone('triangle', 440, 110, 0.9, 0.07);
        tone('triangle', 330, 82, 0.9, 0.05, 0.12);
        break;
      case 'key':
        tone('sine', 1500, 1250, 0.03, 0.028);
        break;
      case 'terminalKey':
        // Original retro terminal key chirp used by davegeurts & exponentialblissmanifesto (600–800 Hz -> 100 Hz, effective gain ~0.05)
        tone('triangle', 600 + Math.random() * 200, 100, 0.05, 0.09);
        break;
      case 'terminalError':
        // Original retro terminal error buzz (150 Hz -> 100 Hz over 0.3s, effective gain ~0.10)
        tone('sawtooth', 150, 100, 0.3, 0.18);
        break;
      case 'slip':
        tone('sawtooth', 150, 105, 0.09, 0.035);
        break;
      case 'tick':
        tone('square', 1000, 1000, 0.03, 0.025);
        break;
      case 'right':
        tone('triangle', 660, 660, 0.1, 0.055);
        tone('triangle', 880, 880, 0.1, 0.055, 0.07);
        tone('triangle', 1320, 1320, 0.16, 0.055, 0.14);
        break;
      case 'success':
        [440, 554.37, 659.25, 880].forEach((f, i) => tone('sine', f, f, i === 3 ? 0.45 : 0.11, 0.055, i * 0.1));
        break;
      case 'coin':
        tone('sine', 987.77, 987.77, 0.08, 0.055);
        tone('sine', 1318.51, 1318.51, 0.42, 0.055, 0.08);
        break;
      case 'wrong':
        tone('square', 220, 165, 0.16, 0.035);
        tone('square', 165, 110, 0.24, 0.035, 0.14);
        break;
      case 'power':
        tone('triangle', 220, 880, 0.36, 0.055);
        tone('triangle', 330, 1320, 0.36, 0.03, 0.05);
        break;
      case 'repair':
        tone('triangle', 523, 523, 0.11, 0.05);
        tone('triangle', 784, 784, 0.2, 0.05, 0.1);
        break;
      case 'jam':
        for (let i = 0; i < 3; i++) tone('square', 110, 100, 0.05, 0.04, 0.3 + i * 0.09);
        break;
      case 'capsule':
        tone('sine', 520, 1040, 0.15, 0.05);
        tone('sine', 300, 70, 0.6, 0.07, 0.1); // time slowing down
        break;
      case 'bomb':
        tone('square', 330, 330, 0.09, 0.045);
        tone('square', 247, 247, 0.12, 0.045, 0.11);
        tone('sine', 300, 70, 0.6, 0.07, 0.1);
        break;
      case 'blast':
        noise(0.75, 0.2, 3200, 80);
        tone('sine', 120, 35, 0.7, 0.14);
        break;
      case 'warning':
        for (let i = 0; i < 4; i++) tone('square', i % 2 ? 349 : 440, i % 2 ? 349 : 440, 0.2, 0.03, i * 0.24);
        break;
      case 'lock':
        tone('sine', 1000, 1250, 0.045, 0.03);
        break;
      case 'core':
        tone('square', 310, 190, 0.06, 0.035);
        break;
      case 'armOff':
        tone('sawtooth', 620, 90, 0.26, 0.045);
        break;
      case 'bossDown':
        noise(1.2, 0.2, 2600, 70);
        tone('sine', 150, 32, 1.1, 0.14);
        break;
      case 'fanfare':
        [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, i === 3 ? 0.3 : 0.11, 0.06, i * 0.1));
        break;
      case 'laugh':
        // "Ha ha ha ha": four barks, each a little lower than the last.
        [330, 294, 262, 220].forEach((f, i) => tone('square', f, f * 0.8, 0.09, 0.035, i * 0.13));
        break;
      case 'taunt':
        tone('sawtooth', 150, 120, 0.09, 0.035);
        tone('sawtooth', 190, 130, 0.14, 0.035, 0.1);
        break;
      case 'beam':
        tone('sawtooth', 1400, 180, 0.28, 0.04);
        tone('sine', 700, 90, 0.28, 0.05);
        break;
      case 'rocket':
        tone('square', 180, 520, 0.14, 0.02);
        break;
      case 'nova':
        noise(0.45, 0.12, 2400, 150);
        tone('sine', 240, 60, 0.45, 0.09);
        break;
      case 'shield':
        tone('triangle', 1200, 300, 0.25, 0.06);
        tone('triangle', 1800, 450, 0.2, 0.03);
        break;
      case 'shieldUp':
        tone('sine', 440, 880, 0.18, 0.035);
        break;
      case 'alarm':
        // Asteroids ahead: three urgent double beeps.
        for (let i = 0; i < 3; i++) {
          tone('square', 880, 880, 0.09, 0.035, i * 0.26);
          tone('square', 660, 660, 0.09, 0.035, i * 0.26 + 0.1);
        }
        break;
      case 'free':
        // Somebody set free: a small bright chime.
        tone('sine', 1175, 1760, 0.14, 0.03);
        tone('sine', 2349, 2349, 0.1, 0.01, 0.04);
        break;
      case 'tanker':
        // The fuel ship announcing itself: two notes on a horn.
        tone('triangle', 196, 196, 0.22, 0.05);
        tone('triangle', 147, 147, 0.34, 0.05, 0.2);
        break;
      case 'hook':
        tone('square', 520, 520, 0.04, 0.03);
        tone('square', 780, 780, 0.06, 0.03, 0.06);
        break;
      case 'snap':
        noise(0.14, 0.07, 2600, 500);
        tone('sawtooth', 520, 130, 0.2, 0.04);
        break;
      case 'pump':
        tone('sine', 300, 380, 0.09, 0.022);
        break;
      case 'bell':
        // A school bell: two bright dings.
        for (const delay of [0, 0.36]) {
          tone('sine', 1320, 1320, 0.5, 0.035, delay);
          tone('sine', 1980, 1980, 0.4, 0.014, delay);
        }
        break;
      case 'step':
        tone('triangle', 150, 95, 0.05, 0.02);
        noise(0.04, 0.012, 900, 300);
        break;
      case 'canopy':
        tone('sine', 300, 620, 0.35, 0.03);
        noise(0.3, 0.02, 600, 2400);
        tone('square', 880, 880, 0.05, 0.018, 0.36);
        break;
      case 'radio':
        tone('square', 1250, 1250, 0.04, 0.016);
        tone('square', 940, 940, 0.05, 0.016, 0.05);
        break;
      case 'liftoff':
        // Three surges, each higher and louder than the last: engines winding up, then the climb.
        [[55, 120, 300, 900, 0.05], [75, 180, 500, 1600, 0.065], [95, 260, 800, 3000, 0.08]].forEach(([from, to, low, high, level], i) => {
          tone('sawtooth', from!, to!, 1.5, level! * 0.7, i * 1.15);
          noise(1.5, level!, low!, high!, i * 1.15);
        });
        break;
      case 'sonic':
        noise(1.1, 0.22, 3000, 60);
        tone('sine', 160, 30, 1, 0.16);
        tone('triangle', 880, 220, 0.5, 0.045);
        break;
      case 'escape':
        tone('triangle', 392, 392, 0.14, 0.05);
        tone('triangle', 294, 262, 0.3, 0.05, 0.14);
        break;
    }
  }

  /** One note: a wave shape sliding from one pitch to another while it fades out. */
  private tone = (wave: OscillatorType, from: number, to: number, seconds: number, level: number, delay = 0): void => {
    const { ctx, out } = this;
    if (!ctx || !out) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + seconds);
    osc.connect(this.fade(t, seconds, level)).connect(out);
    osc.start(t);
    osc.stop(t + seconds + 0.03);
  };

  /** A puff of noise whose brightness falls from one cutoff to another: the body of an explosion. */
  private noise = (seconds: number, level: number, from: number, to: number, delay = 0): void => {
    const { ctx, out, hiss } = this;
    if (!ctx || !out || !hiss) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = hiss;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + seconds);
    src.connect(filter).connect(this.fade(t, seconds, level)).connect(out);
    src.start(t, Math.random() * 0.5, seconds + 0.03);
  };

  /** A volume envelope: up in a few milliseconds (no click), then a smooth fade to silence. */
  private fade(t: number, seconds: number, level: number): GainNode {
    const gain = this.ctx!.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    return gain;
  }
}

export { Sound as SoundEffects, Sound as SoundSystem };
export const sounds = new Sound(null);
