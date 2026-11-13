import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COOP_WORLD_W,
  ENEMY_KIND_TABLE,
  SNAP_MAX_BROKEN_ROCKS,
  SNAP_MAX_ENEMIES,
  SNAP_MAX_FX,
  SNAP_MAX_ITEMS,
  SNAP_MAX_SHIPS,
  SNAP_MAX_SHOTS,
  SNAP_PROTOCOL_VERSION,
  SnapshotInterpolator,
  decodeGuestInput,
  decodeUpgradesMask,
  decodeWorldSnapshot,
  encodeGuestInput,
  encodeUpgradesMask,
  encodeWorldSnapshot,
  formatBossMathQuestion,
  getSnapshotVersionMismatch,
  isSnapshotVersionMismatch,
  packBrokenRockWords,
  parseBossMathQuestion,
  unpackBrokenRockWords,
  type CoopSnapFx,
  type CoopWorldSnapshot,
} from '../src/game/coop-protocol';
import { BIN_FRAME_INPUT, BIN_FRAME_SNAP, COOP_PROTOCOL_VERSION, MAX_BINARY_BYTES } from '../src/game/coop-types';
import { NEON, SAND } from '../src/game/core';

test('BIN_FRAME_INPUT packs to 8 bytes, round-trips sub-pixel targets and flags, and rejects bad frames', () => {
  const bytes = encodeGuestInput({
    seat: 2,
    targetX: 384.25,
    targetY: 812.5,
    firing: true,
    hasPointer: true,
    left: false,
    right: true,
    up: true,
    down: false,
    tap: true,
    seq: 254,
  });
  assert.equal(bytes.byteLength, 8);
  assert.equal(bytes[0], BIN_FRAME_INPUT);

  const out = decodeGuestInput(bytes);
  assert.ok(out);
  assert.equal(out.seat, 2);
  assert.equal(out.targetX, 384.25);
  assert.equal(out.targetY, 812.5);
  assert.equal(out.firing, true);
  assert.equal(out.hasPointer, true);
  assert.equal(out.left, false);
  assert.equal(out.right, true);
  assert.equal(out.up, true);
  assert.equal(out.down, false);
  assert.equal(out.tap, true);
  assert.equal(out.seq, 254);

  assert.equal(decodeGuestInput(bytes.subarray(0, 7)), null);
  assert.equal(decodeGuestInput(new Uint8Array(9)), null);
  const badSeat = new Uint8Array(bytes);
  badSeat[1] = 4;
  assert.equal(decodeGuestInput(badSeat), null);
});

