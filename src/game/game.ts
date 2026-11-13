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
 * - Sound effects are synthesised (see sound.ts), and the commander, the boss and the pilot say their lines
 *   out loud in the browser's own voices (see voice.ts); the overlay's Sound button switches both off.
 * - Every enemy ship holds somebody prisoner. Destroying it sets them free, and they fly up to be counted;
 *   a beaten boss lets out a whole crowd.
 * - About a third of the way through each wave a fuel ship arrives (see tanker.ts): hook on to its fuel line and stay on.
 * - Later in the wave the flight commander bursts in with a warning, and an asteroid field follows
 *   (see asteroids.ts): two winding ways through, an easy one with bombs in it and a hard one with power-ups.
 * - Behind it all, low-poly planets, moons and rocks drift by at different depths (see backdrop.ts).
 * - It opens in the cockpit: a briefing from the flight commander, then a take-off that hands over to
 *   the top-down view (see intro.ts).
 *
 * This file is the conductor: the loop, the ship, collisions and the order things are drawn in. Core maths and
 * colours are in core.ts, enemies in enemies.ts, weapons in weapons.ts, the HUD and panels in hud.ts, the fuel
 * ship and asteroid field's running order in setpieces.ts, the questions in questions.ts, keys and touch in input.ts.
 */
import { gapAt, type Rock } from './asteroids';
import type { Mood } from './avatar';
import { Backdrop } from './backdrop';
import { bossParts, createBoss, shootBoss, tapBoss, touchesBoss, updateBoss, type Boss, type BossEnv, type Hit } from './boss';
import { choose } from './challenge';
import type { CoopFlightDirector, CoopWorldAdapter } from './coop-flight';
import { NEON, PEBBLE, PINK, ROCK, SAND, clamp, pick, rand, strokeInk, type Ink } from './core';
import { KINDS, buildWavePlan, renderEnemies, spawnEnemy, spawnX, splitShards, updateEnemies, type Enemy, type Spawn } from './enemies';
import { Fireworks, renderFireworks, type Grade } from './fireworks';
import { textWidth, traceText } from './font';
import {
  BOSS_CORNER,
  challengeTopY, faceBoxSize, freedCounterPos, freshVillain, offerBoxes, optionBoxes, printSize,
  renderAlert, renderHud, renderMessages, renderTanker,
  type HudViewContext,
} from './hud';
import { Input, boxAt } from './input';
import { Intro, type IntroCue, type IntroView } from './intro';
import { TAUNTS, type Taunt } from './lines';
import { makeProblem } from './maths';
import { MultiplayerClient, renderWingmen } from './multiplayer';
import { GRADE_BANDS, Questions, STAKES, sumLevel, type GradeBand, type QuestionEnv, type Reward } from './questions';
import { SetPieces, type SetPieceEnv } from './setpieces';
import { CAPSULE, FRIEND, MINE, SHIP, trace, type Shape } from './shapes';
import { Sound, type Sfx } from './sound';
import { UPGRADES, type UpgradeId } from './upgrades';
import { Voice } from './voice';
import {
  LANCE_SECONDS, NOVA_SECONDS, ORBIT, ROCKET_SECONDS, SHIELD_SECONDS, WING,
  burstShape, fireVolley, freeSouls, isHostile, isOwn, renderDebris, renderHostileShots,
  renderOwnShotsAndWeapons, renderRingsAndSouls, sparkAt, updateRockets, updateSouls,
  type Beam, type Debris, type Ring, type Rocket, type Shot, type Soul,
} from './weapons';

/** How far the scenery slides when the ship crosses the whole screen, as a share of the screen's width. */
const PARALLAX = 0.3;
const BEST_KEY = 'gg-arcade-best';
const MAX_HULL = 3;
/** Seconds a full energy gauge lasts. */
const ENERGY_SECONDS = 18;
/** How slowly the game runs while a capsule's question waits for its answer. */
const SLOW_MOTION = 0.06;
const COOP_ARENA_W = 768;
const COOP_ARENA_H = 1024;

type State = 'ready' | 'playing' | 'over';

/**
 * The school years the player picked, so they are asked once a visit and not before every game. It lives
 * here in memory and nowhere else: it is not written to storage and is not sent to any server.
 */
let pickedGrade: GradeBand | null = null;

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
  /** Optional shared MultiplayerClient instance from the page. */
  multiplayer?: MultiplayerClient;
  /** Called when the Top 10 Pilots leaderboard overlay is shown or hidden. */
  onLeaderboard?: (open: boolean) => void;
  /** Optional Co-op Squad session (`Phase 2`: shared `768 x 1024` 4-ship flight, lazy-loaded by HeroGame). */
  coop?: {
    director: CoopFlightDirector;
  };
}

/** What a shot landing on each part of a boss sounds like. */
const BOSS_SOUNDS: Record<Exclude<Hit, 'miss'>, Sfx> = {
  blocked: 'clang', core: 'core', down: 'bossDown', arm: 'hit', armOff: 'armOff', lock: 'lock', right: 'right', wrong: 'wrong',
};

