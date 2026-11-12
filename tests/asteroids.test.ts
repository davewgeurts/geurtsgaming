/**
 * The asteroid field, flown by a simulated pilot at a keyboard who steers for the middle of one of the
 * two ways through and never fires. Whatever the dice do when a field is laid out, both ways must be
 * flyable: these runs are the proof.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createField, gapAt, updateField, type Field, type FieldEnv } from '../src/game/asteroids';
import { clamp } from '../src/game/core';

const SCREENS = [[1440, 900], [390, 844], [844, 390], [320, 568]] as const;

/** The game's own sizing rules (see Game.resize). */
function envFor(w: number, h: number, wave: number): FieldEnv {
  return { w, h, left: 0, right: 0, scale: clamp(Math.min(w, h) / 700, h < 500 ? 0.62 : 0.85, 1.3), pace: clamp(h / 760, 0.6, 1.35), wave };
}

interface Flight { field: Field; hits: number; bombs: number; prizes: number; seconds: number }

/** Fly one field. `delay` is the pilot's reaction time in seconds. Only rocks that take more than one shot count as hits. */
function fly(w: number, h: number, wave: number, hard: boolean, delay: number): Flight {
  const env = envFor(w, h, wave);
  const s = env.scale;
  const field = createField(env);
  const ship = { x: w / 2, y: h - Math.max(84, h * 0.14) };
  const dt = 1 / 60;
  const seen: number[] = [];
  const bombs = new Set<number>();
  const prizes = new Set<number>();
  let hits = 0;
  let safe = 0;
  let seconds = 0;
  while (!field.done && seconds < 90) {
    seconds += dt;
    safe -= dt;
    updateField(field, dt, dt, env);
    seen.push(gapAt(field, ship.y - 30 * s, hard) ?? gapAt(field, ship.y - 120 * s, hard) ?? ship.x);
    const aim = seen[Math.max(0, seen.length - 1 - Math.round(delay * 60))]!;
    if (Math.abs(aim - ship.x) > 5) ship.x += Math.sign(aim - ship.x) * Math.min(Math.abs(aim - ship.x), 380 * s * dt);
    for (const rock of field.rocks) {
      if (!rock.tough || safe > 0) continue;
      if (Math.hypot(rock.x - ship.x, field.front - rock.d - ship.y) < rock.r * 0.9 + 9 * s) {
        hits++;
        safe = 2.2;
      }
    }
    field.bombs.forEach((b, i) => { if (Math.hypot(b.x - ship.x, field.front - b.d - ship.y) < 19 * s) bombs.add(i); });
    field.prizes.forEach((p, i) => { if (Math.hypot(p.x - ship.x, field.front - p.d - ship.y) < 22 * s) prizes.add(i); });
  }
  return { field, hits, bombs: bombs.size, prizes: prizes.size, seconds };
}

test('the easy way can always be flown without touching a rock', () => {
  for (const [w, h] of SCREENS) {
    for (const wave of [1, 4, 8, 12]) {
      for (let i = 0; i < 12; i++) {
        const f = fly(w, h, wave, false, 0.3);
        assert.equal(f.hits, 0, `${w}x${h} wave ${wave} (${f.field.bends})`);
        assert.equal(f.prizes, 0, 'and there are no power-ups on it');
      }
    }
  }
});

test('the hard way can always be flown by a quick pilot, who collects every power-up and meets no bombs', () => {
  for (const [w, h] of SCREENS) {
    for (const wave of [1, 4, 8, 12]) {
      for (let i = 0; i < 12; i++) {
        const f = fly(w, h, wave, true, 0.1);
        assert.equal(f.hits, 0, `${w}x${h} wave ${wave} (${f.field.bends})`);
        assert.equal(f.prizes, f.field.prizes.length);
        assert.equal(f.bombs, 0);
      }
    }
  }
});

test('the hard way is narrower and swings further than the easy way', () => {
  for (const [w, h] of SCREENS) {
    for (const wave of [1, 6, 12]) {
      const { easy, hard } = createField(envFor(w, h, wave));
      assert.ok(hard.width < easy.width && hard.swing > easy.swing, `${w}x${h} wave ${wave}`);
    }
  }
});

test('what a field holds: bombs on the easy way, power-ups on the hard way, rocks of three strengths', () => {
  for (const wave of [1, 2, 3, 9]) {
    const field = createField(envFor(1440, 900, wave));
    assert.equal(field.bombs.length, Math.min(3, 1 + Math.floor(wave / 2)));
    assert.equal(field.prizes.length, wave >= 3 ? 3 : 2);
    assert.equal(field.signs.length, 2, 'each way is signposted');
    assert.deepEqual([...new Set(field.rocks.map((rock) => rock.hp))].sort((a, b) => a - b), [1, 8, 20]);
    assert.ok(field.rocks.filter((rock) => !rock.tough).length > field.rocks.length / 5, 'a good share of the rocks break in one shot');
  }
});

test('later fields are faster and narrower, and none lasts too long', () => {
  const first = createField(envFor(1440, 900, 1));
  const tenth = createField(envFor(1440, 900, 10));
  assert.ok(tenth.speed > first.speed && tenth.easy.width < first.easy.width);
  for (const [w, h] of SCREENS) {
    for (const wave of [1, 12]) {
      const f = fly(w, h, wave, false, 0.2);
      assert.ok(f.seconds < 20, `${w}x${h} wave ${wave}: ${f.seconds.toFixed(1)} s`);
    }
  }
});
