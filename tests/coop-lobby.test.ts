import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CoopRoom } from '../relay/room.mjs';
import { CoopClient, clearStoredCoopToken, type CoopConnectOptions, type StorageLike } from '../src/game/coop-client';
import {
  CoopLobbyController,
  CoopLobbyModal,
  describeRefusalReason,
  loadActiveCoopSession,
  resolveLobbyFocusTarget,
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

test('Duplicated lobby tab shows friendly "another tab" message and stops, and copy says 6-character', async () => {
  assert.equal(
    describeRefusalReason('replaced'),
    'This squad is open in another tab or on another device.',
  );

  const lobbySrc = await readFile(new URL('../src/game/coop-lobby.ts', import.meta.url), 'utf8');
  assert.ok(lobbySrc.includes('6-character room code'), 'uses accurate 6-character room code wording');
  assert.equal(lobbySrc.includes('6-letter'), false, 'no stale 6-letter wording');

  const room = new CoopRoom('PRNS6N');
  const WsBridge = createRoomWsConstructor(room);
  const makeClient = (opts: CoopConnectOptions) =>
    new CoopClient({
      ...opts,
      wsBase: 'ws://localhost:84/relay',
      WebSocketConstructor: WsBridge,
      pingIntervalMs: 0,
    });

  const host = new CoopLobbyController({
    storage: new MemoryStorage(),
    createRoomFn: async () => ({ code: 'PRNS6N', formattedCode: 'PRN-S6N' }),
    clientFactory: makeClient,
  });
  await host.hostNewRoom();
  await flush();

  const tab1Store = new MemoryStorage();
  const tab1 = new CoopLobbyController({ storage: tab1Store, clientFactory: makeClient });
  tab1.joinRoomByCode('PRNS6N');
  await flush();
  assert.equal(tab1.snapshot().screen, 'lobby');

  // Duplicate tab copies sessionStorage (`gg_coop_active` + seat token)
  const tab2Store = new MemoryStorage();
  for (const [k, v] of tab1Store.map.entries()) tab2Store.setItem(k, v);
  const resumed = loadActiveCoopSession(tab2Store)!;
  const tab2 = new CoopLobbyController({ storage: tab2Store, clientFactory: makeClient });
  tab2.joinRoomByCode(resumed.code, resumed.role);

  await new Promise((r) => setTimeout(r, 500));

  assert.equal(tab1.snapshot().screen, 'choose', 'first tab exits cleanly to choose screen');
  assert.equal(
    tab1.snapshot().error,
    'This squad is open in another tab or on another device.',
  );
  assert.equal(loadActiveCoopSession(tab1Store), null, 'first tab clears gg_coop_active');
  assert.equal(tab2.snapshot().screen, 'lobby', 'second tab remains connected in seat 1');
  assert.equal(tab2.snapshot().mySeat, 1);

  tab2.dispose();
  host.dispose();
});

test('Removing a guest via keyboard never moves focus onto another Remove button or onto Leave', async () => {
  // Minimal DOM tree whose `querySelector` walks in strict W3C pre-order document order
  // (where `Leave` in `headSlot` comes BEFORE `bodySlot` controls, and comma-separated selectors
  // match whichever node appears earliest in document order).
  let currentActive: MiniEl | null = null;
  const getActive = (): MiniEl | null => currentActive;

  class MiniEl {
    tagName: string;
    attrs = new Map<string, string>();
    dataset: Record<string, string> = {};
    parent: MiniEl | null = null;
    children: MiniEl[] = [];
    private listeners = new Map<string, Array<(ev: unknown) => void>>();
    private rawHtml = '';

    constructor(tagName: string) {
      this.tagName = tagName.toLowerCase();
    }

    setAttribute(name: string, value: string): void {
      const k = name.toLowerCase();
      this.attrs.set(k, value);
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
        this.dataset[camel] = value;
      }
    }

    getAttribute(name: string): string | null {
      return this.attrs.get(name.toLowerCase()) ?? null;
    }

    hasAttribute(name: string): boolean {
      return this.attrs.has(name.toLowerCase());
    }

    get innerHTML(): string {
      return this.rawHtml;
    }

    set innerHTML(html: string) {
      this.rawHtml = html;
      this.children = parseMiniHtml(html, this);
    }

    contains(node: unknown): boolean {
      let cur = node instanceof MiniEl ? (node as MiniEl | null) : null;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parent;
      }
      return false;
    }

    focus(): void {
      currentActive = this;
    }

    matches(selectorList: string): boolean {
      return selectorList
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .some((sel) => matchesSingleSelector(this, sel));
    }

    closest(selectorList: string): MiniEl | null {
      let cur: MiniEl | null = this;
      while (cur) {
        if (cur.matches(selectorList)) return cur;
        cur = cur.parent;
      }
      return null;
    }

    querySelector(selectorList: string): MiniEl | null {
      for (const child of this.children) {
        if (child.matches(selectorList)) return child;
        const hit = child.querySelector(selectorList);
        if (hit) return hit;
      }
      return null;
    }

    addEventListener(type: string, fn: (ev: unknown) => void): void {
      const arr = this.listeners.get(type) ?? [];
      arr.push(fn);
      this.listeners.set(type, arr);
    }

    click(): void {
      let cur: MiniEl | null = this;
      const ev = { target: this, preventDefault() {} };
      while (cur) {
        for (const fn of cur.listeners.get('click') ?? []) fn(ev);
        cur = cur.parent;
      }
    }
  }

  function matchesSingleSelector(el: MiniEl, sel: string): boolean {
    let rest = sel.trim();
    if (/^[a-z0-9-]+/i.test(rest)) {
      const m = rest.match(/^[a-z0-9-]+/i)!;
      if (el.tagName !== m[0].toLowerCase()) return false;
      rest = rest.slice(m[0].length);
    }
    while (rest.length > 0) {
      if (rest.startsWith(':not([disabled])')) {
        if (el.hasAttribute('disabled')) return false;
        rest = rest.slice(':not([disabled])'.length);
        continue;
      }
      const attrMatch = rest.match(/^\[([a-z0-9-]+)(?:="([^"]*)")?\]/i);
      if (attrMatch) {
        const [, attrName, attrVal] = attrMatch;
        if (!el.hasAttribute(attrName!)) return false;
        if (attrVal !== undefined && el.getAttribute(attrName!) !== attrVal) return false;
        rest = rest.slice(attrMatch[0].length);
        continue;
      }
      return false;
    }
    return true;
  }

  function parseMiniHtml(html: string, parent: MiniEl): MiniEl[] {
    const roots: MiniEl[] = [];
    const stack: MiniEl[] = [parent];
    const voidTags = new Set(['input', 'img', 'br', 'hr', 'path', 'circle', 'rect', 'line']);
    const tagRe = /<\/?([a-zA-Z0-9-]+)([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html)) !== null) {
      const full = m[0];
      const tag = m[1]!.toLowerCase();
      const attrPart = m[2] ?? '';
      if (full.startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const el = new MiniEl(tag);
      const attrRe = /([a-zA-Z0-9:-]+)(?:="([^"]*)")?/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(attrPart)) !== null) {
        if (am[1] === '/') continue;
        el.setAttribute(am[1]!, am[2] ?? '');
      }
      const top = stack[stack.length - 1]!;
      el.parent = top;
      if (top === parent) roots.push(el);
      else top.children.push(el);
      const selfClosing = full.endsWith('/>') || voidTags.has(tag);
      if (!selfClosing) stack.push(el);
    }
    return roots;
  }

  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevEl = g.HTMLElement;
  const prevInput = g.HTMLInputElement;
  class FakeInputEl extends MiniEl {}
  g.HTMLElement = MiniEl;
  g.HTMLInputElement = FakeInputEl;
  g.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    get activeElement() {
      return currentActive;
    },
  };

  try {
    const room = new CoopRoom('PRN689');
    const WsBridge = createRoomWsConstructor(room);
    const makeClient = (opts: CoopConnectOptions) =>
      new CoopClient({
        ...opts,
        wsBase: 'ws://localhost:84/relay',
        WebSocketConstructor: WsBridge,
        pingIntervalMs: 0,
      });

    const hostCtrl = new CoopLobbyController({
      storage: new MemoryStorage(),
      createRoomFn: async () => ({ code: 'PRN689', formattedCode: 'PRN-689' }),
      clientFactory: makeClient,
    });
    const guest1 = new CoopLobbyController({ storage: new MemoryStorage(), clientFactory: makeClient });
    const guest2 = new CoopLobbyController({ storage: new MemoryStorage(), clientFactory: makeClient });

    const root = new MiniEl('div');
    const panel = new MiniEl('div');
    panel.setAttribute('data-coop-panel', '');
    panel.parent = root;
    root.children.push(panel);

    const modal = new CoopLobbyModal({
      root: root as unknown as HTMLElement,
      controller: hostCtrl,
      onCloseModal: () => {},
    });

    await hostCtrl.hostNewRoom();
    await flush();
    guest1.joinRoomByCode('PRN689');
    guest2.joinRoomByCode('PRN689');
    await flush();

    assert.equal(hostCtrl.snapshot().seats.length, 3, 'host + 2 guests in hangar');
    assert.equal(panel.getAttribute('tabindex'), '-1', 'dialog panel gets tabindex="-1"');

    // Focus "Remove seat 1" and trigger kick (while Leave is earlier in DOM order and seat 2 Remove is next)
    const kickSeat1 = panel.querySelector('[data-coop-action="kick"][data-seat="1"]');
    assert.ok(kickSeat1, 'Remove seat 1 button exists');
    kickSeat1.focus();
    kickSeat1.click();
    await flush();

    assert.equal(hostCtrl.snapshot().seats.some((s) => s.seat === 1), false, 'seat 1 was removed');
    assert.equal(hostCtrl.snapshot().seats.some((s) => s.seat === 2), true, 'seat 2 is still connected');
    const afterKick1 = getActive();
    assert.ok(afterKick1, 'focus stayed inside the dialog');
    assert.notEqual(afterKick1.dataset.coopAction, 'kick', 'focus must NOT jump to another guest Remove button');
    assert.notEqual(afterKick1.dataset.coopAction, 'leave', 'focus must NOT jump to Leave');
    assert.equal(afterKick1.hasAttribute('data-coop-leave'), false);
    assert.equal(afterKick1.getAttribute('data-coop-seat'), '1', 'focus lands on now-empty seat 1 card');
    assert.equal(afterKick1.getAttribute('tabindex'), '-1');

    // Now focus "Remove seat 2" and trigger kick (removing the last guest)
    const kickSeat2 = panel.querySelector('[data-coop-action="kick"][data-seat="2"]');
    assert.ok(kickSeat2, 'Remove seat 2 button exists');
    kickSeat2.focus();
    kickSeat2.click();
    await flush();

    const afterKick2 = getActive();
    assert.ok(afterKick2, 'focus still inside dialog after removing last guest');
    assert.notEqual(afterKick2.dataset.coopAction, 'kick');
    assert.notEqual(afterKick2.dataset.coopAction, 'leave');
    assert.equal(afterKick2.hasAttribute('data-coop-leave'), false);

    // Also verify disappearing action (e.g. Launch Squad -> locked hangar where ONLY Leave remains as a button)
    // Re-add a guest so host can launch, focus Launch Squad, and click it
    const guest3 = new CoopLobbyController({ storage: new MemoryStorage(), clientFactory: makeClient });
    guest3.joinRoomByCode('PRN689');
    await flush();
    const activeStartBtn = panel.querySelector('[data-coop-action="start"]');
    assert.ok(activeStartBtn && !activeStartBtn.hasAttribute('disabled'));
    activeStartBtn.focus();
    activeStartBtn.click();
    await flush();

    assert.equal(hostCtrl.snapshot().locked, true);
    assert.equal(
      getActive(),
      panel,
      'when all safe controls vanish on launch and only Leave remains, focus falls back to the dialog panel (not Leave)',
    );
    assert.notEqual(
      resolveLobbyFocusTarget(panel as unknown as HTMLElement, {
        wasJoinBtn: false,
        focusedAction: 'start',
        focusedSeat: null,
      }),
      panel.querySelector('[data-coop-leave]') as unknown as HTMLElement,
    );

    guest3.dispose();
    guest2.dispose();
    guest1.dispose();
    modal.destroy();
  } finally {
    g.document = prevDoc;
    g.HTMLElement = prevEl;
    g.HTMLInputElement = prevInput;
  }
});

