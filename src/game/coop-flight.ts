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
  COOP_LEAD_AVERAGE_GAIN,
  COOP_WORLD_H,
  COOP_WORLD_W,
  SNAP_MAX_FX,
  SnapshotInterpolator,
  decodeGuestInput,
  decodeUpgradesMask,
  decodeWorldSnapshot,
  encodeGuestInput,
  encodeUpgradesMask,
  encodeWorldSnapshot,
  formatBossMathQuestion,
  getSnapshotVersionMismatch,
  isSnapshotVersionMismatch,
  packBrokenRockWords,
  parseBossMathQuestion,
  unpackBrokenRockWords,
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
  CLOSE_BREAK_OVER,
  CLOSE_CANCELLED,
  CLOSE_OFFER_FITTED,
  CLOSE_TIMED_OUT,
  COOP_GRADE_PICK_SEC,
  COOP_OFFER_SEC,
  CoopLocalQuizController,
  coopBreakMaxSec,
  coopStakeMaxSec,
  decodeStakeCode,
  encodeStakeCode,
  getCoopTabGrade,
  renderSquadMissionSummary,
  setCoopTabGrade,
  verdictQuality,
  type CoopQuizHooks,
} from './coop-quiz';
import {
  CoopThumbDeck,
  clientToArenaPoint,
  computeCoopViewportLayout,
  hitTestDeckCard,
  type CoopDeckCardView,
  type SafeInsets,
  type CoopViewportLayout,
} from './coop-thumbdeck';
import {
  COOP_SEAT_COLORS,
  type CoopAnswerMessage,
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
import type { Grade } from './fireworks';
import { textWidth, traceText } from './font';
import {
  ALL_OWNED_POINTS,
  DEFUSE_POINTS,
  FULL_HULL_BONUS,
  JAM_SECONDS,
  POWER_GAIN,
  type GradeBand,
  type Reward,
  type Stake,
} from './questions';
import type { SetPieceEnv, SetPieces } from './setpieces';
import { BOSS_CORE, FRIEND, SHIP, trace, type Shape } from './shapes';
import type { Sfx } from './sound';
import { createTanker, tankerTail, type Tanker } from './tanker';
import { UPGRADES, offerUpgrades, type UpgradeId } from './upgrades';
import { ORBIT, SHIELD_SECONDS, WING, fireVolley, type Beam, type Ring, type Rocket, type Shot } from './weapons';

export { getCoopTabGrade, setCoopTabGrade };

export const COOP_SNAP_INTERVAL_SEC = 1 / 18;
export const COOP_INPUT_INTERVAL_SEC = 1 / 20;
export const COOP_WINGMAN_RESPAWN_SEC = 6.0;
export const COOP_WRECK_REVIVE_RADIUS = 34;
export const COOP_STALE_INPUT_SEC = 0.15;
export const COOP_ACK_DEADBAND_PX = 24;
/**
 * The host's limits match the pilots' own clocks (`coop-quiz.ts`, the same for every grade band) plus this much
 * for the answer to cross the network, so a pilot answering in time is never cut off.
 */
export const COOP_ANSWER_GRACE_SEC = 2.5;
export const COOP_QUIZ_TIMEOUT_SEC = coopStakeMaxSec() + COOP_ANSWER_GRACE_SEC;
/**
 * While a guest's inputs stop arriving (its link or the host's is down; the guest's own clock waits meanwhile), the
 * host's clock for that guest's question waits too, at most this long per question.
 */
export const COOP_STALE_HOLD_MAX_SEC = 8;
/** sessionStorage key: the host page's last session byte, so the next page in this tab picks a different one. */
const HOST_SESSION_KEY = 'gg_coop_host_session';
export const COOP_OFFER_TIMEOUT_SEC = COOP_OFFER_SEC + 1.0;
/** How long the host waits for every pilot's pre-wave break answer at `wave`. */
export function coopBreakWindowSec(wave: number): number {
  return coopBreakMaxSec(wave) + COOP_ANSWER_GRACE_SEC;
}
export const COOP_RESUME_COUNTDOWN_SEC = 3.0;
export const COOP_HOST_AWAY_MAGIC = 901;
/** Each host page numbers its questions from `session × CHALLENGE_ID_BLOCK`, so ids never repeat across reloads. */
const CHALLENGE_ID_BLOCK = 1_000_000;
/** The `UPGRADES` index of a fitted upgrade, or -1 for none (every upgrade already owned). */
const upgradeIndexOf = (id: UpgradeId | null): number => (id ? UPGRADES.findIndex((u) => u.id === id) : -1);
const offerIdsOf = (indices: readonly number[]): UpgradeId[] =>
  indices.map((i) => UPGRADES[i]?.id).filter((id): id is UpgradeId => id !== undefined);
/** How many sent answers a guest keeps, to re-send one the host lost. */
const ANSWER_CACHE_SIZE = 64;
/** Fastest the host moves a guest's ship while following it (the pointer-plus-keys top speed). */
const FOLLOW_MAX_SPEED = 1140;

/** Host: a guest's recent reported positions, timed by its own send clock. */
interface GuestTrack {
  /** Unwrapped send time of the newest sample, in the guest's ms (null before the first). */
  sendFull: number | null;
  /** Smallest (arrival - send) seen, creeping up slowly: the base one-way delay plus the clock difference. */
  offsetMinMs: number | null;
  lastArrivalMs: number;
  /** How late inputs usually arrive beyond the fastest one (an average, ms; stalls count as at most 150 ms). */
  jitterMs: number;
  /** Newest last. */
  samples: { s: number; x: number; y: number }[];
  /** Whether the samples carry the guest's own send times (10-byte frames) rather than arrival times. */
  timedBySender: boolean;
}

function freshTrack(): GuestTrack {
  return { sendFull: null, offsetMinMs: null, lastArrivalMs: 0, jitterMs: 0, samples: [], timedBySender: false };
}
const HOST_STATE_PREFIX = 'gg_coop_host_state_';
const FX_RETENTION_SEC = 0.24;
const ARM_COLORS = [NEON.lime, NEON.yellow, NEON.orange, NEON.violet] as const;

interface HostSeatChallengeState {
  mode: 'stake' | 'offer';
  id: number;
  stake: Stake;
  wave: number;
  offerIndices?: number[];
  expiresAtSec: number;
  scale: number;
}

interface HostSquadBreakState {
  id: number;
  nextWave: number;
  answered: Map<CoopSeatIndex, { verdict: Grade; quality: number }>;
  /** Pilots still answering a question when the break began: their break card opens when it closes. */
  waiting: Set<CoopSeatIndex>;
  /** Infinite while anyone is still waiting: the break's window starts when the last waiting card opens. */
  expiresAtSec: number;
}

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
  answering: boolean;
  jamSec: number;
  revives: number;
  questionsRight: number;
  cooldown: number;
  volley: number;
  firing: boolean;
  shieldReady: boolean;
  shieldRecharge: number;
  orbit: number;
  ackSeq: number;
  latestInput: CoopGuestInput | null;
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
  startWave?(wave: number): void;
  celebrate?(grade: Grade, big: boolean): void;
  say?(message: string): void;
  getGrade?(): GradeBand | null;
  setGrade?(grade: GradeBand): void;
}

export interface CoopFlightOptions {
  client: CoopClient;
  initialSeats?: readonly CoopPublicSeat[];
  storage?: StorageLike | null;
  now?: () => number;
  initialGrade?: GradeBand | null;
  initialInputMode?: 'keys' | 'touch';
  onClosed?: (reason: CoopRoomClosedReason | CoopRefusalReason | 'invalid-code') => void;
  onVersionMismatch?: (message: string) => void;
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
  readonly quiz: CoopLocalQuizController;
  layout: CoopViewportLayout;

  hostReconnecting = false;
  hostReconnectDeadlineMs = 0;
  hostPaused = false;
  hostAway = false;
  resumeCountdownSec = 0;
  squadBreakActive = false;
  versionMismatch = false;
  private versionMismatchDir: 'older' | 'newer' = 'newer';
  hookedSeat: CoopSeatIndex = 0;
  closedReason: CoopRoomClosedReason | CoopRefusalReason | 'invalid-code' | null = null;

  private readonly storage: StorageLike | null;
  private readonly nowFn: () => number;
  private readonly onClosed?: (reason: CoopRoomClosedReason | CoopRefusalReason | 'invalid-code') => void;
  private readonly onVersionMismatch?: (message: string) => void;
  private readonly onStatus?: (message: string) => void;
  private readonly unsubscribe: () => void;

  private readonly wasSeatConnected: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private readonly hasHostSeenSeq: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private readonly lastInputAtSec: [number, number, number, number] = [0, 0, 0, 0];
  private readonly awaitingRespawnSync: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private readonly respawnSyncDeadlineSec: [number, number, number, number] = [0, 0, 0, 0];
  private readonly downedAtSec: [number, number, number, number] = [-10, -10, -10, -10];
  private hadAnyPilotInRun = false;
  private readonly hostSessionId: number;
  private activeWorld: CoopWorldAdapter | null = null;
  private elapsedSec = 0;
  private hostSimElapsedMs = 0;
  private sentInitialPause = false;
  private snapAccumSec = 0;
  private inputAccumSec = 0;
  private snapTick = 0;
  private inputSeq = 0;
  private fxSeq = 0;
  private nextChallengeId = 4;
  private readonly hostSeatChallenge: [
    HostSeatChallengeState | null,
    HostSeatChallengeState | null,
    HostSeatChallengeState | null,
    HostSeatChallengeState | null,
  ] = [null, null, null, null];
  private hostBreak: HostSquadBreakState | null = null;
  /** A wave whose pre-wave break waits for open questions and offers to finish (they are never thrown away). */
  /** Seconds each seat's current question clock has been held while that pilot picks a grade (capped). */
  private readonly pickingHeldSec: [number, number, number, number] = [0, 0, 0, 0];
  /** Host: how long each seat's question clock has waited for that guest's inputs to come back. */
  private readonly staleHeldSec: [number, number, number, number] = [0, 0, 0, 0];
  /** Host: whether the host's own link was up last step (open questions are sent again when it comes back). */
  private hostLinkUp = true;
  /** Guest: the wall clock at the last quiz step (the question clock follows the wall clock, see quizStepSec). */
  private lastQuizWallMs: number | null = null;
  /** Guest: the last answer sent, until the host shows it arrived (it is sent again if the host still waits). */
  private pendingAnswer: {
    kind: 'question' | 'break';
    answerId: number;
    verdict: Grade;
    quality: number;
    sentAtMs: number;
  } | null = null;
  /**
   * Questions the host closed recently, per seat (id -> close code and extra), to answer a late answer once
   * (`replied`).
   */
  private readonly recentClosedBySeat: Map<number, { code: number; extra: number | null; replied?: boolean }>[] = [
    new Map(),
    new Map(),
    new Map(),
    new Map(),
  ];
  /** Guest: answers already sent (by question or offer id), re-sent if the host asks again after losing one. */
  private readonly guestAnswerCache = new Map<number, { answerId: number; verdict: Grade; quality: number }>();
  /** Host: each guest's recent reported positions, timed by the guest's own send clock (network jitter removed). */
  private readonly tracks: GuestTrack[] = [freshTrack(), freshTrack(), freshTrack(), freshTrack()];
  /** Host: per seat, the send time (in the track's unwrapped guest ms) of the newest input accepted, taps included. */
  private readonly ackSendFull: Array<number | null> = [null, null, null, null];
  /**
   * Host: per seat, the bullet lead that guest's own screen uses: snapshot host time minus the send time of the input
   * the snapshot acknowledges, averaged exactly as `setAckHostOffset` does. See `trackProjAgeSec`.
   */
  private readonly mirrorLeadMs: Array<number | null> = [null, null, null, null];
  private readonly mirrorAckSeq: Array<number | null> = [null, null, null, null];
  /** Host: pod taps waiting to strike the boss, per seat (a stalled link can deliver several at once). */
  private readonly tapQueue: Array<{ x: number; y: number }>[] = [[], [], [], []];
  /** Guest: the host page's session byte, to forget answered question ids when the host page reloads. */
  private lastHostSession: number | null = null;
  /** Guest: the input whose acknowledgement last calibrated the bullet lead (only a new ack is a new sample). */
  private lastCalibAckSeq: number | null = null;
  private guestParked = false;
  private mismatchCount = 0;
  private lastSentDiscreteMask = -1;
  private lastSeenAckSeq: number | null = null;
  private pendingAckErr = { dx: 0, dy: 0 };
  private reconcileGraceSec = 0;
  private readonly recentFx: StoredFxEntry[] = [];
  private readonly firedSinceLastSnap: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private readonly guardCoolBySeat: [number, number, number, number] = [0, 0, 0, 0];
  private readonly guestLocalBolts: Shot[] = [];
  private readonly guestSendTimesMs: number[] = [];
  private readonly guestSuppressedBullets: Array<{ x: number; y: number; vx: number; vy: number; ttlSec: number }> = [];
  private readonly boltSkipEnemyIds = new WeakMap<Shot, Set<number>>();
  private readonly predHistory: Array<{ seq: number; x: number; y: number; sentAtMs: number; valid: boolean }>;
  private hasSentAnyInput = false;
  private wasAliveOnWire = true;
  private prevWireHull = 3;
  private guestPendingTap: { x: number; y: number } | null = null;
  private testControlOverride: (CoopLocalControlInput & { tap?: { x: number; y: number } | null }) | null = null;
  private guestTankerCache: Tanker | null = null;

