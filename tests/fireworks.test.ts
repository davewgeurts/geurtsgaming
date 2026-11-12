/**
 * The fireworks that say how a challenge went. Only their size and colour are tested, and that they end:
 * how they look is for the eye.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEON } from '../src/game/core';
import { Fireworks, GRADE_COLOR, MAX_SPARKS, type Grade } from '../src/game/fireworks';

const DT = 1 / 60;

/** Run a show to its end. Returns the most sparks in the air at once, every colour seen, and how long it lasted. */
function show(grade: Grade, big: boolean) {
  const fw = new Fireworks();
  fw.launch(grade, big, 500, 300, 250, 1);
  const shells = fw.pending;
  let most = 0;
  let seconds = 0;
  const colors = new Set<string>();
  while (fw.active && seconds < 20) {
    fw.update(DT);
    seconds += DT;
    most = Math.max(most, fw.sparks.length);
    for (const s of fw.sparks) colors.add(s.color);
  }
  return { shells, most, seconds, colors: [...colors], ended: !fw.active };
}

test('a grade has a colour: red for failed, yellow for good, green for perfect', () => {
  assert.deepEqual(GRADE_COLOR, { failed: NEON.red, good: NEON.yellow, perfect: NEON.lime });
});

test('the better the answer, the bigger the show', () => {
  const perfect = show('perfect', true);
  const good = show('good', true);
  const failed = show('failed', true);
  assert.ok(perfect.shells > good.shells && good.shells > failed.shells, 'more shells');
  assert.ok(perfect.most > good.most * 1.5 && good.most > failed.most * 2, `more sparks (${perfect.most}, ${good.most}, ${failed.most})`);
  assert.ok(perfect.seconds > good.seconds && good.seconds > failed.seconds, 'and it goes on for longer');
  assert.equal(failed.shells, 1, 'a failed one is a single fizzle');
  assert.ok(failed.seconds < 1.2);
});

test('failed is all red, good all yellow, and perfect starts green and goes through the neon colours', () => {
  assert.deepEqual(show('failed', true).colors, [NEON.red]);
  assert.deepEqual(show('good', true).colors, [NEON.yellow]);
  const perfect = show('perfect', true).colors;
  assert.equal(perfect[0], NEON.lime);
  assert.ok(perfect.length >= 4, `several colours (${perfect.length})`);
  assert.ok(!perfect.includes(NEON.red), 'none of them red');
  assert.deepEqual(show('perfect', false).colors, [NEON.lime], 'one sum done perfectly is a single green burst');
});

test('one sum in a round gets a small burst, not the whole show', () => {
  for (const grade of ['failed', 'good', 'perfect'] as const) {
    const small = show(grade, false);
    const big = show(grade, true);
    assert.equal(small.shells, 1);
    assert.ok(small.most <= big.most, grade);
  }
});

test('every show ends, sparks fall, and answering in a hurry never fills the sky without limit', () => {
  for (const grade of ['failed', 'good', 'perfect'] as const) assert.ok(show(grade, true).ended, grade);

  const fw = new Fireworks();
  for (let i = 0; i < 30; i++) fw.launch('perfect', true, 500, 300, 250, 1);
  let most = 0;
  for (let t = 0; t < 3; t += DT) {
    fw.update(DT);
    most = Math.max(most, fw.sparks.length);
  }
  assert.ok(most <= MAX_SPARKS, `${most} sparks at once`);

  const one = new Fireworks();
  one.launch('failed', true, 500, 300, 250, 1);
  one.update(DT);
  const before = one.sparks.reduce((sum, s) => sum + s.y, 0) / one.sparks.length;
  for (let t = 0; t < 0.5; t += DT) one.update(DT);
  const after = one.sparks.reduce((sum, s) => sum + s.y, 0) / one.sparks.length;
  assert.ok(after > before, 'a dud drops');
  one.clear();
  assert.ok(!one.active);
});
