/** Showcase data integrity, on-disk asset verification, and mini-game state unit tests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EARL_LOGO,
  EARL_HERO_KEY_ART,
  EARL_HERO_BANNER,
  FALLING_STATE_LOGO,
  EARL_ACTION_GIF,
  STEAM_COMBOS_VIDEO,
  STEAM_CARNAGE_VIDEO,
  EARL_BIOMES,
  MUTANT_BOSSES,
  EARL_POSES,
  EDNA_POSES,
  BANTER_SCENARIOS,
  RIG_WEAPONS,
  RIG_DRONES,
  RIG_POWERUPS,
  WASTELAND_SHOTS,
  strikeBoss,
  computeRigSynergy,
} from '../src/data/earl-showcase';
import {
  CTG_BIG_LOGO,
  CTG_SMALL_LOGO,
  CTG_ROBOT_LOGO,
  CTG_ROBOT_HEAD,
  CTG_HERO_VIDEO,
  CTG_CATEGORIES,
  CTG_RACERS,
  CTG_FISH_HEROES,
  CTG_GAMES,
  DASH_PROMPTS,
  createDashState,
  pressDashKey,
  computeDashStats,
  filterCtgGames,
} from '../src/data/ctg-showcase';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repoRoot, 'public');

function assertPublicAsset(webPath: string, expectedPrefix: string): void {
  assert.ok(
    webPath.startsWith(expectedPrefix),
    `Expected ${webPath} to start with ${expectedPrefix}`,
  );
  const diskPath = path.join(publicDir, webPath.slice(1));
  assert.ok(fs.existsSync(diskPath), `Missing public asset on disk: ${webPath}`);
  const stat = fs.statSync(diskPath);
  assert.ok(stat.isFile() && stat.size > 0, `Empty or non-file asset: ${webPath}`);

  const fd = fs.openSync(diskPath, 'r');
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);

  if (webPath.endsWith('.png')) {
    assert.equal(head.subarray(0, 4).toString('hex'), '89504e47', `Invalid PNG header: ${webPath}`);
  } else if (webPath.endsWith('.gif')) {
    assert.equal(head.subarray(0, 4).toString('ascii'), 'GIF8', `Invalid GIF header: ${webPath}`);
  } else if (webPath.endsWith('.webm')) {
    assert.equal(head.subarray(0, 4).toString('hex'), '1a45dfa3', `Invalid WebM header: ${webPath}`);
  } else if (webPath.endsWith('.mp4')) {
    assert.equal(head.subarray(4, 8).toString('ascii'), 'ftyp', `Invalid MP4 header: ${webPath}`);
  }
}

test('Earl vs. The Mutants showcase references only existing self-hosted assets', () => {
  const prefix = '/games/earl-vs-the-mutants/';
  for (const single of [
    EARL_LOGO,
    EARL_HERO_KEY_ART,
    EARL_HERO_BANNER,
    FALLING_STATE_LOGO,
    EARL_ACTION_GIF,
    STEAM_COMBOS_VIDEO,
    STEAM_CARNAGE_VIDEO,
  ]) {
    assertPublicAsset(single, prefix);
  }

  assert.equal(EARL_BIOMES.length, 3);
  for (const biome of EARL_BIOMES) {
    assertPublicAsset(biome.video, prefix);
    assertPublicAsset(biome.poster, prefix);
    assert.ok(biome.overdriveMph > biome.cruiseMph, biome.id);
  }

  assert.equal(MUTANT_BOSSES.length, 5);
  for (const boss of MUTANT_BOSSES) {
    assertPublicAsset(boss.normalImg, prefix);
    assertPublicAsset(boss.laughingImg, prefix);
    assertPublicAsset(boss.angryImg, prefix);
    assert.ok(boss.bounty > 0 && boss.maxHp >= 500, boss.id);
  }

  assert.equal(EARL_POSES.length, 9);
  for (const pose of EARL_POSES) assertPublicAsset(pose.img, prefix);

  assert.equal(EDNA_POSES.length, 4);
  for (const pose of EDNA_POSES) assertPublicAsset(pose.img, prefix);

  for (const sc of BANTER_SCENARIOS) {
    assert.ok(EARL_POSES.some((p) => p.id === sc.earlPoseId), `Unknown Earl pose ${sc.earlPoseId}`);
    assert.ok(EDNA_POSES.some((p) => p.id === sc.ednaPoseId), `Unknown Edna pose ${sc.ednaPoseId}`);
  }

  assert.equal(WASTELAND_SHOTS.length, 7);
  for (const shot of WASTELAND_SHOTS) assertPublicAsset(shot.src, prefix);
});

test('Cool Typing Games showcase references only existing self-hosted assets', () => {
  const prefix = '/games/cool-typing-games/';
  for (const single of [CTG_BIG_LOGO, CTG_SMALL_LOGO, CTG_ROBOT_LOGO, CTG_ROBOT_HEAD, CTG_HERO_VIDEO]) {
    assertPublicAsset(single, prefix);
  }

  assert.equal(CTG_RACERS.length, 8);
  for (const racer of CTG_RACERS) {
    assertPublicAsset(racer.img, prefix);
    assert.equal(racer.likes.length, 2);
    assert.equal(racer.dislikes.length, 2);
  }

  assert.equal(CTG_FISH_HEROES.length, 3);
  for (const fish of CTG_FISH_HEROES) assertPublicAsset(fish.img, prefix);

  assert.equal(CTG_GAMES.length, 10);
  for (const game of CTG_GAMES) {
    assertPublicAsset(game.cardImg, prefix);
    assertPublicAsset(game.bgImg, prefix);
    assert.ok(game.categories.length >= 1, game.id);
  }
});

test('Mutant Boss Bounty Arena strikeBoss mechanics clamp HP and handle crits cleanly', () => {
  const normalHit = strikeBoss(1000, 1000, 0.25);
  assert.equal(normalHit.crit, false);
  assert.ok(normalHit.damage >= 200 && normalHit.damage <= 320);
  assert.equal(normalHit.nextHp, 1000 - normalHit.damage);
  assert.equal(normalHit.defeated, false);

  const critHit = strikeBoss(1000, 1000, 0.85);
  assert.equal(critHit.crit, true);
  assert.ok(critHit.damage > normalHit.damage);

  for (const boss of MUTANT_BOSSES) {
    let hp = boss.maxHp;
    let swings = 0;
    while (hp > 0 && swings < 10) {
      const step = strikeBoss(hp, boss.maxHp, 0.5);
      hp = step.nextHp;
      swings += 1;
    }
    assert.equal(hp, 0, `${boss.id} should be defeated within 10 strikes`);
    assert.ok(swings >= 2 && swings <= 6, `${boss.id} took ${swings} strikes`);
  }

  const deadAlready = strikeBoss(0, 1000, 0.9);
  assert.deepEqual(deadAlready, { nextHp: 0, damage: 0, crit: false, defeated: true });
});

test('Roguelite rig tinkerer computes bounded 0-100 stats across all 64 part combinations', () => {
  for (const w of RIG_WEAPONS) {
    for (const d of RIG_DRONES) {
      for (const p of RIG_POWERUPS) {
        const syn = computeRigSynergy(w.id, d.id, p.id);
        assert.ok(syn.chaos > 0 && syn.chaos <= 100);
        assert.ok(syn.swarm > 0 && syn.swarm <= 100);
        assert.ok(syn.bossMelt > 0 && syn.bossMelt <= 100);
        assert.ok(syn.title.length > 6);
        assert.ok(syn.summary.includes(w.perk));
        assert.ok(syn.clip === STEAM_COMBOS_VIDEO || syn.clip === STEAM_CARNAGE_VIDEO);
      }
    }
  }
});

test('Turbo WPM Dash typing mechanics, typo handling, WPM medals, and 10-game filters', () => {
  for (const prompt of DASH_PROMPTS) {
    assert.match(prompt, /^[A-Z]+( [A-Z]+)*$/, prompt);
  }

  let state = createDashState('GO BOT');
  // Non-letter keys are ignored without starting timer
  const ignored = pressDashKey(state, 'Shift', 1000);
  assert.equal(ignored.state, state);
  assert.equal(state.startedAtMs, null);

  // Lowercase letter matches uppercase prompt and starts timer
  let step = pressDashKey(state, 'g', 1000);
  assert.equal(step.hit, true);
  state = step.state;
  assert.equal(state.index, 1);
  assert.equal(state.startedAtMs, 1000);

  // Typo increments mistakes and resets streak without advancing index
  step = pressDashKey(state, 'x', 1200);
  assert.equal(step.hit, false);
  state = step.state;
  assert.equal(state.index, 1);
  assert.equal(state.mistakes, 1);
  assert.equal(state.streak, 0);

  // Type remaining characters fast for high WPM
  let t = 1400;
  for (const ch of 'O BOT') {
    step = pressDashKey(state, ch, t);
    state = step.state;
    t += 180;
  }
  assert.equal(step.completedNow, true);
  assert.ok(state.finishedAtMs !== null);
  assert.equal(state.bestStreak, 5);

  const stats = computeDashStats(state, t);
  assert.equal(stats.progressPct, 100);
  assert.equal(stats.accuracyPct, Math.round((6 / 7) * 100));
  assert.ok(stats.wpm >= 35);
  assert.equal(stats.medal, 'silver'); // 86% accuracy (<92% gold threshold) -> silver!

  // Clean gold run
  let goldState = createDashState('TURBO BOOST');
  let gt = 0;
  for (const ch of 'TURBO BOOST') {
    goldState = pressDashKey(goldState, ch, gt).state;
    gt += 160;
  }
  const goldStats = computeDashStats(goldState, gt);
  assert.equal(goldStats.accuracyPct, 100);
  assert.equal(goldStats.medal, 'gold');

  // Category filters cover all 10 games
  assert.equal(filterCtgGames('all').length, 10);
  for (const cat of CTG_CATEGORIES) {
    const catId = cat.id;
    const list = filterCtgGames(catId);
    assert.ok(list.length >= 2, `Category ${catId} should have games`);
    if (catId !== 'all') {
      assert.ok(list.every((g) => g.categories.includes(catId)));
    }
  }
});