test('HeroGame hides [hidden] arcade buttons, confirms before leaving Co-op flight, lazy-loads coop-flight, and clears saved host progress on Leave', async () => {
  // 1. `clearStoredCoopToken` removes both `gg_coop_token_<CODE>` and `gg_coop_host_state_<CODE>`
  const store = new MemoryStorage();
  store.setItem('gg_coop_token_XKCD42', 'tok-123');
  store.setItem('gg_coop_host_state_XKCD42', JSON.stringify({ wave: 4, score: 1800, freed: 12 }));
  clearStoredCoopToken('XKCD42', store);
  assert.equal(store.getItem('gg_coop_token_XKCD42'), null);
  assert.equal(store.getItem('gg_coop_host_state_XKCD42'), null);

  // 2. Verify HeroGame.astro markup, CSS, Co-op leave confirmation, and lazy `coop-flight` import
  const heroSrc = await readFile(new URL('../src/components/HeroGame.astro', import.meta.url), 'utf8');
  assert.match(heroSrc, /\.arcade-btn\[hidden\]\s*\{\s*display:\s*none;\s*\}/, '.arcade-btn[hidden] overrides display: grid');
  assert.ok(heroSrc.includes('data-coop-leave-confirm'), 'renders Co-op leave confirmation dialog');
  assert.ok(heroSrc.includes('role="alertdialog"'), 'Co-op leave confirmation uses accessible alertdialog role');
  assert.ok(heroSrc.includes('data-coop-stay') && heroSrc.includes('data-coop-confirm-leave'));
  assert.ok(
    heroSrc.includes("coopSession ? import('../game/coop-flight') : Promise.resolve(null)"),
    'HeroGame only imports coop-flight when launching a Co-op squad',
  );

  // 3. Verify `src/game/game.ts` has zero runtime imports from `coop-*` so Solo pays 0 KB Co-op overhead
  const gameSrc = await readFile(new URL('../src/game/game.ts', import.meta.url), 'utf8');
  const runtimeCoopImports = gameSrc
    .split('\n')
    .filter((line) => /^\s*import\s+(?!type\b).*from\s+['"]\.\/coop-/.test(line));
  assert.deepEqual(runtimeCoopImports, [], 'game.ts contains only type-only imports from ./coop-*');

  // 4. Round 14 (4.2 & P2/P6): `onVersionMismatch` keeps Guest seat/token (never calls `leaveRoom()`),
  // Leave-sheet keydown blocks key-repeat auto-activation while passing F5 through, and `new GameCtor` failure recovers cleanly.
  const mismatchBlock = heroSrc.slice(
    heroSrc.indexOf('onVersionMismatch:'),
    heroSrc.indexOf('onStatus:', heroSrc.indexOf('onVersionMismatch:')),
  );
  assert.ok(!mismatchBlock.includes('leaveRoom('), 'onVersionMismatch preserves Guest seat & token for refresh rejoin');
  assert.ok(heroSrc.includes('if (e.repeat) e.preventDefault();'), 'held Space/Enter repeat cannot immediately confirm Leave');
  assert.match(heroSrc, /\/\^F\(\[1-9\]\|1\[0-2\]\)\$\/\.test\(e\.code\)/, 'F1..F12 (including F5 refresh) pass through Leave sheet');
  assert.ok(heroSrc.includes('game = new GameCtor(canvas, {') && heroSrc.includes('coopDirector?.dispose();'), 'Game constructor failure cleans up director and returns to lobby');
});
