import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoopRoom } from '../relay/room.mjs';
import { CoopClient, type CoopConnectOptions, type StorageLike } from '../src/game/coop-client';
import {
  CoopLobbyController,
  describeRefusalReason,
  loadActiveCoopSession,
} from '../src/game/coop-lobby';

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

/** In-memory WebSocket bridge connecting `CoopClient` (`partysocket`) directly to `relay/room.mjs` `CoopRoom`. */
function createRoomWsConstructor(room: InstanceType<typeof CoopRoom>) {
  return class RoomBridgeWs extends EventTarget {
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
      if (typeof data === 'string') {
        room.handleText(this.peerConn, data);
      } else {
        room.handleBinary(this.peerConn, new Uint8Array(data));
      }
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState === RoomBridgeWs.CLOSED) return;
      this.readyState = RoomBridgeWs.CLOSED;
      room.disconnect(this.peerConn);
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
    }
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test('4-seat CoopLobbyController drives host creation, chimes, callsign, ready, kick ("removed"), refresh, and launch lock', async () => {
  const room = new CoopRoom('2YCD44');
  const WsBridge = createRoomWsConstructor(room);

  const makeClient = (opts: CoopConnectOptions) =>
    new CoopClient({
      ...opts,
      wsBase: 'ws://localhost:84/relay',
      WebSocketConstructor: WsBridge,
      pingIntervalMs: 0,
    });

  const hostStore = new MemoryStorage();
  let hostJoinChimes = 0;
  let hostLaunchedCount = 0;
  let hostCoopActive = false;

  const hostLobby = new CoopLobbyController({
    initialCallsign: 'NOVA-7',
    storage: hostStore,
    createRoomFn: async () => ({ code: '2YCD44', formattedCode: '2YC-D44' }),
    clientFactory: makeClient,
    inviteLocation: { origin: 'https://geurtsgaming.com', pathname: '/' } as Location,
    onJoinChime: () => {
      hostJoinChimes += 1;
    },
    onCoopActiveChange: (active) => {
      hostCoopActive = active;
    },
    onSquadLaunched: () => {
      hostLaunchedCount += 1;
    },
  });

  await hostLobby.hostNewRoom();
  await flush();

  assert.equal(hostCoopActive, true);
  assert.equal(hostLobby.snapshot().screen, 'lobby');
  assert.equal(hostLobby.snapshot().formattedCode, '2YC-D44');
  assert.equal(hostLobby.snapshot().inviteUrl, 'https://geurtsgaming.com/?j=2YCD44');
  assert.equal(hostLobby.snapshot().canStart, false, 'cannot launch with only 1 pilot');

  // Join 3 guests (filling all 4 seats)
  const g1Store = new MemoryStorage();
  const g2Store = new MemoryStorage();
  const g3Store = new MemoryStorage();
  const g1 = new CoopLobbyController({ initialCallsign: 'FALCON-2', storage: g1Store, clientFactory: makeClient });
  const g2 = new CoopLobbyController({ initialCallsign: 'VIPER-3', storage: g2Store, clientFactory: makeClient });
  const g3 = new CoopLobbyController({ initialCallsign: 'STAR-4', storage: g3Store, clientFactory: makeClient });

  assert.equal(g1.joinRoomByCode('2yc-d44'), true);
  await flush();
  assert.equal(g2.joinRoomByCode('2YCD44'), true);
  await flush();
  assert.equal(g3.joinRoomByCode('2YCD44'), true);
  await flush();

  assert.equal(hostJoinChimes, 3, 'host hears join chime for each of the 3 wingmen');
  assert.equal(hostLobby.snapshot().seats.length, 4);
  assert.equal(hostLobby.snapshot().canStart, true, 'host can launch once >= 2 pilots are connected');

  // 5th player is told the squad is full
  const g5 = new CoopLobbyController({ storage: new MemoryStorage(), clientFactory: makeClient });
  g5.joinRoomByCode('2YCD44');
  await flush();
  assert.equal(g5.snapshot().screen, 'choose');
  assert.match(g5.snapshot().error, /already full/i);

  // Guest 1 marks Ready & cycles callsign
  g1.toggleReady();
  g1.cycleMyCallsign();
  await flush();
  const seat1 = hostLobby.snapshot().seats.find((s) => s.seat === 1)!;
  assert.equal(seat1.ready, true);
  assert.notEqual(seat1.callsign, 'FALCON-2');

  // Host removes Seat 2 -> wording says "removed", never "blocked", and clears Guest 2's active session
  assert.ok(describeRefusalReason('kicked').includes('removed'));
  assert.equal(describeRefusalReason('kicked').toLowerCase().includes('blocked'), false);
  hostLobby.kickSeat(2);
  await flush();
  assert.equal(g2.snapshot().screen, 'choose');
  assert.match(g2.snapshot().error, /removed/i);
  assert.equal(loadActiveCoopSession(g2Store), null);
  assert.equal(hostLobby.snapshot().seats.length, 3);

  // Simulate Guest 1 refreshing the browser mid-lobby (`dispose` keeps sessionStorage token + active room!)
  g1.dispose();
  await flush();
  const savedSession = loadActiveCoopSession(g1Store);
  assert.ok(savedSession, 'active lobby session survives tab refresh in sessionStorage');
  assert.equal(savedSession.code, '2YCD44');
  assert.equal(savedSession.role, 'guest');

  const g1Reloaded = new CoopLobbyController({ storage: g1Store, clientFactory: makeClient });
  g1Reloaded.joinRoomByCode(savedSession.code, savedSession.role);
  await flush();
  assert.equal(g1Reloaded.snapshot().screen, 'lobby');
  assert.equal(g1Reloaded.snapshot().mySeat, 1, 'reloaded guest reclaims Seat 1');
  assert.equal(
    g1Reloaded.snapshot().seats.find((s) => s.seat === 1)?.ready,
    true,
    'reloaded guest preserves Ready state',
  );

  // Explicit Leave on Guest 3 frees Seat 3 immediately & clears sessionStorage
  g3.leaveRoom();
  await flush();
  assert.equal(loadActiveCoopSession(g3Store), null);
  assert.equal(hostLobby.snapshot().seats.length, 2);

  // Host clicks Launch Squad -> locks room & transitions both Host and Guest 1 to `'launched'`
  let g1Launched = 0;
  const g1Sub = g1Reloaded.subscribe((s) => {
    if (s.screen === 'launched') g1Launched += 1;
  });
  hostLobby.launchSquad();
  await flush();
  g1Sub();

  assert.equal(hostLobby.snapshot().screen, 'launched');
  assert.equal(hostLaunchedCount, 1);
  assert.equal(g1Reloaded.snapshot().screen, 'launched');
  assert.ok(g1Launched >= 1);

  // Late joiner after Launch gets `'started'`, while Guest 1 refreshing mid-game lands directly in `'launched'` (`welcome.locked === true`)!
  const lateGuest = new CoopLobbyController({ storage: new MemoryStorage(), clientFactory: makeClient });
  lateGuest.joinRoomByCode('2YCD44');
  await flush();
  assert.equal(lateGuest.snapshot().screen, 'choose');
  assert.match(lateGuest.snapshot().error, /already launched/i);

  g1Reloaded.dispose();
  await flush();
  const g1MidGameReload = new CoopLobbyController({ storage: g1Store, clientFactory: makeClient });
  g1MidGameReload.joinRoomByCode('2YCD44', 'guest');
  await flush();
  assert.equal(g1MidGameReload.snapshot().screen, 'launched', 'returning guest learns game started via welcome.locked');
  assert.equal(g1MidGameReload.snapshot().mySeat, 1);

  g1MidGameReload.dispose();
  hostLobby.dispose();
});
