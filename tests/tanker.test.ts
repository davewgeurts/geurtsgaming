/**
 * The fuel ship, flown by a simulated pilot at a keyboard. The pilot sees the fuel ship a little late
 * (their reaction time) and steers flat out for a spot behind it. These runs are how the fuel line's
 * difficulty was tuned: a quick pilot should hold it, a slow one should struggle.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clamp } from '../src/game/core';
import { FUEL_SECONDS, createTanker, tankerTail, updateTanker, type TankerEnv } from '../src/game/tanker';

const SCREENS = [[1440, 900], [390, 844], [844, 390]] as const;

/** The game's own sizing rule (see Game.resize). */
const scaleFor = (w: number, h: number) => clamp(Math.min(w, h) / 700, h < 500 ? 0.62 : 0.85, 1.3);

interface Flight { fuel: number; seconds: number; hooks: number; snaps: number }

/** Fly one visit. `delay` is the pilot's reaction time in seconds; `steer` false leaves the ship parked at the bottom. */
function fly(w: number, h: number, wave: number, delay: number, steer = true): Flight {
  const scale = scaleFor(w, h);
  const env: TankerEnv = { w, h, top: 0, left: 0, right: 0, scale, noseX: w / 2, noseY: h * 0.8 };
  const ship = { x: w / 2, y: h * 0.86 };
  const t = createTanker(wave, env);
  const dt = 1 / 60;
  const speed = 380 * scale;
  const seen: { x: number; y: number }[] = [];
  const out: Flight = { fuel: 0, seconds: 0, hooks: 0, snaps: 0 };
  while (t.state !== 'gone' && out.seconds < 60) {
    out.seconds += dt;
    env.noseX = ship.x;
    env.noseY = ship.y - 18.4 * scale;
    const event = updateTanker(t, dt, env);
    if (event === 'hook') out.hooks++;
    if (event === 'snap') out.snaps++;
    if (!steer) continue;
    // Not hooked on: aim the nose at the basket. Hooked on: sit a comfortable way behind the tail.
    const tail = tankerTail(t, scale);
    seen.push(t.hooked ? { x: tail.x, y: tail.y + 104 * scale } : { x: t.drogue.x, y: t.drogue.y + 18.4 * scale });
    const aim = seen[Math.max(0, seen.length - 1 - Math.round(delay * 60))]!;
    let dx = Math.abs(aim.x - ship.x) > 6 * scale ? Math.sign(aim.x - ship.x) : 0;
    let dy = Math.abs(aim.y - ship.y) > 6 * scale ? Math.sign(aim.y - ship.y) : 0;
    if (dx && dy) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    ship.x += dx * speed * dt;
    ship.y = clamp(ship.y + dy * speed * dt, h * 0.3, h - 20);
  }
  out.fuel = t.fuel;
  return out;
}

const average = (runs: Flight[], pick: (f: Flight) => number) => runs.reduce((sum, f) => sum + pick(f), 0) / runs.length;
const flights = (count: number, make: () => Flight) => Array.from({ length: count }, make);

test('a quick pilot fills the tank on every screen, in the first wave and the tenth', () => {
  for (const [w, h] of SCREENS) {
    for (const wave of [1, 10]) {
      const runs = flights(40, () => fly(w, h, wave, 0.12));
      assert.ok(runs.every((f) => f.fuel >= 1), `${w}x${h} wave ${wave}: every visit ends with a full tank`);
      assert.ok(average(runs, (f) => f.snaps) < 0.5, `${w}x${h} wave ${wave}: the line hardly ever comes off`);
      // Arriving, hooking on, six seconds of fuel, and leaving.
      assert.ok(average(runs, (f) => f.seconds) < FUEL_SECONDS + 5, `${w}x${h} wave ${wave}: over in ${average(runs, (f) => f.seconds).toFixed(1)} s`);
    }
  }
});

test('a slow pilot loses the line, and more often in later waves', () => {
  const early = flights(80, () => fly(1440, 900, 1, 0.45));
  const late = flights(80, () => fly(1440, 900, 10, 0.45));
  assert.ok(average(early, (f) => f.snaps) > 0.5, 'it comes off now and then in wave 1');
  assert.ok(average(late, (f) => f.snaps) > average(early, (f) => f.snaps), 'and more in wave 10');
  // The fuel already taken is kept, so most still fill up in the end.
  assert.ok(average(early, (f) => f.fuel) > 0.9);
});

test('a very slow pilot often leaves with the tank part full', () => {
  const runs = flights(120, () => fly(1440, 900, 10, 0.9));
  const full = runs.filter((f) => f.fuel >= 1).length / runs.length;
  assert.ok(full < 0.5, `${Math.round(full * 100)}% filled up`);
  assert.ok(average(runs, (f) => f.snaps) > 3, 'the line keeps coming off');
  assert.ok(average(runs, (f) => f.fuel) > 0.2, 'but they do get some');
});

test('a fuel ship nobody flies up to gives up and leaves', () => {
  for (const [w, h] of SCREENS) {
    const f = fly(w, h, 3, 0, false);
    assert.equal(f.fuel, 0);
    assert.equal(f.hooks, 0, 'its line never reaches a ship parked at the bottom of the screen');
    assert.ok(f.seconds > 12 && f.seconds < 16, `${w}x${h}: it waited ${f.seconds.toFixed(1)} s`);
  }
});
