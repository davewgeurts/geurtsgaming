/**
 * Shared math, random, colour palette, vector stroke and 3D wireframe primitives
 * used across the arcade demo and shared with `@funsociety/corepak`.
 */

export const BASE_BG = 'rgb(3, 7, 26)';
export const SAND = '#ecdfd2';
export const PINK = '#d98ac0';
export const MINT = '#7fe0b0';
export const BLUE = '#6f8cff';
/** Enemies come in a few warm colours, one per family, so a new kind is easy to tell from an old one. */
export const LILAC = '#b3a0ff';
export const AMBER = '#f0b45a';
export const ROSE = '#ff7ab8';
/** The people set free are drawn in the brightest colour in the game, and so is their count. */
export const SOUL = '#f4fbff';
/** Rocks: the tough ones are dull, the little ones that break at a touch are bright. */
export const ROCK = '#7c8fa8';
export const PEBBLE = '#d7e3f2';

/** The loud colours kept for the boss, upgrades, and anything exploding. */
export const NEON = {
  cyan: '#42f5ff',
  lime: '#9bff4d',
  yellow: '#ffe84a',
  orange: '#ff9b2f',
  red: '#ff3552',
  violet: '#b98cff',
} as const;

export const NEON_LIST: readonly string[] = Object.values(NEON);

export const rand = (min: number, max: number): number => min + Math.random() * (max - min);
export const int = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1));
export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
export const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = int(0, i);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export const pad6 = (n: number): string => String(n).padStart(6, '0');
export const percent = (v: number): number => Math.round(v * 100);

export type Ink = (color: string, alpha: number, width: number, build: () => void, glow?: boolean) => void;

/** Stroke whatever `build` adds to the path: a soft wide pass for glow, then the bright line. */
export function strokeInk(
  ctx: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  width: number,
  build: () => void,
  glow = true,
): void {
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

export type Seg3D = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => void;

/**
 * Trace a 3D wireframe box standing on `y` with width `wide`, height `tall`, and depth `deep`.
 * When `centeredZ` is true (default), `(x, z)` is the centre of the base; when false, `z` is the front face.
 */
export function box3d(
  seg: Seg3D,
  x: number,
  y: number,
  z: number,
  wide: number,
  tall: number,
  deep: number,
  centeredZ = true,
): void {
  const x0 = x - wide / 2;
  const x1 = x + wide / 2;
  const z0 = centeredZ ? z - deep / 2 : z;
  const z1 = centeredZ ? z + deep / 2 : z + deep;
  const y1 = y + tall;
  for (const [px, pz, qx, qz] of [
    [x0, z0, x1, z0],
    [x1, z0, x1, z1],
    [x1, z1, x0, z1],
    [x0, z1, x0, z0],
  ] as const) {
    seg(px, y, pz, qx, y, qz);
    seg(px, y1, pz, qx, y1, qz);
    seg(px, y, pz, px, y1, pz);
  }
}
