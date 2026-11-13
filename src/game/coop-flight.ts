/**
 * Shared `768 x 1024` (`3:4`) 4-Ship Co-op Flight Director (`Phase 2`).
 *
 * Responsibilities:
 * - Manages up to 4 pilot seats (`P1..P4`) in neon seat colors (`COOP_SEAT_COLORS`), including
 *   formation spawns, per-pilot hull & 6s wingman reboot timers, and TV spectator Host mode (`seat = -1`).
 * - Host (`role === 'host'`): authoritative 60fps simulation over the `768 x 1024` arena, decoding
 *   20 Hz `0x01` `BIN_FRAME_INPUT` frames, enforcing movement speed caps, stepping collisions across all
 *   living connected pilots, packing hits/explosions into the snapshot FX ring, broadcasting 18 Hz `0x02`
 *   `BIN_FRAME_SNAP` frames (`< MAX_BINARY_BYTES`), and sending targeted (`to: seat`) reconnect resync
 *   events (`COOP_RECONNECT_RESYNC_KINDS`) whenever a Guest seat reconnects mid-flight.
 * - Guest (`role === 'guest'`): 0ms local steering prediction + soft reconciliation against authoritative
 *   snapshots, 20 Hz `0x01` `BIN_FRAME_INPUT` transmission, 60fps `SnapshotInterpolator` world reconstruction
 *   (remote ships, enemies, Arms/Sum Boss with zero free-text strings, fuel tanker, seeded asteroid belt,
 *   shots, capsules/mines, and deduplicated FX bursts), and `HOST RECONNECTING` / `HOST PAUSED` resilience.
 */

import type { Boss } from './boss';
import type { CoopClient, StorageLike } from './coop-client';
import {
  COOP_WORLD_H,
  COOP_WORLD_W,
  SnapshotInterpolator,
  decodeGuestInput,
  decodeWorldSnapshot,
  encodeGuestInput,
  encodeWorldSnapshot,
  formatBossMathQuestion,
  parseBossMathQuestion,
  type CoopSnapBoss,
  type CoopSnapEnemy,
  type CoopSnapField,
  type CoopSnapFx,
  type CoopSnapFxKind,
  type CoopSnapItem,
  type CoopSnapItemKind,
  type CoopSnapShip,
  type CoopSnapShot,
  type CoopSnapTanker,
  type CoopWorldSnapshot,
} from './coop-protocol';
import {
  CoopThumbDeck,
  clientToArenaPoint,
  computeCoopViewportLayout,
  type SafeInsets,
  type CoopViewportLayout,
} from './coop-thumbdeck';
import {
  COOP_SEAT_COLORS,
  type CoopEventMessage,
  type CoopGuestInput,
  type CoopLobbyState,
  type CoopPublicSeat,
  type CoopRefusalReason,
  type CoopRoomClosedReason,
  type CoopSeatIndex,
} from './coop-types';
import { NEON, PEBBLE, PINK, ROCK, clamp, rand, type Ink } from './core';
import { KINDS, makeEnemy, type Enemy, type Kind as EnemyKind } from './enemies';
import { textWidth, traceText } from './font';
import type { Reward } from './questions';
import type { SetPieceEnv, SetPieces } from './setpieces';
import { BOSS_CORE, FRIEND, SHIP, trace, type Shape } from './shapes';
import type { Sfx } from './sound';
import { createTanker, tankerTail, type Tanker } from './tanker';
import type { UpgradeId } from './upgrades';
import { ORBIT, SHIELD_SECONDS, WING, fireVolley, type Beam, type Ring, type Rocket, type Shot } from './weapons';

export const COOP_SNAP_INTERVAL_SEC = 1 / 18;
export const COOP_INPUT_INTERVAL_SEC = 1 / 20;
export const COOP_WINGMAN_RESPAWN_SEC = 6.0;
const HOST_STATE_PREFIX = 'gg_coop_host_state_';
const FX_RETENTION_SEC = 0.24;
const ARM_COLORS = [NEON.lime, NEON.yellow, NEON.orange, NEON.violet] as const;

export interface CoopPilotShip {
  seat: CoopSeatIndex;
  present: boolean;
  connected: boolean;
  isHost: boolean;
  callsign: string;
  color: string;
  x: number;
  y: number;
  lastX: number;
  lean: number;
  hull: number;
  maxHull: number;
  alive: boolean;
  respawnSec: number;
  invulnerable: number;
  cooldown: number;
  volley: number;
  firing: boolean;
  shieldReady: boolean;
  shieldRecharge: number;
  orbit: number;
  ackSeq: number;
  latestInput: CoopGuestInput | null;
  pendingTap: { x: number; y: number } | null;
}

export interface CoopPickupItem {
  reward: Reward;
  x: number;
  y: number;
  anchorX: number;
  phase: number;
  age: number;
  dead: boolean;
  ride?: number;
}

export interface CoopMineItem {
  x: number;
  y: number;
  anchorX: number;
  phase: number;
  age: number;
  dead: boolean;
  thrown: boolean;
  ride?: number;
}

export interface CoopLocalControlInput {
  across: number;
  down: number;
  touching: boolean;
  touchX: number;
  touchY: number;
  firing: boolean;
}

/** Bridge between `CoopFlightDirector` and `Game` (or a headless unit-test harness). */
export interface CoopWorldAdapter {
  wave: number;
  banner: number;
  score: number;
  freed: number;
  energy: number;
  paused: boolean;
  parked: boolean;
  gameOver: boolean;
  enemies: Enemy[];
  shots: Shot[];
  rockets: Rocket[];
  beams: Beam[];
  pickups: CoopPickupItem[];
  mines: CoopMineItem[];
  rings: Ring[];
  upgrades: Set<UpgradeId>;
  boss: Boss | null;
  sets: SetPieces;
  setEnv(): SetPieceEnv;
  play(sfx: Sfx): void;
  spark(x: number, y: number, color: string): void;
  burst(shape: Shape, x: number, y: number, scale: number, rot: number, color: string): void;
  ring(x: number, y: number, color: string, reach?: number): void;
  free(x: number, y: number, count?: number): void;
  strikeBoss(x: number, y: number, aimed: boolean, tapped?: boolean): boolean;
  damageEnemy(e: Enemy, amount: number): void;
  destroyEnemy(e: Enemy): void;
  equipUpgrade(id: UpgradeId): void;
  detonateScreen(originX: number, originY: number, color: string): void;
  triggerSquadGameOver(): void;
  resumeSquadNewRun?(): void;
  setHostPausedFromWire?(paused: boolean): void;
}

export interface CoopFlightOptions {
  client: CoopClient;
  initialSeats?: readonly CoopPublicSeat[];
  storage?: StorageLike | null;
  now?: () => number;
  onClosed?: (reason: CoopRoomClosedReason | CoopRefusalReason | 'invalid-code') => void;
  onStatus?: (message: string) => void;
}

interface StoredFxEntry {
  createdAtSec: number;
  fx: CoopSnapFx;
}

function defaultSessionStorage(): StorageLike | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** Deterministic formation spawn coordinates inside the `768 x 1024` (`3:4`) shared arena. */
export function formationSpawnForSeat(seat: CoopSeatIndex): { x: number; y: number } {
  return {
    x: COOP_WORLD_W / 2 + (seat - 1.5) * 96,
    y: COOP_WORLD_H - Math.max(84, Math.round(COOP_WORLD_H * 0.14)),
  };
}

function clampArenaShipX(x: number): number {
  return clamp(x, 22, COOP_WORLD_W - 22);
}

function clampArenaShipY(y: number): number {
  return clamp(y, COOP_WORLD_H * 0.24, COOP_WORLD_H - 28);
}

export class CoopFlightDirector {
  readonly client: CoopClient;
  readonly pilots: [CoopPilotShip, CoopPilotShip, CoopPilotShip, CoopPilotShip];
  readonly deck: CoopThumbDeck;
  readonly interpolator = new SnapshotInterpolator();
  layout: CoopViewportLayout;

  hostReconnecting = false;
  hostReconnectDeadlineMs = 0;
  hostPaused = false;
  hookedSeat: CoopSeatIndex = 0;
  closedReason: CoopRoomClosedReason | CoopRefusalReason | 'invalid-code' | null = null;

  private readonly storage: StorageLike | null;
  private readonly nowFn: () => number;
  private readonly onClosed?: (reason: CoopRoomClosedReason | CoopRefusalReason | 'invalid-code') => void;
  private readonly onStatus?: (message: string) => void;
  private readonly unsubscribe: () => void;

