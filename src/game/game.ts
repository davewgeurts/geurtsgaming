/**
 * Hero arcade game: a small top-down shooter drawn as glowing line art, with the learning built in.
 *
 * - Before every wave the ship parks for a break: type a line or, on a touch screen, answer three sums.
 *   Cleaner and faster work means more energy, and more energy means better cannons.
 * - During a wave, boost capsules drift down. Flying into one slows time to a crawl and asks one
 *   question; a right answer pays out the boost, a wrong one jams the cannons for a moment.
 *
 * The questions live in challenge.ts (the rules), maths.ts and lines.ts (the content).
 */
import {
  accepts, choiceChallenge, choose, entryChallenge, lineChallenge, press, tick,
  type Challenge, type ChoiceChallenge, type LineChallenge,
} from './challenge';
import { advance, textWidth, traceText } from './font';
import { LINES, WORDS } from './lines';
import { makeProblem } from './maths';
import {
  CAPSULE, DART, DRIFTER, HEX, MARK_BOMB, MARK_ENERGY, MARK_HULL, SHIP, segments, trace, type Shape,
} from './shapes';

const SAND = '#ecdfd2';
const PINK = '#d98ac0';
const BEST_KEY = 'gg-arcade-best';
const MAX_HULL = 3;
/** Seconds a full energy gauge lasts. */
const ENERGY_SECONDS = 18;
/** Energy above this fires three shots; any energy at all fires two. */
const TRIPLE_AT = 0.5;
/** Accuracy needed on a finished line to repair one point of hull. */
const REPAIR_ACCURACY = 0.9;
/** Points for clean work when the hull has nothing to repair. */
const FULL_HULL_BONUS = 250;
/** Seconds at the start of a question when answers are ignored, so a last tap of Space is not a mistake. */
const BREAK_GRACE = 0.6;
const PROMPT_GRACE = 0.35;
/** Sums in the pre-wave break on touch, and the seconds allowed for each. */
const ROUND_PROBLEMS = 3;
const ROUND_SECONDS = 8;
/** Seconds to answer a boost capsule's question, and how slowly the game runs meanwhile. */
const PROMPT_SECONDS = 10;
const SLOW_MOTION = 0.06;
/** Seconds the cannons stay jammed after a wrong answer. */
const JAM_SECONDS = 2.5;

const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'Space', 'Enter', 'KeyP',
]);

/** Keys that would scroll the page behind the game; swallowed while it is open. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End']);

type State = 'ready' | 'playing' | 'over';
type Kind = 'drifter' | 'dart' | 'hex';
type Reward = 'hull' | 'energy' | 'bomb';

const KINDS: Record<Kind, { shape: Shape; radius: number; hp: number; points: number }> = {
  drifter: { shape: DRIFTER, radius: 12, hp: 1, points: 50 },
  dart: { shape: DART, radius: 11, hp: 1, points: 100 },
  hex: { shape: HEX, radius: 15, hp: 2, points: 150 },
};

const REWARDS: Record<Reward, { mark: Shape; label: string; goal: string }> = {
  hull: { mark: MARK_HULL, label: 'HULL', goal: 'TO REPAIR THE HULL' },
  energy: { mark: MARK_ENERGY, label: 'POWER', goal: 'TO POWER UP' },
  bomb: { mark: MARK_BOMB, label: 'BOMB', goal: 'TO SET OFF A BOMB' },
};

interface Enemy {
  kind: Kind;
  x: number; y: number; vx: number; vy: number; rot: number;
  hp: number; age: number; flash: number; dead: boolean;
  /** Drifter: centre line and sway of its snaking path. */
  anchorX: number; phase: number; amp: number;
  /** Seconds until the next shot; 0 or less means it never fires (drifters) or fires now (hexes). */
  fireIn: number;
  /** Dart: has locked on. Hex: is leaving the screen. */
  committed: boolean;
  /** Hex: the height it holds at. */
  holdY: number;
}
interface Shot { x: number; y: number; vx: number; vy: number; hostile: boolean; dead: boolean }
interface Debris { x: number; y: number; vx: number; vy: number; rot: number; spin: number; len: number; age: number; ttl: number; pink: boolean }
interface Star { x: number; y: number; speed: number; streak: boolean; tier: number }
interface Spawn { at: number; kind: Kind; x: number; phase: number }
/** A boost capsule drifting down the screen. Flying into it asks a question. */
interface Pickup { reward: Reward; x: number; y: number; anchorX: number; phase: number; age: number; dead: boolean }
/** The shockwave of a bomb. */
interface Ring { x: number; y: number; age: number }
interface Box { x: number; y: number; w: number; h: number }
interface Banner { text: string; size: number; color: string; alpha: number }

/** The stop before a wave: the ship holds still while the player earns energy for it. */
interface Break {
  /** The wave this break leads into. */
  wave: number;
  challenge: Challenge;
  /** A round of sums asks several in a row: how many there are, how many are still to come, how they went. */
  total: number;
  left: number;
  right: number;
  earned: number;
  /** Counts down while an answered sum stays on screen, before the next one. */
  pause: number;
  counted: boolean;
  /** Set once the break is scored; the lines then stay on screen for `hold` seconds. */
  result: Banner[] | null;
  hold: number;
}

/** The question a boost capsule asks in the middle of a wave, while the game runs in slow motion. */
interface Prompt {
  reward: Reward;
  challenge: Challenge;
  settled: boolean;
  /** What the answer earned or cost, shown once it is settled. */
  note: string;
  hold: number;
}

export interface GameOptions {
  /** Where the ship flies in from, e.g. the launch button: viewport position, and how large it is drawn there. */
  from?: { x: number; y: number; scale?: number };
  /** Called when the player asks to leave (Esc). */
  onExit: () => void;
  /** Short status messages for a screen-reader live region. */
  onStatus?: (message: string) => void;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const pad6 = (n: number) => String(n).padStart(6, '0');
const percent = (v: number) => Math.round(v * 100);

export class Game {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly coarse = matchMedia('(pointer: coarse)').matches;

  private w = 0;
  private h = 0;
  /** Size multiplier for ships and shots, so the game reads the same on a phone and a big monitor. */
  private scale = 1;
  /** Speed multiplier for things falling down the screen, so a tall screen does not feel slow. */
  private pace = 1;
  private inset = { top: 0, right: 0, bottom: 0, left: 0 };
  private raf = 0;
  private last = 0;
  private time = 0;
  /** 1 is normal speed. Drops to SLOW_MOTION while a boost capsule's question waits for its answer. */
  private timeScale = 1;

  private state: State = 'ready';
  private stateTime = 0;
  private paused = false;
  private keys = new Set<string>();
  /** How the player last steered. Typing is only asked of players at a keyboard. */
  private input: 'keys' | 'touch' = this.coarse ? 'touch' : 'keys';
  private touchId: number | null = null;
  private touch = { x: 0, y: 0 };

