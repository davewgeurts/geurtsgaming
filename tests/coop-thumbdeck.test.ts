import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoopClient } from '../src/game/coop-client';
import { CoopFlightDirector } from '../src/game/coop-flight';
import {
  CoopThumbDeck,
  arenaToClientPoint,
  clientToArenaPoint,
  computeCoopViewportLayout,
} from '../src/game/coop-thumbdeck';
import { COOP_ARENA_HEIGHT, COOP_ARENA_WIDTH, type CoopPublicSeat } from '../src/game/coop-types';
import { NEON, type Ink } from '../src/game/core';
import { textWidth } from '../src/game/font';
import { freshVillain, renderHud, renderMessages, type Box, type HudViewContext } from '../src/game/hud';
import { UPGRADES } from '../src/game/upgrades';

test('computeCoopViewportLayout reserves bottom 38% on portrait phones and full 3:4 arena on tablets/laptops', () => {
  // Portrait iPhone (390 x 844)
  const phone = computeCoopViewportLayout(390, 844, true);
  assert.equal(phone.useThumbDeck, true);
  assert.equal(phone.deckHeight, Math.round(844 * 0.38));
  assert.ok(Math.abs(phone.arenaRect.w / phone.arenaRect.h - 0.75) < 1e-6, 'exact 3:4 aspect ratio');
  assert.ok(
    phone.arenaRect.y + phone.arenaRect.h <= phone.deckRect.y,
    '3:4 arena sits strictly above the Bottom 38% Thumb Steering Deck with zero overlap',
  );

  // Small portrait phone (320 x 568)
  const smallPhone = computeCoopViewportLayout(320, 568, true);
  assert.equal(smallPhone.useThumbDeck, true);
  assert.ok(smallPhone.arenaRect.w >= 240);
  assert.ok(smallPhone.arenaRect.y + smallPhone.arenaRect.h <= smallPhone.deckRect.y);
  assert.ok(Math.abs(smallPhone.arenaRect.w / smallPhone.arenaRect.h - 0.75) < 1e-6);

  // Portrait iPad (820 x 1180, coarse pointer but >= 600px wide)
  const ipad = computeCoopViewportLayout(820, 1180, true);
  assert.equal(ipad.useThumbDeck, false);
  assert.equal(ipad.deckHeight, 0);
  assert.ok(Math.abs(ipad.arenaRect.w / ipad.arenaRect.h - 0.75) < 1e-6);
  assert.ok(ipad.arenaRect.w > 750);

  // Landscape phone (844 x 390) & Laptop (1440 x 900)
  const landscape = computeCoopViewportLayout(844, 390, true);
  assert.equal(landscape.useThumbDeck, false);
  assert.equal(landscape.deckHeight, 0);

  const laptop = computeCoopViewportLayout(1440, 900, false);
  assert.equal(laptop.useThumbDeck, false);
  assert.equal(laptop.deckHeight, 0);
  assert.ok(Math.abs(laptop.arenaRect.w / laptop.arenaRect.h - 0.75) < 1e-6);

  // Coordinate round-trip between CSS viewport and 768 x 1024 world
  const screenMid = arenaToClientPoint(phone, COOP_ARENA_WIDTH / 2, COOP_ARENA_HEIGHT / 2);
  const backToWorld = clientToArenaPoint(phone, screenMid.x, screenMid.y);
  assert.equal(backToWorld.inside, true);
  assert.ok(Math.abs(backToWorld.x - COOP_ARENA_WIDTH / 2) < 0.01);
  assert.ok(Math.abs(backToWorld.y - COOP_ARENA_HEIGHT / 2) < 0.01);
});

