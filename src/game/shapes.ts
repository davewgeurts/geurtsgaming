/**
 * Line-art shapes for the hero arcade game. Everything is stroked, never filled,
 * so it reads like an old vector monitor. Coordinates are in px at scale 1, origin at the centre.
 */
import type { ShipId } from './loadout';

export type Pt = readonly [number, number];
export interface Poly { pts: readonly Pt[]; closed: boolean }
export type Shape = readonly Poly[];

export const closed = (...pts: Pt[]): Poly => ({ pts, closed: true });
export const open = (...pts: Pt[]): Poly => ({ pts, closed: false });
const round1 = (v: number) => Math.round(v * 10) / 10;
export const ngon = (n: number, r: number, rot = 0): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [round1(Math.cos(a) * r), round1(Math.sin(a) * r)] as const;
  });
/** Points along part of a circle, from one angle to another. */
const arc = (r: number, from: number, to: number, steps: number): Pt[] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / steps;
    return [round1(Math.cos(a) * r), round1(Math.sin(a) * r)] as const;
  });

/** Player ship, nose up (Starhawk balanced striker). The same outline is used for the launch button in the hero. */
export const SHIP: Shape = [
  closed([0, -16], [4, -4], [13, 10], [5, 7], [3, 12], [-3, 12], [-5, 7], [-13, 10], [-4, -4]),
  closed([0, -8], [2, -3], [0, 1], [-2, -3]),
];

/** Fast interceptor (Swift): needle nose, forward-swept gull wings and twin nose blasters. */
export const SHIP_SWIFT: Shape = [
  closed([0, -19], [2.6, -7], [11.5, -10.5], [13, 2], [4.5, 6], [2.4, 12.5], [-2.4, 12.5], [-4.5, 6], [-13, 2], [-11.5, -10.5], [-2.6, -7]),
  closed([0, -11], [1.8, -4], [0, 2], [-1.8, -4]),
  open([-2.6, -7], [-2.6, -12.5]),
  open([2.6, -7], [2.6, -12.5]),
];

/** Heavy armoured gunship (Bastion): twin-prong nose, broad wingtip cannon pods and twin engine nacelles. */
export const SHIP_BASTION: Shape = [
  closed(
    [-4.5, -14], [-1.8, -11], [1.8, -11], [4.5, -14], [6.5, -6], [14.5, -2], [14.5, 8.5],
    [9, 10.5], [7.5, 13], [3.2, 13], [2.2, 9.5], [-2.2, 9.5], [-3.2, 13], [-7.5, 13],
    [-9, 10.5], [-14.5, 8.5], [-14.5, -2], [-6.5, -6],
  ),
  closed([-4, -6.5], [4, -6.5], [5, -0.5], [-5, -0.5]),
  open([-12, -2], [-12, -8.5]),
  open([12, -2], [12, -8.5]),
];

/** Top-down 2D silhouette matching the ship picked in the hangar. */
export function shipShape(id: ShipId): Shape {
  if (id === 'swift') return SHIP_SWIFT;
  if (id === 'bastion') return SHIP_BASTION;
  return SHIP;
}

/** Trace the exhaust flame(s) behind the chosen ship's top-down nozzle(s). */
export function traceShipThrusters(
  ctx: CanvasRenderingContext2D,
  id: ShipId,
  x: number,
  y: number,
  s: number,
  flame: number,
): void {
  if (id === 'swift') {
    ctx.moveTo(x - 2.2 * s, y + 13 * s);
    ctx.lineTo(x, y + 13 * s + flame * 1.25);
    ctx.lineTo(x + 2.2 * s, y + 13 * s);
    return;
  }
  if (id === 'bastion') {
    for (const side of [-1, 1]) {
      const nx = x + side * 5.35 * s;
      ctx.moveTo(nx - 2.1 * s, y + 13.5 * s);
      ctx.lineTo(nx, y + 13.5 * s + flame * 0.9);
      ctx.lineTo(nx + 2.1 * s, y + 13.5 * s);
    }
    return;
  }
  ctx.moveTo(x - 3 * s, y + 13 * s);
  ctx.lineTo(x, y + 13 * s + flame);
  ctx.lineTo(x + 3 * s, y + 13 * s);
}

