// Single Cloudflare Worker + Durable Object (WebSocket Hibernation API) entry point.
// Runs identically in local Docker (`wrangler dev --local` on `workerd` inside `geurtsgaming-relay`)
// and in production on Cloudflare Workers — no second local implementation to drift out of sync.
//
// Hibernation, Reconnect & Privacy Guarantees:
// - Stores ZERO IP addresses and ZERO raw browser identifiers in Durable Object storage.
// - Re-attaches sockets ONLY during cold storage wake-up (verifying monotonic `gen` counters so a late
//   `close` from a superseded socket never undoes a reconnect), and starts 30s disconnect timers on any
//   seats missing sockets after a Worker deploy/restart.
// - Performs ZERO `ctx.storage` reads/writes during steady-state gameplay (`BIN_INPUT`, `BIN_SNAP`, `ping`, `event`, `answer`).
// - Never arms a Durable Object `alarm()` in the past.

import {
  CODE_LENGTH,
  CoopRoom,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  formatRoomCode,
  generateRoomCode,
  isAllowedRelayOrigin,
  normalizeRoomCode,
  randomToken,
} from './room.mjs';

// Classroom-safe per-IP limits (in-memory per Worker isolate; salted & one-way hashed so not even
// transient isolate RAM holds raw IP address strings, and never persisted to storage).
const MAX_ROOMS_PER_IP_PER_MIN = 60;
const MAX_JOIN_ATTEMPTS_PER_IP_PER_MIN = 300;
const ISOLATE_RATE_SALT = randomToken();
const createRateByIp = new Map();
const hostOpenRateByIp = new Map();
const joinRateByIp = new Map();

export function hashRateKey(ip) {
  const input = `${ISOLATE_RATE_SALT}:${ip || 'unknown'}`;
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function inspectRateMapKeys() {
  return [
    ...createRateByIp.keys(),
    ...hostOpenRateByIp.keys(),
    ...joinRateByIp.keys(),
  ];
}

function checkIpRate(map, ip, limit, now = Date.now()) {
  const key = hashRateKey(ip);
  const recent = (map.get(key) || []).filter((ts) => now - ts < 60_000);
  if (recent.length >= limit) {
    map.set(key, recent);
    return false;
  }
  recent.push(now);
  if (map.size > 512) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, recent);
  return true;
}

const textEncoder = new TextEncoder();

/**
 * Constant-time UTF-8 secret comparison (iterates strictly over `expected` length with zero
 * secret-dependent branches so neither prefix matches nor length differences leak via timing).
 */
function timingSafeEqualSecret(provided, expected) {
  const pBytes = textEncoder.encode(String(provided));
  const eBytes = textEncoder.encode(String(expected));
  if (eBytes.length === 0) return false;
  let diff = pBytes.length ^ eBytes.length;
  for (let i = 0; i < eBytes.length; i++) {
    const pByte = i < pBytes.length ? pBytes[i] : 0;
    diff |= pByte ^ eBytes[i];
  }
  return diff === 0;
}

/**
 * Verify CloudFront's custom origin secret so `*.workers.dev` cannot be reached directly around
 * CloudFront in production (fail-closed if `ORIGIN_SECRET` is missing in production!), and
 * extract the real viewer IP in-memory only for per-minute rate limiting.
 */
export function verifyGatewayAndClientIp(request, env) {
  const isStaging = env?.RELAY_ENV === 'staging';
  const expectedSecret = typeof env?.ORIGIN_SECRET === 'string' ? env.ORIGIN_SECRET.trim() : '';
  const providedSecret = request.headers.get('X-Relay-Secret') || '';

  if (!isStaging && !expectedSecret) {
    return { ok: false, status: 503, locked: false, ip: '', error: 'ORIGIN_SECRET not configured' };
  }

  if (expectedSecret) {
    if (!timingSafeEqualSecret(providedSecret, expectedSecret)) {
      return { ok: false, status: 403, locked: true, ip: '', error: 'Direct origin access forbidden' };
    }
    const cfViewer = request.headers.get('CloudFront-Viewer-Address') || '';
    if (cfViewer) {
      const bracketMatch = /^\[([^\]]+)\]:\d+$/.exec(cfViewer.trim());
      if (bracketMatch) return { ok: true, status: 200, locked: true, ip: bracketMatch[1] };
      const lastColon = cfViewer.lastIndexOf(':');
      return {
        ok: true,
        status: 200,
        locked: true,
        ip: lastColon > 0 ? cfViewer.slice(0, lastColon) : cfViewer.trim(),
      };
    }
    const xff = request.headers.get('X-Forwarded-For') || '';
    if (xff) return { ok: true, status: 200, locked: true, ip: xff.split(',')[0].trim() };
    return { ok: true, status: 200, locked: true, ip: 'cloudfront' };
  }

  const directIp =
    request.headers.get('CF-Connecting-IP') ||
    (isStaging ? (request.headers.get('X-Real-IP') || '').trim() : '') ||
    'local';
  return { ok: true, status: 200, locked: false, ip: directIp };
}

