import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoopRoom } from '../relay/room.mjs';
import { createBoss, tapBoss, type Boss, type BossEnv } from '../src/game/boss';
import { CoopClient, type CoopConnectOptions, type StorageLike } from '../src/game/coop-client';
import {
  COOP_ACK_DEADBAND_PX,
  COOP_STALE_INPUT_SEC,
  COOP_WINGMAN_RESPAWN_SEC,
  CoopFlightDirector,
  formationSpawnForSeat,
  type CoopLocalControlInput,
  type CoopMineItem,
  type CoopPickupItem,
  type CoopWorldAdapter,
} from '../src/game/coop-flight';
import {
  COOP_WORLD_H,
  COOP_WORLD_W,
  SNAP_MAX_FX,
  decodeGuestInput,
  decodeWorldSnapshot,
  encodeWorldSnapshot,
} from '../src/game/coop-protocol';
import { COOP_SEAT_COLORS, type CoopErrorMessage, type CoopLobbyState, type CoopPublicSeat } from '../src/game/coop-types';
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
  const wireQueue: Array<{ at: number; order: number; toHost: boolean; bytes: Uint8Array }> = [];
  let wireOrder = 0;
  let lastToHostAt = 0;
  let lastToGuestAt = 0;

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
    const at = Math.max(lastToGuestAt, clockMs + 20 + nextRand() * 80);
    lastToGuestAt = at;
    wireQueue.push({ at, order: ++wireOrder, toHost: false, bytes: new Uint8Array(b) });
    return true;
  };
  guestClient.sendBinary = (b) => {
    const copy = new Uint8Array(b);
    copy[1] = 1; // relay stamps authoritative seat
    const at = Math.max(lastToHostAt, clockMs + 20 + nextRand() * 80);
    lastToHostAt = at;
    wireQueue.push({ at, order: ++wireOrder, toHost: true, bytes: copy });
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
    wireQueue.sort((a, b) => a.at - b.at || a.order - b.order);
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

function createDirectPair(opts?: {
  seats?: CoopPublicSeat[];
  tvMode?: boolean;
  guestViewport?: [number, number, boolean];
  onVersionMismatch?: (msg: string) => void;
}) {
  let clockMs = 1000;
  const now = () => clockMs;
  const roster: CoopPublicSeat[] =
    opts?.seats ??
    (opts?.tvMode
      ? [{ seat: 1, callsign: 'NOVA', ready: true, isHost: false, connected: true }]
      : [
          { seat: 0, callsign: 'ACE', ready: true, isHost: true, connected: true },
          { seat: 1, callsign: 'NOVA', ready: true, isHost: false, connected: true },
        ]);
  const wireQueue: Array<{ at: number; order: number; toHost: boolean; bytes: Uint8Array }> = [];
  let wireOrder = 0;
  let lastToHostAt = 0;
  let lastToGuestAt = 0;
  const binarySinks: { host?: (b: Uint8Array) => void; guest?: (b: Uint8Array) => void } = {};
  const lobbySinks: { host?: (l: CoopLobbyState) => void; guest?: (l: CoopLobbyState) => void } = {};
  let upDelay: () => number = () => 5;
  let downDelay: () => number = () => 5;

  const makeMockClient = (role: 'host' | 'guest', seat: -1 | 0 | 1) => {
    const c = new CoopClient({
      code: 'R13FIX',
      role,
      callsign: role === 'host' ? 'ACE' : 'NOVA',
      tvMode: Boolean(opts?.tvMode),
      storage: null,
    });
    Object.assign(c, { seat, seats: roster.map((s) => ({ ...s })) });
    const origSub = c.subscribe.bind(c);
    c.subscribe = (h) => {
      if (role === 'host') {
        binarySinks.host = h.onBinary;
        lobbySinks.host = h.onLobby;
      } else {
        binarySinks.guest = h.onBinary;
        lobbySinks.guest = h.onLobby;
      }
      return origSub(h);
    };
    c.sendBinary = (bytes: Uint8Array) => {
      const copy = new Uint8Array(bytes);
      if (role === 'guest' && seat >= 0) copy[1] = seat;
      const rawAt = clockMs + (role === 'guest' ? upDelay() : downDelay());
      const at = role === 'guest' ? Math.max(lastToHostAt, rawAt) : Math.max(lastToGuestAt, rawAt);
      if (role === 'guest') lastToHostAt = at;
      else lastToGuestAt = at;
      wireQueue.push({ at, order: ++wireOrder, toHost: role === 'guest', bytes: copy });
      return true;
    };
    c.sendEvent = () => true;
    c.sendHostPaused = () => true;
    return c;
  };

  const hostClient = makeMockClient('host', opts?.tvMode ? -1 : 0);
  const guestClient = makeMockClient('guest', 1);
  const hostWorld = new HeadlessArenaWorld(false);
  const guestWorld = new HeadlessArenaWorld(true);
  const hostDir = new CoopFlightDirector({ client: hostClient, initialSeats: roster, storage: null, now });
  const guestDir = new CoopFlightDirector({
    client: guestClient,
    initialSeats: roster,
    storage: null,
    now,
    onVersionMismatch: opts?.onVersionMismatch,
  });
  hostDir.bindWorld(hostWorld);
  guestDir.bindWorld(guestWorld);
  if (opts?.guestViewport) {
    const [vw, vh, coarse] = opts.guestViewport;
    guestDir.setViewport(vw, vh, undefined, coarse);
  }

  const flushWire = () => {
    wireQueue.sort((a, b) => a.at - b.at || a.order - b.order);
    while (wireQueue.length > 0 && wireQueue[0]!.at <= clockMs) {
      const pkt = wireQueue.shift()!;
      if (pkt.toHost) binarySinks.host?.(pkt.bytes);
      else binarySinks.guest?.(pkt.bytes);
    }
  };

  return {
    get clockMs() {
      return clockMs;
    },
    advanceClock(ms: number) {
      clockMs += ms;
    },
    setDelays(up: () => number, down: () => number) {
      upDelay = up;
      downDelay = down;
    },
    wireQueue,
    binarySinks,
    lobbySinks,
    hostClient,
    guestClient,
    hostWorld,
    guestWorld,
    hostDir,
    guestDir,
    flushWire,
    dispose() {
      hostDir.dispose();
      guestDir.dispose();
      hostClient.dispose();
      guestClient.dispose();
    },
  };
}

test('Round 13 (3.1): portrait-phone Guest upper-arena touch moves Guest ship 0.0px on Host and locally', () => {
  const pair = createDirectPair({ guestViewport: [390, 844, true] });
  assert.equal(pair.guestDir.layout.useThumbDeck, true);
  const idle: CoopLocalControlInput = { across: 0, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 };
  const dt = 1 / 60;

  for (let i = 0; i < 20; i++) {
    pair.advanceClock(dt * 1000);
    pair.flushWire();
    pair.hostDir.step(dt, dt, pair.hostWorld, idle);
    pair.guestDir.step(dt, dt, pair.guestWorld, idle);
  }

  const startHost = { x: pair.hostDir.pilots[1].x, y: pair.hostDir.pilots[1].y };
  const startGuest = { x: pair.guestDir.pilots[1].x, y: pair.guestDir.pilots[1].y };

  // 1. Real upper-arena pointerdown at screen (100, 150) is swallowed by the thumb deck
  assert.equal(pair.guestDir.handlePointerDown(42, 100, 150, true), true);
  assert.equal(pair.guestDir.deck.state().touching, false);

  // 2. Even if Input leaked `touching: true, touchX: 193, touchY: 284` for 2.0s, Guest never sends ctrl.touch* in deck mode
  const leakedArenaCtrl: CoopLocalControlInput = {
    across: 0,
    down: 0,
    firing: false,
    touching: true,
    touchX: 193,
    touchY: 284,
  };
  for (let f = 0; f < 120; f++) {
    pair.advanceClock(dt * 1000);
    pair.flushWire();
    pair.guestDir.step(dt, dt, pair.guestWorld, leakedArenaCtrl);
    pair.hostDir.step(dt, dt, pair.hostWorld, idle);
  }
  pair.guestDir.handlePointerUp(42);

  assert.equal(Math.hypot(pair.hostDir.pilots[1].x - startHost.x, pair.hostDir.pilots[1].y - startHost.y), 0);
  assert.equal(Math.hypot(pair.guestDir.pilots[1].x - startGuest.x, pair.guestDir.pilots[1].y - startGuest.y), 0);
  pair.dispose();
});

test('Round 13 (3.2 & reboot): short Wi-Fi drop keeps run & reboot timers alive while explicit Leave ends immediately, and respawned Guest moves 0.0px toward death spot', () => {
  const idle: CoopLocalControlInput = { across: 0, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 };
  const dt = 1 / 60;

  // Case A: Host rebooting + Guest Wi-Fi blip (`connected: false`, `present: true`) keeps run alive AND ticks Host reboot timer!
  const pair = createDirectPair();
  pair.hostDir.pilots[0].alive = false;
  pair.hostDir.pilots[0].hull = 0;
  pair.hostDir.pilots[0].respawnSec = 3.0;
  pair.lobbySinks.host?.({
    code: 'R13FIX',
    formattedCode: 'R13-FIX',
    hostConnected: true,
    tvMode: false,
    locked: true,
    seats: [
      { seat: 0, callsign: 'ACE', ready: true, isHost: true, connected: true },
      { seat: 1, callsign: 'NOVA', ready: true, isHost: false, connected: false },
    ],
  });
  assert.equal(pair.hostWorld.gameOver, false, 'transient Wi-Fi blip of last living pilot never ends the run');
  for (let f = 0; f < 60; f++) {
    pair.advanceClock(dt * 1000);
    pair.hostDir.step(dt, dt, pair.hostWorld, idle);
  }
  assert.ok(pair.hostDir.pilots[0].respawnSec < 2.1, 'reboot timer continues ticking while living seat is held in grace');
  assert.equal(pair.hostWorld.gameOver, false);

  // Explicit Leave removes Seat 1 from roster (`present: false`) while Host is still down -> immediate Game Over (`3.4` preserved)
  pair.lobbySinks.host?.({
    code: 'R13FIX',
    formattedCode: 'R13-FIX',
    hostConnected: true,
    tvMode: false,
    locked: true,
    seats: [{ seat: 0, callsign: 'ACE', ready: true, isHost: true, connected: true }],
  });
  assert.equal(pair.hostWorld.gameOver, true, 'explicit Leave of last living pilot ends the run immediately');
  pair.dispose();

  // Case B: TV mode (`Seat 0` absent) — Guest blips or connects late without ending the run
  const tvSeats: CoopPublicSeat[] = [
    { seat: 1, callsign: 'NOVA', ready: true, isHost: false, connected: false },
  ];
  const tvPair = createDirectPair({ seats: tvSeats, tvMode: true });
  tvPair.advanceClock(16.67);
  tvPair.hostDir.step(dt, dt, tvPair.hostWorld, idle);
  assert.equal(tvPair.hostWorld.gameOver, false, 'TV mode starting while Guest socket is still connecting stays alive');
  tvPair.dispose();

  // Case C: Rebooted Guest ship with in-flight death-spot packets moves 0.0px from spawn on Host
  const rbPair = createDirectPair();
  rbPair.setDelays(() => 65, () => 65);
  // Fly Guest to (620, 560), then kill Guest while packets carrying (620, 560) are still arriving
  for (let f = 0; f < 90; f++) {
    rbPair.advanceClock(dt * 1000);
    rbPair.flushWire();
    rbPair.guestDir.step(dt, dt, rbPair.guestWorld, { ...idle, across: 1, down: -1 });
    rbPair.hostDir.step(dt, dt, rbPair.hostWorld, idle);
  }
  for (let f = 0; f < 20; f++) {
    rbPair.advanceClock(dt * 1000);
    rbPair.flushWire();
    rbPair.guestDir.step(dt, dt, rbPair.guestWorld, idle);
    rbPair.hostDir.step(dt, dt, rbPair.hostWorld, idle);
  }
  const deathSpot = { x: rbPair.hostDir.pilots[1].x, y: rbPair.hostDir.pilots[1].y };
  assert.ok(deathSpot.x > 500 && deathSpot.y < 700);

  // Kill Seat 1 via lethal hostile shot on Host and fast-forward through the 5s reboot with Guest idle
  rbPair.hostDir.pilots[1].hull = 1;
  rbPair.hostDir.pilots[1].invulnerable = 0;
  rbPair.hostWorld.shots.push({
    x: deathSpot.x,
    y: deathSpot.y,
    vx: 0,
    vy: 200,
    hostile: true,
    dead: false,
    color: '#ff3366',
  } as Shot);
  rbPair.hostDir.collideHostSquad(rbPair.hostWorld, 1);
  assert.equal(rbPair.hostDir.pilots[1].alive, false);

  const spawn = formationSpawnForSeat(1);
  let sawRespawn = false;
  let maxPostSpawnExcursion = 0;
  for (let f = 0; f < Math.ceil((COOP_WINGMAN_RESPAWN_SEC + 1.5) * 60); f++) {
    rbPair.advanceClock(dt * 1000);
    rbPair.flushWire();
    rbPair.guestDir.step(dt, dt, rbPair.guestWorld, idle);
    rbPair.hostDir.step(dt, dt, rbPair.hostWorld, idle);
    if (rbPair.hostDir.pilots[1].alive) {
      sawRespawn = true;
      const d = Math.hypot(rbPair.hostDir.pilots[1].x - spawn.x, rbPair.hostDir.pilots[1].y - spawn.y);
      maxPostSpawnExcursion = Math.max(maxPostSpawnExcursion, d);
    }
  }
  assert.equal(sawRespawn, true);
  assert.equal(maxPostSpawnExcursion, 0, 'respawned Guest ship moved 0.0px toward stale death spot on Host');
  rbPair.dispose();
});

test('Round 13 (3.4): 600ms upstream stalls expire stale velocity after 150ms with < 30px release slide, and 24px deadband eases smoothly', () => {
  assert.equal(COOP_STALE_INPUT_SEC, 0.15);
  assert.equal(COOP_ACK_DEADBAND_PX, 24);

  const idle: CoopLocalControlInput = { across: 0, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 };
  const dt = 1 / 60;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const pair = createDirectPair();
  let stallUntilMs = 0;
  let nextStallSec = 2.15; // overlaps Guest key release at t = 2.30s
  pair.setDelays(
    () => {
      const base = 20 + rand() * 80;
      const nowSec = (pair.clockMs - 1000) / 1000;
      if (nowSec >= nextStallSec) {
        stallUntilMs = pair.clockMs + 600;
        nextStallSec += 2.8;
      }
      const stallHold = Math.max(0, stallUntilMs - pair.clockMs);
      return base + stallHold;
    },
    () => 20 + rand() * 80,
  );

  let prevAcross = 0;
  let releaseX: number | null = null;
  let maxReleaseSlidePx = 0;
  let maxSingleFrameJumpPx = 0;
  let prevGuestX = pair.guestDir.pilots[1].x;

  for (let f = 0; f < 60 * 10; f++) {
    pair.advanceClock(dt * 1000);
    pair.flushWire();
    const tSec = f * dt;
    const across = tSec % 1.4 < 0.9 ? (Math.floor(tSec / 1.4) % 2 === 0 ? 1 : -1) : 0;
    pair.guestDir.step(dt, dt, pair.guestWorld, { ...idle, across });
    pair.hostDir.step(dt, dt, pair.hostWorld, idle);

    const gx = pair.guestDir.pilots[1].x;
    maxSingleFrameJumpPx = Math.max(maxSingleFrameJumpPx, Math.abs(gx - prevGuestX));
    prevGuestX = gx;

    if (prevAcross !== 0 && across === 0) releaseX = gx;
    if (releaseX !== null && across === 0) {
      maxReleaseSlidePx = Math.max(maxReleaseSlidePx, Math.abs(gx - releaseX));
    }
    if (across !== 0) releaseX = null;
    prevAcross = across;
  }

  assert.ok(maxReleaseSlidePx < 30, `600ms upstream stalls gave ${maxReleaseSlidePx.toFixed(1)}px release slide (< 30px)`);
  assert.ok(maxSingleFrameJumpPx <= 12, `max 1-frame Guest step=${maxSingleFrameJumpPx.toFixed(1)}px`);
  pair.dispose();

  // Direct behavioural test of COOP_STALE_INPUT_SEC (150ms): if Guest upstream stalls while holding LEFT,
  // Host advances Guest ship for <= 150ms (~57px) and then stops cold over the remaining 500ms (0.0px extra drift).
  const stalePair = createDirectPair();
  for (let f = 0; f < 15; f++) {
    stalePair.advanceClock(dt * 1000);
    stalePair.flushWire();
    stalePair.guestDir.step(dt, dt, stalePair.guestWorld, { ...idle, across: -1 });
    stalePair.hostDir.step(dt, dt, stalePair.hostWorld, idle);
  }
  stalePair.setDelays(() => 5000, () => 5);
  const hostXAtCut = stalePair.hostDir.pilots[1].x;
  let hostXAt200ms = hostXAtCut;
  for (let f = 1; f <= 42; f++) {
    stalePair.advanceClock(dt * 1000);
    stalePair.flushWire();
    stalePair.guestDir.step(dt, dt, stalePair.guestWorld, { ...idle, across: -1 });
    stalePair.hostDir.step(dt, dt, stalePair.hostWorld, idle);
    if (f === 12) hostXAt200ms = stalePair.hostDir.pilots[1].x;
  }
  assert.ok(hostXAtCut - hostXAt200ms <= 64, `Host coasted <= 64px before 150ms expiry (got ${(hostXAtCut - hostXAt200ms).toFixed(1)}px)`);
  assert.equal(stalePair.hostDir.pilots[1].x, hostXAt200ms, 'Host copy stopped cold once last input exceeded COOP_STALE_INPUT_SEC (150ms)');
  stalePair.dispose();

  // Direct verification of the 24px deadband + <= 8px/frame easing when Host forcibly displaces Guest by 45px
  const easePair = createDirectPair();
  for (let f = 0; f < 20; f++) {
    easePair.advanceClock(dt * 1000);
    easePair.flushWire();
    easePair.guestDir.step(dt, dt, easePair.guestWorld, idle);
    easePair.hostDir.step(dt, dt, easePair.hostWorld, idle);
  }
  const displacedX = easePair.hostDir.pilots[1].x + 45;
  let maxEaseStep = 0;
  let lastX = easePair.guestDir.pilots[1].x;
  for (let f = 0; f < 60; f++) {
    easePair.advanceClock(dt * 1000);
    easePair.flushWire();
    easePair.guestDir.step(dt, dt, easePair.guestWorld, idle);
    easePair.hostDir.step(dt, dt, easePair.hostWorld, idle);
    easePair.hostDir.pilots[1].x = displacedX;
    if (f % 3 === 0) easePair.hostDir.broadcastSnapshotNow(easePair.hostWorld);
    const curX = easePair.guestDir.pilots[1].x;
    maxEaseStep = Math.max(maxEaseStep, Math.abs(curX - lastX));
    lastX = curX;
  }
  assert.ok(
    Math.abs(easePair.guestDir.pilots[1].x - displacedX) <= COOP_ACK_DEADBAND_PX + 1,
    `discrepancy > 24px reconciled inside deadband (got ${Math.abs(easePair.guestDir.pilots[1].x - displacedX).toFixed(2)}px)`,
  );
  assert.ok(maxEaseStep <= 8.1, `reconciliation eased smoothly at <= 8px/frame (got ${maxEaseStep.toFixed(2)}px)`);
  easePair.dispose();
});

test('Round 13 (4.1, 4.3, Sec 5): bullet-crossing agreement, v1 mismatch banner, Guest local pierce by Enemy.id, and 16-FX cap', () => {
  const idle: CoopLocalControlInput = { across: 0, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 };
  const dt = 1 / 60;

  // 1. 4.1: Single-bullet crossing sweep on LAN agrees on hits/misses (<= 6 disagreements across 71 near-miss crossings)
  let disagreements = 0;
  let agreeHit = 0;
  const shipY = formationSpawnForSeat(1).y;
  for (let k = 0; k <= 70; k++) {
    const tCross = 2.3 + k * 0.01;
    const p = createDirectPair();
    let spawned = false;
    let minSeen = Infinity;
    for (let f = 1; f <= 220; f++) {
      p.advanceClock(dt * 1000);
      p.flushWire();
      const t = (p.clockMs - 1000) / 1000;
      const across = t >= 2.5 && t < 3.0 ? 1 : 0;
      p.hostDir.step(dt, dt, p.hostWorld, idle);
      if (!spawned && t >= tCross - 1.5) {
        spawned = true;
        p.hostWorld.shots.push({
          x: 384,
          y: shipY - 260 * (tCross - t),
          vx: 0,
          vy: 260,
          hostile: true,
          dead: false,
          color: '#ff4466',
        } as Shot);
      }
      for (const s of p.hostWorld.shots) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (s.y > COOP_WORLD_H + 40) s.dead = true;
      }
      p.hostDir.collideHostSquad(p.hostWorld, 1);
      p.hostWorld.shots = p.hostWorld.shots.filter((s) => !s.dead);

      p.guestDir.step(dt, dt, p.guestWorld, { ...idle, across });
      const me = p.guestDir.pilots[1];
      for (const s of p.guestWorld.shots) {
        if (s.hostile) minSeen = Math.min(minSeen, Math.hypot(s.x - me.x, s.y - me.y));
      }
    }
    const hit = p.hostDir.pilots[1].hull < 3;
    const saw = minSeen < 12;
    if (hit !== saw) disagreements++;
    else if (hit && saw) agreeHit++;
    p.dispose();
  }
  assert.ok(agreeHit >= 7, `expected >= 7 agreed hits across crossing sweep, got ${agreeHit}`);
  assert.ok(disagreements <= 6, `expected <= 6 grazing disagreements across 71 crossings, got ${disagreements}`);

  // 2. Section 5: Guest local `pierce` bolt passes through two stacked enemies across frames (Enemy.id skip)
  const piercePair = createDirectPair();
  piercePair.hostWorld.energy = 0.1;
  piercePair.guestWorld.energy = 0.1;
  piercePair.hostWorld.upgrades.add('pierce');
  const e1 = makeEnemy('dart', 336, 700, 1);
  const e2 = makeEnemy('dart', 336, 640, 1);
  const e3 = makeEnemy('dart', 336, 580, 1);
  e1.hp = 10;
  e2.hp = 10;
  e3.hp = 10;
  piercePair.hostWorld.enemies.push(e1, e2, e3);
  let minGuestBoltY = 999;
  for (let f = 0; f < 36; f++) {
    piercePair.advanceClock(dt * 1000);
    piercePair.flushWire();
    const fire = f >= 6 && f <= 10;
    piercePair.hostDir.step(dt, dt, piercePair.hostWorld, idle);
    for (const s of piercePair.hostWorld.shots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    piercePair.hostDir.collideHostSquad(piercePair.hostWorld, 1);
    piercePair.hostWorld.shots = piercePair.hostWorld.shots.filter((s) => !s.dead);
    piercePair.guestDir.step(dt, dt, piercePair.guestWorld, { ...idle, firing: fire });
    for (const b of piercePair.guestDir['guestLocalBolts'] as Shot[]) {
      if (b.y < minGuestBoltY) minGuestBoltY = b.y;
    }
  }
  // Host twin bolts (pierce=2 -> each hits 3 enemies total: pierces e1 at 700 & e2 at 640, stops at e3 at 580)
  assert.equal(e1.hp, 8);
  assert.equal(e2.hp, 8);
  assert.equal(e3.hp, 8);
  assert.ok(minGuestBoltY <= 610, `Guest local pierce bolt also passed e1/e2 down to y=${minGuestBoltY}`);
  piercePair.dispose();

  // 3. Section 5: Host recentFx ring retains all 16 (`SNAP_MAX_FX`) FX recorded in one frame
  const fxPair = createDirectPair();
  for (let i = 0; i < SNAP_MAX_FX; i++) {
    fxPair.hostDir.recordHostFx('enemy-burst', 100 + i * 20, 200, '#ffffff', { enemyKind: 'dart' });
  }
  const snapBytes = fxPair.hostDir.broadcastSnapshotNow(fxPair.hostWorld)!;
  const decodedSnap = decodeWorldSnapshot(snapBytes)!;
  assert.equal(decodedSnap.fx.length, SNAP_MAX_FX, 'all 16 FX in a single frame fit in the snapshot FX ring');
  fxPair.dispose();

  // 4. 4.3: Receiving v1 snapshots sets `versionMismatch` immediately and invokes `onVersionMismatch` on 2nd frame
  let mismatchCount = 0;
  const verPair = createDirectPair({ onVersionMismatch: () => mismatchCount++ });
  const v1Bytes = encodeWorldSnapshot({
    session: 1,
    tick: 1,
    hostElapsedMs: 50,
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
  v1Bytes[1] = (v1Bytes[1]! & ~0x03) | 1; // legacy v1
  verPair.binarySinks.guest?.(v1Bytes);
  assert.equal(verPair.guestDir.versionMismatch, true);
  verPair.binarySinks.guest?.(v1Bytes);
  assert.equal(mismatchCount, 1);
  verPair.dispose();
});

test('Round 14 (3.1, 3.2, 4.1, 4.2, 4.3, Sec 5): smooth Host copy under 60±40ms jitter, 0px pointer overshoot, TV-mode last-pilot Game Over, 60±40ms crossing agreement, directional mismatch text, and <= 35 msg/s rate budget', () => {
  const idle: CoopLocalControlInput = { across: 0, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 };
  const dt = 1 / 60;
  const makeRng = (s: number) => {
    let st = s >>> 0;
    return () => {
      st = (st * 1664525 + 1013904223) >>> 0;
      return st / 0x100000000;
    };
  };

  // --- 3.1a: Steady key hold under 60 ± 40 ms jitter moves at normal speed in >= 95% of Host frames and never backwards ---
  {
    const rUp = makeRng(5);
    const rDown = makeRng(6);
    const pair = createDirectPair();
    pair.setDelays(
      () => 20 + rUp() * 80,
      () => 20 + rDown() * 80,
    );
    const nominal = 380 * dt;
    let prevHostX = pair.hostDir.pilots[1].x;
    let normalFrames = 0;
    let backwardFrames = 0;
    let totalSampled = 0;

    for (let f = 1; f <= 60 * 16; f++) {
      pair.advanceClock(dt * 1000);
      pair.flushWire();
      const tSec = f * dt;
      const holdPhase = tSec % 1.6;
      const dir = Math.floor(tSec / 1.6) % 2 === 0 ? 1 : -1;
      const across = holdPhase < 1.3 ? dir : 0;
      pair.guestDir.step(dt, dt, pair.guestWorld, { ...idle, across });
      pair.hostDir.step(dt, dt, pair.hostWorld, idle);

      const hx = pair.hostDir.pilots[1].x;
      const step = (hx - prevHostX) * dir;
      prevHostX = hx;
      if (tSec > 1.0 && holdPhase > 0.35 && holdPhase < 1.3 && hx > 60 && hx < COOP_WORLD_W - 60) {
        totalSampled++;
        if (step < -0.05) backwardFrames++;
        else if (step >= 0.75 * nominal && step <= 1.25 * nominal) normalFrames++;
      }
    }
    const normalRatio = normalFrames / Math.max(1, totalSampled);
    assert.equal(backwardFrames, 0, 'Host copy never steps backwards during steady key holds under 60±40ms jitter');
    assert.ok(normalRatio >= 0.95, `expected >= 95% normal-speed Host frames, got ${(normalRatio * 100).toFixed(1)}%`);
    pair.dispose();
  }

  // --- 3.1b: Pointer fly-and-stop at 760 px/s under 60 ± 40 ms jitter overshoots stop point by <= 5 px ---
  {
    const rUp = makeRng(11);
    const rDown = makeRng(12);
    const pair = createDirectPair();
    pair.setDelays(
      () => 20 + rUp() * 80,
      () => 20 + rDown() * 80,
    );
    const y = formationSpawnForSeat(1).y;
    let maxOvershootPx = 0;
    for (let f = 1; f <= 60 * 12; f++) {
      pair.advanceClock(dt * 1000);
      pair.flushWire();
      const tSec = f * dt;
      const targetX = Math.floor(tSec / 1.2) % 2 === 0 ? 650 : 120;
      pair.guestDir.step(dt, dt, pair.guestWorld, {
        ...idle,
        touching: true,
        touchX: targetX,
        touchY: y,
      });
      pair.hostDir.step(dt, dt, pair.hostWorld, idle);
      const hx = pair.hostDir.pilots[1].x;
      maxOvershootPx = Math.max(maxOvershootPx, hx - 650, 120 - hx);
    }
    assert.ok(maxOvershootPx <= 5, `Host pointer-stop overshoot must be <= 5px, got ${maxOvershootPx.toFixed(2)}px`);
    pair.dispose();
  }

  // --- 3.2: TV-mode Host (`seat = -1`): Wi-Fi blip keeps run alive; last guest leaving or pruned ends the run ---
  {
    const tvPair = createDirectPair({ tvMode: true });
    assert.equal(tvPair.hostDir.localSeat, -1);
    tvPair.advanceClock(dt * 1000);
    tvPair.hostDir.step(dt, dt, tvPair.hostWorld, idle);
    assert.equal(tvPair.hostWorld.gameOver, false);

    // Last guest has a brief Wi-Fi drop (seat held by relay, `connected: false`) -> run stays alive
    tvPair.lobbySinks.host?.({
      code: 'R13FIX',
      formattedCode: 'R13-FIX',
      hostConnected: true,
      tvMode: true,
      locked: true,
      seats: [{ seat: 1, callsign: 'NOVA', ready: true, isHost: false, connected: false }],
    });
    tvPair.advanceClock(dt * 1000);
    tvPair.hostDir.step(dt, dt, tvPair.hostWorld, idle);
    assert.equal(tvPair.hostWorld.gameOver, false, 'TV-mode run stays alive during 30s reconnect grace');

    // Relay prunes the last seat (or guest explicitly leaves): `seats: []` -> Game Over triggers immediately
    tvPair.lobbySinks.host?.({
      code: 'R13FIX',
      formattedCode: 'R13-FIX',
      hostConnected: true,
      tvMode: true,
      locked: true,
      seats: [],
    });
    assert.equal(tvPair.hostWorld.gameOver, true, 'TV-mode run ends immediately when the last pilot seat is removed');
    tvPair.dispose();
  }

  // --- 4.1: 60 ± 40 ms crossing sweep agrees on hits, suppresses ghost continuation, and gives 0px hitbox lead ---
  {
    let agreeHit = 0;
    let maxGhostBelowPx = 0;
    const shipY = formationSpawnForSeat(1).y;
    for (let k = 0; k <= 70; k++) {
      const tCross = 2.3 + k * 0.01;
      const rJit = makeRng(7);
      const p = createDirectPair();
      p.setDelays(
        () => 20 + rJit() * 80,
        () => 20 + rJit() * 80,
      );
      let spawned = false;
      let minSeen = Infinity;
      let localMaxBelowPx = -Infinity;
      let hostKillMs: number | null = null;
      for (let f = 1; f <= 220; f++) {
        p.advanceClock(dt * 1000);
        p.flushWire();
        const t = (p.clockMs - 1000) / 1000;
        const across = t >= 2.5 && t < 3.0 ? 1 : 0;
        p.hostDir.step(dt, dt, p.hostWorld, idle);
        if (!spawned && t >= tCross - 1.5) {
          spawned = true;
          p.hostWorld.shots.push({
            x: 384,
            y: shipY - 260 * (tCross - t),
            vx: 0,
            vy: 260,
            hostile: true,
            dead: false,
            color: '#ff4466',
          } as Shot);
        }
        for (const s of p.hostWorld.shots) {
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          if (s.y > COOP_WORLD_H + 40) s.dead = true;
        }
        const hullBefore = p.hostDir.pilots[1].hull;
        p.hostDir.collideHostSquad(p.hostWorld, 1);
        if (p.hostDir.pilots[1].hull < hullBefore && hostKillMs === null) hostKillMs = p.clockMs;
        p.hostWorld.shots = p.hostWorld.shots.filter((s) => !s.dead);

        p.guestDir.step(dt, dt, p.guestWorld, { ...idle, across });
        const me = p.guestDir.pilots[1];
        for (const s of p.guestWorld.shots) {
          if (!s.hostile) continue;
          minSeen = Math.min(minSeen, Math.hypot(s.x - me.x, s.y - me.y));
          if (hostKillMs !== null && p.clockMs > hostKillMs) {
            localMaxBelowPx = Math.max(localMaxBelowPx, s.y - me.y);
          }
        }
      }
      if (p.hostDir.pilots[1].hull < 3 && minSeen < 12) {
        agreeHit++;
        if (localMaxBelowPx > -Infinity) {
          maxGhostBelowPx = Math.max(maxGhostBelowPx, localMaxBelowPx);
        }
      }
      // Verify 0.0px hitbox cheat regardless of forged Guest targets
      const hp = p.hostDir.pilots[1];
      const hitPos = (p.hostDir as unknown as { hostPilotHitPos: (s: typeof hp) => { x: number; y: number } }).hostPilotHitPos(hp);
      assert.equal(Math.hypot(hitPos.x - hp.x, hitPos.y - hp.y), 0);
      p.dispose();
    }
    assert.ok(agreeHit >= 6, `expected >= 6 agreed hits under 60±40ms jitter, got ${agreeHit}`);
    assert.ok(maxGhostBelowPx <= 16, `suppressed dead bullets after hit (max below ship=${maxGhostBelowPx.toFixed(1)}px)`);
  }

  // --- 4.2: Older (v1) vs newer (v3) snapshot mismatch messages point to the outdated side ---
  {
    const olderMsgs: string[] = [];
    const newerMsgs: string[] = [];
    const olderPair = createDirectPair({ onVersionMismatch: (m) => olderMsgs.push(m) });
    const newerPair = createDirectPair({ onVersionMismatch: (m) => newerMsgs.push(m) });
    const baseBytes = encodeWorldSnapshot({
      session: 1,
      tick: 1,
      hostElapsedMs: 50,
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
    const v1 = new Uint8Array(baseBytes);
    v1[1] = (v1[1]! & ~0x03) | 1;
    // From version 3 the two old bits always hold 3 and the version is the next byte (Round 15, 5.12).
    const v4 = new Uint8Array(baseBytes);
    v4[2] = 4;

    olderPair.binarySinks.guest?.(v1);
    olderPair.binarySinks.guest?.(v1);
    newerPair.binarySinks.guest?.(v4);
    newerPair.binarySinks.guest?.(v4);

    assert.equal(olderMsgs[0], "The host's game is out of date. Ask the host to refresh.");
    assert.equal(newerMsgs[0], 'This game was updated. Refresh to rejoin.');
    olderPair.dispose();
    newerPair.dispose();
  }

  // --- 4.3: Frantic wiggle + 4 pod taps/s + 600ms upstream stalls stays <= 35 msg/s at relay with 0 dropped taps ---
  {
    const ratePair = createDirectPair();
    const sumBoss = createBoss(2, ratePair.hostWorld.bossEnvObj);
    sumBoss.state = 'fight';
    ratePair.hostWorld.boss = sumBoss;
    ratePair.guestWorld.boss = sumBoss;

    const sendTimesMs: number[] = [];
    const origSend = ratePair.guestClient.sendBinary.bind(ratePair.guestClient);
    ratePair.guestClient.sendBinary = (b: Uint8Array) => {
      sendTimesMs.push(ratePair.clockMs);
      return origSend(b);
    };

    const rRelay = makeRng(9);
    let nextTapSec = 0;
    let totalTapsQueued = 0;
    for (let f = 1; f <= 60 * 30; f++) {
      ratePair.advanceClock(1000 / 60);
      const t = (ratePair.clockMs - 1000) / 1000;
      if (t >= nextTapSec) {
        nextTapSec += 0.25;
        totalTapsQueued++;
        ratePair.guestDir.queueArenaTap(384, 300, ratePair.guestWorld);
      }
      const franticCtrl: CoopLocalControlInput = {
        ...idle,
        across: Math.floor(t / 0.07) % 2 ? 1 : -1,
        firing: Math.floor(t / 0.11) % 2 === 0,
      };
      ratePair.guestDir.step(dt, dt, ratePair.guestWorld, franticCtrl);
      ratePair.flushWire();
      ratePair.hostDir.step(dt, dt, ratePair.hostWorld, idle);
    }
    ratePair.advanceClock(500);
    ratePair.flushWire();
    ratePair.hostDir.step(dt, dt, ratePair.hostWorld, idle);

    // Simulate relay fixed 1s window after 20-100ms jitter + 600ms upstream stalls every 3s
    let lastArrive = 0;
    const arrivals = sendTimesMs.map((s) => {
      let at = s + 20 + rRelay() * 80;
      const ph = (s - 1000) % 3000;
      if (ph < 600) at = Math.max(at, s - ph + 620);
      at = Math.max(at, lastArrive);
      lastArrive = at;
      return at;
    });
    let winStart = -Infinity;
    let count = 0;
    let dropped = 0;
    let maxWin = 0;
    for (const a of arrivals) {
      if (a - winStart >= 1000) {
        winStart = a;
        count = 0;
      }
      count++;
      maxWin = Math.max(maxWin, count);
      if (count > 35) dropped++;
    }
    assert.equal(dropped, 0, `relay drops 0 frames across 600ms stalls (max relay window=${maxWin})`);
    assert.equal(ratePair.hostWorld.bossTaps.length, totalTapsQueued, 'all Sum Boss pod taps reached Host');
    ratePair.dispose();
  }
});

// -----------------------------------------------------------------------------------------------------------------
// Round 15 netcode fixes (Claude). Each test fails on 473f55e.
// -----------------------------------------------------------------------------------------------------------------

const { encodeGuestInput: encodeGuestInputR15 } = await import('../src/game/coop-protocol');

/** A seeded random stream, so jitter is the same on every run. */
function seededR15(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

type PairR15 = ReturnType<typeof createDirectPair>;
function stepPairR15(pair: PairR15, guestCtrl: CoopLocalControlInput, dt = 1 / 60): void {
  pair.advanceClock(dt * 1000);
  pair.flushWire();
  pair.hostDir.step(dt, dt, pair.hostWorld, idleCtrl);
  pair.guestDir.step(dt, dt, pair.guestWorld, guestCtrl);
}

type NetProfileR15 = 'lan' | 'j60' | 'j100' | 'j150' | 'gate';
/**
 * One-way delays: LAN 5 ms; 60 ± 40, 100 ± 20 and 150 ± 30 ms; and the gate's profile, which is 60 ± 40 ms with 2% of
 * messages held up a further 200–320 ms. The wire keeps order, so a held message holds up the ones behind it.
 */
function delaysR15(pair: PairR15, profile: NetProfileR15, seed: number): void {
  const rnd = seededR15(seed);
  const one = (): number => {
    switch (profile) {
      case 'lan':
        return 5;
      case 'j60':
        return 20 + rnd() * 80;
      case 'j100':
        return 80 + rnd() * 40;
      case 'j150':
        return 120 + rnd() * 60;
      case 'gate':
        return 20 + rnd() * 80 + (rnd() < 0.02 ? 200 + rnd() * 120 : 0);
    }
  };
  pair.setDelays(one, one);
}

test('Round 15 (3.1): a mouse or thumb moving at 250 or 400 px/s glides on the host instead of hopping', () => {
  for (const profile of ['lan', 'j60'] as const) {
    for (const speed of [250, 400]) {
      const pair = createDirectPair();
      delaysR15(pair, profile, 7);
      const y = pair.guestDir.pilots[1].y;
      const hold = (x: number): CoopLocalControlInput => ({
        across: 0,
        down: 0,
        firing: false,
        touching: true,
        touchX: x,
        touchY: y,
      });
      for (let f = 0; f < 120; f++) stepPairR15(pair, hold(80)); // park the ship at the left
      let normal = 0;
      let counted = 0;
      let backward = 0;
      let prev = pair.hostDir.pilots[1].x;
      let px = 80;
      for (let f = 0; f < 90; f++) {
        px += speed / 60; // the pointer sweeps right, and the ship follows it
        stepPairR15(pair, hold(px));
        const hx = pair.hostDir.pilots[1].x;
        const v = (hx - prev) * 60;
        if (f >= 24 && f < 84) {
          counted += 1;
          if (v >= speed * 0.75 && v <= speed * 1.25) normal += 1;
          if (hx < prev - 0.05) backward += 1;
        }
        prev = hx;
      }
      const share = normal / counted;
      assert.equal(backward, 0, `${profile} ${speed} px/s: never steps backwards`);
      assert.ok(share >= 0.95, `${profile} ${speed} px/s: ${(share * 100).toFixed(1)}% of host frames at normal speed`);
      pair.dispose();
    }
  }
});

test('Round 15 (3.2): straight enemy bullets keep moving on a guest 100-150 ms away, without freezing or hopping', () => {
  const dt = 1 / 60;
  for (const profile of ['j100', 'j150'] as const) {
    const pair = createDirectPair();
    delaysR15(pair, profile, 11);
    for (let f = 0; f < 150; f++) stepPairR15(pair, idleCtrl); // calibrate the bullet lead
    const speed = 200;
    const last = new Map<number, number>();
    let frames = 0;
    let still = 0;
    let worst = 0;
    for (let f = 0; f < 360; f++) {
      if (f % 30 === 0 && f < 240) {
        const lane = 60 + (f / 30) * 70; // one bullet every half second, each in its own lane
        pair.hostWorld.shots.push({ x: lane, y: 40, vx: 0, vy: speed, hostile: true, dead: false, color: '#ff4d4d' });
      }
      for (const sh of pair.hostWorld.shots) sh.y += sh.vy * dt;
      pair.hostWorld.shots = pair.hostWorld.shots.filter((sh) => sh.y < 1000);
      stepPairR15(pair, idleCtrl);
      const seen = new Set<number>();
      for (const sh of pair.guestWorld.shots) {
        if (!sh.hostile) continue;
        const lane = Math.round(sh.x);
        seen.add(lane);
        const before = last.get(lane);
        last.set(lane, sh.y);
        if (before === undefined) continue;
        const step = (sh.y - before) / (speed * dt);
        frames += 1;
        if (step < 0.25) still += 1;
        worst = Math.max(worst, step);
      }
      for (const lane of [...last.keys()]) if (!seen.has(lane)) last.delete(lane);
    }
    assert.ok(frames > 1000, `${profile}: ${frames} bullet frames`);
    assert.ok(still / frames < 0.02, `${profile}: bullets stood still in ${still} of ${frames} frames`);
    assert.ok(worst <= 1.5, `${profile}: a bullet moved ${worst.toFixed(2)}x its speed in one frame`);
    pair.dispose();
  }
});

test("Round 15 (3.3): after 250 and 600 ms upload stalls the guest's own ship stays put when it stops", () => {
  for (const stallMs of [250, 600]) {
    for (const seed of [3, 4]) {
      const pair = createDirectPair();
      const rnd = seededR15(seed);
      const base = () => 20 + rnd() * 80;
      // Every 3 s, the upload stalls for `stallMs`: whatever is sent then arrives together when it ends.
      const up = () => {
        const ph = (pair.clockMs - 2000) % 3000;
        return ph >= 2000 && ph < 2000 + stallMs ? base() + (2000 + stallMs - ph) : base();
      };
      pair.setDelays(up, base);
      let releasedAt: number | null = null;
      let drift = 0;
      let wasMoving = false;
      for (let f = 0; f < 60 * 13; f++) {
        const t = (pair.clockMs - 2000) / 1000;
        // Hold a key for 0.8 s, let go for 0.2 s, and change direction every second.
        const across = t < 0 ? 0 : (Math.floor(t) % 2 === 0 ? 1 : -1) * (t % 1 < 0.8 ? 1 : 0);
        stepPairR15(pair, { across, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 });
        const me = pair.guestDir.pilots[1].x;
        const moving = across !== 0;
        if (wasMoving && !moving) releasedAt = me;
        if (!moving && releasedAt !== null) drift = Math.max(drift, Math.abs(me - releasedAt));
        if (moving) releasedAt = null;
        wasMoving = moving;
      }
      assert.ok(drift <= 2, `${stallMs} ms stalls, seed ${seed}: the stopped ship was pulled ${drift.toFixed(1)} px`);
      pair.dispose();
    }
  }
});

function releaseOvershootR15(profile: NetProfileR15): number[] {
  const overshoots: number[] = [];
  const HOLD = 1.6;
  const REL = 0.5;
  for (const seed of [5, 15, 25]) {
    const pair = createDirectPair();
    delaysR15(pair, profile, seed);
    let stop: { x: number; dir: number } | null = null;
    let over = 0;
    let wasHeld = false;
    for (let f = 0; f < 60 * 32; f++) {
      const t = f / 60;
      const dir = Math.floor(t / HOLD) % 2 === 0 ? 1 : -1;
      const held = t > 1 && t % HOLD < HOLD - REL;
      stepPairR15(pair, { across: held ? dir : 0, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 });
      if (wasHeld && !held) {
        if (stop) overshoots.push(over);
        stop = { x: pair.guestDir.pilots[1].x, dir };
        over = 0;
      }
      if (stop && !held) over = Math.max(over, (pair.hostDir.pilots[1].x - stop.x) * stop.dir);
      wasHeld = held;
    }
    pair.dispose();
  }
  return overshoots.sort((a, b) => a - b);
}

test("Round 15 (3.3): the host's copy runs only a little past a released key, then settles", () => {
  const pct = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
  const j60 = releaseOvershootR15('j60');
  const gate = releaseOvershootR15('gate');
  const info = `60 ± 40: p95 ${pct(j60, 0.95).toFixed(1)} max ${j60[j60.length - 1]!.toFixed(1)} | gate: p95 ${pct(gate, 0.95).toFixed(1)} max ${gate[gate.length - 1]!.toFixed(1)}`;
  console.log(`release overshoot ${info}`);
  assert.ok(pct(j60, 0.95) <= 22, info);
  assert.ok(pct(gate, 0.95) <= 26, info);
});

test('Round 15 (5.7): pod taps that arrive together all reach the boss', () => {
  const pair = createDirectPair();
  const boss = createBoss(2, pair.hostWorld.bossEnvObj);
  boss.state = 'fight';
  boss.x = 384;
  boss.y = 200;
  pair.hostWorld.boss = boss;
  for (let f = 0; f < 30; f++) stepPairR15(pair, idleCtrl);
  const before = pair.hostWorld.bossTaps.length;
  for (let i = 0; i < 4; i++) {
    pair.binarySinks.host!(
      encodeGuestInputR15({
        seat: 1,
        targetX: 300 + i * 10,
        targetY: 200,
        firing: false,
        hasPointer: false,
        left: false,
        right: false,
        up: false,
        down: false,
        tap: true,
        seq: 200 + i,
      }),
    );
  }
  pair.hostDir.step(1 / 60, 1 / 60, pair.hostWorld, idleCtrl);
  assert.equal(pair.hostWorld.bossTaps.length - before, 4);
  pair.dispose();
});

test('Round 15 (5.7): through repeated 900 ms upload stalls, the relay never sees more than 35 inputs in a second', async () => {
  const { GUEST_MAX_MESSAGES_PER_SEC } = await import('../relay/room.mjs');
  const pair = createDirectPair();
  const rnd = seededR15(9);
  const base = () => 20 + rnd() * 80;
  // Every 3 s the upload stalls for 900 ms: whatever is sent then arrives together when it ends.
  const up = () => {
    const ph = (pair.clockMs - 2000) % 3000;
    return ph >= 1000 && ph < 1900 ? base() + (1900 - ph) : base();
  };
  pair.setDelays(up, base);
  const arrivals: number[] = [];
  const deliver = pair.binarySinks.host!;
  pair.binarySinks.host = (bytes: Uint8Array) => {
    arrivals.push(pair.clockMs);
    deliver(bytes);
  };
  for (let f = 0; f < 60 * 13; f++) {
    const t = pair.clockMs / 1000;
    // Frantic steering: change direction every 120 ms, so the guest also sends early on every change.
    const across = Math.floor(t / 0.12) % 3 === 0 ? -1 : Math.floor(t / 0.12) % 3 === 1 ? 1 : 0;
    stepPairR15(pair, { across, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 });
  }
  let busiest = 0;
  for (let i = 0, j = 0; i < arrivals.length; i++) {
    while (arrivals[i]! - arrivals[j]! >= 1000) j += 1;
    busiest = Math.max(busiest, i - j + 1);
  }
  assert.ok(arrivals.length > 150, `${arrivals.length} inputs arrived`);
  assert.ok(busiest <= GUEST_MAX_MESSAGES_PER_SEC, `busiest second at the relay: ${busiest} inputs`);
  pair.dispose();
});

test('Round 15 (3.2): the bullet lead does not balloon during an upload stall', () => {
  const pair = createDirectPair();
  const rnd = seededR15(5);
  let stallUntil = -1;
  pair.setDelays(
    () => (pair.clockMs < stallUntil ? stallUntil - pair.clockMs + 60 : 60 + (rnd() * 2 - 1) * 40),
    () => 60 + (rnd() * 2 - 1) * 40,
  );
  for (let f = 0; f < 240; f++) stepPairR15(pair, idleCtrl);
  // The measured lead (on 473f55e there is no separate goal, so read the one value it has).
  const lead = () => {
    const it = pair.guestDir.interpolator as unknown as { ackHostOffsetMs: number | null; ackHostOffsetGoalMs?: number | null };
    return (it.ackHostOffsetGoalMs ?? it.ackHostOffsetMs)!;
  };
  const before = lead();
  stallUntil = pair.clockMs + 600;
  let peak = before;
  for (let f = 0; f < 60; f++) {
    stepPairR15(pair, idleCtrl);
    peak = Math.max(peak, lead());
  }
  assert.ok(peak - before <= 80, `lead grew ${(peak - before).toFixed(0)} ms during the stall`);
  pair.dispose();
});

// -----------------------------------------------------------------------------------------------------------------
// Round 15 netcode follow-up (Claude): what the two reviews of 57f22a7 found. Each test fails on 04c5620.
// -----------------------------------------------------------------------------------------------------------------

const quizRef = await import('../src/game/coop-quiz');

/**
 * Hit agreement: at each host frame, the distance between the host's copy of the guest and the guest's own ship at the
 * moment the guest's screen showed that same host time (its bullets are drawn `lead` ahead). Same clock in this harness.
 */
function agreementR15(
  pair: PairR15,
  steer: (t: number) => CoopLocalControlInput,
  seconds: number,
  opts: { from?: number; hostEvery?: number; onFrame?: (f: number) => void } = {},
): { median: number; over8: number; n: number } {
  const shown: Array<{ hostMs: number; x: number }> = [];
  const errs: number[] = [];
  const dt = 1 / 60;
  const hostEvery = opts.hostEvery ?? 1;
  for (let f = 0; f < seconds * 60; f++) {
    opts.onFrame?.(f);
    pair.advanceClock(dt * 1000);
    pair.flushWire();
    const hostStep = f % hostEvery === 0;
    if (hostStep) pair.hostDir.step(dt * hostEvery, dt * hostEvery, pair.hostWorld, idleCtrl);
    pair.guestDir.step(dt, dt, pair.guestWorld, steer(f * dt));
    const lead = (pair.guestDir.interpolator as unknown as { ackHostOffsetMs: number | null }).ackHostOffsetMs;
    if (lead !== null) shown.push({ hostMs: pair.clockMs + lead, x: pair.guestDir.pilots[1].x });
    if (!hostStep || f < (opts.from ?? 2) * 60) continue;
    const T = (pair.hostDir as unknown as { hostSimElapsedMs: number }).hostSimElapsedMs;
    let best: { hostMs: number; x: number } | null = null;
    for (let i = shown.length - 1; i >= 0 && i >= shown.length - 60; i--) {
      if (!best || Math.abs(shown[i]!.hostMs - T) < Math.abs(best.hostMs - T)) best = shown[i]!;
    }
    if (best && Math.abs(best.hostMs - T) <= 9) errs.push(Math.abs(pair.hostDir.pilots[1].x - best.x));
  }
  errs.sort((a, b) => a - b);
  return {
    median: errs[Math.floor(errs.length / 2)] ?? Infinity,
    over8: errs.filter((e) => e > 8).length / Math.max(1, errs.length),
    n: errs.length,
  };
}

test('Round 15 follow-up (b2 1): host and guest agree where a mouse- or thumb-steered ship is when bullets reach it', () => {
  for (const speed of [250, 400]) {
    const pair = createDirectPair();
    delaysR15(pair, 'j60', 21);
    const y = pair.guestDir.pilots[1].y;
    // The pointer sweeps back and forth across the arena at `speed`, and the ship follows it.
    const steer = (t: number): CoopLocalControlInput => {
      const span = 500;
      const phase = (t * speed) % (2 * span);
      return { across: 0, down: 0, firing: false, touching: true, touchX: 130 + (phase < span ? phase : 2 * span - phase), touchY: y };
    };
    const r = agreementR15(pair, steer, 12);
    assert.ok(r.n > 300, `${r.n} judgments`);
    assert.ok(r.median <= 8 && r.over8 <= 0.25, `${speed} px/s: median ${r.median.toFixed(1)} px, ${(r.over8 * 100).toFixed(1)}% over 8 px`);
    pair.dispose();
  }
});

test('Round 15 follow-up (b2 2): a stalled download does not throttle a guest that can still send', () => {
  const pair = createDirectPair();
  let stallUntil = -1;
  pair.setDelays(() => 40, () => (pair.clockMs < stallUntil ? stallUntil - pair.clockMs + 40 : 40));
  const keys = (t: number): CoopLocalControlInput => ({ across: Math.floor(t) % 2 === 0 ? 1 : -1, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 });
  for (let f = 0; f < 120; f++) stepPairR15(pair, keys(f / 60));
  let sent = 0;
  const realSend = pair.guestClient.sendBinary.bind(pair.guestClient);
  pair.guestClient.sendBinary = (bytes: Uint8Array) => {
    sent += 1;
    return realSend(bytes);
  };
  stallUntil = pair.clockMs + 1200; // nothing reaches the guest for 1.2 s; its own uploads are fine
  for (let f = 0; f < 72; f++) stepPairR15(pair, keys(2 + f / 60));
  assert.ok(sent >= 22, `${sent} inputs sent in 1.2 s`);
  pair.dispose();
});

test('Round 15 follow-up (b2 3): after a short host pause both screens agree again within a second', () => {
  const pair = createDirectPair();
  delaysR15(pair, 'j60', 31);
  const keys = (t: number): CoopLocalControlInput => ({
    across: t % 1.6 < 1.1 ? (Math.floor(t / 1.6) % 2 === 0 ? 1 : -1) : 0,
    down: 0,
    firing: false,
    touching: false,
    touchX: 0,
    touchY: 0,
  });
  let paused = false;
  const dt = 1 / 60;
  // 4 s of play, then the host stops for 0.7 s (a pause, or a long frame), then 3 s more.
  for (let f = 0; f < 240; f++) stepPairR15(pair, keys(f * dt));
  for (let f = 0; f < 42; f++) {
    pair.advanceClock(dt * 1000);
    pair.flushWire();
    paused = true;
    pair.guestDir.step(dt, dt, pair.guestWorld, keys((240 + f) * dt));
  }
  assert.ok(paused);
  const r = agreementR15(pair, (t) => keys(282 * dt + t), 3, { from: 1 });
  assert.ok(r.median <= 10, `after the pause: median ${r.median.toFixed(1)} px, ${(r.over8 * 100).toFixed(1)}% over 8 px`);
  pair.dispose();
});

test("Round 15 follow-up (b2 4): when the host's link drops and returns, the bullet lead does not jump", () => {
  const pair = createDirectPair();
  delaysR15(pair, 'j60', 41);
  for (let f = 0; f < 360; f++) stepPairR15(pair, idleCtrl);
  const it = pair.guestDir.interpolator as unknown as { ackHostOffsetMs: number | null; reset(): void };
  const before = it.ackHostOffsetMs!;
  // The host's link goes down for 0.6 s: what either side sends meanwhile is lost. Inputs sent just before still reach
  // the host, but the snapshots acknowledging them never leave; the first one after the return repeats that old
  // acknowledgement, long after the input was sent.
  const downFrom = pair.clockMs;
  const down = () => pair.clockMs >= downFrom && pair.clockMs < downFrom + 600;
  const realHostSend = pair.hostClient.sendBinary.bind(pair.hostClient);
  pair.hostClient.sendBinary = (b: Uint8Array) => (down() ? true : realHostSend(b));
  const realGuestSend = pair.guestClient.sendBinary.bind(pair.guestClient);
  pair.guestClient.sendBinary = (b: Uint8Array) => (down() ? true : realGuestSend(b));
  for (let f = 0; f < 36; f++) stepPairR15(pair, idleCtrl);
  // The relay tells the guest the host is back (its interpolator starts afresh); the host is welcomed again.
  it.reset();
  const hostEmit = (pair.hostClient as unknown as { emit: (k: string, ...a: unknown[]) => void }).emit.bind(pair.hostClient);
  hostEmit('onConnectionChange', false);
  hostEmit('onWelcome', {});
  let worst = 0;
  for (let f = 0; f < 180; f++) {
    stepPairR15(pair, idleCtrl);
    const lead = it.ackHostOffsetMs;
    if (lead !== null) worst = Math.max(worst, Math.abs(lead - before));
  }
  assert.ok(worst <= 60, `the lead was off by ${worst.toFixed(0)} ms after the return`);
  pair.dispose();
});

test('Round 15 follow-up (b2 5): a bullet fired close to a guest has caught up to the lead before it gets there', () => {
  const pair = createDirectPair();
  delaysR15(pair, 'j100', 51);
  const dt = 1 / 60;
  for (let f = 0; f < 240; f++) stepPairR15(pair, idleCtrl);
  const me = pair.guestDir.pilots[1];
  pair.hostWorld.shots.push({ x: me.x + 4, y: me.y - 260, vx: 0, vy: 300, hostile: true, dead: false, color: '#ff4d4d' });
  let checked = false;
  for (let f = 0; f < 90 && !checked; f++) {
    for (const sh of pair.hostWorld.shots) sh.y += sh.vy * dt;
    stepPairR15(pair, idleCtrl);
    const drawn = pair.guestWorld.shots.find((sh) => sh.hostile);
    const truth = pair.hostWorld.shots[0]!;
    if (drawn && drawn.y >= me.y - 40) {
      const it = pair.guestDir.interpolator as unknown as { ackHostOffsetMs: number };
      const fullLeadMs = pair.clockMs + it.ackHostOffsetMs - (pair.hostDir as unknown as { hostSimElapsedMs: number }).hostSimElapsedMs;
      const drawnLeadMs = ((drawn.y - truth.y) / truth.vy) * 1000;
      assert.ok(drawnLeadMs >= fullLeadMs * 0.8, `drawn ${drawnLeadMs.toFixed(0)} ms ahead of ${fullLeadMs.toFixed(0)} ms`);
      checked = true;
    }
  }
  assert.ok(checked, 'the bullet reached the guest');
  pair.dispose();
});

test('Round 15 follow-up (b2 14): after a 1.2 s download stall, bullets fired meanwhile still meet the guest on time', () => {
  const pair = createDirectPair();
  const rnd = seededR15(71);
  let stallUntil = -1;
  const one = () => 20 + rnd() * 80;
  // Nothing from the host gets through for 1.2 s; then it all arrives at once, in order. Uploads are fine.
  pair.setDelays(one, () => {
    const d = one();
    return pair.clockMs < stallUntil ? stallUntil - pair.clockMs + d : d;
  });
  const dt = 1 / 60;
  const me = pair.guestDir.pilots[1];
  const tick = () => {
    for (const sh of pair.hostWorld.shots) sh.y += sh.vy * dt;
    stepPairR15(pair, idleCtrl);
  };
  for (let f = 0; f < 240; f++) tick();
  const stallFrom = pair.clockMs;
  stallUntil = stallFrom + 1200;
  // One bullet 1.4 s from the guest's ship row, fired 0.3 and 0.9 s into the stall, at its end, and 0.5 and 1 s after.
  const fireAtMs = [300, 900, 1200, 1700, 2200];
  const lateness: string[] = [];
  let reached = 0;
  const seen = new Set<number>();
  for (let f = 0; f < 60 * 4.5; f++) {
    const sinceMs = pair.clockMs - stallFrom;
    fireAtMs.forEach((at, k) => {
      if (sinceMs >= at && sinceMs < at + dt * 1000) {
        pair.hostWorld.shots.push({ x: me.x + 4 + k, y: me.y - 420, vx: 0, vy: 300, hostile: true, dead: false, color: '#ff4d4d' });
      }
    });
    tick();
    for (let k = 0; k < fireAtMs.length; k++) {
      if (seen.has(k)) continue;
      const truth = pair.hostWorld.shots.find((sh) => sh.x === me.x + 4 + k);
      const drawn = pair.guestWorld.shots.find((sh) => sh.hostile && Math.abs(sh.x - (me.x + 4 + k)) < 0.2);
      if (!truth || !drawn || drawn.y < me.y - 40) continue;
      seen.add(k);
      reached += 1;
      const it = pair.guestDir.interpolator as unknown as { ackHostOffsetMs: number };
      const fullLeadMs = pair.clockMs + it.ackHostOffsetMs - (pair.hostDir as unknown as { hostSimElapsedMs: number }).hostSimElapsedMs;
      const drawnLeadMs = ((drawn.y - truth.y) / truth.vy) * 1000;
      if (drawnLeadMs < fullLeadMs - 45) lateness.push(`fired at +${fireAtMs[k]} ms: drawn ${drawnLeadMs.toFixed(0)} ms ahead of ${fullLeadMs.toFixed(0)} ms`);
    }
  }
  assert.equal(reached, fireAtMs.length, 'every bullet was drawn reaching the guest');
  assert.deepEqual(lateness, []);
  pair.dispose();
});

test('Round 15 follow-up (b2 15): after one long host frame, bullets are not drawn ahead of where they meet the guest', () => {
  const pair = createDirectPair();
  delaysR15(pair, 'j60', 81);
  const dt = 1 / 60;
  const me = pair.guestDir.pilots[1];
  const tick = () => {
    for (const sh of pair.hostWorld.shots) sh.y += sh.vy * dt;
    stepPairR15(pair, idleCtrl);
  };
  // Bullets 1 s from the guest's ship row: three fired 0.7, 0.5 and 0.3 s before the long frame, five after it.
  const fireAtMs = [-700, -500, -300, 100, 400, 700, 1000, 1300];
  const fire = (k: number) =>
    pair.hostWorld.shots.push({ x: me.x + 4 + k, y: me.y - 300, vx: 0, vy: 300, hostile: true, dead: false, color: '#ff4d4d' });
  for (let f = 0; f < 240; f++) {
    fireAtMs.forEach((at, k) => {
      if (at < 0 && f === 240 + Math.round(at / (dt * 1000))) fire(k);
    });
    tick();
  }
  // A 300 ms host frame (a busy tab): the game runs it as 50 ms, so the host's clock falls 250 ms behind.
  for (let f = 0; f < 18; f++) {
    pair.advanceClock(dt * 1000);
    pair.flushWire();
    pair.guestDir.step(dt, dt, pair.guestWorld, idleCtrl);
  }
  for (const sh of pair.hostWorld.shots) sh.y += sh.vy * 0.05;
  pair.hostDir.step(0.05, 0.05, pair.hostWorld, idleCtrl);
  const after = pair.clockMs;
  const off: string[] = [];
  const seen = new Set<number>();
  for (let f = 0; f < 60 * 2.6; f++) {
    const sinceMs = pair.clockMs - after;
    fireAtMs.forEach((at, k) => {
      if (at > 0 && sinceMs >= at && sinceMs < at + dt * 1000) fire(k);
    });
    tick();
    for (let k = 0; k < fireAtMs.length; k++) {
      if (seen.has(k)) continue;
      const truth = pair.hostWorld.shots.find((sh) => sh.x === me.x + 4 + k);
      const drawn = pair.guestWorld.shots.find((sh) => sh.hostile && Math.abs(sh.x - (me.x + 4 + k)) < 0.2);
      if (!truth || !drawn || drawn.y < me.y - 40) continue;
      seen.add(k);
      const it = pair.guestDir.interpolator as unknown as { ackHostOffsetMs: number };
      const fullLeadMs = pair.clockMs + it.ackHostOffsetMs - (pair.hostDir as unknown as { hostSimElapsedMs: number }).hostSimElapsedMs;
      const drawnLeadMs = ((drawn.y - truth.y) / truth.vy) * 1000;
      if (Math.abs(drawnLeadMs - fullLeadMs) > 45) off.push(`fired at ${fireAtMs[k]} ms: drawn ${drawnLeadMs.toFixed(0)} ms ahead, lead ${fullLeadMs.toFixed(0)} ms`);
    }
  }
  assert.equal(seen.size, fireAtMs.length, 'every bullet was drawn reaching the guest');
  assert.deepEqual(off, []);
  pair.dispose();
});

test('Round 15 follow-up (b2 8): a guest hidden in a background tab keeps its question clock on time', () => {
  const pair = createDirectPair();
  pair.guestDir.setGrade(1);
  pair.hostDir.setGrade(1);
  for (let f = 0; f < 30; f++) stepPairR15(pair, idleCtrl);
  const events = pair.guestDir as unknown as { handleHostEvent: (m: unknown) => void };
  const { encodeStakeCode } = quizRef;
  events.handleHostEvent({ type: 'event', kind: 'challenge', to: 1, id: 3_000_101, wave: 2, values: [encodeStakeCode('hull')] });
  stepPairR15(pair, idleCtrl);
  const quiz = () => (pair.guestDir.quiz as unknown as { active: { challenge: { timeLeft: number } } | null }).active;
  const before = quiz()!.challenge.timeLeft;
  // A hidden tab's timer ticks once a second and runs that second as twenty 0.05 s steps at one instant.
  for (let tick = 0; tick < 5; tick++) {
    pair.advanceClock(1000);
    for (let i = 0; i < 20; i++) pair.guestDir.step(0.05, 0.05, pair.guestWorld, idleCtrl);
  }
  const moved = before - quiz()!.challenge.timeLeft;
  assert.ok(moved >= 4.5, `the clock moved ${moved.toFixed(2)} s in 5 s`);
  pair.dispose();
});

test('Round 15 follow-up (b2 13): a key change goes out on the next frame, and the relay window stays well clear', async () => {
  const pair = createDirectPair();
  for (let f = 0; f < 90; f++) stepPairR15(pair, idleCtrl);
  const flags: number[] = [];
  const realSend = pair.guestClient.sendBinary.bind(pair.guestClient);
  pair.guestClient.sendBinary = (bytes: Uint8Array) => {
    flags.push(bytes[6]!);
    return realSend(bytes);
  };
  const { INPUT_FLAG_RIGHT } = await import('../src/game/coop-types');
  const right: CoopLocalControlInput = { across: 1, down: 0, firing: false, touching: false, touchX: 0, touchY: 0 };
  // Twelve presses and releases at different points of the 20-a-second send rhythm.
  for (let press = 0; press < 12; press++) {
    for (let f = 0; f < 7 + press; f++) stepPairR15(pair, idleCtrl);
    flags.length = 0;
    stepPairR15(pair, right);
    stepPairR15(pair, right);
    assert.ok(flags.some((fl) => (fl & INPUT_FLAG_RIGHT) !== 0), `press ${press}: the right key was sent within two frames`);
    for (let f = 0; f < 6; f++) stepPairR15(pair, right);
  }
  pair.dispose();
});
