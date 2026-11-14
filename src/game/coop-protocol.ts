/**
 * Compact binary wire protocol and 60fps snapshot interpolator for Co-op Squad mode.
 *
 * Frame `0x01` (`BIN_FRAME_INPUT`, 8 bytes fixed, Guest -> Host @ 20 Hz):
 *   `[0x01, seat, targetX_lo, targetX_hi, targetY_lo, targetY_hi, flags, seq]`
 *
 * Frame `0x02` (`BIN_FRAME_SNAP`, < 1.15 KB variable, Host -> Guests @ 18 Hz):
 *   Authoritative `768 x 1024` (`3:4`) arena state: squad ships, ID-tagged enemies,
 *   boss (with numeric-only Sum Boss problem encoding), fuel tanker, seeded asteroid
 *   field progress, projectiles, pickups/mines, and a sequence-deduplicated FX ring
 *   so hits and explosions ride inside `BIN_FRAME_SNAP` without spending JSON budget.
 */

import type { Kind as EnemyKind } from './enemies';
import type { UpgradeId } from './upgrades';
import {
  BIN_FRAME_INPUT,
  BIN_FRAME_SNAP,
  COOP_ARENA_HEIGHT,
  COOP_ARENA_WIDTH,
  COOP_PROTOCOL_VERSION,
  COOP_SEAT_COLORS,
  INPUT_FLAG_DOWN,
  INPUT_FLAG_FIRE,
  INPUT_FLAG_LEFT,
  INPUT_FLAG_POINTER,
  INPUT_FLAG_RIGHT,
  INPUT_FLAG_PICKING,
  INPUT_FLAG_TAP,
  INPUT_FLAG_UP,
  MAX_BINARY_BYTES,
  type CoopGuestInput,
  type CoopSeatIndex,
} from './coop-types';
import { AMBER, LILAC, NEON, PEBBLE, PINK, ROCK, ROSE, SAND } from './core';

/** Shared logical `3:4` arena dimensions simulated identically across laptops, tablets, and phones. */
export const COOP_WORLD_W = COOP_ARENA_WIDTH;
export const COOP_WORLD_H = COOP_ARENA_HEIGHT;
export const SNAP_PROTOCOL_VERSION = COOP_PROTOCOL_VERSION;
/**
 * Version 2 kept the version in the low two bits of the flags byte, and 3 is the last value two bits can hold. From
 * version 3 on, those bits are always 3 and the real version is the next byte. A version 2 page still sees 3 there and
 * asks its player to refresh; later versions only change the version byte.
 */
const SNAP_VERSION_BITS_EXTENDED = 3;
/** Fixed header: type, flags, version, session, tick, wave, banner, score, freed, energy, upgrades, host time, counts. */
const SNAP_HEADER_BYTES = 26;
/**
 * How far past the newest snapshot straight bullets may be drawn. It must exceed round trip plus two snapshot
 * intervals, or bullets stand still at the cap until the next snapshot and then hop (round 15, 3.2).
 */
const STRAIGHT_LEAD_CAP_MS = 450;

export const INPUT_FLAG_FIRING = INPUT_FLAG_FIRE;
export {
  INPUT_FLAG_DOWN,
  INPUT_FLAG_LEFT,
  INPUT_FLAG_POINTER,
  INPUT_FLAG_RIGHT,
  INPUT_FLAG_TAP,
  INPUT_FLAG_UP,
  type CoopGuestInput,
};

/** Snapshot section caps keeping saturated frames strictly below `MAX_BINARY_BYTES` (1,280 B). */
export const SNAP_MAX_SHIPS = 4;
export const SNAP_MAX_ENEMIES = 44;
export const SNAP_MAX_SHOTS = 52;
export const SNAP_MAX_ITEMS = 16;
export const SNAP_MAX_FX = 16;
export const SNAP_MAX_BROKEN_ROCKS = 8;
/** Compact broken-rock bitmap ceiling (`64 B` = `512` rock IDs `0..511`; `0 B` when none broken). */
export const SNAP_MAX_ROCK_BITMAP_BYTES = 64;
export const SNAP_MAX_ROCK_BITMAP_BITS = SNAP_MAX_ROCK_BITMAP_BYTES * 8;

export const UPGRADE_WIRE_ORDER: readonly UpgradeId[] = [
  'rapid',
  'wide',
  'shield',
  'wingmates',
  'pierce',
  'guardian',
  'rockets',
  'lance',
  'armour',
  'nova',
];

export function encodeUpgradesMask(upgrades: Iterable<UpgradeId>): number {
  const set = upgrades instanceof Set ? upgrades : new Set(upgrades);
  let mask = 0;
  for (let i = 0; i < UPGRADE_WIRE_ORDER.length; i++) {
    if (set.has(UPGRADE_WIRE_ORDER[i]!)) mask |= 1 << i;
  }
  return mask & 0xffff;
}

export function decodeUpgradesMask(mask: number): UpgradeId[] {
  const out: UpgradeId[] = [];
  for (let i = 0; i < UPGRADE_WIRE_ORDER.length; i++) {
    if ((mask & (1 << i)) !== 0) out.push(UPGRADE_WIRE_ORDER[i]!);
  }
  return out;
}

/** Pack broken rock IDs (`0..511`) into `<= 16` `u32` words so `sanitizeHostEvent` forwards all of them. */
export function packBrokenRockWords(ids: readonly number[]): number[] {
  const words = new Uint32Array(16);
  let highestWord = -1;
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id >= 512) continue;
    const w = id >>> 5;
    words[w] = (words[w]! | (1 << (id & 31))) >>> 0;
    if (w > highestWord) highestWord = w;
  }
  return highestWord < 0 ? [] : Array.from(words.subarray(0, highestWord + 1));
}

export function unpackBrokenRockWords(words: readonly number[]): number[] {
  const out: number[] = [];
  const limit = Math.min(16, words.length);
  for (let w = 0; w < limit; w++) {
    const raw = words[w];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const word = raw >>> 0;
    if (word === 0) continue;
    for (let bit = 0; bit < 32; bit++) {
      if ((word & (1 << bit)) !== 0) out.push(w * 32 + bit);
    }
  }
  return out;
}

const COORD_OFFSET = 256;
const COORD_SCALE = 8; // 0.125 px precision over [-256, +1791.875]
const COORD_MAX_Q = 16383;

export const ENEMY_KIND_TABLE: readonly EnemyKind[] = [
  'drifter',
  'dart',
  'hex',
  'weaver',
  'mite',
  'splitter',
  'shard',
  'spinner',
  'saucer',
];

export const WIRE_COLOR_TABLE: readonly string[] = [
  NEON.cyan,
  NEON.lime,
  NEON.yellow,
  NEON.orange,
  NEON.red,
  NEON.violet,
  PINK,
  LILAC,
  AMBER,
  ROSE,
  SAND,
  ROCK,
  PEBBLE,
  '#ffffff',
  COOP_SEAT_COLORS[0],
  COOP_SEAT_COLORS[1],
  COOP_SEAT_COLORS[2],
  COOP_SEAT_COLORS[3],
];

export const MATH_OP_TABLE = ['+', '-', '×', '÷'] as const;
export type MathWireOp = (typeof MATH_OP_TABLE)[number];

export interface CoopSnapShip {
  seat: CoopSeatIndex;
  connected: boolean;
  alive: boolean;
  hull: number;
  maxHull: number;
  invulnerable: boolean;
  answering?: boolean;
  shielded: boolean;
  firing: boolean;
  spread: boolean;
  wing: boolean;
  orbitUpgrade: boolean;
  x: number;
  y: number;
  lean: number;
  orbit: number;
  ackSeq: number;
  respawnSec: number;
}

export interface CoopSnapEnemy {
  id: number;
  kind: EnemyKind;
  color: string;
  hp: number;
  flash: boolean;
  rot: number;
  x: number;
  y: number;
}

export interface CoopSnapBossArm {
  dx: number;
  dy: number;
  hp: number;
  maxHp: number;
  flash: boolean;
}

export interface CoopSnapBossPod {
  value: number;
  hits: number;
  right: boolean;
  flash: boolean;
}

export interface CoopSnapBoss {
  kind: 'arms' | 'sum';
  state: 'enter' | 'fight' | 'dying' | 'flee';
  open: boolean;
  flash: boolean;
  clang: boolean;
  rage: boolean;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  age: number;
  openTime: number;
  arms: CoopSnapBossArm[];
  mathA: number;
  mathB: number;
  mathOp: MathWireOp;
  pods: CoopSnapBossPod[];
}

export interface CoopSnapTanker {
  state: 'in' | 'fly' | 'out' | 'gone';
  hooked: boolean;
  hookedSeat: CoopSeatIndex;
  fuel: number;
  strain: number;
  x: number;
  y: number;
  drogueX: number;
  drogueY: number;
}

export interface CoopSnapField {
  seed: number;
  /** `null` while only the pre-field Flight Commander warning (`alert`) is active. */
  front: number | null;
  alert: number | null;
  wave: number;
  recentBrokenIds: number[];
}

export type CoopSnapShotKind = 'bolt' | 'rocket' | 'enemy' | 'beam';

export interface CoopSnapShot {
  kind: CoopSnapShotKind;
  color: string;
  heavy: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Normalized `0..1` beam opacity when `kind === 'beam'`. */
  beamLife: number;
}

export type CoopSnapItemKind = 'boost' | 'upgrade' | 'shield' | 'hull' | 'bomb';

export interface CoopSnapItem {
  kind: CoopSnapItemKind;
  age: number;
  x: number;
  y: number;
}

export type CoopSnapFxKind =
  | 'spark'
  | 'enemy-burst'
  | 'boss-burst'
  | 'ship-hit'
  | 'ring'
  | 'rock-break';

export interface CoopSnapFx {
  seq: number;
  kind: CoopSnapFxKind;
  color: string;
  enemyKind: EnemyKind;
  toughRock: boolean;
  x: number;
  y: number;
}

