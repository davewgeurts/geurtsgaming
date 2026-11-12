/**
 * The very first thing the arcade demo shows: the hangar of a school for space pilots, on a space station,
 * seen from across the floor. The player's pilot walks over to their ship, climbs the ladder and gets in;
 * the canopy shuts and the ship rolls off towards the hangar door. Then the view cuts to the cockpit (intro.ts).
 *
 * Around the pilot the school carries on: a maths lesson at a board, a pilot practising typing, mechanics
 * and robots at work on the other ships. Through the hangar door are the stars and planets of the game
 * itself, which game.ts draws and this file only cuts a hole for.
 *
 * Everything is a handful of straight lines in 3D, flattened onto the screen the way a camera would see them.
 */
import { textWidth, traceText } from './font';
import { WORDS } from './lines';
import { makeProblem } from './maths';

export type HangarInk = (color: string, alpha: number, width: number, build: () => void, glow?: boolean) => void;
export type HangarCue = 'bell' | 'step' | 'canopy';

export interface HangarFrame {
  ctx: CanvasRenderingContext2D;
  ink: HangarInk;
  w: number;
  h: number;
  time: number;
  touch: boolean;
}

// The scene, in seconds: the pilot sets off, reaches the ladder, is up it, is sitting down,
// the canopy is shut, and the ship has rolled away.
const WALK_FROM = 0.7;
const WALK_TO = 5.3;
const CLIMBED = 6.5;
const SEATED = 7.1;
const SHUT = 7.7;
const END = 8.9;
/** Seconds a fade to or from black takes. */
const FADE = 0.4;

// The hangar, in metres. x runs left to right, y up, z away from the camera.
const HALF = 24;
const DEPTH = 48;
const WALL = 11;
const ROOF = 19;
const DOOR_HALF = 11;
const DOOR_TOP = 11;
const ARCHES = [6, 18, 30, 42, DEPTH];
/** Where the player's ship is parked, and where the pilot walks from. */
const SHIP = { x: 3, z: 13 };
const START = { x: -6.5, z: 4 };
const LADDER = { x: SHIP.x - 1.75, z: SHIP.z + 0.5 };
/** How high the pilot's feet are once they are sitting in the cockpit. */
const SEAT_Y = 0.5;
/** Nothing nearer the camera than this is drawn. */
const NEAR = 0.6;

const SAND = '#ecdfd2';
const CYAN = '#42f5ff';
const LIME = '#9bff4d';
const YELLOW = '#ffe84a';
const ORANGE = '#ff9b2f';
const VIOLET = '#b98cff';
const BLUE = '#6f8cff';
const PINK = '#d98ac0';
const MINT = '#7fe0b0';

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const smooth = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** How a person is standing. Angles are in radians; phases run through a step (or a rung) every 2π. */
interface Pose {
  x: number; y: number; z: number;
  /** Which way they face: 0 is away from the camera, a quarter turn is to the right. */
  face: number;
  scale: number;
  /** Walking: where in the stride they are. null stands still. */
  stride: number | null;
  seated: boolean;
  /** How far the right arm is raised forwards, 0 (by their side) to 1 (straight up). */
  reach: number;
  /** Both arms up, as if on a ladder. */
  climbing: boolean;
  hat: 'helmet' | 'cap' | 'none';
  pack: boolean;
  /** A pointer or tool held in the right hand, in metres long. */
  tool: number;
}
const person = (over: Partial<Pose> & { x: number; z: number }): Pose => ({
  y: 0, face: 0, scale: 1, stride: null, seated: false, reach: 0, climbing: false, hat: 'helmet', pack: false, tool: 0, ...over,
});

export class Hangar {
  /** Seconds since the scene began. */
  t = 0;
  done = false;
  private w = 0;
  private steps = 0;
  private rang = false;
  private shut = false;
  // Where the camera is this frame, and the numbers that turn a point in the hangar into a point on the screen.
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private cosYaw = 1;
  private sinYaw = 0;
  private cosPitch = 1;
  private sinPitch = 0;
  private focal = 1;
  private eye = 0;
  private ctx: CanvasRenderingContext2D | null = null;
  // The last point flattened: its place on the screen and how far away it is.
  private sx = 0;
  private sy = 0;
  private sd = 0;
  /** Sums for the board and words for the typing screen: the same ones the game asks. */
  private readonly sums = Array.from({ length: 6 }, () => makeProblem(1));
  private readonly words = WORDS.filter((word) => word.length <= 6);

  constructor(private readonly cue: (cue: HangarCue) => void) {}

  /** Cut to the end: the fade out, then the cockpit. */
  skip(): void {
    if (this.t < END - FADE) this.t = END - FADE;
  }

