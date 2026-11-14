/**
 * The opening of the arcade demo.
 *
 * - Hangar: on their first visit the pilot picks their low-poly face, colour theme and one of three ships,
 *   then walks across the school's hangar floor and climbs in (hangar.ts). Returning pilots load their saved
 *   loadout automatically and walk straight in.
 * - Briefing: the ship sits on the runway of a low-poly base. Through the windscreen: the runway, the
 *   base's buildings, hills, and the same far-off planets the game is played over. On the comms screen
 *   the flight commander explains how to play. The pilot launches whenever they like.
 * - Take-off: the ship rolls, climbs out (the ground falls away and the sky slides into the place it
 *   has in the game), and goes supersonic (the stars stretch away from the point the ship is heading for).
 * - Handover: that point slides up and off the screen, which turns the stretched stars into the falling
 *   stars of the top-down game; the cockpit drops away and the ship itself rises into view.
 */
import { renderAvatarFrame, type Mood } from './avatar';
import { BASE_BG as BASE, BLUE, NEON, PINK, SAND, box3d, clamp, lerp, rand, smooth, type Ink } from './core';
import { fitTo, traceText, wrapText } from './font';
import { HANGAR_PICKER_SCRIPT, HANGAR_SCRIPT, Hangar, type HangarCue } from './hangar';
import { BRIEFING } from './lines';
import {
  DEFAULT_LOADOUT,
  PILOT_BY_ID,
  SHIP_BY_ID,
  THEME_BY_ID,
  loadSavedLoadout,
  saveLoadout,
  type PilotId,
  type PilotLoadout,
  type StorageLike,
} from './loadout';

export type { Ink };
export type IntroCue = 'radio' | 'liftoff' | 'sonic' | HangarCue;

/** How game.ts should draw the sky, and where the ship is, at this moment of the intro. */
export interface IntroView {
  lift: number;
  horizon: number | null;
  vanish: { x: number; y: number } | null;
  speed: number;
  stretch: number;
  settle: number;
  ship: number;
  shake: number;
  sky: ((ctx: CanvasRenderingContext2D) => void) | null;
  curtain: number;
}

export interface IntroFrame {
  ctx: CanvasRenderingContext2D;
  ink: Ink;
  w: number;
  h: number;
  inset: { top: number; right: number; bottom: number; left: number };
  time: number;
  touch: boolean;
}

export interface IntroOptions {
  storage?: StorageLike | null;
  onLoadoutChange?: (loadout: PilotLoadout) => void;
  onAnnounce?: (message: string) => void;
}

// The take-off, in seconds: rolling down the runway, climbing out, supersonic, then the handover to the game.
const ROLL = 2.1;
const CLIMB = 2.3;
const SONIC = 1.7;
const HANDOVER = 1.3;
const T_CLIMB = ROLL;
const T_SONIC = T_CLIMB + CLIMB;
const T_HANDOVER = T_SONIC + SONIC;
const T_END = T_HANDOVER + HANDOVER;

const EYE = 2.2;
const PITCH = 0.6;
const TOP_SPEED = 210;
const NEAR = 1;
const RUNWAY_HALF = 7;
const RUNWAY_END = 440;
const GRID = 40;
const FADE_FROM = 30;
const FADE_TO = 110;

const TYPE_RATE = 46;
const LINE_HOLD = 2.3;
const BREATH = 0.45;
const FADE_IN = 0.45;

const { cyan: CYAN, lime: LIME, yellow: YELLOW, violet: VIOLET } = NEON;

type BlockKind = 'box' | 'tower' | 'dome' | 'mast';
interface Block { kind: BlockKind; x: number; z: number; w: number; d: number; h: number; tint: string; dish: boolean }

export class Intro {
  phase: 'hangar' | 'brief' | 'launch';
  /** Seconds since this phase began. */
  t = 0;
  done = false;
  loadout: PilotLoadout;
  private hangar: Hangar | null;
  private readonly storage?: StorageLike | null;
  private readonly onLoadoutChange?: (loadout: PilotLoadout) => void;
  private readonly onAnnounce?: (message: string) => void;

  private camZ = 0;
  private camY = EYE;
  private speedNow = 0;
  private said = '';
  private saidAge = 0;
  private voiced = false;
  private rest = 0;
  private line = -1;
  private wished = false;
  private warned = false;
  private boomed = false;
  private bobbleX = 0;
  private bobbleVx = 0;
  private bobbleY = 0;
  private bobbleVy = 0;
  private readonly blocks: Block[] = [];
  private readonly hills: number[] = Array.from({ length: 31 }, (_, i) => (i % 2 ? rand(0.45, 1) : rand(0.1, 0.5)));

