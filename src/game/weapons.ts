/**
 * Player weapons, projectiles, seeker rockets, lance beams, shockwave rings, debris, and freed souls.
 */
import { NEON, SAND, SOUL, rand, type Ink } from './core';
import { KINDS, type Enemy } from './enemies';
import { PERSON_OUT, PERSON_UP, ROCKET, segments, trace, type Shape } from './shapes';
import type { UpgradeId } from './upgrades';

/** Energy above this fires three shots; any energy at all fires two. */
export const TRIPLE_AT = 0.5;
/** How often the upgrades that fire on their own go off, and how long a spent shield takes to come back. */
export const LANCE_SECONDS = 2.8;
export const ROCKET_SECONDS = 1.5;
export const NOVA_SECONDS = 9;
export const SHIELD_SECONDS = 12;
/** How far out to each side the wingmates fly, and how far from the ship the guardian circles (px at scale 1). */
export const WING = 30;
export const ORBIT = 46;
/** Seconds somebody just set free drifts about before flying up to be counted, and the most drawn at once. */
export const SOUL_FLOAT = 0.7;
export const MAX_SOULS = 80;

export interface Shot {
  x: number; y: number; vx: number; vy: number; hostile: boolean; dead: boolean; color: string;
  /** Piercing laser: how many more enemies this shot can pass through, and the one it is passing through now. */
  pierce?: number;
  skip?: Enemy | null;
  /** Fired by an upgrade rather than the ship's own cannons, so it cannot choose a sum boss's answer. */
  stray?: boolean;
}

export interface Rocket { x: number; y: number; vx: number; vy: number; age: number; dead: boolean }
export interface Beam { x: number; y: number; age: number }
export interface Debris { x: number; y: number; vx: number; vy: number; rot: number; spin: number; len: number; age: number; ttl: number; color: string }
/** An expanding ring. It grows to `reach` px, or right across the screen when that is left out. */
export interface Ring { x: number; y: number; age: number; color: string; reach?: number }
/** Somebody set free, on their way to be counted. A negative age delays them, so a crowd pours out rather than popping out. */
export interface Soul { x: number; y: number; vx: number; vy: number; age: number; phase: number; dead: boolean }

export const isHostile = (shot: Shot): boolean => shot.hostile;
export const isOwn = (shot: Shot): boolean => !shot.hostile;

/** Fire one volley of player cannons, wide lasers, and wingmate shots. */
export function fireVolley(
  shots: Shot[],
  shipX: number,
  shipY: number,
  energy: number,
  volley: number,
  scale: number,
  pace: number,
  hasBoss: boolean,
  upgrades: ReadonlySet<UpgradeId>,
  boltColor: string = SAND,
): void {
  const up = -680 * pace;
  const pierce = upgrades.has('pierce') ? 2 : 0;
  const shoot = (dx: number, dy: number, vx: number, color: string = boltColor, stray = false) =>
    shots.push({ x: shipX + dx * scale, y: shipY - dy * scale, vx, vy: up, hostile: false, dead: false, color, pierce, skip: null, stray });

  // Energy buys cannons: one from the nose, then one from each wing, then all three with the wings angled out.
  if (energy <= 0) {
    shoot(0, 18, 0);
  } else if (energy <= TRIPLE_AT) {
    shoot(-8, 6, 0);
    shoot(8, 6, 0);
  } else {
    // The wing cannons fan out to sweep a wave, and point straight ahead to pound a boss.
    const fan = hasBoss ? 0 : 105 * scale;
    shoot(0, 18, 0);
    shoot(-8, 6, -fan);
    shoot(8, 6, fan);
  }
  if (upgrades.has('wide')) {
    shoot(-10, 4, -215 * scale, boltColor, true);
    shoot(10, 4, 215 * scale, boltColor, true);
  }
  // The wingmates fire with every other volley: a real help, without doing the pilot's job for them.
  if (upgrades.has('wingmates') && volley % 2 === 0) {
    shoot(-WING, 0, 0, NEON.lime, true);
    shoot(WING, 0, 0, NEON.lime, true);
  }
}

export interface RocketUpdateEnv {
  enemies: Enemy[];
  bossTarget: { x: number; y: number } | null;
  scale: number;
  pace: number;
  w: number;
  h: number;
  strikeBoss: (x: number, y: number, aimed: boolean) => boolean;
  damageEnemy: (e: Enemy, amount: number) => void;
  onBlast: (x: number, y: number, reach: number) => void;
}

