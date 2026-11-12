/**
 * Two pilots and the local server, with heartbeats sent the way the page sends them: on a timer, with no
 * position handed in. (The server forgets where a pilot is whenever a heartbeat arrives without a position,
 * so every heartbeat sent during a wave has to carry one, or the other pilot sees the ship blink in and out.)
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handler } from '../lambda/index.mjs';
import { MultiplayerClient } from '../src/game/multiplayer';

const realFetch = globalThis.fetch;

before(() => {
  // Route the clients' requests straight to the handler, as lambda/dev-server.mjs does over HTTP.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = await handler({
      requestContext: { http: { method: init?.method ?? 'GET', path: url.pathname } },
      rawPath: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(res.body, { status: res.statusCode, headers: res.headers });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const flying = (shipX: number, active = true) => ({
  active, w: 1000, h: 800, scale: 1, pace: 1, shipX, shipY: 600, wave: 2, score: 900, freed: 5, hull: 3, firing: false, enemies: [],
});
/** The ships `client` is drawing for the pilot `of`. (The server is shared by every test here, and remembers pilots for a while.) */
const liveShips = (client: MultiplayerClient, of: MultiplayerClient) =>
  client.wingmen.filter((w) => w.live && w.id === Reflect.get(of, 'userId'));

test('a pilot in a wave is seen by the other pilot after every heartbeat, and where they really are', async () => {
  const a = new MultiplayerClient('http://test.local');
  const b = new MultiplayerClient('http://test.local');

  for (const x of [200, 500, 800, 650]) {
    a.updateFlight(0.016, flying(x));
    await a.pollPresence();
    await b.pollPresence();
    b.updateFlight(0.016, flying(500));
    const seen = liveShips(b, a);
    assert.equal(seen.length, 1, `after a heartbeat with the ship at ${x}`);
    assert.equal(seen[0]!.targetX, x);
  }
});

test('a pilot who pauses or leaves the wave stops being shown, and comes back on resuming', async () => {
  const a = new MultiplayerClient('http://test.local');
  const b = new MultiplayerClient('http://test.local');
  const see = async () => {
    await a.pollPresence();
    await b.pollPresence();
    b.updateFlight(0.016, flying(500));
    return liveShips(b, a).length;
  };

  a.updateFlight(0.016, flying(300));
  assert.equal(await see(), 1);
  a.rest();
  assert.equal(await see(), 0, 'paused');
  a.updateFlight(0.016, flying(300));
  assert.equal(await see(), 1, 'resumed');
  a.updateFlight(0.016, flying(300, false));
  assert.equal(await see(), 0, 'between waves');
});

test('the board starts empty, and a pilot flying alone gets a wingman that is not named after a player', () => {
  const client = new MultiplayerClient('');
  assert.deepEqual(client.snapshot().topPilots, []);
  assert.equal(client.snapshot().totalLiberated, 0);
  client.recordScore(4_000, 2, 12);
  client.updateFlight(0.016, flying(500));
  assert.deepEqual(client.wingmen.map((w) => [w.callsign, w.live]), [['WING 1', false]]);
});

test('the server\'s board replaces this browser\'s, so a board cleared on the server clears here too', async () => {
  const client = new MultiplayerClient('http://test.local');
  const answer = (body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  };
  const routed = globalThis.fetch;
  try {
    answer({ activeCount: 1, topPilots: [{ callsign: 'LYRA-4', score: 9000, wave: 4, freed: 30 }], totalLiberated: 30 });
    client.recordScore(5_000, 3, 20);
    await new Promise((done) => setTimeout(done, 5));
    assert.deepEqual(client.snapshot().topPilots.map((p) => p.callsign), ['LYRA-4'], 'what the server says, not what was here');
    assert.equal(client.snapshot().lastRank, null, 'this run is not on that board');

    answer({ activeCount: 1, topPilots: [{ callsign: 'LYRA-4', score: 9000, wave: 4, freed: 30 }, { callsign: client.getCallsign(), score: 5000, wave: 3, freed: 20 }], totalLiberated: 50 });
    await client.pollPresence();
    assert.equal(client.snapshot().lastRank, 2, 'the rank is the row the run is on');
    assert.equal(client.snapshot().totalLiberated, 50);

    answer({ activeCount: 1, topPilots: [], totalLiberated: 0 });
    await client.pollPresence();
    assert.deepEqual(client.snapshot().topPilots, [], 'cleared on the server, cleared here');
    assert.equal(client.snapshot().lastRank, null);
    assert.equal(client.snapshot().totalLiberated, 0);

    // An older server sends no board at all: that is not a cleared board.
    client.recordScore(6_000, 3, 20);
    await new Promise((done) => setTimeout(done, 5));
    answer({ activeCount: 2 });
    await client.pollPresence();
    assert.equal(client.snapshot().topPilots.length, 0, 'the last answer to the score was an empty board');
    client.recordScore(7_000, 3, 20);
    assert.equal(client.snapshot().topPilots.length, 1);
    await client.pollPresence();
    assert.equal(client.snapshot().topPilots.length, 1, 'no board in the answer leaves this one alone');
  } finally {
    globalThis.fetch = routed;
  }
});

