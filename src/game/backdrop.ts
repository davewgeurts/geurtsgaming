/**
 * The scenery behind the arcade demo: low-poly planets (some with rings), moons and tumbling rocks.
 *
 * Each body is a small 3D mesh with a few flat faces, turned slowly and flattened onto the screen.
 * Faces that point away are skipped, and the ones that are left get a very dim flat shade under their
 * outline, so a body reads as a solid, faceted thing rather than a tangle of lines.
 *
 * Depth is what makes it parallax: far bodies (planets) crawl down the screen and barely move when the
 * ship flies sideways; nearer ones (rocks) pass a little quicker and slide a little further. Everything
 * here is drawn far dimmer and thinner than anything in the game itself, with no glow, so it stays in
 * the distance and never looks like a target.
 */
import { pick, rand } from './core';

type V3 = readonly [number, number, number];
interface Mesh { verts: V3[]; faces: number[][]; spokes?: readonly (readonly [number, number])[] }
type BodyKind = 'planet' | 'station' | 'moon' | 'rock';

interface Body {
  kind: BodyKind;
  mesh: Mesh;
  x: number; y: number;
  /** Radius in px. */
  r: number;
  /** 0 is infinitely far, 1 is right behind the ship. */
  depth: number;
  color: string;
  /** Face fills, from unlit to fully lit. */
  shades: string[];
  alpha: number;
  /** Spin, tilt towards the viewer, and roll, in radians; and how fast the first two change. */
  a: number; b: number; c: number; da: number; db: number;
  /** Radius of the ring as a multiple of the body's, or 0 for no ring. */
  ring: number;
}

/** The colour the game is played on, which a body's faces are shaded up from. */
const BASE: V3 = [5, 9, 30];
const LEVELS = 6;
/** Light comes from the upper left, a little in front. */
const LIGHT: V3 = [-0.55, -0.6, 0.58];
const PLANET_COLORS = ['#b98cff', '#42f5ff', '#ff9b2f', '#7fe0b0', '#ffe84a'];
/** Moons are small enough to be taken for an enemy, so they keep to cool colours no enemy uses. */
const MOON_COLORS = ['#42f5ff', '#7fe0b0', '#6f8cff'];
const ROCK_COLOR = '#8f9bc4';
const RING_STEPS = 28;
/**
 * How far a fully lit face is lifted from the background towards the body's colour (0 to 1).
 * Kept low on purpose: the scenery is meant to sit a long way off, behind the game.
 */
const PLANET_SHADE = 0.085;
const MOON_SHADE = 0.07;
const ROCK_SHADE = 0.055;

const unit = ([x, y, z]: V3): V3 => {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
};

/** Twenty triangles: the classic low-poly ball. */
function icosahedron(): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { verts: verts.map(unit), faces };
}

/** A globe built from bands, like lines of latitude and longitude: good for a gas giant. */
function globe(around: number, latitudes: readonly number[]): Mesh {
  const verts: V3[] = [[0, -1, 0]];
  for (const lat of latitudes) {
    for (let i = 0; i < around; i++) {
      const lon = (i / around) * Math.PI * 2;
      verts.push([Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]);
    }
  }
  verts.push([0, 1, 0]);
  const last = verts.length - 1;
  const at = (band: number, i: number) => 1 + band * around + (i % around);
  const faces: number[][] = [];
  for (let i = 0; i < around; i++) {
    faces.push([0, at(0, i), at(0, i + 1)]);
    for (let band = 0; band < latitudes.length - 1; band++) faces.push([at(band, i), at(band + 1, i), at(band + 1, i + 1), at(band, i + 1)]);
    faces.push([last, at(latitudes.length - 1, i + 1), at(latitudes.length - 1, i)]);
  }
  return { verts, faces };
}

/** Eight triangles: a little gem of a moon. */
function octahedron(): Mesh {
  return {
    verts: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
    faces: [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]],
  };
}

/** A lump of rock: a ball with every corner pushed in or pulled out, and squashed along one axis. */
function rock(): Mesh {
  const ball = icosahedron();
  const squash = rand(0.6, 0.95);
  return {
    verts: ball.verts.map(([x, y, z]) => {
      const k = rand(0.68, 1.12);
      return [x * k, y * k * squash, z * k] as const;
    }),
    faces: ball.faces,
  };
}

/**
 * An octagonal rotating ring station (Space Pilot School in orbit): a faceted outer habitat wheel,
 * a central docking hub with twin spires, and four radial connecting spokes.
 */
