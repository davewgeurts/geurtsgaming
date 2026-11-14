import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import { test } from 'node:test';
import { CoopRoom } from '../relay/room.mjs';

// Minimal DOM environment before importing `src/game/game.ts` (`sound.ts` touches `window` at load time).
const media = { coarse: false, reducedMotion: false };
const g = globalThis as Record<string, unknown>;
const winTarget = new EventTarget() as EventTarget & Record<string, unknown>;
winTarget.devicePixelRatio = 1;
const docTarget = new EventTarget() as EventTarget & { hidden: boolean } & Record<string, unknown>;
docTarget.hidden = false;
setMaxListeners(50, winTarget, docTarget);

let fakeNowMs = 50_000;
let nextTimerId = 1;
const activeIntervals = new Map<number, { fn: () => void; ms: number; nextAt: number }>();

g.performance = { now: () => fakeNowMs };
g.setInterval = ((fn: () => void, ms?: number) => {
  const id = nextTimerId++;
  const stepMs = Math.max(1, Number(ms) || 1);
  activeIntervals.set(id, { fn, ms: stepMs, nextAt: fakeNowMs + stepMs });
  return id;
}) as unknown as typeof setInterval;
g.clearInterval = ((id?: number) => {
  if (typeof id === 'number') activeIntervals.delete(id);
}) as unknown as typeof clearInterval;

function advanceTimeMs(totalMs: number): void {
  const end = fakeNowMs + totalMs;
  while (fakeNowMs < end) {
    let nextFire = end;
    for (const timer of activeIntervals.values()) {
      if (timer.nextAt < nextFire) nextFire = timer.nextAt;
    }
    fakeNowMs = nextFire;
    for (const [id, timer] of [...activeIntervals.entries()]) {
      if (!activeIntervals.has(id)) continue;
      if (timer.nextAt <= fakeNowMs) {
        timer.nextAt += timer.ms;
        timer.fn();
      }
    }
  }
}

function createDomStorage(): Storage & { rawMap: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    rawMap: map,
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
  } as Storage & { rawMap: Map<string, string> };
}

const domLocalStorage = createDomStorage();
const domSessionStorage = createDomStorage();

g.window = winTarget;
g.document = docTarget;
g.addEventListener = winTarget.addEventListener.bind(winTarget);
g.removeEventListener = winTarget.removeEventListener.bind(winTarget);
g.matchMedia = (q: string) => ({
  matches: q.includes('coarse') ? media.coarse : q.includes('reduced-motion') ? media.reducedMotion : false,
  addEventListener() {},
  removeEventListener() {},
});
g.localStorage = domLocalStorage;
g.sessionStorage = domSessionStorage;
g.getComputedStyle = () => ({
  paddingTop: '0px',
  paddingRight: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',
});
g.requestAnimationFrame = () => 1;
g.cancelAnimationFrame = () => {};

const { Game } = await import('../src/game/game');
const { CoopClient } = await import('../src/game/coop-client');
const { CoopFlightDirector, formationSpawnForSeat, COOP_QUIZ_TIMEOUT_SEC, COOP_STALE_HOLD_MAX_SEC } = await import(
  '../src/game/coop-flight'
);
const { setCoopTabGrade, getCoopTabGrade } = await import('../src/game/coop-quiz');
const { deckCardBoxes, hitTestDeckCard } = await import('../src/game/coop-thumbdeck');
const { decodeWorldSnapshot, encodeWorldSnapshot, COOP_WORLD_W, COOP_WORLD_H } = await import('../src/game/coop-protocol');
const { NEON, strokeInk } = await import('../src/game/core');
const { makeEnemy } = await import('../src/game/enemies');
const { SetPieces } = await import('../src/game/setpieces');

import type { StorageLike } from '../src/game/coop-client';
import type { CoopMineItem, CoopPickupItem, CoopWorldAdapter } from '../src/game/coop-flight';
import type { CoopPublicSeat } from '../src/game/coop-types';
import type { Boss } from '../src/game/boss';
import type { Enemy } from '../src/game/enemies';
import type { Grade } from '../src/game/fireworks';
import type { GradeBand } from '../src/game/questions';
import type { UpgradeId } from '../src/game/upgrades';
import type { Beam, Ring, Rocket, Shot } from '../src/game/weapons';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function createRoomBridge(room: InstanceType<typeof CoopRoom>, nowFn: () => number) {
  const allJsonFrames: Array<Record<string, unknown>> = [];

  class RoomBridgeWs extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readonly url: string;
    readyState = RoomBridgeWs.CONNECTING;
    binaryType = 'arraybuffer';
    private peerConn: {
      sendText: (s: string) => void;
      sendBinary: (u8: Uint8Array) => void;
      close: (code: number, reason: string) => void;
      setAttachment: () => void;
    };

    constructor(url: string) {
      super();
      this.url = url;
      const parsed = new URL(this.url);
      const cid = parsed.searchParams.get('cid') || '';

      this.peerConn = {
        sendText: (str: string) => {
          try {
            allJsonFrames.push(JSON.parse(str) as Record<string, unknown>);
          } catch {
            /* ignore */
          }
          queueMicrotask(() => {
            if (this.readyState === RoomBridgeWs.CLOSED) return;
            this.dispatchEvent(new MessageEvent('message', { data: str }));
          });
        },
        sendBinary: (u8: Uint8Array) => {
          queueMicrotask(() => {
            if (this.readyState === RoomBridgeWs.CLOSED) return;
            const copy = new Uint8Array(u8);
            this.dispatchEvent(new MessageEvent('message', { data: copy.buffer }));
          });
        },
        close: (code: number, reason: string) => {
          queueMicrotask(() => {
            if (this.readyState === RoomBridgeWs.CLOSED) return;
            this.readyState = RoomBridgeWs.CLOSED;
            this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
          });
        },
        setAttachment: () => {},
      };

      queueMicrotask(() => {
        if (this.readyState === RoomBridgeWs.CLOSED) return;
        this.readyState = RoomBridgeWs.OPEN;
        this.dispatchEvent(new Event('open'));
        room.connect(this.peerConn, {
          role: parsed.searchParams.get('role') === 'host' ? 'host' : 'guest',
          callsign: parsed.searchParams.get('callsign') || '',
          token: parsed.searchParams.get('token') || '',
          tvMode: parsed.searchParams.get('tv') === '1',
          clientId: cid,
          now: nowFn(),
        });
      });
    }

    send(data: string | Uint8Array): void {
      if (this.readyState !== RoomBridgeWs.OPEN) return;
      if (typeof data === 'string') {
        try {
          allJsonFrames.push(JSON.parse(data) as Record<string, unknown>);
        } catch {
          /* ignore */
        }
        room.handleText(this.peerConn, data, nowFn());
      } else {
        room.handleBinary(this.peerConn, new Uint8Array(data), nowFn());
      }
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState === RoomBridgeWs.CLOSED) return;
      this.readyState = RoomBridgeWs.CLOSED;
      room.disconnect(this.peerConn, nowFn());
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
    }
  }

  return { WsCtor: RoomBridgeWs, allJsonFrames };
}

const realSetTimeout = globalThis.setTimeout;

async function flushWs(): Promise<void> {
  await new Promise<void>((resolve) => realSetTimeout(resolve, 8));
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

class HeadlessWorld implements CoopWorldAdapter {
  wave = 1;
  banner = 0;
  score = 0;
  freed = 0;
  energy = 0.5;
  paused = false;
  parked = false;
  gameOver = false;
  enemies: Enemy[] = [];
  shots: Shot[] = [];
  rockets: Rocket[] = [];
  beams: Beam[] = [];
  pickups: CoopPickupItem[] = [];
  mines: CoopMineItem[] = [];
  rings: Ring[] = [];
  upgrades = new Set<UpgradeId>();
  boss: Boss | null = null;
  sets = new SetPieces();
  grade: GradeBand | null = null;
  startedWaves: number[] = [];

  constructor() {
    this.sets.reset();
  }

  setEnv() {
    return {
      w: COOP_WORLD_W,
      h: COOP_WORLD_H,
      top: 0,
      left: 0,
      right: 0,
      scale: 1,
      pace: 1,
      shipScale: 1.15,
      wave: this.wave,
      time: 0,
      playing: !this.gameOver,
      shipX: COOP_WORLD_W / 2,
      shipY: COOP_WORLD_H * 0.85,
      seeded: true,
      play: () => {},
      say: () => {},
      radio: () => {},
      call: () => {},
      feel: () => {},
      award: (pts: number) => {
        this.score += pts;
      },
      charge: (amt: number) => {
        this.energy = Math.min(1, this.energy + amt);
      },
      ring: (x: number, y: number, color: string, reach?: number) => {
        this.rings.push({ x, y, age: 0, color, reach });
      },
      spark: () => {},
      burst: () => {},
      bomb: (x: number, y: number, ride?: number) => {
        this.mines.push({ x, y, anchorX: x, phase: 0, age: 0, dead: false, thrown: false, ride });
      },
      capsule: (x: number, y: number, ride?: number, last?: boolean) => {
        this.pickups.push({
          reward: last ? 'upgrade' : 'energy',
          x,
          y,
          anchorX: x,
          phase: 0,
          age: 0,
          dead: false,
          ride,
        });
      },
    };
  }

  play(): void {}
  spark(): void {}
  burst(): void {}
  ring(x: number, y: number, color: string, reach?: number): void {
    this.rings.push({ x, y, age: 0, color, reach });
  }
  free(_x: number, _y: number, count = 1): void {
    this.freed += count;
  }
  strikeBoss(): boolean {
    return false;
  }
  damageEnemy(e: Enemy, amount: number): void {
    if (e.dead) return;
    e.hp -= amount;
    if (e.hp <= 0) this.destroyEnemy(e);
  }
  destroyEnemy(e: Enemy): void {
    e.dead = true;
    this.score += 100;
    this.freed += 1;
  }
  equipUpgrade(id: UpgradeId): void {
    this.upgrades.add(id);
  }
  detonateScreen(): void {
    for (const e of this.enemies) e.dead = true;
    for (const s of this.shots) if (s.hostile) s.dead = true;
  }
  triggerSquadGameOver(): void {
    this.gameOver = true;
  }
  resumeSquadNewRun(): void {
    this.gameOver = false;
  }
  setHostPausedFromWire(paused: boolean): void {
    this.paused = paused;
  }
  startWave(wave: number): void {
    this.wave = wave;
    this.parked = false;
    this.startedWaves.push(wave);
  }
  getGrade(): GradeBand | null {
    return this.grade;
  }
  setGrade(grade: GradeBand): void {
    this.grade = grade;
  }
}

function makeRecordingCanvas(w = 1280, h = 800) {
  const c = new EventTarget() as EventTarget & {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    parentElement: null;
    getContext: () => CanvasRenderingContext2D;
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
    setPointerCapture: () => void;
    drawnPoints: Array<{ x: number; y: number }>;
    clipRects: Array<{ x: number; y: number; w: number; h: number }>;
  };

  let curMatrix = { a: 1, d: 1, e: 0, f: 0 };
  const matrixStack: Array<{ a: number; d: number; e: number; f: number }> = [];
  const drawnPoints: Array<{ x: number; y: number }> = [];
  const clipRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  let pendingRect: { x: number; y: number; w: number; h: number } | null = null;

  const recordPt = (lx: number, ly: number) => {
    drawnPoints.push({
      x: lx * curMatrix.a + curMatrix.e,
      y: ly * curMatrix.d + curMatrix.f,
    });
  };

  const ctxStore: Record<string | symbol, unknown> = {
    canvas: c,
    save: () => {
      matrixStack.push({ ...curMatrix });
    },
    restore: () => {
      const prev = matrixStack.pop();
      if (prev) curMatrix = prev;
    },
    setTransform: (a: number, _b: number, _c: number, d: number, e: number, f: number) => {
      curMatrix = { a, d, e, f };
    },
    translate: (tx: number, ty: number) => {
      curMatrix = {
        ...curMatrix,
        e: curMatrix.e + tx * curMatrix.a,
        f: curMatrix.f + ty * curMatrix.d,
      };
    },
    scale: (sx: number, sy: number) => {
      curMatrix = {
        ...curMatrix,
        a: curMatrix.a * sx,
        d: curMatrix.d * sy,
      };
    },
    moveTo: (x: number, y: number) => recordPt(x, y),
    lineTo: (x: number, y: number) => recordPt(x, y),
    rect: (x: number, y: number, rw: number, rh: number) => {
      pendingRect = {
        x: x * curMatrix.a + curMatrix.e,
        y: y * curMatrix.d + curMatrix.f,
        w: rw * curMatrix.a,
        h: rh * curMatrix.d,
      };
      recordPt(x, y);
    },
    clip: () => {
      if (pendingRect) clipRects.push(pendingRect);
    },
    beginPath: () => {
      pendingRect = null;
    },
  };

  const ctx = new Proxy(ctxStore, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') {
        return () => ({ addColorStop() {} });
      }
      if (p === 'getTransform') return () => ({ a: curMatrix.a, b: 0, c: 0, d: curMatrix.d, e: curMatrix.e, f: curMatrix.f });
      if (p === 'isPointInPath' || p === 'isPointInStroke') return () => false;
      return () => {};
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  Object.assign(c, {
    clientWidth: w,
    clientHeight: h,
    width: w,
    height: h,
    parentElement: null,
    drawnPoints,
    clipRects,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: c.clientWidth, height: c.clientHeight }),
    setPointerCapture: () => {},
  });
  return c;
}