  constructor(
    private readonly reduceMotion: boolean,
    private readonly cue: (cue: IntroCue) => void,
    private readonly radio?: {
      say(text: string): boolean;
      busy(): boolean;
      sayPilot?(pilot: PilotId, text: string): boolean;
    },
    opts?: IntroOptions,
  ) {
    this.storage = opts?.storage;
    this.onLoadoutChange = opts?.onLoadoutChange;
    this.onAnnounce = opts?.onAnnounce;
    const saved = loadSavedLoadout(this.storage);
    const hasSaved = saved !== null;
    this.loadout = saved ? { ...saved } : { ...DEFAULT_LOADOUT };

    // First-time players always get the hangar picker (even with reduced motion, where it holds steady and skips the walk).
    // Returning players who asked for reduced motion go straight to the cockpit as before.
    const showHangar = !reduceMotion || !hasSaved;
    this.hangar = showHangar
      ? new Hangar(cue, {
          initialLoadout: this.loadout,
          hasSavedLoadout: hasSaved,
          reduceMotion,
          onCommitLoadout: (chosen) => this.commitLoadout(chosen),
          onAnnounce: this.onAnnounce,
          onPilotVoice: (pilot, text) => {
            this.radio?.sayPilot?.(pilot, text);
          },
        })
      : null;
    this.phase = this.hangar ? 'hangar' : 'brief';

    this.blocks.push({ kind: 'tower', x: -24, z: 96, w: 5, d: 5, h: 30, tint: CYAN, dish: false });
    let side = 1;
    for (let z = 46; z < 640; z += rand(26, 52)) {
      if (Math.abs(z - 96) < 22 && side < 0) {
        side = -side;
        continue;
      }
      const roll = Math.random();
      const kind: BlockKind = roll < 0.55 ? 'box' : roll < 0.78 ? 'dome' : 'mast';
      const w = kind === 'mast' ? 1 : kind === 'dome' ? rand(12, 22) : rand(8, 24);
      this.blocks.push({
        kind, z, w,
        x: side * (RUNWAY_HALF + 6 + w / 2 + rand(0, 46)),
        d: kind === 'box' ? rand(8, 22) : w,
        h: kind === 'mast' ? rand(14, 28) : kind === 'dome' ? w / 2 : rand(4, 17),
        tint: Math.random() < 0.3 ? VIOLET : CYAN,
        dish: kind === 'mast' && Math.random() < 0.5,
      });
      side = Math.random() < 0.72 ? -side : side;
    }
  }

  private commitLoadout(chosen: PilotLoadout): void {
    this.loadout = { ...chosen };
    saveLoadout(this.loadout, this.storage);
    this.onLoadoutChange?.({ ...this.loadout });
  }

  /** True while the hangar's 3-step picker is open and waiting for a choice. */
  get isPickingLoadout(): boolean {
    return this.phase === 'hangar' && Boolean(this.hangar?.isPicking);
  }

  /** Open the hangar customiser (from boarding or from the cockpit briefing). */
  openCustomizer(): void {
    if (this.phase === 'launch') return;
    if (!this.hangar) {
      this.hangar = new Hangar(this.cue, {
        initialLoadout: this.loadout,
        hasSavedLoadout: false,
        reduceMotion: this.reduceMotion,
        onCommitLoadout: (chosen) => this.commitLoadout(chosen),
        onAnnounce: this.onAnnounce,
        onPilotVoice: (pilot, text) => {
          this.radio?.sayPilot?.(pilot, text);
        },
      });
    } else {
      this.hangar.done = false;
      this.hangar.openCustomizer();
    }
    this.phase = 'hangar';
    this.t = 0;
    this.line = -1;
    this.said = '';
    this.saidAge = 0;
    this.rest = 0;
  }

  /** Commit the currently focused pilot, theme and ship in the hangar picker and start boarding immediately. */
  quickFly(): void {
    if (this.phase === 'hangar' && this.hangar?.isPicking) {
      this.hangar.quickFly();
      this.loadout = { ...this.hangar.loadout };
    }
  }

  wantsKey(key: string): boolean {
    return this.phase === 'hangar' && Boolean(this.hangar?.wantsKey(key));
  }

  typeKey(key: string): void {
    if (this.phase === 'hangar' && this.hangar) {
      this.hangar.typeKey(key);
      this.loadout = { ...this.hangar.loadout };
    }
  }

  command(code: string): boolean {
    if (this.phase === 'hangar' && this.hangar) {
      const handled = this.hangar.command(code);
      this.loadout = { ...this.hangar.loadout };
      return handled;
    }
    if (this.phase === 'brief' && code === 'KeyH') {
      this.openCustomizer();
      return true;
    }
    return false;
  }

  hover(x: number, y: number): void {
    if (this.phase === 'hangar' && this.hangar) {
      this.hangar.hover(x, y);
      this.loadout = { ...this.hangar.loadout };
    }
  }

  pick(x: number, y: number): boolean {
    if (this.phase === 'hangar' && this.hangar) {
      const picked = this.hangar.pick(x, y);
      this.loadout = { ...this.hangar.loadout };
      return picked;
    }
    return false;
  }