  private ship = { x: 0, y: 0, cooldown: 0, invulnerable: 0 };
  /** Size the ship is drawn at. Starts at the launch button's size and eases to the game's. */
  private shipScale = 1;
  private hull = MAX_HULL;
  /** 0 to 1. Earned by typing and sums, spent over time on extra cannons. */
  private energy = 0;
  /** Seconds the cannons are still jammed for. */
  private jam = 0;
  private score = 0;
  private best = 0;
  private newBest = false;

  private wave = 0;
  private waveTime = 0;
  private banner = 0;
  private rest = 0;
  private queue: Spawn[] = [];
  /** Moments in the current wave, in seconds, at which a boost capsule appears. */
  private pickupTimes: number[] = [];

  private brk: Break | null = null;
  private prompt: Prompt | null = null;
  private lastText = '';

  private enemies: Enemy[] = [];
  private shots: Shot[] = [];
  private debris: Debris[] = [];
  private pickups: Pickup[] = [];
  private rings: Ring[] = [];
  private stars: Star[] = [];
  private warp = 1;
  private shake = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly opts: GameOptions) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    try {
      this.best = Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      /* storage can be blocked; the game works without a saved best */
    }

    this.resize();
    const rect = canvas.getBoundingClientRect();
    this.ship.x = opts.from ? opts.from.x - rect.left : this.homeX;
    this.ship.y = opts.from ? opts.from.y - rect.top : this.homeY;
    this.shipScale = opts.from?.scale ?? 1.15 * this.scale;

    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);

    // Draw once straight away so the ship never blinks out between the button and the first frame.
    this.render();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Stop the loop and remove every listener. The last frame stays on the canvas. */
  destroy(): void {
    cancelAnimationFrame(this.raf);
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.onBlur);
    removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
  }

  // ---------------------------------------------------------------- layout

  private get homeX(): number {
    return this.w / 2;
  }
  private get homeY(): number {
    return this.h - this.inset.bottom - Math.max(84, this.h * 0.14);
  }
  private get margin(): number {
    return 20 * this.scale;
  }
  /** Width available for text and buttons, inside the safe area. */
  private get room(): number {
    return this.w - this.inset.left - this.inset.right - 32;
  }

  private resize = (): void => {
    const { canvas, ctx } = this;
    const first = this.w === 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = canvas.clientWidth;
    this.h = canvas.clientHeight;
    canvas.width = Math.round(this.w * dpr);
    canvas.height = Math.round(this.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    this.scale = clamp(Math.min(this.w, this.h) / 700, 0.85, 1.3);
    this.pace = clamp(this.h / 760, 0.9, 1.35);

    const cs = getComputedStyle(canvas.parentElement ?? canvas);
    this.inset = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };

    const count = Math.min(170, Math.floor((this.w * this.h) / 7500));
    this.stars = Array.from({ length: count }, () => this.makeStar(rand(0, this.h)));
    if (!first) this.keepShipInBounds();
  };

  private makeStar(y: number): Star {
    const streak = Math.random() < 0.1;
    return {
      x: rand(0, this.w),
      y,
      speed: streak ? rand(230, 420) : rand(18, 110),
      streak,
      tier: Math.floor(rand(0, 3)),
    };
  }

  private keepShipInBounds(): void {
    const m = this.margin;
    this.ship.x = clamp(this.ship.x, this.inset.left + m, this.w - this.inset.right - m);
    this.ship.y = clamp(this.ship.y, this.h * 0.3, this.h - this.inset.bottom - m - 6);
  }

  // ----------------------------------------------------------------- input

  /** The question waiting for an answer, if there is one. */
  private get challenge(): Challenge | null {
    if (this.brk) return this.brk.result ? null : this.brk.challenge;
    return this.prompt?.challenge ?? null;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const code = e.code;
    if (code === 'Escape') {
      e.preventDefault();
      this.opts.onExit();
      return;
    }
    if (SCROLL_KEYS.has(code)) {
      e.preventDefault();
      return;
    }
    // Enter still activates a focused button (Exit). Space always belongs to the game,
    // so tabbing to Exit and then firing cannot end a run by accident.
    if (e.target instanceof HTMLButtonElement && code === 'Enter') return;

    // A key that answers the open question goes to the question. It is matched on the character, not the
    // physical key, so a line can be typed on any keyboard layout. Everything else (arrow keys, and any
    // key once the answer is in) falls through, so a key held ready for the wave still counts.
    const challenge = this.paused ? null : this.challenge;
    if (challenge && accepts(challenge, e.key)) {
      e.preventDefault();
      if (!e.repeat) {
        this.input = 'keys';
        press(challenge, e.key);
      }
      return;
    }

    if (!GAME_KEYS.has(code)) return;
    e.preventDefault();
    if (e.repeat) return;
    this.input = 'keys';

    if (this.paused) {
      if (code === 'KeyP' || code === 'Space' || code === 'Enter') this.paused = false;
      return;
    }
    if (code === 'KeyP') {
      if (this.state === 'playing') this.paused = true;
      return;
    }
    this.keys.add(code);
    if (this.state === 'ready' && this.stateTime > 0.5) this.begin();
    else if (this.state === 'over' && this.stateTime > 0.9 && (code === 'Space' || code === 'Enter')) this.begin();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    // A button is clicked when Space is released on it; see onKeyDown for why that is blocked.
    if (e.code === 'Space' && e.target instanceof HTMLButtonElement) e.preventDefault();
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
  };

  private onVisibility = (): void => {
    cancelAnimationFrame(this.raf);
    if (document.hidden) {
      this.keys.clear();
      if (this.state === 'playing') this.paused = true;
    } else {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    const touch = e.pointerType !== 'mouse';
    if (!this.paused) {
      // A click or tap on an answer picks it, and is not a steering touch.
      const option = this.optionAt(e);
      if (option !== null && this.challenge) {
        if (touch) this.input = 'touch';
        choose(this.challenge, option);
        return;
      }
    }
    if (touch) {
      this.input = 'touch';
      this.askByTouch();
      this.touchId = e.pointerId;
      this.trackTouch(e);
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety, not a requirement */
      }
    }
    if (this.paused) this.paused = false;
    else if (this.state === 'ready' && this.stateTime > 0.5) this.begin();
    else if (this.state === 'over' && this.stateTime > 0.9) this.begin();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId === this.touchId) this.trackTouch(e);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.touchId) this.touchId = null;
  };

  /** The ship rides a little above the finger so the finger does not cover it. */
  private trackTouch(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.touch.x = e.clientX - rect.left;
    this.touch.y = e.clientY - rect.top - 64;
  }

  /** Which answer box, if any, a click or tap landed on. */
  private optionAt(e: PointerEvent): number | null {
    const c = this.challenge;
    if (!c || c.kind !== 'choice' || c.outcome) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const slack = 5;
    const index = this.optionBoxes(c.options.length, this.challengeTop).findIndex(
      (b) => x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack,
    );
    return index < 0 ? null : index;
  }

  /** Someone on a touch screen has no keys, so a question that needs typing becomes one with answers to tap. */
  private askByTouch(): void {
    if (this.brk && !this.brk.result && this.brk.challenge.kind === 'line') {
      this.startBreak(this.brk.wave);
    } else if (this.prompt && !this.prompt.challenge.outcome && this.prompt.challenge.kind !== 'choice') {
      this.prompt.challenge = this.sum(PROMPT_SECONDS, PROMPT_GRACE);
      this.announce(this.prompt.challenge, '');
    }
  }

  // ------------------------------------------------------------ game state

  private setState(state: State): void {
    this.state = state;
    this.stateTime = 0;
  }

  private begin(): void {
    this.hull = MAX_HULL;
    this.energy = 0;
    this.jam = 0;
    this.score = 0;
    this.newBest = false;
    this.enemies = [];
    this.shots = [];
    this.pickups = [];
    this.rings = [];
    this.prompt = null;
    this.ship.cooldown = 0;
    this.ship.invulnerable = 1;
    if (this.state === 'over') {
      this.ship.x = this.homeX;
      this.ship.y = this.homeY;
    }
    this.setState('playing');
    this.startBreak(1);
  }

  private startWave(n: number): void {
    this.wave = n;
    this.waveTime = 0;
    this.banner = 2.2;
    this.rest = 0;
    this.queue = this.buildWave(n);
    this.opts.onStatus?.(`Wave ${n}.`);
  }

  /** Each wave is chains of drifters, with darts from wave 2 and hexes from wave 3, and a boost capsule or two. */
  private buildWave(n: number): Spawn[] {
    const q: Spawn[] = [];
    const chains = Math.min(6, 2 + Math.ceil(n / 2));
    const chainLength = Math.min(5, 3 + Math.floor(n / 3));
    const gap = Math.max(1.3, 2.6 - n * 0.15);
    let t = 1.5;
    for (let i = 0; i < chains; i++) {
      const x = this.spawnX();
      const phase = rand(0, Math.PI * 2);
      for (let k = 0; k < chainLength; k++) q.push({ at: t + k * 0.42, kind: 'drifter', x, phase });
      t += gap;
    }
    if (n >= 2) {
      for (let i = 0; i < Math.min(8, n + 1); i++) q.push({ at: rand(2.5, t + 1), kind: 'dart', x: this.spawnX(), phase: 0 });
    }
    if (n >= 3) {
      for (let i = 0; i < Math.min(3, Math.floor((n - 1) / 2)); i++) q.push({ at: rand(2, t), kind: 'hex', x: this.spawnX(), phase: 0 });
    }
    this.pickupTimes = Array.from({ length: n >= 4 ? 2 : 1 }, () => rand(3, Math.max(4, t - 1))).sort((a, b) => a - b);
    return q.sort((a, b) => a.at - b.at);
  }

  private spawnX(): number {
    const m = 40 * this.scale + 30;
    return rand(this.inset.left + m, Math.max(this.inset.left + m + 1, this.w - this.inset.right - m));
  }

  private spawn(sp: Spawn): void {
    const n = this.wave;
    const kind = KINDS[sp.kind];
    const e: Enemy = {
      kind: sp.kind,
      x: sp.x, y: -30, vx: 0, vy: 0, rot: 0,
      hp: kind.hp, age: 0, flash: 0, dead: false,
      anchorX: sp.x, phase: sp.phase, amp: 0,
      fireIn: 0, committed: false, holdY: 0,
    };
    if (sp.kind === 'drifter') {
      e.vy = Math.min(112, 62 + n * 5) * this.pace;
      e.amp = Math.min(rand(46, 72) * this.scale, this.w * 0.14);
      if (n >= 3 && Math.random() < 0.3) e.fireIn = rand(0.9, 2.4);
    } else if (sp.kind === 'dart') {
      e.vy = 60 * this.pace;
    } else {
      e.hp = n >= 6 ? 3 : 2;
      e.holdY = clamp(rand(this.h * 0.14, this.h * 0.34), this.inset.top + 90, this.h * 0.4);
      e.vx = (Math.random() < 0.5 ? -1 : 1) * Math.min(130, 70 + n * 6);
      e.fireIn = rand(1.2, 2.2);
    }
    this.enemies.push(e);
  }

  private spawnPickup(): void {
    // Offer what helps most: repairs when the hull is hurt, bombs once the waves get busy.
    const pool: Reward[] = ['energy'];
    if (this.hull < MAX_HULL) pool.push('hull', 'hull');
    if (this.wave >= 2) pool.push('bomb');
    const x = this.spawnX();
    this.pickups.push({ reward: pick(pool), x, y: -24, anchorX: x, phase: rand(0, Math.PI * 2), age: 0, dead: false });
  }

  private destroyEnemy(e: Enemy): void {
    e.dead = true;
    this.score += KINDS[e.kind].points;
    this.burst(KINDS[e.kind].shape, e.x, e.y, this.scale, e.rot, true);
  }

  private hitShip(): void {
    this.hull -= 1;
    this.ship.invulnerable = 1.6;
    if (!this.reduceMotion) this.shake = 0.35;
    for (let i = 0; i < 7; i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(60, 190);
      this.debris.push({
        x: this.ship.x, y: this.ship.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        rot: a, spin: rand(-5, 5), len: rand(4, 9), age: 0, ttl: rand(0.3, 0.6), pink: false,
      });
    }
    if (this.hull <= 0) this.gameOver();
    else this.opts.onStatus?.(`Ship hit. Hull ${this.hull} of ${MAX_HULL}.`);
  }

  /** Clear the screen: every enemy and every enemy shot goes. */
  private detonate(): void {
    for (const e of this.enemies) if (!e.dead) this.destroyEnemy(e);
    for (const s of this.shots) if (s.hostile) s.dead = true;
    this.rings.push({ x: this.ship.x, y: this.ship.y, age: 0 });
    if (!this.reduceMotion) this.shake = 0.4;
  }

  private gameOver(): void {
    this.burst(SHIP, this.ship.x, this.ship.y, this.shipScale, 0, false);
    this.queue = [];
    this.pickupTimes = [];
    this.prompt = null;
    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
      try {
        localStorage.setItem(BEST_KEY, String(this.best));
      } catch {
        /* see constructor */
      }
    }
    this.setState('over');
    this.opts.onStatus?.(`Game over. Score ${this.score}. Wave ${this.wave}.`);
  }

  /** Break a shape into its line segments and send them tumbling outward. */
  private burst(shape: Shape, x: number, y: number, scale: number, rot: number, pink: boolean): void {
    for (const [x1, y1, x2, y2] of segments(shape, x, y, scale, rot)) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const out = Math.atan2(my - y, mx - x) + rand(-0.4, 0.4);
      const v = rand(45, 150);
      this.debris.push({
        x: mx, y: my, vx: Math.cos(out) * v, vy: Math.sin(out) * v,
        rot: Math.atan2(y2 - y1, x2 - x1), spin: rand(-5, 5),
        len: Math.hypot(x2 - x1, y2 - y1), age: 0, ttl: rand(0.5, 0.95), pink,
      });
    }
  }

  // ------------------------------------------------------------- questions

  /** How hard the sums are: 1 for the first two waves, 2 for the next two, 3 from wave five. */
  private get level(): number {
    return Math.min(3, 1 + Math.floor((Math.max(1, this.wave) - 1) / 2));
  }

  /** A sum with answers to pick from. */
  private sum(seconds: number, grace: number): ChoiceChallenge {
    return choiceChallenge(makeProblem(this.level), seconds, grace);
  }

  /** A piece of text to type, never the same one twice running. */
  private text(from: readonly string[]): string {
    let text = pick(from);
    if (text === this.lastText) text = from[(from.indexOf(text) + 1) % from.length]!;
    this.lastText = text;
    return text;
  }

  /** Read the question out for a screen reader, after `lead` (what just happened). */
  private announce(c: Challenge, lead: string): void {
    const ask =
      c.kind === 'line'
        ? `Type: ${c.text}`
        : c.kind === 'choice'
          ? `What is ${c.question}? ${c.options.map((o, i) => `Press ${i + 1} for ${o}`).join(', ')}.`
          : `What is ${c.question}? Type the answer.`;
    this.opts.onStatus?.(`${lead} ${ask}`.trim());
  }

  private startBreak(wave: number): void {
    this.wave = wave;
    this.keys.clear();
    this.shots = [];
    this.pickups = [];
    const typing = this.input === 'keys';
    let challenge: Challenge;
    if (typing) {
      // Lines get longer every two waves. The time allowed is generous enough for a beginner
      // (about 15 words a minute); a fast typist simply finishes early.
      const text = this.text(LINES[Math.min(LINES.length - 1, Math.floor((wave - 1) / 2))]!);
      challenge = lineChallenge(text, 5 + text.length * 0.6, BREAK_GRACE);
    } else {
      challenge = this.sum(ROUND_SECONDS, BREAK_GRACE);
    }
    this.brk = {
      wave, challenge,
      total: typing ? 1 : ROUND_PROBLEMS, left: typing ? 0 : ROUND_PROBLEMS - 1,
      right: 0, earned: 0, pause: 0, counted: false, result: null, hold: 0,
    };
    this.announce(challenge, `${wave === 1 ? 'Game started.' : `Wave ${wave - 1} cleared.`} Charge the ship for wave ${wave}.`);
  }

  private updateBreak(dt: number): void {
    const b = this.brk;
    if (!b) return;
    if (b.result) {
      b.hold -= dt;
      if (b.hold <= 0) {
        this.brk = null;
        this.startWave(b.wave);
      }
      return;
    }
    const c = b.challenge;
    tick(c, dt);
    if (!c.outcome) return;
    if (c.kind === 'line') {
      this.scoreBreak(b);
      return;
    }
    // A round of sums: leave each answer up for a moment (longer when it was wrong, to read the right one).
    if (!b.counted) {
      b.counted = true;
      b.earned += c.outcome.quality;
      if (c.outcome.success) b.right += 1;
      b.pause = c.outcome.success ? 0.7 : 1.7;
    }
    b.pause -= dt;
    if (b.pause > 0) return;
    if (b.left > 0) {
      b.left -= 1;
      b.counted = false;
      b.challenge = this.sum(ROUND_SECONDS, 0.25);
      this.announce(b.challenge, c.outcome.success ? 'Correct.' : 'Not quite.');
    } else {
      this.scoreBreak(b);
    }
  }

  /** Turn the break's work into rewards: energy for how well it went, a repair for clean work. */
  private scoreBreak(b: Break): void {
    const o = b.challenge.outcome;
    if (!o) return;
    const typed = b.challenge.kind === 'line';
    const gain = typed ? o.quality : b.earned / b.total;
    const clean = typed ? o.success && o.accuracy >= REPAIR_ACCURACY : b.right === b.total;
    const hurt = this.hull < MAX_HULL;
    const repaired = clean && hurt;
    const bonus = clean && !hurt ? FULL_HULL_BONUS : 0;
    if (repaired) this.hull += 1;
    this.score += bonus;
    this.energy = Math.min(1, this.energy + gain);

    const lines: Banner[] = [];
    const add = (text: string, size: number, color = SAND, alpha = 1) => lines.push({ text, size, color, alpha });
    if (typed && !o.success) {
      add('OUT OF TIME', 24);
      add(`ENERGY +${percent(gain)}%`, 13);
    } else if (typed) {
      add(`ENERGY +${percent(gain)}%`, 24);
      add(`ACCURACY ${percent(o.accuracy)}% - SPEED ${Math.round(o.wpm)} WPM`, 11, SAND, 0.85);
    } else {
      add(`${b.right} OF ${b.total} CORRECT`, 24);
      add(`ENERGY +${percent(gain)}%`, 13);
    }
    const cannons = this.energy > TRIPLE_AT ? 'TRIPLE CANNONS' : this.energy > 0 ? 'TWIN CANNONS' : '';
    if (cannons) add(cannons, 13, PINK);
    if (repaired) add('HULL REPAIRED', 11, PINK);
    else if (bonus) add(`HULL IS FULL - BONUS ${bonus}`, 11, PINK);
    else if (hurt) {
      const how = !typed ? 'ALL CORRECT REPAIRS' : o.success ? `${percent(REPAIR_ACCURACY)}% ACCURACY REPAIRS` : 'FINISHING THE LINE REPAIRS';
      add(`${how} THE HULL`, 11, SAND, 0.8);
    }
    b.result = lines;
    b.hold = 2.6;
    this.opts.onStatus?.(
      lines.map((l) => l.text.replace('%', ' percent').replace(' - ', ', ').toLowerCase()).join('. ') + '.',
    );
  }

  /** Flying into a boost capsule: time slows and one question decides whether the boost is paid out. */
  private startPrompt(reward: Reward): void {
    const roll = Math.random();
    const challenge =
      this.input === 'touch' || roll < 0.4
        ? this.sum(PROMPT_SECONDS, PROMPT_GRACE)
        : roll < 0.7
          ? entryChallenge(makeProblem(this.level), PROMPT_SECONDS, PROMPT_GRACE)
          : lineChallenge(this.text(WORDS), PROMPT_SECONDS, PROMPT_GRACE);
    this.prompt = { reward, challenge, settled: false, note: '', hold: 0 };
    this.announce(challenge, `Boost capsule. Answer in ${PROMPT_SECONDS} seconds ${REWARDS[reward].goal.toLowerCase()}.`);
  }

  private updatePrompt(dt: number): void {
    const p = this.prompt;
    if (!p) return;
    const o = p.challenge.outcome;
    if (!o) {
      tick(p.challenge, dt);
      return;
    }
    if (!p.settled) {
      p.settled = true;
      if (!o.success) {
        this.jam = JAM_SECONDS;
        p.note = 'CANNONS JAMMED';
        p.hold = 1.8;
      } else {
        p.hold = 1;
        if (p.reward === 'bomb') {
          this.detonate();
          p.note = 'BOOM';
        } else if (p.reward === 'energy') {
          // A quicker answer is a bigger boost: 30% of a gauge at worst, 60% at best.
          const gain = 0.6 * o.quality;
          this.energy = Math.min(1, this.energy + gain);
          p.note = `POWER +${percent(gain)}%`;
        } else if (this.hull < MAX_HULL) {
          this.hull += 1;
          p.note = 'HULL REPAIRED';
        } else {
          this.score += FULL_HULL_BONUS;
          p.note = `HULL IS FULL - BONUS ${FULL_HULL_BONUS}`;
        }
      }
      this.opts.onStatus?.(`${o.success ? 'Correct.' : 'Not quite.'} ${p.note.toLowerCase().replace('%', ' percent')}.`);
    }
    p.hold -= dt;
    if (p.hold <= 0) {
      this.prompt = null;
      // A moment to find your bearings before anything can hit the ship again.
      this.ship.invulnerable = Math.max(this.ship.invulnerable, 1);
    }
  }

  // ---------------------------------------------------------------- update

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (!this.paused) this.update(dt);
    this.render();
  };

  /** `dt` is real time. Questions and their clocks run on it; the world runs on `sim`, which slow motion shrinks. */
  private update(dt: number): void {
    this.time += dt;
    this.stateTime += dt;
    this.shake = Math.max(0, this.shake - dt);
    // Time crawls only while the question is waiting. Once it is answered the action picks straight back up,
    // with the result still on screen and the ship still shielded.
    const asking = this.prompt !== null && !this.prompt.settled;
    this.timeScale += ((asking ? SLOW_MOTION : 1) - this.timeScale) * (1 - Math.exp(-dt * 9));
    const sim = dt * this.timeScale;
    this.banner = Math.max(0, this.banner - sim);

    // Stars speed up once the ship launches, which is what sells the feeling of flying.
    const flying = this.state === 'playing' && !this.brk;
    const targetWarp = flying ? 3.2 : this.state === 'over' ? 0.6 : 1;
    this.warp += (targetWarp - this.warp) * (1 - Math.exp(-dt * 1.8));
    for (const star of this.stars) {
      star.y += star.speed * this.warp * sim;
      if (star.y > this.h + 80) Object.assign(star, this.makeStar(-rand(10, 80)));
    }

    for (const d of this.debris) {
      d.age += sim;
      d.x += d.vx * sim;
      d.y += d.vy * sim;
      d.rot += d.spin * sim;
    }
    this.debris = this.debris.filter((d) => d.age < d.ttl);
    for (const ring of this.rings) ring.age += dt;
    this.rings = this.rings.filter((ring) => ring.age < 0.7);

    this.updateShip(sim);
    if (this.state === 'playing') {
      if (this.brk) {
        this.updateBreak(dt);
      } else {
        this.updateWave(sim);
        this.updatePickups(sim);
        this.updatePrompt(dt);
      }
    }
    this.updateEnemies(sim);
    this.updateShots(sim);
    if (this.state === 'playing') this.collide();

    this.enemies = this.enemies.filter((e) => !e.dead);
    this.shots = this.shots.filter((s) => !s.dead);
    this.pickups = this.pickups.filter((p) => !p.dead);
  }

  private updateShip(dt: number): void {
    const ship = this.ship;
    const k = 1 - Math.exp(-dt * 4);
    this.shipScale += (1.15 * this.scale - this.shipScale) * k;
    if (this.state === 'ready' || this.brk) {
      // Glide in from wherever the launch button was, or back to base for a break.
      ship.x += (this.homeX - ship.x) * k;
      ship.y += (this.homeY - ship.y) * k;
      return;
    }
    if (this.state !== 'playing') return;

    ship.invulnerable = Math.max(0, ship.invulnerable - dt);
    ship.cooldown = Math.max(0, ship.cooldown - dt);
    this.jam = Math.max(0, this.jam - dt);

    const keys = this.keys;
    let dx = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    let dy = (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0);
    if (dx && dy) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    const speed = 380 * this.scale;
    ship.x += dx * speed * dt;
    ship.y += dy * speed * dt;

    if (this.touchId !== null) {
      const tx = this.touch.x - ship.x;
      const ty = this.touch.y - ship.y;
      const dist = Math.hypot(tx, ty);
      if (dist > 0.5) {
        const step = Math.min(dist, 760 * dt);
        ship.x += (tx / dist) * step;
        ship.y += (ty / dist) * step;
      }
    }
    this.keepShipInBounds();

    // On touch the ship fires for as long as a finger is down, so letting go is never a free ride.
    // It holds fire while a capsule's question is open, which keeps the question clear of shots.
    const asking = this.prompt !== null && !this.prompt.settled;
    if ((keys.has('Space') || this.touchId !== null) && ship.cooldown <= 0 && this.jam <= 0 && !asking) {
      ship.cooldown = 0.17;
      const sc = this.scale;
      const up = -680 * this.pace;
      const shoot = (dx: number, dy: number, vx: number) =>
        this.shots.push({ x: ship.x + dx * sc, y: ship.y - dy * sc, vx, vy: up, hostile: false, dead: false });
      // Energy buys cannons: one from the nose, then one from each wing, then all three with the wings angled out.
      if (this.energy <= 0) {
        shoot(0, 18, 0);
      } else if (this.energy <= TRIPLE_AT) {
        shoot(-8, 6, 0);
        shoot(8, 6, 0);
      } else {
        shoot(0, 18, 0);
        shoot(-8, 6, -105 * sc);
        shoot(8, 6, 105 * sc);
      }
    }
    this.energy = Math.max(0, this.energy - dt / ENERGY_SECONDS);
  }

  private updateWave(dt: number): void {
    this.waveTime += dt;
    while (this.queue.length && this.queue[0]!.at <= this.waveTime) this.spawn(this.queue.shift()!);
    while (this.pickupTimes.length && this.pickupTimes[0]! <= this.waveTime) {
      this.pickupTimes.shift();
      this.spawnPickup();
    }
    const cleared = !this.queue.length && !this.enemies.length;
    if (cleared && !this.pickups.length && !this.pickupTimes.length && !this.prompt) {
      this.rest += dt;
      if (this.rest > 0.9) this.startBreak(this.wave + 1);
    }
  }

  private updatePickups(dt: number): void {
    // Once the wave is beaten, a capsule nobody wants hurries off so the game is not left waiting for it.
    const hurry = !this.queue.length && !this.enemies.length ? 3 : 1;
    const reach = (13 + 9) * this.scale;
    for (const p of this.pickups) {
      p.age += dt;
      p.y += 60 * this.pace * hurry * dt;
      p.x = p.anchorX + Math.sin(p.age * 1.3 + p.phase) * 18 * this.scale;
      if (p.y > this.h + 40) p.dead = true;
      else if (!this.prompt && Math.hypot(p.x - this.ship.x, p.y - this.ship.y) < reach) {
        p.dead = true;
        this.startPrompt(p.reward);
      }
    }
  }

  private updateEnemies(dt: number): void {
    const playing = this.state === 'playing';
    const left = this.inset.left + this.margin;
    const right = this.w - this.inset.right - this.margin;
    const ship = this.ship;

    for (const e of this.enemies) {
      e.age += dt;
      e.flash = Math.max(0, e.flash - dt);

      if (e.kind === 'drifter') {
        const sway = Math.sin(e.age * 1.7 + e.phase);
        e.y += e.vy * dt;
        e.x = clamp(e.anchorX + sway * e.amp, left, right);
        e.rot = sway * 0.25;
        if (e.fireIn > 0) {
          e.fireIn -= dt;
          if (e.fireIn <= 0 && playing && e.y > 0 && e.y < this.h * 0.55) {
            this.shots.push({ x: e.x, y: e.y + 12 * this.scale, vx: 0, vy: 230 * this.pace, hostile: true, dead: false });
          }
        }
      } else if (e.kind === 'dart') {
        if (!e.committed && e.age > 0.7) {
          e.committed = true;
          const tx = ship.x - e.x;
          const ty = Math.max(80, ship.y - e.y);
          const dist = Math.hypot(tx, ty);
          const speed = Math.min(560, 400 + this.wave * 14);
          e.vx = (tx / dist) * speed;
          e.vy = (ty / dist) * speed;
          e.rot = Math.atan2(-e.vx, e.vy);
        }
        e.x += e.vx * dt;
        e.y += e.vy * dt;
      } else {
        e.rot += dt * 1.4;
        if (!e.committed && (e.age > 16 || !playing)) {
          e.committed = true;
          e.vy = 160;
        }
        if (e.committed) {
          e.y += e.vy * dt;
        } else if (e.y < e.holdY) {
          e.y += 95 * this.pace * dt;
        } else {
          e.x += e.vx * dt;
          if (e.x < left || e.x > right) {
            e.x = clamp(e.x, left, right);
            e.vx = -e.vx;
          }
          e.fireIn -= dt;
          if (e.fireIn <= 0) {
            e.fireIn = rand(1.5, 2.6);
            const tx = ship.x - e.x;
            const ty = ship.y - e.y;
            const dist = Math.hypot(tx, ty) || 1;
            const speed = Math.min(300, 210 + this.wave * 8);
            this.shots.push({ x: e.x, y: e.y, vx: (tx / dist) * speed, vy: (ty / dist) * speed, hostile: true, dead: false });
          }
        }
      }

      if (e.y > this.h + 40 || e.x < -60 || e.x > this.w + 60) e.dead = true;
    }
  }

  private updateShots(dt: number): void {
    for (const s of this.shots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.y < -20 || s.y > this.h + 20 || s.x < -20 || s.x > this.w + 20) s.dead = true;
    }
  }

  private collide(): void {
    const ship = this.ship;
    const shipRadius = 9 * this.scale;
    // Nothing can hit the ship while its pilot is busy with a question; the ship's own shots still land.
    const safe = ship.invulnerable > 0 || this.prompt !== null;

    for (const s of this.shots) {
      if (s.dead) continue;
      if (s.hostile) {
        if (!safe && Math.hypot(s.x - ship.x, s.y - ship.y) < shipRadius + 3) {
          s.dead = true;
          this.hitShip();
          if (this.state !== 'playing') return;
        }
        continue;
      }
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (Math.hypot(s.x - e.x, s.y - e.y) < KINDS[e.kind].radius * this.scale + 4) {
          s.dead = true;
          e.hp -= 1;
          e.flash = 0.1;
          if (e.hp <= 0) this.destroyEnemy(e);
          break;
        }
      }
    }

    if (safe) return;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (Math.hypot(e.x - ship.x, e.y - ship.y) < KINDS[e.kind].radius * this.scale + shipRadius) {
        this.destroyEnemy(e);
        this.hitShip();
        return;
      }
    }
  }

  // ---------------------------------------------------------------- render

  /** Stroke whatever `build` adds to the path: a soft wide pass for glow, then the bright line. */
  private ink(color: string, alpha: number, width: number, build: () => void, glow = true): void {
    const ctx = this.ctx;
    ctx.beginPath();
    build();
    ctx.strokeStyle = color;
    if (glow) {
      ctx.lineWidth = width + 4;
      ctx.globalAlpha = alpha * 0.2;
      ctx.stroke();
    }
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Largest size up to `size` at which `text` still fits the screen width. */
  private fit(text: string, size: number): number {
    const width = textWidth(text, size);
    return width > this.room ? (size * this.room) / width : size;
  }

  private centred(text: string, y: number, size: number, alpha = 1, color = SAND): void {
    const fitted = this.fit(text, size);
    this.ink(color, alpha, fitted > 16 ? 1.8 : 1.4, () => traceText(this.ctx, text, this.w / 2, y, fitted, 'center'));
  }

  private render(): void {
    const { ctx, w, h } = this;
    const sc = this.scale;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    if (this.shake > 0) ctx.translate(rand(-1, 1) * this.shake * 14, rand(-1, 1) * this.shake * 14);

    // Stars, batched by brightness so each tier is a single stroke.
    for (let tier = 0; tier < 3; tier++) {
      this.ink(SAND, [0.22, 0.45, 0.8][tier]!, 1.2, () => {
        for (const star of this.stars) {
          if (star.streak || star.tier !== tier) continue;
          ctx.moveTo(star.x, star.y);
          ctx.lineTo(star.x, star.y + Math.max(0.6, star.speed * this.warp * 0.02));
        }
      }, false);
    }
    this.ink(SAND, 0.16, 1, () => {
      for (const star of this.stars) {
        if (!star.streak) continue;
        ctx.moveTo(star.x, star.y);
        ctx.lineTo(star.x, star.y + star.speed * (0.08 + this.warp * 0.035));
      }
    }, false);

    // Debris fades in two steps rather than per piece, again to keep strokes batched.
    for (const pink of [true, false]) {
      for (const fresh of [true, false]) {
        this.ink(pink ? PINK : SAND, fresh ? 1 : 0.45, 1.5, () => {
          for (const d of this.debris) {
            if (d.pink !== pink || d.age < d.ttl * 0.55 !== fresh) continue;
            const hx = (Math.cos(d.rot) * d.len) / 2;
            const hy = (Math.sin(d.rot) * d.len) / 2;
            ctx.moveTo(d.x - hx, d.y - hy);
            ctx.lineTo(d.x + hx, d.y + hy);
          }
        }, fresh);
      }
    }

    // Boost capsules are drawn in the ship's colour, small and quiet: an offer, not a threat.
    if (this.pickups.length) {
      const pulse = 1 + 0.07 * Math.sin(this.time * 5);
      this.ink(SAND, 0.9, 1.5, () => {
        for (const p of this.pickups) {
          trace(ctx, CAPSULE, p.x, p.y, sc * pulse, 0);
          trace(ctx, REWARDS[p.reward].mark, p.x, p.y, sc * 0.8, 0);
        }
      });
      this.ink(SAND, 0.65, 1.1, () => {
        for (const p of this.pickups) traceText(ctx, REWARDS[p.reward].label, p.x, p.y + 19 * sc, 7, 'center');
      }, false);
    }

    this.ink(PINK, 1, 1.6, () => {
      for (const e of this.enemies) if (e.flash <= 0) trace(ctx, KINDS[e.kind].shape, e.x, e.y, sc, e.rot);
      for (const s of this.shots) {
        if (!s.hostile) continue;
        const r = 4 * sc;
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y);
        ctx.lineTo(s.x, s.y + r);
        ctx.lineTo(s.x - r, s.y);
        ctx.closePath();
      }
    });
    // An enemy that was just hit flashes in the ship's colour.
    this.ink(SAND, 1, 2.2, () => {
      for (const e of this.enemies) if (e.flash > 0) trace(ctx, KINDS[e.kind].shape, e.x, e.y, sc, e.rot);
    });

    // The ship's shots are drawn along the way they fly, so the angled wing cannons look angled.
    this.ink(SAND, 1, 1.8, () => {
      for (const s of this.shots) {
        if (s.hostile) continue;
        const len = (11 * sc) / (Math.hypot(s.vx, s.vy) || 1);
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.vx * len, s.y - s.vy * len);
      }
    });

    for (const ring of this.rings) {
      const t = ring.age / 0.7;
      const r = t * Math.hypot(w, h);
      this.ink(SAND, 1 - t, 2.4, () => {
        ctx.moveTo(ring.x + r, ring.y);
        ctx.arc(ring.x, ring.y, r, 0, Math.PI * 2);
      });
    }

    // The ship blinks while it cannot be hit, but never disappears on the ready or paused screens.
    const blinking = this.state === 'playing' && !this.paused && !this.prompt && !this.brk && this.ship.invulnerable > 0;
    const shipVisible = this.state !== 'over' && (!blinking || Math.floor(this.time * 14) % 2 === 0);
    if (shipVisible) {
      const s = this.shipScale;
      this.ink(SAND, 1, 1.7, () => trace(ctx, SHIP, this.ship.x, this.ship.y, s, 0));
      const flame = (this.state === 'playing' ? rand(8, 15) : rand(4, 8)) * s;
      this.ink(PINK, 1, 1.5, () => {
        ctx.moveTo(this.ship.x - 3 * s, this.ship.y + 13 * s);
        ctx.lineTo(this.ship.x, this.ship.y + 13 * s + flame);
        ctx.lineTo(this.ship.x + 3 * s, this.ship.y + 13 * s);
      });
      // A shield ring shows that nothing can hit the ship while a capsule's question is open.
      if (this.prompt) this.ink(SAND, 0.5, 1.2, () => trace(ctx, CAPSULE, this.ship.x, this.ship.y, 2.1 * s, this.time * 0.5), false);
    }
    ctx.restore();

    // Slow motion dims the action a little, so the question is the brightest thing on screen.
    if (this.timeScale < 0.99) {
      ctx.fillStyle = `rgba(3, 7, 26, ${(0.5 * (1 - this.timeScale)).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (this.state !== 'ready') this.renderHud();
    this.renderMessages();
  }

  private renderHud(): void {
    const { ctx } = this;
    const left = this.inset.left + 16;
    const top = this.inset.top + 18;
    this.ink(SAND, 1, 1.4, () => {
      traceText(ctx, `SCORE ${pad6(this.score)}`, left, top, 12);
      for (let i = 0; i < this.hull; i++) trace(ctx, SHIP, left + 9 + i * 24, top + 34, 0.55, 0);
      if (this.w >= 640) traceText(ctx, `BEST ${pad6(this.best)}`, this.w / 2, top, 12, 'center');
    });
    this.ink(SAND, 0.7, 1.2, () => traceText(ctx, `WAVE ${this.wave}`, left, top + 52, 9));

    // Energy gauge: ten ticks beside the hull. The taller ones are the half that buys the third cannon.
    const gauge = left + 84;
    if (this.jam > 0) {
      if (this.time % 0.5 < 0.32) this.ink(PINK, 1, 1.3, () => traceText(ctx, 'JAMMED', gauge, top + 30, 9));
    } else if (this.energy > 0) {
      const lit = Math.ceil(this.energy * 10);
      const ticks = (from: number, to: number) => () => {
        for (let i = from; i < to; i++) {
          const tall = i >= TRIPLE_AT * 10 ? 3 : 0;
          ctx.moveTo(gauge + i * 5, top + 29 - tall);
          ctx.lineTo(gauge + i * 5, top + 40);
        }
      };
      this.ink(PINK, 1, 1.6, ticks(0, lit));
      if (lit < 10) this.ink(SAND, 0.3, 1.2, ticks(lit, 10), false);
    }
  }

  private renderMessages(): void {
    const mid = this.h * 0.42;
    const blink = this.time % 1.1 < 0.75;

    if (this.paused) {
      this.centred('PAUSED', mid, 28);
      this.centred(this.coarse ? 'TAP TO RESUME' : 'PRESS P TO RESUME', mid + 52, 11, 0.8);
      return;
    }

    if (this.state === 'ready') {
      const alpha = Math.min(1, this.stateTime / 0.6);
      if (this.coarse) {
        if (blink) this.centred('TAP TO START', mid, 20, alpha);
        this.centred('HOLD AND DRAG TO FLY AND FIRE', mid + 46, 11, alpha * 0.8);
        this.centred('SOLVE SUMS TO POWER UP', mid + 70, 11, alpha * 0.8, PINK);
        this.centred('FLY INTO CAPSULES FOR A BOOST', mid + 94, 11, alpha * 0.8, PINK);
      } else {
        if (blink) this.centred('PRESS SPACE TO START', mid, 20, alpha);
        this.centred('WASD OR ARROWS TO FLY - SPACE TO FIRE', mid + 46, 11, alpha * 0.8);
        this.centred('P TO PAUSE - ESC TO EXIT', mid + 70, 11, alpha * 0.8);
        this.centred('TYPE WELL BEFORE EACH WAVE TO POWER UP', mid + 94, 11, alpha * 0.8, PINK);
        this.centred('FLY INTO CAPSULES FOR A BOOST', mid + 118, 11, alpha * 0.8, PINK);
      }
      return;
    }

    if (this.brk) {
      this.renderBreak(this.brk);
      return;
    }

    if (this.prompt) {
      const p = this.prompt;
      const top = this.challengeTop;
      this.renderChallenge(p.challenge, top, `${p.challenge.kind === 'line' ? 'TYPE' : 'SOLVE'} ${REWARDS[p.reward].goal}`);
      if (p.settled) this.centred(p.note, top + 180, 13, 1, p.challenge.outcome?.success ? PINK : SAND);
      return;
    }

    if (this.state === 'playing' && this.banner > 0) {
      this.centred(`WAVE ${this.wave}`, mid, 26, Math.min(1, this.banner / 0.5));
      return;
    }

    if (this.state === 'over') {
      const alpha = Math.min(1, this.stateTime / 0.5);
      this.centred('GAME OVER', mid - 30, 32, alpha);
      this.centred(`SCORE ${pad6(this.score)}`, mid + 30, 15, alpha);
      this.centred(this.newBest ? 'NEW BEST!' : `BEST ${pad6(this.best)}`, mid + 60, 11, alpha * 0.8, this.newBest ? PINK : SAND);
      if (this.stateTime > 0.9 && blink) {
        this.centred(this.coarse ? 'TAP TO RETRY' : 'PRESS SPACE TO RETRY - ESC TO EXIT', mid + 104, 11, 0.9);
      }
    }
  }

  // -------------------------------------------------------- question render

  /** Top of the question panel. A break sits mid-screen; a capsule's question sits higher, clear of the ship. */
  private get challengeTop(): number {
    return this.brk ? this.h * 0.42 - 44 : Math.max(this.inset.top + 96, this.h * 0.2);
  }

  /** Where the answer boxes of a multiple-choice sum go. Used to draw them and to tell which one was clicked. */
  private optionBoxes(count: number, top: number): Box[] {
    const gap = 14;
    const w = Math.min(96, (this.room - gap * (count - 1)) / count);
    const x0 = this.w / 2 - (w * count + gap * (count - 1)) / 2;
    return Array.from({ length: count }, (_, i) => ({ x: x0 + i * (w + gap), y: top + 76, w, h: 50 }));
  }

  private renderBreak(b: Break): void {
    const top = this.challengeTop;
    if (b.result) {
      const alpha = Math.min(1, b.hold / 0.4);
      let y = top + 10;
      for (const line of b.result) {
        this.centred(line.text, y, line.size, alpha * line.alpha, line.color);
        y += line.size + (line.size > 20 ? 24 : 17);
      }
      return;
    }
    const title =
      b.challenge.kind === 'line'
        ? `TYPE TO CHARGE THE SHIP FOR WAVE ${b.wave}`
        : `SOLVE TO CHARGE THE SHIP - ${b.total - b.left} OF ${b.total}`;
    this.renderChallenge(b.challenge, top, title);
  }

  private renderChallenge(c: Challenge, top: number, title: string): void {
    const { ctx } = this;
    const alpha = Math.min(1, c.age / 0.35);
    const done = c.outcome !== null;
    this.centred(title, top, 11, alpha * 0.8);

    if (c.kind === 'line') {
      this.renderLine(c, top + 40, alpha);
    } else {
      this.centred(`${c.question} = ${done && c.kind === 'entry' ? c.answer : '?'}`, top + 32, 22, alpha);
      if (c.kind === 'choice') {
        this.optionBoxes(c.options.length, top).forEach((b, i) => {
          const correct = done && i === c.correct;
          const wrongPick = done && i === c.picked && i !== c.correct;
          const a = alpha * (done && !correct && !wrongPick ? 0.35 : 1);
          this.ink(correct ? PINK : SAND, a, correct ? 2.6 : 1.5, () => {
            ctx.rect(b.x, b.y, b.w, b.h);
            if (wrongPick) {
              ctx.moveTo(b.x, b.y);
              ctx.lineTo(b.x + b.w, b.y + b.h);
              ctx.moveTo(b.x + b.w, b.y);
              ctx.lineTo(b.x, b.y + b.h);
            }
          });
          this.ink(correct ? PINK : SAND, a, 1.8, () => traceText(ctx, c.options[i]!, b.x + b.w / 2, b.y + (b.h - 16) / 2, 16, 'center'));
          // The number key that picks this answer, for players at a keyboard.
          if (!done && this.input === 'keys') this.ink(SAND, a * 0.55, 1, () => traceText(ctx, String(i + 1), b.x + 6, b.y + 6, 7), false);
        });
      } else {
        // The answer field: what has been typed so far, and a cursor after it.
        const field = { x: this.w / 2 - 66, y: top + 76, w: 132, h: 50 };
        const right = done && c.outcome?.success;
        this.ink(right ? PINK : SAND, alpha, right ? 2.6 : 1.5, () => ctx.rect(field.x, field.y, field.w, field.h));
        const typedWidth = textWidth(c.typed, 18);
        if (c.typed) this.ink(right ? PINK : SAND, alpha, 1.8, () => traceText(ctx, c.typed, this.w / 2, field.y + 16, 18, 'center'));
        if (!done && this.time % 0.9 < 0.55) {
          const cx = this.w / 2 + typedWidth / 2 + (c.typed ? 5 : -6);
          this.ink(SAND, alpha, 1.8, () => {
            ctx.moveTo(cx, field.y + 37);
            ctx.lineTo(cx + 12, field.y + 37);
          });
        }
      }
      this.renderTimer(c, top + 144, alpha);
    }

    // Under the question: how to answer it, then how the answer went. A miss always shows the right answer.
    const o = c.outcome;
    const hintY = c.kind === 'line' ? top + 124 : top + 158;
    if (o) {
      const said =
        o.success
          ? c.kind === 'line' ? 'NICE TYPING' : 'CORRECT'
          : c.kind === 'line' ? 'OUT OF TIME'
            : `${c.timeLeft <= 0 ? 'OUT OF TIME' : 'NOT QUITE'} - ${c.question} = ${c.kind === 'choice' ? c.options[c.correct] : c.answer}`;
      this.centred(said, hintY, 10, 1, o.success ? PINK : SAND);
    } else if (c.kind !== 'line') {
      const how = c.kind === 'entry' ? 'TYPE THE ANSWER' : this.input === 'keys' ? 'CLICK AN ANSWER OR PRESS ITS NUMBER' : 'TAP THE ANSWER';
      this.centred(how, hintY, 8, alpha * 0.6);
    }
  }

  private renderLine(c: LineChallenge, y: number, alpha: number): void {
    const { ctx } = this;
    const wrong = c.error > 0;
    // The line is laid out once, so typed and untyped letters keep their places as the colour moves across.
    const size = this.fit(c.text, 20);
    const step = advance(size);
    const x = this.w / 2 - textWidth(c.text, size) / 2 + (wrong && !this.reduceMotion ? rand(-3, 3) : 0);
    const next = x + c.index * step;
    if (c.index > 0) this.ink(PINK, alpha, 1.8, () => traceText(ctx, c.text.slice(0, c.index), x, y, size));
    if (c.index < c.text.length) {
      this.ink(SAND, alpha * (wrong ? 1 : 0.85), 1.6, () => traceText(ctx, c.text.slice(c.index), next, y, size));
      // Cursor under the next letter; it thickens and turns pink on a wrong key.
      this.ink(wrong ? PINK : SAND, alpha, wrong ? 3 : 1.8, () => {
        ctx.moveTo(next, y + size + 7);
        ctx.lineTo(next + (size / 6) * 4, y + size + 7);
      });
    }
    this.renderTimer(c, y + size + 30, alpha);
    const pressed = c.index + c.misses;
    if (!c.outcome) this.centred(`ACCURACY ${pressed ? percent(c.index / pressed) : 100}%`, y + size + 46, 9, alpha * 0.7);
  }

  /** Time left, as a line that shrinks toward the centre and turns pink for the last quarter. */
  private renderTimer(c: Challenge, y: number, alpha: number): void {
    const left = Math.max(0, c.timeLeft / c.limit);
    const half = Math.min(170, (this.room - 32) / 2) * left;
    this.ink(left < 0.25 ? PINK : SAND, alpha * 0.7, 1.4, () => {
      this.ctx.moveTo(this.w / 2 - half, y);
      this.ctx.lineTo(this.w / 2 + half, y);
    }, false);
  }
}
