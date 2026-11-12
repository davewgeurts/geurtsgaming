import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MultiplayerClient,
  generateCallsign,
  mergeTopPilots,
} from '../src/game/multiplayer';
import { handler } from '../lambda/index.mjs';

describe('Multiplayer, Top 10 Pilots Leaderboard, and Wingmen', () => {
  it('generates valid arcade pilot callsigns and cycles through prefixes', () => {
    const cs1 = generateCallsign(0.15);
    const cs2 = generateCallsign(0.72);
    assert.match(cs1, /^[A-Z]+-[1-9]$/);
    assert.match(cs2, /^[A-Z]+-[1-9]$/);

    const client = new MultiplayerClient('');
    const initial = client.getCallsign();
    const next = client.cycleCallsign();
    assert.notEqual(initial, next);
    assert.match(next, /^[A-Z]+-[1-9]$/);
  });

  it('merges scores into the Top 10 Pilots leaderboard and computes rank', () => {
    // The board holds only what it is given: nothing is there that nobody flew.
    assert.deepEqual(mergeTopPilots([]), { topPilots: [], rank: null });
    const flown = Array.from({ length: 12 }, (_, i) => ({ callsign: `VEGA-${i}`, score: 20000 - i * 1000, wave: 5, freed: 40 }));
    const { topPilots, rank } = mergeTopPilots(flown, {
      callsign: 'ACE-1',
      score: 19500,
      wave: 6,
      freed: 82,
    });
    assert.equal(topPilots.length, 10);
    assert.equal(rank, 2);
    assert.equal(topPilots[0]?.callsign, 'VEGA-0');
    assert.equal(topPilots[1]?.callsign, 'ACE-1');
    assert.equal(topPilots[1]?.score, 19500);
  });

  it('spawns and interpolates autonomous squadron wingmen during active flight', () => {
    const client = new MultiplayerClient('');
    for (let step = 0; step < 20; step++) {
      client.updateFlight(0.05, {
        active: true,
        w: 800,
        h: 600,
        scale: 1,
        pace: 1,
        shipX: 400,
        shipY: 500,
        wave: 2,
        score: 1200,
        freed: 8,
        hull: 3,
        firing: true,
        enemies: [{ x: 320, y: 180 }],
      });
    }
    assert.ok(client.wingmen.length >= 1, 'Expected at least 1 allied wingman in formation');
    const w = client.wingmen[0]!;
    assert.ok(w.x > 0 && w.x < 800);
    assert.ok(w.y > 0 && w.y < 600);
    assert.ok(client.lasers.length > 0, 'Expected wingman tracer lasers when firing');

    // Clearing active flight should dismiss wingmen cleanly
    client.updateFlight(0.05, {
      active: false,
      w: 800,
      h: 600,
      scale: 1,
      pace: 1,
      shipX: 400,
      shipY: 500,
      wave: 2,
      score: 1200,
      freed: 8,
      hull: 3,
      firing: false,
      enemies: [],
    });
    assert.equal(client.wingmen.length, 0);
  });

  it('records a high score locally and updates snapshot rank and totalLiberated', () => {
    const client = new MultiplayerClient('');
    const beforeLib = client.snapshot().totalLiberated;
    const rank = client.recordScore(22500, 7, 110);
    assert.equal(rank, 1);
    const snap = client.snapshot();
    assert.equal(snap.lastRank, 1);
    assert.equal(snap.topPilots[0]?.score, 22500);
    assert.equal(snap.totalLiberated, beforeLib + 110);
  });

  it('connects two local clients through the local Lambda handler (end-to-end Docker/local mode)', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        query[k] = v;
      });
      const res = await handler({
        requestContext: { http: { method: init?.method || 'GET', path: url.pathname } },
        rawPath: url.pathname,
        queryStringParameters: query,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response(res.body, {
        status: res.statusCode,
        headers: res.headers,
      });
    }) as typeof fetch;

    try {
      const tab1 = new MultiplayerClient('http://localhost:84/api');
      const tab2 = new MultiplayerClient('http://localhost:84/api');
      tab2.cycleCallsign();

      await tab1.pollPresence({
        wave: 2,
        score: 1400,
        freed: 9,
        x: 0.3,
        y: 0.7,
        firing: true,
      });
      await tab2.pollPresence({
        wave: 3,
        score: 4800,
        freed: 22,
        x: 0.75,
        y: 0.65,
        firing: true,
      });
      await tab1.pollPresence({
        wave: 2,
        score: 1500,
        freed: 10,
        x: 0.32,
        y: 0.7,
        firing: true,
      });

      assert.ok(tab1.snapshot().onlineCount >= 2, 'Expected at least 2 active pilots across local tabs');
      tab1.updateFlight(0.1, {
        active: true,
        w: 1000,
        h: 800,
        scale: 1,
        pace: 1,
        shipX: 320,
        shipY: 560,
        wave: 2,
        score: 1500,
        freed: 10,
        hull: 3,
        firing: true,
        enemies: [],
      });

      const liveWingman = tab1.wingmen.find((w) => w.live && w.callsign === tab2.getCallsign());
      assert.ok(liveWingman, 'Expected tab1 to render tab2 as a live network wingman');
      assert.equal(liveWingman.targetX, 750);
      assert.equal(liveWingman.targetY, 520);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
