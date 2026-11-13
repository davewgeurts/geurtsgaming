import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CoopClient,
  buildCoopInviteUrl,
  consumeInviteCodeFromLocation,
  createCoopRoom,
  detectRelayEndpoints,
  getStoredCoopToken,
  nextAvailableCallsign,
  type StorageLike,
} from '../src/game/coop-client';
import { MultiplayerClient } from '../src/game/multiplayer';

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

/** Deterministic mock WebSocket (`EventTarget`) compatible with `partysocket`'s `ReconnectingWebSocket` wrapper. */
class FakeWs extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWs[] = [];
  static reset(): void {
    FakeWs.instances = [];
  }

  readonly url: string;
  readyState = FakeWs.CONNECTING;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];

  constructor(url: string) {
    super();
    this.url = url;
    FakeWs.instances.push(this);
  }

  send(data: string | Uint8Array): void {
    if (data instanceof Uint8Array) this.sent.push(new Uint8Array(data));
    else this.sent.push(String(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    const ev = Object.assign(new Event('close'), { code, reason });
    this.dispatchEvent(ev);
  }

  serverOpen(): void {
    this.readyState = FakeWs.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  serverSendJson(obj: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) }));
  }

  serverDrop(code = 1006, reason = 'Network drop'): void {
    this.readyState = FakeWs.CLOSED;
    const ev = Object.assign(new Event('close'), { code, reason });
    this.dispatchEvent(ev);
  }
}

