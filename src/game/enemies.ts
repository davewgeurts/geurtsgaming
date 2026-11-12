/**
 * Wave enemy types, wave choreography (`buildWavePlan`), spawning, movement AI, and rendering.
 */
import { AMBER, LILAC, PINK, ROSE, SAND, SOUL, clamp, pick, rand, type Ink } from './core';
import { DART, DRIFTER, HEX, MITE, SAUCER, SHARD, SPINNER, SPLITTER, WEAVER, trace, type Shape } from './shapes';

export type Kind = 'drifter' | 'dart' | 'hex' | 'weaver' | 'mite' | 'splitter' | 'shard' | 'spinner' | 'saucer';
/** The groups a wave is built from, and the wave each first appears in. */
export type Group = 'drifters' | 'mites' | 'weavers' | 'spinners';

export const KINDS: Record<Kind, { shape: Shape; radius: number; hp: number; points: number; color: string }> = {
  drifter: { shape: DRIFTER, radius: 12, hp: 1, points: 50, color: PINK },
  dart: { shape: DART, radius: 11, hp: 1, points: 100, color: PINK },
  hex: { shape: HEX, radius: 15, hp: 2, points: 150, color: PINK },
  weaver: { shape: WEAVER, radius: 12, hp: 1, points: 80, color: LILAC },
  mite: { shape: MITE, radius: 7, hp: 1, points: 30, color: LILAC },
  splitter: { shape: SPLITTER, radius: 17, hp: 3, points: 120, color: AMBER },
  shard: { shape: SHARD, radius: 8, hp: 1, points: 40, color: AMBER },
  spinner: { shape: SPINNER, radius: 13, hp: 1, points: 90, color: ROSE },
  saucer: { shape: SAUCER, radius: 16, hp: 2, points: 200, color: ROSE },
};

export const ENEMY_COLORS = [PINK, LILAC, AMBER, ROSE] as const;
export const GROUP_FROM: Record<Group, number> = { drifters: 1, mites: 1, weavers: 2, spinners: 3 };

export interface Enemy {
  kind: Kind;
  x: number; y: number; vx: number; vy: number; rot: number;
  hp: number; age: number; flash: number; dead: boolean;
  /** Drifter, weaver, spinner: centre line and width of its path. */
  anchorX: number; phase: number; amp: number;
  /** Seconds until the next shot; 0 or less means it never fires (drifters) or fires now (hexes, saucers). */
  fireIn: number;
  /** Dart: has locked on. Hex: is leaving the screen. */
  committed: boolean;
  /** Hex, saucer: the height it holds at. Spinner: the height of the centre of its loop. */
  holdY: number;
}

export interface Spawn {
  at: number;
  kind: Kind;
  x: number;
  phase: number;
  /** Weaver, saucer: which way it sets off, -1 or 1. */
  dir?: number;
}

export interface WavePlan {
  queue: Spawn[];
  pickupTimes: number[];
  upgradeTimes: number[];
  mineTimes: number[];
  stops: { at: number; kind: 'fuel' | 'rocks' }[];
}

export function spawnX(w: number, inset: { left: number; right: number }, scale: number): number {
  const m = 40 * scale + 30;
  return rand(inset.left + m, Math.max(inset.left + m + 1, w - inset.right - m));
}

/**
 * A wave is a run of groups, one after another (a chain of drifters, a V of mites, a pair of weavers,
 * a ring of spinners), with loners arriving in between: darts, hexes, splitters and saucers.
 * New kinds join as the waves go by, and the wave a group first appears in always includes it.
 */
