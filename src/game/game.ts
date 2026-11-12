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
 * - Two wireframe faces watch from the top corners: the pilot's, and the boss's (see avatar.ts & hud.ts).
 * - Sound effects are synthesised (see sound.ts); the overlay's Sound button switches them off.
 * - Every enemy ship holds somebody prisoner. Destroying it sets them free, and they fly up to be counted;
 *   a beaten boss lets out a whole crowd.
 * - About a third of the way through each wave a fuel ship arrives (see tanker.ts): hook on to its fuel line and stay on.
 * - Later in the wave the flight commander bursts in with a warning, and an asteroid field follows
 *   (see asteroids.ts): two winding ways through, an easy one with bombs in it and a hard one with power-ups.
 * - Behind it all, low-poly planets, moons and rocks drift by at different depths (see backdrop.ts).
 * - It opens in the cockpit: a briefing from the flight commander, then a take-off that hands over to
 *   the top-down view (see intro.ts).
 *
 * Core math/colours live in core.ts; enemies in enemies.ts; weapons/projectiles in weapons.ts; HUD/panels in hud.ts.
 */
import { createField, gapAt, updateField, type Field, type FieldEnv, type Rock } from './asteroids';
import type { Mood } from './avatar';
import { Backdrop } from './backdrop';
import { bossParts, createBoss, shootBoss, tapBoss, touchesBoss, updateBoss, type Boss, type BossEnv, type Hit } from './boss';
import {
  accepts, choiceChallenge, choose, entryChallenge, lineChallenge, press, tick,
  type Challenge, type ChoiceChallenge,
} from './challenge';
import { NEON, PEBBLE, PINK, ROCK, SAND, clamp, percent, pick, rand, strokeInk, type Ink } from './core';
import { KINDS, buildWavePlan, renderEnemies, spawnEnemy, spawnX, splitShards, updateEnemies, type Enemy, type Spawn } from './enemies';
import { textWidth, traceText } from './font';
import {
  ALERT_LEAD, ALERT_SECONDS, ALERT_TURN, BOSS_CORNER, STAKES,
  challengeTopY, faceBoxSize, freedCounterPos, freshVillain, offerBoxes, optionBoxes, printSize,
  renderAlert, renderHud, renderMessages, renderTanker,
  type Banner, type Box, type Break, type HudViewContext, type Prompt, type Reward, type Stake,
} from './hud';
import { Intro, type IntroCue, type IntroView } from './intro';
import { BRIEFING, LINES, TAUNTS, WORDS, type Taunt } from './lines';
import { makeProblem } from './maths';
import { CAPSULE, FRIEND, MINE, SHIP, trace, type Shape } from './shapes';
import { Sound, type Sfx } from './sound';
import { FUEL_SECONDS, createTanker, dismissTanker, updateTanker, type Tanker, type TankerEnv } from './tanker';
import { UPGRADES, offerUpgrades, type UpgradeId } from './upgrades';
import {
  LANCE_SECONDS, NOVA_SECONDS, ORBIT, ROCKET_SECONDS, SHIELD_SECONDS, TRIPLE_AT, WING,
  burstShape, fireVolley, freeSouls, isHostile, isOwn, renderDebris, renderHostileShots,
  renderOwnShotsAndWeapons, renderRingsAndSouls, sparkAt, updateRockets, updateSouls,
  type Beam, type Debris, type Ring, type Rocket, type Shot, type Soul,
} from './weapons';

/** Points for filling the tank from the fuel ship. */
const FULL_TANK_POINTS = 400;
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

const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'Space', 'Enter', 'KeyP',
]);

