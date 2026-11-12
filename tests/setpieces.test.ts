/**
 * The running order of a wave's set pieces: when the fuel ship and the asteroid field start, what holds the
 * wave's clock, and what each is worth. The game is stood in for by an env that writes down what it is asked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALERT_LEAD, ALERT_SECONDS, ALERT_TURN, CLEAN_FIELD_POINTS, DUE_PATIENCE, FIELD_POINTS, FULL_TANK_POINTS,
  PEBBLE_POINTS, ROCK_POINTS, SetPieces, type SetPieceEnv,
} from '../src/game/setpieces';
import { tankerTail } from '../src/game/tanker';

const DT = 1 / 60;

interface Log { sounds: string[]; said: string[]; radio: string[]; calls: string[]; score: number; energy: number; bombs: number; capsules: boolean[]; bursts: number; sparks: number }

function makeEnv(w = 1440, h = 900): { env: SetPieceEnv; log: Log } {
  const log: Log = { sounds: [], said: [], radio: [], calls: [], score: 0, energy: 0, bombs: 0, capsules: [], bursts: 0, sparks: 0 };
  const env: SetPieceEnv = {
    w, h, top: 0, left: 0, right: 0, scale: 1, pace: 1, shipScale: 1.15, wave: 1, time: 0, playing: true, shipX: w / 2, shipY: h * 0.86,
    play: (sound) => log.sounds.push(sound),
    say: (message) => log.said.push(message),
    radio: (text) => log.radio.push(text),
    call: (text) => log.calls.push(text),
    feel: () => {},
    award: (points) => (log.score += points),
    charge: (amount) => (log.energy = Math.min(1, log.energy + amount)),
    ring: () => {},
    spark: () => log.sparks++,
    burst: () => log.bursts++,
    bomb: () => log.bombs++,
    capsule: (_x, _y, _ride, last) => log.capsules.push(last),
  };
  return { env, log };
}

/** Run the set pieces for `seconds`, as the wave does. Returns how many of those seconds the wave's clock was held. */
function run(sets: SetPieces, env: SetPieceEnv, seconds: number, enemies = 0, asking = false, each?: () => void): number {
  let held = 0;
  for (let t = 0; t < seconds; t += DT) {
    env.time += DT;
    each?.();
    if (sets.run(DT, DT, env, enemies, asking)) held += DT;
  }
  return held;
}

test('the wave clock runs up to a set piece and no further', () => {
  const sets = new SetPieces();
  sets.plan([{ at: 2, kind: 'fuel' }, { at: 5, kind: 'rocks' }]);
  assert.equal(sets.advance(0, 1.5), 1.5);
  assert.equal(sets.due, null);
  assert.equal(sets.advance(1.5, 1.5), 2, 'the clock stops at the fuel ship');
  assert.equal(sets.due, 'fuel');
  assert.deepEqual(sets.stops, [{ at: 5, kind: 'rocks' }]);
});

test('a set piece waits for a clear sky, but not for ever, and never starts over a question', () => {
  const { env, log } = makeEnv();
  const sets = new SetPieces();
  sets.plan([{ at: 1, kind: 'fuel' }]);
  sets.advance(0, 1);
  assert.ok(run(sets, env, 3, 4) > 2.9, 'the wave is held while it waits');
  assert.equal(sets.tanker, null, 'enemies still about: not yet');
  run(sets, env, DUE_PATIENCE, 4, true);
  assert.equal(sets.tanker, null, 'a question is open: not yet, however long it has waited');
  run(sets, env, DT, 4);
  assert.ok(sets.tanker, 'it has waited long enough');
  assert.deepEqual(log.sounds, ['tanker']);
  assert.equal(sets.due, null);

  const clear = new SetPieces();
  clear.plan([{ at: 1, kind: 'fuel' }]);
  clear.advance(0, 1);
  run(clear, env, DT);
  assert.ok(clear.tanker, 'with a clear sky it comes at once');
});

