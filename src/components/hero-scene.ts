/**
 * Far-off "learning skirmishes" for the hero background. A tiny friendly ship lines up under an enemy,
 * a sum or a word appears above it, the answer arrives, and one shot breaks the enemy into its lines.
 * It borrows the arcade demo's shapes, stroke font, sums and words, so the backdrop shows what the game teaches.
 * Only the small data modules are imported here: the game itself stays lazy-loaded.
 */
import { NEON, PINK, SAND, pick, rand } from '../game/core';
import { textWidth, traceText } from '../game/font';
import { WORDS } from '../game/lines';
import { makeProblem } from '../game/maths';
import { DART, DRIFTER, HEX, SHIP, segments, trace, type Shape } from '../game/shapes';

/** An area the skirmishes must keep clear of, as [left, top, right, bottom] in canvas px. */
export type Rect = readonly [number, number, number, number];

const LIME = NEON.lime;
const ENEMIES = [DRIFTER, DART, HEX];
const SHORT = WORDS.filter((word) => word.length < 6);

// Sizes in px at scale 1. Skirmishes are drawn at about half that, so they read as a long way off.
/** Cap height of the sum or word. */
const CAP = 16;
/** From the enemy down to the ship waiting under it. */
const GAP = 84;
/** Enemies turn up this far left or right of the middle, so the ship has to move across for the next one. */
const SWAY = 22;
/** The room one skirmish takes: half its width (the widest sum is ten characters), and how far it reaches above and below the enemy. */
const HALF = SWAY + textWidth('17 - 8 = 9', CAP) / 2;
const ABOVE = 15 + 8 + CAP;
const BELOW = GAP + 16 + 40;
/** Clear px kept between a skirmish and the copy, the screen edge, or another skirmish. */
const PAD = 12;

// Seconds. A word's first letter is typed at TYPE_AT and the rest follow one every TYPE_EVERY.
const TYPE_AT = 0.9;
const TYPE_EVERY = 0.28;
const SUM_AT = 1.6;
/** The beat between the answer and the shot. */
const AIM = 0.7;

const IN = 0;
const ASK = 1;
const SHOT = 2;
const BOOM = 3;
const OUT = 4;

/** One loose line of a broken enemy: middle x and y, half-length x and y, speed x and y, spin. */
type Bit = [number, number, number, number, number, number, number];

interface Skirmish {
  /** Middle of the row the enemies appear on. */
  x: number;
  y: number;
  scale: number;
  /** -1 on the left half of the screen, 1 on the right: the ship comes and goes on the outside. */
  side: number;
  /** Enemies still to come after this one. */
  more: number;
  phase: number;
  /** Seconds spent in this phase. */
  t: number;
  shipX: number;
  shipY: number;
  shipAlpha: number;
  enemy: Shape;
  enemyX: number;
  /** The sum or the word. */
  ask: string;
  /** For a sum, the " = 7" that appears beside it. Empty for a word, which is typed letter by letter instead. */
  reply: string;
  /** Seconds into the ask at which the answer is complete. */
  solved: number;
  shotY: number;
  bits: Bit[];
}