test('BIN_FRAME_SNAP round-trips full world state, keeps saturated size < MAX_BINARY_BYTES, and survives truncation', () => {
  const parsed = parseBossMathQuestion('24 × 3');
  assert.deepEqual(parsed, { a: 24, b: 3, op: '×' });
  assert.equal(formatBossMathQuestion(parsed.a, parsed.op, parsed.b), '24 × 3');

  const typical: CoopWorldSnapshot = {
    tick: 1024,
    wave: 3,
    banner: 1.4,
    teamScore: 18450,
    freed: 42,
    energy: 0.75,
    paused: false,
    parked: false,
    gameOver: false,
    ships: [0, 1, 2, 3].map((seat) => ({
      seat: seat as 0 | 1 | 2 | 3,
      connected: true,
      alive: seat !== 3,
      hull: seat === 3 ? 0 : 3,
      maxHull: 4,
      invulnerable: seat === 1,
      shielded: seat === 0,
      firing: true,
      spread: seat === 0,
      wing: seat === 2,
      orbitUpgrade: seat === 1,
      x: 160 + seat * 140.5,
      y: 860.25,
      lean: -0.35,
      orbit: 1.5,
      ackSeq: 77 + seat,
      respawnSec: seat === 3 ? 3.5 : 0,
    })),
    enemies: Array.from({ length: 10 }, (_, i) => ({
      id: 500 + i,
      kind: ENEMY_KIND_TABLE[i % ENEMY_KIND_TABLE.length]!,
      color: i % 2 === 0 ? NEON.violet : NEON.cyan,
      hp: 3,
      flash: i === 2,
      rot: 0.8,
      x: 90 + i * 62,
      y: 180 + i * 24,
    })),
    boss: {
      kind: 'sum',
      state: 'fight',
      open: true,
      flash: false,
      clang: true,
      rage: false,
      hp: 45,
      maxHp: 90,
      x: COOP_WORLD_W / 2,
      y: 210,
      age: 12.5,
      openTime: 4.2,
      arms: [],
      mathA: parsed.a,
      mathB: parsed.b,
      mathOp: parsed.op,
      pods: [
        { value: 72, hits: 2, right: true, flash: true },
        { value: 68, hits: 0, right: false, flash: false },
        { value: 81, hits: 1, right: false, flash: false },
      ],
    },
    tanker: null,
    field: null,
    shots: Array.from({ length: 12 }, (_, i) => ({
      kind: i === 11 ? 'beam' : i % 3 === 0 ? 'enemy' : 'bolt',
      color: i % 3 === 0 ? NEON.orange : NEON.cyan,
      heavy: i === 0,
      x: 200 + i * 32,
      y: 500 - i * 20,
      vx: i % 2 === 0 ? 0 : -64,
      vy: i % 3 === 0 ? 256 : -640,
      beamLife: i === 11 ? 0.8 : 0,
    })),
    items: [
      { kind: 'upgrade', age: 2.1, x: 384, y: 420 },
      { kind: 'bomb', age: 1.0, x: 220, y: 310 },
    ],
    fx: [
      {
        seq: 11,
        kind: 'enemy-burst',
        enemyKind: 'saucer',
        color: NEON.violet,
        toughRock: false,
        x: 312,
        y: 280,
      },
      {
        seq: 12,
        kind: 'spark',
        enemyKind: 'drifter',
        color: SAND,
        toughRock: false,
        x: 384,
        y: 210,
      },
    ],
  };

  const typicalBytes = encodeWorldSnapshot(typical);
  assert.equal(typicalBytes[0], BIN_FRAME_SNAP);
  assert.ok(
    typicalBytes.byteLength < 400,
    `typical 4-pilot snapshot is compact (${typicalBytes.byteLength} B < 400 B)`,
  );

  const decoded = decodeWorldSnapshot(typicalBytes);
  assert.ok(decoded);
  assert.equal(decoded.tick, 1024);
  assert.equal(decoded.wave, 3);
  assert.equal(decoded.teamScore, 18450);
  assert.equal(decoded.freed, 42);
  assert.equal(decoded.ships.length, 4);
  assert.equal(decoded.ships[0]!.x, 160);
  assert.equal(decoded.ships[0]!.shielded, true);
  assert.equal(decoded.ships[3]!.alive, false);
  assert.equal(decoded.ships[3]!.respawnSec, 3.5);
  assert.equal(decoded.enemies.length, 10);
  assert.equal(decoded.enemies[2]!.id, 502);
  assert.equal(decoded.enemies[2]!.flash, true);
  assert.ok(decoded.boss);
  assert.equal(decoded.boss.kind, 'sum');
  assert.equal(
    formatBossMathQuestion(decoded.boss.mathA, decoded.boss.mathOp, decoded.boss.mathB),
    '24 × 3',
  );
  assert.equal(decoded.boss.pods[0]!.value, 72);
  assert.equal(decoded.boss.pods[0]!.right, true);
  assert.equal(decoded.shots[11]!.kind, 'beam');
  assert.ok(Math.abs(decoded.shots[11]!.beamLife - 0.8) < 0.02);
  assert.equal(decoded.items[0]!.kind, 'upgrade');
  assert.equal(decoded.fx[0]!.kind, 'enemy-burst');
  assert.equal(decoded.fx[0]!.enemyKind, 'saucer');

  // Every possible prefix truncation returns null without throwing
  for (let cut = 0; cut < typicalBytes.byteLength; cut++) {
    assert.equal(decodeWorldSnapshot(typicalBytes.subarray(0, cut)), null);
  }

  // Absolute worst-case saturated snapshot (every single array maxed out simultaneously)
  const saturated: CoopWorldSnapshot = {
    ...typical,
    ships: typical.ships.slice(0, SNAP_MAX_SHIPS),
    enemies: Array.from({ length: SNAP_MAX_ENEMIES }, (_, i) => ({
      id: i + 1,
      kind: 'hex',
      color: NEON.yellow,
      hp: 6,
      flash: false,
      rot: 1.2,
      x: 100 + (i % 8) * 70,
      y: 120 + Math.floor(i / 8) * 60,
    })),
    boss: {
      kind: 'arms',
      state: 'fight',
      open: false,
      flash: true,
      clang: false,
      rage: true,
      hp: 120,
      maxHp: 150,
      x: 384,
      y: 200,
      age: 20,
      openTime: 0,
      arms: Array.from({ length: 4 }, (_, i) => ({
        dx: -90 + i * 60,
        dy: 32,
        hp: 10,
        maxHp: 14,
        flash: i === 1,
      })),
      mathA: 0,
      mathB: 0,
      mathOp: '+',
      pods: [],
    },
    tanker: {
      state: 'fly',
      hooked: true,
      hookedSeat: 2,
      fuel: 0.6,
      strain: 0.25,
      x: 384,
      y: 260,
      drogueX: 390,
      drogueY: 420,
    },
    field: {
      seed: 0xdeadbeef,
      front: 640,
      alert: 5.2,
      wave: 4,
      recentBrokenIds: Array.from({ length: SNAP_MAX_BROKEN_ROCKS }, (_, i) => 10 + i),
    },
    shots: Array.from({ length: SNAP_MAX_SHOTS }, (_, i) => ({
      kind: 'bolt',
      color: NEON.cyan,
      heavy: false,
      x: 40 + (i % 10) * 68,
      y: 300 + i * 8,
      vx: 0,
      vy: -640,
      beamLife: 0,
    })),
    items: Array.from({ length: SNAP_MAX_ITEMS }, (_, i) => ({
      kind: 'boost',
      age: 1.5,
      x: 100 + i * 35,
      y: 400,
    })),
    fx: Array.from({ length: SNAP_MAX_FX }, (_, i) => ({
      seq: i,
      kind: 'rock-break',
      enemyKind: 'drifter',
      color: NEON.cyan,
      toughRock: i % 2 === 0,
      x: 200 + i * 20,
      y: 500,
    })),
  };

  const satBytes = encodeWorldSnapshot(saturated);
  assert.ok(
    satBytes.byteLength < MAX_BINARY_BYTES,
    `saturated snapshot (${satBytes.byteLength} B) stays strictly under MAX_BINARY_BYTES (${MAX_BINARY_BYTES} B)`,
  );
  const satDecoded = decodeWorldSnapshot(satBytes);
  assert.ok(satDecoded);
  assert.equal(satDecoded.boss?.kind, 'arms');
  assert.equal(satDecoded.boss?.arms.length, 4);
  assert.equal(satDecoded.tanker?.hookedSeat, 2);
  assert.equal(satDecoded.field?.seed, 0xdeadbeef);
  assert.equal(satDecoded.field?.recentBrokenIds.length, SNAP_MAX_BROKEN_ROCKS);
});