export interface CoopWorldSnapshot {
  tick: number;
  /** Random `1..255` Host page-load session byte (`0` when unset) so Host reloads reset Guest interpolators immediately. */
  session?: number;
  /** Monotonic Host simulation elapsed time in ms (`undefined` when unset, falling back to `tick * (1000/18)`). */
  hostElapsedMs?: number;
  /** Bitmask of all 10 squad `UpgradeId`s (`encodeUpgradesMask`). */
  upgradesMask?: number;
  wave: number;
  banner: number;
  teamScore: number;
  freed: number;
  energy: number;
  paused: boolean;
  parked: boolean;
  gameOver: boolean;
  ships: CoopSnapShip[];
  enemies: CoopSnapEnemy[];
  boss: CoopSnapBoss | null;
  tanker: CoopSnapTanker | null;
  field: CoopSnapField | null;
  shots: CoopSnapShot[];
  items: CoopSnapItem[];
  fx: CoopSnapFx[];
}

function clampNum(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v > max ? max : v;
}

export function encodeCoord(v: number): number {
  const q = Math.round((clampNum(v, -COORD_OFFSET, 1790) + COORD_OFFSET) * COORD_SCALE);
  return clampNum(q, 0, COORD_MAX_Q);
}

export function decodeCoord(q: number): number {
  return (q & 0x3fff) / COORD_SCALE - COORD_OFFSET;
}

function encodeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  const norm = (((Number.isFinite(rad) ? rad : 0) % twoPi) + twoPi) % twoPi;
  return Math.round((norm / twoPi) * 255) & 0xff;
}

function decodeAngle(byte: number): number {
  return ((byte & 0xff) / 255) * Math.PI * 2;
}

export function encodeWireColor(color: string): number {
  const idx = WIRE_COLOR_TABLE.indexOf(color);
  return idx >= 0 ? idx : 0;
}

export function decodeWireColor(idx: number): string {
  return WIRE_COLOR_TABLE[idx] ?? NEON.cyan;
}

function encodeEnemyKind(kind: EnemyKind): number {
  const idx = ENEMY_KIND_TABLE.indexOf(kind);
  return idx >= 0 ? idx : 0;
}

function decodeEnemyKind(idx: number): EnemyKind {
  return ENEMY_KIND_TABLE[idx] ?? 'drifter';
}

/** Parse `"12 + 7"` from `maths.ts` into numeric `(a, op, b)` so zero free-text strings cross the wire. */
export function parseBossMathQuestion(question: string): {
  a: number;
  b: number;
  op: MathWireOp;
} {
  const m = /^\s*(\d+)\s*([+\-×÷])\s*(\d+)\s*$/.exec(question);
  if (!m) return { a: 1, b: 1, op: '+' };
  const a = clampNum(Number(m[1]), 0, 255);
  const b = clampNum(Number(m[3]), 0, 255);
  const op = (MATH_OP_TABLE.includes(m[2] as MathWireOp) ? m[2] : '+') as MathWireOp;
  return { a, b, op };
}

export function formatBossMathQuestion(a: number, op: MathWireOp, b: number): string {
  return `${a & 0xff} ${op} ${b & 0xff}`;
}

/**
 * Pack a `0x01` `BIN_FRAME_INPUT` frame: 8 bytes, plus 2 when `sendMs` is given (the guest's own clock in ms, low 16
 * bits, so the host times each input from when it was sent rather than when it arrived), plus 4 more when steering by
 * pointer: `destX`/`destY`, where the ship is heading.
 */
export function encodeGuestInput(input: CoopGuestInput): Uint8Array {
  const hasSendMs = typeof input.sendMs === 'number' && Number.isFinite(input.sendMs);
  const hasDest =
    hasSendMs &&
    typeof input.destX === 'number' &&
    Number.isFinite(input.destX) &&
    typeof input.destY === 'number' &&
    Number.isFinite(input.destY);
  const buf = new ArrayBuffer(hasDest ? 14 : hasSendMs ? 10 : 8);
  const view = new DataView(buf);
  let flags = 0;
  if (input.firing) flags |= INPUT_FLAG_FIRING;
  if (input.hasPointer) flags |= INPUT_FLAG_POINTER;
  if (input.left) flags |= INPUT_FLAG_LEFT;
  if (input.right) flags |= INPUT_FLAG_RIGHT;
  if (input.up) flags |= INPUT_FLAG_UP;
  if (input.down) flags |= INPUT_FLAG_DOWN;
  if (input.tap) flags |= INPUT_FLAG_TAP;
  if (input.picking) flags |= INPUT_FLAG_PICKING;

  view.setUint8(0, BIN_FRAME_INPUT);
  view.setUint8(1, input.seat & 0x03);
  view.setUint16(2, encodeCoord(input.targetX), true);
  view.setUint16(4, encodeCoord(input.targetY), true);
  view.setUint8(6, flags);
  view.setUint8(7, input.seq & 0xff);
  if (hasSendMs) view.setUint16(8, Math.round(input.sendMs!) & 0xffff, true);
  if (hasDest) {
    // A coordinate uses 14 bits; the top bit of destX says the destination is still.
    view.setUint16(10, encodeCoord(input.destX!) | (input.destStill ? 0x8000 : 0), true);
    view.setUint16(12, encodeCoord(input.destY!), true);
  }
  return new Uint8Array(buf);
}

/** Unpack an 8-, 10- or 14-byte `0x01` `BIN_FRAME_INPUT` frame, returning `null` if malformed. */
export function decodeGuestInput(bytes: Uint8Array): CoopGuestInput | null {
  const len = bytes instanceof Uint8Array ? bytes.byteLength : 0;
  if (len !== 8 && len !== 10 && len !== 14) return null;
  if (bytes[0] !== BIN_FRAME_INPUT) return null;
  const seatRaw = bytes[1]!;
  if (seatRaw > 3) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const targetX = decodeCoord(view.getUint16(2, true));
  const targetY = decodeCoord(view.getUint16(4, true));
  const flags = view.getUint8(6);
  const seq = view.getUint8(7);
  return {
    seat: seatRaw as CoopSeatIndex,
    targetX,
    targetY,
    firing: (flags & INPUT_FLAG_FIRING) !== 0,
    hasPointer: (flags & INPUT_FLAG_POINTER) !== 0,
    left: (flags & INPUT_FLAG_LEFT) !== 0,
    right: (flags & INPUT_FLAG_RIGHT) !== 0,
    up: (flags & INPUT_FLAG_UP) !== 0,
    down: (flags & INPUT_FLAG_DOWN) !== 0,
    tap: (flags & INPUT_FLAG_TAP) !== 0,
    picking: (flags & INPUT_FLAG_PICKING) !== 0,
    seq,
    ...(len >= 10 ? { sendMs: view.getUint16(8, true) } : {}),
    ...(len === 14
      ? {
          destX: decodeCoord(view.getUint16(10, true)),
          destY: decodeCoord(view.getUint16(12, true)),
          destStill: (view.getUint16(10, true) & 0x8000) !== 0,
        }
      : {}),
  };
}

const BOSS_STATES = ['enter', 'fight', 'dying', 'flee'] as const;
const TANKER_STATES = ['in', 'fly', 'out', 'gone'] as const;
const SHOT_KINDS: readonly CoopSnapShotKind[] = ['bolt', 'rocket', 'enemy', 'beam'];
const ITEM_KINDS: readonly CoopSnapItemKind[] = ['boost', 'upgrade', 'shield', 'hull', 'bomb'];
const FX_KINDS: readonly CoopSnapFxKind[] = [
  'spark',
  'enemy-burst',
  'boss-burst',
  'ship-hit',
  'ring',
  'rock-break',
];