/** Rockets steer for the nearest enemy (or the boss) and go off against the first thing they touch. */
export function updateRockets(rockets: Rocket[], dt: number, env: RocketUpdateEnv): Rocket[] {
  const { enemies, bossTarget, scale, pace, w, h, strikeBoss, damageEnemy, onBlast } = env;
  const speed = 430 * pace;
  for (const r of rockets) {
    r.age += dt;
    let tx = r.x;
    let ty = r.y - 200;
    let nearest = Infinity;
    for (const e of enemies) {
      const d = Math.hypot(e.x - r.x, e.y - r.y);
      if (!e.dead && d < nearest) {
        nearest = d;
        tx = e.x;
        ty = e.y;
      }
    }
    if (nearest === Infinity && bossTarget) {
      tx = bossTarget.x;
      ty = bossTarget.y;
    }
    const dist = Math.hypot(tx - r.x, ty - r.y) || 1;
    const turn = 1 - Math.exp(-dt * 5);
    r.vx += (((tx - r.x) / dist) * speed - r.vx) * turn;
    r.vy += (((ty - r.y) / dist) * speed - r.vy) * turn;
    r.x += r.vx * dt;
    r.y += r.vy * dt;

    const touched = enemies.some((e) => !e.dead && Math.hypot(e.x - r.x, e.y - r.y) < (KINDS[e.kind].radius + 6) * scale);
    const struck = !touched && strikeBoss(r.x, r.y, false);
    if (touched || struck) {
      r.dead = true;
      // A rocket that reaches a boss lands like three shots.
      if (struck) for (let n = 0; n < 2; n++) strikeBoss(r.x, r.y, false);
      const reach = 54 * scale;
      onBlast(r.x, r.y, reach);
      for (const e of enemies) if (Math.hypot(e.x - r.x, e.y - r.y) < reach) damageEnemy(e, 2);
    } else if (r.age > 4 || r.y < -30 || r.y > h + 30 || r.x < -30 || r.x > w + 30) {
      r.dead = true;
    }
  }
  return rockets.filter((r) => !r.dead);
}

/** Break a shape into its line segments and send them tumbling outward. */
export function burstShape(
  debris: Debris[],
  shape: Shape,
  x: number,
  y: number,
  scale: number,
  rot: number,
  color: string,
): void {
  for (const [x1, y1, x2, y2] of segments(shape, x, y, scale, rot)) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const out = Math.atan2(my - y, mx - x) + rand(-0.4, 0.4);
    const v = rand(45, 150);
    debris.push({
      x: mx, y: my, vx: Math.cos(out) * v, vy: Math.sin(out) * v,
      rot: Math.atan2(y2 - y1, x2 - x1), spin: rand(-5, 5),
      len: Math.hypot(x2 - x1, y2 - y1), age: 0, ttl: rand(0.5, 0.95), color,
    });
  }
}

/** A few sparks where a shot landed on something it could not destroy. */
export function sparkAt(debris: Debris[], x: number, y: number, color: string): void {
  for (let i = 0; i < 3; i++) {
    const a = rand(0, Math.PI * 2);
    const v = rand(50, 160);
    debris.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      rot: a, spin: rand(-6, 6), len: rand(3, 7), age: 0, ttl: rand(0.15, 0.35), color,
    });
  }
}

/** Set people free at (x, y): one from an ordinary ship, a crowd from a boss. Returns immediate overflow count. */
export function freeSouls(
  souls: Soul[],
  rings: Ring[],
  x: number,
  y: number,
  scale: number,
  count = 1,
): number {
  let immediate = 0;
  const crowd = count > 1;
  if (!crowd) rings.push({ x, y, age: 0.12, color: SOUL, reach: 34 * scale });
  for (let i = 0; i < count; i++) {
    if (souls.length >= MAX_SOULS) {
      immediate += 1;
      continue;
    }
    const angle = crowd ? rand(0, Math.PI * 2) : rand(-Math.PI * 0.85, -Math.PI * 0.15);
    const speed = (crowd ? rand(70, 300) : rand(50, 110)) * scale;
    souls.push({
      x: x + (crowd ? rand(-30, 30) * scale : 0),
      y: y + (crowd ? rand(-20, 20) * scale : 0),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      age: crowd ? -i * 0.04 : 0,
      phase: rand(0, Math.PI * 2),
      dead: false,
    });
  }
  return immediate;
}

