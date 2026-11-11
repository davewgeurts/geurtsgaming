/**
 * Line-art shapes for the hero arcade game. Everything is stroked, never filled,
 * so it reads like an old vector monitor. Coordinates are in px at scale 1, origin at the centre.
 */
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

/** Player ship, nose up. The same outline is used for the launch button in the hero. */
export const SHIP: Shape = [
  closed([0, -16], [4, -4], [13, 10], [5, 7], [3, 12], [-3, 12], [-5, 7], [-13, 10], [-4, -4]),
  closed([0, -8], [2, -3], [0, 1], [-2, -3]),
];

/** Slow enemy that snakes down the screen in a chain. */
export const DRIFTER: Shape = [
  closed([0, -12], [11, 0], [0, 12], [-11, 0]),
  closed([0, -5], [5, 0], [0, 5], [-5, 0]),
];

/** Fast enemy that locks on and dives. Drawn nose down. */
export const DART: Shape = [closed([0, 15], [8, -11], [0, -5], [-8, -11]), open([0, -5], [0, 6])];

/** Tough enemy that holds position, spins and fires aimed shots. */
export const HEX: Shape = [closed(...ngon(6, 15)), closed(...ngon(3, 7, -Math.PI / 2))];

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
export const FRIEND: Shape = [closed([0, -16], [4, -4], [13, 10], [5, 7], [3, 12], [-3, 12], [-5, 7], [-13, 10], [-4, -4])];

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