test('CoopThumbDeck drives relative trackpad steering, auto-fire latch, and independent arena taps', () => {
  const layout = computeCoopViewportLayout(390, 844, true);
  const deck = new CoopThumbDeck();
  deck.reset(384, 880);

  assert.equal(deck.state().touching, false);
  assert.equal(deck.state().firing, false);

  // Put thumb down in middle of pad
  const startX = layout.padRect.x + layout.padRect.w / 2;
  const startY = layout.padRect.y + layout.padRect.h / 2;
  assert.equal(deck.onPointerDown(layout, 7, startX, startY), true);
  assert.equal(deck.state().touching, true);
  assert.equal(deck.state().firing, true, 'holding thumb on pad fires automatically');

  // Slide thumb 120px right -> sweeps smoothly to right edge and clamps inside 768px world
  assert.equal(deck.onPointerMove(layout, 7, startX + 120, startY - 40), true);
  assert.ok(deck.state().targetX > 680 && deck.state().targetX <= COOP_ARENA_WIDTH - 22);
  assert.ok(deck.state().targetY < 880 && deck.state().targetY >= 44);

  // Second finger tapping a Sum Boss pod inside top 3:4 arena does NOT steal steering thumb!
  const podClient = arenaToClientPoint(layout, 250, 320);
  assert.equal(deck.onPointerDown(layout, 8, podClient.x, podClient.y), true);
  const tap = deck.consumeArenaTap();
  assert.ok(tap);
  assert.ok(Math.abs(tap.x - 250) < 0.5);
  assert.ok(Math.abs(tap.y - 320) < 0.5);
  assert.equal(deck.state().touching, true, 'steering thumb stays active');

  // Release thumb -> stops firing unless Auto-Fire latch is tapped
  assert.equal(deck.onPointerUp(7), true);
  assert.equal(deck.state().touching, false);
  assert.equal(deck.state().firing, false);

  // Tap Auto-Fire button -> latches firing ON
  const btnX = layout.autoFireBtnRect.x + layout.autoFireBtnRect.w / 2;
  const btnY = layout.autoFireBtnRect.y + layout.autoFireBtnRect.h / 2;
  assert.equal(deck.onPointerDown(layout, 9, btnX, btnY), true);
  assert.equal(deck.state().autoFireLatch, true);
  assert.equal(deck.state().firing, true);
  assert.equal(layout.autoFireBtnRect.h, 44, 'AUTO-FIRE button meets 44px minimum touch height');
});

test('Portrait-phone Host lets 100% of touches pass through on Game Over or Pause, and rotating mid-touch releases steering cleanly', () => {
  const seats: CoopPublicSeat[] = [
    { seat: 0, callsign: 'NOVA-1', ready: true, isHost: true, connected: true },
    { seat: 1, callsign: 'STAR-2', ready: true, isHost: false, connected: true },
  ];
  const client = new CoopClient({ code: 'DECK88', role: 'host', callsign: 'NOVA-1', storage: null });
  // Simulate welcomed Seat 0 without opening a socket
  Object.assign(client, { seat: 0 });
  const dir = new CoopFlightDirector({ client, initialSeats: seats, storage: null, now: () => 1000 });
  const phone = dir.setViewport(390, 844, undefined, true);
  assert.equal(phone.useThumbDeck, true);

  // Bind a minimal world adapter to toggle gameOver / paused / boss state
  const stubWorld = {
    gameOver: false,
    paused: false,
    boss: null as null | { kind: 'sum' | 'arms'; state: 'fight'; pods: Array<{ value: number }> },
  };
  dir.bindWorld(stubWorld as never);

  // 1. During normal play with NO Sum Boss active, upper-arena taps are swallowed (`true`) with 0 steering or queued taps (`3.1`), while pad touches steer (`true`)
  const upperPt = arenaToClientPoint(phone, 384, 300);
  assert.equal(dir.handlePointerDown(1, upperPt.x, upperPt.y, true), true);
  assert.equal(dir.deck.state().touching, false);
  assert.equal(dir.deck.consumeArenaTap(), null);
  const padX = phone.padRect.x + phone.padRect.w / 2;
  const padY = phone.padRect.y + phone.padRect.h / 2;
  assert.equal(dir.handlePointerDown(2, padX, padY, true), true);
  assert.equal(dir.deck.state().touching, true);

  // 2. Rotate phone to landscape (`844 x 390`) mid-touch, lift finger, and rotate back (`390 x 844`)
  const landscape = dir.setViewport(844, 390, undefined, true);
  assert.equal(landscape.useThumbDeck, false);
  assert.equal(dir.deck.state().touching, false, 'viewport switch immediately releases captured thumb pointer');
  dir.handlePointerUp(2);
  dir.setViewport(390, 844, undefined, true);
  assert.equal(dir.deck.state().touching, false);
  assert.equal(dir.deck.state().firing, false);

  // A new thumb touch with a different pointerId steers immediately after rotating back
  assert.equal(dir.handlePointerDown(3, padX, padY, true), true);
  assert.equal(dir.handlePointerMove(3, padX + 90, padY), true);
  assert.ok(dir.deck.state().targetX > formationSpawnX0() + 120);

  // 3. On Game Over (and on Pause), 100% of screen touches pass through (`false`) and release any held deck pointer!
  stubWorld.gameOver = true;
  for (let y = 20; y < 844; y += 60) {
    for (let x = 20; x < 390; x += 60) {
      assert.equal(dir.handlePointerDown(10, x, y, true), false, `touch at (${x},${y}) passes through on Game Over`);
    }
  }
  assert.equal(dir.deck.state().touching, false);

  stubWorld.gameOver = false;
  stubWorld.paused = true;
  assert.equal(dir.handlePointerDown(11, padX, padY, true), false, 'pad touch passes through while Paused');

  dir.dispose();
  client.dispose();
});

