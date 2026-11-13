/**
 * Reconnecting Co-op WebSocket client (`partysocket` `WebSocket` export) + HTTP room creator.
 *
 * Safeguards & Privacy Guarantees:
 * - Room seat tokens (`gg_coop_token_<CODE>`) and ephemeral per-tab IDs (`gg_coop_cid`) live in
 *   `sessionStorage` ONLY — never `localStorage`, and never cookies.
 * - Validates 6-char unambiguous room codes BEFORE opening any WebSocket, and caps pre-`welcome`
 *   connection retries (`<= 2` retries = 3 total attempts) so HTTP 400/403/429 responses never retry forever.
 * - Acts immediately on `refused` and `room-closed` JSON frames (without waiting for `onclose`),
 *   stopping auto-reconnect and clearing stale room tokens.
 * - Bounds the offline queue (`maxEnqueuedMessages: 8`), checks `readyState === OPEN` before sending
 *   binary frames, pings every 55s to keep CloudFront/NAT idle timers alive, and holds `navigator.wakeLock`
 *   while connected.
 */
import { WebSocket as ReconnectingWebSocket } from 'partysocket';
import type { Grade } from './fireworks';
import {
  COOP_CALLSIGN_PREFIXES,
  VALID_COOP_CALLSIGN_RE,
  formatCoopRoomCode,
  isValidCoopRoomCode,
  normalizeCoopRoomCode,
  type CoopAnswerMessage,
  type CoopClientToRelayMessage,
  type CoopCreateRoomResponse,
  type CoopErrorMessage,
  type CoopEventMessage,
  type CoopHostSeatIndex,
  type CoopLobbyState,
  type CoopPublicSeat,
  type CoopRefusalReason,
  type CoopRelayToClientMessage,
  type CoopRole,
  type CoopRoomClosedReason,
  type CoopWelcomeMessage,
} from './coop-types';

const TOKEN_PREFIX = 'gg_coop_token_';
const CID_KEY = 'gg_coop_cid';
export const INVITE_STORAGE_KEY = 'gg_coop_invite';
const PING_INTERVAL_MS = 55_000;
/** Initial connection attempt + up to 2 retries before first `welcome`; stops infinite 400/403/429 loops. */
const MAX_PRE_WELCOME_ATTEMPTS = 3;