export function buildWavePlan(
  n: number,
  w: number,
  inset: { left: number; right: number },
  scale: number,
  margin: number,
  hasMoreUpgrades: boolean,
): WavePlan {
  const q: Spawn[] = [];
  const sc = scale;
  const slots = Math.min(6, 2 + Math.ceil(n / 2));
  const chainLength = Math.min(5, 3 + Math.floor(n / 3));
  const gap = Math.max(1.3, 2.6 - n * 0.15);
  const known = (Object.keys(GROUP_FROM) as Group[]).filter((g) => GROUP_FROM[g] <= n);
  const fresh = known.filter((g) => g !== 'drifters' && GROUP_FROM[g] === n);
  let t = 1.5;
  // Two set pieces break the wave up: the fuel ship about a third of the way through its groups and the
  // asteroid field about two thirds. Each comes between two groups: once every group before it has finished
  // arriving, and with the next group held back until it is over. (The wave's clock stops while it is here.)
  const fuelSlot = Math.max(1, Math.round(slots / 3));
  const rockSlot = Math.max(fuelSlot + 1, Math.round((2 * slots) / 3));
  const stops: { at: number; kind: 'fuel' | 'rocks' }[] = [];
  /** When the last enemy of the groups so far arrives. */
  let arrived = 0;
  for (let i = 0; i < slots; i++) {
    if (i === fuelSlot || i === rockSlot) {
      const at = Math.max(t - 0.2, arrived + 0.05);
      stops.push({ at, kind: i === fuelSlot ? 'fuel' : 'rocks' });
      t = Math.max(t, at + 0.2);
    }
    // Open with drifters, show off anything new next, then mix (drifters stay the most common).
    const group: Group = i === 0 ? 'drifters' : fresh[i - 1] ?? pick([...known, 'drifters']);
    const x = spawnX(w, inset, sc);
    if (group === 'drifters') {
      const phase = rand(0, Math.PI * 2);
      for (let k = 0; k < chainLength; k++) q.push({ at: t + k * 0.42, kind: 'drifter', x, phase });
      arrived = Math.max(arrived, t + (chainLength - 1) * 0.42);
    } else if (group === 'mites') {
      // A V of five, the leader in front.
      const reach = 44 * sc;
      const lead = clamp(x, inset.left + margin + reach, Math.max(inset.left + margin + reach, w - inset.right - margin - reach));
      for (let k = -2; k <= 2; k++) q.push({ at: t + Math.abs(k) * 0.16, kind: 'mite', x: lead + k * 22 * sc, phase: 0 });
      arrived = Math.max(arrived, t + 0.32);
    } else if (group === 'weavers') {
      const dir = Math.random() < 0.5 ? -1 : 1;
      for (let k = 0; k < (n >= 5 ? 3 : 2); k++) q.push({ at: t + k * 0.55, kind: 'weaver', x, phase: 0, dir: k % 2 ? -dir : dir });
      arrived = Math.max(arrived, t + (n >= 5 ? 1.1 : 0.55));
    } else {
      // Three spinners a third of a turn apart make a ring that turns as it comes down.
      const phase = rand(0, Math.PI * 2);
      for (let k = 0; k < 3; k++) q.push({ at: t, kind: 'spinner', x, phase: phase + (k * Math.PI * 2) / 3 });
      arrived = Math.max(arrived, t);
    }
    t += gap;
  }
  const loners = (kind: Kind, count: number, from = 2.5) => {
    for (let i = 0; i < count; i++) {
      q.push({ at: rand(from, t + 1), kind, x: spawnX(w, inset, sc), phase: 0, dir: Math.random() < 0.5 ? -1 : 1 });
    }
  };
  if (n >= 2) loners('dart', Math.min(8, n + 1));
  if (n >= 3) loners('hex', Math.min(3, Math.floor((n - 1) / 2)), 2);
  if (n >= 3) loners('splitter', Math.min(3, Math.floor(n / 2)), 3);
  if (n >= 4) loners('saucer', Math.min(2, Math.floor((n - 2) / 2)), 4);

  const moments = (count: number) => Array.from({ length: count }, () => rand(3, Math.max(4, t - 1))).sort((a, b) => a - b);
  const pickupTimes = moments(n >= 4 ? 2 : 1);
  // One upgrade capsule a wave, for as long as there are upgrades left to earn.
  const upgradeTimes = hasMoreUpgrades ? moments(1) : [];
  const mineTimes = moments(Math.min(4, 1 + Math.floor(n / 2)));

  return {
    queue: q.sort((a, b) => a.at - b.at),
    pickupTimes,
    upgradeTimes,
    mineTimes,
    stops,
  };
}

export function makeEnemy(kind: Kind, x: number, y: number, phase = 0): Enemy {
  return {
    kind,
    x, y, vx: 0, vy: 0, rot: 0,
    hp: KINDS[kind].hp, age: 0, flash: 0, dead: false,
    anchorX: x, phase, amp: 0,
    fireIn: 0, committed: false, holdY: 0,
  };
}

