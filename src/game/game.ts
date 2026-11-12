/**
 * Hero arcade game: a small top-down shooter drawn as glowing line art, with the learning built in.
 *
 * - Before every wave the ship parks for a break: type a line or, on a touch screen, answer three sums.
 *   Cleaner and faster work means more energy, and more energy means better cannons.
 * - During a wave, boost capsules drift down. Flying into one slows time to a crawl and asks one
 *   question; a right answer pays out the boost, a wrong one jams the cannons for a moment.
 * - Bombs drift down too. Touching one asks a question that has to be answered, or the ship is lost.
 * - Every wave ends with a mini boss, in neon (see boss.ts). It throws bombs of its own, and taunts.
 * - Upgrade capsules ask a question too; a right answer offers three upgrades to pick from (see upgrades.ts).
 * - Two wireframe faces watch from the top corners: the pilot's, and the boss's (see avatar.ts).
 * - Sound effects are synthesised (see sound.ts); the overlay's Sound button switches them off.
 * - Behind it all, low-poly planets, moons and rocks drift by at different depths (see backdrop.ts).
 * - It opens in the cockpit: a briefing from the flight commander, then a take-off that hands over to
 *   the top-down view (see intro.ts).
 *
 * The questions live in challenge.ts (the rules), maths.ts and lines.ts (the content).
 */
import { traceAvatar, type Mood, type Who } from './avatar';
import { Backdrop } from './backdrop';
import { NEON, NEON_LIST, bossParts, createBoss, shootBoss, tapBoss, touchesBoss, updateBoss, type Boss, type BossEnv, type Hit } from './boss';
import {
  accepts, choiceChallenge, choose, entryChallenge, lineChallenge, press, tick,
  type Challenge, type ChoiceChallenge, type LineChallenge,
} from './challenge';
import { advance, textWidth, traceText } from './font';
import { Intro, type Ink, type IntroCue, type IntroView } from './intro';
import { LINES, TAUNTS, WORDS, type Taunt } from './lines';
import { makeProblem } from './maths';
import {
  CAPSULE, DART, DRIFTER, FRIEND, HEX, MARK_BOMB, MARK_ENERGY, MARK_HULL, MARK_STAR, MINE, MITE, ROCKET, SAUCER, SHARD, SHIP, SPINNER, SPLITTER,
  WEAVER, segments, trace, type Shape,
} from './shapes';
import { Sound, type Sfx } from './sound';
import { UPGRADES, offerUpgrades, type Upgrade, type UpgradeId } from './upgrades';

const SAND = '#ecdfd2';
const PINK = '#d98ac0';
/** Enemies come in a few warm colours, one per family, so a new kind is easy to tell from an old one. */
const LILAC = '#b3a0ff';
const AMBER = '#f0b45a';
const ROSE = '#ff7ab8';
/** How far the scenery slides when the ship crosses the whole screen, as a share of the screen's width. */
const PARALLAX = 0.3;
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
/** Points for defusing a bomb. */
const DEFUSE_POINTS = 300;
/** Seconds before an offered upgrade can be picked, so a key or finger still down from the question picks nothing. */
const OFFER_GRACE = 0.4;
/** How often the upgrades that fire on their own go off, and how long a spent shield takes to come back. */
const LANCE_SECONDS = 2.8;
const ROCKET_SECONDS = 1.5;
const NOVA_SECONDS = 9;
const SHIELD_SECONDS = 12;
/** How far out to each side the wingmates fly, and how far from the ship the guardian circles (px at scale 1). */
const WING = 30;
const ORBIT = 46;

const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'Space', 'Enter', 'KeyP',
]);

/** Keys that would scroll the page behind the game; swallowed while it is open. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End']);

type State = 'ready' | 'playing' | 'over';
type Kind = 'drifter' | 'dart' | 'hex' | 'weaver' | 'mite' | 'splitter' | 'shard' | 'spinner' | 'saucer';
/** What a boost capsule pays out. A blast clears the screen. */
type Reward = 'hull' | 'energy' | 'blast' | 'upgrade';
/** What a question is being answered for: a capsule's reward, or to defuse a bomb. */
type Stake = Reward | 'defuse';

const KINDS: Record<Kind, { shape: Shape; radius: number; hp: number; points: number; color: string }> = {
  drifter: { shape: DRIFTER, radius: 12, hp: 1, points: 50, color: PINK },
  dart: { shape: DART, radius: 11, hp: 1, points: 100, color: PINK },
  hex: { shape: HEX, radius: 15, hp: 2, points: 150, color: PINK },
  weaver: { shape: WEAVER, radius: 12, hp: 1, points: 80, color: LILAC },
  mite: { shape: MITE, radius: 7, hp: 1, points: 30, color: LILAC },
  splitter: { shape: SPLITTER, radius: 17, hp: 3, points: 120, color: AMBER },
  shard: { shape: SHARD, radius: 8, hp: 1, points: 40, color: AMBER },
  spinner: { shape: SPINNER, radius: 13, hp: 1, points: 90, color: ROSE },
  saucer: { shape: SAUCER, radius: 16, hp: 2, points: 200, color: ROSE },
};
const ENEMY_COLORS = [PINK, LILAC, AMBER, ROSE];
/** The groups a wave is built from, and the wave each first appears in. */
type Group = 'drifters' | 'mites' | 'weavers' | 'spinners';
const GROUP_FROM: Record<Group, number> = { drifters: 1, mites: 1, weavers: 2, spinners: 3 };

const STAKES: Record<Stake, { mark: Shape; label: string; goal: string }> = {
  hull: { mark: MARK_HULL, label: 'HULL', goal: 'TO REPAIR THE HULL' },
  energy: { mark: MARK_ENERGY, label: 'POWER', goal: 'TO POWER UP' },
  blast: { mark: MARK_BOMB, label: 'BLAST', goal: 'TO SET OFF A BLAST' },
  upgrade: { mark: MARK_STAR, label: 'UPGRADE', goal: 'TO WIN AN UPGRADE' },
  defuse: { mark: MINE, label: 'BOMB', goal: 'OR THE BOMB GOES OFF' },
};

interface Enemy {
  kind: Kind;
  x: number; y: number; vx: number; vy: number; rot: number;
  hp: number; age: number; flash: number; dead: boolean;
  /** Drifter, weaver, spinner: centre line and width of its path. */
  anchorX: number; phase: number; amp: number;
  /** Seconds until the next shot; 0 or less means it never fires (drifters) or fires now (hexes, saucers). */
  fireIn: number;
  /** Dart: has locked on. Hex: is leaving the screen. */
  committed: boolean;
  /** Hex, saucer: the height it holds at. Spinner: the height of the centre of its loop. */
  holdY: number;
}
interface Shot {
  x: number; y: number; vx: number; vy: number; hostile: boolean; dead: boolean; color: string;
  /** Piercing laser: how many more enemies this shot can pass through, and the one it is passing through now. */
  pierce?: number;
  skip?: Enemy | null;
  /** Fired by an upgrade rather than the ship's own cannons, so it cannot choose a sum boss's answer. */
  stray?: boolean;
}
interface Rocket { x: number; y: number; vx: number; vy: number; age: number; dead: boolean }
interface Beam { x: number; y: number; age: number }
interface Debris { x: number; y: number; vx: number; vy: number; rot: number; spin: number; len: number; age: number; ttl: number; color: string }
interface Star { x: number; y: number; speed: number; streak: boolean; tier: number }
interface Spawn { at: number; kind: Kind; x: number; phase: number; /** Weaver, saucer: which way it sets off, -1 or 1. */ dir?: number }
/** A boost capsule drifting down the screen. Flying into it asks a question. */
interface Pickup { reward: Reward; x: number; y: number; anchorX: number; phase: number; age: number; dead: boolean }
/** A bomb drifting down the screen. Touching it means answering a question or losing the ship. */
/** A hazard bomb. One thrown by a boss drifts after the ship. */
interface Mine { x: number; y: number; anchorX: number; phase: number; age: number; dead: boolean; thrown: boolean }
/** An expanding shockwave. A negative age delays it. */
/** An expanding ring. It grows to `reach` px, or right across the screen when that is left out. */
interface Ring { x: number; y: number; age: number; color: string; reach?: number }
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
  stake: Stake;
  challenge: Challenge;
  settled: boolean;
  /** A bomb that was not defused: when the result has been read, the ship is lost. */
  fatal: boolean;
  /** What the answer earned or cost, shown once it is settled. */
  note: string;
  hold: number;
  /** An upgrade capsule answered right: the upgrades to choose from, until one is picked. */
  offer: Upgrade[] | null;
  offerAge: number;
}

export interface GameOptions {
  /** Called when the player asks to leave (Esc). */
  onExit: () => void;
  /** Short status messages for a screen-reader live region. */
  onStatus?: (message: string) => void;
}

/** What a shot landing on each part of a boss sounds like. */
const BOSS_SOUNDS: Record<Exclude<Hit, 'miss'>, Sfx> = {
  blocked: 'clang', core: 'core', down: 'bossDown', arm: 'hit', armOff: 'armOff', lock: 'lock', right: 'right', wrong: 'wrong',
};

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const pad6 = (n: number) => String(n).padStart(6, '0');
const percent = (v: number) => Math.round(v * 100);

export class Game {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly coarse = matchMedia('(pointer: coarse)').matches;
  private readonly sound = new Sound();

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
  /** Moments in the current wave, in seconds, at which a boost capsule or a bomb appears. */
  private pickupTimes: number[] = [];
  private mineTimes: number[] = [];

  private boss: Boss | null = null;
  /** The last boss sum read out for screen readers. */
  private bossAsked = 0;
  /** After a boss: what happened to it, and the seconds left before the next break. */
  private bossNote = '';
  private intermission = 0;

  private brk: Break | null = null;
  private prompt: Prompt | null = null;
  private lastText = '';

  private enemies: Enemy[] = [];
  private shots: Shot[] = [];
  private debris: Debris[] = [];
  private pickups: Pickup[] = [];
  private mines: Mine[] = [];
  private rings: Ring[] = [];
  private stars: Star[] = [];
  private readonly backdrop = new Backdrop();
  /** The view from the cockpit that opens the game. null once the ship has taken off. */
  private intro: Intro | null = null;
  private readonly inkFn: Ink = (color, alpha, width, build, glow) => this.ink(color, alpha, width, build, glow);
  /** Where the ship is across the screen, -0.5 to 0.5, smoothed: the scenery slides the other way. */
  private drift = 0;
  private warp = 1;
  private shake = 0;

  /** Upgrades earned this game, and the moving parts some of them need. */
  private upgrades = new Set<UpgradeId>();
  private upgradeTimes: number[] = [];
  private shield = { ready: false, recharge: 0 };
  private lanceIn = 0;
  private rocketIn = 0;
  private novaIn = 0;
  /** The guardian's angle round the ship, and the pause before it can ram another enemy. */
  private orbit = 0;
  private guardCool = 0;
  private rockets: Rocket[] = [];
  private beams: Beam[] = [];