function stationMesh(): Mesh {
  const N = 8;
  const verts: V3[] = [];
  const faces: number[][] = [];
  const spokes: Array<readonly [number, number]> = [];

  // 0..7: outer-top wheel, 8..15: outer-bottom wheel, 16..23: inner-top wheel, 24..31: inner-bottom wheel
  const rOut = 1;
  const rIn = 0.74;
  const hRim = 0.11;
  for (const y of [hRim, -hRim]) {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      verts.push([Math.cos(a) * rOut, y, Math.sin(a) * rOut]);
    }
  }
  for (const y of [hRim, -hRim]) {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      verts.push([Math.cos(a) * rIn, y, Math.sin(a) * rIn]);
    }
  }

  // 32..39: hub top ring, 40..47: hub bottom ring, 48: top spire, 49: bottom spire
  const rHub = 0.25;
  const hHub = 0.18;
  for (const y of [hHub, -hHub]) {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      verts.push([Math.cos(a) * rHub, y, Math.sin(a) * rHub]);
    }
  }
  verts.push([0, 0.46, 0], [0, -0.46, 0]);

  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    // Wheel outer rim + top deck + bottom deck (all outward normals point away from origin):
    faces.push([i, j, 8 + j, 8 + i]);
    faces.push([16 + i, 16 + j, j, i]);
    faces.push([8 + i, 8 + j, 24 + j, 24 + i]);
    // Central hub drum + twin spire cones:
    faces.push([32 + i, 32 + j, 40 + j, 40 + i]);
    faces.push([48, 32 + j, 32 + i]);
    faces.push([49, 40 + i, 40 + j]);
    if (i % 2 === 0) {
      spokes.push([32 + i, 16 + i], [40 + i, 24 + i]);
    }
  }
  return { verts, faces, spokes };
}

const ICOSAHEDRON = icosahedron();
const OCTAHEDRON = octahedron();
const GLOBE = globe(8, [-1.05, -0.4, 0.4, 1.05]);
const GLOBE_FINE = globe(10, [-1.1, -0.55, 0, 0.55, 1.1]);
const STATION = stationMesh();
const STATION_SHADE = 0.068;

/** Fills for a body's faces: the background colour, lifted a little towards the body's own colour. */
function shadesOf(color: string, strength: number): string[] {
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return Array.from({ length: LEVELS }, (_, level) => {
    const t = 0.012 + strength * (level / (LEVELS - 1));
    return `rgb(${rgb.map((c, i) => Math.round(BASE[i]! + (c - BASE[i]!) * t)).join(',')})`;
  });
}

export class Backdrop {
  private bodies: Body[] = [];
  private w = 0;
  private h = 0;
  /** The shorter side of the screen, which sizes are taken from. */
  private span = 0;
  private light = unit(LIGHT);
  /** Which side the next planet appears on, and the colour of the last one, so neighbours differ. */
  private side = Math.random() < 0.5 ? -1 : 1;
  private lastColor = '';
  // Scratch space, reused every frame: a body's corners after turning, and its faces sorted by how lit they are.
  private X = new Float32Array(96);
  private Y = new Float32Array(96);
  private Z = new Float32Array(96);
  private lit: number[][] = Array.from({ length: LEVELS }, () => []);

  /** Tell the backdrop how big the screen is. The first call, and any big change of shape, lays the scenery out afresh. */
  resize(w: number, h: number): void {
    const span = Math.min(w, h);
    const reshaped = !this.bodies.length || Math.abs(span - this.span) > this.span * 0.25 || w > h !== this.w > this.h;
    if (!reshaped) {
      // A small change (a phone's address bar sliding away): keep everything where it is.
      for (const b of this.bodies) b.x *= w / this.w;
      this.w = w;
      this.h = h;
      return;
    }
    this.w = w;
    this.h = h;
    this.span = span;
    const roomy = w * h > 600_000;
    this.bodies = [];
    // Listed far to near, which is also the order they are drawn in.
    for (let i = 0; i < (roomy ? 2 : 1); i++) this.bodies.push(this.make('planet', i === 0));
    this.bodies.push(this.make('station', roomy));
    for (let i = 0; i < 2; i++) this.bodies.push(this.make('moon', true));
    const rocks = Math.max(3, Math.min(9, Math.floor((w * h) / 150_000)));
    for (let i = 0; i < rocks; i++) this.bodies.push(this.make('rock', true));
  }

  /** How far a body reaches from its centre, ring included. */
  private reach(b: Body): number {
    return b.r * Math.max(1, b.ring) + 2;
  }

