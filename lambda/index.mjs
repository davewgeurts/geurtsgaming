// Shared Multi-Site Soul Presence, Ripples, Hugs, Globe Pins, Arcade Wingmen,
// Top 10 Pilot Leaderboards & Manifesto Pledges Lambda Handler.
// Used by exponentialblissmanifesto.com, TheLoneliestDay, and geurtsgaming.com.
// @ts-nocheck

let ddb = null;
let GetCommand = null;
let PutCommand = null;
let UpdateCommand = null;
let QueryCommand = null;

const SHOULD_USE_DDB =
  (Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) || process.env.USE_DYNAMODB === 'true') &&
  process.env.DYNAMODB_TABLE !== '';

if (SHOULD_USE_DDB) {
  try {
    const clientMod = await import('@aws-sdk/client-dynamodb');
    const libMod = await import('@aws-sdk/lib-dynamodb');
    GetCommand = libMod.GetCommand;
    PutCommand = libMod.PutCommand;
    UpdateCommand = libMod.UpdateCommand;
    QueryCommand = libMod.QueryCommand;
    ddb = libMod.DynamoDBDocumentClient.from(new clientMod.DynamoDBClient({}));
  } catch {
    // Running in local/offline mode without @aws-sdk installed
  }
}

const TABLE = process.env.TABLE_NAME || 'exponentialbliss-pledges';
const DEFAULT_SITE = process.env.DEFAULT_SITE || 'geurtsgaming';
const SOUL_ACTIVE_WINDOW_MS = 110_000;
const PILOT_ACTIVE_WINDOW_MS = 30_000;
const WINGMAN_ACTIVE_WINDOW_MS = 12_000;
const EVENT_RECENT_WINDOW_MS = 90_000;
const MAX_RECENT_EVENTS = 12;
const MAX_ACTIVE_SOULS = 24;
const MAX_HUG_PINS = 64;
const MAX_LEADERBOARD_PILOTS = 10;
const DDB_SYNC_COALESCE_MS = 1_500;
const VALID_CALLSIGN_RE = /^(NOVA|FALCON|VIPER|STAR|ORION|LYRA|VEGA|COMET|APEX|DRIFT|PULSE|SOLAR)-[1-9]$/;
const SCORE_RATE_WINDOW_MS = 60_000;
const SCORE_RATE_MAX = 10;
const scoreRateByIp = new Map();


function createInitialPins() {
  return new Map([
    [
      'pin-mountain-west',
      {
        id: 'pin-mountain-west',
        region: 'Mountain West',
        lat: 39.74,
        lon: -104.99,
        color: '#fbbf24',
        count: 14,
        lastHugTs: 1792100000000,
      },
    ],
    [
      'pin-pacific-coast',
      {
        id: 'pin-pacific-coast',
        region: 'Pacific Coast',
        lat: 36.78,
        lon: -119.42,
        color: '#38bdf8',
        count: 19,
        lastHugTs: 1792100000000,
      },
    ],
    [
      'pin-tokyo',
      {
        id: 'pin-tokyo',
        region: 'Tokyo',
        lat: 35.68,
        lon: 139.65,
        color: '#f472b6',
        count: 11,
        lastHugTs: 1792100000000,
      },
    ],
    [
      'pin-london',
      {
        id: 'pin-london',
        region: 'London',
        lat: 51.51,
        lon: -0.13,
        color: '#4ade80',
        count: 9,
        lastHugTs: 1792100000000,
      },
    ],
  ]);
}

function createPresenceRoom(pkName, initialVisits = 108, initialHugs = 42, initialLiberated = 319) {
  return {
    pk: pkName,
    activeSouls: new Map(),
    recentRipples: [],
    recentHugs: [],
    hugPins: createInitialPins(),
    // The leaderboard starts empty: it only ever holds scores somebody really flew.
    topPilots: [],
    cachedTotalVisits: initialVisits,
    cachedDayVisits: 14,
    cachedTotalHugs: initialHugs,
    cachedTotalLiberated: initialLiberated,
    cachedDayKey: '',
    lastDdbSyncMs: 0,
  };
}

const ROOMS = new Map([
  ['default', createPresenceRoom('META', 108, 42, 0)],
  ['theloneliestday', createPresenceRoom('META_LONELIEST', 142, 64, 0)],
  ['geurtsgaming', createPresenceRoom('SITE#geurtsgaming', 128, 0, 0)],
]);