  /** The faces in the corners: what each is feeling and until when. */
  private pilot = { mood: 'calm' as Mood, until: 0 };
  private villain = { mood: 'calm' as Mood, until: 0, line: '', lineUntil: 0, nextIdle: 0, show: 0, warned: false, bye: false, beaten: false };
  /** How hard the pilot is leaning into a turn, -1 to 1. It turns the pilot's head. */
  private lean = 0;
  private lastShipX = 0;

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
    this.shipScale = 1.15 * this.scale;
    // The game opens in the cockpit; the ship itself is out of sight below the screen until it has taken off.
    this.intro = new Intro(this.reduceMotion, this.onIntroCue);
    this.ship.x = this.homeX;
    this.ship.y = this.h + 80;
    opts.onStatus?.(Intro.script(this.input === 'touch'));

    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);

    // The click that opened the game is what allows it to make sound.
    this.sound.unlock();
    // Draw once straight away, so the overlay never fades in on an empty canvas.
    this.render();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Keep the score if it beats the best so far. Returns whether it did. */
  private saveBest(): boolean {
    if (this.score <= this.best) return false;
    this.best = this.score;
    try {
      localStorage.setItem(BEST_KEY, String(this.best));
    } catch {
      /* see constructor */
    }
    return true;
  }

  /** Stop the loop and remove every listener. The last frame stays on the canvas. */
  destroy(): void {
    // Leaving in the middle of a record run still counts.
    this.saveBest();
    cancelAnimationFrame(this.raf);
    this.sound.dispose();
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

  get soundOn(): boolean {
    return this.sound.enabled;
  }

  /** Switch the sound effects on or off. The choice is remembered for next time. */
  setSound(on: boolean): void {
    this.sound.setEnabled(on);
  }

  private get maxHull(): number {
    return MAX_HULL + (this.upgrades.has('armour') ? 1 : 0);
  }

  // ----------------------------------------------------------------- faces

  /** Set the pilot's expression for a while. A `soft` feeling (a kill) does not wipe a wince off the pilot's face. */
  private feel(mood: Mood, seconds: number, soft = false): void {
    if (soft && this.pilot.mood === 'hurt' && this.pilot.until > this.time) return;
    this.pilot = { mood, until: this.time + seconds };
  }

  /**
   * Make the boss pull a face and, `chance` of the time, say something. It does not talk over itself
   * unless `force` says this line matters more than the last one.
   */
  private taunt(kind: Taunt, mood: Mood, seconds: number, chance = 1, force = false): void {
    const v = this.villain;
    v.mood = mood;
    v.until = this.time + seconds;
    if (Math.random() >= chance || (!force && v.lineUntil - 1.2 > this.time)) return;
    const pool = TAUNTS[kind];
    let line: string = pick(pool);
    if (line === v.line && pool.length > 1) line = pool[(pool.indexOf(line as never) + 1) % pool.length]!;
    v.line = line;
    v.lineUntil = this.time + 2.6;
    v.nextIdle = this.time + rand(6, 9);
    v.show = Math.max(v.show, this.time + 3);
    this.sound.play(mood === 'laugh' ? 'laugh' : 'taunt');
  }

  private get pilotMood(): Mood {
    if (this.state === 'over') return 'out';
    if (this.pilot.until > this.time) return this.pilot.mood;
    return this.hull <= 1 ? 'worried' : 'calm';
  }

  private get villainMood(): Mood {
    const v = this.villain;
    if (v.beaten) return 'out';
    if (v.until > this.time) return v.mood;
    // Its mouth moves for the first second or so of whatever it is saying.
    return v.lineUntil - 1.4 > this.time ? 'talk' : 'calm';
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
    // A phone held sideways is short: everything shrinks further there, to leave room to fly.
    this.scale = clamp(Math.min(this.w, this.h) / 700, this.h < 500 ? 0.62 : 0.85, 1.3);
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
    this.backdrop.resize(this.w, this.h);
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
    this.sound.unlock();
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
        this.type(challenge, e.key);
      }
      return;
    }

    // Number keys pick one of the upgrades on offer.
    const offer = this.paused ? null : this.prompt?.offer;
    if (offer && e.key >= '1' && e.key <= String(offer.length)) {
      e.preventDefault();
      if (!e.repeat) {
        this.input = 'keys';
        this.chooseUpgrade(Number(e.key) - 1);
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
    if (this.state === 'ready') {
      if (code === 'Space' || code === 'Enter') this.go();
    } else if (this.state === 'over' && this.stateTime > 0.9 && (code === 'Space' || code === 'Enter')) this.begin();
  };

  /** Pass a key to the open question, with a click for a key that counted and a buzz for a wrong letter. */
  private type(c: Challenge, key: string): void {
    const before = c.kind === 'line' ? c.index : c.kind === 'entry' ? c.typed.length : 0;
    const misses = c.kind === 'choice' ? 0 : c.misses;
    press(c, key);
    if (c.kind === 'line') {
      if (c.index > before) this.sound.play('key');
      else if (c.misses > misses) this.sound.play('slip');
    } else if (c.kind === 'entry' && c.misses > misses) {
      this.sound.play('slip');
      this.opts.onStatus?.(`Not quite. One more try. What is ${c.question}?`);
    } else if (c.kind === 'entry' && c.typed.length !== before) {
      this.sound.play('key');
    }
  }

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
      this.saveBest();
      this.keys.clear();
      if (this.state === 'playing') this.paused = true;
    } else {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    const touch = e.pointerType !== 'mouse';
    this.sound.unlock();
    if (!this.paused) {
      // A click or tap on an upgrade or an answer picks it, and is not a steering touch.
      const offer = this.prompt?.offer;
      const offered = offer ? this.boxAt(e, this.offerBoxes(offer.length)) : null;
      if (offered !== null) {
        if (touch) this.input = 'touch';
        this.chooseUpgrade(offered);
        return;
      }
      const option = this.optionAt(e);
      if (option !== null && this.challenge) {
        if (touch) this.input = 'touch';
        choose(this.challenge, option);
        return;
      }
      // On a sum boss, a tap or click on a little ship chooses its answer.
      if (this.state === 'playing' && !this.prompt && this.boss) {
        const rect = this.canvas.getBoundingClientRect();
        if (this.strikeBoss(e.clientX - rect.left, e.clientY - rect.top, true, true)) {
          if (touch) this.input = 'touch';
          return;
        }
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
    else if (this.state === 'ready') this.go();
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
    return this.boxAt(e, this.optionBoxes(c.options.length, this.challengeTop));
  }

  /** Which of these boxes, if any, a click or tap landed on (with a little slack for fingers). */
  private boxAt(e: PointerEvent, boxes: Box[]): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const slack = 4;
    const index = boxes.findIndex((b) => x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack);
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

  /** Space, Enter or a tap in the cockpit: launch, or cut a take-off short. */
  private go(): void {
    const intro = this.intro;
    if (!intro || this.stateTime < 0.5) return;
    if (intro.phase === 'brief') {
      intro.launch();
      this.opts.onStatus?.('Taking off.');
    } else {
      intro.skip();
    }
  }

  private onIntroCue = (cue: IntroCue): void => {
    this.sound.play(cue);
    if (cue === 'sonic') {
      // The boom: a ring bursts out from dead ahead as the view changes.
      this.rings.push({ x: this.w / 2, y: this.h * 0.38, age: 0, color: NEON.cyan });
      if (!this.reduceMotion) this.shake = 0.45;
    }
  };

  /** How the sky is to be drawn while the game is still in the cockpit, or null once it is not. */
  private get view(): IntroView | null {
    return this.intro ? this.intro.view(this.w, this.h) : null;
  }

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
    this.mines = [];
    this.rings = [];
    this.prompt = null;
    this.boss = null;
    this.intermission = 0;
    this.upgrades.clear();
    this.shield = { ready: false, recharge: 0 };
    this.rockets = [];
    this.beams = [];
    this.pilot = { mood: 'calm', until: 0 };
    this.villain = { mood: 'calm', until: 0, line: '', lineUntil: 0, nextIdle: 0, show: 0, warned: false, bye: false, beaten: false };
    this.ship.cooldown = 0;
    this.ship.invulnerable = 1;
    if (this.state === 'over') {
      this.ship.x = this.homeX;
      this.ship.y = this.homeY;
    }
    this.setState('playing');
    this.sound.play('start');
    this.startBreak(1);
  }

  private startWave(n: number): void {
    this.wave = n;
    this.waveTime = 0;
    this.banner = 2.2;
    this.rest = 0;
    this.queue = this.buildWave(n);
    this.sound.play('wave');
    this.opts.onStatus?.(`Wave ${n}.`);
  }

  /**
   * A wave is a run of groups, one after another (a chain of drifters, a V of mites, a pair of weavers,
   * a ring of spinners), with loners arriving in between: darts, hexes, splitters and saucers.
   * New kinds join as the waves go by, and the wave a group first appears in always includes it.
   */
  private buildWave(n: number): Spawn[] {
    const q: Spawn[] = [];
    const sc = this.scale;
    const slots = Math.min(6, 2 + Math.ceil(n / 2));
    const chainLength = Math.min(5, 3 + Math.floor(n / 3));
    const gap = Math.max(1.3, 2.6 - n * 0.15);
    const known = (Object.keys(GROUP_FROM) as Group[]).filter((g) => GROUP_FROM[g] <= n);
    const fresh = known.filter((g) => g !== 'drifters' && GROUP_FROM[g] === n);
    let t = 1.5;
    for (let i = 0; i < slots; i++) {
      // Open with drifters, show off anything new next, then mix (drifters stay the most common).
      const group: Group = i === 0 ? 'drifters' : fresh[i - 1] ?? pick([...known, 'drifters']);
      const x = this.spawnX();
      if (group === 'drifters') {
        const phase = rand(0, Math.PI * 2);
        for (let k = 0; k < chainLength; k++) q.push({ at: t + k * 0.42, kind: 'drifter', x, phase });
      } else if (group === 'mites') {
        // A V of five, the leader in front.
        const reach = 44 * sc;
        const lead = clamp(x, this.inset.left + this.margin + reach, Math.max(this.inset.left + this.margin + reach, this.w - this.inset.right - this.margin - reach));
        for (let k = -2; k <= 2; k++) q.push({ at: t + Math.abs(k) * 0.16, kind: 'mite', x: lead + k * 22 * sc, phase: 0 });
      } else if (group === 'weavers') {
        const dir = Math.random() < 0.5 ? -1 : 1;
        for (let k = 0; k < (n >= 5 ? 3 : 2); k++) q.push({ at: t + k * 0.55, kind: 'weaver', x, phase: 0, dir: k % 2 ? -dir : dir });
      } else {
        // Three spinners a third of a turn apart make a ring that turns as it comes down.
        const phase = rand(0, Math.PI * 2);
        for (let k = 0; k < 3; k++) q.push({ at: t, kind: 'spinner', x, phase: phase + (k * Math.PI * 2) / 3 });
      }
      t += gap;
    }
    const loners = (kind: Kind, count: number, from = 2.5) => {
      for (let i = 0; i < count; i++) q.push({ at: rand(from, t + 1), kind, x: this.spawnX(), phase: 0, dir: Math.random() < 0.5 ? -1 : 1 });
    };
    if (n >= 2) loners('dart', Math.min(8, n + 1));
    if (n >= 3) loners('hex', Math.min(3, Math.floor((n - 1) / 2)), 2);
    if (n >= 3) loners('splitter', Math.min(3, Math.floor(n / 2)), 3);
    if (n >= 4) loners('saucer', Math.min(2, Math.floor((n - 2) / 2)), 4);
    const moments = (count: number) => Array.from({ length: count }, () => rand(3, Math.max(4, t - 1))).sort((a, b) => a - b);
    this.pickupTimes = moments(n >= 4 ? 2 : 1);
    // One upgrade capsule a wave, for as long as there are upgrades left to earn.
    this.upgradeTimes = this.upgrades.size < UPGRADES.length ? moments(1) : [];
    this.mineTimes = moments(Math.min(4, 1 + Math.floor(n / 2)));
    return q.sort((a, b) => a.at - b.at);
  }

  private spawnX(): number {
    const m = 40 * this.scale + 30;
    return rand(this.inset.left + m, Math.max(this.inset.left + m + 1, this.w - this.inset.right - m));
  }

  private makeEnemy(kind: Kind, x: number, y: number, phase = 0): Enemy {
    return {
      kind,
      x, y, vx: 0, vy: 0, rot: 0,
      hp: KINDS[kind].hp, age: 0, flash: 0, dead: false,
      anchorX: x, phase, amp: 0,
      fireIn: 0, committed: false, holdY: 0,
    };
  }

  private spawn(sp: Spawn): void {
    const n = this.wave;
    const sc = this.scale;
    const e = this.makeEnemy(sp.kind, sp.x, -30, sp.phase);
    const dir = sp.dir ?? 1;
    if (sp.kind === 'drifter') {
      e.vy = Math.min(112, 62 + n * 5) * this.pace;
      e.amp = Math.min(rand(46, 72) * sc, this.w * 0.14);
      if (n >= 3 && Math.random() < 0.3) e.fireIn = rand(0.9, 2.4);
    } else if (sp.kind === 'dart') {
      e.vy = 60 * this.pace;
    } else if (sp.kind === 'hex') {
      e.hp = n >= 6 ? 3 : 2;
      e.holdY = clamp(rand(this.h * 0.14, this.h * 0.34), this.inset.top + 90, this.h * 0.4);
      e.vx = (Math.random() < 0.5 ? -1 : 1) * Math.min(130, 70 + n * 6);
      e.fireIn = rand(1.2, 2.2);
    } else if (sp.kind === 'weaver') {
      e.vy = Math.min(120, 78 + n * 4) * this.pace;
      e.vx = dir * Math.min(230, 150 + n * 8) * sc;
      e.amp = Math.min(rand(90, 130) * sc, this.w * 0.24);
    } else if (sp.kind === 'mite') {
      e.vy = Math.min(210, 135 + n * 7) * this.pace;
    } else if (sp.kind === 'splitter') {
      e.vy = 46 * this.pace;
      e.hp = n >= 7 ? 4 : 3;
    } else if (sp.kind === 'spinner') {
      e.amp = Math.min(rand(42, 58) * sc, this.w * 0.16);
      e.vy = Math.min(84, 52 + n * 3) * this.pace;
      e.holdY = -30 - e.amp;
      e.y = e.holdY;
    } else if (sp.kind === 'saucer') {
      // Comes in from one side and leaves by the other.
      e.x = dir > 0 ? -40 : this.w + 40;
      e.vx = dir * Math.min(190, 115 + n * 7) * sc;
      e.holdY = clamp(rand(this.h * 0.13, this.h * 0.3), this.inset.top + 90, this.h * 0.4);
      e.y = e.holdY;
      e.fireIn = rand(0.5, 1);
    }
    this.enemies.push(e);
  }

  private spawnPickup(reward?: Reward): void {
    // Offer what helps most: repairs when the hull is hurt, blasts once the waves get busy.
    const pool: Reward[] = ['energy'];
    if (this.hull < this.maxHull) pool.push('hull', 'hull');
    if (this.wave >= 2) pool.push('blast');
    const x = this.spawnX();
    this.pickups.push({ reward: reward ?? pick(pool), x, y: -24, anchorX: x, phase: rand(0, Math.PI * 2), age: 0, dead: false });
  }

  private spawnMine(): void {
    const x = this.spawnX();
    this.mines.push({ x, y: -24, anchorX: x, phase: rand(0, Math.PI * 2), age: 0, dead: false, thrown: false });
  }

  /** What the boss needs to know about the world, and the ways it can act on it. */
  private bossEnv(): BossEnv {
    return {
      w: this.w, h: this.h, top: this.inset.top, scale: this.scale,
      shipX: this.ship.x, shipY: this.ship.y,
      fire: (x, y, vx, vy, color) => {
        this.shots.push({ x, y, vx, vy, hostile: true, dead: false, color });
        this.sound.play('enemyShot');
      },
      bomb: (x, y) => {
        if (this.mines.length >= 3 || this.state !== 'playing') return;
        this.mines.push({ x, y, anchorX: x, phase: 0, age: 0, dead: false, thrown: true });
        this.taunt('bomb', 'talk', 1.2, 0.7);
      },
      burst: (shape, x, y, scale, rot, color) => {
        this.burst(shape, x, y, scale, rot, color);
        this.sound.play('boom');
      },
      problem: () => makeProblem(this.level),
    };
  }

  private startBoss(): void {
    this.boss = createBoss(this.wave, this.bossEnv());
    this.bossAsked = 0;
    this.banner = 0;
    this.villain = { mood: 'calm', until: 0, line: '', lineUntil: 0, nextIdle: 0, show: 0, warned: false, bye: false, beaten: false };
    this.taunt('enter', 'laugh', 2, 1, true);
    this.sound.play('warning');
    this.opts.onStatus?.(
      this.boss.kind === 'sum'
        ? `Mini boss. ${this.input === 'touch' ? 'Tap' : 'Keep shooting'} the little ship carrying the right answer to open its armour, then shoot the red core.`
        : 'Mini boss. Shoot its arms off, and shoot the red core when its armour opens.',
    );
  }

  private updateBossFight(dt: number): void {
    const b = this.boss;
    if (!b) return;
    updateBoss(b, dt, this.bossEnv());
    if (b.problem && b.pods.length && b.problemId !== this.bossAsked) {
      this.bossAsked = b.problemId;
      this.opts.onStatus?.(`What is ${b.problem.question}? The little ships carry ${b.pods.map((p) => p.value).join(', ')}.`);
    }
    const v = this.villain;
    if (this.state === 'playing') {
      if (b.state === 'fight' && this.time > v.nextIdle && !this.prompt) this.taunt('idle', 'talk', 1.2);
      if (b.state === 'leaving' && !v.bye) {
        v.bye = true;
        this.taunt('bored', 'talk', 2, 1, true);
      }
    }
    if (b.state !== 'gone') return;
    this.boss = null;
    // Its face lingers for a moment after it has gone, to have the last word.
    v.show = Math.max(v.show, this.time + 2);
    this.clearMines();
    if (this.state !== 'playing') return;
    if (b.defeated) {
      const bonus = 500 + 250 * b.wave;
      this.score += bonus;
      this.bossNote = `BOSS DOWN +${bonus}`;
      for (const s of this.shots) if (s.hostile) s.dead = true;
      this.rings.push(
        { x: b.x, y: b.y, age: 0, color: NEON.red },
        { x: b.x, y: b.y, age: -0.12, color: NEON.cyan },
        { x: b.x, y: b.y, age: -0.24, color: NEON.yellow },
      );
      if (!this.reduceMotion) this.shake = 0.5;
    } else {
      this.bossNote = 'IT GOT AWAY';
    }
    this.intermission = 1.8;
    this.sound.play(b.defeated ? 'fanfare' : 'escape');
    this.opts.onStatus?.(b.defeated ? 'Mini boss destroyed.' : 'The mini boss got away.');
  }

  /** Throw away any bombs still on screen, with a puff of sparks each. */
  private clearMines(): void {
    for (const m of this.mines) this.spark(m.x, m.y, NEON.red);
    this.mines = [];
  }

  /** Hurt an enemy by something other than a shot: a beam, a rocket, a nova or the guardian. */
  private damage(e: Enemy, amount: number): void {
    if (e.dead) return;
    e.hp -= amount;
    e.flash = 0.1;
    if (e.hp <= 0) this.destroyEnemy(e);
    else this.sound.play('hit');
  }

  private destroyEnemy(e: Enemy): void {
    e.dead = true;
    this.feel('happy', 0.6, true);
    this.score += KINDS[e.kind].points;
    this.burst(KINDS[e.kind].shape, e.x, e.y, this.scale, e.rot, KINDS[e.kind].color);
    this.sound.play('boom');
    if (e.kind === 'splitter') {
      // Two shards fly out and down, one to each side.
      for (const side of [-1, 1]) {
        const shard = this.makeEnemy('shard', e.x + side * 8 * this.scale, e.y);
        shard.vx = side * rand(90, 140) * this.scale;
        shard.vy = rand(130, 170) * this.pace;
        shard.rot = rand(0, Math.PI * 2);
        this.enemies.push(shard);
      }
    }
  }

  private hitShip(): void {
    if (this.shield.ready) {
      // The shield takes this one, then needs time to come back.
      this.shield = { ready: false, recharge: SHIELD_SECONDS };
      this.ship.invulnerable = 0.8;
      this.rings.push({ x: this.ship.x, y: this.ship.y, age: 0, color: NEON.cyan, reach: 80 * this.scale });
      this.sound.play('shield');
      this.opts.onStatus?.('The shield took the hit.');
      return;
    }
    this.hull -= 1;
    this.feel('hurt', 1.5);
    if (this.boss && this.hull > 0) this.taunt('hit', 'laugh', 1.6, 0.8);
    this.ship.invulnerable = 1.6;
    if (!this.reduceMotion) this.shake = 0.35;
    for (let i = 0; i < 7; i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(60, 190);
      this.debris.push({
        x: this.ship.x, y: this.ship.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        rot: a, spin: rand(-5, 5), len: rand(4, 9), age: 0, ttl: rand(0.3, 0.6), color: SAND,
      });
    }
    if (this.hull <= 0) {
      this.gameOver();
    } else {
      this.sound.play('hurt');
      this.opts.onStatus?.(`Ship hit. Hull ${this.hull} of ${this.maxHull}.`);
    }
  }

  /** Clear the screen: every enemy and every enemy shot goes. */
  private detonate(): void {
    for (const e of this.enemies) if (!e.dead) this.destroyEnemy(e);
    for (const s of this.shots) if (s.hostile) s.dead = true;
    this.rings.push({ x: this.ship.x, y: this.ship.y, age: 0, color: SAND });
    this.sound.play('blast');
    if (!this.reduceMotion) this.shake = 0.4;
  }

  /** A few sparks where a shot landed on something it could not destroy. */
  private spark(x: number, y: number, color: string): void {
    for (let i = 0; i < 3; i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(50, 160);
      this.debris.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        rot: a, spin: rand(-6, 6), len: rand(3, 7), age: 0, ttl: rand(0.15, 0.35), color,
      });
    }
  }

  private gameOver(): void {
    this.burst(SHIP, this.ship.x, this.ship.y, this.shipScale, 0, SAND);
    this.queue = [];
    this.pickupTimes = [];
    this.upgradeTimes = [];
    this.mineTimes = [];
    this.pickups = [];
    this.mines = [];
    this.rockets = [];
    this.beams = [];
    this.prompt = null;
    this.intermission = 0;
    if (this.boss) this.taunt('win', 'laugh', 6, 1, true);
    // A boss that has won does not hang about over the game over screen.
    if (this.boss && this.boss.state !== 'dying') {
      this.boss.pods = [];
      this.boss.state = 'leaving';
    }
    this.newBest = this.saveBest();
    this.setState('over');
    this.sound.play('over');
    this.opts.onStatus?.(`Game over. Score ${this.score}. Wave ${this.wave}.`);
  }

  /** Break a shape into its line segments and send them tumbling outward. */
  private burst(shape: Shape, x: number, y: number, scale: number, rot: number, color: string): void {
    for (const [x1, y1, x2, y2] of segments(shape, x, y, scale, rot)) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const out = Math.atan2(my - y, mx - x) + rand(-0.4, 0.4);
      const v = rand(45, 150);
      this.debris.push({
        x: mx, y: my, vx: Math.cos(out) * v, vy: Math.sin(out) * v,
        rot: Math.atan2(y2 - y1, x2 - x1), spin: rand(-5, 5),
        len: Math.hypot(x2 - x1, y2 - y1), age: 0, ttl: rand(0.5, 0.95), color,
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

  /** Run a question's clock, with a tick for each of its last three seconds. */
  private clock(c: Challenge, dt: number): void {
    const before = Math.ceil(c.timeLeft);
    tick(c, dt);
    const left = Math.ceil(c.timeLeft);
    if (!c.outcome && left < before && left <= 3) this.sound.play('tick');
  }

  private startBreak(wave: number): void {
    this.wave = wave;
    this.keys.clear();
    this.shots = [];
    this.pickups = [];
    this.mines = [];
    this.rockets = [];
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
    this.clock(c, dt);
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
      this.sound.play(c.outcome.success ? 'right' : 'wrong');
      this.feel(c.outcome.success ? 'happy' : 'hurt', 1.2);
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
    const hurt = this.hull < this.maxHull;
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
    if (typed && !o.success) this.sound.play('wrong');
    if (gain > 0) this.sound.play('power');
    this.feel(gain >= 0.5 || clean ? 'happy' : gain > 0 ? 'calm' : 'hurt', 2.2);
    if (repaired) this.sound.play('repair');
    this.opts.onStatus?.(
      lines.map((l) => l.text.replace('%', ' percent').replace(' - ', ', ').toLowerCase()).join('. ') + '.',
    );
  }

  /** Flying into a boost capsule or a bomb: time slows and one question decides what happens next. */
  private startPrompt(stake: Stake): void {
    const roll = Math.random();
    const challenge =
      this.input === 'touch' || roll < 0.4
        ? this.sum(PROMPT_SECONDS, PROMPT_GRACE)
        : roll < 0.7
          ? // A bomb is do or die, so one slip of the finger on a typed answer is forgiven.
            entryChallenge(makeProblem(this.level), PROMPT_SECONDS, PROMPT_GRACE, stake === 'defuse' ? 1 : 0)
          : lineChallenge(this.text(WORDS), PROMPT_SECONDS, PROMPT_GRACE);
    this.prompt = { stake, challenge, settled: false, fatal: false, note: '', hold: 0, offer: null, offerAge: 0 };
    this.sound.play(stake === 'defuse' ? 'bomb' : 'capsule');
    const what = stake === 'defuse' ? 'You hit a bomb' : stake === 'upgrade' ? 'Upgrade capsule' : 'Boost capsule';
    this.announce(challenge, `${what}. Answer in ${PROMPT_SECONDS} seconds ${STAKES[stake].goal.toLowerCase()}.`);
  }

  private updatePrompt(dt: number): void {
    const p = this.prompt;
    if (!p) return;
    const o = p.challenge.outcome;
    if (!o) {
      this.clock(p.challenge, dt);
      return;
    }
    if (!p.settled) {
      p.settled = true;
      if (p.stake === 'defuse') {
        // A bomb is all or nothing: defuse it, or lose the ship once the right answer has been shown.
        if (o.success) {
          this.score += DEFUSE_POINTS;
          p.note = `BOMB DEFUSED +${DEFUSE_POINTS}`;
          p.hold = 1;
          if (this.boss) this.taunt('defused', 'hurt', 1.5, 1, true);
        } else {
          p.fatal = true;
          p.note = 'THE BOMB GOES OFF';
          p.hold = 1.7;
          if (this.boss) this.taunt('boom', 'laugh', 4, 1, true);
        }
      } else if (!o.success) {
        this.jam = JAM_SECONDS;
        this.sound.play('jam');
        p.note = 'CANNONS JAMMED';
        p.hold = 1.8;
      } else {
        p.hold = 1;
        if (p.stake === 'upgrade') {
          const offer = offerUpgrades(this.upgrades);
          if (offer.length) {
            p.offer = offer;
          } else {
            this.score += 500;
            p.note = 'EVERY UPGRADE OWNED - BONUS 500';
          }
        } else if (p.stake === 'blast') {
          this.detonate();
          p.note = 'BOOM';
        } else if (p.stake === 'energy') {
          // A quicker answer is a bigger boost: 30% of a gauge at worst, 60% at best.
          const gain = 0.6 * o.quality;
          this.energy = Math.min(1, this.energy + gain);
          p.note = `POWER +${percent(gain)}%`;
        } else if (this.hull < this.maxHull) {
          this.hull += 1;
          p.note = 'HULL REPAIRED';
        } else {
          this.score += FULL_HULL_BONUS;
          p.note = `HULL IS FULL - BONUS ${FULL_HULL_BONUS}`;
        }
      }
      this.sound.play(o.success ? 'right' : 'wrong');
      this.feel(o.success ? 'happy' : 'hurt', 1.6);
      this.opts.onStatus?.(
        p.offer
          ? `Correct. Choose an upgrade. ${p.offer.map((u, i) => `Press ${i + 1} for ${u.name.toLowerCase()}: ${u.blurb.toLowerCase()}`).join('. ')}.`
          : `${o.success ? 'Correct.' : 'Not quite.'} ${p.note.toLowerCase().replace('%', ' percent')}.`,
      );
    }
    // The world waits, still in slow motion, for as long as it takes to choose an upgrade.
    if (p.offer) {
      p.offerAge += dt;
      return;
    }
    p.hold -= dt;
    if (p.hold <= 0) {
      this.prompt = null;
      if (p.fatal) {
        this.hull = 0;
        this.rings.push({ x: this.ship.x, y: this.ship.y, age: 0, color: NEON.red }, { x: this.ship.x, y: this.ship.y, age: -0.1, color: NEON.orange });
        if (!this.reduceMotion) this.shake = 0.5;
        this.sound.play('blast');
        this.gameOver();
        return;
      }
      // A moment to find your bearings before anything can hit the ship again.
      this.ship.invulnerable = Math.max(this.ship.invulnerable, 1);
    }
  }

  /** Take one of the upgrades on offer. */
  private chooseUpgrade(index: number): void {
    const p = this.prompt;
    const u = p?.offer?.[index];
    if (!p || !u || p.offerAge < OFFER_GRACE) return;
    this.upgrades.add(u.id);
    if (u.id === 'armour') this.hull = Math.min(this.maxHull, this.hull + 1);
    if (u.id === 'shield') this.shield = { ready: true, recharge: 0 };
    // The ones that fire on their own show off soon after they are picked.
    if (u.id === 'lance') this.lanceIn = 0.8;
    if (u.id === 'rockets') this.rocketIn = 0.5;
    if (u.id === 'nova') this.novaIn = 1.5;
    p.offer = null;
    p.note = `${u.name} READY`;
    p.hold = 1.3;
    this.sound.play('power');
    this.feel('happy', 2);
    this.opts.onStatus?.(`${u.name.toLowerCase()} ready.`);
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
    // (A bomb that was not defused keeps time crawling to the end.)
    this.timeScale += ((this.asking ? SLOW_MOTION : 1) - this.timeScale) * (1 - Math.exp(-dt * 9));
    const sim = dt * this.timeScale;
    this.banner = Math.max(0, this.banner - sim);

    if (this.intro) {
      this.intro.update(dt, this.input === 'touch');
      if (this.intro.done) {
        // The take-off is over: the ship is in its place and the stars are already falling as the game has them.
        this.intro = null;
        this.warp = 3.2;
        this.begin();
      }
    }
    const view = this.view;
    if (view) {
      this.flyStars(view, dt);
      this.backdrop.update(dt, 3.2 * view.settle);
    } else {
      // Stars speed up once the ship launches, which is what sells the feeling of flying.
      const flying = this.state === 'playing' && !this.brk;
      const targetWarp = flying ? 3.2 : this.state === 'over' ? 0.6 : 1;
      this.warp += (targetWarp - this.warp) * (1 - Math.exp(-dt * 1.8));
      for (const star of this.stars) {
        star.y += star.speed * this.warp * sim;
        if (star.y > this.h + 80) Object.assign(star, this.makeStar(-rand(10, 80)));
      }
      this.backdrop.update(sim, this.warp);
    }
    // The scenery slides against the ship: a little for what is far away, a lot for what is near.
    const across = this.reduceMotion ? 0 : clamp(this.ship.x / (this.w || 1) - 0.5, -0.5, 0.5);
    this.drift += (across - this.drift) * (1 - Math.exp(-dt * 3));

    for (const d of this.debris) {
      d.age += sim;
      d.x += d.vx * sim;
      d.y += d.vy * sim;
      d.rot += d.spin * sim;
    }
    this.debris = this.debris.filter((d) => d.age < d.ttl);
    for (const ring of this.rings) ring.age += dt;
    this.rings = this.rings.filter((ring) => ring.age < 0.7);
    // A boss on its way out (after a game over) still has to fly off the screen.
    if (this.boss && this.state !== 'playing') this.updateBossFight(sim);

    this.updateShip(sim);
    // The pilot leans into a turn: how fast the ship is moving sideways, smoothed.
    const drift = (this.ship.x - this.lastShipX) / Math.max(dt, 0.001);
    this.lastShipX = this.ship.x;
    this.lean += (clamp(drift / 380, -1, 1) - this.lean) * (1 - Math.exp(-dt * 8));
    if (this.state === 'playing') {
      if (this.brk) {
        this.updateBreak(dt);
      } else {
        if (this.intermission > 0) {
          this.intermission -= sim;
          if (this.intermission <= 0) this.startBreak(this.wave + 1);
        } else if (this.boss) {
          this.updateBossFight(sim);
        } else {
          this.updateWave(sim);
        }
        this.updatePickups(sim);
        this.updateMines(sim);
        this.updateUpgrades(sim);
        this.updatePrompt(dt);
      }
    }
    this.updateEnemies(sim);
    this.updateShots(sim);
    if (this.state === 'playing') this.collide();

    this.enemies = this.enemies.filter((e) => !e.dead);
    this.shots = this.shots.filter((s) => !s.dead);
    this.pickups = this.pickups.filter((p) => !p.dead);
    this.mines = this.mines.filter((m) => !m.dead);
  }

  /** A question is open and still waiting for its answer (or an upgrade is being chosen, or a bomb is about to go off). */
  private get asking(): boolean {
    return this.prompt !== null && (!this.prompt.settled || this.prompt.fatal || this.prompt.offer !== null);
  }

  private updateShip(dt: number): void {
    const ship = this.ship;
    const k = 1 - Math.exp(-dt * 4);
    this.shipScale += (1.15 * this.scale - this.shipScale) * k;
    if (this.state === 'ready') {
      // Out of sight below the screen while the game is in the cockpit; it rises into place as the view hands over.
      const risen = this.view?.ship ?? 1;
      ship.x = this.homeX;
      ship.y = this.homeY + (1 - risen) * (this.h - this.homeY + 80);
      return;
    }
    if (this.brk) {
      // Back to base for a break.
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
    if ((keys.has('Space') || this.touchId !== null) && ship.cooldown <= 0 && this.jam <= 0 && !this.asking) {
      const has = (id: UpgradeId) => this.upgrades.has(id);
      ship.cooldown = has('rapid') ? 0.11 : 0.17;
      this.sound.play('shot');
      const sc = this.scale;
      const up = -680 * this.pace;
      const pierce = has('pierce') ? 2 : 0;
      const shoot = (dx: number, dy: number, vx: number, color: string = SAND, stray = false) =>
        this.shots.push({ x: ship.x + dx * sc, y: ship.y - dy * sc, vx, vy: up, hostile: false, dead: false, color, pierce, skip: null, stray });
      // Energy buys cannons: one from the nose, then one from each wing, then all three with the wings angled out.
      if (this.energy <= 0) {
        shoot(0, 18, 0);
      } else if (this.energy <= TRIPLE_AT) {
        shoot(-8, 6, 0);
        shoot(8, 6, 0);
      } else {
        // The wing cannons fan out to sweep a wave, and point straight ahead to pound a boss.
        const fan = this.boss ? 0 : 105 * sc;
        shoot(0, 18, 0);
        shoot(-8, 6, -fan);
        shoot(8, 6, fan);
      }
      if (has('wide')) {
        shoot(-10, 4, -215 * sc, SAND, true);
        shoot(10, 4, 215 * sc, SAND, true);
      }
      if (has('wingmates')) {
        shoot(-WING, 0, 0, NEON.lime, true);
        shoot(WING, 0, 0, NEON.lime, true);
      }
    }
    // Energy only runs down while there is something to fight, so none is wasted waiting for a wave to arrive.
    if (this.enemies.length || this.boss?.state === 'fight') this.energy = Math.max(0, this.energy - dt / ENERGY_SECONDS);
  }

  /**
   * Move the stars as seen from the cockpit: away from the point the ship is heading for, faster the
   * further from it they are. As the view hands over to the game that turns into falling straight down.
   */
  private flyStars(view: IntroView, dt: number): void {
    if (view.speed <= 0) return;
    const { w, h } = this;
    const reach = 0.5 * Math.min(w, h);
    for (const star of this.stars) {
      let ux = 0;
      let uy = 1;
      let pace = 1;
      if (view.vanish) {
        const dx = star.x - view.vanish.x;
        const dy = star.y - view.vanish.y;
        const dist = Math.hypot(dx, dy) || 1;
        ux = dx / dist;
        uy = dy / dist;
        pace = Math.min(3, 0.35 + dist / reach) * (1 - view.settle) + view.settle;
      }
      const step = star.speed * view.speed * pace * dt;
      star.x += ux * step;
      star.y += uy * step;
      if (star.y > h + 80 || star.y < -80 || star.x < -20 || star.x > w + 20) {
        if (!view.vanish || view.settle > 0.5) {
          Object.assign(star, this.makeStar(-rand(10, 80)));
        } else {
          // A new star appears ahead, near the point everything is flying out from.
          const angle = rand(0, Math.PI * 2);
          const far = rand(0.03, 0.3) * Math.min(w, h);
          star.x = view.vanish.x + Math.cos(angle) * far;
          star.y = view.vanish.y + Math.sin(angle) * far * 0.8;
        }
      }
    }
  }

  private updateWave(dt: number): void {
    this.waveTime += dt;
    while (this.queue.length && this.queue[0]!.at <= this.waveTime) this.spawn(this.queue.shift()!);
    while (this.pickupTimes.length && this.pickupTimes[0]! <= this.waveTime) {
      this.pickupTimes.shift();
      this.spawnPickup();
    }
    while (this.upgradeTimes.length && this.upgradeTimes[0]! <= this.waveTime) {
      this.upgradeTimes.shift();
      this.spawnPickup('upgrade');
    }
    while (this.mineTimes.length && this.mineTimes[0]! <= this.waveTime) {
      this.mineTimes.shift();
      this.spawnMine();
    }
    const cleared = !this.queue.length && !this.enemies.length;
    const quiet =
      !this.pickups.length && !this.pickupTimes.length && !this.upgradeTimes.length && !this.mines.length && !this.mineTimes.length;
    if (cleared && quiet && !this.prompt) {
      this.rest += dt;
      if (this.rest > 0.9) this.startBoss();
    }
  }

  private updateMines(dt: number): void {
    // Once a wave is beaten its last bombs hurry off. A boss's bombs fall a little faster than a wave's.
    const hurry = this.boss ? 1.2 : !this.queue.length && !this.enemies.length ? 3 : 1;
    const reach = (10 + 9) * this.scale;
    for (const m of this.mines) {
      m.age += dt;
      m.y += 74 * this.pace * hurry * dt;
      // A thrown bomb drifts after the ship; an ordinary one just sways.
      if (m.thrown) m.anchorX += clamp(this.ship.x - m.anchorX, -1, 1) * 30 * this.scale * dt;
      m.x = m.anchorX + Math.sin(m.age * 0.9 + m.phase) * (m.thrown ? 12 : 34) * this.scale;
      if (m.y > this.h + 40) m.dead = true;
      // A ship that is still blinking (just hit, or just out of a question) passes through a bomb unharmed.
      else if (this.state === 'playing' && !this.prompt && this.ship.invulnerable <= 0 && Math.hypot(m.x - this.ship.x, m.y - this.ship.y) < reach) {
        m.dead = true;
        this.startPrompt('defuse');
      }
    }
  }

  private updatePickups(dt: number): void {
    // Once the wave is beaten, a capsule nobody wants hurries off so the game is not left waiting for it.
    const hurry = !this.queue.length && !this.enemies.length ? 3 : 1;
    const reach = (13 + 9) * this.scale;
    // Capsules wait while a question is on screen, so one never slips past a pilot who is busy answering.
    if (this.prompt) return;
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

  /** Where the guardian is on its circle round the ship. */
  private get guardianAt(): { x: number; y: number } {
    const r = ORBIT * this.scale;
    return { x: this.ship.x + Math.cos(this.orbit) * r, y: this.ship.y + Math.sin(this.orbit) * r };
  }

  /** Run the upgrades that act on their own: the shield's recharge, the guardian, the beam, rockets and nova. */
  private updateUpgrades(dt: number): void {
    const sc = this.scale;
    const { ship } = this;
    const has = (id: UpgradeId) => this.upgrades.has(id);
    for (const beam of this.beams) beam.age += dt;
    this.beams = this.beams.filter((b) => b.age < 0.22);

    if (has('shield') && !this.shield.ready) {
      this.shield.recharge -= dt;
      if (this.shield.recharge <= 0) {
        this.shield.ready = true;
        this.sound.play('shieldUp');
      }
    }

    if (has('guardian')) {
      this.orbit += dt * 2.8;
      this.guardCool = Math.max(0, this.guardCool - dt);
      const g = this.guardianAt;
      for (const s of this.shots) {
        if (!s.hostile || s.dead || Math.hypot(s.x - g.x, s.y - g.y) > 14 * sc) continue;
        s.dead = true;
        this.spark(s.x, s.y, NEON.cyan);
        this.sound.play('clang');
      }
      if (this.guardCool <= 0) {
        const rammed = this.enemies.find((e) => !e.dead && Math.hypot(e.x - g.x, e.y - g.y) < (KINDS[e.kind].radius + 8) * sc);
        if (rammed) {
          this.guardCool = 0.3;
          this.damage(rammed, 1);
        }
      }
    }

    this.updateRockets(dt);
    // The rest only go off in a fight: with enemies about or a boss that can be hurt, and not during a question.
    if (this.asking || !(this.enemies.length > 0 || this.boss?.state === 'fight')) return;

    if (has('lance') && (this.lanceIn -= dt) <= 0) {
      this.lanceIn = LANCE_SECONDS;
      // A beam straight up from the nose: two points of damage to everything in its path.
      const x = ship.x;
      this.beams.push({ x, y: ship.y - 18 * sc, age: 0 });
      this.sound.play('beam');
      for (const e of this.enemies) if (e.y < ship.y && Math.abs(e.x - x) < (KINDS[e.kind].radius + 7) * sc) this.damage(e, 2);
      for (let n = 0; n < 2; n++) {
        for (let y = ship.y - 20 * sc; y > 0; y -= 8) if (this.strikeBoss(x, y, false)) break;
      }
    }

    if (has('rockets') && (this.rocketIn -= dt) <= 0) {
      this.rocketIn = ROCKET_SECONDS;
      this.rockets.push({ x: ship.x, y: ship.y - 16 * sc, vx: (Math.random() < 0.5 ? -1 : 1) * 140, vy: -240, age: 0, dead: false });
      this.sound.play('rocket');
    }

    if (has('nova') && (this.novaIn -= dt) <= 0) {
      this.novaIn = NOVA_SECONDS;
      // A ring that wipes out nearby enemy shots and hurts nearby enemies.
      const reach = 210 * sc;
      this.rings.push({ x: ship.x, y: ship.y, age: 0, color: NEON.cyan, reach });
      this.sound.play('nova');
      for (const s of this.shots) if (s.hostile && Math.hypot(s.x - ship.x, s.y - ship.y) < reach) s.dead = true;
      for (const e of this.enemies) if (Math.hypot(e.x - ship.x, e.y - ship.y) < reach) this.damage(e, 1);
    }
  }

  /** Rockets steer for the nearest enemy (or the boss) and go off against the first thing they touch. */
  private updateRockets(dt: number): void {
    const sc = this.scale;
    const speed = 430 * this.pace;
    for (const r of this.rockets) {
      r.age += dt;
      let tx = r.x;
      let ty = r.y - 200;
      let nearest = Infinity;
      for (const e of this.enemies) {
        const d = Math.hypot(e.x - r.x, e.y - r.y);
        if (!e.dead && d < nearest) {
          nearest = d;
          tx = e.x;
          ty = e.y;
        }
      }
      if (nearest === Infinity && this.boss?.state === 'fight') {
        tx = this.boss.x;
        ty = this.boss.y;
      }
      const dist = Math.hypot(tx - r.x, ty - r.y) || 1;
      const turn = 1 - Math.exp(-dt * 5);
      r.vx += (((tx - r.x) / dist) * speed - r.vx) * turn;
      r.vy += (((ty - r.y) / dist) * speed - r.vy) * turn;
      r.x += r.vx * dt;
      r.y += r.vy * dt;

      const touched = this.enemies.some((e) => !e.dead && Math.hypot(e.x - r.x, e.y - r.y) < (KINDS[e.kind].radius + 6) * sc);
      if (touched || this.strikeBoss(r.x, r.y, false)) {
        r.dead = true;
        const reach = 54 * sc;
        this.rings.push({ x: r.x, y: r.y, age: 0, color: NEON.orange, reach });
        this.sound.play('boom');
        for (const e of this.enemies) if (Math.hypot(e.x - r.x, e.y - r.y) < reach) this.damage(e, 2);
      } else if (r.age > 4 || r.y < -30 || r.y > this.h + 30 || r.x < -30 || r.x > this.w + 30) {
        r.dead = true;
      }
    }
    this.rockets = this.rockets.filter((r) => !r.dead);
  }

  /** Land a hit on the boss at (x, y), if any part of it is there, and let it react. Returns whether something was hit. */
  private strikeBoss(x: number, y: number, aimed = true, tapped = false): boolean {
    const b = this.boss;
    if (!b) return false;
    const hit = tapped ? tapBoss(b, x, y, this.bossEnv()) : shootBoss(b, x, y, this.bossEnv(), aimed);
    if (hit === 'miss') return false;
    const v = this.villain;
    this.spark(x, y, hit === 'blocked' ? NEON.cyan : hit === 'lock' ? NEON.yellow : NEON.red);
    this.score += hit === 'armOff' ? 150 : hit === 'right' ? 100 : hit === 'core' ? 10 : 0;
    this.sound.play(BOSS_SOUNDS[hit]);
    if (hit === 'down') {
      for (const other of this.shots) if (other.hostile) other.dead = true;
      this.clearMines();
      this.taunt('down', 'out', 3, 1, true);
      v.beaten = true;
      this.feel('happy', 3);
    } else if (hit === 'right') {
      this.opts.onStatus?.('Right answer. Its armour is open: shoot the red core.');
      this.taunt('right', 'hurt', 1.6, 1, true);
      this.feel('happy', 1.5);
    } else if (hit === 'wrong') {
      this.opts.onStatus?.('Wrong ship. A new sum is coming.');
      this.taunt('wrong', 'laugh', 1.6, 1, true);
      this.feel('hurt', 1.2);
    } else if (hit === 'armOff') {
      this.taunt('arm', 'hurt', 1.2, 1, true);
      this.feel('happy', 1, true);
    } else if (hit === 'core') {
      if (!v.warned && b.hp < b.maxHp * 0.3) {
        v.warned = true;
        this.taunt('low', 'hurt', 1.5, 1, true);
      } else {
        this.taunt('ouch', 'hurt', 0.35, 0.12);
      }
    } else if (hit === 'blocked' && v.until <= this.time) {
      this.taunt('blocked', 'laugh', 1.2, 0.04);
    }
    return true;
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
            this.shots.push({ x: e.x, y: e.y + 12 * this.scale, vx: 0, vy: 230 * this.pace, hostile: true, dead: false, color: PINK });
            this.sound.play('enemyShot');
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
      } else if (e.kind === 'weaver') {
        // Sharp diagonals: it turns back at the edge of its lane, or of the screen.
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        const off = e.x - e.anchorX;
        if ((Math.abs(off) > e.amp && off * e.vx > 0) || (e.x < left && e.vx < 0) || (e.x > right && e.vx > 0)) e.vx = -e.vx;
        e.rot += (-Math.sign(e.vx) * 0.5 - e.rot) * (1 - Math.exp(-dt * 14));
      } else if (e.kind === 'mite') {
        e.y += e.vy * dt;
        e.x = clamp(e.anchorX + Math.sin(e.age * 3.2) * 9 * this.scale, left, right);
      } else if (e.kind === 'splitter') {
        e.y += e.vy * dt;
        e.rot += dt * 0.5;
      } else if (e.kind === 'shard') {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        e.rot += dt * 6;
        if ((e.x < left && e.vx < 0) || (e.x > right && e.vx > 0)) e.vx = -e.vx;
      } else if (e.kind === 'spinner') {
        // A loop whose centre sinks: with three of them a third of a turn apart, a turning ring.
        const turn = e.age * 2.3 + e.phase;
        e.holdY += e.vy * dt;
        e.x = clamp(e.anchorX + Math.cos(turn) * e.amp, left, right);
        e.y = e.holdY + Math.sin(turn) * e.amp * 0.62;
        e.rot += dt * 5;
      } else if (e.kind === 'saucer') {
        e.x += e.vx * dt;
        e.y = e.holdY + Math.sin(e.age * 2.4) * 7 * this.scale;
        e.rot = Math.sin(e.age * 2.4 + 1) * 0.12;
        e.fireIn -= dt;
        if (e.fireIn <= 0 && playing && e.x > left && e.x < right) {
          e.fireIn = Math.max(0.75, 1.5 - this.wave * 0.06);
          this.shots.push({ x: e.x, y: e.y + 9 * this.scale, vx: 0, vy: 250 * this.pace, hostile: true, dead: false, color: KINDS.saucer.color });
          this.sound.play('enemyShot');
        }
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
            this.shots.push({ x: e.x, y: e.y, vx: (tx / dist) * speed, vy: (ty / dist) * speed, hostile: true, dead: false, color: PINK });
            this.sound.play('enemyShot');
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
      // On a touch screen the ship fires all the time, so its shots cannot choose an answer: a tap does that.
      if (this.strikeBoss(s.x, s.y, !s.stray && this.input !== 'touch')) {
        s.dead = true;
        continue;
      }
      // Bombs shrug shots off. They have to be flown around.
      const mine = this.mines.find((m) => Math.hypot(s.x - m.x, s.y - m.y) < 11 * this.scale);
      if (mine) {
        s.dead = true;
        this.spark(s.x, s.y, NEON.red);
        this.sound.play('clang');
        continue;
      }
      for (const e of this.enemies) {
        if (e.dead || e === s.skip) continue;
        if (Math.hypot(s.x - e.x, s.y - e.y) < KINDS[e.kind].radius * this.scale + 4) {
          // A piercing shot carries on through, but only hurts each enemy once.
          if (s.pierce) {
            s.pierce -= 1;
            s.skip = e;
          } else {
            s.dead = true;
          }
          e.hp -= 1;
          e.flash = 0.1;
          if (e.hp <= 0) this.destroyEnemy(e);
          else this.sound.play('hit');
          break;
        }
      }
    }

    if (safe) return;
    if (this.boss && touchesBoss(this.boss, ship.x, ship.y, shipRadius, this.bossEnv())) {
      this.hitShip();
      return;
    }
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
    const view = this.view;
    const shake = Math.max(this.shake, view?.shake ?? 0);
    if (shake > 0) ctx.translate(rand(-1, 1) * shake * 14, rand(-1, 1) * shake * 14);
    const frame = { ctx, ink: this.inkFn, w, h, inset: this.inset, time: this.time, touch: this.input === 'touch' };
    // From the cockpit, the sky stops at the horizon.
    if (view && view.horizon !== null) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(-20, -20, w + 40, view.horizon + 20);
      ctx.clip();
    }

    // A star's speed is its depth: the faster it falls, the nearer it is, and the further it slides
    // against the ship. Stars that slide off one side come back on the other.
    const shift = -this.drift * w * PARALLAX;
    const starX = (star: Star): number => {
      const x = (star.x + (shift * star.speed) / 420) % w;
      return x < 0 ? x + w : x;
    };
    // From the cockpit the whole sky is slid up or down (stars that slide off one edge come back on the
    // other), and a star's streak points away from where the ship is heading instead of straight down.
    const lift = view?.lift ?? 0;
    const tall = h + 160;
    const starY = (star: Star): number => (lift ? ((((star.y + lift + 80) % tall) + tall) % tall) - 80 : star.y);
    const vanish = view?.vanish ?? null;
    const streak = (x: number, y: number, length: number): void => {
      ctx.moveTo(x, y);
      if (vanish) {
        const dx = x - vanish.x;
        const dy = y - vanish.y;
        const dist = Math.hypot(dx, dy) || 1;
        ctx.lineTo(x + (dx / dist) * length, y + (dy / dist) * length);
      } else {
        ctx.lineTo(x, y + length);
      }
    };
    const pace = view ? view.speed : this.warp;
    const stretch = view ? view.stretch : 1;
    // Stars, batched by brightness so each tier is a single stroke.
    for (let tier = 0; tier < 3; tier++) {
      this.ink(SAND, [0.22, 0.45, 0.8][tier]!, 1.2, () => {
        for (const star of this.stars) {
          if (star.streak || star.tier !== tier) continue;
          streak(starX(star), starY(star), Math.max(0.6, star.speed * pace * 0.02 * stretch));
        }
      }, false);
    }
    // Planets, moons and rocks go over the stars (they hide them) and under everything else.
    this.backdrop.render(ctx, shift, lift);
    // Streaks are quiet sand in a wave and turn neon while a boss is on screen.
    const streakColors = this.boss ? [NEON.cyan, NEON.violet, NEON.lime] : [SAND];
    // (Parked on the runway nothing is moving, so there are no streaks at all.)
    const streakAlpha = (this.boss ? 0.4 : 0.16) * (view ? clamp(view.speed, 0, 1) : 1);
    streakColors.forEach((color, band) => {
      if (streakAlpha <= 0) return;
      this.ink(color, streakAlpha, 1, () => {
        this.stars.forEach((star, i) => {
          if (!star.streak || i % streakColors.length !== band) return;
          streak(starX(star), starY(star), star.speed * (0.08 + pace * 0.035) * Math.sqrt(stretch));
        });
      }, false);
    });
    if (view && view.horizon !== null) ctx.restore();
    this.intro?.renderGround(frame);

    // Debris fades in two steps rather than per piece, and is grouped by colour, to keep strokes batched.
    for (const color of new Set(this.debris.map((d) => d.color))) {
      for (const fresh of [true, false]) {
        this.ink(color, fresh ? 1 : 0.45, 1.5, () => {
          for (const d of this.debris) {
            if (d.color !== color || d.age < d.ttl * 0.55 !== fresh) continue;
            const hx = (Math.cos(d.rot) * d.len) / 2;
            const hy = (Math.sin(d.rot) * d.len) / 2;
            ctx.moveTo(d.x - hx, d.y - hy);
            ctx.lineTo(d.x + hx, d.y + hy);
          }
        }, fresh);
      }
    }

    // Boost capsules are drawn in the ship's colour, small and quiet: an offer, not a threat.
    // An upgrade capsule is the exception: bright green, with a turning star, because it is the big prize.
    const pulse = 1 + 0.07 * Math.sin(this.time * 5);
    for (const prize of [false, true]) {
      const these = this.pickups.filter((p) => (p.reward === 'upgrade') === prize);
      if (!these.length) continue;
      const color = prize ? NEON.lime : SAND;
      this.ink(color, prize ? 1 : 0.9, prize ? 1.7 : 1.5, () => {
        for (const p of these) {
          trace(ctx, CAPSULE, p.x, p.y, sc * pulse * (prize ? 1.15 : 1), 0);
          trace(ctx, STAKES[p.reward].mark, p.x, p.y, sc * 0.8, prize ? this.time * 1.6 : 0);
        }
      });
      this.ink(color, prize ? 0.9 : 0.65, 1.1, () => {
        for (const p of these) traceText(ctx, STAKES[p.reward].label, p.x, p.y + (prize ? 22 : 19) * sc, 7, 'center');
      }, false);
    }

    // Bombs are the opposite: red, spiked, spinning and throbbing.
    if (this.mines.length) {
      const throb = 1 + 0.16 * Math.sin(this.time * 9);
      this.ink(NEON.red, 1, 1.7, () => {
        for (const m of this.mines) trace(ctx, MINE, m.x, m.y, sc * throb, m.age * 1.4);
      });
    }

    for (const color of ENEMY_COLORS) {
      if (!this.enemies.some((e) => e.flash <= 0 && KINDS[e.kind].color === color)) continue;
      this.ink(color, 1, 1.6, () => {
        for (const e of this.enemies) if (e.flash <= 0 && KINDS[e.kind].color === color) trace(ctx, KINDS[e.kind].shape, e.x, e.y, sc, e.rot);
      });
    }
    // Enemy shots are diamonds in the colour of whatever fired them.
    for (const color of new Set(this.shots.filter((s) => s.hostile).map((s) => s.color))) {
      this.ink(color, 1, 1.6, () => {
        for (const s of this.shots) {
          if (!s.hostile || s.color !== color) continue;
          const r = 4 * sc;
          ctx.moveTo(s.x, s.y - r);
          ctx.lineTo(s.x + r, s.y);
          ctx.lineTo(s.x, s.y + r);
          ctx.lineTo(s.x - r, s.y);
          ctx.closePath();
        }
      });
    }
    // An enemy that was just hit flashes in the ship's colour.
    this.ink(SAND, 1, 2.2, () => {
      for (const e of this.enemies) if (e.flash > 0) trace(ctx, KINDS[e.kind].shape, e.x, e.y, sc, e.rot);
    });

    // The ship's shots are drawn along the way they fly, so the angled wing cannons look angled.
    // (A wingmate's shots are green, so it is clear who fired what.)
    for (const color of new Set(this.shots.filter((s) => !s.hostile).map((s) => s.color))) {
      this.ink(color, 1, 1.8, () => {
        for (const s of this.shots) {
          if (s.hostile || s.color !== color) continue;
          const len = (11 * sc) / (Math.hypot(s.vx, s.vy) || 1);
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - s.vx * len, s.y - s.vy * len);
        }
      });
    }

    // Seeker rockets point the way they are flying and leave a short trail.
    if (this.rockets.length) {
      this.ink(NEON.orange, 1, 1.6, () => {
        for (const r of this.rockets) {
          const v = Math.hypot(r.vx, r.vy) || 1;
          trace(ctx, ROCKET, r.x, r.y, sc, Math.atan2(r.vx, -r.vy));
          ctx.moveTo(r.x - (r.vx / v) * 9 * sc, r.y - (r.vy / v) * 9 * sc);
          ctx.lineTo(r.x - (r.vx / v) * 22 * sc, r.y - (r.vy / v) * 22 * sc);
        }
      });
    }
    // The lance beam: a thick line to the top of the screen that fades in a blink.
    for (const beam of this.beams) {
      const fade = 1 - beam.age / 0.22;
      const line = () => {
        ctx.moveTo(beam.x, beam.y);
        ctx.lineTo(beam.x, 0);
      };
      this.ink(NEON.cyan, fade, 2 + 9 * fade, line);
      this.ink('#ffffff', fade, 1.5, line, false);
    }

    if (this.boss) {
      const b = this.boss;
      for (const part of bossParts(b, this.bossEnv(), this.time)) {
        this.ink(part.color, part.alpha, part.width, () => trace(ctx, part.shape, part.x, part.y, part.scale, part.rot));
        const label = part.label;
        if (label) this.ink(part.color, part.alpha, 1.6, () => traceText(ctx, label, part.x, part.y - 0.28 * 18 * part.scale, 0.56 * 18 * part.scale, 'center'), false);
      }
      // The sum boss wears its question above its head for as long as the answer ships are out.
      if (b.problem && b.pods.length) {
        const question = `${b.problem.question} = ?`;
        this.ink(NEON.yellow, 1, 1.8, () => traceText(ctx, question, b.x, b.y - 100 * sc, 18, 'center'));
        // On a touch screen the answer is tapped, not shot, and that needs saying while the ships are there.
        if (this.input === 'touch') {
          const x = clamp(b.x, this.inset.left + 70, w - this.inset.right - 70);
          this.ink(NEON.yellow, 0.6 + 0.3 * Math.sin(this.time * 6), 1.2, () => traceText(ctx, 'TAP THE ANSWER', x, b.y + 150 * sc, 9, 'center'), false);
        }
      }
    }

    for (const ring of this.rings) {
      if (ring.age < 0) continue;
      const t = ring.age / 0.7;
      const r = t * (ring.reach ?? Math.hypot(w, h));
      this.ink(ring.color, 1 - t, 2.4, () => {
        ctx.moveTo(ring.x + r, ring.y);
        ctx.arc(ring.x, ring.y, r, 0, Math.PI * 2);
      });
    }

    // The cockpit goes over the view out of it, and under the ship that rises as the cockpit drops away.
    this.intro?.renderCockpit(frame);

    // The ship blinks while it cannot be hit, but never disappears on the paused screen.
    const blinking = this.state === 'playing' && !this.paused && !this.prompt && !this.brk && this.ship.invulnerable > 0;
    const shipVisible = this.state !== 'over' && (!view || view.ship > 0) && (!blinking || Math.floor(this.time * 14) % 2 === 0);
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

      // Upgrades that can be seen: the shield (a circle, when it is charged), the wingmates and the guardian.
      if (this.shield.ready) {
        this.ink(NEON.cyan, 0.5 + 0.2 * Math.sin(this.time * 4), 1.3, () => {
          ctx.moveTo(this.ship.x + 22 * s, this.ship.y);
          ctx.arc(this.ship.x, this.ship.y, 22 * s, 0, Math.PI * 2);
        });
      }
      if (this.upgrades.has('wingmates')) {
        this.ink(NEON.lime, 1, 1.4, () => {
          for (const side of [-1, 1]) {
            const x = this.ship.x + side * WING * sc;
            const y = this.ship.y + 8 * sc + Math.sin(this.time * 3 + side) * 2;
            trace(ctx, FRIEND, x, y, 0.5 * s, 0);
            ctx.moveTo(x - 1.5 * s, y + 6.5 * s);
            ctx.lineTo(x, y + (6.5 + rand(3, 6)) * s);
            ctx.lineTo(x + 1.5 * s, y + 6.5 * s);
          }
        });
      }
      if (this.upgrades.has('guardian')) {
        const g = this.guardianAt;
        // It flies nose first round its circle.
        this.ink(NEON.cyan, 1, 1.4, () => trace(ctx, FRIEND, g.x, g.y, 0.45 * s, this.orbit + Math.PI));
      }
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

  /** Side of the square each corner face sits in: large on a desktop, smaller on phones (either way up). */
  private get faceBox(): number {
    if (this.w < 480 || this.h < 480) return 50;
    return this.w >= 1000 && this.h >= 640 ? 88 : 66;
  }

  /** Largest size up to `size` at which `text` fits in `width` px. */
  private fitTo(text: string, size: number, width: number): number {
    const full = textWidth(text, size);
    return full > width ? (size * width) / full : size;
  }

  private renderHud(): void {
    const { ctx } = this;
    const box = this.faceBox;
    const small = box < 60;
    const left = this.inset.left + 12;
    const top = this.inset.top + 12;

    // Top left: the pilot in the cockpit, with score, hull, wave and energy beside the face.
    this.renderFace('pilot', left, top, box);
    const x0 = left + box + 10;
    const hullY = top + (small ? 26 : Math.round(box * 0.5) + 1);
    const hullGap = small ? 20 : 24;
    const hullScale = small ? 0.48 : 0.55;
    const waveY = top + box - (small ? 9 : 10);
    const waveSize = small ? 8 : 9;
    const waveText = `WAVE ${this.wave}`;
    this.ink(SAND, 1, 1.4, () => {
      traceText(ctx, this.w < 360 ? pad6(this.score) : `SCORE ${pad6(this.score)}`, x0, top + 1, small ? 10 : 12);
      for (let i = 0; i < this.hull; i++) trace(ctx, SHIP, x0 + 8 + i * hullGap, hullY, hullScale, 0);
      if (this.w >= 720) traceText(ctx, `BEST ${pad6(this.best)}`, this.w / 2, top + 1, 12, 'center');
    });
    // Hull points that have been lost stay as faint outlines, so it is clear how many there are to win back.
    if (this.hull < this.maxHull) {
      this.ink(SAND, 0.25, 1, () => {
        for (let i = Math.max(0, this.hull); i < this.maxHull; i++) trace(ctx, SHIP, x0 + 8 + i * hullGap, hullY, hullScale, 0);
      }, false);
    }
    this.ink(SAND, 0.7, 1.2, () => traceText(ctx, waveText, x0, waveY, waveSize));

    // Energy gauge: ten ticks. The taller ones are the half that buys the third cannon.
    // It sits beside the hull, or beside the wave number where there is less room.
    const gauge = small ? x0 + textWidth(waveText, waveSize) + 10 : x0 + this.maxHull * hullGap + 8;
    const foot = small ? waveY + waveSize : hullY + 6;
    const step = small ? 4 : 5;
    if (this.jam > 0) {
      if (this.time % 0.5 < 0.32) this.ink(PINK, 1, 1.3, () => traceText(ctx, 'JAMMED', gauge, foot - waveSize, waveSize));
    } else if (this.energy > 0) {
      const lit = Math.ceil(this.energy * 10);
      const ticks = (from: number, to: number) => () => {
        for (let i = from; i < to; i++) {
          ctx.moveTo(gauge + i * step, foot - (small ? 8 : 11) - (i >= TRIPLE_AT * 10 ? 3 : 0));
          ctx.lineTo(gauge + i * step, foot);
        }
      };
      this.ink(PINK, 1, 1.6, ticks(0, lit));
      if (lit < 10) this.ink(SAND, 0.3, 1.2, ticks(lit, 10), false);
    }

    // The upgrades earned so far, as a row of small icons under the cockpit.
    if (this.upgrades.size) {
      this.ink(NEON.lime, 0.85, 1.1, () => {
        let i = 0;
        for (const u of UPGRADES) if (this.upgrades.has(u.id)) trace(ctx, u.icon, left + 8 + i++ * 18, top + box + 14, 0.55, 0);
      }, false);
    }

    // Top right, under the Sound and Exit buttons: the boss, with its health and whatever it is saying beside it.
    const v = this.villain;
    const b = this.boss;
    if (!b && v.show <= this.time) return;
    const bx = this.w - this.inset.right - 12 - box;
    const by = this.inset.top + 64;
    this.renderFace('boss', bx, by, box);
    const edge = bx - 10;
    const room = edge - left;
    if (b && (b.state === 'fight' || b.state === 'enter')) {
      const length = Math.min(150, room);
      this.ink(NEON.red, 0.25, 2, () => {
        ctx.moveTo(edge - length, by + 5);
        ctx.lineTo(edge, by + 5);
      }, false);
      this.ink(NEON.red, 1, 2.6, () => {
        ctx.moveTo(edge - length * Math.max(0, b.hp / b.maxHp), by + 5);
        ctx.lineTo(edge, by + 5);
      });
    }
    if (v.lineUntil > this.time) {
      const size = this.fitTo(v.line, small ? 9 : 11, room);
      const alpha = Math.min(1, (v.lineUntil - this.time) / 0.3);
      this.ink(NEON.yellow, alpha, 1.5, () => traceText(ctx, v.line, edge, by + 17, size, 'right'));
    }
  }

  /** One of the corner faces: a wireframe head in a frame, turned and wearing whatever it is feeling. */
  private renderFace(who: Who, x: number, y: number, box: number): void {
    const { ctx } = this;
    const t = this.time;
    const pilot = who === 'pilot';
    const mood = pilot ? this.pilotMood : this.villainMood;
    let yaw: number;
    let pitch: number;
    if (pilot) {
      // The pilot looks the way the ship is turning, nods when pleased and shudders when hit.
      yaw = this.lean * 0.55 + Math.sin(t * 0.8) * 0.07;
      pitch = Math.sin(t * 1.1) * 0.05 + (mood === 'hurt' && !this.reduceMotion ? Math.sin(t * 40) * 0.06 : 0) - (mood === 'happy' ? 0.1 : 0);
    } else {
      // The boss keeps its eyes on the ship, and its head bobs when it laughs.
      const look = this.boss ? clamp((this.ship.x - this.boss.x) / (this.w * 0.5), -1, 1) : 0;
      yaw = look * 0.5 + Math.sin(t * 0.6) * 0.1;
      pitch = 0.12 + (mood === 'laugh' && !this.reduceMotion ? Math.sin(t * 15) * 0.13 : 0);
    }
    const cut = box * 0.18;
    const frame = () => {
      ctx.moveTo(x + cut, y);
      ctx.lineTo(x + box - cut, y);
      ctx.lineTo(x + box, y + cut);
      ctx.lineTo(x + box, y + box - cut);
      ctx.lineTo(x + box - cut, y + box);
      ctx.lineTo(x + cut, y + box);
      ctx.lineTo(x, y + box - cut);
      ctx.lineTo(x, y + cut);
      ctx.closePath();
    };
    const head = pilot ? SAND : NEON.violet;
    const face = pilot ? (mood === 'hurt' ? PINK : mood === 'happy' ? NEON.lime : SAND) : mood === 'hurt' ? '#ffffff' : NEON.red;
    const cx = x + box / 2;
    const cy = y + box * (pilot ? 0.46 : 0.54);
    const size = box * (pilot ? 0.33 : 0.3);

    // Nothing of the head is drawn outside its frame.
    ctx.save();
    ctx.beginPath();
    frame();
    ctx.clip();
    this.ink(head, 0.45, 1, () => traceAvatar(ctx, who, 'head', cx, cy, size, yaw, pitch, mood, t), false);
    this.ink(face, 1, 1.5, () => traceAvatar(ctx, who, 'face', cx, cy, size, yaw, pitch, mood, t));
    if (pilot) {
      // The cockpit's console, across the bottom of the window.
      this.ink(SAND, 0.6, 1, () => {
        ctx.moveTo(x, y + box * 0.86);
        ctx.lineTo(x + box, y + box * 0.86);
        for (let i = 1; i < 4; i++) {
          ctx.moveTo(x + (box * i) / 4, y + box * 0.86);
          ctx.lineTo(x + (box * i) / 4, y + box * 0.93);
        }
      }, false);
    }
    ctx.restore();
    this.ink(head, 0.75, 1.3, frame, false);
  }

  private renderMessages(): void {
    const mid = this.h * 0.42;
    const blink = this.time % 1.1 < 0.75;

    if (this.paused) {
      this.centred('PAUSED', mid, 28);
      this.centred(this.coarse ? 'TAP TO RESUME' : 'PRESS P TO RESUME', mid + 52, 11, 0.8);
      return;
    }

    // In the cockpit, the words on the glass and the commander's briefing are intro.ts's.
    if (this.state === 'ready') return;

    if (this.brk) {
      this.renderBreak(this.brk);
      return;
    }

    if (this.prompt) {
      const p = this.prompt;
      const top = this.challengeTop;
      if (p.offer) {
        this.renderOffer(p.offer, p.offerAge);
        return;
      }
      this.renderChallenge(p.challenge, top, `${p.challenge.kind === 'line' ? 'TYPE' : 'SOLVE'} ${STAKES[p.stake].goal}`, p.stake === 'defuse' ? NEON.red : SAND);
      if (p.settled) this.centred(p.note, top + 180, 13, 1, p.fatal ? NEON.red : p.challenge.outcome?.success ? PINK : SAND);
      return;
    }

    // A boss arrives under a flashing warning, and leaves under a line saying how it went.
    if (this.state === 'playing' && this.boss?.state === 'enter') {
      const flash = Math.floor(this.time * 7) % 2 === 0;
      this.centred('WARNING', mid, 30, 1, flash ? NEON.red : NEON.yellow);
      this.centred(
        this.boss.kind === 'sum'
          ? `${this.input === 'touch' ? 'TAP' : 'BLAST'} THE RIGHT ANSWER TO CRACK ITS ARMOUR`
          : 'HIT THE RED CORE WHEN ITS ARMOUR OPENS',
        mid + 56, 11, 0.9, NEON.cyan,
      );
      return;
    }
    if (this.state === 'playing' && this.intermission > 0) {
      const color = NEON_LIST[Math.floor(this.time * 10) % NEON_LIST.length]!;
      this.centred(this.bossNote, mid, 26, Math.min(1, this.intermission / 0.4), color);
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

  /** Where the upgrades on offer go: one row each. Used to draw them and to tell which one was clicked. */
  private offerBoxes(count: number): Box[] {
    const rowHeight = this.h < 480 ? 44 : 54;
    const w = Math.min(this.room, 420);
    return Array.from({ length: count }, (_, i) => ({ x: this.w / 2 - w / 2, y: this.challengeTop + 26 + i * (rowHeight + 8), w, h: rowHeight }));
  }

  private renderOffer(offer: Upgrade[], age: number): void {
    const { ctx } = this;
    const alpha = Math.min(1, age / 0.3);
    const boxes = this.offerBoxes(offer.length);
    this.centred('CORRECT - CHOOSE AN UPGRADE', this.challengeTop, 11, alpha, NEON.lime);
    boxes.forEach((b, i) => {
      const u = offer[i]!;
      const textX = b.x + b.h + 10;
      const room = b.w - b.h - 22;
      const nameSize = this.fitTo(u.name, 12, room);
      this.ink(SAND, alpha * 0.9, 1.4, () => ctx.rect(b.x, b.y, b.w, b.h));
      this.ink(NEON.lime, alpha, 1.6, () => {
        trace(ctx, u.icon, b.x + 4 + b.h / 2, b.y + b.h / 2, b.h / 40, 0);
        traceText(ctx, u.name, textX, b.y + b.h / 2 - nameSize - 2, nameSize);
      });
      this.ink(SAND, alpha * 0.8, 1.1, () => traceText(ctx, u.blurb, textX, b.y + b.h / 2 + 6, this.fitTo(u.blurb, 8, room)), false);
      // The number key that picks this one, for players at a keyboard.
      if (this.input === 'keys') this.ink(SAND, alpha * 0.55, 1, () => traceText(ctx, String(i + 1), b.x + b.w - 8, b.y + 6, 7, 'right'), false);
    });
    const last = boxes[boxes.length - 1];
    if (last) this.centred(this.input === 'keys' ? 'CLICK ONE OR PRESS ITS NUMBER' : 'TAP ONE', last.y + last.h + 12, 8, alpha * 0.6);
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

  private renderChallenge(c: Challenge, top: number, title: string, titleColor = SAND): void {
    const { ctx } = this;
    const alpha = Math.min(1, c.age / 0.35);
    const done = c.outcome !== null;
    this.centred(title, top, 11, alpha * (titleColor === SAND ? 0.8 : 1), titleColor);

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
        // The field flashes red, and shakes, when a wrong answer has just been wiped for a second try.
        const wiped = !done && c.error > 0;
        if (wiped && !this.reduceMotion) field.x += rand(-3, 3);
        this.ink(right ? PINK : wiped ? NEON.red : SAND, alpha, right || wiped ? 2.6 : 1.5, () => ctx.rect(field.x, field.y, field.w, field.h));
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
      const again = c.kind === 'entry' && c.misses > 0;
      const how = again ? 'NOT QUITE - ONE MORE TRY' : c.kind === 'entry' ? 'TYPE THE ANSWER' : this.input === 'keys' ? 'CLICK AN ANSWER OR PRESS ITS NUMBER' : 'TAP THE ANSWER';
      this.centred(how, hintY, again ? 10 : 8, alpha * (again ? 1 : 0.6), again ? NEON.red : SAND);
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