  /** A new body. `onScreen` places it somewhere in view; otherwise it waits above the top edge. */
  private make(kind: BodyKind, onScreen: boolean): Body {
    const { w, h, span } = this;
    let body: Body;
    if (kind === 'planet') {
      const r = span * rand(0.08, 0.19);
      const banded = Math.random() < 0.45;
      const color = pick(PLANET_COLORS.filter((c) => c !== this.lastColor));
      this.lastColor = color;
      // Planets keep to the sides, often half off the screen, so the middle stays clear for the game.
      // They take turns, left then right.
      this.side = -this.side;
      const x = this.side < 0 ? rand(-r * 0.3, w * 0.22) : rand(w * 0.78, w + r * 0.3);
      body = {
        kind, r, x, y: 0, color,
        mesh: banded ? (r > 80 ? GLOBE_FINE : GLOBE) : ICOSAHEDRON,
        depth: rand(0.03, 0.07),
        shades: shadesOf(color, PLANET_SHADE),
        alpha: 0.24,
        a: rand(0, 6), b: rand(0.25, 0.6), c: rand(-0.45, 0.45),
        da: rand(0.05, 0.11) * (Math.random() < 0.5 ? -1 : 1), db: 0,
        ring: Math.random() < (banded ? 0.6 : 0.2) ? rand(1.55, 1.9) : 0,
      };
      body.y = onScreen ? rand(h * 0.2, h * 0.5) : -this.reach(body) - rand(h * 0.1, h * 0.8);
    } else if (kind === 'station') {
      const r = Math.max(24, span * rand(0.055, 0.095));
      const color = pick(MOON_COLORS);
      this.side = -this.side;
      const x = this.side < 0 ? rand(r * 0.4, w * 0.2) : rand(w * 0.8, w - r * 0.4);
      body = {
        kind, r, x, y: 0, color,
        mesh: STATION,
        depth: rand(0.06, 0.11),
        shades: shadesOf(color, STATION_SHADE),
        alpha: 0.19,
        a: rand(0, 6), b: rand(0.48, 0.82), c: rand(-0.4, 0.4),
        da: rand(0.09, 0.18) * (Math.random() < 0.5 ? -1 : 1), db: 0,
        ring: 0,
      };
      body.y = onScreen ? rand(h * 0.58, h * 0.84) : -r - rand(h * 0.25, h * 0.9);
    } else if (kind === 'moon') {
      const r = Math.max(6, span * rand(0.014, 0.032));
      const color = pick(MOON_COLORS);
      body = {
        kind, r, color,
        x: rand(w * 0.04, w * 0.96), y: 0,
        mesh: Math.random() < 0.5 ? OCTAHEDRON : ICOSAHEDRON,
        depth: rand(0.1, 0.18),
        shades: shadesOf(color, MOON_SHADE),
        alpha: 0.2,
        a: rand(0, 6), b: rand(-0.5, 0.5), c: rand(-0.5, 0.5),
        da: rand(0.15, 0.4) * (Math.random() < 0.5 ? -1 : 1), db: 0,
        ring: 0,
      };
      body.y = onScreen ? rand(0, h) : -body.r - rand(0, h * 0.7);
    } else {
      const r = Math.max(3, span * rand(0.006, 0.014));
      body = {
        kind, r, color: ROCK_COLOR,
        x: rand(0, w), y: 0,
        mesh: rock(),
        depth: rand(0.25, 0.5),
        shades: shadesOf(ROCK_COLOR, ROCK_SHADE),
        alpha: 0.17,
        a: rand(0, 6), b: rand(0, 6), c: rand(0, 6),
        da: rand(0.3, 1.1) * (Math.random() < 0.5 ? -1 : 1), db: rand(0.2, 0.8) * (Math.random() < 0.5 ? -1 : 1),
        ring: 0,
      };
      body.y = onScreen ? rand(0, h) : -body.r - rand(0, h * 0.5);
    }
    return body;
  }