  update(dt: number): void {
    this.t += dt;
    if (!this.rang && this.t > 0.25) {
      this.rang = true;
      this.cue('bell');
    }
    // A footstep for every half stride while the pilot is walking.
    if (this.t > WALK_FROM && this.t < WALK_TO) {
      const taken = Math.floor(((this.t - WALK_FROM) * STRIDES) / Math.PI);
      if (taken > this.steps) {
        this.steps = taken;
        this.cue('step');
      }
    }
    if (!this.shut && this.t > SEATED + 0.3 && this.t < END - FADE) {
      this.shut = true;
      this.cue('canopy');
    }
    if (this.t >= END) this.done = true;
  }

  /** How dark the screen is, 0 to 1: the scene fades in from black and out to it. */
  get curtain(): number {
    return Math.max(1 - this.t / FADE, (this.t - (END - FADE)) / FADE, 0);
  }

  /** Point the camera for this frame. It drifts in a little and follows the pilot across. */
  private aim(w: number, h: number): void {
    this.w = w;
    const along = smooth(this.t / END);
    const yaw = lerp(-0.03, 0.08, along);
    const pitch = -0.06;
    // (A tall, narrow screen cannot see both sides of the hangar: it looks further left, to keep the lesson in view.)
    this.cx = lerp(-2.5, 0.4, along) - (h > w ? 3 : 0);
    this.cy = 4.6;
    this.cz = lerp(-11, -7.5, along);
    this.cosYaw = Math.cos(yaw);
    this.sinYaw = Math.sin(yaw);
    this.cosPitch = Math.cos(pitch);
    this.sinPitch = Math.sin(pitch);
    // (On a tall, narrow screen the view is tighter, so the scene fills more of it.)
    this.focal = Math.max(0.9 * Math.min(w, h * 1.25), 0.5 * h);
    this.eye = h * 0.52;
  }

  /** Flatten a point of the hangar onto the screen (into sx, sy; sd is its distance). False if it is behind the camera. */
  private flat(x: number, y: number, z: number): boolean {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const dz = z - this.cz;
    const x1 = dx * this.cosYaw - dz * this.sinYaw;
    const z1 = dx * this.sinYaw + dz * this.cosYaw;
    const depth = z1 * this.cosPitch + dy * this.sinPitch;
    if (depth < NEAR) return false;
    this.sd = depth;
    this.sx = this.w / 2 + (this.focal * x1) / depth;
    this.sy = this.eye - (this.focal * (dy * this.cosPitch - z1 * this.sinPitch)) / depth;
    return true;
  }

