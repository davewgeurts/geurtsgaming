/**
 * The fuel ship. Half way through a wave it flies in ahead of the player and trails a fuel line with a
 * basket on the end. Flying the ship's nose into the basket hooks the line on, and fuel flows for as long
 * as it stays on. The fuel ship does not hold still: it weaves and bobs, and every so often it sidesteps.
 * Fall too far behind and the line pulls off; crowd it and the line kinks and comes off. A line that has
 * come off can be hooked on again, and the fuel already taken is kept.
 *
 * This file is the rules and the motion. hud.ts draws it; game.ts plays its sounds and pays out the fuel.
 */

import { clamp, rand, smooth } from './core';

/** Seconds on the line for a full tank. */
export const FUEL_SECONDS = 6;
/** Seconds the fuel ship will wait with nobody on its line before it gives up and leaves. */
export const PATIENCE = 12;
/** How much bigger than its drawing in shapes.ts the fuel ship flies. */
export const TANKER_SIZE = 1.3;
/** Where the line leaves the fuel ship: this far behind its centre (px at scale 1, like everything below). */
const TAIL = 30 * TANKER_SIZE;
/** How long the line hangs when nobody is on it, and how far it will stretch before it pulls off. */
const REST = 82;
const REACH = 146;
/** The line kinks and comes off when the ship's nose is closer than this behind the tail. */
const CROWD = 30;
/** How near the ship's nose must come to the basket to hook on, and the pause before a line that came off can be caught again. */
const CATCH = 17;
const RELATCH = 0.7;

export interface TankerEnv {
  w: number; h: number;
  /** The safe area's edges. */
  top: number; left: number; right: number;
  scale: number;
  /** Where the tip of the player's ship is. */
  noseX: number; noseY: number;
}

export type TankerEvent = 'hook' | 'snap' | 'full' | 'leave';

export interface Tanker {
  state: 'enter' | 'station' | 'leaving' | 'gone';
  wave: number;
  x: number; y: number;
  /** Seconds since it arrived, and seconds it has been in place. */
  age: number; fly: number;
  /** 0 to 1. */
  fuel: number;
  hooked: boolean;
  /** 0 when the line is easy, 1 when it comes off. */
  strain: number;
  /** Why the line last came off, and how long ago. */
  why: 'far' | 'close' | null;
  whyAge: number;
  snaps: number;
  /** Seconds before the basket can be caught again. */
  relatch: number;
  /** Seconds of waiting it has left. */
  patience: number;
  /** The free end of the line. */
  drogue: { x: number; y: number };
  vy: number;
  phases: [number, number, number];
  /** Its sidesteps: where the last one started and is going, how far through it is, and when the next comes. */
  jink: { from: number; to: number; t: number; next: number };
}

/** The height it flies at: clear of the top of the screen, and low enough that the ship can reach its line. */
function stationY(env: TankerEnv): number {
  return Math.max(env.top + 84, env.h * 0.22, env.h * 0.3 - 60 * env.scale);
}

export function createTanker(wave: number, env: TankerEnv): Tanker {
  const x = (env.left + env.w - env.right) / 2;
  const y = -90 * env.scale;
  return {
    state: 'enter', wave, x, y, age: 0, fly: 0,
    fuel: 0, hooked: false, strain: 0, why: null, whyAge: 0, snaps: 0, relatch: 0, patience: PATIENCE,
    drogue: { x, y: y + (TAIL + REST) * env.scale }, vy: 0,
    phases: [rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2)],
    jink: { from: 0, to: 0, t: 1, next: rand(2.4, 3.6) },
  };
}

/** Where the fuel line leaves the fuel ship. */
export function tankerTail(t: Tanker, scale: number): { x: number; y: number } {
  return { x: t.x, y: t.y + TAIL * scale };
}

/** Send it away, whatever it was doing (the game is over, say). */
export function dismissTanker(t: Tanker): void {
  if (t.state === 'gone') return;
  t.hooked = false;
  t.strain = 0;
  t.state = 'leaving';
}