test('SnapshotInterpolator smoothly lerps by seat/enemy ID at 60fps under jitter + loss and deduplicates FX', () => {
  const interp = new SnapshotInterpolator({ interpDelayMs: 65, maxExtrapolateMs: 80 });
  const hostPeriodMs = 1000 / 18;
  let fxCounter = 250; // starts near 255 to exercise u8 wraparound!

  const makeSnap = (tick: number, tSec: number): CoopWorldSnapshot => {
    const fx = [];
    // Include rolling last 3 FX entries so dropped snapshots still deliver explosions once
    for (let k = Math.max(0, tick - 2); k <= tick; k++) {
      fx.push({
        seq: (fxCounter + k) & 0xff,
        kind: 'spark' as const,
        enemyKind: 'drifter' as const,
        color: NEON.cyan,
        toughRock: false,
        x: 300,
        y: 300,
      });
    }
    // At tick 5, enemy id=10 dies so enemy id=20 shifts from index 1 -> index 0!
    const enemies = [];
    if (tick < 5) {
      enemies.push({
        id: 10,
        kind: 'drifter' as const,
        color: NEON.violet,
        hp: 1,
        flash: false,
        rot: 0,
        x: 100,
        y: 200 + tSec * 120,
      });
    }
    enemies.push({
      id: 20,
      kind: 'saucer' as const,
      color: NEON.lime,
      hp: 3,
      flash: false,
      rot: 0.5,
      x: 500,
      y: 150 + tSec * 180,
    });

    return {
      tick,
      wave: 1,
      banner: 0,
      teamScore: tick * 10,
      freed: 0,
      energy: 0.5,
      paused: false,
      parked: false,
      gameOver: false,
      ships: [
        {
          seat: 0,
          connected: true,
          alive: true,
          hull: 3,
          maxHull: 3,
          invulnerable: false,
          shielded: false,
          firing: true,
          spread: false,
          wing: false,
          orbitUpgrade: false,
          x: 200 + tSec * 200,
          y: 860,
          lean: 0.4,
          orbit: tSec * 2,
          ackSeq: tick,
          respawnSec: 0,
        },
      ],
      enemies,
      boss: null,
      tanker: null,
      field: null,
      shots: [],
      items: [],
      fx,
    };
  };

  // Simulate 20 Host snapshots (~1.1s) with 60ms latency, +-8ms jitter, and a dropped packet at tick=7
  const arrivals: Array<{ at: number; snap: CoopWorldSnapshot }> = [];
  for (let tick = 0; tick < 20; tick++) {
    if (tick === 7) continue; // simulated packet drop!
    const sentAt = tick * hostPeriodMs;
    const jitter = ((tick * 37) % 17) - 8;
    arrivals.push({
      at: sentAt + 60 + jitter,
      snap: makeSnap(tick, sentAt / 1000),
    });
  }

  let arrivalIdx = 0;
  let prevShipX: number | null = null;
  let prevSaucerY: number | null = null;
  const seenFxSeqs: number[] = [];

  for (let frame = 0; frame < 60; frame++) {
    const nowMs = 130 + frame * (1000 / 60);
    while (arrivalIdx < arrivals.length && arrivals[arrivalIdx]!.at <= nowMs) {
      interp.push(arrivals[arrivalIdx]!.snap, arrivals[arrivalIdx]!.at);
      arrivalIdx++;
    }
    for (const ev of interp.consumeNewFx()) {
      seenFxSeqs.push(ev.seq);
    }

    const sampled = interp.sample(nowMs);
    assert.ok(sampled);
    const shipX = sampled.ships[0]!.x;
    const saucer = sampled.enemies.find((e) => e.id === 20)!;
    assert.ok(saucer, 'enemy id=20 stays tracked across array shift when id=10 dies');

    if (prevShipX !== null && prevSaucerY !== null) {
      const dx = shipX - prevShipX;
      const dy = saucer.y - prevSaucerY;
      assert.ok(dx >= -0.01 && dx < 12, `smooth monotonic ship X step at 60fps (dx=${dx.toFixed(2)})`);
      assert.ok(dy >= -0.01 && dy < 12, `smooth monotonic enemy Y step across array shift & drop (dy=${dy.toFixed(2)})`);
    }
    prevShipX = shipX;
    prevSaucerY = saucer.y;
  }

  // Consume remaining arrivals and verify FX deduplication across wraparound (250..255, 0..13) and tick=7 drop
  while (arrivalIdx < arrivals.length) {
    interp.push(arrivals[arrivalIdx]!.snap, arrivals[arrivalIdx]!.at);
    arrivalIdx++;
    for (const ev of interp.consumeNewFx()) seenFxSeqs.push(ev.seq);
  }

  const expectedSeqs = Array.from({ length: 20 }, (_, k) => (fxCounter + k) & 0xff);
  assert.deepEqual(
    seenFxSeqs,
    expectedSeqs,
    'every FX event (including dropped tick=7 recovered from tick=8) plays once in exact order across u8 wrap',
  );
});