/** Pack an authoritative `0x02` `BIN_FRAME_SNAP` binary snapshot strictly under `MAX_BINARY_BYTES`. */
export function encodeWorldSnapshot(snap: CoopWorldSnapshot): Uint8Array {
  const ships = snap.ships.slice(0, SNAP_MAX_SHIPS);
  const enemies = snap.enemies.slice(0, SNAP_MAX_ENEMIES);
  let shots: CoopSnapShot[];
  if (snap.shots.length <= SNAP_MAX_SHOTS) {
    shots = snap.shots.slice();
  } else {
    // Priority order: enemy bullets first (lethal hazards), then beams & rockets, then newest bolts.
    const enemyShots: CoopSnapShot[] = [];
    const specialShots: CoopSnapShot[] = [];
    const boltShots: CoopSnapShot[] = [];
    for (const sh of snap.shots) {
      if (sh.kind === 'enemy') enemyShots.push(sh);
      else if (sh.kind === 'beam' || sh.kind === 'rocket') specialShots.push(sh);
      else boltShots.push(sh);
    }
    shots = enemyShots.slice(0, SNAP_MAX_SHOTS);
    if (shots.length < SNAP_MAX_SHOTS && specialShots.length > 0) {
      shots.push(...specialShots.slice(0, SNAP_MAX_SHOTS - shots.length));
    }
    if (shots.length < SNAP_MAX_SHOTS && boltShots.length > 0) {
      shots.push(...boltShots.slice(-(SNAP_MAX_SHOTS - shots.length)));
    }
  }
  const items = snap.items.slice(0, SNAP_MAX_ITEMS);
  const fx = snap.fx.slice(-SNAP_MAX_FX);
  const boss = snap.boss;
  const tanker = snap.tanker;
  const field = snap.field;

  const bossExtra = boss
    ? boss.kind === 'arms'
      ? 1 + Math.min(4, boss.arms.length) * 5
      : 4 + Math.min(4, boss.pods.length) * 4
    : 0;
  const bossBytes = boss ? 12 + bossExtra : 0;
  const tankerBytes = tanker ? 11 : 0;

  let rockBitmap = new Uint8Array(0);
  if (field && field.recentBrokenIds.length > 0) {
    let maxByteIdx = -1;
    const temp = new Uint8Array(SNAP_MAX_ROCK_BITMAP_BYTES);
    for (const rawId of field.recentBrokenIds) {
      if (!Number.isFinite(rawId)) continue;
      const id = Math.round(rawId);
      if (id < 0 || id >= SNAP_MAX_ROCK_BITMAP_BYTES * 8) continue;
      const byteIdx = id >> 3;
      temp[byteIdx] = (temp[byteIdx] ?? 0) | (1 << (id & 7));
      if (byteIdx > maxByteIdx) maxByteIdx = byteIdx;
    }
    if (maxByteIdx >= 0) {
      rockBitmap = temp.subarray(0, maxByteIdx + 1);
    }
  }
  const fieldBytes = field ? 9 + rockBitmap.byteLength : 0;

  const totalBytes =
    SNAP_HEADER_BYTES +
    ships.length * 12 +
    enemies.length * 9 +
    bossBytes +
    tankerBytes +
    fieldBytes +
    shots.length * 7 +
    items.length * 6 +
    fx.length * 7;

  if (totalBytes > MAX_BINARY_BYTES) {
    throw new RangeError(`Co-op snapshot (${totalBytes} B) exceeds MAX_BINARY_BYTES (${MAX_BINARY_BYTES} B)`);
  }

  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  let off = 0;

  let vFlags = SNAP_VERSION_BITS_EXTENDED;
  if (snap.paused) vFlags |= 0x04;
  if (snap.parked) vFlags |= 0x08;
  if (snap.gameOver) vFlags |= 0x10;
  if (boss) vFlags |= 0x20;
  if (tanker) vFlags |= 0x40;
  if (field) vFlags |= 0x80;

  const sessionByte =
    snap.session !== undefined && Number.isFinite(snap.session)
      ? clampNum(Math.round(snap.session), 0, 255)
      : 0;
  const upgradesMask =
    snap.upgradesMask !== undefined && Number.isFinite(snap.upgradesMask)
      ? clampNum(Math.round(snap.upgradesMask), 0, 0xffff)
      : 0;
  const hostElapsedRaw =
    snap.hostElapsedMs !== undefined && Number.isFinite(snap.hostElapsedMs) && snap.hostElapsedMs >= 0
      ? clampNum(Math.round(snap.hostElapsedMs), 0, 0xfffffffe) >>> 0
      : 0xffffffff;

  view.setUint8(off++, BIN_FRAME_SNAP);
  view.setUint8(off++, vFlags);
  view.setUint8(off++, SNAP_PROTOCOL_VERSION);
  view.setUint8(off++, sessionByte);
  view.setUint16(off, snap.tick & 0xffff, true);
  off += 2;
  view.setUint8(off++, clampNum(Math.round(snap.wave), 1, 255));
  view.setUint8(off++, clampNum(Math.round(snap.banner * 10), 0, 255));
  view.setUint32(off, clampNum(Math.round(snap.teamScore), 0, 0xffffffff) >>> 0, true);
  off += 4;
  view.setUint16(off, clampNum(Math.round(snap.freed), 0, 0xffff), true);
  off += 2;
  view.setUint8(off++, clampNum(Math.round(snap.energy * 255), 0, 255));
  view.setUint16(off, upgradesMask, true);
  off += 2;
  view.setUint32(off, hostElapsedRaw, true);
  off += 4;
  view.setUint8(off++, ships.length);
  view.setUint8(off++, enemies.length);
  view.setUint8(off++, shots.length);
  view.setUint8(off++, items.length);
  view.setUint8(off++, fx.length);

  for (const s of ships) {
    let status = 0;
    if (s.connected) status |= 0x01;
    if (s.alive) status |= 0x02;
    if (s.invulnerable) status |= 0x04;
    if (s.shielded) status |= 0x08;
    if (s.firing) status |= 0x10;
    if (s.spread) status |= 0x20;
    if (s.wing) status |= 0x40;
    if (s.orbitUpgrade) status |= 0x80;

    view.setUint8(off++, s.seat & 0x03);
    view.setUint8(off++, clampNum(Math.round(s.hull), 0, 255));
    view.setUint8(off++, (clampNum(Math.round(s.maxHull), 1, 127) & 0x7f) | (s.answering ? 0x80 : 0));
    view.setUint8(off++, status);
    view.setUint16(off, encodeCoord(s.x), true);
    off += 2;
    view.setUint16(off, encodeCoord(s.y), true);
    off += 2;
    view.setInt8(off++, clampNum(Math.round(s.lean * 100), -100, 100));
    view.setUint8(off++, encodeAngle(s.orbit));
    view.setUint8(off++, s.ackSeq & 0xff);
    view.setUint8(off++, clampNum(Math.round(s.respawnSec * 10), 0, 255));
  }

  for (const e of enemies) {
    const kindIdx = encodeEnemyKind(e.kind) & 0x0f;
    const colorIdx = encodeWireColor(e.color) & 0x1f;
    const hpByte = (clampNum(Math.round(e.hp), 0, 63) & 0x3f) | (e.flash ? 0x80 : 0) | ((colorIdx & 0x10) << 2);

    view.setUint16(off, e.id & 0xffff, true);
    off += 2;
    view.setUint8(off++, kindIdx | ((colorIdx & 0x0f) << 4));
    view.setUint8(off++, hpByte);
    view.setUint8(off++, encodeAngle(e.rot));
    view.setUint16(off, encodeCoord(e.x), true);
    off += 2;
    view.setUint16(off, encodeCoord(e.y), true);
    off += 2;
  }

  if (boss) {
    const stateIdx = Math.max(0, BOSS_STATES.indexOf(boss.state));
    let bFlags = boss.kind === 'sum' ? 0x01 : 0x00;
    bFlags |= (stateIdx & 0x03) << 1;
    if (boss.open) bFlags |= 0x08;
    if (boss.flash) bFlags |= 0x10;
    if (boss.clang) bFlags |= 0x20;
    if (boss.rage) bFlags |= 0x40;

    view.setUint8(off++, bFlags);
    view.setUint16(off, clampNum(Math.round(boss.hp), 0, 0xffff), true);
    off += 2;
    view.setUint16(off, clampNum(Math.round(boss.maxHp), 1, 0xffff), true);
    off += 2;
    view.setUint16(off, encodeCoord(boss.x), true);
    off += 2;
    view.setUint16(off, encodeCoord(boss.y), true);
    off += 2;
    view.setUint16(off, clampNum(Math.round(boss.age * 60), 0, 0xffff), true);
    off += 2;
    view.setUint8(off++, clampNum(Math.round(boss.openTime * 10), 0, 255));

    if (boss.kind === 'arms') {
      const arms = boss.arms.slice(0, 4);
      view.setUint8(off++, arms.length);
      for (const arm of arms) {
        view.setInt8(off++, clampNum(Math.round(arm.dx / 2), -127, 127));
        view.setInt8(off++, clampNum(Math.round(arm.dy / 2), -127, 127));
        view.setUint8(off++, clampNum(Math.round(arm.hp), 0, 255));
        view.setUint8(off++, clampNum(Math.round(arm.maxHp), 1, 255));
        view.setUint8(off++, arm.flash ? 1 : 0);
      }
    } else {
      const opIdx = Math.max(0, MATH_OP_TABLE.indexOf(boss.mathOp));
      const pods = boss.pods.slice(0, 4);
      view.setUint8(off++, clampNum(Math.round(boss.mathA), 0, 255));
      view.setUint8(off++, clampNum(Math.round(boss.mathB), 0, 255));
      view.setUint8(off++, opIdx & 0x03);
      view.setUint8(off++, pods.length);
      for (const pod of pods) {
        view.setUint16(off, clampNum(Math.round(pod.value), 0, 0xffff), true);
        off += 2;
        view.setUint8(off++, clampNum(Math.round(pod.hits), 0, 255));
        view.setUint8(off++, (pod.right ? 0x01 : 0) | (pod.flash ? 0x02 : 0));
      }
    }
  }

  if (tanker) {
    const tStateIdx = Math.max(0, TANKER_STATES.indexOf(tanker.state));
    const tFlags =
      (tStateIdx & 0x03) | (tanker.hooked ? 0x04 : 0) | ((tanker.hookedSeat & 0x03) << 3);
    view.setUint8(off++, tFlags);
    view.setUint8(off++, clampNum(Math.round(tanker.fuel * 255), 0, 255));
    view.setUint8(off++, clampNum(Math.round(tanker.strain * 255), 0, 255));
    view.setUint16(off, encodeCoord(tanker.x), true);
    off += 2;
    view.setUint16(off, encodeCoord(tanker.y), true);
    off += 2;
    view.setUint16(off, encodeCoord(tanker.drogueX), true);
    off += 2;
    view.setUint16(off, encodeCoord(tanker.drogueY), true);
    off += 2;
  }

  if (field) {
    view.setUint32(off, field.seed >>> 0, true);
    off += 4;
    view.setInt16(
      off,
      field.front === null ? -32768 : clampNum(Math.round(field.front), -32767, 32767),
      true,
    );
    off += 2;
    view.setUint8(
      off++,
      field.alert === null ? 255 : clampNum(Math.round(field.alert * 10), 0, 254),
    );
    view.setUint8(off++, clampNum(Math.round(field.wave), 1, 255));
    view.setUint8(off++, rockBitmap.byteLength);
    for (let i = 0; i < rockBitmap.byteLength; i++) {
      view.setUint8(off++, rockBitmap[i]!);
    }
  }

  for (const sh of shots) {
    const kindIdx = Math.max(0, SHOT_KINDS.indexOf(sh.kind)) & 0x03;
    const colorIdx = encodeWireColor(sh.color) & 0x1f;
    const header = kindIdx | (colorIdx << 2) | (sh.heavy ? 0x80 : 0);
    view.setUint8(off++, header);
    view.setUint16(off, encodeCoord(sh.x), true);
    off += 2;
    view.setUint16(off, encodeCoord(sh.y), true);
    off += 2;
    if (sh.kind === 'beam') {
      view.setInt8(off++, clampNum(Math.round(sh.beamLife * 100), 0, 100));
      view.setInt8(off++, 0);
    } else {
      view.setInt8(off++, clampNum(Math.round(sh.vx / 8), -127, 127));
      view.setInt8(off++, clampNum(Math.round(sh.vy / 8), -127, 127));
    }
  }

  for (const it of items) {
    const kindIdx = Math.max(0, ITEM_KINDS.indexOf(it.kind));
    view.setUint8(off++, kindIdx);
    view.setUint8(off++, clampNum(Math.round((it.age % 12.5) * 20), 0, 255));
    view.setUint16(off, encodeCoord(it.x), true);
    off += 2;
    view.setUint16(off, encodeCoord(it.y), true);
    off += 2;
  }

  for (const event of fx) {
    const fxIdx = Math.max(0, FX_KINDS.indexOf(event.kind)) & 0x07;
    const colorIdx = encodeWireColor(event.color) & 0x1f;
    let param = 0;
    if (event.kind === 'enemy-burst') {
      param = encodeEnemyKind(event.enemyKind) & 0x0f;
    } else if (event.kind === 'rock-break') {
      param = event.toughRock ? 1 : 0;
    }
    view.setUint8(off++, event.seq & 0xff);
    view.setUint8(off++, fxIdx | (colorIdx << 3));
    view.setUint8(off++, param);
    view.setUint16(off, encodeCoord(event.x), true);
    off += 2;
    view.setUint16(off, encodeCoord(event.y), true);
    off += 2;
  }

  return new Uint8Array(buf);
}