/** Move freed souls toward the HUD counter; returns how many arrived this frame. */
export function updateSouls(
  souls: Soul[],
  dt: number,
  home: { x: number; y: number },
  scale: number,
): number {
  if (!souls.length) return 0;
  let arrived = 0;
  const slow = Math.exp(-dt * 3.2);
  for (const s of souls) {
    s.age += dt;
    if (s.age < 0) continue;
    if (s.age < SOUL_FLOAT) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= slow;
      s.vy *= slow;
      continue;
    }
    const dx = home.x - s.x;
    const dy = home.y - s.y;
    const dist = Math.hypot(dx, dy);
    const step = (240 + (s.age - SOUL_FLOAT) * 1100) * Math.max(0.8, scale) * dt;
    if (dist <= step + 5) {
      s.dead = true;
      arrived += 1;
    } else {
      s.x += (dx / dist) * step;
      s.y += (dy / dist) * step;
    }
  }
  return arrived;
}

export function renderDebris(
  ctx: CanvasRenderingContext2D,
  ink: Ink,
  debris: readonly Debris[],
  tints: Iterable<string>,
): void {
  for (const color of tints) {
    for (const fresh of [true, false]) {
      ink(color, fresh ? 1 : 0.45, 1.5, () => {
        for (const d of debris) {
          if (d.color !== color || d.age < d.ttl * 0.55 !== fresh) continue;
          const hx = (Math.cos(d.rot) * d.len) / 2;
          const hy = (Math.sin(d.rot) * d.len) / 2;
          ctx.moveTo(d.x - hx, d.y - hy);
          ctx.lineTo(d.x + hx, d.y + hy);
        }
      }, fresh);
    }
  }
}

export function renderHostileShots(
  ctx: CanvasRenderingContext2D,
  ink: Ink,
  shots: readonly Shot[],
  tints: Iterable<string>,
  scale: number,
): void {
  for (const color of tints) {
    ink(color, 1, 1.6, () => {
      for (const s of shots) {
        if (!s.hostile || s.color !== color) continue;
        const r = 4 * scale;
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y);
        ctx.lineTo(s.x, s.y + r);
        ctx.lineTo(s.x - r, s.y);
        ctx.closePath();
      }
    });
  }
}

export function renderOwnShotsAndWeapons(
  ctx: CanvasRenderingContext2D,
  ink: Ink,
  shots: readonly Shot[],
  tints: Iterable<string>,
  rockets: readonly Rocket[],
  beams: readonly Beam[],
  scale: number,
): void {
  for (const color of tints) {
    ink(color, 1, 1.8, () => {
      for (const s of shots) {
        if (s.hostile || s.color !== color) continue;
        const len = (11 * scale) / (Math.hypot(s.vx, s.vy) || 1);
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - s.vx * len, s.y - s.vy * len);
      }
    });
  }

  if (rockets.length) {
    ink(NEON.orange, 1, 1.6, () => {
      for (const r of rockets) {
        const v = Math.hypot(r.vx, r.vy) || 1;
        trace(ctx, ROCKET, r.x, r.y, scale, Math.atan2(r.vx, -r.vy));
        ctx.moveTo(r.x - (r.vx / v) * 9 * scale, r.y - (r.vy / v) * 9 * scale);
        ctx.lineTo(r.x - (r.vx / v) * 22 * scale, r.y - (r.vy / v) * 22 * scale);
      }
    });
  }

  for (const beam of beams) {
    const fade = 1 - beam.age / 0.22;
    const line = () => {
      ctx.moveTo(beam.x, beam.y);
      ctx.lineTo(beam.x, 0);
    };
    ink(NEON.cyan, fade, 2 + 9 * fade, line);
    ink('#ffffff', fade, 1.5, line, false);
  }
}

export function renderRingsAndSouls(
  ctx: CanvasRenderingContext2D,
  ink: Ink,
  rings: readonly Ring[],
  souls: readonly Soul[],
  w: number,
  h: number,
  scale: number,
  time: number,
): void {
  for (const ring of rings) {
    if (ring.age < 0) continue;
    const t = ring.age / 0.7;
    const r = t * (ring.reach ?? Math.hypot(w, h));
    ink(ring.color, 1 - t, 2.4, () => {
      ctx.moveTo(ring.x + r, ring.y);
      ctx.arc(ring.x, ring.y, r, 0, Math.PI * 2);
    });
  }

  if (souls.length) {
    ink(SOUL, 1, 1.3, () => {
      for (const s of souls) {
        if (s.age < 0) continue;
        const waving = Math.floor(time * 7 + s.phase) % 2 === 0;
        trace(
          ctx,
          waving ? PERSON_UP : PERSON_OUT,
          s.x,
          s.y,
          1.2 * scale * Math.min(1, 0.4 + s.age * 4),
          Math.sin(time * 5 + s.phase) * 0.22,
        );
      }
    });
  }
}
