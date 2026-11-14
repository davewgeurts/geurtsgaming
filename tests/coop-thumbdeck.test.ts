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

const thumbDeckR15 = await import('../src/game/coop-thumbdeck');
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

  // Landscape phone (844 x 390): the deck moves beside the arena (Round 15, 4.4). Laptop (1440 x 900): no deck.
  const landscape = computeCoopViewportLayout(844, 390, true);
  assert.equal(landscape.useThumbDeck, true);
  assert.equal(landscape.deckSide, 'right');
  assert.equal(landscape.deckHeight, 0);
  assert.ok(landscape.arenaRect.x + landscape.arenaRect.w <= landscape.deckRect.x, 'the deck sits beside the arena');
  assert.ok(Math.abs(landscape.arenaRect.w / landscape.arenaRect.h - 0.75) < 1e-6);

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

  // 2. Rotate phone to landscape (`844 x 390`) mid-touch, lift finger, and rotate back (`390 x 844`). Since Round 15
  // (4.4) the deck moves beside the arena instead of going away; the held thumb is still let go.
  const landscape = dir.setViewport(844, 390, undefined, true);
  assert.equal(landscape.deckSide, 'right');
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

test('Round 13 (Sec 5): Guest Game Over shows host-relaunch notice without Top 10, Game Over hides reboot timers, and stacked wrecks stagger labels', async () => {
  // 1. A squad's game over is its mission summary: the solo HUD lines (BEST, Top 10, Retry) are not drawn at all, and
  // a guest's summary says it is waiting for the host (Round 15, 6: the HUD's own co-op lines were never shown).
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
  assert.equal(guestRec.batches.length, 0, 'the HUD draws nothing over a squad game over');
  const { renderSquadMissionSummary } = await import('../src/game/coop-quiz');
  const summaryRec = createStrokeRecorder();
  renderSquadMissionSummary(summaryRec.ctx as never, summaryRec.ink, {
    formattedCode: 'R13-SEC',
    isHost: false,
    coarse: false,
    time: 0.2,
    stateTime: 1.5,
    score: 1200,
    wave: 4,
    totalFreed: 3,
    upgrades: new Set(),
    pilots: [{ seat: 1, callsign: 'NOVA', color: NEON.cyan, questionsRight: 2, revives: 1 }],
  });
  const expectedWaitWidth = textWidth('WAITING FOR THE HOST TO RELAUNCH', 10.5);
  const waitBatch = summaryRec.batches.find((b) => b.color === NEON.cyan && Math.abs(b.w - expectedWaitWidth) < 4);
  assert.ok(waitBatch, "a guest's summary says WAITING FOR THE HOST TO RELAUNCH");

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

test('Round 15 (4.4): a phone or tablet held sideways gets full-size question cards beside the arena', () => {
  const { deckCardBoxes } = thumbDeckR15;
  const cards = [
    { kind: 'grade', interactive: true },
    { kind: 'offer', upgrades: UPGRADES.slice(0, 3), interactive: true },
    {
      kind: 'choice',
      title: 'SOLVE TO DEFUSE',
      titleColor: NEON.red,
      question: '7 + 5',
      options: [11, 12, 13],
      correctIndex: 1,
      pickedIndex: null,
      done: false,
      interactive: true,
      timeLeft: 10,
      timeLimit: 16,
      note: '',
      noteColor: NEON.cyan,
    },
  ] as const;
  for (const [w, h] of [
    [844, 390],
    [740, 360],
    [1024, 768],
    [1180, 820],
  ] as const) {
    const layout = computeCoopViewportLayout(w, h, true);
    assert.equal(layout.useThumbDeck, true, `${w}x${h} uses the deck`);
    assert.equal(layout.deckSide, 'right');
    const arena = layout.arenaRect;
    assert.ok(arena.h >= h - 16, `${w}x${h}: the arena still uses the full height (${arena.h.toFixed(0)} px)`);
    for (const card of cards) {
      const boxes = deckCardBoxes(layout, card as never);
      assert.ok(boxes.length > 0, `${w}x${h} ${card.kind}`);
      for (const b of boxes) {
        assert.ok(b.w >= 44 && b.h >= 44, `${w}x${h} ${card.kind}: target ${b.w.toFixed(0)}x${b.h.toFixed(0)} px`);
        assert.ok(b.x >= arena.x + arena.w && b.x + b.w <= w && b.y >= 0 && b.y + b.h <= h, `${w}x${h} ${card.kind}: on screen, beside the arena`);
      }
    }
  }
  // A laptop's mouse and a portrait tablet's finger still play in the full-size arena.
  assert.equal(computeCoopViewportLayout(1440, 900, false).useThumbDeck, false);
  assert.equal(computeCoopViewportLayout(820, 1180, true).useThumbDeck, false);
});

test('Round 15 (5.11): on small phones every grade and upgrade row is at least 44 px and fully on screen', () => {
  const { deckCardBoxes } = thumbDeckR15;
  const grade = { kind: 'grade', interactive: true } as const;
  const offer = { kind: 'offer', upgrades: UPGRADES.slice(0, 3), interactive: true } as const;
  for (const [w, h] of [
    [320, 568],
    [360, 640],
    [375, 667],
    [390, 844],
  ] as const) {
    const layout = computeCoopViewportLayout(w, h, true);
    assert.equal(layout.deckSide, 'bottom');
    for (const card of [grade, offer]) {
      const boxes = deckCardBoxes(layout, card as never);
      assert.equal(boxes.length, 3);
      for (const b of boxes) {
        assert.ok(b.h >= 44 && b.w >= 44, `${w}x${h} ${card.kind}: row ${b.w.toFixed(0)}x${b.h.toFixed(0)} px`);
        assert.ok(b.y >= layout.deckRect.y && b.y + b.h <= h, `${w}x${h} ${card.kind}: row ends at y ${(b.y + b.h).toFixed(0)}`);
      }
    }
  }
});

test('Round 15 (6): wreck labels never overprint, and deck card titles use only letters the font can draw', async () => {
  const { placeWreckLabel } = await import('../src/game/coop-flight');
  const { hasGlyph } = await import('../src/game/font');
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let run = 0; run < 200; run++) {
    const drawn: Array<{ x: number; top: number; bottom: number }> = [];
    const count = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      const x = 300 + rnd() * 120;
      const y = 800 + rnd() * 40;
      placeWreckLabel(drawn, x, y + 22, rnd() < 0.5 ? 18 : 9, 2);
    }
    for (let a = 0; a < drawn.length; a++) {
      for (let b = a + 1; b < drawn.length; b++) {
        const A = drawn[a]!;
        const B = drawn[b]!;
        const overlap = Math.abs(A.x - B.x) < 84 && A.top < B.bottom && B.top < A.bottom;
        assert.equal(overlap, false, `run ${run}: labels ${a} and ${b} overprint`);
      }
    }
  }
  const { CoopLocalQuizController } = await import('../src/game/coop-quiz');
  const hooks = { play() {}, announce() {}, onChallengeSettled() {}, onUpgradeChosen() {} };
  const c = new CoopLocalQuizController({ isolatedGrade: true, initialGrade: 1, initialInputMode: 'touch' });
  c.openChallenge(600, 'break', 12, true, hooks);
  const card = c.deckCard(true);
  assert.ok(card && card.kind === 'choice');
  const blanks = [...card.title].filter((ch) => !hasGlyph(ch));
  assert.deepEqual(blanks, [], `"${card.title}" draws blanks for ${blanks.join(' ')}`);
});