test('counts only pilots of this game on a shared server, and tracks 3 browsers online at once', async () => {
  const routed = globalThis.fetch;
  const paths: string[] = [];
  const sharedSouls = new Map<string, Record<string, unknown>>([
    ['soul-manifesto-1', { sid: 'soul-manifesto-1', region: 'Pacific Coast', lastSeen: Date.now() }],
    ['soul-manifesto-2', { sid: 'soul-manifesto-2', region: 'London', lastSeen: Date.now() }],
  ]);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    paths.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      if (typeof b.sid === 'string') {
        sharedSouls.set(b.sid, {
          sid: b.sid,
          persona: b.persona,
          chapter: b.chapter,
          lastSeen: Date.now(),
        });
      }
    }
    return new Response(
      JSON.stringify({
        ok: true,
        activeCount: 37 + sharedSouls.size,
        activeSouls: Array.from(sharedSouls.values()),
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const settle = () => new Promise((done) => setTimeout(done, 10));
  try {
    const browser1 = new MultiplayerClient('http://test.local');
    const browser2 = new MultiplayerClient('http://test.local');
    const browser3 = new MultiplayerClient('http://test.local');

    browser1.start();
    await settle();
    assert.equal(browser1.snapshot().onlineCount, 1, 'another site\'s 37 visitors and soul-* entries are ignored');

    browser2.start();
    browser3.start();
    await settle();
    await browser1.pollPresence();
    await browser2.pollPresence();

    assert.equal(browser1.snapshot().onlineCount, 3, 'browser 1 sees all 3 pilots online');
    assert.equal(browser2.snapshot().onlineCount, 3, 'browser 2 sees all 3 pilots online');
    assert.equal(browser3.snapshot().onlineCount, 3, 'browser 3 sees all 3 pilots online');

    // A pilot flying a wave on the shared server is also seen as a live wingman by the other browsers.
    browser1.updateFlight(0.016, flying(400));
    await browser1.pollPresence();
    await browser2.pollPresence();
    browser2.updateFlight(0.016, flying(500));
    assert.equal(liveShips(browser2, browser1).length, 1, 'live wingman works on the shared server too');
    assert.equal(liveShips(browser2, browser1)[0]!.targetX, 400);

    // Scores stay local and do not POST /score when the server has no topPilots board.
    paths.length = 0;
    browser1.recordScore(5_000, 2, 10);
    await settle();
    assert.ok(!paths.some((p) => p.includes('/score')), 'does not call /score on a server without topPilots');
    assert.equal(browser1.snapshot().topPilots.length, 1, 'the run is kept on this browser\'s own board');

    // When browser 1 leaves (stop/pagehide), the other browsers drop its ship and pilot count on the next heartbeat.
    browser1.stop();
    await settle();
    await browser2.pollPresence();
    browser2.updateFlight(0.016, flying(500));
    assert.equal(liveShips(browser2, browser1).length, 0, 'leaving pilot disappears from other screens right away');
    assert.equal(browser2.snapshot().onlineCount, 2, 'pilot count drops from 3 to 2 on the next heartbeat');

    browser2.stop();
    browser3.stop();
  } finally {
    globalThis.fetch = routed;
  }
});

test('changing callsign forgets the rank earned under the old one', () => {
  const client = new MultiplayerClient('');
  assert.equal(client.recordScore(99_000, 9, 80), 1);
  client.cycleCallsign();
  assert.equal(client.snapshot().lastRank, null);
});