test('a pilot who stays on the fuel line fills the tank and is paid for it', () => {
  const { env, log } = makeEnv();
  const sets = new SetPieces();
  sets.plan([{ at: 0, kind: 'fuel' }]);
  sets.advance(0, DT);
  // A pilot with perfect reactions: on the basket until hooked, then a comfortable way behind the tail.
  const held = run(sets, env, 40, 0, false, () => {
    const t = sets.tanker;
    if (!t) return;
    const tail = tankerTail(t, env.scale);
    env.shipX = t.hooked ? tail.x : t.drogue.x;
    env.shipY = (t.hooked ? tail.y + 104 * env.scale : t.drogue.y) + 16 * env.shipScale;
  });
  assert.equal(sets.tanker, null, 'the fuel ship has been and gone');
  assert.ok(held > 6 && held < 40, `the wave was held for the visit (${held.toFixed(1)}s)`);
  assert.equal(log.score, FULL_TANK_POINTS);
  assert.equal(log.energy, 1);
  assert.ok(log.sounds.includes('hook') && log.sounds.includes('power'));
  assert.match(sets.note.text, /^FULL TANK/);
  assert.equal(log.calls.at(-1), 'FULL TANK', 'the pilot says so');
  assert.equal(run(sets, env, 1), 0, 'and the wave moves on');
});

/** Start the asteroids and run to the moment the field sets off. */
function toField(wave = 1): { sets: SetPieces; env: SetPieceEnv; log: Log } {
  const { env, log } = makeEnv();
  env.wave = wave;
  const sets = new SetPieces();
  sets.plan([{ at: 0, kind: 'rocks' }]);
  sets.advance(0, DT);
  run(sets, env, ALERT_LEAD + 2 * DT);
  return { sets, env, log };
}

test('the warning comes first, then the field, with bombs on one way and power-ups on the other', () => {
  const { env, log } = makeEnv();
  const sets = new SetPieces();
  sets.plan([{ at: 0, kind: 'rocks' }]);
  sets.advance(0, DT);
  run(sets, env, DT);
  assert.equal(sets.alert, 0);
  assert.deepEqual(log.sounds, ['alarm']);
  assert.match(log.said[0]!, /^Flight commander: ASTEROIDS COMING!/);
  run(sets, env, ALERT_TURN);
  assert.deepEqual(log.sounds, ['alarm', 'radio'], 'the commander turns to the choice of ways');
  assert.deepEqual(log.radio, ['ASTEROIDS COMING! TAKE EVASIVE MANOEUVRES!', 'LOOK, PILOT! THERE IS AN EASIER WAY WITH BOMBS, OR A HARDER PATH WITH POWER-UPS. CHOOSE WISELY!'], 'and says both parts out loud');
  assert.equal(sets.field, null);
  run(sets, env, ALERT_LEAD - ALERT_TURN + DT);
  assert.ok(sets.field, 'the rocks set off while the commander is still talking');
  assert.ok(log.bombs >= 1);
  assert.ok(log.capsules.length >= 2);
  assert.deepEqual(log.capsules.filter(Boolean), [true], 'one capsule is the big prize');
  assert.equal(log.capsules.at(-1), true, 'and it is the last one, at the far end');
  run(sets, env, ALERT_SECONDS - ALERT_LEAD);
  assert.equal(sets.alert, null, 'the warning clears');
  assert.ok(sets.field, 'and the field is still coming');
});

test('getting through pays, and getting through without a scratch pays more', () => {
  for (const scrapes of [0, 2]) {
    const { sets, env, log } = toField();
    const field = sets.field!;
    for (let i = 0; i < scrapes; i++) sets.scrape(field.rocks.find((r) => r.tough)!, env);
    const held = run(sets, env, 120);
    assert.equal(sets.field, null);
    assert.ok(held < 60, `a field does not go on for ever (${held.toFixed(1)}s)`);
    assert.equal(log.score, scrapes ? FIELD_POINTS : CLEAN_FIELD_POINTS);
    assert.match(sets.note.text, scrapes ? /^THROUGH THE ASTEROIDS/ : /^NOT A SCRATCH/);
    assert.deepEqual(log.calls, [scrapes ? 'THROUGH THE ASTEROIDS' : 'NOT A SCRATCH']);
    assert.equal(sets.near.length, 0);
  }
});