export class CoopRoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.socketWrappers = new Map();
    this.pendingJoins = new Map();
  }

  wrapSocket(ws) {
    let wrapped = this.socketWrappers.get(ws);
    if (!wrapped) {
      wrapped = {
        sendText: (str) => ws.send(str),
        sendBinary: (u8) => ws.send(u8),
        close: (code, reason) => ws.close(code, reason),
        setAttachment: (obj) => ws.serializeAttachment?.(obj),
      };
      this.socketWrappers.set(ws, wrapped);
    }
    return wrapped;
  }

  /**
   * Ensure `this.room` is hydrated in memory:
   * - If already in memory, NEVER re-attach missing sockets (a socket missing from `room.conns`
   *   was already replaced, kicked, or refused!).
   * - When waking cold from `ctx.storage`, re-bind valid live sockets from `ctx.getWebSockets()`
   *   (closing any orphan sockets whose attachment no longer matches), plus `closingWs` if waking
   *   specifically on `webSocketClose`, and start 30s grace timers for any seats missing sockets
   *   (e.g. right after a Worker deploy / container restart).
   */
  async ensureRoom(fallbackCode = '', closingWs = null) {
    if (this.room && !this.room.closed) {
      return this.room;
    }

    const now = Date.now();
    const saved = await this.ctx.storage?.get?.('room');
    if (saved && !saved.closed) {
      const room = CoopRoom.fromPersisted(saved);
      const liveSockets = typeof this.ctx.getWebSockets === 'function' ? this.ctx.getWebSockets() : [];
      for (const ws of liveSockets) {
        if (this.pendingJoins.has(ws)) continue;
        const att = ws.deserializeAttachment?.() || null;
        if (att && att.pending === true) continue;
        if (!att || !room.reattachSocket(this.wrapSocket(ws), att, now)) {
          try {
            ws.serializeAttachment?.(null);
            ws.send(JSON.stringify({ type: 'refused', reason: 'expired' }));
            ws.close(4004, 'Session expired');
          } catch {
            /* ignore */
          }
        }
      }
      if (closingWs && !liveSockets.includes(closingWs)) {
        const att = closingWs.deserializeAttachment?.() || null;
        if (att) {
          room.reattachSocket(this.wrapSocket(closingWs), att, now);
        }
      }
      room.reconcileMissingSockets(now);
      this.room = room;
      await this.syncPersistence(now);
      return this.room;
    }

    if (fallbackCode) {
      this.room = new CoopRoom(fallbackCode, { now });
      return this.room;
    }
    return null;
  }

  /** Persist room metadata + next future alarm ONLY when room lifecycle state (`room.dirty`) changed. */
  async syncPersistence(now = Date.now()) {
    if (!this.room || !this.ctx.storage) return;
    if (this.room.closed) {
      await this.ctx.storage.deleteAlarm?.();
      await this.ctx.storage.deleteAll?.();
      this.room = null;
      return;
    }
    if (!this.room.dirty) return;
    this.room.dirty = false;
    if (!this.room.hostToken) return;

    await this.ctx.storage.put('room', this.room.toPersistedState());
    const alarmAt = this.room.nextAlarmAt();
    if (alarmAt !== null && typeof this.ctx.storage.setAlarm === 'function') {
      const safeAlarmAt = alarmAt > now ? alarmAt : now + RECONNECT_GRACE_MS;
      await this.ctx.storage.setAlarm(safeAlarmAt);
    }
  }

  async completeJoin(ws) {
    const joinOpts = this.pendingJoins.get(ws);
    if (!joinOpts) return;
    if (!this.socketWrappers.has(ws)) {
      this.pendingJoins.delete(ws);
      return;
    }

    const now = Date.now();
    const room = await this.ensureRoom(joinOpts.code);
    this.pendingJoins.delete(ws);
    if (!room) return;
    if (joinOpts.tvMode && !room.hostToken && joinOpts.role === 'host') {
      room.tvMode = true;
    }
    room.connect(this.wrapSocket(ws), { ...joinOpts, now });
    await this.syncPersistence(now);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = normalizeRoomCode(url.searchParams.get('code') || 'ROOM00');

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({ ok: false, error: 'Expected WebSocket upgrade' }), {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await this.ensureRoom(code);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment?.({ pending: true });

    this.wrapSocket(server);
    this.pendingJoins.set(server, {
      code,
      role: url.searchParams.get('role') === 'host' ? 'host' : 'guest',
      callsign: url.searchParams.get('callsign') || '',
      token: url.searchParams.get('token') || '',
      tvMode: url.searchParams.get('tv') === '1',
      clientId: url.searchParams.get('cid') || '',
    });

    this.ctx.waitUntil(
      new Promise((resolve) => setTimeout(resolve, 10)).then(() => this.completeJoin(server))
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.completeJoin(ws);
    const room = await this.ensureRoom();
    if (!room) return;

    const now = Date.now();
    const conn = this.wrapSocket(ws);
    if (typeof message === 'string') {
      room.handleText(conn, message, now);
    } else if (message instanceof ArrayBuffer) {
      room.handleBinary(conn, new Uint8Array(message), now);
    } else if (ArrayBuffer.isView(message)) {
      room.handleBinary(conn, new Uint8Array(message.buffer, message.byteOffset, message.byteLength), now);
    }
    await this.syncPersistence(now);
  }

  async webSocketClose(ws) {
    this.pendingJoins.delete(ws);
    const room = await this.ensureRoom('', ws);
    if (room) {
      const now = Date.now();
      const conn = this.wrapSocket(ws);
      room.disconnect(conn, now);
      await this.syncPersistence(now);
    }
    this.socketWrappers.delete(ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    const room = await this.ensureRoom();
    if (!room) return;
    const now = Date.now();
    room.prune(now);
    await this.syncPersistence(now);
    if (this.room && !this.room.closed && this.ctx.storage?.setAlarm) {
      const nextAt = this.room.nextAlarmAt();
      if (nextAt !== null) {
        const safeNextAt = nextAt > now ? nextAt : now + RECONNECT_GRACE_MS;
        await this.ctx.storage.setAlarm(safeNextAt);
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const allowDev = env?.RELAY_ENV === 'staging';
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = isAllowedRelayOrigin(origin, allowDev) ? origin || '*' : 'https://geurtsgaming.com';
    const headers = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const gate = verifyGatewayAndClientIp(request, env);
    if (!gate.ok) {
      return new Response(JSON.stringify({ ok: false, locked: gate.locked, error: gate.error }), {
        status: gate.status || 403,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/relay(?=\/|$)/, '') || '/';

    if (request.method === 'GET' && path === '/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          protocol: PROTOCOL_VERSION,
          env: env?.RELAY_ENV || 'production',
          locked: gate.locked,
        }),
        { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } }
      );
    }

    if (!isAllowedRelayOrigin(origin, allowDev)) {
      return new Response(JSON.stringify({ ok: false, error: 'Origin not allowed' }), {
        status: 403,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'POST' && path === '/room') {
      if (!checkIpRate(createRateByIp, gate.ip, MAX_ROOMS_PER_IP_PER_MIN)) {
        return new Response(JSON.stringify({ ok: false, error: 'Too many rooms created' }), {
          status: 429,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
      const code = generateRoomCode();
      return new Response(
        JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, code, formattedCode: formatRoomCode(code) }),
        { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } }
      );
    }

    const match = /^\/room\/([A-Za-z0-9-]+)$/.exec(path);
    if (match) {
      const isInitialHostOpen = url.searchParams.get('role') === 'host' && !url.searchParams.get('token');
      if (isInitialHostOpen && !checkIpRate(hostOpenRateByIp, gate.ip, MAX_ROOMS_PER_IP_PER_MIN)) {
        return new Response(JSON.stringify({ ok: false, error: 'Too many rooms hosted' }), {
          status: 429,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
      if (!checkIpRate(joinRateByIp, gate.ip, MAX_JOIN_ATTEMPTS_PER_IP_PER_MIN)) {
        return new Response(JSON.stringify({ ok: false, error: 'Too many join attempts' }), {
          status: 429,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
      const rawStripped = match[1].replace(/[\s-]+/g, '').toUpperCase();
      const code = normalizeRoomCode(match[1]);
      if (rawStripped.length !== CODE_LENGTH || code.length !== CODE_LENGTH) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid room code' }), {
          status: 400,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
      const id = env.COOP_ROOMS.idFromName(code);
      const stub = env.COOP_ROOMS.get(id);
      url.searchParams.set('code', code);
      return stub.fetch(new Request(url.toString(), request));
    }

    return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
      status: 404,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  },
};
