/** The mini boss that ends each wave: the one with arms (odd waves) and the one with a sum (even waves). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bossParts, createBoss, shootBoss, tapBoss, touchesBoss, updateBoss, type Boss, type BossEnv } from '../src/game/boss';
import { makeProblem } from '../src/game/maths';
import { CLAW } from '../src/game/shapes';

/** Read something afresh. (After `assert.equal(thing.state, 'fight')` TypeScript takes the state to be 'fight' for good.) */
const look = <T>(thing: T): T => thing;

/** A desktop-sized world that counts what the boss does to it. */
function world(over: Partial<BossEnv> = {}) {
  const seen = { fired: 0, bombs: 0, bursts: 0, speeds: [] as number[] };
  const env: BossEnv = {
    w: 1440, h: 900, top: 0, scale: 1.2, pace: 1, headroom: 104, sweep: Infinity, calm: false, shipX: 720, shipY: 780,
    fire: (_x, _y, vx, vy) => {
      seen.fired++;
      seen.speeds.push(Math.hypot(vx, vy));
    },
    bomb: () => { seen.bombs++; },
    burst: () => { seen.bursts++; },
    problem: () => makeProblem(2),
    ...over,
  };
  return { env, seen };
}

/** Run the boss for up to `seconds`, stopping early once `until` is true. Returns whether it became true. */
function run(b: Boss, env: BossEnv, seconds: number, until?: () => boolean): boolean {
  for (let t = 0; t < seconds; t += 1 / 60) {
    updateBoss(b, 1 / 60, env);
    if (until?.()) return true;
  }
  return false;
}

test('arms boss: shoot the arms off, then the core when the armour opens', () => {
  const { env, seen } = world();
  const b = createBoss(1, env);
  assert.deepEqual([b.kind, b.arms.length, b.hp], ['arms', 2, 23]);
  assert.equal(shootBoss(b, b.x, b.y, env), 'blocked', 'cannot be hurt while it is arriving');
  run(b, env, 2.1);
  assert.equal(b.state, 'fight');
  assert.equal(shootBoss(b, b.x, b.y, env), 'blocked', 'a shot at the core is blocked while the armour is shut');
  assert.equal(b.hp, 23);
  assert.equal(shootBoss(b, b.x + 400, b.y, env), 'miss');
  assert.ok(touchesBoss(b, b.x, b.y + 30, 10, env) && !touchesBoss(b, b.x, b.y + 300, 10, env), 'flying into it counts, flying under it does not');

  const claw = () => bossParts(b, env, 0).find((p) => p.shape === CLAW)!;
  const armHp = b.arms[0]!.hp;
  let hit = '';
  for (let i = 0; i < armHp; i++) hit = shootBoss(b, claw().x, claw().y, env);
  assert.equal(hit, 'armOff');
  assert.equal(b.arms.length, 1);

  seen.fired = 0;
  assert.ok(run(b, env, 6, () => b.open > 0.6), 'the armour opens by itself within six seconds');
  assert.ok(seen.fired >= 8, 'it lashes out as it opens');
  assert.equal(shootBoss(b, b.x, b.y, env), 'core');
  assert.equal(b.hp, 22);
  assert.ok(run(b, env, 6, () => b.open < 0.3), 'the armour shuts again');
  assert.equal(shootBoss(b, b.x, b.y, env), 'blocked');

  run(b, env, 8, () => b.open > 0.6);
  while (b.hp > 0) hit = shootBoss(b, b.x, b.y, env);
  assert.equal(hit, 'down');
  assert.ok(look(b).state === 'dying' && b.defeated);
  seen.bursts = 0;
  assert.ok(run(b, env, 2, () => b.state === 'gone'), 'it is gone within two seconds');
  assert.ok(seen.bursts > 8, 'in a string of explosions');
  assert.equal(bossParts(b, env, 0).length, 0, 'and there is nothing left to draw');
});

