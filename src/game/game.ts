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
 * - Every enemy ship holds somebody prisoner. Destroying it sets them free, and they fly up to be counted;
 *   a beaten boss lets out a whole crowd.
 * - Half way through each wave a fuel ship arrives (see tanker.ts): hook on to its fuel line and stay on.
 * - Later in the wave the flight commander bursts in with a warning, and an asteroid field follows
 *   (see asteroids.ts): two winding ways through, an easy one with bombs in it and a hard one with power-ups.
 * - Behind it all, low-poly planets, moons and rocks drift by at different depths (see backdrop.ts).
 * - It opens in the cockpit: a briefing from the flight commander, then a take-off that hands over to
 *   the top-down view (see intro.ts).
 *
 * The questions live in challenge.ts (the rules), maths.ts and lines.ts (the content).
 */
import { createField, gapAt, updateField, type Field, type FieldEnv, type Rock } from './asteroids';
import { traceAvatar, type Mood, type Who } from './avatar';
import { Backdrop } from './backdrop';
import { NEON, NEON_LIST, bossParts, createBoss, shootBoss, tapBoss, touchesBoss, updateBoss, type Boss, type BossEnv, type Hit } from './boss';
import {
  accepts, choiceChallenge, choose, entryChallenge, lineChallenge, press, tick,
  type Challenge, type ChoiceChallenge, type LineChallenge,
} from './challenge';
import { advance, textWidth, traceText } from './font';
import { Intro, type Ink, type IntroCue, type IntroView } from './intro';
import { BRIEFING, LINES, TAUNTS, WORDS, type Taunt } from './lines';
import { makeProblem } from './maths';
import {
  CAPSULE, DART, DRIFTER, DROGUE, FRIEND, HEX, MARK_BOMB, MARK_ENERGY, MARK_HULL, MARK_STAR, MINE, MITE, PERSON_OUT, PERSON_UP, ROCKET, SAUCER,
  SHARD, SHIP, SPINNER, SPLITTER, TANKER, WEAVER, segments, trace, type Shape,
} from './shapes';
import { Sound, type Sfx } from './sound';
import { FUEL_SECONDS, TANKER_SIZE, createTanker, dismissTanker, tankerTail, updateTanker, type Tanker, type TankerEnv } from './tanker';
import { UPGRADES, offerUpgrades, type Upgrade, type UpgradeId } from './upgrades';

const SAND = '#ecdfd2';
const PINK = '#d98ac0';
/** Enemies come in a few warm colours, one per family, so a new kind is easy to tell from an old one. */
const LILAC = '#b3a0ff';
const AMBER = '#f0b45a';
const ROSE = '#ff7ab8';
/** The people set free are drawn in the brightest colour in the game, and so is their count. */
const SOUL = '#f4fbff';
/** Seconds somebody just set free drifts about before flying up to be counted, and the most drawn at once. */
const SOUL_FLOAT = 0.7;
const MAX_SOULS = 80;
/** Points for filling the tank from the fuel ship. */
const FULL_TANK_POINTS = 400;
/** Rocks: the tough ones are dull, the little ones that break at a touch are bright. */
const ROCK = '#7c8fa8';
const PEBBLE = '#d7e3f2';
/**
 * The commander's warning: how long it is on screen, when the commander turns from the alarm to the choice
 * of ways through, and how far in the asteroids set off.
 */
const ALERT_SECONDS = 6;
const ALERT_TURN = 2.4;
const ALERT_LEAD = 3.4;
/** Points for breaking a little rock and a tough one, for getting through a field, and for doing it without a scratch. */
const PEBBLE_POINTS = 20;
const ROCK_POINTS = 150;
const FIELD_POINTS = 150;
const CLEAN_FIELD_POINTS = 400;
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

/**
 * On a short screen: how far in from the right edge the boss's corner reaches (its face, then its health
 * bar and its taunts, which are kept to SHORT_TAUNT px wide there).
 */
const SHORT_TAUNT = 130;
const BOSS_CORNER = 12 + 50 + 10 + SHORT_TAUNT + 10;

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
interface Pickup {
  reward: Reward; x: number; y: number; anchorX: number; phase: number; age: number; dead: boolean;
  /** A power-up in an asteroid field: it falls at this speed, in step with the rocks, and does not sway. */
  ride?: number;
}
/** A bomb drifting down the screen. Touching it means answering a question or losing the ship. */
/** A hazard bomb. One thrown by a boss drifts after the ship. */
interface Mine {
  x: number; y: number; anchorX: number; phase: number; age: number; dead: boolean; thrown: boolean;
  /** A bomb in an asteroid field: it falls at this speed, in step with the rocks, and does not sway. */
  ride?: number;
}
/** An expanding shockwave. A negative age delays it. */
/** An expanding ring. It grows to `reach` px, or right across the screen when that is left out. */
interface Ring { x: number; y: number; age: number; color: string; reach?: number }
/** Somebody set free, on their way to be counted. A negative age delays them, so a crowd pours out rather than popping out. */
interface Soul { x: number; y: number; vx: number; vy: number; age: number; phase: number; dead: boolean }
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
  /** Called whenever the game is paused or resumed, however that happened, so a Pause button can keep in step. */
  onPause?: (paused: boolean) => void;
}

