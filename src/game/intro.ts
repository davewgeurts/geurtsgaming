/**
 * The opening of the arcade demo, seen from the pilot's seat.
 *
 * - Briefing: the ship sits on the runway of a low-poly base. Through the windscreen: the runway, the
 *   base's buildings, hills, and the same far-off planets the game is played over. On the comms screen
 *   the flight commander explains how to play. The pilot launches whenever they like.
 * - Take-off: the ship rolls, climbs out (the ground falls away and the sky slides into the place it
 *   has in the game), and goes supersonic (the stars stretch away from the point the ship is heading for).
 * - Handover: that point slides up and off the screen, which turns the stretched stars into the falling
 *   stars of the top-down game; the cockpit drops away and the ship itself rises into view.
 *
 * This file owns the timeline, the 3D ground scene and the cockpit. The stars and planets belong to
 * game.ts, which draws them the way `view()` says, so they are the very same ones before and after.
 */
import { traceAvatar, type Mood } from './avatar';
import { textWidth, traceText } from './font';
import { BRIEFING } from './lines';

export type Ink = (color: string, alpha: number, width: number, build: () => void, glow?: boolean) => void;
export type IntroCue = 'radio' | 'liftoff' | 'sonic';

/** How game.ts should draw the sky, and where the ship is, at this moment of the intro. */
export interface IntroView {
  /** Px the sky is shifted by (negative is up). It reaches 0 as the ship climbs out, which is where the game has it. */
  lift: number;
  /** The row of the horizon: the sky is only drawn above it. null once the ground is out of sight. */
  horizon: number | null;
  /** The point the stars streak away from. null: they fall straight down, as in the game. */
  vanish: { x: number; y: number } | null;
  /** How fast the stars travel, as a multiple of their own speed, and how long their streaks are. */
  speed: number;
  stretch: number;
  /** 0 to 1: how much of the way the stars' motion has turned from "away from a point" into "straight down". */
  settle: number;
  /** 0 to 1: how far the ship has risen into its place in the top-down view. */
  ship: number;
  /** How hard the picture shakes, 0 to 1. */
  shake: number;
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

// The take-off, in seconds: rolling down the runway, climbing out, supersonic, then the handover to the game.
const ROLL = 2.1;
const CLIMB = 2.3;
const SONIC = 1.7;
const HANDOVER = 1.3;
const T_CLIMB = ROLL;
const T_SONIC = T_CLIMB + CLIMB;
const T_HANDOVER = T_SONIC + SONIC;
const T_END = T_HANDOVER + HANDOVER;

/** The camera: eye height on the runway, how steeply the ship climbs (radians), and its top speed (units a second). */
const EYE = 2.2;
const PITCH = 0.6;
const TOP_SPEED = 210;
/** Nothing nearer than this is drawn. */
const NEAR = 1;
const RUNWAY_HALF = 7;
const RUNWAY_END = 440;
const GRID = 40;
/** How high the ship is when the ground starts to fade, and when it has gone. */
const FADE_FROM = 30;
const FADE_TO = 110;

/** Letters a second the commander's words appear at, and how long a finished line stays up. */
const TYPE_RATE = 46;
const LINE_HOLD = 2.3;

const BASE = 'rgb(3, 7, 26)';
const SAND = '#ecdfd2';
const CYAN = '#42f5ff';
const LIME = '#9bff4d';
const YELLOW = '#ffe84a';
const VIOLET = '#b98cff';
const BLUE = '#6f8cff';

type BlockKind = 'box' | 'tower' | 'dome' | 'mast';
interface Block { kind: BlockKind; x: number; z: number; w: number; d: number; h: number; tint: string; dish: boolean }

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const smooth = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};

