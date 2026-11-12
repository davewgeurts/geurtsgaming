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

test('nothing is sent to a server from before this game; one that knows the game gets heartbeats', async () => {
  const routed = globalThis.fetch;
  const calls: string[] = [];
  const server = (reply: unknown) => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET');
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as typeof fetch;
  };
  const settle = () => new Promise((done) => setTimeout(done, 10));
  try {
    // The older server answers for another site's room, and has no leaderboard.
    server({ ok: true, activeCount: 37, activeSouls: [] });
    const quiet = new MultiplayerClient('http://test.local');
    quiet.start();
    await settle();
    quiet.updateFlight(0.016, flying(300));
    quiet.recordScore(5_000, 2, 10);
    await quiet.pollPresence();
    await settle();
    quiet.stop();
    assert.deepEqual(calls, ['GET'], 'one question that only reads, and then silence');
    assert.equal(quiet.snapshot().onlineCount, 1, 'and its count of another site\'s visitors is not shown');
    assert.equal(quiet.snapshot().topPilots.length, 1, 'the run is still on this browser\'s own board');

    calls.length = 0;
    server({ ok: true, activeCount: 2, topPilots: [], totalLiberated: 0 });
    const live = new MultiplayerClient('http://test.local');
    live.start();
    await settle();
    live.stop();
    assert.deepEqual(calls, ['GET', 'POST'], 'an empty board is still a board: the heartbeats start');
    assert.equal(live.snapshot().onlineCount, 2);
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
