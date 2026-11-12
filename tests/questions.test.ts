/** The sums, the lines to type, and the rules for answering them. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accepts, choiceChallenge, choose, entryChallenge, lineChallenge, press, tick } from '../src/game/challenge';
import { BRIEFING, LINES, TAUNTS, WORDS } from '../src/game/lines';
import { makeProblem } from '../src/game/maths';

/** Read something afresh. (After `assert.equal(thing.state, 'fight')` TypeScript takes the state to be 'fight' for good.) */
const look = <T>(thing: T): T => thing;

const SUM = { question: '7 + 5', answer: 12, options: [11, 12, 13] };

test('every sum is well formed, at every level', () => {
  for (const level of [1, 2, 3]) {
    for (let i = 0; i < 3000; i++) {
      const p = makeProblem(level);
      const [a, op, b] = p.question.split(' ');
      const x = Number(a);
      const y = Number(b);
      const truth = op === '+' ? x + y : op === '-' ? x - y : op === '×' ? x * y : x / y;
      assert.equal(p.answer, truth, p.question);
      assert.ok(Number.isInteger(p.answer) && p.answer >= 0, `${p.question} is whole and not negative`);
      assert.equal(new Set(p.options).size, 3, `${p.question} offers three different answers`);
      assert.equal(p.options.filter((o) => o === p.answer).length, 1, `${p.question} offers the right answer once`);
      assert.ok(p.options.every((o) => o >= 0), `${p.question} offers no negative answers`);
    }
  }
});

test('harder levels bring in harder sums', () => {
  const ops = (level: number) => new Set(Array.from({ length: 2000 }, () => makeProblem(level).question.split(' ')[1]));
  assert.deepEqual([...ops(1)].sort(), ['+', '-']);
  assert.ok(ops(2).has('×'));
  assert.ok(ops(3).has('÷'));
});

test('everything typed or shown uses only what the stroke font can draw', () => {
  // Lines to type are letters and single spaces, so no key is hard to find.
  for (const text of [...LINES.flat(), ...WORDS]) assert.match(text, /^[A-Z]+( [A-Z]+)*$/, text);
  // Everything else may also use the font's digits and punctuation, but never lower case.
  const shown = [...Object.values(TAUNTS).flat(), ...BRIEFING.keys, ...BRIEFING.touch, ...BRIEFING.asteroids, ...BRIEFING.choice, BRIEFING.engines, BRIEFING.luck, BRIEFING.sonic];
  for (const text of shown) assert.match(text, /^[A-Z0-9 ,.:\-+=/!?'×÷%]+$/, text);
});

/** Type a whole line at a steady speed, with a wrong key every `typoEvery` letters. */
function typeLine(text: string, secondsPerKey: number, typoEvery = 0) {
  const c = lineChallenge(text, 30, 0.6);
  tick(c, 0.3);
  press(c, text[0]!);
  assert.equal(c.index, 0, 'keys pressed in the first moment are ignored');
  tick(c, 0.5);
  [...text].forEach((ch, i) => {
    if (typoEvery && i % typoEvery === typoEvery - 1) press(c, '#');
    press(c, ch.toLowerCase());
    tick(c, secondsPerKey);
  });
  return c.outcome!;
}

test('typing: speed and accuracy decide what a line is worth', () => {
  const fast = typeLine('CHARGE THE LASERS NOW', 0.25); // 48 words a minute
  const slow = typeLine('CHARGE THE LASERS NOW', 1.2); // 10 words a minute
  const sloppy = typeLine('CHARGE THE LASERS NOW', 0.25, 4);
  assert.ok(fast.success);
  assert.equal(fast.quality, 1, 'fast and clean is worth everything');
  assert.ok(Math.abs(slow.quality - 0.5) < 0.01, 'slow and clean is worth half');
  assert.ok(sloppy.quality < fast.quality && sloppy.accuracy < 0.9, 'wrong keys cost');
});

test('typing: running out of time keeps a share for what was typed', () => {
  const c = lineChallenge('ABCDEFGHIJ', 5, 0.5);
  tick(c, 0.6);
  press(c, 'a');
  tick(c, 0.5);
  press(c, 'b');
  tick(c, 6);
  assert.ok(c.outcome && !c.outcome.success);
  assert.ok(c.outcome.quality > 0 && c.outcome.quality < 0.2);
});

test('a sum with answers to pick from', () => {
  let c = choiceChallenge(SUM, 10, 0.3);
  tick(c, 0.1);
  choose(c, 1);
  assert.equal(c.outcome, null, 'a pick in the first moment is ignored');
  tick(c, 0.5);
  assert.ok(accepts(c, '2') && !accepts(c, '4') && !accepts(c, 'a'), 'only the keys 1 to 3 are answers');
  press(c, '2');
  assert.ok(c.outcome!.success);
  assert.equal(c.outcome!.quality, 1, 'a quick right answer is worth everything');

  c = choiceChallenge(SUM, 10, 0.3);
  tick(c, 9);
  press(c, '2');
  assert.ok(c.outcome!.success && c.outcome!.quality < 0.7, 'a late right answer is worth less');

  c = choiceChallenge(SUM, 10, 0.3);
  tick(c, 1);
  choose(c, 0);
  assert.ok(!look(c).outcome!.success && look(c).outcome!.quality === 0 && c.picked === 0, 'a wrong answer is worth nothing');

  c = choiceChallenge(SUM, 10, 0.3);
  tick(c, 11);
  assert.ok(c.outcome && !c.outcome.success, 'no answer in time is a miss');
});

test('a sum whose answer is typed in', () => {
  let e = entryChallenge(SUM, 10, 0.3);
  tick(e, 1);
  press(e, '1');
  assert.ok(e.outcome === null && e.typed === '1', 'one digit of two is not an answer yet');
  press(e, 'Backspace');
  assert.equal(e.typed, '');
  press(e, '1');
  press(e, '2');
  assert.ok(e.outcome!.success, 'checked as soon as it is long enough, with no Enter key');

  e = entryChallenge(SUM, 10, 0.3);
  tick(e, 1);
  press(e, '1');
  press(e, '3');
  assert.ok(e.outcome && !e.outcome.success, 'a wrong answer fails when no retry is allowed');
  assert.ok(!accepts(e, '1'), 'nothing more can be typed once it is settled');
});

test('a typed sum with a retry forgives one wrong answer, not two', () => {
  let r = entryChallenge(SUM, 10, 0.3, 1);
  tick(r, 1);
  press(r, '1');
  press(r, '3');
  assert.ok(r.outcome === null && r.typed === '' && r.misses === 1 && r.retries === 0 && r.error > 0, 'the first wrong answer is wiped');
  press(r, '1');
  press(r, '2');
  assert.ok(look(r).outcome?.success, 'right on the second try');

  r = entryChallenge(SUM, 10, 0.3, 1);
  tick(r, 1);
  for (const key of ['1', '3', '1', '4']) press(r, key);
  assert.ok(r.outcome && !r.outcome.success, 'wrong twice fails');

  r = entryChallenge(SUM, 10, 0.3, 1);
  tick(r, 1);
  press(r, '1');
  press(r, '3');
  tick(r, 20);
  assert.ok(r.outcome && !r.outcome.success, 'the clock still runs out after a retry');
});