export interface RelayEndpoints {
  httpBase: string;
  wsBase: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultSessionStorage(): StorageLike | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function detectRelayEndpoints(loc?: Location): RelayEndpoints {
  if (typeof window !== 'undefined') {
    const win = window as unknown as { __GG_RELAY_URL__?: string };
    if (win.__GG_RELAY_URL__) {
      const httpBase = win.__GG_RELAY_URL__.replace(/\/$/, '');
      const wsBase = httpBase.replace(/^http/i, 'ws');
      return { httpBase, wsBase };
    }
  }
  const l = loc ?? (typeof window !== 'undefined' ? window.location : null);
  if (!l) {
    return { httpBase: 'http://localhost:4323', wsBase: 'ws://localhost:4323' };
  }

  const { protocol, hostname, port, host, origin } = l;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  const isPrivateLan =
    /^(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(
      hostname,
    );

  // Local Docker Nginx gateway (:84, *.localdev, *.local, or LAN IP) proxies `/relay/*` directly to `wrangler dev`
  if (port === '84' || hostname.endsWith('.localdev') || hostname.endsWith('.local') || isPrivateLan) {
    return { httpBase: `${origin}/relay`, wsBase: `${wsProto}//${host}/relay` };
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return { httpBase: 'http://localhost:4323', wsBase: 'ws://localhost:4323' };
  }
  return { httpBase: 'https://relay.geurtsgaming.com', wsBase: 'wss://relay.geurtsgaming.com' };
}

/** Build a shareable Co-op invite URL (`https://geurtsgaming.com/?j=ABCDEF` or local `:84/?j=ABCDEF`). */
export function buildCoopInviteUrl(code: string, loc?: Location): string {
  const clean = normalizeCoopRoomCode(code);
  const l = loc ?? (typeof window !== 'undefined' ? window.location : null);
  const base = l ? `${l.origin}${l.pathname}` : 'https://geurtsgaming.com/';
  return `${base}?j=${clean}`;
}

/** Read `?j=ABCDEF` from the current URL (if valid) and immediately strip `?j=` via `history.replaceState`. */
export function consumeInviteCodeFromLocation(
  loc?: Location,
  hist?: Pick<History, 'replaceState'>,
): string | null {
  const l = loc ?? (typeof window !== 'undefined' ? window.location : null);
  if (!l || !l.search) return null;
  const params = new URLSearchParams(l.search);
  const rawJoin = params.get('j');
  if (rawJoin === null) return null;

  params.delete('j');
  const remaining = params.toString();
  const cleanUrl = `${l.pathname}${remaining ? `?${remaining}` : ''}${l.hash || ''}`;
  const h = hist ?? (typeof history !== 'undefined' ? history : null);
  try {
    h?.replaceState(history.state ?? null, '', cleanUrl);
  } catch {
    try {
      h?.replaceState(null, '', cleanUrl);
    } catch {
      /* ignore restricted history contexts */
    }
  }

  return isValidCoopRoomCode(rawJoin) ? normalizeCoopRoomCode(rawJoin) : null;
}

/**
 * Consume a pending Co-op invite code stashed by `Base.astro`'s early `<head>` script
 * (`sessionStorage['gg_coop_invite']` or `window.__ggInvite`) before Google Analytics ran,
 * falling back to `consumeInviteCodeFromLocation` if `?j=` is still in `location.search`.
 */
export function consumePendingInviteCode(opts?: {
  storage?: StorageLike | null;
  win?: { __ggInvite?: unknown } | null;
  loc?: Location;
  hist?: Pick<History, 'replaceState'>;
}): string | null {
  const storage = opts?.storage === undefined ? defaultSessionStorage() : opts.storage;
  const win =
    opts?.win === undefined
      ? typeof window !== 'undefined'
        ? (window as unknown as { __ggInvite?: unknown })
        : null
      : opts.win;

  let rawFromStorage: string | null = null;
  try {
    rawFromStorage = storage?.getItem(INVITE_STORAGE_KEY) ?? null;
    if (rawFromStorage !== null) {
      storage?.removeItem(INVITE_STORAGE_KEY);
    }
  } catch {
    /* ignore restricted storage */
  }

  let rawFromWindow: string | null = null;
  if (win && typeof win.__ggInvite === 'string') {
    rawFromWindow = win.__ggInvite;
    delete win.__ggInvite;
  }

  const fromUrl = consumeInviteCodeFromLocation(opts?.loc, opts?.hist);
  const candidate = rawFromStorage ?? rawFromWindow ?? fromUrl;
  if (!candidate) return null;
  return isValidCoopRoomCode(candidate) ? normalizeCoopRoomCode(candidate) : null;
}

/** Ensure a valid preset callsign (`PREFIX-[1-9]`), falling back cleanly if needed. */
export function ensureCoopCallsign(candidate?: string): string {
  if (candidate && VALID_COOP_CALLSIGN_RE.test(candidate.trim().toUpperCase())) {
    return candidate.trim().toUpperCase();
  }
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const prefix = COOP_CALLSIGN_PREFIXES[bytes[0]! % COOP_CALLSIGN_PREFIXES.length]!;
  const digit = (bytes[1]! % 9) + 1;
  return `${prefix}-${digit}`;
}

/** Cycle to the next preset Co-op callsign (`PREFIX-[1-9]`), skipping callsigns already taken in the room. */
export function nextAvailableCallsign(current: string, taken: Iterable<string> = []): string {
  const takenSet = new Set(Array.from(taken, (c) => c.toUpperCase()));
  takenSet.delete(current.toUpperCase());
  const parts = current.trim().toUpperCase().split('-');
  const curPrefixIdx = Math.max(0, COOP_CALLSIGN_PREFIXES.indexOf((parts[0] ?? 'NOVA') as never));
  const curDigit = Number(parts[1]) || 1;

  for (let step = 1; step <= COOP_CALLSIGN_PREFIXES.length * 9; step++) {
    const prefix = COOP_CALLSIGN_PREFIXES[(curPrefixIdx + step) % COOP_CALLSIGN_PREFIXES.length]!;
    const digit = ((curDigit + step - 1) % 9) + 1;
    const candidate = `${prefix}-${digit}`;
    if (!takenSet.has(candidate)) return candidate;
  }
  return ensureCoopCallsign();
}

export function getOrCreateTabClientId(storage: StorageLike | null = defaultSessionStorage()): string {
  try {
    const existing = storage?.getItem(CID_KEY);
    if (existing && /^[a-f0-9]{16,32}$/.test(existing)) return existing;
  } catch {
    /* ignore */
  }
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  try {
    storage?.setItem(CID_KEY, hex);
  } catch {
    /* ignore */
  }
  return hex;
}

export function getStoredCoopToken(code: string, storage: StorageLike | null = defaultSessionStorage()): string {
  const clean = normalizeCoopRoomCode(code);
  if (!clean) return '';
  try {
    return storage?.getItem(`${TOKEN_PREFIX}${clean}`) || '';
  } catch {
    return '';
  }
}

export function setStoredCoopToken(
  code: string,
  token: string,
  storage: StorageLike | null = defaultSessionStorage(),
): void {
  const clean = normalizeCoopRoomCode(code);
  if (!clean || !token) return;
  try {
    storage?.setItem(`${TOKEN_PREFIX}${clean}`, token);
  } catch {
    /* ignore */
  }
}

export function clearStoredCoopToken(code: string, storage: StorageLike | null = defaultSessionStorage()): void {
  const clean = normalizeCoopRoomCode(code);
  if (!clean) return;
  try {
    storage?.removeItem(`${TOKEN_PREFIX}${clean}`);
    storage?.removeItem(`gg_coop_host_state_${clean}`);
  } catch {
    /* ignore */
  }
}

/** Allocate a fresh 6-character room code via `POST /relay/room`. */
export async function createCoopRoom(
  opts: { httpBase?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ code: string; formattedCode: string }> {
  const httpBase = (opts.httpBase ?? detectRelayEndpoints().httpBase).replace(/\/$/, '');
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${httpBase}/room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  let body: CoopCreateRoomResponse | null = null;
  try {
    body = (await res.json()) as CoopCreateRoomResponse;
  } catch {
    /* handled below */
  }
  if (!res.ok || !body?.ok || !body.code || !isValidCoopRoomCode(body.code)) {
    throw new Error(body?.error || `Could not create room (HTTP ${res.status})`);
  }
  const code = normalizeCoopRoomCode(body.code);
  return { code, formattedCode: body.formattedCode || formatCoopRoomCode(code) };
}

export interface CoopClientCallbacks {
  onWelcome?: (msg: CoopWelcomeMessage) => void;
  onLobby?: (state: CoopLobbyState) => void;
  onStarted?: (seats: CoopPublicSeat[], code: string) => void;
  onEvent?: (msg: CoopEventMessage) => void;
  onAnswer?: (msg: CoopAnswerMessage) => void;
  onRefused?: (reason: CoopRefusalReason | 'invalid-code') => void;
  onRoomClosed?: (reason: CoopRoomClosedReason) => void;
  onHostReconnecting?: (graceMs: number) => void;
  onHostResumed?: () => void;
  onHostPaused?: (paused: boolean) => void;
  onRelayError?: (err: CoopErrorMessage) => void;
  onConnectionError?: (message: string) => void;
  onMessage?: (msg: CoopRelayToClientMessage) => void;
  onBinary?: (bytes: Uint8Array) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export interface CoopConnectOptions extends CoopClientCallbacks {
  code: string;
  role: CoopRole;
  callsign?: string;
  tvMode?: boolean;
  wsBase?: string;
  storage?: StorageLike | null;
  /** Custom WebSocket constructor for deterministic Node unit tests. */
  WebSocketConstructor?: unknown;
  pingIntervalMs?: number;
}

interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

export class CoopClient {
  readonly code: string;
  readonly formattedCode: string;
  role: CoopRole;
  seat: CoopHostSeatIndex = -1;
  callsign: string;
  tvMode: boolean;
  locked = false;
  seats: CoopPublicSeat[] = [];

  private readonly wsBase: string;
  private readonly storage: StorageLike | null;
  private readonly clientId: string;
  private readonly callbacks: CoopClientCallbacks;
  private readonly subscribers = new Set<CoopClientCallbacks>();
  private readonly customWsCtor: unknown;
  private readonly pingIntervalMs: number;

  private socket: ReconnectingWebSocket | null = null;
  private token = '';
  private welcomed = false;
  private preWelcomeFailures = 0;
  private permanentlyStopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private wakeLock: WakeLockSentinelLike | null = null;

  constructor(opts: CoopConnectOptions) {
    this.code = normalizeCoopRoomCode(opts.code);
    this.formattedCode = formatCoopRoomCode(this.code);
    this.role = opts.role;
    this.callsign = ensureCoopCallsign(opts.callsign);
    this.tvMode = Boolean(opts.tvMode);
    this.wsBase = (opts.wsBase ?? detectRelayEndpoints().wsBase).replace(/\/$/, '');
    this.storage = opts.storage === undefined ? defaultSessionStorage() : opts.storage;
    this.clientId = getOrCreateTabClientId(this.storage);
    this.token = getStoredCoopToken(this.code, this.storage);
    this.callbacks = opts;
    this.customWsCtor = opts.WebSocketConstructor;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
  }

  get isConnected(): boolean {
    return Boolean(this.socket && this.socket.readyState === ReconnectingWebSocket.OPEN);
  }

  get hasWelcomed(): boolean {
    return this.welcomed;
  }

  /** Attach an additional listener set (e.g. `CoopFlightDirector` once the squad launches) with an unsubscribe fn. */
  subscribe(handlers: CoopClientCallbacks): () => void {
    this.subscribers.add(handlers);
    return () => {
      this.subscribers.delete(handlers);
    };
  }

  private emit<K extends keyof CoopClientCallbacks>(
    key: K,
    ...args: Parameters<NonNullable<CoopClientCallbacks[K]>>
  ): void {
    const primary = this.callbacks[key] as ((...a: unknown[]) => void) | undefined;
    primary?.(...args);
    for (const sub of this.subscribers) {
      const fn = sub[key] as ((...a: unknown[]) => void) | undefined;
      fn?.(...args);
    }
  }

  /** Open the reconnecting WebSocket (`false` immediately if the room code format is invalid). */
  connect(): boolean {
    if (!isValidCoopRoomCode(this.code)) {
      this.permanentlyStopped = true;
      this.emit('onRefused', 'invalid-code');
      return false;
    }
    if (this.socket || this.permanentlyStopped) return true;

    const urlProvider = () => {
      const params = new URLSearchParams();
      params.set('role', this.role);
      params.set('callsign', this.callsign);
      params.set('cid', this.clientId);
      if (this.tvMode && this.role === 'host') params.set('tv', '1');
      const tok = this.token || getStoredCoopToken(this.code, this.storage);
      if (tok) params.set('token', tok);
      return `${this.wsBase}/room/${this.code}?${params.toString()}`;
    };

    const ws = new ReconnectingWebSocket(urlProvider, [], {
      ...(this.customWsCtor ? { WebSocket: this.customWsCtor as never } : {}),
      maxEnqueuedMessages: 8,
      minReconnectionDelay: 250,
      maxReconnectionDelay: 2_500,
      connectionTimeout: 6_000,
      shouldReconnectOnClose: (ev: { code?: number }) => ev.code !== 4001,
    });
    ws.binaryType = 'arraybuffer';
    this.socket = ws;

    ws.addEventListener('open', () => {
      if (this.permanentlyStopped) return;
      ws.binaryType = 'arraybuffer';
      this.startKeepAlive();
      void this.acquireWakeLock();
      this.emit('onConnectionChange', true);
    });

    ws.addEventListener('message', (ev) => {
      if (this.permanentlyStopped) return;
      const { data } = ev;
      if (typeof data === 'string') {
        this.handleTextFrame(data);
      } else if (data instanceof ArrayBuffer) {
        this.emit('onBinary', new Uint8Array(data));
      } else if (ArrayBuffer.isView(data)) {
        this.emit('onBinary', new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
    });

    ws.addEventListener('close', (ev) => {
      this.stopKeepAlive();
      this.emit('onConnectionChange', false);
      if (this.permanentlyStopped) return;

      // Close code 4001 ("Replaced by reconnect") is always final so two duplicated tabs sharing
      // one seat token never fight over the seat — even against an older relay without `refused`.
      if ((ev as { code?: number }).code === 4001) {
        clearStoredCoopToken(this.code, this.storage);
        this.token = '';
        this.stopSocket();
        this.emit('onRefused', 'replaced');
        return;
      }

      if (!this.welcomed) {
        this.preWelcomeFailures += 1;
        if (this.preWelcomeFailures >= MAX_PRE_WELCOME_ATTEMPTS) {
          this.stopSocket();
          this.emit(
            'onConnectionError',
            'Could not reach the squad room. Check the 6-character room code and try again.',
          );
        }
      }
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    return true;
  }

  private handleTextFrame(raw: string): void {
    let msg: CoopRelayToClientMessage;
    try {
      msg = JSON.parse(raw) as CoopRelayToClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'welcome': {
        this.welcomed = true;
        this.preWelcomeFailures = 0;
        this.role = msg.role;
        this.seat = msg.seat;
        this.token = msg.token;
        this.tvMode = msg.tvMode;
        this.locked = msg.locked;
        this.seats = msg.seats;
        const mySeat = msg.seats.find((s) => s.seat === msg.seat);
        if (mySeat) this.callsign = mySeat.callsign;
        setStoredCoopToken(this.code, msg.token, this.storage);
        this.emit('onWelcome', msg);
        break;
      }
      case 'lobby': {
        this.tvMode = msg.tvMode;
        this.locked = msg.locked;
        this.seats = msg.seats;
        const mySeat = msg.seats.find((s) => s.seat === this.seat);
        if (mySeat) this.callsign = mySeat.callsign;
        this.emit('onLobby', {
          code: msg.code,
          formattedCode: msg.formattedCode,
          tvMode: msg.tvMode,
          locked: msg.locked,
          hostConnected: msg.hostConnected,
          seats: msg.seats,
        });
        break;
      }
      case 'started': {
        this.locked = true;
        this.seats = msg.seats;
        this.emit('onStarted', msg.seats, msg.code);
        break;
      }
      case 'event': {
        this.emit('onEvent', msg);
        break;
      }
      case 'answer': {
        this.emit('onAnswer', msg);
        break;
      }
      case 'refused': {
        // Act immediately on `refused` without waiting for `onclose`, and clear stale room token!
        clearStoredCoopToken(this.code, this.storage);
        this.token = '';
        this.stopSocket();
        this.emit('onRefused', msg.reason);
        break;
      }
      case 'room-closed': {
        clearStoredCoopToken(this.code, this.storage);
        this.token = '';
        this.stopSocket();
        this.emit('onRoomClosed', msg.reason);
        break;
      }
      case 'host-reconnecting': {
        this.emit('onHostReconnecting', msg.graceMs);
        break;
      }
      case 'host-resumed': {
        this.emit('onHostResumed');
        break;
      }
      case 'host-paused': {
        this.emit('onHostPaused', msg.paused);
        break;
      }
      case 'error': {
        this.emit('onRelayError', msg);
        break;
      }
      default:
        break;
    }

    this.emit('onMessage', msg);
  }

  sendJson(msg: CoopClientToRelayMessage): boolean {
    if (!this.socket || this.permanentlyStopped) return false;
    try {
      this.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a compact binary frame ONLY when the socket is currently OPEN (never queued offline). */
  sendBinary(bytes: Uint8Array): boolean {
    if (!this.socket || this.permanentlyStopped || this.socket.readyState !== ReconnectingWebSocket.OPEN) {
      return false;
    }
    try {
      const payload =
        bytes.buffer instanceof ArrayBuffer
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes);
      this.socket.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  setReady(ready: boolean): void {
    this.sendJson({ type: 'ready', ready });
  }

  setCallsign(callsign: string): void {
    const clean = ensureCoopCallsign(callsign);
    this.callsign = clean;
    this.sendJson({ type: 'callsign', callsign: clean });
  }

  kickSeat(seat: 0 | 1 | 2 | 3): void {
    if (this.role !== 'host') return;
    this.sendJson({ type: 'kick', seat });
  }

  startSquad(): void {
    if (this.role !== 'host') return;
    this.sendJson({ type: 'start' });
  }

  /** Broadcast or unicast (`to: seat`) a flat numeric/boolean Host event frame. */
  sendEvent(event: Omit<CoopEventMessage, 'type'>): boolean {
    if (this.role !== 'host') return false;
    return this.sendJson({ type: 'event', ...event });
  }

  /** Broadcast Host pause/resume state to all Guests. */
  sendHostPaused(paused: boolean): boolean {
    if (this.role !== 'host') return false;
    return this.sendJson({ type: 'host-paused', paused });
  }

  /** Send a Guest challenge verdict (`'perfect' | 'good' | 'failed'`) & normalized quality (`0..1`) to the Host. */
  sendAnswer(id: number, verdict: Grade, quality: number): boolean {
    if (this.role !== 'guest' || this.seat < 0) return false;
    const safeQuality = Number.isFinite(quality) ? Math.max(0, Math.min(1, quality)) : 0;
    return this.sendJson({ type: 'answer', id, verdict, quality: safeQuality });
  }

  /**
   * Deliberate user Leave button click: tells the relay to free the seat immediately (`{ type: 'leave' }`),
   * clears the stored room token, and closes the socket permanently.
   * Never call `leave()` on `pagehide` — refreshes use `dispose()` so the 30s seat hold applies!
   */
  leave(): void {
    if (!this.permanentlyStopped && this.socket && this.socket.readyState === ReconnectingWebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: 'leave' }));
      } catch {
        /* ignore */
      }
    }
    clearStoredCoopToken(this.code, this.storage);
    this.token = '';
    this.stopSocket();
  }

  /** Close the local socket & timers without forfeiting the 30s reconnect token in `sessionStorage`. */
  dispose(): void {
    this.stopSocket();
  }

  private stopSocket(): void {
    this.permanentlyStopped = true;
    this.stopKeepAlive();
    void this.releaseWakeLock();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try {
        ws.close(1000, 'Client closed');
      } catch {
        /* ignore */
      }
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === ReconnectingWebSocket.OPEN) {
        this.sendJson({ type: 'ping', t: Date.now() });
      }
    }, this.pingIntervalMs);
  }

  private stopKeepAlive(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && !document.hidden && !this.permanentlyStopped) {
      void this.acquireWakeLock();
    }
  };

  private async acquireWakeLock(): Promise<void> {
    if ((this.wakeLock && !this.wakeLock.released) || this.permanentlyStopped || typeof navigator === 'undefined') {
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) return;
    const nav = navigator as unknown as {
      wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
    };
    if (!nav.wakeLock) return;
    try {
      const sentinel = await nav.wakeLock.request('screen');
      if (this.permanentlyStopped) {
        void sentinel.release().catch(() => {});
        return;
      }
      this.wakeLock = sentinel;
      sentinel.addEventListener?.('release', () => {
        if (this.wakeLock === sentinel) {
          this.wakeLock = null;
        }
      });
    } catch {
      this.wakeLock = null;
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (!lock) return;
    try {
      await lock.release();
    } catch {
      /* ignore */
    }
  }
}
