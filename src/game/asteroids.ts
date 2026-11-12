/**
 * The asteroid field. Part way through a wave a belt of rocks comes down the screen, too thick to shoot a
 * way through in time: the little rocks break at a touch, the rest take a pounding. There are two ways
 * through, and neither runs straight: they zigzag, or snake from side to side in loops, one the mirror
 * of the other, so they part and meet again all the way down.
 *
 * - The easy way is wide and swings gently. It has bombs in it, each to one side with room to squeeze past.
 * - The hard way is narrow, swings further and has more little rocks to shoot. It has power-ups instead.
 *
 * This file lays the field out and moves it. game.ts draws it, and handles what hits what.
 */
import { int, rand } from './core';
import { closed, open, type Pt, type Shape } from './shapes';

export interface FieldEnv {
  w: number; h: number;
  /** The safe area's edges. */
  left: number; right: number;
  scale: number; pace: number;
  wave: number;
}

export interface Rock {
  x: number;
  /** How far back from the front of the field it is. Its place on screen is `front - d`. */
  d: number;
  r: number;
  hp: number;
  /** Not one of the little ones: it takes a good many shots, and they spark off it until it goes. */
  tough: boolean;
  rot: number; spin: number;
  shape: Shape;
  flash: number;
  dead: boolean;
}

/** One of the two ways through: how far it swings to each side, and how wide it is. */
interface Lane { swing: number; width: number }
/** Something lying in a lane, placed in the same terms as the rocks. */
interface Spot { x: number; d: number }

export interface Field {
  rocks: Rock[];
  /** Where the bombs (easy way) and the power-ups (hard way) go. game.ts makes the real things of them. */
  bombs: Spot[];
  prizes: Spot[];
  /** Where each way is signposted: just after they first part. */
  signs: { x: number; d: number; hard: boolean }[];
  /** Screen height of the front of the field. It starts above the screen and falls. */
  front: number;
  speed: number;
  length: number;
  /** The ways through: which way they bend, where they are centred, how long one swing there and back is. */
  bends: 'zigzag' | 'loops';
  mid: number; period: number; turn: number;
  easy: Lane; hard: Lane;
  /** How far in the mouth of the field is still wider than the rest. */
  mouth: number;
  age: number;
  done: boolean;
}

/** Centre of a way through, `d` px back from the front of the field. The hard way mirrors the easy one. */
function centre(f: Field, d: number, hard: boolean): number {
  const u = Math.max(0, d - f.mouth * 0.6) / f.period;
  const bend = f.bends === 'zigzag' ? 1 - 4 * Math.abs(((u + 0.25) % 1) - 0.5) : Math.sin(u * Math.PI * 2);
  return f.mid + (hard ? -f.hard.swing : f.easy.swing) * f.turn * bend;
}

/** Width of a way through there: wide at the mouth, so there is time to find it, and wide again at the far end. */
function widthAt(f: Field, d: number, hard: boolean): number {
  const opening = Math.max(0, 1 - d / f.mouth);
  const closing = Math.max(0, 1 - (f.length - d) / (f.mouth * 0.5));
  return (hard ? f.hard : f.easy).width * (1 + 1.6 * opening + 0.8 * closing);
}

/** Centre of a way through at a height on the screen, or null where the field has not reached or has passed. */
export function gapAt(f: Field, y: number, hard = false): number | null {
  const d = f.front - y;
  return d < 0 || d > f.length ? null : centre(f, d, hard);
}

/** Whether a circle is wholly outside both ways through. They slant, so this looks along them, not just across. */
function clearOfGaps(f: Field, x: number, d: number, r: number): boolean {
  for (const hard of [false, true]) {
    const reach = widthAt(f, d, hard) / 2 + r + f.easy.width;
    for (let at = d - reach; at <= d + reach; at += 9) {
      if (at < -40 || at > f.length + 40) continue;
      const from = Math.min(f.length, Math.max(0, at));
      if (Math.hypot(x - centre(f, from, hard), d - at) < widthAt(f, from, hard) / 2 + r) return false;
    }
  }
  return true;
}