test('sum boss: lock on to the ship with the right answer to open its armour', () => {
  const { env, seen } = world();
  const b = createBoss(2, env);
  assert.deepEqual([b.kind, b.arms.length], ['sum', 0]);
  run(b, env, 3);
  assert.ok(b.problem !== null && b.pods.length === 3, 'it shows a sum and three answer ships');
  run(b, env, 8);
  assert.ok(b.open < 0.1, 'its armour never opens by itself');

  const pod = (value: number) => bossParts(b, env, 0).find((p) => p.label === String(value))!;
  const lockOn = (value: number) => {
    const p = pod(value);
    let hit = '';
    for (let i = 0; i < 5; i++) hit = shootBoss(b, p.x, p.y, env);
    return hit;
  };
  const wrong = b.problem!.options.find((o) => o !== b.problem!.answer)!;
  const stray = pod(wrong);
  assert.equal(shootBoss(b, stray.x, stray.y, env), 'lock');
  assert.equal(shootBoss(b, stray.x, stray.y, env), 'lock');
  assert.equal(b.pods.length, 3, 'two stray hits choose nothing');
  run(b, env, 1);
  assert.ok(b.pods.every((p) => p.hits === 0), 'and an unfinished lock fades');

  const asked = b.problemId;
  seen.fired = 0;
  assert.equal(lockOn(wrong), 'wrong');
  assert.ok(look(b).pods.length === 0 && seen.fired >= 11 && b.open < 0.1, 'a wrong ship makes it lash out, and the armour stays shut');
  assert.ok(run(b, env, 3, () => b.pods.length === 3), 'a new sum follows');
  assert.equal(b.problemId, asked + 1);

  assert.equal(lockOn(b.problem!.answer), 'right');
  assert.equal(b.openFor, 5, 'the right ship opens the armour for five seconds');
  run(b, env, 0.6);
  assert.equal(shootBoss(b, b.x, b.y, env), 'core');
  assert.ok(run(b, env, 6, () => b.open < 0.3) && run(b, env, 2, () => b.pods.length === 3), 'then it shuts and asks again');
});

test('sum boss on a touch screen: a tap chooses, a passing shot does not', () => {
  const { env } = world();
  const fresh = () => {
    const boss = createBoss(2, env);
    run(boss, env, 12, () => boss.pods.length > 0);
    return boss;
  };
  const at = (boss: Boss, slot: number) => ({ x: boss.x + (slot - 1) * 92 * env.scale * 1.3, y: boss.y + 82 * env.scale * 1.3 });

  let boss = fresh();
  assert.equal(tapBoss(boss, boss.x, boss.y + 400, env), 'miss');
  assert.equal(boss.pods.length, 3, 'a tap on empty space chooses nothing');
  let p = at(boss, boss.pods.findIndex((q) => q.value === boss.problem!.answer));
  assert.equal(tapBoss(boss, p.x + 10, p.y - 8, env), 'right');
  run(boss, env, 0.5);
  assert.equal(shootBoss(boss, boss.x, boss.y, env), 'core', 'the core is open after the tap');

  boss = fresh();
  p = at(boss, boss.pods.findIndex((q) => q.value !== boss.problem!.answer));
  assert.equal(tapBoss(boss, p.x, p.y, env), 'wrong');

  boss = fresh();
  p = at(boss, 0);
  for (let i = 0; i < 12; i++) assert.equal(shootBoss(boss, p.x, p.y, env, false), 'blocked', 'a shot that was not aimed never chooses a ship');
  assert.equal(boss.pods.length, 3);
});

test('the answer ships stay on a phone screen', () => {
  const { env } = world({ w: 390, h: 844, scale: 0.85 });
  const b = createBoss(2, env);
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t < 30; t += 1 / 30) {
    updateBoss(b, 1 / 30, env);
    for (const part of bossParts(b, env, 0)) {
      if (!part.label) continue;
      min = Math.min(min, part.x);
      max = Math.max(max, part.x);
    }
  }
  assert.ok(min > 21 && max < 390 - 21, `answer ships ran from ${Math.round(min)} to ${Math.round(max)} px`);
});

test('a boss nobody beats gives up, having thrown a few bombs', () => {
  const { env, seen } = world();
  const b = createBoss(3, env);
  assert.equal(b.arms.length, 3);
  assert.ok(run(b, env, 60, () => b.state === 'gone') && !b.defeated);
  assert.equal(createBoss(9, env).arms.length, 4, 'four arms at most');

  seen.bombs = 0;
  const idle = createBoss(1, env);
  run(idle, env, 50, () => idle.state === 'gone');
  assert.ok(seen.bombs >= 4 && seen.bombs <= 8, `threw ${seen.bombs} bombs in a full stay`);
});

test('later bosses stop getting tougher, and wait a little longer', () => {
  const { env } = world();
  assert.equal(createBoss(13, env).maxHp, createBoss(25, env).maxHp);
  assert.equal(createBoss(12, env).maxHp, createBoss(30, env).maxHp);
  assert.ok(createBoss(11, env).maxHp < createBoss(13, env).maxHp, 'they do grow up to there');
  assert.deepEqual([1, 5, 40].map((wave) => createBoss(wave, env).timeLeft), [45, 55, 70]);
});

test('on a short screen the boss sits higher and its shots are slower', () => {
  const { env, seen } = world({ w: 844, h: 390, scale: 0.62, pace: 0.6, headroom: 68 });
  const b = createBoss(1, env);
  run(b, env, 20);
  assert.ok(seen.speeds.length > 3 && seen.speeds.every((v) => v < 0.6 * 280 + 1), `fastest shot ${Math.max(...seen.speeds).toFixed(0)} px a second`);
  assert.ok(b.y < 390 * 0.36, `boss at ${b.y.toFixed(0)} px down a 390 px screen`);
});
