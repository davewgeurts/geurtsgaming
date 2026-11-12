/**
 * Live multiplayer presence, Top 10 Pilots leaderboard, and Ghost Wingmen squadron telemetry.
 *
 * - Talks to the shared multi-site Presence & Leaderboard Lambda (`/presence?site=geurtsgaming` and `/score`),
 *   or `/api/presence` when running inside the local Docker / Nginx stack.
 * - The board starts empty and holds only scores people have really flown. The server's board is the truth:
 *   whatever it sends replaces what is shown, so a board cleared on the server clears everywhere. Offline, the
 *   board is whatever this browser last saw, plus this pilot's own runs.
 * - Shows other pilots' ships where they are, and flies one or two computer-flown wingmen ("WING 1", "WING 2")
 *   alongside a pilot who is on their own. Those are never given a player's name.
 */
import { NEON, PINK, SAND, clamp, type Ink } from './core';
import { textWidth, traceText } from './font';
import { SHIP, trace } from './shapes';

export interface PilotScore {
  callsign: string;
  score: number;
  wave: number;
  freed: number;
  updatedAt?: string;
}

export interface WingmanTelemetry {
  id?: string;
  callsign: string;
  wave: number;
  score: number;
  freed: number;
  /** Normalized horizontal position across the screen (0..1). */
  x: number;
  /** Normalized vertical position down the screen (0..1). */
  y: number;
  vx?: number;
  vy?: number;
  hull?: number;
  weapon?: string;
  firing?: boolean;
  updatedAt?: string;
}

export interface WingmanShip {
  id: string;
  callsign: string;
  wave: number;
  score: number;
  freed: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  vx: number;
  vy: number;
  lean: number;
  firing: boolean;
  cooldown: number;
  /** True when driven by live network telemetry; false when an autonomous ghost wingman from Top 10. */
  live: boolean;
  phase: number;
  lastSeen: number;
}

export interface WingmanLaser {
  x: number;
  y: number;
  vy: number;
  color: string;
  age: number;
}

export interface MultiplayerSnapshot {
  onlineCount: number;
  wingmenCount: number;
  callsign: string;
  topPilots: readonly PilotScore[];
  lastRank: number | null;
  totalLiberated: number;
}

const CALLSIGN_KEY = 'gg-pilot-callsign';
const PILOTS_KEY = 'gg-top-pilots-v1';
const USER_ID_KEY = 'gg-pilot-id';

const CALLSIGN_PREFIXES = [
  'NOVA', 'FALCON', 'VIPER', 'STAR', 'ORION', 'LYRA',
  'VEGA', 'COMET', 'APEX', 'DRIFT', 'PULSE', 'SOLAR',
] as const;

const PROD_LAMBDA_URL = 'https://64nyizvtcs7b7qwjjcpgumre7i0zweoe.lambda-url.us-west-2.on.aws';

/** Pick a clean arcade callsign like `NOVA-7` or `FALCON-3`. */
export function generateCallsign(seed = Math.random()): string {
  const idx = Math.floor(Math.abs(seed) * CALLSIGN_PREFIXES.length) % CALLSIGN_PREFIXES.length;
  const digit = Math.floor(Math.abs(seed * 97) % 9) + 1;
  return `${CALLSIGN_PREFIXES[idx]}-${digit}`;
}

/** Merge a pilot score into a Top 10 list, keeping each pilot's best run sorted descending by score. Nothing is added that nobody flew. */
export function mergeTopPilots(
  existing: readonly PilotScore[],
  entry?: PilotScore | null,
  limit = 10,
): { topPilots: PilotScore[]; rank: number | null } {
  const byCallsign = new Map<string, PilotScore>();
  for (const p of existing) {
    if (!p || !p.callsign || !(p.score > 0)) continue;
    const key = p.callsign.trim().toUpperCase().slice(0, 12);
    const prev = byCallsign.get(key);
    if (!prev || p.score > prev.score) {
      byCallsign.set(key, {
        callsign: key,
        score: Math.max(0, Math.floor(p.score)),
        wave: Math.max(1, Math.floor(p.wave || 1)),
        freed: Math.max(0, Math.floor(p.freed || 0)),
      });
    }
  }
  let targetKey: string | null = null;
  if (entry && entry.callsign && entry.score > 0) {
    targetKey = entry.callsign.trim().toUpperCase().slice(0, 12);
    const prev = byCallsign.get(targetKey);
    if (!prev || entry.score >= prev.score) {
      byCallsign.set(targetKey, {
        callsign: targetKey,
        score: Math.max(0, Math.floor(entry.score)),
        wave: Math.max(1, Math.floor(entry.wave || 1)),
        freed: Math.max(0, Math.floor(entry.freed || 0)),
      });
    }
  }
  const sorted = Array.from(byCallsign.values())
    .sort((a, b) => b.score - a.score || b.wave - a.wave || b.freed - a.freed)
    .slice(0, limit);
  const rank = targetKey ? sorted.findIndex((p) => p.callsign === targetKey) + 1 : null;
  return { topPilots: sorted, rank: rank && rank > 0 ? rank : null };
}