test('encodeWorldSnapshot prioritizes enemy bullets, beams, and rockets over older bolts and packs 80+ broken rocks', () => {
  const upgradesMask = encodeUpgradesMask(['rapid', 'wide', 'pierce', 'wingmates', 'guardian', 'nova']);
  assert.deepEqual(decodeUpgradesMask(upgradesMask), ['rapid', 'wide', 'wingmates', 'pierce', 'guardian', 'nova']);

  const brokenIds = Array.from({ length: 85 }, (_, i) => i * 5); // up to id=420
  assert.deepEqual(unpackBrokenRockWords(packBrokenRockWords(brokenIds)), brokenIds);

  const boltShots = Array.from({ length: 100 }, (_, i) => ({
    kind: 'bolt' as const,
    color: NEON.cyan,
    heavy: false,
    x: 100 + (i % 50) * 10,
    y: 900 - i * 4,
    vx: 0,
    vy: -640,
    beamLife: 0,
  }));
  const enemyShots = Array.from({ length: 14 }, (_, i) => ({
    kind: 'enemy' as const,
    color: NEON.orange,
    heavy: false,
    x: 80 + i * 40,
    y: 300 + i * 10,
    vx: 0,
    vy: 260,
    beamLife: 0,
  }));
  const specialShots = [
    { kind: 'beam' as const, color: NEON.yellow, heavy: false, x: 384, y: 800, vx: 0, vy: 0, beamLife: 0.7 },
    { kind: 'rocket' as const, color: NEON.orange, heavy: true, x: 240, y: 620, vx: -80, vy: -520, beamLife: 0 },
    { kind: 'rocket' as const, color: NEON.orange, heavy: true, x: 520, y: 620, vx: 80, vy: -520, beamLife: 0 },
  ];

  const snap: CoopWorldSnapshot = {
    session: 142,
    tick: 42,
    hostElapsedMs: 2333,
    upgradesMask,
    wave: 4,
    banner: 0,
    teamScore: 9900,
    freed: 18,
    energy: 0.5,
    paused: false,
    parked: false,
    gameOver: false,
    ships: [],
    enemies: [],
    boss: null,
    tanker: null,
    field: {
      seed: 0x1234abcd,
      front: 720,
      alert: null,
      wave: 4,
      recentBrokenIds: brokenIds,
    },
    // Oldest 100 bolts first, enemy bullets + beams/rockets appended at the tail (just like world.shots)
    shots: [...boltShots, ...enemyShots, ...specialShots],
    items: [],
    fx: [],
  };

  const decoded = decodeWorldSnapshot(encodeWorldSnapshot(snap));
  assert.ok(decoded);
  assert.equal(decoded.session, 142);
  assert.equal(decoded.hostElapsedMs, 2333);
  assert.equal(decoded.upgradesMask, upgradesMask);
  assert.deepEqual(decoded.field?.recentBrokenIds, brokenIds);
  assert.equal(decoded.shots.length, SNAP_MAX_SHOTS);
  assert.equal(decoded.shots.filter((s) => s.kind === 'enemy').length, 14);
  assert.equal(decoded.shots.filter((s) => s.kind === 'beam').length, 1);
  assert.equal(decoded.shots.filter((s) => s.kind === 'rocket').length, 2);
  // Remaining 35 bolt slots keep the NEWEST bolts (y around 900 - 99*4 = 504), not the oldest!
  const decodedBolts = decoded.shots.filter((s) => s.kind === 'bolt');
  assert.equal(decodedBolts.length, SNAP_MAX_SHOTS - 17);
  assert.equal(decodedBolts[decodedBolts.length - 1]!.y, 900 - 99 * 4);
});

test('SnapshotInterpolator recovers on the very first frame after Host page reload while still rejecting stale reorders', () => {
  const period = 1000 / 18;
  const makeWireSnap = (tick: number, x: number, session?: number): CoopWorldSnapshot =>
    decodeWorldSnapshot(
      encodeWorldSnapshot({
        session,
        tick: tick & 0xffff,
        wave: 2,
        banner: 0,
        teamScore: 0,
        freed: 0,
        energy: 0.5,
        paused: false,
        parked: false,
        gameOver: false,
        ships: [],
        enemies: [{ id: 7, kind: 'dart', color: '#ffffff', hp: 1, flash: false, rot: 0, x, y: 300 }],
        boss: null,
        tanker: null,
        field: null,
        shots: [],
        items: [],
        fx: [],
      }),
    )!;

  // Duplicate and out-of-order older packets within reorder window are still rejected
  const reorderIt = new SnapshotInterpolator();
  assert.equal(reorderIt.push(makeWireSnap(10, 100, 7), 0), true);
  assert.equal(reorderIt.push(makeWireSnap(11, 110, 7), 55), true);
  assert.equal(reorderIt.push(makeWireSnap(11, 999, 7), 60), false);
  assert.equal(reorderIt.push(makeWireSnap(9, 999, 7), 61), false);
  assert.equal(reorderIt.latest()!.enemies[0]!.x, 110);

  // Host reload from any prior tick (including without session byte AND with session byte) accepts k=1 immediately
  for (const oldTick of [500, 6000, 21600, 32000, 40000]) {
    const it = new SnapshotInterpolator();
    let now = 0;
    for (let k = oldTick - 10; k <= oldTick; k++) {
      it.push(makeWireSnap(k, 200), now);
      now += period;
    }
    now += 8000;
    assert.equal(it.push(makeWireSnap(1, 500), now), true, `oldTick=${oldTick} accepts tick=1 immediately`);
    assert.equal(it.latest()!.enemies[0]!.x, 500);
    assert.equal(it.sample(now + 1)!.enemies[0]!.x, 500);
  }

  // Session change even at low tick (e.g. tick 5 -> tick 1 within < 500ms) resets immediately
  const sessIt = new SnapshotInterpolator();
  sessIt.push(makeWireSnap(5, 200, 11), 100);
  assert.equal(sessIt.push(makeWireSnap(1, 520, 99), 300), true);
  assert.equal(sessIt.latest()!.enemies[0]!.x, 520);
});

