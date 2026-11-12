/**
 * Little things passing by in the hero background, one or two at a time, far off and faint:
 *
 * - a flight-school line: a leader with a row of small ships wobbling along behind, the last one always catching up
 * - a fuel ship with somebody hooked on to its fuel line
 * - people who have been set free, floating up and waving
 * - a ship that cannot resist a loop-the-loop
 * - a shooting star
 * - a constellation: stars that join up into a letter, a number, a sign from a sum, or a ship, then fade
 *
 * They are scenery, not the show: smaller and dimmer than the skirmishes (see hero-scene.ts), slow, and
 * anything that crosses the screen fades out before it reaches the copy or a skirmish, hurries across behind
 * it, and comes back on the far side.
 * Nothing here runs for people who have asked for less motion.
 */
import { NEON, PINK, SAND, pick, rand } from '../game/core';
import { traceText } from '../game/font';
import { DROGUE, FRIEND, MARK_STAR, PERSON_OUT, PERSON_UP, SHIP, TANKER, segments, trace, type Shape } from '../game/shapes';
import type { Rect } from './hero-scene';

const LIME = NEON.lime;
const QUARTER = Math.PI / 2;
/** How close to the copy something may come before it has faded right out, and the px over which it fades. */
const NEAR = 14;
const FADE = 60;

/** Advance by `dt` seconds and draw, slid by (dx, dy) with its layer of stars. False once it has gone. */
type Cameo = (dt: number, dx: number, dy: number) => boolean;
type Seg = [number, number, number, number];

/** What the constellations spell: things a pilot in training would know. */
const GLYPHS = ['A', 'B', 'C', 'X', 'Z', '1', '2', '3', '7', '+', '=', '?'];

/** The lines of a character of the stroke font, as segments, by tracing it on to something that only takes notes. */
function glyphSegments(char: string, x: number, y: number, cap: number): Seg[] {
  const segs: Seg[] = [];
  let px = 0;
  let py = 0;
  const pen = {
    moveTo(nx: number, ny: number) {
      px = nx;
      py = ny;
    },
    lineTo(nx: number, ny: number) {
      segs.push([px, py, nx, ny]);
      px = nx;
      py = ny;
    },
  };
  traceText(pen as unknown as CanvasRenderingContext2D, char, x, y - cap / 2, cap, 'center');
  return segs;
}