/** Move the fuel ship on by `dt` seconds. Returns what happened, if anything did. */
export function updateTanker(t: Tanker, dt: number, env: TankerEnv): TankerEvent | null {
  const s = env.scale;
  const home = stationY(env);
  let event: TankerEvent | null = null;
  t.age += dt;
  t.whyAge += dt;
  t.relatch = Math.max(0, t.relatch - dt);

  if (t.state === 'enter') {
    // It glides down into place, slowing as it arrives.
    t.y += (home - t.y) * (1 - Math.exp(-dt * 3.2));
    if (home - t.y < 3) t.state = 'station';
  } else if (t.state === 'station') {
    t.fly += dt;
    // Later waves fly it faster and jink it further.
    const k = Math.min(8, t.wave - 1);
    const centre = (env.left + env.w - env.right) / 2;
    const room = Math.max(0, Math.min((env.w - env.left - env.right) / 2 - 60 * s, 230 * s));
    // It starts out steady, so there is a fair chance to hook on, and builds up to its full weave.
    const amp = room * Math.min(1, t.fly / 2.5);
    const j = t.jink;
    j.next -= dt;
    if (j.next <= 0) {
      j.from = j.from + (j.to - j.from) * smooth(Math.min(1, j.t));
      j.to = (Math.random() < 0.5 ? -1 : 1) * rand(24, 44) * s * (1 + 0.06 * k);
      j.t = 0;
      j.next = rand(2.2, 3.8) - 0.1 * k;
    }
    j.t += dt / 0.55;
    const step = j.from + (j.to - j.from) * smooth(Math.min(1, j.t));
    const [p1, p2, p3] = t.phases;
    const weave = 0.62 * Math.sin((0.85 + 0.035 * k) * t.fly + p1) + 0.38 * Math.sin((2.2 + 0.07 * k) * t.fly + p2);
    // (Both sines are eased in from zero, so it sets off from where it arrived.)
    t.x = clamp(centre + amp * weave + step * Math.min(1, t.fly / 2.5), env.left + 50 * s, env.w - env.right - 50 * s);
    t.y = home + Math.sin(1.3 * t.fly + p3) * 12 * s * Math.min(1, t.fly / 2.5);
  } else if (t.state === 'leaving') {
    // It pulls away ahead, off the top of the screen.
    t.vy -= 620 * s * dt;
    t.y += t.vy * dt;
    if (t.y < -150 * s) t.state = 'gone';
  }

  const tail = tankerTail(t, s);
  if (t.hooked) {
    const dx = env.noseX - tail.x;
    const dy = env.noseY - tail.y;
    const far = (Math.hypot(dx, dy) / (REACH * s) - 0.6) / 0.4;
    const close = (1.7 * CROWD * s - dy) / (0.7 * CROWD * s);
    t.strain = clamp(Math.max(far, close), 0, 1);
    if (t.strain >= 1) {
      t.hooked = false;
      t.strain = 0;
      t.why = far > close ? 'far' : 'close';
      t.whyAge = 0;
      t.snaps += 1;
      t.relatch = RELATCH;
      // The basket whips back from where the ship let go of it.
      t.drogue.x = env.noseX;
      t.drogue.y = env.noseY;
      event = 'snap';
    } else {
      t.fuel = Math.min(1, t.fuel + dt / FUEL_SECONDS);
      if (t.fuel >= 1) {
        t.hooked = false;
        t.strain = 0;
        t.drogue.x = env.noseX;
        t.drogue.y = env.noseY;
        t.state = 'leaving';
        event = 'full';
      }
    }
  }
  if (!t.hooked) {
    // The free end trails behind the tail, swinging out as the fuel ship weaves.
    const reach = REST * s;
    const k = 1 - Math.exp(-dt * 5);
    t.drogue.x += (tail.x - t.drogue.x) * k;
    const off = clamp(t.drogue.x - tail.x, -reach * 0.8, reach * 0.8);
    t.drogue.x = tail.x + off;
    const hang = tail.y + Math.sqrt(reach * reach - off * off);
    t.drogue.y += (hang - t.drogue.y) * Math.min(1, k * 2.4);

    if (t.state === 'station') {
      if (t.relatch <= 0 && Math.hypot(env.noseX - t.drogue.x, env.noseY - t.drogue.y) < CATCH * s) {
        t.hooked = true;
        event = 'hook';
      } else {
        t.patience -= dt;
        if (t.patience <= 0) {
          t.state = 'leaving';
          event = 'leave';
        }
      }
    }
  }
  return event;
}