test('little rocks break at a shot; tough ones spark, and only break after many', () => {
  const { sets, env, log } = toField();
  const field = sets.field!;
  const pebble = field.rocks.find((r) => !r.tough)!;
  const tough = field.rocks.find((r) => r.tough && r.hp > 2)!;
  const hp = tough.hp;

  sets.hitRock(pebble, 0, 0, env);
  assert.ok(pebble.dead);
  assert.equal(log.score, PEBBLE_POINTS);
  assert.equal(log.bursts, 1);

  sets.hitRock(tough, 0, 0, env);
  assert.ok(!tough.dead);
  assert.equal(log.sparks, 1);
  assert.equal(log.sounds.at(-1), 'clang');
  for (let i = 1; i < hp; i++) sets.hitRock(tough, 0, 0, env);
  assert.ok(tough.dead, `it gives way after ${hp} shots`);
  assert.equal(log.score, PEBBLE_POINTS + ROCK_POINTS);

  sets.breakRock(tough, env);
  assert.equal(log.score, PEBBLE_POINTS + ROCK_POINTS, 'a rock cannot be broken twice');
});

test('a blast clears the little rocks on screen and leaves the tough ones', () => {
  const { sets, env, log } = toField(3);
  // Fly on until rocks of both kinds are on screen.
  for (let i = 0; i < 600 && !(sets.near.some((r) => r.tough) && sets.near.some((r) => !r.tough)); i++) run(sets, env, DT);
  const little = sets.near.filter((r) => !r.tough).length;
  const tough = sets.near.filter((r) => r.tough).length;
  assert.ok(little > 0 && tough > 0);
  sets.blast(env);
  assert.equal(log.score, little * PEBBLE_POINTS);
  assert.equal(sets.near.filter((r) => !r.dead).length, tough);
});

test('rocks are found where they are drawn', () => {
  const { sets, env } = toField();
  for (let i = 0; i < 600 && !sets.near.length; i++) run(sets, env, DT);
  const rock = sets.near[0]!;
  const y = sets.field!.front - rock.d;
  assert.equal(sets.rockAt(rock.x, y), rock);
  assert.equal(sets.rockTouching(rock.x, y + rock.r * 0.9 + 8, 9), rock, 'a ship just under it is touching it');
  assert.equal(sets.rockAt(rock.x, y + rock.r + 400), null);
  rock.dead = true;
  assert.equal(sets.rockAt(rock.x, y), null, 'a broken rock is not there any more');
});

test('once the game is over, set pieces leave quietly and pay nothing', () => {
  const { env: env2, log: log2 } = makeEnv();
  const withTanker = new SetPieces();
  withTanker.plan([{ at: 0, kind: 'fuel' }]);
  withTanker.advance(0, DT);
  run(withTanker, env2, 1);
  assert.ok(withTanker.tanker);

  env2.playing = false;
  withTanker.stop();
  assert.deepEqual(withTanker.stops, []);
  for (let t = 0; t < 30 && withTanker.tanker; t += DT) withTanker.coast(DT, DT, env2);
  assert.equal(withTanker.tanker, null, 'the fuel ship flies off');
  assert.equal(log2.score, 0);
  assert.equal(log2.energy, 0);

  // A field that was falling when the ship was lost carries on down the screen, for nothing.
  const { sets: falling, env: env3, log: log3 } = toField();
  env3.playing = false;
  falling.stop();
  for (let t = 0; t < 120 && falling.field; t += DT) falling.coast(DT, DT, env3);
  assert.equal(falling.field, null);
  assert.equal(log3.score, 0);
});