test('CoopClient validates room code before connecting and caps pre-welcome handshake retries', async () => {
  FakeWs.reset();
  const storage = new MemoryStorage();
  const refusals: string[] = [];

  // 1. 5-character code is rejected immediately with zero WebSocket connections opened
  const badClient = new CoopClient({
    code: 'ABCDE',
    role: 'guest',
    wsBase: 'ws://localhost:84/relay',
    storage,
    WebSocketConstructor: FakeWs,
    pingIntervalMs: 0,
    onRefused: (r) => refusals.push(r),
  });
  assert.equal(badClient.connect(), false);
  assert.deepEqual(refusals, ['invalid-code']);
  assert.equal(FakeWs.instances.length, 0);

  // 2. Repeated HTTP 400/403/429 handshake failures before `welcome` stop after 3 attempts
  FakeWs.reset();
  const connErrors: string[] = [];
  const retryClient = new CoopClient({
    code: '2YCD44',
    role: 'guest',
    wsBase: 'ws://localhost:84/relay',
    storage,
    WebSocketConstructor: FakeWs,
    pingIntervalMs: 0,
    onConnectionError: (msg) => connErrors.push(msg),
  });
  assert.equal(retryClient.connect(), true);

  for (let attempt = 1; attempt <= 3; attempt++) {
    for (let wait = 0; wait < 25 && FakeWs.instances.length < attempt; wait++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(FakeWs.instances.length, attempt, `attempt ${attempt} opened`);
    FakeWs.instances[attempt - 1]!.serverDrop(1006, 'HTTP 429');
  }

  assert.equal(connErrors.length, 1, 'emits connection error after 3 pre-welcome failures');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(FakeWs.instances.length, 3, 'stops retrying after pre-welcome cap');
});

test('CoopClient stores seat token in sessionStorage, injects token on reconnect, and acts immediately on refused/leave', async () => {
  FakeWs.reset();
  const storage = new MemoryStorage();
  const events: string[] = [];

  const client = new CoopClient({
    code: '2YC-D44',
    role: 'guest',
    callsign: 'NOVA-7',
    wsBase: 'ws://localhost:84/relay',
    storage,
    WebSocketConstructor: FakeWs,
    pingIntervalMs: 0,
    onWelcome: (w) => events.push(`welcome:${w.seat}:${w.locked}`),
    onRefused: (r) => events.push(`refused:${r}`),
  });

  assert.equal(client.connect(), true);
  for (let i = 0; i < 10 && FakeWs.instances.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  const ws1 = FakeWs.instances[0]!;
  assert.ok(!ws1.url.includes('token='), 'initial join has no token');
  assert.ok(ws1.url.includes('cid='), 'includes ephemeral per-tab cid');

  ws1.serverOpen();
  ws1.serverSendJson({
    type: 'welcome',
    protocol: 1,
    code: '2YCD44',
    formattedCode: '2YC-D44',
    role: 'guest',
    seat: 1,
    token: 'seat1-secret-token',
    tvMode: false,
    locked: false,
    seats: [{ seat: 1, callsign: 'NOVA-7', ready: false, isHost: false, connected: true }],
  });

  assert.equal(getStoredCoopToken('2YCD44', storage), 'seat1-secret-token');
  assert.deepEqual(events, ['welcome:1:false']);

  // Simulate Wi-Fi drop -> `partysocket` reconnects automatically with `token=seat1-secret-token`!
  ws1.serverDrop(1006, 'Wi-Fi drop');
  for (let i = 0; i < 25 && FakeWs.instances.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(FakeWs.instances.length, 2, 'reconnected after Wi-Fi drop');
  const ws2 = FakeWs.instances[1]!;
  assert.ok(ws2.url.includes('token=seat1-secret-token'), 'reconnect URL carries stored seat token');
  ws2.serverOpen();

  // `dispose()` preserves the stored token (for page refresh), whereas `refused` clears it immediately
  // WITHOUT waiting for the server's close frame!
  ws2.serverSendJson({ type: 'refused', reason: 'kicked' });
  assert.deepEqual(events, ['welcome:1:false', 'refused:kicked']);
  assert.equal(getStoredCoopToken('2YCD44', storage), '', 'kicked clears stored token immediately');
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(FakeWs.instances.length, 2, 'never retries after refused');

  // Deliberate `leave()` sends `{ type: 'leave' }` and clears token
  FakeWs.reset();
  const leaveClient = new CoopClient({
    code: 'K7M4P9',
    role: 'guest',
    wsBase: 'ws://localhost:84/relay',
    storage,
    WebSocketConstructor: FakeWs,
    pingIntervalMs: 0,
  });
  leaveClient.connect();
  const openedCount = () => FakeWs.instances.length;
  for (let i = 0; i < 10 && openedCount() === 0; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  const wsLeave = FakeWs.instances[0]!;
  wsLeave.serverOpen();
  wsLeave.serverSendJson({
    type: 'welcome',
    protocol: 1,
    code: 'K7M4P9',
    formattedCode: 'K7M-4P9',
    role: 'guest',
    seat: 2,
    token: 'tok-leave',
    tvMode: false,
    locked: false,
    seats: [],
  });
  assert.equal(getStoredCoopToken('K7M4P9', storage), 'tok-leave');
  leaveClient.leave();
  assert.ok(wsLeave.sent.includes(JSON.stringify({ type: 'leave' })), 'leave() sends { type: "leave" }');
  assert.equal(getStoredCoopToken('K7M4P9', storage), '', 'leave() clears room token');
});

test('Invite URL helpers strip ?j= from location, detect relay endpoints, and suppress solo wingmen in Co-op', async () => {
  let replacedUrl = '';
  const code = consumeInviteCodeFromLocation(
    {
      origin: 'https://geurtsgaming.com',
      pathname: '/',
      search: '?j=2yc-d44&keep=1',
      hash: '#top',
    } as Location,
    {
      replaceState: (_data, _unused, url) => {
        replacedUrl = String(url);
      },
    },
  );
  assert.equal(code, '2YCD44');
  assert.equal(replacedUrl, '/?keep=1#top');

  assert.equal(
    buildCoopInviteUrl('2yc-d44', { origin: 'http://localhost:84', pathname: '/' } as Location),
    'http://localhost:84/?j=2YCD44',
  );
  assert.deepEqual(
    detectRelayEndpoints({
      protocol: 'http:',
      hostname: 'localhost',
      port: '84',
      host: 'localhost:84',
      origin: 'http://localhost:84',
    } as Location),
    { httpBase: 'http://localhost:84/relay', wsBase: 'ws://localhost:84/relay' },
  );
  assert.deepEqual(
    detectRelayEndpoints({
      protocol: 'https:',
      hostname: 'geurtsgaming.com',
      port: '',
      host: 'geurtsgaming.com',
      origin: 'https://geurtsgaming.com',
    } as Location),
    { httpBase: 'https://relay.geurtsgaming.com', wsBase: 'wss://relay.geurtsgaming.com' },
  );

  const created = await createCoopRoom({
    httpBase: 'http://localhost:84/relay',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ ok: true, protocol: 1, code: 'K7M4P9', formattedCode: 'K7M-4P9' }), {
        status: 200,
      })) as unknown as typeof fetch,
  });
  assert.deepEqual(created, { code: 'K7M4P9', formattedCode: 'K7M-4P9' });

  const cycled = nextAvailableCallsign('NOVA-1', ['NOVA-1', 'FALCON-1']);
  assert.notEqual(cycled, 'NOVA-1');
  assert.notEqual(cycled, 'FALCON-1');

  // MultiplayerClient.setCoopActive(true) suppresses solo ghost wingmen & solo Top 10 score writes
  const mp = new MultiplayerClient('');
  mp.updateFlight(0.05, {
    active: true,
    w: 800,
    h: 600,
    scale: 1,
    pace: 1,
    shipX: 400,
    shipY: 480,
    wave: 1,
    score: 500,
    freed: 3,
    hull: 3,
    firing: true,
    enemies: [],
  });
  assert.ok(mp.wingmen.length >= 1, 'solo flight spawns computer wingman');

  mp.setCoopActive(true);
  assert.equal(mp.wingmen.length, 0, 'enabling Co-op clears solo wingmen immediately');
  mp.updateFlight(0.05, {
    active: true,
    w: 800,
    h: 600,
    scale: 1,
    pace: 1,
    shipX: 400,
    shipY: 480,
    wave: 2,
    score: 2500,
    freed: 10,
    hull: 3,
    firing: true,
    enemies: [],
  });
  assert.equal(mp.wingmen.length, 0, 'solo wingmen stay suppressed while Co-op is active');
  assert.equal(mp.recordScore(9999, 4, 20), null, 'Co-op runs never write to solo Top 10 leaderboard');
});