/** Keys that would scroll the page behind the game; swallowed while it is open. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End']);

type State = 'ready' | 'playing' | 'over';

interface Star { x: number; y: number; speed: number; streak: boolean; tier: number }
/** A boost capsule drifting down the screen. Flying into it asks a question. */
interface Pickup {
  reward: Reward; x: number; y: number; anchorX: number; phase: number; age: number; dead: boolean;
  /** A power-up in an asteroid field: it falls at this speed, in step with the rocks, and does not sway. */
  ride?: number;
}
/** A hazard bomb. One thrown by a boss drifts after the ship. */
interface Mine {
  x: number; y: number; anchorX: number; phase: number; age: number; dead: boolean; thrown: boolean;
  /** A bomb in an asteroid field: it falls at this speed, in step with the rocks, and does not sway. */
  ride?: number;
}

export interface GameOptions {
  /** Called when the player asks to leave (Esc). */
  onExit: () => void;
  /** Short status messages for a screen-reader live region. */
  onStatus?: (message: string) => void;
  /** Called whenever the game is paused or resumed, however that happened, so a Pause button can keep in step. */
  onPause?: (paused: boolean) => void;
}

/** What a shot landing on each part of a boss sounds like. */
const BOSS_SOUNDS: Record<Exclude<Hit, 'miss'>, Sfx> = {
  blocked: 'clang', core: 'core', down: 'bossDown', arm: 'hit', armOff: 'armOff', lock: 'lock', right: 'right', wrong: 'wrong',
};

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
  private readonly ink: Ink = (color, alpha, width, build, glow = true) => strokeInk(this.ctx, color, alpha, width, build, glow);
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
    document.addEventListener('visibilitychange', this.onVisibility);
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
      const top = challengeTopY(this.h, this.inset.top, this.homeY, Boolean(this.brk));
      const offered = offer ? this.boxAt(e, offerBoxes(this.w, this.h, this.room, top, offer.length)) : null;
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
    const top = challengeTopY(this.h, this.inset.top, this.homeY, Boolean(this.brk));
    return this.boxAt(e, optionBoxes(this.w, this.room, c.options.length, top));
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
    const plan = buildWavePlan(n, this.w, this.inset, this.scale, this.margin, this.upgrades.size < UPGRADES.length);
    this.queue = plan.queue;
    this.pickupTimes = plan.pickupTimes;
    this.upgradeTimes = plan.upgradeTimes;
    this.mineTimes = plan.mineTimes;
    this.stops = plan.stops;
    this.sound.play('wave');
    this.opts.onStatus?.(`Wave ${n}.`);
  }

  private spawn(sp: Spawn): void {
    this.enemies.push(spawnEnemy(sp, this.wave, this.w, this.h, this.inset.top, this.scale, this.pace));
  }

  /** What an ordinary capsule holds: whatever helps most. Repairs when the hull is hurt, blasts once the waves get busy. */
  private pickReward(): Reward {
    const pool: Reward[] = ['energy'];
    if (this.hull < this.maxHull) pool.push('hull', 'hull');
    if (this.wave >= 2) pool.push('blast');
    return pick(pool);
  }

  private spawnPickup(reward?: Reward): void {
    const x = spawnX(this.w, this.inset, this.scale);
    this.pickups.push({ reward: reward ?? this.pickReward(), x, y: -24, anchorX: x, phase: rand(0, Math.PI * 2), age: 0, dead: false });
  }

  private spawnMine(): void {
    const x = spawnX(this.w, this.inset, this.scale);
    this.mines.push({ x, y: -24, anchorX: x, phase: rand(0, Math.PI * 2), age: 0, dead: false, thrown: false });
  }

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
    this.freed += freeSouls(this.souls, this.rings, x, y, this.scale, count);
  }

  private updateSoulsOnScreen(dt: number): void {
    this.freedPulse = Math.max(0, this.freedPulse - dt);
    const home = freedCounterPos(this.w, this.h, this.inset.left, this.inset.top, this.score);
    const arrived = updateSouls(this.souls, dt, home, this.scale);
    if (arrived > 0) {
      this.freed += arrived;
      this.freedPulse = 0.3;
      this.sound.play('free');
    }
    if (this.souls.length) this.souls = this.souls.filter((s) => !s.dead);
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
      this.enemies.push(...splitShards(e, this.scale, this.pace));
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
    sparkAt(this.debris, x, y, color);
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
    burstShape(this.debris, shape, x, y, scale, rot, color);
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
    this.timeScale += ((this.asking ? SLOW_MOTION : 1) - this.timeScale) * (1 - Math.exp(-dt * 9));
    const sim = dt * this.timeScale;
    this.banner = Math.max(0, this.banner - sim);

    if (this.intro) {
      this.intro.update(dt, this.input === 'touch');
      if (this.intro.done) {
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
      const flying = this.state === 'playing' && !this.brk;
      const targetWarp = flying ? 3.2 : this.state === 'over' ? 0.6 : 1;
      this.warp += (targetWarp - this.warp) * (1 - Math.exp(-dt * 1.8));
      for (const star of this.stars) {
        star.y += star.speed * this.warp * sim;
        if (star.y > this.h + 80) Object.assign(star, this.makeStar(-rand(10, 80)));
      }
      this.backdrop.update(sim, this.warp);
    }
    const across = this.reduceMotion ? 0 : clamp(this.ship.x / (this.w || 1) - 0.5, -0.5, 0.5);
    this.drift += (across - this.drift) * (1 - Math.exp(-dt * 3));

    for (const d of this.debris) {
      d.age += sim;
      d.x += d.vx * sim;
      d.y += d.vy * sim;
      d.rot += d.spin * sim;
    }
    this.debris = this.debris.filter((d) => d.age < d.ttl);
    for (const beam of this.beams) beam.age += dt;
    if (this.beams.length) this.beams = this.beams.filter((b) => b.age < 0.22);
    for (const ring of this.rings) ring.age += dt;
    this.rings = this.rings.filter((ring) => ring.age < 0.7);
    if (this.boss && this.state !== 'playing') this.updateBossFight(sim, dt);
    if (this.tanker && this.state !== 'playing') this.flyTanker(sim);
    if (this.field && this.state !== 'playing') this.flyField(sim, dt);
    this.updateSoulsOnScreen(sim);

    this.updateShip(sim);
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
    updateEnemies(this.enemies, sim, dt, {
      playing: this.state === 'playing',
      wave: this.wave,
      w: this.w,
      h: this.h,
      left: this.inset.left + this.margin,
      right: this.w - this.inset.right - this.margin,
      scale: this.scale,
      pace: this.pace,
      shipX: this.ship.x,
      shipY: this.ship.y,
      fireShot: (x, y, vx, vy, color) => {
        this.shots.push({ x, y, vx, vy, hostile: true, dead: false, color });
        this.sound.play('enemyShot');
      },
    });
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
      const risen = this.view?.ship ?? 1;
      ship.x = this.homeX;
      ship.y = this.homeY + (1 - risen) * (this.h - this.homeY + 80);
      return;
    }
    if (this.brk) {
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

    if ((keys.has('Space') || this.touchId !== null) && ship.cooldown <= 0 && this.jam <= 0 && !this.asking && !this.tanker?.hooked) {
      ship.cooldown = this.upgrades.has('rapid') ? 0.11 : 0.17;
      this.volley += 1;
      this.sound.play('shot');
      fireVolley(this.shots, ship.x, ship.y, this.energy, this.volley, this.scale, this.pace, Boolean(this.boss), this.upgrades);
    }
    if (this.enemies.length || this.boss?.state === 'fight') this.energy = Math.max(0, this.energy - dt / ENERGY_SECONDS);
  }

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
          const angle = rand(0, Math.PI * 2);
          const far = rand(0.03, 0.3) * Math.min(w, h);
          star.x = view.vanish.x + Math.cos(angle) * far;
          star.y = view.vanish.y + Math.sin(angle) * far * 0.8;
        }
      }
    }
  }

  private updateWave(dt: number, real: number): void {
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
    const hurry = this.boss ? 1.2 : !this.queue.length && !this.enemies.length ? 3 : 1;
    const reach = (10 + 9) * this.scale;
    for (const m of this.mines) {
      m.age += dt;
      m.y += (m.ride ?? 74 * this.pace * hurry) * dt;
      if (m.thrown) m.anchorX += clamp(this.ship.x - m.anchorX, -1, 1) * 30 * this.scale * dt;
      m.x = m.ride !== undefined ? m.anchorX : m.anchorX + Math.sin(m.age * 0.9 + m.phase) * (m.thrown ? 12 : 34) * this.scale;
      if (m.y > this.h + 40) m.dead = true;
      else if (this.state === 'playing' && !this.prompt && this.ship.invulnerable <= 0 && Math.hypot(m.x - this.ship.x, m.y - this.ship.y) < reach) {
        m.dead = true;
        this.startPrompt('defuse');
      }
    }
  }

  private updatePickups(dt: number): void {
    const hurry = !this.queue.length && !this.enemies.length ? 3 : 1;
    const reach = (13 + 9) * this.scale;
    for (const p of this.pickups) {
      if (p.ride !== undefined) {
        p.age += dt;
        p.y += p.ride * dt;
      } else if (!this.prompt) {
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

    this.rockets = updateRockets(this.rockets, dt, {
      enemies: this.enemies,
      bossTarget: this.boss?.state === 'fight' ? { x: this.boss.x, y: this.boss.y } : null,
      scale: sc,
      pace: this.pace,
      w: this.w,
      h: this.h,
      strikeBoss: (x, y, aimed) => this.strikeBoss(x, y, aimed),
      damageEnemy: (e, amount) => this.damage(e, amount),
      onBlast: (x, y, reach) => {
        this.rings.push({ x, y, age: 0, color: NEON.orange, reach });
        this.sound.play('boom');
      },
    });

    if (this.asking || !(this.enemies.length > 0 || this.boss?.state === 'fight')) return;

    if (has('lance') && (this.lanceIn -= dt) <= 0) {
      this.lanceIn = LANCE_SECONDS;
      const x = ship.x;
      this.beams.push({ x, y: ship.y - 18 * sc, age: 0 });
      this.sound.play('beam');
      for (const e of this.enemies) if (e.y < ship.y && Math.abs(e.x - x) < (KINDS[e.kind].radius + 7) * sc) this.damage(e, 2);
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
      const reach = 210 * sc;
      this.rings.push({ x: ship.x, y: ship.y, age: 0, color: NEON.cyan, reach });
      this.sound.play('nova');
      for (const s of this.shots) if (s.hostile && Math.hypot(s.x - ship.x, s.y - ship.y) < reach) s.dead = true;
      for (const e of this.enemies) if (Math.hypot(e.x - ship.x, e.y - ship.y) < reach) this.damage(e, 1);
    }
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
      if (this.strikeBoss(s.x, s.y, !s.stray && this.input !== 'touch')) {
        s.dead = true;
        continue;
      }
      const mine = this.mines.find((m) => Math.hypot(s.x - m.x, s.y - m.y) < 11 * this.scale);
      if (mine) {
        s.dead = true;
        this.spark(s.x, s.y, NEON.red);
        this.sound.play('clang');
        continue;
      }
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
    if (this.field) {
      const front = this.field.front;
      for (const rock of this.near) {
        if (rock.dead || Math.hypot(rock.x - ship.x, front - rock.d - ship.y) >= rock.r * 0.9 + shipRadius) continue;
        if (!rock.tough) this.breakRock(rock);
        this.fieldHits += 1;
        this.hitShip();
        if (this.state === 'playing') ship.invulnerable = Math.max(ship.invulnerable, 2.2);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- render

  /** The colours of these things (or of the ones `keep` lets through), so each colour can be drawn in one stroke. */
  private tintsOf<T extends { color: string }>(items: readonly T[], keep?: (item: T) => boolean): Set<string> {
    this.tints.clear();
    for (const item of items) if (!keep || keep(item)) this.tints.add(item.color);
    return this.tints;
  }

  private hudContext(): HudViewContext {
    return {
      ctx: this.ctx,
      ink: this.ink,
      w: this.w,
      h: this.h,
      scale: this.scale,
      shipScale: this.shipScale,
      inset: this.inset,
      room: this.room,
      homeY: this.homeY,
      time: this.time,
      reduceMotion: this.reduceMotion,
      coarse: this.coarse,
      input: this.input,
      state: this.state,
      stateTime: this.stateTime,
      paused: this.paused,
      shipX: this.ship.x,
      shipY: this.ship.y,
      lean: this.lean,
      hull: this.hull,
      maxHull: this.maxHull,
      energy: this.energy,
      jam: this.jam,
      score: this.score,
      best: this.best,
      newBest: this.newBest,
      wave: this.wave,
      banner: this.banner,
      freed: this.freed,
      freedPulse: this.freedPulse,
      soulsInFlight: this.souls.length,
      bossFreed: this.bossFreed,
      bossNote: this.bossNote,
      intermission: this.intermission,
      fuelNote: this.fuelNote,
      upgrades: this.upgrades,
      boss: this.boss,
      tanker: this.tanker,
      brk: this.brk,
      prompt: this.prompt,
      pilotMood: this.pilotMood,
      villainMood: this.villainMood,
      villain: this.villain,
    };
  }

  private render(): void {
    const { ctx, w, h } = this;
    const sc = this.scale;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    const view = this.view;
    const shake = Math.max(this.shake, view?.shake ?? 0);
    if (shake > 0) ctx.translate(rand(-1, 1) * shake * 14, rand(-1, 1) * shake * 14);
    const frame = this.intro ? { ctx, ink: this.ink, w, h, inset: this.inset, time: this.time, touch: this.input === 'touch' } : null;
    const framed = view !== null && (view.horizon !== null || view.sky !== null);
    if (view && framed) {
      ctx.save();
      ctx.beginPath();
      if (view.sky) view.sky(ctx);
      else ctx.rect(-20, -20, w + 40, (view.horizon ?? 0) + 20);
      ctx.clip();
    }

    const shift = -this.drift * w * PARALLAX;
    const starX = (star: Star): number => {
      const x = (star.x + (shift * star.speed) / 420) % w;
      return x < 0 ? x + w : x;
    };
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

    for (let tier = 0; tier < 3; tier++) {
      this.ink(SAND, [0.22, 0.45, 0.8][tier]!, 1.2, () => {
        for (const star of this.stars) {
          if (star.streak || star.tier !== tier) continue;
          streak(starX(star), starY(star), Math.max(0.6, star.speed * pace * 0.02 * stretch));
        }
      }, false);
    }
    this.backdrop.render(ctx, shift, lift);
    const streakColors = this.boss ? [NEON.cyan, NEON.violet, NEON.lime] : [SAND];
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

    renderDebris(ctx, this.ink, this.debris, this.tintsOf(this.debris));

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
        for (const p of these) traceText(ctx, STAKES[p.reward].label, p.x, p.y + (prize ? 22 : 19) * sc, printSize(7, w, h), 'center');
      }, false);
    }

    if (this.mines.length) {
      const throb = 1 + 0.16 * Math.sin(this.time * 9);
      this.ink(NEON.red, 1, 1.7, () => {
        for (const m of this.mines) trace(ctx, MINE, m.x, m.y, sc * throb, m.age * 1.4);
      });
    }

    if (this.field && this.near.length) {
      const field = this.field;
      const front = field.front;
      const step = 54 * sc;
      for (const hard of [false, true]) {
        this.ink(hard ? NEON.orange : NEON.cyan, 0.6, 1.4, () => {
          for (let d = Math.max(0, Math.ceil((front - h) / step) * step); d < Math.min(front + 20, field.length); d += step) {
            const x = gapAt(field, front - d, hard);
            const ahead = gapAt(field, front - d - step, hard);
            if (x === null) continue;
            const lean = ahead === null ? 0 : Math.atan2(ahead - x, step);
            const y = front - d;
            const arm = 7.5 * sc;
            ctx.moveTo(x + Math.sin(lean - 2.5) * arm, y - Math.cos(lean - 2.5) * arm);
            ctx.lineTo(x + Math.sin(lean) * arm * 0.4, y - Math.cos(lean) * arm * 0.4);
            ctx.lineTo(x + Math.sin(lean + 2.5) * arm, y - Math.cos(lean + 2.5) * arm);
          }
        }, false);
      }
      for (const sign of field.signs) {
        const y = front - sign.d;
        if (y < -30 || y > h + 30) continue;
        const size = printSize(8, w, h);
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

    renderEnemies(ctx, this.ink, this.enemies, sc, this.time);
    renderHostileShots(ctx, this.ink, this.shots, this.tintsOf(this.shots, isHostile), sc);

    const hudCtx = this.hudContext();
    if (this.tanker) renderTanker(hudCtx, this.tanker, this.tankerEnv());

    renderOwnShotsAndWeapons(ctx, this.ink, this.shots, this.tintsOf(this.shots, isOwn), this.rockets, this.beams, sc);

    if (this.boss) {
      const b = this.boss;
      for (const part of bossParts(b, this.bossEnv(), this.time)) {
        this.ink(part.color, part.alpha, part.width, () => trace(ctx, part.shape, part.x, part.y, part.scale, part.rot));
        const label = part.label;
        if (label) this.ink(part.color, part.alpha, 1.6, () => traceText(ctx, label, part.x, part.y - 0.28 * 18 * part.scale, 0.56 * 18 * part.scale, 'center'), false);
      }
      if (b.problem && b.pods.length) {
        const question = `${b.problem.question} = ?`;
        const half = textWidth(question, 18) / 2;
        const qy = b.y - 100 * sc;
        const face = faceBoxSize(w, h);
        const beside = qy < this.inset.top + 64 + face + 6 ? w - this.inset.right - 12 - face - 10 - half : Infinity;
        const qx = Math.max(this.inset.left + 8 + half, Math.min(b.x, beside));
        this.ink(NEON.yellow, 1, 1.8, () => traceText(ctx, question, qx, qy, 18, 'center'));
        if (this.input === 'touch') {
          const x = clamp(b.x, this.inset.left + 70, w - this.inset.right - 70);
          this.ink(NEON.yellow, 0.6 + 0.3 * Math.sin(this.time * 6), 1.2, () => traceText(ctx, 'TAP THE ANSWER', x, b.y + 150 * sc, 9, 'center'), false);
        }
      }
    }

    renderRingsAndSouls(ctx, this.ink, this.rings, this.souls, w, h, sc, this.time);

    if (frame) this.intro?.renderCockpit(frame);
    if (view && view.curtain > 0) {
      ctx.fillStyle = `rgba(3, 7, 26, ${Math.min(1, view.curtain).toFixed(3)})`;
      ctx.fillRect(-20, -20, w + 40, h + 40);
    }

    const blinking = this.state === 'playing' && !this.paused && !this.prompt && !this.brk && this.ship.invulnerable > 0;
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
      if (this.prompt) this.ink(SAND, 0.5, 1.2, () => trace(ctx, CAPSULE, this.ship.x, this.ship.y, 2.1 * s, this.time * 0.5), false);

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
        this.ink(NEON.cyan, 1, 1.4, () => trace(ctx, FRIEND, g.x, g.y, 0.45 * s, this.orbit + Math.PI));
      }
    }
    ctx.restore();

    if (this.timeScale < 0.99) {
      ctx.fillStyle = `rgba(3, 7, 26, ${(0.5 * (1 - this.timeScale)).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (this.state !== 'ready') renderHud(hudCtx);
    renderMessages(hudCtx);
    if (this.alert !== null && this.state === 'playing' && !this.paused) renderAlert(hudCtx, this.alert);
  }
}