function makeFakeMultiplayer(scoreLog: Array<{ score: number; wave: number; freed: number }> = []) {
  return {
    wingmen: [],
    lasers: [],
    start() {},
    stop() {},
    rest() {},
    updateFlight() {},
    recordScore: (score: number, wave: number, freed: number) => {
      scoreLog.push({ score, wave, freed });
      return 1;
    },
    cycleCallsign: () => 'ACE-1',
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

function makePointerEvent(type: string, pointerId: number, x: number, y: number, pointerType: 'touch' | 'mouse' = 'touch') {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerId,
    pointerType,
    button: 0,
    clientX: x,
    clientY: y,
  });
}

function makeKeyEvent(type: string, key: string, code: string) {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    key,
    code,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });
}

const IDLE_CTRL = {
  across: 0,
  down: 0,
  touching: false,
  touchX: 0,
  touchY: 0,
  firing: false,
};

async function createLiveSquad(opts?: { tvMode?: boolean; guestCount?: number; nowFn?: () => number }) {
  let simNow = 10_000;
  const nowFn = opts?.nowFn ?? (() => simNow);
  const room = new CoopRoom('PH3TST', { now: nowFn() });
  const bridge = createRoomBridge(room, nowFn);
  const tvMode = Boolean(opts?.tvMode);
  const guestCount = opts?.guestCount ?? 1;

  const hostStorage = new MemoryStorage();
  const hostClient = new CoopClient({
    code: 'PH3TST',
    role: 'host',
    callsign: 'HOST-1',
    tvMode,
    wsBase: 'ws://relay.test',
    storage: hostStorage,
    WebSocketConstructor: bridge.WsCtor,
    pingIntervalMs: 0,
  });

  hostClient.connect();
  await flushWs();

  const guestClients: InstanceType<typeof CoopClient>[] = [];
  const guestStorages: MemoryStorage[] = [];
  for (let i = 0; i < guestCount; i++) {
    const gs = new MemoryStorage();
    const gc = new CoopClient({
      code: 'PH3TST',
      role: 'guest',
      callsign: `WING-${i + 2}`,
      wsBase: 'ws://relay.test',
      storage: gs,
      WebSocketConstructor: bridge.WsCtor,
      pingIntervalMs: 0,
    });
    gc.connect();
    await flushWs();
    gc.setReady(true);
    await flushWs();
    guestClients.push(gc);
    guestStorages.push(gs);
  }

  hostClient.startSquad();
  await flushWs();

  const seats: readonly CoopPublicSeat[] = hostClient.seats;
  const hostWorld = new HeadlessWorld();
  const hostDir = new CoopFlightDirector({
    client: hostClient,
    initialSeats: seats,
    storage: hostStorage,
    now: () => nowFn(),
  });
  hostDir.bindWorld(hostWorld);
  hostDir.setViewport(1280, 800, {}, false);

  const guestWorlds: HeadlessWorld[] = [];
  const guestDirs: InstanceType<typeof CoopFlightDirector>[] = [];
  for (let i = 0; i < guestClients.length; i++) {
    const gw = new HeadlessWorld();
    const gd = new CoopFlightDirector({
      client: guestClients[i]!,
      initialSeats: seats,
      storage: guestStorages[i]!,
      now: () => nowFn(),
    });
    gd.bindWorld(gw);
    gd.setViewport(390, 844, {}, true);
    guestWorlds.push(gw);
    guestDirs.push(gd);
  }

  const tickSquad = async (frames = 1, dt = 1 / 60) => {
    for (let f = 0; f < frames; f++) {
      simNow += dt * 1000;
      hostDir.step(dt, dt, hostWorld, IDLE_CTRL);
      for (let i = 0; i < guestDirs.length; i++) {
        guestDirs[i]!.step(dt, dt, guestWorlds[i]!, IDLE_CTRL);
      }
      await flushMicrotasks(4);
    }
  };

  const cleanup = () => {
    hostDir.dispose();
    for (const gd of guestDirs) gd.dispose();
    hostClient.dispose();
    for (const gc of guestClients) gc.dispose();
  };

  return {
    room,
    bridge,
    hostClient,
    hostStorage,
    hostWorld,
    hostDir,
    guestClients,
    guestStorages,
    guestWorlds,
    guestDirs,
    tickSquad,
    now: () => nowFn(),
    advanceSimMs: (ms: number) => {
      simNow += ms;
    },
    cleanup,
  };
}

test('Phase 3 (1): Per-pilot Grade Picker runs independently per device with zero storage or wire leakage', async () => {
  setCoopTabGrade(null);
  domLocalStorage.clear();
  domSessionStorage.clear();

  const sq = await createLiveSquad({ guestCount: 1 });
  const guestDir = sq.guestDirs[0]!;
  const guestWorld = sq.guestWorlds[0]!;

  assert.equal(sq.hostDir.grade, null);
  assert.equal(guestDir.grade, null);

  // Spawn an energy capsule on Host P1 and a hull capsule on Guest P2
  const p0 = sq.hostDir.pilots[0];
  const p1 = sq.hostDir.pilots[1];
  p1.hull = 2;
  sq.hostWorld.pickups.push(
    { reward: 'energy', x: p0.x, y: p0.y, anchorX: p0.x, phase: 0, age: 0, dead: false },
    { reward: 'hull', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false },
  );

  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(30); // >= 0.3s grade grace

  // Host is on desktop keys; Guest is on 390x844 portrait thumb deck
  const hostCardBefore = sq.hostDir.currentDeckCard();
  const guestCardGrade = guestDir.currentDeckCard();
  assert.equal(hostCardBefore, null);
  assert.ok(guestCardGrade && guestCardGrade.kind === 'grade');
  assert.equal(sq.hostDir.wantsKey('1'), true);

  // Host picks K-2 ('1' -> grade 0); Guest taps 6+ (index 2 -> grade 2) on their Thumb Deck!
  assert.equal(sq.hostDir.typeKey('1', sq.hostWorld), true);
  assert.equal(sq.hostDir.grade, 0);

  const gradeBoxes = deckCardBoxes(guestDir.layout, guestCardGrade);
  assert.equal(gradeBoxes.length, 3);
  const box6Plus = gradeBoxes[2]!;
  assert.equal(guestDir.handlePointerDown(11, box6Plus.x + 10, box6Plus.y + 10, true), true);
  guestDir.handlePointerUp(11);
  assert.equal(guestDir.grade, 2);

  // Host's grade stayed 0 while Guest's grade is 2 (isolated per-pilot!)
  assert.equal(sq.hostDir.grade, 0);
  assert.equal(guestDir.grade, 2);

  // Guest now sees a math choice card in their Thumb Deck
  const mathCard = guestDir.currentDeckCard();
  assert.ok(mathCard && mathCard.kind === 'choice');

  // Verify ZERO grade keys in localStorage, sessionStorage, hostStorage, guestStorage, or JSON wire frames
  for (const k of [...domLocalStorage.rawMap.keys(), ...domSessionStorage.rawMap.keys(), ...sq.hostStorage.map.keys(), ...sq.guestStorages[0]!.map.keys()]) {
    assert.equal(/grade/i.test(k), false, `unexpected storage key: ${k}`);
  }
  for (const frame of sq.bridge.allJsonFrames) {
    const serialized = JSON.stringify(frame);
    assert.equal(/grade/i.test(serialized), false, `grade leaked onto wire: ${serialized}`);
  }

  void guestWorld;
  sq.cleanup();
  setCoopTabGrade(null);
});