/** A lump of rock: an uneven outline, and on the bigger ones a couple of ridges, so it looks cut, not round. */
function rockShape(r: number): Shape {
  const n = r > 24 ? 9 : r > 14 ? 8 : 6;
  const turn = rand(0, Math.PI * 2);
  const pts: Pt[] = Array.from({ length: n }, (_, i) => {
    const a = turn + ((i + rand(-0.22, 0.22)) / n) * Math.PI * 2;
    const reach = r * rand(0.74, 1.06);
    return [Math.round(Math.cos(a) * reach * 10) / 10, Math.round(Math.sin(a) * reach * 10) / 10] as const;
  });
  const shape = [closed(...pts)];
  if (r > 14) {
    const hub: Pt = [rand(-0.2, 0.2) * r, rand(-0.2, 0.2) * r];
    const a = int(0, n - 1);
    shape.push(open(pts[a]!, hub, pts[(a + Math.floor(n / 3) + 1) % n]!));
    if (r > 24) shape.push(open(hub, pts[(a + Math.floor((2 * n) / 3) + 1) % n]!));
  }
  return shape;
}

function makeRock(x: number, d: number, r: number, tough: boolean): Rock {
  return {
    x, d, r, tough,
    // Little ones go in one shot. The rest can be broken too, but it takes long enough that flying round is quicker.
    hp: !tough ? 1 : r > 24 ? 20 : 8,
    rot: rand(0, Math.PI * 2), spin: rand(-0.5, 0.5) * (tough ? 0.5 : 1.6),
    shape: rockShape(r), flash: 0, dead: false,
  };
}

