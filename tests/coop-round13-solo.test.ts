import assert from 'node:assert/strict';
import { test } from 'node:test';

// Install minimal browser environment before dynamically importing `src/game/game.ts` (`sound.ts` reads `window` on load).
const media = { coarse: false, reducedMotion: false };
const g = globalThis as Record<string, unknown>;
const winTarget = new EventTarget() as EventTarget & Record<string, unknown>;
winTarget.devicePixelRatio = 1;
const docTarget = new EventTarget() as EventTarget & { hidden: boolean } & Record<string, unknown>;
docTarget.hidden = false;

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  } as Storage;
}

g.window = winTarget;
g.document = docTarget;
g.addEventListener = winTarget.addEventListener.bind(winTarget);
g.removeEventListener = winTarget.removeEventListener.bind(winTarget);
g.matchMedia = (q: string) => ({
  matches: q.includes('coarse') ? media.coarse : q.includes('reduced-motion') ? media.reducedMotion : false,
  addEventListener() {},
  removeEventListener() {},
});
g.localStorage = createMemoryStorage();
g.sessionStorage = createMemoryStorage();
g.getComputedStyle = () => ({
  paddingTop: '0px',
  paddingRight: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',
});
g.requestAnimationFrame = () => 1;
g.cancelAnimationFrame = () => {};

const { Game } = await import('../src/game/game');
const { CoopClient } = await import('../src/game/coop-client');
const { CoopFlightDirector } = await import('../src/game/coop-flight');
const { CoopLobbyController } = await import('../src/game/coop-lobby');
const { NEON } = await import('../src/game/core');
const { makeEnemy } = await import('../src/game/enemies');
const { decodeWorldSnapshot } = await import('../src/game/coop-protocol');

function makeStubCanvas(w = 1280, h = 800) {
  const c = new EventTarget() as EventTarget & {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    parentElement: null;
    getContext: () => CanvasRenderingContext2D;
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
    setPointerCapture: () => void;
  };
  const ctxStore: Record<string | symbol, unknown> = { canvas: c };
  const ctx = new Proxy(ctxStore, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') {
        return () => ({ addColorStop() {} });
      }
      if (p === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (p === 'isPointInPath' || p === 'isPointInStroke') return () => false;
      return () => {};
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  Object.assign(c, {
    clientWidth: w,
    clientHeight: h,
    width: w,
    height: h,
    parentElement: null,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: c.clientWidth, height: c.clientHeight }),
    setPointerCapture: () => {},
  });
  return c;
}

function makeFakeMultiplayer() {
  return {
    wingmen: [],
    lasers: [],
    start() {},
    stop() {},
    rest() {},
    updateFlight() {},
    recordScore: () => null,
    cycleCallsign: () => 'ACE-1',
    snapshot: () => ({
      onlineCount: 1,
      wingmenCount: 0,
      callsign: 'ACE-1',
      lastRank: null,
      totalLiberated: 0,
      topPilots: [],
    }),
    getCallsign: () => 'ACE-1',
    setCoopActive() {},
    subscribe: () => () => {},
  };
}

function makeKeyEvent(type: 'keydown' | 'keyup', code: string, keyName: string, target: unknown = null): Event {
  const ev = Object.assign(new Event(type, { cancelable: true }), {
    code,
    key: keyName,
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  });
  Object.defineProperty(ev, 'target', { value: target, configurable: true });
  return ev;
}