  private readonly wasSeatConnected: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private activeWorld: CoopWorldAdapter | null = null;
  private elapsedSec = 0;
  private snapAccumSec = 0;
  private inputAccumSec = 0;
  private snapTick = 0;
  private inputSeq = 0;
  private fxSeq = 0;
  private readonly recentFx: StoredFxEntry[] = [];
  private guestPendingTap: { x: number; y: number } | null = null;
  private testControlOverride: (CoopLocalControlInput & { tap?: { x: number; y: number } | null }) | null = null;
  private guestTankerCache: Tanker | null = null;

  constructor(opts: CoopFlightOptions) {
    this.client = opts.client;
    this.storage = opts.storage === undefined ? defaultSessionStorage() : opts.storage;
    this.nowFn = opts.now ?? (() => performance.now());
    this.onClosed = opts.onClosed;
    this.onStatus = opts.onStatus;

    this.layout = computeCoopViewportLayout(COOP_WORLD_W, COOP_WORLD_H, false);
    const myInitialPos =
      this.client.seat >= 0
        ? formationSpawnForSeat(this.client.seat as CoopSeatIndex)
        : { x: COOP_WORLD_W / 2, y: COOP_WORLD_H * 0.84 };
    this.deck = new CoopThumbDeck();
    this.deck.reset(myInitialPos.x, myInitialPos.y);

    this.pilots = [0, 1, 2, 3].map((idx) => {
      const seat = idx as CoopSeatIndex;
      const pos = formationSpawnForSeat(seat);
      return {
        seat,
        present: false,
        connected: false,
        isHost: false,
        callsign: `P${seat + 1}`,
        color: COOP_SEAT_COLORS[seat],
        x: pos.x,
        y: pos.y,
        lastX: pos.x,
        lean: 0,
        hull: 3,
        maxHull: 3,
        alive: false,
        respawnSec: 0,
        invulnerable: 1.2,
        cooldown: 0,
        volley: 0,
        firing: false,
        shieldReady: false,
        shieldRecharge: 0,
        orbit: 0,
        ackSeq: 0,
        latestInput: null,
        pendingTap: null,
      };
    }) as [CoopPilotShip, CoopPilotShip, CoopPilotShip, CoopPilotShip];

    const roster = opts.initialSeats ?? this.client.seats;
    this.applySeatRoster(roster, true);

    this.unsubscribe = this.client.subscribe({
      onLobby: (lobby: CoopLobbyState) => this.handleLobbyUpdate(lobby),
      onBinary: (bytes: Uint8Array) => this.handleBinaryFrame(bytes),
      onEvent: (msg: CoopEventMessage) => this.handleHostEvent(msg),
      onHostReconnecting: (graceMs: number) => {
        this.hostReconnecting = true;
        this.hostReconnectDeadlineMs = this.nowFn() + graceMs;
        this.onStatus?.('Host connection dropped. Holding formation while Host reconnects.');
      },
      onHostResumed: () => {
        this.hostReconnecting = false;
        this.hostReconnectDeadlineMs = 0;
        this.onStatus?.('Host reconnected. Resuming flight.');
      },
      onHostPaused: (paused: boolean) => {
        this.hostPaused = paused;
        this.activeWorld?.setHostPausedFromWire?.(paused);
      },
      onRoomClosed: (reason: CoopRoomClosedReason) => {
        this.closedReason = reason;
        this.clearSavedHostProgress();
        this.onClosed?.(reason);
      },
      onRefused: (reason: CoopRefusalReason | 'invalid-code') => {
        this.closedReason = reason;
        this.onClosed?.(reason);
      },
    });
  }

  get isHost(): boolean {
    return this.client.role === 'host';
  }

  get localSeat(): CoopHostSeatOrIndex {
    return this.client.seat;
  }

  dispose(): void {
    this.unsubscribe();
    this.deck.reset();
    this.activeWorld = null;
  }

  /** Update viewport layout (`arenaRect` + portrait-phone Bottom 38% `deckRect`) on window resize. */
  setViewport(viewW: number, viewH: number, insets?: Partial<SafeInsets>, coarsePointer = true): CoopViewportLayout {
    const fullInsets: SafeInsets = {
      top: insets?.top ?? 0,
      right: insets?.right ?? 0,
      bottom: insets?.bottom ?? 0,
      left: insets?.left ?? 0,
    };
    this.layout = computeCoopViewportLayout(viewW, viewH, coarsePointer, fullInsets);
    return this.layout;
  }

  /** Map a canvas client offset `(x, y)` into `768 x 1024` logical arena coordinates. */
  mapCanvasPointToArena(x: number, y: number): { x: number; y: number } {
    const pt = clientToArenaPoint(this.layout, x, y);
    return {
      x: clamp(pt.x, 0, COOP_WORLD_W),
      y: clamp(pt.y, 0, COOP_WORLD_H),
    };
  }

  /** Route pointer events through `CoopThumbDeck` when on a portrait phone (`layout.useThumbDeck`). */
  handlePointerDown(pointerId: number, x: number, y: number, touch: boolean): boolean {
    if (!touch || !this.layout.useThumbDeck || this.client.seat < 0) return false;
    const myPilot = this.pilots[this.client.seat as CoopSeatIndex];
    this.deck.syncTarget(myPilot.x, myPilot.y);
    return this.deck.onPointerDown(this.layout, pointerId, x, y);
  }

  handlePointerMove(pointerId: number, x: number, y: number): boolean {
    if (!this.layout.useThumbDeck) return false;
    return this.deck.onPointerMove(this.layout, pointerId, x, y);
  }

  handlePointerUp(pointerId: number): boolean {
    if (!this.layout.useThumbDeck) return false;
    return this.deck.onPointerUp(pointerId);
  }

  /** Queue an arena tap (e.g. clicking/tapping a Sum Boss pod on Guest or Host). */
  queueArenaTap(arenaX: number, arenaY: number, world?: CoopWorldAdapter): boolean {
    const x = clamp(arenaX, 0, COOP_WORLD_W);
    const y = clamp(arenaY, 0, COOP_WORLD_H);
    if (this.isHost) {
      const w = world ?? this.activeWorld;
      return w ? w.strikeBoss(x, y, true, true) : false;
    }
    this.guestPendingTap = { x, y };
    return Boolean((world ?? this.activeWorld)?.boss);
  }

  /** Programmatic local-control hook for deterministic Node unit tests. */
  setTestLocalInput(
    ctrl: (CoopLocalControlInput & { tap?: { x: number; y: number } | null }) | null,
  ): void {
    this.testControlOverride = ctrl;
  }

  /** Save Host `{ wave, score, freed }` in `sessionStorage` so a brief Host refresh keeps squad progress. */
  saveHostProgress(wave: number, score: number, freed: number): void {
    if (!this.isHost || !this.storage || !this.client.code) return;
    try {
      this.storage.setItem(
        `${HOST_STATE_PREFIX}${this.client.code}`,
        JSON.stringify({ wave: Math.max(1, Math.round(wave)), score: Math.round(score), freed: Math.round(freed) }),
      );
    } catch {
      /* ignore restricted storage */
    }
  }

