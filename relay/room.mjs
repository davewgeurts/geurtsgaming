// Pure, transport-agnostic Co-op Room state machine shared by:
// - `relay/worker.mjs` (single Cloudflare Worker + SQLite Durable Object running in `wrangler dev` locally & prod)
// - `tests/relay.test.ts` (deterministic Node unit, hibernation rehydration, late-close reconnect, and alarm tests)

export const PROTOCOL_VERSION = 1;

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;
// Largest multiple of 31 <= 256 (31 * 8 = 248) for rejection sampling with zero modulo bias.
const UNBIASED_BYTE_LIMIT = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;

export const MAX_PILOT_SEATS = 4;
export const HOST_MAX_BYTES = 8_192;
export const GUEST_MAX_BYTES = 2_048;
export const GUEST_MAX_MESSAGES_PER_SEC = 35;
export const GUEST_FLOOD_DISCONNECT_PER_SEC = 90;
export const HOST_MAX_MESSAGES_PER_SEC = 65;
export const HOST_FLOOD_DISCONNECT_PER_SEC = 160;
// Backwards-compatible aliases matching guest limits
export const MAX_MESSAGES_PER_SEC = GUEST_MAX_MESSAGES_PER_SEC;
export const FLOOD_DISCONNECT_PER_SEC = GUEST_FLOOD_DISCONNECT_PER_SEC;
export const RECONNECT_GRACE_MS = 30_000;
export const LOBBY_TIMEOUT_MS = 10 * 60 * 1_000;
export const ROOM_MAX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const MAX_KICKED_ENTRIES = 32;

export const BIN_INPUT = 0x01;
export const BIN_SNAP = 0x02;

const CALLSIGN_PREFIXES = [
  'NOVA', 'FALCON', 'VIPER', 'STAR', 'ORION', 'LYRA',
  'VEGA', 'COMET', 'APEX', 'DRIFT', 'PULSE', 'SOLAR',
];
export const VALID_CALLSIGN_RE =
  /^(NOVA|FALCON|VIPER|STAR|ORION|LYRA|VEGA|COMET|APEX|DRIFT|PULSE|SOLAR)-[1-9]$/;

const SAFE_EVENT_KIND_RE = /^[a-z0-9-]{1,28}$/;
const SAFE_EVENT_KEY_RE = /^[a-zA-Z0-9_]{1,24}$/;

const PROD_ORIGIN_RE = /^https:\/\/(?:www\.)?geurtsgaming\.com$/i;
const DEV_ORIGIN_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|[a-z0-9-]+\.(?:localdev|local)|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?$/i;

export function isAllowedRelayOrigin(origin, allowDevOrigins = false) {
  if (!origin) return allowDevOrigins;
  const trimmed = String(origin).trim();
  if (PROD_ORIGIN_RE.test(trimmed)) return true;
  return Boolean(allowDevOrigins && DEV_ORIGIN_RE.test(trimmed));
}

/**
 * Generate a 6-character unambiguous room code using rejection sampling (`byte < 248`)
 * so every character in the 31-symbol alphabet is equally likely.
 */
export function generateRoomCode(randomBytesFn) {
  let out = '';
  while (out.length < CODE_LENGTH) {
    const bytes = randomBytesFn
      ? randomBytesFn(16)
      : crypto.getRandomValues(new Uint8Array(16));
    for (let i = 0; i < bytes.length && out.length < CODE_LENGTH; i++) {
      const b = bytes[i];
      if (b < UNBIASED_BYTE_LIMIT) {
        out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      }
    }
  }
  return out;
}

export function formatRoomCode(code) {
  const clean = normalizeRoomCode(code);
  if (clean.length === CODE_LENGTH) return `${clean.slice(0, 3)}-${clean.slice(3)}`;
  return clean;
}

export function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g, '')
    .slice(0, CODE_LENGTH);
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * One-way per-room tag hash (FNV-1a 64-bit hex) so a kicked tab's ephemeral `cid` can be
 * recognized for the life of the lobby without storing raw browser identifiers or IP addresses.
 */