/** Classify a `0x02` snapshot frame carrying a non-zero wire version !== `SNAP_PROTOCOL_VERSION` (`'older'` vs `'newer'`). */
export function getSnapshotVersionMismatch(bytes: Uint8Array): 'older' | 'newer' | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 18 || bytes.byteLength > MAX_BINARY_BYTES) {
    return null;
  }
  if (bytes[0] !== BIN_FRAME_SNAP) return null;
  const bits = bytes[1]! & 0x03;
  if (bits === 0) return null;
  const version = bits === SNAP_VERSION_BITS_EXTENDED ? bytes[2]! : bits;
  if (version === SNAP_PROTOCOL_VERSION) return null;
  return version < SNAP_PROTOCOL_VERSION ? 'older' : 'newer';
}

/** True when `bytes` is a `0x02` snapshot frame carrying a non-zero wire version !== `SNAP_PROTOCOL_VERSION`. */
export function isSnapshotVersionMismatch(bytes: Uint8Array): boolean {
  return getSnapshotVersionMismatch(bytes) !== null;
}

/** Unpack a `0x02` `BIN_FRAME_SNAP` binary snapshot, returning `null` on any truncated or invalid frame. */
export function decodeWorldSnapshot(bytes: Uint8Array): CoopWorldSnapshot | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < SNAP_HEADER_BYTES || bytes.byteLength > MAX_BINARY_BYTES) {
    return null;
  }
  if (bytes[0] !== BIN_FRAME_SNAP) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  let off = 1;

  const vFlags = view.getUint8(off++);
  if ((vFlags & 0x03) !== SNAP_VERSION_BITS_EXTENDED) return null;
  if (view.getUint8(off++) !== SNAP_PROTOCOL_VERSION) return null;

  const paused = (vFlags & 0x04) !== 0;
  const parked = (vFlags & 0x08) !== 0;
  const gameOver = (vFlags & 0x10) !== 0;
  const hasBoss = (vFlags & 0x20) !== 0;
  const hasTanker = (vFlags & 0x40) !== 0;
  const hasField = (vFlags & 0x80) !== 0;

  const session = view.getUint8(off++);
  const tick = view.getUint16(off, true);
  off += 2;
  const wave = view.getUint8(off++);
  const banner = view.getUint8(off++) / 10;
  const teamScore = view.getUint32(off, true);
  off += 4;
  const freed = view.getUint16(off, true);
  off += 2;
  const energy = view.getUint8(off++) / 255;
  const upgradesMask = view.getUint16(off, true);
  off += 2;
  const hostElapsedRaw = view.getUint32(off, true);
  off += 4;
  const hostElapsedMs = hostElapsedRaw === 0xffffffff ? undefined : hostElapsedRaw;
  const shipCount = view.getUint8(off++);
  const enemyCount = view.getUint8(off++);
  const shotCount = view.getUint8(off++);
  const itemCount = view.getUint8(off++);
  const fxCount = view.getUint8(off++);

  if (
    shipCount > SNAP_MAX_SHIPS ||
    enemyCount > SNAP_MAX_ENEMIES ||
    shotCount > SNAP_MAX_SHOTS ||
    itemCount > SNAP_MAX_ITEMS ||
    fxCount > SNAP_MAX_FX
  ) {
    return null;
  }

  const ships: CoopSnapShip[] = [];
  if (off + shipCount * 12 > len) return null;
  for (let i = 0; i < shipCount; i++) {
    const seatRaw = view.getUint8(off++);
    if (seatRaw > 3) return null;
    const hull = view.getUint8(off++);
    const maxHullByte = view.getUint8(off++);
    const answering = (maxHullByte & 0x80) !== 0;
    const maxHull = Math.max(1, maxHullByte & 0x7f);
    const status = view.getUint8(off++);
    const x = decodeCoord(view.getUint16(off, true));
    off += 2;
    const y = decodeCoord(view.getUint16(off, true));
    off += 2;
    const lean = clampNum(view.getInt8(off++) / 100, -1, 1);
    const orbit = decodeAngle(view.getUint8(off++));
    const ackSeq = view.getUint8(off++);
    const respawnSec = view.getUint8(off++) / 10;
    ships.push({
      seat: seatRaw as CoopSeatIndex,
      connected: (status & 0x01) !== 0,
      alive: (status & 0x02) !== 0,
      hull,
      maxHull,
      invulnerable: (status & 0x04) !== 0,
      answering,
      shielded: (status & 0x08) !== 0,
      firing: (status & 0x10) !== 0,
      spread: (status & 0x20) !== 0,
      wing: (status & 0x40) !== 0,
      orbitUpgrade: (status & 0x80) !== 0,
      x,
      y,
      lean,
      orbit,
      ackSeq,
      respawnSec,
    });
  }

  const enemies: CoopSnapEnemy[] = [];
  if (off + enemyCount * 9 > len) return null;
  for (let i = 0; i < enemyCount; i++) {
    const id = view.getUint16(off, true);
    off += 2;
    const kc = view.getUint8(off++);
    const hpByte = view.getUint8(off++);
    const rot = decodeAngle(view.getUint8(off++));
    const x = decodeCoord(view.getUint16(off, true));
    off += 2;
    const y = decodeCoord(view.getUint16(off, true));
    off += 2;
    const colorIdx = ((kc >> 4) & 0x0f) | ((hpByte & 0x40) >> 2);
    enemies.push({
      id,
      kind: decodeEnemyKind(kc & 0x0f),
      color: decodeWireColor(colorIdx),
      hp: hpByte & 0x3f,
      flash: (hpByte & 0x80) !== 0,
      rot,
      x,
      y,
    });
  }

  let boss: CoopSnapBoss | null = null;
  if (hasBoss) {
    if (off + 12 > len) return null;
    const bFlags = view.getUint8(off++);
    const kind: 'arms' | 'sum' = (bFlags & 0x01) !== 0 ? 'sum' : 'arms';
    const state = BOSS_STATES[(bFlags >> 1) & 0x03] ?? 'fight';
    const open = (bFlags & 0x08) !== 0;
    const flash = (bFlags & 0x10) !== 0;
    const clang = (bFlags & 0x20) !== 0;
    const rage = (bFlags & 0x40) !== 0;
    const hp = view.getUint16(off, true);
    off += 2;
    const maxHp = Math.max(1, view.getUint16(off, true));
    off += 2;
    const x = decodeCoord(view.getUint16(off, true));
    off += 2;
    const y = decodeCoord(view.getUint16(off, true));
    off += 2;
    const age = view.getUint16(off, true) / 60;
    off += 2;
    const openTime = view.getUint8(off++) / 10;

    const arms: CoopSnapBossArm[] = [];
    const pods: CoopSnapBossPod[] = [];
    let mathA = 0;
    let mathB = 0;
    let mathOp: MathWireOp = '+';

    if (kind === 'arms') {
      if (off + 1 > len) return null;
      const armCount = view.getUint8(off++);
      if (armCount > 4 || off + armCount * 5 > len) return null;
      for (let i = 0; i < armCount; i++) {
        const dx = view.getInt8(off++) * 2;
        const dy = view.getInt8(off++) * 2;
        const armHp = view.getUint8(off++);
        const armMaxHp = Math.max(1, view.getUint8(off++));
        const armFlash = view.getUint8(off++) !== 0;
        arms.push({ dx, dy, hp: armHp, maxHp: armMaxHp, flash: armFlash });
      }
    } else {
      if (off + 4 > len) return null;
      mathA = view.getUint8(off++);
      mathB = view.getUint8(off++);
      mathOp = MATH_OP_TABLE[view.getUint8(off++) & 0x03] ?? '+';
      const podCount = view.getUint8(off++);
      if (podCount > 4 || off + podCount * 4 > len) return null;
      for (let i = 0; i < podCount; i++) {
        const value = view.getUint16(off, true);
        off += 2;
        const hits = view.getUint8(off++);
        const pFlags = view.getUint8(off++);
        pods.push({
          value,
          hits,
          right: (pFlags & 0x01) !== 0,
          flash: (pFlags & 0x02) !== 0,
        });
      }
    }

    boss = {
      kind,
      state,
      open,
      flash,
      clang,
      rage,
      hp,
      maxHp,
      x,
      y,
      age,
      openTime,
      arms,
      mathA,
      mathB,
      mathOp,
      pods,
    };
  }

  let tanker: CoopSnapTanker | null = null;
  if (hasTanker) {
    if (off + 11 > len) return null;
    const tFlags = view.getUint8(off++);
    const state = TANKER_STATES[tFlags & 0x03] ?? 'fly';
    const hooked = (tFlags & 0x04) !== 0;
    const hookedSeat = ((tFlags >> 3) & 0x03) as CoopSeatIndex;
    const fuel = view.getUint8(off++) / 255;
    const strain = view.getUint8(off++) / 255;
    const x = decodeCoord(view.getUint16(off, true));
    off += 2;
    const y = decodeCoord(view.getUint16(off, true));
    off += 2;
    const drogueX = decodeCoord(view.getUint16(off, true));
    off += 2;
    const drogueY = decodeCoord(view.getUint16(off, true));
    off += 2;
    tanker = { state, hooked, hookedSeat, fuel, strain, x, y, drogueX, drogueY };
  }

  let field: CoopSnapField | null = null;
  if (hasField) {
    if (off + 9 > len) return null;
    const seed = view.getUint32(off, true);
    off += 4;
    const frontRaw = view.getInt16(off, true);
    off += 2;
    const alertRaw = view.getUint8(off++);
    const fWave = view.getUint8(off++);
    const bitmapBytes = view.getUint8(off++);
    if (bitmapBytes > SNAP_MAX_ROCK_BITMAP_BYTES || off + bitmapBytes > len) return null;
    const recentBrokenIds: number[] = [];
    for (let bIdx = 0; bIdx < bitmapBytes; bIdx++) {
      const byte = view.getUint8(off++);
      if (byte === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if ((byte & (1 << bit)) !== 0) {
          recentBrokenIds.push(bIdx * 8 + bit);
        }
      }
    }
    field = {
      seed,
      front: frontRaw === -32768 ? null : frontRaw,
      alert: alertRaw === 255 ? null : alertRaw / 10,
      wave: fWave,
      recentBrokenIds,
    };
  }

  const shots: CoopSnapShot[] = [];
  if (off + shotCount * 7 > len) return null;
  for (let i = 0; i < shotCount; i++) {
    const header = view.getUint8(off++);
    const kind = SHOT_KINDS[header & 0x03] ?? 'bolt';
    const color = decodeWireColor((header >> 2) & 0x1f);
    const heavy = (header & 0x80) !== 0;
    const x = decodeCoord(view.getUint16(off, true));
    off += 2;
    const y = decodeCoord(view.getUint16(off, true));
    off += 2;
    const b1 = view.getInt8(off++);
    const b2 = view.getInt8(off++);
    if (kind === 'beam') {
      shots.push({
        kind,
        color,
        heavy,
        x,
        y,
        vx: 0,
        vy: 0,
        beamLife: clampNum(b1 / 100, 0, 1),
      });
    } else {
      shots.push({
        kind,
        color,
        heavy,
        x,
        y,
        vx: b1 * 8,
        vy: b2 * 8,
        beamLife: 0,
      });
    }
  }

  const items: CoopSnapItem[] = [];
  if (off + itemCount * 6 > len) return null;
  for (let i = 0; i < itemCount; i++) {
    const kindIdx = view.getUint8(off++);
    const kind = ITEM_KINDS[kindIdx] ?? 'boost';
    const age = view.getUint8(off++) / 20;
    const x = decodeCoord(view.getUint16(off, true));
    off += 2;
    const y = decodeCoord(view.getUint16(off, true));
    off += 2;
    items.push({ kind, age, x, y });
  }

  const fx: CoopSnapFx[] = [];
  if (off + fxCount * 7 > len) return null;
  for (let i = 0; i < fxCount; i++) {
    const seq = view.getUint8(off++);
    const fxHeader = view.getUint8(off++);
    const param = view.getUint8(off++);
    const x = decodeCoord(view.getUint16(off, true));
    off += 2;
    const y = decodeCoord(view.getUint16(off, true));
    off += 2;
    const kind = FX_KINDS[fxHeader & 0x07] ?? 'spark';
    const color = decodeWireColor((fxHeader >> 3) & 0x1f);
    if (kind === 'enemy-burst') {
      fx.push({
        seq,
        kind,
        enemyKind: decodeEnemyKind(param & 0x0f),
        color,
        toughRock: false,
        x,
        y,
      });
    } else if (kind === 'rock-break') {
      fx.push({
        seq,
        kind,
        enemyKind: 'drifter',
        color,
        toughRock: param !== 0,
        x,
        y,
      });
    } else {
      fx.push({
        seq,
        kind,
        enemyKind: 'drifter',
        color,
        toughRock: false,
        x,
        y,
      });
    }
  }

  if (off !== len) return null;

  return {
    session,
    tick,
    hostElapsedMs,
    upgradesMask,
    wave,
    banner,
    teamScore,
    freed,
    energy,
    paused,
    parked,
    gameOver,
    ships,
    enemies,
    boss,
    tanker,
    field,
    shots,
    items,
    fx,
  };
}