export function spawnEnemy(
  sp: Spawn,
  wave: number,
  w: number,
  h: number,
  topInset: number,
  scale: number,
  pace: number,
): Enemy {
  const n = wave;
  const sc = scale;
  const e = makeEnemy(sp.kind, sp.x, -30, sp.phase);
  const dir = sp.dir ?? 1;
  if (sp.kind === 'drifter') {
    e.vy = Math.min(112, 62 + n * 5) * pace;
    e.amp = Math.min(rand(46, 72) * sc, w * 0.14);
    if (n >= 3 && Math.random() < 0.3) e.fireIn = rand(0.9, 2.4);
  } else if (sp.kind === 'dart') {
    e.vy = 60 * pace;
  } else if (sp.kind === 'hex') {
    e.hp = n >= 6 ? 3 : 2;
    e.holdY = clamp(rand(h * 0.14, h * 0.34), topInset + 90, h * 0.4);
    e.vx = (Math.random() < 0.5 ? -1 : 1) * Math.min(130, 70 + n * 6);
    e.fireIn = rand(1.2, 2.2);
  } else if (sp.kind === 'weaver') {
    e.vy = Math.min(120, 78 + n * 4) * pace;
    e.vx = dir * Math.min(230, 150 + n * 8) * sc;
    e.amp = Math.min(rand(90, 130) * sc, w * 0.24);
  } else if (sp.kind === 'mite') {
    e.vy = Math.min(210, 135 + n * 7) * pace;
  } else if (sp.kind === 'splitter') {
    e.vy = 46 * pace;
    e.hp = n >= 7 ? 4 : 3;
  } else if (sp.kind === 'spinner') {
    e.amp = Math.min(rand(42, 58) * sc, w * 0.16);
    e.vy = Math.min(84, 52 + n * 3) * pace;
    e.holdY = -30 - e.amp;
    e.y = e.holdY;
  } else if (sp.kind === 'saucer') {
    // Comes in from one side and leaves by the other.
    e.x = dir > 0 ? -40 : w + 40;
    e.vx = dir * Math.min(190, 115 + n * 7) * sc;
    e.holdY = clamp(rand(h * 0.13, h * 0.3), topInset + 90, h * 0.4);
    e.y = e.holdY;
    e.fireIn = rand(0.5, 1);
  }
  return e;
}

/** Two shards fly out and down when a splitter is destroyed. */
export function splitShards(e: Enemy, scale: number, pace: number): Enemy[] {
  return [-1, 1].map((side) => {
    const shard = makeEnemy('shard', e.x + side * 8 * scale, e.y);
    shard.vx = side * rand(90, 140) * scale;
    shard.vy = rand(130, 170) * pace;
    shard.rot = rand(0, Math.PI * 2);
    return shard;
  });
}

export interface EnemyUpdateEnv {
  playing: boolean;
  wave: number;
  w: number;
  h: number;
  left: number;
  right: number;
  scale: number;
  pace: number;
  shipX: number;
  shipY: number;
  fireShot: (x: number, y: number, vx: number, vy: number, color: string) => void;
}