export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly opts: GameOptions;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly coarse = matchMedia('(pointer: coarse)').matches;
  private readonly sound = new Sound();
  private readonly voice = new Voice();

  private viewW = 0;
  private viewH = 0;
  private viewInset = { top: 0, right: 0, bottom: 0, left: 0 };
  private w = 0;
  private h = 0;
  /** Size multiplier for ships and shots, so the game reads the same on a phone and a big monitor. */
  private scale = 1;
  /** Speed multiplier for things falling down the screen, so a tall screen does not feel slow. */
  private pace = 1;
  private inset = { top: 0, right: 0, bottom: 0, left: 0 };
  private raf = 0;
  private bgTimer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private time = 0;
  /** 1 is normal speed. Drops to SLOW_MOTION while a boost capsule's question waits for its answer. */
  private timeScale = 1;

  private state: State = 'ready';
  private stateTime = 0;
  private paused = false;
  /** The keyboard, the mouse and the touch screen (see input.ts). */
  private readonly input: Input;
  /** Counts the ship's volleys, for the things that fire every other one. */
  private volley = 0;
  /** Rotates auto-firing upgrades (lance, rockets, nova) across living Co-op pilots without touching Solo volley parity. */
  private upgradeTurn = 0;
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

  /** The break before each wave, and the questions that capsules and bombs ask (see questions.ts). */
  private readonly questions = new Questions();

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
  /** The fuel ship, the commander's warning and the asteroid field (see setpieces.ts). */
  private readonly sets = new SetPieces();
  /** The player's school years (see GradeBand), or null until they have said. While `picking`, the game is asking. */
  private grade: GradeBand | null = pickedGrade;
  private picking = false;
  private pickAge = 0;
  /** The fireworks that say how a challenge went. */
  private readonly fireworks = new Fireworks();
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
  private readonly mp: MultiplayerClient;
  private readonly coop: CoopFlightDirector | null;
  private readonly coopAdapter: CoopWorldAdapter;
  private coopHiddenSec = 0;
  private showLeaderboard = false;

  constructor(canvas: HTMLCanvasElement, opts: GameOptions) {
    this.canvas = canvas;
    this.opts = opts;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;

    const self = this;
    this.coopAdapter = {
      get wave() { return self.wave; },
      set wave(v: number) { self.wave = v; },
      get banner() { return self.banner; },
      set banner(v: number) { self.banner = v; },
      get score() { return self.score; },
      set score(v: number) { self.score = v; },
      get freed() { return self.freed; },
      set freed(v: number) { self.freed = v; },
      get energy() { return self.energy; },
      set energy(v: number) { self.energy = v; },
      get paused() { return self.paused; },
      set paused(v: boolean) { self.paused = v; },
      get parked() { return self.parked; },
      set parked(_v: boolean) { /* derived on Host; Guest uses coop state */ },
      get gameOver() { return self.state === 'over'; },
      set gameOver(_v: boolean) { /* managed via triggerSquadGameOver / resumeSquadNewRun */ },
      get enemies() { return self.enemies; },
      set enemies(v: Enemy[]) { self.enemies = v; },
      get shots() { return self.shots; },
      set shots(v: Shot[]) { self.shots = v; },
      get rockets() { return self.rockets; },
      set rockets(v: Rocket[]) { self.rockets = v; },
      get beams() { return self.beams; },
      set beams(v: Beam[]) { self.beams = v; },
      get pickups() { return self.pickups; },
      set pickups(v: Pickup[]) { self.pickups = v; },
      get mines() { return self.mines; },
      set mines(v: Mine[]) { self.mines = v; },
      get rings() { return self.rings; },
      get upgrades() { return self.upgrades; },
      get boss() { return self.boss; },
      set boss(v: Boss | null) { self.boss = v; },
      get sets() { return self.sets; },
      setEnv: () => self.setEnv(),
      play: (sfx) => self.sound.play(sfx),
      spark: (x, y, color) => self.spark(x, y, color),
      burst: (shape, x, y, sc, rot, color) => self.burst(shape, x, y, sc, rot, color),
      ring: (x, y, color, reach) => self.rings.push({ x, y, age: 0, color, reach }),
      free: (x, y, count = 1) => self.free(x, y, count),
      strikeBoss: (x, y, aimed, tapped = false) => self.strikeBoss(x, y, aimed, tapped),
      damageEnemy: (e, amount) => self.damage(e, amount),
      destroyEnemy: (e) => self.destroyEnemy(e),
      equipUpgrade: (id) => self.equip(id),
      detonateScreen: (ox, oy, color) => {
        let fxBudget = 12;
        for (const e of self.enemies) {
          if (!e.dead) {
            self.destroyEnemy(e);
            if (self.coop?.isHost && fxBudget > 0) {
              fxBudget -= 1;
              self.coop.recordHostFx('enemy-burst', e.x, e.y, KINDS[e.kind].color, { enemyKind: e.kind });
            }
          }
        }
        for (const s of self.shots) if (s.hostile) s.dead = true;
        const brokenBefore = self.sets.brokenRockIds.length;
        self.sets.blast(self.setEnv());
        if (self.coop?.isHost && self.sets.field && self.sets.brokenRockIds.length > brokenBefore) {
          let rockFx = 0;
          for (const r of self.sets.near) {
            if (r.dead && !r.tough && rockFx < 3) {
              rockFx += 1;
              self.coop.recordHostFx('rock-break', r.x, self.sets.field.front - r.d, PEBBLE, { toughRock: false });
            }
          }
        }
        self.rings.push({ x: ox, y: oy, age: 0, color });
        self.sound.play('blast');
        if (!self.reduceMotion) self.shake = 0.4;
      },
      triggerSquadGameOver: () => self.coopGameOver(),
      resumeSquadNewRun: () => self.resumeCoopGuestRun(),
      setHostPausedFromWire: (paused) => {
        self.paused = paused;
        if (self.coop?.isHost) {
          self.opts.onPause?.(paused);
        }
      },
      startWave: (wave) => self.startWave(wave),
      celebrate: (grade: Grade, big: boolean) => {
        if (self.reduceMotion) return;
        self.fireworks.launch(grade, big, self.w / 2, self.h * 0.34, Math.min(self.room / 2, 300), self.scale);
      },
      say: (message: string) => self.opts.onStatus?.(message),
      getGrade: () => self.grade,
      setGrade: (grade: GradeBand) => {
        self.grade = pickedGrade = grade;
      },
    };

    this.coop = opts.coop?.director ?? null;

    if (this.coop) {
      this.coop.bindWorld(this.coopAdapter);
      this.setsEnv.seeded = true;
      this.setsEnv.onTankerStart = (w) => this.coop?.notifyHostTankerStart(w);
      this.setsEnv.onFieldAlarm = (w, s) => this.coop?.notifyHostFieldEvent(w, s, null, 0, []);
      this.setsEnv.onFieldStart = (w, s) =>
        this.coop?.notifyHostFieldEvent(w, s, this.sets.field?.front ?? 0, this.sets.alert, this.sets.brokenRockIds);
    }

    this.input = new Input(window, canvas, {
      wake: () => {
        this.sound.unlock();
        this.voice.unlock();
      },
      exit: () => this.opts.onExit(),
      wants: (key) =>
        !this.paused &&
        (this.coop
          ? this.coop.wantsKey(key)
          : this.picking
            ? key >= '1' && key <= String(GRADE_BANDS.length)
            : this.questions.wants(key)),
      type: (key) => {
        if (this.coop) {
          this.coop.typeKey(key, this.coopAdapter);
          return;
        }
        if (this.picking) this.chooseGrade(Number(key) - 1);
        else this.questions.type(key, this.quizEnv());
      },
      command: (code) => this.command(code),
      pick: (x, y) => this.pick(x, y),
      touched: () => {
        if (this.coop) this.coop.onTouchInput(this.coopAdapter);
        else this.questions.byTouch(this.quizEnv());
      },
      press: () => this.press(),
      ...(this.coop
        ? {
            mapPoint: (x: number, y: number) => this.coop!.mapCanvasPointToArena(x, y),
            pointerDown: (id: number, x: number, y: number, touch: boolean) =>
              this.state === 'playing' && !this.paused && this.coop!.handlePointerDown(id, x, y, touch),
            pointerMove: (id: number, x: number, y: number) => this.coop!.handlePointerMove(id, x, y),
            pointerUp: (id: number) => this.coop!.handlePointerUp(id),
            // A pause or a hidden tab lets go of held touches; AUTO-FIRE stays as the pilot set it.
            pointerDrop: () => this.coop!.releasePointers(false),
            allowButtonSpace: (target: EventTarget | null) => this.coop!.isLeaveSheetButton(target),
          }
        : {}),
    }, this.coarse ? 'touch' : 'keys');

    this.mp = opts.multiplayer ?? new MultiplayerClient();
    if (!this.coop) {
      this.mp.start();
    }
    try {
      this.best = Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      /* storage can be blocked; the game works without a saved best */
    }

    this.resize();
    this.shipScale = 1.15 * this.scale;
    this.voice.setEnabled(this.sound.enabled);

    if (this.coop) {
      this.intro = null;
      this.warp = 3.2;
      this.beginCoop();
    } else {
      // The game opens in the cockpit; the ship itself is out of sight below the screen until it has taken off.
      this.intro = new Intro(this.reduceMotion, this.onIntroCue, {
        say: (text) => this.voice.say('commander', text),
        busy: () => this.voice.busy,
      });
      this.ship.x = this.homeX;
      this.ship.y = this.h + 80;
      opts.onStatus?.(Intro.script(this.input.mode === 'touch', !this.reduceMotion));
    }

    addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);

    // The click that opened the game is what allows it to make sound.
    this.sound.unlock();
    this.voice.unlock();
    // Draw once straight away, so the overlay never fades in on an empty canvas.
    this.render();
    this.last = performance.now();
    if (this.coop && document.hidden) {
      this.onVisibility();
    } else {
      this.raf = requestAnimationFrame(this.frame);
    }
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
    if (!this.coop) {
      this.saveBest();
      this.mp.rest();
      if (!this.opts.multiplayer) this.mp.stop();
    } else {
      this.coop.dispose();
    }
    if (this.bgTimer) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
    cancelAnimationFrame(this.raf);
    this.sound.dispose();
    this.voice.dispose();
    this.input.detach();
    removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isLeaderboardOpen(): boolean {
    return this.showLeaderboard;
  }

  /** Toggle the Top 10 Pilots leaderboard overlay (pausing first if currently flying). */
  toggleLeaderboard(): boolean {
    if (this.coop) return false;
    if (!this.showLeaderboard && this.state === 'playing' && !this.paused) {
      this.setPaused(true);
    }
    this.showLeaderboard = !this.showLeaderboard;
    // In the opening there is nothing to pause: the hangar and the briefing simply wait while the board is up.
    if (this.showLeaderboard && this.state === 'ready') this.voice.hush();
    this.opts.onLeaderboard?.(this.showLeaderboard);
    this.opts.onStatus?.(this.showLeaderboard ? 'Top 10 Pilots leaderboard open.' : 'Leaderboard closed.');
    return this.showLeaderboard;
  }

  /** Pause or resume: this is what the overlay's Pause button does. Only a game in play can be paused. */
  togglePause(): void {
    if (this.coop && !this.coop.isHost) return;
    this.setPaused(!this.paused);
  }

  private setPaused(on: boolean): void {
    if (this.coop && !this.coop.isHost) return;
    if (on === this.paused || (on && this.state !== 'playing')) return;
    this.paused = on;
    if (!on && this.showLeaderboard) {
      this.showLeaderboard = false;
      this.opts.onLeaderboard?.(false);
    }
    this.input.drop();
    // A paused pilot is not flying: other pilots stop seeing this ship until the game is resumed.
    if (on && !this.coop) this.mp.rest();
    if (on) this.voice.hush();
    if (this.coop?.isHost) {
      if (!on) this.coop.cancelHostAwayCountdown(this.coopAdapter);
      this.coop.client.sendHostPaused(on);
      this.coop.broadcastSnapshotNow(this.coopAdapter);
    }
    this.opts.onPause?.(on);
    this.opts.onStatus?.(on ? 'Paused.' : 'Resumed.');
  }

  get soundOn(): boolean {
    return this.sound.enabled;
  }

  /** Switch the sound effects on or off. The choice is remembered for next time. */
  setSound(on: boolean): void {
    this.sound.setEnabled(on);
    this.voice.setEnabled(on);
  }

  private get maxHull(): number {
    if (this.coop) {
      const seat = this.coop.localSeat;
      if (seat !== -1) {
        return this.coop.pilots[seat].maxHull;
      }
    }
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
    this.voice.say('boss', line);
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
    this.viewW = canvas.clientWidth;
    this.viewH = canvas.clientHeight;
    this.input.measure();
    canvas.width = Math.round(this.viewW * dpr);
    canvas.height = Math.round(this.viewH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const cs = getComputedStyle(canvas.parentElement ?? canvas);
    this.viewInset = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };

    if (this.coop) {
      this.w = COOP_ARENA_W;
      this.h = COOP_ARENA_H;
      this.scale = 1;
      this.pace = 1;
      this.inset = { top: 0, right: 0, bottom: 0, left: 0 };
      this.coop.setViewport(this.viewW, this.viewH, this.viewInset, this.coarse);
    } else {
      this.w = this.viewW;
      this.h = this.viewH;
      // A phone held sideways is short: everything shrinks further there, to leave room to fly.
      this.scale = clamp(Math.min(this.w, this.h) / 700, this.h < 500 ? 0.62 : 0.85, 1.3);
      // Everything that flies does so at a speed in proportion to the height of the screen, so a short screen
      // (a phone held sideways) gives a pilot as long to react as a tall one does.
      this.pace = clamp(this.h / 760, 0.6, 1.35);
      this.inset = this.viewInset;
    }

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
    if (!first && !this.coop) this.keepShipInBounds();
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

  /** One of the game's keys has gone down (see input.ts). True if it was a command, and so not a control to hold. */
  private command(code: string): boolean {
    const confirm = code === 'Space' || code === 'Enter';
    if (this.coop) {
      if (!this.coop.isHost) return false;
      if (this.paused && this.coop.isResumeCountdownActive) {
        // HOST AWAY's 3-2-1 gives the squad time to get ready: it is not skipped. P stops it and stays paused.
        if (code === 'KeyP') this.coop.cancelHostAwayCountdown(this.coopAdapter);
        return true;
      }
      if (this.paused) {
        if (code === 'KeyP' || confirm) this.setPaused(false);
        return true;
      }
      if (code === 'KeyP') {
        this.setPaused(true);
        return true;
      }
      if (this.state === 'over' && this.stateTime > 0.9 && confirm) {
        this.beginCoop();
        return true;
      }
      return false;
    }
    if (code === 'KeyL' && (this.paused || this.state !== 'playing')) {
      this.sound.play('key');
      this.toggleLeaderboard();
      return true;
    }
    if (code === 'KeyC' && (this.showLeaderboard || this.state === 'over' || this.paused)) {
      this.sound.play('key');
      const next = this.mp.cycleCallsign();
      this.opts.onStatus?.(`Pilot callsign set to ${next}.`);
      return true;
    }
    if (this.paused) {
      if (code === 'KeyP' || confirm) this.setPaused(false);
      return true;
    }
    if (code === 'KeyP') {
      this.setPaused(true);
      return true;
    }
    if (confirm && this.showLeaderboard) this.closeLeaderboard();
    else if (this.state === 'ready') {
      if (confirm) this.go();
    } else if (this.state === 'over' && this.stateTime > 0.9 && confirm) this.begin();
    return false;
  }

  /** A click or tap at (x, y): on an upgrade on offer, an answer to a sum, or one of a sum boss's little ships. */
  private pick(x: number, y: number): boolean {
    if (this.paused) return false;
    if (this.coop) {
      if (this.state === 'playing' && this.coop.pickArenaOverlay(x, y, this.coopAdapter)) {
        return true;
      }
      if (
        this.state !== 'playing' ||
        !this.boss ||
        this.boss.kind !== 'sum' ||
        this.boss.state !== 'fight' ||
        !this.boss.pods.length
      ) {
        return false;
      }
      if (!this.coop.isHost && !touchesBoss(this.boss, x, y, 16, this.bossEnv())) {
        return false;
      }
      return this.coop.queueArenaTap(x, y, this.coopAdapter);
    }
    if (this.picking) {
      const band = boxAt(x, y, offerBoxes(this.w, this.h, this.room, challengeTopY(this.h, this.inset.top, this.homeY, true), GRADE_BANDS.length));
      if (band !== null) this.chooseGrade(band);
      return band !== null;
    }
    const { brk, prompt, challenge } = this.questions;
    const top = challengeTopY(this.h, this.inset.top, this.homeY, Boolean(brk));
    const offer = prompt?.offer;
    const offered = offer ? boxAt(x, y, offerBoxes(this.w, this.h, this.room, top, offer.length)) : null;
    if (offered !== null) {
      this.questions.chooseUpgrade(offered, this.quizEnv());
      return true;
    }
    if (challenge && challenge.kind === 'choice' && !challenge.outcome) {
      const option = boxAt(x, y, optionBoxes(this.w, this.room, challenge.options.length, top));
      if (option !== null) {
        choose(challenge, option);
        return true;
      }
    }
    return this.state === 'playing' && !prompt && this.boss !== null && this.strikeBoss(x, y, true, true);
  }

  /** A click or tap that picked nothing: resume, launch, or try again. */
  private press(): void {
    if (this.coop) {
      if (!this.coop.isHost) return;
      // The click that brings the window back must not skip HOST AWAY's 3-2-1.
      if (this.paused && this.coop.isResumeCountdownActive) return;
      if (this.paused) this.setPaused(false);
      else if (this.state === 'over' && this.stateTime > 0.9) this.beginCoop();
      return;
    }
    if (this.paused) this.setPaused(false);
    // With the leaderboard up, a click or tap puts it away; it does not launch or start a new game underneath it.
    else if (this.showLeaderboard) this.closeLeaderboard();
    else if (this.state === 'ready') this.go();
    else if (this.state === 'over' && this.stateTime > 0.9) this.begin();
  }

  private closeLeaderboard(): void {
    if (!this.showLeaderboard) return;
    this.showLeaderboard = false;
    this.opts.onLeaderboard?.(false);
    this.opts.onStatus?.('Leaderboard closed.');
  }

  private onVisibility = (): void => {
    cancelAnimationFrame(this.raf);
    if (this.bgTimer) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
    if (this.coop) {
      if (document.hidden) {
        this.voice.hush();
        this.input.drop();
        this.coopHiddenSec = 0;
        // Hidden again during HOST AWAY's 3-2-1: nobody is at the host, so the squad waits again.
        if (this.coop.isHost && this.paused && this.coop.isResumeCountdownActive) {
          this.coop.engageHostAway(this.coopAdapter);
        }
        this.last = performance.now();
        this.bgTimer = setInterval(() => {
          const coop = this.coop;
          if (!coop) return;
          const now = performance.now();
          const rawElapsed = Math.min(1.0, Math.max(0, (now - this.last) / 1000));
          let elapsed = rawElapsed;
          this.last = now;
          if (!this.paused) {
            if (coop.isHost && !coop.client.tvMode && this.state === 'playing') {
              this.coopHiddenSec += rawElapsed;
              if (this.coopHiddenSec >= 2.0) {
                this.setPaused(true);
                coop.engageHostAway(this.coopAdapter);
                return;
              }
            }
            while (elapsed > 0.001) {
              const step = Math.min(0.05, elapsed);
              this.update(step);
              elapsed -= step;
            }
          } else if (coop.tickPaused(rawElapsed, this.coopAdapter)) {
            this.setPaused(false);
          }
        }, 50);
      } else {
        this.coopHiddenSec = 0;
        if (this.coop.isHost && this.coop.hostAway && this.paused && this.state === 'playing') {
          this.coop.beginHostAwayResumeCountdown(this.coopAdapter);
        }
        this.sound.unlock();
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.frame);
      }
      return;
    }
    if (document.hidden) {
      this.saveBest();
      this.voice.hush();
      this.input.letGo();
      this.setPaused(true);
    } else {
      // Coming back from another app, the phone may have taken the audio away: ask for it back.
      this.sound.unlock();
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  };

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
    // The school bell, and the announcement that goes with it (the words are on screen too).
    if (cue === 'bell') this.voice.say('commander', 'TIME FOR FLIGHT CLASS');
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
    this.sets.reset();
    this.fireworks.clear();
    this.questions.prompt = null;
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
    this.showLeaderboard = false;
    this.opts.onLeaderboard?.(false);
    this.setState('playing');
    this.sound.play('start');
    this.picking = false;
    if (this.grade === null) this.askGrade();
    else this.questions.startBreak(1, this.quizEnv());
  }

  private beginCoop(): void {
    if (!this.coop) return;
    this.hull = MAX_HULL;
    this.energy = 0.45;
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
    this.sets.reset();
    this.fireworks.clear();
    this.questions.prompt = null;
    this.questions.brk = null;
    this.boss = null;
    this.intermission = 0;
    this.upgrades.clear();
    this.shield = { ready: false, recharge: 0 };
    this.rockets = [];
    this.beams = [];
    this.pilot = { mood: 'calm', until: 0 };
    this.villain = freshVillain();
    this.picking = false;
    this.showLeaderboard = false;
    this.upgradeTurn = 0;
    this.coop.resetSquadForNewRun();
    this.setState('playing');
    this.sound.play('start');

    if (this.coop.isHost) {
      const saved = this.coop.loadSavedHostProgress();
      if (saved) {
        this.score = saved.score;
        this.freed = saved.freed;
        this.startWave(saved.wave);
      } else {
        this.startWave(1);
      }
      this.coop.broadcastSnapshotNow(this.coopAdapter);
    } else {
      this.wave = 1;
      this.banner = 2.0;
    }
  }

  private resumeCoopGuestRun(): void {
    this.enemies = [];
    this.shots = [];
    this.pickups = [];
    this.mines = [];
    this.rings = [];
    this.souls = [];
    this.sets.reset();
    this.boss = null;
    this.upgrades.clear();
    this.setState('playing');
    this.sound.play('start');
  }

  private coopGameOver(): void {
    this.queue = [];
    this.pickupTimes = [];
    this.upgradeTimes = [];
    this.mineTimes = [];
    this.pickups = [];
    this.mines = [];
    this.rockets = [];
    this.beams = [];
    this.questions.prompt = null;
    this.intermission = 0;
    this.sets.stop();
    if (this.boss && this.boss.state !== 'dying') {
      this.boss.pods = [];
      this.boss.state = 'leaving';
    }
    this.setState('over');
    this.sound.play('over');
    const totalFreed = this.freed + this.souls.length;
    this.opts.onStatus?.(
      `Squad down. Team score ${this.score}. Wave ${this.wave}. ${totalFreed} ${totalFreed === 1 ? 'person' : 'people'} set free.`,
    );
  }

  /** Before the first challenge of a visit: ask which school years the player is in, so the questions fit. */
  private askGrade(): void {
    this.picking = true;
    this.pickAge = 0;
    this.input.letGo();
    this.voice.say('commander', 'WHAT GRADE ARE YOU IN, PILOT?');
    const how = this.input.mode === 'touch' ? 'Tap' : 'Press';
    this.opts.onStatus?.(
      `What grade are you in? ${GRADE_BANDS.map((band, i) => `${how}${this.input.mode === 'touch' ? '' : ` ${i + 1} for`} ${band.spoken}`).join('. ')}. ` +
      'This only sets how hard the questions are. It is not saved or sent anywhere.',
    );
  }

  private chooseGrade(index: number): void {
    // (A moment's grace, so a key or finger still down from the take-off picks nothing.)
    if (!this.picking || this.pickAge < 0.4 || !GRADE_BANDS[index]) return;
    this.grade = pickedGrade = index as GradeBand;
    this.picking = false;
    this.sound.play('power');
    this.questions.startBreak(1, this.quizEnv());
  }

  /** The ship is parked and nothing is flying: a break is on, or the player is being asked their grade. */
  private get parked(): boolean {
    return this.coop ? this.coop.isSquadParked : this.picking || this.questions.brk !== null;
  }

  private startWave(n: number): void {
    this.wave = n;
    this.waveTime = 0;
    this.banner = 2.2;
    this.rest = 0;
    const plan = buildWavePlan(n, this.w, this.inset, this.scale, this.margin, this.upgrades.size < UPGRADES.length);
    this.queue = plan.queue;
    this.pickupTimes = plan.pickupTimes;
    this.upgradeTimes = plan.upgradeTimes;
    this.mineTimes = plan.mineTimes;
    this.sets.plan(plan.stops);
    if (this.coop?.isHost) {
      if (n > 1) this.energy = Math.min(1, this.energy + 0.35);
      this.coop.notifyHostWaveStart(n, this.score, this.freed);
    }
    this.sound.play('wave');
    this.opts.onStatus?.(`Wave ${n}.`);
  }

  private spawn(sp: Spawn): void {
    this.enemies.push(spawnEnemy(sp, this.wave, this.w, this.h, this.inset.top, this.scale, this.pace));
  }

  /** What an ordinary capsule holds: whatever helps most. Repairs when the hull is hurt, blasts once the waves get busy. */
  private pickReward(): Reward {
    const pool: Reward[] = ['energy'];
    const anyHurt = this.coop
      ? this.coop.pilots.some((p) => p.present && p.alive && p.hull < p.maxHull)
      : this.hull < this.maxHull;
    if (anyHurt) pool.push('hull', 'hull');
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
      if (this.coop?.isHost && x > 0 && y > 0) {
        this.coop.recordHostFx('spark', x, y, color);
      }
    },
    // In co-op the whole squad sees the boss's sums, so they cannot follow one pilot's private grade band (it would
    // show the others which band the host picked): the squad gets the youngest band's sums.
    problem: () => makeProblem(sumLevel(this.wave, this.coop ? 0 : (this.grade ?? 1))),
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
    if (this.coop && this.coop.isHost && this.boss) {
      const target = this.coop.nearestLivingPilot(this.boss.x, this.boss.y);
      env.shipX = target.x;
      env.shipY = target.y;
    } else {
      env.shipX = this.ship.x;
      env.shipY = this.ship.y;
    }
    return env;
  }

  /** What the fuel ship and the asteroids know of the game: made once, and brought up to date each time it is asked for. */
  private readonly setsEnv: SetPieceEnv = {
    w: 0, h: 0, top: 0, left: 0, right: 0, scale: 1, pace: 1, shipScale: 1, wave: 1, time: 0, playing: false, shipX: 0, shipY: 0,
    play: (sound) => this.sound.play(sound),
    say: (message) => this.opts.onStatus?.(message),
    radio: (text) => void this.voice.say('commander', text),
    call: (text) => void this.voice.say('pilot', `${text}!`),
    feel: (mood, seconds, soft) => this.feel(mood, seconds, soft),
    award: (points) => {
      this.score += points;
    },
    charge: (amount) => {
      this.energy = Math.min(1, this.energy + amount);
    },
    ring: (x, y, color, reach) => {
      this.rings.push({ x, y, age: 0, color, reach });
    },
    spark: (x, y, color) => this.spark(x, y, color),
    burst: (shape, x, y, rot, color) => this.burst(shape, x, y, 1, rot, color),
    bomb: (x, y, ride) => {
      this.mines.push({ x, y, anchorX: x, phase: 0, age: 0, dead: false, thrown: false, ride });
    },
    capsule: (x, y, ride, last) => {
      // At the far end of the hard way is the big prize: an upgrade, while there are any left to win.
      const reward = last && this.upgrades.size < UPGRADES.length ? 'upgrade' : this.pickReward();
      this.pickups.push({ reward, x, y, anchorX: x, phase: 0, age: 0, dead: false, ride });
    },
  };

  private setEnv(): SetPieceEnv {
    const env = this.setsEnv;
    env.w = this.w;
    env.h = this.h;
    env.top = this.inset.top;
    env.left = this.inset.left;
    env.right = this.inset.right;
    env.scale = this.scale;
    env.pace = this.pace;
    env.shipScale = this.shipScale;
    env.wave = this.wave;
    env.time = this.time;
    env.playing = this.state === 'playing';
    if (this.coop) {
      const tankerPilot = this.coop.isHost
        ? this.coop.selectTankerPilot(this.sets.tanker, this.shipScale)
        : this.coop.pilots[this.coop.hookedSeat];
      env.shipX = tankerPilot.x;
      env.shipY = tankerPilot.y;
    } else {
      env.shipX = this.ship.x;
      env.shipY = this.ship.y;
    }
    return env;
  }

  /** What the questions know of the game: made once, and brought up to date each time it is asked for. */
  private readonly quizzing: QuestionEnv = {
    touch: false, wave: 1, grade: 1, hull: 0, maxHull: 0, energy: 0, boss: false, owned: new Set(),
    play: (sound) => this.sound.play(sound),
    say: (message) => this.opts.onStatus?.(message),
    call: (text) => void this.voice.say('pilot', `${text}!`),
    celebrate: (grade, big) => {
      // With motion turned down the colour of the badge says it all.
      if (this.reduceMotion) return;
      const top = challengeTopY(this.h, this.inset.top, this.homeY, Boolean(this.questions.brk));
      this.fireworks.launch(grade, big, this.w / 2, top + 40, Math.min(this.room / 2, 460), this.scale);
    },
    feel: (mood, seconds) => this.feel(mood, seconds),
    taunt: (kind, mood, seconds) => this.taunt(kind, mood, seconds, 1, true),
    award: (points) => {
      this.score += points;
    },
    charge: (amount) => {
      this.energy = Math.min(1, this.energy + amount);
    },
    repair: () => {
      this.hull += 1;
    },
    jam: (seconds) => {
      this.jam = seconds;
    },
    blast: () => this.detonate(),
    equip: (id) => this.equip(id),
    explode: () => {
      this.hull = 0;
      this.rings.push({ x: this.ship.x, y: this.ship.y, age: 0, color: NEON.red }, { x: this.ship.x, y: this.ship.y, age: -0.1, color: NEON.orange });
      if (!this.reduceMotion) this.shake = 0.5;
      this.sound.play('blast');
      this.gameOver();
    },
    shelter: (seconds) => {
      this.ship.invulnerable = Math.max(this.ship.invulnerable, seconds);
    },
    park: (wave) => {
      this.wave = wave;
      this.input.letGo();
      this.shots = [];
      this.pickups = [];
      this.mines = [];
      this.rockets = [];
    },
    launch: (wave) => this.startWave(wave),
  };

  private quizEnv(): QuestionEnv {
    const env = this.quizzing;
    env.touch = this.input.mode === 'touch';
    env.wave = this.wave;
    env.grade = this.grade ?? 1;
    env.hull = this.hull;
    env.maxHull = this.maxHull;
    env.energy = this.energy;
    env.boss = this.boss !== null;
    env.owned = this.upgrades;
    return env;
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
        ? `Mini boss. ${this.input.mode === 'touch' ? 'Tap' : 'Keep shooting'} the little ship carrying the right answer to open its armour, then shoot the red core.`
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
      if (b.state === 'fight' && this.time > v.nextIdle && !this.questions.prompt) this.taunt('idle', 'talk', 1.2);
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
      if (this.coop?.isHost) {
        this.coop.recordHostFx('boss-burst', b.x, b.y, NEON.red);
      }
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
    if (e.hp <= 0) {
      this.destroyEnemy(e);
      if (this.coop?.isHost) {
        this.coop.recordHostFx('enemy-burst', e.x, e.y, KINDS[e.kind].color, { enemyKind: e.kind });
      }
    } else {
      this.sound.play('hit');
      if (this.coop?.isHost) {
        this.coop.recordHostFx('spark', e.x, e.y, KINDS[e.kind].color);
      }
    }
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
    this.sets.blast(this.setEnv());
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
    this.questions.prompt = null;
    this.intermission = 0;
    this.sets.stop();
    if (this.boss) this.taunt('win', 'laugh', 6, 1, true);
    // A boss that has won does not hang about over the game over screen.
    if (this.boss && this.boss.state !== 'dying') {
      this.boss.pods = [];
      this.boss.state = 'leaving';
    }
    this.newBest = this.saveBest();
    this.setState('over');
    this.sound.play('over');
    this.mp.rest();
    // (Anyone still on their way to the counter has been freed all the same.)
    const freed = this.freed + this.souls.length;
    const rank = this.mp.recordScore(this.score, this.wave, freed);
    const rankMsg = rank ? ` Ranked #${rank} on Top 10 Pilots.` : '';
    this.opts.onStatus?.(`Game over. Score ${this.score}. Wave ${this.wave}. You set ${freed} ${freed === 1 ? 'person' : 'people'} free.${rankMsg}`);
  }

  /** Break a shape into its line segments and send them tumbling outward. */
  private burst(shape: Shape, x: number, y: number, scale: number, rot: number, color: string): void {
    burstShape(this.debris, shape, x, y, scale, rot, color);
  }

  /** Fit an upgrade that has just been chosen. */
  private equip(id: UpgradeId): void {
    this.upgrades.add(id);
    if (id === 'armour') this.hull = Math.min(this.maxHull, this.hull + 1);
    if (id === 'shield') this.shield = { ready: true, recharge: 0 };
    if (id === 'lance') this.lanceIn = 0.8;
    if (id === 'rockets') this.rocketIn = 0.5;
    if (id === 'nova') this.novaIn = 1.5;
  }

  // ---------------------------------------------------------------- update

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (!this.paused) this.update(dt);
    else if (this.coop && this.coop.tickPaused(dt, this.coopAdapter)) this.setPaused(false);
    this.render();
  };

  /** `dt` is real time. Questions and their clocks run on it; the world runs on `sim`, which slow motion shrinks. */
  private update(dt: number): void {
    if (this.coop) {
      this.updateCoop(dt);
      return;
    }
    this.time += dt;
    this.stateTime += dt;
    this.shake = Math.max(0, this.shake - dt);
    this.fireworks.update(dt);
    this.timeScale += ((this.asking ? SLOW_MOTION : 1) - this.timeScale) * (1 - Math.exp(-dt * 9));
    const sim = dt * this.timeScale;
    this.banner = Math.max(0, this.banner - sim);

    if (this.intro && !this.showLeaderboard) {
      this.intro.update(dt, this.input.mode === 'touch');
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
      const flying = this.state === 'playing' && !this.parked;
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
    if (this.state !== 'playing') this.sets.coast(sim, dt, this.setEnv());
    this.updateSoulsOnScreen(sim);

    this.updateShip(sim);
    const drift = (this.ship.x - this.lastShipX) / Math.max(dt, 0.001);
    this.lastShipX = this.ship.x;
    this.lean += (clamp(drift / 380, -1, 1) - this.lean) * (1 - Math.exp(-dt * 8));
    if (this.state === 'playing') {
      if (this.picking) {
        this.pickAge += dt;
      } else if (this.questions.brk) {
        this.questions.updateBreak(dt, this.quizEnv());
      } else {
        if (this.intermission > 0) {
          this.intermission -= sim;
          if (this.intermission <= 0) this.questions.startBreak(this.wave + 1, this.quizEnv());
        } else if (this.boss) {
          this.updateBossFight(sim, dt);
        } else {
          this.updateWave(sim, dt);
        }
        this.updatePickups(sim);
        this.updateMines(sim);
        this.updateUpgrades(sim);
        this.questions.updatePrompt(dt, this.quizEnv());
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
    this.mp.updateFlight(sim, {
      active: this.state === 'playing' && !this.parked && !this.intro,
      w: this.w,
      h: this.h,
      scale: this.scale,
      pace: this.pace,
      shipX: this.ship.x,
      shipY: this.ship.y,
      wave: this.wave,
      score: this.score,
      freed: this.freed,
      hull: this.hull,
      firing: this.input.firing && !this.asking && !this.sets.tanker?.hooked,
      enemies: this.enemies,
    });

    this.enemies = this.enemies.filter((e) => !e.dead);
    this.shots = this.shots.filter((s) => !s.dead);
    this.pickups = this.pickups.filter((p) => !p.dead);
    this.mines = this.mines.filter((m) => !m.dead);
  }

  /** Co-op `768 x 1024` shared-arena tick (Host authoritative simulation or Guest 60fps interpolation). */
  private updateCoop(dt: number): void {
    const coop = this.coop;
    if (!coop) return;

    this.time += dt;
    this.stateTime += dt;
    this.shake = Math.max(0, this.shake - dt);
    this.fireworks.update(dt);
    const sim = dt;
    this.shipScale = 1.15 * this.scale;
    if (coop.isHost) {
      this.banner = Math.max(0, this.banner - sim);
    }

    const flying = this.state === 'playing' && !this.parked && !coop.hostReconnecting && !coop.hostPaused;
    const targetWarp = flying ? 3.2 : this.state === 'over' ? 0.6 : 1;
    this.warp += (targetWarp - this.warp) * (1 - Math.exp(-dt * 1.8));
    for (const star of this.stars) {
      star.y += star.speed * this.warp * sim;
      if (star.y > this.h + 80) Object.assign(star, this.makeStar(-rand(10, 80)));
    }
    this.backdrop.update(sim, this.warp);

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
    this.updateSoulsOnScreen(sim);

    coop.step(sim, dt, this.coopAdapter, {
      across: this.input.across,
      down: this.input.down,
      touching: this.input.touching,
      touchX: this.input.touch.x,
      touchY: this.input.touch.y,
      firing: this.input.firing,
    });

    const localIdx = coop.localSeat !== -1 ? coop.localSeat : 0;
    const localPilot = coop.pilots[localIdx];
    this.ship.x = localPilot.x;
    this.ship.y = localPilot.y;
    this.ship.invulnerable = localPilot.invulnerable;
    this.lean = localPilot.lean;
    this.hull = localPilot.hull;
    this.jam = localPilot.jamSec;

    const across = this.reduceMotion ? 0 : clamp(this.ship.x / (this.w || 1) - 0.5, -0.5, 0.5);
    this.drift += (across - this.drift) * (1 - Math.exp(-dt * 3));

    if (!coop.isHost) {
      return;
    }

    if (this.boss && this.state !== 'playing') this.updateBossFight(sim, dt);
    if (this.state !== 'playing') this.sets.coast(sim, dt, this.setEnv());

    if (this.state === 'playing' && !coop.isSquadParked) {
      if (this.intermission > 0) {
        this.intermission -= sim;
        if (this.intermission <= 0) coop.beginSquadWaveBreak(this.wave + 1, this.coopAdapter);
      } else if (this.boss) {
        this.updateBossFight(sim, dt);
      } else {
        this.updateWave(sim, dt);
      }

      const hurry = !this.queue.length && !this.enemies.length ? 3 : 1;
      for (const p of this.pickups) {
        p.age += sim;
        if (p.ride !== undefined) {
          p.y += p.ride * sim;
        } else {
          p.y += 60 * this.pace * hurry * sim;
          p.x = p.anchorX + Math.sin(p.age * 1.3 + p.phase) * 18 * this.scale;
        }
        if (p.y > this.h + 40) p.dead = true;
      }

      const mineHurry = this.boss ? 1.2 : hurry;
      const chasePilot = coop.nearestLivingPilot(this.w / 2, this.h * 0.75);
      for (const m of this.mines) {
        m.age += sim;
        m.y += (m.ride ?? 74 * this.pace * mineHurry) * sim;
        if (m.thrown) m.anchorX += clamp(chasePilot.x - m.anchorX, -1, 1) * 30 * this.scale * sim;
        m.x = m.ride !== undefined ? m.anchorX : m.anchorX + Math.sin(m.age * 0.9 + m.phase) * (m.thrown ? 12 : 34) * this.scale;
        if (m.y > this.h + 40) m.dead = true;
      }

      this.updateUpgrades(sim);
      if (this.enemies.length || this.boss?.state === 'fight') {
        this.energy = Math.max(0, this.energy - sim / ENERGY_SECONDS);
      }
    }

    const aggroPilot = coop.nearestLivingPilot(this.w / 2, this.h * 0.72);
    updateEnemies(this.enemies, sim, dt, {
      playing: this.state === 'playing',
      wave: this.wave,
      w: this.w,
      h: this.h,
      left: this.inset.left + this.margin,
      right: this.w - this.inset.right - this.margin,
      scale: this.scale,
      pace: this.pace,
      shipX: aggroPilot.x,
      shipY: aggroPilot.y,
      fireShot: (x, y, vx, vy, color) => {
        this.shots.push({ x, y, vx, vy, hostile: true, dead: false, color });
        this.sound.play('enemyShot');
      },
    });
    this.updateShots(sim);
    if (this.state === 'playing' && !coop.isSquadParked) {
      coop.collideHostSquad(this.coopAdapter, this.scale);
    }

    this.enemies = this.enemies.filter((e) => !e.dead);
    this.shots = this.shots.filter((s) => !s.dead);
    this.pickups = this.pickups.filter((p) => !p.dead);
    this.mines = this.mines.filter((m) => !m.dead);
    // Everything has moved and every hit is settled: the squad's snapshot can go out.
    coop.endHostFrame(this.coopAdapter);
  }

  /** A capsule's question is open, which is when the world runs in slow motion and the cannons hold their fire. */
  private get asking(): boolean {
    return this.questions.asking;
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
    if (this.parked) {
      ship.x += (this.homeX - ship.x) * k;
      ship.y += (this.homeY - ship.y) * k;
      return;
    }
    if (this.state !== 'playing') return;

    ship.invulnerable = Math.max(0, ship.invulnerable - dt);
    ship.cooldown = Math.max(0, ship.cooldown - dt);
    this.jam = Math.max(0, this.jam - dt);

    const input = this.input;
    let dx = input.across;
    let dy = input.down;
    if (dx && dy) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    const speed = 380 * this.scale;
    ship.x += dx * speed * dt;
    ship.y += dy * speed * dt;

    if (input.touching) {
      const tx = input.touch.x - ship.x;
      const ty = input.touch.y - ship.y;
      const dist = Math.hypot(tx, ty);
      if (dist > 0.5) {
        const step = Math.min(dist, 760 * dt);
        ship.x += (tx / dist) * step;
        ship.y += (ty / dist) * step;
      }
    }
    this.keepShipInBounds();

    if (input.firing && ship.cooldown <= 0 && this.jam <= 0 && !this.asking && !this.sets.tanker?.hooked) {
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
    const asking = this.questions.prompt !== null;
    // While the fuel ship or the asteroids have the stage, nothing else in the wave moves on.
    if (this.sets.run(dt, real, this.setEnv(), this.enemies.length, asking)) return;
    this.waveTime = this.sets.advance(this.waveTime, dt);
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
    if (cleared && quiet && !asking) {
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
      else if (this.state === 'playing' && !this.questions.prompt && this.ship.invulnerable <= 0 && Math.hypot(m.x - this.ship.x, m.y - this.ship.y) < reach) {
        m.dead = true;
        this.questions.startPrompt('defuse', this.quizEnv());
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
      } else if (!this.questions.prompt) {
        p.age += dt;
        p.y += 60 * this.pace * hurry * dt;
        p.x = p.anchorX + Math.sin(p.age * 1.3 + p.phase) * 18 * this.scale;
      }
      if (p.y > this.h + 40) p.dead = true;
      else if (!this.questions.prompt && Math.hypot(p.x - this.ship.x, p.y - this.ship.y) < reach) {
        p.dead = true;
        this.questions.startPrompt(p.reward, this.quizEnv());
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
    if (!this.coop && has('shield') && !this.shield.ready) {
      this.shield.recharge -= dt;
      if (this.shield.recharge <= 0) {
        this.shield.ready = true;
        this.sound.play('shieldUp');
      }
    }

    if (!this.coop && has('guardian')) {
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
        if (this.coop?.isHost) {
          this.coop.recordHostFx('ring', x, y, NEON.orange);
        }
      },
    });

    if (this.asking || !(this.enemies.length > 0 || this.boss?.state === 'fight')) return;

    const shooters = this.coop
      ? this.coop.pilots.filter((p) => p.present && p.connected && p.alive)
      : [{ x: ship.x, y: ship.y, color: NEON.cyan }];
    if (shooters.length === 0) return;

    if (has('lance') && (this.lanceIn -= dt) <= 0) {
      this.lanceIn = LANCE_SECONDS;
      const origin = shooters[this.upgradeTurn++ % shooters.length]!;
      const x = origin.x;
      this.beams.push({ x, y: origin.y - 18 * sc, age: 0 });
      this.sound.play('beam');
      for (const e of this.enemies) if (e.y < origin.y && Math.abs(e.x - x) < (KINDS[e.kind].radius + 7) * sc) this.damage(e, 2);
      for (let n = 0; n < 4; n++) {
        for (let y = origin.y - 20 * sc; y > 0; y -= 8) if (this.strikeBoss(x, y, false)) break;
      }
    }

    if (has('rockets') && (this.rocketIn -= dt) <= 0) {
      this.rocketIn = ROCKET_SECONDS;
      const origin = shooters[this.upgradeTurn++ % shooters.length]!;
      this.rockets.push({ x: origin.x, y: origin.y - 16 * sc, vx: (Math.random() < 0.5 ? -1 : 1) * 140, vy: -240, age: 0, dead: false });
      this.sound.play('rocket');
    }

    if (has('nova') && (this.novaIn -= dt) <= 0) {
      this.novaIn = NOVA_SECONDS;
      const origin = shooters[this.upgradeTurn++ % shooters.length]!;
      const reach = 210 * sc;
      this.rings.push({ x: origin.x, y: origin.y, age: 0, color: NEON.cyan, reach });
      this.sound.play('nova');
      if (this.coop?.isHost) {
        this.coop.recordHostFx('ring', origin.x, origin.y, NEON.cyan);
      }
      for (const s of this.shots) if (s.hostile && Math.hypot(s.x - origin.x, s.y - origin.y) < reach) s.dead = true;
      for (const e of this.enemies) if (Math.hypot(e.x - origin.x, e.y - origin.y) < reach) this.damage(e, 1);
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
    const safe = ship.invulnerable > 0 || this.questions.prompt !== null;

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
      if (this.strikeBoss(s.x, s.y, !s.stray && this.input.mode !== 'touch')) {
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
      const rock = this.sets.rockAt(s.x, s.y);
      if (rock) {
        s.dead = true;
        this.sets.hitRock(rock, s.x, s.y, this.setEnv());
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
    const rock = this.sets.rockTouching(ship.x, ship.y, shipRadius);
    if (rock) {
      this.sets.scrape(rock, this.setEnv());
      this.hitShip();
      // Long enough to get clear of the rocks before the next one can hurt.
      if (this.state === 'playing') ship.invulnerable = Math.max(ship.invulnerable, 2.2);
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
    const squad = this.mp.snapshot();
    const coopOnline = this.coop ? this.coop.pilots.filter((p) => p.present && p.connected).length : 0;
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
      input: this.input.mode,
      state: this.state,
      stateTime: this.stateTime,
      paused: this.coop && !this.coop.isHost ? false : this.paused,
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
      fuelNote: this.sets.note,
      upgrades: this.upgrades,
      boss: this.boss,
      tanker: this.sets.tanker,
      brk: this.questions.brk,
      prompt: this.questions.prompt,
      pilotMood: this.pilotMood,
      villainMood: this.villainMood,
      villain: this.villain,
      callsign: this.coop ? this.coop.client.callsign : squad.callsign,
      onlineCount: this.coop ? coopOnline : squad.onlineCount,
      wingmenCount: this.coop ? Math.max(0, coopOnline - 1) : squad.wingmenCount,
      lastRank: this.coop ? null : squad.lastRank,
      totalLiberated: this.coop ? this.freed : squad.totalLiberated,
      topPilots: this.coop ? [] : squad.topPilots,
      showLeaderboard: this.showLeaderboard,
      ...(this.coop ? { coopRole: this.coop.isHost ? ('host' as const) : ('guest' as const) } : {}),
      grading: this.picking ? this.pickAge : null,
    };
  }

  private render(): void {
    const { ctx, w, h } = this;
    const sc = this.scale;
    const coop = this.coop;
    if (coop) {
      ctx.clearRect(0, 0, this.viewW, this.viewH);
      ctx.fillStyle = '#03071a';
      ctx.fillRect(0, 0, this.viewW, this.viewH);
      const { arenaRect, arenaScale } = coop.layout;
      ctx.save();
      ctx.beginPath();
      ctx.rect(arenaRect.x, arenaRect.y, arenaRect.w, arenaRect.h);
      ctx.clip();
      ctx.translate(arenaRect.x, arenaRect.y);
      ctx.scale(arenaScale, arenaScale);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    ctx.save();
    const view = this.view;
    const shake = Math.max(this.shake, view?.shake ?? 0);
    if (shake > 0) ctx.translate(rand(-1, 1) * shake * 14, rand(-1, 1) * shake * 14);
    const frame = this.intro ? { ctx, ink: this.ink, w, h, inset: this.inset, time: this.time, touch: this.input.mode === 'touch' } : null;
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

    const { field, near, tanker, alert } = this.sets;
    const { brk, prompt } = this.questions;
    if (field && near.length) {
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
        for (const rock of near) if (!rock.dead && keep(rock)) trace(ctx, rock.shape, rock.x, front - rock.d, 1, rock.rot);
      };
      this.ink(ROCK, 1, 1.5, rocks((rock) => rock.tough && rock.flash <= 0), false);
      this.ink(PEBBLE, 1, 1.4, rocks((rock) => !rock.tough && rock.flash <= 0));
      this.ink(SAND, 1, 2, rocks((rock) => rock.flash > 0));
    }

    renderEnemies(ctx, this.ink, this.enemies, sc, this.time);
    renderHostileShots(ctx, this.ink, this.shots, this.tintsOf(this.shots, isHostile), sc);

    const hudCtx = this.hudContext();
    if (tanker) {
      const tankerHud = coop
        ? { ...hudCtx, shipX: coop.pilots[coop.hookedSeat].x, shipY: coop.pilots[coop.hookedSeat].y }
        : hudCtx;
      renderTanker(tankerHud, tanker, this.sets.tankerEnv(this.setEnv()));
    }

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
        if (this.input.mode === 'touch') {
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

    if (coop) {
      coop.renderSquadShips(ctx, this.ink, this.time, sc, this.shipScale, this.reduceMotion, this.upgrades);
    } else {
      if (this.state === 'playing' && !this.parked && !view) {
        renderWingmen(ctx, this.ink, this.mp.wingmen, this.mp.lasers, sc, this.shipScale, this.time);
      }

      const blinking = this.state === 'playing' && !this.paused && !prompt && !brk && this.ship.invulnerable > 0;
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
        if (prompt) this.ink(SAND, 0.5, 1.2, () => trace(ctx, CAPSULE, this.ship.x, this.ship.y, 2.1 * s, this.time * 0.5), false);

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
    }
    ctx.restore();

    if (this.timeScale < 0.99) {
      ctx.fillStyle = `rgba(3, 7, 26, ${(0.5 * (1 - this.timeScale)).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    renderFireworks(ctx, this.ink, this.fireworks);
    if (this.state !== 'ready') renderHud(hudCtx);
    if (!coop || !coop.suppressStandardMessages(this.state, this.paused)) {
      renderMessages(hudCtx);
    }
    // The asteroid alert goes under co-op's question cards: a pilot answering must always see the sum and the boxes.
    if (alert !== null && this.state === 'playing' && !this.paused) renderAlert(hudCtx, alert);
    if (coop) {
      coop.renderArenaOverlays(ctx, this.ink, {
        time: this.time,
        state: this.state,
        stateTime: this.stateTime,
        paused: this.paused,
        reduceMotion: this.reduceMotion,
        coarse: this.coarse,
        soulsInFlight: this.souls.length,
      });
    }

    if (coop) {
      ctx.restore();
      coop.renderViewportChrome(ctx, this.ink, this.time);
    }
  }
}