function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let diff = ((b - a) % twoPi + twoPi) % twoPi;
  if (diff > Math.PI) diff -= twoPi;
  return a + diff * t;
}

function isNewerTick(prevTick: number, nextTick: number): boolean {
  const delta = (nextTick - prevTick + 65536) & 0xffff;
  return delta > 0 && delta < 32768;
}

/** The host sends a snapshot about every 55.6 ms (18 a second). */
const HOST_SNAP_PERIOD_MS = 1000 / 18;
/**
 * How much of each new sample the bullet lead's running average takes. A guest and its host keep the same average (the
 * guest for its bullets, the host for that guest's ship), so it must be the same on both sides; a small gain keeps the
 * two close while a sample is still on its way from one to the other.
 */
export const COOP_LEAD_AVERAGE_GAIN = 0.05;

/**
 * The bullet lead's running average. A guest keeps one for its bullets and the host keeps the same one for that
 * guest's ship (`mirrorGuestLeads`), fed the same samples in the same order and updated by `updateLeadAverage`, so
 * both screens use the same value.
 */
export interface LeadAverage {
  value: number | null;
  /** Samples taken since the last reset (the first few are averaged evenly). */
  count: number;
  /** Consecutive samples far off the average on the same side: a clock that jumped. */
  jumps: number;
  jumpSign: number;
}

export function freshLeadAverage(): LeadAverage {
  return { value: null, count: 0, jumps: 0, jumpSign: 0 };
}

/**
 * Take one lead sample. The first 4 after a reset are averaged evenly (one late first sample cannot skew it); after
 * that each sample moves it by COOP_LEAD_AVERAGE_GAIN. Three samples in a row more than 150 ms off on the same side
 * mean the host's clock jumped (a short pause, a long frame): it moves there at once. Over 1.2 s off, at once too.
 */
export function updateLeadAverage(avg: LeadAverage, sample: number): void {
  if (!Number.isFinite(sample)) return;
  if (avg.value === null || Math.abs(sample - avg.value) > 1200) {
    avg.value = sample;
    avg.count = 1;
    avg.jumps = 0;
    avg.jumpSign = 0;
    return;
  }
  const off = sample - avg.value;
  if (Math.abs(off) > 150 && (avg.jumps === 0 || Math.sign(off) === avg.jumpSign)) {
    avg.jumps += 1;
    avg.jumpSign = Math.sign(off);
    if (avg.jumps >= 3) {
      avg.value = sample;
      avg.count = 1;
      avg.jumps = 0;
      avg.jumpSign = 0;
      return;
    }
  } else {
    avg.jumps = 0;
    avg.jumpSign = 0;
  }
  avg.count += 1;
  avg.value += off * (avg.count <= 4 ? 1 / avg.count : COOP_LEAD_AVERAGE_GAIN);
}

interface BufferedSnapshot {
  unwrappedTick: number;
  hostMs: number;
  receivedAt: number;
  snap: CoopWorldSnapshot;
}

/**
 * Host-tick-timeline snapshot interpolator (`~75ms` render delay) for Guest rendering at 60fps.
 *
 * - Maps `u16` Host `tick` onto a jitter-free 18 Hz simulation timeline via a smoothed clock offset,
 *   so Wi-Fi arrival jitter (`+-15ms`) never warps entity velocity or causes micro-rubberbanding.
 * - Smoothly `lerp`s remote squad ships (by `seat`), enemies (by `id`), boss, tanker, and asteroid `front`.
 * - Advances projectiles along `(vx, vy)` between 18 Hz snapshots so bolts never stutter.
 * - Deduplicates `fx` events by wrapping `u8 seq` so redundant FX ring entries across consecutive
 *   snapshots play once even across dropped/delayed frames.
 */