function detectApiBaseUrl(): { url: string; fallbackUrl: string | null } {
  if (typeof window === 'undefined') return { url: '', fallbackUrl: null };
  const win = window as unknown as { __GG_API_URL__?: string };
  if (win.__GG_API_URL__) return { url: win.__GG_API_URL__.replace(/\/$/, ''), fallbackUrl: null };
  const { hostname, port } = window.location;
  // Inside Docker Nginx (:84 or geurtsgaming.localdev), /api proxies to the local Lambda container.
  if (port === '84' || hostname.endsWith('.localdev')) return { url: '/api', fallbackUrl: PROD_LAMBDA_URL };
  // On localhost Astro dev/preview, talk to local API if running, or fall back to the shared Lambda.
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return { url: 'http://localhost:4322', fallbackUrl: PROD_LAMBDA_URL };
  }
  return { url: PROD_LAMBDA_URL, fallbackUrl: null };
}

/** IDs already claimed in this JS context so multiple instances in one process never share an ID. */
const claimedUserIds = new Set<string>();

export class MultiplayerClient {
  private callsign: string;
  private userId: string;
  private topPilots: PilotScore[] = [];
  private lastRank: number | null = null;
  /** The last run this pilot finished, so its rank can be read off whatever board is being shown. */
  private lastRun: PilotScore | null = null;
  private totalLiberated = 0;
  private onlineCount = 1;
  private remoteWingmen: WingmanTelemetry[] = [];
  private seenPilots = new Map<string, number>();
  readonly wingmen: WingmanShip[] = [];
  readonly lasers: WingmanLaser[] = [];

  private apiBase: string;
  private fallbackApiBase: string | null = null;
  private readonly siteId = 'geurtsgaming';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private warmupTimers: Array<ReturnType<typeof setTimeout>> = [];
  private channel: BroadcastChannel | null = null;
  private started = false;
  /**
   * Whether the server at `apiBase` has this game's dedicated leaderboard room (`topPilots`).
   * Even on the shared presence server ('shared'), `/presence` still tracks active `pilot-*` souls
   * so the online pilot counter and live wingmen work across browsers without calling `/score`.
   */
  private serverBoard: 'unknown' | 'ready' | 'shared' = 'unknown';
  private fastPolling = false;
  private lastPollMs = 0;
  /**
   * Where this pilot is flying now. It goes out with every heartbeat while a wave is on, so that the server
   * never hears from a pilot in flight without hearing where they are (it forgets a position it is not sent).
   * null between waves, when other pilots should not see this ship.
   */
  private flight: Omit<WingmanTelemetry, 'callsign'> | null = null;
  private time = 0;
  private listeners = new Set<(snap: MultiplayerSnapshot) => void>();

  constructor(apiBaseOverride?: string) {
    if (apiBaseOverride !== undefined) {
      this.apiBase = apiBaseOverride;
      this.fallbackApiBase = null;
    } else {
      const detected = detectApiBaseUrl();
      this.apiBase = detected.url;
      this.fallbackApiBase = detected.fallbackUrl;
    }
    this.callsign = this.loadCallsign();
    this.userId = this.loadUserId();
    this.seenPilots.set(this.userId, Date.now());
    this.topPilots = this.loadSavedPilots();
  }