  /** What happens before take-off, and every line of the briefing, for a screen reader. */
  static script(touch: boolean, hangar: boolean, picking = false): string {
    const opening = picking ? HANGAR_PICKER_SCRIPT : HANGAR_SCRIPT;
    return `${hangar || picking ? `${opening} Then: in` : 'In'} the cockpit, on the runway. ${BRIEFING[touch ? 'touch' : 'keys'].join(' ')}`;
  }

  /** The pilot has pressed the button (or tapped): move things on, whatever is happening. */
  advance(): void {
    if (this.isPickingLoadout) return;
    if (this.phase === 'hangar') this.hangar?.skip();
    else if (this.phase === 'brief') this.launch();
    else this.skip();
  }

  private say(text: string): void {
    this.said = text;
    this.saidAge = 0;
    this.rest = 0;
    this.cue('radio');
    this.voiced = this.radio?.say(text) ?? false;
  }

  private briefingLine(index: number, touch: boolean): string {
    const lines = BRIEFING[touch ? 'touch' : 'keys'];
    if (index === 0) {
      const pilot = PILOT_BY_ID[this.loadout.pilot].name;
      const ship = SHIP_BY_ID[this.loadout.ship].name;
      return `COMMAND TO ${pilot} IN THE ${ship}. WELCOME ABOARD!`;
    }
    return lines[index]!;
  }

  /** The pilot has asked to go. */
  launch(): void {
    if (this.phase !== 'brief') return;
    this.phase = 'launch';
    this.t = 0;
    if (!this.reduceMotion) {
      this.bobbleVy += 28;
      this.bobbleVx += 18;
    }
    this.say(BRIEFING.engines);
    this.cue('liftoff');
    if (this.reduceMotion) this.skip();
  }

  /** Cut the take-off short: straight to the moment the game takes over. */
  skip(): void {
    if (this.phase !== 'launch' || this.t >= T_HANDOVER) return;
    this.t = T_HANDOVER;
    this.camY = FADE_TO + 1;
    this.wished = this.warned = true;
    this.say(BRIEFING.luck);
  }

  private stepBobble(dt: number): void {
    if (this.reduceMotion) {
      this.bobbleX = 0;
      this.bobbleY = 0;
      this.bobbleVx = 0;
      this.bobbleVy = 0;
      return;
    }
    const step = Math.min(dt, 0.05);
    const launching = this.phase === 'launch';
    const sonic = launching ? smooth((this.t - T_SONIC) / SONIC) : 0;
    const driveX = launching
      ? Math.sin(this.t * 27) * (2.6 + sonic * 3.8) + sonic * 3.2
      : Math.sin(this.t * 3.2) * 1.1;
    const driveY = launching
      ? Math.cos(this.t * 33) * (1.8 + sonic * 2.4) + sonic * 2.6
      : Math.cos(this.t * 6.4) * 0.45;
    this.bobbleVx += ((driveX - this.bobbleX) * 135 - this.bobbleVx * 7.2) * step;
    this.bobbleVy += ((driveY - this.bobbleY) * 150 - this.bobbleVy * 7.8) * step;
    this.bobbleX = clamp(this.bobbleX + this.bobbleVx * step, -9, 9);
    this.bobbleY = clamp(this.bobbleY + this.bobbleVy * step, -5, 6);
  }

  update(dt: number, touch: boolean): void {
    this.t += dt;
    if (this.phase === 'hangar' && this.hangar) {
      this.hangar.update(dt);
      if (this.hangar.done) {
        this.loadout = { ...this.hangar.loadout };
        this.phase = 'brief';
        this.t = 0;
        this.line = -1;
      }
      return;
    }
    this.stepBobble(dt);
    this.saidAge += dt;
    if (this.phase === 'brief') {
      const lines = BRIEFING[touch ? 'touch' : 'keys'];
      const typed = this.saidAge > this.said.length / TYPE_RATE;
      if (this.voiced && typed && !this.radio!.busy()) this.rest += dt;
      const spoken = this.voiced ? this.rest > BREATH : this.saidAge > this.said.length / TYPE_RATE + LINE_HOLD;
      if (this.line < 0 || (spoken && this.line < lines.length - 1)) {
        this.line += 1;
        this.say(this.briefingLine(this.line, touch));
      }
      return;
    }
    const t = this.t;
    const pitch = this.pitch;
    this.speedNow = t < ROLL ? TOP_SPEED * (t / ROLL) ** 2 : TOP_SPEED + (t - ROLL) * 70;
    this.camZ += this.speedNow * Math.cos(pitch) * dt;
    this.camY += this.speedNow * Math.sin(pitch) * dt;
    if (!this.wished && t > T_CLIMB + 0.5) {
      this.wished = true;
      this.say(BRIEFING.luck);
    }
    if (!this.warned && t > T_SONIC) {
      this.warned = true;
      this.say(BRIEFING.sonic);
    }
    if (!this.boomed && t >= T_HANDOVER) {
      this.boomed = true;
      this.cue('sonic');
    }
    if (t >= T_END) this.done = true;
  }

  private get pitch(): number {
    return this.phase === 'launch' ? PITCH * smooth((this.t - T_CLIMB) / CLIMB) : 0;
  }

