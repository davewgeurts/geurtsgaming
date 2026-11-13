import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoopRoom } from '../relay/room.mjs';
import { createBoss, tapBoss, type Boss, type BossEnv } from '../src/game/boss';
import { CoopClient, type CoopConnectOptions, type StorageLike } from '../src/game/coop-client';
import {
  COOP_WINGMAN_RESPAWN_SEC,
  CoopFlightDirector,
  formationSpawnForSeat,
  type CoopLocalControlInput,
  type CoopMineItem,
  type CoopPickupItem,
  type CoopWorldAdapter,
} from '../src/game/coop-flight';
import { COOP_WORLD_H, COOP_WORLD_W, decodeGuestInput, decodeWorldSnapshot } from '../src/game/coop-protocol';
import { COOP_SEAT_COLORS, type CoopErrorMessage } from '../src/game/coop-types';
import { KINDS, makeEnemy, type Enemy } from '../src/game/enemies';
import { makeProblem } from '../src/game/maths';
import { ALERT_LEAD, SetPieces, type SetPieceEnv } from '../src/game/setpieces';
import type { Shape } from '../src/game/shapes';
import type { Sfx } from '../src/game/sound';
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

interface BridgeHandle {
  WsCtor: unknown;
  sentTextsBySeat: Map<number, string[]>;
  receivedEventsByClientId: Map<string, Array<Record<string, unknown>>>;
}

function createRoomWsBridge(room: InstanceType<typeof CoopRoom>): BridgeHandle {
  const sentTextsBySeat = new Map<number, string[]>();
  const receivedEventsByClientId = new Map<string, Array<Record<string, unknown>>>();

  class RoomBridgeWs extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readonly url: string;
    readyState = RoomBridgeWs.CONNECTING;
    binaryType = 'arraybuffer';
    private cid = '';
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
      this.cid = parsed.searchParams.get('cid') || '';

      this.peerConn = {
        sendText: (str: string) => {
          try {
            const msg = JSON.parse(str) as Record<string, unknown>;
            if (msg.type === 'event') {
              const arr = receivedEventsByClientId.get(this.cid) ?? [];
              arr.push(msg);
              receivedEventsByClientId.set(this.cid, arr);
            }
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
          clientId: this.cid,
        });
      });
    }

    send(data: string | Uint8Array): void {
      if (this.readyState !== RoomBridgeWs.OPEN) return;
      if (typeof data === 'string') {
        const list = sentTextsBySeat.get(0) ?? [];
        list.push(data);
        sentTextsBySeat.set(0, list);
        room.handleText(this.peerConn, data);
      } else {
        room.handleBinary(this.peerConn, new Uint8Array(data));
      }
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState === RoomBridgeWs.CLOSED) return;
      this.readyState = RoomBridgeWs.CLOSED;
      room.disconnect(this.peerConn);
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
    }
  }

  return { WsCtor: RoomBridgeWs, sentTextsBySeat, receivedEventsByClientId };
}

class HeadlessArenaWorld implements CoopWorldAdapter {
  wave = 1;
  banner = 2.0;
  score = 0;
  freed = 0;
  energy = 0.75;
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

  readonly playedSfx: Sfx[] = [];
  bursts = 0;
  sparks = 0;
  bossTaps: Array<{ x: number; y: number }> = [];

  private readonly setsEnvObj: SetPieceEnv;
  readonly bossEnvObj: BossEnv;