export function heroCameos(ctx: CanvasRenderingContext2D) {
  let w = 0;
  let h = 0;
  let keep: readonly Rect[] = [];
  /** Where the skirmishes are just now: kept clear of in the same way as the copy. */
  let busy: readonly Rect[] = [];
  let size = 0.6;
  let dim = 0.36;
  let most = 2;
  let live: Cameo[] = [];
  let wait = 2.5;
  let clock = 0;
  let lastKind = -1;

  /** Call it when the canvas changes size or the copy moves. `compact` is for phones: one at a time, smaller and dimmer. */
  function layout(width: number, height: number, keepClear: readonly Rect[], compact: boolean): void {
    w = width;
    h = height;
    keep = keepClear;
    size = compact ? 0.5 : 0.62;
    dim = compact ? 0.27 : 0.36;
    most = compact ? 1 : 3;
    live = [];
  }

  /** How much of something at (x, y) shows: 1 in the open, falling to 0 as it comes up to the copy. */
  function shows(x: number, y: number): number {
    let least = 1;
    for (const rects of [keep, busy]) {
      for (const [l, t, r, b] of rects) {
        const away = Math.hypot(Math.max(l - x, 0, x - r), Math.max(t - y, 0, y - b));
        least = Math.min(least, (away - NEAR) / FADE);
      }
    }
    return Math.max(0, least);
  }

  /**
   * How much faster than usual something crossing the screen moves: six times as fast while all of it is
   * hidden behind the copy, so that it is not out of sight for long. `back` is how far behind `x` it reaches.
   */
  const hurry = (x: number, y: number, back = 0): number => 1 + 5 * (1 - Math.max(shows(x, y), shows(x - back, y)));

  /** A height at which to cross the screen: one clear of the copy all the way across if there is one. */
  function lane(): number {
    for (let tries = 0; tries < 12; tries++) {
      const y = rand(h * 0.12, h * 0.88);
      if (!keep.some(([, t, , b]) => y > t - 30 && y < b + 30)) return y;
    }
    // None (a wide screen keeps its whole middle column clear): cross anyway, and fade behind the copy.
    for (let tries = 0; tries < 12; tries++) {
      const y = rand(h * 0.14, h * 0.86);
      if (shows(30, y) > 0.9 && shows(w - 30, y) > 0.9) return y;
    }
    return h * 0.8;
  }

  /** A place in the open with `room` px clear all round, or null. */
  function clearing(room: number): [number, number] | null {
    for (let tries = 0; tries < 24; tries++) {
      const x = rand(room, w - room);
      const y = rand(room + 10, h - room - 10);
      if ([[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]].every(([ox, oy]) => shows(x + ox! * room, y + oy! * room) >= 1)) return [x, y];
    }
    return null;
  }

  /** Stroke whatever `build` traces, in one colour. */
  const ink = (color: string, alpha: number, build: () => void): void => {
    if (alpha <= 0.01) return;
    ctx.beginPath();
    build();
    ctx.strokeStyle = color;
    ctx.globalAlpha = dim * Math.min(1, alpha);
    ctx.stroke();
  };
  const draw = (shape: Shape, x: number, y: number, scale: number, rot: number, color: string, alpha: number): void =>
    ink(color, alpha * shows(x, y), () => trace(ctx, shape, x, y, scale, rot));
  /** The little flame behind a ship flying along the x axis. */
  const flame = (x: number, y: number, s: number, dir: number, color: string, alpha: number): void =>
    ink(color, alpha * shows(x, y), () => {
      ctx.moveTo(x - dir * 13 * s, y - 2.5 * s);
      ctx.lineTo(x - dir * (13 + rand(5, 10)) * s, y);
      ctx.lineTo(x - dir * 13 * s, y + 2.5 * s);
    });

  // ---------------------------------------------------------------- the cast

  /** Flight school: a leader, and a line of learners who more or less keep up. */
  function school(): Cameo {
    const dir = Math.random() < 0.5 ? -1 : 1;
    const s = size * rand(0.85, 1);
    const y0 = lane();
    const learners = Math.floor(rand(3, 6));
    const speed = rand(30, 44);
    const reach = (learners + 2) * 20 * s;
    let x = dir > 0 ? -30 : w + 30;
    const seed = rand(0, 9);
    return (dt, dx, dy) => {
      x += dir * speed * dt * hurry(x, y0, dir * reach);
      const t = clock + seed;
      const wave = (i: number) => Math.sin(t * 1.6 - i * 0.7) * 5 * s;
      draw(SHIP, x + dx, y0 + wave(0) + dy, 0.62 * s, dir * QUARTER, SAND, 1);
      flame(x + dx, y0 + wave(0) + dy, 0.62 * s, dir, PINK, 0.8);
      for (let i = 1; i <= learners; i++) {
        // The last in line drifts back, notices, and scoots to catch up; then does it again.
        const lag = i === learners ? Math.max(0, Math.sin(t * 0.9)) ** 3 * 16 * s : 0;
        const lx = x - dir * (10 + i * 17) * s - dir * lag;
        // Learners wobble more than their teacher.
        const ly = y0 + wave(i) * 1.5 + Math.sin(t * 3.1 + i * 2) * 1.5 * s;
        draw(FRIEND, lx + dx, ly + dy, 0.34 * s, dir * QUARTER + Math.sin(t * 2.3 + i) * 0.18, LIME, 0.9);
      }
      return dir > 0 ? x - reach < w + 30 : x + reach > -30;
    };
  }

  /** A fuel ship on its rounds, with a customer on the line. */
  function refuel(): Cameo {
    const dir = Math.random() < 0.5 ? -1 : 1;
    const s = size * rand(0.8, 0.95);
    const y0 = lane();
    const speed = rand(22, 30);
    let x = dir > 0 ? -40 : w + 40;
    const seed = rand(0, 9);
    return (dt, dx, dy) => {
      x += dir * speed * dt * hurry(x, y0, dir * 70 * s);
      const t = clock + seed;
      const ty = y0 + Math.sin(t * 0.8) * 4 * s;
      // The ship on the line bobs about behind, never quite still.
      const sx = x - dir * (62 + Math.sin(t * 1.3) * 5) * s;
      const sy = ty + Math.sin(t * 1.9 + 1) * 6 * s;
      const tail = x - dir * 22 * s;
      const nose = sx + dir * 9 * s;
      const sag = 7 * s;
      draw(TANKER, x + dx, ty + dy, 0.72 * s, dir * QUARTER, LIME, 1);
      ink(LIME, 0.8 * shows((tail + nose) / 2, ty), () => {
        ctx.moveTo(tail + dx, ty + dy);
        ctx.quadraticCurveTo((tail + nose) / 2 + dx, (ty + sy) / 2 + sag + dy, nose + dx, sy + dy);
        trace(ctx, DROGUE, nose + dx, sy + dy, 0.5 * s, dir * QUARTER);
      });
      // Fuel on its way down the line.
      ink(SAND, 0.9 * shows((tail + nose) / 2, ty), () => {
        for (let i = 0; i < 3; i++) {
          const u = (t * 0.7 + i / 3) % 1;
          const px = (1 - u) * (1 - u) * tail + 2 * (1 - u) * u * ((tail + nose) / 2) + u * u * nose + dx;
          const py = (1 - u) * (1 - u) * ty + 2 * (1 - u) * u * ((ty + sy) / 2 + sag) + u * u * sy + dy;
          ctx.moveTo(px - 1, py);
          ctx.lineTo(px + 1, py);
        }
      });
      draw(SHIP, sx + dx, sy + dy, 0.55 * s, dir * QUARTER, SAND, 1);
      return dir > 0 ? sx < w + 40 : sx > -40;
    };
  }

  /** Two or three people who have been set free, floating up and waving to whoever is watching. */
  function rescued(): Cameo | null {
    const spot = clearing(46 * size);
    if (!spot) return null;
    const [x0, y0] = spot;
    const s = size * rand(0.95, 1.15);
    const people = Array.from({ length: Math.floor(rand(2, 4)) }, (_, i) => ({ off: (i - 1) * 15 * s + rand(-3, 3), rise: rand(0, 8) * s, beat: rand(0, 6), sway: rand(0, 6) }));
    const life = rand(7, 9);
    let t = 0;
    return (dt, dx, dy) => {
      t += dt;
      const alpha = Math.min(1, t / 1.2, (life - t) / 1.5);
      for (const p of people) {
        const x = x0 + p.off + Math.sin(t * 0.7 + p.sway) * 5 * s;
        const y = y0 + 24 * s - t * 6 * s - p.rise;
        const waving = Math.floor(t * 3 + p.beat) % 2 === 0;
        draw(waving ? PERSON_UP : PERSON_OUT, x + dx, y + dy, 1.1 * s, Math.sin(t * 1.4 + p.beat) * 0.2, SAND, alpha);
      }
      return t < life;
    };
  }

  /** A ship flying across that cannot resist a loop-the-loop on the way. */
  function looper(): Cameo {
    const dir = Math.random() < 0.5 ? -1 : 1;
    const s = size * rand(0.85, 1);
    const y0 = lane();
    const speed = rand(70, 95);
    const radius = rand(20, 28) * s;
    // The loop happens out in the open, a little way in from the edge it came from.
    const loopAt = dir > 0 ? rand(0.08, 0.2) * w : rand(0.8, 0.92) * w;
    let x = dir > 0 ? -20 : w + 20;
    let y = y0;
    let turned = -1;
    let heading = dir * QUARTER;
    const trail: number[] = [];
    return (dt, dx, dy) => {
      if (turned < 0 && (dir > 0 ? x >= loopAt : x <= loopAt)) turned = 0;
      if (turned >= 0 && turned < Math.PI * 2) {
        // Up and over: once round a circle whose lowest point is where the ship left the level.
        turned = Math.min(Math.PI * 2, turned + (speed / radius) * dt);
        x = loopAt + dir * Math.sin(turned) * radius;
        y = y0 - (1 - Math.cos(turned)) * radius;
        heading = dir * (QUARTER - turned);
      } else {
        x += dir * speed * dt * hurry(x, y0);
        heading = dir * QUARTER;
      }
      trail.push(x, y);
      if (trail.length > 44) trail.splice(0, 2);
      ink(SAND, 0.22 * shows(x, y), () => {
        for (let i = 0; i < trail.length; i += 2) {
          if (i === 0) ctx.moveTo(trail[i]! + dx, trail[i + 1]! + dy);
          else ctx.lineTo(trail[i]! + dx, trail[i + 1]! + dy);
        }
      });
      draw(SHIP, x + dx, y + dy, 0.55 * s, heading, SAND, 1);
      return dir > 0 ? x < w + 30 : x > -30;
    };
  }

  /** A shooting star: gone almost before it is noticed. */
  function comet(): Cameo | null {
    const spot = clearing(30);
    if (!spot) return null;
    let [x, y] = spot;
    const dir = Math.random() < 0.5 ? -1 : 1;
    const slope = rand(0.35, 0.7);
    const speed = rand(300, 420);
    const life = rand(0.7, 1.1);
    let t = 0;
    return (dt, dx, dy) => {
      t += dt;
      x += dir * speed * dt;
      y += slope * speed * dt;
      const alpha = Math.min(1, t / 0.12, (life - t) / 0.4) * shows(x, y);
      // A tail in three pieces, fainter the further back.
      for (let i = 0; i < 3; i++) {
        ink(SAND, alpha * (0.9 - i * 0.28), () => {
          ctx.moveTo(x - dir * i * 16 + dx, y - slope * i * 16 + dy);
          ctx.lineTo(x - dir * (i + 1) * 16 + dx, y - slope * (i + 1) * 16 + dy);
        });
      }
      return t < life;
    };
  }

  /** Stars that come out one by one, join up into something, twinkle for a while, and fade. */
  function constellation(): Cameo | null {
    const cap = 104 * size;
    const spot = clearing(cap * 0.7);
    if (!spot) return null;
    const [x0, y0] = spot;
    const roll = Math.random();
    const segs: Seg[] = roll < 0.2 ? segments(SHIP, x0, y0, 3.4 * size, rand(-0.3, 0.3)) : roll < 0.32 ? segments(MARK_STAR, x0, y0, 5 * size, 0) : glyphSegments(pick(GLYPHS), x0, y0, cap);
    // Its stars are the ends of its lines, each counted once.
    const stars: number[] = [];
    for (const [x1, y1, x2, y2] of segs) {
      for (const [x, y] of [[x1, y1], [x2, y2]] as const) {
        let known = false;
        for (let i = 0; i < stars.length; i += 2) if (Math.hypot(stars[i]! - x, stars[i + 1]! - y) < 1.5) known = true;
        if (!known) stars.push(x, y);
      }
    }
    const count = stars.length / 2;
    const STAR = 0.16;
    const LINE = 0.22;
    const drawn = count * STAR + 0.3;
    const joined = drawn + segs.length * LINE;
    const life = joined + 3.2 + 1.4;
    const seed = rand(0, 9);
    let t = 0;
    return (dt, dx, dy) => {
      t += dt;
      const fade = Math.min(1, (life - t) / 1.4);
      // The stars: tiny crosses that twinkle, each out of step with the others.
      for (let i = 0; i < count; i++) {
        const born = t - i * STAR;
        if (born <= 0) break;
        const x = stars[i * 2]! + dx;
        const y = stars[i * 2 + 1]! + dy;
        const r = 1.8 * Math.min(1, born / 0.25);
        ink(SAND, fade * (0.75 + 0.25 * Math.sin((clock + seed) * 3 + i * 1.7)), () => {
          ctx.moveTo(x - r, y);
          ctx.lineTo(x + r, y);
          ctx.moveTo(x, y - r);
          ctx.lineTo(x, y + r);
        });
      }
      // The lines between them, drawn one after another.
      ink(SAND, fade * 0.45, () => {
        segs.forEach(([x1, y1, x2, y2], i) => {
          const u = Math.min(1, (t - drawn - i * LINE) / LINE);
          if (u <= 0) return;
          ctx.moveTo(x1 + dx, y1 + dy);
          ctx.lineTo(x1 + (x2 - x1) * u + dx, y1 + (y2 - y1) * u + dy);
        });
      });
      return t < life;
    };
  }

  const CAST = [school, refuel, rescued, looper, comet, constellation];

  /** Move everything on by `dt` seconds and draw it. `skirmishes` is the room the skirmishes are taking up. */
  function frame(dt: number, dx: number, dy: number, skirmishes: readonly Rect[] = []): void {
    if (!w) return;
    busy = skirmishes;
    clock += dt;
    if (live.length < most && (wait -= dt) < 0) {
      wait = rand(1.5, 4.5);
      // Never the same thing twice running.
      let kind = Math.floor(Math.random() * CAST.length);
      if (kind === lastKind) kind = (kind + 1) % CAST.length;
      const cameo = CAST[kind]!();
      if (cameo) {
        live.push(cameo);
        lastKind = kind;
      }
    }
    if (!live.length) return;
    ctx.lineWidth = 1.1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    live = live.filter((cameo) => cameo(dt, dx, dy));
    ctx.globalAlpha = 1;
  }

  return { layout, frame };
}