test('Phase 3 (2 & 3): Mid-wave challenges keep 1.0x speed, pack Amber Quiz Shield in maxHull bit 7 (0 extra bytes), deflect hazards, jam on capsule fail, and down ONLY answering pilot on bomb fail', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);

  const p0 = sq.hostDir.pilots[0];
  const p1 = sq.hostDir.pilots[1];

  // Measure wire snapshot byte size before and during `answering = true`
  const snapIdle = encodeWorldSnapshot({
    tick: 1,
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
        connected: true,
        alive: true,
        hull: 3,
        maxHull: 3,
        invulnerable: false,
        answering: false,
        shielded: false,
        firing: false,
        spread: false,
        wing: false,
        orbitUpgrade: false,
        x: p0.x,
        y: p0.y,
        lean: 0,
        orbit: 0,
        ackSeq: 1,
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
  });
  const snapAnswering = encodeWorldSnapshot({
    tick: 2,
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
        connected: true,
        alive: true,
        hull: 3,
        maxHull: 4,
        invulnerable: false,
        answering: true,
        shielded: false,
        firing: false,
        spread: false,
        wing: false,
        orbitUpgrade: false,
        x: p0.x,
        y: p0.y,
        lean: 0,
        orbit: 0,
        ackSeq: 1,
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
  });
  assert.equal(snapAnswering.byteLength, snapIdle.byteLength);
  const decodedAnswering = decodeWorldSnapshot(snapAnswering);
  assert.ok(decodedAnswering);
  assert.equal(decodedAnswering.ships[0]!.answering, true);
  assert.equal(decodedAnswering.ships[0]!.maxHull, 4);

  // Guest P2 flies into a boost capsule -> P2 gets Amber Quiz Shield (`answering = true`) while world runs at 1.0x
  p0.invulnerable = 0;
  p1.invulnerable = 0;
  sq.hostWorld.pickups.push({ reward: 'energy', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(36); // advance past PROMPT_GRACE (0.4s)

  assert.equal(p1.answering, true);
  assert.equal(sq.guestDirs[0]!.pilots[1].answering, true);

  // Hostile bullet & enemy hitting P2 while `answering = true` are deflected with 0 hull loss!
  sq.hostWorld.shots.push({ x: p1.x, y: p1.y, vx: 0, vy: 200, hostile: true, dead: false, color: NEON.red });
  const rammer = makeEnemy('dart', p1.x, p1.y);
  sq.hostWorld.enemies.push(rammer);
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  assert.equal(p1.hull, 3);
  assert.equal(rammer.dead, false);
  sq.hostWorld.shots.length = 0;
  sq.hostWorld.enemies.length = 0;

  // Guest P2 answers WRONG on the boost capsule -> 2.5s local cannon jam on P2 ONLY; P1 is untouched!
  const card = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(card && card.kind === 'choice');
  const wrongIdx = (card.correctIndex + 1) % card.options.length;
  const boxes = deckCardBoxes(sq.guestDirs[0]!.layout, card);
  const pickBox = boxes[wrongIdx]!;
  sq.guestDirs[0]!.handlePointerDown(21, pickBox.x + 8, pickBox.y + 8, true);
  sq.guestDirs[0]!.handlePointerUp(21);
  await sq.tickSquad(4);

  assert.equal(p1.answering, false);
  assert.ok(p1.jamSec > 2.0 && p1.jamSec <= 2.5);
  assert.ok(p1.invulnerable >= 0.8); // +1.0s post-quiz shelter
  assert.equal(p0.jamSec, 0);
  assert.equal(p0.hull, 3);

  // Now clear shelter and trigger a BOMB (`defuse`) on P2, then let the host's question limit expire -> ONLY P2 goes down; P1 keeps flying!
  p1.invulnerable = 0;
  p1.jamSec = 0;
  sq.hostWorld.mines.push({ x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false, thrown: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  assert.equal(p1.answering, true);

  // Advance just past the host's question limit (and well short of the 6 s reboot that would follow). Only the host
  // steps here, so the guest's inputs stop arriving and the host first waits up to COOP_STALE_HOLD_MAX_SEC for them.
  for (let i = 0; i < Math.ceil((COOP_QUIZ_TIMEOUT_SEC + COOP_STALE_HOLD_MAX_SEC + 0.5) / 0.5); i++) {
    sq.hostDir.step(0.5, 0.5, sq.hostWorld, IDLE_CTRL);
  }
  assert.equal(p1.alive, false);
  assert.equal(p1.hull, 0);
  assert.equal(p0.alive, true);
  assert.equal(sq.hostWorld.gameOver, false);

  sq.cleanup();
});

test('Phase 3 (4): Squad Upgrade Capsule sends unicast 3-choice offer, equips chosen upgrade for entire squad, and 16s timeout auto-picks first offer', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(0);
  sq.guestDirs[0]!.setGrade(0);

  const p0 = sq.hostDir.pilots[0];
  const p1 = sq.hostDir.pilots[1];
  p0.invulnerable = 0;
  p1.invulnerable = 0;

  // Guest P2 collects an Upgrade Capsule
  sq.hostWorld.pickups.push({ reward: 'upgrade', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(36); // advance past PROMPT_GRACE

  const mathCard = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(mathCard && mathCard.kind === 'choice');
  const rightIdx = mathCard.correctIndex;

  const mBoxes = deckCardBoxes(sq.guestDirs[0]!.layout, mathCard);
  sq.guestDirs[0]!.handlePointerDown(31, mBoxes[rightIdx]!.x + 8, mBoxes[rightIdx]!.y + 8, true);
  sq.guestDirs[0]!.handlePointerUp(31);
  await sq.tickSquad(36); // settle answer + advance past OFFER_GRACE (0.4s)

  // Guest P2 now receives a 3-choice `offer` card in their Thumb Deck (while Host P1 does NOT!)
  const offerCard = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(offerCard && offerCard.kind === 'offer');
  assert.equal(offerCard.upgrades.length, 3);
  assert.equal(sq.hostDir.currentDeckCard(), null);

  // Guest P2 picks slot 1 via mouse click on the Thumb Deck card!
  const chosenUpgrade = offerCard.upgrades[1]!;
  const oBoxes = deckCardBoxes(sq.guestDirs[0]!.layout, offerCard);
  assert.equal(sq.guestDirs[0]!.handlePointerDown(32, oBoxes[1]!.x + 12, oBoxes[1]!.y + 12, false), true);
  sq.guestDirs[0]!.handlePointerUp(32);
  await sq.tickSquad(8);

  assert.equal(sq.hostWorld.upgrades.has(chosenUpgrade.id), true);
  assert.equal(sq.guestWorlds[0]!.upgrades.has(chosenUpgrade.id), true);

  // Also verify 16s offer timeout auto-equips first offer
  p0.invulnerable = 0;
  sq.hostWorld.pickups.push({ reward: 'upgrade', x: p0.x, y: p0.y, anchorX: p0.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);

  sq.hostDir.onTouchInput(sq.hostWorld);
  await sq.tickSquad(36); // advance past PROMPT_GRACE
  const hostChallenge = (sq.hostDir.quiz as unknown as { active: { stage: string; challenge?: { correct: number } } }).active;
  assert.ok(hostChallenge && hostChallenge.stage === 'stake' && hostChallenge.challenge);
  sq.hostDir.typeKey(String(hostChallenge.challenge.correct + 1), sq.hostWorld);
  await sq.tickSquad(4); // settle `stake` -> opens `offer` on Host

  const countBeforeTimeout = sq.hostWorld.upgrades.size;
  for (let i = 0; i < 34; i++) {
    sq.hostDir.step(0.5, 0.5, sq.hostWorld, IDLE_CTRL);
  }
  assert.equal(sq.hostWorld.upgrades.size, countBeforeTimeout + 1);

  sq.cleanup();
});

test('Phase 3 (5): Dual Wingman Rescue-Pod Revives — BOTH wreck fly-over (+150 score, 0.35s stacked guard) AND right quiz answers revive downed wingmen', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(0);
  sq.guestDirs[0]!.setGrade(0);

  const p0 = sq.hostDir.pilots[0];
  const p1 = sq.hostDir.pilots[1];

  // Stack P1 and P2 at the exact same coordinates and knock P2 down
  p0.x = 384;
  p0.y = 820;
  p1.x = 384;
  p1.y = 820;
  p1.hull = 1;
  p1.invulnerable = 0;
  sq.hostWorld.shots.push({ x: 384, y: 820, vx: 0, vy: 220, hostile: true, dead: false, color: NEON.red });
  // Give P1 temporary invulnerability so only P2 takes the fatal hit
  p0.invulnerable = 1.0;
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  assert.equal(p1.alive, false);
  assert.equal(p1.respawnSec, 6.0);

  // Frame 0..0.2s (< 0.35s stacked-death guard): P1 standing on top of P2 does NOT insta-revive P2!
  sq.hostDir.step(0.1, 0.1, sq.hostWorld, IDLE_CTRL);
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  assert.equal(p1.alive, false);
  assert.equal(p0.revives, 0);

  // Advance past 0.35s (`total >= 0.4s`) while still well before the 6.0s auto-reboot timer -> Wreck Fly-Over revives P2!
  for (let i = 0; i < 4; i++) {
    sq.hostDir.step(0.1, 0.1, sq.hostWorld, IDLE_CTRL);
  }
  const scoreBefore = sq.hostWorld.score;
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  assert.equal(p1.alive, true);
  assert.equal(p1.hull, Math.max(2, p1.maxHull - 1));
  assert.ok(p1.invulnerable >= 1.9);
  assert.equal(p0.revives, 1);
  assert.equal(sq.hostWorld.score, scoreBefore + 150);

  // Now knock P2 down far away from P1, and verify a RIGHT QUIZ ANSWER by P1 ALSO revives P2 remotely!
  p0.x = 180;
  p0.y = 820;
  p1.x = 620;
  p1.y = 820;
  p0.invulnerable = 0;
  p1.invulnerable = 0;
  p1.hull = 1;
  sq.hostWorld.shots.push({ x: 620, y: 820, vx: 0, vy: 220, hostile: true, dead: false, color: NEON.red });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  assert.equal(p1.alive, false);

  sq.hostWorld.pickups.push({ reward: 'energy', x: p0.x, y: p0.y, anchorX: p0.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  sq.hostDir.onTouchInput(sq.hostWorld);
  await sq.tickSquad(36); // advance past PROMPT_GRACE
  const st = (sq.hostDir.quiz as unknown as { active: { challenge: { correct: number } } }).active;
  sq.hostDir.typeKey(String(st.challenge.correct + 1), sq.hostWorld);
  await sq.tickSquad(4); // step quiz so `onChallengeSettled` fires!

  assert.equal(p1.alive, true);
  assert.equal(p0.revives, 2);
  assert.equal(p0.questionsRight, 1);

  sq.cleanup();
});

test('Phase 3 (6): Pre-Wave Squad Break parks the squad between waves, aggregates energy, repairs/revives, and launches Wave 2', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(0);
  sq.guestDirs[0]!.setGrade(0);

  const p0 = sq.hostDir.pilots[0];
  const p1 = sq.hostDir.pilots[1];
  p0.hull = 2; // hurt so a 'perfect' break answer repairs +1 hull
  p1.alive = false;
  p1.hull = 0;
  p1.respawnSec = 5.0;
  sq.hostWorld.energy = 0.2;

  // Begin Pre-Wave Squad Break before Wave 2
  sq.hostDir.beginSquadWaveBreak(2, sq.hostWorld);
  sq.hostDir.onTouchInput(sq.hostWorld);
  await sq.tickSquad(42); // advance past BREAK_GRACE (0.6s)

  assert.equal(sq.hostDir.isSquadParked, true);
  assert.equal(sq.guestDirs[0]!.isSquadParked, true);
  assert.equal(sq.hostWorld.startedWaves.length, 0);

  // Host answers their break challenge (2 quick sums)
  for (let round = 0; round < 2; round++) {
    const brkState = (sq.hostDir.quiz as unknown as { active: { challenge: { correct: number } } }).active;
    sq.hostDir.typeKey(String(brkState.challenge.correct + 1), sq.hostWorld);
    await sq.tickSquad(46); // >= 0.45s inter-round pause + 0.25s round 2 grace
  }

  // Wave 2 has NOT launched yet because Guest P2 is still answering!
  assert.equal(sq.hostDir.isSquadParked, true);
  assert.equal(sq.hostWorld.startedWaves.length, 0);

  // Guest P2 completes their 2 sums on their Thumb Deck
  for (let round = 0; round < 2; round++) {
    const gCard = sq.guestDirs[0]!.currentDeckCard();
    assert.ok(gCard && gCard.kind === 'choice');
    const boxes = deckCardBoxes(sq.guestDirs[0]!.layout, gCard);
    sq.guestDirs[0]!.handlePointerDown(40 + round, boxes[gCard.correctIndex]!.x + 8, boxes[gCard.correctIndex]!.y + 8, true);
    sq.guestDirs[0]!.handlePointerUp(40 + round);
    await sq.tickSquad(46); // >= 0.45s inter-round pause + 0.25s round 2 grace
  }

  // Both pilots answered -> Wave 2 launched, energy increased, P0 hull repaired, P1 revived!
  assert.deepEqual(sq.hostWorld.startedWaves, [2]);
  assert.equal(sq.hostDir.isSquadParked, false);
  assert.ok(sq.hostWorld.energy > 0.5);
  assert.equal(p0.hull, 3);
  assert.equal(p1.alive, true);

  sq.cleanup();
});

test('Phase 3 (7): Portrait-phone 390x844 Thumb Deck cards stay 100% inside Bottom 38% deckRect and never draw over the 3:4 arena', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  const guestDir = sq.guestDirs[0]!;
  assert.equal(guestDir.layout.useThumbDeck, true);

  const p0 = sq.hostDir.pilots[0];
  const p1 = sq.hostDir.pilots[1];
  p0.answering = true; // Host P1 is answering -> Guest P2 wingman pill shows `P1 QUIZ`
  sq.hostWorld.pickups.push({ reward: 'energy', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(22);

  const canvas = makeRecordingCanvas(390, 844);
  const ctx = canvas.getContext();
  const ink = (color: string, alpha: number, width: number, build: () => void, glow = true) =>
    strokeInk(ctx, color, alpha, width, build, glow);

  // Check Grade card geometry
  const gradeCard = guestDir.currentDeckCard();
  assert.ok(gradeCard && gradeCard.kind === 'grade');
  for (const b of deckCardBoxes(guestDir.layout, gradeCard)) {
    assert.ok(b.y >= guestDir.layout.deckRect.y, `grade box y=${b.y} leaked above deckRect.y=${guestDir.layout.deckRect.y}`);
    assert.ok(b.y + b.h <= 844);
    assert.ok(b.h >= 34);
    assert.notEqual(hitTestDeckCard(guestDir.layout, gradeCard, b.x + b.w / 2, b.y + b.h / 2), null);
  }

  // Render viewport chrome + arena overlays and assert arena overlay drew ZERO strokes while `useThumbDeck === true`
  canvas.drawnPoints.length = 0;
  guestDir.renderArenaOverlays(ctx, ink, {
    time: 1.5,
    state: 'playing',
    stateTime: 1.5,
    paused: false,
    reduceMotion: false,
    coarse: true,
    soulsInFlight: 0,
  });
  assert.equal(canvas.drawnPoints.length, 0, 'deck-mode quiz must not draw inside the 3:4 arena');

  // Render Thumb Deck directly and verify EVERY stroke stays strictly inside Bottom 38% `deckRect` (`y >= deckRect.y - 2`)
  canvas.drawnPoints.length = 0;
  guestDir.deck.render(ctx, guestDir.layout, {
    seat: 1,
    callsign: 'WING-2',
    hull: 3,
    maxHull: 3,
    alive: true,
    respawnSec: 0,
    answering: true,
    gameOver: false,
    wingmen: [{ seat: 0, hull: 3, alive: true, connected: true, answering: true }],
    card: gradeCard,
  });
  assert.ok(canvas.drawnPoints.length > 20, 'deck card + P1 QUIZ wingman pill rendered in thumb deck');
  for (const pt of canvas.drawnPoints) {
    assert.ok(
      pt.y >= guestDir.layout.deckRect.y - 2 && pt.y <= 844,
      `deck stroke y=${pt.y} leaked outside deckRect [${guestDir.layout.deckRect.y}, 844]`,
    );
  }

  sq.cleanup();
});

test('Phase 3 (8): Piloting Host hidden >= 2.0s triggers HOST AWAY + 3-2-1 countdown on return; < 2.0s and TV-mode Host never auto-pause', async () => {
  // Part A: Piloting Host (`tvMode: false`) through real `Game` + `document.hidden`
  const sq = await createLiveSquad({ tvMode: false, guestCount: 1, nowFn: () => fakeNowMs });
  media.coarse = false;
  docTarget.hidden = false;
  const hostCanvas = makeRecordingCanvas(1280, 800);
  const hostGame = new Game(hostCanvas as never, {
    multiplayer: makeFakeMultiplayer() as never,
    coop: { director: sq.hostDir },
    onExit() {},
  });

  // Hide tab for 1.0s (< 2.0s threshold) -> MUST keep simulating without pausing!
  docTarget.hidden = true;
  docTarget.dispatchEvent(new Event('visibilitychange'));
  advanceTimeMs(1000);
  await flushMicrotasks();
  assert.equal(hostGame.isPaused, false);
  assert.equal(sq.hostDir.hostAway, false);

  // Hide for another 1.2s (total 2.2s >= 2.0s) -> auto-pauses with `HOST AWAY` on Guest!
  advanceTimeMs(1200);
  await flushMicrotasks();
  assert.equal(hostGame.isPaused, true);
  assert.equal(sq.hostDir.hostAway, true);
  assert.equal(sq.guestDirs[0]!.hostPaused, true);
  assert.equal(sq.guestDirs[0]!.hostAway, true);

  //Piloting Host returns (`document.hidden = false`) -> starts `3-2-1` (`3.0s`) countdown while still paused!
  docTarget.hidden = false;
  docTarget.dispatchEvent(new Event('visibilitychange'));
  await flushMicrotasks();
  assert.equal(hostGame.isPaused, true);
  assert.equal(sq.hostDir.isResumeCountdownActive, true);
  assert.ok(sq.guestDirs[0]!.resumeCountdownSec > 2.5);

  // Step `frame` through the 3.0s countdown -> unpauses automatically at 0!
  const stepFrame = (hostGame as unknown as { frame: (now: number) => void }).frame;
  for (let i = 0; i < 65; i++) {
    fakeNowMs += 50;
    stepFrame(fakeNowMs);
  }
  await flushMicrotasks();
  assert.equal(hostGame.isPaused, false);
  assert.equal(sq.hostDir.isResumeCountdownActive, false);
  assert.equal(sq.guestDirs[0]!.hostPaused, false);
  assert.equal(sq.guestDirs[0]!.hostAway, false);

  hostGame.destroy();
  sq.cleanup();

  // Part B: TV-mode Host (`tvMode: true`, `seat === -1`) hidden for 5.0s NEVER triggers `HOST AWAY`!
  const tvSq = await createLiveSquad({ tvMode: true, guestCount: 1, nowFn: () => fakeNowMs });
  const tvCanvas = makeRecordingCanvas(1920, 1080);
  const tvGame = new Game(tvCanvas as never, {
    multiplayer: makeFakeMultiplayer() as never,
    coop: { director: tvSq.hostDir },
    onExit() {},
  });

  docTarget.hidden = true;
  docTarget.dispatchEvent(new Event('visibilitychange'));
  advanceTimeMs(5000);
  await flushMicrotasks();

  assert.equal(tvGame.isPaused, false);
  assert.equal(tvSq.hostDir.hostAway, false);
  assert.equal(tvSq.guestDirs[0]!.hostPaused, false);

  docTarget.hidden = false;
  docTarget.dispatchEvent(new Event('visibilitychange'));
  tvGame.destroy();
  tvSq.cleanup();
});

test('Phase 3 (9 & 10): Reconnect resync restores open challenges/mission summary, wire carries zero free-text strings, and Co-op never writes Solo scores', async () => {
  domLocalStorage.clear();
  const soloScoreCalls: Array<{ score: number; wave: number; freed: number }> = [];
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(0);
  sq.guestDirs[0]!.setGrade(0);

  const p0 = sq.hostDir.pilots[0];
  const p1 = sq.hostDir.pilots[1];
  p0.invulnerable = 0;
  p1.invulnerable = 0;

  // Open a mid-wave challenge on Guest P2, then disconnect & reconnect Guest P2 -> Host resyncs the active challenge!
  sq.hostWorld.pickups.push({ reward: 'hull', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(4);
  assert.ok(sq.guestDirs[0]!.currentDeckCard()?.kind === 'choice');

  // Simulate Guest P2 tab reload / fresh director reconnecting with their saved seat token in `guestStorages[0]`
  sq.guestDirs[0]!.dispose();
  sq.guestClients[0]!.dispose();
  await sq.tickSquad(4);

  const reClient = new CoopClient({
    code: 'PH3TST',
    role: 'guest',
    callsign: 'WING-2',
    wsBase: 'ws://relay.test',
    storage: sq.guestStorages[0]!,
    WebSocketConstructor: sq.bridge.WsCtor,
    pingIntervalMs: 0,
  });
  const reWorld = new HeadlessWorld();
  const reDir = new CoopFlightDirector({
    client: reClient,
    initialSeats: sq.hostDir.pilots.filter((p) => p.present).map((p) => ({
      seat: p.seat,
      callsign: p.callsign,
      color: p.color,
      ready: true,
      isHost: p.isHost,
      connected: p.connected,
    })),
    storage: sq.guestStorages[0]!,
    initialGrade: 0,
    now: () => sq.now(),
  });
  reDir.bindWorld(reWorld);
  reDir.setViewport(390, 844, {}, true);

  reClient.connect();
  await flushWs();
  sq.hostDir.step(1 / 60, 1 / 60, sq.hostWorld, IDLE_CTRL);
  await flushWs();

  // Reconnected Guest P2 immediately has their open `hull` challenge restored!
  const restoredCard = reDir.currentDeckCard();
  assert.ok(restoredCard && restoredCard.kind === 'choice');

  // Mount real `Game` on BOTH Host and Guest to verify live `frame()` + `render()` + Squad Mission Summary + ZERO Solo leaderboard bleed!
  const hostCanvas = makeRecordingCanvas(1280, 800);
  const hostGame = new Game(hostCanvas as never, {
    multiplayer: makeFakeMultiplayer(soloScoreCalls) as never,
    coop: { director: sq.hostDir },
    onExit() {},
  });
  const guestCanvas = makeRecordingCanvas(390, 844);
  const guestGame = new Game(guestCanvas as never, {
    multiplayer: makeFakeMultiplayer(soloScoreCalls) as never,
    coop: { director: reDir },
    onExit() {},
  });
  fakeNowMs += 16;
  (guestGame as unknown as { frame: (now: number) => void }).frame(fakeNowMs);
  (guestGame as unknown as { render: () => void }).render();

  // Wipe both ships on Host
  const hp0 = sq.hostDir.pilots[0];
  const hp1 = sq.hostDir.pilots[1];
  hp0.invulnerable = 0;
  hp1.invulnerable = 0;
  hp0.answering = false;
  hp1.answering = false;
  hp0.hull = 1;
  hp1.hull = 1;
  const rawWorld = (hostGame as unknown as { coopAdapter: CoopWorldAdapter }).coopAdapter;
  rawWorld.score = 4250;
  rawWorld.freed = 19;
  rawWorld.shots.push(
    { x: hp0.x, y: hp0.y, vx: 0, vy: 200, hostile: true, dead: false, color: NEON.red },
    { x: hp1.x, y: hp1.y, vx: 0, vy: 200, hostile: true, dead: false, color: NEON.red },
  );
  sq.hostDir.collideHostSquad(rawWorld, 1);
  await flushWs();

  assert.equal((hostGame as unknown as { state: string }).state, 'over');
  assert.equal((guestGame as unknown as { state: string }).state, 'over');

  // Render Squad Mission Summary on BOTH Host and Guest and verify strokes draw cleanly
  hostCanvas.drawnPoints.length = 0;
  (hostGame as unknown as { render: () => void }).render();
  assert.ok(hostCanvas.drawnPoints.length > 50);
  guestCanvas.drawnPoints.length = 0;
  (guestGame as unknown as { render: () => void }).render();
  assert.ok(guestCanvas.drawnPoints.length > 50);

  // ZERO Solo leaderboard submissions and ZERO `gg-arcade-best` writes!
  assert.equal(soloScoreCalls.length, 0);
  assert.equal(domLocalStorage.getItem('gg-arcade-best'), null);

  // Verify every JSON frame across the entire room contains ZERO free-text quiz fields
  const forbiddenKeys = ['question', 'typed', 'prompt', 'grade', 'text', 'sentence'];
  for (const frame of sq.bridge.allJsonFrames) {
    for (const bad of forbiddenKeys) {
      assert.equal(bad in frame, false, `forbidden free-text field '${bad}' on wire: ${JSON.stringify(frame)}`);
    }
  }

  // Host presses Enter after 1.0s -> relaunches squad into Wave 1!
  const stepFrame = (hostGame as unknown as { frame: (now: number) => void }).frame;
  const stepGuestFrame = (guestGame as unknown as { frame: (now: number) => void }).frame;
  for (let i = 0; i < 25; i++) {
    fakeNowMs += 50;
    stepFrame(fakeNowMs);
  }
  winTarget.dispatchEvent(makeKeyEvent('keydown', 'Enter', 'Enter'));
  await flushWs();
  fakeNowMs += 16;
  stepGuestFrame(fakeNowMs);
  assert.equal((hostGame as unknown as { state: string }).state, 'playing');
  assert.equal((guestGame as unknown as { state: string }).state, 'playing');

  void makePointerEvent;
  void formationSpawnForSeat;
  void reWorld;
  guestGame.destroy();
  hostGame.destroy();
  reDir.dispose();
  reClient.dispose();
  sq.cleanup();
  setCoopTabGrade(null);
  assert.equal(getCoopTabGrade(), null);
});

// -----------------------------------------------------------------------------------------------------------------
// Round 15 fixes (Claude): question timing between host and guests, the host's "question closed" message, answers
// that only say right or wrong (grade privacy), host reloads and lost answers. Each test fails on 473f55e.
// -----------------------------------------------------------------------------------------------------------------

const quizR15 = await import('../src/game/coop-quiz');
const questionsR15 = await import('../src/game/questions');
const { UPGRADES } = await import('../src/game/upgrades');
const { COOP_OFFER_TIMEOUT_SEC, coopBreakWindowSec } = await import('../src/game/coop-flight');

type LiveSquad = Awaited<ReturnType<typeof createLiveSquad>>;
type QuizPeek = {
  stage: string;
  id?: number;
  challenge?: { kind: string; correct: number; limit: number; timeLeft: number };
  headline?: string;
} | null;
const quizOf = (d: InstanceType<typeof CoopFlightDirector>): QuizPeek =>
  (d.quiz as unknown as { active: QuizPeek }).active;

async function answerGuestCard(sq: LiveSquad, gi: number, right: boolean, pointerId: number): Promise<void> {
  const gd = sq.guestDirs[gi]!;
  const card = gd.currentDeckCard();
  assert.ok(card && card.kind === 'choice', `guest ${gi} shows a choice card`);
  const idx = right ? card.correctIndex : (card.correctIndex + 1) % card.options.length;
  const boxes = deckCardBoxes(gd.layout, card);
  gd.handlePointerDown(pointerId, boxes[idx]!.x + 8, boxes[idx]!.y + 8, true);
  gd.handlePointerUp(pointerId);
}

test('Round 15 (5.1 privacy): every grade band gets the same clock, and only right or wrong is reported', () => {
  const { CoopLocalQuizController } = quizR15;
  const settled: Array<{ verdict: string; quality: number }> = [];
  const hooks = {
    play() {},
    announce() {},
    onChallengeSettled: (_id: number, _kind: string, verdict: string, quality: number) => {
      settled.push({ verdict, quality });
    },
    onUpgradeChosen() {},
  };
  const limitFor = (band: 0 | 1 | 2, kind: 'hull' | 'break', mode: 'keys' | 'touch', wave: number): number => {
    const q = new CoopLocalQuizController({ isolatedGrade: true, initialGrade: band, initialInputMode: mode });
    q.openChallenge(7, kind, wave, mode === 'touch', hooks);
    return q.activeChallenge!.limit;
  };

  // The moment a question runs out must not depend on the band: the same clock for every band.
  for (const wave of [1, 2, 3, 5, 8, 12]) {
    for (const [kind, mode] of [
      ['hull', 'keys'],
      ['hull', 'touch'],
      ['break', 'keys'],
      ['break', 'touch'],
    ] as const) {
      const limits = ([0, 1, 2] as const).map((band) => limitFor(band, kind, mode, wave));
      assert.equal(new Set(limits).size, 1, `wave ${wave} ${kind}/${mode}: ${limits.join(' / ')}`);
    }
  }

  // A quick right answer and a slow one, in every band: the score sent is only ever 0, 0.7 or 1.
  for (const band of [0, 1, 2] as const) {
    for (const wait of [0.5, 9]) {
      const q = new CoopLocalQuizController({ isolatedGrade: true, initialGrade: band, initialInputMode: 'touch' });
      q.openChallenge(9, 'energy', 4, true, hooks);
      q.step(wait, true, false, hooks);
      const c = q.activeChallenge as unknown as { kind: string; correct: number };
      assert.equal(c.kind, 'choice');
      q.pickDeckCard(c.correct, true, hooks);
      q.step(0.016, true, false, hooks);
    }
  }
  assert.equal(settled.length, 6);
  for (const s of settled) assert.ok([0, 0.7, 1].includes(s.quality), `score ${s.quality} for ${s.verdict}`);

  // The grade picker has its own clock. When nobody picks, no band is picked for them (that would show the squad which
  // band a pilot was given): the host closes the question with nothing lost, and the picker comes back next time.
  const idle = new CoopLocalQuizController({ isolatedGrade: true, initialInputMode: 'touch' });
  idle.openChallenge(10, 'hull', 2, true, hooks);
  assert.equal(idle.stage, 'grade');
  idle.step(12.1, true, false, hooks);
  assert.equal(idle.stage, 'grade', 'no band is picked when the picker runs out');
  idle.hostClosed(10, quizR15.CLOSE_CANCELLED, null, true, hooks);
  assert.equal(idle.stage, 'result');
  assert.equal(idle.getGrade(), null);
  idle.step(2, true, false, hooks);
  idle.openChallenge(11, 'hull', 2, true, hooks);
  assert.equal(idle.stage, 'grade', 'the picker comes back with the next question');

  // And the clocks are the generous ones, so nobody gets less time than their own band would have.
  const { coopClock, coopBreakLineClock } = quizR15;
  const { PROMPT_SECONDS, ROUND_SECONDS, clockFor } = questionsR15;
  for (const band of [0, 1, 2] as const) {
    assert.ok(coopClock(PROMPT_SECONDS) >= clockFor(PROMPT_SECONDS, band));
    assert.ok(coopClock(ROUND_SECONDS) >= clockFor(ROUND_SECONDS, band));
  }
  assert.ok(coopBreakLineClock(12) >= coopBreakLineClock(1));
});

test('Round 15 (4.1): when the host ends a break, every guest card closes at once', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(0); // K-2: the longest own clock
  sq.hostDir.beginSquadWaveBreak(4, sq.hostWorld);
  await sq.tickSquad(42);
  assert.equal(quizOf(sq.guestDirs[0]!)?.stage, 'break');

  // Nobody answers. Run until the host starts wave 4, then a moment more.
  for (let i = 0; i < 400 && !sq.hostWorld.startedWaves.includes(4); i++) await sq.tickSquad(1, 0.1);
  assert.deepEqual(sq.hostWorld.startedWaves, [4]);
  await sq.tickSquad(5, 0.1);
  assert.equal(sq.guestDirs[0]!.quiz.isOpen(), false, "the guest's card closed with the host's break");
  assert.ok(coopBreakWindowSec(4) >= quizR15.coopBreakMaxSec(4) + 2, 'the host waits longer than any own clock');
  sq.cleanup();
});

test('Round 15 (4.1): an offer the host fits on time-out closes on the guest and names what was really fitted', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  sq.hostWorld.pickups.push({ reward: 'upgrade', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(36);
  await answerGuestCard(sq, 0, true, 41);
  await sq.tickSquad(36);
  const offer = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(offer && offer.kind === 'offer');

  const before = new Set(sq.hostWorld.upgrades);
  await sq.tickSquad(Math.ceil((COOP_OFFER_TIMEOUT_SEC + 0.3) / 0.1), 0.1);
  const fitted = [...sq.hostWorld.upgrades].filter((u) => !before.has(u));
  assert.equal(fitted.length, 1);
  const shown = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(shown && shown.kind === 'result', 'the offer card is closed');
  assert.equal(shown.headline, `${UPGRADES.find((u) => u.id === fitted[0])!.name} EQUIPPED!`);
  sq.cleanup();
});

test("Round 15 (4.1): a pilot picking a grade never runs out the host's clock", async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1); // the guest has not picked a grade yet
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  sq.hostWorld.mines.push({ x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false, thrown: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(30);
  assert.equal(quizOf(sq.guestDirs[0]!)?.stage, 'grade');

  // The child takes 11.5 s over the grade, then most of the bomb's own clock, and answers right in time.
  await sq.tickSquad(110, 0.1);
  const gradeCard = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(gradeCard && gradeCard.kind === 'grade');
  const gBoxes = deckCardBoxes(sq.guestDirs[0]!.layout, gradeCard);
  sq.guestDirs[0]!.handlePointerDown(51, gBoxes[0]!.x + 8, gBoxes[0]!.y + 8, true);
  sq.guestDirs[0]!.handlePointerUp(51);
  await sq.tickSquad(6);
  const limit = quizOf(sq.guestDirs[0]!)!.challenge!.limit;
  await sq.tickSquad(Math.floor((limit - 1) / 0.1), 0.1);
  assert.equal(p1.alive, true, "not blown up while the bomb's own clock is still running");
  await answerGuestCard(sq, 0, true, 52);
  await sq.tickSquad(10);
  assert.equal(p1.alive, true);
  assert.equal(p1.answering, false, 'the bomb was defused');
  sq.cleanup();
});

test('Round 15 (4.2): after the host page reloads, a guest still gets its next question', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  sq.hostWorld.pickups.push({ reward: 'energy', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(36);
  await answerGuestCard(sq, 0, true, 61);
  await sq.tickSquad(90);
  assert.equal(sq.guestDirs[0]!.quiz.isOpen(), false);

  // The host page reloads: a new director, with a different session byte, takes over the room and the world.
  const oldSession = (sq.hostDir as unknown as { hostSessionId: number }).hostSessionId;
  const target = oldSession === 255 ? 1 : oldSession + 1;
  sq.hostDir.dispose();
  const realRandom = Math.random;
  Math.random = () => (target - 1 + 0.5) / 255;
  const host2 = new CoopFlightDirector({
    client: sq.hostClient,
    initialSeats: sq.hostClient.seats,
    storage: sq.hostStorage,
    now: () => sq.now(),
  });
  Math.random = realRandom;
  host2.bindWorld(sq.hostWorld);
  host2.setViewport(1280, 800, {}, false);
  host2.setGrade(1);
  const tick2 = async (frames: number) => {
    for (let f = 0; f < frames; f++) {
      sq.advanceSimMs(1000 / 60);
      host2.step(1 / 60, 1 / 60, sq.hostWorld, IDLE_CTRL);
      sq.guestDirs[0]!.step(1 / 60, 1 / 60, sq.guestWorlds[0]!, IDLE_CTRL);
      await flushMicrotasks(4);
    }
  };
  await tick2(30);
  const q1 = host2.pilots[1];
  q1.invulnerable = 0;
  sq.hostWorld.pickups.push({ reward: 'energy', x: q1.x, y: q1.y, anchorX: q1.x, phase: 0, age: 0, dead: false });
  host2.collideHostSquad(sq.hostWorld, 1);
  await tick2(36);
  const card = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(card && card.kind === 'choice', "the reloaded host's question reached the guest");
  host2.dispose();
  sq.cleanup();
});

test('Round 15 (4.2): an answer lost on the way is sent again when the host asks again', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  sq.hostWorld.mines.push({ x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false, thrown: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(36);

  // The right answer is lost, say in a socket drop.
  const client = sq.guestClients[0]!;
  const realSend = client.sendAnswer.bind(client);
  let lost = 0;
  client.sendAnswer = () => {
    lost += 1;
    return true;
  };
  await answerGuestCard(sq, 0, true, 71);
  await sq.tickSquad(10);
  client.sendAnswer = realSend;
  assert.equal(lost, 1);
  assert.equal(p1.answering, true, 'the host never heard the answer');

  // The host asks again, as its reconnect resync does; the guest re-sends the answer it already gave.
  const open = (sq.hostDir as unknown as { hostSeatChallenge: Array<{ id: number; wave: number } | null> })
    .hostSeatChallenge[1]!;
  sq.hostClient.sendEvent({ kind: 'challenge', to: 1, id: open.id, wave: open.wave, values: [quizR15.encodeStakeCode('defuse')] });
  await sq.tickSquad(10);
  assert.equal(p1.answering, false);
  assert.equal(p1.alive, true, 'the bomb was defused, not set off');
  sq.cleanup();
});

test('Round 15 (5.6): the pre-wave break parks the squad at once, and an open upgrade offer is finished first', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  sq.hostWorld.pickups.push({ reward: 'upgrade', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(36);
  await answerGuestCard(sq, 0, true, 81);
  await sq.tickSquad(36);
  const offer = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(offer && offer.kind === 'offer');
  const pick = offer.upgrades[0]!;

  sq.hostDir.beginSquadWaveBreak(3, sq.hostWorld);
  await sq.tickSquad(4);
  assert.equal(sq.hostDir.isSquadParked, true, 'the squad parks at once');
  assert.equal(sq.guestDirs[0]!.currentDeckCard()?.kind, 'offer', 'the open offer stays on screen');

  const oBoxes = deckCardBoxes(sq.guestDirs[0]!.layout, offer);
  sq.guestDirs[0]!.handlePointerDown(82, oBoxes[0]!.x + 12, oBoxes[0]!.y + 12, true);
  sq.guestDirs[0]!.handlePointerUp(82);
  await sq.tickSquad(8);
  assert.equal(sq.hostWorld.upgrades.has(pick.id), true, 'the chosen upgrade was fitted');
  await sq.tickSquad(150);
  assert.equal(quizOf(sq.guestDirs[0]!)?.stage, 'break', 'and then this pilot gets the break card');
  sq.cleanup();
});

test("Round 15 (5.9): when another pilot took the same upgrade first, the screen names the one really fitted", async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  sq.hostWorld.pickups.push({ reward: 'upgrade', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(36);
  await answerGuestCard(sq, 0, true, 91);
  await sq.tickSquad(36);
  const offer = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(offer && offer.kind === 'offer');
  const taken = offer.upgrades[0]!;
  sq.hostWorld.equipUpgrade(taken.id); // another pilot got it a moment earlier

  const before = new Set(sq.hostWorld.upgrades);
  const oBoxes = deckCardBoxes(sq.guestDirs[0]!.layout, offer);
  sq.guestDirs[0]!.handlePointerDown(92, oBoxes[0]!.x + 12, oBoxes[0]!.y + 12, true);
  sq.guestDirs[0]!.handlePointerUp(92);
  await sq.tickSquad(8);
  const fitted = [...sq.hostWorld.upgrades].filter((u) => !before.has(u));
  assert.equal(fitted.length, 1);
  assert.notEqual(fitted[0], taken.id);
  assert.ok(
    offer.upgrades.some((u) => u.id === fitted[0]),
    'the replacement comes from this pilot\'s own offer when it can',
  );
  const shown = sq.guestDirs[0]!.currentDeckCard();
  assert.ok(shown && shown.kind === 'result');
  assert.equal(shown.headline, `${UPGRADES.find((u) => u.id === fitted[0])!.name} EQUIPPED!`);
  sq.cleanup();
});

// -----------------------------------------------------------------------------------------------------------------
// Round 15 follow-up (Claude): what the two reviews of a51691d found. Each test fails on 57f22a7.
// -----------------------------------------------------------------------------------------------------------------

const quizR15b = await import('../src/game/coop-quiz');

/** Steps the host alone (a guest that neither draws nor sends), `seconds` long. */
async function stepHostOnly(sq: LiveSquad, seconds: number): Promise<void> {
  for (let f = 0; f < Math.round(seconds * 60); f++) {
    sq.advanceSimMs(1000 / 60);
    sq.hostDir.step(1 / 60, 1 / 60, sq.hostWorld, IDLE_CTRL);
    await flushMicrotasks(2);
  }
}

/** Drops a bomb on guest seat 1 and returns that pilot (the guest is then asked to defuse it). */
function bombOnGuest(sq: LiveSquad) {
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  sq.hostWorld.mines.push({ x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false, thrown: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  assert.equal(p1.answering, true, 'the guest is asked to defuse the bomb');
  return p1;
}

test('Round 15 follow-up (5.6): a question open when the break is due parks the squad at once, and no boss comes back', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const game = new Game(makeRecordingCanvas(1280, 800) as never, {
    multiplayer: makeFakeMultiplayer() as never,
    coop: { director: sq.hostDir },
    onExit() {},
  });
  const G = game as unknown as Record<string, any>;
  const W = G.coopAdapter;
  const gd = sq.guestDirs[0]!;
  const gw = sq.guestWorlds[0]!;
  const tick = async (n: number) => {
    for (let i = 0; i < n; i++) {
      sq.advanceSimMs(1000 / 60);
      G.update(1 / 60);
      gd.step(1 / 60, 1 / 60, gw, IDLE_CTRL);
      await flushMicrotasks(4);
    }
  };
  await tick(10);
  // Wave 1 is over: nothing left to come, so after 0.9 s of quiet the boss arrives.
  G.queue = [];
  G.enemies = [];
  G.pickupTimes = [];
  G.upgradeTimes = [];
  G.mineTimes = [];
  G.pickups = [];
  G.mines = [];
  G.sets.due = null;
  await tick(70);
  const firstBoss = G.boss;
  assert.ok(firstBoss, 'the wave-1 boss arrived');
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  W.mines.push({ x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false, thrown: true });
  sq.hostDir.collideHostSquad(W, G.scale);
  await tick(30);
  assert.equal(quizOf(gd)?.stage, 'stake', 'the guest is defusing a bomb');
  firstBoss.state = 'gone';
  firstBoss.defeated = true;
  firstBoss.hp = 0;
  await tick(1);
  assert.equal(G.boss, null);
  await tick(Math.ceil(1.9 * 60) + 120); // the 1.8 s intermission, then 2 s more with the question still open
  assert.equal(sq.hostDir.isSquadParked, true, 'the squad parked when its break was due');
  assert.equal(G.boss, null, 'no boss came back');
  assert.equal(quizOf(gd)?.stage, 'stake', 'the guest still has its question');
  await answerGuestCard(sq, 0, true, 61);
  await tick(150);
  assert.equal(quizOf(gd)?.stage, 'break', 'once it closes, the guest gets the break card');
  assert.equal(G.wave, 1, 'the next wave waits for the break');
  sq.cleanup();
});

test('Round 15 follow-up (5.6): a capsule touched while no question can open is not used up', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  sq.hostDir.beginSquadWaveBreak(2, sq.hostWorld);
  await sq.tickSquad(4);
  const p0 = sq.hostDir.pilots[0];
  p0.invulnerable = 0;
  const capsule = { reward: 'upgrade' as const, x: p0.x, y: p0.y, anchorX: p0.x, phase: 0, age: 0, dead: false };
  sq.hostWorld.pickups.push(capsule);
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  assert.equal(capsule.dead, false);
  sq.cleanup();
});

test('Round 15 follow-up (2): a guest on a slow phone who answers with time still showing is never too late', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(0);
  sq.guestDirs[0]!.setGrade(0);
  const gd = sq.guestDirs[0]!;
  const gw = sq.guestWorlds[0]!;
  const p1 = bombOnGuest(sq);
  // The host draws 60 frames a second. The phone manages 12, and the game steps each of them by at most 0.05 s.
  let answered = false;
  for (let f = 0; f < 60 * 40 && !answered; f++) {
    sq.advanceSimMs(1000 / 60);
    sq.hostDir.step(1 / 60, 1 / 60, sq.hostWorld, IDLE_CTRL);
    if (f % 5 === 4) {
      gd.step(0.05, 0.05, gw, IDLE_CTRL);
      const card = gd.currentDeckCard();
      if (card?.kind === 'choice' && !card.done && card.timeLeft <= 1) {
        await answerGuestCard(sq, 0, true, 71);
        gd.step(0.05, 0.05, gw, IDLE_CTRL);
        answered = true;
      }
    }
    await flushMicrotasks(2);
  }
  assert.ok(answered, 'the guest answered with a second still showing');
  await stepHostOnly(sq, 0.5);
  assert.equal(p1.alive, true, 'the bomb was defused');
  assert.equal(p1.answering, false);
  sq.cleanup();
});

test("Round 15 follow-up (2): while a guest's inputs stop arriving, the host's clock for its question waits too", async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(0);
  sq.guestDirs[0]!.setGrade(0);
  const gd = sq.guestDirs[0]!;
  const p1 = bombOnGuest(sq);
  await sq.tickSquad(30);
  await stepHostOnly(sq, 4); // the phone's tab is hidden for 4 s: it neither draws nor sends
  let answered = false;
  for (let f = 0; f < 60 * 30 && !answered; f++) {
    await sq.tickSquad(1);
    const card = gd.currentDeckCard();
    if (card?.kind === 'choice' && !card.done && card.timeLeft <= 1) {
      await answerGuestCard(sq, 0, true, 72);
      answered = true;
    }
  }
  assert.ok(answered, 'the guest answered with a second still showing');
  await sq.tickSquad(30);
  assert.equal(p1.alive, true, 'the bomb was defused');
  sq.cleanup();
});

test('Round 15 follow-up (4): an answer lost on the way is sent again while the host still waits for it', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const gc = sq.guestClients[0]!;
  const realSend = gc.sendAnswer.bind(gc);
  let dropped = 0;
  gc.sendAnswer = (id: number, verdict: Grade, quality: number) => {
    if (dropped === 0) {
      dropped += 1; // a link that died silently
      return true;
    }
    return realSend(id, verdict, quality);
  };
  const p1 = bombOnGuest(sq);
  await sq.tickSquad(30);
  await answerGuestCard(sq, 0, true, 73);
  await sq.tickSquad(150);
  assert.equal(dropped, 1);
  assert.equal(p1.answering, false, 'the host got the answer');
  assert.equal(p1.alive, true);
  sq.cleanup();
});

test('Round 15 follow-up (privacy): a pilot who never picks a grade has the question closed, nothing lost and no band picked', async () => {
  setCoopTabGrade(null);
  const sq = await createLiveSquad({ guestCount: 1 });
  const gd = sq.guestDirs[0]!;
  const p1 = bombOnGuest(sq);
  await sq.tickSquad(30);
  assert.equal(quizOf(gd)?.stage, 'grade');
  await sq.tickSquad(60 * 13);
  assert.equal(p1.answering, false, 'the host closed the question');
  assert.equal(p1.alive, true, 'and the bomb did not go off');
  assert.equal(gd.grade, null, 'no band was picked for the pilot');
  sq.cleanup();
  setCoopTabGrade(null);
});

test("Round 15 follow-up (privacy): the squad's Sum Boss sums do not follow the host pilot's own band", async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(2);
  const game = new Game(makeRecordingCanvas(1280, 800) as never, {
    multiplayer: makeFakeMultiplayer() as never,
    coop: { director: sq.hostDir },
    onExit() {},
  });
  const G = game as unknown as Record<string, any>;
  G.wave = 6;
  const questions = Array.from({ length: 60 }, () => G.env.problem().question as string);
  const hard = questions.filter((q) => /[×÷]/.test(q));
  assert.equal(hard.length, 0, `grade-6 sums in the squad's boss: ${hard.slice(0, 3).join(', ')}`);
  sq.cleanup();
});

test('Round 15 follow-up (privacy): every band types the same break line, so its length says nothing', () => {
  const { CoopLocalQuizController } = quizR15b;
  const hooks = { play() {}, announce() {}, onChallengeSettled() {}, onUpgradeChosen() {} };
  const orig = Math.random;
  try {
    for (const wave of [1, 3, 4, 5, 8]) {
      const lines = ([0, 1, 2] as const).map((band) => {
        Math.random = () => 0.37;
        const c = new CoopLocalQuizController({ isolatedGrade: true, initialGrade: band, initialInputMode: 'keys' });
        c.openChallenge(500 + wave, 'break', wave, false, hooks);
        return (c as unknown as { active: { challenge: { text: string } } }).active.challenge.text;
      });
      assert.equal(new Set(lines).size, 1, `wave ${wave}: ${lines.join(' / ')}`);
    }
  } finally {
    Math.random = orig;
  }
});

test('Round 15 follow-up (5): a reloaded host page never reuses the last session byte', () => {
  const storage = new MemoryStorage();
  const orig = Math.random;
  Math.random = () => 0.5;
  try {
    const mk = () =>
      new CoopFlightDirector({
        client: new CoopClient({ code: 'SESS01', role: 'host', callsign: 'ACE', tvMode: false, storage: null }),
        initialSeats: [{ seat: 0, callsign: 'ACE', ready: true, isHost: true, connected: true }],
        storage,
        now: () => 0,
      });
    const a = mk();
    const b = mk();
    const sessionOf = (d: InstanceType<typeof CoopFlightDirector>) => (d as unknown as { hostSessionId: number }).hostSessionId;
    assert.notEqual(sessionOf(a), sessionOf(b));
    a.dispose();
    b.dispose();
  } finally {
    Math.random = orig;
  }
});

test('Round 15 follow-up (7): a replayed late answer gets one reply, not one per copy', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const gd = sq.guestDirs[0]!;
  bombOnGuest(sq);
  await sq.tickSquad(30);
  const id = quizOf(gd)?.id;
  assert.ok(typeof id === 'number');
  await stepHostOnly(sq, COOP_QUIZ_TIMEOUT_SEC + COOP_STALE_HOLD_MAX_SEC + 1); // the host's question runs out
  const closes: unknown[] = [];
  const realEvent = sq.hostClient.sendEvent.bind(sq.hostClient);
  sq.hostClient.sendEvent = (ev) => {
    if (ev.kind === 'challenge-closed') closes.push(ev);
    return realEvent(ev);
  };
  const wire = sq.hostDir as unknown as { handleWireAnswer: (m: unknown) => void };
  for (let i = 0; i < 5; i++) wire.handleWireAnswer({ type: 'answer', seat: 1, id, verdict: 'perfect', quality: 1 });
  assert.equal(closes.length, 1);
  sq.cleanup();
});

test('Round 15 follow-up (8): a phone pilot who steers right after choosing an upgrade still sees what was fitted', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const gd = sq.guestDirs[0]!;
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  sq.hostWorld.pickups.push({ reward: 'upgrade', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(36);
  await answerGuestCard(sq, 0, true, 74);
  await sq.tickSquad(36);
  const offer = gd.currentDeckCard();
  assert.ok(offer && offer.kind === 'offer');
  const pick = offer.upgrades[0]!;
  const boxes = deckCardBoxes(gd.layout, offer);
  gd.handlePointerDown(75, boxes[0]!.x + 12, boxes[0]!.y + 12, true);
  gd.handlePointerUp(75);
  // The thumb goes straight back to steering, before the host's reply arrives.
  const deck = gd.layout.deckRect;
  gd.handlePointerDown(76, deck.x + deck.w / 2, deck.y + deck.h - 12, true);
  gd.handlePointerUp(76);
  await sq.tickSquad(8);
  const st = quizOf(gd);
  assert.equal(st?.stage, 'result');
  assert.equal(st?.headline, `${pick.name} EQUIPPED!`);
  sq.cleanup();
});

test('Round 15 follow-up (10): a right answer that reached the host too late says so, even after its card closed', () => {
  const { CoopLocalQuizController, CLOSE_TIMED_OUT } = quizR15b;
  const hooks = { play() {}, announce() {}, onChallengeSettled() {}, onUpgradeChosen() {} };
  const c = new CoopLocalQuizController({ isolatedGrade: true, initialGrade: 1, initialInputMode: 'touch' });
  c.openChallenge(900, 'defuse', 2, true, hooks);
  c.step(0.5, true, false, hooks); // past the grace
  const card = c.deckCard(true);
  assert.ok(card && card.kind === 'choice');
  c.pickDeckCard(card.correctIndex, true, hooks);
  c.step(0.02, true, false, hooks); // settles: "BOMB DEFUSED +300"
  c.step(2, true, false, hooks); // the card closes
  assert.equal(c.stage, null);
  c.hostClosed(900, CLOSE_TIMED_OUT, null, true, hooks);
  const st = (c as unknown as { active: { stage: string; headline: string; subline: string } | null }).active;
  assert.equal(st?.headline, 'TOO LATE');
  assert.equal(st?.subline, 'THE BOMB WENT OFF');
});

test('Round 15 follow-up (6): a question asked again after a reconnect shows only the time the host still allows', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  const gd = sq.guestDirs[0]!;
  gd.setGrade(1);
  await sq.tickSquad(1);
  const events = gd as unknown as { handleHostEvent: (m: unknown) => void };
  events.handleHostEvent({
    type: 'event',
    kind: 'challenge',
    to: 1,
    id: 7_000_123,
    wave: 2,
    values: [quizR15b.encodeStakeCode('defuse'), 50],
  });
  const st = quizOf(gd);
  assert.equal(st?.stage, 'stake');
  assert.ok(st!.challenge!.timeLeft <= 5.0001, `the card shows ${st!.challenge!.timeLeft.toFixed(1)} s`);
  sq.cleanup();
});

test('Round 15 (4.3): a thumb that lands back on the deck just after a card appears picks nothing; a tap does', async () => {
  setCoopTabGrade(null);
  const sq = await createLiveSquad({ guestCount: 1 });
  const gd = sq.guestDirs[0]!;
  const p1 = sq.hostDir.pilots[1];
  p1.invulnerable = 0;
  sq.hostWorld.pickups.push({ reward: 'hull', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  await sq.tickSquad(20); // 0.33 s: the grade card has been up for its grace
  const card = gd.currentDeckCard();
  assert.ok(card && card.kind === 'grade');
  const rows = deckCardBoxes(gd.layout, card);
  const bottom = rows[rows.length - 1]!;
  // The thumb lifts and lands again on the bottom row, where it rests, and goes on steering.
  gd.handlePointerDown(81, bottom.x + bottom.w / 2, bottom.y + bottom.h / 2, true);
  for (let i = 0; i < 50; i++) {
    gd.handlePointerMove(81, bottom.x + bottom.w / 2 + i * 2, bottom.y + bottom.h / 2);
    await sq.tickSquad(1);
  }
  gd.handlePointerUp(81);
  await sq.tickSquad(2);
  assert.equal(gd.grade, null, 'no grade was picked by the landing thumb');
  assert.equal(quizOf(gd)?.stage, 'grade');
  // A tap on the first row picks it.
  const top = rows[0]!;
  gd.handlePointerDown(82, top.x + 12, top.y + 12, true);
  await sq.tickSquad(6);
  gd.handlePointerUp(82);
  await sq.tickSquad(2);
  assert.equal(gd.grade, 0);
  sq.cleanup();
  setCoopTabGrade(null);
});

test("Round 15 (5.4): HOST AWAY's 3-2-1 is not skipped by a key or click, and hiding again during it waits again", async () => {
  const sq = await createLiveSquad({ tvMode: false, guestCount: 1, nowFn: () => fakeNowMs });
  media.coarse = false;
  docTarget.hidden = false;
  const hostGame = new Game(makeRecordingCanvas(1280, 800) as never, {
    multiplayer: makeFakeMultiplayer() as never,
    coop: { director: sq.hostDir },
    onExit() {},
  });
  const G = hostGame as unknown as Record<string, any>;
  const hide = async (ms: number) => {
    docTarget.hidden = true;
    docTarget.dispatchEvent(new Event('visibilitychange'));
    advanceTimeMs(ms);
    await flushMicrotasks();
  };
  const show = async () => {
    docTarget.hidden = false;
    docTarget.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();
  };
  await hide(2300);
  assert.equal(sq.hostDir.hostAway, true, 'HOST AWAY after 2 s hidden');
  await show();
  assert.equal(sq.hostDir.isResumeCountdownActive, true, 'the 3-2-1 started');

  // The click that brings the window back, and Space, do not skip it.
  G.press();
  G.command('Space');
  assert.equal(hostGame.isPaused, true, 'still counting down');
  assert.equal(sq.hostDir.isResumeCountdownActive, true);

  // Hidden again during the 3-2-1: the squad waits again, however long the host is gone.
  await hide(5000);
  assert.equal(hostGame.isPaused, true, 'the squad did not fly with nobody at the host');
  assert.equal(sq.hostDir.hostAway, true);
  await show();
  assert.equal(sq.hostDir.isResumeCountdownActive, true, 'a fresh 3-2-1 on return');
  const stepFrame = G.frame as (now: number) => void;
  for (let i = 0; i < 65; i++) {
    fakeNowMs += 50;
    stepFrame(fakeNowMs);
  }
  await flushMicrotasks();
  assert.equal(hostGame.isPaused, false, 'and then the squad flies');
  hostGame.destroy();
  sq.cleanup();
});

// -----------------------------------------------------------------------------------------------------------------
// Round 15 follow-up 2 (Claude): what the re-checks of 26d077d and the reviews of 57f22a7 found or could not test.
// -----------------------------------------------------------------------------------------------------------------

test('Round 15 follow-up 2 (b2 6): on a slow host the snapshot shows bullets where they are at its time stamp', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  const game = new Game(makeRecordingCanvas(1280, 800) as never, {
    multiplayer: makeFakeMultiplayer() as never,
    coop: { director: sq.hostDir },
    onExit() {},
  });
  const G = game as unknown as Record<string, any>;
  const W = G.coopAdapter;
  const sent: Uint8Array[] = [];
  const realSend = sq.hostClient.sendBinary.bind(sq.hostClient);
  sq.hostClient.sendBinary = (b: Uint8Array) => {
    sent.push(new Uint8Array(b));
    return realSend(b);
  };
  W.shots.push({ x: 90, y: 120, vx: 0, vy: 240, hostile: true, dead: false, color: '#ff4d4d' });
  let checked = 0;
  for (let f = 0; f < 45; f++) {
    sent.length = 0;
    sq.advanceSimMs(1000 / 30);
    G.update(1 / 30); // a 30 fps host
    const bullet = W.shots.find((sh: { hostile: boolean }) => sh.hostile);
    for (const bytes of sent) {
      const snap = decodeWorldSnapshot(bytes);
      const drawn = snap?.shots.find((sh) => sh.kind === 'enemy');
      if (!snap || !drawn || !bullet) continue;
      assert.ok(Math.abs(drawn.y - bullet.y) < 0.6, `snapshot bullet y ${drawn.y.toFixed(1)}, host ${bullet.y.toFixed(1)}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 10, `${checked} snapshots checked`);
  game.destroy();
  sq.cleanup();
});

test('Round 15 follow-up 2 (b1 1): a pilot still on the grade picker during an upload stall is never blown up', async () => {
  setCoopTabGrade(null);
  const sq = await createLiveSquad({ guestCount: 1 });
  const gc = sq.guestClients[0]!;
  const realSend = gc.sendBinary.bind(gc);
  let stallFrom = Infinity;
  gc.sendBinary = (b: Uint8Array) => (sq.now() >= stallFrom && sq.now() < stallFrom + 4000 ? true : realSend(b));
  const p1 = bombOnGuest(sq);
  await sq.tickSquad(120); // 2 s on the picker
  stallFrom = sq.now(); // then 4 s of uploads lost
  let everDown = false;
  for (let i = 0; i < 38 * 4; i++) {
    await sq.tickSquad(15);
    everDown ||= !p1.alive;
  }
  assert.equal(everDown, false, 'the bomb never went off');
  assert.equal(p1.answering, false, 'the host closed the question');
  assert.equal(sq.guestDirs[0]!.grade, null);
  sq.cleanup();
  setCoopTabGrade(null);
});

test('Round 15 follow-up 2 (b1 3): a break answer is sent again at most three times', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  let answers = 0;
  const gc = sq.guestClients[0]!;
  const realAnswer = gc.sendAnswer.bind(gc);
  gc.sendAnswer = (id: number, verdict: Grade, quality: number) => {
    answers += 1;
    return realAnswer(id, verdict, quality);
  };
  sq.hostDir.beginSquadWaveBreak(2, sq.hostWorld);
  await sq.tickSquad(50);
  await answerGuestCard(sq, 0, true, 91);
  await sq.tickSquad(70);
  await answerGuestCard(sq, 0, true, 92); // the second sum of the touch break
  await sq.tickSquad(60 * 30); // the host's own pilot never answers: the break runs its course
  assert.ok(answers >= 1 && answers <= 4, `${answers} copies of the break answer`);
  sq.cleanup();
});

test("Round 15 follow-up 2 (b1 4): a question lost while the host's link was down is asked again when it returns", async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const hc = sq.hostClient;
  const emit = (hc as unknown as { emit: (k: string, ...a: unknown[]) => void }).emit.bind(hc);
  const realEvent = hc.sendEvent.bind(hc);
  let down = true;
  hc.sendEvent = (ev) => (down && ev.kind === 'challenge' ? true : realEvent(ev));
  emit('onConnectionChange', false); // the host's link drops; the bomb's question is lost on the way
  const p1 = bombOnGuest(sq);
  await sq.tickSquad(20);
  assert.equal(quizOf(sq.guestDirs[0]!), null, 'the guest never got the question');
  down = false;
  emit('onWelcome', {}); // the link is back
  await sq.tickSquad(20);
  assert.equal(quizOf(sq.guestDirs[0]!)?.stage, 'stake', 'the host asked again');
  assert.equal(p1.answering, true);
  sq.cleanup();
});

test('Round 15 follow-up 2 (b1 n07): a question asked again after a reconnect carries the time the host still allows', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  bombOnGuest(sq);
  await sq.tickSquad(60 * 6);
  const asked: Array<{ values?: number[] }> = [];
  const realEvent = sq.hostClient.sendEvent.bind(sq.hostClient);
  sq.hostClient.sendEvent = (ev) => {
    if (ev.kind === 'challenge') asked.push(ev as { values?: number[] });
    return realEvent(ev);
  };
  const lobby = (sq.hostDir as unknown as { handleLobbyUpdate: (l: unknown) => void }).handleLobbyUpdate.bind(sq.hostDir);
  const seats = sq.hostClient.seats.map((s) => ({ ...s }));
  lobby({ code: 'PH3TST', seats: seats.map((s) => (s.seat === 1 ? { ...s, connected: false } : s)) });
  lobby({ code: 'PH3TST', seats });
  const ch = (sq.hostDir as unknown as { hostSeatChallenge: Array<{ expiresAtSec: number } | null>; elapsedSec: number });
  const left = ch.hostSeatChallenge[1]!.expiresAtSec - ch.elapsedSec - 2.5;
  assert.equal(asked.length, 1);
  assert.ok(Math.abs((asked[0]!.values?.[1] ?? NaN) / 10 - left) <= 0.11, `asked with ${asked[0]!.values?.[1]} tenths, host allows ${left.toFixed(2)} s`);
  sq.cleanup();
});

test('Round 15 follow-up 2 (b1 n15): a break card waits until "BOMB DEFUSED" has been shown', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const gd = sq.guestDirs[0]!;
  bombOnGuest(sq);
  await sq.tickSquad(36);
  sq.hostDir.beginSquadWaveBreak(2, sq.hostWorld); // the break is due while the bomb is open
  await sq.tickSquad(4);
  await answerGuestCard(sq, 0, true, 93);
  const stages: string[] = [];
  for (let f = 0; f < 90; f++) {
    await sq.tickSquad(1);
    const st = quizOf(gd)?.stage ?? 'none';
    if (stages[stages.length - 1] !== st) stages.push(st);
  }
  assert.deepEqual(stages.slice(0, 2), ['stake', 'break'], `stages: ${stages.join(' > ')}`);
  sq.cleanup();
});

test('Round 15 follow-up 2 (b1 m04): the break waits while a pilot picks a grade', async () => {
  setCoopTabGrade(null);
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.hostDir.beginSquadWaveBreak(2, sq.hostWorld);
  await sq.tickSquad(10);
  assert.equal(quizOf(sq.guestDirs[0]!)?.stage, 'grade');
  const brk = () => (sq.hostDir as unknown as { hostBreak: { expiresAtSec: number } | null; elapsedSec: number });
  const leftBefore = brk().hostBreak!.expiresAtSec - brk().elapsedSec;
  await sq.tickSquad(60 * 8); // eight seconds on the picker
  const leftAfter = brk().hostBreak!.expiresAtSec - brk().elapsedSec;
  assert.ok(leftAfter >= leftBefore - 0.5, `the break's window went from ${leftBefore.toFixed(1)} to ${leftAfter.toFixed(1)} s`);
  sq.cleanup();
  setCoopTabGrade(null);
});

test('Round 15 follow-up 2 (privacy): the touch break gives every band the same clock on both sums, and host limits include the graces', () => {
  const { CoopLocalQuizController, coopClock, coopStakeMaxSec, coopBreakMaxSec, coopBreakLineClock } = quizR15b;
  const { PROMPT_GRACE, PROMPT_SECONDS, BREAK_GRACE, ROUND_SECONDS } = questionsR15;
  const hooks = { play() {}, announce() {}, onChallengeSettled() {}, onUpgradeChosen() {} };
  const limits = ([0, 1, 2] as const).map((band) => {
    const c = new CoopLocalQuizController({ isolatedGrade: true, initialGrade: band, initialInputMode: 'touch' });
    c.openChallenge(700, 'break', 6, true, hooks);
    c.step(BREAK_GRACE + 0.05, true, true, hooks);
    const first = c.deckCard(true)!;
    assert.ok(first.kind === 'choice');
    const firstLimit = first.timeLimit;
    c.pickDeckCard((first.correctIndex + 1) % first.options.length, true, hooks);
    c.step(0.02, true, true, hooks);
    c.step(1.2, true, true, hooks); // the pause after a wrong answer
    const second = c.deckCard(true)!;
    assert.ok(second.kind === 'choice');
    return [firstLimit, second.timeLimit];
  });
  assert.deepEqual(limits[0], limits[1]);
  assert.deepEqual(limits[0], limits[2]);
  assert.equal(limits[0]![1], coopClock(ROUND_SECONDS), 'the second sum gets the shared clock');
  // The host's own limits leave 2.5 s for the network after a pilot's whole question, graces included.
  assert.ok(Math.abs(coopStakeMaxSec() - (PROMPT_GRACE + coopClock(PROMPT_SECONDS))) < 1e-9);
  assert.ok(COOP_QUIZ_TIMEOUT_SEC - coopStakeMaxSec() >= 2.5 - 1e-9);
  for (const wave of [1, 3, 5, 9]) {
    assert.ok(coopBreakMaxSec(wave) >= BREAK_GRACE + coopBreakLineClock(wave) - 1e-9);
    assert.ok(coopBreakWindowSec(wave) - coopBreakMaxSec(wave) >= 2.5 - 1e-9);
  }
});

test("Round 15 follow-up 2 (privacy): the host ignores a guest's score, and the boss's sums follow no pilot's band", async () => {
  // A forged score gives the squad no more power than a plain right answer.
  const energyAfter = async (quality: number) => {
    const sq = await createLiveSquad({ guestCount: 1 });
    sq.hostDir.setGrade(1);
    sq.guestDirs[0]!.setGrade(1);
    const p1 = sq.hostDir.pilots[1];
    p1.invulnerable = 0;
    sq.hostWorld.energy = 0.2;
    sq.hostWorld.pickups.push({ reward: 'energy', x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false });
    sq.hostDir.collideHostSquad(sq.hostWorld, 1);
    await sq.tickSquad(10);
    const id = (sq.hostDir as unknown as { hostSeatChallenge: Array<{ id: number } | null> }).hostSeatChallenge[1]!.id;
    (sq.hostDir as unknown as { handleWireAnswer: (m: unknown) => void }).handleWireAnswer({
      type: 'answer',
      seat: 1,
      id,
      verdict: 'good',
      quality,
    });
    const e = sq.hostWorld.energy;
    sq.cleanup();
    return e;
  };
  assert.equal(await energyAfter(0.9672), await energyAfter(0.7));

  for (const grade of [0, 1, 2] as const) {
    const sq = await createLiveSquad({ guestCount: 1 });
    sq.hostDir.setGrade(grade);
    const game = new Game(makeRecordingCanvas(1280, 800) as never, {
      multiplayer: makeFakeMultiplayer() as never,
      coop: { director: sq.hostDir },
      onExit() {},
    });
    const G = game as unknown as Record<string, any>;
    for (const wave of [2, 3, 4, 5, 6, 7, 8]) {
      G.wave = wave;
      const hard = Array.from({ length: 40 }, () => G.env.problem().question as string).filter((q) => /[×÷]/.test(q));
      assert.equal(hard.length, 0, `host band ${grade}, wave ${wave}: ${hard.slice(0, 2).join(', ')}`);
    }
    game.destroy();
    sq.cleanup();
  }
});

test('Round 15 (6): an answer that reaches a paused host changes nothing until play resumes, then counts', async () => {
  const sq = await createLiveSquad({ guestCount: 1 });
  sq.hostDir.setGrade(1);
  sq.guestDirs[0]!.setGrade(1);
  const p1 = bombOnGuest(sq);
  await sq.tickSquad(36); // past the grace: the guest shows the question
  sq.hostWorld.paused = true; // the host pauses just as the guest answers
  await answerGuestCard(sq, 0, true, 96);
  await sq.tickSquad(30);
  assert.equal(p1.answering, true, 'nothing changes while the host is paused');
  assert.equal(p1.alive, true);
  sq.hostWorld.paused = false;
  await sq.tickSquad(6);
  assert.equal(p1.answering, false, 'the answer counts once play resumes');
  assert.equal(p1.alive, true, 'the bomb was defused, not set off');
  sq.cleanup();
});

test('Round 15 (5.11): a number key pressed before a grade or upgrade can be picked sounds, and picks nothing', () => {
  const { CoopLocalQuizController, COOP_GRADE_GRACE_SEC } = quizR15b;
  const { OFFER_GRACE } = questionsR15;
  const played: string[] = [];
  const hooks = { play: (s: string) => played.push(s), announce() {}, onChallengeSettled() {}, onUpgradeChosen() {} };
  const q = new CoopLocalQuizController({ isolatedGrade: true, initialInputMode: 'keys' });
  q.openChallenge(20, 'hull', 2, false, hooks);
  assert.equal(q.stage, 'grade');
  q.step(COOP_GRADE_GRACE_SEC / 2, false, false, hooks);
  assert.equal(q.typeKey('2', false, hooks), true);
  assert.deepEqual(played, ['slip'], 'the early key is heard');
  assert.equal(q.stage, 'grade', 'and picks nothing');
  q.step(COOP_GRADE_GRACE_SEC, false, false, hooks);
  assert.equal(q.typeKey('2', false, hooks), true);
  assert.equal(q.getGrade(), 1, 'after the grace the key picks');

  played.length = 0;
  const offerQ = new CoopLocalQuizController({ isolatedGrade: true, initialGrade: 1, initialInputMode: 'keys' });
  assert.equal(offerQ.openUpgradeOffer(30, [0, 1, 2], hooks), true);
  offerQ.step(OFFER_GRACE / 2, false, false, hooks);
  assert.equal(offerQ.typeKey('1', false, hooks), true);
  assert.deepEqual(played, ['slip']);
  assert.equal(offerQ.stage, 'offer');
});

test("Round 15 review (b2r 5): if the host's \"question closed\" is lost, a guest's picker closes on its own and it can fire again", async () => {
  setCoopTabGrade(null);
  const sq = await createLiveSquad({ guestCount: 1 });
  const hc = sq.hostClient;
  const realEvent = hc.sendEvent.bind(hc);
  hc.sendEvent = (ev) => (ev.kind === 'challenge-closed' ? true : realEvent(ev)); // every close is lost
  const p1 = bombOnGuest(sq);
  await sq.tickSquad(60 * 2);
  const gd = sq.guestDirs[0]!;
  assert.equal(quizOf(gd)?.stage, 'grade', 'the guest is on the grade picker');
  // Nobody picks: the host closes the question at 12 s (nothing lost), but the guest never hears it.
  let closedAt: number | null = null;
  for (let i = 0; i < 60 * 20 && closedAt === null; i++) {
    await sq.tickSquad(1);
    if (quizOf(gd)?.stage !== 'grade') closedAt = (i + 120) / 60;
  }
  assert.equal(p1.alive, true, 'nothing was lost');
  assert.ok(closedAt !== null && closedAt < 15, `the picker closed after ${closedAt?.toFixed(1)} s`);
  assert.equal(gd.quiz.isInteractive(), false, 'and no longer stops the guest firing');
  sq.cleanup();
  setCoopTabGrade(null);
});