function getRoom(siteKey) {
  const clean = sanitize(siteKey, 48).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!clean || clean === 'default' || clean === 'ebm' || clean === 'exponentialblissmanifesto') {
    return ROOMS.get('default');
  }
  if (clean === 'theloneliestday') {
    return ROOMS.get('theloneliestday');
  }
  let room = ROOMS.get(clean);
  if (!room) {
    room = createPresenceRoom(`SITE#${clean}`, 1, 0, 0);
    ROOMS.set(clean, room);
  }
  return room;
}

const fallbackMeta = {
  signatures: 0,
  wealthPledges: 0,
  totalPledgedMillions: 0,
  beneficiaries: 0,
  bitesTaken: 0,
  totalVisits: 108,
  totalHugs: 42,
};
const fallbackEntries = [];

const SEED_ENTRIES = [
  {
    id: 'seed-1',
    type: 'wealth_pledge',
    handle: 'The First Spark',
    location: 'Salt Lake Valley, UT',
    pledgeMillions: 10,
    pledgeTier: 'Once at $10M+ Bliss Baseline → 100% Overflow to the Base',
    message:
      'The Massive 1% Fires Must Spread Some Flames to Ignite The World. Just take the first bite.',
    createdAt: '2026-10-14T06:00:00.000Z',
  },
  {
    id: 'seed-2',
    type: 'signature',
    handle: 'Stadium Vibration',
    location: 'Pacific Coast',
    message:
      'Imagine going to see your favorite band where everyone in the crowd got in for free and is debt free. It will feel like your very first concert again.',
    createdAt: '2026-10-14T06:15:00.000Z',
  },
  {
    id: 'seed-3',
    type: 'beneficiary',
    handle: 'Present Parent',
    location: 'Mountain West',
    needCategory: 'Time Abundance & Debt Liberation',
    message:
      'Seeking freedom from mortgage/medical debt so both parents can be home daily with our young kids while they are still little.',
    createdAt: '2026-10-14T06:30:00.000Z',
  },
];

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function sanitize(str, maxLen = 280) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>]/g, '').slice(0, maxLen);
}