  constructor(seeded = true) {
    this.setsEnvObj = {
      w: COOP_WORLD_W,
      h: COOP_WORLD_H,
      top: 0,
      left: 0,
      right: 0,
      scale: 1,
      pace: 1,
      shipScale: 1.15,
      wave: 1,
      time: 0,
      playing: true,
      shipX: COOP_WORLD_W / 2,
      shipY: COOP_WORLD_H * 0.85,
      seeded,
      play: (s) => this.playedSfx.push(s),
      say: () => {},
      radio: () => {},
      call: () => {},
      feel: () => {},
      award: (pts) => {
        this.score += pts;
      },
      charge: (amt) => {
        this.energy = Math.min(1, this.energy + amt);
      },
      ring: (x, y, color, reach) => this.rings.push({ x, y, age: 0, color, reach }),
      spark: () => {
        this.sparks += 1;
      },
      burst: () => {
        this.bursts += 1;
      },
      bomb: (x, y, ride) => {
        this.mines.push({ x, y, anchorX: x, phase: 0, age: 0, dead: false, thrown: false, ride });
      },
      capsule: (x, y, ride, last) => {
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

    this.bossEnvObj = {
      w: COOP_WORLD_W,
      h: COOP_WORLD_H,
      top: 0,
      scale: 1,
      pace: 1,
      headroom: 104,
      sweep: Infinity,
      calm: false,
      shipX: COOP_WORLD_W / 2,
      shipY: COOP_WORLD_H * 0.85,
      fire: (x, y, vx, vy, color) => {
        this.shots.push({ x, y, vx, vy, hostile: true, dead: false, color });
      },
      bomb: () => {},
      burst: () => {
        this.bursts += 1;
      },
      problem: () => makeProblem(1),
    };
  }

  setEnv(): SetPieceEnv {
    this.setsEnvObj.wave = this.wave;
    this.setsEnvObj.playing = !this.gameOver;
    return this.setsEnvObj;
  }

  play(sfx: Sfx): void {
    this.playedSfx.push(sfx);
  }

  spark(): void {
    this.sparks += 1;
  }

  burst(_shape: Shape, _x: number, _y: number, _scale: number, _rot: number, _color: string): void {
    this.bursts += 1;
  }

  ring(x: number, y: number, color: string, reach?: number): void {
    this.rings.push({ x, y, age: 0, color, reach });
  }

  free(_x: number, _y: number, count = 1): void {
    this.freed += count;
  }

  strikeBoss(x: number, y: number, _aimed: boolean, tapped = false): boolean {
    if (!this.boss) return false;
    if (tapped) {
      this.bossTaps.push({ x, y });
      return tapBoss(this.boss, x, y, this.bossEnvObj) !== 'miss';
    }
    return false;
  }

  damageEnemy(e: Enemy, amount: number): void {
    e.hp -= amount;
    if (e.hp <= 0) this.destroyEnemy(e);
  }

  destroyEnemy(e: Enemy): void {
    e.dead = true;
    this.score += KINDS[e.kind].points;
    this.freed += 1;
    this.bursts += 1;
  }

  equipUpgrade(id: UpgradeId): void {
    this.upgrades.add(id);
  }

  detonateScreen(ox: number, oy: number, color: string): void {
    for (const e of this.enemies) e.dead = true;
    this.rings.push({ x: ox, y: oy, age: 0, color });
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
}

const idleCtrl: CoopLocalControlInput = {
  across: 0,
  down: 0,
  touching: false,
  touchX: 0,
  touchY: 0,
  firing: false,
};

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 8));

test('4-ship Co-op flight moves & fires across Host + 3 Guests, syncs Sum Boss taps & FX in snapshots, and stays well under relay rate budget', async () => {
  const room = new CoopRoom('FGGT42');
  const bridge = createRoomWsBridge(room);
  const relayErrors: CoopErrorMessage[] = [];
  let clockMs = 1_000;
  const now = () => clockMs;

  const makeClient = (opts: Omit<CoopConnectOptions, 'code' | 'WebSocketConstructor' | 'wsBase'>) =>
    new CoopClient({
      ...opts,
      code: 'FGGT42',
      wsBase: 'ws://localhost:84/relay',
      WebSocketConstructor: bridge.WsCtor,
      pingIntervalMs: 0,
      onRelayError: (err) => relayErrors.push(err),
    });

  const hostStore = new MemoryStorage();
  const g1Store = new MemoryStorage();
  const g2Store = new MemoryStorage();
  const g3Store = new MemoryStorage();

  const hostClient = makeClient({ role: 'host', callsign: 'NOVA-1', storage: hostStore });
  const g1Client = makeClient({ role: 'guest', callsign: 'STAR-2', storage: g1Store });
  const g2Client = makeClient({ role: 'guest', callsign: 'COMET-3', storage: g2Store });
  const g3Client = makeClient({ role: 'guest', callsign: 'ORBIT-4', storage: g3Store });

  hostClient.connect();
  g1Client.connect();
  g2Client.connect();
  g3Client.connect();
  await flushMicrotasks();

  assert.equal(hostClient.seat, 0);
  assert.equal(g1Client.seat, 1);
  assert.equal(g2Client.seat, 2);
  assert.equal(g3Client.seat, 3);

  hostClient.startSquad();
  await flushMicrotasks();
  assert.equal(hostClient.locked, true);

  const hostWorld = new HeadlessArenaWorld();
  const g1World = new HeadlessArenaWorld();
  const g2World = new HeadlessArenaWorld();
  const g3World = new HeadlessArenaWorld();

  const hostDir = new CoopFlightDirector({ client: hostClient, storage: hostStore, now });
  const g1Dir = new CoopFlightDirector({ client: g1Client, storage: g1Store, now });
  const g2Dir = new CoopFlightDirector({ client: g2Client, storage: g2Store, now });
  const g3Dir = new CoopFlightDirector({ client: g3Client, storage: g3Store, now });

  // All 4 seats spawn in formation inside `768 x 1024` with their distinct neon colors
  for (let s = 0; s < 4; s++) {
    const expected = formationSpawnForSeat(s as 0 | 1 | 2 | 3);
    assert.equal(hostDir.pilots[s]!.present, true);
    assert.equal(hostDir.pilots[s]!.x, expected.x);
    assert.equal(hostDir.pilots[s]!.y, expected.y);
    assert.equal(hostDir.pilots[s]!.color, COOP_SEAT_COLORS[s]);
  }

  // Spawn an enemy on Host + a Sum Boss on Wave 2 so we also test FX ring & numeric Sum Boss sync
  hostWorld.wave = 2;
  const targetEnemy = makeEnemy('hex', hostDir.pilots[1].x, hostDir.pilots[1].y - 120);
  targetEnemy.hp = 1;
  hostWorld.enemies.push(targetEnemy);

  const sumBoss = createBoss(2, hostWorld.bossEnvObj);
  sumBoss.state = 'fight';
  sumBoss.x = COOP_WORLD_W / 2;
  sumBoss.y = 220;
  sumBoss.problem = { question: '14 + 5', answer: 19, options: [17, 19, 21] };
  sumBoss.problemId = 1;
  sumBoss.pods = sumBoss.problem.options.map((value, slot) => ({
    slot,
    value,
    hits: 0,
    cool: 0.7,
    flash: 0,
  }));
  hostWorld.boss = sumBoss;

  // Step 36 frames (600ms at 60fps):
  // - Guest 1 flies up-left via pointer & fires cannon bolts (destroying `targetEnemy`)
  // - Guest 2 flies right via keyboard & fires
  // - Guest 3 stays in formation, then taps the middle Sum Boss pod (`value: 19`)!
  const dt = 1 / 60;
  for (let frame = 0; frame < 36; frame++) {
    clockMs += dt * 1000;

    g1Dir.step(
      dt,
      dt,
      g1World,
      {
        across: 0,
        down: 0,
        touching: true,
        touchX: 220,
        touchY: 640,
        firing: true,
      },
    );
    g2Dir.step(
      dt,
      dt,
      g2World,
      {
        across: 1,
        down: 0,
        touching: false,
        touchX: 0,
        touchY: 0,
        firing: true,
      },
    );
    if (frame === 18 && g3World.boss && g3World.boss.pods.length === 3) {
      // Pod slot 1 (middle pod = right answer 19) hangs directly below `boss.x` at `boss.y + 82 * 1.3`
      g3Dir.queueArenaTap(g3World.boss.x, g3World.boss.y + 82 * 1.3, g3World);
    }
    g3Dir.step(dt, dt, g3World, idleCtrl);

    // Move shots on Host, step Host squad, and collide
    for (const sh of hostWorld.shots) {
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
    }
    hostDir.step(dt, dt, hostWorld, { ...idleCtrl, across: -1, firing: true });
    hostDir.collideHostSquad(hostWorld, 1);
    hostWorld.enemies = hostWorld.enemies.filter((e) => !e.dead);
    hostWorld.shots = hostWorld.shots.filter((s) => !s.dead);

    await flushMicrotasks();
  }

  // 1. Zero rate-limit errors from `CoopRoom`
  assert.equal(relayErrors.length, 0, 'Host + 3 Guests stay strictly under relay rate limits');

  // 2. Guest 1 moved immediately on its own screen AND moved authoritatively on Host & Guest 3
  assert.ok(g1Dir.pilots[1].x < 300 && g1Dir.pilots[1].y < 800);
  assert.ok(Math.abs(hostDir.pilots[1].x - g1Dir.pilots[1].x) < 35);
  assert.ok(Math.abs(g3Dir.pilots[1].x - hostDir.pilots[1].x) < 45);

  // 3. Guest 2 moved right via keyboard and fired seat-colored bolts (`COOP_SEAT_COLORS[2]`)
  assert.ok(hostDir.pilots[2].x > formationSpawnForSeat(2).x + 120);
  assert.ok(
    g1World.shots.some((s) => s.color === COOP_SEAT_COLORS[2]),
    'Guest 1 sees Guest 2 cannon bolts in Guest 2 neon color',
  );

  // 4. `targetEnemy` was destroyed by Guest 1's bolts, awarding shared team score + FX burst on Guests!
  assert.equal(targetEnemy.dead, true);
  assert.ok(hostWorld.score >= KINDS.hex.points);
  assert.equal(g2World.score, hostWorld.score);
  assert.ok(g2World.bursts >= 1, 'Enemy explosion FX arrived inside BIN_FRAME_SNAP without JSON spam');
  assert.ok(g2World.playedSfx.includes('boom'));

  // 5. Guest 3's arena tap on the Sum Boss's right-answer pod (`19`) reached Host & opened Boss armour!
  assert.ok(hostWorld.bossTaps.length >= 1, 'Guest 3 arena tap forwarded to Host via BIN_FRAME_INPUT');
  assert.ok(sumBoss.openFor > 0, 'Tapping right Sum Boss pod opened Boss armour on Host');

  hostDir.dispose();
  g1Dir.dispose();
  g2Dir.dispose();
  g3Dir.dispose();
  hostClient.dispose();
  g1Client.dispose();
  g2Client.dispose();
  g3Client.dispose();
});

test('Mid-field Guest reconnect receives targeted (to: seat) asteroid-field resync, and wingman reboot / pause / host-reconnect work cleanly', async () => {
  const room = new CoopRoom('SYNC88');
  const bridge = createRoomWsBridge(room);
  let clockMs = 5_000;
  const now = () => clockMs;

  const makeClient = (opts: Omit<CoopConnectOptions, 'code' | 'WebSocketConstructor' | 'wsBase'>) =>
    new CoopClient({
      ...opts,
      code: 'SYNC88',
      wsBase: 'ws://localhost:84/relay',
      WebSocketConstructor: bridge.WsCtor,
      pingIntervalMs: 0,
    });

  const hostStore = new MemoryStorage();
  const g1Store = new MemoryStorage();
  const g2Store = new MemoryStorage();

  const hostClient = makeClient({ role: 'host', callsign: 'NOVA-1', storage: hostStore });
  const g1Client = makeClient({ role: 'guest', callsign: 'STAR-2', storage: g1Store });
  let g2Client = makeClient({ role: 'guest', callsign: 'COMET-3', storage: g2Store });

  hostClient.connect();
  g1Client.connect();
  g2Client.connect();
  await flushMicrotasks();

  hostClient.startSquad();
  await flushMicrotasks();

  const hostWorld = new HeadlessArenaWorld(true);
  const g1World = new HeadlessArenaWorld(true);
  const g2World = new HeadlessArenaWorld(true);

  const hostDir = new CoopFlightDirector({ client: hostClient, storage: hostStore, now });
  const g1Dir = new CoopFlightDirector({ client: g1Client, storage: g1Store, now });
  let g2Dir = new CoopFlightDirector({ client: g2Client, storage: g2Store, now });

  hostWorld.wave = 3;
  hostWorld.score = 1250;
  hostWorld.freed = 9;
  hostDir.notifyHostWaveStart(3, 1250, 9);

  // Start a seeded asteroid field on Host, advance `front`, and break 2 rocks!
  hostWorld.sets.plan([{ at: 0, kind: 'rocks' }]);
  hostWorld.sets.advance(0, 0.1);
  hostWorld.sets.run(0.1, 0.1, hostWorld.setEnv(), 0, false); // raises alarm & picks seed
  hostWorld.sets.run(ALERT_LEAD + 0.2, ALERT_LEAD + 0.2, hostWorld.setEnv(), 0, false); // creates field
  hostWorld.sets.run(1.5, 1.5, hostWorld.setEnv(), 0, false); // advances front
  assert.ok(hostWorld.sets.field);
  assert.ok(hostWorld.sets.fieldSeed !== null);

  const brokenA = hostWorld.sets.field.rocks[0]!;
  const brokenB = hostWorld.sets.field.rocks[1]!;
  hostWorld.sets.breakRock(brokenA, hostWorld.setEnv());
  hostWorld.sets.breakRock(brokenB, hostWorld.setEnv());
  assert.deepEqual(hostWorld.sets.brokenRockIds, [brokenA.id, brokenB.id]);

  // Step once so `activeWorld` is bound on Host & Guests
  hostDir.step(1 / 60, 1 / 60, hostWorld, idleCtrl);
  g1Dir.step(1 / 60, 1 / 60, g1World, idleCtrl);
  g2Dir.step(1 / 60, 1 / 60, g2World, idleCtrl);
  await flushMicrotasks();

  // Clear recorded Guest 1 events before Guest 2 drops & reconnects
  const g1Cid = g1Store.getItem('gg_coop_cid')!;
  bridge.receivedEventsByClientId.set(g1Cid, []);

  // Simulate Guest 2 Wi-Fi drop / page refresh (socket closes WITHOUT `leave`, keeping seat token in `g2Store`)
  g2Dir.dispose();
  g2Client.dispose();
  await flushMicrotasks();
  assert.equal(hostDir.pilots[2].connected, false);

  // Guest 2 reconnects with a brand-new `CoopClient` + `CoopFlightDirector` + `HeadlessArenaWorld`
  const g2ResumedWorld = new HeadlessArenaWorld(true);
  g2Client = makeClient({ role: 'guest', callsign: 'COMET-3', storage: g2Store });
  g2Dir = new CoopFlightDirector({ client: g2Client, storage: g2Store, now });
  // Bind `activeWorld` before messages arrive (just like `Game` constructor does)
  g2Dir.step(0, 0, g2ResumedWorld, idleCtrl);
  g2Client.connect();
  await flushMicrotasks();

  assert.equal(g2Client.seat, 2, 'Guest 2 reclaimed seat 2 via sessionStorage token');
  assert.equal(g2ResumedWorld.wave, 3, 'Targeted wave-sync restored Wave 3 on Guest 2');
  assert.equal(g2ResumedWorld.score, hostWorld.score);
  assert.ok(g2ResumedWorld.sets.field, 'Targeted asteroid-field resync rebuilt seeded belt on Guest 2');
  assert.equal(g2ResumedWorld.sets.field.seed, hostWorld.sets.field.seed);
  assert.equal(
    g2ResumedWorld.sets.field.rocks.some((r) => r.id === brokenA.id || r.id === brokenB.id),
    false,
    'Already-broken rock IDs were stripped on Guest 2 immediately upon reconnect',
  );
  assert.equal(
    (bridge.receivedEventsByClientId.get(g1Cid) ?? []).length,
    0,
    'Reconnect resync events were unicast (`to: 2`) and did NOT spam Guest 1',
  );

  // Test `host-paused` propagation
  hostWorld.paused = true;
  hostClient.sendHostPaused(true);
  await flushMicrotasks();
  assert.equal(g1Dir.hostPaused, true);
  assert.equal(g1World.paused, true);
  hostWorld.paused = false;
  hostClient.sendHostPaused(false);
  await flushMicrotasks();
  assert.equal(g1Dir.hostPaused, false);

  // Test Wingman 6s Auto-Reboot (Guest 1 knocked down while Host is still alive -> reboots after 6s!)
  g1Dir.pilots[1].invulnerable = 0;
  hostDir.pilots[1].invulnerable = 0;
  hostDir.pilots[1].hull = 1;
  hostWorld.shots.push({
    x: hostDir.pilots[1].x,
    y: hostDir.pilots[1].y,
    vx: 0,
    vy: 200,
    hostile: true,
    dead: false,
    color: '#ff4466',
  });
  hostDir.collideHostSquad(hostWorld, 1);
  assert.equal(hostDir.pilots[1].alive, false);
  assert.equal(hostDir.pilots[1].respawnSec, COOP_WINGMAN_RESPAWN_SEC);
  assert.equal(hostWorld.gameOver, false, 'Squad continues flying while >= 1 pilot remains alive');

  for (let i = 0; i < 62; i++) {
    clockMs += 100;
    hostDir.step(0.1, 0.1, hostWorld, idleCtrl);
  }
  assert.equal(hostDir.pilots[1].alive, true, 'Knocked-down wingman auto-rebooted after 6.0s');
  assert.ok(hostDir.pilots[1].hull >= 2);

  // Test Host disconnect -> `hostReconnecting` banner on Guests -> `hostResumed` + saved progress continuity
  assert.deepEqual(hostDir.loadSavedHostProgress(), { wave: 3, score: 1250, freed: 9 });
  hostDir.dispose();
  hostClient.dispose();
  await flushMicrotasks();
  assert.equal(g1Dir.hostReconnecting, true);

  const resumedHostClient = makeClient({ role: 'host', callsign: 'NOVA-1', storage: hostStore });
  const resumedHostDir = new CoopFlightDirector({ client: resumedHostClient, storage: hostStore, now });
  resumedHostClient.connect();
  await flushMicrotasks();
  assert.equal(g1Dir.hostReconnecting, false, 'Host reconnect cleared hostReconnecting on Guests');
  assert.deepEqual(resumedHostDir.loadSavedHostProgress(), { wave: 3, score: 1250, freed: 9 });

  resumedHostDir.dispose();
  g1Dir.dispose();
  g2Dir.dispose();
  resumedHostClient.dispose();
  g1Client.dispose();
  g2Client.dispose();
});

test('Gate 2 fixes: Host reload unfreezes Guest in <= 0.1s, 4-ship saturation drops 0 enemy bullets/rockets, missed pause self-heals, and squad limbo triggers Game Over', async () => {
  const room = new CoopRoom('GATE22');
  const bridge = createRoomWsBridge(room);
  let clockMs = 10_000;
  const now = () => clockMs;

  const makeClient = (opts: Omit<CoopConnectOptions, 'code' | 'WebSocketConstructor' | 'wsBase'>) =>
    new CoopClient({
      ...opts,
      code: 'GATE22',
      wsBase: 'ws://localhost:84/relay',
      WebSocketConstructor: bridge.WsCtor,
      pingIntervalMs: 0,
    });

  const hostStore = new MemoryStorage();
  const g1Store = new MemoryStorage();
  let hostClient = makeClient({ role: 'host', callsign: 'NOVA-1', storage: hostStore });
  const g1Client = makeClient({ role: 'guest', callsign: 'STAR-2', storage: g1Store });

  hostClient.connect();
  g1Client.connect();
  await flushMicrotasks();
  hostClient.startSquad();
  await flushMicrotasks();

  let hostWorld = new HeadlessArenaWorld(true);
  const g1World = new HeadlessArenaWorld(true);
  let hostDir = new CoopFlightDirector({ client: hostClient, storage: hostStore, now });
  const g1Dir = new CoopFlightDirector({ client: g1Client, storage: g1Store, now });
  hostDir.bindWorld(hostWorld);
  g1Dir.bindWorld(g1World);

  // --- 3.2: Saturated 4-ship fire (`rapid` + `wide` + `wingmates` + `pierce`) + 24 enemy bullets + 4 rockets ---
  hostWorld.upgrades.add('rapid');
  hostWorld.upgrades.add('wide');
  hostWorld.upgrades.add('wingmates');
  hostWorld.upgrades.add('pierce');
  hostWorld.upgrades.add('rockets');
  for (let i = 0; i < 24; i++) {
    hostWorld.shots.push({
      x: 100 + i * 20,
      y: 260,
      vx: 0,
      vy: 180,
      hostile: true,
      dead: false,
      color: '#ff4466',
    });
  }
  for (let i = 0; i < 4; i++) {
    hostWorld.rockets.push({ x: 200 + i * 60, y: 500, vx: 0, vy: -220, age: 0.1, dead: false });
  }
  // Also add 90 friendly bolts on Host to exceed SNAP_MAX_SHOTS (52) by > 2x
  for (let i = 0; i < 90; i++) {
    hostWorld.shots.push({
      x: 300,
      y: 700 - (i % 40) * 8,
      vx: 0,
      vy: -600,
      hostile: false,
      dead: false,
      color: COOP_SEAT_COLORS[0],
    });
  }
  const snapBytes = hostDir.broadcastSnapshotNow(hostWorld)!;
  const decodedSnap = decodeWorldSnapshot(snapBytes)!;
  assert.equal(
    decodedSnap.shots.filter((s) => s.kind === 'enemy').length,
    24,
    '0 hostile enemy bullets dropped even with 90 friendly bolts active',
  );
  assert.equal(decodedSnap.shots.filter((s) => s.kind === 'rocket').length, 4, '0 rockets dropped');
  await flushMicrotasks();
  clockMs += 60;
  g1Dir.step(1 / 60, 1 / 60, g1World, { ...idleCtrl, firing: true });
  assert.equal(g1World.upgrades.has('pierce'), true, 'full 10-upgrade bitmask synced pierce to Guest');
  assert.equal(g1World.upgrades.has('rockets'), true, 'full 10-upgrade bitmask synced rockets to Guest');
  assert.equal(
    g1World.shots.filter((s) => s.hostile).length,
    24,
    'Guest sees all 24 hostile bullets',
  );
  assert.ok(
    g1World.shots.some((s) => !s.hostile && s.color === COOP_SEAT_COLORS[1]),
    'Guest simulates own cannon bolts locally at 0ms muzzle lag',
  );

  // --- 3.3: Missed `host-paused: false` self-heals via snapshot even while Guest world is paused (no `step()` needed) ---
  g1World.paused = true;
  g1Dir.hostPaused = true;
  hostWorld.paused = false;
  hostDir.broadcastSnapshotNow(hostWorld);
  await flushMicrotasks();
  assert.equal(g1Dir.hostPaused, false, 'snapshot paused=false cleared director.hostPaused immediately');
  assert.equal(g1World.paused, false, 'snapshot paused=false unpaused Guest world without waiting for update()');

  // --- 4.2: Blast breaking 50+ asteroid rocks + late reconnect leaves 0 ghost rocks ---
  hostWorld.wave = 3;
  hostWorld.sets.plan([{ at: 0, kind: 'rocks' }]);
  hostWorld.sets.advance(0, 0.1);
  hostWorld.sets.run(0.1, 0.1, hostWorld.setEnv(), 0, false);
  hostWorld.sets.run(ALERT_LEAD + 0.2, ALERT_LEAD + 0.2, hostWorld.setEnv(), 0, false);
  hostWorld.sets.run(3.0, 3.0, hostWorld.setEnv(), 0, false);
  hostWorld.sets.blast(hostWorld.setEnv());
  for (const r of hostWorld.sets.field!.rocks.filter((rk) => !rk.dead).slice(0, 35)) {
    hostWorld.sets.breakRock(r, hostWorld.setEnv());
  }
  assert.ok(hostWorld.sets.brokenRockIds.length > 60, 'over 60 rocks broken on Host');
  hostDir.broadcastSnapshotNow(hostWorld);
  await flushMicrotasks();
  clockMs += 60;
  g1Dir.step(1 / 60, 1 / 60, g1World, idleCtrl);
  const hostAliveRockIds = new Set(hostWorld.sets.field!.rocks.filter((r) => !r.dead).map((r) => r.id));
  const guestGhostRocks = g1World.sets.field!.rocks.filter((r) => !r.dead && !hostAliveRockIds.has(r.id));
  assert.equal(guestGhostRocks.length, 0, '0 ghost rocks on Guest after 60+ broken rocks');

  // --- 3.1: Host page reload after >3 minutes of play (`snapTick > 3200`) unfreezes Guest in <= 0.1s ---
  hostWorld.enemies = [makeEnemy('dart', 140, 320)];
  for (let f = 0; f < 60 * 185; f++) {
    clockMs += 16.67;
    hostDir.step(1 / 60, 1 / 60, hostWorld, idleCtrl);
  }
  await flushMicrotasks();
  clockMs += 16.67;
  g1Dir.step(1 / 60, 1 / 60, g1World, idleCtrl);
  assert.equal(Math.round(g1World.enemies[0]!.x), 140);

  // Host reloads browser tab: socket drops (`hostReconnecting = true`), then new Host `CoopClient` + `CoopFlightDirector` starts at tick 1
  hostDir.dispose();
  hostClient.dispose();
  await flushMicrotasks();
  assert.equal(g1Dir.hostReconnecting, true);

  clockMs += 2_000;
  hostClient = makeClient({ role: 'host', callsign: 'NOVA-1', storage: hostStore });
  hostWorld = new HeadlessArenaWorld(true);
  hostWorld.enemies = [makeEnemy('hex', 610, 340)];
  hostDir = new CoopFlightDirector({ client: hostClient, storage: hostStore, now });
  hostDir.bindWorld(hostWorld);
  hostClient.connect();
  await flushMicrotasks();

  for (let f = 0; f < 6; f++) {
    clockMs += 16.67;
    hostDir.step(1 / 60, 1 / 60, hostWorld, idleCtrl);
    await flushMicrotasks();
    g1Dir.step(1 / 60, 1 / 60, g1World, idleCtrl);
  }
  assert.equal(g1Dir.hostReconnecting, false);
  assert.equal(g1World.enemies[0]?.kind, 'hex', 'Guest switched to reloaded Host world within 0.1s (6 frames)');
  assert.equal(Math.round(g1World.enemies[0]!.x), 610);

  // --- 3.4: Squad limbo: Host pilot knocked down (`alive = false, respawnSec = 6`), then Guest leaves -> immediate Game Over ---
  hostDir.pilots[0].alive = false;
  hostDir.pilots[0].respawnSec = COOP_WINGMAN_RESPAWN_SEC;
  assert.equal(hostWorld.gameOver, false);
  g1Client.leave();
  await flushMicrotasks();
  assert.equal(
    hostWorld.gameOver,
    true,
    'When the last living pilot leaves while teammates are rebooting, squad triggers Game Over immediately',
  );

  hostDir.dispose();
  g1Dir.dispose();
  hostClient.dispose();
  g1Client.dispose();
});

test('Guest own-ship prediction has 0.0px lag/drift under 60±40ms jitter, and Sum Boss pod taps move ship 0.0px on Host', () => {
  // Deterministic PRNG for `60 ± 40 ms` network jitter
  let seed = 987654321;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  let clockMs = 1_000;
  const now = () => clockMs;
  const wireQueue: Array<{ at: number; toHost: boolean; bytes: Uint8Array }> = [];

  const hostClient = new CoopClient({ code: 'JITR77', role: 'host', callsign: 'NOVA-1', storage: null });
  const guestClient = new CoopClient({ code: 'JITR77', role: 'guest', callsign: 'STAR-2', storage: null });
  const roster = [
    { seat: 0 as const, callsign: 'NOVA-1', ready: true, isHost: true, connected: true },
    { seat: 1 as const, callsign: 'STAR-2', ready: true, isHost: false, connected: true },
  ];
  Object.assign(hostClient, { seat: 0 });
  Object.assign(guestClient, { seat: 1 });

  const binarySinks: {
    host: ((b: Uint8Array) => void) | null;
    guest: ((b: Uint8Array) => void) | null;
  } = { host: null, guest: null };
  const origHostSub = hostClient.subscribe.bind(hostClient);
  const origGuestSub = guestClient.subscribe.bind(guestClient);
  hostClient.subscribe = (h) => {
    binarySinks.host = h.onBinary ?? null;
    return origHostSub(h);
  };
  guestClient.subscribe = (h) => {
    binarySinks.guest = h.onBinary ?? null;
    return origGuestSub(h);
  };
  hostClient.sendBinary = (b) => {
    wireQueue.push({ at: clockMs + 20 + nextRand() * 80, toHost: false, bytes: new Uint8Array(b) });
    return true;
  };
  guestClient.sendBinary = (b) => {
    const copy = new Uint8Array(b);
    copy[1] = 1; // relay stamps authoritative seat
    wireQueue.push({ at: clockMs + 20 + nextRand() * 80, toHost: true, bytes: copy });
    return true;
  };

  const hostWorld = new HeadlessArenaWorld(true);
  const guestWorld = new HeadlessArenaWorld(true);
  const hostDir = new CoopFlightDirector({ client: hostClient, initialSeats: roster, storage: null, now });
  const guestDir = new CoopFlightDirector({ client: guestClient, initialSeats: roster, storage: null, now });
  hostDir.bindWorld(hostWorld);
  guestDir.bindWorld(guestWorld);

  const dt = 1 / 60;
  let idealX = formationSpawnForSeat(1).x;
  let maxLagPx = 0;
  let maxSettleDriftPx = 0;
  let releaseX: number | null = null;
  let prevAcross = 0;

  for (let f = 0; f < 360; f++) {
    clockMs += dt * 1000;
    wireQueue.sort((a, b) => a.at - b.at);
    while (wireQueue.length > 0 && wireQueue[0]!.at <= clockMs) {
      const pkt = wireQueue.shift()!;
      if (pkt.toHost) binarySinks.host?.(pkt.bytes);
      else binarySinks.guest?.(pkt.bytes);
    }

    const tSec = f * dt;
    const across = tSec % 1.0 < 0.7 ? (Math.floor(tSec) % 2 === 0 ? 1 : -1) : 0;
    guestDir.step(dt, dt, guestWorld, { ...idleCtrl, across });
    hostDir.step(dt, dt, hostWorld, idleCtrl);

    idealX = Math.min(COOP_WORLD_W - 22, Math.max(22, idealX + across * 380 * dt));
    maxLagPx = Math.max(maxLagPx, Math.abs(guestDir.pilots[1].x - idealX));

    if (prevAcross !== 0 && across === 0) releaseX = guestDir.pilots[1].x;
    if (releaseX !== null && across === 0) {
      maxSettleDriftPx = Math.max(maxSettleDriftPx, Math.abs(guestDir.pilots[1].x - releaseX));
    }
    if (across !== 0) releaseX = null;
    prevAcross = across;
  }

  assert.equal(maxLagPx, 0, 'Guest own-ship has 0.0px lag vs pure local prediction under 60±40ms jitter');
  assert.equal(maxSettleDriftPx, 0, 'Guest own-ship has 0.0px drift after releasing steering keys');

  // --- 3.8: 10 Sum Boss pod taps in a row encode `hasPointer: false` and move Guest ship 0.0px on Host ---
  const sumBoss = createBoss(2, hostWorld.bossEnvObj);
  sumBoss.state = 'fight';
  sumBoss.x = 384;
  sumBoss.y = 200;
  hostWorld.boss = sumBoss;
  guestWorld.boss = sumBoss;

  const restingHostX = hostDir.pilots[1].x;
  const restingHostY = hostDir.pilots[1].y;
  wireQueue.length = 0;

  for (let k = 0; k < 10; k++) {
    guestDir.queueArenaTap(384, 307, guestWorld);
    guestDir.step(dt, dt, guestWorld, idleCtrl);
    const tapPkt = wireQueue.pop()!;
    const decoded = decodeGuestInput(tapPkt.bytes)!;
    assert.equal(decoded.tap, true);
    assert.equal(decoded.hasPointer, false, 'Sum Boss tap frame never sets hasPointer=true');
    binarySinks.host?.(tapPkt.bytes);
    for (let i = 0; i < 3; i++) {
      clockMs += 16.67;
      hostDir.step(dt, dt, hostWorld, idleCtrl);
    }
  }

  assert.equal(hostDir.pilots[1].x, restingHostX, 'Host-side Guest ship X moved 0.0px across 10 pod taps');
  assert.equal(hostDir.pilots[1].y, restingHostY, 'Host-side Guest ship Y moved 0.0px across 10 pod taps');
  assert.equal(hostWorld.bossTaps.length, 10, 'All 10 pod taps reached strikeBoss on Host');

  hostDir.dispose();
  guestDir.dispose();
  hostClient.dispose();
  guestClient.dispose();
});
