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
import { COOP_WORLD_H, COOP_WORLD_W } from '../src/game/coop-protocol';
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
