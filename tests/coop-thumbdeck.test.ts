import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CoopThumbDeck,
  arenaToClientPoint,
  clientToArenaPoint,
  computeCoopViewportLayout,
} from '../src/game/coop-thumbdeck';
import { COOP_ARENA_HEIGHT, COOP_ARENA_WIDTH } from '../src/game/coop-types';

test('computeCoopViewportLayout reserves bottom 38% on portrait phones and full 3:4 arena on tablets/laptops', () => {
  // Portrait iPhone (390 x 844)
  const phone = computeCoopViewportLayout(390, 844, true);
  assert.equal(phone.useThumbDeck, true);
  assert.equal(phone.deckHeight, Math.round(844 * 0.38));
  assert.ok(Math.abs(phone.arenaRect.w / phone.arenaRect.h - 0.75) < 1e-6, 'exact 3:4 aspect ratio');
  assert.ok(
    phone.arenaRect.y + phone.arenaRect.h <= phone.deckRect.y,
    '3:4 arena sits strictly above the Bottom 38% Thumb Steering Deck with zero overlap',
  );

  // Small portrait phone (320 x 568)
  const smallPhone = computeCoopViewportLayout(320, 568, true);
  assert.equal(smallPhone.useThumbDeck, true);
  assert.ok(smallPhone.arenaRect.w >= 240);
  assert.ok(smallPhone.arenaRect.y + smallPhone.arenaRect.h <= smallPhone.deckRect.y);
  assert.ok(Math.abs(smallPhone.arenaRect.w / smallPhone.arenaRect.h - 0.75) < 1e-6);

  // Portrait iPad (820 x 1180, coarse pointer but >= 600px wide)
  const ipad = computeCoopViewportLayout(820, 1180, true);
  assert.equal(ipad.useThumbDeck, false);
  assert.equal(ipad.deckHeight, 0);
  assert.ok(Math.abs(ipad.arenaRect.w / ipad.arenaRect.h - 0.75) < 1e-6);
  assert.ok(ipad.arenaRect.w > 750);

  // Landscape phone (844 x 390) & Laptop (1440 x 900)
  const landscape = computeCoopViewportLayout(844, 390, true);
  assert.equal(landscape.useThumbDeck, false);
  assert.equal(landscape.deckHeight, 0);

  const laptop = computeCoopViewportLayout(1440, 900, false);
  assert.equal(laptop.useThumbDeck, false);
  assert.equal(laptop.deckHeight, 0);
  assert.ok(Math.abs(laptop.arenaRect.w / laptop.arenaRect.h - 0.75) < 1e-6);

  // Coordinate round-trip between CSS viewport and 768 x 1024 world
  const screenMid = arenaToClientPoint(phone, COOP_ARENA_WIDTH / 2, COOP_ARENA_HEIGHT / 2);
  const backToWorld = clientToArenaPoint(phone, screenMid.x, screenMid.y);
  assert.equal(backToWorld.inside, true);
  assert.ok(Math.abs(backToWorld.x - COOP_ARENA_WIDTH / 2) < 0.01);
  assert.ok(Math.abs(backToWorld.y - COOP_ARENA_HEIGHT / 2) < 0.01);
});

test('CoopThumbDeck drives relative trackpad steering, auto-fire latch, and independent arena taps', () => {
  const layout = computeCoopViewportLayout(390, 844, true);
  const deck = new CoopThumbDeck();
  deck.reset(384, 880);

  assert.equal(deck.state().touching, false);
  assert.equal(deck.state().firing, false);

  // Put thumb down in middle of pad
  const startX = layout.padRect.x + layout.padRect.w / 2;
  const startY = layout.padRect.y + layout.padRect.h / 2;
  assert.equal(deck.onPointerDown(layout, 7, startX, startY), true);
  assert.equal(deck.state().touching, true);
  assert.equal(deck.state().firing, true, 'holding thumb on pad fires automatically');

  // Slide thumb 120px right -> sweeps smoothly to right edge and clamps inside 768px world
  assert.equal(deck.onPointerMove(layout, 7, startX + 120, startY - 40), true);
  assert.ok(deck.state().targetX > 680 && deck.state().targetX <= COOP_ARENA_WIDTH - 22);
  assert.ok(deck.state().targetY < 880 && deck.state().targetY >= 44);

  // Second finger tapping a Sum Boss pod inside top 3:4 arena does NOT steal steering thumb!
  const podClient = arenaToClientPoint(layout, 250, 320);
  assert.equal(deck.onPointerDown(layout, 8, podClient.x, podClient.y), true);
  const tap = deck.consumeArenaTap();
  assert.ok(tap);
  assert.ok(Math.abs(tap.x - 250) < 0.5);
  assert.ok(Math.abs(tap.y - 320) < 0.5);
  assert.equal(deck.state().touching, true, 'steering thumb stays active');

  // Release thumb -> stops firing unless Auto-Fire latch is tapped
  assert.equal(deck.onPointerUp(7), true);
  assert.equal(deck.state().touching, false);
  assert.equal(deck.state().firing, false);

  // Tap Auto-Fire button -> latches firing ON
  const btnX = layout.autoFireBtnRect.x + layout.autoFireBtnRect.w / 2;
  const btnY = layout.autoFireBtnRect.y + layout.autoFireBtnRect.h / 2;
  assert.equal(deck.onPointerDown(layout, 9, btnX, btnY), true);
  assert.equal(deck.state().autoFireLatch, true);
  assert.equal(deck.state().firing, true);
});