test('Round 13 (3.3): Solo wingmates fire on strictly alternating cannon volleys even when rockets, lance, and nova are fitted', () => {
  for (const fitted of [
    ['wingmates'],
    ['wingmates', 'rockets'],
    ['wingmates', 'lance'],
    ['wingmates', 'nova'],
    ['wingmates', 'rockets', 'lance', 'nova'],
  ] as const) {
    const canvas = makeStubCanvas(1280, 800);
    const game = new Game(canvas as unknown as HTMLCanvasElement, {
      multiplayer: makeFakeMultiplayer() as never,
      onExit() {},
      onStatus() {},
      onPause() {},
      onLeaderboard() {},
    }) as unknown as Record<string, any>;

    // Solo InputHost carries zero Co-op pointer/button hooks
    const inputHost = game.input.host as Record<string, unknown>;
    assert.equal(inputHost.onPointerDown, undefined);
    assert.equal(inputHost.allowButtonSpace, undefined);

    game.grade = 1;
    game.setState('playing');
    game.energy = 0.3;
    for (const id of fitted) game.upgrades.add(id);
    game.ship.x = game.w / 2;
    game.ship.y = game.h * 0.8;
    game.ship.invulnerable = 1e9;
    const targetEnemy = makeEnemy('dart', game.w / 2, game.h * 0.2, 1);
    targetEnemy.hp = 1e9;
    game.enemies = [targetEnemy];

    // Hold Space in solo and track each cannon volley's wingmate bolt count while rockets/lance/nova also fire!
    winTarget.dispatchEvent(makeKeyEvent('keydown', 'Space', ' ', null));

    let cannonFired = false;
    const origPlay = game.sound.play.bind(game.sound);
    game.sound.play = (sfx: string) => {
      if (sfx === 'shot') cannonFired = true;
      return origPlay(sfx);
    };

    const wingmatePattern: boolean[] = [];
    for (let f = 0; f < 60 * 20; f++) {
      cannonFired = false;
      game.shots = [];
      game.updateShip(1 / 60);
      game.updateUpgrades(1 / 60);
      if (cannonFired) {
        const wingBolts = (game.shots as Array<{ color: string; hostile: boolean }>).filter(
          (s) => !s.hostile && s.color === NEON.lime,
        );
        wingmatePattern.push(wingBolts.length > 0);
      }
    }

    winTarget.dispatchEvent(makeKeyEvent('keyup', 'Space', ' ', null));
    game.destroy();

    assert.equal(wingmatePattern.length, 110, `${fitted.join('+')}: expected 110 cannon volleys in 20s`);
    const wingCount = wingmatePattern.filter(Boolean).length;
    assert.equal(wingCount, 55, `${fitted.join('+')}: expected exactly 55 wingmate volleys, got ${wingCount}`);
    for (let i = 1; i < wingmatePattern.length; i++) {
      assert.notEqual(
        wingmatePattern[i],
        wingmatePattern[i - 1],
        `${fitted.join('+')}: back-to-back volley parity repeat at index ${i}`,
      );
    }
  }
});

