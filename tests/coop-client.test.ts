import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { CoopRoom } from '../relay/room.mjs';
import {
  CoopClient,
  INVITE_STORAGE_KEY,
  buildCoopInviteUrl,
  consumeInviteCodeFromLocation,
  consumePendingInviteCode,
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

test('Two CoopClients sharing one seat token settle immediately without a reconnect loop, and bare 4001 is final', async () => {
  const room = new CoopRoom('2YCD44');
  let openedSockets = 0;

  class RoomBridgeWs extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readonly url: string;
    readyState = RoomBridgeWs.CONNECTING;
    binaryType = 'arraybuffer';
    private peerConn: {
      sendText: (s: string) => void;
      sendBinary: (u8: Uint8Array) => void;
      close: (code: number, reason: string) => void;
      setAttachment: () => void;
    };

    constructor(url: string) {
      super();
      this.url = url;
      openedSockets += 1;
      this.peerConn = {
        sendText: (str: string) => {
          queueMicrotask(() => {
            if (this.readyState === RoomBridgeWs.CLOSED) return;
            this.dispatchEvent(new MessageEvent('message', { data: str }));
          });
        },
        sendBinary: (u8: Uint8Array) => {
          queueMicrotask(() => {
            if (this.readyState === RoomBridgeWs.CLOSED) return;
            const copy = new Uint8Array(u8);
            this.dispatchEvent(new MessageEvent('message', { data: copy.buffer }));
          });
        },
        close: (code: number, reason: string) => {
          queueMicrotask(() => {
            if (this.readyState === RoomBridgeWs.CLOSED) return;
            this.readyState = RoomBridgeWs.CLOSED;
            this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
          });
        },
        setAttachment: () => {},
      };

      queueMicrotask(() => {
        if (this.readyState === RoomBridgeWs.CLOSED) return;
        this.readyState = RoomBridgeWs.OPEN;
        this.dispatchEvent(new Event('open'));
        const parsed = new URL(this.url);
        room.connect(this.peerConn, {
          role: parsed.searchParams.get('role') === 'host' ? 'host' : 'guest',
          callsign: parsed.searchParams.get('callsign') || '',
          token: parsed.searchParams.get('token') || '',
          tvMode: parsed.searchParams.get('tv') === '1',
          clientId: parsed.searchParams.get('cid') || '',
        });
      });
    }

    send(data: string | Uint8Array): void {
      if (this.readyState !== RoomBridgeWs.OPEN) return;
      if (typeof data === 'string') room.handleText(this.peerConn, data);
      else room.handleBinary(this.peerConn, new Uint8Array(data));
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState === RoomBridgeWs.CLOSED) return;
      this.readyState = RoomBridgeWs.CLOSED;
      room.disconnect(this.peerConn);
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
    }
  }

  // Host opens the room first
  const hostClient = new CoopClient({
    code: '2YCD44',
    role: 'host',
    wsBase: 'ws://localhost:84/relay',
    storage: new MemoryStorage(),
    WebSocketConstructor: RoomBridgeWs,
    pingIntervalMs: 0,
  });
  hostClient.connect();
  await new Promise((r) => setTimeout(r, 30));

  // Tab 1 joins as Guest in Seat 1
  const tab1Storage = new MemoryStorage();
  const tab1Refusals: string[] = [];
  const tab1 = new CoopClient({
    code: '2YCD44',
    role: 'guest',
    wsBase: 'ws://localhost:84/relay',
    storage: tab1Storage,
    WebSocketConstructor: RoomBridgeWs,
    pingIntervalMs: 0,
    onRefused: (r) => tab1Refusals.push(r),
  });
  tab1.connect();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tab1.isConnected, true);
  assert.equal(tab1.seat, 1);

  // Simulate browser "Duplicate Tab" copying `sessionStorage` (including seat token) into Tab 2
  const tab2Storage = new MemoryStorage();
  for (const [k, v] of tab1Storage.map.entries()) tab2Storage.setItem(k, v);
  const tab2Refusals: string[] = [];
  const tab2 = new CoopClient({
    code: '2YCD44',
    role: 'guest',
    wsBase: 'ws://localhost:84/relay',
    storage: tab2Storage,
    WebSocketConstructor: RoomBridgeWs,
    pingIntervalMs: 0,
    onRefused: (r) => tab2Refusals.push(r),
  });
  tab2.connect();

  // Wait past two full `minReconnectionDelay` (250ms) cycles to prove there is zero reconnect tug-of-war!
  await new Promise((r) => setTimeout(r, 650));

  assert.equal(openedSockets, 3, 'only host + tab1 + tab2 ever connected (zero reconnect loop)');
  assert.equal(tab1.isConnected, false, 'replaced tab1 stopped permanently');
  assert.equal(tab2.isConnected, true, 'tab2 cleanly holds the seat');
  assert.deepEqual(tab1Refusals, ['replaced']);
  assert.deepEqual(tab2Refusals, []);
  assert.equal(getStoredCoopToken('2YCD44', tab1Storage), '', 'replaced tab clears its copied token');
  assert.notEqual(getStoredCoopToken('2YCD44', tab2Storage), '', 'active tab keeps its token');

  tab2.dispose();
  hostClient.dispose();

  // Also verify bare close code 4001 (from an older relay sending no `refused` JSON frame) is final!
  FakeWs.reset();
  const legacyStorage = new MemoryStorage();
  const legacyRefusals: string[] = [];
  const legacyClient = new CoopClient({
    code: 'K7M4P9',
    role: 'guest',
    wsBase: 'ws://localhost:84/relay',
    storage: legacyStorage,
    WebSocketConstructor: FakeWs,
    pingIntervalMs: 0,
    onRefused: (r) => legacyRefusals.push(r),
  });
  legacyClient.connect();
  for (let i = 0; i < 10 && FakeWs.instances.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  const wsLegacy = FakeWs.instances[0]!;
  wsLegacy.serverOpen();
  wsLegacy.serverSendJson({
    type: 'welcome',
    protocol: 1,
    code: 'K7M4P9',
    formattedCode: 'K7M-4P9',
    role: 'guest',
    seat: 1,
    token: 'tok-legacy',
    tvMode: false,
    locked: false,
    seats: [],
  });
  wsLegacy.serverDrop(4001, 'Replaced by reconnect');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(legacyRefusals, ['replaced'], 'bare 4001 close triggers onRefused("replaced")');
  assert.equal(FakeWs.instances.length, 1, 'bare 4001 never reconnects');
  assert.equal(getStoredCoopToken('K7M4P9', legacyStorage), '');
});

