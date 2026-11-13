/**
 * Single Co-op wire, lobby & UI contract shared across:
 * - Engine / Netcode (`src/game/coop-protocol.ts`, `src/game/coop-client.ts`, `src/game/game.ts`)
 * - UX / Lobby / QR / Phone Deck (`src/game/qr.ts`, `src/game/coop-lobby.ts`, `src/game/coop-thumbdeck.ts`)
 * - Relay (`relay/room.mjs` & `relay/worker.mjs`)
 */
import type { Grade } from './fireworks';

/**
 * 3: input frames may carry the guest's send time (10 bytes) and a pointer's destination (14 bytes), the PICKING input
 * flag and the answering bit, and the snapshot header carries the version in its own byte. Bump it whenever either
 * frame changes shape or meaning.
 */
export const COOP_PROTOCOL_VERSION = 3;

/** Unambiguous 31-symbol room code alphabet (`0/O/1/I/L` omitted) — matches `relay/room.mjs`. */
export const COOP_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const COOP_CODE_LENGTH = 6;
const VALID_ROOM_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** Normalize user-typed or URL room input into a clean 6-character code (`""`..`6` chars). */
export function normalizeCoopRoomCode(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g, '')
    .slice(0, COOP_CODE_LENGTH);
}

/** Check whether `raw` is a complete, valid 6-character Co-op room code (with optional hyphen/spaces). */
export function isValidCoopRoomCode(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const stripped = raw.replace(/[\s-]+/g, '').toUpperCase();
  return stripped.length === COOP_CODE_LENGTH && VALID_ROOM_CODE_RE.test(stripped);
}

/** Format a room code as `ABC-DEF` for display. */
export function formatCoopRoomCode(code: string): string {
  const clean = normalizeCoopRoomCode(code);
  return clean.length === COOP_CODE_LENGTH ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
}

/** Preset pilot callsign prefixes & validator — matches `relay/room.mjs` (`PREFIX-[1-9]`, zero free-text). */
export const COOP_CALLSIGN_PREFIXES = [
  'NOVA',
  'FALCON',
  'VIPER',
  'STAR',
  'ORION',
  'LYRA',
  'VEGA',
  'COMET',
  'APEX',
  'DRIFT',
  'PULSE',
  'SOLAR',
] as const;

export const VALID_COOP_CALLSIGN_RE =
  /^(NOVA|FALCON|VIPER|STAR|ORION|LYRA|VEGA|COMET|APEX|DRIFT|PULSE|SOLAR)-[1-9]$/;

/** Logical shared arena dimensions (`3:4` aspect ratio) used by all devices in Co-op mode. */
export const COOP_ARENA_WIDTH = 768;
export const COOP_ARENA_HEIGHT = 1024;

/** Binary WebSocket frame discriminators (`byte[0]`) and relay binary frame ceiling (`relay/room.mjs`). */
export const BIN_FRAME_INPUT = 0x01;
export const BIN_FRAME_SNAP = 0x02;
export const MAX_BINARY_BYTES = 1280;

/** Valid pilot seat indices (`0..3`), or `-1` for a Big-Screen TV spectator host. */
export type CoopSeatIndex = 0 | 1 | 2 | 3;
export type CoopHostSeatIndex = -1 | CoopSeatIndex;
export type CoopRole = 'host' | 'guest';

/** Distinct neon cockpit hull colors per pilot seat (`0..3`). */
export const COOP_SEAT_COLORS: readonly [string, string, string, string] = [
  '#38bdf8', // Seat 0 — Sky Cyan
  '#fbbf24', // Seat 1 — Solar Amber
  '#34d399', // Seat 2 — Emerald Mint
  '#f472b6', // Seat 3 — Nova Rose
];

/** Public seat state broadcast inside `welcome`, `lobby`, and `started` messages (contains zero tokens/IPs). */
export interface CoopPublicSeat {
  seat: CoopSeatIndex;
  callsign: string;
  ready: boolean;
  isHost: boolean;
  connected: boolean;
}