  /** Add the line between two points of the hangar to the path. (Lines that pass behind the camera are left out.) */
  private seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const ctx = this.ctx!;
    if (!this.flat(ax, ay, az)) return;
    const x = this.sx;
    const y = this.sy;
    if (!this.flat(bx, by, bz)) return;
    ctx.moveTo(x, y);
    ctx.lineTo(this.sx, this.sy);
  }

  /** A box standing on (x, y, z) as the middle of its base. */
  private box(x: number, y: number, z: number, wide: number, tall: number, deep: number): void {
    const x0 = x - wide / 2, x1 = x + wide / 2, z0 = z - deep / 2, z1 = z + deep / 2, y1 = y + tall;
    for (const [px, pz, qx, qz] of [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]] as const) {
      this.seg(px, y, pz, qx, y, qz);
      this.seg(px, y1, pz, qx, y1, qz);
      this.seg(px, y, pz, px, y1, pz);
    }
  }

  /** Words on something that faces the camera: `tall` is the height of the letters in metres. */
  private label(text: string, x: number, y: number, z: number, tall: number): void {
    if (!this.flat(x, y, z)) return;
    const size = (this.focal * tall) / this.sd;
    if (size >= 2.5) traceText(this.ctx!, text, this.sx, this.sy, size, 'center');
  }

  /** The hole the stars and planets show through: the hangar door. game.ts clips the sky to this path. */
  clipSky = (ctx: CanvasRenderingContext2D): void => {
    const corners = [[-DOOR_HALF, 0], [-DOOR_HALF, DOOR_TOP], [DOOR_HALF, DOOR_TOP], [DOOR_HALF, 0]] as const;
    corners.forEach(([x, y], i) => {
      if (!this.flat(x, y, DEPTH)) return;
      if (i) ctx.lineTo(this.sx, this.sy);
      else ctx.moveTo(this.sx, this.sy);
    });
    ctx.closePath();
  };

  /** Get ready to be asked for the door's outline, before anything is drawn this frame. */
  layout(w: number, h: number): void {
    this.aim(w, h);
  }

  // ---------------------------------------------------------------- people

  /** One part of a person: 'body' is the head, torso and kit; 'limbs' the arms and legs (drawn thicker, as a suit). */
  private draw(p: Pose, part: 'body' | 'limbs'): void {
    const s = p.scale;
    const cos = Math.cos(p.face);
    const sin = Math.sin(p.face);
    // A line in the person's own space (x to their right, y up, z the way they face), placed in the hangar.
    const L = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void =>
      this.seg(
        p.x + (ax * cos + az * sin) * s, p.y + ay * s, p.z + (-ax * sin + az * cos) * s,
        p.x + (bx * cos + bz * sin) * s, p.y + by * s, p.z + (-bx * sin + bz * cos) * s,
      );
    // Sitting down lowers everything above the hips.
    const drop = p.seated ? 0.4 : 0;
    const hip = 0.94 - drop;
    const shoulder = 1.46 - drop;

    if (part === 'body') {
      // Torso: wide at the shoulders, narrow at the hips, with a little depth.
      for (const z of [0.1, -0.1]) {
        L(-0.25, shoulder, z, 0.25, shoulder, z);
        L(0.25, shoulder, z, 0.16, hip, z);
        L(0.16, hip, z, -0.16, hip, z);
        L(-0.16, hip, z, -0.25, shoulder, z);
      }
      for (const [x, y] of [[-0.25, shoulder], [0.25, shoulder], [0.16, hip], [-0.16, hip]] as const) L(x, y, 0.1, x, y, -0.1);
      // Head: a box on a short neck.
      const chin = shoulder + 0.12;
      const crown = chin + 0.28;
      L(0, shoulder, 0, 0, chin, 0);
      for (const z of [0.13, -0.13]) {
        L(-0.13, chin, z, 0.13, chin, z);
        L(0.13, chin, z, 0.13, crown, z);
        L(0.13, crown, z, -0.13, crown, z);
        L(-0.13, crown, z, -0.13, chin, z);
      }
      for (const [x, y] of [[-0.13, chin], [0.13, chin], [0.13, crown], [-0.13, crown]] as const) L(x, y, 0.13, x, y, -0.13);
      if (p.hat === 'helmet') {
        // A visor across the face and a ridge over the top.
        L(-0.1, crown - 0.08, 0.135, 0.1, crown - 0.08, 0.135);
        L(0.1, crown - 0.08, 0.135, 0.1, crown - 0.17, 0.135);
        L(0.1, crown - 0.17, 0.135, -0.1, crown - 0.17, 0.135);
        L(-0.1, crown - 0.17, 0.135, -0.1, crown - 0.08, 0.135);
        L(0, crown, 0.13, 0, crown + 0.04, 0);
        L(0, crown + 0.04, 0, 0, crown, -0.13);
      } else if (p.hat === 'cap') {
        // A peak sticking out over the eyes.
        L(-0.15, crown - 0.03, 0.13, -0.12, crown - 0.03, 0.3);
        L(-0.12, crown - 0.03, 0.3, 0.12, crown - 0.03, 0.3);
        L(0.12, crown - 0.03, 0.3, 0.15, crown - 0.03, 0.13);
      }
      if (p.pack) {
        // A pack on the back.
        for (const [x, y, x2, y2] of [[-0.15, hip + 0.14, 0.15, hip + 0.14], [0.15, hip + 0.14, 0.15, shoulder - 0.04], [0.15, shoulder - 0.04, -0.15, shoulder - 0.04], [-0.15, shoulder - 0.04, -0.15, hip + 0.14]] as const) {
          L(x, y, -0.24, x2, y2, -0.24);
          L(x, y, -0.1, x, y, -0.24);
        }
      }
      return;
    }

    // Legs: thigh then shin, swinging from the hip.
    const stride = p.stride;
    for (const side of [-1, 1]) {
      const hx = side * 0.11;
      if (p.seated) {
        L(hx, hip, 0, hx, hip, 0.44);
        L(hx, hip, 0.44, hx, hip - 0.5, 0.48);
        L(hx, hip - 0.5, 0.48, hx, hip - 0.5, 0.64);
        continue;
      }
      const phase = stride === null ? 0 : stride + (side > 0 ? Math.PI : 0);
      const swing = stride === null ? 0 : Math.sin(phase) * (p.climbing ? 0.75 : 0.55);
      // The knee bends as the leg comes through, and more on a ladder.
      const bend = stride === null ? 0.04 : 0.2 + (p.climbing ? 0.9 : 0.5) * Math.max(0, Math.cos(phase));
      const kx = hx, ky = hip - Math.cos(swing) * 0.47, kz = Math.sin(swing) * 0.47;
      const fy = ky - Math.cos(swing - bend) * 0.47, fz = kz + Math.sin(swing - bend) * 0.47;
      L(hx, hip, 0, kx, ky, kz);
      L(kx, ky, kz, kx, fy, fz);
      L(kx, fy, fz, kx, fy, fz + 0.16);
    }
    // Arms: upper arm then forearm. They swing against the legs, or reach, or hold the ladder.
    for (const side of [-1, 1]) {
      const ax = side * 0.29;
      const ay = shoulder - 0.04;
      let raise: number;
      if (p.climbing) raise = 2 + Math.sin((stride ?? 0) + (side > 0 ? 0 : Math.PI)) * 0.45;
      else if (side > 0 && p.reach > 0) raise = p.reach * Math.PI;
      else if (p.seated) raise = 0.9;
      else raise = stride === null ? 0.05 : -Math.sin(stride + (side > 0 ? Math.PI : 0)) * 0.5;
      const ex = ax, ey = ay - Math.cos(raise) * 0.3, ez = Math.sin(raise) * 0.3;
      const fore = raise + (p.seated ? 0.5 : 0.35);
      const hy = ey - Math.cos(fore) * 0.28, hz = ez + Math.sin(fore) * 0.28;
      L(ax, ay, 0, ex, ey, ez);
      L(ex, ey, ez, ex, hy, hz);
      if (side > 0 && p.tool) L(ex, hy, hz, ex, hy - Math.cos(fore) * p.tool, hz + Math.sin(fore) * p.tool);
    }
  }

  /** Draw some people in one colour: their bodies in a fine line, their limbs in a heavier one. */
  private people(ink: HangarInk, color: string, alpha: number, glow: boolean, poses: readonly Pose[]): void {
    ink(color, alpha, 1.1, () => poses.forEach((p) => this.draw(p, 'body')), glow);
    ink(color, alpha, 2, () => poses.forEach((p) => this.draw(p, 'limbs')), glow);
  }

  // ----------------------------------------------------------------- ships

  /**
   * A ship parked on its three legs, nose pointing away from the camera when `face` is 0.
   * `open` is how far its canopy is up (0 shut, 1 wide open).
   */
  private craft(x: number, z: number, face: number, open: number): void {
    const cos = Math.cos(face);
    const sin = Math.sin(face);
    const L = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void =>
      this.seg(x + ax * cos + az * sin, ay, z - ax * sin + az * cos, x + bx * cos + bz * sin, by, z - bx * sin + bz * cos);
    const deck = 1;
    // The outline, seen from above, is the ship from the game.
    const hull = [[0, 4], [1, 1], [3.25, -2.5], [1.25, -1.75], [0.75, -3], [-0.75, -3], [-1.25, -1.75], [-3.25, -2.5], [-1, 1]] as const;
    hull.forEach(([hx, hz], i) => {
      const [nx, nz] = hull[(i + 1) % hull.length]!;
      L(hx, deck, hz, nx, deck, nz);
    });
    // A spine along the top, joined to the outline so the hull has facets.
    const spine = [[0, deck, 4], [0, 1.5, 1.6], [0, 1.6, -0.9], [0, 2.3, -2.9], [0, deck + 0.1, -3]] as const;
    for (let i = 0; i < spine.length - 1; i++) {
      const [ax, ay, az] = spine[i]!;
      const [bx, by, bz] = spine[i + 1]!;
      L(ax, ay, az, bx, by, bz);
    }
    for (const side of [-1, 1]) {
      L(0, 1.5, 1.6, side, deck, 1);
      L(0, 1.6, -0.9, side * 1.25, deck, -1.75);
      L(0, 1.6, -0.9, side * 3.25, deck, -2.5);
      L(0, 2.3, -2.9, side * 0.75, deck, -3);
      // Legs, and the engines' nozzles.
      L(side * 1.7, deck, -1.9, side * 1.7, 0, -1.9);
      L(side * 1.7 - 0.3, 0, -1.9, side * 1.7 + 0.3, 0, -1.9);
      L(side * 0.5 - 0.22, deck - 0.25, -3, side * 0.5 + 0.22, deck - 0.25, -3);
      L(side * 0.5 - 0.22, deck + 0.2, -3, side * 0.5 + 0.22, deck + 0.2, -3);
    }
    L(0, deck, 2.7, 0, 0, 2.7);
    L(-0.3, 0, 2.7, 0.3, 0, 2.7);
    // The canopy: hinged at the back, so opening lifts its front.
    const lift = open * 0.95;
    const hinge = [0, 1.62, -0.75] as const;
    const tip = (py: number, pz: number): [number, number] => {
      const dy = py - hinge[1];
      const dz = pz - hinge[2];
      return [hinge[1] + dy * Math.cos(lift) + dz * Math.sin(lift), hinge[2] - dy * Math.sin(lift) + dz * Math.cos(lift)];
    };
    const [fy, fz] = tip(1.52, 1.5);
    const [ty, tz] = tip(2.12, 0.35);
    L(0, hinge[1], hinge[2], 0, ty, tz);
    L(0, ty, tz, 0, fy, fz);
    for (const side of [-1, 1]) {
      const [sy, sz] = tip(1.5, 0.3);
      L(side * 0.62, sy, sz, 0, ty, tz);
      L(side * 0.62, sy, sz, 0, fy, fz);
      L(side * 0.62, sy, sz, 0, hinge[1], hinge[2]);
    }
  }

  // ----------------------------------------------------------------- scene

  /** The whole hangar. Drawn over the sky that shows through the door. */
  render(f: HangarFrame): void {
    const { ctx, ink, w, h, time } = f;
    this.ctx = ctx;
    this.aim(w, h);
    const t = this.t;
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => this.seg(ax, ay, az, bx, by, bz);

    // --- outside the door: a low-poly planet with a ring, a long way off
    ctx.save();
    ctx.beginPath();
    this.clipSky(ctx);
    ctx.clip();
    ink(MINT, 0.55, 1.1, () => {
      const [px, py, pz, r] = [9, 15, DEPTH + 150, 11];
      const at = (turn: number, scale: number): [number, number] => [px + Math.cos(turn * Math.PI * 2 + 0.3) * r * scale, py + Math.sin(turn * Math.PI * 2 + 0.3) * r * scale];
      // A ten-sided rim, a five-sided ring inside it and a point in the middle, all joined up into triangles.
      for (let i = 0; i < 10; i++) {
        const [x0, y0] = at(i / 10, 1);
        const [x1, y1] = at((i + 1) / 10, 1);
        seg(x0, y0, pz, x1, y1, pz);
      }
      for (let i = 0; i < 5; i++) {
        const [ix, iy] = at((i * 2 + 1) / 10, 0.52);
        const [jx, jy] = at((i * 2 + 3) / 10, 0.52);
        seg(ix, iy, pz, jx, jy, pz);
        seg(ix, iy, pz, px - 1, py + 1, pz);
        for (const k of [0, 1, 2]) {
          const [rx, ry] = at((i * 2 + k) / 10, 1);
          seg(ix, iy, pz, rx, ry, pz);
        }
      }
      // The ring, tipped towards the hangar. The part behind the planet is left out.
      for (let i = 0; i < 24; i++) {
        const a = (i * Math.PI) / 12, b = ((i + 1) * Math.PI) / 12;
        if (Math.sin(a + 0.13) > 0.1 && Math.abs(Math.cos(a + 0.13)) < 0.62) continue;
        seg(px + Math.cos(a) * r * 1.75, py + Math.sin(a) * r * 0.4, pz, px + Math.cos(b) * r * 1.75, py + Math.sin(b) * r * 0.4, pz);
      }
    }, false);
    ctx.restore();

    // --- the building: floor, walls, roof, and the door open to space
    ink(BLUE, 0.2, 1, () => {
      for (let z = 0; z <= DEPTH; z += 6) seg(-HALF, 0, z, HALF, 0, z);
      for (let x = -HALF; x <= HALF; x += 6) seg(x, 0, 0, x, 0, DEPTH);
    }, false);
    ink(VIOLET, 0.4, 1.1, () => {
      for (const z of ARCHES) {
        seg(-HALF, 0, z, -HALF, WALL, z);
        seg(-HALF, WALL, z, -15, ROOF, z);
        seg(-15, ROOF, z, 15, ROOF, z);
        seg(15, ROOF, z, HALF, WALL, z);
        seg(HALF, WALL, z, HALF, 0, z);
      }
      for (const [x, y] of [[-HALF, WALL], [-15, ROOF], [15, ROOF], [HALF, WALL]] as const) seg(x, y, ARCHES[0]!, x, y, DEPTH);
      seg(-HALF, 0, DEPTH, -DOOR_HALF, 0, DEPTH);
      seg(DOOR_HALF, 0, DEPTH, HALF, 0, DEPTH);
    }, false);
    // The door: a bright frame, and the faint shimmer of the field that keeps the air in.
    ink(CYAN, 0.9, 1.6, () => {
      seg(-DOOR_HALF, 0, DEPTH, -DOOR_HALF, DOOR_TOP, DEPTH);
      seg(-DOOR_HALF, DOOR_TOP, DEPTH, DOOR_HALF, DOOR_TOP, DEPTH);
      seg(DOOR_HALF, DOOR_TOP, DEPTH, DOOR_HALF, 0, DEPTH);
    });
    ink(CYAN, 0.1 + 0.04 * Math.sin(time * 3), 1, () => {
      for (let x = -DOOR_HALF + 1.1; x < DOOR_HALF; x += 1.1) seg(x, 0, DEPTH, x, DOOR_TOP, DEPTH);
    }, false);
    // A line painted on the floor from the pilot's ship out through the door.
    ink(YELLOW, 0.5, 1.2, () => {
      for (let z = SHIP.z + 6; z < DEPTH; z += 4) seg(SHIP.x, 0, z, SHIP.x, 0, z + 2);
    }, false);

    // --- the school: its name over the door, the alphabet and the numbers along the wall, a clock, bunting
    ink(SAND, 0.9, 1.4, () => this.label('SPACE PILOT SCHOOL', 0, DOOR_TOP + 4.6, DEPTH, 2));
    ink(PINK, 0.55, 1, () => {
      this.label('A B C D E F G H I J K L M N O P Q R S T U V W X Y Z', 0, DOOR_TOP + 1.6, DEPTH, 0.62);
      this.label('1 2 3 4 5 6 7 8 9 10', 17.5, 3.6, DEPTH, 0.6);
      this.label('HANGAR 3', 17.5, 5.6, DEPTH, 0.9);
    }, false);
    ink(SAND, 0.55, 1, () => {
      // The clock, with its hands going round.
      const [kx, ky] = [17.5, 9];
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4, b = ((i + 1) * Math.PI) / 4;
        seg(kx + Math.cos(a) * 1.3, ky + Math.sin(a) * 1.3, DEPTH, kx + Math.cos(b) * 1.3, ky + Math.sin(b) * 1.3, DEPTH);
      }
      seg(kx, ky, DEPTH, kx + Math.sin(time * 0.7) * 1, ky + Math.cos(time * 0.7) * 1, DEPTH);
      seg(kx, ky, DEPTH, kx + 0.55, ky + 0.4, DEPTH);
      // Lockers down the near end of the left wall.
      for (let z = 3; z < 14.9; z += 1.2) {
        seg(-HALF, 0, z, -HALF, 2.3, z);
        seg(-HALF, 2.3, z, -HALF, 2.3, z + 1.2);
        seg(-HALF, 1.7, z + 0.3, -HALF, 1.7, z + 0.9);
      }
      seg(-HALF, 0, 15, -HALF, 2.3, 15);
    }, false);
    // Bunting strung across the hangar: a sagging line of little flags.
    for (const [color, odd] of [[YELLOW, 0], [PINK, 1]] as const) {
      ink(color, 0.5, 1, () => {
        const flags = 16;
        for (let i = 0; i < flags; i++) {
          const at = (k: number): [number, number] => {
            const u = k / flags;
            return [lerp(-HALF, HALF, u), 15.5 - Math.sin(u * Math.PI) * 2.2];
          };
          const [x0, y0] = at(i);
          const [x1, y1] = at(i + 1);
          if (!odd) seg(x0, y0, 22, x1, y1, 22);
          if (i % 2 === odd) {
            seg(x0, y0, 22, (x0 + x1) / 2, (y0 + y1) / 2 - 1.1, 22);
            seg((x0 + x1) / 2, (y0 + y1) / 2 - 1.1, 22, x1, y1, 22);
          }
        }
      }, false);
    }

    // --- the maths lesson: a board on legs, a teacher with a pointer, pilots at their desks
    const board = { x: -12.5, z: 31, y: 1.4, wide: 9, tall: 4.2 };
    const sum = this.sums[Math.floor(time / 4.5) % this.sums.length]!;
    const answered = time % 4.5 > 2.4;
    ink(CYAN, 0.7, 1.2, () => {
      this.box(board.x, board.y, board.z, board.wide, board.tall, 0.2);
      seg(board.x - 3.6, 0, board.z, board.x - 3.6, board.y, board.z);
      seg(board.x + 3.6, 0, board.z, board.x + 3.6, board.y, board.z);
      this.label('MATHS CLASS', board.x, board.y + board.tall + 1.2, board.z, 0.6);
    }, false);
    const asked = `${sum.question} = ${answered ? '' : '?'}`;
    ink(SAND, 0.9, 1.3, () => this.label(answered ? `${asked}${' '.repeat(String(sum.answer).length)}` : asked, board.x, board.y + board.tall - 1.5, board.z - 0.12, 0.8));
    if (answered) {
      ink(LIME, 1, 1.4, () => this.label(`${' '.repeat(asked.length)}${sum.answer}`, board.x, board.y + board.tall - 1.5, board.z - 0.12, 0.8));
    }
    const desks = [[-15.4, 24.4], [-11.6, 24.4], [-15.4, 27.2], [-11.6, 27.2]] as const;
    ink(BLUE, 0.5, 1, () => {
      for (const [x, z] of desks) {
        this.box(x, 0.62, z + 0.55, 1.5, 0.06, 0.7);
        seg(x - 0.7, 0, z + 0.55, x - 0.7, 0.62, z + 0.55);
        seg(x + 0.7, 0, z + 0.55, x + 0.7, 0.62, z + 0.55);
      }
    }, false);
    // One of the class has a hand up whenever there is a sum waiting for its answer.
    const students = desks.map(([x, z], i) => person({ x, z, scale: 0.84, seated: true, pack: true, reach: !answered && i === Math.floor(time / 4.5) % 4 ? 0.85 : 0 }));
    this.people(ink, SAND, 0.6, false, students);
    const teacher = person({ x: -18.4, z: 29.8, face: 1.75, hat: 'cap', reach: 0.52 + Math.sin(time * 1.6) * 0.04, tool: 0.75 });
    this.people(ink, CYAN, 0.75, false, [teacher]);

    // --- the typing lab: a pilot at a console, a word going up on its screen a letter at a time
    const desk = { x: 10.8, z: 11.5 };
    const word = this.words[Math.floor(time / 5) % this.words.length]!;
    const typed = Math.min(word.length, Math.floor((time % 5) / 0.45));
    ink(CYAN, 0.6, 1.1, () => {
      this.box(desk.x, 0, desk.z + 1.3, 3, 0.75, 0.9);
      this.box(desk.x, 1.3, desk.z + 1.55, 3, 1.5, 0.1);
      seg(desk.x, 0.75, desk.z + 1.55, desk.x, 1.3, desk.z + 1.55);
      this.label('TYPING LAB', desk.x, 3.9, desk.z + 1.55, 0.5);
    }, false);
    ink(SAND, 0.35, 1.2, () => this.label(' '.repeat(typed) + word.slice(typed), desk.x, 2.4, desk.z + 1.45, 0.58), false);
    if (typed) ink(LIME, 0.95, 1.3, () => this.label(word.slice(0, typed) + ' '.repeat(word.length - typed), desk.x, 2.4, desk.z + 1.45, 0.58));
    this.people(ink, SAND, 0.65, false, [person({ x: desk.x, z: desk.z, scale: 0.84, seated: true, pack: true })]);

    // --- the other ships, with mechanics and robots at work on them
    ink(CYAN, 0.5, 1.1, () => this.craft(13.5, 25, 0.25, 0.9), false);
    ink(VIOLET, 0.45, 1.1, () => {
      this.craft(15, 39, -0.2, 0);
      this.craft(-4.5, 40, 0.3, 0);
    }, false);
    // A mechanic welding (the torch flickers and sheds sparks), and another up a pair of steps.
    const welder = person({ x: 11.1, z: 24.2, face: 1.35, hat: 'none', reach: 0.42, tool: 0.3 });
    const fitter = person({ x: -1.6, z: 39.6, y: 0.9, face: -1.5, hat: 'cap', reach: 0.62 + Math.sin(time * 5) * 0.05, tool: 0.35 });
    this.people(ink, ORANGE, 0.75, false, [welder, fitter]);
    ink(ORANGE, 0.5, 1, () => this.box(fitter.x, 0, fitter.z, 0.9, 0.9, 0.9), false);
    const spark = { x: 11.95, y: 1.32, z: 24.4 };
    const flare = 0.55 + 0.45 * Math.abs(Math.sin(time * 23));
    ink(YELLOW, flare, 1.6, () => {
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 + time * 4;
        seg(spark.x, spark.y, spark.z, spark.x + Math.cos(a) * 0.3 * flare, spark.y + Math.sin(a) * 0.3 * flare, spark.z);
      }
      // Sparks falling away from the weld, each on its own little arc.
      for (let i = 0; i < 5; i++) {
        const age = (time * 1.4 + i * 0.37) % 1;
        const sx = spark.x + (i - 2) * 0.22 * age * 2.2;
        const sy = spark.y + 0.5 * age - 2.2 * age * age;
        seg(sx, sy, spark.z, sx + (i - 2) * 0.03, sy - 0.12, spark.z);
      }
    });
    // A robot trundling across with a crate, and a drone looking a ship over.
    const lap = (time * 0.09) % 1;
    const away = lap < 0.5;
    const robot = { x: -6.4, z: lerp(16.5, 33, away ? lap * 2 : 2 - lap * 2), dir: away ? 1 : -1 };
    ink(LIME, 0.7, 1.2, () => {
      this.box(robot.x, 0.28, robot.z, 0.75, 0.95, 0.95);
      this.box(robot.x, 1.3, robot.z, 0.5, 0.45, 0.55);
      seg(robot.x, 1.75, robot.z, robot.x, 2.15, robot.z);
      seg(robot.x - 0.12, 2.15, robot.z, robot.x + 0.12, 2.15, robot.z);
      // Wheels, and the eye on the side it is heading.
      for (const side of [-1, 1]) this.box(robot.x + side * 0.48, 0, robot.z, 0.1, 0.36, 0.5);
      seg(robot.x - 0.14, 1.52, robot.z + robot.dir * 0.28, robot.x + 0.14, 1.52, robot.z + robot.dir * 0.28);
      // Its arms, and the crate in them.
      for (const side of [-1, 1]) seg(robot.x + side * 0.3, 0.95, robot.z + robot.dir * 0.48, robot.x + side * 0.3, 0.8, robot.z + robot.dir * 0.95);
      this.box(robot.x, 0.55, robot.z + robot.dir * 1.25, 0.62, 0.62, 0.62);
    }, false);
    const drone = { x: 15 + Math.sin(time * 0.6) * 1.6, y: 4.3 + Math.sin(time * 1.7) * 0.25, z: 39 + Math.cos(time * 0.6) * 1.2 };
    ink(LIME, 0.7, 1.1, () => {
      for (const [dx, dz] of [[0.45, 0], [0, 0.45], [-0.45, 0], [0, -0.45]] as const) {
        seg(drone.x + dx, drone.y, drone.z + dz, drone.x, drone.y + 0.32, drone.z);
        seg(drone.x + dx, drone.y, drone.z + dz, drone.x, drone.y - 0.32, drone.z);
        seg(drone.x + dx, drone.y, drone.z + dz, drone.x - dz, drone.y, drone.z + dx);
      }
    }, false);
    // The drone's scanning beam, sweeping along the ship below it.
    ink(LIME, 0.3, 1, () => seg(drone.x, drone.y - 0.32, drone.z, 15 + Math.sin(time * 2.1) * 1.2, 1.4, 39 + Math.cos(time * 1.3) * 2.4), false);

    // --- the pilot and their ship: brightest of all, and the only things that glow
    const rolling = smooth((t - SHUT) / (END - SHUT));
    const shipZ = SHIP.z + rolling * rolling * 16;
    const open = 1 - smooth((t - SEATED - 0.15) / (SHUT - SEATED - 0.15));
    ink(SAND, 1, 1.6, () => this.craft(SHIP.x, shipZ, 0, open));
    // The ladder up to the cockpit, taken away once the canopy is down.
    if (t < SHUT) {
      ink(SAND, 0.8 * (1 - smooth((t - SEATED) / (SHUT - SEATED))), 1.2, () => {
        for (const dz of [-0.28, 0.28]) seg(LADDER.x - 0.75, 0, LADDER.z + dz, LADDER.x + 0.45, 1.25, LADDER.z + dz);
        for (let i = 1; i <= 4; i++) {
          const u = i / 5;
          seg(LADDER.x - 0.75 + 1.2 * u, 1.25 * u, LADDER.z - 0.28, LADDER.x - 0.75 + 1.2 * u, 1.25 * u, LADDER.z + 0.28);
        }
      }, false);
    }
    // The engines light once the canopy is shut.
    if (t > SHUT - 0.1) {
      ink(PINK, 0.9, 1.5, () => {
        const flame = 0.7 + rolling * 1.6 + Math.abs(Math.sin(time * 31)) * 0.3;
        for (const side of [-1, 1]) {
          seg(SHIP.x + side * 0.5 - 0.2, 1, shipZ - 3, SHIP.x + side * 0.5, 1, shipZ - 3 - flame);
          seg(SHIP.x + side * 0.5 + 0.2, 1, shipZ - 3, SHIP.x + side * 0.5, 1, shipZ - 3 - flame);
        }
      });
    }
    this.people(ink, SAND, 1, true, [this.pilot(shipZ)]);

    // --- words on the screen: where this is, and how to skip it
    const title = smooth((t - 0.5) / 0.6) * (1 - smooth((t - 3.6) / 0.6));
    if (title > 0) {
      const size = Math.min(16, (16 * (w - 40)) / textWidth('TIME FOR FLIGHT CLASS', 16));
      ink(CYAN, title, 1.6, () => traceText(ctx, 'TIME FOR FLIGHT CLASS', w / 2, h * 0.06, size, 'center'));
    }
    const hint = f.touch ? 'TAP TO SKIP' : 'PRESS SPACE TO SKIP';
    ink(SAND, 0.45 * smooth((t - 1) / 0.5), 1, () => traceText(ctx, hint, w / 2, h - 30, 8, 'center'), false);
    this.ctx = null;
  }

  /** Where the player's pilot is, and what they are doing, at this moment of the scene. */
  private pilot(shipZ: number): Pose {
    const t = this.t;
    const base = { pack: true, hat: 'helmet' as const };
    if (t < WALK_TO) {
      // Across the floor to the foot of the ladder.
      const u = clamp((t - WALK_FROM) / (WALK_TO - WALK_FROM), 0, 1);
      const walking = t > WALK_FROM;
      return person({
        ...base,
        x: lerp(START.x, LADDER.x - 0.75, u), z: lerp(START.z, LADDER.z, u),
        face: Math.atan2(LADDER.x - 0.75 - START.x, LADDER.z - START.z),
        stride: walking ? (t - WALK_FROM) * STRIDES : null,
      });
    }
    if (t < CLIMBED) {
      // Up the ladder, facing the ship.
      const u = (t - WALK_TO) / (CLIMBED - WALK_TO);
      return person({ ...base, x: lerp(LADDER.x - 0.75, LADDER.x + 0.45, u), y: lerp(0, 1.25, u), z: LADDER.z, face: Math.PI / 2, stride: (t - WALK_TO) * 9, climbing: true });
    }
    // Over the side and down into the seat, then off with the ship.
    const u = smooth((t - CLIMBED) / (SEATED - CLIMBED));
    return person({
      ...base,
      x: lerp(LADDER.x + 0.45, SHIP.x, u), y: lerp(1.25, SEAT_Y, u), z: lerp(LADDER.z, shipZ + 0.2, u),
      face: lerp(Math.PI / 2, 0, u), seated: u > 0.5,
    });
  }
}

/** How fast the pilot's stride cycles, in radians a second. */
const STRIDES = 7.4;

/** What a screen reader is told is happening. */
export const HANGAR_SCRIPT = 'The hangar of Space Pilot School, on a space station. Pilots are in a maths class and a typing lab, mechanics and robots are working on the ships, and your pilot walks to their ship and climbs in.';