test('Base.astro strips ?j= in its first <head> script before Google Analytics and stashes invite for HeroGame', async () => {
  const baseSource = await readFile(new URL('../src/layouts/Base.astro', import.meta.url), 'utf8');

  const earlyStripIdx = baseSource.indexOf("sessionStorage.setItem('gg_coop_invite'");
  const gtagScriptIdx = baseSource.indexOf('googletagmanager.com/gtag/js');
  const gtagSetIdx = baseSource.indexOf("gtag('set'");
  const gtagConfigIdx = baseSource.indexOf("gtag('config'");

  assert.ok(earlyStripIdx > 0, 'Base.astro contains early gg_coop_invite strip script');
  assert.ok(earlyStripIdx < gtagScriptIdx, 'early ?j= strip runs strictly BEFORE gtag.js script tag');
  assert.ok(gtagSetIdx > 0 && gtagSetIdx < gtagConfigIdx, 'gtag("set") stays strictly BEFORE gtag("config")');
  assert.equal(baseSource.includes('page_location'), false, 'unused page_location override removed');

  // Extract the exact inline early-strip script from Base.astro and run it against simulated URLs!
  const match = baseSource.match(/<script is:inline>\s*(\(\(\)\s*=>\s*\{[\s\S]*?\}\)\(\);)\s*<\/script>/);
  assert.ok(match?.[1], 'extracted inline early-strip IIFE from Base.astro');
  const earlyScript = match[1];

  // 1. Standard browser with working sessionStorage
  const store = new MemoryStorage();
  let replacedPath = '';
  const win1: { __ggInvite?: unknown } = {};
  vm.runInNewContext(earlyScript, {
    URL,
    location: { href: 'https://geurtsgaming.com/?j=prn-s6n&src=qr#hangar' },
    sessionStorage: store,
    window: win1,
    history: {
      state: { ok: 1 },
      replaceState: (_state: unknown, _unused: string, url: string) => {
        replacedPath = url;
      },
    },
  });
  assert.equal(replacedPath, '/?src=qr#hangar', 'strips j from URL before GA while keeping other params & hash');
  assert.equal(store.getItem(INVITE_STORAGE_KEY), 'prn-s6n');

  const consumed1 = consumePendingInviteCode({
    storage: store,
    win: win1,
    loc: { origin: 'https://geurtsgaming.com', pathname: '/', search: '?src=qr', hash: '#hangar' } as Location,
  });
  assert.equal(consumed1, 'PRNS6N');
  assert.equal(store.getItem(INVITE_STORAGE_KEY), null, 'consumePendingInviteCode clears gg_coop_invite');

  // 2. Locked-down browser where sessionStorage throws -> falls back to window.__ggInvite
  let replacedPath2 = '';
  const win2: { __ggInvite?: unknown } = {};
  vm.runInNewContext(earlyScript, {
    URL,
    location: { href: 'https://geurtsgaming.com/?j=2yc-d44' },
    sessionStorage: {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    },
    window: win2,
    history: {
      state: null,
      replaceState: (_state: unknown, _unused: string, url: string) => {
        replacedPath2 = url;
      },
    },
  });
  assert.equal(replacedPath2, '/', 'cleanly strips single ?j= param down to /');
  assert.equal(win2.__ggInvite, '2yc-d44');

  const consumed2 = consumePendingInviteCode({
    storage: null,
    win: win2,
    loc: { origin: 'https://geurtsgaming.com', pathname: '/', search: '', hash: '' } as Location,
  });
  assert.equal(consumed2, '2YCD44');
  assert.equal('__ggInvite' in win2, false, 'cleans up window.__ggInvite after reading');
});

