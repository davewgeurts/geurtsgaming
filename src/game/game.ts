/**
 * Hero arcade game: a small top-down shooter drawn as glowing line art.
 *
 * Phase one is fly + shoot. The ship's hull is tracked on its own so later phases
 * (typing to charge or repair, maths to steer) have something to plug into.
 */
import { textWidth, traceText } from './font';
import { DART, DRIFTER, HEX, SHIP, segments, trace, type Shape } from './shapes';

const SAND = '#ecdfd2';
const PINK = '#d98ac0';
const BEST_KEY = 'gg-arcade-best';
const MAX_HULL = 3;
const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'Space', 'Enter', 'KeyP',
]);

/** Keys that would scroll the page behind the game; swallowed while it is open. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End']);

type State = 'ready' | 'playing' | 'over';
type Kind = 'drifter' | 'dart' | 'hex';

const KINDS: Record<Kind, { shape: Shape; radius: number; hp: number; points: number }> = {
  drifter: { shape: DRIFTER, radius: 12, hp: 1, points: 50 },
  dart: { shape: DART, radius: 11, hp: 1, points: 100 },
  hex: { shape: HEX, radius: 15, hp: 2, points: 150 },
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

export interface GameOptions {
  /** Where the ship flies in from, e.g. the launch button: viewport position, and how large it is drawn there. */
  from?: { x: number; y: number; scale?: number };
  /** Called when the player asks to leave (Esc). */
  onExit: () => void;
  /** Short status messages for a screen-reader live region. */
  onStatus?: (message: string) => void;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const pad6 = (n: number) => String(n).padStart(6, '0');

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

  private state: State = 'ready';
  private stateTime = 0;
  private paused = false;
  private keys = new Set<string>();
  private touchId: number | null = null;
  private touch = { x: 0, y: 0 };

  private ship = { x: 0, y: 0, cooldown: 0, invulnerable: 0 };
  /** Size the ship is drawn at. Starts at the launch button's size and eases to the game's. */
  private shipScale = 1;
  private hull = MAX_HULL;
  private score = 0;
  private best = 0;
  private newBest = false;

  private wave = 0;
  private waveTime = 0;
  private banner = 0;
  private rest = 0;
  private queue: Spawn[] = [];

  private enemies: Enemy[] = [];
  private shots: Shot[] = [];
  private debris: Debris[] = [];
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
    if (!GAME_KEYS.has(code)) return;
    // Enter still activates a focused button (Exit). Space always belongs to the game,
    // so tabbing to Exit and then firing cannot end a run by accident.
    if (e.target instanceof HTMLButtonElement && code === 'Enter') return;
    e.preventDefault();
    if (e.repeat) return;

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
    if (e.pointerType !== 'mouse') {
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

  // ------------------------------------------------------------ game state

  private setState(state: State): void {
    this.state = state;
    this.stateTime = 0;
  }

  private begin(): void {
    this.hull = MAX_HULL;
    this.score = 0;
    this.newBest = false;
    this.enemies = [];
    this.shots = [];
    this.ship.cooldown = 0;
    this.ship.invulnerable = 1;
    if (this.state === 'over') {
      this.ship.x = this.homeX;
      this.ship.y = this.homeY;
    }
    this.setState('playing');
    this.startWave(1);
    this.opts.onStatus?.('Game started. Wave 1.');
  }

  private startWave(n: number): void {
    this.wave = n;
    this.waveTime = 0;
    this.banner = 2.2;
    this.rest = 0;
    this.queue = this.buildWave(n);
  }

  /** Each wave is chains of drifters, with darts from wave 2 and hexes from wave 3. */
  private buildWave(n: number): Spawn[] {
    const q: Spawn[] = [];
    const m = 40 * this.scale + 30;
    const spawnX = () => rand(this.inset.left + m, Math.max(this.inset.left + m + 1, this.w - this.inset.right - m));
    const chains = Math.min(6, 2 + Math.ceil(n / 2));
    const chainLength = Math.min(5, 3 + Math.floor(n / 3));
    const gap = Math.max(1.3, 2.6 - n * 0.15);
    let t = 1.5;
    for (let i = 0; i < chains; i++) {
      const x = spawnX();
      const phase = rand(0, Math.PI * 2);
      for (let k = 0; k < chainLength; k++) q.push({ at: t + k * 0.42, kind: 'drifter', x, phase });
      t += gap;
    }
    if (n >= 2) {
      for (let i = 0; i < Math.min(8, n + 1); i++) q.push({ at: rand(2.5, t + 1), kind: 'dart', x: spawnX(), phase: 0 });
    }
    if (n >= 3) {
      for (let i = 0; i < Math.min(3, Math.floor((n - 1) / 2)); i++) q.push({ at: rand(2, t), kind: 'hex', x: spawnX(), phase: 0 });
    }
    return q.sort((a, b) => a.at - b.at);
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

  private gameOver(): void {
    this.burst(SHIP, this.ship.x, this.ship.y, this.shipScale, 0, false);
    this.queue = [];
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

  // ---------------------------------------------------------------- update

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (!this.paused) this.update(dt);
    this.render();
  };

  private update(dt: number): void {
    this.time += dt;
    this.stateTime += dt;
    this.shake = Math.max(0, this.shake - dt);
    this.banner = Math.max(0, this.banner - dt);

    // Stars speed up once the ship launches, which is what sells the feeling of flying.
    const targetWarp = this.state === 'playing' ? 3.2 : this.state === 'over' ? 0.6 : 1;
    this.warp += (targetWarp - this.warp) * (1 - Math.exp(-dt * 1.8));
    for (const star of this.stars) {
      star.y += star.speed * this.warp * dt;
      if (star.y > this.h + 80) Object.assign(star, this.makeStar(-rand(10, 80)));
    }

    for (const d of this.debris) {
      d.age += dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.rot += d.spin * dt;
    }
    this.debris = this.debris.filter((d) => d.age < d.ttl);

    this.updateShip(dt);
    if (this.state === 'playing') this.updateWave(dt);
    this.updateEnemies(dt);
    this.updateShots(dt);
    if (this.state === 'playing') this.collide();

    this.enemies = this.enemies.filter((e) => !e.dead);
    this.shots = this.shots.filter((s) => !s.dead);
  }

  private updateShip(dt: number): void {
    const ship = this.ship;
    const k = 1 - Math.exp(-dt * 4);
    this.shipScale += (1.15 * this.scale - this.shipScale) * k;
    if (this.state === 'ready') {
      // Glide in from wherever the launch button was.
      ship.x += (this.homeX - ship.x) * k;
      ship.y += (this.homeY - ship.y) * k;
      return;
    }
    if (this.state !== 'playing') return;

    ship.invulnerable = Math.max(0, ship.invulnerable - dt);
    ship.cooldown = Math.max(0, ship.cooldown - dt);

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
    if ((keys.has('Space') || this.touchId !== null) && ship.cooldown <= 0) {
      ship.cooldown = 0.17;
      this.shots.push({ x: ship.x, y: ship.y - 18 * this.scale, vx: 0, vy: -680 * this.pace, hostile: false, dead: false });
    }
  }

  private updateWave(dt: number): void {
    this.waveTime += dt;
    while (this.queue.length && this.queue[0]!.at <= this.waveTime) this.spawn(this.queue.shift()!);
    if (!this.queue.length && !this.enemies.length) {
      this.rest += dt;
      if (this.rest > 1.4) {
        this.startWave(this.wave + 1);
        this.opts.onStatus?.(`Wave ${this.wave}.`);
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

    for (const s of this.shots) {
      if (s.dead) continue;
      if (s.hostile) {
        if (ship.invulnerable <= 0 && Math.hypot(s.x - ship.x, s.y - ship.y) < shipRadius + 3) {
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

    if (ship.invulnerable > 0) return;
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
    const room = this.w - this.inset.left - this.inset.right - 32;
    const width = textWidth(text, size);
    return width > room ? (size * room) / width : size;
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

    this.ink(SAND, 1, 1.8, () => {
      for (const s of this.shots) {
        if (s.hostile) continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x, s.y + 11 * sc);
      }
    });

    // The ship blinks while it cannot be hit, but never disappears on the ready or paused screens.
    const blinking = this.state === 'playing' && !this.paused && this.ship.invulnerable > 0;
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
    }
    ctx.restore();

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
      } else {
        if (blink) this.centred('PRESS SPACE TO START', mid, 20, alpha);
        this.centred('WASD OR ARROWS TO FLY - SPACE TO FIRE', mid + 46, 11, alpha * 0.8);
        this.centred('P TO PAUSE - ESC TO EXIT', mid + 70, 11, alpha * 0.8);
      }
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
}