test('SnapshotInterpolator rides out 250ms network stalls without snap-jumps and plays FX after 200/256-FX gaps', () => {
  const period = 1000 / 18;
  const speed = 240;
  const it = new SnapshotInterpolator();

  // Deterministic pseudo-RNG for 60+-40ms delay + 250ms stall every 3s
  let seed = 99;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const arrivals: Array<{ atMs: number; snap: CoopWorldSnapshot }> = [];
  let acc = 0;
  let tick = 0;
  let lastArr = 0;
  let nextStall = 3.0;
  for (let f = 1; f <= 60 * 25; f++) {
    const hostSec = f / 60;
    acc += 1 / 60;
    if (acc >= 1 / 18) {
      acc -= 1 / 18;
      tick++;
      let at = hostSec + 0.02 + rand() * 0.08;
      if (hostSec >= nextStall && hostSec < nextStall + 0.25) {
        at = Math.max(at, nextStall + 0.25 + 0.06);
      }
      if (hostSec >= nextStall + 0.25) nextStall += 3.0;
      at = Math.max(at, lastArr + 0.0005);
      lastArr = at;
      const x = 60 + ((hostSec * speed) % 600);
      arrivals.push({
        atMs: at * 1000,
        snap: decodeWorldSnapshot(
          encodeWorldSnapshot({
            session: 3,
            tick,
            hostElapsedMs: Math.round(hostSec * 1000),
            wave: 2,
            banner: 0,
            teamScore: 0,
            freed: 0,
            energy: 0.5,
            paused: false,
            parked: false,
            gameOver: false,
            ships: [],
            enemies: [{ id: 7, kind: 'dart', color: '#ffffff', hp: 1, flash: false, rot: 0, x, y: 300 }],
            boss: null,
            tanker: null,
            field: null,
            shots: [],
            items: [],
            fx: [],
          }),
        )!,
      });
    }
  }

  let ai = 0;
  let prevX: number | null = null;
  let jumps = 0;
  for (let f = 0; f < 60 * 22; f++) {
    const nowMs = 1500 + f * (1000 / 60);
    while (ai < arrivals.length && arrivals[ai]!.atMs <= nowMs) {
      it.push(arrivals[ai]!.snap, arrivals[ai]!.atMs);
      ai++;
    }
    const sampled = it.sample(nowMs);
    if (!sampled) continue;
    const x = sampled.enemies[0]!.x;
    if (prevX !== null) {
      const d = x - prevX;
      if (d > -100 && (d > 12 || d < -0.5)) {
        jumps++;
      }
    }
    prevX = x;
  }
  assert.equal(jumps, 0, 'zero snap-jumps (>12px) or backward steps across 250ms stalls');

  // FX dedupe after 200-FX and 256-FX gaps
  const fxAt = (s: number): CoopSnapFx => ({
    seq: s & 0xff,
    kind: 'enemy-burst',
    color: '#ffffff',
    enemyKind: 'dart',
    toughRock: false,
    x: 100,
    y: 100,
  });
  const fxSnap = (t: number, fxs: CoopSnapFx[]): CoopWorldSnapshot =>
    decodeWorldSnapshot(
      encodeWorldSnapshot({
        tick: t & 0xffff,
        wave: 1,
        banner: 0,
        teamScore: 0,
        freed: 0,
        energy: 0.5,
        paused: false,
        parked: false,
        gameOver: false,
        ships: [],
        enemies: [],
        boss: null,
        tanker: null,
        field: null,
        shots: [],
        items: [],
        fx: fxs,
      }),
    )!;

  const fxIt = new SnapshotInterpolator();
  let seq = 0;
  for (let k = 1; k <= 10; k++) {
    seq++;
    fxIt.push(fxSnap(k, [fxAt(seq)]), k * period);
  }
  fxIt.consumeNewFx();
  seq += 200; // 200 missed FX during Wi-Fi drop
  let played = 0;
  for (let k = 0; k < 40; k++) {
    seq++;
    fxIt.push(fxSnap(200 + k, [fxAt(seq)]), (200 + k) * period);
    played += fxIt.consumeNewFx().length;
  }
  assert.equal(played, 40, 'all 40 FX after a 200-FX gap play cleanly');

  const fxIt256 = new SnapshotInterpolator();
  fxIt256.push(fxSnap(1, [fxAt(10)]), 0);
  fxIt256.consumeNewFx();
  fxIt256.push(fxSnap(500, [fxAt(10 + 256)]), 30000);
  assert.equal(fxIt256.consumeNewFx().length, 1, 'exact 256-FX wrap across gap still plays next FX');
});

