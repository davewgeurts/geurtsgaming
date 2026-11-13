import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Minimal browser environment for importing `src/game/game.ts`.
const media = { coarse: false, reducedMotion: false };
const g = globalThis as Record<string, unknown>;
const winTarget = new EventTarget() as EventTarget & Record<string, unknown>;
winTarget.devicePixelRatio = 1;
const docTarget = new EventTarget() as EventTarget & { hidden: boolean } & Record<string, unknown>;
docTarget.hidden = false;

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  } as Storage;
}

const sharedLocalStorage = createMemoryStorage();
g.window = winTarget;
g.document = docTarget;
g.addEventListener = winTarget.addEventListener.bind(winTarget);
g.removeEventListener = winTarget.removeEventListener.bind(winTarget);
g.matchMedia = (q: string) => ({
  matches: q.includes('coarse') ? media.coarse : q.includes('reduced-motion') ? media.reducedMotion : false,
  addEventListener() {},
  removeEventListener() {},
});
g.localStorage = sharedLocalStorage;
g.sessionStorage = createMemoryStorage();
g.getComputedStyle = () => ({
  paddingTop: '0px',
  paddingRight: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',
});
g.requestAnimationFrame = () => 1;
g.cancelAnimationFrame = () => {};

const {
  DEFAULT_LOADOUT,
  LOADOUT_KEY,
  PILOTS,
  PILOT_BY_ID,
  PILOT_IDS,
  SHIPS,
  SHIP_BY_ID,
  THEMES,
  THEME_BY_ID,
  loadSavedLoadout,
  saveLoadout,
} = await import('../src/game/loadout');
const { renderAvatarFrame } = await import('../src/game/avatar');
const { AMBER, LILAC, NEON, PINK, ROCK, ROSE, SAND, clamp, strokeInk } = await import('../src/game/core');
const { HANGAR_PICKER_SCRIPT, HANGAR_STAGE_GRACE, Hangar } = await import('../src/game/hangar');
const { Intro } = await import('../src/game/intro');
const { SHIP, SHIP_BASTION, SHIP_SWIFT, shipShape, traceShipThrusters } = await import('../src/game/shapes');
const { fireVolley } = await import('../src/game/weapons');
const { Game } = await import('../src/game/game');
const { bossParts, createBoss, shootBoss, updateBoss } = await import('../src/game/boss');
const { createField, gapAt, updateField } = await import('../src/game/asteroids');
const { FUEL_SECONDS, createTanker, tankerTail, updateTanker } = await import('../src/game/tanker');
const { trust } = await import('../src/data/trust');

interface StrokeRecord {
  color: string;
  alpha: number;
  width: number;
  glow: boolean;
  moves: number;
  lines: number;
  coords: Array<[number, number]>;
}

function makeRecordingCanvas(w = 1280, h = 800) {
  const strokes: StrokeRecord[] = [];
  let activeCoords: Array<[number, number]> = [];
  let moves = 0;
  let lines = 0;

  const c = new EventTarget() as EventTarget & {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    parentElement: null;
    getContext: () => CanvasRenderingContext2D;
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
    setPointerCapture: () => void;
  };

  const ctxObj: Record<string, unknown> = {
    canvas: c,
    strokeStyle: '#fff',
    fillStyle: '#000',
    globalAlpha: 1,
    lineWidth: 1,
    shadowBlur: 0,
    shadowColor: 'transparent',
    lineJoin: 'round',
    lineCap: 'round',
    beginPath() {
      activeCoords = [];
      moves = 0;
      lines = 0;
    },
    moveTo(x: number, y: number) {
      moves += 1;
      activeCoords.push([x, y]);
    },
    lineTo(x: number, y: number) {
      lines += 1;
      activeCoords.push([x, y]);
    },
    stroke() {
      strokes.push({
        color: String(ctxObj.strokeStyle),
        alpha: Number(ctxObj.globalAlpha),
        width: Number(ctxObj.lineWidth),
        glow: Number(ctxObj.shadowBlur) > 0,
        moves,
        lines,
        coords: [...activeCoords],
      });
    },
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createConicGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
  };

  const ctx = new Proxy(ctxObj, {
    get(t, p) {
      if (p in t) return t[p as string];
      return () => {};
    },
    set(t, p, v) {
      t[p as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  Object.assign(c, {
    clientWidth: w,
    clientHeight: h,
    width: w,
    height: h,
    parentElement: null,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: c.clientWidth, height: c.clientHeight }),
    setPointerCapture: () => {},
  });

  const ink = (color: string, alpha: number, width: number, build: () => void, glow = true) =>
    strokeInk(ctx, color, alpha, width, build, glow);

  return { canvas: c, ctx, ink, strokes };
}

function makeFakeMultiplayer(onCycleCallsign?: () => void) {
  return {
    wingmen: [],
    lasers: [],
    start() {},
    stop() {},
    rest() {},
    updateFlight() {},
    recordScore: () => null,
    cycleCallsign: () => {
      onCycleCallsign?.();
      return 'ACE-2';
    },
    snapshot: () => ({
      onlineCount: 1,
      wingmenCount: 0,
      callsign: 'ACE-1',
      lastRank: null,
      totalLiberated: 0,
      topPilots: [],
    }),
    getCallsign: () => 'ACE-1',
    setCoopActive() {},
    subscribe: () => () => {},
  };
}

function makePointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  pointerType: 'mouse' | 'touch' = 'mouse',
  pointerId = 1,
): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    clientX: x,
    clientY: y,
    button: 0,
    pointerId,
    pointerType,
  });
}

function makeKeyEvent(type: 'keydown' | 'keyup', code: string, keyName: string): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    code,
    key: keyName,
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  });
}

function hexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function colorDist(a: string, b: string): number {
  const [r1, g1, b1] = hexRgb(a);
  const [r2, g2, b2] = hexRgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

test('loadout persistence & theme non-clash: validates JSON, keeps SAND bolts, and separates hull colours from all hostiles/hazards', () => {
  const store = createMemoryStorage();
  assert.deepEqual(DEFAULT_LOADOUT, { pilot: 'nova', theme: 'starlight', ship: 'starhawk' });
  assert.equal(loadSavedLoadout(store), null);

  store.setItem(LOADOUT_KEY, '{not-json');
  assert.equal(loadSavedLoadout(store), null);

  store.setItem(LOADOUT_KEY, JSON.stringify({ v: 1, pilot: 'dragon', theme: 'cyber', ship: 'swift' }));
  assert.equal(loadSavedLoadout(store), null);

  assert.equal(saveLoadout({ pilot: 'fox', theme: 'solar', ship: 'bastion' }, store), true);
  assert.deepEqual(loadSavedLoadout(store), { pilot: 'fox', theme: 'solar', ship: 'bastion' });

  // Roster checks: 8 pilots (4 human kids + 4 animals), 6 colour themes, 3 distinct ships
  assert.equal(PILOTS.length, 8);
  assert.equal(PILOTS.filter((p) => ['visor', 'goggles', 'puffs', 'cap'].includes(p.hangarHat)).length, 4);
  assert.equal(PILOTS.filter((p) => ['fox', 'cat', 'wolf', 'owl'].includes(p.hangarHat)).length, 4);
  assert.equal(THEMES.length, 6);
  assert.equal(SHIPS.length, 3);

  // Every theme keeps SAND bolts and maintains strong visual separation from all enemy/boss/mine/rock colours
  const reservedHazardColors = [
    PINK,
    LILAC,
    AMBER,
    ROSE,
    NEON.lime,
    NEON.yellow,
    NEON.orange,
    NEON.violet,
    NEON.red,
    ROCK,
  ];
  for (const theme of THEMES) {
    assert.equal(theme.bolt, SAND, `${theme.id} bolt must stay crisp SAND`);
    for (const hazard of reservedHazardColors) {
      const dist = colorDist(theme.hull, hazard);
      assert.ok(
        dist >= 75,
        `theme ${theme.id} hull (${theme.hull}) is too close to hazard/wingmate colour ${hazard} (dist=${dist.toFixed(1)})`,
      );
    }
  }

  // Ship balance invariants: Swift faster & lighter, Starhawk balanced, Bastion slower & heavier armour
  assert.equal(SHIP_BY_ID.swift.speedMul, 1.2);
  assert.equal(SHIP_BY_ID.starhawk.speedMul, 1);
  assert.equal(SHIP_BY_ID.bastion.speedMul, 0.88);
  assert.ok(SHIP_BY_ID.bastion.baseHull > SHIP_BY_ID.starhawk.baseHull);
  assert.ok(SHIP_BY_ID.swift.baseHull < SHIP_BY_ID.starhawk.baseHull);
});

test('low-poly pilot avatars: all 8 pilots draw multi-colour wireframe layers and reactive facial/ear/beak emotions across all 7 moods', () => {
  const moods = ['calm', 'worried', 'happy', 'hurt', 'laugh', 'talk', 'out'] as const;

  for (const pilot of PILOTS) {
    const coordsByMood = new Map<string, string>();
    for (const mood of moods) {
      const { ctx, ink, strokes } = makeRecordingCanvas(320, 320);
      renderAvatarFrame({
        ctx,
        ink,
        who: pilot.id,
        x: 20,
        y: 20,
        box: 180,
        yaw: 0.12,
        pitch: -0.04,
        mood,
        time: 1.4,
      });

      const strokeColors = new Set(strokes.map((s) => s.color));
      assert.ok(strokeColors.has(pilot.colors.base), `${pilot.id} (${mood}) missing base colour ${pilot.colors.base}`);
      assert.ok(
        strokeColors.has(pilot.colors.accent),
        `${pilot.id} (${mood}) missing accent colour ${pilot.colors.accent}`,
      );
      const totalSegments = strokes.reduce((sum, s) => sum + s.lines, 0);
      assert.ok(totalSegments > 25, `${pilot.id} (${mood}) should draw rich low-poly geometry`);
      coordsByMood.set(
        mood,
        strokes
          .flatMap((s) => s.coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`))
          .join(';'),
      );
    }

    assert.notEqual(coordsByMood.get('calm'), coordsByMood.get('happy'), `${pilot.id}: calm vs happy should differ`);
    assert.notEqual(coordsByMood.get('happy'), coordsByMood.get('worried'), `${pilot.id}: happy vs worried should differ`);
    assert.notEqual(coordsByMood.get('talk'), coordsByMood.get('out'), `${pilot.id}: talk vs out should differ`);
  }

  for (const legacy of ['pilot', 'boss', 'commander'] as const) {
    const { ctx, ink, strokes } = makeRecordingCanvas(240, 240);
    renderAvatarFrame({
      ctx,
      ink,
      who: legacy,
      x: 10,
      y: 10,
      box: 120,
      yaw: 0,
      pitch: 0,
      mood: 'calm',
      time: 0.5,
    });
    assert.ok(strokes.length >= 2, `${legacy} avatar still renders`);
  }
});

test('hangar onboarding: 0.25s input grace, Quick Fly, >=44px responsive layout, announcements, walk-in boarding, and KeyH re-customise', () => {
  const store = createMemoryStorage();
  const cues: string[] = [];
  const announcements: string[] = [];

  // 1. First visit (empty storage): opens on Avatar picker, announces Step 1, and enforces 0.25s input grace
  const firstIntro = new Intro(false, (c) => cues.push(c), undefined, {
    storage: store,
    onAnnounce: (msg) => announcements.push(msg),
  });
  assert.equal(firstIntro.phase, 'hangar');
  assert.equal(firstIntro.isPickingLoadout, true);
  assert.ok(Intro.script(false, true, true).startsWith(HANGAR_PICKER_SCRIPT));
  assert.ok(announcements.some((m) => m.includes('Step 1 of 3')));

  // Inputs arriving within HANGAR_STAGE_GRACE (0.25s) are swallowed so launch/prior-step presses never double-pick
  firstIntro.typeKey('6');
  firstIntro.command('Space');
  firstIntro.advance();
  const hangarInternal = (firstIntro as unknown as { hangar: InstanceType<typeof Hangar> }).hangar;
  assert.equal(hangarInternal.stage, 'avatar', 'inputs during 0.25s opening grace must not skip Step 1');

  // Verify responsive layout & >=44px non-overlapping hitboxes across narrow phones, landscape phones, and desktops
  for (const [vw, vh] of [
    [320, 568],
    [390, 844],
    [844, 390],
    [1280, 800],
    [1440, 900],
  ] as const) {
    for (const stage of ['avatar', 'theme', 'ship'] as const) {
      const probe = new Hangar(() => {}, {
        initialLoadout: DEFAULT_LOADOUT,
        hasSavedLoadout: false,
        reduceMotion: false,
      });
      probe.stage = stage;
      probe.update(HANGAR_STAGE_GRACE + 0.05);
      const { ctx, ink, strokes } = makeRecordingCanvas(vw, vh);
      probe.render({
        ctx,
        ink,
        w: vw,
        h: vh,
        inset: { top: 0, right: 0, bottom: 0, left: 0 },
        time: 0.6,
        touch: vw < 500,
      });
      assert.ok(strokes.length > 20, `${stage} picker renders at ${vw}x${vh}`);

      const ui = probe.uiBoxes;
      assert.ok(ui.quickFlyBtn, `quickFlyBtn present on ${stage} at ${vw}x${vh}`);
      assert.ok(
        ui.quickFlyBtn!.w >= 44 && ui.quickFlyBtn!.h >= 44 && ui.quickFlyBtn!.y >= 60,
        `quickFlyBtn clears toolbar and meets >=44px target at ${vw}x${vh}`,
      );
      if (stage !== 'avatar') {
        assert.ok(ui.navBtn, `navBtn present on ${stage} at ${vw}x${vh}`);
        assert.ok(
          ui.navBtn!.w >= 44 && ui.navBtn!.h >= 44 && ui.navBtn!.y >= 60,
          `navBtn clears toolbar and meets >=44px target at ${vw}x${vh}`,
        );
        assert.equal(boxesOverlap(ui.navBtn!, ui.quickFlyBtn!), false, 'navBtn and quickFlyBtn never overlap');
      }

      const activeCards =
        stage === 'avatar' ? ui.avatarCards : stage === 'theme' ? ui.themeCards : ui.shipPlaques;
      for (let i = 0; i < activeCards.length; i++) {
        const c = activeCards[i]!;
        assert.ok(
          c.x >= 0 && c.x + c.w <= vw && c.y >= 0 && c.y + c.h <= vh,
          `${stage} card ${i} stays inside ${vw}x${vh}`,
        );
        if (stage === 'ship') {
          assert.ok(c.w >= 44 && c.h >= 44, `ship bay plaque ${i} meets >=44px target at ${vw}x${vh}`);
        }
        for (let j = i + 1; j < activeCards.length; j++) {
          assert.equal(boxesOverlap(c, activeCards[j]!), false, `${stage} cards ${i} & ${j} do not overlap at ${vw}x${vh}`);
        }
      }
    }
  }

  // Advance past the 0.25s grace on `firstIntro`, render at 1280x800, and step through Avatar -> Theme -> Ship
  firstIntro.update(HANGAR_STAGE_GRACE + 0.05, false);
  {
    const { ctx, ink } = makeRecordingCanvas(1280, 800);
    const frame = { ctx, ink, w: 1280, h: 800, inset: { top: 0, right: 0, bottom: 0, left: 0 }, time: 0.5, touch: false };
    firstIntro.renderGround(frame);
    firstIntro.renderCockpit(frame);
  }

  // Step 1: Pick animal pilot #6 (`cat` / Mochi) via number key, verify transition grace blocks immediate bounce, then Backspace
  assert.equal(firstIntro.wantsKey('6'), true);
  firstIntro.typeKey('6');
  assert.equal(hangarInternal.stage, 'theme');
  assert.equal(firstIntro.loadout.pilot, 'cat');
  assert.ok(announcements.some((m) => m.includes('Step 2 of 3')));

  // Immediate key bounce before 0.25s on Step 2 is ignored
  firstIntro.typeKey('2');
  assert.equal(hangarInternal.stage, 'theme', 'step-transition grace blocks accidental double-press');

  firstIntro.update(HANGAR_STAGE_GRACE + 0.05, false);
  assert.equal(firstIntro.wantsKey('Backspace'), true);
  firstIntro.typeKey('Backspace');
  assert.equal(hangarInternal.stage, 'avatar');

  firstIntro.update(HANGAR_STAGE_GRACE + 0.05, false);
  const foxCard = hangarInternal.uiBoxes.avatarCards[4]!;
  assert.equal(firstIntro.pick(foxCard.x + foxCard.w / 2, foxCard.y + foxCard.h / 2), true);
  assert.equal(hangarInternal.stage, 'theme');
  assert.equal(firstIntro.loadout.pilot, 'fox');

  // Step 2: Pick colour theme #4 (`emerald` / Jade Mint)
  firstIntro.update(HANGAR_STAGE_GRACE + 0.05, false);
  {
    const { ctx, ink } = makeRecordingCanvas(1280, 800);
    const frame = { ctx, ink, w: 1280, h: 800, inset: { top: 0, right: 0, bottom: 0, left: 0 }, time: 1.0, touch: false };
    firstIntro.renderGround(frame);
    firstIntro.renderCockpit(frame);
  }
  const emeraldCard = hangarInternal.uiBoxes.themeCards[3]!;
  assert.equal(firstIntro.pick(emeraldCard.x + emeraldCard.w / 2, emeraldCard.y + emeraldCard.h / 2), true);
  assert.equal(hangarInternal.stage, 'ship');
  assert.equal(firstIntro.loadout.theme, 'emerald');
  assert.ok(announcements.some((m) => m.includes('Step 3 of 3')));

  // Step 3: Click directly on the 3D Bastion gunship in Bay 3
  firstIntro.update(HANGAR_STAGE_GRACE + 0.05, false);
  {
    const { ctx, ink } = makeRecordingCanvas(1280, 800);
    const frame = { ctx, ink, w: 1280, h: 800, inset: { top: 0, right: 0, bottom: 0, left: 0 }, time: 1.4, touch: false };
    firstIntro.renderGround(frame);
    firstIntro.renderCockpit(frame);
  }
  const shipTargets = hangarInternal.uiBoxes.shipTargets;
  assert.equal(shipTargets.length, 3);
  assert.ok(shipTargets[0]!.x < shipTargets[1]!.x && shipTargets[1]!.x < shipTargets[2]!.x, '3 bays span left to right');

  const bastionBox = shipTargets[2]!;
  assert.equal(firstIntro.pick(bastionBox.x + bastionBox.w / 2, bastionBox.y + bastionBox.h / 2), true);
  assert.equal(firstIntro.isPickingLoadout, false);
  assert.equal(hangarInternal.stage, 'boarding');
  assert.deepEqual(loadSavedLoadout(store), { pilot: 'fox', theme: 'emerald', ship: 'bastion' });
  assert.ok(announcements.some((m) => m.toLowerCase().includes('boarding bastion')));

  // Verify the walking pilot heads rightward across the hangar floor toward Bay 3 (`bastion` at x = +6.8)
  const poseMidWalk = (
    hangarInternal as unknown as {
      pilotPose: (s: (typeof SHIPS)[number], sx: number, sz: number, hat: string) => { x: number; y: number; z: number };
    }
  ).pilotPose(SHIP_BY_ID.bastion, SHIP_BY_ID.bastion.bay.x, SHIP_BY_ID.bastion.bay.z, PILOT_BY_ID.fox.hangarHat);
  firstIntro.update(2.2, false);
  const poseNearLadder = (
    hangarInternal as unknown as {
      pilotPose: (s: (typeof SHIPS)[number], sx: number, sz: number, hat: string) => { x: number; y: number; z: number };
    }
  ).pilotPose(SHIP_BY_ID.bastion, SHIP_BY_ID.bastion.bay.x, SHIP_BY_ID.bastion.bay.z, PILOT_BY_ID.fox.hangarHat);
  assert.ok(poseNearLadder.x > poseMidWalk.x + 1.5, 'pilot walks rightward across the hangar toward Bay 3 ladder');

  // Complete boarding into cockpit briefing
  for (let i = 0; i < 90; i++) {
    firstIntro.update(0.1, false);
    const { ctx, ink } = makeRecordingCanvas(1280, 800);
    const frame = { ctx, ink, w: 1280, h: 800, inset: { top: 0, right: 0, bottom: 0, left: 0 }, time: 2 + i * 0.1, touch: false };
    firstIntro.renderGround(frame);
    firstIntro.renderCockpit(frame);
    if ((firstIntro as { phase: string }).phase === 'brief') break;
  }
  assert.equal(firstIntro.phase, 'brief');
  assert.ok(cues.includes('step') && cues.includes('canopy'), 'played footsteps and canopy shut cues');

  // 2. Returning visit walks straight in; KeyH opens customiser, KeyC is untouched, and Quick Fly (`f`) commits in one press
  const secondIntro = new Intro(false, () => {}, undefined, { storage: store });
  assert.equal(secondIntro.phase, 'hangar');
  assert.equal(secondIntro.isPickingLoadout, false);
  assert.deepEqual(secondIntro.loadout, { pilot: 'fox', theme: 'emerald', ship: 'bastion' });
  assert.equal(secondIntro.command('KeyC'), false, 'KeyC must stay free for callsign cycling');
  assert.equal(secondIntro.command('KeyH'), true, 'KeyH re-opens Hangar customiser');
  assert.equal(secondIntro.isPickingLoadout, true);

  secondIntro.update(HANGAR_STAGE_GRACE + 0.05, false);
  secondIntro.command('ArrowRight'); // focus moves from fox (#4) to cat (#5)
  assert.equal(secondIntro.wantsKey('f'), true);
  secondIntro.typeKey('f'); // Quick Fly!
  assert.equal(secondIntro.isPickingLoadout, false);
  assert.equal(secondIntro.loadout.pilot, 'cat');

  // 3. Reduced motion: first visit lets player pick once, then jumps straight to cockpit briefing
  const rmStore = createMemoryStorage();
  const rmIntro = new Intro(true, () => {}, undefined, { storage: rmStore });
  assert.equal(rmIntro.phase, 'hangar');
  assert.equal(rmIntro.isPickingLoadout, true);
  rmIntro.update(HANGAR_STAGE_GRACE + 0.05, false);
  rmIntro.typeKey('1'); // pilot: nova
  rmIntro.update(HANGAR_STAGE_GRACE + 0.05, false);
  rmIntro.typeKey('2'); // theme: cyber
  rmIntro.update(HANGAR_STAGE_GRACE + 0.05, false);
  rmIntro.typeKey('1'); // ship: swift
  rmIntro.update(0.016, false);
  assert.equal(rmIntro.phase, 'brief');
  assert.deepEqual(loadSavedLoadout(rmStore), { pilot: 'nova', theme: 'cyber', ship: 'swift' });

  const rmReturning = new Intro(true, () => {}, undefined, { storage: rmStore });
  assert.equal(rmReturning.phase, 'brief');
});

test('set-piece physics: Swift, Starhawk, and Bastion all fly Easy/Hard asteroid lanes unscathed and refuel to 100% through Wave 10', () => {
  const fieldScreens = [
    [1440, 900],
    [390, 844],
    [844, 390],
    [320, 568],
  ] as const;

  const flyFieldWithShip = (
    shipId: 'swift' | 'starhawk' | 'bastion',
    w: number,
    h: number,
    wave: number,
    hard: boolean,
    delay: number,
    seed: number,
  ) => {
    const spec = SHIP_BY_ID[shipId];
    const scale = clamp(Math.min(w, h) / 700, h < 500 ? 0.62 : 0.85, 1.3);
    const pace = clamp(h / 760, 0.6, 1.35);
    const env = { w, h, left: 0, right: 0, scale, pace, wave, seed };
    const field = createField(env);
    const ship = { x: w / 2, y: h - Math.max(84, h * 0.14) };
    const dt = 1 / 60;
    const seen: number[] = [];
    const prizes = new Set<number>();
    let hits = 0;
    let safe = 0;
    let seconds = 0;
    while (!field.done && seconds < 90) {
      seconds += dt;
      safe -= dt;
      updateField(field, dt, dt, env);
      seen.push(gapAt(field, ship.y - 30 * scale, hard) ?? gapAt(field, ship.y - 120 * scale, hard) ?? ship.x);
      const aim = seen[Math.max(0, seen.length - 1 - Math.round(delay * 60))]!;
      if (Math.abs(aim - ship.x) > 5) {
        ship.x += Math.sign(aim - ship.x) * Math.min(Math.abs(aim - ship.x), 380 * spec.speedMul * scale * dt);
      }
      for (const rock of field.rocks) {
        if (!rock.tough || safe > 0) continue;
        if (Math.hypot(rock.x - ship.x, field.front - rock.d - ship.y) < rock.r * 0.9 + spec.hitRadius * scale) {
          hits++;
          safe = 2.2;
        }
      }
      field.prizes.forEach((p, i) => {
        if (Math.hypot(p.x - ship.x, field.front - p.d - ship.y) < (13 + 9) * scale) prizes.add(i);
      });
    }
    return { hits, prizes: prizes.size, totalPrizes: field.prizes.length };
  };

  for (const shipId of ['swift', 'starhawk', 'bastion'] as const) {
    for (const [w, h] of fieldScreens) {
      for (const wave of [1, 4, 8, 12]) {
        for (let s = 1; s <= 6; s++) {
          const seed = ((wave * 2654435761) ^ (s * 2246822519)) >>> 0 || 1;
          const easy = flyFieldWithShip(shipId, w, h, wave, false, 0.3, seed);
          assert.equal(easy.hits, 0, `${shipId} easy asteroid way ${w}x${h} wave ${wave} seed ${s}`);

          const hard = flyFieldWithShip(shipId, w, h, wave, true, 0.1, seed);
          assert.equal(hard.hits, 0, `${shipId} hard asteroid way ${w}x${h} wave ${wave} seed ${s}`);
          assert.equal(hard.prizes, hard.totalPrizes, `${shipId} collects all hard-way prizes ${w}x${h} wave ${wave}`);
        }
      }
    }
  }

  const tankerScreens = [
    [1440, 900],
    [390, 844],
    [844, 390],
  ] as const;

  const flyTankerWithShip = (shipId: 'swift' | 'starhawk' | 'bastion', w: number, h: number, wave: number) => {
    const spec = SHIP_BY_ID[shipId];
    const scale = clamp(Math.min(w, h) / 700, h < 500 ? 0.62 : 0.85, 1.3);
    const env = { w, h, top: 0, left: 0, right: 0, scale, noseX: w / 2, noseY: h * 0.8 };
    const ship = { x: w / 2, y: h * 0.86 };
    const t = createTanker(wave, env);
    const dt = 1 / 60;
    const speed = 380 * spec.speedMul * scale;
    const seen: Array<{ x: number; y: number }> = [];
    let seconds = 0;
    let snaps = 0;
    while (t.state !== 'gone' && seconds < 60) {
      seconds += dt;
      env.noseX = ship.x;
      env.noseY = ship.y - 18.4 * scale;
      const event = updateTanker(t, dt, env);
      if (event === 'snap') snaps++;
      const tail = tankerTail(t, scale);
      seen.push(t.hooked ? { x: tail.x, y: tail.y + 104 * scale } : { x: t.drogue.x, y: t.drogue.y + 18.4 * scale });
      const aim = seen[Math.max(0, seen.length - 1 - Math.round(0.12 * 60))]!;
      let dx = Math.abs(aim.x - ship.x) > 6 * scale ? Math.sign(aim.x - ship.x) : 0;
      let dy = Math.abs(aim.y - ship.y) > 6 * scale ? Math.sign(aim.y - ship.y) : 0;
      if (dx && dy) {
        dx *= Math.SQRT1_2;
        dy *= Math.SQRT1_2;
      }
      ship.x += dx * speed * dt;
      ship.y = clamp(ship.y + dy * speed * dt, h * 0.3, h - 20);
    }
    return { fuel: t.fuel, snaps, seconds };
  };

  for (const shipId of ['swift', 'starhawk', 'bastion'] as const) {
    for (const [w, h] of tankerScreens) {
      for (const wave of [1, 10]) {
        const runs = Array.from({ length: 30 }, () => flyTankerWithShip(shipId, w, h, wave));
        assert.ok(runs.every((r) => r.fuel >= 1), `${shipId} fills fuel tank on ${w}x${h} wave ${wave}`);
        const avgSeconds = runs.reduce((sum, r) => sum + r.seconds, 0) / runs.length;
        assert.ok(avgSeconds < FUEL_SECONDS + 5.5, `${shipId} refuels promptly (${avgSeconds.toFixed(1)}s) on ${w}x${h} wave ${wave}`);
      }
    }
  }
});

test('Game integration: ship speeds (keyboard & touch), weapons, 5-hull 320px HUD, KeyH vs KeyC, HeroGame button, and privacy disclosure', () => {
  sharedLocalStorage.clear();

  assert.equal(shipShape('swift'), SHIP_SWIFT);
  assert.equal(shipShape('starhawk'), SHIP);
  assert.equal(shipShape('bastion'), SHIP_BASTION);
  assert.notDeepEqual(SHIP_SWIFT, SHIP);
  assert.notDeepEqual(SHIP_BASTION, SHIP);

  for (const id of ['swift', 'starhawk', 'bastion'] as const) {
    const { ctx, ink, strokes } = makeRecordingCanvas(200, 200);
    ink('#ff6ec7', 1, 1.5, () => traceShipThrusters(ctx, id, 100, 100, 1, 10));
    assert.ok(strokes[0]!.lines >= 2, `${id} thrusters draw cleanly`);
  }

  const runShipTrial = (
    pilot: 'nova' | 'owl' | 'wolf',
    theme: 'cyber' | 'solar' | 'plasma',
    ship: 'swift' | 'starhawk' | 'bastion',
  ) => {
    sharedLocalStorage.clear();
    saveLoadout({ pilot, theme, ship }, sharedLocalStorage);

    const { canvas, strokes } = makeRecordingCanvas(1280, 800);
    const game = new Game(canvas as unknown as HTMLCanvasElement, {
      multiplayer: makeFakeMultiplayer() as never,
      onExit() {},
      onStatus() {},
      onPause() {},
      onLeaderboard() {},
    }) as unknown as Record<string, any>;

    assert.equal(game.intro.isPickingLoadout, false);
    assert.equal(game.maxHull, SHIP_BY_ID[ship].baseHull);
    assert.equal(game.hull, SHIP_BY_ID[ship].baseHull);

    game.intro = null;
    game.grade = 1;
    game.begin();
    game.questions.brk = null;
    game.ship.x = 640;
    game.ship.y = 640;
    game.energy = 0.75;

    const startX = game.ship.x as number;
    winTarget.dispatchEvent(makeKeyEvent('keydown', 'ArrowRight', 'ArrowRight'));
    winTarget.dispatchEvent(makeKeyEvent('keydown', 'Space', ' '));

    let volleys = 0;
    const origPlay = game.sound.play.bind(game.sound);
    game.sound.play = (sfx: string) => {
      if (sfx === 'shot') volleys += 1;
      return origPlay(sfx);
    };

    const collectedShots: Array<{ color: string; pierce?: number; stray?: boolean }> = [];
    for (let i = 0; i < 60; i++) {
      game.shots = [];
      game.updateShip(1 / 60);
      if (game.shots.length > 0) {
        collectedShots.push(...(game.shots as Array<{ color: string; pierce?: number; stray?: boolean }>));
      }
    }

    const distanceMoved = (game.ship.x as number) - startX;
    winTarget.dispatchEvent(makeKeyEvent('keyup', 'ArrowRight', 'ArrowRight'));
    winTarget.dispatchEvent(makeKeyEvent('keyup', 'Space', ' '));

    // Also measure touch finger-chase distance over 0.25s toward a far target
    game.ship.x = 200;
    game.ship.y = 640;
    canvas.dispatchEvent(makePointerEvent('pointerdown', 1100, 640, 'touch', 7));
    for (let i = 0; i < 15; i++) {
      game.updateShip(1 / 60);
    }
    const touchDistanceMoved = (game.ship.x as number) - 200;
    winTarget.dispatchEvent(makePointerEvent('pointerup', 1100, 640, 'touch', 7));

    strokes.length = 0;
    game.render();
    const renderedColors = new Set(strokes.map((s) => s.color));

    game.equip('armour');
    const armouredMaxHull = game.maxHull as number;

    game.destroy();
    return {
      baseHull: SHIP_BY_ID[ship].baseHull,
      armouredMaxHull,
      distanceMoved,
      touchDistanceMoved,
      volleys,
      collectedShots,
      renderedColors,
    };
  };

  const swiftRun = runShipTrial('owl', 'cyber', 'swift');
  const hawkRun = runShipTrial('nova', 'solar', 'starhawk');
  const bastionRun = runShipTrial('wolf', 'plasma', 'bastion');

  assert.equal(swiftRun.baseHull, 2);
  assert.equal(swiftRun.armouredMaxHull, 3);
  assert.equal(hawkRun.baseHull, 3);
  assert.equal(hawkRun.armouredMaxHull, 4);
  assert.equal(bastionRun.baseHull, 4);
  assert.equal(bastionRun.armouredMaxHull, 5);

  // Keyboard & touch agility both scale cleanly by speedMul (1.20 > 1.00 > 0.88)
  assert.ok(swiftRun.distanceMoved > hawkRun.distanceMoved * 1.15);
  assert.ok(bastionRun.distanceMoved < hawkRun.distanceMoved * 0.91);
  assert.ok(swiftRun.touchDistanceMoved > hawkRun.touchDistanceMoved * 1.15);
  assert.ok(bastionRun.touchDistanceMoved < hawkRun.touchDistanceMoved * 0.91);

  // Fire rate & weapon traits
  assert.ok(swiftRun.volleys > hawkRun.volleys, 'Swift fires faster than Starhawk');
  assert.ok(bastionRun.volleys < hawkRun.volleys, 'Bastion fires slower heavy volleys than Starhawk');
  assert.ok(bastionRun.collectedShots.every((s) => (s.pierce ?? 0) >= 1), 'Bastion cannons carry +1 pierce');

  // Crisp SAND bolts + distinct theme hull tinting
  assert.ok(swiftRun.collectedShots.every((s) => s.color === SAND));
  assert.ok(hawkRun.collectedShots.every((s) => s.color === SAND));
  assert.ok(bastionRun.collectedShots.every((s) => s.color === SAND));
  assert.ok(swiftRun.renderedColors.has(THEME_BY_ID.cyber.hull));
  assert.ok(hawkRun.renderedColors.has(THEME_BY_ID.solar.hull));
  assert.ok(bastionRun.renderedColors.has(THEME_BY_ID.plasma.hull));

  // Sum Boss safety: Bastion wingtip pods mark `stray: true` during boss fights
  const bossShots: Parameters<typeof fireVolley>[0] = [];
  fireVolley(bossShots, 500, 700, 0.9, 1, 1, 1, true, new Set(), SAND, 'bastion');
  const wideBossShots = bossShots.filter((s) => Math.abs(s.x - 500) >= 10);
  assert.ok(wideBossShots.length === 2 && wideBossShots.every((s) => s.stray === true));

  const bossEnv = {
    w: 1000,
    h: 800,
    top: 0,
    scale: 1,
    pace: 1,
    headroom: 104,
    sweep: Infinity,
    calm: false,
    shipX: 500,
    shipY: 700,
    fire() {},
    bomb() {},
    burst() {},
    problem: () => ({ question: '2 + 3', answer: 5, options: [4, 5, 6] }),
  };
  const sumBoss = createBoss(2, bossEnv);
  for (let i = 0; i < 30; i++) updateBoss(sumBoss, 0.1, bossEnv, 0.1);
  const parts = bossParts(sumBoss, bossEnv, 3.0);
  const wrongPart = parts.find((p) => p.label !== undefined && Number(p.label) !== sumBoss.problem?.answer);
  assert.ok(wrongPart);
  assert.notEqual(shootBoss(sumBoss, wrongPart.x, wrongPart.y, bossEnv, false), 'wrong');

  // 5-hull Bastion HUD at 320x568 + KeyC callsign preservation + KeyH / openHangarCustomizer() + onHangar state
  sharedLocalStorage.clear();
  saveLoadout({ pilot: 'wolf', theme: 'plasma', ship: 'bastion' }, sharedLocalStorage);
  let callsignCycles = 0;
  const hangarStates: Array<[boolean, boolean]> = [];
  const { canvas: narrowCanvas } = makeRecordingCanvas(320, 568);
  const narrowGame = new Game(narrowCanvas as unknown as HTMLCanvasElement, {
    multiplayer: makeFakeMultiplayer(() => {
      callsignCycles += 1;
    }) as never,
    onExit() {},
    onStatus() {},
    onPause() {},
    onLeaderboard() {},
    onHangar: (avail, active) => hangarStates.push([avail, active]),
  }) as unknown as Record<string, any>;

  // Available during Hangar boarding (`active = false`)
  assert.deepEqual(hangarStates.at(-1), [true, false]);

  // Enter flight, equip armour (5 hull icons on 320px width), and verify HUD hides Hangar button while actively flying
  narrowGame.intro = null;
  narrowGame.grade = 1;
  narrowGame.begin();
  narrowGame.equip('armour');
  assert.equal(narrowGame.maxHull, 5);
  narrowGame.render();
  assert.deepEqual(hangarStates.at(-1), [false, false], 'Hangar toolbar button hides during unpaused flight so 320px HUD stays uncluttered');

  // Pause flight -> Hangar button becomes available (`[true, false]`); KeyC cycles callsign while KeyH / button opens Hangar
  narrowGame.togglePause();
  assert.deepEqual(hangarStates.at(-1), [true, false]);
  winTarget.dispatchEvent(makeKeyEvent('keydown', 'KeyC', 'c'));
  winTarget.dispatchEvent(makeKeyEvent('keyup', 'KeyC', 'c'));
  assert.equal(callsignCycles, 1);
  assert.equal(narrowGame.state, 'playing');

  assert.equal(narrowGame.openHangarCustomizer(), true);
  assert.equal(narrowGame.state, 'ready');
  assert.equal(narrowGame.intro.isPickingLoadout, true);
  assert.deepEqual(hangarStates.at(-1), [true, true]);

  // Pressing Hangar button again while picking triggers Quick Fly (`[true, false]`)
  assert.equal(narrowGame.openHangarCustomizer(), true);
  assert.equal(narrowGame.intro.isPickingLoadout, false);
  assert.deepEqual(hangarStates.at(-1), [true, false]);
  narrowGame.destroy();

  // First-visit pointer hover & click flow through Game canvas (respecting 0.25s step grace)
  sharedLocalStorage.clear();
  const { canvas } = makeRecordingCanvas(1280, 800);
  const liveGame = new Game(canvas as unknown as HTMLCanvasElement, {
    multiplayer: makeFakeMultiplayer() as never,
    onExit() {},
    onStatus() {},
    onPause() {},
    onLeaderboard() {},
  }) as unknown as Record<string, any>;

  const inputHost = liveGame.input.host as Record<string, unknown>;
  assert.equal(inputHost.pointerMove, undefined);
  assert.equal(inputHost.pointerDown, undefined);

  liveGame.intro.update(HANGAR_STAGE_GRACE + 0.05, false);
  liveGame.render();
  const hg = liveGame.intro.hangar as InstanceType<typeof Hangar>;
  const leoBox = hg.uiBoxes.avatarCards[1]!;
  canvas.dispatchEvent(makePointerEvent('pointermove', leoBox.x + 10, leoBox.y + 10, 'mouse'));
  assert.equal(liveGame.intro.loadout.pilot, 'leo');
  canvas.dispatchEvent(makePointerEvent('pointerdown', leoBox.x + 10, leoBox.y + 10, 'mouse'));
  canvas.dispatchEvent(makePointerEvent('pointerup', leoBox.x + 10, leoBox.y + 10, 'mouse'));
  assert.equal(hg.stage, 'theme');

  liveGame.intro.update(HANGAR_STAGE_GRACE + 0.05, false);
  liveGame.render();
  const nebulaBox = hg.uiBoxes.themeCards[4]!;
  canvas.dispatchEvent(makePointerEvent('pointerdown', nebulaBox.x + 10, nebulaBox.y + 10, 'mouse'));
  canvas.dispatchEvent(makePointerEvent('pointerup', nebulaBox.x + 10, nebulaBox.y + 10, 'mouse'));
  assert.equal(hg.stage, 'ship');

  liveGame.intro.update(HANGAR_STAGE_GRACE + 0.05, false);
  liveGame.render();
  const swiftPlaque = hg.uiBoxes.shipPlaques[0]!;
  canvas.dispatchEvent(makePointerEvent('pointerdown', swiftPlaque.x + 10, swiftPlaque.y + 10, 'mouse'));
  canvas.dispatchEvent(makePointerEvent('pointerup', swiftPlaque.x + 10, swiftPlaque.y + 10, 'mouse'));
  assert.equal(hg.stage, 'boarding');
  assert.deepEqual(loadSavedLoadout(sharedLocalStorage), { pilot: 'leo', theme: 'nebula', ship: 'swift' });
  assert.equal(liveGame.maxHull, 2);

  liveGame.destroy();
  sharedLocalStorage.clear();

  // Verify HeroGame.astro markup & Privacy disclosure text
  const heroGameSrc = readFileSync(new URL('../src/components/HeroGame.astro', import.meta.url), 'utf8');
  assert.ok(heroGameSrc.includes('data-game-hangar'), 'HeroGame.astro renders [data-game-hangar] button');
  assert.ok(heroGameSrc.includes('openHangarCustomizer'), 'HeroGame.astro wires button to game.openHangarCustomizer()');

  const privacySrc = readFileSync(new URL('../src/pages/privacy.astro', import.meta.url), 'utf8');
  assert.ok(privacySrc.includes('stores five things on your own device'), 'privacy.astro updates local item count to five');
  assert.ok(
    privacySrc.includes('which pilot face, colour theme and ship you picked in the hangar (kept on your device only and never sent anywhere)'),
    'privacy.astro explicitly states local-only device storage',
  );
  assert.equal(trust.updated, '13 November 2026');
});

test('hangar living squad scenario: chosen pilot wears avatar head + theme colours, and all 7 other pilots populate randomized antics & cadet dances', () => {
  // 1. Every chosen pilot walks to their ship wearing their theme hull colour + avatar accent colour,
  //    while the other 7 named avatars appear in the hangar in their own base + accent colours.
  for (const chosenId of PILOT_IDS) {
    const chosenSpec = PILOT_BY_ID[chosenId];
    const theme = THEME_BY_ID.solar;
    const hangar = new Hangar(() => {}, {
      initialLoadout: { pilot: chosenId, theme: 'solar', ship: 'bastion' },
      hasSavedLoadout: true,
      reduceMotion: false,
      scenarioSeed: 4242,
    });
    assert.equal(hangar.stage, 'boarding');
    assert.equal(hangar.scenario.rosterOrder.length, PILOT_IDS.length);
    assert.deepEqual([...hangar.scenario.rosterOrder].sort(), [...PILOT_IDS].sort());

    hangar.update(2.2); // mid-walk across hangar floor toward Bay 3
    const { ctx, ink, strokes } = makeRecordingCanvas(1280, 800);
    hangar.render({
      ctx,
      ink,
      w: 1280,
      h: 800,
      inset: { top: 0, right: 0, bottom: 0, left: 0 },
      time: 2.2,
      touch: false,
      reduceMotion: false,
    });

    const drawnColors = new Set(strokes.map((s) => s.color));
    assert.ok(drawnColors.has(theme.hull), `boarding ${chosenId} strokes chosen theme hull (${theme.hull})`);
    assert.ok(
      drawnColors.has(chosenSpec.colors.accent),
      `boarding ${chosenId} strokes chosen avatar accent (${chosenSpec.colors.accent})`,
    );

    const squadmates = PILOTS.filter((p) => p.id !== chosenId);
    assert.equal(squadmates.length, 7);
    for (const mate of squadmates) {
      assert.ok(
        drawnColors.has(mate.colors.base),
        `squadmate ${mate.id} base colour (${mate.colors.base}) rendered when ${chosenId} boards`,
      );
      assert.ok(
        drawnColors.has(mate.colors.accent),
        `squadmate ${mate.id} accent colour (${mate.colors.accent}) rendered when ${chosenId} boards`,
      );
    }
  }

  // 2. Randomized scenarios cover all 6 activities, all 3 catch zones, and all 4 cadet dances cleanly,
  //    and re-opening the customizer rolls a fresh scenario each visit.
  const seenActivities = new Set<string>();
  const seenCatchZones = new Set<string>();
  const seenDances = new Set<string>();
  const seenOrders = new Set<string>();

  for (let seed = 1; seed <= 50; seed++) {
    const hangar = new Hangar(() => {}, {
      initialLoadout: { pilot: 'fox', theme: 'nebula', ship: 'swift' },
      hasSavedLoadout: true,
      reduceMotion: false,
      scenarioSeed: seed * 7919,
    });
    for (const act of hangar.scenario.antics) seenActivities.add(act);
    seenCatchZones.add(hangar.scenario.catchZone);
    for (const d of hangar.scenario.dances) seenDances.add(d);
    seenOrders.add(hangar.scenario.rosterOrder.join(','));

    // Render across multiple timestamps (including spontaneous cadet dance bursts) and with reduceMotion
    for (const [t, rm] of [
      [0.8, false],
      [3.1, false],
      [8.6, false],
      [2.0, true],
    ] as const) {
      const { ctx, ink, strokes } = makeRecordingCanvas(1280, 800);
      hangar.render({
        ctx,
        ink,
        w: 1280,
        h: 800,
        inset: { top: 0, right: 0, bottom: 0, left: 0 },
        time: t,
        touch: false,
        reduceMotion: rm,
      });
      const totalSegments = strokes.reduce((sum, s) => sum + s.lines, 0);
      assert.ok(
        strokes.length > 20 && totalSegments > 500,
        `seed ${seed} renders rich 3D hangar squad at t=${t}, reduceMotion=${rm} (batches=${strokes.length}, segments=${totalSegments})`,
      );
    }
  }

  assert.deepEqual(
    [...seenActivities].sort(),
    ['dance', 'eat', 'jacks', 'mathExtra', 'practice', 'sleep'],
    'all 6 hangar antics appear across random scenarios',
  );
  assert.deepEqual(
    [...seenCatchZones].sort(),
    ['leftApron', 'midRunway', 'rightApron'],
    'all 3 ball-toss catch zones appear across random scenarios',
  );
  assert.deepEqual(
    [...seenDances].sort(),
    ['boogie', 'hype', 'starhop', 'wave'],
    'all 4 cadet dances appear across random scenarios',
  );
  assert.ok(seenOrders.size > 20, 'squadmate roster order shuffles across visits');

  // Re-opening customizer reseeds the scenario
  const reseedProbe = new Hangar(() => {}, {
    initialLoadout: DEFAULT_LOADOUT,
    hasSavedLoadout: true,
    reduceMotion: false,
    scenarioSeed: 12345,
  });
  const firstSeed = reseedProbe.scenario.seed;
  reseedProbe.openCustomizer();
  const secondSeed = reseedProbe.scenario.seed;
  assert.notEqual(firstSeed, secondSeed, 'openCustomizer() rolls a new hangar scenario');
});