  private get ground(): number {
    return 1 - clamp((this.camY - FADE_FROM) / (FADE_TO - FADE_FROM), 0, 1);
  }

  private get handover(): number {
    return this.phase === 'launch' ? clamp((this.t - T_HANDOVER) / HANDOVER, 0, 1) : 0;
  }

  private dash(h: number): number {
    return clamp(h * 0.27, 104, 240);
  }
  private eye(h: number): number {
    return (h - this.dash(h)) * 0.56;
  }
  private focal(w: number, h: number): number {
    return 0.9 * Math.min(w, h * 1.25);
  }

  get mood(): Mood {
    if (this.saidAge < this.said.length / TYPE_RATE) return 'talk';
    return this.wished ? 'happy' : 'calm';
  }

  view(w: number, h: number): IntroView {
    if (this.phase === 'hangar' && this.hangar) {
      this.hangar.layout(w, h);
      return {
        lift: 0,
        horizon: null,
        vanish: null,
        speed: 0,
        stretch: 1,
        settle: 0,
        ship: 0,
        shake: 0,
        sky: this.hangar.clipSky,
        curtain: this.hangar.curtain,
      };
    }
    const launching = this.phase === 'launch';
    const t = launching ? this.t : 0;
    const climb = launching ? smooth((t - T_CLIMB) / CLIMB) : 0;
    const sonic = launching ? smooth((t - T_SONIC) / SONIC) : 0;
    const hand = this.handover;
    const eye = this.eye(h);
    const horizon = eye + this.focal(w, h) * Math.tan(this.pitch);
    const away = hand > 0 ? h * 0.9 * (Math.exp(7 * hand) - 1) : 0;
    const rumble = launching && !this.reduceMotion ? (t < T_CLIMB ? 0.12 * (t / ROLL) : 0.1 + 0.25 * sonic) * (1 - hand) : 0;
    return {
      lift: -h * 0.15 * (1 - climb),
      horizon: this.ground > 0 && horizon < h ? horizon : null,
      vanish: hand >= 1 ? null : { x: w / 2, y: eye - away },
      speed: launching ? 0.5 * climb + 6.5 * sonic - 3.8 * smooth(hand) : 0,
      stretch: 1 + 4 * sonic * (1 - smooth(hand)),
      settle: smooth(hand),
      ship: smooth(hand),
      shake: rumble,
      sky: null,
      curtain: this.hangar && this.phase === 'brief' ? Math.max(0, 1 - this.t / FADE_IN) : 0,
    };
  }

  // ------------------------------------------------------------ the ground

  renderGround(f: IntroFrame): void {
    if (this.phase === 'hangar') {
      this.hangar?.render({ ...f, reduceMotion: this.reduceMotion });
      return;
    }
    const solid = this.ground;
    if (solid <= 0) return;
    const { ctx, ink, w, h, time } = f;
    const focal = this.focal(w, h);
    const cx = w / 2;
    const eye = this.eye(h);
    const pitch = this.pitch;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const horizon = eye + focal * Math.tan(pitch);
    if (horizon > h + 80) return;
    const { camY, camZ } = this;

    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
      let ady = ay - camY, adz = az - camZ, bdy = by - camY, bdz = bz - camZ;
      let a = adz * cp + ady * sp;
      let b = bdz * cp + bdy * sp;
      if (a < NEAR && b < NEAR) return;
      if (a < NEAR || b < NEAR) {
        const k = (NEAR - a) / (b - a);
        const mx = ax + (bx - ax) * k, my = ady + (bdy - ady) * k, mz = adz + (bdz - adz) * k;
        if (a < NEAR) {
          ax = mx; ady = my; adz = mz; a = NEAR;
        } else {
          bx = mx; bdy = my; bdz = mz; b = NEAR;
        }
      }
      ctx.moveTo(cx + (focal * ax) / a, eye - (focal * (ady * cp - adz * sp)) / a);
      ctx.lineTo(cx + (focal * bx) / b, eye - (focal * (bdy * cp - bdz * sp)) / b);
    };

    const step = (w * 1.2) / (this.hills.length - 1);
    const hillX = (i: number) => -w * 0.1 + i * step;
    const hillY = (i: number) => horizon - this.hills[i]! * h * 0.085;
    ctx.beginPath();
    ctx.moveTo(-w * 0.1, horizon + 2);
    this.hills.forEach((_, i) => ctx.lineTo(hillX(i), hillY(i)));
    ctx.lineTo(w * 1.1, horizon + 2);
    ctx.closePath();
    ctx.fillStyle = BASE;
    ctx.fill();
    ink(VIOLET, 0.42 * solid, 1, () => {
      this.hills.forEach((_, i) => (i ? ctx.lineTo(hillX(i), hillY(i)) : ctx.moveTo(hillX(i), hillY(i))));
      for (let i = 1; i < this.hills.length - 1; i += 2) {
        ctx.moveTo(hillX(i), hillY(i));
        ctx.lineTo(hillX(i) + step * 0.3, horizon);
      }
      ctx.moveTo(0, horizon);
      ctx.lineTo(w, horizon);
    }, false);