/** Slow enemy that snakes down the screen in a chain. */
export const DRIFTER: Shape = [
  closed([0, -12], [11, 0], [0, 12], [-11, 0]),
  closed([0, -5], [5, 0], [0, 5], [-5, 0]),
];

/** Fast enemy that locks on and dives. Drawn nose down. */
export const DART: Shape = [closed([0, 15], [8, -11], [0, -5], [-8, -11]), open([0, -5], [0, 6])];

/** Tough enemy that holds position, spins and fires aimed shots. */
export const HEX: Shape = [closed(...ngon(6, 15)), closed(...ngon(3, 7, -Math.PI / 2))];

/** Zigzags down the screen in sharp diagonals. Drawn nose down. */
export const WEAVER: Shape = [
  closed([0, 11], [13, -9], [6, -10], [0, -1], [-6, -10], [-13, -9]),
  open([-4, 3], [0, 7], [4, 3]),
];

/** Tiny, quick, and never alone: mites fly in a V. Drawn nose down. */
export const MITE: Shape = [closed([0, 8], [6, -6], [0, -2], [-6, -6])];

/** A slow lump that breaks into two shards when it is destroyed. The crack shows where. */
export const SPLITTER: Shape = [
  closed(...ngon(8, 17, Math.PI / 8)),
  open([-1, -15.5], [-5, -5], [4, 2], [-1, 15.5]),
];
export const SHARD: Shape = [closed([-1, -10], [7, 5], [-6, 7]), open([-1, -10], [0, 4])];

/** A pinwheel that spirals down in a ring of three. */
export const SPINNER: Shape = [
  closed(...ngon(4, 5)),
  ...Array.from({ length: 4 }, (_, i) => {
    const a = (i * Math.PI) / 2;
    const at = (r: number, turn: number): Pt => [round1(Math.cos(a + turn) * r), round1(Math.sin(a + turn) * r)];
    return open(at(5, 0), at(14, 0), at(11, 0.7));
  }),
];

/** Crosses the top of the screen, dropping shots as it goes. */
export const SAUCER: Shape = [
  closed([-19, 2], [-9, -4], [9, -4], [19, 2], [9, 7], [-9, 7]),
  open([-6, -4], [-3, -10], [3, -10], [6, -4]),
  open([-19, 2], [19, 2]),
];

/** Boost capsule: the ring, and the mark inside that says what it holds. */
export const CAPSULE: Shape = [closed(...ngon(8, 13, Math.PI / 8))];
export const MARK_HULL: Shape = [open([-6, 0], [6, 0]), open([0, -6], [0, 6])];
export const MARK_ENERGY: Shape = [open([3, -8], [-4, 1], [3, 1], [-3, 8])];
/** The mark of an upgrade capsule: a four-pointed star. */
export const MARK_STAR: Shape = [closed([0, -9], [2.5, -2.5], [9, 0], [2.5, 2.5], [0, 9], [-2.5, 2.5], [-9, 0], [-2.5, -2.5])];
export const MARK_BOMB: Shape = [open([-5, -5], [5, 5]), open([5, -5], [-5, 5]), open([0, -8], [0, 8]), open([-8, 0], [8, 0])];

/** A hazard bomb: fly into one and it must be defused. */
export const MINE: Shape = [
  closed(...ngon(8, 9, Math.PI / 8)),
  ...Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return open([round1(Math.cos(a) * 9), round1(Math.sin(a) * 9)], [round1(Math.cos(a) * 15), round1(Math.sin(a) * 15)]);
  }),
];

/** A seeker rocket, nose up. */
export const ROCKET: Shape = [closed([0, -8], [3, -2], [3, 5], [-3, 5], [-3, -2]), open([-3, 2], [-6, 7]), open([3, 2], [6, 7])];
/** A friend's ship: the player's own outline without the cockpit, drawn small. */
export const FRIEND: Shape = [SHIP[0]!];

