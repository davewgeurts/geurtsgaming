/**
 * When the game asks a question and what the answer is worth: the break before a wave, the capsules and bombs
 * in the middle of one, and the choice of upgrade. (What counts as a right answer is tested in questions.test.ts.)
 * The game is stood in for by an env that keeps its own hull, energy and score, and writes down what it is asked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choose, type Challenge, type Outcome } from '../src/game/challenge';
import { LINES, WORDS } from '../src/game/lines';
import {
  ALL_OWNED_POINTS, DEFUSE_POINTS, FULL_HULL_BONUS, JAM_SECONDS, OFFER_GRACE, POWER_GAIN, Questions, ROUND_PROBLEMS,
  sumLevel, type QuestionEnv,
} from '../src/game/questions';
import { UPGRADES, type UpgradeId } from '../src/game/upgrades';

const DT = 1 / 60;
const GOOD: Outcome = { success: true, quality: 0.8, accuracy: 0.96, wpm: 30 };
const SLOPPY: Outcome = { success: true, quality: 0.5, accuracy: 0.7, wpm: 12 };
const FAILED: Outcome = { success: false, quality: 0, accuracy: 0, wpm: 0 };

interface World extends QuestionEnv {
  score: number;
  jammed: number;
  sheltered: number;
  log: string[];
  said: string[];
  calls: string[];
  sounds: string[];
  fitted: UpgradeId[];
}

function world(over: Partial<QuestionEnv> = {}): World {
  const fitted: UpgradeId[] = [];
  const w: World = {
    touch: false, wave: 1, hull: 3, maxHull: 3, energy: 0, boss: false, owned: new Set<UpgradeId>(),
    score: 0, jammed: 0, sheltered: 0, log: [], said: [], calls: [], sounds: [], fitted,
    play: (sound) => w.sounds.push(sound),
    say: (message) => w.said.push(message),
    call: (text) => w.calls.push(text),
    feel: () => {},
    taunt: (kind) => w.log.push(`taunt:${kind}`),
    award: (points) => (w.score += points),
    charge: (amount) => (w.energy = Math.min(1, w.energy + amount)),
    repair: () => (w.hull += 1),
    jam: (seconds) => (w.jammed = seconds),
    blast: () => w.log.push('blast'),
    equip: (id) => fitted.push(id),
    explode: () => w.log.push('explode'),
    shelter: (seconds) => (w.sheltered = seconds),
    park: (wave) => w.log.push(`park:${wave}`),
    launch: (wave) => w.log.push(`launch:${wave}`),
    ...over,
  };
  return w;
}

const banners = (q: Questions) => q.brk?.result?.map((line) => line.text) ?? [];
const runBreak = (q: Questions, w: World, seconds: number) => { for (let t = 0; t < seconds; t += DT) q.updateBreak(DT, w); };
const runPrompt = (q: Questions, w: World, seconds: number) => { for (let t = 0; t < seconds; t += DT) q.updatePrompt(DT, w); };
/** The question that is open now. (Asked through a function so that one assertion about it does not narrow the next.) */
const asked = (q: Questions): Challenge => q.challenge!;
/** Give the open question an answer without playing it out. */
const settle = (c: Challenge, outcome: Outcome) => { c.outcome = outcome; };

test('sums get harder every two waves, and stop at the hardest', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9, 30].map(sumLevel), [1, 1, 2, 2, 3, 3, 3, 3]);
});

test('at a keyboard the break is one line to type; good clean typing charges the cannons and mends the hull', () => {
  const w = world({ hull: 2 });
  const q = new Questions();
  q.startBreak(1, w);
  assert.deepEqual(w.log, ['park:1']);
  const c = q.challenge!;
  assert.equal(c.kind, 'line');
  assert.ok(c.kind === 'line' && LINES[0]!.includes(c.text), 'the first waves use the shortest lines');
  assert.match(w.said[0]!, /^Game started\. Charge the ship for wave 1\. Type: /);

  settle(c, GOOD);
  q.updateBreak(DT, w);
  assert.equal(w.hull, 3, 'clean work repairs a hurt hull');
  assert.equal(w.energy, 0.8);
  assert.equal(w.score, 0);
  assert.deepEqual(banners(q), ['ENERGY +80%', 'ACCURACY 96% - SPEED 30 WPM', 'TRIPLE CANNONS', 'HULL REPAIRED']);
  assert.equal(q.challenge, null, 'nothing is being asked while the result is up');
  assert.deepEqual(w.calls, ['TRIPLE CANNONS'], 'the pilot calls out how the cannons are charged');

  runBreak(q, w, 2.5);
  assert.ok(q.brk, 'the result stays up to be read');
  runBreak(q, w, 0.2);
  assert.equal(q.brk, null);
  assert.deepEqual(w.log, ['park:1', 'launch:1']);
});

