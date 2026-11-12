/** Tests for the shared multi-site Lambda presence, wingman telemetry, and Top 10 leaderboard handler. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../lambda/index.mjs';

function makeEvent(method: string, path: string, body?: unknown, query?: Record<string, string>) {
  return {
    rawPath: path,
    queryStringParameters: query ?? {},
    requestContext: {
      http: {
        method,
        path,
      },
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

test('score submission updates Top 10 leaderboard, sorts descending, validates callsigns, and clamps implausible scores', async () => {
  const invalidRes = await handler(
    makeEvent('POST', '/score', {
      callsign: 'maverick',
      score: 21500,
      wave: 8,
      freed: 72,
    }),
  );
  assert.equal(invalidRes.statusCode, 400, 'rejects arbitrary free-text callsigns');

  const scoreRes = await handler(
    makeEvent('POST', '/score', {
      callsign: 'NOVA-7',
      score: 21500,
      wave: 8,
      freed: 72,
      color: '#ffe066',
    }),
  );

  assert.equal(scoreRes.statusCode, 200);
  const data = JSON.parse(scoreRes.body);
  assert.equal(data.ok, true);
  assert.equal(data.qualified, true);
  assert.equal(data.rank, 1);
  assert.equal(data.topPilots.length, 1, 'the board starts empty, so this is the only score on it');
  assert.equal(data.topPilots[0].callsign, 'NOVA-7');
  assert.equal(data.topPilots[0].score, 21500);

  // Verify wave-based anti-cheat score clamp (wave 1 max is 40,000)
  const clampedRes = await handler(
    makeEvent('POST', '/score', {
      callsign: 'FALCON-3',
      score: 9999999,
      wave: 1,
      freed: 9999,
    }),
  );
  const clampedData = JSON.parse(clampedRes.body);
  assert.equal(clampedData.entry.score, 40000);
  assert.equal(clampedData.entry.freed, 60);
});