test('Round 13 (Sec 5): Co-op Space on focused button never triggers game behind Leave sheet, hidden tab drops held deck touch, detonateScreen records Host FX, and lobby reportError surfaces errors', () => {
  const clockMs = 5000;
  const seats = [
    { seat: 0 as const, callsign: 'ACE', ready: true, isHost: true, connected: true },
    { seat: 1 as const, callsign: 'NOVA', ready: true, isHost: false, connected: true },
  ];

  const makeCoopGame = (role: 'host' | 'guest', w: number, h: number, coarse: boolean) => {
    const sentSnaps: Uint8Array[] = [];
    const client = new CoopClient({
      code: 'SHEET1',
      role,
      callsign: role === 'host' ? 'ACE' : 'NOVA',
      storage: null,
    });
    Object.assign(client, {
      seat: role === 'host' ? 0 : 1,
      seats,
    });
    client.sendBinary = (b: Uint8Array) => {
      sentSnaps.push(new Uint8Array(b));
      return true;
    };
    client.sendEvent = () => true;
    client.sendHostPaused = () => true;
    const director = new CoopFlightDirector({ client, initialSeats: seats, storage: null, now: () => clockMs });
    media.coarse = coarse;
    const canvas = makeStubCanvas(w, h);
    const game = new Game(canvas as unknown as HTMLCanvasElement, {
      multiplayer: makeFakeMultiplayer() as never,
      coop: { director },
      onExit() {},
      onStatus() {},
      onPause() {},
    }) as unknown as Record<string, any>;
    media.coarse = false;
    return { game, director, client, canvas, sentSnaps };
  };

  // 1. Space & Enter on a Leave-sheet <button> (`data-coop-stay` / `data-coop-confirm-leave`) leave Co-op Host paused / at Game Over,
  // while Space on an in-game button (`Pause` / `Sound`, without Leave-sheet attributes) shoots instead of re-clicking the button (Round 14 §4.4).
  const sheetButtonTarget = {
    tagName: 'BUTTON',
    hasAttribute: (name: string) => name === 'data-coop-stay',
  };
  for (const phase of ['paused', 'over'] as const) {
    const { game, director, client } = makeCoopGame('host', 1280, 800, false);
    if (phase === 'paused') {
      game.togglePause();
      assert.equal(game.paused, true);
    } else {
      game.coopGameOver();
      for (let i = 0; i < 65; i++) game.update(1 / 60);
      assert.equal(game.state, 'over');
    }
    for (const [code, keyName] of [
      ['Enter', 'Enter'],
      ['Space', ' '],
    ] as const) {
      const kd = makeKeyEvent('keydown', code, keyName, sheetButtonTarget);
      winTarget.dispatchEvent(kd);
      assert.equal(kd.defaultPrevented, false, `${code} on Leave-sheet button must not be preventDefault-ed by Input`);
      winTarget.dispatchEvent(makeKeyEvent('keyup', code, keyName, sheetButtonTarget));
    }
    if (phase === 'paused') assert.equal(game.paused, true, 'Space/Enter on sheet button did not unpause Host');
    else assert.equal(game.state, 'over', 'Space/Enter on sheet button did not relaunch Host behind sheet');
    game.destroy();
    director.dispose();
    client.dispose();
  }

  // Round 14 (4.4): Space while focus sits on an in-game button (`Pause` / `Sound`) prevents button activation and fires cannons
  {
    const topBarBtn = { tagName: 'BUTTON', hasAttribute: () => false };
    const { game, director, client } = makeCoopGame('host', 1280, 800, false);
    const kd = makeKeyEvent('keydown', 'Space', ' ', topBarBtn);
    winTarget.dispatchEvent(kd);
    assert.equal(kd.defaultPrevented, true, 'Space on focused in-game button must preventDefault so button does not click');
    game.update(1 / 60);
    assert.equal(director.pilots[0].firing, true, 'Space on focused in-game button fires ship cannons');
    winTarget.dispatchEvent(makeKeyEvent('keyup', 'Space', ' ', topBarBtn));
    game.destroy();
    director.dispose();
    client.dispose();
  }

  // 2. Portrait-phone Co-op tab hidden mid-touch (no pointercancel) drops held deck pointer cleanly
  const phone = makeCoopGame('guest', 390, 844, true);
  const pad = phone.director.layout.padRect;
  phone.canvas.dispatchEvent(
    Object.assign(new Event('pointerdown'), {
      pointerType: 'touch',
      pointerId: 11,
      clientX: pad.x + 60,
      clientY: pad.y + 60,
      button: 0,
    }),
  );
  assert.equal(phone.director.deck.state().touching, true);
  docTarget.hidden = true;
  docTarget.dispatchEvent(new Event('visibilitychange'));
  docTarget.hidden = false;
  docTarget.dispatchEvent(new Event('visibilitychange'));
  assert.equal(phone.director.deck.state().touching, false, 'visibilitychange dropped held thumb touch');
  assert.equal(phone.director.deck.state().firing, false);
  phone.canvas.dispatchEvent(
    Object.assign(new Event('pointerdown'), {
      pointerType: 'touch',
      pointerId: 12,
      clientX: pad.x + 100,
      clientY: pad.y + 60,
      button: 0,
    }),
  );
  assert.equal(phone.director.handlePointerMove(12, pad.x + 170, pad.y + 60), true);
  phone.game.destroy();
  phone.director.dispose();
  phone.client.dispose();

  // 3. Host detonateScreen records enemy-burst FX into snapshot FX ring for Guests
  const hostDet = makeCoopGame('host', 1280, 800, false);
  hostDet.game.enemies.push(makeEnemy('dart', 220, 300, 1), makeEnemy('hex', 440, 340, 1));
  hostDet.director['activeWorld']!.detonateScreen(384, 500, '#ff3366');
  const snapBytes = hostDet.director.broadcastSnapshotNow(hostDet.director['activeWorld']!)!;
  const snap = decodeWorldSnapshot(snapBytes)!;
  assert.equal(
    snap.fx.filter((f) => f.kind === 'enemy-burst').length,
    2,
    'detonateScreen recorded both enemy-burst FX for Guests',
  );
  hostDet.game.destroy();
  hostDet.director.dispose();
  hostDet.client.dispose();

  // 4. CoopLobbyController.reportError surfaces dynamic-import failures cleanly
  let renderedError = '';
  const lobbyCtrl = new CoopLobbyController({
    initialCallsign: 'ACE',
    storage: null,
  });
  lobbyCtrl.subscribe((snap) => {
    renderedError = snap.error;
  });
  lobbyCtrl.reportError('Could not launch squad flight. Check your connection and try again.');
  assert.equal(renderedError, 'Could not launch squad flight. Check your connection and try again.');
  lobbyCtrl.dispose();
});