    const first = Math.ceil((camZ + NEAR) / GRID) * GRID;
    [[0, 6, 0.36], [6, 14, 0.22], [14, 26, 0.12]].forEach(([from, to, alpha]) => {
      ink(BLUE, alpha! * solid, 1, () => {
        for (let i = from!; i < to!; i++) seg(-420, 0, first + i * GRID, 420, 0, first + i * GRID);
      }, false);
    });
    ink(BLUE, 0.2 * solid, 1, () => {
      for (let k = 1; k <= 10; k++) {
        seg(-k * GRID, 0, camZ + NEAR, -k * GRID, 0, camZ + 1040);
        seg(k * GRID, 0, camZ + NEAR, k * GRID, 0, camZ + 1040);
      }
    }, false);

    if (camZ + NEAR < RUNWAY_END) {
      ink(SAND, 0.85 * solid, 1.4, () => {
        seg(-RUNWAY_HALF, 0, -30, -RUNWAY_HALF, 0, RUNWAY_END);
        seg(RUNWAY_HALF, 0, -30, RUNWAY_HALF, 0, RUNWAY_END);
        seg(-RUNWAY_HALF, 0, RUNWAY_END, RUNWAY_HALF, 0, RUNWAY_END);
        for (let z = 0; z < RUNWAY_END - 30; z += 24) seg(0, 0, z, 0, 0, z + 10);
        for (let x = -5; x <= 5; x += 2) seg(x, 0, RUNWAY_END - 20, x, 0, RUNWAY_END - 6);
      });
      const beat = this.reduceMotion ? 1 : Math.floor(time * 9);
      for (const lit of [false, true]) {
        ink(lit ? YELLOW : CYAN, (lit ? 1 : 0.45) * solid, lit ? 2 : 1.2, () => {
          for (let i = 0; i * 24 < RUNWAY_END; i++) {
            if ((((i - beat) % 5) + 5) % 5 === 0 !== lit) continue;
            seg(-RUNWAY_HALF - 0.8, 0, i * 24, -RUNWAY_HALF - 0.8, 1, i * 24);
            seg(RUNWAY_HALF + 0.8, 0, i * 24, RUNWAY_HALF + 0.8, 1, i * 24);
          }
        }, lit);
      }
    }

    const box = (x: number, y: number, z: number, bw: number, bh: number, bd: number): void =>
      box3d(seg, x, y, z, bw, bh, bd, false);
    for (const tint of [CYAN, VIOLET]) {
      ink(tint, 0.6 * solid, 1.1, () => {
        for (const b of this.blocks) {
          if (b.tint !== tint || b.z + b.d < camZ + NEAR || b.z > camZ + 900) continue;
          if (b.kind === 'box') {
            box(b.x, 0, b.z, b.w, b.h, b.d);
          } else if (b.kind === 'tower') {
            box(b.x, 0, b.z, b.w, b.h, b.d);
            box(b.x, b.h, b.z - 2.5, b.w * 2, 4, b.d * 2);
            seg(b.x, b.h + 4, b.z + b.d / 2, b.x, b.h + 11, b.z + b.d / 2);
          } else if (b.kind === 'dome') {
            const r = b.w / 2;
            const rings = [[0, 1], [0.55, 0.8], [0.88, 0.42], [1, 0]] as const;
            for (let i = 0; i < 8; i++) {
              const a0 = (i * Math.PI) / 4, a1 = ((i + 1) * Math.PI) / 4;
              for (let k = 0; k < 3; k++) {
                const [y0, r0] = rings[k]!;
                const [y1, r1] = rings[k + 1]!;
                seg(b.x + Math.cos(a0) * r0 * r, y0 * r, b.z + r + Math.sin(a0) * r0 * r, b.x + Math.cos(a1) * r0 * r, y0 * r, b.z + r + Math.sin(a1) * r0 * r);
                seg(b.x + Math.cos(a0) * r0 * r, y0 * r, b.z + r + Math.sin(a0) * r0 * r, b.x + Math.cos(a0) * r1 * r, y1 * r, b.z + r + Math.sin(a0) * r1 * r);
              }
            }
          } else {
            seg(b.x, 0, b.z, b.x, b.h, b.z);
            seg(b.x - 1.6, b.h * 0.62, b.z, b.x + 1.6, b.h * 0.62, b.z);
            if (b.dish) {
              const a = time * 2.2 + b.z;
              seg(b.x - Math.cos(a) * 3.4, b.h, b.z - Math.sin(a) * 3.4, b.x + Math.cos(a) * 3.4, b.h, b.z + Math.sin(a) * 3.4);
            }
          }
        }
      }, false);
    }
    if (Math.floor(time * 2.5) % 2 === 0) {
      ink('#ff3552', solid, 2.2, () => {
        for (const b of this.blocks) {
          if ((b.kind !== 'mast' && b.kind !== 'tower') || b.z < camZ + NEAR || b.z > camZ + 900) continue;
          const top = b.kind === 'tower' ? b.h + 11 : b.h;
          const z = b.kind === 'tower' ? b.z + b.d / 2 : b.z;
          seg(b.x, top, z, b.x, top + 0.7, z);
        }
      });
    }