export function createField(env: FieldEnv): Field {
  const s = env.scale;
  const k = Math.max(0, env.wave - 1);
  const left = env.left;
  const right = env.w - env.right;
  // Later waves bring narrower ways through, a faster field and more bends.
  const wide = Math.max(106, 152 - 6 * k) * s;
  const narrow = Math.max(80 * s, wide * 0.7);
  const speed = Math.min(250, 170 + 9 * k) * env.pace;
  // The hard way swings as far as the screen allows; the easy way a little over half as far.
  const reach = Math.max(0, Math.min(170 * s, (right - left) / 2 - narrow / 2 - 26 * s));
  const hard: Lane = { swing: reach, width: narrow };
  const easy: Lane = { swing: Math.max(0, Math.min(reach * 0.58, (right - left) / 2 - wide / 2 - 26 * s)), width: wide };
  const bends = Math.random() < 0.5 ? 'zigzag' : 'loops';
  // How hard the hard way is to follow: the sideways speed it asks for, as a share of what the ship can do.
  // (The easy way, swinging less far in the same distance, asks for a little over half of that.)
  const ask = Math.min(0.7, 0.5 + 0.03 * k) * 380 * s;
  const period = Math.max(260 * s, ((bends === 'zigzag' ? 4 : Math.PI * 2) * hard.swing * speed) / ask);
  const mouth = 300 * s;
  const swings = Math.min(6, 3 + Math.floor(k / 2));
  const f: Field = {
    rocks: [], bombs: [], prizes: [], signs: [], front: -30, speed, bends,
    mid: (left + right) / 2, period, turn: Math.random() < 0.5 ? -1 : 1, easy, hard,
    mouth, length: mouth * 0.6 + (swings * period) / 2 + mouth * 0.5, age: 0, done: false,
  };

  const rocks = f.rocks;
  const fits = (x: number, d: number, r: number, gap = 5 * s): boolean => {
    for (const o of rocks) if (Math.abs(o.d - d) < o.r + r + gap && Math.hypot(o.x - x, o.d - d) < o.r + r + gap) return false;
    return true;
  };
  // First the walls: tough rocks lining both sides of each way through, so that they read as ways through.
  for (const lane of [false, true]) {
    for (let d = 10 * s; d < f.length; d += rand(34, 50) * s) {
      for (const side of [-1, 1]) {
        const r = rand(15, 36) * s;
        let x = centre(f, d, lane) + side * (widthAt(f, d, lane) / 2 + r + 2);
        for (let tries = 0; tries < 30 && !clearOfGaps(f, x, d, r); tries++) x += side * 6 * s;
        if (x < left - 50 * s || x > right + 50 * s || !clearOfGaps(f, x, d, r) || !fits(x, d, r, 1)) continue;
        rocks.push(makeRock(x, d, r, true));
      }
    }
  }
  // Then the rest of the belt, thrown down wherever there is room: a third of it little rocks.
  const tries = Math.round(((right - left + 60 * s) * f.length) / (46 * s * 46 * s));
  for (let i = 0; i < tries; i++) {
    const little = Math.random() < 0.34;
    const r = (little ? rand(8.5, 12) : Math.random() < 0.45 ? rand(26, 38) : rand(15, 23)) * s;
    const x = rand(left - 20 * s, right + 20 * s);
    const d = rand(0, f.length);
    if (clearOfGaps(f, x, d, r) && fits(x, d, r)) rocks.push(makeRock(x, d, r, !little));
  }

  // What lies in the ways through goes where they run apart, a quarter and three quarters of the way
  // round each swing, never where they cross.
  const start = mouth * 0.6;
  const apexes: number[] = [];
  for (let d = start + period / 4; d < f.length - mouth * 0.5; d += period / 2) apexes.push(d);
  const spread = (count: number): number[] => {
    // `count` of the apexes, evenly spaced, the first one left for the signs.
    const free = apexes.slice(1);
    if (!free.length) return apexes.slice(0, 1);
    return Array.from({ length: Math.min(count, free.length) }, (_, i) => free[Math.min(free.length - 1, Math.round(((i + 0.5) / Math.min(count, free.length)) * free.length - 0.5))]!);
  };
  // The easy way: bombs, each to one side.
  for (const at of spread(Math.min(3, 1 + Math.floor(env.wave / 2)))) {
    const d = at + rand(-0.08, 0.08) * period;
    f.bombs.push({ x: centre(f, d, false) + (Math.random() < 0.5 ? -1 : 1) * 0.26 * easy.width, d });
  }
  // The hard way: power-ups, in the middle of it.
  for (const at of spread(env.wave >= 3 ? 3 : 2)) {
    const d = at + rand(-0.06, 0.06) * period;
    f.prizes.push({ x: centre(f, d, true), d });
  }
  if (apexes.length) {
    const d = apexes[0]! - 30 * s;
    f.signs.push({ x: centre(f, d, false), d, hard: false }, { x: centre(f, d, true), d, hard: true });
  }
  // Little rocks to shoot: a few in the easy way, twice as many in the hard one.
  for (const lane of [false, true]) {
    const taken = lane ? f.prizes : f.bombs;
    const width = (lane ? hard : easy).width;
    for (let d = start + rand(0.2, 0.5) * period; d < f.length - mouth * 0.5; d += rand(0.45, 0.8) * period * (lane ? 0.5 : 1)) {
      if (taken.some((t) => Math.abs(t.d - d) < 80 * s) || f.signs.some((sign) => Math.abs(sign.d - d) < 50 * s)) continue;
      const r = rand(8.5, 11) * s;
      const x = centre(f, d, lane) + rand(-0.3, 0.3) * width;
      if (fits(x, d, r)) rocks.push(makeRock(x, d, r, false));
    }
  }
  return f;
}

/** Move the field on. It is over once the last of it has left the bottom of the screen. */
export function updateField(f: Field, dt: number, real: number, env: FieldEnv): void {
  f.age += dt;
  f.front += f.speed * dt;
  for (const rock of f.rocks) {
    rock.rot += rock.spin * dt;
    rock.flash = Math.max(0, rock.flash - real);
  }
  if (f.front - f.length > env.h + 60 * env.scale) f.done = true;
}