test('clean work on a full hull earns points instead; sloppy or unfinished work repairs nothing', () => {
  const full = world();
  const q = new Questions();
  q.startBreak(3, full);
  settle(q.challenge!, GOOD);
  q.updateBreak(DT, full);
  assert.equal(full.score, FULL_HULL_BONUS);
  assert.equal(full.hull, 3);
  assert.ok(banners(q).includes(`HULL IS FULL - BONUS ${FULL_HULL_BONUS}`));
  assert.match(full.said[0]!, /^Wave 2 cleared\./);

  const sloppy = world({ hull: 1 });
  q.startBreak(3, sloppy);
  settle(q.challenge!, SLOPPY);
  q.updateBreak(DT, sloppy);
  assert.equal(sloppy.hull, 1);
  assert.equal(sloppy.energy, 0.5);
  assert.deepEqual(banners(q).slice(-2), ['TWIN CANNONS', '90% ACCURACY REPAIRS THE HULL']);

  const late = world({ hull: 1 });
  q.startBreak(3, late);
  settle(q.challenge!, { ...FAILED, quality: 0.2 });
  q.updateBreak(DT, late);
  assert.equal(late.hull, 1);
  assert.deepEqual(banners(q), ['OUT OF TIME', 'ENERGY +20%', 'TWIN CANNONS', 'FINISHING THE LINE REPAIRS THE HULL']);
});

/** Play a round of sums on a touch screen, tapping the right answer except on the sums listed in `wrong`. */
function playRound(w: World, wrong: number[] = []): Questions {
  const q = new Questions();
  q.startBreak(2, w);
  for (let i = 0; i < ROUND_PROBLEMS; i++) {
    const c = q.challenge!;
    assert.ok(c.kind === 'choice', `sum ${i + 1} has answers to tap`);
    runBreak(q, w, 0.7);
    choose(c, wrong.includes(i) ? (c.correct + 1) % c.options.length : c.correct);
    // The answer stays up for a moment (longer when it was wrong) before the next sum.
    runBreak(q, w, 1.8);
  }
  return q;
}

test('on a touch screen the break is three sums; all three right repairs the hull', () => {
  const w = world({ touch: true, hull: 2 });
  const q = playRound(w);
  assert.equal(banners(q)[0], '3 OF 3 CORRECT');
  assert.equal(w.hull, 3);
  assert.ok(w.energy > 0.5, 'three quick right answers are worth most of a tank');
  assert.equal(w.said.filter((s) => s.includes('Tap the answer')).length, 3);

  const missed = world({ touch: true, hull: 2 });
  const q2 = playRound(missed, [1]);
  assert.equal(banners(q2)[0], '2 OF 3 CORRECT');
  assert.equal(missed.hull, 2);
  assert.equal(banners(q2).at(-1), 'ALL CORRECT REPAIRS THE HULL');
  assert.ok(missed.energy < w.energy);
});

test('a capsule answered right pays what it holds; answered wrong it jams the cannons', () => {
  const q = new Questions();

  const power = world({ touch: true, energy: 0.1 });
  q.startPrompt('energy', power);
  assert.ok(q.asking);
  assert.match(power.said[0]!, /^Boost capsule\. Answer in 10 seconds to power up\./);
  settle(q.challenge!, GOOD);
  q.updatePrompt(DT, power);
  assert.ok(Math.abs(power.energy - (0.1 + POWER_GAIN * 0.8)) < 1e-9);
  assert.equal(q.prompt!.note, 'POWER +48%');
  assert.deepEqual(power.calls, ['POWER UP']);
  assert.ok(!q.asking, 'once it is settled the world speeds up again');
  runPrompt(q, power, 1.1);
  assert.equal(q.prompt, null);
  assert.equal(power.sheltered, 1, 'and the ship has a moment before it can be hit');

  const hurt = world({ touch: true, hull: 1 });
  q.startPrompt('hull', hurt);
  settle(q.challenge!, GOOD);
  q.updatePrompt(DT, hurt);
  assert.equal(hurt.hull, 2);

  const whole = world({ touch: true });
  q.startPrompt('hull', whole);
  settle(q.challenge!, GOOD);
  q.updatePrompt(DT, whole);
  assert.equal(whole.hull, 3);
  assert.equal(whole.score, FULL_HULL_BONUS);

  const boom = world({ touch: true });
  q.startPrompt('blast', boom);
  settle(q.challenge!, GOOD);
  q.updatePrompt(DT, boom);
  assert.deepEqual(boom.log, ['blast']);

  const wrong = world({ touch: true });
  q.startPrompt('blast', wrong);
  settle(q.challenge!, FAILED);
  q.updatePrompt(DT, wrong);
  assert.deepEqual(wrong.log, [], 'no blast');
  assert.equal(q.prompt!.note, 'CANNONS JAMMED');
  assert.deepEqual(wrong.calls, ['CANNONS JAMMED']);
  assert.ok(wrong.jammed > JAM_SECONDS, 'jammed for the time the note is up, and then some');
});

