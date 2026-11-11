/**
 * Line-art shapes for the hero arcade game. Everything is stroked, never filled,
 * so it reads like an old vector monitor. Coordinates are in px at scale 1, origin at the centre.
 */
export type Pt = readonly [number, number];
export interface Poly { pts: readonly Pt[]; closed: boolean }
export type Shape = readonly Poly[];

const closed = (...pts: Pt[]): Poly => ({ pts, closed: true });
const open = (...pts: Pt[]): Poly => ({ pts, closed: false });
const ngon = (n: number, r: number, rot = 0): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [Math.round(Math.cos(a) * r * 10) / 10, Math.round(Math.sin(a) * r * 10) / 10] as const;
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
