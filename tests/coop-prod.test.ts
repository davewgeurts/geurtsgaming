import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { INVITE_STORAGE_KEY } from '../src/game/coop-client';
import {
  COOP_PREVIEW_STORAGE_KEY,
  isCoopButtonUnlocked,
  isCoopDisclosed,
  parseCoopModeAttr,
  resolveCoopMode,
} from '../src/game/coop-mode';

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  get size(): number {
    return this.map.size;
  }
}

test('resolveCoopMode defaults to off in production builds, on in dev, and honours off/playtest/on switches', () => {
  assert.equal(resolveCoopMode({ DEV: false }), 'off', 'static prod build defaults to off');
  assert.equal(resolveCoopMode({ DEV: true }), 'on', 'local astro dev defaults to on');

  assert.equal(resolveCoopMode({ DEV: true, PUBLIC_COOP_MODE: 'off' }), 'off');
  assert.equal(resolveCoopMode({ DEV: false, PUBLIC_COOP_MODE: 'playtest' }), 'playtest');
  assert.equal(resolveCoopMode({ DEV: false, PUBLIC_COOP_MODE: 'on' }), 'on');
  assert.equal(resolveCoopMode({ DEV: false, PUBLIC_COOP_MODE: 'true' }), 'on');
  assert.equal(resolveCoopMode({ DEV: false, PUBLIC_COOP_ENABLED: 'true' }), 'on');
  assert.equal(resolveCoopMode({ DEV: true, PUBLIC_COOP_ENABLED: 'false' }), 'off');

  assert.equal(parseCoopModeAttr('on'), 'on');
  assert.equal(parseCoopModeAttr('playtest'), 'playtest');
  assert.equal(parseCoopModeAttr('off'), 'off');
  assert.equal(parseCoopModeAttr(undefined), 'off');

  assert.equal(isCoopDisclosed('off'), false);
  assert.equal(isCoopDisclosed('playtest'), true);
  assert.equal(isCoopDisclosed('on'), true);

  assert.equal(isCoopButtonUnlocked('off', { hasPreviewFlag: true, hasInvite: true }), false);
  assert.equal(isCoopButtonUnlocked('on', {}), true);
  assert.equal(isCoopButtonUnlocked('playtest', {}), false);
  assert.equal(isCoopButtonUnlocked('playtest', { hasPreviewFlag: true }), true);
  assert.equal(isCoopButtonUnlocked('playtest', { hasInvite: true }), true);
  assert.equal(isCoopButtonUnlocked('playtest', { hasSavedSession: true }), true);
});

test('Base.astro early <head> script respects data-coop-mode across off, playtest, and on before Google Analytics', async () => {
  const baseSource = await readFile(new URL('../src/layouts/Base.astro', import.meta.url), 'utf8');
  const match = baseSource.match(/<script is:inline>\s*(\(\(\)\s*=>\s*\{[\s\S]*?\}\)\(\);)\s*<\/script>/);
  assert.ok(match?.[1], 'extracted inline early-strip IIFE from Base.astro');
  const earlyScript = match[1];

  const runEarly = (mode: string, href: string) => {
    const store = new MemoryStorage();
    let replaced = '';
    const win: { __ggInvite?: unknown; __ggCoopPreview?: unknown } = {};
    vm.runInNewContext(earlyScript, {
      URL,
      document: { documentElement: { dataset: { coopMode: mode } } },
      location: { href },
      sessionStorage: store,
      window: win,
      history: {
        state: null,
        replaceState: (_s: unknown, _u: string, url: string) => {
          replaced = url;
        },
      },
    });
    return { store, replaced, win };
  };

  // 1. Mode 'off': strips both ?j= and ?coop=1 before GA and writes NOTHING to sessionStorage!
  const offRes = runEarly('off', 'https://geurtsgaming.com/?j=2YCD44&coop=1');
  assert.equal(offRes.replaced, '/', 'strips j and coop from URL even when Co-op is off');
  assert.equal(offRes.store.size, 0, 'writes zero sessionStorage keys when Co-op is off');
  assert.equal(offRes.win.__ggInvite, undefined);
  assert.equal(offRes.win.__ggCoopPreview, undefined);

  // 2. Mode 'playtest': ?coop=1 unlocks gg_coop_preview and strips ?coop=1; ?j=ABCDEF stashes invite
  const playRes = runEarly('playtest', 'https://geurtsgaming.com/?coop=1');
  assert.equal(playRes.replaced, '/');
  assert.equal(playRes.store.getItem(COOP_PREVIEW_STORAGE_KEY), '1');

  const playJoin = runEarly('playtest', 'https://geurtsgaming.com/?j=2YCD44');
  assert.equal(playJoin.replaced, '/');
  assert.equal(playJoin.store.getItem(INVITE_STORAGE_KEY), '2YCD44');

  // 3. Mode 'on': ?j=ABCDEF stashes invite; ?coop=1 is stripped without needing gg_coop_preview
  const onRes = runEarly('on', 'https://geurtsgaming.com/?j=PRNS6N&coop=1');
  assert.equal(onRes.replaced, '/');
  assert.equal(onRes.store.getItem(INVITE_STORAGE_KEY), 'PRNS6N');
  assert.equal(onRes.store.getItem(COOP_PREVIEW_STORAGE_KEY), null);
});