/** Break text into lines no wider than `width`. */
function wrap(text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class Intro {
  phase: 'brief' | 'launch' = 'brief';
  /** Seconds since this phase began. */
  t = 0;
  done = false;

  private camZ = 0;
  private camY = EYE;
  private speedNow = 0;
  /** What the commander is saying, how long ago they started, and which line of the briefing it is. */
  private said = '';
  private saidAge = 0;
  private line = -1;
  private wished = false;
  private warned = false;
  private boomed = false;
  private readonly blocks: Block[] = [];
  /** Heights of the hills along the horizon, 0 to 1, left to right. */
  private readonly hills: number[] = Array.from({ length: 31 }, (_, i) => (i % 2 ? rand(0.45, 1) : rand(0.1, 0.5)));

  constructor(
    private readonly reduceMotion: boolean,
    private readonly cue: (cue: IntroCue) => void,
  ) {
    // The base: a control tower by the runway, then huts, domes and masts down both sides.
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

  /** Every line of the briefing, for a screen reader. */
  static script(touch: boolean): string {
    return `In the cockpit, on the runway. ${BRIEFING[touch ? 'touch' : 'keys'].join(' ')}`;
  }

  private say(text: string): void {
    this.said = text;
    this.saidAge = 0;
    this.cue('radio');
  }

  /** The pilot has asked to go. */
  launch(): void {
    if (this.phase !== 'brief') return;
    this.phase = 'launch';
    this.t = 0;
    this.say(BRIEFING.engines);
    this.cue('liftoff');
    // With motion turned down there is no flight to watch: go straight to the handover.
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

  update(dt: number, touch: boolean): void {
    this.t += dt;
    this.saidAge += dt;
    if (this.phase === 'brief') {
      const lines = BRIEFING[touch ? 'touch' : 'keys'];
      const spoken = this.saidAge > this.said.length / TYPE_RATE + LINE_HOLD;
      if (this.line < 0 || (spoken && this.line < lines.length - 1)) {
        this.line += 1;
        this.say(lines[this.line]!);
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

  /** How solid the ground is drawn: 1 on the runway, 0 once the ship is well clear of it. */
  private get ground(): number {
    return 1 - clamp((this.camY - FADE_FROM) / (FADE_TO - FADE_FROM), 0, 1);
  }

  /** 0 to 1 through the handover. */
  private get handover(): number {
    return this.phase === 'launch' ? clamp((this.t - T_HANDOVER) / HANDOVER, 0, 1) : 0;
  }

  /** Height of the dashboard, and the row the pilot's eyes are level with. */
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
    const launching = this.phase === 'launch';
    const t = launching ? this.t : 0;
    const climb = launching ? smooth((t - T_CLIMB) / CLIMB) : 0;
    const sonic = launching ? smooth((t - T_SONIC) / SONIC) : 0;
    const hand = this.handover;
    const eye = this.eye(h);
    const horizon = eye + this.focal(w, h) * Math.tan(this.pitch);
    // The point the stars fly away from sits dead ahead, then runs off the top of the screen: by the time
    // it is far enough away, "away from it" is as good as "straight down".
    const away = hand > 0 ? h * 0.9 * (Math.exp(7 * hand) - 1) : 0;
    const rumble = launching && !this.reduceMotion ? (t < T_CLIMB ? 0.12 * (t / ROLL) : 0.1 + 0.25 * sonic) * (1 - hand) : 0;
    return {
      // On the runway the sky sits a little higher than the game has it, so a planet hangs over the base.
      lift: -h * 0.15 * (1 - climb),
      horizon: this.ground > 0 && horizon < h ? horizon : null,
      vanish: hand >= 1 ? null : { x: w / 2, y: eye - away },
      speed: launching ? 0.5 * climb + 6.5 * sonic - 3.8 * smooth(hand) : 0,
      stretch: 1 + 4 * sonic * (1 - smooth(hand)),
      settle: smooth(hand),
      ship: smooth(hand),
      shake: rumble,
    };
  }

  // ------------------------------------------------------------ the ground

  /** The base, its runway and the land around it, seen from the cockpit. Drawn over the sky, under the cockpit. */
  renderGround(f: IntroFrame): void {
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

    /** Add the line between two points of the world to the path, cut off where it passes behind the pilot. */
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
      let ady = ay - camY, adz = az - camZ, bdy = by - camY, bdz = bz - camZ;
      let a = adz * cp + ady * sp;
      let b = bdz * cp + bdy * sp;
      if (a < NEAR && b < NEAR) return;
      if (a < NEAR || b < NEAR) {
        // Slide the end that is behind the pilot up to the nearest thing that can be drawn.
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

    // Hills along the horizon. They are filled with the night's own colour so that no star shows through them.
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
      // A crease down from each peak is what makes a row of triangles look like low-poly hills.
      for (let i = 1; i < this.hills.length - 1; i += 2) {
        ctx.moveTo(hillX(i), hillY(i));
        ctx.lineTo(hillX(i) + step * 0.3, horizon);
      }
      ctx.moveTo(0, horizon);
      ctx.lineTo(w, horizon);
    }, false);

    // The land: a grid, fainter the further off it is.
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

    // The runway: its edges, a dashed centre line, and bars across the far end.
    if (camZ + NEAR < RUNWAY_END) {
      ink(SAND, 0.85 * solid, 1.4, () => {
        seg(-RUNWAY_HALF, 0, -30, -RUNWAY_HALF, 0, RUNWAY_END);
        seg(RUNWAY_HALF, 0, -30, RUNWAY_HALF, 0, RUNWAY_END);
        seg(-RUNWAY_HALF, 0, RUNWAY_END, RUNWAY_HALF, 0, RUNWAY_END);
        for (let z = 0; z < RUNWAY_END - 30; z += 24) seg(0, 0, z, 0, 0, z + 10);
        for (let x = -5; x <= 5; x += 2) seg(x, 0, RUNWAY_END - 20, x, 0, RUNWAY_END - 6);
      });
      // Lights down both edges, lit in turn so that they run away towards the horizon.
      const beat = Math.floor(time * 9);
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

    // The base's buildings.
    const box = (x: number, y: number, z: number, bw: number, bh: number, bd: number): void => {
      const x0 = x - bw / 2, x1 = x + bw / 2, z0 = z, z1 = z + bd, y1 = y + bh;
      for (const [px, pz, qx, qz] of [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]] as const) {
        seg(px, y, pz, qx, y, qz);
        seg(px, y1, pz, qx, y1, qz);
        seg(px, y, pz, px, y1, pz);
      }
    };
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
            // Three rings of eight, narrowing to a point.
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
              // A radar bar, turning.
              const a = time * 2.2 + b.z;
              seg(b.x - Math.cos(a) * 3.4, b.h, b.z - Math.sin(a) * 3.4, b.x + Math.cos(a) * 3.4, b.h, b.z + Math.sin(a) * 3.4);
            }
          }
        }
      }, false);
    }
    // A warning light on top of every mast and the tower, blinking.
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
  }

  // ----------------------------------------------------------- the cockpit

  /** The windscreen's frame, the dashboard with the commander on its screen, and the words on the glass. */
  renderCockpit(f: IntroFrame): void {
    const { ctx, ink, w, h, inset, time, touch } = f;
    const hand = this.handover;
    if (hand >= 1) return;
    const launching = this.phase === 'launch';
    const dash = this.dash(h);
    const eye = this.eye(h);
    // The cockpit rattles with the engines, and at the handover drops out of the bottom of the picture.
    const rumble = launching && !this.reduceMotion ? this.view(w, h).shake * 9 : 0;
    const ox = rumble ? rand(-1, 1) * rumble : 0;
    const oy = (rumble ? rand(-1, 1) * rumble : 0) + hand * hand * (dash + 90);
    const fade = 1 - smooth(hand * 1.4);
    const top = h - dash + oy;
    const shoulder = top + dash * 0.3;

    // Words on the glass.
    if (!launching) {
      const alpha = Math.min(1, this.t / 0.6);
      const ask = touch ? 'TAP TO LAUNCH' : 'PRESS SPACE TO LAUNCH';
      const size = Math.min(20, (20 * (w - 40)) / textWidth(ask, 20));
      if (time % 1.1 < 0.75) ink(SAND, alpha, 1.8, () => traceText(ctx, ask, w / 2, eye * 0.42, size, 'center'));
    } else if (this.t > T_SONIC && hand < 0.4) {
      const size = Math.min(26, (26 * (w - 40)) / textWidth('SUPERSONIC', 26));
      const flash = Math.floor(time * 9) % 2 === 0;
      ink(flash ? CYAN : YELLOW, 1, 2, () => traceText(ctx, 'SUPERSONIC', w / 2, eye * 0.42, size, 'center'));
    }

    // A gunsight on the glass, with a ladder that slides as the nose comes up.
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

    // The canopy's struts, each a pair of lines.
    ink(SAND, 0.85 * fade, 1.5, () => {
      for (const s of [-1, 1]) {
        const foot = w / 2 + s * w * 0.34;
        const head = w / 2 + s * w * 0.17;
        ctx.moveTo(foot + ox, top);
        ctx.lineTo(head + ox, -12 + oy * 0.4);
        ctx.moveTo(foot + s * 12 + ox, top);
        ctx.lineTo(head + s * 10 + ox, -12 + oy * 0.4);
      }
    });

    // The dashboard: solid, so the runway does not show through it.
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
    ink(SAND, 0.95, 1.7, outline);
    ink(SAND, 0.3, 1, () => {
      ctx.moveTo(w * 0.16 + ox + 6, top + 7);
      ctx.lineTo(w * 0.84 + ox - 6, top + 7);
    }, false);

    // On the dashboard: the comms screen, what the commander is saying, and (where there is room) the dials.
    const wide = w >= 720;
    const left = Math.max(inset.left + 14, w * (wide ? 0.07 : 0.045)) + ox;
    const right = w - Math.max(inset.right + 14, w * (wide ? 0.07 : 0.045)) + ox;
    const panelTop = top + dash * 0.3 + 12;
    const room = h - inset.bottom - 10 + oy - panelTop;
    const screen = clamp(Math.min(room, w * 0.2), 44, 104);
    this.renderCommander(f, left, panelTop, screen);

    const textX = left + screen + 14;
    const size = wide ? 11 : 9;
    const textWidthMax = (wide ? Math.min(right - 250, textX + 560) : right) - textX;
    ink(CYAN, 0.8, 1.1, () => traceText(ctx, 'FLIGHT COMMAND', textX, panelTop + 1, 7), false);
    const lines = wrap(this.said, size, textWidthMax);
    let budget = Math.floor(this.saidAge * TYPE_RATE);
    ink(SAND, 1, 1.4, () => {
      lines.forEach((line, i) => {
        if (budget <= 0) return;
        traceText(ctx, line.slice(0, budget), textX, panelTop + 16 + i * (size + 7), size);
        budget -= line.length + 1;
      });
    });

    if (wide) {
      // Speed and height, and a throttle that fills as the engines wind up.
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
        ink(lit ? YELLOW : SAND, lit ? 1 : 0.25, 1.4, () => {
          for (let i = 0; i < 16; i++) {
            if (i < Math.round(power * 16) !== lit) continue;
            ctx.moveTo(gx + i * 7, panelTop + 40);
            ctx.lineTo(gx + i * 7, panelTop + 50);
          }
        }, false);
      }
      // A little radar, sweeping.
      const rx = right - 30;
      const ry = panelTop + 26;
      ink(CYAN, 0.6, 1, () => {
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

  /** The comms screen, with the commander's head inside it. */
  private renderCommander(f: IntroFrame, x: number, y: number, box: number): void {
    const { ctx, ink, time } = f;
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
    const mood = this.mood;
    // The commander looks about a little, and nods along while talking.
    const yaw = Math.sin(time * 0.7) * 0.22;
    const pitch = 0.04 + (mood === 'talk' && !this.reduceMotion ? Math.sin(time * 7) * 0.035 : 0);
    const cx = x + box / 2;
    const cy = y + box * 0.5;
    const size = box * 0.3;
    ctx.save();
    ctx.beginPath();
    frame();
    ctx.clip();
    ink(CYAN, 0.5, 1, () => traceAvatar(ctx, 'commander', 'head', cx, cy, size, yaw, pitch, mood, time), false);
    ink(mood === 'happy' ? LIME : SAND, 1, 1.5, () => traceAvatar(ctx, 'commander', 'face', cx, cy, size, yaw, pitch, mood, time));
    // Scan lines drifting down the screen: it is a picture sent over the radio.
    ink(CYAN, 0.12, 1, () => {
      for (let sy = y + ((time * 14) % 6); sy < y + box; sy += 6) {
        ctx.moveTo(x, sy);
        ctx.lineTo(x + box, sy);
      }
    }, false);
    ctx.restore();
    ink(CYAN, 0.9, 1.5, frame);
  }
}
