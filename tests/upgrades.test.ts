/** The ten ship upgrades, and how three are offered at a time. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UPGRADES, offerUpgrades } from '../src/game/upgrades';

test('there are ten different upgrades, with text short enough for a phone', () => {
  assert.equal(UPGRADES.length, 10);
  assert.equal(new Set(UPGRADES.map((u) => u.id)).size, 10);
  for (const u of UPGRADES) assert.ok(u.name.length <= 14 && u.blurb.length <= 28, u.name);
});

test('an offer is three upgrades from three families, never one already owned', () => {
  for (let i = 0; i < 500; i++) {
    const offer = offerUpgrades(new Set());
    assert.equal(offer.length, 3);
    assert.equal(new Set(offer.map((u) => u.family)).size, 3);
  }
  const owned = new Set(UPGRADES.slice(0, 8).map((u) => u.id));
  const rest = offerUpgrades(owned);
  assert.equal(rest.length, 2);
  assert.ok(rest.every((u) => !owned.has(u.id)));
  assert.equal(offerUpgrades(new Set(UPGRADES.map((u) => u.id))).length, 0, 'nothing to offer once all are owned');
});