  constructor(opts: CoopFlightOptions) {
    this.client = opts.client;
    this.storage = opts.storage === undefined ? defaultSessionStorage() : opts.storage;
    this.nowFn = opts.now ?? (() => performance.now());
    this.onClosed = opts.onClosed;
    this.onVersionMismatch = opts.onVersionMismatch;
    this.onStatus = opts.onStatus;
    this.hostSessionId = this.pickHostSessionId(opts.client.role === 'host');
    // Question ids are unique to this host page, so guests never mistake a reloaded host's question for an old one.
    this.nextChallengeId = this.hostSessionId * CHALLENGE_ID_BLOCK + 4;
    this.predHistory = Array.from({ length: 256 }, () => ({ seq: 0, x: 0, y: 0, sentAtMs: 0, valid: false }));
    this.quiz = new CoopLocalQuizController({
      isolatedGrade: opts.storage !== undefined || opts.initialGrade !== undefined,
      initialGrade: opts.initialGrade,
      initialInputMode: opts.initialInputMode,
    });

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
        answering: false,
        jamSec: 0,
        revives: 0,
        questionsRight: 0,
        cooldown: 0,
        volley: 0,
        firing: false,
        shieldReady: false,
        shieldRecharge: 0,
        orbit: 0,
        ackSeq: 0,
        latestInput: null,
      };
    }) as [CoopPilotShip, CoopPilotShip, CoopPilotShip, CoopPilotShip];

    const roster = opts.initialSeats ?? this.client.seats;
    this.applySeatRoster(roster, true);

    this.unsubscribe = this.client.subscribe({
      onLobby: (lobby: CoopLobbyState) => this.handleLobbyUpdate(lobby),
      onBinary: (bytes: Uint8Array) => this.handleBinaryFrame(bytes),
      onEvent: (msg: CoopEventMessage) => this.handleHostEvent(msg),
      onAnswer: (msg: CoopAnswerMessage) => this.handleWireAnswer(msg),
      onHostReconnecting: (graceMs: number) => {
        this.hostReconnecting = true;
        this.hostReconnectDeadlineMs = this.nowFn() + graceMs;
        this.onStatus?.('Host connection dropped. Holding formation while Host reconnects.');
      },
      onHostResumed: () => {
        this.hostReconnecting = false;
        this.hostReconnectDeadlineMs = 0;
        this.interpolator.reset();
        this.onStatus?.('Host reconnected. Resuming flight.');
      },
      onHostPaused: (paused: boolean) => {
        this.hostPaused = paused;
        if (!paused) {
          this.hostAway = false;
          this.resumeCountdownSec = 0;
        }
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

  get isSquadParked(): boolean {
    return this.isHost ? this.squadBreakActive : this.guestParked;
  }

  get isResumeCountdownActive(): boolean {
    return this.resumeCountdownSec > 0;
  }

  get grade(): GradeBand | null {
    return this.quiz.getGrade(this.activeWorld?.getGrade);
  }

  setGrade(grade: GradeBand | null): void {
    this.quiz.setGrade(grade, this.activeWorld?.setGrade);
  }

  bindWorld(world: CoopWorldAdapter): void {
    this.activeWorld = world;
  }

  dispose(): void {
    this.unsubscribe();
    this.deck.reset();
    this.quiz.clearActive(true);
    this.guestLocalBolts.length = 0;
    this.activeWorld = null;
  }

  /** Update viewport layout (`arenaRect` + portrait-phone Bottom 38% `deckRect`) on window resize. */
  setViewport(viewW: number, viewH: number, insets?: Partial<SafeInsets>, coarsePointer = true): CoopViewportLayout {
    const prevUseDeck = this.layout.useThumbDeck;
    const fullInsets: SafeInsets = {
      top: insets?.top ?? 0,
      right: insets?.right ?? 0,
      bottom: insets?.bottom ?? 0,
      left: insets?.left ?? 0,
    };
    this.layout = computeCoopViewportLayout(viewW, viewH, coarsePointer, fullInsets);
    if (this.layout.useThumbDeck) {
      this.quiz.setInputMode('touch');
    }
    if (!this.layout.useThumbDeck || prevUseDeck !== this.layout.useThumbDeck) {
      this.deck.releasePointer(false);
    }
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
    if (!this.layout.useThumbDeck || this.client.seat < 0) return false;
    const w = this.activeWorld;
    if (w && (w.gameOver || w.paused)) {
      this.deck.releasePointer(false);
      return false;
    }
    const card = this.quiz.deckCard(true);
    if (card) {
      this.deck.releasePointer(false);
      const hit = hitTestDeckCard(this.layout, card, x, y);
      if (hit !== null) {
        this.quiz.pickDeckCard(hit, true, this.quizHooks(w));
        return true;
      }
      if (!this.quiz.isInteractive() && !this.isSquadParked && touch && y >= this.layout.deckRect.y - 4) {
        this.quiz.dismissCard();
      } else {
        return touch;
      }
    }
    if (!touch) {
      const btn = this.layout.autoFireBtnRect;
      if (x >= btn.x - 4 && x <= btn.x + btn.w + 4 && y >= btn.y - 4 && y <= btn.y + btn.h + 4) {
        return this.deck.onPointerDown(this.layout, pointerId, x, y, false);
      }
      return false;
    }
    const allowArenaTap = Boolean(
      w?.boss && w.boss.kind === 'sum' && w.boss.state === 'fight' && w.boss.pods.length > 0,
    );
    const myPilot = this.pilots[this.client.seat as CoopSeatIndex];
    this.deck.syncTarget(myPilot.x, myPilot.y);
    return this.deck.onPointerDown(this.layout, pointerId, x, y, allowArenaTap);
  }

  handlePointerMove(pointerId: number, x: number, y: number): boolean {
    if (!this.layout.useThumbDeck) return false;
    return this.deck.onPointerMove(this.layout, pointerId, x, y);
  }

  handlePointerUp(pointerId: number): boolean {
    return this.deck.onPointerUp(pointerId);
  }

  releasePointers(clearAutoFire = false): void {
    this.deck.releasePointer(clearAutoFire);
  }

  /** Allow `Space` button activation only on the Co-op Leave confirmation sheet's own buttons. */
  isLeaveSheetButton(target: EventTarget | null): boolean {
    if (!target || typeof target !== 'object') return false;
    const el = target as { hasAttribute?: (name: string) => boolean };
    if (typeof el.hasAttribute !== 'function') return false;
    return el.hasAttribute('data-coop-stay') || el.hasAttribute('data-coop-confirm-leave');
  }

  wantsKey(key: string): boolean {
    if (this.client.seat < 0 || this.activeWorld?.gameOver) return false;
    return this.quiz.wantsKey(key);
  }

  typeKey(key: string, world?: CoopWorldAdapter): boolean {
    if (this.client.seat < 0) return false;
    return this.quiz.typeKey(key, this.layout.useThumbDeck, this.quizHooks(world ?? this.activeWorld));
  }

  onTouchInput(world?: CoopWorldAdapter): void {
    if (this.client.seat < 0) return;
    this.quiz.onTouchDetected(this.layout.useThumbDeck, this.quizHooks(world ?? this.activeWorld));
  }

  pickArenaOverlay(arenaX: number, arenaY: number, world?: CoopWorldAdapter): boolean {
    if (this.client.seat < 0) return false;
    return this.quiz.pickArena(arenaX, arenaY, this.layout.useThumbDeck, this.quizHooks(world ?? this.activeWorld));
  }

  currentDeckCard(): CoopDeckCardView | null {
    return this.quiz.deckCard(this.layout.useThumbDeck);
  }

  suppressStandardMessages(state: 'ready' | 'playing' | 'over', paused: boolean): boolean {
    if (state === 'over') return true;
    if (paused && this.resumeCountdownSec > 0) return true;
    if (!paused && state === 'playing' && !this.layout.useThumbDeck && this.quiz.isOpen()) return true;
    return false;
  }

  renderArenaOverlays(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    opts: {
      time: number;
      state: 'ready' | 'playing' | 'over';
      stateTime: number;
      paused: boolean;
      reduceMotion: boolean;
      coarse: boolean;
      soulsInFlight?: number;
    },
  ): void {
    const w = this.activeWorld;
    if (!w) return;
    if (opts.state === 'over' || w.gameOver) {
      const roster = this.pilots
        .filter((p) => p.present)
        .map((p) => ({
          seat: p.seat,
          callsign: p.callsign,
          color: p.color,
          questionsRight: p.questionsRight,
          revives: p.revives,
        }));
      renderSquadMissionSummary(ctx, ink, {
        formattedCode: this.client.formattedCode || this.client.code || 'SQUAD',
        isHost: this.isHost,
        coarse: opts.coarse,
        time: opts.time,
        stateTime: opts.stateTime,
        score: w.score,
        wave: w.wave,
        totalFreed: w.freed + (opts.soulsInFlight ?? 0),
        upgrades: w.upgrades,
        pilots: roster,
      });
      return;
    }
    if (!opts.paused && opts.state === 'playing' && this.client.seat >= 0) {
      this.quiz.renderArenaQuiz(ctx, ink, opts.time, opts.reduceMotion, this.layout.useThumbDeck);
    }
  }

  /** Engage `HOST AWAY` auto-pause when a piloting Host hides their tab for `>= 2.0 s`. */
  engageHostAway(world?: CoopWorldAdapter): void {
    if (!this.isHost || this.client.tvMode) return;
    const w = world ?? this.activeWorld;
    this.hostAway = true;
    this.resumeCountdownSec = 0;
    if (w) {
      this.client.sendEvent({
        kind: 'wave-sync',
        wave: w.wave,
        score: w.score,
        freed: w.freed,
        values: [COOP_HOST_AWAY_MAGIC, 1, 0],
      });
    }
    this.onStatus?.('Host tab hidden. Squad paused until you return.');
  }

  /** Start the synced `3-2-1` countdown when a piloting Host returns from `HOST AWAY`. */
  beginHostAwayResumeCountdown(world?: CoopWorldAdapter): void {
    if (!this.isHost || !this.hostAway) return;
    const w = world ?? this.activeWorld;
    this.hostAway = false;
    this.resumeCountdownSec = COOP_RESUME_COUNTDOWN_SEC;
    if (w) {
      this.client.sendEvent({
        kind: 'wave-sync',
        wave: w.wave,
        score: w.score,
        freed: w.freed,
        values: [COOP_HOST_AWAY_MAGIC, 2, Math.round(COOP_RESUME_COUNTDOWN_SEC * 10)],
      });
    }
    this.onStatus?.('Welcome back. Resuming squad flight in 3 seconds.');
  }

  /** Cancel any pending `HOST AWAY` / `3-2-1` state when manually resumed. */
  cancelHostAwayCountdown(world?: CoopWorldAdapter): void {
    if (!this.hostAway && this.resumeCountdownSec <= 0) return;
    this.hostAway = false;
    this.resumeCountdownSec = 0;
    if (this.isHost) {
      const w = world ?? this.activeWorld;
      if (w) {
        this.client.sendEvent({
          kind: 'wave-sync',
          wave: w.wave,
          score: w.score,
          freed: w.freed,
          values: [COOP_HOST_AWAY_MAGIC, 0, 0],
        });
      }
    }
  }

  /**
   * Tick paused timers (such as the `3-2-1` `HOST AWAY` resume countdown).
   * Returns `true` on Host when the countdown reaches `0` and `Game` should unpause.
   */
  tickPaused(dt: number, world?: CoopWorldAdapter): boolean {
    if (this.resumeCountdownSec <= 0) return false;
    const w = world ?? this.activeWorld;
    if (!this.isHost) {
      this.resumeCountdownSec = Math.max(0.05, this.resumeCountdownSec - dt);
      return false;
    }
    const before = Math.ceil(this.resumeCountdownSec);
    this.resumeCountdownSec = Math.max(0, this.resumeCountdownSec - dt);
    const after = Math.ceil(this.resumeCountdownSec);
    if (after > 0 && after < before) {
      w?.play('tick');
    }
    if (this.resumeCountdownSec <= 0) {
      if (w) {
        this.client.sendEvent({
          kind: 'wave-sync',
          wave: w.wave,
          score: w.score,
          freed: w.freed,
          values: [COOP_HOST_AWAY_MAGIC, 0, 0],
        });
      }
      return true;
    }
    return false;
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
    this.pickingHeldSec.fill(0);
    this.staleHeldSec.fill(0);
    this.pendingAnswer = null;
    for (let i = 0; i < 4; i++) this.resetGuestTiming(i as CoopSeatIndex);
    this.guestLocalBolts.length = 0;
    this.guestSendTimesMs.length = 0;
    this.guestSuppressedBullets.length = 0;
    this.quiz.clearActive();
    this.hostAway = false;
    this.resumeCountdownSec = 0;
    this.squadBreakActive = false;
    this.guestParked = false;
    this.hostBreak = null;
    this.hostSeatChallenge[0] = null;
    this.hostSeatChallenge[1] = null;
    this.hostSeatChallenge[2] = null;
    this.hostSeatChallenge[3] = null;
    this.downedAtSec.fill(-10);
    this.invalidatePredHistory();
    this.hasSentAnyInput = false;
    this.wasAliveOnWire = true;
    this.prevWireHull = 3;
    this.lastSentDiscreteMask = -1;
    this.lastSeenAckSeq = null;
    this.pendingAckErr = { dx: 0, dy: 0 };
    this.reconcileGraceSec = 0;
    this.guardCoolBySeat.fill(0);
    this.firedSinceLastSnap.fill(false);
    this.hasHostSeenSeq.fill(false);
    this.lastInputAtSec.fill(0);
    this.awaitingRespawnSync.fill(true);
    this.respawnSyncDeadlineSec.fill(this.elapsedSec + 0.9);
    this.hadAnyPilotInRun = this.pilots.some((p) => p.present);
    for (const p of this.pilots) {
      p.latestInput = null;
      p.answering = false;
      p.jamSec = 0;
      p.revives = 0;
      p.questionsRight = 0;
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
    while (this.recentFx.length > SNAP_MAX_FX) {
      this.recentFx.shift();
    }
  }

  /** Broadcast a wave transition + save Host `sessionStorage` continuity state. */
  notifyHostWaveStart(wave: number, score: number, freed: number): void {
    if (!this.isHost) return;
    this.saveHostProgress(wave, score, freed);
    this.client.sendEvent({ kind: 'wave-sync', wave, score, freed });
  }

  /**
   * Park the squad between waves (`Wave 2+`) and open a per-device Pre-Wave Squad Break
   * at each pilot's own in-memory `GradeBand`.
   */
  beginSquadWaveBreak(nextWave: number, world: CoopWorldAdapter): void {
    if (!this.isHost || world.gameOver || this.squadBreakActive) return;
    const presentPilots = this.pilots.filter((p) => p.present);
    if (presentPilots.length === 0) {
      world.startWave?.(nextWave);
      return;
    }

    // The squad parks at once, so the wave stops (and no boss comes back). A pilot still answering a question or
    // choosing an upgrade keeps it; their break card opens when it closes (releaseWaitingBreakCards).
    const waiting = new Set<CoopSeatIndex>();
    for (const p of this.pilots) {
      p.firing = false;
      if (p.present && this.hostSeatChallenge[p.seat]) {
        waiting.add(p.seat);
      } else {
        p.answering = false;
        this.pickingHeldSec[p.seat] = 0;
        this.staleHeldSec[p.seat] = 0;
      }
    }

    world.shots.length = 0;
    world.rockets.length = 0;
    world.beams.length = 0;
    world.pickups.length = 0;
    world.mines.length = 0;

    this.squadBreakActive = true;
    world.parked = true;
    this.hostBreak = {
      id: this.allocateChallengeIds(1),
      nextWave,
      answered: new Map(),
      waiting,
      expiresAtSec: waiting.size > 0 ? Infinity : this.elapsedSec + coopBreakWindowSec(nextWave),
    };
    for (const p of presentPilots) {
      if (!waiting.has(p.seat)) this.openBreakCard(p.seat, world);
    }
    this.broadcastSnapshotNow(world);
  }

  /** Host: show the squad break's card on one pilot's screen. */
  private openBreakCard(seat: CoopSeatIndex, world: CoopWorldAdapter): void {
    const brk = this.hostBreak;
    if (!brk) return;
    if (seat === this.client.seat) {
      this.quiz.openChallenge(brk.id, 'break', brk.nextWave, this.layout.useThumbDeck, this.quizHooks(world));
    } else {
      this.client.sendEvent({
        kind: 'challenge',
        to: seat,
        id: brk.id,
        wave: brk.nextWave,
        values: [encodeStakeCode('break')],
      });
    }
  }

  /** Host: a pilot whose question was still open when the break began gets their break card once it closes. */
  private releaseWaitingBreakCards(world: CoopWorldAdapter): void {
    const brk = this.hostBreak;
    if (!brk || brk.waiting.size === 0) return;
    for (const seat of [...brk.waiting]) {
      if (this.hostSeatChallenge[seat]) continue;
      brk.waiting.delete(seat);
      this.pickingHeldSec[seat] = 0;
      this.staleHeldSec[seat] = 0;
      if (this.pilots[seat].present) this.openBreakCard(seat, world);
    }
    if (brk.waiting.size === 0) {
      brk.expiresAtSec = this.elapsedSec + coopBreakWindowSec(brk.nextWave);
      this.broadcastSnapshotNow(world);
    }
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
      bitmap: packBrokenRockWords(brokenIds),
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

    if (world.gameOver) {
      this.quiz.clearActive();
      this.lastQuizWallMs = null;
    } else if (!world.paused && !this.hostReconnecting && this.client.seat >= 0) {
      this.quiz.step(this.quizStepSec(realDt), this.layout.useThumbDeck, this.isSquadParked, this.quizHooks(world));
    } else {
      this.lastQuizWallMs = null;
    }

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
    this.mirrorGuestLeads(snap);
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
        if (this.guardCoolBySeat[p.seat]! <= 0) {
          const rammed = world.enemies.find(
            (e) => !e.dead && Math.hypot(e.x - gx, e.y - gy) < (KINDS[e.kind].radius + 8) * scale,
          );
          if (rammed) {
            this.guardCoolBySeat[p.seat] = 0.3;
            rammed.hp -= 2;
            rammed.flash = 0.1;
            if (rammed.hp <= 0) {
              world.destroyEnemy(rammed);
              this.recordHostFx('enemy-burst', rammed.x, rammed.y, KINDS[rammed.kind].color, { enemyKind: rammed.kind });
            } else {
              world.play('hit');
              this.recordHostFx('spark', gx, gy, NEON.cyan);
            }
          }
        }
      }
    }

    // Shots (both hostile against squad ships, and squad bolts against Boss, mines, rocks, and enemies)
    for (const s of world.shots) {
      if (s.dead) continue;
      if (s.hostile) {
        for (const p of this.pilots) {
          if (!p.present || !p.connected || !p.alive || p.invulnerable > 0 || p.answering) continue;
          const hp = this.hostPilotHitPos(p);
          if (Math.hypot(s.x - hp.x, s.y - hp.y) < shipRadius + 3) {
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

    // Body collisions, rescue-pod revives, pickups, and mines for each living connected pilot
    const pickupReach = (13 + 9) * scale;
    const mineReach = (10 + 9) * scale;
    for (const p of this.pilots) {
      if (!p.present || !p.connected || !p.alive) continue;

      if (!p.answering) {
        for (const other of this.pilots) {
          if (
            other.seat === p.seat ||
            !other.present ||
            !other.connected ||
            other.alive ||
            other.respawnSec <= 0 ||
            this.elapsedSec - this.downedAtSec[other.seat]! < 0.35
          ) {
            continue;
          }
          if (Math.hypot(other.x - p.x, other.y - p.y) <= COOP_WRECK_REVIVE_RADIUS * scale) {
            this.reviveSingleWingman(
              other,
              p.seat,
              clampArenaShipX(other.x),
              clampArenaShipY(other.y),
              world,
              scale,
            );
            world.score += 150;
          }
        }

        for (const item of world.pickups) {
          if (item.dead || Math.hypot(item.x - p.x, item.y - p.y) >= pickupReach) continue;
          // A capsule is only used up when its question opens.
          if (this.startHostPilotChallenge(p, item.reward, world, scale)) item.dead = true;
          break;
        }
      }

      if (p.invulnerable > 0 || p.answering) continue;

      for (const m of world.mines) {
        if (m.dead || Math.hypot(m.x - p.x, m.y - p.y) >= mineReach) continue;
        if (!this.startHostPilotChallenge(p, 'defuse', world, scale)) break;
        m.dead = true;
        world.spark(m.x, m.y, NEON.red);
        this.recordHostFx('spark', m.x, m.y, NEON.red);
        break;
      }
      if (!p.alive || p.invulnerable > 0 || p.answering) continue;

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
        const wasDead = rock.dead;
        world.sets.scrape(rock, world.setEnv());
        if (!wasDead && rock.dead) {
          this.recordHostFx('rock-break', rock.x, (world.sets.field?.front ?? 0) - rock.d, rock.tough ? ROCK : PEBBLE, {
            toughRock: rock.tough,
          });
        } else {
          this.recordHostFx('spark', p.x, p.y, rock.tough ? ROCK : PEBBLE);
        }
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
    const isGameOver = Boolean(this.activeWorld?.gameOver);
    const hasLivingRescuer = this.pilots.some((o) => o.present && o.connected && o.alive);
    const drawnWrecks: Array<{ x: number; y: number }> = [];

    for (const p of this.pilots) {
      if (!p.present) continue;
      const isLocal = p.seat === this.client.seat;

      if (!p.alive) {
        if (!isGameOver && p.connected && p.respawnSec > 0) {
          let stackIdx = 0;
          for (const prev of drawnWrecks) {
            if (Math.abs(prev.x - p.x) < 84 && Math.abs(prev.y - p.y) < 22) {
              stackIdx += 1;
            }
          }
          drawnWrecks.push({ x: p.x, y: p.y });
          if (hasLivingRescuer) {
            const podR = (COOP_WRECK_REVIVE_RADIUS - 6 + 2 * Math.sin(time * 5 + p.seat)) * scale;
            ink(NEON.lime, 0.34 + 0.14 * Math.sin(time * 5 + p.seat), 1.1, () => {
              ctx.moveTo(p.x + podR, p.y);
              ctx.arc(p.x, p.y, podR, 0, Math.PI * 2);
            }, false);
          }
          const ghostAlpha = 0.25 + 0.12 * Math.sin(time * 6);
          ink(p.color, ghostAlpha, 1.2, () => {
            trace(ctx, SHIP, p.x, p.y, shipScale * 0.85, 0);
            traceText(ctx, `REBOOT ${Math.ceil(p.respawnSec)} SEC`, p.x, p.y + (22 + 10 * stackIdx) * scale, 7, 'center');
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
      ink(p.answering ? NEON.yellow : p.color, p.connected ? 0.86 : 0.45, 1.1, () => {
        const label = !p.connected
          ? `P${p.seat + 1} OFFLINE`
          : p.answering
            ? `P${p.seat + 1} QUIZ`
            : `P${p.seat + 1} ${p.callsign}`;
        traceText(ctx, label, p.x, p.y + 24 * shipScale, 6.5, 'center');
      }, false);

      if (p.answering) {
        const pulseR = (25 + 2.2 * Math.sin(time * 7 + p.seat)) * shipScale;
        ink(NEON.yellow, 0.78 + 0.18 * Math.sin(time * 7 + p.seat), 1.6, () => {
          ctx.moveTo(p.x + pulseR, p.y);
          ctx.arc(p.x, p.y, pulseR, 0, Math.PI * 2);
          ctx.moveTo(p.x + pulseR * 0.82, p.y);
          ctx.arc(p.x, p.y, pulseR * 0.82, 0, Math.PI * 2);
        });
      }

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
   * - Resilience banners (`HOST RECONNECTING` / `HOST AWAY` / `PAUSED BY HOST`)
   */
  renderViewportChrome(ctx: CanvasRenderingContext2D, ink: Ink, _time: number): void {
    const { arenaRect, viewportW, useThumbDeck } = this.layout;

    // 1. Crisp neon border framing the shared 3:4 arena when letterboxed or above the thumb deck
    ink(NEON.cyan, 0.34, 1.3, () => {
      ctx.rect(arenaRect.x + 0.5, arenaRect.y + 0.5, arenaRect.w - 1, arenaRect.h - 1);
    }, false);

    // 2. Squad wingman roster rail (left pillar on widescreen, or compact top bar inside arena on narrow screens)
    const activePilots = this.pilots.filter((p) => p.present);
    const isGameOver = Boolean(this.activeWorld?.gameOver);
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
            ? isGameOver
              ? 'HULL DOWN'
              : `REBOOT ${Math.ceil(p.respawnSec)} SEC`
            : p.answering
              ? 'IN QUIZ'
              : `HULL ${p.hull}/${p.maxHull}`;
        ink(p.answering && p.connected && p.alive ? NEON.yellow : p.color, p.connected ? 0.92 : 0.45, 1.3, () => {
          traceText(ctx, `P${p.seat + 1} ${p.callsign}`, rx, ry, 7.5, 'left');
          traceText(ctx, status, rx, ry + 11, 6.5, 'left');
        }, false);
        ry += 30;
      }
    } else if (!useThumbDeck && activePilots.length > 1) {
      const sc = this.layout.arenaScale;
      const slotW = Math.min(86 * sc, (arenaRect.w * 0.46) / activePilots.length);
      const topY = arenaRect.y + 108 * sc;
      const fontSize = Math.max(5.5, 6.2 * sc);
      activePilots.forEach((p, idx) => {
        const cx = arenaRect.x + 12 * sc + slotW * (idx + 0.5);
        const tag = !p.connected
          ? `P${p.seat + 1} WAIT`
          : !p.alive
            ? `P${p.seat + 1} OUT`
            : p.answering
              ? `P${p.seat + 1} QUIZ`
              : `P${p.seat + 1} ${p.hull}HP`;
        ink(p.answering && p.connected && p.alive ? NEON.yellow : p.color, p.connected ? 0.85 : 0.45, 1.15, () => {
          traceText(ctx, tag, cx, topY, fontSize, 'center');
        }, false);
      });
    }

    // 3. Portrait-phone Bottom 38% Thumb Steering Deck
    if (useThumbDeck && this.client.seat >= 0) {
      const me = this.pilots[this.client.seat as CoopSeatIndex];
      const isPaused = Boolean(this.activeWorld?.paused);
      const wingmen = activePilots
        .filter((p) => p.seat !== me.seat)
        .map((p) => ({
          seat: p.seat,
          callsign: p.callsign,
          color: p.color,
          hull: p.hull,
          maxHull: p.maxHull,
          alive: p.alive,
          connected: p.connected,
          respawnSec: p.respawnSec,
          answering: p.answering,
        }));
      this.deck.render(ctx, this.layout, {
        seat: me.seat,
        callsign: me.callsign,
        hull: me.hull,
        maxHull: me.maxHull,
        alive: me.alive,
        respawnSec: me.respawnSec,
        answering: me.answering,
        gameOver: isGameOver,
        wingmen,
        card: isGameOver || isPaused ? null : this.quiz.deckCard(true),
      });
    }

    // 4. Resilience banners (`THIS GAME WAS UPDATED` / `HOST GAME IS OUT OF DATE`, `HOST RECONNECTING`, `RESUMING IN 3..1`, `HOST AWAY`, or `PAUSED BY HOST`)
    if (this.versionMismatch) {
      const bx = arenaRect.x + arenaRect.w / 2;
      const by = arenaRect.y + arenaRect.h * 0.44;
      const bw = Math.min(arenaRect.w - 24, 356);
      const topLine = this.versionMismatchDir === 'older' ? 'HOST GAME IS OUT OF DATE' : 'THIS GAME WAS UPDATED';
      const botLine = this.versionMismatchDir === 'older' ? 'ASK THE HOST TO REFRESH' : 'REFRESH TO REJOIN';
      ctx.fillStyle = 'rgba(3, 7, 26, 0.88)';
      ctx.fillRect(bx - bw / 2, by - 28, bw, 58);
      ink(NEON.red, 0.95, 1.6, () => {
        ctx.rect(bx - bw / 2, by - 28, bw, 58);
        traceText(ctx, topLine, bx, by - 14, 9.5, 'center');
        traceText(ctx, botLine, bx, by + 6, 8, 'center');
      });
    } else if (this.hostReconnecting) {
      const secLeft = Math.max(0, Math.ceil((this.hostReconnectDeadlineMs - this.nowFn()) / 1000));
      const bx = arenaRect.x + arenaRect.w / 2;
      const by = arenaRect.y + arenaRect.h * 0.44;
      const bw = Math.min(arenaRect.w - 24, 340);
      ctx.fillStyle = 'rgba(3, 7, 26, 0.84)';
      ctx.fillRect(bx - bw / 2, by - 28, bw, 58);
      ink(NEON.yellow, 0.95, 1.6, () => {
        ctx.rect(bx - bw / 2, by - 28, bw, 58);
        traceText(ctx, 'HOST RECONNECTING', bx, by - 14, 10, 'center');
        traceText(ctx, `HOLDING FORMATION - ${secLeft} SEC`, bx, by + 6, 7.5, 'center');
      });
    } else if (this.resumeCountdownSec > 0) {
      const countNum = Math.max(1, Math.ceil(this.resumeCountdownSec));
      const bx = arenaRect.x + arenaRect.w / 2;
      const by = arenaRect.y + arenaRect.h * 0.44;
      const bw = Math.min(arenaRect.w - 24, 300);
      ctx.fillStyle = 'rgba(3, 7, 26, 0.85)';
      ctx.fillRect(bx - bw / 2, by - 28, bw, 58);
      ink(NEON.lime, 0.95, 1.7, () => {
        ctx.rect(bx - bw / 2, by - 28, bw, 58);
        traceText(ctx, `RESUMING IN ${countNum}`, bx, by - 14, 11, 'center');
        traceText(ctx, 'HANDS ON CONTROLS, SQUAD', bx, by + 7, 7.5, 'center');
      });
    } else if (!this.isHost && this.hostPaused) {
      const bx = arenaRect.x + arenaRect.w / 2;
      const by = arenaRect.y + arenaRect.h * 0.44;
      if (this.hostAway) {
        const bw = Math.min(arenaRect.w - 24, 320);
        ctx.fillStyle = 'rgba(3, 7, 26, 0.85)';
        ctx.fillRect(bx - bw / 2, by - 28, bw, 58);
        ink(NEON.yellow, 0.95, 1.6, () => {
          ctx.rect(bx - bw / 2, by - 28, bw, 58);
          traceText(ctx, 'HOST AWAY', bx, by - 14, 11, 'center');
          traceText(ctx, 'PAUSED UNTIL HOST RETURNS', bx, by + 7, 7.5, 'center');
        });
      } else {
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
  }

  // ------------------------------------------------------------------ internals

  private applySeatRoster(seats: readonly CoopPublicSeat[], initial: boolean): void {
    if (seats.length > 0) {
      this.hadAnyPilotInRun = true;
    }
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

  private invalidatePredHistory(): void {
    for (const entry of this.predHistory) {
      entry.valid = false;
    }
  }

  private closestPredictedPointSinceAck(
    ackSeq: number,
    curX: number,
    curY: number,
    authX: number,
    authY: number,
  ): { x: number; y: number } {
    const pts: Array<{ x: number; y: number }> = [];
    const prevSeq = (ackSeq - 1) & 0xff;
    const prev = this.predHistory[prevSeq];
    if (prev && prev.valid && prev.seq === prevSeq) {
      pts.push({ x: prev.x, y: prev.y });
    }
    const first = this.predHistory[ackSeq & 0xff]!;
    pts.push({ x: first.x, y: first.y });
    const inFlight = (this.inputSeq - ackSeq + 256) & 0xff;
    const steps = Math.min(inFlight, 3);
    for (let k = 1; k <= steps; k++) {
      const seq = (ackSeq + k) & 0xff;
      const entry = this.predHistory[seq];
      if (entry && entry.valid && entry.seq === seq) {
        pts.push({ x: entry.x, y: entry.y });
      }
    }
    if (inFlight <= 3) {
      pts.push({ x: curX, y: curY });
    }
    if (pts.length === 1) return pts[0]!;

    let bestX = pts[0]!.x;
    let bestY = pts[0]!.y;
    let bestDistSq = (authX - bestX) ** 2 + (authY - bestY) ** 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby;
      let t = 0;
      if (lenSq > 1e-6) {
        t = clamp(((authX - a.x) * abx + (authY - a.y) * aby) / lenSq, 0, 1);
      }
      const cx = a.x + abx * t;
      const cy = a.y + aby * t;
      const dSq = (authX - cx) ** 2 + (authY - cy) ** 2;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestX = cx;
        bestY = cy;
      }
    }
    return { x: bestX, y: bestY };
  }

  private hostPilotHitPos(p: CoopPilotShip): { x: number; y: number } {
    return { x: p.x, y: p.y };
  }

  private checkAllConnectedPilotsDown(world: CoopWorldAdapter): boolean {
    if (!this.isHost || world.gameOver) return false;
    const anyPresent = this.pilots.some((p) => p.present);
    if (!anyPresent && !this.hadAnyPilotInRun) return false;
    // End the run when no PRESENT pilot is alive (including TV mode when the last guest leaves or is pruned at 30s).
    const anyPresentAlive = this.pilots.some((p) => p.present && p.alive);
    if (!anyPresentAlive) {
      this.endSquadMission(world);
      return true;
    }
    return false;
  }

  private handleLobbyUpdate(lobby: CoopLobbyState): void {
    const reconnectedGuests: CoopSeatIndex[] = [];
    for (const s of lobby.seats) {
      const prevConnected = this.wasSeatConnected[s.seat];
      if (!prevConnected && s.connected && !s.isHost) {
        reconnectedGuests.push(s.seat);
        this.hasHostSeenSeq[s.seat] = false;
        this.resetGuestTiming(s.seat);
      }
      this.wasSeatConnected[s.seat] = s.connected;
    }
    for (let i = 0; i < 4; i++) {
      const seat = i as CoopSeatIndex;
      if (!lobby.seats.some((s) => s.seat === seat)) {
        this.wasSeatConnected[seat] = false;
        this.hasHostSeenSeq[seat] = false;
        this.resetGuestTiming(seat);
      }
    }

    this.applySeatRoster(lobby.seats, false);

    // 3.4: If the last living pilot disconnected or left while squadmates were rebooting, end the run immediately
    if (this.isHost && this.activeWorld && this.checkAllConnectedPilotsDown(this.activeWorld)) {
      this.broadcastSnapshotNow(this.activeWorld);
    }

    // Round 9 #3 + Round 12 3.3 + Phase 3: Targeted reconnect resync (`to: seat`) so a rejoining Guest immediately
    // regains wave context, HOST AWAY / countdown state, seeded asteroid belt, active tanker, and any open prompt.
    if (this.isHost && this.activeWorld && reconnectedGuests.length > 0) {
      const w = this.activeWorld;
      const hostAwayValues = this.hostAway
        ? [COOP_HOST_AWAY_MAGIC, 1, 0]
        : this.resumeCountdownSec > 0
          ? [COOP_HOST_AWAY_MAGIC, 2, Math.max(1, Math.round(this.resumeCountdownSec * 10))]
          : undefined;

      for (const seat of reconnectedGuests) {
        this.client.sendEvent({
          kind: 'wave-sync',
          to: seat,
          wave: w.wave,
          score: w.score,
          freed: w.freed,
          ...(hostAwayValues ? { values: hostAwayValues } : {}),
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
            bitmap: packBrokenRockWords(w.sets.brokenRockIds),
          });
        }
        if (w.sets.tanker !== null && w.sets.tanker.state !== 'gone') {
          this.client.sendEvent({
            kind: 'tanker-start',
            to: seat,
            wave: w.wave,
          });
        }
        this.resendOpenPrompt(seat);
        if (w.gameOver) {
          this.client.sendEvent({
            kind: 'mission-ended',
            to: seat,
            wave: w.wave,
            score: w.score,
            freed: w.freed,
            values: [
              this.pilots[0].revives,
              this.pilots[1].revives,
              this.pilots[2].revives,
              this.pilots[3].revives,
              this.pilots[0].questionsRight,
              this.pilots[1].questionsRight,
              this.pilots[2].questionsRight,
              this.pilots[3].questionsRight,
            ],
          });
        }
      }
      this.client.sendHostPaused(Boolean(w.paused));
      this.broadcastSnapshotNow(w);
    }
  }

  private handleBinaryFrame(bytes: Uint8Array): void {
    if (this.isHost) {
      const input = decodeGuestInput(bytes);
      if (!input) return;
      const pilot = this.pilots[input.seat];
      if (!pilot.present || pilot.seat === this.client.seat) return;
      if (input.tap) {
        if (!this.hasHostSeenSeq[pilot.seat]!) {
          pilot.ackSeq = input.seq;
          this.hasHostSeenSeq[pilot.seat] = true;
          this.ackSendFull[pilot.seat] = this.senderTimeOf(pilot.seat, input);
        } else {
          const fwd = (input.seq - pilot.ackSeq + 256) & 0xff;
          if (fwd < 128) {
            pilot.ackSeq = input.seq;
            this.ackSendFull[pilot.seat] = this.senderTimeOf(pilot.seat, input);
          }
        }
        const queue = this.tapQueue[pilot.seat]!;
        queue.push({ x: clamp(input.targetX, 0, COOP_WORLD_W), y: clamp(input.targetY, 0, COOP_WORLD_H) });
        if (queue.length > 8) queue.shift();
        if (pilot.latestInput) {
          pilot.latestInput = { ...pilot.latestInput, firing: input.firing, seq: pilot.ackSeq };
        }
        return;
      }

      if (this.hasHostSeenSeq[pilot.seat]!) {
        const back = (pilot.ackSeq - input.seq + 256) & 0xff;
        if (back > 0 && back <= 64 && this.elapsedSec - this.lastInputAtSec[pilot.seat]! < 0.5) {
          return;
        }
      }
      this.hasHostSeenSeq[pilot.seat] = true;
      pilot.ackSeq = input.seq;

      const tx = clampArenaShipX(input.targetX);
      const ty = clampArenaShipY(input.targetY);
      if (this.awaitingRespawnSync[pilot.seat]!) {
        if (
          this.elapsedSec >= this.respawnSyncDeadlineSec[pilot.seat]! ||
          Math.hypot(tx - pilot.x, ty - pilot.y) <= 48
        ) {
          this.awaitingRespawnSync[pilot.seat] = false;
        }
      }

      this.lastInputAtSec[pilot.seat] = this.elapsedSec;
      pilot.latestInput = input;
      this.recordGuestSample(pilot.seat, input, tx, ty);
      this.ackSendFull[pilot.seat] = this.senderTimeOf(pilot.seat, input);
      return;
    }

    const snap = decodeWorldSnapshot(bytes);
    if (!snap) {
      const mismatch = getSnapshotVersionMismatch(bytes);
      if (mismatch !== null || isSnapshotVersionMismatch(bytes)) {
        const dir = mismatch ?? 'newer';
        this.versionMismatchDir = dir;
        const msg =
          dir === 'older'
            ? "The host's game is out of date. Ask the host to refresh."
            : 'This game was updated. Refresh to rejoin.';
        if (!this.versionMismatch) {
          this.versionMismatch = true;
          this.onStatus?.(msg);
        }
        this.mismatchCount += 1;
        if (this.mismatchCount === 2 && this.interpolator.latest() === null) {
          this.onVersionMismatch?.(msg);
        }
      }
      return;
    }
    if (this.versionMismatch || this.mismatchCount > 0) {
      this.versionMismatch = false;
      this.mismatchCount = 0;
    }
    const nowMs = this.nowFn();
    const accepted = this.interpolator.push(snap, nowMs);
    if (!accepted) return;
    if (!this.isHost && typeof snap.session === 'number' && snap.session > 0) {
      if (this.lastHostSession !== null && snap.session !== this.lastHostSession) {
        // A reloaded host numbers its questions afresh: answers to the old page's questions mean nothing now.
        this.quiz.clearActive(true);
        this.guestAnswerCache.clear();
      }
      this.lastHostSession = snap.session;
    }
    if (snap.hostElapsedMs !== undefined && Number.isFinite(snap.hostElapsedMs) && this.client.seat >= 0) {
      const wireMe = snap.ships.find((sh) => sh.seat === this.client.seat);
      if (wireMe) {
        const hist = this.predHistory[wireMe.ackSeq & 0xff];
        // During an upstream stall every snapshot repeats the same ack while host time runs on; feeding those
        // would inflate the lead and make bullets surge. Calibrate once per newly acknowledged input.
        if (
          wireMe.ackSeq !== this.lastCalibAckSeq &&
          hist &&
          hist.valid &&
          hist.seq === wireMe.ackSeq &&
          Number.isFinite(hist.sentAtMs)
        ) {
          this.lastCalibAckSeq = wireMe.ackSeq;
          // The host mirrors this same average (mirrorGuestLeads) to place our ship, so both screens agree on hits.
          this.interpolator.setAckHostOffset(snap.hostElapsedMs - hist.sentAtMs);
        }
      }
    }
    if (this.hostReconnecting) {
      this.hostReconnecting = false;
      this.hostReconnectDeadlineMs = 0;
    }
    if (snap.paused !== this.hostPaused || (this.activeWorld && snap.paused !== this.activeWorld.paused)) {
      this.hostPaused = snap.paused;
      if (!snap.paused) {
        this.hostAway = false;
        this.resumeCountdownSec = 0;
      }
      this.activeWorld?.setHostPausedFromWire?.(snap.paused);
    }
  }

  private handleHostEvent(msg: CoopEventMessage): void {
    if (this.isHost) return;
    if (typeof msg.to === 'number' && msg.to !== this.client.seat) return;
    const w = this.activeWorld;
    if (!w) return;

    if (msg.kind === 'wave-sync') {
      if (typeof msg.wave === 'number' && Number.isFinite(msg.wave) && msg.wave >= 1 && msg.wave !== w.wave) {
        w.wave = msg.wave;
        w.banner = 2.0;
      }
      if (typeof msg.score === 'number' && Number.isFinite(msg.score)) w.score = msg.score;
      if (typeof msg.freed === 'number' && Number.isFinite(msg.freed)) w.freed = msg.freed;
      if (Array.isArray(msg.values) && msg.values[0] === COOP_HOST_AWAY_MAGIC) {
        const mode = msg.values[1];
        if (mode === 1) {
          this.hostAway = true;
          this.resumeCountdownSec = 0;
        } else if (mode === 2) {
          this.hostAway = false;
          const tenths =
            typeof msg.values[2] === 'number' && Number.isFinite(msg.values[2])
              ? clamp(msg.values[2], 1, 90)
              : Math.round(COOP_RESUME_COUNTDOWN_SEC * 10);
          this.resumeCountdownSec = tenths / 10;
        } else if (mode === 0) {
          this.hostAway = false;
          this.resumeCountdownSec = 0;
        }
      }
    } else if (msg.kind === 'asteroid-field' && typeof msg.seed === 'number') {
      const brokenIds = Array.isArray(msg.bitmap)
        ? unpackBrokenRockWords(msg.bitmap)
        : Array.isArray(msg.values)
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
    } else if (msg.kind === 'challenge') {
      if (this.client.seat < 0) return;
      const rawCode = Array.isArray(msg.values) && typeof msg.values[0] === 'number' ? msg.values[0] : undefined;
      const stakeKind = decodeStakeCode(rawCode);
      if (stakeKind && typeof msg.id === 'number' && Number.isInteger(msg.id) && msg.id > 0) {
        const safeWave =
          typeof msg.wave === 'number' && Number.isFinite(msg.wave)
            ? clamp(Math.round(msg.wave), 1, 99)
            : clamp(Math.round(w.wave || 1), 1, 99);
        const opened = this.quiz.openChallenge(msg.id, stakeKind, safeWave, this.layout.useThumbDeck, this.quizHooks(w));
        const left = msg.values?.[1];
        if (typeof left === 'number' && Number.isFinite(left)) this.quiz.limitClock(msg.id, left / 10);
        if (opened) {
          this.pendingAnswer = null;
        } else {
          // The host asked again for a question this pilot already answered: its answer was lost, so send it again.
          this.resendCachedAnswer(msg.id);
        }
      }
    } else if (msg.kind === 'upgrade-offer') {
      if (this.client.seat < 0) return;
      if (typeof msg.id === 'number' && Number.isInteger(msg.id) && msg.id > 0 && Array.isArray(msg.values)) {
        const indices = msg.values.filter(
          (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < UPGRADES.length,
        );
        const opened = this.quiz.openUpgradeOffer(msg.id, indices, this.quizHooks(w));
        if (opened) this.pendingAnswer = null;
        else this.resendCachedAnswer(msg.id);
      }
    } else if (msg.kind === 'challenge-closed') {
      if (this.client.seat < 0) return;
      if (typeof msg.id === 'number' && Number.isInteger(msg.id) && msg.id > 0 && Array.isArray(msg.values)) {
        const code = typeof msg.values[0] === 'number' ? msg.values[0] : CLOSE_CANCELLED;
        const extra = typeof msg.values[1] === 'number' && Number.isInteger(msg.values[1]) ? msg.values[1] : null;
        const pa = this.pendingAnswer;
        if (pa && msg.id <= pa.answerId && pa.answerId < msg.id + 4) this.pendingAnswer = null;
        this.quiz.hostClosed(msg.id, code, extra, this.layout.useThumbDeck, this.quizHooks(w));
      }
    } else if (msg.kind === 'revive') {
      if (typeof msg.seat === 'number' && Number.isInteger(msg.seat) && msg.seat >= 0 && msg.seat <= 3) {
        const revived = this.pilots[msg.seat as CoopSeatIndex];
        w.ring(revived.x, revived.y, NEON.lime, 105);
        w.play('shieldUp');
      }
    } else if (msg.kind === 'mission-ended') {
      if (typeof msg.wave === 'number' && Number.isFinite(msg.wave) && msg.wave >= 1) {
        w.wave = Math.round(msg.wave);
      }
      if (typeof msg.score === 'number' && Number.isFinite(msg.score)) {
        w.score = Math.max(0, Math.round(msg.score));
      }
      if (typeof msg.freed === 'number' && Number.isFinite(msg.freed)) {
        w.freed = Math.max(0, Math.round(msg.freed));
      }
      if (Array.isArray(msg.values) && msg.values.length >= 8) {
        for (let i = 0; i < 4; i++) {
          const r = msg.values[i];
          const q = msg.values[i + 4];
          if (typeof r === 'number' && Number.isFinite(r) && r >= 0) this.pilots[i]!.revives = Math.round(r);
          if (typeof q === 'number' && Number.isFinite(q) && q >= 0) this.pilots[i]!.questionsRight = Math.round(q);
        }
      }
      this.quiz.clearActive();
      if (!w.gameOver) {
        w.triggerSquadGameOver();
      }
    }
  }

  private stepHostSquad(
    simDt: number,
    realDt: number,
    world: CoopWorldAdapter,
    localCtrl: CoopLocalControlInput,
  ): void {
    this.hostSimElapsedMs += realDt * 1000;
    if (!this.sentInitialPause) {
      this.sentInitialPause = true;
      this.client.sendHostPaused(Boolean(world.paused));
    }

    if (!world.gameOver && this.checkAllConnectedPilotsDown(world)) {
      this.broadcastSnapshotNow(world);
      return;
    }

    const linkUp = this.client.isConnected;
    if (linkUp && !this.hostLinkUp) {
      // The host's own link came back: anything sent while it was down may be lost, so ask again.
      for (let i = 0; i < 4; i++) this.resendOpenPrompt(i as CoopSeatIndex);
    }
    this.hostLinkUp = linkUp;

    if (!world.gameOver && !world.paused) {
      this.holdQuestionClocks(simDt, world);
      this.checkHostQuizTimeouts(world);
      if (world.gameOver) {
        this.broadcastSnapshotNow(world);
        return;
      }
      this.releaseWaitingBreakCards(world);
    }

    const anyOtherLiving = this.pilots.some((p) => p.present && p.alive);
    const tankerHooked = Boolean(world.sets.tanker?.hooked);
    const squadParked = world.parked || this.squadBreakActive;

    for (const p of this.pilots) {
      if (!p.present) continue;

      if (!p.alive) {
        p.firing = false;
        p.answering = false;
        p.jamSec = 0;
        p.latestInput = null;
        this.tracks[p.seat]!.samples.length = 0;
        this.tapQueue[p.seat]!.length = 0;
        if (anyOtherLiving && !world.gameOver) {
          p.respawnSec = Math.max(0, p.respawnSec - simDt);
          if (p.respawnSec <= 0 && p.connected) {
            const spawn = formationSpawnForSeat(p.seat);
            p.x = spawn.x;
            p.y = spawn.y;
            p.lastX = spawn.x;
            p.hull = Math.max(2, p.maxHull - 1);
            p.alive = true;
            p.invulnerable = 2.4;
            this.awaitingRespawnSync[p.seat] = true;
            this.respawnSyncDeadlineSec[p.seat] = this.elapsedSec + 0.9;
            world.ring(p.x, p.y, p.color, 95);
            this.recordHostFx('ring', p.x, p.y, p.color);
            world.play('shieldUp');
          }
        }
        continue;
      }

      p.invulnerable = Math.max(0, p.invulnerable - simDt);
      p.cooldown = Math.max(0, p.cooldown - simDt);
      p.jamSec = Math.max(0, p.jamSec - simDt);
      this.guardCoolBySeat[p.seat] = Math.max(0, this.guardCoolBySeat[p.seat]! - simDt);
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
      const fireBlocked = squadParked || isHookedPilot || p.answering || p.jamSec > 0;

      if (p.seat !== this.client.seat && p.connected) {
        const queue = this.tapQueue[p.seat]!;
        while (queue.length > 0) {
          const tap = queue.shift()!;
          world.strikeBoss(tap.x, tap.y, true, true);
        }
      }

      if (this.squadBreakActive) {
        const home = formationSpawnForSeat(p.seat);
        const k = 1 - Math.exp(-simDt * 4);
        p.x = clampArenaShipX(p.x + (home.x - p.x) * k);
        p.y = clampArenaShipY(p.y + (home.y - p.y) * k);
        p.firing = false;
      } else if (p.seat === this.client.seat) {
        this.movePilotWithLocalControl(p, simDt, localCtrl);
        const deckState = this.deck.state();
        const keyFiring = localCtrl.firing && !localCtrl.touching;
        const wantsFire = this.layout.useThumbDeck ? deckState.firing || keyFiring : localCtrl.firing;
        p.firing = wantsFire && !fireBlocked;
      } else if (p.connected && p.latestInput) {
        const inp = p.latestInput;
        const age = Math.max(0, this.elapsedSec - this.lastInputAtSec[p.seat]!);
        const stale = age > COOP_STALE_INPUT_SEC;
        const ignoreRespawnTarget =
          this.awaitingRespawnSync[p.seat]! && this.elapsedSec < this.respawnSyncDeadlineSec[p.seat]!;
        if (!inp.tap) {
          let dx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
          let dy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
          if (dx && dy) {
            dx *= Math.SQRT1_2;
            dy *= Math.SQRT1_2;
          }
          if (ignoreRespawnTarget) {
            if (!stale && (dx || dy)) {
              p.x += dx * 380 * simDt;
              p.y += dy * 380 * simDt;
            }
          } else if (!stale && inp.hasPointer) {
            p.x += dx * 380 * simDt;
            p.y += dy * 380 * simDt;
            // Chase the newest reported position at the guest's own speed (from its send-timed reports), so the
            // ship glides between the 20-a-second reports instead of jumping to each one and waiting. It never
            // passes the reported position, so a stop is exact.
            const goalX = clampArenaShipX(inp.targetX);
            const goalY = clampArenaShipY(inp.targetY);
            const tx = goalX - p.x;
            const ty = goalY - p.y;
            const dist = Math.hypot(tx, ty);
            if (dist > 0.25) {
              const est = this.trackSpeed(p.seat);
              // About 100 ms of travel behind the newest report, so a report that is a little late does not
              // let the copy catch up and stop.
              const chase = clamp(est + Math.max(0, dist - est * 0.1) * 3, 30, FOLLOW_MAX_SPEED);
              const step = Math.min(dist, chase * simDt);
              p.x += (tx / dist) * step;
              p.y += (ty / dist) * step;
            }
          } else if (!stale && (dx || dy)) {
            p.x += dx * 380 * simDt;
            p.y += dy * 380 * simDt;
            // Projected from when the guest sent the input to the guest's own time for this host moment (see
            // trackProjAgeSec), and no further than the next report could be late. A release is never overrun far.
            const projAge = Math.min(this.trackProjAgeSec(p.seat) ?? age, this.trackLeadCapSec(p.seat));
            const goalX = clampArenaShipX(inp.targetX + dx * 380 * projAge);
            const goalY = clampArenaShipY(inp.targetY + dy * 380 * projAge);
            if (dx !== 0) {
              const dirX = Math.sign(dx);
              const leadX = (goalX - p.x) * dirX;
              if (leadX > 1) {
                // Behind (a late first report): close the gap within about a tenth of a second.
                p.x += dirX * Math.min(leadX - 1, clamp((leadX - 1) * 10, 30, 520) * simDt);
              } else if (leadX < 0) {
                // Ahead of the guest: slow down (never reverse while the key is held).
                p.x -= dirX * Math.min(-leadX, 380 * simDt);
              }
            } else {
              const errX = clampArenaShipX(inp.targetX) - p.x;
              if (Math.abs(errX) > 0.25) {
                p.x += Math.sign(errX) * Math.min(Math.abs(errX), 240 * simDt);
              }
            }
            if (dy !== 0) {
              const dirY = Math.sign(dy);
              const leadY = (goalY - p.y) * dirY;
              if (leadY > 1) {
                // Behind (a late first report): close the gap within about a tenth of a second.
                p.y += dirY * Math.min(leadY - 1, clamp((leadY - 1) * 10, 30, 520) * simDt);
              } else if (leadY < 0) {
                p.y -= dirY * Math.min(-leadY, 380 * simDt);
              }
            } else {
              const errY = clampArenaShipY(inp.targetY) - p.y;
              if (Math.abs(errY) > 0.25) {
                p.y += Math.sign(errY) * Math.min(Math.abs(errY), 240 * simDt);
              }
            }
          } else if (!inp.hasPointer && !dx && !dy) {
            // Stopped: settle onto the reported position with an ease-out, not a slide.
            const tx = clampArenaShipX(inp.targetX) - p.x;
            const ty = clampArenaShipY(inp.targetY) - p.y;
            const dist = Math.hypot(tx, ty);
            if (dist > 0.25) {
              const step = Math.min(dist, Math.min(380, dist * 7 + 25) * simDt);
              p.x += (tx / dist) * step;
              p.y += (ty / dist) * step;
            }
          }
          p.x = clampArenaShipX(p.x);
          p.y = clampArenaShipY(p.y);
        }
        p.firing = age <= 0.35 && inp.firing && !fireBlocked;
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
        this.firedSinceLastSnap[p.seat] = true;
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

    // 1. 0ms predicted local movement + immediate local cosmetic bolts + cannon audio feedback
    if (me.present && me.alive && !this.hostReconnecting && !this.hostPaused && !world.gameOver) {
      me.cooldown = Math.max(0, me.cooldown - simDt);
      me.jamSec = Math.max(0, me.jamSec - simDt);
      const parkedNow = this.guestParked;
      if (parkedNow) {
        const home = formationSpawnForSeat(mySeat);
        const k = 1 - Math.exp(-simDt * 4);
        me.x = clampArenaShipX(me.x + (home.x - me.x) * k);
        me.y = clampArenaShipY(me.y + (home.y - me.y) * k);
        if (this.layout.useThumbDeck) this.deck.syncTarget(me.x, me.y);
      } else {
        this.movePilotWithLocalControl(me, simDt, localCtrl);
      }
      const vx = (me.x - me.lastX) / Math.max(realDt, 0.001);
      me.lastX = me.x;
      me.lean += (clamp(vx / 380, -1, 1) - me.lean) * (1 - Math.exp(-realDt * 8));

      const isHooked = Boolean(world.sets.tanker?.hooked) && this.hookedSeat === mySeat;
      const deckState = this.deck.state();
      const keyFiring = localCtrl.firing && !localCtrl.touching;
      const wantsFire = this.layout.useThumbDeck ? deckState.firing || keyFiring : localCtrl.firing;
      const fireBlocked = parkedNow || isHooked || me.answering || me.jamSec > 0 || this.quiz.isInteractive();
      me.firing = wantsFire && !fireBlocked;
      if (me.firing && me.cooldown <= 0 && Number.isFinite(me.x) && Number.isFinite(me.y)) {
        me.cooldown = world.upgrades.has('rapid') ? 0.11 : 0.17;
        me.volley += 1;
        world.play('shot');
        fireVolley(
          this.guestLocalBolts,
          me.x,
          me.y,
          clamp(world.energy, 0, 1),
          me.volley,
          1,
          1,
          Boolean(world.boss),
          world.upgrades,
          me.color,
        );
      }
    } else {
      me.firing = false;
    }

    // 2. Send `0x01` `BIN_FRAME_INPUT` at 20 Hz. A key, fire or touch change goes out on the next frame instead, and
    // pushes the next regular send back a full interval, so the rate never passes 20 a second (plus pod taps).
    const nowMs = this.nowFn();
    while (this.guestSendTimesMs.length > 0 && nowMs - this.guestSendTimesMs[0]! >= 1000) {
      this.guestSendTimesMs.shift();
    }
    this.inputAccumSec = Math.min(this.inputAccumSec + realDt, COOP_INPUT_INTERVAL_SEC);
    const deckSt = this.deck.state();
    const hasPtrNow = this.layout.useThumbDeck ? deckSt.touching : localCtrl.touching;
    const discreteMask =
      (me.firing ? 1 : 0) |
      (hasPtrNow ? 2 : 0) |
      (localCtrl.across < 0 ? 4 : 0) |
      (localCtrl.across > 0 ? 8 : 0) |
      (localCtrl.down < 0 ? 16 : 0) |
      (localCtrl.down > 0 ? 32 : 0);
    const discreteChanged = discreteMask !== this.lastSentDiscreteMask;
    if (this.guestPendingTap !== null) {
      this.inputAccumSec = Math.min(this.inputAccumSec, 0.017);
      this.lastSentDiscreteMask = discreteMask;
      this.guestSendTimesMs.push(nowMs);
      this.sendGuestInputFrame(me, localCtrl, nowMs);
    } else if (
      this.guestSendTimesMs.length < 20 &&
      !this.upstreamStalledThrottle(nowMs) &&
      (this.inputAccumSec >= COOP_INPUT_INTERVAL_SEC || (discreteChanged && this.inputAccumSec >= 0.015))
    ) {
      this.inputAccumSec -= COOP_INPUT_INTERVAL_SEC;
      this.lastSentDiscreteMask = discreteMask;
      this.guestSendTimesMs.push(nowMs);
      this.sendGuestInputFrame(me, localCtrl, nowMs);
    }

    // 3. Sample 60fps Host-timeline interpolator to reconstruct world & reconcile local ship
    const sample = this.interpolator.sample(nowMs);
    const latestSnap = this.interpolator.latest();
    if (!sample) {
      this.stepGuestLocalBolts(simDt, world);
      world.shots = [...this.guestLocalBolts];
      return;
    }

    if (latestSnap && typeof latestSnap.upgradesMask === 'number') {
      world.upgrades.clear();
      for (const id of decodeUpgradesMask(latestSnap.upgradesMask)) {
        world.upgrades.add(id);
      }
    }

    const prevWave = world.wave;
    world.wave = sample.wave;
    if (sample.wave > prevWave && prevWave > 0) {
      world.play('wave');
    }
    world.banner = sample.banner;
    world.score = sample.teamScore;
    world.freed = sample.freed;
    world.energy = sample.energy;
    const isParkedNow = latestSnap ? latestSnap.parked : sample.parked;
    const isOverNow = latestSnap ? latestSnap.gameOver : sample.gameOver;
    if (this.guestParked && !isParkedNow) this.quiz.closeBreakCard();
    this.guestParked = isParkedNow;
    world.parked = isParkedNow;
    if (isOverNow && !world.gameOver) {
      this.quiz.clearActive();
      world.triggerSquadGameOver();
    } else if (!isOverNow && world.gameOver) {
      this.guestLocalBolts.length = 0;
      this.guestSuppressedBullets.length = 0;
      this.quiz.clearActive();
      this.guestParked = false;
      for (const p of this.pilots) {
        p.answering = false;
        p.jamSec = 0;
        p.revives = 0;
        p.questionsRight = 0;
      }
      this.invalidatePredHistory();
      this.hasSentAnyInput = false;
      this.prevWireHull = 3;
      world.resumeSquadNewRun?.();
    }

    const authMe = latestSnap?.ships.find((sh) => sh.seat === mySeat) ?? null;
    const seenSnapSeats = new Set<CoopSeatIndex>();

    for (const s of sample.ships) {
      seenSnapSeats.add(s.seat);
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
      if (s.seat === mySeat) {
        const wireAnswering = Boolean((authMe ?? s).answering);
        p.answering = s.alive && (wireAnswering || (!this.guestParked && this.quiz.isInteractive()));
        this.resendUnconfirmedAnswer(wireAnswering);
      } else {
        p.answering = s.alive && Boolean(s.answering);
      }
      if (latestSnap?.upgradesMask === undefined) {
        if (s.wing) world.upgrades.add('wingmates');
        if (s.orbitUpgrade) world.upgrades.add('guardian');
        if (s.spread) world.upgrades.add('wide');
      }

      if (s.seat === mySeat) {
        this.reconcileGraceSec = Math.max(0, this.reconcileGraceSec - realDt);
        const wireMe = authMe ?? s;
        const authX = clampArenaShipX(wireMe.x);
        const authY = clampArenaShipY(wireMe.y);
        const justRespawned = !this.wasAliveOnWire && wireMe.alive;
        this.wasAliveOnWire = wireMe.alive;

        if (!wireMe.alive || justRespawned || !this.hasSentAnyInput) {
          p.x = authX;
          p.y = authY;
          p.lastX = authX;
          this.invalidatePredHistory();
          this.lastSeenAckSeq = wireMe.ackSeq;
          this.pendingAckErr.dx = 0;
          this.pendingAckErr.dy = 0;
          this.reconcileGraceSec = 0;
          this.deck.syncTarget(p.x, p.y);
        } else {
          if (wireMe.ackSeq !== this.lastSeenAckSeq) {
            const deltaAck =
              this.lastSeenAckSeq === null ? 1 : (wireMe.ackSeq - this.lastSeenAckSeq + 256) & 0xff;
            this.lastSeenAckSeq = wireMe.ackSeq;
            if (deltaAck >= 3 && deltaAck < 128) {
              // Upstream stall just flushed multiple queued inputs; give Host time to walk `p` within speed caps.
              this.reconcileGraceSec = 0.7;
              this.pendingAckErr.dx = 0;
              this.pendingAckErr.dy = 0;
            } else if (this.reconcileGraceSec <= 0) {
              const hist = this.predHistory[wireMe.ackSeq & 0xff];
              if (hist && hist.valid && hist.seq === wireMe.ackSeq) {
                const near = this.closestPredictedPointSinceAck(wireMe.ackSeq, p.x, p.y, authX, authY);
                const dxErr = authX - near.x;
                const dyErr = authY - near.y;
                const ackErr = Math.hypot(dxErr, dyErr);
                if (ackErr > 240) {
                  p.x = authX;
                  p.y = authY;
                  p.lastX = authX;
                  this.invalidatePredHistory();
                  this.pendingAckErr.dx = 0;
                  this.pendingAckErr.dy = 0;
                  this.deck.syncTarget(p.x, p.y);
                } else if (ackErr > COOP_ACK_DEADBAND_PX) {
                  const excess = (ackErr - COOP_ACK_DEADBAND_PX) / ackErr;
                  this.pendingAckErr.dx = dxErr * excess;
                  this.pendingAckErr.dy = dyErr * excess;
                } else {
                  this.pendingAckErr.dx = 0;
                  this.pendingAckErr.dy = 0;
                }
              }
            }
          }

          const remErr = Math.hypot(this.pendingAckErr.dx, this.pendingAckErr.dy);
          if (remErr > 0.25) {
            const stepMag = Math.min(remErr, Math.min(8, remErr * (1 - Math.exp(-realDt * 12))));
            const stepX = (this.pendingAckErr.dx / remErr) * stepMag;
            const stepY = (this.pendingAckErr.dy / remErr) * stepMag;
            this.pendingAckErr.dx -= stepX;
            this.pendingAckErr.dy -= stepY;
            p.x = clampArenaShipX(p.x + stepX);
            p.y = clampArenaShipY(p.y + stepY);
            for (const entry of this.predHistory) {
              if (entry.valid) {
                entry.x = clampArenaShipX(entry.x + stepX);
                entry.y = clampArenaShipY(entry.y + stepY);
              }
            }
            this.deck.syncTarget(p.x, p.y);
          }
        }
      } else {
        p.x = s.x;
        p.y = s.y;
        p.lean = s.lean;
        p.firing = s.firing;
        if (
          p.connected &&
          p.alive &&
          !this.hostReconnecting &&
          !this.hostPaused &&
          !world.gameOver &&
          Number.isFinite(p.x) &&
          Number.isFinite(p.y)
        ) {
          p.cooldown = Math.max(0, p.cooldown - simDt);
          if (p.firing && p.cooldown <= 0) {
            p.cooldown = world.upgrades.has('rapid') ? 0.11 : 0.17;
            p.volley += 1;
            fireVolley(
              this.guestLocalBolts,
              p.x,
              p.y,
              clamp(world.energy, 0, 1),
              p.volley,
              1,
              1,
              Boolean(world.boss),
              world.upgrades,
              p.color,
            );
          }
        } else {
          p.firing = false;
        }
      }
    }

    if (sample.ships.length > 0 || this.client.seats.length === 0) {
      for (const p of this.pilots) {
        if (!seenSnapSeats.has(p.seat)) {
          p.present = false;
          p.connected = false;
          p.alive = false;
        }
      }
    }

    const hullDropped = authMe !== null && authMe.hull < this.prevWireHull;
    if (authMe !== null) {
      this.prevWireHull = authMe.hull;
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

    // Reconstruct pickups & hazard mines before culling local cosmetic bolts
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

    // Reconstruct authoritative hostile shots, rockets, and beams + step local cosmetic squad bolts
    if (!this.hostPaused && !this.hostReconnecting && simDt > 0) {
      for (const sb of this.guestSuppressedBullets) {
        sb.x += sb.vx * simDt;
        sb.y += sb.vy * simDt;
        sb.ttlSec -= realDt;
      }
    }
    for (let i = this.guestSuppressedBullets.length - 1; i >= 0; i--) {
      if (this.guestSuppressedBullets[i]!.ttlSec <= 0) {
        this.guestSuppressedBullets.splice(i, 1);
      }
    }

    const canSuppressOnMe = me.present && me.alive && me.invulnerable <= 0 && !me.answering;
    const nextShots: Shot[] = [];
    const nextRockets: Rocket[] = [];
    const nextBeams: Beam[] = [];
    for (const sh of sample.shots) {
      if (sh.kind === 'rocket') {
        nextRockets.push({ x: sh.x, y: sh.y, vx: sh.vx, vy: sh.vy, age: 0.2, dead: false });
      } else if (sh.kind === 'beam') {
        nextBeams.push({ x: sh.x, y: sh.y, age: (1 - sh.beamLife) * 0.22 });
      } else {
        if (sh.kind === 'enemy') {
          let suppressed = false;
          for (const sb of this.guestSuppressedBullets) {
            if (Math.hypot(sh.x - sb.x, sh.y - sb.y) < 18 && Math.hypot(sh.vx - sb.vx, sh.vy - sb.vy) < 40) {
              sb.x = sh.x;
              sb.y = sh.y;
              suppressed = true;
              break;
            }
          }
          if (suppressed) continue;

          const dxMe = sh.x - me.x;
          const dyMe = sh.y - me.y;
          const distMe = Math.hypot(dxMe, dyMe);
          if (hullDropped && distMe < 36 && dxMe * sh.vx + dyMe * sh.vy > 0) {
            this.guestSuppressedBullets.push({ x: sh.x, y: sh.y, vx: sh.vx, vy: sh.vy, ttlSec: 0.25 });
            continue;
          }
          if (canSuppressOnMe && distMe < 12) {
            this.guestSuppressedBullets.push({ x: sh.x, y: sh.y, vx: sh.vx, vy: sh.vy, ttlSec: 0.25 });
          }
        }
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
    this.stepGuestLocalBolts(simDt, world);
    world.shots = [...nextShots, ...this.guestLocalBolts];
    world.rockets = nextRockets;
    world.beams = nextBeams;

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

  private stepGuestLocalBolts(simDt: number, world: CoopWorldAdapter): void {
    if (this.guestLocalBolts.length === 0) return;
    if (!this.hostPaused && !this.hostReconnecting && simDt > 0) {
      for (const b of this.guestLocalBolts) {
        b.x += b.vx * simDt;
        b.y += b.vy * simDt;
        if (b.x < -32 || b.x > COOP_WORLD_W + 32 || b.y < -48 || b.y > COOP_WORLD_H + 32) {
          b.dead = true;
          continue;
        }
        if (world.boss && (world.boss.state === 'fight' || world.boss.state === 'enter')) {
          if (Math.hypot(b.x - world.boss.x, b.y - world.boss.y) < 42) {
            b.dead = true;
            continue;
          }
        }
        if (world.sets.rockAt(b.x, b.y)) {
          b.dead = true;
          continue;
        }
        if (world.mines.some((m) => !m.dead && Math.hypot(b.x - m.x, b.y - m.y) < 11)) {
          b.dead = true;
          continue;
        }
        const skippedIds = this.boltSkipEnemyIds.get(b);
        for (const e of world.enemies) {
          if (e.dead || e === b.skip || skippedIds?.has(e.id)) continue;
          if (Math.hypot(b.x - e.x, b.y - e.y) < KINDS[e.kind].radius + 4) {
            if (b.pierce) {
              b.pierce -= 1;
              b.skip = e;
              let set = skippedIds;
              if (!set) {
                set = new Set<number>();
                this.boltSkipEnemyIds.set(b, set);
              }
              set.add(e.id);
            } else {
              b.dead = true;
            }
            break;
          }
        }
      }
    }
    let write = 0;
    for (let i = 0; i < this.guestLocalBolts.length; i++) {
      const b = this.guestLocalBolts[i]!;
      if (!b.dead) this.guestLocalBolts[write++] = b;
    }
    this.guestLocalBolts.length = write;
    if (this.guestLocalBolts.length > 160) {
      this.guestLocalBolts.splice(0, this.guestLocalBolts.length - 160);
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

  private sendGuestInputFrame(me: CoopPilotShip, ctrl: CoopLocalControlInput, sentAtMs = this.nowFn()): void {
    if (this.client.seat < 0) return;
    this.inputSeq = (this.inputSeq + 1) & 0xff;
    const tap = this.guestPendingTap;
    this.guestPendingTap = null;

    const deckState = this.deck.state();
    const hasPointer = !tap && (this.layout.useThumbDeck ? deckState.touching : ctrl.touching);
    // Always report Guest's own predicted `(me.x, me.y)` when `!tap`:
    // - In deck mode (`3.1`), `ctrl.touch*` is never read on the wire.
    // - In pointer & key modes (`4.1`), Host receives Guest's exact speed-capped position at `seq`.
    const targetX = tap ? tap.x : me.x;
    const targetY = tap ? tap.y : me.y;

    this.predHistory[this.inputSeq & 0xff] = {
      seq: this.inputSeq,
      x: me.x,
      y: me.y,
      sentAtMs,
      valid: true,
    };
    this.hasSentAnyInput = true;

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
      picking: this.quiz.isPickingGrade(),
      sendMs: sentAtMs,
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
    p.answering = false;
    p.jamSec = 0;
    this.downedAtSec[p.seat] = this.elapsedSec;
    this.hostSeatChallenge[p.seat] = null;
    if (p.seat === this.client.seat) {
      this.quiz.clearActive();
    }
    p.latestInput = null;
    p.respawnSec = COOP_WINGMAN_RESPAWN_SEC;
    world.burst(SHIP, p.x, p.y, 1.15 * scale, 0, p.color);
    this.recordHostFx('ring', p.x, p.y, p.color);

    const anyPresentPilotAlive = this.pilots.some((other) => other.present && other.alive);
    if (!anyPresentPilotAlive) {
      this.endSquadMission(world);
    } else {
      world.play('boom');
      this.onStatus?.(`${p.callsign} hull down. Auto-reboot in ${COOP_WINGMAN_RESPAWN_SEC} seconds.`);
    }
  }

  private allocateChallengeIds(span = 1): number {
    const base = this.nextChallengeId;
    this.nextChallengeId += Math.max(1, span);
    if (this.nextChallengeId >= (this.hostSessionId + 1) * CHALLENGE_ID_BLOCK - 8) {
      this.nextChallengeId = this.hostSessionId * CHALLENGE_ID_BLOCK + 4;
    }
    return base;
  }

  /** Tell a pilot's screen that the host has closed a question or offer, and remember it for late answers. */
  private sendQuestionClosed(seat: CoopSeatIndex, id: number, code: number, extra: number | null = null): void {
    const recent = this.recentClosedBySeat[seat]!;
    recent.set(id, { code, extra });
    while (recent.size > 8) recent.delete(recent.keys().next().value as number);
    if (seat === this.client.seat) {
      this.quiz.hostClosed(id, code, extra, this.layout.useThumbDeck, this.quizHooks(this.activeWorld));
      return;
    }
    this.client.sendEvent({
      kind: 'challenge-closed',
      to: seat,
      id,
      values: extra === null ? [code] : [code, extra],
    });
  }

  private quizHooks(world: CoopWorldAdapter | null): CoopQuizHooks {
    return {
      play: (sfx) => world?.play(sfx),
      announce: (msg) => {
        if (world?.say) world.say(msg);
        else this.onStatus?.(msg);
      },
      celebrate: (grade, big) => world?.celebrate?.(grade, big),
      getExternalGrade: world?.getGrade,
      setExternalGrade: world?.setGrade,
      onChallengeSettled: (id, kind, verdict, quality) => {
        if (this.client.seat < 0) return;
        const mySeat = this.client.seat as CoopSeatIndex;
        if (this.isHost) {
          if (world) this.handlePilotAnswer(mySeat, id, verdict, quality, world);
        } else {
          if (verdict !== 'failed') {
            this.pilots[mySeat].questionsRight += 1;
          } else if (kind !== 'break' && kind !== 'defuse') {
            this.pilots[mySeat].jamSec = JAM_SECONDS;
          }
          this.cacheGuestAnswer(id, id, verdict, quality);
          this.sendGuestAnswer(id, verdict, quality);
          this.pendingAnswer = {
            kind: kind === 'break' ? 'break' : 'question',
            answerId: id,
            verdict,
            quality,
            sentAtMs: this.nowFn(),
          };
        }
      },
      onUpgradeChosen: (baseId, slotIndex, _upgrade) => {
        if (this.client.seat < 0) return;
        const mySeat = this.client.seat as CoopSeatIndex;
        const answerId = baseId + slotIndex;
        if (this.isHost) {
          if (world) this.handlePilotAnswer(mySeat, answerId, 'perfect', 1, world);
        } else {
          this.cacheGuestAnswer(baseId, answerId, 'perfect', 1);
          this.sendGuestAnswer(answerId, 'perfect', 1);
          this.pendingAnswer = { kind: 'question', answerId, verdict: 'perfect', quality: 1, sentAtMs: this.nowFn() };
        }
      },
    };
  }

  private cacheGuestAnswer(key: number, answerId: number, verdict: Grade, quality: number): void {
    this.guestAnswerCache.set(key, { answerId, verdict, quality });
    while (this.guestAnswerCache.size > ANSWER_CACHE_SIZE) {
      this.guestAnswerCache.delete(this.guestAnswerCache.keys().next().value as number);
    }
  }

  private resendCachedAnswer(key: number): void {
    const cached = this.guestAnswerCache.get(key);
    if (cached) this.sendGuestAnswer(cached.answerId, cached.verdict, cached.quality);
  }

  private sendGuestAnswer(id: number, verdict: Grade, quality: number): void {
    if (typeof this.client.sendAnswer === 'function') {
      this.client.sendAnswer(id, verdict, quality);
    } else if (typeof (this.client as { sendJson?: (m: unknown) => void }).sendJson === 'function') {
      (this.client as { sendJson: (m: unknown) => void }).sendJson({
        type: 'answer',
        id,
        verdict,
        quality,
      });
    }
  }

  private startHostPilotChallenge(
    pilot: CoopPilotShip,
    stake: Stake,
    world: CoopWorldAdapter,
    scale: number,
  ): boolean {
    if (!this.isHost || world.gameOver || pilot.answering) return false;
    // No new question while the squad is in its pre-wave break.
    if (this.squadBreakActive) return false;
    const id = this.allocateChallengeIds(1);
    this.pickingHeldSec[pilot.seat] = 0;
    this.staleHeldSec[pilot.seat] = 0;
    const safeWave = Math.max(1, Math.round(world.wave || 1));
    pilot.answering = true;
    pilot.firing = false;
    this.hostSeatChallenge[pilot.seat] = {
      mode: 'stake',
      id,
      stake,
      wave: safeWave,
      expiresAtSec: this.elapsedSec + COOP_QUIZ_TIMEOUT_SEC,
      scale,
    };

    if (pilot.seat === this.client.seat) {
      this.quiz.openChallenge(id, stake, safeWave, this.layout.useThumbDeck, this.quizHooks(world));
    } else {
      this.client.sendEvent({
        kind: 'challenge',
        to: pilot.seat,
        id,
        wave: safeWave,
        values: [encodeStakeCode(stake)],
      });
    }
    return true;
  }

  private handleWireAnswer(msg: CoopAnswerMessage): void {
    if (!this.isHost) return;
    const w = this.activeWorld;
    if (!w || w.gameOver) return;
    if (typeof msg.seat !== 'number' || !Number.isInteger(msg.seat) || msg.seat < 0 || msg.seat > 3) return;
    if (typeof msg.id !== 'number' || !Number.isInteger(msg.id) || msg.id <= 0) return;
    const verdict: Grade =
      msg.verdict === 'perfect' || msg.verdict === 'good' || msg.verdict === 'failed' ? msg.verdict : 'failed';
    // Only right or wrong counts: the guest's score is ignored (a band-scaled score would reveal the grade band).
    this.handlePilotAnswer(msg.seat as CoopSeatIndex, msg.id, verdict, verdictQuality(verdict), w);
  }

  private handlePilotAnswer(
    seat: CoopSeatIndex,
    id: number,
    verdict: Grade,
    quality: number,
    world: CoopWorldAdapter,
  ): void {
    if (!this.isHost || world.gameOver) return;
    const p = this.pilots[seat];
    if (!p.present) return;

    // 1. Pre-Wave Squad Break answer
    if (this.hostBreak && id === this.hostBreak.id) {
      if (this.hostBreak.answered.has(seat)) return;
      this.hostBreak.answered.set(seat, { verdict, quality });
      if (verdict !== 'failed') {
        p.questionsRight += 1;
      }
      const allConnectedDone = this.pilots.every(
        (other) => !other.present || !other.connected || this.hostBreak!.answered.has(other.seat),
      );
      if (allConnectedDone) {
        this.finishHostSquadBreak(world);
      }
      return;
    }

    // 2. Active mid-wave Stake or Upgrade Offer for `seat`
    const ch = this.hostSeatChallenge[seat];
    if (!ch || !p.alive) {
      this.replyToLateAnswer(seat, id);
      return;
    }

    if (ch.mode === 'offer') {
      const offers = ch.offerIndices ?? [];
      if (id < ch.id || id >= ch.id + offers.length) return;
      const chosenIdx = offers[id - ch.id];
      const chosen = chosenIdx !== undefined ? UPGRADES[chosenIdx] : undefined;
      this.hostSeatChallenge[seat] = null;
      p.answering = false;
      p.invulnerable = Math.max(p.invulnerable, 1.0);
      const fitted = this.equipSquadUpgrade(chosen?.id ?? null, p, world, ch.scale, offerIdsOf(offers));
      this.sendQuestionClosed(seat, ch.id, CLOSE_OFFER_FITTED, upgradeIndexOf(fitted));
      this.broadcastSnapshotNow(world);
      return;
    }

    if (id !== ch.id) {
      this.replyToLateAnswer(seat, id);
      return;
    }

    if (verdict === 'failed') {
      this.hostSeatChallenge[seat] = null;
      p.answering = false;
      if (ch.stake === 'defuse') {
        this.explodeBombOnPilot(p, world, ch.scale);
      } else {
        p.jamSec = JAM_SECONDS;
        p.firing = false;
        p.invulnerable = Math.max(p.invulnerable, 1.0);
      }
      this.broadcastSnapshotNow(world);
      return;
    }

    // Right answer (`'good'` or `'perfect'`): increment quiz counter & trigger Wingman Rescue-Pod Revive!
    p.questionsRight += 1;
    this.reviveDownedWingmen(seat, world, ch.scale);

    if (ch.stake === 'upgrade') {
      const choices = offerUpgrades(world.upgrades);
      const offerIndices = choices
        .map((u) => UPGRADES.findIndex((item) => item.id === u.id))
        .filter((idx) => idx >= 0);

      if (offerIndices.length === 0) {
        this.hostSeatChallenge[seat] = null;
        p.answering = false;
        p.invulnerable = Math.max(p.invulnerable, 1.0);
        world.score += ALL_OWNED_POINTS;
        world.energy = 1;
        world.ring(p.x, p.y, NEON.lime, 105 * ch.scale);
        this.recordHostFx('ring', p.x, p.y, NEON.lime);
        world.play('power');
      } else {
        const offerBaseId = this.allocateChallengeIds(4);
        this.hostSeatChallenge[seat] = {
          mode: 'offer',
          id: offerBaseId,
          stake: 'upgrade',
          wave: ch.wave,
          offerIndices,
          expiresAtSec: this.elapsedSec + COOP_OFFER_TIMEOUT_SEC,
          scale: ch.scale,
        };
        if (seat === this.client.seat) {
          this.quiz.openUpgradeOffer(offerBaseId, offerIndices, this.quizHooks(world));
        } else {
          this.client.sendEvent({
            kind: 'upgrade-offer',
            to: seat,
            id: offerBaseId,
            values: offerIndices,
          });
        }
      }
      this.broadcastSnapshotNow(world);
      return;
    }

    this.hostSeatChallenge[seat] = null;
    p.answering = false;
    p.invulnerable = Math.max(p.invulnerable, ch.stake === 'defuse' ? 1.2 : 1.0);

    if (ch.stake === 'energy') {
      world.energy = Math.min(1, world.energy + POWER_GAIN * clamp(quality, 0.35, 1));
      world.ring(p.x, p.y, NEON.cyan, 85 * ch.scale);
      this.recordHostFx('ring', p.x, p.y, NEON.cyan);
      world.play('power');
    } else if (ch.stake === 'hull') {
      let repaired = 0;
      for (const other of this.pilots) {
        if (other.present && other.alive && other.hull < other.maxHull) {
          other.hull = Math.min(other.maxHull, other.hull + 1);
          repaired += 1;
        }
      }
      if (repaired === 0) {
        world.score += FULL_HULL_BONUS;
      }
      world.ring(p.x, p.y, NEON.lime, 85 * ch.scale);
      this.recordHostFx('ring', p.x, p.y, NEON.lime);
      world.play('power');
    } else if (ch.stake === 'blast') {
      world.detonateScreen(p.x, p.y, p.color);
      this.recordHostFx('ring', p.x, p.y, p.color);
    } else if (ch.stake === 'defuse') {
      world.score += DEFUSE_POINTS;
      world.ring(p.x, p.y, NEON.lime, 80 * ch.scale);
      this.recordHostFx('ring', p.x, p.y, NEON.lime);
      world.play('power');
    }

    this.broadcastSnapshotNow(world);
  }

  private reviveSingleWingman(
    other: CoopPilotShip,
    rescuerSeat: CoopSeatIndex | null,
    spawnX: number,
    spawnY: number,
    world: CoopWorldAdapter,
    scale: number,
  ): void {
    other.x = spawnX;
    other.y = spawnY;
    other.lastX = spawnX;
    other.hull = Math.max(2, other.maxHull - 1);
    other.alive = true;
    other.respawnSec = 0;
    other.invulnerable = 2.4;
    other.answering = false;
    other.jamSec = 0;
    this.awaitingRespawnSync[other.seat] = true;
    this.respawnSyncDeadlineSec[other.seat] = this.elapsedSec + 0.9;
    world.ring(other.x, other.y, NEON.lime, 105 * scale);
    this.recordHostFx('ring', other.x, other.y, NEON.lime);
    world.play('shieldUp');
    if (rescuerSeat !== null) {
      this.pilots[rescuerSeat].revives += 1;
    }
    this.client.sendEvent({
      kind: 'revive',
      seat: other.seat,
      hp: other.hull,
      ...(rescuerSeat !== null ? { revives: this.pilots[rescuerSeat].revives } : {}),
    });
  }

  private reviveDownedWingmen(
    rescuerSeat: CoopSeatIndex | null,
    world: CoopWorldAdapter,
    scale: number,
  ): number {
    let revivedCount = 0;
    for (const other of this.pilots) {
      if (!other.present || other.alive || !other.connected) continue;
      const spawn = formationSpawnForSeat(other.seat);
      this.reviveSingleWingman(other, rescuerSeat, spawn.x, spawn.y, world, scale);
      revivedCount += 1;
    }
    return revivedCount;
  }

  /**
   * Guest: while the host has stopped acknowledging inputs (an upload stall: 10 or more outstanding, half a second),
   * send a regular input only every 200 ms. The rest would only queue up and arrive in one burst that the relay's
   * 35-a-second limit drops. Taps are never held back.
   */
  private upstreamStalledThrottle(nowMs: number): boolean {
    if (this.lastSeenAckSeq === null) return false;
    const outstanding = (this.inputSeq - this.lastSeenAckSeq + 256) & 0xff;
    if (outstanding < 10 || outstanding > 200) return false;
    const lastSent = this.guestSendTimesMs[this.guestSendTimesMs.length - 1];
    return lastSent !== undefined && nowMs - lastSent < 200;
  }

  /** Host: forget a seat's timing (a new run, or the guest's page or socket started again). */
  private resetGuestTiming(seat: CoopSeatIndex): void {
    this.tracks[seat] = freshTrack();
    this.tapQueue[seat]!.length = 0;
    this.ackSendFull[seat] = null;
    this.mirrorLeadMs[seat] = null;
    this.mirrorAckSeq[seat] = null;
  }

  /** Host: an input's send time in the seat's track's unwrapped guest ms (null for an 8-byte frame without one). */
  private senderTimeOf(seat: CoopSeatIndex, input: CoopGuestInput): number | null {
    if (typeof input.sendMs !== 'number' || !Number.isFinite(input.sendMs)) return null;
    const ref = this.tracks[seat]!.sendFull;
    if (ref === null) return input.sendMs;
    const low = ((ref % 65536) + 65536) % 65536;
    const delta = (input.sendMs - low + 65536) % 65536;
    return delta < 32768 ? ref + delta : ref - (65536 - delta);
  }

  /** Host: average each guest's bullet lead from this snapshot, once per newly acknowledged input, as the guest does. */
  private mirrorGuestLeads(snap: CoopWorldSnapshot): void {
    const hostMs = snap.hostElapsedMs;
    if (hostMs === undefined || !Number.isFinite(hostMs)) return;
    for (const ship of snap.ships) {
      const seat = ship.seat;
      if (seat === this.client.seat) continue;
      const sent = this.ackSendFull[seat];
      if (sent === null || ship.ackSeq === this.mirrorAckSeq[seat]) continue;
      this.mirrorAckSeq[seat] = ship.ackSeq;
      const sample = hostMs - sent;
      const cur = this.mirrorLeadMs[seat];
      this.mirrorLeadMs[seat] =
        cur === null || Math.abs(sample - cur) > 1200 ? sample : cur + (sample - cur) * COOP_LEAD_AVERAGE_GAIN;
    }
  }

  /** Host: record a guest's reported position, timed by its own send clock where the frame carries one. */
  private recordGuestSample(seat: CoopSeatIndex, input: CoopGuestInput, x: number, y: number): void {
    let tr = this.tracks[seat]!;
    const arrival = this.nowFn();
    let full = this.senderTimeOf(seat, input) ?? arrival; // an older 8-byte frame: time it by arrival
    if (tr.sendFull !== null && full < tr.sendFull - 1000) {
      // Over an ordered socket a report never comes from a second earlier: the guest's clock started again.
      this.resetGuestTiming(seat);
      tr = this.tracks[seat]!;
      full = this.senderTimeOf(seat, input) ?? arrival;
    }
    if (tr.sendFull !== null && full <= tr.sendFull) return;
    tr.timedBySender = typeof input.sendMs === 'number' && Number.isFinite(input.sendMs);
    const raw = arrival - full;
    tr.offsetMinMs =
      tr.offsetMinMs === null ? raw : Math.min(tr.offsetMinMs + Math.max(0, arrival - tr.lastArrivalMs) * 0.002, raw);
    tr.jitterMs += (clamp(raw - tr.offsetMinMs, 0, 150) - tr.jitterMs) * 0.1;
    tr.lastArrivalMs = arrival;
    tr.sendFull = full;
    tr.samples.push({ s: full, x, y });
    if (tr.samples.length > 6) tr.samples.shift();
  }

  /**
   * Host: how far to project a guest's newest input, in seconds (null until it can be timed). A guest draws enemy
   * bullets as they will be when its current input reaches the host: its screen maps host time to its own clock by the
   * lead in `mirrorLeadMs`. Projected to the guest's own time for this host moment by that same mapping, the copy is
   * where the guest's screen shows its ship when it shows the bullets of this moment, so both agree on every hit. The
   * network's jitter does not move it. It is negative for a report that came in sooner than usual.
   */
  private trackProjAgeSec(seat: CoopSeatIndex): number | null {
    const tr = this.tracks[seat]!;
    const newest = tr.samples[tr.samples.length - 1];
    const lead = this.mirrorLeadMs[seat];
    if (!newest || lead === null || !tr.timedBySender) return null;
    return Math.max(-120, this.hostSimElapsedMs - lead - newest.s) / 1000;
  }

  /** Host: the furthest to project: one report interval plus how late a report can usually be. */
  private trackLeadCapSec(seat: CoopSeatIndex): number {
    const jitter = this.tracks[seat]!.jitterMs;
    return Math.min(COOP_STALE_INPUT_SEC, (50 + clamp(jitter * 1.25, 10, 80)) / 1000);
  }

  /** Host: the guest's speed from its last reports (px/s), measured over at least 30 ms of its own clock. */
  private trackSpeed(seat: CoopSeatIndex): number {
    const samples = this.tracks[seat]!.samples;
    const newest = samples[samples.length - 1];
    if (!newest) return 0;
    for (let i = samples.length - 2; i >= 0; i--) {
      const old = samples[i]!;
      const span = newest.s - old.s;
      if (span >= 30) {
        return Math.min(FOLLOW_MAX_SPEED, Math.hypot(newest.x - old.x, newest.y - old.y) / (span / 1000));
      }
    }
    return 0;
  }

  /**
   * Host: a pilot's question clock (and the break's, for a pilot still on their break card) waits while that pilot
   * picks a grade, and while a guest's inputs stop arriving: its link or the host's is down, and its own clock waits
   * meanwhile. Each wait is capped. A pilot still picking after COOP_GRADE_PICK_SEC has that question closed, with
   * nothing won or lost, and is asked to pick again next time.
   */
  private holdQuestionClocks(dt: number, world: CoopWorldAdapter): void {
    let breakHeld = false;
    for (let i = 0; i < 4; i++) {
      const seat = i as CoopSeatIndex;
      const p = this.pilots[seat];
      if (!p.present) continue;
      const ch = this.hostSeatChallenge[seat];
      const brk = this.hostBreak;
      const inBreak = brk !== null && !brk.answered.has(seat) && !brk.waiting.has(seat);
      if (!ch && !inBreak) continue;
      const local = seat === this.client.seat;
      const fresh = local || this.elapsedSec - this.lastInputAtSec[seat]! <= 0.4;
      const picking = local ? this.quiz.isPickingGrade() : fresh && Boolean(p.latestInput?.picking);
      if (picking) {
        this.pickingHeldSec[seat] += dt;
        if (this.pickingHeldSec[seat]! >= COOP_GRADE_PICK_SEC) {
          this.cancelForUnpickedGrade(seat, world);
          continue;
        }
      } else if (!fresh && this.staleHeldSec[seat]! < COOP_STALE_HOLD_MAX_SEC) {
        this.staleHeldSec[seat] += dt;
      } else {
        continue;
      }
      if (ch) ch.expiresAtSec += dt;
      if (inBreak && !breakHeld) {
        brk.expiresAtSec += dt;
        breakHeld = true;
      }
    }
  }

  /** Host: a pilot never picked a grade, so close what they were asked: no reward and no penalty. */
  private cancelForUnpickedGrade(seat: CoopSeatIndex, world: CoopWorldAdapter): void {
    const p = this.pilots[seat];
    const ch = this.hostSeatChallenge[seat];
    this.pickingHeldSec[seat] = 0;
    if (ch) {
      this.hostSeatChallenge[seat] = null;
      p.answering = false;
      p.invulnerable = Math.max(p.invulnerable, 1.0);
      this.sendQuestionClosed(seat, ch.id, CLOSE_CANCELLED);
    } else if (this.hostBreak && !this.hostBreak.answered.has(seat)) {
      // Counts as no charge from this pilot, the same as not answering.
      this.hostBreak.answered.set(seat, { verdict: 'failed', quality: 0 });
      this.sendQuestionClosed(seat, this.hostBreak.id, CLOSE_CANCELLED);
    }
    this.broadcastSnapshotNow(world);
  }

  /** Host: send a pilot's open question, offer or break card again, with the time the host still allows. */
  private resendOpenPrompt(seat: CoopSeatIndex): void {
    if (seat === this.client.seat || !this.pilots[seat].present) return;
    const ch = this.hostSeatChallenge[seat];
    if (ch) {
      if (ch.mode === 'offer' && ch.offerIndices) {
        this.client.sendEvent({ kind: 'upgrade-offer', to: seat, id: ch.id, values: ch.offerIndices });
      } else {
        const left = Math.max(0, ch.expiresAtSec - this.elapsedSec - COOP_ANSWER_GRACE_SEC);
        this.client.sendEvent({
          kind: 'challenge',
          to: seat,
          id: ch.id,
          wave: ch.wave,
          values: [encodeStakeCode(ch.stake), Math.round(left * 10)],
        });
      }
    } else if (this.hostBreak && !this.hostBreak.answered.has(seat) && !this.hostBreak.waiting.has(seat)) {
      this.client.sendEvent({
        kind: 'challenge',
        to: seat,
        id: this.hostBreak.id,
        wave: this.hostBreak.nextWave,
        values: [encodeStakeCode('break')],
      });
    }
  }

  /** A session byte different from this tab's last host page, so a reloaded host never reuses old question ids. */
  private pickHostSessionId(isHost: boolean): number {
    let id = 1 + Math.floor(Math.random() * 255);
    if (!isHost) return id;
    try {
      const last = Number(this.storage?.getItem(HOST_SESSION_KEY) ?? 0);
      if (id === last) id = (id % 255) + 1;
      this.storage?.setItem(HOST_SESSION_KEY, String(id));
    } catch {
      /* storage blocked: a repeat is then 1 in 255 */
    }
    return id;
  }

  /**
   * How far the local question clock moves this frame. A guest's follows the wall clock (at most 0.25 s a frame), so
   * on a slow phone it keeps pace with the host's deadline; frame time is capped per frame and would fall behind.
   */
  private quizStepSec(realDt: number): number {
    if (this.isHost) return realDt;
    const now = this.nowFn();
    const last = this.lastQuizWallMs;
    this.lastQuizWallMs = now;
    return last === null ? realDt : clamp((now - last) / 1000, 0, 0.25);
  }

  /**
   * Guest: the host still shows this pilot answering (or the squad still on its break) a second after the answer
   * went out, so it was lost on the way (a link that died, or the relay's rate limit): send it again.
   */
  private resendUnconfirmedAnswer(hostStillAsking: boolean): void {
    const pa = this.pendingAnswer;
    if (!pa) return;
    const waiting = pa.kind === 'break' ? this.guestParked : hostStillAsking;
    const now = this.nowFn();
    if (now - pa.sentAtMs < 1000) return;
    if (!waiting) {
      this.pendingAnswer = null;
      return;
    }
    if (this.quiz.isInteractive()) return;
    pa.sentAtMs = now;
    this.sendGuestAnswer(pa.answerId, pa.verdict, pa.quality);
  }

  /** An answer for a question the host already closed: tell that screen again what really happened. */
  private replyToLateAnswer(seat: CoopSeatIndex, id: number): void {
    if (seat === this.client.seat) return;
    const recent = this.recentClosedBySeat[seat]!;
    for (let k = 0; k < 4; k++) {
      const closed = recent.get(id - k);
      if (!closed) continue;
      if (k > 0 && closed.code !== CLOSE_OFFER_FITTED) continue;
      if (closed.replied) return;
      closed.replied = true;
      this.client.sendEvent({
        kind: 'challenge-closed',
        to: seat,
        id: id - k,
        values: closed.extra === null ? [closed.code] : [closed.code, closed.extra],
      });
      return;
    }
  }

  private checkHostQuizTimeouts(world: CoopWorldAdapter): void {
    for (let i = 0; i < 4; i++) {
      const seat = i as CoopSeatIndex;
      const ch = this.hostSeatChallenge[seat];
      if (!ch) continue;
      const p = this.pilots[seat];
      if (!p.present || !p.alive) {
        this.hostSeatChallenge[seat] = null;
        p.answering = false;
        if (p.present) this.sendQuestionClosed(seat, ch.id, CLOSE_CANCELLED);
        else if (seat === this.client.seat) this.quiz.clearActive();
        continue;
      }
      if (this.elapsedSec < ch.expiresAtSec) continue;

      if (ch.mode === 'offer') {
        const firstIdx = ch.offerIndices?.[0];
        const firstId = firstIdx !== undefined ? UPGRADES[firstIdx]?.id ?? null : null;
        this.hostSeatChallenge[seat] = null;
        p.answering = false;
        p.invulnerable = Math.max(p.invulnerable, 1.0);
        const fitted = this.equipSquadUpgrade(firstId, p, world, ch.scale, offerIdsOf(ch.offerIndices ?? []));
        this.sendQuestionClosed(seat, ch.id, CLOSE_OFFER_FITTED, upgradeIndexOf(fitted));
      } else {
        this.handlePilotAnswer(seat, ch.id, 'failed', 0, world);
        this.sendQuestionClosed(seat, ch.id, CLOSE_TIMED_OUT);
        if (world.gameOver) return;
      }
    }

    if (this.hostBreak) {
      const allConnectedDone =
        this.hostBreak.answered.size > 0 &&
        this.pilots.every((p) => !p.present || !p.connected || this.hostBreak!.answered.has(p.seat));
      if (allConnectedDone || this.elapsedSec >= this.hostBreak.expiresAtSec) {
        this.finishHostSquadBreak(world);
      }
    }
  }

  private finishHostSquadBreak(world: CoopWorldAdapter): void {
    const brk = this.hostBreak;
    if (!brk) return;
    this.hostBreak = null;
    this.squadBreakActive = false;
    world.parked = false;

    let totalQuality = 0;
    let count = 0;
    let anyPerfect = false;
    for (const p of this.pilots) {
      if (!p.present) continue;
      const ans = brk.answered.get(p.seat);
      if (ans) {
        totalQuality += ans.quality;
        count += 1;
        if (ans.verdict === 'perfect') anyPerfect = true;
      } else if (p.connected) {
        count += 1;
      }
    }

    const avgQuality = count > 0 ? clamp(totalQuality / count, 0, 1) : 0;
    world.energy = clamp(Math.max(world.energy, avgQuality), 0.2, 1);

    if (anyPerfect) {
      let repaired = 0;
      for (const p of this.pilots) {
        if (p.present && p.alive && p.hull < p.maxHull) {
          p.hull = Math.min(p.maxHull, p.hull + 1);
          repaired += 1;
        }
      }
      if (repaired === 0) {
        world.score += FULL_HULL_BONUS;
      }
    }

    this.reviveDownedWingmen(null, world, 1);
    for (const p of this.pilots) {
      if (p.present) this.sendQuestionClosed(p.seat, brk.id, CLOSE_BREAK_OVER);
    }
    world.startWave?.(brk.nextWave);
    this.broadcastSnapshotNow(world);
  }

  private explodeBombOnPilot(p: CoopPilotShip, world: CoopWorldAdapter, scale: number): void {
    p.hull = 0;
    p.shieldReady = false;
    p.alive = false;
    p.firing = false;
    p.answering = false;
    p.jamSec = 0;
    this.downedAtSec[p.seat] = this.elapsedSec;
    p.latestInput = null;
    p.respawnSec = COOP_WINGMAN_RESPAWN_SEC;
    world.ring(p.x, p.y, NEON.red, 110 * scale);
    world.ring(p.x, p.y, NEON.orange, 85 * scale);
    world.burst(SHIP, p.x, p.y, 1.15 * scale, 0, p.color);
    this.recordHostFx('ring', p.x, p.y, NEON.red);
    world.play('blast');

    const anyPresentPilotAlive = this.pilots.some((other) => other.present && other.alive);
    if (!anyPresentPilotAlive) {
      this.endSquadMission(world);
    } else {
      this.onStatus?.(`${p.callsign} hit by bomb blast. Auto-reboot in ${COOP_WINGMAN_RESPAWN_SEC} seconds.`);
    }
  }

  private equipSquadUpgrade(
    preferred: UpgradeId | null,
    collector: CoopPilotShip,
    world: CoopWorldAdapter,
    scale: number,
    offered: readonly UpgradeId[] = [],
  ): UpgradeId | null {
    // Another pilot may have fitted the chosen upgrade a moment earlier: then the next one from this pilot's own offer.
    const chosenId =
      preferred && !world.upgrades.has(preferred)
        ? preferred
        : offered.find((id) => !world.upgrades.has(id)) ?? UPGRADES.find((u) => !world.upgrades.has(u.id))?.id ?? null;

    if (chosenId) {
      world.equipUpgrade(chosenId);
      if (chosenId === 'armour') {
        for (const p of this.pilots) {
          p.maxHull = 4;
          if (p.alive) p.hull = Math.min(4, p.hull + 1);
        }
      } else if (chosenId === 'shield') {
        for (const p of this.pilots) {
          p.shieldReady = true;
          p.shieldRecharge = 0;
        }
      }
    } else {
      world.score += ALL_OWNED_POINTS;
      world.energy = 1;
    }

    world.ring(collector.x, collector.y, NEON.lime, 105 * scale);
    this.recordHostFx('ring', collector.x, collector.y, NEON.lime);
    world.play('power');
    return chosenId;
  }

  private endSquadMission(world: CoopWorldAdapter): void {
    this.clearSavedHostProgress();
    this.squadBreakActive = false;
    this.hostBreak = null;
    this.hostSeatChallenge[0] = null;
    this.hostSeatChallenge[1] = null;
    this.hostSeatChallenge[2] = null;
    this.hostSeatChallenge[3] = null;
    for (const other of this.pilots) {
      other.answering = false;
      other.firing = false;
    }
    this.quiz.clearActive();
    world.triggerSquadGameOver();
    this.broadcastSnapshotNow(world);
    this.client.sendEvent({
      kind: 'mission-ended',
      wave: world.wave,
      score: world.score,
      freed: world.freed,
      values: [
        this.pilots[0].revives,
        this.pilots[1].revives,
        this.pilots[2].revives,
        this.pilots[3].revives,
        this.pilots[0].questionsRight,
        this.pilots[1].questionsRight,
        this.pilots[2].questionsRight,
        this.pilots[3].questionsRight,
      ],
    });
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
        answering: p.answering,
        shielded: p.shieldReady,
        firing: p.firing || this.firedSinceLastSnap[p.seat]!,
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
    this.firedSinceLastSnap.fill(false);

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
        recentBrokenIds: world.sets.brokenRockIds,
      };
    }

    // 3.2: Only pack hostile bullets, rockets, and lance beams on the wire; Guests simulate cosmetic friendly bolts locally at 60fps
    const shots: CoopSnapShot[] = [];
    for (const sh of world.shots) {
      if (sh.dead || !sh.hostile) continue;
      shots.push({
        kind: 'enemy',
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
      session: this.hostSessionId,
      hostElapsedMs: Math.round(this.hostSimElapsedMs),
      upgradesMask: encodeUpgradesMask(world.upgrades),
      wave: Math.max(1, world.wave),
      banner: world.banner,
      teamScore: world.score,
      freed: world.freed,
      energy: world.energy,
      paused: world.paused,
      parked: world.parked || this.squadBreakActive,
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