/** The fuel ship, nose up: a fat hull with a fuel tank slung on each side. Its fuel line leaves from the tail. */
export const TANKER: Shape = [
  closed([0, -34], [9, -24], [11, 4], [20, 12], [20, 22], [9, 20], [6, 30], [-6, 30], [-9, 20], [-20, 22], [-20, 12], [-11, 4], [-9, -24]),
  closed([-30, -18], [-24, -24], [-18, -18], [-18, 0], [-24, 6], [-30, 0]),
  closed([30, -18], [24, -24], [18, -18], [18, 0], [24, 6], [30, 0]),
  open([-18, -9], [-10, -9]),
  open([18, -9], [10, -9]),
  // The mark on its back: a drop of fuel.
  closed([0, -17], [4.5, -8], [0, -3], [-4.5, -8]),
];
/** The basket on the end of the fuel line, open toward the ship that is to fly into it. */
export const DROGUE: Shape = [closed([-3, -5], [3, -5], [8, 4], [-8, 4]), open([-5.5, -0.5], [5.5, -0.5])];

/** Somebody set free, cheering: arms up, then arms out. Drawn one after the other, they wave. */
const person = (...arms: Pt[]): Shape => [closed(...ngon(6, 2.6).map(([x, y]) => [x, round1(y - 6.6)] as const)), open([0, -4], [0, 2]), open(...arms), open([-3.5, 8], [0, 2], [3.5, 8])];
export const PERSON_UP: Shape = person([-5, -8], [0, -2.5], [5, -8]);
export const PERSON_OUT: Shape = person([-6, -3.5], [0, -2.5], [6, -3.5]);

/** Mini boss. The core is the weak spot; the shell is one half of its armour (drawn twice, the second turned round). */
export const BOSS_CORE: Shape = [closed(...ngon(8, 24, Math.PI / 8))];
export const BOSS_EYE: Shape = [closed(...ngon(4, 12)), closed(...ngon(4, 5))];
export const BOSS_SHELL: Shape = [closed(...arc(35, -1.42, 1.42, 6), ...arc(28, 1.42, -1.42, 6))];
export const BOSS_WINGS: Shape = [
  open([-36, -6], [-66, -28], [-98, -10], [-78, 8], [-40, 10]),
  open([36, -6], [66, -28], [98, -10], [78, 8], [40, 10]),
  open([-18, -36], [0, -52], [18, -36]),
];
/** The hand at the end of a boss arm, pointing down. */
export const CLAW: Shape = [closed([0, 13], [9, -7], [0, -2], [-9, -7])];
/** A little escort ship with room for a number inside. */
export const POD: Shape = [closed(...ngon(6, 18, Math.PI / 6)), open([-15, 9], [-24, 17]), open([15, 9], [24, 17])];

/** Add a shape to the current canvas path, moved to (x, y), scaled and rotated. */
export function trace(ctx: CanvasRenderingContext2D, shape: Shape, x: number, y: number, scale = 1, rot = 0): void {
  const c = Math.cos(rot) * scale;
  const s = Math.sin(rot) * scale;
  for (const poly of shape) {
    poly.pts.forEach(([px, py], i) => {
      const tx = x + px * c - py * s;
      const ty = y + px * s + py * c;
      if (i === 0) ctx.moveTo(tx, ty);
      else ctx.lineTo(tx, ty);
    });
    if (poly.closed) ctx.closePath();
  }
}

/** The individual line segments of a placed shape, as [x1, y1, x2, y2]. Used to break a ship apart. */
export function segments(shape: Shape, x: number, y: number, scale = 1, rot = 0): [number, number, number, number][] {
  const c = Math.cos(rot) * scale;
  const s = Math.sin(rot) * scale;
  const out: [number, number, number, number][] = [];
  for (const poly of shape) {
    const pts = poly.pts.map(([px, py]) => [x + px * c - py * s, y + px * s + py * c] as const);
    const count = poly.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      out.push([a[0], a[1], b[0], b[1]]);
    }
  }
  return out;
}