test('Round 13 (4.3), Round 15 (5.12): snapshot protocol version 3 rejects other versions and names which side is out of date', () => {
  assert.equal(COOP_PROTOCOL_VERSION, 3);
  assert.equal(SNAP_PROTOCOL_VERSION, 3);

  const valid = encodeWorldSnapshot({
    session: 9,
    tick: 1,
    hostElapsedMs: 100,
    wave: 1,
    banner: 0,
    teamScore: 0,
    freed: 0,
    energy: 0.5,
    paused: false,
    parked: false,
    gameOver: false,
    ships: [],
    enemies: [],
    boss: null,
    tanker: null,
    field: null,
    shots: [],
    items: [],
    fx: [],
  });
  assert.equal(valid.byteLength, 26, 'minimum v3 snapshot header is 26 bytes');
  // A version 2 page reads the two version bits, sees 3 instead of its own 2, and asks its player to refresh.
  assert.equal(valid[1]! & 0x03, 3, 'the two old version bits hold 3, meaning "the version is in the next byte"');
  assert.equal(valid[2], 3, 'the version byte holds 3');
  assert.equal(isSnapshotVersionMismatch(valid), false);
  assert.ok(decodeWorldSnapshot(valid));

  // Frames from version 1 and 2 hosts keep the version in the two bits.
  for (const oldVer of [1, 2]) {
    const mutated = new Uint8Array(valid);
    mutated[1] = (mutated[1]! & ~0x03) | oldVer;
    assert.equal(decodeWorldSnapshot(mutated), null, `version ${oldVer} is rejected by decoder`);
    assert.equal(isSnapshotVersionMismatch(mutated), true, `version ${oldVer} is flagged as version mismatch`);
    assert.equal(getSnapshotVersionMismatch(mutated), 'older', `version ${oldVer} is older`);
  }
  // Later versions keep 3 in the bits and change the version byte.
  const future = new Uint8Array(valid);
  future[2] = 4;
  assert.equal(decodeWorldSnapshot(future), null, 'version 4 is rejected by decoder');
  assert.equal(getSnapshotVersionMismatch(future), 'newer', 'version 4 is newer');
  assert.equal(getSnapshotVersionMismatch(valid), null);
  const v0Mutated = new Uint8Array(valid);
  v0Mutated[1] = v0Mutated[1]! & ~0x03;
  assert.equal(decodeWorldSnapshot(v0Mutated), null, 'version 0 is rejected by decoder');
  assert.equal(isSnapshotVersionMismatch(v0Mutated), false, 'zeroed version bits do not false-trigger mismatch');

  // Non-snapshot frames and 1-byte truncated frames are never misclassified as version mismatch
  assert.equal(isSnapshotVersionMismatch(new Uint8Array([BIN_FRAME_SNAP])), false);
  const inputBytes = encodeGuestInput({
    seat: 1,
    targetX: 200,
    targetY: 500,
    firing: false,
    hasPointer: false,
    left: false,
    right: false,
    up: false,
    down: false,
    tap: false,
    seq: 1,
  });
  assert.equal(isSnapshotVersionMismatch(inputBytes), false);
});