export interface CoopLobbyState {
  code: string;
  formattedCode: string;
  tvMode: boolean;
  locked: boolean;
  hostConnected: boolean;
  seats: CoopPublicSeat[];
}

export type CoopRefusalReason =
  | 'not-found'
  | 'expired'
  | 'started'
  | 'full'
  | 'kicked'
  | 'already-hosted'
  | 'replaced';

export type CoopRoomClosedReason = 'expired' | 'host-left' | 'closed';

export type CoopErrorReason = 'message-too-large' | 'rate-limited';

/**
 * Closed set of `event.kind` identifiers that the page recognizes.
 * - Frequent visual effects (`hit`, `boom`, pickups) ride inside the 18 Hz `0x02` `BIN_FRAME_SNAP`
 *   binary snapshot rather than as separate JSON messages, preserving the host's rate budget.
 * - Security rule: events carry codes and numbers ONLY — never free-text strings that get drawn!
 */
export type CoopEventKind =
  | 'wave-sync'
  | 'asteroid-field'
  | 'tanker-start'
  | 'capsule-caught'
  | 'challenge'
  | 'revive'
  | 'upgrade-offer'
  /** Host -> one pilot: a question or offer is over (`values: [closeCode, fittedUpgradeIndex?]`, see `coop-quiz.ts`). */
  | 'challenge-closed'
  | 'wave-clear'
  | 'mission-ended';

/**
 * Reconnect State Resync Rule (Host -> returning Guest):
 * 1. Returning guests learn that a game is already in flight from `welcome.locked === true`
 *    (since `started` is sent once at launch and is not re-sent on reconnect).
 * 2. Whenever the Host sees a guest seat transition from `connected: false` -> `connected: true`
 *    in `lobby` while `locked === true`, the Host immediately sends targeted (`to: seat`) `event`
 *    frames for any active state from `COOP_RECONNECT_RESYNC_KINDS`:
 *    - `'wave-sync'` (`wave`, `score`, `freed`)
 *    - `'asteroid-field'` (`wave`, `seed`) if an asteroid set piece is currently active
 *    - `'tanker-start'` (`wave`) if a refuel tanker set piece is currently active
 *    - `'challenge'` (`id`, `wave`) or `'upgrade-offer'` (`id`, `values`) if that seat has an open prompt.
 */
export const COOP_RECONNECT_RESYNC_KINDS = [
  'wave-sync',
  'asteroid-field',
  'tanker-start',
  'challenge',
  'upgrade-offer',
] as const satisfies readonly CoopEventKind[];

export interface CoopEventMessage {
  type: 'event';
  kind: CoopEventKind;
  to?: CoopSeatIndex;
  wave?: number;
  seed?: number;
  front?: number | null;
  alert?: number | null;
  id?: number;
  seat?: CoopSeatIndex;
  score?: number;
  freed?: number;
  revives?: number;
  hp?: number;
  x?: number;
  y?: number;
  values?: number[];
  /** Packed `u32` broken-rock bitmask words (`<= 16` words = up to `512` rock IDs) for reconnect resync. */
  bitmap?: number[];
}

/**
 * Guest -> Relay -> Host challenge result.
 * Matches `relay/room.mjs` and `Grade` in `src/game/fireworks.ts` (`'perfect' | 'good' | 'failed'`).
 * Never includes the child's grade picker level!
 */
export interface CoopAnswerMessage {
  type: 'answer';
  seat?: CoopSeatIndex;
  id: number;
  verdict: Grade;
  quality: number;
}

/* ============================================================================
 * Relay <-> Client JSON Control & Gameplay Message Unions (`relay/room.mjs`)
 * ============================================================================ */

export interface CoopWelcomeMessage {
  type: 'welcome';
  protocol: number;
  code: string;
  formattedCode: string;
  role: CoopRole;
  seat: CoopHostSeatIndex;
  token: string;
  tvMode: boolean;
  locked: boolean;
  seats: CoopPublicSeat[];
}

export interface CoopLobbyMessage extends CoopLobbyState {
  type: 'lobby';
}

export interface CoopRefusedMessage {
  type: 'refused';
  reason: CoopRefusalReason;
}