function hashRoomTag(roomCode, value) {
  if (!value) return '';
  const input = `${roomCode}:${value}`;
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function addCappedSet(set, item, cap = MAX_KICKED_ENTRIES) {
  if (!item) return;
  if (set.has(item)) set.delete(item);
  while (set.size >= cap) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
  set.add(item);
}

export function sanitizeCallsign(candidate, fallbackIndex = 0) {
  if (typeof candidate === 'string') {
    const upper = candidate.trim().toUpperCase();
    if (VALID_CALLSIGN_RE.test(upper)) return upper;
  }
  const prefix = CALLSIGN_PREFIXES[Math.abs(fallbackIndex) % CALLSIGN_PREFIXES.length];
  const digit = (Math.abs(fallbackIndex) % 9) + 1;
  return `${prefix}-${digit}`;
}

/**
 * Strip any free-text strings from host `event` / `host-paused` frames so a modified host page
 * can never turn the relay into an unmoderated text chat channel. Only `kind` (kebab-case enum)
 * and finite numbers, booleans, null, or short numeric/boolean arrays are forwarded.
 */
export function sanitizeHostEvent(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'host-paused') {
    return { type: 'host-paused', paused: msg.paused !== false };
  }
  if (msg.type !== 'event') return null;
  if (typeof msg.kind !== 'string' || !SAFE_EVENT_KIND_RE.test(msg.kind)) return null;

  const clean = { type: 'event', kind: msg.kind };
  for (const [k, v] of Object.entries(msg)) {
    if (k === 'type' || k === 'kind') continue;
    if (!SAFE_EVENT_KEY_RE.test(k)) continue;
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) {
      clean[k] = v;
    } else if (
      Array.isArray(v) &&
      v.length <= 16 &&
      v.every((item) => (typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean')
    ) {
      clean[k] = v.slice();
    }
  }
  return clean;
}

function refuseConn(conn, closeCode, reason, detail = '') {
  try {
    conn.setAttachment?.(null);
  } catch {
    /* ignore */
  }
  try {
    conn.sendText(JSON.stringify({ type: 'refused', reason }));
  } catch {
    /* ignore */
  }
  try {
    conn.close(closeCode, detail || reason);
  } catch {
    /* ignore */
  }
}

/**
 * Single room state machine. Holds ZERO IP addresses and ZERO personal data — only seat numbers,
 * preset callsigns, transient reconnect tokens, monotonic socket generation counters (`gen`),
 * and live socket handles (`{ sendText(str), sendBinary(u8), close(code, reason), setAttachment?(obj) }`).
 */
export class CoopRoom {
  constructor(code, opts = {}) {
    const now = opts.now ?? Date.now();
    this.code = normalizeRoomCode(code);
    this.createdAt = now;
    this.lastActivityAt = now;
    this.tvMode = Boolean(opts.tvMode);
    this.locked = false;
    this.startedAt = null;
    this.closed = false;
    this.dirty = false;
    this.nextGen = 1;

    /** Host socket wrapper (seat 0 in standard mode, or seat -1 in TV spectator mode). */
    this.hostConn = null;
    this.hostToken = null;
    this.hostGen = 0;
    this.hostDisconnectedAt = null;

    /** Bounded kicked sets (tokens + one-way hashed tab `cid`s; never raw IPs or raw browser IDs). */
    this.kickedTokens = new Set();
    this.kickedCidHashes = new Set();

    /** Map<number, { seat: number, callsign: string, ready: boolean, isHost: boolean, token: string, gen: number, cidHash: string, conn: object | null, disconnectedAt: number | null }> */
    this.seats = new Map();

    /** Map<object, { role: 'host' | 'guest', seat: number, token: string, gen: number, windowStartMs: number, windowCount: number }> */
    this.conns = new Map();
  }

  /** Serialize room metadata for Durable Object `ctx.storage.put('room', ...)` (zero IPs, zero raw IDs). */
  toPersistedState() {
    return {
      code: this.code,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      tvMode: this.tvMode,
      locked: this.locked,
      startedAt: this.startedAt,
      closed: this.closed,
      nextGen: this.nextGen,
      hostToken: this.hostToken,
      hostGen: this.hostGen,
      hostDisconnectedAt: this.hostDisconnectedAt,
      kickedTokens: Array.from(this.kickedTokens),
      kickedCidHashes: Array.from(this.kickedCidHashes),
      seats: Array.from(this.seats.values()).map((s) => ({
        seat: s.seat,
        callsign: s.callsign,
        ready: s.ready,
        isHost: s.isHost,
        token: s.token,
        gen: s.gen || 0,
        ...(s.cidHash ? { cidHash: s.cidHash } : {}),
        disconnectedAt: s.disconnectedAt,
      })),
    };
  }

  /** Rebuild a `CoopRoom` instance from persisted storage when waking from DO hibernation or deploy. */
  static fromPersisted(data) {
    const room = new CoopRoom(data.code, { now: data.createdAt, tvMode: data.tvMode });
    room.createdAt = data.createdAt;
    room.lastActivityAt = data.lastActivityAt ?? data.createdAt;
    room.tvMode = Boolean(data.tvMode);
    room.locked = Boolean(data.locked);
    room.startedAt = data.startedAt ?? null;
    room.closed = Boolean(data.closed);
    room.nextGen = typeof data.nextGen === 'number' && data.nextGen > 0 ? data.nextGen : 1;
    room.hostToken = data.hostToken ?? null;
    room.hostGen = typeof data.hostGen === 'number' ? data.hostGen : 0;
    room.hostDisconnectedAt = data.hostDisconnectedAt ?? null;
    room.kickedTokens = new Set(Array.isArray(data.kickedTokens) ? data.kickedTokens.slice(-MAX_KICKED_ENTRIES) : []);
    room.kickedCidHashes = new Set(
      Array.isArray(data.kickedCidHashes) ? data.kickedCidHashes.slice(-MAX_KICKED_ENTRIES) : []
    );
    if (Array.isArray(data.seats)) {
      for (const s of data.seats) {
        room.seats.set(s.seat, {
          seat: s.seat,
          callsign: s.callsign,
          ready: Boolean(s.ready),
          isHost: Boolean(s.isHost),
          token: s.token,
          gen: typeof s.gen === 'number' ? s.gen : 0,
          cidHash: typeof s.cidHash === 'string' ? s.cidHash : '',
          conn: null,
          disconnectedAt: s.disconnectedAt ?? null,
        });
      }
    }
    room.dirty = false;
    return room;
  }

  /**
   * Re-bind a live hibernated WebSocket (`ctx.getWebSockets()`) ONLY during cold storage wake-up,
   * verifying both `token` AND socket generation `gen` so a superseded socket can never re-bind!
   */
  reattachSocket(conn, attachment, now = Date.now()) {
    if (!attachment || typeof attachment.token !== 'string' || !attachment.token) return false;
    const attGen = typeof attachment.gen === 'number' ? attachment.gen : 0;

    if (this.hostToken && attachment.token === this.hostToken) {
      if (this.hostGen > 0 && attGen !== this.hostGen) return false;
      const hostSeat = this.tvMode ? -1 : 0;
      this.hostConn = conn;
      this.hostDisconnectedAt = null;
      if (!this.tvMode && this.seats.has(0)) {
        const s0 = this.seats.get(0);
        s0.conn = conn;
        s0.disconnectedAt = null;
      }
      this.conns.set(conn, {
        role: 'host',
        seat: hostSeat,
        token: this.hostToken,
        gen: this.hostGen,
        windowStartMs: now,
        windowCount: 0,
      });
      return true;
    }

    for (const info of this.seats.values()) {
      if (info.token === attachment.token && !info.isHost) {
        if (info.gen > 0 && attGen !== info.gen) return false;
        info.conn = conn;
        info.disconnectedAt = null;
        this.conns.set(conn, {
          role: 'guest',
          seat: info.seat,
          token: info.token,
          gen: info.gen,
          windowStartMs: now,
          windowCount: 0,
        });
        return true;
      }
    }
    return false;
  }

  /**
   * After rebuilding from storage (e.g. following a Worker deploy or relay restart where all TCP
   * sockets were dropped without firing `webSocketClose`), start the 30s grace clock for any
   * host or guest seat that has no live socket attached.
   */
  reconcileMissingSockets(now = Date.now()) {
    if (this.closed || !this.hostToken) return false;
    let changed = false;

    if (!this.hostConn && this.hostDisconnectedAt === null) {
      this.hostDisconnectedAt = now;
      if (!this.tvMode && this.seats.has(0)) {
        const s0 = this.seats.get(0);
        s0.conn = null;
        s0.disconnectedAt = now;
      }
      changed = true;
      this.broadcastJson({ type: 'host-reconnecting', graceMs: RECONNECT_GRACE_MS });
    }

    for (const info of this.seats.values()) {
      if (!info.isHost && !info.conn && info.disconnectedAt === null) {
        info.disconnectedAt = now;
        changed = true;
      }
    }

    if (changed) {
      this.dirty = true;
      this.broadcastLobby();
    }
    return changed;
  }

  /** Compute the next timestamp (`ms`) at which a Durable Object `alarm()` must wake this room. */
  nextAlarmAt() {
    if (this.closed || !this.hostToken) return null;
    let earliest = this.startedAt
      ? this.createdAt + ROOM_MAX_LIFETIME_MS
      : Math.min(this.lastActivityAt + LOBBY_TIMEOUT_MS, this.createdAt + ROOM_MAX_LIFETIME_MS);

    if (!this.hostConn && this.hostDisconnectedAt !== null) {
      earliest = Math.min(earliest, this.hostDisconnectedAt + RECONNECT_GRACE_MS);
    }
    for (const info of this.seats.values()) {
      if (!info.isHost && !info.conn && info.disconnectedAt !== null) {
        earliest = Math.min(earliest, info.disconnectedAt + RECONNECT_GRACE_MS);
      }
    }
    return earliest;
  }

  isExpired(now = Date.now()) {
    if (this.closed) return true;
    if (!this.hostToken) return false;
    if (!this.startedAt && now - this.lastActivityAt >= LOBBY_TIMEOUT_MS) return true;
    if (now - this.createdAt >= ROOM_MAX_LIFETIME_MS) return true;
    return false;
  }

  /** Enforce room expiry and 30s host/guest disconnect grace windows (called on connect & DO `alarm()`). */
  prune(now = Date.now()) {
    if (this.closed) return true;
    if (this.isExpired(now)) {
      this.closeRoom('expired');
      return true;
    }
    if (!this.hostConn && this.hostDisconnectedAt !== null && now - this.hostDisconnectedAt >= RECONNECT_GRACE_MS) {
      this.closeRoom('host-left');
      return true;
    }
    let changed = false;
    for (const [seatNum, info] of this.seats.entries()) {
      if (!info.isHost && !info.conn && info.disconnectedAt !== null && now - info.disconnectedAt >= RECONNECT_GRACE_MS) {
        this.seats.delete(seatNum);
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.broadcastLobby();
    }
    return false;
  }

  publicSeats() {
    return Array.from(this.seats.values())
      .sort((a, b) => a.seat - b.seat)
      .map((s) => ({
        seat: s.seat,
        callsign: s.callsign,
        ready: s.ready,
        isHost: s.isHost,
        connected: Boolean(s.conn),
      }));
  }

  /**
   * Attach a WebSocket connection (`conn`) to this room.
   * @param {object} conn - `{ sendText(jsonStr), sendBinary(uint8), close(code, reason), setAttachment?(obj) }`
   * @param {object} params - `{ role?: 'host' | 'guest', callsign?: string, token?: string, tvMode?: boolean, clientId?: string, now?: number }`
   */
  connect(conn, params = {}) {
    const now = params.now ?? Date.now();
    if (this.prune(now)) {
      refuseConn(conn, 4004, 'expired', 'Room expired');
      return { ok: false, reason: 'expired', error: 'Room expired' };
    }

    const token = typeof params.token === 'string' ? params.token.trim() : '';
    const clientId = typeof params.clientId === 'string' ? params.clientId.trim().slice(0, 64) : '';
    const cidHash = clientId ? hashRoomTag(this.code, clientId) : '';

    // 0. Reject kicked tokens or kicked per-tab `cid` hashes
    if ((token && this.kickedTokens.has(token)) || (cidHash && this.kickedCidHashes.has(cidHash))) {
      refuseConn(conn, 4003, 'kicked', 'Removed from lobby');
      return { ok: false, reason: 'kicked', error: 'Removed from lobby' };
    }

    // 1. Reconnecting host (within 30s grace or replacing a silent/stale old socket)
    if (token && this.hostToken && token === this.hostToken) {
      if (this.hostConn && this.hostConn !== conn) {
        const oldHost = this.hostConn;
        this.conns.delete(oldHost);
        refuseConn(oldHost, 4001, 'replaced', 'Replaced by reconnect');
      }
      const wasDisconnected = this.hostDisconnectedAt !== null;
      const gen = this.nextGen++;
      this.hostGen = gen;
      this.hostConn = conn;
      this.hostDisconnectedAt = null;
      const hostSeat = this.tvMode ? -1 : 0;
      if (!this.tvMode && this.seats.has(0)) {
        const s0 = this.seats.get(0);
        s0.conn = conn;
        s0.gen = gen;
        s0.disconnectedAt = null;
      }
      if (!this.startedAt) this.lastActivityAt = now;
      this.dirty = true;
      conn.setAttachment?.({ token: this.hostToken, role: 'host', seat: hostSeat, gen });
      this.conns.set(conn, {
        role: 'host',
        seat: hostSeat,
        token: this.hostToken,
        gen,
        windowStartMs: now,
        windowCount: 0,
      });
      this.sendWelcome(conn, 'host', hostSeat, this.hostToken);
      if (wasDisconnected) {
        this.broadcastJson({ type: 'host-resumed' }, conn);
      }
      this.broadcastLobby();
      return { ok: true, role: 'host', seat: hostSeat, token: this.hostToken };
    }

    // 2. Reconnecting guest with valid seat token (works in both lobby and locked game)
    if (token) {
      for (const info of this.seats.values()) {
        if (info.token === token && !info.isHost) {
          if (info.conn && info.conn !== conn) {
            const oldGuest = info.conn;
            this.conns.delete(oldGuest);
            refuseConn(oldGuest, 4001, 'replaced', 'Replaced by reconnect');
          }
          const gen = this.nextGen++;
          info.gen = gen;
          info.conn = conn;
          info.disconnectedAt = null;
          if (!this.startedAt) this.lastActivityAt = now;
          this.dirty = true;
          conn.setAttachment?.({ token: info.token, role: 'guest', seat: info.seat, gen });
          this.conns.set(conn, {
            role: 'guest',
            seat: info.seat,
            token: info.token,
            gen,
            windowStartMs: now,
            windowCount: 0,
          });
          this.sendWelcome(conn, 'guest', info.seat, info.token);
          this.broadcastLobby();
          if (!this.hostConn && this.hostDisconnectedAt !== null) {
            const remaining = Math.max(1, RECONNECT_GRACE_MS - (now - this.hostDisconnectedAt));
            conn.sendText(JSON.stringify({ type: 'host-reconnecting', graceMs: remaining }));
          }
          return { ok: true, role: 'guest', seat: info.seat, token: info.token };
        }
      }

      // Any non-empty token that matched nothing is stale/expired — NEVER open a fresh room for it!
      refuseConn(conn, 4004, 'expired', 'Session expired');
      return { ok: false, reason: 'expired', error: 'Session expired' };
    }

    // 3. Initial host connection creating the room
    if (!this.hostToken && params.role === 'host') {
      this.tvMode = Boolean(params.tvMode);
      const gen = this.nextGen++;
      this.hostToken = randomToken();
      this.hostGen = gen;
      this.hostConn = conn;
      this.hostDisconnectedAt = null;
      this.lastActivityAt = now;
      this.dirty = true;
      const hostSeat = this.tvMode ? -1 : 0;
      if (!this.tvMode) {
        const callsign = sanitizeCallsign(params.callsign, 0);
        this.seats.set(0, {
          seat: 0,
          callsign,
          ready: true,
          isHost: true,
          token: this.hostToken,
          gen,
          cidHash: '',
          conn,
          disconnectedAt: null,
        });
      }
      conn.setAttachment?.({ token: this.hostToken, role: 'host', seat: hostSeat, gen });
      this.conns.set(conn, {
        role: 'host',
        seat: hostSeat,
        token: this.hostToken,
        gen,
        windowStartMs: now,
        windowCount: 0,
      });
      this.sendWelcome(conn, 'host', hostSeat, this.hostToken);
      this.broadcastLobby();
      return { ok: true, role: 'host', seat: hostSeat, token: this.hostToken };
    }

    // A second `role=host` without a valid hostToken cannot hijack an existing room
    if (params.role === 'host' && this.hostToken) {
      refuseConn(conn, 4003, 'already-hosted', 'Room already has a host');
      return { ok: false, reason: 'already-hosted', error: 'Room already has a host' };
    }

    // Cannot join as guest if no host has initialized the room or if locked
    if (!this.hostToken) {
      refuseConn(conn, 4004, 'not-found', 'Room not found');
      return { ok: false, reason: 'not-found', error: 'Room not found' };
    }
    if (this.locked) {
      refuseConn(conn, 4002, 'started', 'Game already started');
      return { ok: false, reason: 'started', error: 'Game already started' };
    }

    // Find lowest open pilot seat (0..3 in tvMode, 1..3 in standard mode)
    const firstGuestSeat = this.tvMode ? 0 : 1;
    let assignedSeat = -1;
    for (let s = firstGuestSeat; s < MAX_PILOT_SEATS; s++) {
      if (!this.seats.has(s)) {
        assignedSeat = s;
        break;
      }
    }
    if (assignedSeat === -1) {
      refuseConn(conn, 4005, 'full', 'Room is full');
      return { ok: false, reason: 'full', error: 'Room is full' };
    }

    const guestToken = randomToken();
    const gen = this.nextGen++;
    const callsign = this.uniqueCallsign(params.callsign, assignedSeat);
    this.lastActivityAt = now;
    this.dirty = true;
    this.seats.set(assignedSeat, {
      seat: assignedSeat,
      callsign,
      ready: false,
      isHost: false,
      token: guestToken,
      gen,
      cidHash,
      conn,
      disconnectedAt: null,
    });
    conn.setAttachment?.({ token: guestToken, role: 'guest', seat: assignedSeat, gen });
    this.conns.set(conn, {
      role: 'guest',
      seat: assignedSeat,
      token: guestToken,
      gen,
      windowStartMs: now,
      windowCount: 0,
    });
    this.sendWelcome(conn, 'guest', assignedSeat, guestToken);
    this.broadcastLobby();
    if (!this.hostConn && this.hostDisconnectedAt !== null) {
      const remaining = Math.max(1, RECONNECT_GRACE_MS - (now - this.hostDisconnectedAt));
      conn.sendText(JSON.stringify({ type: 'host-reconnecting', graceMs: remaining }));
    }
    return { ok: true, role: 'guest', seat: assignedSeat, token: guestToken };
  }

  uniqueCallsign(preferred, fallbackSeed) {
    const taken = new Set(Array.from(this.seats.values()).map((s) => s.callsign));
    const base = sanitizeCallsign(preferred, fallbackSeed);
    if (!taken.has(base)) return base;
    for (let i = 0; i < CALLSIGN_PREFIXES.length * 9; i++) {
      const candidate = sanitizeCallsign('', fallbackSeed + i + 1);
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }

  sendWelcome(conn, role, seat, token) {
    conn.sendText(
      JSON.stringify({
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        code: this.code,
        formattedCode: formatRoomCode(this.code),
        role,
        seat,
        token,
        tvMode: this.tvMode,
        locked: this.locked,
        seats: this.publicSeats(),
      })
    );
  }

  broadcastLobby() {
    this.broadcastJson({
      type: 'lobby',
      code: this.code,
      formattedCode: formatRoomCode(this.code),
      tvMode: this.tvMode,
      locked: this.locked,
      hostConnected: Boolean(this.hostConn),
      seats: this.publicSeats(),
    });
  }

  broadcastJson(obj, excludeConn = null) {
    const raw = JSON.stringify(obj);
    for (const c of this.conns.keys()) {
      if (c === excludeConn) continue;
      try {
        c.sendText(raw);
      } catch {
        /* ignore broken socket */
      }
    }
  }

  checkRateAndSize(conn, meta, byteLength, now) {
    // Always count incoming frames against the rate window first (including oversize ones!)
    if (now - meta.windowStartMs >= 1_000) {
      meta.windowStartMs = now;
      meta.windowCount = 0;
      meta.warnedRateLimit = false;
    }
    meta.windowCount += 1;
    const isHost = meta.role === 'host';
    const maxPerSec = isHost ? HOST_MAX_MESSAGES_PER_SEC : GUEST_MAX_MESSAGES_PER_SEC;
    const floodDisconnect = isHost ? HOST_FLOOD_DISCONNECT_PER_SEC : GUEST_FLOOD_DISCONNECT_PER_SEC;

    if (meta.windowCount > floodDisconnect) {
      try {
        conn.close(1008, 'Rate limit exceeded');
      } catch {
        /* ignore */
      }
      this.disconnect(conn, now);
      return false;
    }
    if (meta.windowCount > maxPerSec) {
      if (!meta.warnedRateLimit) {
        meta.warnedRateLimit = true;
        try {
          conn.sendText(JSON.stringify({ type: 'error', reason: 'rate-limited' }));
        } catch {
          /* ignore */
        }
      }
      return false;
    }

    const maxBytes = isHost ? HOST_MAX_BYTES : GUEST_MAX_BYTES;
    if (byteLength > maxBytes) {
      try {
        conn.sendText(JSON.stringify({ type: 'error', reason: 'message-too-large', maxBytes }));
      } catch {
        /* ignore */
      }
      // Never kill the host (and 4 players' game) over an isolated oversize frame — drop it and report error.
      if (meta.role !== 'host') {
        try {
          conn.close(1009, 'Message too large');
        } catch {
          /* ignore */
        }
        this.disconnect(conn, now);
      }
      return false;
    }
    return true;
  }

  /** Handle an incoming binary frame (`Uint8Array`). Zero storage writes in this hot loop. */
  handleBinary(conn, bytes, now = Date.now()) {
    const meta = this.conns.get(conn);
    if (!meta || this.closed || !(bytes instanceof Uint8Array) || bytes.byteLength < 2) return;
    if (!this.checkRateAndSize(conn, meta, bytes.byteLength, now)) return;

    const frameType = bytes[0];
    if (frameType === BIN_INPUT && meta.role === 'guest' && meta.seat >= 0) {
      if (!this.hostConn) return;
      // Overwrite byte[1] with the relay-authenticated seat so a guest can never spoof another player's ship!
      const stamped = new Uint8Array(bytes.byteLength);
      stamped.set(bytes);
      stamped[1] = meta.seat & 0xff;
      try {
        this.hostConn.sendBinary(stamped);
      } catch {
        /* ignore */
      }
      return;
    }

    if (frameType === BIN_SNAP && meta.role === 'host') {
      for (const [peer, peerMeta] of this.conns.entries()) {
        if (peerMeta.role !== 'guest') continue;
        try {
          peer.sendBinary(bytes);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Handle an incoming UTF-8 JSON message (`string`). */
  handleText(conn, rawText, now = Date.now()) {
    const meta = this.conns.get(conn);
    if (!meta || this.closed || typeof rawText !== 'string') return;
    const byteLen = new TextEncoder().encode(rawText).byteLength;
    if (!this.checkRateAndSize(conn, meta, byteLen, now)) return;

    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    if (msg.type === 'ping') {
      conn.sendText(JSON.stringify({ type: 'pong', t: typeof msg.t === 'number' ? msg.t : now }));
      return;
    }

    // Explicit "Leave" button action (never sent on `pagehide`, so refreshes keep 30s grace):
    // immediately frees a guest's seat & invalidates their token, or closes the room if the host leaves.
    if (msg.type === 'leave') {
      if (meta.role === 'host') {
        this.closeRoom('host-left');
        return;
      }
      this.conns.delete(conn);
      if (meta.seat >= 0) {
        const seatInfo = this.seats.get(meta.seat);
        if (seatInfo && !seatInfo.isHost) {
          this.seats.delete(meta.seat);
          if (!this.locked) this.lastActivityAt = now;
          this.dirty = true;
        }
      }
      try {
        conn.setAttachment?.(null);
      } catch {
        /* ignore */
      }
      try {
        conn.close(1000, 'Left room');
      } catch {
        /* ignore */
      }
      this.broadcastLobby();
      return;
    }

    // Ignore `ready` once the room is locked, and ignore duplicate `ready` with unchanged value!
    if (msg.type === 'ready' && !this.locked && meta.seat >= 0) {
      const seatInfo = this.seats.get(meta.seat);
      const nextReady = Boolean(msg.ready);
      if (seatInfo && seatInfo.ready !== nextReady) {
        seatInfo.ready = nextReady;
        this.lastActivityAt = now;
        this.dirty = true;
        this.broadcastLobby();
      }
      return;
    }

    if (msg.type === 'callsign' && !this.locked && meta.seat >= 0) {
      const seatInfo = this.seats.get(meta.seat);
      if (seatInfo && typeof msg.callsign === 'string' && VALID_CALLSIGN_RE.test(msg.callsign.trim().toUpperCase())) {
        const desired = msg.callsign.trim().toUpperCase();
        if (seatInfo.callsign === desired) return;
        const takenByOther = Array.from(this.seats.values()).some(
          (s) => s.seat !== meta.seat && s.callsign === desired
        );
        if (!takenByOther) {
          seatInfo.callsign = desired;
          this.lastActivityAt = now;
          this.dirty = true;
          this.broadcastLobby();
        }
      }
      return;
    }

    if (msg.type === 'kick' && meta.role === 'host' && !this.locked) {
      const targetSeat = Number(msg.seat);
      if (Number.isInteger(targetSeat) && targetSeat >= 0 && !seatIsHost(this.seats.get(targetSeat))) {
        const kicked = this.seats.get(targetSeat);
        if (kicked) {
          if (kicked.token) addCappedSet(this.kickedTokens, kicked.token);
          if (kicked.cidHash) addCappedSet(this.kickedCidHashes, kicked.cidHash);
          this.seats.delete(targetSeat);
          this.lastActivityAt = now;
          this.dirty = true;
          if (kicked.conn) {
            this.conns.delete(kicked.conn);
            refuseConn(kicked.conn, 4003, 'kicked', 'Removed from lobby');
          }
          this.broadcastLobby();
        }
      }
      return;
    }

    if (msg.type === 'start' && meta.role === 'host' && !this.locked) {
      this.locked = true;
      this.startedAt = now;
      this.dirty = true;
      this.broadcastJson({
        type: 'started',
        code: this.code,
        seats: this.publicSeats(),
      });
      this.broadcastLobby();
      return;
    }

    if ((msg.type === 'event' || msg.type === 'host-paused') && meta.role === 'host') {
      const safeMsg = sanitizeHostEvent(msg);
      if (!safeMsg) return;
      const targetSeat = typeof safeMsg.to === 'number' && Number.isInteger(safeMsg.to) ? safeMsg.to : null;
      if (targetSeat !== null) {
        const dest = this.seats.get(targetSeat);
        if (dest?.conn) {
          try {
            dest.conn.sendText(JSON.stringify(safeMsg));
          } catch {
            /* ignore */
          }
        }
      } else {
        this.broadcastJson(safeMsg, conn);
      }
      return;
    }

    if (msg.type === 'answer' && meta.role === 'guest' && meta.seat >= 0) {
      if (!this.hostConn) return;
      const verdict =
        msg.verdict === 'perfect' || msg.verdict === 'good' || msg.verdict === 'failed'
          ? msg.verdict
          : 'failed';
      const quality =
        typeof msg.quality === 'number' && Number.isFinite(msg.quality)
          ? Math.max(0, Math.min(1, msg.quality))
          : 0;
      const challengeId = typeof msg.id === 'number' && Number.isFinite(msg.id) ? msg.id : 0;
      try {
        this.hostConn.sendText(
          JSON.stringify({
            type: 'answer',
            seat: meta.seat,
            id: challengeId,
            verdict,
            quality,
          })
        );
      } catch {
        /* ignore */
      }
    }
  }

  disconnect(conn, now = Date.now()) {
    const meta = this.conns.get(conn);
    if (!meta) return;
    this.conns.delete(conn);

    if (meta.role === 'host') {
      // Ignore late close events from a superseded socket!
      if (this.hostConn !== conn) return;
      this.hostConn = null;
      this.hostDisconnectedAt = now;
      if (!this.tvMode && this.seats.has(0)) {
        const s0 = this.seats.get(0);
        s0.conn = null;
        s0.disconnectedAt = now;
      }
      this.dirty = true;
      this.broadcastJson({ type: 'host-reconnecting', graceMs: RECONNECT_GRACE_MS });
      this.broadcastLobby();
      return;
    }

    const seatInfo = this.seats.get(meta.seat);
    if (!seatInfo || seatInfo.conn !== conn) return;

    // Hold both lobby and in-game guest seats for 30s so phone screen-lock or page refresh keeps the seat!
    seatInfo.conn = null;
    seatInfo.disconnectedAt = now;
    this.dirty = true;
    this.broadcastLobby();
  }

  closeRoom(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.dirty = true;
    const msg = JSON.stringify({ type: 'room-closed', reason });
    for (const c of this.conns.keys()) {
      try {
        c.setAttachment?.(null);
      } catch {
        /* ignore */
      }
      try {
        c.sendText(msg);
        c.close(1000, reason);
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    this.seats.clear();
    this.hostConn = null;
    this.hostToken = null;
  }
}

function seatIsHost(seatInfo) {
  return Boolean(seatInfo && seatInfo.isHost);
}