test('Round 13 (4.1, 4.4, Sec 5): straight shots extrapolate to present, extrapolation turns smooth out, and pauses/stalls never replay FX', () => {
  const period = 1000 / 18;

  // 1. 4.1: Enemy bullets extrapolate forward to Host present (~85ms ahead of interpolated entities)
  const bulletIt = new SnapshotInterpolator();
  let nextTick = 0;
  let sampled: CoopWorldSnapshot | null = null;
  for (let wallMs = 0; wallMs <= 3600; wallMs += 1000 / 60) {
    while (nextTick * period + 10 <= wallMs) {
      const hostMs = nextTick * period;
      nextTick++;
      const snap = decodeWorldSnapshot(
        encodeWorldSnapshot({
          session: 5,
          tick: nextTick,
          hostElapsedMs: Math.round(hostMs),
          wave: 1,
          banner: 0,
          teamScore: 0,
          freed: 0,
          energy: 0.5,
          paused: false,
          parked: false,
          gameOver: false,
          ships: [],
          enemies: [{ id: 1, kind: 'dart', color: '#ffffff', hp: 1, flash: false, rot: 0, x: 300, y: 80 + hostMs * 0.2 }],
          boss: null,
          tanker: null,
          field: null,
          shots: [{ kind: 'enemy', color: '#ff3366', x: 300, y: 80 + hostMs * 0.2, vx: 0, vy: 200, heavy: false, beamLife: 0 }],
          items: [],
          fx: [],
        }),
      )!;
      bulletIt.push(snap, hostMs + 10);
    }
    sampled = bulletIt.sample(wallMs);
  }
  const latestShotY = bulletIt.latest()!.shots[0]!.y;
  const enemyY = sampled!.enemies[0]!.y;
  const shotY = sampled!.shots[0]!.y;
  assert.ok(shotY > latestShotY + 2, `shot extrapolated forward past newest snapshot to Host present (${shotY} vs ${latestShotY})`);
  assert.ok(shotY - enemyY >= 10 && shotY - enemyY <= 20, `expected shot extrapolated ahead of interp enemy, got ${shotY - enemyY}`);

  // 2. 4.4: Direction reversal during an extrapolation stall blends smoothly (< 12px/frame instead of a 30px snap)
  const turnIt = new SnapshotInterpolator();
  const shipSnap = (tick: number, hostMs: number, x: number): CoopWorldSnapshot =>
    decodeWorldSnapshot(
      encodeWorldSnapshot({
        session: 6,
        tick,
        hostElapsedMs: Math.round(hostMs),
        wave: 1,
        banner: 0,
        teamScore: 0,
        freed: 0,
        energy: 0.5,
        paused: false,
        parked: false,
        gameOver: false,
        ships: [
          {
            seat: 0,
            hull: 3,
            maxHull: 3,
            connected: true,
            alive: true,
            invulnerable: false,
            shielded: false,
            firing: false,
            spread: false,
            wing: false,
            orbitUpgrade: false,
            x,
            y: 800,
            lean: 0,
            orbit: 0,
            ackSeq: 0,
            respawnSec: 0,
          },
        ],
        enemies: [],
        boss: null,
        tanker: null,
        field: null,
        shots: [],
        items: [],
        fx: [],
      }),
    )!;

  // Ship moves right at +380 px/s for ticks 1..6, then reverses left at -380 px/s while tick 7 is delayed 180ms
  const turnX = (ms: number) => (ms <= 300 ? 300 + (ms / 1000) * 380 : 300 + 0.3 * 380 - ((ms - 300) / 1000) * 380);
  let maxSingleFrameStep = 0;
  let lastX: number | null = null;
  const scheduled: Array<{ arrMs: number; snap: CoopWorldSnapshot }> = [];
  for (let k = 1; k <= 14; k++) {
    const hMs = k * 50;
    const stall = k === 7 || k === 8 ? 170 : 0;
    scheduled.push({ arrMs: hMs + 10 + stall, snap: shipSnap(k, hMs, turnX(hMs)) });
  }
  scheduled.sort((a, b) => a.arrMs - b.arrMs);
  let si = 0;
  for (let wall = 60; wall <= 750; wall += 1000 / 60) {
    while (si < scheduled.length && scheduled[si]!.arrMs <= wall) {
      turnIt.push(scheduled[si]!.snap, scheduled[si]!.arrMs);
      si++;
    }
    const s = turnIt.sample(wall);
    if (!s || s.ships.length === 0) continue;
    const x = s.ships[0]!.x;
    if (lastX !== null) {
      maxSingleFrameStep = Math.max(maxSingleFrameStep, Math.abs(x - lastX));
    }
    lastX = x;
  }
  assert.ok(maxSingleFrameStep < 12, `post-extrapolation turn blended smoothly: max step=${maxSingleFrameStep.toFixed(2)}px (< 12px)`);

  // 3. Section 5: 600ms wall-clock stalls and 3s Host pauses never replay FX ring entries and resume smoothly
  const pauseIt = new SnapshotInterpolator();
  const ring: CoopSnapFx[] = [];
  let fxSeq = 0;
  let recorded = 0;
  let consumed = 0;
  let hostSimMs = 0;
  let wallMs = 0;
  let tick = 0;
  let maxResumeStep = 0;
  let prevEnemyX: number | null = null;

  for (let step = 0; step < 90; step++) {
    const paused = step >= 30 && step < 50;
    const stallMs = step === 15 ? 600 : paused && step === 30 ? 3000 : Math.round(period);
    wallMs += stallMs;
    if (!paused) {
      hostSimMs += period;
      tick++;
      fxSeq = (fxSeq + 1) & 0xff;
      ring.push({
        seq: fxSeq,
        kind: 'enemy-burst',
        color: '#ffffff',
        enemyKind: 'dart',
        toughRock: false,
        x: 200,
        y: 200,
      });
      while (ring.length > 6) ring.shift();
      recorded++;
    } else {
      tick++;
    }
    const snap = decodeWorldSnapshot(
      encodeWorldSnapshot({
        session: 12,
        tick,
        hostElapsedMs: Math.round(hostSimMs),
        wave: 1,
        banner: 0,
        teamScore: 0,
        freed: 0,
        energy: 0.5,
        paused,
        parked: false,
        gameOver: false,
        ships: [],
        enemies: [{ id: 3, kind: 'dart', color: '#ffffff', hp: 1, flash: false, rot: 0, x: 80 + hostSimMs * 0.24, y: 260 }],
        boss: null,
        tanker: null,
        field: null,
        shots: [],
        items: [],
        fx: ring,
      }),
    )!;
    pauseIt.push(snap, wallMs);
    consumed += pauseIt.consumeNewFx().length;
    for (let sub = 0; sub < 3; sub++) {
      const s = pauseIt.sample(wallMs + sub * (1000 / 60));
      if (s && s.enemies.length > 0) {
        const ex = s.enemies[0]!.x;
        if (prevEnemyX !== null && step >= 50 && step <= 60) {
          maxResumeStep = Math.max(maxResumeStep, Math.abs(ex - prevEnemyX));
        }
        prevEnemyX = ex;
      }
    }
  }
  assert.equal(consumed, recorded, `zero duplicate or dropped FX across 600ms stall + 3s pause (${consumed} vs ${recorded})`);
  assert.ok(maxResumeStep < 8.5, `post-unpause enemy step stays smooth: max=${maxResumeStep.toFixed(2)}px`);
});