export function heroScene(ctx: CanvasRenderingContext2D) {
  /** Places a skirmish fits, as x, y pairs. */
  let spots: number[] = [];
  let live: Skirmish[] = [];
  let most = 0;
  let size = 0;
  let dim = 0;
  let mid = 0;
  /** Which half the last skirmish started in. */
  let last = 0;
  let wait = 1;
  let clock = 0;
  // Sums and words take turns, so both kinds of learning are on show.
  let sum = Math.random() < 0.5;

  /**
   * Work out where skirmishes may go. Call it when the canvas changes size or the copy moves.
   * `compact` is for phones: one skirmish at a time, smaller and dimmer.
   */
  function layout(w: number, h: number, keepClear: readonly Rect[], compact: boolean): void {
    live = [];
    spots = [];
    mid = w / 2;
    most = compact ? 1 : 3;
    dim = compact ? 0.32 : 0.45;
    // Try the biggest size first and settle for a smaller one where room is tight. No room at all means no skirmishes.
    for (size of compact ? [0.5, 0.45] : [0.7, 0.58, 0.48]) {
      const half = HALF * size + PAD;
      const above = ABOVE * size + PAD;
      const below = BELOW * size + PAD;
      const fits = (x: number, y: number) =>
        !keepClear.some(([l, t, r, b]) => x + half > l && x - half < r && y + below > t && y - above < b);
      for (let y = above; y < h - below; y += 12) {
        // Work in from both edges at once, so a tight left and right gutter get the same chances.
        for (let x = half; x < mid; x += 12) {
          for (const at of [x, w - x]) if (fits(at, y)) spots.push(at, y);
        }
      }
      if (spots.length) break;
    }
  }

  const go = (k: Skirmish, phase: number) => {
    k.phase = phase;
    k.t = 0;
  };

  /** Bring on the next enemy, on the other side of the row from the last, with a fresh sum or word. */
  function next(k: Skirmish): void {
    k.enemyX = 2 * k.x - k.enemyX;
    k.enemy = pick(ENEMIES);
    sum = !sum;
    if (sum) {
      const problem = makeProblem(1);
      k.ask = problem.question;
      k.reply = ` = ${problem.answer}`;
      k.solved = SUM_AT;
    } else {
      k.ask = pick(SHORT);
      k.reply = '';
      k.solved = TYPE_AT + TYPE_EVERY * k.ask.length;
    }
    go(k, IN);
  }

  function spawn(): void {
    // Which half of the screen is busier: below zero for the left, above for the right.
    // With nothing going (a phone shows one at a time), it is the half the last one was in.
    const lopsided = live.reduce((total, k) => total + k.side, 0) || last;
    // A few tries to find a spot clear of the skirmishes already going. If none turns up, wait for the next turn.
    for (let tries = 0; tries < 8; tries++) {
      const i = Math.floor((Math.random() * spots.length) / 2) * 2;
      const x = spots[i]!;
      const y = spots[i + 1]!;
      const side = x < mid ? -1 : 1;
      const near = (k: Skirmish) =>
        Math.abs(k.x - x) < 2 * (HALF * size + PAD) && Math.abs(k.y - y) < (ABOVE + BELOW) * size + 2 * PAD;
      // Prefer the quieter half, so the skirmishes spread out instead of stacking up down one side.
      if (live.some(near) || (tries < 5 && side * lopsided > 0)) continue;
      const scale = size * rand(0.9, 1);
      const k: Skirmish = {
        x, y, scale, side,
        more: Math.floor(rand(0, 3)),
        phase: IN,
        t: 0,
        shipX: x + side * 40 * scale,
        shipY: y + (GAP + 40) * scale,
        shipAlpha: 0,
        enemy: HEX,
        enemyX: x + (Math.random() < 0.5 ? SWAY : -SWAY) * scale,
        ask: '', reply: '', solved: 0, shotY: 0, bits: [],
      };
      next(k);
      live.push(k);
      last = side;
      return;
    }
  }

  /** Hexes spin on the spot; the others just rock a little. */
  const turn = (k: Skirmish) => (k.enemy === HEX ? clock * 0.5 : Math.sin(clock * 1.7 + k.x) * 0.12);

  /** Move one skirmish on by `dt` seconds. False once its ship has gone. */
  function advance(k: Skirmish, dt: number): boolean {
    const s = k.scale;
    const home = k.y + GAP * s;
    k.t += dt;
    if (k.phase === IN) {
      // The ship eases in under the enemy: quick at first, settling as it lines up.
      const ease = Math.min(1, dt * 2.6);
      k.shipX += (k.enemyX - k.shipX) * ease;
      k.shipY += (home - k.shipY) * ease;
      k.shipAlpha = Math.min(1, k.shipAlpha + dt * 1.4);
      if (k.t > 0.8 && Math.abs(k.enemyX - k.shipX) + Math.abs(home - k.shipY) < 0.6) go(k, ASK);
    } else if (k.phase === ASK) {
      if (k.t > k.solved + AIM) {
        k.shotY = home - 16 * s;
        go(k, SHOT);
      }
    } else if (k.phase === SHOT) {
      k.shotY -= 150 * s * dt;
      if (k.shotY < k.y + 9 * s) {
        // The enemy comes apart into its own lines, each thrown outward from the middle.
        k.bits = segments(k.enemy, k.enemyX, k.y, s, turn(k)).map(([x1, y1, x2, y2]): Bit => {
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          const away = Math.atan2(my - k.y, mx - k.enemyX) + rand(-0.6, 0.6);
          const speed = rand(14, 40) * s;
          return [mx, my, (x2 - x1) / 2, (y2 - y1) / 2, Math.cos(away) * speed, Math.sin(away) * speed, rand(-3, 3)];
        });
        go(k, BOOM);
      }
    } else if (k.phase === BOOM) {
      for (const b of k.bits) {
        const c = Math.cos(b[6] * dt);
        const sn = Math.sin(b[6] * dt);
        b[0] += b[4] * dt;
        b[1] += b[5] * dt;
        [b[2], b[3]] = [b[2] * c - b[3] * sn, b[2] * sn + b[3] * c];
      }
      if (k.t > 1) {
        if (k.more-- > 0) next(k);
        else go(k, OUT);
      }
    } else {
      // Off it goes, up and out towards the nearer edge, fading as it leaves.
      k.shipY -= 190 * s * k.t * dt;
      k.shipX += k.side * 50 * s * k.t * dt;
      k.shipAlpha = 1 - k.t;
      return k.t < 1;
    }
    return true;
  }

  /** Stroke everything traced since the last call in one colour, then start a new path. */
  const ink = (color: string, alpha: number) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = dim * alpha;
    ctx.stroke();
    ctx.beginPath();
  };

  /** Draw one skirmish, moved by (dx, dy) so it slides with the far layer of stars. */
  function paint(k: Skirmish, dx: number, dy: number): void {
    const s = k.scale;
    const x = k.enemyX + dx;
    const y = k.y + dy;

    // The ship leans into its turns and hovers a little while it thinks. Its shot shares the stroke.
    const lean = k.phase === OUT ? k.side * Math.min(0.3, k.t) : Math.max(-0.3, Math.min(0.3, (k.enemyX - k.shipX) * 0.03));
    trace(ctx, SHIP, k.shipX + dx, k.shipY + dy + Math.sin(clock * 2 + k.x) * 1.2 * s, s, lean);
    if (k.phase === SHOT) {
      ctx.moveTo(x, k.shotY + dy);
      ctx.lineTo(x, k.shotY + dy - 7 * s);
    }
    ink(SAND, k.shipAlpha);

    if (k.phase < BOOM) {
      const arrive = k.phase === IN ? Math.min(1, k.t / 0.6) : 1;
      trace(ctx, k.enemy, x, y - (1 - arrive) * 10 * s, s, turn(k));
      ink(PINK, arrive);
    } else if (k.phase === BOOM) {
      for (const [mx, my, hx, hy] of k.bits) {
        ctx.moveTo(mx - hx + dx, my - hy + dy);
        ctx.lineTo(mx + hx + dx, my + hy + dy);
      }
      // A ring spreads from the hit.
      const r = (6 + 30 * k.t) * s;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ink(PINK, 1 - k.t);
    }

    if (k.phase > IN && k.phase < OUT) {
      const fade = k.phase === ASK ? Math.min(1, k.t / 0.4) : k.phase === BOOM ? 1 - k.t : 1;
      const cap = CAP * s;
      // Laid out once for the whole line, so nothing shifts when the answer or the next letter lights up.
      const left = x - textWidth(k.ask + k.reply, cap) / 2;
      const top = y - ABOVE * s;
      const answered = k.phase > ASK || k.t > k.solved;
      const typed = k.reply ? 0 : answered ? k.ask.length : Math.max(0, Math.floor((k.t - TYPE_AT) / TYPE_EVERY));
      traceText(ctx, ' '.repeat(typed) + k.ask.slice(typed), left, top, cap);
      ink(SAND, fade * (k.reply ? 0.85 : 0.45));
      // The bright part: a sum's answer in green, or the letters of a word typed so far.
      if (k.reply ? answered : typed) {
        traceText(ctx, k.reply ? ' '.repeat(k.ask.length) + k.reply : k.ask.slice(0, typed), left, top, cap);
        ink(k.reply ? LIME : SAND, fade);
      }
    }
  }

  /** Move everything on by `dt` seconds and draw it. */
  function frame(dt: number, dx: number, dy: number): void {
    clock += dt;
    if (live.length < most && spots.length && (wait -= dt) < 0) {
      wait = rand(2.5, 6);
      spawn();
    }
    if (!live.length) return;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    live = live.filter((k) => advance(k, dt));
    for (const k of live) paint(k, dx, dy);
    ctx.globalAlpha = 1;
  }

  /** The room each skirmish going on now takes up, so that whatever else is in the sky can keep out of it. */
  function busy(): Rect[] {
    const half = HALF * size + PAD;
    return live.map((k): Rect => [k.x - half, k.y - ABOVE * size - PAD, k.x + half, k.y + BELOW * size + PAD]);
  }

  return { layout, frame, busy };
}
