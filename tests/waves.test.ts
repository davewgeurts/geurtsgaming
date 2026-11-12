/** How a wave is laid out: its enemies, and the two set pieces that break it up. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROUP_FROM, buildWavePlan, type Kind } from '../src/game/enemies';

const plan = (wave: number, upgradesLeft = true) => buildWavePlan(wave, 1440, { left: 0, right: 0 }, 1.2, 24, upgradesLeft);

test('every wave has the fuel ship first and the asteroid field second, with enemies before, between and after', () => {
  for (let wave = 1; wave <= 14; wave++) {
    for (let i = 0; i < 40; i++) {
      const p = plan(wave);
      assert.deepEqual(p.stops.map((s) => s.kind), ['fuel', 'rocks']);
      const [fuel, rocks] = p.stops;
      assert.ok(fuel!.at < rocks!.at, `wave ${wave}: fuel at ${fuel!.at}, asteroids at ${rocks!.at}`);
      assert.ok(p.queue.some((s) => s.at < fuel!.at), `wave ${wave}: enemies before the fuel ship`);
      assert.ok(p.queue.some((s) => s.at > fuel!.at && s.at < rocks!.at), `wave ${wave}: enemies between the two`);
      assert.ok(p.queue.some((s) => s.at > rocks!.at), `wave ${wave}: enemies after the asteroids`);
    }
  }
});

test('a set piece never arrives part way through a group of enemies', () => {
  // The members of a chain, a V or a pair arrive within half a second or so of each other; a set piece
  // stops the wave's clock, so one landing inside a group would split it in two.
  for (let wave = 1; wave <= 14; wave++) {
    for (let i = 0; i < 40; i++) {
      const p = plan(wave);
      for (const stop of p.stops) {
        const grouped = p.queue.filter((s) => s.kind === 'drifter' || s.kind === 'mite' || s.kind === 'weaver');
        const before = grouped.filter((s) => s.at <= stop.at).map((s) => s.at);
        const after = grouped.filter((s) => s.at > stop.at).map((s) => s.at);
        if (before.length && after.length) assert.ok(Math.min(...after) - Math.max(...before) >= 0.2, `wave ${wave}: ${stop.kind} at ${stop.at.toFixed(2)}`);
      }
    }
  }
});

test('enemies arrive in order, and never start before the wave is announced', () => {
  for (let wave = 1; wave <= 10; wave++) {
    const { queue } = plan(wave);
    assert.ok(queue.every((s, i) => i === 0 || s.at >= queue[i - 1]!.at));
    assert.ok(queue[0]!.at >= 1.5);
  }
});

test('new kinds of enemy join as the waves go by', () => {
  const kinds = (wave: number) => {
    const seen = new Set<Kind>();
    for (let i = 0; i < 60; i++) for (const s of plan(wave).queue) seen.add(s.kind);
    return seen;
  };
  assert.deepEqual([...kinds(1)].sort(), ['drifter', 'mite']);
  assert.ok(kinds(2).has('weaver') && kinds(2).has('dart'));
  assert.ok(kinds(3).has('spinner') && kinds(3).has('hex') && kinds(3).has('splitter'));
  assert.ok(kinds(4).has('saucer'));
  // The wave a group first appears in always includes it.
  for (let i = 0; i < 40; i++) {
    assert.ok(plan(GROUP_FROM.weavers).queue.some((s) => s.kind === 'weaver'));
    assert.ok(plan(GROUP_FROM.spinners).queue.some((s) => s.kind === 'spinner'));
  }
});

test('one upgrade capsule a wave, until there are no upgrades left to win', () => {
  assert.equal(plan(3, true).upgradeTimes.length, 1);
  assert.equal(plan(3, false).upgradeTimes.length, 0);
});