/** `dt` is game time; `real` is the time that actually passed, which a hit's flash is timed by. */
export function updateEnemies(enemies: Enemy[], dt: number, real: number, env: EnemyUpdateEnv): void {
  const { playing, wave, w, h, left, right, scale, pace, shipX, shipY, fireShot } = env;

  for (const e of enemies) {
    e.age += dt;
    e.flash = Math.max(0, e.flash - real);

    if (e.kind === 'drifter') {
      const sway = Math.sin(e.age * 1.7 + e.phase);
      e.y += e.vy * dt;
      e.x = clamp(e.anchorX + sway * e.amp, left, right);
      e.rot = sway * 0.25;
      if (e.fireIn > 0) {
        e.fireIn -= dt;
        if (e.fireIn <= 0 && playing && e.y > 0 && e.y < h * 0.55) {
          fireShot(e.x, e.y + 12 * scale, 0, 230 * pace, PINK);
        }
      }
    } else if (e.kind === 'dart') {
      if (!e.committed && e.age > 0.7) {
        e.committed = true;
        const tx = shipX - e.x;
        const ty = Math.max(80, shipY - e.y);
        const dist = Math.hypot(tx, ty);
        const speed = Math.min(560, 400 + wave * 14) * pace;
        e.vx = (tx / dist) * speed;
        e.vy = (ty / dist) * speed;
        e.rot = Math.atan2(-e.vx, e.vy);
      }
      e.x += e.vx * dt;
      e.y += e.vy * dt;
    } else if (e.kind === 'weaver') {
      // Sharp diagonals: it turns back at the edge of its lane, or of the screen.
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      const off = e.x - e.anchorX;
      if ((Math.abs(off) > e.amp && off * e.vx > 0) || (e.x < left && e.vx < 0) || (e.x > right && e.vx > 0)) e.vx = -e.vx;
      e.rot += (-Math.sign(e.vx) * 0.5 - e.rot) * (1 - Math.exp(-dt * 14));
    } else if (e.kind === 'mite') {
      e.y += e.vy * dt;
      e.x = clamp(e.anchorX + Math.sin(e.age * 3.2) * 9 * scale, left, right);
    } else if (e.kind === 'splitter') {
      e.y += e.vy * dt;
      e.rot += dt * 0.5;
    } else if (e.kind === 'shard') {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.rot += dt * 6;
      if ((e.x < left && e.vx < 0) || (e.x > right && e.vx > 0)) e.vx = -e.vx;
    } else if (e.kind === 'spinner') {
      // A loop whose centre sinks: with three of them a third of a turn apart, a turning ring.
      const turn = e.age * 2.3 + e.phase;
      e.holdY += e.vy * dt;
      e.x = clamp(e.anchorX + Math.cos(turn) * e.amp, left, right);
      e.y = e.holdY + Math.sin(turn) * e.amp * 0.62;
      e.rot += dt * 5;
    } else if (e.kind === 'saucer') {
      e.x += e.vx * dt;
      e.y = e.holdY + Math.sin(e.age * 2.4) * 7 * scale;
      e.rot = Math.sin(e.age * 2.4 + 1) * 0.12;
      e.fireIn -= dt;
      if (e.fireIn <= 0 && playing && e.x > left && e.x < right) {
        e.fireIn = Math.max(0.75, 1.5 - wave * 0.06);
        fireShot(e.x, e.y + 9 * scale, 0, 250 * pace, KINDS.saucer.color);
      }
    } else {
      e.rot += dt * 1.4;
      if (!e.committed && (e.age > 16 || !playing)) {
        e.committed = true;
        e.vy = 160;
      }
      if (e.committed) {
        e.y += e.vy * dt;
      } else if (e.y < e.holdY) {
        e.y += 95 * pace * dt;
      } else {
        e.x += e.vx * dt;
        if (e.x < left || e.x > right) {
          e.x = clamp(e.x, left, right);
          e.vx = -e.vx;
        }
        e.fireIn -= dt;
        if (e.fireIn <= 0) {
          e.fireIn = rand(1.5, 2.6);
          const tx = shipX - e.x;
          const ty = shipY - e.y;
          const dist = Math.hypot(tx, ty) || 1;
          const speed = Math.min(300, 210 + wave * 8) * pace;
          fireShot(e.x, e.y, (tx / dist) * speed, (ty / dist) * speed, PINK);
        }
      }
    }

    if (e.y > h + 40 || e.x < -60 || e.x > w + 60) e.dead = true;
  }
}

export function renderEnemies(
  ctx: CanvasRenderingContext2D,
  ink: Ink,
  enemies: readonly Enemy[],
  scale: number,
  time: number,
): void {
  for (const color of ENEMY_COLORS) {
    if (!enemies.some((e) => e.flash <= 0 && KINDS[e.kind].color === color)) continue;
    ink(color, 1, 1.6, () => {
      for (const e of enemies) if (e.flash <= 0 && KINDS[e.kind].color === color) trace(ctx, KINDS[e.kind].shape, e.x, e.y, scale, e.rot);
    });
  }
  // An enemy that was just hit flashes in the ship's colour.
  if (enemies.some((e) => e.flash > 0)) {
    ink(SAND, 1, 2.2, () => {
      for (const e of enemies) if (e.flash > 0) trace(ctx, KINDS[e.kind].shape, e.x, e.y, scale, e.rot);
    });
  }
  // The spark at the heart of each one is whoever it is holding.
  if (enemies.length) {
    ink(SOUL, 0.6 + 0.3 * Math.sin(time * 5), 1.2, () => {
      for (const e of enemies) {
        ctx.moveTo(e.x + 1.3 * scale, e.y);
        ctx.arc(e.x, e.y, 1.3 * scale, 0, Math.PI * 2);
      }
    }, false);
  }
}