  private loadCallsign(): string {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(CALLSIGN_KEY) : null;
      if (saved && /^[A-Z0-9-]{3,12}$/.test(saved)) return saved;
      const fresh = generateCallsign();
      if (typeof localStorage !== 'undefined') localStorage.setItem(CALLSIGN_KEY, fresh);
      return fresh;
    } catch {
      return generateCallsign();
    }
  }

  private loadUserId(): string {
    const mint = () => `pilot-${Math.random().toString(36).slice(2, 10)}`;
    try {
      if (typeof window !== 'undefined' && typeof sessionStorage !== 'undefined') {
        const saved = sessionStorage.getItem(USER_ID_KEY);
        // Reuse the ID across reloads of the same tab (where window.name persists),
        // but mint a fresh ID in a new or duplicated tab (where window.name starts empty).
        if (saved && saved.startsWith('pilot-') && window.name === saved && !claimedUserIds.has(saved)) {
          claimedUserIds.add(saved);
          return saved;
        }
        const fresh = mint();
        sessionStorage.setItem(USER_ID_KEY, fresh);
        window.name = fresh;
        claimedUserIds.add(fresh);
        return fresh;
      }
    } catch {
      /* ignore storage errors */
    }
    const fresh = mint();
    claimedUserIds.add(fresh);
    return fresh;
  }

  private loadSavedPilots(): PilotScore[] {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PILOTS_KEY) : null;
      if (!raw) return [];
      const parsed = JSON.parse(raw) as PilotScore[];
      if (!Array.isArray(parsed)) return [];
      return mergeTopPilots(parsed).topPilots;
    } catch {
      return [];
    }
  }

  private savePilots(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(PILOTS_KEY, JSON.stringify(this.topPilots));
      }
    } catch {
      /* ignore storage errors */
    }
  }

  getCallsign(): string {
    return this.callsign;
  }

  /** Cycle to a new pilot callsign (e.g. when pressing C on the leaderboard). */
  cycleCallsign(): string {
    const currentPrefix = this.callsign.split('-')[0] ?? 'NOVA';
    const idx = Math.max(0, CALLSIGN_PREFIXES.indexOf(currentPrefix as never));
    const nextPrefix = CALLSIGN_PREFIXES[(idx + 1) % CALLSIGN_PREFIXES.length]!;
    const digit = ((Number(this.callsign.split('-')[1]) || 1) % 9) + 1;
    this.callsign = `${nextPrefix}-${digit}`;
    // The rank belonged to the last run, flown under the old callsign.
    this.lastRank = null;
    this.lastRun = null;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(CALLSIGN_KEY, this.callsign);
    } catch {
      /* ignore */
    }
    this.notify();
    return this.callsign;
  }

  snapshot(): MultiplayerSnapshot {
    return {
      onlineCount: Math.max(1, this.onlineCount),
      wingmenCount: this.wingmen.length,
      callsign: this.callsign,
      topPilots: this.topPilots,
      lastRank: this.lastRank,
      totalLiberated: this.totalLiberated,
    };
  }

  subscribe(fn: (snap: MultiplayerSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  /** Start background presence polling. Safe to call in browser; no-ops if fetch is unavailable. */
  start(): void {
    if (typeof fetch === 'undefined' || !this.apiBase) return;
    if (!this.started) {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', this.onFocus);
        this.openChannel();
      }
    }
    this.started = true;
    void this.pollPresence();
    // Follow up after the server's 1.5s DynamoDB coalesce window (twice: once to flush, once to read merged state).
    for (const t of this.warmupTimers) clearTimeout(t);
    this.warmupTimers = [
      setTimeout(() => {
        if (this.started) void this.pollPresence();
      }, 1750 + Math.floor(Math.random() * 450)),
      setTimeout(() => {
        if (this.started) void this.pollPresence();
      }, 3400 + Math.floor(Math.random() * 500)),
    ];
    this.resetPollInterval(this.fastPolling);
  }

  stop(): void {
    if (this.started) {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
      if (typeof window !== 'undefined') window.removeEventListener('focus', this.onFocus);
    }
    this.started = false;
    for (const t of this.warmupTimers) clearTimeout(t);
    this.warmupTimers = [];
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        /* ignore */
      }
      this.channel = null;
    }
  }

  private openChannel(): void {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    try {
      this.channel = new BroadcastChannel('gg-pilot-presence');
      this.channel.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as { type?: string; sid?: string; seen?: Array<[string, number]> } | null;
        if (!msg || typeof msg !== 'object') return;
        const now = Date.now();
        let changed = false;
        if (typeof msg.sid === 'string' && msg.sid.startsWith('pilot-')) {
          if (!this.seenPilots.has(msg.sid)) changed = true;
          this.seenPilots.set(msg.sid, now);
        }
        if (Array.isArray(msg.seen)) {
          for (const entry of msg.seen) {
            if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'number') continue;
            if (now - entry[1] <= 110_000) {
              if (!this.seenPilots.has(entry[0])) changed = true;
              const prev = this.seenPilots.get(entry[0]) ?? 0;
              if (entry[1] > prev) this.seenPilots.set(entry[0], entry[1]);
            }
          }
        }
        if (msg.type === 'hello' && msg.sid !== this.userId) {
          this.broadcastPresence('ack');
        }
        if (changed && this.seenPilots.size > this.onlineCount) {
          this.onlineCount = this.seenPilots.size;
          this.notify();
        }
      };
      this.broadcastPresence('hello');
    } catch {
      this.channel = null;
    }
  }

  private broadcastPresence(type: 'hello' | 'ack' | 'sync'): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage({
        type,
        sid: this.userId,
        seen: Array.from(this.seenPilots.entries()),
      });
    } catch {
      /* ignore */
    }
  }

  /** Hidden or occluded browser windows poll more slowly so they stay counted as online without busy-polling. */
  private onVisibility = (): void => {
    if (!this.started) return;
    if (!document.hidden) {
      void this.pollPresence();
    }
    this.resetPollInterval(this.fastPolling);
  };

  private onFocus = (): void => {
    if (!this.started) return;
    if (Date.now() - this.lastPollMs > 1800) {
      void this.pollPresence();
    }
  };

  setFastPolling(fast: boolean): void {
    if (this.fastPolling === fast) return;
    this.fastPolling = fast;
    if (!this.started) return;
    this.resetPollInterval(fast);
    // Say so straight away when a wave starts or stops, rather than at the next heartbeat.
    void this.pollPresence();
  }

  /** The pilot is not flying (the game is paused, or closed): stop reporting a position. */
  rest(): void {
    this.flight = null;
    this.setFastPolling(false);
  }

  private resetPollInterval(fast: boolean): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!this.started || typeof fetch === 'undefined' || !this.apiBase) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const jitter = Math.floor(Math.random() * 600);
    const ms = hidden ? 8000 + jitter : fast ? 2600 + jitter : 5000 + jitter;
    this.pollTimer = setInterval(() => {
      void this.pollPresence();
    }, ms);
  }

  private endpoint(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.apiBase}${path}${sep}site=${encodeURIComponent(this.siteId)}`;
  }

  async pollPresence(flight: Omit<WingmanTelemetry, 'callsign'> | null = this.flight): Promise<void> {
    if (typeof fetch === 'undefined' || !this.apiBase) return;
    this.lastPollMs = Date.now();
    const chapter = flight
      ? `gg:${flight.wave}:${flight.x.toFixed(3)}:${flight.y.toFixed(3)}:${flight.firing ? 1 : 0}:${Math.round(flight.score)}:${Math.round(flight.freed)}`
      : 'geurtsgaming';
    const payload = JSON.stringify({
      site: this.siteId,
      siteId: this.siteId,
      sid: this.userId,
      userId: this.userId,
      persona: this.callsign,
      callsign: this.callsign,
      chapter,
      ...(flight ? { flight: { ...flight, callsign: this.callsign } } : {}),
    });

    try {
      let res: Response;
      try {
        res = await fetch(this.endpoint('/presence'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
      } catch (err) {
        if (this.fallbackApiBase && this.apiBase !== this.fallbackApiBase) {
          this.apiBase = this.fallbackApiBase;
          this.fallbackApiBase = null;
          res = await fetch(this.endpoint('/presence'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          });
        } else {
          throw err;
        }
      }
      if (!res.ok) return;
      const data = (await res.json()) as {
        activeCount?: number;
        count?: number;
        activeSouls?: Array<{
          sid?: string;
          persona?: string;
          chapter?: string;
          lastSeen?: number;
        }>;
        topPilots?: PilotScore[];
        totalLiberated?: number;
        wingmen?: Array<
          WingmanTelemetry & {
            sid?: string;
            flight?: Partial<WingmanTelemetry>;
          }
        >;
      };

      const now = Date.now();
      const hasBoard = Array.isArray(data.topPilots);
      this.serverBoard = hasBoard ? 'ready' : 'shared';

      this.seenPilots.set(this.userId, now);
      for (const [id, ts] of this.seenPilots) {
        if (now - ts > 110_000) this.seenPilots.delete(id);
      }

      const activeSouls = Array.isArray(data.activeSouls) ? data.activeSouls : null;
      if (activeSouls) {
        for (const s of activeSouls) {
          if (!s || typeof s.sid !== 'string') continue;
          const isPilot =
            hasBoard ||
            s.sid.startsWith('pilot-') ||
            (typeof s.chapter === 'string' && (s.chapter === 'geurtsgaming' || s.chapter.startsWith('gg:')));
          if (!isPilot) continue;
          const seenAt = typeof s.lastSeen === 'number' && s.lastSeen > 0 && s.lastSeen <= now ? s.lastSeen : now;
          if (now - seenAt <= 110_000) {
            const prev = this.seenPilots.get(s.sid) ?? 0;
            if (seenAt >= prev) this.seenPilots.set(s.sid, seenAt);
          }
        }
      }

      const count = data.activeCount ?? data.count;
      if (hasBoard) {
        const serverCount = typeof count === 'number' && count >= 1 ? count : 1;
        this.onlineCount = activeSouls ? Math.max(serverCount, this.seenPilots.size) : serverCount;
      } else if (activeSouls) {
        this.onlineCount = Math.max(1, this.seenPilots.size);
      } else if (typeof count === 'number' && count >= 1) {
        this.onlineCount = count;
      }

      this.takeBoard(data.topPilots, data.totalLiberated);
      if (Array.isArray(data.wingmen)) {
        this.remoteWingmen = data.wingmen
          .map((w): WingmanTelemetry | null => {
            if (!w) return null;
            const id = w.sid || w.id || '';
            if (id === this.userId) return null;
            const f = w.flight ?? w;
            if (typeof f.x !== 'number' || typeof f.y !== 'number') return null;
            return {
              id: id || `remote-${w.callsign || 'WINGMAN'}`,
              callsign: (w.callsign || 'WINGMAN').toUpperCase(),
              wave: f.wave ?? w.wave ?? 1,
              score: f.score ?? w.score ?? 0,
              freed: f.freed ?? w.freed ?? 0,
              x: f.x,
              y: f.y,
              vx: f.vx ?? w.vx ?? 0,
              vy: f.vy ?? w.vy ?? 0,
              hull: f.hull ?? w.hull ?? 3,
              weapon: f.weapon ?? w.weapon ?? 'cannon',
              firing: Boolean(f.firing ?? w.firing),
            };
          })
          .filter((w): w is WingmanTelemetry => w !== null);
      } else if (activeSouls) {
        this.remoteWingmen = activeSouls
          .map((s): WingmanTelemetry | null => {
            if (!s || typeof s.sid !== 'string' || s.sid === this.userId) return null;
            if (typeof s.chapter !== 'string' || !s.chapter.startsWith('gg:')) return null;
            const m = /^gg:(\d+):([0-9.]+):([0-9.]+):([01]):(\d+)(?::(\d+))?$/.exec(s.chapter);
            if (!m) return null;
            return {
              id: s.sid,
              callsign: (typeof s.persona === 'string' && s.persona ? s.persona : 'WINGMAN').toUpperCase(),
              wave: Number(m[1]) || 1,
              x: Number(m[2]),
              y: Number(m[3]),
              firing: m[4] === '1',
              score: Number(m[5]) || 0,
              freed: Number(m[6]) || 0,
              vx: 0,
              vy: 0,
              hull: 3,
              weapon: 'cannon',
            };
          })
          .filter((w): w is WingmanTelemetry => w !== null);
      }
      this.broadcastPresence('sync');
      this.notify();
    } catch {
      /* Offline or local dev without API server: silently continue with local & seeded squad */
    }
  }

  /**
   * Show the server's board in place of this browser's. An empty board from the server is a cleared board,
   * and is shown as one. (A server that sends no board at all, an older one say, changes nothing.)
   */
  private takeBoard(pilots: unknown, liberated: unknown): void {
    if (Array.isArray(pilots)) {
      const board = mergeTopPilots(pilots as PilotScore[]);
      this.topPilots = board.topPilots;
      // The rank is the row this pilot's last run is on, if it is still on the board at all.
      const run = this.lastRun;
      const row = run ? board.topPilots.findIndex((p) => p.callsign === run.callsign && p.score >= run.score) : -1;
      this.lastRank = row < 0 ? null : row + 1;
      this.savePilots();
    }
    if (typeof liberated === 'number' && liberated >= 0) this.totalLiberated = liberated;
  }

  /** Record a finished run's score locally and submit it to the global Top 10 leaderboard. */
  recordScore(score: number, wave: number, freed: number): number | null {
    this.totalLiberated += Math.max(0, Math.floor(freed));
    if (score <= 0) return null;
    const entry: PilotScore = {
      callsign: this.callsign,
      score: Math.floor(score),
      wave: Math.max(1, Math.floor(wave)),
      freed: Math.max(0, Math.floor(freed)),
    };
    const merged = mergeTopPilots(this.topPilots, entry);
    this.topPilots = merged.topPilots;
    this.lastRank = merged.rank;
    this.lastRun = entry;
    this.savePilots();
    this.notify();

    if (typeof fetch !== 'undefined' && this.apiBase && this.serverBoard !== 'shared') {
      void fetch(this.endpoint('/score'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site: this.siteId,
          siteId: this.siteId,
          sid: this.userId,
          userId: this.userId,
          callsign: entry.callsign,
          score: entry.score,
          wave: entry.wave,
          freed: entry.freed,
        }),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const data = (await res.json()) as {
            topPilots?: PilotScore[];
            rank?: number | null;
            totalLiberated?: number;
          };
          this.takeBoard(data.topPilots, data.totalLiberated);
          this.notify();
        })
        .catch(() => {
          /* ignore network errors */
        });
    }
    return this.lastRank;
  }

  /**
   * Advance allied wingmen and their visual tracer lasers, and periodically report player telemetry.
   * A pilot flying alone gets one computer-flown wingman for company; it is labelled as one, not as a player.
   */
  updateFlight(
    dt: number,
    opts: {
      active: boolean;
      w: number;
      h: number;
      scale: number;
      pace: number;
      shipX: number;
      shipY: number;
      wave: number;
      score: number;
      freed: number;
      hull: number;
      firing: boolean;
      enemies: readonly { x: number; y: number; dead?: boolean }[];
    },
  ): void {
    this.time += dt;

    // Keep the position that goes out with each heartbeat up to date while flying in a wave.
    if (opts.active && opts.w > 0 && opts.h > 0) {
      const f = (this.flight ??= { wave: 1, score: 0, freed: 0, x: 0.5, y: 0.8, vx: 0, vy: 0, hull: 0, weapon: 'cannon', firing: false });
      f.wave = opts.wave;
      f.score = opts.score;
      f.freed = opts.freed;
      f.x = clamp(opts.shipX / opts.w, 0.05, 0.95);
      f.y = clamp(opts.shipY / opts.h, 0.25, 0.95);
      f.hull = opts.hull;
      f.firing = opts.firing;
    } else {
      this.flight = null;
    }
    this.setFastPolling(opts.active);

    // Update wingmen lasers.
    for (const l of this.lasers) {
      l.age += dt;
      l.y += l.vy * dt;
    }
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const l = this.lasers[i]!;
      if (l.age > 1.2 || l.y < -20) this.lasers.splice(i, 1);
    }

    if (!opts.active || opts.w <= 0 || opts.h <= 0) {
      this.wingmen.length = 0;
      return;
    }

    // Reconcile live remote wingmen.
    const activeIds = new Set<string>();
    for (const remote of this.remoteWingmen.slice(0, 3)) {
      const id = remote.id || `remote-${remote.callsign}`;
      activeIds.add(id);
      const tx = clamp(remote.x, 0.08, 0.92) * opts.w;
      const ty = clamp(remote.y, 0.36, 0.88) * opts.h;
      let ship = this.wingmen.find((w) => w.id === id);
      if (!ship) {
        ship = {
          id,
          callsign: remote.callsign,
          wave: remote.wave || opts.wave,
          score: remote.score || 0,
          freed: remote.freed || 0,
          x: tx,
          y: opts.h + 40,
          targetX: tx,
          targetY: ty,
          vx: 0,
          vy: 0,
          lean: 0,
          firing: Boolean(remote.firing),
          cooldown: 0.2,
          live: true,
          phase: Math.random() * Math.PI * 2,
          lastSeen: this.time,
        };
        this.wingmen.push(ship);
      } else {
        ship.callsign = remote.callsign;
        ship.wave = remote.wave || opts.wave;
        ship.score = remote.score || ship.score;
        ship.targetX = tx;
        ship.targetY = ty;
        ship.firing = Boolean(remote.firing);
        ship.live = true;
        ship.lastSeen = this.time;
      }
    }

    // With no other pilot about, a computer-flown wingman keeps the player company.
    const desiredSquadSize = Math.min(2, Math.max(1, this.remoteWingmen.length));
    const ghostCountNeeded = Math.max(0, desiredSquadSize - this.remoteWingmen.length);
    for (let g = 0; g < ghostCountNeeded; g++) {
      const name = `WING ${g + 1}`;
      const id = `ghost-${g}`;
      activeIds.add(id);
      let ship = this.wingmen.find((w) => w.id === id);
      const side = g === 0 ? -1 : 1;
      const baseOffsetX = side * Math.min(150 * opts.scale, opts.w * 0.24);
      const swayX = Math.sin(this.time * (1.1 + g * 0.35) + g * 2.1) * 68 * opts.scale;
      const swayY = Math.cos(this.time * (0.85 + g * 0.25) + g * 1.7) * 26 * opts.scale;
      let tx = clamp(opts.shipX + baseOffsetX + swayX, 42 * opts.scale, opts.w - 42 * opts.scale);
      const ty = clamp(opts.shipY - (28 + g * 18) * opts.scale + swayY, opts.h * 0.42, opts.h - 72 * opts.scale);

      // Gently steer toward nearest enemy column when enemies are on screen.
      const targetEnemy = opts.enemies.find((e) => !e.dead && e.y > 0 && e.y < ty - 40);
      if (targetEnemy) {
        tx = clamp(tx * 0.65 + targetEnemy.x * 0.35, 42 * opts.scale, opts.w - 42 * opts.scale);
      }

      if (!ship) {
        ship = {
          id,
          callsign: name,
          wave: opts.wave,
          score: 0,
          freed: 0,
          x: tx,
          y: opts.h + 48,
          targetX: tx,
          targetY: ty,
          vx: 0,
          vy: 0,
          lean: 0,
          firing: opts.enemies.length > 0,
          cooldown: 0.3 + g * 0.18,
          live: false,
          phase: g * 1.9,
          lastSeen: this.time,
        };
        this.wingmen.push(ship);
      } else {
        ship.wave = opts.wave;
        ship.targetX = tx;
        ship.targetY = ty;
        ship.firing = opts.enemies.length > 0 || opts.firing;
        ship.lastSeen = this.time;
      }
    }

    // Remove stale wingmen.
    for (let i = this.wingmen.length - 1; i >= 0; i--) {
      if (!activeIds.has(this.wingmen[i]!.id)) {
        this.wingmen.splice(i, 1);
      }
    }

    // Smoothly interpolate all active wingmen and fire translucent allied tracer lasers.
    const smooth = 1 - Math.exp(-dt * 5.5);
    for (const w of this.wingmen) {
      const prevX = w.x;
      w.x += (w.targetX - w.x) * smooth;
      w.y += (w.targetY - w.y) * smooth;
      const vx = (w.x - prevX) / Math.max(dt, 0.001);
      w.vx = vx;
      w.lean += (clamp(vx / 320, -1, 1) - w.lean) * (1 - Math.exp(-dt * 8));
      w.cooldown -= dt;
      if (w.firing && w.cooldown <= 0 && this.lasers.length < 18) {
        w.cooldown = w.live ? 0.32 : 0.44;
        this.lasers.push({
          x: w.x,
          y: w.y - 14 * opts.scale,
          vy: -560 * opts.pace,
          color: w.live ? NEON.cyan : NEON.violet,
          age: 0,
        });
      }
    }
  }
}

/** Draw allied wingmen ships and their translucent tracer lasers behind the player's ship. */
export function renderWingmen(
  ctx: CanvasRenderingContext2D,
  ink: Ink,
  wingmen: readonly WingmanShip[],
  lasers: readonly WingmanLaser[],
  scale: number,
  shipScale: number,
  time: number,
): void {
  if (!wingmen.length && !lasers.length) return;

  if (lasers.length) {
    for (const color of [NEON.cyan, NEON.violet]) {
      const group = lasers.filter((l) => l.color === color);
      if (!group.length) continue;
      ink(color, 0.32, 1.2, () => {
        for (const l of group) {
          ctx.moveTo(l.x, l.y);
          ctx.lineTo(l.x, l.y + 11 * scale);
        }
      }, false);
    }
  }

  const s = 0.86 * shipScale;
  for (const w of wingmen) {
    const color = w.live ? NEON.cyan : NEON.violet;
    const pulse = 0.36 + 0.06 * Math.sin(time * 4 + w.phase);
    const tilt = w.lean * 0.14;
    ink(color, pulse, 1.35, () => {
      trace(ctx, SHIP, w.x, w.y, s, tilt);
    });
    const flame = (6 + 3 * Math.sin(time * 18 + w.phase)) * s;
    ink(PINK, 0.32, 1.1, () => {
      ctx.moveTo(w.x - 2.6 * s, w.y + 13 * s);
      ctx.lineTo(w.x, w.y + 13 * s + flame);
      ctx.lineTo(w.x + 2.6 * s, w.y + 13 * s);
    }, false);
    // A real pilot is shown with the wave they are on; a computer-flown wingman just has its name.
    const tag = w.live ? `${w.callsign} W${w.wave}` : w.callsign;
    ink(color, 0.48, 1, () => {
      traceText(ctx, tag, w.x, w.y + 22 * s, Math.max(6.5, 7.5 * scale), 'center');
    }, false);
  }
}

/** Render the glowing vector Top 10 Pilots Leaderboard overlay. */
export function renderLeaderboardPanel(
  ctx: CanvasRenderingContext2D,
  ink: Ink,
  w: number,
  h: number,
  room: number,
  topY: number,
  pilots: readonly PilotScore[],
  callsign: string,
  lastRank: number | null,
  totalLiberated: number,
  onlineCount: number,
  alpha = 1,
  touch = false,
): void {
  const panelW = Math.min(room, 440);
  const rows = pilots.slice(0, 10);
  const rowH = h < 540 ? 18 : 22;
  const panelH = 86 + Math.max(1, rows.length) * rowH + 34;
  const x = (w - panelW) / 2;
  const y = clamp(topY, 44, Math.max(44, h - panelH - 24));

  ctx.save();
  ctx.fillStyle = `rgba(3, 7, 26, ${(0.88 * alpha).toFixed(3)})`;
  ctx.fillRect(x - 12, y - 12, panelW + 24, panelH + 24);
  ctx.restore();

  ink(NEON.cyan, 0.55 * alpha, 1.4, () => {
    ctx.rect(x - 12, y - 12, panelW + 24, panelH + 24);
  });

  const titleSize = h < 540 ? 15 : 18;
  ink(SAND, alpha, 2, () => {
    traceText(ctx, 'TOP 10 PILOTS', w / 2, y + 4, titleSize, 'center');
  });

  const sub = `PILOT ${callsign}${lastRank ? ` - RANK ${lastRank}` : ''} - ONLINE ${Math.max(1, onlineCount)}`;
  ink(NEON.cyan, 0.85 * alpha, 1.2, () => {
    traceText(ctx, sub, w / 2, y + titleSize + 14, 8.5, 'center');
  }, false);

  const headerY = y + titleSize + 34;
  const colRank = x + 8;
  const colName = x + 52;
  const colWave = x + panelW - 126;
  const colScore = x + panelW - 8;

  ink(SAND, 0.55 * alpha, 1.1, () => {
    traceText(ctx, 'RNK', colRank, headerY, 7.5);
    traceText(ctx, 'CALLSIGN', colName, headerY, 7.5);
    traceText(ctx, 'WAVE', colWave, headerY, 7.5);
    traceText(ctx, 'SCORE', colScore, headerY, 7.5, 'right');
  }, false);

  if (!rows.length) {
    ink(SAND, 0.8 * alpha, 1.2, () => {
      traceText(ctx, 'NO SCORES YET. BE THE FIRST!', w / 2, headerY + 16, h < 540 ? 8.5 : 9.5, 'center');
    }, false);
  }
  rows.forEach((p, idx) => {
    const ry = headerY + 16 + idx * rowH;
    const isSelf = p.callsign === callsign;
    const isPodium = idx < 3;
    const color = isSelf ? NEON.lime : isPodium ? PINK : SAND;
    const rowAlpha = (isSelf ? 1 : isPodium ? 0.92 : 0.78) * alpha;
    const weight = isSelf ? 1.6 : 1.25;
    const fontSize = h < 540 ? 8.5 : 9.5;

    ink(color, rowAlpha, weight, () => {
      traceText(ctx, String(idx + 1), colRank, ry, fontSize);
      traceText(ctx, p.callsign, colName, ry, fontSize);
      traceText(ctx, `W${p.wave}`, colWave, ry, fontSize);
      traceText(ctx, String(p.score), colScore, ry, fontSize, 'right');
    }, isSelf || idx === 0);
  });

  const footY = headerY + 20 + Math.max(1, rows.length) * rowH;
  // (The stroke font has no brackets or '#'. Someone at a touch screen has no C or L key either.)
  const footer = `GALACTIC LIBERATED ${totalLiberated} - ${touch ? 'TAP THE STAR TO CLOSE' : 'C: NEW CALLSIGN - L: BACK'}`;
  const footSize = textWidth(footer, 8) > panelW ? 7 : 8;
  ink(SAND, 0.72 * alpha, 1.15, () => {
    traceText(ctx, footer, w / 2, footY, footSize, 'center');
  }, false);
}