/** The boss's face before it has done or said anything. */
const freshVillain = () => ({ mood: 'calm' as Mood, until: 0, line: '', lineUntil: 0, nextIdle: 0, show: 0, warned: false, bye: false, beaten: false });
const isHostile = (shot: Shot): boolean => shot.hostile;
const isOwn = (shot: Shot): boolean => !shot.hostile;

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
  /** Where the canvas's top left corner is in the window, measured when it is laid out rather than on every touch. */
  private origin = { x: 0, y: 0 };
  /** Counts the ship's volleys, for the things that fire every other one. */
  private volley = 0;
  /** Scratch space for sorting things by colour before drawing them. */
  private readonly tints = new Set<string>();

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
  /** The people set free this game: those still on their way to the counter, and the count itself. */
  private souls: Soul[] = [];
  private freed = 0;
  private freedPulse = 0;
  /** How many the last boss was holding. */
  private bossFreed = 0;
  /**
   * The set pieces in a wave, in order: the fuel ship and the asteroid field, and when each is due.
   * `due` is the one waiting for a clear sky before it starts; the wave's clock stops from then until it is over.
   */
  private stops: { at: number; kind: 'fuel' | 'rocks' }[] = [];
  private due: 'fuel' | 'rocks' | null = null;
  private dueWait = 0;
  private tanker: Tanker | null = null;
  /** The asteroid field, the rocks of it that are on screen, and how many times it has hit the ship. */
  private field: Field | null = null;
  private near: Rock[] = [];
  private fieldHits = 0;
  /** Seconds the commander's asteroid warning has been up, or null when it is not. */
  private alert: number | null = null;
  /** A line about how the refuelling or the asteroids went, and when it fades. */
  private fuelNote = { text: '', until: 0, color: SAND };
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
  private villain = freshVillain();
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
    opts.onStatus?.(Intro.script(this.input === 'touch', !this.reduceMotion));

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

  get isPaused(): boolean {
    return this.paused;
  }

  /** Pause or resume: this is what the overlay's Pause button does. Only a game in play can be paused. */
  togglePause(): void {
    this.setPaused(!this.paused);
  }

  private setPaused(on: boolean): void {
    if (on === this.paused || (on && this.state !== 'playing')) return;
    this.paused = on;
    this.keys.clear();
    this.touchId = null;
    this.opts.onPause?.(on);
    this.opts.onStatus?.(on ? 'Paused.' : 'Resumed.');
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
    const was = { w: this.w, h: this.h };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = canvas.clientWidth;
    this.h = canvas.clientHeight;
    const box = canvas.getBoundingClientRect();
    this.origin = { x: box.left, y: box.top };
    canvas.width = Math.round(this.w * dpr);
    canvas.height = Math.round(this.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // A phone held sideways is short: everything shrinks further there, to leave room to fly.
    this.scale = clamp(Math.min(this.w, this.h) / 700, this.h < 500 ? 0.62 : 0.85, 1.3);
    // Everything that flies does so at a speed in proportion to the height of the screen, so a short screen
    // (a phone held sideways) gives a pilot as long to react as a tall one does.
    this.pace = clamp(this.h / 760, 0.6, 1.35);

    const cs = getComputedStyle(canvas.parentElement ?? canvas);
    this.inset = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };

    const count = Math.min(170, Math.floor((this.w * this.h) / 7500));
    if (first || !was.w || !was.h) {
      this.stars = Array.from({ length: count }, () => this.makeStar(rand(0, this.h)));
    } else {
      // A change of size (a window being dragged, a phone's address bar sliding away) keeps the stars it has,
      // spread over the new shape, rather than scattering a new sky.
      for (const star of this.stars) {
        star.x *= this.w / was.w;
        star.y *= this.h / was.h;
      }
      while (this.stars.length < count) this.stars.push(this.makeStar(rand(0, this.h)));
      this.stars.length = count;
    }
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
      if (code === 'KeyP' || code === 'Space' || code === 'Enter') this.setPaused(false);
      return;
    }
    if (code === 'KeyP') {
      this.setPaused(true);
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
      this.setPaused(true);
    } else {
      // Coming back from another app, the phone may have taken the audio away: ask for it back.
      this.sound.unlock();
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    const touch = e.pointerType !== 'mouse';
    // Only the main mouse button plays; the others are the browser's.
    if (!touch && e.button !== 0) return;
    this.sound.unlock();
    const box = this.canvas.getBoundingClientRect();
    this.origin = { x: box.left, y: box.top };
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
        if (this.strikeBoss(e.clientX - this.origin.x, e.clientY - this.origin.y, true, true)) {
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
    if (this.paused) this.setPaused(false);
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
    this.touch.x = e.clientX - this.origin.x;
    this.touch.y = e.clientY - this.origin.y - 64;
  }

  /** Which answer box, if any, a click or tap landed on. */
  private optionAt(e: PointerEvent): number | null {
    const c = this.challenge;
    if (!c || c.kind !== 'choice' || c.outcome) return null;
    return this.boxAt(e, this.optionBoxes(c.options.length, this.challengeTop));
  }

  /** Which of these boxes, if any, a click or tap landed on (with a little slack for fingers). */
  private boxAt(e: PointerEvent, boxes: Box[]): number | null {
    const x = e.clientX - this.origin.x;
    const y = e.clientY - this.origin.y;
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

  /** Space, Enter or a tap before the game has begun: skip the hangar, launch, or cut the take-off short. */
  private go(): void {
    const intro = this.intro;
    if (!intro || this.stateTime < 0.5) return;
    const briefing = intro.phase === 'brief';
    intro.advance();
    if (briefing) this.opts.onStatus?.('Taking off.');
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
    this.souls = [];
    this.freed = 0;
    this.tanker = null;
    this.field = null;
    this.near = [];
    this.alert = null;
    this.due = null;
    this.stops = [];
    this.fuelNote.until = 0;
    this.prompt = null;
    this.boss = null;
    this.intermission = 0;
    this.upgrades.clear();
    this.shield = { ready: false, recharge: 0 };
    this.rockets = [];
    this.beams = [];
    this.pilot = { mood: 'calm', until: 0 };
    this.villain = freshVillain();
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
    this.tanker = null;
    this.field = null;
    this.near = [];
    this.alert = null;
    this.due = null;
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
    // When each group starts and ends, so the fuel ship does not turn up in the middle of one.
    const spans: [number, number][] = [];
    for (let i = 0; i < slots; i++) {
      // Open with drifters, show off anything new next, then mix (drifters stay the most common).
      const group: Group = i === 0 ? 'drifters' : fresh[i - 1] ?? pick([...known, 'drifters']);
      const x = this.spawnX();
      if (group === 'drifters') {
        const phase = rand(0, Math.PI * 2);
        for (let k = 0; k < chainLength; k++) q.push({ at: t + k * 0.42, kind: 'drifter', x, phase });
        spans.push([t, t + (chainLength - 1) * 0.42]);
      } else if (group === 'mites') {
        // A V of five, the leader in front.
        const reach = 44 * sc;
        const lead = clamp(x, this.inset.left + this.margin + reach, Math.max(this.inset.left + this.margin + reach, this.w - this.inset.right - this.margin - reach));
        for (let k = -2; k <= 2; k++) q.push({ at: t + Math.abs(k) * 0.16, kind: 'mite', x: lead + k * 22 * sc, phase: 0 });
        spans.push([t, t + 0.32]);
      } else if (group === 'weavers') {
        const dir = Math.random() < 0.5 ? -1 : 1;
        for (let k = 0; k < (n >= 5 ? 3 : 2); k++) q.push({ at: t + k * 0.55, kind: 'weaver', x, phase: 0, dir: k % 2 ? -dir : dir });
        spans.push([t, t + 1.1]);
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
    // Two set pieces break the wave up: the fuel ship about a third of the way through its groups and the
    // asteroid field about two thirds, each once any group already on its way in has arrived.
    const stopAfter = (slot: number): number => {
      let at = 1.5 + gap * slot - 0.2;
      for (const [from, to] of spans) if (from < at && to >= at) at = to + 0.05;
      return at;
    };
    const fuelSlot = Math.max(1, Math.round(slots / 3));
    const rockSlot = Math.max(fuelSlot + 1, Math.round((2 * slots) / 3));
    this.stops = [{ at: stopAfter(fuelSlot), kind: 'fuel' }, { at: stopAfter(rockSlot), kind: 'rocks' }];
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

  /** What an ordinary capsule holds: whatever helps most. Repairs when the hull is hurt, blasts once the waves get busy. */
  private pickReward(): Reward {
    const pool: Reward[] = ['energy'];
    if (this.hull < this.maxHull) pool.push('hull', 'hull');
    if (this.wave >= 2) pool.push('blast');
    return pick(pool);
  }

  private spawnPickup(reward?: Reward): void {
    const x = this.spawnX();
    this.pickups.push({ reward: reward ?? this.pickReward(), x, y: -24, anchorX: x, phase: rand(0, Math.PI * 2), age: 0, dead: false });
  }

  private spawnMine(): void {
    const x = this.spawnX();
    this.mines.push({ x, y: -24, anchorX: x, phase: rand(0, Math.PI * 2), age: 0, dead: false, thrown: false });
  }

  /** What the boss needs to know about the world, and the ways it can act on it. */
  /** What the boss knows of the game: made once, and brought up to date each time it is asked for. */
  private readonly env: BossEnv = {
    w: 0, h: 0, top: 0, scale: 1, pace: 1, headroom: 104, sweep: Infinity, calm: false, shipX: 0, shipY: 0,
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

  private bossEnv(): BossEnv {
    const env = this.env;
    env.w = this.w;
    env.h = this.h;
    env.top = this.inset.top;
    env.scale = this.scale;
    env.pace = this.pace;
    // On a short screen (a phone held sideways) the HUD is all in the corners, so the boss can sit higher;
    // but it must not sweep under its own health bar and taunts, which are to the left of its face.
    // On a narrow one it sits a little lower, so the sum over its head clears the taunts.
    const short = this.h < 500;
    env.headroom = short ? 68 : this.w < 480 ? 112 : 104;
    env.sweep = short ? Math.max(0, this.w / 2 - this.inset.right - BOSS_CORNER - 84) : Infinity;
    env.calm = this.reduceMotion;
    env.shipX = this.ship.x;
    env.shipY = this.ship.y;
    return env;
  }

  /** What the fuel ship knows of the game: made once, and brought up to date each time it is asked for. */
  private readonly fuelEnv: TankerEnv = { w: 0, h: 0, top: 0, left: 0, right: 0, scale: 1, noseX: 0, noseY: 0 };

  private tankerEnv(): TankerEnv {
    const env = this.fuelEnv;
    env.w = this.w;
    env.h = this.h;
    env.top = this.inset.top;
    env.left = this.inset.left;
    env.right = this.inset.right;
    env.scale = this.scale;
    env.noseX = this.ship.x;
    env.noseY = this.ship.y - 16 * this.shipScale;
    return env;
  }

  private callTanker(): void {
    this.tanker = createTanker(this.wave, this.tankerEnv());
    this.sound.play('tanker');
    this.opts.onStatus?.(`A fuel ship has arrived. Fly up behind it, catch the end of its fuel line with the nose of the ship, and stay hooked on for ${FUEL_SECONDS} seconds. It will not hold still.`);
  }

  /** Fly the fuel ship, and pay out its fuel: energy for as long as the line is on, and a bonus for a full tank. */
  private flyTanker(dt: number): void {
    const t = this.tanker;
    if (!t) return;
    const playing = this.state === 'playing';
    const event = updateTanker(t, dt, this.tankerEnv());
    const note = (text: string, color: string, seconds = 1.8) => {
      this.fuelNote = { text, until: this.time + seconds, color };
    };
    if (t.hooked && playing) {
      this.energy = Math.min(1, this.energy + dt / FUEL_SECONDS);
      this.sound.play('pump');
    }
    if (event === 'hook') {
      this.sound.play('hook');
      this.feel('happy', 0.8, true);
      if (!t.snaps) this.opts.onStatus?.('Fuel line hooked on. Stay with the fuel ship.');
    } else if (event === 'snap') {
      this.sound.play('snap');
      this.spark(this.ship.x, this.ship.y - 16 * this.shipScale, NEON.red);
      this.feel('worried', 1, true);
      this.opts.onStatus?.(`The fuel line came off: too ${t.why === 'close' ? 'close' : 'far away'}. Catch it again.`);
    } else if (event === 'full') {
      this.energy = 1;
      this.score += FULL_TANK_POINTS;
      this.feel('happy', 1.4);
      this.sound.play('power');
      this.rings.push({ x: this.ship.x, y: this.ship.y, age: 0, color: NEON.lime, reach: 120 * this.scale });
      note(`FULL TANK +${FULL_TANK_POINTS}`, NEON.lime, 2);
      this.opts.onStatus?.('Tank full. Cannons at full power.');
    } else if (event === 'leave') {
      note(t.fuel > 0 ? `FUEL SHIP LEAVING - TANK ${percent(t.fuel)}% FULL` : 'THE FUEL SHIP COULD NOT WAIT', SAND);
      this.opts.onStatus?.('The fuel ship has left.');
    }
    if (t.state === 'gone') this.tanker = null;
  }

  private readonly rockEnv: FieldEnv = { w: 0, h: 0, left: 0, right: 0, scale: 1, pace: 1, wave: 1 };

  private fieldEnv(): FieldEnv {
    const env = this.rockEnv;
    env.w = this.w;
    env.h = this.h;
    env.left = this.inset.left;
    env.right = this.inset.right;
    env.scale = this.scale;
    env.pace = this.pace;
    env.wave = this.wave;
    return env;
  }

  /** The flight commander bursts in, worried: asteroids ahead. The field itself sets off a moment later. */
  private raiseAlarm(): void {
    this.alert = 0;
    this.sound.play('alarm');
    this.feel('worried', ALERT_TURN + 1);
    this.opts.onStatus?.(
      `Flight commander: ${BRIEFING.asteroids.join(' ')} ${BRIEFING.choice.join(' ')} An asteroid field is coming down the screen, with two winding ways through. ` +
      'The easy way is wide and has bombs in it, which ask a question if touched. The hard way is narrow and has power-ups instead. ' +
      'Little rocks break in one shot; the rest take many.',
    );
  }

  private startField(): void {
    const f = createField(this.fieldEnv());
    this.field = f;
    this.fieldHits = 0;
    for (const b of f.bombs) {
      this.mines.push({ x: b.x, y: f.front - b.d, anchorX: b.x, phase: 0, age: 0, dead: false, thrown: false, ride: f.speed });
    }
    // The hard way's power-ups: boosts, and at the far end the big prize, an upgrade (while there are any left to win).
    f.prizes.forEach((p, i) => {
      const last = i === f.prizes.length - 1 && this.upgrades.size < UPGRADES.length;
      this.pickups.push({ reward: last ? 'upgrade' : this.pickReward(), x: p.x, y: f.front - p.d, anchorX: p.x, phase: 0, age: 0, dead: false, ride: f.speed });
    });
  }

  /** Run the warning and then the asteroid field. `dt` is the world's time, `real` the clock's. */
  private flyField(dt: number, real: number): void {
    if (this.alert !== null) {
      const was = this.alert;
      this.alert += dt;
      if (was < ALERT_TURN && this.alert >= ALERT_TURN) this.sound.play('radio');
      if (was < ALERT_LEAD && this.alert >= ALERT_LEAD) this.startField();
      if (this.alert >= ALERT_SECONDS) this.alert = null;
    }
    const f = this.field;
    if (!f) return;
    updateField(f, dt, real, this.fieldEnv());
    if (f.rocks.some((rock) => rock.dead)) f.rocks = f.rocks.filter((rock) => !rock.dead);
    // Only the rocks on screen are drawn or can be hit.
    this.near.length = 0;
    for (const rock of f.rocks) {
      const y = f.front - rock.d;
      if (y > -rock.r - 8 && y < this.h + rock.r + 8) this.near.push(rock);
    }
    if (!f.done) return;
    this.field = null;
    this.near.length = 0;
    if (this.state !== 'playing') return;
    const clean = this.fieldHits === 0;
    const points = clean ? CLEAN_FIELD_POINTS : FIELD_POINTS;
    this.score += points;
    this.fuelNote = { text: `${clean ? 'NOT A SCRATCH' : 'THROUGH THE ASTEROIDS'} +${points}`, until: this.time + 2, color: clean ? NEON.lime : SAND };
    this.feel('happy', 1.4);
    this.sound.play('right');
    this.opts.onStatus?.(`Through the asteroid field${clean ? ' without a scratch' : ''}.`);
  }

  /** A shot has landed on a rock. Little ones break after a couple; on the rest it mostly just sparks. */
  private hitRock(rock: Rock, x: number, y: number): void {
    rock.hp -= 1;
    rock.flash = 0.08;
    if (rock.hp <= 0) {
      this.breakRock(rock);
    } else if (rock.tough) {
      this.spark(x, y, ROCK);
      this.sound.play('clang');
    } else {
      this.sound.play('hit');
    }
  }

  private breakRock(rock: Rock): void {
    if (rock.dead || !this.field) return;
    rock.dead = true;
    this.score += rock.tough ? ROCK_POINTS : PEBBLE_POINTS;
    this.burst(rock.shape, rock.x, this.field.front - rock.d, 1, rock.rot, rock.tough ? ROCK : PEBBLE);
    this.sound.play('boom');
  }

  /** Set people free at (x, y): one from an ordinary ship, a crowd from a boss. They fly up to the counter. */
  private free(x: number, y: number, count = 1): void {
    const crowd = count > 1;
    if (!crowd) this.rings.push({ x, y, age: 0.12, color: SOUL, reach: 34 * this.scale });
    for (let i = 0; i < count; i++) {
      // More than can be drawn at once are counted straight away.
      if (this.souls.length >= MAX_SOULS) {
        this.freed += 1;
        continue;
      }
      // One pops up and out of the wreck; a crowd scatters every way.
      const angle = crowd ? rand(0, Math.PI * 2) : rand(-Math.PI * 0.85, -Math.PI * 0.15);
      const speed = (crowd ? rand(70, 300) : rand(50, 110)) * this.scale;
      this.souls.push({
        x: x + (crowd ? rand(-30, 30) * this.scale : 0), y: y + (crowd ? rand(-20, 20) * this.scale : 0),
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        age: crowd ? -i * 0.04 : 0, phase: rand(0, Math.PI * 2), dead: false,
      });
    }
  }

  /** Where the score is written, and so where the count of people freed goes: just after it. */
  private get scoreLine(): { text: string; size: number; x: number; y: number } {
    const box = this.faceBox;
    return {
      text: this.w < 360 ? pad6(this.score) : `SCORE ${pad6(this.score)}`,
      size: box < 60 ? 10 : 12,
      x: this.inset.left + 12 + box + 10,
      y: this.inset.top + 13,
    };
  }
  private get freedAt(): { x: number; y: number } {
    const line = this.scoreLine;
    return { x: line.x + textWidth(line.text, line.size) + (line.size < 12 ? 13 : 18), y: line.y + line.size / 2 };
  }

  private updateSouls(dt: number): void {
    this.freedPulse = Math.max(0, this.freedPulse - dt);
    if (!this.souls.length) return;
    const home = this.freedAt;
    const slow = Math.exp(-dt * 3.2);
    for (const s of this.souls) {
      s.age += dt;
      if (s.age < 0) continue;
      if (s.age < SOUL_FLOAT) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vx *= slow;
        s.vy *= slow;
        continue;
      }
      // Then away to be counted, faster and faster.
      const dx = home.x - s.x;
      const dy = home.y - s.y;
      const dist = Math.hypot(dx, dy);
      const step = (240 + (s.age - SOUL_FLOAT) * 1100) * Math.max(0.8, this.scale) * dt;
      if (dist <= step + 5) {
        s.dead = true;
        this.freed += 1;
        this.freedPulse = 0.3;
        this.sound.play('free');
      } else {
        s.x += (dx / dist) * step;
        s.y += (dy / dist) * step;
      }
    }
    this.souls = this.souls.filter((s) => !s.dead);
  }

  private startBoss(): void {
    this.boss = createBoss(this.wave, this.bossEnv());
    this.bossAsked = 0;
    this.banner = 0;
    this.villain = freshVillain();
    this.taunt('enter', 'laugh', 2, 1, true);
    this.sound.play('warning');
    this.opts.onStatus?.(
      this.boss.kind === 'sum'
        ? `Mini boss. ${this.input === 'touch' ? 'Tap' : 'Keep shooting'} the little ship carrying the right answer to open its armour, then shoot the red core.`
        : 'Mini boss. Shoot its arms off, and shoot the red core when its armour opens.',
    );
  }

  private updateBossFight(dt: number, real: number): void {
    const b = this.boss;
    if (!b) return;
    updateBoss(b, dt, this.bossEnv(), real);
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
      // A boss holds a crowd, and a bigger one each wave.
      this.bossFreed = Math.min(30, 10 + 2 * b.wave);
      this.free(b.x, b.y, this.bossFreed);
      for (const s of this.shots) if (s.hostile) s.dead = true;
      this.rings.push(
        { x: b.x, y: b.y, age: 0, color: NEON.red },
        { x: b.x, y: b.y, age: -0.12, color: NEON.cyan },
        { x: b.x, y: b.y, age: -0.24, color: NEON.yellow },
      );
      if (!this.reduceMotion) this.shake = 0.5;
    } else {
      this.bossNote = 'IT GOT AWAY';
      this.bossFreed = 0;
    }
    this.intermission = 1.8;
    this.sound.play(b.defeated ? 'fanfare' : 'escape');
    this.opts.onStatus?.(b.defeated ? `Mini boss destroyed. ${this.bossFreed} people set free.` : 'The mini boss got away.');
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
    // Whoever it was holding is free.
    this.free(e.x, e.y);
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
    // In an asteroid field it clears the little rocks on screen. The tough ones shrug it off.
    for (const rock of this.near) if (!rock.tough) this.breakRock(rock);
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
    this.due = null;
    this.stops = [];
    this.alert = null;
    this.fuelNote.until = 0;
    if (this.tanker) dismissTanker(this.tanker);
    if (this.boss) this.taunt('win', 'laugh', 6, 1, true);
    // A boss that has won does not hang about over the game over screen.
    if (this.boss && this.boss.state !== 'dying') {
      this.boss.pods = [];
      this.boss.state = 'leaving';
    }
    this.newBest = this.saveBest();
    this.setState('over');
    this.sound.play('over');
    // (Anyone still on their way to the counter has been freed all the same.)
    const freed = this.freed + this.souls.length;
    this.opts.onStatus?.(`Game over. Score ${this.score}. Wave ${this.wave}. You set ${freed} ${freed === 1 ? 'person' : 'people'} free.`);
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
          ? this.input === 'touch'
            ? `What is ${c.question}? Tap the answer: ${c.options.join(', ')}.`
            : `What is ${c.question}? ${c.options.map((o, i) => `Press ${i + 1} for ${o}`).join(', ')}.`
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
        p.note = 'CANNONS JAMMED';
        p.hold = 1.8;
        // The jam lasts beyond the moment the result is on screen (when nothing can hurt the ship anyway),
        // so a wrong answer costs a spell of real flying without cannons.
        this.jam = JAM_SECONDS + p.hold;
        this.sound.play('jam');
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
          ? `Correct. Choose an upgrade. ${p.offer.map((u, i) => `${this.input === 'touch' ? 'Tap' : `Press ${i + 1} for`} ${u.name.toLowerCase()}: ${u.blurb.toLowerCase()}`).join('. ')}.`
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
    // Flashes of light keep real time, so one caught by slow motion does not hang about for seconds.
    for (const beam of this.beams) beam.age += dt;
    if (this.beams.length) this.beams = this.beams.filter((b) => b.age < 0.22);
    for (const ring of this.rings) ring.age += dt;
    this.rings = this.rings.filter((ring) => ring.age < 0.7);
    // A boss on its way out (after a game over) still has to fly off the screen, and so does a fuel ship.
    if (this.boss && this.state !== 'playing') this.updateBossFight(sim, dt);
    if (this.tanker && this.state !== 'playing') this.flyTanker(sim);
    if (this.field && this.state !== 'playing') this.flyField(sim, dt);
    this.updateSouls(sim);

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
          this.updateBossFight(sim, dt);
        } else {
          this.updateWave(sim, dt);
        }
        this.updatePickups(sim);
        this.updateMines(sim);
        this.updateUpgrades(sim);
        this.updatePrompt(dt);
      }
    }
    this.updateEnemies(sim, dt);
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
    // (And it holds fire while it is on the fuel line: the fuel ship is right in front of the cannons.)
    if ((keys.has('Space') || this.touchId !== null) && ship.cooldown <= 0 && this.jam <= 0 && !this.asking && !this.tanker?.hooked) {
      const has = (id: UpgradeId) => this.upgrades.has(id);
      ship.cooldown = has('rapid') ? 0.11 : 0.17;
      this.volley += 1;
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
      // The wingmates fire with every other volley: a real help, without doing the pilot's job for them.
      if (has('wingmates') && this.volley % 2 === 0) {
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

  private updateWave(dt: number, real: number): void {
    // The wave waits while the fuel ship or the asteroid field is here, and before that until the sky is
    // clear enough for it to come in.
    if (this.tanker) {
      this.flyTanker(dt);
      return;
    }
    if (this.field || this.alert !== null) {
      this.flyField(dt, real);
      return;
    }
    if (this.due) {
      this.dueWait += dt;
      if (!this.prompt && (!this.enemies.length || this.dueWait > 12)) {
        if (this.due === 'fuel') this.callTanker();
        else this.raiseAlarm();
        this.due = null;
      }
      return;
    }
    const next = this.stops[0]?.at ?? Infinity;
    this.waveTime = Math.min(this.waveTime + dt, next);
    if (this.waveTime >= next) {
      this.due = this.stops.shift()!.kind;
      this.dueWait = 0;
    }
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
      m.y += (m.ride ?? 74 * this.pace * hurry) * dt;
      // A thrown bomb drifts after the ship; an ordinary one just sways; one in an asteroid field keeps its place.
      if (m.thrown) m.anchorX += clamp(this.ship.x - m.anchorX, -1, 1) * 30 * this.scale * dt;
      m.x = m.ride !== undefined ? m.anchorX : m.anchorX + Math.sin(m.age * 0.9 + m.phase) * (m.thrown ? 12 : 34) * this.scale;
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
    for (const p of this.pickups) {
      if (p.ride !== undefined) {
        // A power-up in an asteroid field keeps its place among the rocks, question or no question.
        p.age += dt;
        p.y += p.ride * dt;
      } else if (!this.prompt) {
        // The others wait while a question is on screen, so one never slips past a pilot who is busy answering.
        p.age += dt;
        p.y += 60 * this.pace * hurry * dt;
        p.x = p.anchorX + Math.sin(p.age * 1.3 + p.phase) * 18 * this.scale;
      }
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
    if (has('shield') && !this.shield.ready) {
      this.shield.recharge -= dt;
      if (this.shield.recharge <= 0) {
        this.shield.ready = true;
        this.sound.play('shieldUp');
      }
    }

    if (has('guardian')) {
      this.orbit += dt * 3.6;
      this.guardCool = Math.max(0, this.guardCool - dt);
      const g = this.guardianAt;
      for (const s of this.shots) {
        if (!s.hostile || s.dead || Math.hypot(s.x - g.x, s.y - g.y) > 20 * sc) continue;
        s.dead = true;
        this.spark(s.x, s.y, NEON.cyan);
        this.sound.play('clang');
      }
      if (this.guardCool <= 0) {
        const rammed = this.enemies.find((e) => !e.dead && Math.hypot(e.x - g.x, e.y - g.y) < (KINDS[e.kind].radius + 8) * sc);
        if (rammed) {
          this.guardCool = 0.3;
          this.damage(rammed, 2);
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
      // Against a boss the beam lands like four shots.
      for (let n = 0; n < 4; n++) {
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
      const struck = !touched && this.strikeBoss(r.x, r.y, false);
      if (touched || struck) {
        r.dead = true;
        // A rocket that reaches a boss lands like three shots.
        if (struck) for (let n = 0; n < 2; n++) this.strikeBoss(r.x, r.y, false);
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

  /** `dt` is game time; `real` is the time that actually passed, which a hit's flash is timed by. */
  private updateEnemies(dt: number, real: number): void {
    const playing = this.state === 'playing';
    const left = this.inset.left + this.margin;
    const right = this.w - this.inset.right - this.margin;
    const ship = this.ship;

    for (const e of this.enemies) {
      e.age += dt;
      e.flash = Math.max(0, e.flash - real);

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
          const speed = Math.min(560, 400 + this.wave * 14) * this.pace;
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
            const speed = Math.min(300, 210 + this.wave * 8) * this.pace;
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
      // Rocks stop every shot, piercing ones too.
      const field = this.field;
      const rock = field && this.near.find((r) => !r.dead && Math.hypot(s.x - r.x, s.y - (field.front - r.d)) < r.r + 2);
      if (rock) {
        s.dead = true;
        this.hitRock(rock, s.x, s.y);
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
    // Flying into a rock costs a point of hull. A little one breaks; a tough one does not even notice.
    if (this.field) {
      const front = this.field.front;
      for (const rock of this.near) {
        if (rock.dead || Math.hypot(rock.x - ship.x, front - rock.d - ship.y) >= rock.r * 0.9 + shipRadius) continue;
        if (!rock.tough) this.breakRock(rock);
        this.fieldHits += 1;
        this.hitShip();
        // A little longer than usual before the next rock can hurt: time to get back into the gap.
        if (this.state === 'playing') ship.invulnerable = Math.max(ship.invulnerable, 2.2);
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

  /** The colours of these things (or of the ones `keep` lets through), so each colour can be drawn in one stroke. */
  private tintsOf<T extends { color: string }>(items: readonly T[], keep?: (item: T) => boolean): Set<string> {
    this.tints.clear();
    for (const item of items) if (!keep || keep(item)) this.tints.add(item.color);
    return this.tints;
  }

  /** Small print is drawn a quarter larger on a big screen, where it would otherwise be tiny. */
  private get big(): boolean {
    return this.w >= 1000 && this.h >= 640;
  }
  private print(size: number): number {
    return this.big ? Math.round(size * 1.25) : size;
  }

  private centred(text: string, y: number, size: number, alpha = 1, color = SAND): void {
    const fitted = this.fitTo(text, size, this.room);
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
    const frame = this.intro ? { ctx, ink: this.inkFn, w, h, inset: this.inset, time: this.time, touch: this.input === 'touch' } : null;
    // From the cockpit, the sky stops at the horizon; in the hangar, it shows only through the door.
    const framed = view !== null && (view.horizon !== null || view.sky !== null);
    if (view && framed) {
      ctx.save();
      ctx.beginPath();
      if (view.sky) view.sky(ctx);
      else ctx.rect(-20, -20, w + 40, (view.horizon ?? 0) + 20);
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
    if (framed) ctx.restore();
    if (frame) this.intro?.renderGround(frame);

    // Debris fades in two steps rather than per piece, and is grouped by colour, to keep strokes batched.
    for (const color of this.tintsOf(this.debris)) {
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
        for (const p of these) traceText(ctx, STAKES[p.reward].label, p.x, p.y + (prize ? 22 : 19) * sc, this.print(7), 'center');
      }, false);
    }

    // Bombs are the opposite: red, spiked, spinning and throbbing.
    if (this.mines.length) {
      const throb = 1 + 0.16 * Math.sin(this.time * 9);
      this.ink(NEON.red, 1, 1.7, () => {
        for (const m of this.mines) trace(ctx, MINE, m.x, m.y, sc * throb, m.age * 1.4);
      });
    }

    // Asteroids: the tough ones dull, the little ones that break bright, and any that was just hit in the ship's colour.
    if (this.field && this.near.length) {
      const field = this.field;
      const front = field.front;
      // Faint arrowheads down the middle of each way through show where it goes: cool blue for the easy way,
      // hot orange for the hard one. They ride along with the rocks.
      const step = 54 * sc;
      for (const hard of [false, true]) {
        this.ink(hard ? NEON.orange : NEON.cyan, 0.6, 1.4, () => {
          for (let d = Math.max(0, Math.ceil((front - h) / step) * step); d < Math.min(front + 20, field.length); d += step) {
            const x = gapAt(field, front - d, hard);
            const ahead = gapAt(field, front - d - step, hard);
            if (x === null) continue;
            // Each one points the way the gap goes from there.
            const lean = ahead === null ? 0 : Math.atan2(ahead - x, step);
            const y = front - d;
            const arm = 7.5 * sc;
            ctx.moveTo(x + Math.sin(lean - 2.5) * arm, y - Math.cos(lean - 2.5) * arm);
            ctx.lineTo(x + Math.sin(lean) * arm * 0.4, y - Math.cos(lean) * arm * 0.4);
            ctx.lineTo(x + Math.sin(lean + 2.5) * arm, y - Math.cos(lean + 2.5) * arm);
          }
        }, false);
      }
      // Where the two first part, each is signposted with what is in it.
      for (const sign of field.signs) {
        const y = front - sign.d;
        if (y < -30 || y > h + 30) continue;
        const size = this.print(8);
        const half = textWidth('POWER-UPS', size) / 2 + 4;
        const x = clamp(sign.x, this.inset.left + half, w - this.inset.right - half);
        this.ink(sign.hard ? NEON.orange : NEON.cyan, 1, 1.3, () => {
          traceText(ctx, sign.hard ? 'HARD WAY' : 'EASY WAY', x, y - size - 3, size, 'center');
          traceText(ctx, sign.hard ? 'POWER-UPS' : 'BOMBS', x, y + 3, size, 'center');
        }, false);
      }
      const rocks = (keep: (rock: Rock) => boolean) => () => {
        for (const rock of this.near) if (!rock.dead && keep(rock)) trace(ctx, rock.shape, rock.x, front - rock.d, 1, rock.rot);
      };
      this.ink(ROCK, 1, 1.5, rocks((rock) => rock.tough && rock.flash <= 0), false);
      this.ink(PEBBLE, 1, 1.4, rocks((rock) => !rock.tough && rock.flash <= 0));
      this.ink(SAND, 1, 2, rocks((rock) => rock.flash > 0));
    }

    for (const color of ENEMY_COLORS) {
      if (!this.enemies.some((e) => e.flash <= 0 && KINDS[e.kind].color === color)) continue;
      this.ink(color, 1, 1.6, () => {
        for (const e of this.enemies) if (e.flash <= 0 && KINDS[e.kind].color === color) trace(ctx, KINDS[e.kind].shape, e.x, e.y, sc, e.rot);
      });
    }
    // Enemy shots are diamonds in the colour of whatever fired them.
    for (const color of this.tintsOf(this.shots, isHostile)) {
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
    // The spark at the heart of each one is whoever it is holding.
    if (this.enemies.length) {
      this.ink(SOUL, 0.6 + 0.3 * Math.sin(this.time * 5), 1.2, () => {
        for (const e of this.enemies) {
          ctx.moveTo(e.x + 1.3 * sc, e.y);
          ctx.arc(e.x, e.y, 1.3 * sc, 0, Math.PI * 2);
        }
      }, false);
    }
    if (this.tanker) this.renderTanker(this.tanker);

    // The ship's shots are drawn along the way they fly, so the angled wing cannons look angled.
    // (A wingmate's shots are green, so it is clear who fired what.)
    for (const color of this.tintsOf(this.shots, isOwn)) {
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
        // On a narrow screen the boss's face, in the top right corner, is in the way: the sum slides left of it.
        const half = textWidth(question, 18) / 2;
        const qy = b.y - 100 * sc;
        const face = this.faceBox;
        const beside = qy < this.inset.top + 64 + face + 6 ? w - this.inset.right - 12 - face - 10 - half : Infinity;
        const qx = Math.max(this.inset.left + 8 + half, Math.min(b.x, beside));
        this.ink(NEON.yellow, 1, 1.8, () => traceText(ctx, question, qx, qy, 18, 'center'));
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

    // The people set free wave their arms as they go.
    if (this.souls.length) {
      this.ink(SOUL, 1, 1.3, () => {
        for (const s of this.souls) {
          if (s.age < 0) continue;
          const waving = Math.floor(this.time * 7 + s.phase) % 2 === 0;
          trace(ctx, waving ? PERSON_UP : PERSON_OUT, s.x, s.y, 1.2 * sc * Math.min(1, 0.4 + s.age * 4), Math.sin(this.time * 5 + s.phase) * 0.22);
        }
      });
    }

    // The cockpit goes over the view out of it, and under the ship that rises as the cockpit drops away.
    if (frame) this.intro?.renderCockpit(frame);
    // The cut from the hangar to the cockpit is a fade through black.
    if (view && view.curtain > 0) {
      ctx.fillStyle = `rgba(3, 7, 26, ${Math.min(1, view.curtain).toFixed(3)})`;
      ctx.fillRect(-20, -20, w + 40, h + 40);
    }

    // The ship blinks while it cannot be hit, but never disappears on the paused screen.
    const blinking = this.state === 'playing' && !this.paused && !this.prompt && !this.brk && this.ship.invulnerable > 0;
    // (For people who have asked for less motion it goes faint instead of blinking.)
    const shipVisible = this.state !== 'over' && (!view || view.ship > 0) && (!blinking || this.reduceMotion || Math.floor(this.time * 14) % 2 === 0);
    if (shipVisible) {
      const s = this.shipScale;
      this.ink(SAND, blinking && this.reduceMotion ? 0.45 : 1, 1.7, () => trace(ctx, SHIP, this.ship.x, this.ship.y, s, 0));
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
    if (this.alert !== null && this.state === 'playing' && !this.paused) this.renderAlert(this.alert);
  }

  /**
   * The flight commander, large in the middle of the screen, with what they are saying underneath: first
   * the alarm, worried, and then the choice between the two ways through.
   */
  private renderAlert(age: number): void {
    const { ctx, w, h } = this;
    const t = this.time;
    const steady = this.reduceMotion;
    const fade = clamp(Math.min(age / 0.2, (ALERT_SECONDS - age) / 0.35), 0, 1);
    const alarm = age < ALERT_TURN;
    const [headline, order] = BRIEFING.asteroids;
    const [look, or, choose] = BRIEFING.choice;
    const big = this.fitTo(headline, h < 500 ? 20 : 28, this.room);
    const small = Math.min(this.fitTo(order, h < 500 ? 11 : 15, this.room), this.fitTo(look, h < 500 ? 11 : 15, this.room));
    // The screen, then the words, centred as a block a little above the middle. (It is sized for the longer
    // of the two things said, so that it does not jump when the commander moves on.)
    const box = Math.round(Math.min(w - this.inset.left - this.inset.right - 60, h * (h < 500 ? 0.36 : 0.4), 320));
    const block = box + 20 + small + 8 + small + 12 + big;
    const x = w / 2 - box / 2;
    const y = Math.max(this.inset.top + 58, Math.min(h * 0.44 - block / 2, this.homeY - 44 - block));
    const cut = box * 0.16;
    const frame = (): void => {
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
    const flash = steady || Math.floor(t * 6) % 2 === 0;
    // How far through saying the second thing: the mouth moves until it is said.
    const told = Math.floor((age - ALERT_TURN) * 46);
    const mood: Mood = alarm ? 'worried' : told < look.length + or.length + choose.length ? 'talk' : 'calm';
    // Worried: looking this way and that, and shuddering. Then steadier, looking straight at the pilot.
    const yaw = alarm ? Math.sin(t * 4.2) * 0.3 : Math.sin(t * 0.9) * 0.08;
    const pitch = 0.05 + (steady ? 0 : alarm ? Math.sin(t * 34) * 0.025 : mood === 'talk' ? Math.sin(t * 7) * 0.035 : 0);
    const cx = x + box / 2;
    const cy = y + box * 0.5;
    const size = box * 0.3;

    ctx.save();
    ctx.beginPath();
    frame();
    ctx.fillStyle = `rgba(3, 7, 26, ${(0.86 * fade).toFixed(3)})`;
    ctx.fill();
    ctx.clip();
    this.ink(NEON.cyan, 0.5 * fade, 1.2, () => traceAvatar(ctx, 'commander', 'head', cx, cy, size, yaw, pitch, mood, t), false);
    this.ink(SAND, fade, 2, () => traceAvatar(ctx, 'commander', 'face', cx, cy, size, yaw, pitch, mood, t));
    // Scan lines: it is a picture sent over the radio.
    this.ink(NEON.cyan, 0.12 * fade, 1, () => {
      for (let sy = y + ((t * 14) % 6); sy < y + box; sy += 6) {
        ctx.moveTo(x, sy);
        ctx.lineTo(x + box, sy);
      }
    }, false);
    ctx.restore();
    this.ink(alarm ? (flash ? NEON.red : NEON.yellow) : NEON.cyan, fade, 2, frame);

    // The words appear as they are spoken. Each line starts where it will end up, so it does not slide about.
    const ty = y + box + 20;
    const write = (text: string, shown: number, top: number, size: number, color: string, width: number): void => {
      const part = text.slice(0, Math.max(0, shown));
      if (part) this.ink(color, fade, width, () => traceText(ctx, part, w / 2 - textWidth(text, size) / 2, top, size));
    };
    if (alarm) {
      const said = Math.floor(age * 46);
      write(headline, said, ty, big, flash ? NEON.red : NEON.yellow, 2);
      write(order, said - headline.length, ty + big + 14, small, SAND, 1.6);
    } else {
      const last = this.fitTo(choose, big, this.room);
      write(look, told, ty, small, SAND, 1.6);
      write(or, told - look.length, ty + small + 8, small, SAND, 1.6);
      write(choose, told - look.length - or.length, ty + small + 8 + small + 12, last, NEON.yellow, 2);
    }
  }

  /** The fuel ship, its line and basket, and how the refuelling is going. */
  private renderTanker(t: Tanker): void {
    const { ctx } = this;
    const sc = this.scale;
    const env = this.tankerEnv();
    const tail = tankerTail(t, sc);
    const end = t.hooked ? { x: env.noseX, y: env.noseY } : t.drogue;
    const steady = this.reduceMotion;
    // The line is green while it is easy, yellow as it tightens and red when it is about to come off.
    const lineColor = t.strain > 0.8 ? NEON.red : t.strain > 0.5 ? NEON.yellow : NEON.lime;
    // It hangs in a lazy curve while it is slack, pulls straight as it tightens, and shivers at the end.
    const bow = (1 - t.strain) * 20 * sc * (t.hooked ? Math.sin(this.time * 2.2 + t.phases[0]) : 0.35);
    const shiver = t.strain > 0.8 && !steady ? rand(-1.5, 1.5) : 0;
    const mx = (tail.x + end.x) / 2 + bow + shiver;
    const my = (tail.y + end.y) / 2;
    const top = end.y - 5 * sc;
    this.ink(lineColor, 1, 1.5, () => {
      ctx.moveTo(tail.x, tail.y);
      ctx.quadraticCurveTo(mx, my, end.x, top);
      trace(ctx, DROGUE, end.x, end.y, sc, 0);
    });
    if (t.hooked) {
      // Fuel on its way down the line.
      this.ink(SAND, 1, 1.3, () => {
        for (let i = 0; i < 4; i++) {
          const u = (this.time * 1.1 + i / 4) % 1;
          const x = (1 - u) * (1 - u) * tail.x + 2 * (1 - u) * u * mx + u * u * end.x;
          const y = (1 - u) * (1 - u) * tail.y + 2 * (1 - u) * u * my + u * u * top;
          const r = 2.2 * sc;
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
        }
      }, false);
    }

    // It flickers when it is about to give up waiting.
    const impatient = t.state === 'station' && !t.hooked && t.patience < 3;
    const faint = impatient && (steady || Math.floor(this.time * 6) % 2 === 0);
    const big = sc * TANKER_SIZE;
    this.ink(NEON.lime, faint ? 0.45 : 1, 1.7, () => trace(ctx, TANKER, t.x, t.y, big, 0));
    this.ink(PINK, 1, 1.4, () => {
      for (const side of [-1, 1]) {
        const x = t.x + side * 14.5 * big;
        const y = t.y + 21.5 * big;
        ctx.moveTo(x - 3 * big, y);
        ctx.lineTo(x, y + rand(6, 12) * big);
        ctx.lineTo(x + 3 * big, y);
      }
    });

    if (this.state !== 'playing') return;
    // How full the tank is: a ring round the ship that closes as the fuel goes in.
    if (t.fuel > 0) {
      const r = 27 * this.shipScale;
      const { x, y } = this.ship;
      this.ink(NEON.lime, 0.22, 1.2, () => {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }, false);
      this.ink(NEON.lime, 1, 2, () => {
        ctx.moveTo(x, y - r);
        ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t.fuel);
      });
      this.ink(NEON.lime, 0.9, 1.2, () => traceText(ctx, `FUEL ${percent(t.fuel)}%`, x, y + r + 6, this.print(8), 'center'), false);
    }
    // By the basket: what to do, or what just went wrong.
    if (t.state === 'station' && !t.hooked) {
      const lost = t.why !== null && t.whyAge < 1.1;
      const label = lost ? (t.why === 'close' ? 'TOO CLOSE!' : 'TOO FAR!') : t.fuel > 0 ? 'HOOK ON AGAIN' : 'HOOK ON HERE';
      const alpha = lost || steady ? 1 : 0.6 + 0.35 * Math.sin(this.time * 6);
      this.ink(lost ? NEON.red : NEON.lime, alpha, 1.2, () => traceText(ctx, label, t.drogue.x, t.drogue.y + 9 * sc, this.print(8), 'center'), false);
    }
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
    const line = this.scoreLine;
    this.ink(SAND, 1, 1.4, () => {
      traceText(ctx, line.text, line.x, line.y, line.size);
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

    // After the score: how many people have been set free. The little figure jumps as each one arrives.
    const at = this.freedAt;
    const jump = this.reduceMotion ? 0 : this.freedPulse / 0.3;
    this.ink(SOUL, 1, 1.2, () => {
      trace(ctx, jump > 0 ? PERSON_UP : PERSON_OUT, at.x, at.y + 1 - jump * 2, (line.size / 17) * (1 + jump * 0.25), 0);
      traceText(ctx, String(this.freed), at.x + line.size * 0.62, line.y, line.size);
    });

    // Energy gauge: ten ticks. The taller ones are the half that buys the third cannon.
    // It sits beside the hull, or beside the wave number where there is less room.
    const gauge = small ? x0 + textWidth(waveText, waveSize) + 10 : x0 + this.maxHull * hullGap + 8;
    const foot = small ? waveY + waveSize : hullY + 6;
    const step = small ? 4 : 5;
    if (this.jam > 0) {
      if (this.reduceMotion || this.time % 0.5 < 0.32) this.ink(PINK, 1, 1.3, () => traceText(ctx, 'JAMMED', gauge, foot - waveSize, waveSize));
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
    // On a phone they are drawn smaller and closer together, to leave room beside them for the boss's health.
    const iconStep = small ? 14 : 18;
    const iconsEnd = this.upgrades.size ? left + 8 + (this.upgrades.size - 1) * iconStep + 7 : left;
    if (this.upgrades.size) {
      this.ink(NEON.lime, 0.85, 1.1, () => {
        let i = 0;
        for (const u of UPGRADES) if (this.upgrades.has(u.id)) trace(ctx, u.icon, left + 8 + i++ * iconStep, top + box + (small ? 12 : 14), small ? 0.45 : 0.55, 0);
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
      const length = Math.min(150, room, small ? Math.max(48, edge - iconsEnd - 10) : Infinity, this.h < 500 ? SHORT_TAUNT : Infinity);
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
      const size = this.fitTo(v.line, small ? 9 : 11, this.h < 500 ? SHORT_TAUNT : room);
      const alpha = Math.min(1, (v.lineUntil - this.time) / 0.3);
      // (A line lower on a phone, so a long taunt runs under the upgrade icons and not through them.)
      this.ink(NEON.yellow, alpha, 1.5, () => traceText(ctx, v.line, edge, by + (small ? 24 : 17), size, 'right'));
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
      const flash = this.reduceMotion || Math.floor(this.time * 7) % 2 === 0;
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
      const color = this.reduceMotion ? NEON.yellow : NEON_LIST[Math.floor(this.time * 10) % NEON_LIST.length]!;
      const alpha = Math.min(1, this.intermission / 0.4);
      this.centred(this.bossNote, mid, 26, alpha, color);
      if (this.bossFreed) this.centred(`${this.bossFreed} PEOPLE SET FREE`, mid + 48, 13, alpha, SOUL);
      return;
    }

    // The fuel ship is announced below where the ship will be flying, and so is how the refuelling went.
    if (this.state === 'playing') {
      const t = this.tanker;
      const low = Math.min(this.h * 0.58, this.homeY - 96);
      if (t && t.fuel === 0 && !t.hooked && t.age < 3.2 && t.state !== 'leaving') {
        const alpha = Math.min(1, t.age / 0.3, (3.2 - t.age) / 0.4);
        this.centred('FUEL SHIP', low, 22, alpha, NEON.lime);
        this.centred('FLY IN BEHIND IT AND CATCH THE FUEL LINE', low + 40, 11, alpha * 0.9);
        this.centred(`STAY HOOKED ON FOR ${FUEL_SECONDS} SECONDS`, low + 62, 11, alpha * 0.9);
        return;
      }
      if (this.fuelNote.until > this.time) {
        this.centred(this.fuelNote.text, low, 16, Math.min(1, (this.fuelNote.until - this.time) / 0.4), this.fuelNote.color);
        return;
      }
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
      const freed = this.freed + this.souls.length;
      this.centred(freed === 1 ? 'YOU SET 1 PERSON FREE' : `YOU SET ${freed} PEOPLE FREE`, mid + 86, 11, alpha, SOUL);
      if (this.stateTime > 0.9 && blink) {
        this.centred(this.coarse ? 'TAP TO RETRY' : 'PRESS SPACE TO RETRY - ESC TO EXIT', mid + 122, 11, 0.9);
      }
    }
  }

  // -------------------------------------------------------- question render

  /** Top of the question panel. A break sits mid-screen; a capsule's question sits higher, clear of the ship. */
  private get challengeTop(): number {
    const usual = this.brk ? this.h * 0.42 - 44 : Math.max(this.inset.top + 96, this.h * 0.2);
    // On a very short screen the whole question moves up, so that its last line stays clear of the ship.
    return Math.max(this.inset.top + 40, Math.min(usual, this.homeY - 196));
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
    const rowHeight = this.h < 480 ? 44 : this.big ? 64 : 54;
    const w = Math.min(this.room, 420);
    return Array.from({ length: count }, (_, i) => ({ x: this.w / 2 - w / 2, y: this.challengeTop + 26 + i * (rowHeight + 8), w, h: rowHeight }));
  }

  private renderOffer(offer: Upgrade[], age: number): void {
    const { ctx } = this;
    const alpha = Math.min(1, age / 0.3);
    const boxes = this.offerBoxes(offer.length);
    this.centred('CORRECT - CHOOSE AN UPGRADE', this.challengeTop, this.print(11), alpha, NEON.lime);
    boxes.forEach((b, i) => {
      const u = offer[i]!;
      const textX = b.x + b.h + 10;
      const room = b.w - b.h - 22;
      const nameSize = this.fitTo(u.name, this.print(12), room);
      this.ink(SAND, alpha * 0.9, 1.4, () => ctx.rect(b.x, b.y, b.w, b.h));
      this.ink(NEON.lime, alpha, 1.6, () => {
        trace(ctx, u.icon, b.x + 4 + b.h / 2, b.y + b.h / 2, b.h / 40, 0);
        traceText(ctx, u.name, textX, b.y + b.h / 2 - nameSize - 2, nameSize);
      });
      this.ink(SAND, alpha * 0.8, 1.1, () => traceText(ctx, u.blurb, textX, b.y + b.h / 2 + 6, this.fitTo(u.blurb, this.print(8), room)), false);
      // The number key that picks this one, for players at a keyboard.
      if (this.input === 'keys') this.ink(SAND, alpha * 0.55, 1, () => traceText(ctx, String(i + 1), b.x + b.w - 8, b.y + 6, this.print(7), 'right'), false);
    });
    const last = boxes[boxes.length - 1];
    if (last) this.centred(this.input === 'keys' ? 'CLICK ONE OR PRESS ITS NUMBER' : 'TAP ONE', last.y + last.h + 12, this.print(8), alpha * 0.6);
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
    this.centred(title, top, this.print(11), alpha * (titleColor === SAND ? 0.8 : 1), titleColor);

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
          if (!done && this.input === 'keys') this.ink(SAND, a * 0.55, 1, () => traceText(ctx, String(i + 1), b.x + 6, b.y + 6, this.print(7)), false);
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
      this.centred(said, hintY, this.print(10), 1, o.success ? PINK : SAND);
    } else if (c.kind !== 'line') {
      const again = c.kind === 'entry' && c.misses > 0;
      const how = again ? 'NOT QUITE - ONE MORE TRY' : c.kind === 'entry' ? 'TYPE THE ANSWER' : this.input === 'keys' ? 'CLICK AN ANSWER OR PRESS ITS NUMBER' : 'TAP THE ANSWER';
      this.centred(how, hintY, this.print(again ? 10 : 8), alpha * (again ? 1 : 0.6), again ? NEON.red : SAND);
    }
  }

  private renderLine(c: LineChallenge, y: number, alpha: number): void {
    const { ctx } = this;
    const wrong = c.error > 0;
    // The line is laid out once, so typed and untyped letters keep their places as the colour moves across.
    const size = this.fitTo(c.text, 20, this.room);
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
    if (!c.outcome) this.centred(`ACCURACY ${pressed ? percent(c.index / pressed) : 100}%`, y + size + 46, this.print(9), alpha * 0.7);
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