test('Round 15 follow-up (b2 15): after a long host frame, the bullet lead floor follows the newest snapshots, not the slow arrival clock', () => {
  // Host and guest clocks run together; snapshots go out every 55 ms and take 50 ms to arrive; the guest's inputs
  // take 60 ms to be used. At 2.0 s the host has one 300 ms frame that it runs as 50 ms: its clock falls 250 ms behind.
  const it = new SnapshotInterpolator();
  const snapAt = (tick: number, hostMs: number): CoopWorldSnapshot => ({
    tick,
    hostElapsedMs: hostMs,
    wave: 1,
    banner: 0,
    teamScore: 0,
    freed: 0,
    energy: 1,
    paused: false,
    parked: false,
    gameOver: false,
    ships: [],
    enemies: [],
    boss: null,
    tanker: null,
    field: null,
    // One straight bullet that left y = 0 at host time 0, at 300 px/s.
    shots: [{ kind: 'enemy', color: NEON.red, heavy: false, x: 100, y: (300 * hostMs) / 1000, vx: 0, vy: 300, beamLife: 0 }],
    items: [],
    fx: [],
  });
  const hostAt = (sendMs: number) => (sendMs < 2000 ? sendMs : sendMs - 250);
  const sends: number[] = [];
  for (let t = 0; t < 2000; t += 55) sends.push(t);
  for (let t = 2300; t < 3200; t += 55) sends.push(t);
  let next = 0;
  let tick = 0;
  const worst: Array<{ t: number; aheadMs: number }> = [];
  for (let now = 0; now < 3200; now += 1000 / 60) {
    while (next < sends.length && sends[next]! + 50 <= now) {
      const sent = sends[next]!;
      it.push(snapAt(++tick, hostAt(sent)), sent + 50);
      // The input this snapshot acknowledges was sent 60 ms before the host used it.
      it.setAckHostOffset(hostAt(sent) - (sent - 60));
      next += 1;
    }
    const out = it.sample(now);
    const shot = out?.shots[0];
    if (!shot || now < 2300 + 200) continue; // the first ~0.2 s after the frame: the lead itself is still re-learning
    // Where the bullet belongs: at the host time when an input sent now gets used.
    const wantHostMs = hostAt(now) + 60;
    worst.push({ t: Math.round(now), aheadMs: ((shot.y - (300 * wantHostMs) / 1000) / 300) * 1000 });
  }
  const bad = worst.filter((w) => Math.abs(w.aheadMs) > 20);
  assert.ok(worst.length > 30);
  assert.deepEqual(bad.slice(0, 4), [], `${bad.length} frames off by more than 20 ms`);
});

test('Round 15 follow-up (b2 16): the held-up snapshots arriving after a long download stall never pull a young bullet back', () => {
  // Host and guest clocks run together; snapshots go out every 55 ms and take 50 ms to arrive, except that everything
  // sent from 2.0 to 2.7 s is held up and arrives oldest first between 2.75 and 2.8 s. Three bullets at 300 px/s: one
  // fired before the stall, two during it (the guest first hears of those in the held-up batch).
  const it = new SnapshotInterpolator();
  const bullets = [
    { x: 100, born: 1700 },
    { x: 120, born: 2100 },
    { x: 140, born: 2400 },
  ];
  const snapAt = (tick: number, hostMs: number): CoopWorldSnapshot => ({
    tick,
    hostElapsedMs: hostMs,
    wave: 1,
    banner: 0,
    teamScore: 0,
    freed: 0,
    energy: 1,
    paused: false,
    parked: false,
    gameOver: false,
    ships: [],
    enemies: [],
    boss: null,
    tanker: null,
    field: null,
    shots: bullets
      .filter((b) => hostMs >= b.born)
      .map((b) => ({ kind: 'enemy' as const, color: NEON.red, heavy: false, x: b.x, y: (300 * (hostMs - b.born)) / 1000, vx: 0, vy: 300, beamLife: 0 })),
    items: [],
    fx: [],
  });
  const sends: Array<{ sent: number; arrives: number }> = [];
  let held = 0;
  for (let t = 0; t < 3600; t += 55) {
    const isHeld = t >= 2000 && t < 2700;
    sends.push({ sent: t, arrives: isHeld ? 2750 + 4 * held++ : t + 50 });
  }
  let next = 0;
  let tick = 0;
  const prevY = new Map<number, number>();
  const problems: string[] = [];
  for (let now = 0; now < 3600; now += 1000 / 60) {
    while (next < sends.length && sends[next]!.arrives <= now) {
      const { sent } = sends[next]!;
      it.push(snapAt(++tick, sent), sends[next]!.arrives);
      it.setAckHostOffset(60);
      next += 1;
    }
    const out = it.sample(now);
    if (!out) continue;
    for (const b of bullets) {
      const drawn = out.shots.find((sh) => sh.x === b.x);
      const before = prevY.get(b.x);
      if (before !== undefined && !drawn) problems.push(`${Math.round(now)} ms: bullet ${b.x} vanished`);
      if (before !== undefined && drawn && drawn.y < before - 0.01) {
        problems.push(`${Math.round(now)} ms: bullet ${b.x} went back ${(before - drawn.y).toFixed(1)} px`);
      }
      if (drawn) prevY.set(b.x, drawn.y);
    }
  }
  assert.equal(prevY.size, bullets.length, 'every bullet was drawn');
  assert.deepEqual(problems.slice(0, 4), [], `${problems.length} problems`);
});