export class SnapshotInterpolator {
  private readonly interpDelayMs: number;
  private readonly maxExtrapolateMs: number;
  private readonly buffer: BufferedSnapshot[] = [];
  private readonly pendingFx: CoopSnapFx[] = [];
  private lastFxSeq: number | null = null;
  private lastRawTick: number | null = null;
  private lastSession = 0;
  private lastPushWallMs: number | null = null;
  private unwrappedTick = 0;
  private clockOffsetMs: number | null = null;
  private lastRenderHostMs: number | null = null;
  private lastSampleWallMs: number | null = null;
  /** The host's present as last estimated (`sample`), the wall time it was for, and since when the evidence says less. */
  private hostNowEstMs: number | null = null;
  private hostNowEstAtMs = 0;
  private hostNowLowSinceMs: number | null = null;
  private wasPaused = false;
  private wasExtrapolating = false;
  private needsReseam = false;
  private prevSampleHostMs: number | null = null;
  private readonly lastRenderedShips = new Map<CoopSeatIndex, { x: number; y: number }>();
  private readonly lastRenderedEnemies = new Map<number, { x: number; y: number }>();
  private lastRenderedBoss: { x: number; y: number } | null = null;
  private readonly shipSmoothOffset = new Map<CoopSeatIndex, { dx: number; dy: number }>();
  private readonly enemySmoothOffset = new Map<number, { dx: number; dy: number }>();
  private bossSmoothOffset: { dx: number; dy: number } = { dx: 0, dy: 0 };
  /** The bullet lead: the same running average the host keeps for this guest (see `updateLeadAverage`). */
  private readonly leadAvg: LeadAverage = freshLeadAverage();
  /** Goes up each time the lead is cleared, so its owner knows to start sampling afresh. */
  leadResets = 0;
  private bulletTracks: Array<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    atHostMs: number;
    bornHostMs: number;
    reachMs: number;
  }> = [];
  private shotBornHostMs = new WeakMap<CoopSnapShot, number>();
  /** Per new bullet, how soon after its birth it passes nearest this guest's ship (Infinity if it never comes near). */
  private shotReachMs = new WeakMap<CoopSnapShot, number>();
  /** This guest's own ship, where a new bullet's catch-up must be finished by. */
  private focus: { x: number; y: number } | null = null;

  constructor(opts?: { interpDelayMs?: number; maxExtrapolateMs?: number }) {
    this.interpDelayMs = opts?.interpDelayMs ?? 85;
    this.maxExtrapolateMs = opts?.maxExtrapolateMs ?? 65;
  }

  /** Feed `snap.hostElapsedMs - guestSentWallMs[ackSeq]` so enemy bullets align with Guest's 0ms local ship. */
  setAckHostOffset(offsetMs: number | null): void {
    if (offsetMs === null || !Number.isFinite(offsetMs)) {
      Object.assign(this.leadAvg, freshLeadAverage());
      this.leadResets += 1;
      return;
    }
    // The host keeps this same average (coop-flight.ts mirrorGuestLeads): it must change only the same way.
    updateLeadAverage(this.leadAvg, offsetMs);
  }

  /** Whether the bullet lead has a value (false after a reset, until the first sample). */
  hasAckHostOffset(): boolean {
    return this.leadAvg.value !== null;
  }

  private get ackHostOffsetMs(): number | null {
    return this.leadAvg.value;
  }

  reset(): void {
    this.resetTimeline();
    this.pendingFx.length = 0;
    this.lastFxSeq = null;
    this.lastRawTick = null;
    this.lastSession = 0;
    this.lastPushWallMs = null;
    this.unwrappedTick = 0;
  }

  private resetTimeline(): void {
    this.buffer.length = 0;
    this.clockOffsetMs = null;
    this.lastRenderHostMs = null;
    this.lastSampleWallMs = null;
    this.hostNowEstMs = null;
    this.hostNowLowSinceMs = null;
    this.wasPaused = false;
    this.wasExtrapolating = false;
    this.needsReseam = false;
    this.prevSampleHostMs = null;
    this.lastRenderedShips.clear();
    this.lastRenderedEnemies.clear();
    this.lastRenderedBoss = null;
    this.shipSmoothOffset.clear();
    this.enemySmoothOffset.clear();
    this.bossSmoothOffset = { dx: 0, dy: 0 };
    Object.assign(this.leadAvg, freshLeadAverage());
    this.leadResets += 1;
    this.bulletTracks.length = 0;
    this.shotBornHostMs = new WeakMap<CoopSnapShot, number>();
    this.shotReachMs = new WeakMap<CoopSnapShot, number>();
  }

  /** Where this guest's own ship is (null while it is down): new bullets heading for it finish catching up in time. */
  setFocus(x: number | null, y: number | null): void {
    this.focus = x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y) ? null : { x, y };
  }

  /**
   * How soon a bullet passes nearest this guest's ship, in ms: Infinity if it moves away, or passes further off than
   * the ship can fly (at 380 px/s, steering by keys) by then, plus 120 px. A bullet the ship could still get under
   * has to have caught up by the time it gets there, or at 150 ms or more each way it lands well behind the lead.
   */
  private reachOf(sh: CoopSnapShot): number {
    const f = this.focus;
    const v2 = sh.vx * sh.vx + sh.vy * sh.vy;
    if (!f || v2 < 1) return Infinity;
    const t = -((sh.x - f.x) * sh.vx + (sh.y - f.y) * sh.vy) / v2;
    if (t <= 0) return Infinity;
    const miss = Math.hypot(sh.x + sh.vx * t - f.x, sh.y + sh.vy * t - f.y);
    return miss > 120 + 380 * t ? Infinity : t * 1000;
  }

  latest(): CoopWorldSnapshot | null {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1]!.snap : null;
  }

  push(snap: CoopWorldSnapshot, nowMs: number): boolean {
    const safeNow = Number.isFinite(nowMs) ? nowMs : 0;
    const snapSession = snap.session ?? 0;
    if (snapSession !== 0 && this.lastSession !== 0 && snapSession !== this.lastSession) {
      this.reset();
    }

    const wallGap = this.lastPushWallMs !== null ? Math.max(0, safeNow - this.lastPushWallMs) : 0;

    if (this.lastRawTick !== null) {
      if (snap.tick === this.lastRawTick) {
        if (wallGap >= 1000) {
          this.reset();
          this.unwrappedTick = snap.tick;
        } else {
          return false;
        }
      } else if (!isNewerTick(this.lastRawTick, snap.tick)) {
        const backDelta = (this.lastRawTick - snap.tick + 65536) & 0xffff;
        if (backDelta <= 32 && wallGap < 1000) {
          return false;
        }
        // Host restarted ticks (e.g., Host page reload) outside the brief reorder window.
        this.reset();
        this.unwrappedTick = snap.tick;
      } else {
        const tickDelta = (snap.tick - this.lastRawTick + 65536) & 0xffff;
        if (tickDelta > 1000 && Math.abs(tickDelta * HOST_SNAP_PERIOD_MS - wallGap) > 15000) {
          this.resetTimeline();
          this.lastFxSeq = null;
          this.unwrappedTick = snap.tick;
        } else {
          this.unwrappedTick += tickDelta;
          if (wallGap > 2000 && !this.wasPaused && !snap.paused) {
            this.resetTimeline();
          }
          // Reset FX dedupe on host-tick gaps only (>8 ticks > 0.35s FX retention), never on wall-clock stalls/pauses.
          if (tickDelta > 8) {
            this.lastFxSeq = null;
          }
        }
      }
    } else {
      this.unwrappedTick = snap.tick;
    }

    this.lastRawTick = snap.tick;
    if (snapSession !== 0) this.lastSession = snapSession;
    this.lastPushWallMs = safeNow;

    let hostMs =
      snap.hostElapsedMs !== undefined && Number.isFinite(snap.hostElapsedMs)
        ? snap.hostElapsedMs
        : this.unwrappedTick * HOST_SNAP_PERIOD_MS;
    const prevBuf = this.buffer.length > 0 ? this.buffer[this.buffer.length - 1]! : null;
    if (prevBuf) {
      if (hostMs < prevBuf.hostMs - 5 || hostMs - prevBuf.hostMs > 5000) {
        this.resetTimeline();
      } else if (hostMs <= prevBuf.hostMs) {
        hostMs = prevBuf.hostMs + 1;
      }
    }

    const measuredOffset = safeNow - hostMs;
    if (snap.paused) {
      this.wasPaused = true;
      this.clockOffsetMs = measuredOffset;
    } else if (this.wasPaused) {
      this.wasPaused = false;
      this.clockOffsetMs = measuredOffset;
      this.lastSampleWallMs = safeNow;
    } else if (this.clockOffsetMs === null || Math.abs(measuredOffset - this.clockOffsetMs) > 1000) {
      this.clockOffsetMs = measuredOffset;
    } else {
      const gain = measuredOffset < this.clockOffsetMs ? 0.2 : 0.04;
      this.clockOffsetMs += (measuredOffset - this.clockOffsetMs) * gain;
    }

    if (this.wasExtrapolating) {
      this.needsReseam = true;
    }

    this.trackStraightBulletBirths(snap, hostMs, this.buffer.length === 0);

    this.buffer.push({
      unwrappedTick: this.unwrappedTick,
      hostMs,
      receivedAt: safeNow,
      snap,
    });
    while (this.buffer.length > 12) {
      this.buffer.shift();
    }

    for (const item of snap.fx) {
      if (this.lastFxSeq === null) {
        this.lastFxSeq = item.seq;
        this.pendingFx.push(item);
      } else {
        const delta = (item.seq - this.lastFxSeq + 256) & 0xff;
        if (delta > 0 && delta < 128) {
          this.lastFxSeq = item.seq;
          this.pendingFx.push(item);
        }
      }
    }
    if (this.pendingFx.length > 48) {
      this.pendingFx.splice(0, this.pendingFx.length - 48);
    }
    return true;
  }

  consumeNewFx(): CoopSnapFx[] {
    if (this.pendingFx.length === 0) return [];
    return this.pendingFx.splice(0, this.pendingFx.length);
  }

  sample(nowMs: number): CoopWorldSnapshot | null {
    const safeNow = Number.isFinite(nowMs) ? nowMs : 0;
    const count = this.buffer.length;
    if (count === 0 || this.clockOffsetMs === null) return null;
    if (count === 1) {
      const only = this.buffer[0]!;
      this.lastRenderHostMs = only.hostMs;
      this.prevSampleHostMs = only.hostMs;
      this.lastSampleWallMs = safeNow;
      this.wasExtrapolating = false;
      const dtSec = only.snap.paused ? 0 : clampNum((safeNow - only.receivedAt) / 1000, 0, 0.18);
      const out = this.advanceShots(only.snap, dtSec);
      this.recordRendered(out);
      return out;
    }

    const first = this.buffer[0]!;
    const last = this.buffer[count - 1]!;
    const presentHostMs = safeNow - this.clockOffsetMs;
    const targetHostMs = presentHostMs - this.interpDelayMs;
    const capHostMs = last.hostMs + this.maxExtrapolateMs;

    let wallDt = 1000 / 60;
    let renderHostMs: number;
    if (this.lastRenderHostMs === null || this.lastSampleWallMs === null) {
      renderHostMs = clampNum(targetHostMs, first.hostMs, capHostMs);
    } else {
      const rawWallGap = safeNow - this.lastSampleWallMs;
      wallDt = rawWallGap > 150 ? 1000 / 60 : clampNum(rawWallGap, 0, 100);
      if (targetHostMs - this.lastRenderHostMs > 1500) {
        renderHostMs = clampNum(targetHostMs, first.hostMs, capHostMs);
      } else {
        const lagMs = targetHostMs - this.lastRenderHostMs;
        let rate = 1.0;
        if (lagMs > 12) {
          // Ordinary jitter catches up gently (at most 25% fast). After a stall of the snapshots coming in (the render
          // clock waits `maxExtrapolateMs` past the last one), the world is far behind: up to 3x, so a second behind
          // is under 300 ms behind in about 0.7 s instead of 4.5.
          rate = 1.0 + Math.min(0.25, (lagMs - 12) / 140) + Math.min(1.75, Math.max(0, lagMs - 300) / 250);
        } else if (lagMs < -12) {
          rate = 1.0 - Math.min(0.15, (-lagMs - 12) / 140);
        }
        renderHostMs = clampNum(this.lastRenderHostMs + wallDt * rate, this.lastRenderHostMs, capHostMs);
      }
    }
    this.lastRenderHostMs = renderHostMs;
    this.lastSampleWallMs = safeNow;

    this.decaySmoothOffsets(wallDt);

    const recentHostNowMs = this.estimateHostNow(safeNow, last);
    const leadTargetHostMs =
      this.ackHostOffsetMs !== null
        ? clampNum(safeNow + this.ackHostOffsetMs, recentHostNowMs - 40, last.hostMs + STRAIGHT_LEAD_CAP_MS)
        : clampNum(presentHostMs, renderHostMs, last.hostMs + STRAIGHT_LEAD_CAP_MS);
    const straightShots = this.evaluateStraightShots(last.snap, last.hostMs, renderHostMs, leadTargetHostMs, recentHostNowMs);

    if (this.needsReseam && this.prevSampleHostMs !== null) {
      this.needsReseam = false;
      const reconstructedAtPrev = this.rawSampleAt(this.prevSampleHostMs, straightShots);
      this.captureExtrapolationSeam(reconstructedAtPrev, wallDt);
    }

    const raw = this.rawSampleAt(renderHostMs, straightShots);
    const smoothed = this.applySmoothOffsets(raw);

    this.prevSampleHostMs = renderHostMs;
    this.wasExtrapolating = renderHostMs > last.hostMs;
    this.recordRendered(smoothed);
    return smoothed;
  }

  private rawSampleAt(hostMs: number, straightShots: CoopSnapShot[]): CoopWorldSnapshot {
    const count = this.buffer.length;
    const first = this.buffer[0]!;
    const last = this.buffer[count - 1]!;

    if (hostMs <= first.hostMs) {
      return {
        ...first.snap,
        shots: this.mergeShotsWithSpecials(straightShots, first.snap, 0),
      };
    }

    if (hostMs <= last.hostMs) {
      let prev = first;
      let next = last;
      for (let i = 0; i < count - 1; i++) {
        const a = this.buffer[i]!;
        const b = this.buffer[i + 1]!;
        if (hostMs >= a.hostMs && hostMs <= b.hostMs) {
          prev = a;
          next = b;
          break;
        }
      }
      const span = Math.max(1, next.hostMs - prev.hostMs);
      const alpha = clampNum((hostMs - prev.hostMs) / span, 0, 1);
      const specialDtSec = next.snap.paused
        ? 0
        : clampNum((hostMs - next.hostMs) / 1000, -0.06, 0.08);
      return this.interpolatePair(
        prev.snap,
        next.snap,
        alpha,
        this.mergeShotsWithSpecials(straightShots, next.snap, specialDtSec),
      );
    }

    // Brief network jitter past `last.hostMs`: extrapolate smoothly up to `maxExtrapolateMs`, then hold.
    const prev = this.buffer[count - 2]!;
    const span = Math.max(16, last.hostMs - prev.hostMs);
    const overMs = clampNum(hostMs - last.hostMs, 0, this.maxExtrapolateMs);
    const extraAlpha = 1 + overMs / span;
    const specialDtSec = last.snap.paused ? 0 : clampNum(overMs / 1000, 0, 0.08);
    return this.interpolatePair(
      prev.snap,
      last.snap,
      extraAlpha,
      this.mergeShotsWithSpecials(straightShots, last.snap, specialDtSec),
    );
  }

  private stepSmoothVec(dx: number, dy: number, wallDt: number): { dx: number; dy: number } | null {
    const mag = Math.hypot(dx, dy);
    if (mag < 0.15) return null;
    const maxStep = (Math.max(1, wallDt) / (1000 / 60)) * 5.0;
    const expStep = mag * (1 - Math.exp(-wallDt / 55));
    const step = Math.min(mag, Math.min(maxStep, Math.max(expStep, 1.2)));
    const nextMag = mag - step;
    if (nextMag < 0.15) return null;
    const ratio = nextMag / mag;
    return { dx: dx * ratio, dy: dy * ratio };
  }

  private decaySmoothOffsets(wallDt: number): void {
    for (const [seat, off] of this.shipSmoothOffset) {
      const next = this.stepSmoothVec(off.dx, off.dy, wallDt);
      if (next) {
        off.dx = next.dx;
        off.dy = next.dy;
      } else {
        this.shipSmoothOffset.delete(seat);
      }
    }
    for (const [id, off] of this.enemySmoothOffset) {
      const next = this.stepSmoothVec(off.dx, off.dy, wallDt);
      if (next) {
        off.dx = next.dx;
        off.dy = next.dy;
      } else {
        this.enemySmoothOffset.delete(id);
      }
    }
    const nextBoss = this.stepSmoothVec(this.bossSmoothOffset.dx, this.bossSmoothOffset.dy, wallDt);
    if (nextBoss) {
      this.bossSmoothOffset = nextBoss;
    } else {
      this.bossSmoothOffset.dx = 0;
      this.bossSmoothOffset.dy = 0;
    }
  }

  private captureExtrapolationSeam(reconstructedPrev: CoopWorldSnapshot, wallDt: number): void {
    for (const s of reconstructedPrev.ships) {
      const prev = this.lastRenderedShips.get(s.seat);
      if (!prev || !s.alive) continue;
      const prevOff = this.shipSmoothOffset.get(s.seat);
      const totalDx = prev.x - s.x;
      const totalDy = prev.y - s.y;
      const mag = Math.hypot(totalDx - (prevOff?.dx ?? 0), totalDy - (prevOff?.dy ?? 0));
      if (mag > 0.5 && mag <= 96) {
        const next = this.stepSmoothVec(totalDx, totalDy, wallDt);
        if (next) this.shipSmoothOffset.set(s.seat, next);
      }
    }
    for (const e of reconstructedPrev.enemies) {
      const prev = this.lastRenderedEnemies.get(e.id);
      if (!prev) continue;
      const prevOff = this.enemySmoothOffset.get(e.id);
      const totalDx = prev.x - e.x;
      const totalDy = prev.y - e.y;
      const mag = Math.hypot(totalDx - (prevOff?.dx ?? 0), totalDy - (prevOff?.dy ?? 0));
      if (mag > 0.5 && mag <= 96) {
        const next = this.stepSmoothVec(totalDx, totalDy, wallDt);
        if (next) this.enemySmoothOffset.set(e.id, next);
      }
    }
    while (this.enemySmoothOffset.size > 64) {
      const oldestKey = this.enemySmoothOffset.keys().next().value;
      if (oldestKey === undefined) break;
      this.enemySmoothOffset.delete(oldestKey);
    }
    if (reconstructedPrev.boss && this.lastRenderedBoss) {
      const totalDx = this.lastRenderedBoss.x - reconstructedPrev.boss.x;
      const totalDy = this.lastRenderedBoss.y - reconstructedPrev.boss.y;
      const mag = Math.hypot(totalDx - this.bossSmoothOffset.dx, totalDy - this.bossSmoothOffset.dy);
      if (mag > 0.5 && mag <= 96) {
        const next = this.stepSmoothVec(totalDx, totalDy, wallDt);
        if (next) this.bossSmoothOffset = next;
      }
    }
  }

  private applySmoothOffsets(snap: CoopWorldSnapshot): CoopWorldSnapshot {
    const hasShipOff = this.shipSmoothOffset.size > 0;
    const hasEnemyOff = this.enemySmoothOffset.size > 0;
    const hasBossOff =
      snap.boss !== null && (this.bossSmoothOffset.dx !== 0 || this.bossSmoothOffset.dy !== 0);
    if (!hasShipOff && !hasEnemyOff && !hasBossOff) return snap;

    const ships = hasShipOff
      ? snap.ships.map((s) => {
          const off = this.shipSmoothOffset.get(s.seat);
          if (!off || !s.alive) return s;
          return {
            ...s,
            x: clampNum(s.x + off.dx, 12, COOP_WORLD_W - 12),
            y: clampNum(s.y + off.dy, 12, COOP_WORLD_H - 12),
          };
        })
      : snap.ships;

    const enemies = hasEnemyOff
      ? snap.enemies.map((e) => {
          const off = this.enemySmoothOffset.get(e.id);
          if (!off) return e;
          return { ...e, x: e.x + off.dx, y: e.y + off.dy };
        })
      : snap.enemies;

    const boss =
      hasBossOff && snap.boss
        ? {
            ...snap.boss,
            x: snap.boss.x + this.bossSmoothOffset.dx,
            y: snap.boss.y + this.bossSmoothOffset.dy,
          }
        : snap.boss;

    return { ...snap, ships, enemies, boss };
  }

  private recordRendered(snap: CoopWorldSnapshot): void {
    this.lastRenderedShips.clear();
    for (const s of snap.ships) {
      if (s.alive) this.lastRenderedShips.set(s.seat, { x: s.x, y: s.y });
    }
    this.lastRenderedEnemies.clear();
    for (const e of snap.enemies) {
      this.lastRenderedEnemies.set(e.id, { x: e.x, y: e.y });
    }
    this.lastRenderedBoss = snap.boss ? { x: snap.boss.x, y: snap.boss.y } : null;
  }

  private trackStraightBulletBirths(
    snap: CoopWorldSnapshot,
    hostMs: number,
    initialSnap: boolean,
  ): void {
    const used = new Set<number>();
    const nextTracks: Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      atHostMs: number;
      bornHostMs: number;
      reachMs: number;
    }> = [];

    for (const sh of snap.shots) {
      if (sh.kind === 'beam' || sh.kind === 'rocket') continue;
      if (initialSnap) {
        this.shotBornHostMs.set(sh, -Infinity);
        nextTracks.push({
          x: sh.x,
          y: sh.y,
          vx: sh.vx,
          vy: sh.vy,
          atHostMs: hostMs,
          bornHostMs: -Infinity,
          reachMs: Infinity,
        });
        continue;
      }

      let bestIdx = -1;
      let bestDist = 28;
      for (let i = 0; i < this.bulletTracks.length; i++) {
        if (used.has(i)) continue;
        const tr = this.bulletTracks[i]!;
        if (Math.abs(tr.vx - sh.vx) > 16 || Math.abs(tr.vy - sh.vy) > 16) continue;
        const dt = snap.paused ? 0 : (hostMs - tr.atHostMs) / 1000;
        // Straight bullets fly exactly as predicted, so one is still recognised after a gap in snapshots (a stalled
        // download) and is not caught up again from its muzzle.
        if (dt < -0.02 || dt > 3) continue;
        const px = tr.x + tr.vx * Math.max(0, dt);
        const py = tr.y + tr.vy * Math.max(0, dt);
        const d = Math.hypot(px - sh.x, py - sh.y);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }

      const bornHostMs = bestIdx >= 0 ? this.bulletTracks[bestIdx]!.bornHostMs : hostMs;
      const reachMs = bestIdx >= 0 ? this.bulletTracks[bestIdx]!.reachMs : this.reachOf(sh);
      if (bestIdx >= 0) used.add(bestIdx);
      this.shotBornHostMs.set(sh, bornHostMs);
      this.shotReachMs.set(sh, reachMs);
      nextTracks.push({
        x: sh.x,
        y: sh.y,
        vx: sh.vx,
        vy: sh.vy,
        atHostMs: hostMs,
        bornHostMs,
        reachMs,
      });
    }

    this.bulletTracks =
      nextTracks.length > SNAP_MAX_SHOTS ? nextTracks.slice(-SNAP_MAX_SHOTS) : nextTracks;
  }

  /**
   * The host's present: the fastest snapshot of the last 250 ms (its time plus how long ago it came in), carried
   * forward. The arrival clock follows the fastest arrivals slowly on purpose; this one is right again as soon as a
   * held-up batch of snapshots has come in, and 150 ms after the host's own clock fell behind in a long frame. It goes
   * forward at once, but back only when the snapshots have said so for 150 ms: a held-up batch arrives oldest first,
   * and for a moment its oldest are all there is. While the host is paused its clock stands still, and an estimate
   * not kept up for a while (this guest paused, or its tab hidden) starts afresh.
   */
  private estimateHostNow(nowMs: number, last: BufferedSnapshot): number {
    let windowMs = last.hostMs + Math.max(0, nowMs - last.receivedAt);
    for (let i = this.buffer.length - 2; i >= 0; i--) {
      const b = this.buffer[i]!;
      if (b.snap.paused || this.buffer[i + 1]!.snap.paused || nowMs - b.receivedAt > 250) break;
      windowMs = Math.max(windowMs, b.hostMs + (nowMs - b.receivedAt));
    }
    let estMs: number;
    if (last.snap.paused || this.hostNowEstMs === null || nowMs - this.hostNowEstAtMs > 250) {
      estMs = last.snap.paused ? last.hostMs : windowMs;
      this.hostNowLowSinceMs = null;
    } else {
      const carriedMs = this.hostNowEstMs + Math.max(0, nowMs - this.hostNowEstAtMs);
      if (windowMs >= carriedMs - 30) {
        estMs = Math.max(windowMs, carriedMs);
        this.hostNowLowSinceMs = null;
      } else if (this.hostNowLowSinceMs !== null && nowMs - this.hostNowLowSinceMs >= 150) {
        estMs = windowMs;
        this.hostNowLowSinceMs = null;
      } else {
        this.hostNowLowSinceMs ??= nowMs;
        estMs = carriedMs;
      }
    }
    this.hostNowEstMs = estMs;
    this.hostNowEstAtMs = nowMs;
    return estMs;
  }

  private evaluateStraightShots(
    lastSnap: CoopWorldSnapshot,
    lastHostMs: number,
    renderHostMs: number,
    leadTargetHostMs: number,
    recentHostNowMs: number,
  ): CoopSnapShot[] {
    const out: CoopSnapShot[] = [];
    // A new bullet appears at its muzzle as of the host's present (the render clock plus the interpolation delay, which
    // moves smoothly) and catches up to the lead: gently (at most 15% faster than it really flies), but finished by the
    // time it gets near this guest's ship (then at most 60% faster), so the ship and the bullet meet where they meet
    // on the host. While the render clock is still catching up after a stall, "the present" is the newest snapshots'
    // (less a little of their jitter), or bullets fired in the meantime would reach this ship hundreds of ms late.
    const presentStartMs = Math.max(renderHostMs + this.interpDelayMs, recentHostNowMs - 40);
    const startHostMs = Math.min(presentStartMs, Math.max(renderHostMs, leadTargetHostMs));
    for (const sh of lastSnap.shots) {
      if (sh.kind === 'beam' || sh.kind === 'rocket') continue;
      const born = this.shotBornHostMs.get(sh) ?? -Infinity;
      if (Number.isFinite(born) && startHostMs < born - 28) {
        continue;
      }
      if (lastSnap.paused) {
        out.push(sh);
        continue;
      }
      const leadMs = Math.max(0, leadTargetHostMs - startHostMs);
      const gentleMs = Math.max(420, leadMs / 0.15);
      const reach = this.shotReachMs.get(sh) ?? Infinity;
      const rampMs = Number.isFinite(reach) ? Math.min(gentleMs, Math.max(leadMs / 0.6, reach * 0.7)) : gentleMs;
      const ramp = Number.isFinite(born) ? clampNum((startHostMs - (born - 28)) / rampMs, 0, 1) : 1;
      const evalHostMs = startHostMs + ramp * (leadTargetHostMs - startHostMs);
      const dtSec = clampNum((evalHostMs - lastHostMs) / 1000, -0.14, STRAIGHT_LEAD_CAP_MS / 1000);
      out.push(
        dtSec === 0
          ? sh
          : {
              ...sh,
              x: sh.x + sh.vx * dtSec,
              y: sh.y + sh.vy * dtSec,
            },
      );
    }
    return out;
  }

  private mergeShotsWithSpecials(
    straightShots: readonly CoopSnapShot[],
    pairSnap: CoopWorldSnapshot,
    specialDtSec: number,
  ): CoopSnapShot[] {
    let hasSpecial = false;
    for (const sh of pairSnap.shots) {
      if (sh.kind === 'beam' || sh.kind === 'rocket') {
        hasSpecial = true;
        break;
      }
    }
    if (!hasSpecial) return straightShots as CoopSnapShot[];
    const merged = straightShots.slice();
    for (const sh of pairSnap.shots) {
      if (sh.kind === 'beam') {
        merged.push(sh);
      } else if (sh.kind === 'rocket') {
        merged.push(
          specialDtSec === 0
            ? sh
            : {
                ...sh,
                x: sh.x + sh.vx * specialDtSec,
                y: sh.y + sh.vy * specialDtSec,
              },
        );
      }
    }
    return merged;
  }

  private advanceShots(snap: CoopWorldSnapshot, dtSec: number): CoopWorldSnapshot {
    if (dtSec === 0 || snap.paused) return snap;
    const rocketDt = clampNum(dtSec, 0, 0.065);
    return {
      ...snap,
      shots: snap.shots.map((sh) => {
        if (sh.kind === 'beam') return sh;
        const step = sh.kind === 'rocket' ? rocketDt : dtSec;
        return {
          ...sh,
          x: sh.x + sh.vx * step,
          y: sh.y + sh.vy * step,
        };
      }),
    };
  }

  private interpolatePair(
    a: CoopWorldSnapshot,
    b: CoopWorldSnapshot,
    alpha: number,
    shotsOverride: CoopSnapShot[],
  ): CoopWorldSnapshot {
    const prevShips = new Map<CoopSeatIndex, CoopSnapShip>();
    for (const s of a.ships) prevShips.set(s.seat, s);

    const ships: CoopSnapShip[] = b.ships.map((nextShip) => {
      const prevShip = prevShips.get(nextShip.seat);
      if (!prevShip || !prevShip.alive || !nextShip.alive) return nextShip;
      if (Math.hypot(nextShip.x - prevShip.x, nextShip.y - prevShip.y) > 240) return nextShip;
      return {
        ...nextShip,
        x: clampNum(lerpScalar(prevShip.x, nextShip.x, alpha), 12, COOP_WORLD_W - 12),
        y: clampNum(lerpScalar(prevShip.y, nextShip.y, alpha), 12, COOP_WORLD_H - 12),
        lean: clampNum(lerpScalar(prevShip.lean, nextShip.lean, Math.min(1, alpha)), -1, 1),
        orbit: lerpAngle(prevShip.orbit, nextShip.orbit, alpha),
      };
    });

    const prevEnemies = new Map<number, CoopSnapEnemy>();
    for (const e of a.enemies) prevEnemies.set(e.id, e);

    const enemies: CoopSnapEnemy[] = b.enemies.map((nextEnemy) => {
      const prevEnemy = prevEnemies.get(nextEnemy.id);
      if (!prevEnemy || prevEnemy.kind !== nextEnemy.kind || nextEnemy.hp > prevEnemy.hp) {
        return nextEnemy;
      }
      if (Math.hypot(nextEnemy.x - prevEnemy.x, nextEnemy.y - prevEnemy.y) > 180) return nextEnemy;
      return {
        ...nextEnemy,
        x: lerpScalar(prevEnemy.x, nextEnemy.x, alpha),
        y: lerpScalar(prevEnemy.y, nextEnemy.y, alpha),
        rot: lerpAngle(prevEnemy.rot, nextEnemy.rot, Math.min(1, alpha)),
      };
    });

    let boss: CoopSnapBoss | null = b.boss;
    if (a.boss && b.boss && a.boss.kind === b.boss.kind) {
      boss = {
        ...b.boss,
        x: lerpScalar(a.boss.x, b.boss.x, alpha),
        y: lerpScalar(a.boss.y, b.boss.y, alpha),
        age: lerpScalar(a.boss.age, b.boss.age, alpha),
      };
    }

    let tanker: CoopSnapTanker | null = b.tanker;
    if (a.tanker && b.tanker) {
      tanker = {
        ...b.tanker,
        x: lerpScalar(a.tanker.x, b.tanker.x, alpha),
        y: lerpScalar(a.tanker.y, b.tanker.y, alpha),
        drogueX: lerpScalar(a.tanker.drogueX, b.tanker.drogueX, alpha),
        drogueY: lerpScalar(a.tanker.drogueY, b.tanker.drogueY, alpha),
        fuel: clampNum(lerpScalar(a.tanker.fuel, b.tanker.fuel, Math.min(1, alpha)), 0, 1),
        strain: clampNum(lerpScalar(a.tanker.strain, b.tanker.strain, Math.min(1, alpha)), 0, 1),
      };
    }

    let field: CoopSnapField | null = b.field;
    if (
      a.field &&
      b.field &&
      a.field.seed === b.field.seed &&
      a.field.front !== null &&
      b.field.front !== null
    ) {
      field = {
        ...b.field,
        front: lerpScalar(a.field.front, b.field.front, alpha),
      };
    }

    return {
      ...b,
      ships,
      enemies,
      boss,
      tanker,
      field,
      shots: shotsOverride,
    };
  }
}