export interface CoopRoomClosedMessage {
  type: 'room-closed';
  reason: CoopRoomClosedReason;
}

export interface CoopHostReconnectingMessage {
  type: 'host-reconnecting';
  graceMs: number;
}

export interface CoopHostResumedMessage {
  type: 'host-resumed';
}

export interface CoopStartedMessage {
  type: 'started';
  code: string;
  seats: CoopPublicSeat[];
}

export interface CoopErrorMessage {
  type: 'error';
  reason: CoopErrorReason;
  maxBytes?: number;
}

export interface CoopPongMessage {
  type: 'pong';
  t: number;
}

export interface CoopHostPausedMessage {
  type: 'host-paused';
  paused: boolean;
}

/** Discriminated union of every JSON frame sent by `relay/room.mjs` / `relay/worker.mjs` to a browser client. */
export type CoopRelayToClientMessage =
  | CoopWelcomeMessage
  | CoopLobbyMessage
  | CoopRefusedMessage
  | CoopRoomClosedMessage
  | CoopHostReconnectingMessage
  | CoopHostResumedMessage
  | CoopStartedMessage
  | CoopErrorMessage
  | CoopPongMessage
  | CoopHostPausedMessage
  | CoopEventMessage
  | CoopAnswerMessage;

export interface CoopReadyMessage {
  type: 'ready';
  ready: boolean;
}

export interface CoopCallsignMessage {
  type: 'callsign';
  callsign: string;
}

export interface CoopKickMessage {
  type: 'kick';
  seat: CoopSeatIndex;
}

export interface CoopStartMessage {
  type: 'start';
}

export interface CoopLeaveMessage {
  type: 'leave';
}

export interface CoopPingMessage {
  type: 'ping';
  t: number;
}

/** Discriminated union of every JSON frame sent by a browser client to `relay/room.mjs`. */
export type CoopClientToRelayMessage =
  | CoopReadyMessage
  | CoopCallsignMessage
  | CoopKickMessage
  | CoopStartMessage
  | CoopLeaveMessage
  | CoopPingMessage
  | CoopAnswerMessage
  | CoopHostPausedMessage
  | CoopEventMessage;

/** HTTP response from `POST /relay/room` (`relay/worker.mjs`). */
export interface CoopCreateRoomResponse {
  ok: boolean;
  protocol?: number;
  code?: string;
  formattedCode?: string;
  error?: string;
}

/** Input bitflags packed into `byte[6]` of `0x01` `BIN_FRAME_INPUT` (`8 bytes` total). */
export const INPUT_FLAG_FIRE = 1 << 0;
export const INPUT_FLAG_POINTER = 1 << 1;
export const INPUT_FLAG_LEFT = 1 << 2;
export const INPUT_FLAG_RIGHT = 1 << 3;
export const INPUT_FLAG_UP = 1 << 4;
export const INPUT_FLAG_DOWN = 1 << 5;
export const INPUT_FLAG_TAP = 1 << 6;
/** The pilot's grade picker is up: the host holds that pilot's question clock until a grade is picked. */
export const INPUT_FLAG_PICKING = 1 << 7;

export interface CoopGuestInput {
  seat: CoopSeatIndex;
  targetX: number;
  targetY: number;
  firing: boolean;
  hasPointer: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  tap: boolean;
  seq: number;
  /** Grade picker on screen (never which grade). */
  picking?: boolean;
  /** The guest's own clock when sent, ms mod 65536 (absent in older 8-byte frames). */
  sendMs?: number;
  /**
   * While steering by pointer or thumb deck: where the ship is heading (the pointer, or the deck's target). The
   * ship flies toward it at up to 760 px/s, so the host can follow exactly as the guest's own screen does.
   */
  destX?: number;
  destY?: number;
  /** The destination has stopped moving (the finger or the deck's target is still). */
  destStill?: boolean;
}

export interface CoopMissionSummary {
  waveReached: number;
  teamScore: number;
  peopleFreed: number;
  revives: number;
  reason: 'victory' | 'all-down' | 'host-left';
}