    // Classmate 2-ship formation streaking overhead down the runway & pulling up into the stars during take-off!
    if (this.phase === 'launch' && !this.reduceMotion && this.t > 0.1 && this.t < T_SONIC + 0.8) {
      this.renderClassmateFlyby(ink, seg, solid);
    }
  }

  private renderClassmateFlyby(
    ink: Ink,
    seg: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => void,
    solid: number,
  ): void {
    const u = clamp((this.t - 0.1) / 4.2, 0, 1);
    const fade = Math.min(1, u * 6, (1 - u) * 3.5) * Math.max(0.35, solid);
    if (fade <= 0.02) return;

    const wingmen = [
      { side: -1, lag: 0, col: CYAN, trailCol: SAND },
      { side: 1, lag: 0.08, col: PINK, trailCol: YELLOW },
    ] as const;

    for (const wm of wingmen) {
      const wu = clamp(u - wm.lag, 0, 1);
      if (wu <= 0) continue;
      const climb = wu * wu;
      const wx = wm.side * (8.5 + wu * 14);
      const wy = this.camY + 7.5 + climb * 72;
      const wz = this.camZ + 22 + wu * 270;
      const pitchUp = climb * 0.58;
      const bank = wm.side * (0.18 + wu * 0.25);
      const cb = Math.cos(bank);
      const sb = Math.sin(bank);
      const cp = Math.cos(pitchUp);
      const sp = Math.sin(pitchUp);
      const J = (lx: number, ly: number, lz: number): [number, number, number] => {
        const rx = lx * cb - ly * sb;
        const ry = lx * sb + ly * cb;
        return [wx + rx, wy + ry * cp + lz * sp, wz - ry * sp + lz * cp];
      };
      const jetSeg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
        const [x0, y0, z0] = J(ax, ay, az);
        const [x1, y1, z1] = J(bx, by, bz);
        seg(x0, y0, z0, x1, y1, z1);
      };

      // Low-poly 3D delta classmate fighter:
      ink(wm.col, 0.92 * fade, 1.5, () => {
        jetSeg(0, 0, 4.2, -3.1, -0.15, -2.4);
        jetSeg(0, 0, 4.2, 3.1, -0.15, -2.4);
        jetSeg(-3.1, -0.15, -2.4, 0, 0.2, -1.6);
        jetSeg(3.1, -0.15, -2.4, 0, 0.2, -1.6);
        jetSeg(0, 0, 4.2, 0, 0.85, -1.8);
        jetSeg(0, 0.85, -1.8, 0, 0.2, -2.6);
        jetSeg(-1.1, 0.1, -2.1, -1.35, 0.95, -2.7);
        jetSeg(1.1, 0.1, -2.1, 1.35, 0.95, -2.7);
      });
      // Twin glowing engine contrails:
      ink(wm.trailCol, 0.55 * fade, 1.2, () => {
        const tailLen = lerp(8, 34, wu);
        for (const ts of [-2.85, 2.85]) {
          const [tx0, ty0, tz0] = J(ts, -0.15, -2.5);
          const [tx1, ty1, tz1] = J(ts, -0.35, -2.5 - tailLen);
          seg(tx0, ty0, tz0, tx1, ty1, tz1);
        }
      }, false);
    }
  }

  // ----------------------------------------------------------- the cockpit

  renderCockpit(f: IntroFrame): void {
    const { ctx, ink, w, h, inset, time, touch } = f;
    const hand = this.handover;
    if (hand >= 1 || this.phase === 'hangar') {
      return;
    }
    const theme = THEME_BY_ID[this.loadout.theme];
    const shipKind = this.loadout.ship;
    const launching = this.phase === 'launch';
    const dash = this.dash(h);
    const eye = this.eye(h);
    const rumble = launching && !this.reduceMotion ? this.view(w, h).shake * 9 : 0;
    const ox = rumble ? rand(-1, 1) * rumble : 0;
    const oy = (rumble ? rand(-1, 1) * rumble : 0) + hand * hand * (dash + 90);
    const fade = 1 - smooth(hand * 1.4);
    const top = h - dash + oy;
    const shoulder = top + dash * 0.3;

    if (!launching) {
      const alpha = Math.min(1, this.t / 0.6);
      const ask = touch ? 'TAP TO LAUNCH' : 'PRESS SPACE TO LAUNCH';
      const size = fitTo(ask, 20, w - 40);
      if (time % 1.1 < 0.75) ink(theme.hull, alpha, 1.8, () => traceText(ctx, ask, w / 2, eye * 0.42, size, 'center'));
      const subHint = touch ? 'HANGAR BUTTON TO CHANGE PILOT OR SHIP' : 'PRESS H TO CHANGE PILOT OR SHIP';
      ink(SAND, 0.55 * alpha, 1, () => traceText(ctx, subHint, w / 2, eye * 0.42 + size + 10, fitTo(subHint, 7.5, w - 40), 'center'), false);
    } else {
      if (this.t > T_SONIC && hand < 0.4) {
        const size = fitTo('SUPERSONIC', 26, w - 40);
        const flash = this.reduceMotion || Math.floor(time * 9) % 2 === 0;
        ink(flash ? CYAN : YELLOW, 1, 2, () => traceText(ctx, 'SUPERSONIC', w / 2, eye * 0.42, size, 'center'));
      }
    }

    const sight = fade * 0.55;
    if (sight > 0) {
      const rung = 46;
      const slide = (this.focal(w, h) * Math.tan(this.pitch)) % rung;
      ink(LIME, sight, 1.1, () => {
        const y = eye + oy * 0.2;
        for (const s of [-1, 1]) {
          ctx.moveTo(w / 2 + s * 34, y - 9);
          ctx.lineTo(w / 2 + s * 22, y - 9);
          ctx.lineTo(w / 2 + s * 22, y + 9);
          ctx.lineTo(w / 2 + s * 34, y + 9);
          for (let k = -2; k <= 2; k++) {
            const ry = y + slide + k * rung;
            if (Math.abs(ry - y) < 16 || ry > top - 12) continue;
            ctx.moveTo(w / 2 + s * 52, ry);
            ctx.lineTo(w / 2 + s * 74, ry);
          }
        }
      }, false);
    }

    // Canopy struts: narrower on Swift, classic on Starhawk, wider armoured frame on Bastion, tinted to Theme!
    const headRatio = shipKind === 'swift' ? 0.12 : shipKind === 'bastion' ? 0.23 : 0.17;
    const footRatio = shipKind === 'swift' ? 0.28 : shipKind === 'bastion' ? 0.4 : 0.34;
    ink(theme.hull, 0.88 * fade, 1.5, () => {
      for (const s of [-1, 1]) {
        const foot = w / 2 + s * w * footRatio;
        const head = w / 2 + s * w * headRatio;
        ctx.moveTo(foot + ox, top);
        ctx.lineTo(head + ox, -12 + oy * 0.4);
        ctx.moveTo(foot + s * 12 + ox, top);
        ctx.lineTo(head + s * 10 + ox, -12 + oy * 0.4);
      }
      if (shipKind === 'bastion') {
        // Upper armoured cross-brace on the heavy gunship canopy.
        const barY = Math.max(22, eye * 0.16) + oy * 0.35;
        ctx.moveTo(w / 2 - w * (headRatio + 0.03) + ox, barY);
        ctx.lineTo(w / 2 + w * (headRatio + 0.03) + ox, barY);
      }
    });

    const outline = (): void => {
      ctx.moveTo(-12 + ox, shoulder);
      ctx.lineTo(w * 0.16 + ox, top);
      ctx.lineTo(w * 0.84 + ox, top);
      ctx.lineTo(w + 12 + ox, shoulder);
    };
    ctx.beginPath();
    outline();
    ctx.lineTo(w + 12, h + dash + 200);
    ctx.lineTo(-12, h + dash + 200);
    ctx.closePath();
    ctx.fillStyle = BASE;
    ctx.fill();
    ink(theme.hull, 0.95, 1.7, outline);
    ink(theme.accent, 0.35, 1, () => {
      ctx.moveTo(w * 0.16 + ox + 6, top + 7);
      ctx.lineTo(w * 0.84 + ox - 6, top + 7);
    }, false);
    this.renderDashboardBobblehead(f, top, ox, fade);

    const wide = w >= 720;
    const left = Math.max(inset.left + 14, w * (wide ? 0.07 : 0.045)) + ox;
    const right = w - Math.max(inset.right + 14, w * (wide ? 0.07 : 0.045)) + ox;
    const panelTop = top + dash * 0.3 + 12;
    const room = h - inset.bottom - 10 + oy - panelTop;
    const screen = clamp(Math.min(room, w * 0.2), 44, 104);
    this.renderCommander(f, left, panelTop, screen);

    const textX = left + screen + 14;
    const big = w >= 1000 && h >= 640;
    const size = big ? 13 : wide ? 11 : 9;
    const textWidthMax = (wide ? Math.min(right - 250, textX + 560) : right) - textX;
    ink(CYAN, 0.8, 1.1, () => traceText(ctx, 'FLIGHT COMMAND', textX, panelTop + 1, big ? 9 : 7), false);
    const lines = wrapText(this.said, size, textWidthMax);
    let budget = Math.floor(this.saidAge * TYPE_RATE);
    ink(SAND, 1, 1.4, () => {
      lines.forEach((line, i) => {
        if (budget <= 0) return;
        traceText(ctx, line.slice(0, budget), textX, panelTop + (big ? 20 : 16) + i * (size + 7), size);
        budget -= line.length + 1;
      });
    });

    if (wide) {
      const gx = right - 220;
      const speed = Math.round(this.speedNow * 9);
      const height = Math.round((this.camY - EYE) * 12);
      ink(LIME, 0.9, 1.2, () => {
        traceText(ctx, 'SPEED', gx, panelTop + 1, 7);
        traceText(ctx, String(speed).padStart(4, '0'), gx, panelTop + 14, 14);
        traceText(ctx, 'HEIGHT', gx + 96, panelTop + 1, 7);
        traceText(ctx, String(height).padStart(4, '0'), gx + 96, panelTop + 14, 14);
      }, false);
      const power = launching ? clamp(this.t / ROLL, 0, 1) : 0;
      for (const lit of [true, false]) {
        ink(lit ? theme.thruster : SAND, lit ? 1 : 0.25, 1.4, () => {
          for (let i = 0; i < 16; i++) {
            if (i < Math.round(power * 16) !== lit) continue;
            ctx.moveTo(gx + i * 7, panelTop + 40);
            ctx.lineTo(gx + i * 7, panelTop + 50);
          }
        }, false);
      }
      const rx = right - 30;
      const ry = panelTop + 26;
      ink(theme.accent, 0.65, 1, () => {
        for (let i = 0; i <= 8; i++) {
          const a = (i * Math.PI) / 4;
          if (i) ctx.lineTo(rx + Math.cos(a) * 24, ry + Math.sin(a) * 24);
          else ctx.moveTo(rx + 24, ry);
        }
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx + Math.cos(time * 2.4) * 24, ry + Math.sin(time * 2.4) * 24);
      }, false);
    }
  }

  private renderDashboardBobblehead(f: IntroFrame, coamingY: number, ox: number, fade: number): void {
    if (fade <= 0.05) return;
    const { ctx, ink, w, h, time } = f;
    const theme = THEME_BY_ID[this.loadout.theme];
    const pilotSpec = PILOT_BY_ID[this.loadout.pilot];
    const box = clamp(this.dash(h) * 0.3, 30, 44);
    const anchorX = clamp(w * 0.68, Math.min(w * 0.76, w / 2 + 88), w * 0.8) + ox;
    const baseY = coamingY;
    const springH = Math.max(8, 10 - this.bobbleY * 0.55);
    const headCx = anchorX + this.bobbleX;
    const neckY = baseY - springH;

    // Magnetic dashboard pedestal + 4-coil wireframe spring on the coaming:
    ink(theme.accent, 0.85 * fade, 1.3, () => {
      ctx.moveTo(anchorX - 9, baseY);
      ctx.lineTo(anchorX - 7, baseY - 3);
      ctx.lineTo(anchorX + 7, baseY - 3);
      ctx.lineTo(anchorX + 9, baseY);
      const coils = 4;
      ctx.moveTo(anchorX, baseY - 3);
      for (let i = 1; i <= coils; i++) {
        const u = i / (coils + 1);
        const side = i % 2 === 0 ? -1 : 1;
        ctx.lineTo(lerp(anchorX, headCx, u) + side * 4.2, lerp(baseY - 3, neckY, u));
      }
      ctx.lineTo(headCx, neckY);
    }, false);

    const launching = this.phase === 'launch';
    const mood: Mood =
      launching && this.t > T_SONIC
        ? 'fierce'
        : launching
          ? 'laugh'
          : 'happy';
    const yaw = this.reduceMotion
      ? -0.2
      : -0.18 + this.bobbleX * 0.045 + Math.sin(time * 2.1) * 0.08;
    const pitch = this.reduceMotion
      ? 0.04
      : clamp(0.03 - this.bobbleY * 0.035, -0.22, 0.22);

    renderAvatarFrame({
      ctx,
      ink,
      who: pilotSpec.id,
      x: headCx - box / 2,
      y: neckY - box * 0.86,
      box,
      yaw,
      pitch,
      mood,
      time,
      cutRatio: 0,
      cyRatio: 0.52,
      sizeRatio: 0.34,
      fade,
      headColor: pilotSpec.colors.base,
      headAlpha: 0.9,
      headWidth: 1.25,
      faceColor: pilotSpec.colors.face,
      faceWidth: 1.55,
      frameAlpha: 0,
      frameGlow: false,
    });
  }

  private renderCommander(f: IntroFrame, x: number, y: number, box: number): void {
    const { ctx, ink, time } = f;
    const mood = this.mood;
    const yaw = Math.sin(time * 0.7) * 0.22;
    const pitch = 0.04 + (mood === 'talk' && !this.reduceMotion ? Math.sin(time * 7) * 0.035 : 0);
    renderAvatarFrame({
      ctx,
      ink,
      who: 'commander',
      x,
      y,
      box,
      yaw,
      pitch,
      mood,
      time,
      headColor: CYAN,
      faceColor: mood === 'happy' ? LIME : SAND,
      frameColor: CYAN,
      scanlines: true,
    });
  }
}