  /** Move the scenery on by `dt` seconds. `warp` is how fast the ship is flying (1 at rest). */
  update(dt: number, warp: number): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]!;
      b.y += (5 + 62 * b.depth) * warp * dt;
      b.a += b.da * dt;
      b.b += b.db * dt;
      if (b.y - this.reach(b) > this.h) this.bodies[i] = this.make(b.kind, false);
    }
  }

  /**
   * Draw every body. `shift` is how far, in px, something right behind the ship would have slid sideways;
   * each body slides by its depth's share of that. `lift` moves the whole sky up or down, which is what
   * the view from the cockpit does as the ship's nose rises.
   */
  render(ctx: CanvasRenderingContext2D, shift: number, lift = 0): void {
    ctx.lineJoin = 'round';
    for (const b of this.bodies) {
      const reach = this.reach(b);
      const x = b.x + shift * b.depth;
      const y = b.y + lift;
      if (y + reach < 0 || y - reach > this.h || x + reach < 0 || x - reach > this.w) continue;
      this.draw(ctx, b, x, y);
    }
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'miter';
  }

  private draw(ctx: CanvasRenderingContext2D, b: Body, cx: number, cy: number): void {
    const { X, Y, Z, lit } = this;
    const ca = Math.cos(b.a), sa = Math.sin(b.a);
    const cb = Math.cos(b.b), sb = Math.sin(b.b);
    const cc = Math.cos(b.c), sc = Math.sin(b.c);
    // Spin about the body's own axis, tilt that axis towards the viewer, then roll it over.
    // Screen axes: x to the right, y down, z out of the screen.
    b.mesh.verts.forEach(([vx, vy, vz], i) => {
      const x1 = vx * ca + vz * sa;
      const z1 = -vx * sa + vz * ca;
      const y2 = vy * cb - z1 * sb;
      Z[i] = vy * sb + z1 * cb;
      X[i] = cx + (x1 * cc - y2 * sc) * b.r;
      Y[i] = cy + (x1 * sc + y2 * cc) * b.r;
    });

    ctx.strokeStyle = b.color;
    ctx.lineWidth = 1;
    if (b.ring) this.ring(ctx, b, cx, cy, cb, sb, cc, sc, false);

    // Sort the faces that point at the viewer by how much light falls on them.
    for (const bucket of lit) bucket.length = 0;
    b.mesh.faces.forEach((face, index) => {
      const [i0, i1, i2] = face as [number, number, number];
      const ux = X[i1]! - X[i0]!, uy = Y[i1]! - Y[i0]!, uz = (Z[i1]! - Z[i0]!) * b.r;
      const vx = X[i2]! - X[i0]!, vy = Y[i2]! - Y[i0]!, vz = (Z[i2]! - Z[i0]!) * b.r;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      // Make the normal point outwards, whichever way round the face was listed.
      const out = nx * (X[i0]! + X[i1]! + X[i2]! - 3 * cx) + ny * (Y[i0]! + Y[i1]! + Y[i2]! - 3 * cy) + nz * (Z[i0]! + Z[i1]! + Z[i2]!) * b.r;
      if (out < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      if (nz <= 0) return;
      const len = Math.hypot(nx, ny, nz) || 1;
      const light = Math.max(0, (nx * this.light[0] + ny * this.light[1] + nz * this.light[2]) / len);
      lit[Math.min(LEVELS - 1, Math.floor(light * LEVELS))]!.push(index);
    });

    const outline = (index: number) => {
      const face = b.mesh.faces[index]!;
      ctx.moveTo(X[face[0]!]!, Y[face[0]!]!);
      for (let k = 1; k < face.length; k++) ctx.lineTo(X[face[k]!]!, Y[face[k]!]!);
      ctx.closePath();
    };
    // The fills are solid, so a planet hides the stars and the back of its ring.
    ctx.globalAlpha = 1;
    lit.forEach((bucket, level) => {
      if (!bucket.length) return;
      ctx.fillStyle = b.shades[level]!;
      ctx.beginPath();
      bucket.forEach(outline);
      ctx.fill();
    });
    ctx.globalAlpha = b.alpha;
    ctx.beginPath();
    for (const bucket of lit) bucket.forEach(outline);
    if (b.mesh.spokes) {
      for (const [s0, s1] of b.mesh.spokes) {
        ctx.moveTo(X[s0]!, Y[s0]!);
        ctx.lineTo(X[s1]!, Y[s1]!);
      }
    }
    ctx.stroke();

    if (b.ring) this.ring(ctx, b, cx, cy, cb, sb, cc, sc, true);
  }

  /** A planet's ring: two flat hoops. The whole ring goes down before the planet; the near half again on top. */
  private ring(ctx: CanvasRenderingContext2D, b: Body, cx: number, cy: number, cb: number, sb: number, cc: number, sc: number, nearHalf: boolean): void {
    ctx.globalAlpha = b.alpha * 0.9;
    ctx.beginPath();
    for (const size of [b.ring, b.ring * 0.84]) {
      let penDown = false;
      for (let i = 0; i <= RING_STEPS; i++) {
        const t = (i / RING_STEPS) * Math.PI * 2;
        const rx = Math.cos(t) * size;
        const rz = Math.sin(t) * size;
        // The same tilt and roll as the planet; z is positive on the side nearer the viewer.
        const y2 = -rz * sb;
        const near = rz * cb >= 0;
        const px = cx + (rx * cc - y2 * sc) * b.r;
        const py = cy + (rx * sc + y2 * cc) * b.r;
        if (nearHalf && !near) {
          penDown = false;
        } else if (penDown) {
          ctx.lineTo(px, py);
        } else {
          ctx.moveTo(px, py);
          penDown = true;
        }
      }
    }
    ctx.stroke();
  }
}