  loadSavedHostProgress(): { wave: number; score: number; freed: number } | null {
    if (!this.isHost || !this.storage || !this.client.code) return null;
    try {
      const raw = this.storage.getItem(`${HOST_STATE_PREFIX}${this.client.code}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { wave?: unknown; score?: unknown; freed?: unknown };
      if (typeof parsed.wave !== 'number' || !Number.isFinite(parsed.wave) || parsed.wave < 1) return null;
      return {
        wave: Math.max(1, Math.round(parsed.wave)),
        score: typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? Math.max(0, Math.round(parsed.score)) : 0,
        freed: typeof parsed.freed === 'number' && Number.isFinite(parsed.freed) ? Math.max(0, Math.round(parsed.freed)) : 0,
      };
    } catch {
      return null;
    }
  }

  clearSavedHostProgress(): void {
    if (!this.storage || !this.client.code) return;
    try {
      this.storage.removeItem(`${HOST_STATE_PREFIX}${this.client.code}`);
    } catch {
      /* ignore */
    }
  }

  /** Reset all present pilots to formation & full hull when the Host starts a fresh squad run. */
  resetSquadForNewRun(): void {
    for (const p of this.pilots) {
      if (!p.present) continue;
      const pos = formationSpawnForSeat(p.seat);
      p.x = pos.x;
      p.y = pos.y;
      p.lastX = pos.x;
      p.lean = 0;
      p.maxHull = 3;
      p.hull = 3;
      p.alive = true;
      p.respawnSec = 0;
      p.invulnerable = 1.4;
      p.cooldown = 0;
      p.volley = 0;
      p.firing = false;
      p.shieldReady = false;
      p.shieldRecharge = 0;
      p.orbit = 0;
    }
    if (this.client.seat >= 0) {
      const me = this.pilots[this.client.seat as CoopSeatIndex];
      this.deck.syncTarget(me.x, me.y);
    }
  }

  /** Record a compact FX event on the Host to be packed inside the next `18 Hz` `BIN_FRAME_SNAP` frames. */
  recordHostFx(
    kind: CoopSnapFxKind,
    x: number,
    y: number,
    color: string,
    opts?: { enemyKind?: EnemyKind; toughRock?: boolean },
  ): void {
    if (!this.isHost) return;
    this.fxSeq = (this.fxSeq + 1) & 0xff;
    this.recentFx.push({
      createdAtSec: this.elapsedSec,
      fx: {
        seq: this.fxSeq,
        kind,
        enemyKind: opts?.enemyKind ?? 'drifter',
        color,
        toughRock: Boolean(opts?.toughRock),
        x,
        y,
      },
    });
    while (this.recentFx.length > 14) {
      this.recentFx.shift();
    }
  }

  /** Broadcast a wave transition + save Host `sessionStorage` continuity state. */
  notifyHostWaveStart(wave: number, score: number, freed: number): void {
    if (!this.isHost) return;
    this.saveHostProgress(wave, score, freed);
    this.client.sendEvent({ kind: 'wave-sync', wave, score, freed });
  }

  notifyHostTankerStart(wave: number): void {
    if (!this.isHost) return;
    this.client.sendEvent({ kind: 'tanker-start', wave });
  }

  notifyHostFieldEvent(
    wave: number,
    seed: number,
    front: number | null,
    alert: number | null,
    brokenIds: readonly number[],
  ): void {
    if (!this.isHost) return;
    this.client.sendEvent({
      kind: 'asteroid-field',
      wave,
      seed: seed >>> 0,
      front: front === null ? null : Math.round(front),
      alert: alert === null ? null : Math.round(alert * 100) / 100,
      values: brokenIds.slice(-16),
    });
  }

  /** Coordinates of the living connected pilot closest to `(x, y)` (used for enemy/boss aggro). */
  nearestLivingPilot(x: number, y: number): CoopPilotShip {
    let best: CoopPilotShip | null = null;
    let bestDist = Infinity;
    for (const p of this.pilots) {
      if (!p.present || !p.connected || !p.alive) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    if (best) return best;
    const fallbackSeat = this.client.seat >= 0 ? (this.client.seat as CoopSeatIndex) : 0;
    return this.pilots[fallbackSeat];
  }

  /** Pilot nose target for `SetPieces.tanker` so ANY pilot in the squad can catch the fuel line. */
  selectTankerPilot(tanker: Tanker | null, shipScale: number): CoopPilotShip {
    if (tanker?.hooked) {
      const hooked = this.pilots[this.hookedSeat];
      if (hooked.present && hooked.connected && hooked.alive) {
        return hooked;
      }
      tanker.hooked = false;
    }
    const targetX = tanker ? tanker.drogue.x : COOP_WORLD_W / 2;
    const targetY = tanker ? tanker.drogue.y : COOP_WORLD_H * 0.45;
    let best: CoopPilotShip | null = null;
    let bestDist = Infinity;
    for (const p of this.pilots) {
      if (!p.present || !p.connected || !p.alive) continue;
      const d = Math.hypot(p.x - targetX, p.y - 16 * shipScale - targetY);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    const chosen = best ?? this.pilots[0];
    this.hookedSeat = chosen.seat;
    return chosen;
  }

  /** Step one frame (`simDt` world seconds, `realDt` wall-clock seconds) for either Host or Guest. */
  step(simDt: number, realDt: number, world: CoopWorldAdapter, localCtrl: CoopLocalControlInput): void {
    this.activeWorld = world;
    this.elapsedSec += realDt;

    const deckTap = this.deck.consumeArenaTap();
    if (deckTap) {
      this.queueArenaTap(deckTap.x, deckTap.y, world);
    }
    if (this.testControlOverride?.tap) {
      const t = this.testControlOverride.tap;
      this.testControlOverride.tap = null;
      this.queueArenaTap(t.x, t.y, world);
    }

    const ctrl = this.testControlOverride ?? localCtrl;

    if (this.isHost) {
      this.stepHostSquad(simDt, realDt, world, ctrl);
    } else {
      this.stepGuestSquad(simDt, realDt, world, ctrl);
    }
  }

  /** Broadcast an authoritative snapshot immediately (used on wave transitions or deterministic tests). */
  broadcastSnapshotNow(world: CoopWorldAdapter): Uint8Array | null {
    if (!this.isHost) return null;
    this.pruneRecentFx();
    this.snapTick = (this.snapTick + 1) & 0xffff;
    const snap = this.buildWorldSnapshot(world);
    const bytes = encodeWorldSnapshot(snap);
    this.client.sendBinary(bytes);
    return bytes;
  }

  /** Host collision pass across all living connected squad ships. */
  collideHostSquad(world: CoopWorldAdapter, scale = 1): void {
    if (!this.isHost || world.gameOver) return;
    const shipRadius = 9 * scale;
    const hasGuard = world.upgrades.has('guardian');

    // Guardian orbitals block hostile shots & ram enemies for every living pilot
    if (hasGuard) {
      for (const p of this.pilots) {
        if (!p.present || !p.connected || !p.alive) continue;
        const gx = p.x + Math.cos(p.orbit) * ORBIT * scale;
        const gy = p.y + Math.sin(p.orbit) * ORBIT * scale;
        for (const s of world.shots) {
          if (!s.hostile || s.dead || Math.hypot(s.x - gx, s.y - gy) > 20 * scale) continue;
          s.dead = true;
          world.spark(s.x, s.y, NEON.cyan);
          this.recordHostFx('spark', s.x, s.y, NEON.cyan);
          world.play('clang');
        }
      }
    }

    // Shots (both hostile against squad ships, and squad bolts against Boss, mines, rocks, and enemies)
    for (const s of world.shots) {
      if (s.dead) continue;
      if (s.hostile) {
        for (const p of this.pilots) {
          if (!p.present || !p.connected || !p.alive || p.invulnerable > 0) continue;
          if (Math.hypot(s.x - p.x, s.y - p.y) < shipRadius + 3) {
            s.dead = true;
            this.damagePilot(p, world, scale);
            if (world.gameOver) return;
            break;
          }
        }
        continue;
      }

      if (world.strikeBoss(s.x, s.y, !s.stray, false)) {
        s.dead = true;
        this.recordHostFx('spark', s.x, s.y, NEON.yellow);
        continue;
      }
      const mine = world.mines.find((m) => !m.dead && Math.hypot(s.x - m.x, s.y - m.y) < 11 * scale);
      if (mine) {
        s.dead = true;
        world.spark(s.x, s.y, NEON.red);
        this.recordHostFx('spark', s.x, s.y, NEON.red);
        world.play('clang');
        continue;
      }
      const rock = world.sets.rockAt(s.x, s.y);
      if (rock) {
        s.dead = true;
        const wasDead = rock.dead;
        world.sets.hitRock(rock, s.x, s.y, world.setEnv());
        if (!wasDead && rock.dead) {
          this.recordHostFx('rock-break', rock.x, (world.sets.field?.front ?? 0) - rock.d, rock.tough ? ROCK : PEBBLE, {
            toughRock: rock.tough,
          });
        } else {
          this.recordHostFx('spark', s.x, s.y, rock.tough ? ROCK : PEBBLE);
        }
        continue;
      }
      for (const e of world.enemies) {
        if (e.dead || e === s.skip) continue;
        if (Math.hypot(s.x - e.x, s.y - e.y) < KINDS[e.kind].radius * scale + 4) {
          if (s.pierce) {
            s.pierce -= 1;
            s.skip = e;
          } else {
            s.dead = true;
          }
          e.hp -= 1;
          e.flash = 0.1;
          if (e.hp <= 0) {
            world.destroyEnemy(e);
            this.recordHostFx('enemy-burst', e.x, e.y, KINDS[e.kind].color, { enemyKind: e.kind });
          } else {
            world.play('hit');
            this.recordHostFx('spark', s.x, s.y, s.color);
          }
          break;
        }
      }
    }

    // Body collisions, pickups, and mines for each living connected pilot
    const pickupReach = (13 + 9) * scale;
    const mineReach = (10 + 9) * scale;
    for (const p of this.pilots) {
      if (!p.present || !p.connected || !p.alive) continue;

      for (const item of world.pickups) {
        if (item.dead || Math.hypot(item.x - p.x, item.y - p.y) >= pickupReach) continue;
        item.dead = true;
        this.applySquadPickup(p, item.reward, world, scale);
      }

      if (p.invulnerable > 0) continue;

      for (const m of world.mines) {
        if (m.dead || Math.hypot(m.x - p.x, m.y - p.y) >= mineReach) continue;
        m.dead = true;
        world.spark(m.x, m.y, NEON.red);
        this.recordHostFx('spark', m.x, m.y, NEON.red);
        this.damagePilot(p, world, scale);
        if (world.gameOver) return;
        break;
      }
      if (!p.alive || p.invulnerable > 0) continue;

      if (world.boss && (world.boss.state === 'fight' || world.boss.state === 'enter')) {
        if (Math.hypot(p.x - world.boss.x, p.y - world.boss.y) < 35 * 1.3 * scale + shipRadius) {
          this.damagePilot(p, world, scale);
          if (world.gameOver) return;
          continue;
        }
      }

      for (const e of world.enemies) {
        if (e.dead) continue;
        if (Math.hypot(e.x - p.x, e.y - p.y) < KINDS[e.kind].radius * scale + shipRadius) {
          world.destroyEnemy(e);
          this.recordHostFx('enemy-burst', e.x, e.y, KINDS[e.kind].color, { enemyKind: e.kind });
          this.damagePilot(p, world, scale);
          if (world.gameOver) return;
          break;
        }
      }
      if (!p.alive || p.invulnerable > 0) continue;

      const rock = world.sets.rockTouching(p.x, p.y, shipRadius);
      if (rock) {
        world.sets.scrape(rock, world.setEnv());
        this.damagePilot(p, world, scale);
        if (world.gameOver) return;
        if (p.alive) p.invulnerable = Math.max(p.invulnerable, 2.2);
      }
    }
  }

  /** Render all active squad ships (`P1..P4`) inside the `768 x 1024` arena coordinate space. */
  renderSquadShips(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    time: number,
    scale: number,
    shipScale: number,
    reduceMotion: boolean,
    upgrades: ReadonlySet<UpgradeId>,
  ): void {
    const hasWing = upgrades.has('wingmates');
    const hasGuard = upgrades.has('guardian');

    for (const p of this.pilots) {
      if (!p.present) continue;
      const isLocal = p.seat === this.client.seat;

      if (!p.alive) {
        if (p.connected && p.respawnSec > 0) {
          const ghostAlpha = 0.25 + 0.12 * Math.sin(time * 6);
          ink(p.color, ghostAlpha, 1.2, () => {
            trace(ctx, SHIP, p.x, p.y, shipScale * 0.85, 0);
            traceText(ctx, `REBOOT ${Math.ceil(p.respawnSec)}S`, p.x, p.y + 22 * scale, 7, 'center');
          }, false);
        }
        continue;
      }

      const blinking = p.invulnerable > 0 || !p.connected;
      const visible = !blinking || reduceMotion || Math.floor(time * 14) % 2 === 0;
      const alpha = !p.connected ? 0.38 : blinking && reduceMotion ? 0.45 : isLocal ? 1 : 0.92;

      if (visible) {
        ink(p.color, alpha, isLocal ? 1.9 : 1.6, () => {
          trace(ctx, SHIP, p.x, p.y, shipScale, p.lean * 0.16);
        });
        if (p.connected) {
          const flame = (p.firing ? rand(9, 16) : rand(5, 10)) * shipScale;
          ink(isLocal ? PINK : p.color, 0.9, 1.4, () => {
            ctx.moveTo(p.x - 3 * shipScale, p.y + 13 * shipScale);
            ctx.lineTo(p.x, p.y + 13 * shipScale + flame);
            ctx.lineTo(p.x + 3 * shipScale, p.y + 13 * shipScale);
          });
        }
      }

      // Compact callsign tag beneath wingmen (and local P-badge) so squadmates can spot each other instantly
      ink(p.color, p.connected ? 0.82 : 0.45, 1.1, () => {
        const label = p.connected ? `P${p.seat + 1} ${p.callsign}` : `P${p.seat + 1} OFFLINE`;
        traceText(ctx, label, p.x, p.y + 24 * shipScale, 6.5, 'center');
      }, false);

      if (p.shieldReady) {
        ink(NEON.cyan, 0.48 + 0.2 * Math.sin(time * 4 + p.seat), 1.3, () => {
          ctx.moveTo(p.x + 22 * shipScale, p.y);
          ctx.arc(p.x, p.y, 22 * shipScale, 0, Math.PI * 2);
        });
      }
      if (hasWing && p.connected) {
        ink(p.color, 0.88, 1.3, () => {
          for (const side of [-1, 1]) {
            const wx = p.x + side * WING * scale;
            const wy = p.y + 8 * scale + Math.sin(time * 3 + side + p.seat) * 2;
            trace(ctx, FRIEND, wx, wy, 0.5 * shipScale, 0);
          }
        });
      }
      if (hasGuard && p.connected) {
        const gx = p.x + Math.cos(p.orbit) * ORBIT * scale;
        const gy = p.y + Math.sin(p.orbit) * ORBIT * scale;
        ink(NEON.cyan, 0.9, 1.3, () => trace(ctx, FRIEND, gx, gy, 0.45 * shipScale, p.orbit + Math.PI));
      }
    }
  }

  /**
   * Render outer-viewport Co-op chrome in physical canvas coordinates:
   * - Subtle neon `3:4` arena frame
   * - Squad status strip (`P1..P4` hull bars / reboot state)
   * - Portrait-phone Bottom 38% Thumb Steering Deck (`CoopThumbDeck`)
   * - Resilience banners (`HOST RECONNECTING` / `PAUSED BY HOST`)
   */
  renderViewportChrome(ctx: CanvasRenderingContext2D, ink: Ink, _time: number): void {
    const { arenaRect, viewportW, useThumbDeck } = this.layout;

    // 1. Crisp neon border framing the shared 3:4 arena when letterboxed or above the thumb deck
    ink(NEON.cyan, 0.34, 1.3, () => {
      ctx.rect(arenaRect.x + 0.5, arenaRect.y + 0.5, arenaRect.w - 1, arenaRect.h - 1);
    }, false);

    // 2. Squad wingman roster rail (left pillar on widescreen, or compact top bar inside arena on narrow screens)
    const activePilots = this.pilots.filter((p) => p.present);
    const hasSideRail = arenaRect.x >= 132;
    if (hasSideRail) {
      const rx = Math.max(14, arenaRect.x - 120);
      let ry = arenaRect.y + 18;
      ink(NEON.cyan, 0.72, 1.2, () => {
        traceText(ctx, `ROOM ${this.client.formattedCode}`, rx, ry, 7.5, 'left');
      }, false);
      ry += 20;
      for (const p of activePilots) {
        const status = !p.connected
          ? 'SIGNAL LOST'
          : !p.alive
            ? `REBOOT ${Math.ceil(p.respawnSec)}S`
            : `HULL ${p.hull}/${p.maxHull}`;
        ink(p.color, p.connected ? 0.92 : 0.45, 1.3, () => {
          traceText(ctx, `P${p.seat + 1} ${p.callsign}`, rx, ry, 7.5, 'left');
          traceText(ctx, status, rx, ry + 11, 6.5, 'left');
        }, false);
        ry += 30;
      }
    } else if (activePilots.length > 1) {
      const slotW = Math.min(96, (arenaRect.w - 16) / activePilots.length);
      const topY = arenaRect.y + 6;
      activePilots.forEach((p, idx) => {
        const cx = arenaRect.x + 8 + slotW * (idx + 0.5);
        const tag = !p.connected ? `P${p.seat + 1} WAIT` : !p.alive ? `P${p.seat + 1} OUT` : `P${p.seat + 1} ${p.hull}HP`;
        ink(p.color, p.connected ? 0.85 : 0.45, 1.15, () => {
          traceText(ctx, tag, cx, topY, 6.2, 'center');
        }, false);
      });
    }

    // 3. Portrait-phone Bottom 38% Thumb Steering Deck
    if (useThumbDeck && this.client.seat >= 0) {
      const me = this.pilots[this.client.seat as CoopSeatIndex];
      this.deck.render(ctx, this.layout, {
        seat: me.seat,
        callsign: me.callsign,
        hull: me.hull,
        maxHull: me.maxHull,
        alive: me.alive,
        respawnSec: me.respawnSec,
      });
    }

    // 4. Resilience banners (`HOST RECONNECTING` or `PAUSED BY HOST`)
    if (this.hostReconnecting) {
      const secLeft = Math.max(0, Math.ceil((this.hostReconnectDeadlineMs - this.nowFn()) / 1000));
      const bx = arenaRect.x + arenaRect.w / 2;
      const by = arenaRect.y + arenaRect.h * 0.44;
      const bw = Math.min(arenaRect.w - 24, 340);
      ctx.fillStyle = 'rgba(3, 7, 26, 0.84)';
      ctx.fillRect(bx - bw / 2, by - 28, bw, 58);
      ink(NEON.yellow, 0.95, 1.6, () => {
        ctx.rect(bx - bw / 2, by - 28, bw, 58);
        traceText(ctx, 'HOST RECONNECTING', bx, by - 14, 10, 'center');
        traceText(ctx, `HOLDING FORMATION - ${secLeft}S`, bx, by + 6, 7.5, 'center');
      });
    } else if (!this.isHost && this.hostPaused) {
      const bx = arenaRect.x + arenaRect.w / 2;
      const by = arenaRect.y + arenaRect.h * 0.44;
      const label = 'PAUSED BY HOST';
      const bw = Math.min(viewportW - 24, Math.max(190, textWidth(label, 11) + 36));
      ctx.fillStyle = 'rgba(3, 7, 26, 0.82)';
      ctx.fillRect(bx - bw / 2, by - 22, bw, 44);
      ink(NEON.cyan, 0.92, 1.6, () => {
        ctx.rect(bx - bw / 2, by - 22, bw, 44);
        traceText(ctx, label, bx, by - 5, 10.5, 'center');
      });
    }
  }

  // ------------------------------------------------------------------ internals

  private applySeatRoster(seats: readonly CoopPublicSeat[], initial: boolean): void {
    const seen = new Set<CoopSeatIndex>();
    for (const s of seats) {
      seen.add(s.seat);
      const p = this.pilots[s.seat];
      const wasPresent = p.present;
      p.present = true;
      p.connected = s.connected;
      p.isHost = s.isHost;
      p.callsign = s.callsign;
      p.color = COOP_SEAT_COLORS[s.seat];
      if (!wasPresent) {
        const pos = formationSpawnForSeat(s.seat);
        p.x = pos.x;
        p.y = pos.y;
        p.lastX = pos.x;
        p.hull = p.maxHull;
        p.alive = true;
        p.invulnerable = 1.4;
      }
      if (initial) {
        this.wasSeatConnected[s.seat] = s.connected;
      }
    }
    for (const p of this.pilots) {
      if (!seen.has(p.seat)) {
        p.present = false;
        p.connected = false;
        p.alive = false;
        if (initial) this.wasSeatConnected[p.seat] = false;
      }
    }
  }

  private handleLobbyUpdate(lobby: CoopLobbyState): void {
    const reconnectedGuests: CoopSeatIndex[] = [];
    for (const s of lobby.seats) {
      const prevConnected = this.wasSeatConnected[s.seat];
      if (!prevConnected && s.connected && !s.isHost) {
        reconnectedGuests.push(s.seat);
      }
      this.wasSeatConnected[s.seat] = s.connected;
    }
    for (let i = 0; i < 4; i++) {
      const seat = i as CoopSeatIndex;
      if (!lobby.seats.some((s) => s.seat === seat)) {
        this.wasSeatConnected[seat] = false;
      }
    }

    this.applySeatRoster(lobby.seats, false);

    // Round 9 #3: Targeted reconnect resync (`to: seat`) so a rejoining Guest immediately regains
    // wave context, seeded asteroid belt + already-broken rock IDs, and Host pause state.
    if (this.isHost && this.activeWorld && reconnectedGuests.length > 0) {
      const w = this.activeWorld;
      for (const seat of reconnectedGuests) {
        this.client.sendEvent({
          kind: 'wave-sync',
          to: seat,
          wave: w.wave,
          score: w.score,
          freed: w.freed,
        });
        if (w.sets.fieldSeed !== null && (w.sets.field !== null || w.sets.alert !== null)) {
          this.client.sendEvent({
            kind: 'asteroid-field',
            to: seat,
            wave: w.wave,
            seed: w.sets.fieldSeed >>> 0,
            front: w.sets.field ? Math.round(w.sets.field.front) : null,
            alert: w.sets.alert === null ? null : Math.round(w.sets.alert * 100) / 100,
            values: w.sets.brokenRockIds.slice(-16),
          });
        }
      }
      if (w.paused) {
        this.client.sendHostPaused(true);
      }
      this.broadcastSnapshotNow(w);
    }
  }

  private handleBinaryFrame(bytes: Uint8Array): void {
    if (this.isHost) {
      const input = decodeGuestInput(bytes);
      if (!input) return;
      const pilot = this.pilots[input.seat];
      if (!pilot.present || pilot.seat === this.client.seat) return;
      pilot.latestInput = input;
      pilot.ackSeq = input.seq;
      if (input.tap) {
        pilot.pendingTap = {
          x: clamp(input.targetX, 0, COOP_WORLD_W),
          y: clamp(input.targetY, 0, COOP_WORLD_H),
        };
      }
      return;
    }

    const snap = decodeWorldSnapshot(bytes);
    if (!snap) return;
    if (this.hostReconnecting) {
      this.hostReconnecting = false;
      this.hostReconnectDeadlineMs = 0;
    }
    this.interpolator.push(snap, this.nowFn());
  }

  private handleHostEvent(msg: CoopEventMessage): void {
    if (this.isHost) return;
    if (typeof msg.to === 'number' && msg.to !== this.client.seat) return;
    const w = this.activeWorld;
    if (!w) return;

    if (msg.kind === 'wave-sync') {
      if (typeof msg.wave === 'number' && msg.wave >= 1 && msg.wave !== w.wave) {
        w.wave = msg.wave;
        w.banner = 2.0;
      }
      if (typeof msg.score === 'number') w.score = msg.score;
      if (typeof msg.freed === 'number') w.freed = msg.freed;
    } else if (msg.kind === 'asteroid-field' && typeof msg.seed === 'number') {
      const brokenIds = Array.isArray(msg.values)
        ? msg.values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        : [];
      const front = msg.front === undefined ? null : msg.front;
      const alert = msg.alert === undefined ? null : msg.alert;
      if (front === null && alert !== null && alert <= 0.15) {
        w.sets.startSyncedFieldAlarm(msg.seed, w.setEnv());
      } else {
        w.sets.syncFieldState(msg.wave ?? w.wave, msg.seed, front, alert, brokenIds, w.setEnv());
      }
    } else if (msg.kind === 'tanker-start') {
      w.play('tanker');
    }
  }

  private stepHostSquad(
    simDt: number,
    realDt: number,
    world: CoopWorldAdapter,
    localCtrl: CoopLocalControlInput,
  ): void {
    const anyOtherLiving = this.pilots.some((p) => p.present && p.connected && p.alive);
    const tankerHooked = Boolean(world.sets.tanker?.hooked);

    for (const p of this.pilots) {
      if (!p.present) continue;

      if (!p.alive) {
        p.firing = false;
        if (p.connected && anyOtherLiving && !world.gameOver) {
          p.respawnSec = Math.max(0, p.respawnSec - simDt);
          if (p.respawnSec <= 0) {
            const spawn = formationSpawnForSeat(p.seat);
            p.x = spawn.x;
            p.y = spawn.y;
            p.lastX = spawn.x;
            p.hull = Math.max(2, p.maxHull - 1);
            p.alive = true;
            p.invulnerable = 2.4;
            world.ring(p.x, p.y, p.color, 95);
            this.recordHostFx('ring', p.x, p.y, p.color);
            world.play('shieldUp');
          }
        }
        continue;
      }

      p.invulnerable = Math.max(0, p.invulnerable - simDt);
      p.cooldown = Math.max(0, p.cooldown - simDt);
      if (world.upgrades.has('shield') && !p.shieldReady) {
        p.shieldRecharge -= simDt;
        if (p.shieldRecharge <= 0) {
          p.shieldReady = true;
        }
      }
      if (world.upgrades.has('guardian')) {
        p.orbit += simDt * 3.6;
      }

      const isHookedPilot = tankerHooked && this.hookedSeat === p.seat;

      if (p.seat === this.client.seat) {
        this.movePilotWithLocalControl(p, simDt, localCtrl);
        const deckState = this.deck.state();
        const wantsFire = (this.layout.useThumbDeck ? deckState.firing || localCtrl.firing : localCtrl.firing) && !world.parked;
        p.firing = wantsFire && !isHookedPilot;
      } else if (p.connected && p.latestInput) {
        const inp = p.latestInput;
        let dx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
        let dy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
        if (dx && dy) {
          dx *= Math.SQRT1_2;
          dy *= Math.SQRT1_2;
        }
        p.x += dx * 380 * simDt;
        p.y += dy * 380 * simDt;
        if (inp.hasPointer) {
          const tx = clampArenaShipX(inp.targetX) - p.x;
          const ty = clampArenaShipY(inp.targetY) - p.y;
          const dist = Math.hypot(tx, ty);
          if (dist > 0.5) {
            const step = Math.min(dist, 760 * simDt);
            p.x += (tx / dist) * step;
            p.y += (ty / dist) * step;
          }
        }
        p.x = clampArenaShipX(p.x);
        p.y = clampArenaShipY(p.y);
        if (p.pendingTap) {
          const tap = p.pendingTap;
          p.pendingTap = null;
          world.strikeBoss(tap.x, tap.y, true, true);
        }
        p.firing = inp.firing && !world.parked && !isHookedPilot;
      } else {
        p.firing = false;
      }

      const vx = (p.x - p.lastX) / Math.max(realDt, 0.001);
      p.lastX = p.x;
      p.lean += (clamp(vx / 380, -1, 1) - p.lean) * (1 - Math.exp(-realDt * 8));
      if (p.seat === this.client.seat && this.layout.useThumbDeck) {
        this.deck.syncTarget(p.x, p.y);
      }

      if (p.firing && p.cooldown <= 0 && !world.gameOver) {
        p.cooldown = world.upgrades.has('rapid') ? 0.11 : 0.17;
        p.volley += 1;
        if (p.seat === this.client.seat) world.play('shot');
        fireVolley(
          world.shots,
          p.x,
          p.y,
          world.energy,
          p.volley,
          1,
          1,
          Boolean(world.boss),
          world.upgrades,
          p.color,
        );
      }
    }

    this.snapAccumSec += realDt;
    if (this.snapAccumSec >= COOP_SNAP_INTERVAL_SEC) {
      this.snapAccumSec = Math.min(this.snapAccumSec - COOP_SNAP_INTERVAL_SEC, COOP_SNAP_INTERVAL_SEC);
      this.broadcastSnapshotNow(world);
    }
  }

  private stepGuestSquad(
    simDt: number,
    realDt: number,
    world: CoopWorldAdapter,
    localCtrl: CoopLocalControlInput,
  ): void {
    const mySeat = this.client.seat >= 0 ? (this.client.seat as CoopSeatIndex) : 0;
    const me = this.pilots[mySeat];

    // 1. 0ms predicted local movement + cannon audio feedback
    if (me.present && me.alive && !this.hostReconnecting && !this.hostPaused && !world.gameOver) {
      me.cooldown = Math.max(0, me.cooldown - simDt);
      this.movePilotWithLocalControl(me, simDt, localCtrl);
      const vx = (me.x - me.lastX) / Math.max(realDt, 0.001);
      me.lastX = me.x;
      me.lean += (clamp(vx / 380, -1, 1) - me.lean) * (1 - Math.exp(-realDt * 8));

      const isHooked = Boolean(world.sets.tanker?.hooked) && this.hookedSeat === mySeat;
      const deckState = this.deck.state();
      const wantsFire = (this.layout.useThumbDeck ? deckState.firing || localCtrl.firing : localCtrl.firing) && !world.parked;
      me.firing = wantsFire && !isHooked;
      if (me.firing && me.cooldown <= 0) {
        me.cooldown = world.upgrades.has('rapid') ? 0.11 : 0.17;
        world.play('shot');
      }
    } else {
      me.firing = false;
    }

    // 2. Send 8-byte `0x01` `BIN_FRAME_INPUT` at 20 Hz (or immediately on an arena Sum Boss tap)
    this.inputAccumSec += realDt;
    if (this.guestPendingTap !== null || this.inputAccumSec >= COOP_INPUT_INTERVAL_SEC) {
      this.inputAccumSec = 0;
      this.sendGuestInputFrame(me, localCtrl);
    }

    // 3. Sample 60fps Host-tick-timeline interpolator to reconstruct world & reconcile local ship
    const sample = this.interpolator.sample(this.nowFn());
    if (!sample) return;

    const prevWave = world.wave;
    world.wave = sample.wave;
    if (sample.wave > prevWave && prevWave > 0) {
      world.play('wave');
    }
    world.banner = sample.banner;
    world.score = sample.teamScore;
    world.freed = sample.freed;
    world.energy = sample.energy;
    world.parked = sample.parked;
    if (sample.gameOver && !world.gameOver) {
      world.triggerSquadGameOver();
    } else if (!sample.gameOver && world.gameOver) {
      world.resumeSquadNewRun?.();
    }

    for (const s of sample.ships) {
      const p = this.pilots[s.seat];
      p.present = true;
      p.connected = s.connected;
      p.hull = s.hull;
      p.maxHull = s.maxHull;
      p.alive = s.alive;
      p.respawnSec = s.respawnSec;
      p.invulnerable = s.invulnerable ? Math.max(p.invulnerable, 0.12) : 0;
      p.shieldReady = s.shielded;
      p.orbit = s.orbit;
      p.ackSeq = s.ackSeq;
      if (s.wing) world.upgrades.add('wingmates');
      if (s.orbitUpgrade) world.upgrades.add('guardian');
      if (s.spread) world.upgrades.add('wide');

      if (s.seat === mySeat) {
        const err = Math.hypot(s.x - p.x, s.y - p.y);
        if (!s.alive || err > 180) {
          p.x = s.x;
          p.y = s.y;
          p.lastX = s.x;
          this.deck.syncTarget(p.x, p.y);
        } else if (err > 1.5) {
          const blend = err > 48 ? 0.18 : 0.06;
          p.x += (s.x - p.x) * blend;
          p.y += (s.y - p.y) * blend;
          this.deck.syncTarget(p.x, p.y);
        }
      } else {
        p.x = s.x;
        p.y = s.y;
        p.lean = s.lean;
        p.firing = s.firing;
      }
    }

    // Reconstruct interpolated enemies
    world.enemies = sample.enemies.map((se) => {
      const e = makeEnemy(se.kind, se.x, se.y);
      e.id = se.id;
      e.rot = se.rot;
      e.hp = se.hp;
      e.flash = se.flash ? 0.08 : 0;
      return e;
    });

    // Reconstruct interpolated Boss (including numeric-only Sum Boss problem & pod locks)
    world.boss = sample.boss ? this.reconstructGuestBoss(sample.boss, sample.wave) : null;

    // Reconstruct interpolated Tanker
    if (sample.tanker) {
      this.hookedSeat = sample.tanker.hookedSeat;
      world.sets.tanker = this.reconstructGuestTanker(sample.tanker, sample.wave);
    } else {
      world.sets.tanker = null;
      this.guestTankerCache = null;
    }

    // Reconstruct seeded Asteroid Field
    if (sample.field) {
      world.sets.syncFieldState(
        sample.field.wave,
        sample.field.seed,
        sample.field.front,
        sample.field.alert,
        sample.field.recentBrokenIds,
        world.setEnv(),
      );
    } else {
      world.sets.field = null;
      world.sets.alert = null;
      world.sets.near.length = 0;
    }

    // Reconstruct shots, rockets, and beams
    const nextShots: Shot[] = [];
    const nextRockets: Rocket[] = [];
    const nextBeams: Beam[] = [];
    for (const sh of sample.shots) {
      if (sh.kind === 'rocket') {
        nextRockets.push({ x: sh.x, y: sh.y, vx: sh.vx, vy: sh.vy, age: 0.2, dead: false });
      } else if (sh.kind === 'beam') {
        nextBeams.push({ x: sh.x, y: sh.y, age: (1 - sh.beamLife) * 0.22 });
      } else {
        nextShots.push({
          x: sh.x,
          y: sh.y,
          vx: sh.vx,
          vy: sh.vy,
          hostile: sh.kind === 'enemy',
          dead: false,
          color: sh.color,
        });
      }
    }
    world.shots = nextShots;
    world.rockets = nextRockets;
    world.beams = nextBeams;

    // Reconstruct pickups & hazard mines
    const nextPickups: CoopPickupItem[] = [];
    const nextMines: CoopMineItem[] = [];
    for (const it of sample.items) {
      if (it.kind === 'bomb') {
        nextMines.push({
          x: it.x,
          y: it.y,
          anchorX: it.x,
          phase: 0,
          age: it.age,
          dead: false,
          thrown: false,
        });
      } else {
        const reward: Reward =
          it.kind === 'upgrade'
            ? 'upgrade'
            : it.kind === 'hull'
              ? 'hull'
              : it.kind === 'shield'
                ? 'blast'
                : 'energy';
        nextPickups.push({
          reward,
          x: it.x,
          y: it.y,
          anchorX: it.x,
          phase: 0,
          age: it.age,
          dead: false,
        });
      }
    }
    world.pickups = nextPickups;
    world.mines = nextMines;

    // Play deduplicated FX events packed inside `BIN_FRAME_SNAP`
    for (const fx of this.interpolator.consumeNewFx()) {
      if (fx.kind === 'spark') {
        world.spark(fx.x, fx.y, fx.color);
      } else if (fx.kind === 'enemy-burst') {
        world.burst(KINDS[fx.enemyKind].shape, fx.x, fx.y, 1, 0, fx.color);
        world.free(fx.x, fx.y, 1);
        world.play('boom');
      } else if (fx.kind === 'boss-burst') {
        world.burst(BOSS_CORE, fx.x, fx.y, 1.4, 0, fx.color);
        world.play('boom');
      } else if (fx.kind === 'ship-hit') {
        world.spark(fx.x, fx.y, fx.color);
        world.play('hurt');
      } else if (fx.kind === 'ring') {
        world.ring(fx.x, fx.y, fx.color, 95);
      } else if (fx.kind === 'rock-break') {
        world.spark(fx.x, fx.y, fx.toughRock ? ROCK : PEBBLE);
        world.play('boom');
      }
    }
  }

  private movePilotWithLocalControl(p: CoopPilotShip, simDt: number, ctrl: CoopLocalControlInput): void {
    let dx = ctrl.across;
    let dy = ctrl.down;
    if (dx && dy) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    p.x += dx * 380 * simDt;
    p.y += dy * 380 * simDt;

    const deckState = this.deck.state();
    const pointerActive = this.layout.useThumbDeck ? deckState.touching : ctrl.touching;
    const targetX = this.layout.useThumbDeck ? deckState.targetX : ctrl.touchX;
    const targetY = this.layout.useThumbDeck ? deckState.targetY : ctrl.touchY;

    if (pointerActive) {
      const tx = clampArenaShipX(targetX) - p.x;
      const ty = clampArenaShipY(targetY) - p.y;
      const dist = Math.hypot(tx, ty);
      if (dist > 0.5) {
        const step = Math.min(dist, 760 * simDt);
        p.x += (tx / dist) * step;
        p.y += (ty / dist) * step;
      }
    }

    p.x = clampArenaShipX(p.x);
    p.y = clampArenaShipY(p.y);
  }

  private sendGuestInputFrame(me: CoopPilotShip, ctrl: CoopLocalControlInput): void {
    if (this.client.seat < 0) return;
    this.inputSeq = (this.inputSeq + 1) & 0xff;
    const tap = this.guestPendingTap;
    this.guestPendingTap = null;

    const deckState = this.deck.state();
    const hasPointer = Boolean(tap) || (this.layout.useThumbDeck ? deckState.touching : ctrl.touching);
    const targetX = tap
      ? tap.x
      : this.layout.useThumbDeck && deckState.touching
        ? deckState.targetX
        : ctrl.touching
          ? ctrl.touchX
          : me.x;
    const targetY = tap
      ? tap.y
      : this.layout.useThumbDeck && deckState.touching
        ? deckState.targetY
        : ctrl.touching
          ? ctrl.touchY
          : me.y;

    const frame = encodeGuestInput({
      seat: this.client.seat as CoopSeatIndex,
      targetX,
      targetY,
      firing: me.firing,
      hasPointer,
      left: ctrl.across < 0,
      right: ctrl.across > 0,
      up: ctrl.down < 0,
      down: ctrl.down > 0,
      tap: Boolean(tap),
      seq: this.inputSeq,
    });
    this.client.sendBinary(frame);
  }

  private damagePilot(p: CoopPilotShip, world: CoopWorldAdapter, scale: number): void {
    if (p.shieldReady) {
      p.shieldReady = false;
      p.shieldRecharge = SHIELD_SECONDS;
      p.invulnerable = 0.8;
      world.ring(p.x, p.y, NEON.cyan, 80 * scale);
      this.recordHostFx('ring', p.x, p.y, NEON.cyan);
      world.play('shield');
      return;
    }

    p.hull = Math.max(0, p.hull - 1);
    p.invulnerable = 1.6;
    world.spark(p.x, p.y, p.color);
    this.recordHostFx('ship-hit', p.x, p.y, p.color);

    if (p.hull > 0) {
      world.play('hurt');
      return;
    }

    p.alive = false;
    p.firing = false;
    p.respawnSec = COOP_WINGMAN_RESPAWN_SEC;
    world.burst(SHIP, p.x, p.y, 1.15 * scale, 0, p.color);
    this.recordHostFx('ring', p.x, p.y, p.color);

    const anyConnectedPilotAlive = this.pilots.some((other) => other.present && other.connected && other.alive);
    if (!anyConnectedPilotAlive) {
      this.clearSavedHostProgress();
      world.triggerSquadGameOver();
    } else {
      world.play('boom');
      this.onStatus?.(`${p.callsign} hull down. Auto-reboot in ${COOP_WINGMAN_RESPAWN_SEC} seconds.`);
    }
  }

  private applySquadPickup(collector: CoopPilotShip, reward: Reward, world: CoopWorldAdapter, scale: number): void {
    if (reward === 'energy') {
      world.energy = Math.min(1, world.energy + 0.45);
      world.ring(collector.x, collector.y, NEON.cyan, 85 * scale);
      this.recordHostFx('ring', collector.x, collector.y, NEON.cyan);
      world.play('power');
      return;
    }
    if (reward === 'hull') {
      for (const p of this.pilots) {
        if (p.present && p.alive) {
          p.hull = Math.min(p.maxHull, p.hull + 1);
        }
      }
      world.ring(collector.x, collector.y, NEON.lime, 85 * scale);
      this.recordHostFx('ring', collector.x, collector.y, NEON.lime);
      world.play('power');
      return;
    }
    if (reward === 'blast') {
      world.detonateScreen(collector.x, collector.y, collector.color);
      this.recordHostFx('ring', collector.x, collector.y, collector.color);
      return;
    }
    const order: readonly UpgradeId[] = ['rapid', 'wide', 'shield', 'wingmates', 'pierce', 'guardian', 'rockets', 'lance', 'armour', 'nova'];
    const next = order.find((id) => !world.upgrades.has(id));
    if (next) {
      world.equipUpgrade(next);
      if (next === 'armour') {
        for (const p of this.pilots) {
          p.maxHull = 4;
          if (p.alive) p.hull = Math.min(4, p.hull + 1);
        }
      } else if (next === 'shield') {
        for (const p of this.pilots) {
          p.shieldReady = true;
          p.shieldRecharge = 0;
        }
      }
    } else {
      world.energy = 1;
    }
    world.ring(collector.x, collector.y, NEON.lime, 105 * scale);
    this.recordHostFx('ring', collector.x, collector.y, NEON.lime);
    world.play('power');
  }

  private pruneRecentFx(): void {
    const cutoff = this.elapsedSec - FX_RETENTION_SEC;
    while (this.recentFx.length > 0 && this.recentFx[0]!.createdAtSec < cutoff) {
      this.recentFx.shift();
    }
  }

  private buildWorldSnapshot(world: CoopWorldAdapter): CoopWorldSnapshot {
    const hasSpread = world.upgrades.has('wide');
    const hasWing = world.upgrades.has('wingmates');
    const hasGuard = world.upgrades.has('guardian');

    const ships: CoopSnapShip[] = this.pilots
      .filter((p) => p.present)
      .map((p) => ({
        seat: p.seat,
        connected: p.connected,
        alive: p.alive,
        hull: p.hull,
        maxHull: p.maxHull,
        invulnerable: p.invulnerable > 0,
        shielded: p.shieldReady,
        firing: p.firing,
        spread: hasSpread,
        wing: hasWing,
        orbitUpgrade: hasGuard,
        x: p.x,
        y: p.y,
        lean: p.lean,
        orbit: p.orbit,
        ackSeq: p.ackSeq,
        respawnSec: p.alive ? 0 : p.respawnSec,
      }));

    const enemies: CoopSnapEnemy[] = world.enemies
      .filter((e) => !e.dead)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        color: KINDS[e.kind].color,
        hp: e.hp,
        flash: e.flash > 0,
        rot: e.rot,
        x: e.x,
        y: e.y,
      }));

    let boss: CoopSnapBoss | null = null;
    if (world.boss && world.boss.state !== 'gone') {
      const b = world.boss;
      const state: CoopSnapBoss['state'] =
        b.state === 'enter'
          ? 'enter'
          : b.state === 'fight'
            ? 'fight'
            : b.state === 'dying'
              ? 'dying'
              : 'flee';
      const parsedMath = b.problem ? parseBossMathQuestion(b.problem.question) : { a: 0, b: 0, op: '+' as const };
      const armMaxHp = 3 + Math.floor(b.wave / 2);
      boss = {
        kind: b.kind,
        state,
        open: b.open > 0.55,
        flash: b.flash > 0,
        clang: b.clang > 0,
        rage: b.rage > 0,
        hp: Math.max(0, b.hp),
        maxHp: Math.max(1, b.maxHp),
        x: b.x,
        y: b.y,
        age: b.age,
        openTime: Math.max(0, b.openFor),
        arms: b.arms.map((arm) => {
          const angle = arm.base + Math.sin(b.age * 1.4 + arm.phase) * 0.22;
          const reach = (35 + 66 + Math.sin(b.age * 0.9 + arm.phase) * 8) * 1.3;
          return {
            dx: Math.cos(angle) * reach,
            dy: Math.sin(angle) * reach,
            hp: Math.max(0, arm.hp),
            maxHp: armMaxHp,
            flash: arm.flash > 0,
          };
        }),
        mathA: parsedMath.a,
        mathB: parsedMath.b,
        mathOp: parsedMath.op,
        pods: b.pods.map((pod) => ({
          value: pod.value,
          hits: pod.hits,
          right: pod.value === b.problem?.answer,
          flash: pod.flash > 0,
        })),
      };
    }

    let tanker: CoopSnapTanker | null = null;
    if (world.sets.tanker && world.sets.tanker.state !== 'gone') {
      const t = world.sets.tanker;
      tanker = {
        state: t.state === 'enter' ? 'in' : t.state === 'station' ? 'fly' : 'out',
        hooked: t.hooked,
        hookedSeat: this.hookedSeat,
        fuel: t.fuel,
        strain: t.strain,
        x: t.x,
        y: t.y,
        drogueX: t.drogue.x,
        drogueY: t.drogue.y,
      };
    }

    let field: CoopSnapField | null = null;
    if (world.sets.fieldSeed !== null && (world.sets.field !== null || world.sets.alert !== null)) {
      field = {
        seed: world.sets.fieldSeed >>> 0,
        front: world.sets.field ? world.sets.field.front : null,
        alert: world.sets.alert,
        wave: world.wave,
        recentBrokenIds: world.sets.brokenRockIds.slice(-8),
      };
    }

    const shots: CoopSnapShot[] = [];
    for (const sh of world.shots) {
      if (sh.dead) continue;
      shots.push({
        kind: sh.hostile ? 'enemy' : 'bolt',
        color: sh.color,
        heavy: Boolean(sh.pierce),
        x: sh.x,
        y: sh.y,
        vx: sh.vx,
        vy: sh.vy,
        beamLife: 0,
      });
    }
    for (const rk of world.rockets) {
      if (rk.dead) continue;
      shots.push({
        kind: 'rocket',
        color: NEON.orange,
        heavy: true,
        x: rk.x,
        y: rk.y,
        vx: rk.vx,
        vy: rk.vy,
        beamLife: 0,
      });
    }
    for (const bm of world.beams) {
      shots.push({
        kind: 'beam',
        color: NEON.cyan,
        heavy: true,
        x: bm.x,
        y: bm.y,
        vx: 0,
        vy: 0,
        beamLife: clamp(1 - bm.age / 0.22, 0, 1),
      });
    }

    const items: CoopSnapItem[] = [];
    for (const p of world.pickups) {
      if (p.dead) continue;
      const kind: CoopSnapItemKind =
        p.reward === 'upgrade'
          ? 'upgrade'
          : p.reward === 'hull'
            ? 'hull'
            : p.reward === 'blast'
              ? 'shield'
              : 'boost';
      items.push({ kind, age: p.age, x: p.x, y: p.y });
    }
    for (const m of world.mines) {
      if (m.dead) continue;
      items.push({ kind: 'bomb', age: m.age, x: m.x, y: m.y });
    }

    return {
      tick: this.snapTick,
      wave: Math.max(1, world.wave),
      banner: world.banner,
      teamScore: world.score,
      freed: world.freed,
      energy: world.energy,
      paused: world.paused,
      parked: world.parked,
      gameOver: world.gameOver,
      ships,
      enemies,
      boss,
      tanker,
      field,
      shots,
      items,
      fx: this.recentFx.map((entry) => entry.fx),
    };
  }

  private reconstructGuestBoss(sb: CoopSnapBoss, wave: number): Boss {
    const count = Math.min(4, 2 + Math.floor((Math.max(1, wave) - 1) / 2));
    const slotTemplates = Array.from({ length: count }, (_, i) => {
      const base = ((30 + (120 * i) / Math.max(1, count - 1)) * Math.PI) / 180;
      const phase = i * 1.7;
      const angle = base + Math.sin(sb.age * 1.4 + phase) * 0.22;
      const reach = (35 + 66 + Math.sin(sb.age * 0.9 + phase) * 8) * 1.3;
      return {
        base,
        phase,
        color: ARM_COLORS[i % ARM_COLORS.length]!,
        dx: Math.cos(angle) * reach,
        dy: Math.sin(angle) * reach,
      };
    });

    const usedSlots = new Set<number>();
    const arms =
      sb.kind === 'arms'
        ? sb.arms.map((sa) => {
            let bestIdx = 0;
            let bestDist = Infinity;
            slotTemplates.forEach((tpl, idx) => {
              if (usedSlots.has(idx)) return;
              const d = Math.hypot(tpl.dx - sa.dx, tpl.dy - sa.dy);
              if (d < bestDist) {
                bestIdx = idx;
                bestDist = d;
              }
            });
            usedSlots.add(bestIdx);
            const tpl = slotTemplates[bestIdx] ?? slotTemplates[0]!;
            return {
              base: tpl.base,
              phase: tpl.phase,
              color: tpl.color,
              hp: sa.hp,
              flash: sa.flash ? 0.08 : 0,
              fireIn: 99,
            };
          })
        : [];

    const hasMath = sb.kind === 'sum' && sb.pods.length > 0;
    const rightPod = sb.pods.find((p) => p.right);
    const problem = hasMath
      ? {
          question: formatBossMathQuestion(sb.mathA, sb.mathOp, sb.mathB),
          answer: rightPod ? rightPod.value : sb.pods[0]!.value,
          options: sb.pods.map((p) => p.value),
        }
      : null;

    return {
      kind: sb.kind,
      wave: Math.max(1, wave),
      x: sb.x,
      y: sb.y,
      age: sb.age,
      state: sb.state === 'flee' ? 'leaving' : sb.state,
      stateTime: Math.max(1, sb.age),
      hp: sb.hp,
      maxHp: sb.maxHp,
      defeated: sb.hp <= 0,
      flash: sb.flash ? 0.08 : 0,
      clang: sb.clang ? 0.08 : 0,
      rage: sb.rage ? 0.3 : 0,
      open: sb.open ? 1 : 0,
      openFor: sb.openTime,
      cycle: 2,
      arms,
      problem,
      problemId: hasMath ? (sb.mathA * 31 + sb.mathB) | 1 : 0,
      pods: sb.pods.map((p, slot) => ({
        slot,
        value: p.value,
        hits: p.hits,
        cool: 0.7,
        flash: p.flash ? 0.08 : 0,
      })),
      nextSum: 1,
      fireIn: 99,
      bombIn: 99,
      timeLeft: 45,
      popIn: 1,
    };
  }

  private reconstructGuestTanker(st: CoopSnapTanker, wave: number): Tanker {
    if (!this.guestTankerCache) {
      this.guestTankerCache = createTanker(Math.max(1, wave), {
        w: COOP_WORLD_W,
        h: COOP_WORLD_H,
        top: 0,
        left: 0,
        right: 0,
        scale: 1,
        noseX: COOP_WORLD_W / 2,
        noseY: COOP_WORLD_H * 0.8,
      });
    }
    const t = this.guestTankerCache;
    t.wave = Math.max(1, wave);
    t.state = st.state === 'in' ? 'enter' : st.state === 'fly' ? 'station' : st.state === 'out' ? 'leaving' : 'gone';
    t.x = st.x;
    t.y = st.y;
    t.fuel = st.fuel;
    t.hooked = st.hooked;
    t.strain = st.strain;
    if (st.hooked) {
      const pilot = this.pilots[st.hookedSeat];
      t.drogue.x = pilot.x;
      t.drogue.y = pilot.y - 16 * 1.15;
    } else {
      t.drogue.x = st.drogueX;
      t.drogue.y = st.drogueY;
    }
    // Keep tail valid even before first station tick
    void tankerTail(t, 1);
    return t;
  }
}

type CoopHostSeatOrIndex = -1 | CoopSeatIndex;
