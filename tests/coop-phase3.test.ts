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
const { CoopFlightDirector, formationSpawnForSeat } = await import('../src/game/coop-flight');
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

  // Now clear shelter and trigger a BOMB (`defuse`) on P2, then let 26s timeout expire -> ONLY P2 goes down; P1 keeps flying!
  p1.invulnerable = 0;
  p1.jamSec = 0;
  sq.hostWorld.mines.push({ x: p1.x, y: p1.y, anchorX: p1.x, phase: 0, age: 0, dead: false, thrown: false });
  sq.hostDir.collideHostSquad(sq.hostWorld, 1);
  assert.equal(p1.answering, true);

  // Advance 26.5s on Host (> 26s challenge timeout)
  for (let i = 0; i < 54; i++) {
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