test('a bomb defused is worth points; a bomb not defused goes off once the result has been read', () => {
  const q = new Questions();
  const safe = world({ touch: true, boss: true });
  q.startPrompt('defuse', safe);
  assert.match(safe.said[0]!, /^You hit a bomb\./);
  settle(q.challenge!, GOOD);
  q.updatePrompt(DT, safe);
  assert.equal(safe.score, DEFUSE_POINTS);
  assert.deepEqual(safe.log, ['taunt:defused'], 'the boss is not pleased');
  runPrompt(q, safe, 1.1);
  assert.equal(q.prompt, null);

  const lost = world({ touch: true });
  q.startPrompt('defuse', lost);
  settle(q.challenge!, FAILED);
  q.updatePrompt(DT, lost);
  assert.equal(q.prompt!.note, 'THE BOMB GOES OFF');
  assert.deepEqual(lost.calls, [], 'the pilot has nothing to say about that');
  assert.ok(q.asking, 'the world stays slow until it does');
  assert.deepEqual(lost.log, [], 'with no boss about, nobody gloats');
  runPrompt(q, lost, 1.6);
  assert.deepEqual(lost.log, []);
  runPrompt(q, lost, 0.2);
  assert.deepEqual(lost.log, ['explode']);
  assert.equal(q.prompt, null);
  assert.equal(lost.sheltered, 0);
});

test('an upgrade capsule answered right offers three; one can be picked after a moment, by number key or tap', () => {
  const w = world();
  const q = new Questions();
  q.startPrompt('upgrade', w);
  settle(q.challenge!, GOOD);
  q.updatePrompt(DT, w);
  const offer = q.prompt!.offer!;
  assert.equal(offer.length, 3);
  assert.ok(q.asking);
  assert.ok(q.wants('3') && !q.wants('4') && !q.wants('a'));

  q.type('2', w);
  assert.deepEqual(w.fitted, [], 'a key still down from the question picks nothing');
  runPrompt(q, w, OFFER_GRACE + DT);
  q.type('2', w);
  assert.deepEqual(w.fitted, [offer[1]!.id]);
  assert.equal(q.prompt!.note, `${offer[1]!.name} READY`);
  assert.deepEqual(w.calls, [`${offer[1]!.name} READY`]);
  assert.ok(!q.asking);
  q.chooseUpgrade(0, w);
  assert.equal(w.fitted.length, 1, 'only one of the three');
  runPrompt(q, w, 1.4);
  assert.equal(q.prompt, null);

  const all = world({ owned: new Set(UPGRADES.map((u) => u.id)) });
  q.startPrompt('upgrade', all);
  settle(q.challenge!, GOOD);
  q.updatePrompt(DT, all);
  assert.equal(q.prompt!.offer, null);
  assert.equal(all.score, ALL_OWNED_POINTS);
});

test('at a keyboard a capsule asks a sum to pick, a sum to type, or a word; a bomb forgives one slip', () => {
  const q = new Questions();
  const w = world();
  const random = Math.random;
  try {
    Math.random = () => 0.1;
    q.startPrompt('energy', w);
    assert.equal(asked(q).kind, 'choice');
    Math.random = () => 0.5;
    q.startPrompt('energy', w);
    const typed = asked(q);
    assert.ok(typed.kind === 'entry' && typed.retries === 0);
    q.startPrompt('defuse', w);
    const bomb = asked(q);
    assert.ok(bomb.kind === 'entry' && bomb.retries === 1);
    Math.random = () => 0.9;
    q.startPrompt('energy', w);
    const word = asked(q);
    assert.ok(word.kind === 'line' && WORDS.includes(word.text));
  } finally {
    Math.random = random;
  }
});

test('keys go to the question, with a click when they count and a buzz when they do not', () => {
  const w = world();
  const q = new Questions();
  q.startBreak(1, w);
  const c = asked(q);
  assert.ok(c.kind === 'line');
  assert.ok(q.wants('x') && q.wants(' '), 'a line takes any character');
  assert.ok(!q.wants('ArrowLeft') && !q.wants('Enter'), 'but not the keys that fly the ship');
  runBreak(q, w, 0.7);
  w.sounds.length = 0;
  q.type(c.text[0]!.toLowerCase(), w);
  q.type('#', w);
  assert.deepEqual(w.sounds, ['key', 'slip']);
  assert.equal(c.index, 1);
});

test('a finger on the screen turns a question that needs typing into one with answers to tap', () => {
  const w = world();
  const q = new Questions();
  q.startBreak(4, w);
  assert.equal(asked(q).kind, 'line');
  w.touch = true;
  q.byTouch(w);
  assert.equal(asked(q).kind, 'choice');
  assert.equal(q.brk!.total, ROUND_PROBLEMS);
  assert.equal(q.brk!.wave, 4);

  const random = Math.random;
  const mid = world();
  q.reset();
  try {
    Math.random = () => 0.9;
    q.startPrompt('energy', mid);
  } finally {
    Math.random = random;
  }
  assert.equal(asked(q).kind, 'line');
  mid.touch = true;
  q.byTouch(mid);
  assert.equal(asked(q).kind, 'choice');
  assert.match(mid.said.at(-1)!, /Tap the answer/);
  // A sum that already has answers to tap is left alone.
  const same = q.challenge;
  q.byTouch(mid);
  assert.equal(q.challenge, same);
});