function clampCoordinate(value, min, max, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function sanitizeFlightTelemetry(flight) {
  if (!flight || typeof flight !== 'object') return undefined;
  return {
    wave: Math.round(clampCoordinate(flight.wave, 1, 99, 1)),
    score: Math.round(clampCoordinate(flight.score, 0, 9_999_999, 0)),
    freed: Math.round(clampCoordinate(flight.freed, 0, 99_999, 0)),
    x: Number(clampCoordinate(flight.x, 0, 1, 0.5).toFixed(4)),
    y: Number(clampCoordinate(flight.y, 0, 1, 0.8).toFixed(4)),
    vx: Number(clampCoordinate(flight.vx, -5, 5, 0).toFixed(3)),
    vy: Number(clampCoordinate(flight.vy, -5, 5, 0).toFixed(3)),
    hull: Math.round(clampCoordinate(flight.hull, 0, 20, 5)),
    weapon: sanitize(flight.weapon, 24) || 'blaster',
    firing: Boolean(flight.firing),
  };
}

function mergeTopPilots(existingPilots, incomingPilots) {
  const byCallsign = new Map();
  for (const p of [...existingPilots, ...(Array.isArray(incomingPilots) ? incomingPilots : [])]) {
    if (!p || typeof p.callsign !== 'string' || typeof p.score !== 'number') continue;
    const callsign = sanitize(p.callsign, 18).toUpperCase() || 'PILOT';
    const prev = byCallsign.get(callsign);
    if (!prev || p.score >= prev.score) {
      byCallsign.set(callsign, {
        id: sanitize(p.id || `${callsign}-${p.score}-${p.wave || 1}`, 64),
        callsign,
        score: Math.round(clampCoordinate(p.score, 0, 9_999_999, 0)),
        wave: Math.round(clampCoordinate(p.wave, 1, 99, 1)),
        freed: Math.round(clampCoordinate(p.freed, 0, 99_999, 0)),
        color: sanitize(p.color, 32) || '#5ce1e6',
        ts: typeof p.ts === 'number' ? p.ts : Date.now(),
      });
    }
  }
  return Array.from(byCallsign.values())
    .sort((a, b) => b.score - a.score || b.wave - a.wave || a.ts - b.ts)
    .slice(0, MAX_LEADERBOARD_PILOTS);
}

/**
 * Merges incoming timestamped events into `targetList`, deduplicating by `id`,
 * pruning entries older than `maxAgeMs`, sorting ascending by `ts`, and capping at `maxItems`.
 */
function mergeAndPruneRecentEvents(
  targetList,
  incomingEvents,
  nowMs,
  maxAgeMs = EVENT_RECENT_WINDOW_MS,
  maxItems = MAX_RECENT_EVENTS
) {
  if (Array.isArray(incomingEvents)) {
    const existingIds = new Set(targetList.map((entry) => entry.id));
    for (const candidate of incomingEvents) {
      if (!candidate || typeof candidate.id !== 'string') continue;
      if (
        nowMs - (candidate.ts || 0) < maxAgeMs &&
        !existingIds.has(candidate.id)
      ) {
        targetList.push(candidate);
        existingIds.add(candidate.id);
      }
    }
    targetList.sort((a, b) => a.ts - b.ts);
  }
  while (targetList.length > 0 && nowMs - targetList[0].ts >= maxAgeMs) {
    targetList.shift();
  }
  if (targetList.length > maxItems) {
    targetList.splice(0, targetList.length - maxItems);
  }
}

function getSortedHugPins(room) {
  return Array.from(room.hugPins.values())
    .sort((a, b) => (b.lastHugTs || 0) - (a.lastHugTs || 0))
    .slice(0, MAX_HUG_PINS);
}

function mergeRemoteState(room, item, nowMs) {
  if (!item || typeof item !== 'object') return;
  if (typeof item.totalVisits === 'number') {
    room.cachedTotalVisits = Math.max(room.cachedTotalVisits, item.totalVisits);
  }
  if (typeof item.totalHugs === 'number') {
    room.cachedTotalHugs = Math.max(room.cachedTotalHugs, item.totalHugs);
  }
  if (typeof item.totalLiberated === 'number') {
    room.cachedTotalLiberated = Math.max(
      room.cachedTotalLiberated,
      item.totalLiberated
    );
  }
  if (Array.isArray(item.activeSouls)) {
    for (const s of item.activeSouls) {
      if (!s || typeof s.sid !== 'string') continue;
      if (nowMs - (s.lastSeen || 0) <= SOUL_ACTIVE_WINDOW_MS) {
        const existing = room.activeSouls.get(s.sid);
        if (!existing || s.lastSeen > existing.lastSeen) {
          room.activeSouls.set(s.sid, s);
        }
      }
    }
  }
  if (Array.isArray(item.recentRipples)) {
    mergeAndPruneRecentEvents(room.recentRipples, item.recentRipples, nowMs);
  }
  if (Array.isArray(item.recentHugs)) {
    mergeAndPruneRecentEvents(room.recentHugs, item.recentHugs, nowMs);
  }
  if (Array.isArray(item.topPilots)) {
    room.topPilots = mergeTopPilots(room.topPilots, item.topPilots);
  }
  if (Array.isArray(item.hugPins)) {
    for (const p of item.hugPins) {
      if (!p || typeof p.id !== 'string') continue;
      const existing = room.hugPins.get(p.id);
      if (!existing) {
        room.hugPins.set(p.id, {
          id: p.id,
          region: sanitize(p.region, 64) || 'Earth',
          lat: typeof p.lat === 'number' && Number.isFinite(p.lat) ? p.lat : 0,
          lon: typeof p.lon === 'number' && Number.isFinite(p.lon) ? p.lon : 0,
          color: sanitize(p.color, 32) || '#f472b6',
          count:
            typeof p.count === 'number' && Number.isFinite(p.count)
              ? Math.max(1, p.count)
              : 1,
          lastHugTs:
            typeof p.lastHugTs === 'number' && Number.isFinite(p.lastHugTs)
              ? p.lastHugTs
              : nowMs,
        });
      } else {
        room.hugPins.set(p.id, {
          ...existing,
          count: Math.max(existing.count || 1, p.count || 1),
          lastHugTs: Math.max(existing.lastHugTs || 0, p.lastHugTs || 0),
        });
      }
    }
  }
}

export async function handler(event) {
  const method = event.requestContext?.http?.method || 'GET';
  const rawPath = event.rawPath || event.requestContext?.http?.path || '/';
  const path = rawPath.replace(/^\/api(?=\/|$)/, '') || '/';
  const querySite = event.queryStringParameters?.site || '';

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: {}, body: '' };
  }

  try {
    if (method === 'GET' && path === '/health') {
      const room = getRoom(querySite || DEFAULT_SITE);
      return respond(200, {
        ok: true,
        mode: ddb ? 'dynamodb' : 'memory',
        site: room.pk,
        activeCount: room.activeSouls.size,
        totalVisits: room.cachedTotalVisits,
      });
    }

    if (
      (method === 'GET' || method === 'POST') &&
      (path === '/presence' || path === '/loneliest-presence')
    ) {
      const body = method === 'POST' ? JSON.parse(event.body || '{}') : {};
      const siteKey =
        path === '/loneliest-presence'
          ? 'theloneliestday'
          : querySite || body.siteId || body.site || DEFAULT_SITE;
      const room = getRoom(siteKey);

      const nowMs = Date.now();
      const todayKey = new Date(nowMs).toISOString().slice(0, 10);
      if (room.cachedDayKey && room.cachedDayKey !== todayKey) {
        room.cachedDayVisits = 1;
      }
      room.cachedDayKey = todayKey;

      const activeWindowMs = room.pk.startsWith('SITE#')
        ? PILOT_ACTIVE_WINDOW_MS
        : SOUL_ACTIVE_WINDOW_MS;
      for (const [k, s] of room.activeSouls.entries()) {
        if (nowMs - s.lastSeen > activeWindowMs || s.chapter === 'gg-left') {
          room.activeSouls.delete(k);
        }
      }

      const hasHug = Boolean(body.hug && typeof body.hug === 'object');
      const isLeaving = method === 'POST' && (body.leave === true || body.chapter === 'gg-left');
      const incomingSid =
        method === 'POST'
          ? sanitize(body.sid, 64) ||
            `anon-${Math.random().toString(36).slice(2, 8)}`
          : '';
      const isNewSoul = method === 'POST' && !isLeaving && !room.activeSouls.has(incomingSid);
      const shouldSyncDdb =
        Boolean(ddb) &&
        (body.isInitialView === true ||
          isNewSoul ||
          isLeaving ||
          body.gong === true ||
          hasHug ||
          nowMs - room.lastDdbSyncMs > DDB_SYNC_COALESCE_MS);

      if (shouldSyncDdb) {
        if (method === 'POST') room.lastDdbSyncMs = nowMs;
        try {
          const metaRes = await ddb.send(
            new GetCommand({
              TableName: TABLE,
              Key: { pk: room.pk, sk: 'COUNTS' },
            })
          );
          mergeRemoteState(room, metaRes.Item, nowMs);
        } catch {
          // Offline / local Docker fallback
        }
      }

      if (method === 'POST') {
        const sid = incomingSid;
        const region = sanitize(body.region, 64) || 'Earth';
        const lat = clampCoordinate(body.lat, -90, 90);
        const lon = clampCoordinate(body.lon, -180, 180);
        const color = sanitize(body.color, 32) || '#fbbf24';
        const chapter = sanitize(body.chapter, 48) || undefined;
        const persona = sanitize(body.persona, 64) || undefined;
        const flight = sanitizeFlightTelemetry(body.flight);

        if (isLeaving) {
          room.activeSouls.delete(sid);
        } else {
          room.activeSouls.set(sid, {
            sid,
            region,
            lat,
            lon,
            color,
            chapter,
            persona,
            flight,
            lastSeen: nowMs,
          });
        }

        if (body.gong === true) {
          mergeAndPruneRecentEvents(
            room.recentRipples,
            [
              {
                id: `${nowMs}-${sid.slice(0, 4)}`,
                region,
                lat,
                lon,
                color,
                ts: nowMs,
              },
            ],
            nowMs
          );
        }

        if (hasHug) {
          room.cachedTotalHugs += 1;
          const h = body.hug;
          mergeAndPruneRecentEvents(
            room.recentHugs,
            [
              {
                id: `${nowMs}-hug-${sid.slice(0, 4)}-${Math.random()
                  .toString(36)
                  .slice(2, 5)}`,
                fromSid: sid,
                fromRegion: region,
                fromLat: lat,
                fromLon: lon,
                toSid: sanitize(h.toSid, 64) || 'planet-earth',
                toRegion: sanitize(h.toRegion, 64) || 'Earth',
                toLat: clampCoordinate(h.toLat, -90, 90),
                toLon: clampCoordinate(h.toLon, -180, 180),
                color: sanitize(h.color, 32) || '#f472b6',
                ts: nowMs,
              },
            ],
            nowMs
          );

          const pinKey =
            sanitize(h.pinId, 64) ||
            `pin-${region
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')}`;
          const existingPin = room.hugPins.get(pinKey);
          room.hugPins.set(pinKey, {
            id: pinKey,
            region,
            lat,
            lon,
            color: color || '#f472b6',
            count: (existingPin?.count || 0) + 1,
            lastHugTs: nowMs,
          });
        }

        if (body.isInitialView === true) {
          room.cachedTotalVisits += 1;
          room.cachedDayVisits += 1;
        }

        if (shouldSyncDdb) {
          const prunedSouls = Array.from(room.activeSouls.values())
            .filter((s) => nowMs - s.lastSeen <= SOUL_ACTIVE_WINDOW_MS)
            .slice(-MAX_ACTIVE_SOULS);
          const prunedRipples = room.recentRipples
            .filter((r) => nowMs - r.ts < EVENT_RECENT_WINDOW_MS)
            .slice(-MAX_RECENT_EVENTS);
          const prunedHugs = room.recentHugs
            .filter((h) => nowMs - h.ts < EVENT_RECENT_WINDOW_MS)
            .slice(-MAX_RECENT_EVENTS);
          const persistentHugPins = getSortedHugPins(room);

          try {
            const res = await ddb.send(
              new UpdateCommand({
                TableName: TABLE,
                Key: { pk: room.pk, sk: 'COUNTS' },
                UpdateExpression:
                  'SET activeSouls = :souls, recentRipples = :ripples, recentHugs = :hugs, hugPins = :hugPins, topPilots = :pilots, totalVisits = :visits, totalHugs = :totalHugs, totalLiberated = :liberated',
                ExpressionAttributeValues: {
                  ':souls': prunedSouls,
                  ':ripples': prunedRipples,
                  ':hugs': prunedHugs,
                  ':hugPins': persistentHugPins,
                  ':pilots': room.topPilots,
                  ':visits': room.cachedTotalVisits,
                  ':totalHugs': room.cachedTotalHugs,
                  ':liberated': room.cachedTotalLiberated,
                },
                ReturnValues: 'ALL_NEW',
              })
            );
            if (typeof res.Attributes?.totalVisits === 'number') {
              room.cachedTotalVisits = Math.max(
                room.cachedTotalVisits,
                res.Attributes.totalVisits
              );
            }
            if (typeof res.Attributes?.totalHugs === 'number') {
              room.cachedTotalHugs = Math.max(
                room.cachedTotalHugs,
                res.Attributes.totalHugs
              );
            }
            if (typeof res.Attributes?.totalLiberated === 'number') {
              room.cachedTotalLiberated = Math.max(
                room.cachedTotalLiberated,
                res.Attributes.totalLiberated
              );
            }
          } catch {
            // Offline / local Docker fallback
          }
        }
      }

      const activeSouls = Array.from(room.activeSouls.values()).slice(
        0,
        MAX_ACTIVE_SOULS
      );
      const wingmen = activeSouls
        .filter(
          (s) =>
            Boolean(s.flight) && nowMs - s.lastSeen <= WINGMAN_ACTIVE_WINDOW_MS
        )
        .map((s) => ({
          sid: s.sid,
          callsign: s.persona || 'WINGMAN',
          color: s.color,
          region: s.region,
          flight: s.flight,
          lastSeen: s.lastSeen,
        }));

      const recentRipples = room.recentRipples
        .filter((r) => nowMs - r.ts < EVENT_RECENT_WINDOW_MS)
        .slice(-MAX_RECENT_EVENTS);
      const recentHugs = room.recentHugs
        .filter((h) => nowMs - h.ts < EVENT_RECENT_WINDOW_MS)
        .slice(-MAX_RECENT_EVENTS);
      const hugPins = getSortedHugPins(room);

      return respond(200, {
        ok: true,
        activeCount: room.activeSouls.size,
        activeSouls,
        wingmen,
        topPilots: room.topPilots,
        totalVisits: room.cachedTotalVisits,
        dayVisits: room.cachedDayVisits,
        totalHugs: room.cachedTotalHugs,
        totalLiberated: room.cachedTotalLiberated,
        recentRipples,
        recentHugs,
        hugPins,
      });
    }

    if (method === 'GET' && path === '/leaderboard') {
      const room = getRoom(querySite || 'geurtsgaming');
      return respond(200, {
        ok: true,
        topPilots: room.topPilots,
        totalLiberated: room.cachedTotalLiberated,
      });
    }

    if (method === 'POST' && (path === '/score' || path === '/leaderboard')) {
      const body = JSON.parse(event.body || '{}');
      const room = getRoom(querySite || body.siteId || body.site || 'geurtsgaming');
      const nowMs = Date.now();

      const clientIp = sanitize(event.requestContext?.http?.sourceIp, 64);
      if (clientIp) {
        const recent = (scoreRateByIp.get(clientIp) || []).filter(
          (ts) => nowMs - ts < SCORE_RATE_WINDOW_MS
        );
        if (recent.length >= SCORE_RATE_MAX) {
          return respond(429, {
            ok: false,
            error: 'Too many score submissions',
          });
        }
        recent.push(nowMs);
        scoreRateByIp.set(clientIp, recent);
      }

      const callsign = sanitize(body.callsign, 18).toUpperCase();
      if (!VALID_CALLSIGN_RE.test(callsign)) {
        return respond(400, {
          ok: false,
          error: 'Invalid callsign format',
        });
      }
      const wave = Math.round(clampCoordinate(body.wave, 1, 99, 1));
      const maxPlausibleScore = wave * 25_000 + 15_000;
      const score = Math.round(
        clampCoordinate(body.score, 0, maxPlausibleScore, 0)
      );
      const freed = Math.round(clampCoordinate(body.freed, 0, wave * 60, 0));
      const color = sanitize(body.color, 32) || '#5ce1e6';

      if (score <= 0) {
        return respond(400, {
          ok: false,
          error: 'Score must be greater than 0',
        });
      }

      const entryId = `${nowMs}-${Math.random().toString(36).slice(2, 7)}`;
      const candidate = {
        id: entryId,
        callsign,
        score,
        wave,
        freed,
        color,
        ts: nowMs,
      };

      room.cachedTotalLiberated += freed;
      room.topPilots = mergeTopPilots(room.topPilots, [candidate]);

      if (ddb) {
        room.lastDdbSyncMs = nowMs;
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: TABLE,
              Key: { pk: room.pk, sk: 'COUNTS' },
              UpdateExpression:
                'SET topPilots = :pilots, totalLiberated = :liberated',
              ExpressionAttributeValues: {
                ':pilots': room.topPilots,
                ':liberated': room.cachedTotalLiberated,
              },
            })
          );
        } catch {
          // Offline / local Docker fallback
        }
      }

      const rankIdx = room.topPilots.findIndex((p) => p.id === entryId);

      return respond(200, {
        ok: true,
        qualified: rankIdx !== -1,
        rank: rankIdx !== -1 ? rankIdx + 1 : null,
        entry: candidate,
        topPilots: room.topPilots,
        totalLiberated: room.cachedTotalLiberated,
      });
    }

    if (method === 'GET' && (path === '/' || path === '/pledges')) {
      const defaultRoom = getRoom('default');
      let item = fallbackMeta;
      let dbEntries = fallbackEntries;

      if (ddb) {
        try {
          const [statsRes, entriesRes] = await Promise.all([
            ddb.send(
              new GetCommand({
                TableName: TABLE,
                Key: { pk: 'META', sk: 'COUNTS' },
              })
            ),
            ddb.send(
              new QueryCommand({
                TableName: TABLE,
                KeyConditionExpression: 'pk = :pk',
                ExpressionAttributeValues: { ':pk': 'ENTRY' },
                ScanIndexForward: false,
                Limit: 50,
              })
            ),
          ]);

          item = statsRes.Item || {};
          mergeRemoteState(defaultRoom, item, Date.now());
          dbEntries = (entriesRes.Items || []).map((e) => ({
            id: e.sk,
            type: e.type,
            handle: e.handle,
            location: e.location,
            pledgeMillions: e.pledgeMillions,
            pledgeTier: e.pledgeTier,
            needCategory: e.needCategory,
            message: e.message,
            createdAt: e.createdAt,
          }));
        } catch {
          item = fallbackMeta;
          dbEntries = fallbackEntries;
        }
      }

      const recent = [...dbEntries, ...SEED_ENTRIES].slice(0, 50);

      return respond(200, {
        counts: {
          signatures: (item.signatures || 0) + 1,
          wealthPledges: (item.wealthPledges || 0) + 1,
          totalPledgedMillions: (item.totalPledgedMillions || 0) + 10,
          beneficiaries: (item.beneficiaries || 0) + 1,
          bitesTaken: (item.bitesTaken || 0) + 3,
        },
        recent,
      });
    }

    if (method === 'POST' && path === '/bite') {
      fallbackMeta.bitesTaken += 1;
      let item = fallbackMeta;

      if (ddb) {
        try {
          const res = await ddb.send(
            new UpdateCommand({
              TableName: TABLE,
              Key: { pk: 'META', sk: 'COUNTS' },
              UpdateExpression: 'ADD bitesTaken :inc',
              ExpressionAttributeValues: { ':inc': 1 },
              ReturnValues: 'ALL_NEW',
            })
          );
          item = res.Attributes || fallbackMeta;
        } catch {
          item = fallbackMeta;
        }
      }

      return respond(200, {
        ok: true,
        bitesTaken: (item.bitesTaken || 0) + 3,
      });
    }

    if (method === 'POST' && path === '/pledge') {
      const body = JSON.parse(event.body || '{}');
      const type = body.type;
      if (!['signature', 'wealth_pledge', 'beneficiary'].includes(type)) {
        return respond(400, { error: 'Invalid pledge type' });
      }

      const defaultHandles = {
        signature: 'Anonymous Signer',
        wealth_pledge: 'Anonymous 1% Spark',
        beneficiary: 'Anonymous Beneficiary',
      };

      const handle = sanitize(body.handle, 48) || defaultHandles[type];
      const location = sanitize(body.location, 48) || 'Earth';
      const message =
        sanitize(body.message, 360) ||
        'All humans deserve to experience bliss and freedom from suffering.';
      const pledgeTier = sanitize(body.pledgeTier, 90);
      const needCategory = sanitize(body.needCategory, 90);
      const rawMillions = Number(body.pledgeMillions) || 0;
      const pledgeMillions =
        type === 'wealth_pledge' ? Math.max(0, Math.min(10000, rawMillions)) : 0;

      const nowIso = new Date().toISOString();
      const sk = `${nowIso}#${Math.random().toString(36).slice(2, 8)}`;

      const entry = {
        pk: 'ENTRY',
        sk,
        type,
        handle,
        location,
        pledgeMillions,
        pledgeTier,
        needCategory,
        message,
        createdAt: nowIso,
      };

      const counterField =
        type === 'signature'
          ? 'signatures'
          : type === 'wealth_pledge'
          ? 'wealthPledges'
          : 'beneficiaries';

      fallbackMeta[counterField] = (fallbackMeta[counterField] || 0) + 1;
      fallbackMeta.totalPledgedMillions =
        (fallbackMeta.totalPledgedMillions || 0) + pledgeMillions;
      fallbackMeta.bitesTaken = (fallbackMeta.bitesTaken || 0) + 1;
      fallbackEntries.unshift({
        id: sk,
        type,
        handle,
        location,
        pledgeMillions,
        pledgeTier,
        needCategory,
        message,
        createdAt: nowIso,
      });

      if (ddb) {
        try {
          await Promise.all([
            ddb.send(
              new PutCommand({
                TableName: TABLE,
                Item: entry,
              })
            ),
            ddb.send(
              new UpdateCommand({
                TableName: TABLE,
                Key: { pk: 'META', sk: 'COUNTS' },
                UpdateExpression:
                  'ADD #cf :inc, totalPledgedMillions :pm, bitesTaken :inc',
                ExpressionAttributeNames: { '#cf': counterField },
                ExpressionAttributeValues: {
                  ':inc': 1,
                  ':pm': pledgeMillions,
                },
              })
            ),
          ]);
        } catch {
          // Offline / local Docker fallback
        }
      }

      return respond(200, {
        ok: true,
        entry: {
          id: sk,
          type,
          handle,
          location,
          pledgeMillions,
          pledgeTier,
          needCategory,
          message,
          createdAt: nowIso,
        },
      });
    }

    return respond(404, { error: 'Not found' });
  } catch (err) {
    console.error('Presence/Pledges handler error:', err);
    return respond(500, { error: 'Internal server error' });
  }
}