test("Round 15 (6): on a phone and a tablet, the page's buttons never cover the Sum Boss's face, health bar or taunt", () => {
  const seats: CoopPublicSeat[] = [0, 1].map((i) => ({ seat: i as 0 | 1, callsign: `P${i + 1}`, ready: true, isHost: i === 0, connected: true }));
  for (const [vw, vh] of [
    [390, 844],
    [360, 640],
    [768, 1024],
  ] as const) {
    const client = new CoopClient({ code: 'BOSS15', role: 'host', storage: null });
    Object.assign(client, { seat: 0, seats });
    const dir = new CoopFlightDirector({ client, initialSeats: seats, storage: null, now: () => 1000 });
    const layout = dir.setViewport(vw, vh, undefined, true);
    // A host's row in co-op (HeroGame.astro): Pause and Sound 44 px, Exit 57 px (measured in Chrome at 390x844), 6 px
    // apart on narrow phones; wider screens give Exit more room. 12 px from the top and right, 44 px tall.
    const rowW = vw <= 420 ? 44 + 44 + 57 + 2 * 6 : 44 + 44 + 80 + 2 * 8;
    const controls: Box = { x: vw - 12 - rowW, y: 12, w: rowW, h: 44 };
    const draw = (bossShown: boolean) => {
      const rec = createStrokeRecorder();
      rec.ctx.save();
      rec.ctx.translate(layout.arenaRect.x, layout.arenaRect.y);
      rec.ctx.scale(layout.arenaScale, layout.arenaScale);
      const ctxv = baseHudContext(rec.ctx, rec.ink, { controlsBottom: dir.mapCanvasPointToArena(0, 56).y });
      if (!bossShown) {
        ctxv.boss = null;
        ctxv.villain.show = 0;
      }
      renderHud(ctxv);
      rec.ctx.restore();
      return rec.batches;
    };
    // The boss's corner is drawn last: whatever a boss adds to the HUD is its face, health bar and taunt.
    const without = draw(false).length;
    const bossParts = draw(true).slice(without);
    assert.ok(bossParts.length >= 3, `${vw}x${vh}: the boss's corner was drawn`);
    const covered = bossParts.filter((b) => boxesOverlap(b, controls));
    assert.deepEqual(
      covered.map((b) => `${b.color} at (${Math.round(b.x)},${Math.round(b.y)}) ${Math.round(b.w)}x${Math.round(b.h)}`),
      [],
      `${vw}x${vh}: the boss's corner is drawn under the buttons`,
    );
    dir.dispose();
    client.dispose();
  }
});
