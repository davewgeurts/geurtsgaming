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
  SnapshotInterpolator,
  decodeGuestInput,
  decodeWorldSnapshot,
  encodeGuestInput,
  encodeWorldSnapshot,
  formatBossMathQuestion,
  parseBossMathQuestion,
  type CoopWorldSnapshot,
} from '../src/game/coop-protocol';
import { BIN_FRAME_INPUT, BIN_FRAME_SNAP, MAX_BINARY_BYTES } from '../src/game/coop-types';
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
