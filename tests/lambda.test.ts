/** Tests for the shared multi-site Lambda presence, wingman telemetry, and Top 10 leaderboard handler. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../lambda/index.mjs';

function makeEvent(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  headers?: Record<string, string>,
) {
  return {
    rawPath: path,
    headers: headers ?? {},
    queryStringParameters: query ?? {},
    requestContext: {
      http: {
        method,
        path,
      },
    },
    body: typeof body === 'string' ? body : body !== undefined ? JSON.stringify(body) : undefined,
  };
}

test('health endpoint reports memory mode and default site partition', async () => {
  const res = await handler(makeEvent('GET', '/health'));
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.site, 'SITE#geurtsgaming');
  assert.equal(typeof payload.totalVisits, 'number');
});

test('multi-site rooms isolate geurtsgaming, exponentialblissmanifesto, and theloneliestday', async () => {
  const ebmHealth = JSON.parse((await handler(makeEvent('GET', '/health', undefined, { site: 'ebm' }))).body);
  const lonelyHealth = JSON.parse(
    (await handler(makeEvent('GET', '/health', undefined, { site: 'theloneliestday' }))).body,
  );
  const customHealth = JSON.parse(
    (await handler(makeEvent('GET', '/health', undefined, { site: 'felinetherapist' }))).body,
  );

  assert.equal(ebmHealth.site, 'META');
  assert.equal(lonelyHealth.site, 'META_LONELIEST');
  assert.equal(customHealth.site, 'SITE#felinetherapist');
});

test('presence heartbeat tracks active pilots, wingman flight telemetry, hugs, and nginx /api prefix', async () => {
  const beforeRes = await handler(makeEvent('GET', '/api/presence'));
  const before = JSON.parse(beforeRes.body);

  const postRes = await handler(
    makeEvent('POST', '/api/presence', {
      sid: 'pilot-ace-01',
      persona: 'ACE-01',
      region: 'Mountain West',
      color: '#5ce1e6',
      isInitialView: true,
      gong: true,
      hug: {
        toSid: 'pilot-wing-02',
        toRegion: 'Tokyo',
        toLat: 35.68,
        toLon: 139.65,
        color: '#f472b6',
      },
      flight: {
        wave: 4,
        score: 9200,
        freed: 30,
        x: 0.35,
        y: 0.72,
        vx: 0.8,
        vy: -0.2,
        hull: 4,
        weapon: 'laser',
        firing: true,
      },
    }),
  );

  assert.equal(postRes.statusCode, 200);
  const after = JSON.parse(postRes.body);
  assert.equal(after.ok, true);
  assert.equal(after.totalVisits, before.totalVisits + 1);
  assert.equal(after.totalHugs, before.totalHugs + 1);
  assert.ok(after.activeCount >= 1);
  assert.ok(after.recentRipples.length >= 1);
  assert.ok(after.recentHugs.length >= 1);
  const wingman = after.wingmen.find((w: { sid: string }) => w.sid === 'pilot-ace-01');
  assert.ok(wingman, 'active pilot with flight telemetry appears in wingmen list');
  assert.equal(wingman.callsign, 'ACE-01');
  assert.equal(wingman.flight.wave, 4);
  assert.equal(wingman.flight.weapon, 'laser');
});

test('verified flight runs update the real Top 10 leaderboard, while cheaters only see a Mirage #1 board', async () => {
  const invalidRes = await handler(
    makeEvent('POST', '/score', {
      callsign: 'maverick',
      score: 6500,
      wave: 1,
      freed: 24,
    }),
  );
  assert.equal(invalidRes.statusCode, 400, 'rejects arbitrary free-text callsigns');

  // 1. A real pilot flies Wave 1 via /presence heartbeats and finishes with a plausible score.
  await handler(
    makeEvent('POST', '/presence', {
      sid: 'pilot-honest-1',
      persona: 'NOVA-7',
      flight: { runId: 'run-honest-1', wave: 1, score: 3200, freed: 18, x: 0.5, y: 0.8, firing: true },
    }),
  );

  const honestScoreRes = await handler(
    makeEvent('POST', '/score', {
      sid: 'pilot-honest-1',
      runId: 'run-honest-1',
      callsign: 'NOVA-7',
      score: 6400,
      wave: 1,
      freed: 28,
      color: '#ffe066',
    }),
  );

  assert.equal(honestScoreRes.statusCode, 200);
  const honestData = JSON.parse(honestScoreRes.body);
  assert.equal(honestData.ok, true);
  assert.equal(honestData.qualified, true);
  assert.equal(honestData.rank, 1);
  assert.equal(honestData.topPilots.length, 1, 'the board starts empty, so this honest run is the only score on it');
  assert.equal(honestData.topPilots[0].callsign, 'NOVA-7');
  assert.equal(honestData.topPilots[0].score, 6400);

  // 2. Cold API submission (no /presence flight history) gets Mirage #1 in their own response,
  //    but is absent from GET /leaderboard and other players' /presence responses.
  const coldCurlRes = await handler(
    makeEvent('POST', '/score', {
      sid: 'pilot-curl-bot',
      callsign: 'VIPER-9',
      score: 9500,
      wave: 1,
      freed: 30,
    }),
  );
  assert.equal(coldCurlRes.statusCode, 200);
  const coldData = JSON.parse(coldCurlRes.body);
  assert.equal(coldData.rank, 1, 'cheater is told they ranked #1');
  assert.equal(coldData.topPilots[0].callsign, 'VIPER-9');

  // 3. DevTools point spike (+9,999,999 on Wave 1) also gets Mirage #1 only for that cheater's sid.
  await handler(
    makeEvent('POST', '/presence', {
      sid: 'pilot-cheater-2',
      persona: 'FALCON-3',
      flight: { runId: 'run-cheat-2', wave: 1, score: 400, freed: 2, x: 0.5, y: 0.8, firing: false },
    }),
  );
  const spikeRes = await handler(
    makeEvent('POST', '/score', {
      sid: 'pilot-cheater-2',
      runId: 'run-cheat-2',
      callsign: 'FALCON-3',
      score: 9999999,
      wave: 1,
      freed: 9999,
    }),
  );
  assert.equal(spikeRes.statusCode, 200);
  const spikeData = JSON.parse(spikeRes.body);
  assert.equal(spikeData.rank, 1, 'cheater sees their huge fake score at #1');
  assert.equal(spikeData.topPilots[0].callsign, 'FALCON-3');
  assert.equal(spikeData.topPilots[0].score, 9999999);

  // When the cheater polls /presence, they STILL see themselves at #1 so the illusion holds.
  const cheaterPresence = JSON.parse(
    (await handler(makeEvent('POST', '/presence', { sid: 'pilot-cheater-2', persona: 'FALCON-3' }))).body,
  );
  assert.equal(cheaterPresence.topPilots[0].callsign, 'FALCON-3');

  // Meanwhile, the real public leaderboard and honest pilots ONLY ever see NOVA-7!
  const realBoard = JSON.parse((await handler(makeEvent('GET', '/leaderboard'))).body);
  assert.deepEqual(
    realBoard.topPilots.map((p: { callsign: string; score: number }) => [p.callsign, p.score]),
    [['NOVA-7', 6400]],
    'neither cold-curl nor score-spike cheaters appear on the real leaderboard',
  );
  assert.equal(realBoard.totalLiberated, 28);

  const honestPresence = JSON.parse(
    (await handler(makeEvent('POST', '/presence', { sid: 'pilot-honest-1', persona: 'NOVA-7' }))).body,
  );
  assert.deepEqual(
    honestPresence.topPilots.map((p: { callsign: string }) => p.callsign),
    ['NOVA-7'],
    'other players polling /presence never see shadowbanned scores',
  );
});

test('origin allowlist and request body size cap block untrusted cross-site and oversized POSTs', async () => {
  const evilOriginRes = await handler(
    makeEvent(
      'POST',
      '/score',
      { callsign: 'NOVA-7', score: 1200, wave: 1, freed: 5 },
      {},
      { origin: 'https://evil-cheats.example.com' },
    ),
  );
  assert.equal(evilOriginRes.statusCode, 403);

  const goodOriginRes = await handler(
    makeEvent(
      'POST',
      '/presence',
      { sid: 'pilot-origin-ok', persona: 'LYRA-2' },
      { site: 'geurtsgaming' },
      { origin: 'https://geurtsgaming.com' },
    ),
  );
  assert.equal(goodOriginRes.statusCode, 200);

  const hugeBody = JSON.stringify({ sid: 'pilot-big', pad: 'x'.repeat(10_000) });
  const oversizedRes = await handler(makeEvent('POST', '/presence', hugeBody));
  assert.equal(oversizedRes.statusCode, 413);
});