function formationSpawnX0(): number {
  return COOP_ARENA_WIDTH / 2 + (0 - 1.5) * 96;
}

interface RecordedBatch extends Box {
  color: string;
}

function createStrokeRecorder() {
  const stack: Array<{ tx: number; ty: number; sx: number; sy: number }> = [];
  let tx = 0;
  let ty = 0;
  let sx = 1;
  let sy = 1;
  let curMinX = Infinity;
  let curMinY = Infinity;
  let curMaxX = -Infinity;
  let curMaxY = -Infinity;
  const batches: RecordedBatch[] = [];

  const mark = (x: number, y: number) => {
    const px = tx + x * sx;
    const py = ty + y * sy;
    if (px < curMinX) curMinX = px;
    if (py < curMinY) curMinY = py;
    if (px > curMaxX) curMaxX = px;
    if (py > curMaxY) curMaxY = py;
  };

  const resetCur = () => {
    curMinX = Infinity;
    curMinY = Infinity;
    curMaxX = -Infinity;
    curMaxY = -Infinity;
  };

  let inInk = false;
  const ctxStrokes: RecordedBatch[] = [];

  const ctx = {
    save() {
      stack.push({ tx, ty, sx, sy });
    },
    restore() {
      const prev = stack.pop();
      if (prev) {
        tx = prev.tx;
        ty = prev.ty;
        sx = prev.sx;
        sy = prev.sy;
      }
    },
    translate(dx: number, dy: number) {
      tx += dx * sx;
      ty += dy * sy;
    },
    scale(kx: number, ky: number) {
      sx *= kx;
      sy *= ky;
    },
    beginPath() {
      if (!inInk) resetCur();
    },
    closePath() {},
    moveTo(x: number, y: number) {
      mark(x, y);
    },
    lineTo(x: number, y: number) {
      mark(x, y);
    },
    rect(x: number, y: number, w: number, h: number) {
      mark(x, y);
      mark(x + w, y + h);
    },
    arc(x: number, y: number, r: number) {
      mark(x - r, y - r);
      mark(x + r, y + r);
    },
    arcTo(x1: number, y1: number, x2: number, y2: number) {
      mark(x1, y1);
      mark(x2, y2);
    },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
      mark(cx, cy);
      mark(x, y);
    },
    fill() {},
    stroke() {
      if (!inInk && Number.isFinite(curMinX)) {
        ctxStrokes.push({
          color: String((ctx as unknown as { strokeStyle: string }).strokeStyle),
          x: curMinX,
          y: curMinY,
          w: Math.max(0, curMaxX - curMinX),
          h: Math.max(0, curMaxY - curMinY),
        });
      }
    },
    fillRect() {},
    strokeRect(x: number, y: number, w: number, h: number) {
      mark(x, y);
      mark(x + w, y + h);
    },
    clip() {},
    fillStyle: '',
    strokeStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    globalAlpha: 1,
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;

  const ink: Ink = (color, _alpha, _width, draw) => {
    inInk = true;
    resetCur();
    draw();
    inInk = false;
    if (Number.isFinite(curMinX)) {
      batches.push({
        color,
        x: curMinX,
        y: curMinY,
        w: Math.max(0, curMaxX - curMinX),
        h: Math.max(0, curMaxY - curMinY),
      });
    }
  };

  return { ctx, ink, batches, ctxStrokes };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function baseHudContext(
  ctx: CanvasRenderingContext2D,
  ink: Ink,
  overrides: Partial<HudViewContext> = {},
): HudViewContext {
  const villain = freshVillain();
  villain.show = 10;
  villain.line = 'SOLVE THIS OR FALL';
  villain.lineUntil = 10;
  return {
    ctx,
    ink,
    w: COOP_ARENA_WIDTH,
    h: COOP_ARENA_HEIGHT,
    scale: 1,
    shipScale: 1,
    inset: { top: 0, right: 0, bottom: 0, left: 0 },
    room: COOP_ARENA_WIDTH,
    homeY: COOP_ARENA_HEIGHT * 0.86,
    time: 1.0,
    reduceMotion: true,
    coarse: true,
    input: 'touch',
    state: 'playing',
    stateTime: 1.5,
    paused: false,
    shipX: 384,
    shipY: 880,
    lean: 0,
    hull: 3,
    maxHull: 3,
    energy: 0.8,
    jam: 0,
    score: 12450,
    best: 25000,
    newBest: false,
    wave: 8,
    banner: 0,
    freed: 14,
    freedPulse: 0,
    soulsInFlight: 0,
    bossFreed: 0,
    bossNote: '',
    intermission: 0,
    fuelNote: { text: '', until: 0, color: '#ffffff' },
    upgrades: new Set(UPGRADES.map((u) => u.id)),
    boss: { state: 'fight', kind: 'sum', x: 384, y: 200, hp: 14, maxHp: 20 } as never,
    tanker: null,
    brk: null,
    prompt: null,
    pilotMood: 'calm',
    villainMood: 'calm',
    villain,
    callsign: 'ACE',
    onlineCount: 4,
    ...overrides,
  };
}

test('Round 13 (4.2): tablet portrait (768x1024 and 810x1080) wingman tags have zero overlap with HUD face, wave, upgrades, or boss', () => {
  const fourSeats: CoopPublicSeat[] = [0, 1, 2, 3].map((i) => ({
    seat: i as 0 | 1 | 2 | 3,
    callsign: `P${i + 1}`,
    ready: true,
    isHost: i === 0,
    connected: true,
  }));

  for (const [vw, vh] of [
    [768, 1024],
    [810, 1080],
  ] as const) {
    const client = new CoopClient({ code: 'TAB768', role: 'host', storage: null });
    Object.assign(client, { seat: 0, seats: fourSeats });
    const dir = new CoopFlightDirector({ client, initialSeats: fourSeats, storage: null, now: () => 1000 });
    const layout = dir.setViewport(vw, vh, undefined, true);
    assert.equal(layout.useThumbDeck, false);
    assert.ok(layout.arenaRect.x < 132, 'tablet portrait uses top compact wingman bar');

    const hudRec = createStrokeRecorder();
    hudRec.ctx.save();
    hudRec.ctx.translate(layout.arenaRect.x, layout.arenaRect.y);
    hudRec.ctx.scale(layout.arenaScale, layout.arenaScale);
    renderHud(baseHudContext(hudRec.ctx, hudRec.ink));
    hudRec.ctx.restore();
    assert.ok(hudRec.batches.length >= 8, 'HUD rendered portrait, score, wave, 10 upgrades, and boss corner');

    const chromeRec = createStrokeRecorder();
    dir.renderViewportChrome(chromeRec.ctx, chromeRec.ink, 1.0);
    // Batch 0 is the full 3:4 arena frame rect; batches 1..4 are P1..P4 wingman tags
    const tagBoxes = chromeRec.batches.slice(1);
    assert.equal(tagBoxes.length, 4, `${vw}x${vh}: expected 4 wingman tag batches`);

    const arcadeControlsBox: Box = { x: vw - 180, y: 12, w: 168, h: 40 };
    for (let idx = 0; idx < tagBoxes.length; idx++) {
      const tag = tagBoxes[idx]!;
      assert.equal(
        boxesOverlap(tag, arcadeControlsBox),
        false,
        `${vw}x${vh}: tag P${idx + 1} overlaps .arcade-controls`,
      );
      for (const hb of hudRec.batches) {
        assert.equal(
          boxesOverlap(tag, hb),
          false,
          `${vw}x${vh}: tag P${idx + 1} (${Math.round(tag.x)},${Math.round(tag.y)} ${Math.round(tag.w)}x${Math.round(tag.h)}) overlaps HUD element (${Math.round(hb.x)},${Math.round(hb.y)} ${Math.round(hb.w)}x${Math.round(hb.h)})`,
        );
      }
    }

    dir.dispose();
    client.dispose();
  }
});

test('Round 13 (Sec 5): Guest Game Over shows host-relaunch notice without Top 10, Game Over hides reboot timers, and stacked wrecks stagger labels', () => {
  // 1. Guest Game Over draws "WAITING FOR THE HOST TO RELAUNCH" (at mid + 96) and omits BEST + Top 10 + Retry
  const guestRec = createStrokeRecorder();
  renderMessages(
    baseHudContext(guestRec.ctx, guestRec.ink, {
      time: 0.2,
      state: 'over',
      stateTime: 1.5,
      coarse: false,
      input: 'keys',
      coopRole: 'guest',
    }),
  );
  const expectedWaitWidth = textWidth('WAITING FOR THE HOST TO RELAUNCH', 10);
  assert.equal(guestRec.batches.length, 4, 'Guest Game Over draws exactly 4 lines (GAME OVER, SCORE, SQUAD SET FREE, WAITING FOR HOST)');
  const waitBatch = guestRec.batches[3]!;
  assert.equal(waitBatch.color, NEON.cyan);
  assert.ok(Math.abs(waitBatch.w - expectedWaitWidth) < 4, 'bottom line matches WAITING FOR THE HOST TO RELAUNCH');

  // Solo Game Over still draws BEST + TOP 10 + PRESS SPACE TO RETRY (6 lines)
  const soloRec = createStrokeRecorder();
  renderMessages(
    baseHudContext(soloRec.ctx, soloRec.ink, {
      time: 0.2,
      state: 'over',
      stateTime: 1.5,
      coarse: false,
      input: 'keys',
      coopRole: undefined,
    }),
  );
  assert.equal(soloRec.batches.length, 6, 'Solo Game Over still draws all 6 solo lines including BEST and Top 10');

  // 2. Two pilots wrecked at the exact same (384, 700) stagger their label Ys and say "HULL DOWN" on Game Over
  const twoSeats: CoopPublicSeat[] = [
    { seat: 0, callsign: 'ACE', ready: true, isHost: true, connected: true },
    { seat: 1, callsign: 'NOVA', ready: true, isHost: false, connected: true },
  ];
  const client = new CoopClient({ code: 'WRECKS', role: 'host', storage: null });
  Object.assign(client, { seat: 0, seats: twoSeats });
  const dir = new CoopFlightDirector({ client, initialSeats: twoSeats, storage: null, now: () => 1000 });
  const stubWorld = {
    gameOver: false,
    paused: false,
    boss: null,
    upgrades: new Set<string>(),
  };
  dir.bindWorld(stubWorld as never);
  for (const s of [0, 1] as const) {
    dir.pilots[s].alive = false;
    dir.pilots[s].x = 384;
    dir.pilots[s].y = 700;
    dir.pilots[s].respawnSec = 4.2;
  }

  const liveWreckRec = createStrokeRecorder();
  dir.renderSquadShips(liveWreckRec.ctx, liveWreckRec.ink, 1.0, 1, 1, true, new Set());
  // Each dead pilot draws 1 combined ghost-ship + reboot-label batch; co-located P2 shifts its label down by +10px
  assert.equal(liveWreckRec.batches.length, 2);
  const liveBatch1 = liveWreckRec.batches[0]!;
  const liveBatch2 = liveWreckRec.batches[1]!;
  assert.ok(
    liveBatch2.y + liveBatch2.h - (liveBatch1.y + liveBatch1.h) >= 9.5,
    `co-located wreck labels stagger vertically (${liveBatch1.y + liveBatch1.h} vs ${liveBatch2.y + liveBatch2.h})`,
  );

  stubWorld.gameOver = true;
  const overWreckRec = createStrokeRecorder();
  dir.renderSquadShips(overWreckRec.ctx, overWreckRec.ink, 1.0, 1, 1, true, new Set());
  assert.equal(overWreckRec.batches.length, 0, 'Game Over hides arena REBOOT ghost countdowns');

  // 3. Portrait-phone thumb deck replaces "WINGMAN REBOOT IN 5 SEC" with "SQUAD DOWN" on Game Over
  dir.setViewport(390, 844, undefined, true);
  stubWorld.gameOver = false;
  const liveDeckRec = createStrokeRecorder();
  dir.renderViewportChrome(liveDeckRec.ctx, liveDeckRec.ink, 1.0);
  stubWorld.gameOver = true;
  const overDeckRec = createStrokeRecorder();
  dir.renderViewportChrome(overDeckRec.ctx, overDeckRec.ink, 1.0);
  const liveBannerW = Math.max(...liveDeckRec.ctxStrokes.filter((b) => b.color === NEON.orange).map((b) => b.w));
  const overBannerW = Math.max(...overDeckRec.ctxStrokes.filter((b) => b.color === NEON.orange).map((b) => b.w));
  assert.ok(overBannerW < liveBannerW - 40, 'Thumb deck replaces WINGMAN REBOOT IN ... SEC with SQUAD DOWN on Game Over');

  dir.dispose();
  client.dispose();
});
