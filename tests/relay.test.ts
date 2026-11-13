/**
 * Unit, security, Durable Object `alarm()`, post-deploy restart reconciliation,
 * late-close reconnect race, and Hibernation rehydration tests for `relay/room.mjs` & `relay/worker.mjs`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BIN_INPUT,
  BIN_SNAP,
  CoopRoom,
  GUEST_FLOOD_DISCONNECT_PER_SEC,
  GUEST_MAX_MESSAGES_PER_SEC,
  HOST_FLOOD_DISCONNECT_PER_SEC,
  HOST_MAX_BYTES,
  HOST_MAX_MESSAGES_PER_SEC,
  LOBBY_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  ROOM_MAX_LIFETIME_MS,
  formatRoomCode,
  generateRoomCode,
  normalizeRoomCode,
  sanitizeHostEvent,
} from '../relay/room.mjs';
import worker, { CoopRoomDO, verifyGatewayAndClientIp } from '../relay/worker.mjs';

class MockSocket {
  texts: Array<Record<string, unknown>> = [];
  binaries: Uint8Array[] = [];
  closedWith: { code: number; reason: string } | null = null;
  attachment: Record<string, unknown> | null = null;

  sendText(str: string): void {
    this.texts.push(JSON.parse(str) as Record<string, unknown>);
  }

  sendBinary(u8: Uint8Array): void {
    this.binaries.push(new Uint8Array(u8));
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  setAttachment(obj: Record<string, unknown> | null): void {
    this.attachment = obj ? structuredClone(obj) : null;
  }
}

class HibernatableWs {
  texts: Array<Record<string, unknown>> = [];
  binaries: Uint8Array[] = [];
  closedWith: { code: number; reason: string } | null = null;
  att: unknown = null;

  send(payload: string | Uint8Array): void {
    if (typeof payload === 'string') {
      this.texts.push(JSON.parse(payload) as Record<string, unknown>);
    } else {
      this.binaries.push(new Uint8Array(payload));
    }
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.att = value ? structuredClone(value) : null;
  }

  deserializeAttachment(): unknown {
    return this.att ? structuredClone(this.att) : null;
  }

  last(type: string): Record<string, unknown> | undefined {
    return [...this.texts].reverse().find((t) => t.type === type);
  }
}

function createFakeDOWorld() {
  const w = {
    store: new Map<string, unknown>(),
    sockets: [] as HibernatableWs[],
    alarmAt: null as number | null,
    puts: 0,
    obj: null as unknown as InstanceType<typeof CoopRoomDO>,
    sleep: () => {},
    join: async (_opts: Record<string, unknown>): Promise<HibernatableWs> => new HibernatableWs(),
    say: async (_ws: HibernatableWs, _msg: Record<string, unknown>): Promise<void> => {},
  };

  const ctx = {
    acceptWebSocket: (ws: HibernatableWs) => {
      w.sockets.push(ws);
    },
    getWebSockets: () => w.sockets.filter((s) => !s.closedWith),
    waitUntil: () => {},
    storage: {
      get: async (k: string) => (w.store.has(k) ? structuredClone(w.store.get(k)) : undefined),
      put: async (k: string, v: unknown) => {
        w.puts += 1;
        w.store.set(k, structuredClone(v));
      },
      deleteAll: async () => {
        w.store.clear();
      },
      setAlarm: async (t: number) => {
        w.alarmAt = t;
      },
      deleteAlarm: async () => {
        w.alarmAt = null;
      },
    },
  };

  w.sleep = () => {
    w.obj = new CoopRoomDO(ctx, { RELAY_ENV: 'staging' });
  };
  w.join = async (opts: Record<string, unknown>) => {
    const ws = new HibernatableWs();
    w.sockets.push(ws);
    w.obj.wrapSocket(ws);
    w.obj.pendingJoins.set(ws, {
      code: '2YCD44',
      role: 'guest',
      callsign: '',
      token: '',
      tvMode: false,
      clientId: '',
      ...opts,
    });
    await w.obj.completeJoin(ws);
    return ws;
  };
  w.say = async (ws: HibernatableWs, msg: Record<string, unknown>) => {
    await w.obj.webSocketMessage(ws, JSON.stringify(msg));
  };

  w.sleep();
  return w;
}

test('room codes reject biased bytes >= 248, strip lookalike characters, and normalize cleanly', () => {
  let callCount = 0;
  const codeFromEdgeBytes = generateRoomCode(() => {
    callCount++;
    return new Uint8Array([255, 254, 253, 252, 251, 250, 249, 248, 248, 255, 0, 30, 31, 61, 62, 247]);
  });
  assert.equal(callCount, 1);
  assert.equal(codeFromEdgeBytes, '2Z2Z2Z');

  for (let i = 0; i < 40; i++) {
    const code = generateRoomCode();
    assert.equal(code.length, 6);
    assert.ok(!/[0O1IL]/.test(code), `no ambiguous characters in ${code}`);
    const formatted = formatRoomCode(code);
    assert.match(formatted, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    assert.equal(normalizeRoomCode(formatted.toLowerCase()), code);
  }
});

test('CoopRoom sends refused reasons, blocks kicked cid/token without storing IPs, holds lobby seats 30s, and counts oversize floods', () => {
  const room = new CoopRoom('K7M4P9', { now: 1_000 });
  const host = new MockSocket();
  const g1 = new MockSocket();
  const g2 = new MockSocket();
  const g3 = new MockSocket();
  const extra = new MockSocket();

  const earlyGuest = new MockSocket();
  assert.equal(room.connect(earlyGuest, { role: 'guest', now: 900 }).ok, false);
  assert.equal(earlyGuest.texts[0]?.reason, 'not-found');
  assert.equal(earlyGuest.closedWith?.code, 4004);

  const hostJoin = room.connect(host, { role: 'host', callsign: 'NOVA-7', now: 1_000 });
  assert.equal(hostJoin.ok, true);

  const j1 = room.connect(g1, { role: 'guest', callsign: 'COMET-4', clientId: 'kid-1', now: 1_010 });
  const j2 = room.connect(g2, { role: 'guest', callsign: 'BAD FREE TEXT!!', clientId: 'kid-2', now: 1_020 });
  const j3 = room.connect(g3, { role: 'guest', callsign: 'NOVA-7', clientId: 'kid-3', now: 1_030 });
  assert.equal(j1.seat, 1);
  assert.equal(j2.seat, 2);
  assert.equal(j3.seat, 3);

  // Full room tells 5th player `reason: 'full'`
  assert.equal(room.connect(extra, { role: 'guest', now: 1_040 }).ok, false);
  assert.equal(extra.texts[0]?.reason, 'full');

  // Lobby guest (Seat 1) sets ready, locks phone screen (disconnects), and returns 5s later keeping seat + ready!
  room.handleText(g1, JSON.stringify({ type: 'ready', ready: true }), 1_042);
  room.disconnect(g1, 1_045);
  assert.equal(room.publicSeats().find((s) => s.seat === 1)?.connected, false);
  assert.equal(room.publicSeats().find((s) => s.seat === 1)?.ready, true);

  const g1BackInLobby = new MockSocket();
  const lobbyRejoin = room.connect(g1BackInLobby, { role: 'guest', token: j1.token, now: 6_000 });
  assert.equal(lobbyRejoin.ok, true);
  assert.equal(lobbyRejoin.seat, 1);
  assert.equal(room.publicSeats().find((s) => s.seat === 1)?.ready, true);

  // Host kicks Seat 2 -> blocked by token and by hashed `cid`, while a fresh tab (`kid-4`) takes Seat 2
  room.handleText(host, JSON.stringify({ type: 'kick', seat: 2 }), 6_050);
  assert.equal(g2.texts.at(-1)?.reason, 'kicked');
  assert.equal(g2.attachment, null, 'kicked socket attachment cleared');

  const rejoinByCid = new MockSocket();
  assert.equal(room.connect(rejoinByCid, { role: 'guest', clientId: 'kid-2', now: 6_055 }).ok, false);
  assert.equal(rejoinByCid.texts[0]?.reason, 'kicked');

  const g4 = new MockSocket();
  assert.equal(room.connect(g4, { role: 'guest', clientId: 'kid-4', now: 6_060 }).seat, 2);

  // Single oversize host message drops without closing room; 100 oversize messages in 1s triggers flood limiter!
  const hugePayload = JSON.stringify({ type: 'event', kind: 'asteroid-seed', pad: 'x'.repeat(HOST_MAX_BYTES + 500) });
  room.handleText(host, hugePayload, 6_100);
  assert.equal(room.closed, false);
  assert.equal(host.texts.at(-1)?.reason, 'message-too-large');

  // Event sanitizer strips all free-text strings
  assert.deepEqual(
    sanitizeHostEvent({ type: 'event', kind: 'wave-clear', wave: 2, chat: 'nope' }),
    { type: 'event', kind: 'wave-clear', wave: 2 },
  );

  // Seat spoofing protection on binary input
  room.handleBinary(g3, new Uint8Array([BIN_INPUT, 1, 0xaa, 0xbb]), 7_200);
  assert.equal(host.binaries[0]![1], 3);

  // Explicit `leave` from guest (Seat 2 / g4) frees seat immediately without 30s hold and invalidates token
  const g4Token = String(g4.texts.find((m) => m.type === 'welcome')?.token);
  room.handleText(g4, JSON.stringify({ type: 'leave' }), 7_500);
  assert.equal(g4.closedWith?.code, 1000);
  assert.equal(
    room.publicSeats().some((s) => s.seat === 2),
    false,
    'explicit leave frees seat immediately rather than holding 30s',
  );
  const g4StaleRetry = new MockSocket();
  assert.equal(room.connect(g4StaleRetry, { role: 'guest', token: g4Token, now: 7_510 }).ok, false);
  assert.equal(g4StaleRetry.texts[0]?.reason, 'expired');

  // Host rate allowance (65/s): 18 binary snapshots + 47 events in 1s all pass with 0 drops;
  // message #66 drops and emits ONE `{ type: 'error', reason: 'rate-limited' }` for that 1s window!
  const g3SnapsBefore = g3.binaries.length;
  const g3EventsBefore = g3.texts.filter((m) => m.type === 'event').length;
  for (let i = 0; i < 18; i++) {
    room.handleBinary(host, new Uint8Array([BIN_SNAP, i, 1, 2]), 8_000);
  }
  for (let i = 0; i < HOST_MAX_MESSAGES_PER_SEC - 18; i++) {
    room.handleText(host, JSON.stringify({ type: 'event', kind: 'wave-sync', wave: i }), 8_000);
  }
  assert.equal(g3.binaries.length - g3SnapsBefore, 18, 'all 18 snapshots delivered');
  assert.equal(
    g3.texts.filter((m) => m.type === 'event').length - g3EventsBefore,
    HOST_MAX_MESSAGES_PER_SEC - 18,
    'all 47 host events in the same second delivered',
  );
  assert.equal(
    host.texts.some((m) => m.type === 'error' && m.reason === 'rate-limited'),
    false,
    'no rate-limit error within host budget',
  );

  // Burst 10 more events in the same second -> dropped, with exactly 1 `rate-limited` warning
  for (let i = 0; i < 10; i++) {
    room.handleText(host, JSON.stringify({ type: 'event', kind: 'wave-sync', wave: 99 }), 8_000);
  }
  assert.equal(
    host.texts.filter((m) => m.type === 'error' && m.reason === 'rate-limited').length,
    1,
    'sender notified once per 1s window when messages are rate-limited',
  );

  // Guest flood check (`GUEST_MAX_MESSAGES_PER_SEC = 35`, `GUEST_FLOOD_DISCONNECT_PER_SEC = 90`)
  for (let i = 0; i < GUEST_MAX_MESSAGES_PER_SEC + 5; i++) {
    room.handleText(g3, JSON.stringify({ type: 'ping', t: i }), 8_500);
  }
  assert.equal(
    g3.texts.filter((m) => m.type === 'error' && m.reason === 'rate-limited').length,
    1,
    'guest notified once when exceeding 35 msg/sec',
  );
  for (let i = 0; i < GUEST_FLOOD_DISCONNECT_PER_SEC; i++) {
    room.handleText(g3, JSON.stringify({ type: 'ping', t: i }), 8_500);
  }
  assert.equal(g3.closedWith?.code, 1008);

  // Flood of oversize frames on host disconnects above `HOST_FLOOD_DISCONNECT_PER_SEC`
  const errCountBefore = host.texts.filter((m) => m.type === 'error').length;
  for (let i = 0; i < HOST_FLOOD_DISCONNECT_PER_SEC + 10; i++) {
    room.handleText(host, hugePayload, 9_500);
  }
  const errCountDelta = host.texts.filter((m) => m.type === 'error').length - errCountBefore;
  assert.ok(
    errCountDelta <= HOST_MAX_MESSAGES_PER_SEC + 1,
    `capped error replies (${errCountDelta} <= ${HOST_MAX_MESSAGES_PER_SEC + 1})`,
  );
  assert.equal(host.closedWith?.code, 1008);
});

test('Reconnect arriving before old socket close (3.1) & alarm loop prevention (3.2) hold for Host and Guest across hibernation', async (t) => {
  const realNow = Date.now;
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  t.after(() => {
    Date.now = realNow;
  });

  // 1. Host reconnects while old socket is frozen; old socket dies later (even after hibernation!)
  {
    const w = createFakeDOWorld();
    const host1 = await w.join({ role: 'host' });
    const hostToken = String(host1.last('welcome')?.token);
    const guest = await w.join({});
    await w.say(host1, { type: 'start' });

    clock += 4_000;
    const host2 = await w.join({ role: 'host', token: hostToken });
    assert.equal(host1.last('refused')?.reason, 'replaced', 'replaced host socket receives refused: replaced before 4001');
    assert.deepEqual(host1.closedWith, { code: 4001, reason: 'Replaced by reconnect' });
    assert.equal(host1.att, null, 'superseded host socket attachment cleared');

    // Simulate hibernation before the frozen old socket finally closes on the network!
    w.sleep();
    clock += 10_000;
    const guestMsgIdx = guest.texts.length;
    await w.obj.webSocketClose(host1);

    assert.equal(
      guest.texts.slice(guestMsgIdx).some((m) => m.type === 'host-reconnecting'),
      false,
      'late close of old host socket must NOT emit host-reconnecting',
    );
    assert.equal(w.obj.room?.hostDisconnectedAt, null);

    // Controls from guest still reach host2, and snapshots from host2 still reach guest!
    await w.obj.webSocketMessage(guest, new Uint8Array([BIN_INPUT, 0, 1, 2, 3, 4]).buffer);
    await w.obj.webSocketMessage(host2, new Uint8Array([BIN_SNAP, 9, 8, 7]).buffer);
    assert.equal(host2.binaries.length, 1);
    assert.equal(host2.binaries[0]![1], 1);
    assert.equal(guest.binaries.length, 1);

    // 30s later, alarm does NOT close the room!
    clock += RECONNECT_GRACE_MS + 1_000;
    await w.obj.alarm();
    assert.equal(guest.last('room-closed'), undefined);
    assert.equal(host2.closedWith, null);
  }

  // 2. Guest reconnects before old socket closes (both in lobby and in started game)
  for (const inGame of [false, true]) {
    const w = createFakeDOWorld();
    const host = await w.join({ role: 'host' });
    const guest1 = await w.join({});
    const guestToken = String(guest1.last('welcome')?.token);
    if (inGame) await w.say(host, { type: 'start' });

    clock += 3_000;
    const guest2 = await w.join({ token: guestToken });
    assert.equal(guest1.last('refused')?.reason, 'replaced', 'replaced guest socket receives refused: replaced before 4001');
    assert.deepEqual(guest1.closedWith, { code: 4001, reason: 'Replaced by reconnect' });
    clock += 200;
    await w.obj.webSocketClose(guest1);

    const lobbySeats = host.last('lobby')?.seats as Array<{ seat: number; connected: boolean }>;
    assert.equal(lobbySeats.find((s) => s.seat === 1)?.connected, true, `inGame=${inGame}: seat 1 stays connected`);

    // Addressed event reaches guest2
    const beforeLen = guest2.texts.length;
    await w.say(host, { type: 'event', kind: 'challenge', to: 1, id: 7 });
    assert.equal(
      guest2.texts.slice(beforeLen).filter((m) => m.type === 'event').length,
      1,
      `inGame=${inGame}: targeted event reaches guest2`,
    );

    // 30s later, seat 1 is still connected and alarm is never armed in the past
    clock += RECONNECT_GRACE_MS + 500;
    await w.obj.alarm();
    assert.ok(w.alarmAt === null || w.alarmAt > clock, 'alarm is strictly in the future');
    const seatsAfter = host.last('lobby')?.seats as Array<{ seat: number; connected: boolean }>;
    assert.equal(seatsAfter.find((s) => s.seat === 1)?.connected, true);
  }
});

test('DO alarm() enforces 10m lobby limit, 2h game limit, post-restart missing-socket grace (3.4), ready dedup (3.5), and zero stored IPs', async (t) => {
  const realNow = Date.now;
  let clock = 1_700_100_000_000;
  Date.now = () => clock;
  t.after(() => {
    Date.now = realNow;
  });

  // 1. Two-hour max game lifetime via `alarm()`
  {
    const w = createFakeDOWorld();
    const t0 = clock;
    const host = await w.join({ role: 'host' });
    const guest = await w.join({});
    clock += 60_000;
    await w.say(host, { type: 'start' });
    assert.equal(w.alarmAt, t0 + ROOM_MAX_LIFETIME_MS);

    w.sleep();
    clock = t0 + ROOM_MAX_LIFETIME_MS - 1_000;
    await w.obj.alarm();
    assert.equal(host.last('room-closed'), undefined, 'holds open 1s before 2h limit');

    w.sleep();
    clock = t0 + ROOM_MAX_LIFETIME_MS;
    await w.obj.alarm();
    assert.equal(host.last('room-closed')?.reason, 'expired');
    assert.equal(guest.last('room-closed')?.reason, 'expired');
    assert.equal(w.store.size, 0);
    assert.equal(w.alarmAt, null);
  }

  // 2. Ten-minute empty lobby timeout via `alarm()`
  {
    const w = createFakeDOWorld();
    const t0 = clock;
    const host = await w.join({ role: 'host' });
    assert.equal(w.alarmAt, t0 + LOBBY_TIMEOUT_MS);
    w.sleep();
    clock = t0 + LOBBY_TIMEOUT_MS;
    await w.obj.alarm();
    assert.equal(host.last('room-closed')?.reason, 'expired');
    assert.equal(w.store.size, 0);
  }

  // 3. Relay restart / Worker deploy drops all sockets: returning guest is told `host-reconnecting`,
  // and if host never comes back, room closes 30s later via `alarm()`!
  {
    const w = createFakeDOWorld();
    const host = await w.join({ role: 'host' });
    const guest = await w.join({});
    const guestToken = String(guest.last('welcome')?.token);
    await w.say(host, { type: 'start' });

    // Simulate relay container restart: all sockets disappear without firing `webSocketClose`, storage stays!
    w.sockets.length = 0;
    w.sleep();
    clock += 5_000;

    const guestBack = await w.join({ role: 'guest', token: guestToken });
    assert.equal(guestBack.last('welcome')?.seat, 1);
    assert.equal(
      guestBack.texts.some((m) => m.type === 'host-reconnecting'),
      true,
      'returning guest after restart is told host is reconnecting',
    );
    assert.equal(w.alarmAt, clock + RECONNECT_GRACE_MS);

    // Host never returns -> 30s later `alarm()` closes the room!
    w.sleep();
    clock += RECONNECT_GRACE_MS;
    await w.obj.alarm();
    assert.equal(guestBack.last('room-closed')?.reason, 'host-left');
    assert.equal(w.store.size, 0);
  }

  // 4. Storage audit: 0 writes for duplicate/post-start `ready`, 0 writes during play, ZERO IPs & ZERO raw clientIds stored!
  {
    const w = createFakeDOWorld();
    const host = await w.join({ role: 'host', clientId: 'browser-abc' });
    const guest = await w.join({ clientId: 'browser-def' });

    // Toggling ready true once in lobby writes once; sending ready: true 10 more times writes 0!
    const putsBeforeLobbyReady = w.puts;
    await w.say(guest, { type: 'ready', ready: true });
    assert.equal(w.puts - putsBeforeLobbyReady, 1);
    for (let i = 0; i < 10; i++) await w.say(guest, { type: 'ready', ready: true });
    assert.equal(w.puts - putsBeforeLobbyReady, 1, 'duplicate lobby ready writes nothing');

    await w.say(host, { type: 'start' });
    const putsAfterStart = w.puts;
    for (let i = 0; i < 30; i++) await w.say(guest, { type: 'ready', ready: false });
    assert.equal(w.puts - putsAfterStart, 0, 'mid-game ready is ignored completely');

    for (let i = 0; i < 20; i++) {
      await w.obj.webSocketMessage(host, new Uint8Array([BIN_SNAP, 1, 2, 3]).buffer);
      await w.say(guest, { type: 'ping', t: i });
      await w.say(guest, { type: 'answer', id: i, verdict: 'good', quality: 0.8 });
      await w.say(host, { type: 'event', kind: 'wave-sync', n: i });
    }
    assert.equal(w.puts - putsAfterStart, 0, 'zero storage writes during steady-state gameplay');

    // Cold-wake orphan socket receives `{ type: 'refused', reason: 'expired' }` before 4004 close
    const orphanWs = new HibernatableWs();
    orphanWs.serializeAttachment({ token: 'stale-orphan-token', role: 'guest', seat: 2, gen: 99 });
    w.sockets.push(orphanWs);
    w.sleep();
    await w.say(host, { type: 'ping', t: 42 });
    assert.equal(orphanWs.last('refused')?.reason, 'expired');
    assert.equal(orphanWs.closedWith?.code, 4004);

    const stored = w.store.get('room') as Record<string, unknown>;
    assert.equal('hostIp' in stored, false, 'no host IP stored');
    assert.equal('kickedIps' in stored, false, 'no kicked IPs stored');
    const storedSeats = stored.seats as Array<Record<string, unknown>>;
    for (const s of storedSeats) {
      assert.equal('ip' in s, false, 'no seat IP stored');
      assert.equal('clientId' in s, false, 'no raw browser clientId stored');
    }
  }
});

test('Worker gateway fails closed without ORIGIN_SECRET in prod, rejects 5-char codes, and allows 40+ classroom joins per IP', async () => {
  const unlockedProdRes = await worker.fetch(
    new Request('https://relay.geurtsgaming.com/health', {
      headers: { Origin: 'https://geurtsgaming.com' },
    }),
    { RELAY_ENV: 'production' },
  );
  assert.equal(unlockedProdRes.status, 503);

  const lockedEnv = {
    RELAY_ENV: 'production',
    ORIGIN_SECRET: 'cf-secret-xyz',
    COOP_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => new Response(null, { status: 200 }),
      }),
    },
  };

  const bypassRes = await worker.fetch(
    new Request('https://gg-relay.example.workers.dev/health', {
      headers: { Origin: 'https://geurtsgaming.com', 'CloudFront-Viewer-Address': '198.51.100.7:54321' },
    }),
    lockedEnv,
  );
  assert.equal(bypassRes.status, 403);

  const healthRes = await worker.fetch(
    new Request('https://relay.geurtsgaming.com/health', {
      headers: { Origin: 'https://geurtsgaming.com', 'X-Relay-Secret': 'cf-secret-xyz' },
    }),
    lockedEnv,
  );
  assert.equal(healthRes.status, 200);
  const healthJson = (await healthRes.json()) as { ok: boolean; protocol: number; locked: boolean };
  assert.equal(healthJson.protocol, PROTOCOL_VERSION);
  assert.equal(healthJson.locked, true);

  const shortCodeRes = await worker.fetch(
    new Request('https://relay.geurtsgaming.com/room/ABCDE', {
      headers: {
        Origin: 'https://geurtsgaming.com',
        'X-Relay-Secret': 'cf-secret-xyz',
        'CloudFront-Viewer-Address': '198.51.100.44:12345',
      },
    }),
    lockedEnv,
  );
  assert.equal(shortCodeRes.status, 400);

  for (let i = 0; i < 40; i++) {
    const joinRes = await worker.fetch(
      new Request('https://relay.geurtsgaming.com/room/2YCD44', {
        headers: {
          Origin: 'https://geurtsgaming.com',
          'X-Relay-Secret': 'cf-secret-xyz',
          'CloudFront-Viewer-Address': '198.51.100.88:50000',
        },
      }),
      lockedEnv,
    );
    assert.equal(joinRes.status, 200);
  }

  const gate = verifyGatewayAndClientIp(
    new Request('https://relay.geurtsgaming.com/room', {
      method: 'POST',
      headers: {
        Origin: 'https://geurtsgaming.com',
        'X-Relay-Secret': 'cf-secret-xyz',
        'CloudFront-Viewer-Address': '198.51.100.7:54321',
      },
    }),
    lockedEnv,
  );
  assert.equal(gate.ok, true);
  assert.equal(gate.locked, true);
  assert.equal(gate.ip, '198.51.100.7');

  for (const badSecret of ['cf-secret-xy', 'cf-secret-xyz-extra', 'cf-secret-xyZ', '']) {
    const badGate = verifyGatewayAndClientIp(
      new Request('https://relay.geurtsgaming.com/room', {
        method: 'POST',
        headers: { 'X-Relay-Secret': badSecret },
      }),
      lockedEnv,
    );
    assert.equal(badGate.ok, false, `rejects invalid secret "${badSecret}"`);
    assert.equal(badGate.status, 403);
  }
});