test('CoopClient re-acquires screen wake lock when page returns from hidden after browser release', async (t) => {
  FakeWs.reset();
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const origDocDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');

  let wakeRequests = 0;
  let latestSentinel: (EventTarget & { released: boolean; release: () => Promise<void> }) | null = null;
  const fakeDoc = Object.assign(new EventTarget(), { hidden: false });

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      wakeLock: {
        request: async () => {
          wakeRequests += 1;
          const sentinel = Object.assign(new EventTarget(), {
            released: false,
            async release() {
              sentinel.released = true;
              sentinel.dispatchEvent(new Event('release'));
            },
          });
          latestSentinel = sentinel;
          return sentinel;
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: fakeDoc,
  });

  t.after(() => {
    if (origNavDesc) Object.defineProperty(globalThis, 'navigator', origNavDesc);
    if (origDocDesc) Object.defineProperty(globalThis, 'document', origDocDesc);
    else delete (globalThis as { document?: unknown }).document;
  });

  const client = new CoopClient({
    code: '2YCD44',
    role: 'host',
    wsBase: 'ws://localhost:84/relay',
    storage: new MemoryStorage(),
    WebSocketConstructor: FakeWs,
    pingIntervalMs: 0,
  });
  client.connect();
  for (let i = 0; i < 10 && FakeWs.instances.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  FakeWs.instances[0]!.serverOpen();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(wakeRequests, 1, 'acquires initial wake lock on open');

  // Simulate browser auto-releasing the wake lock when the tab is hidden
  fakeDoc.hidden = true;
  await latestSentinel!.release();
  assert.equal(latestSentinel!.released, true);

  // Tab becomes visible again -> CoopClient re-acquires a fresh wake lock!
  fakeDoc.hidden = false;
  fakeDoc.dispatchEvent(new Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(wakeRequests, 2, 're-acquires wake lock after page returns to foreground');

  client.dispose();
});
