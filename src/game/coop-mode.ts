/**
 * Build- and tab-level visibility switch for Co-op ("Fly with friends").
 *
 * Modes (`PUBLIC_COOP_MODE` / `PUBLIC_COOP_ENABLED`):
 * - `'off'` (default in static production builds until switched on):
 *   "Fly with friends" is omitted from HTML, invite/preview params are stripped without writing to
 *   `sessionStorage`, `/privacy/` & `/security/` show solo-only facts, and zero Co-op code runs.
 * - `'playtest'` (Step 4 family playtest on `geurtsgaming.com` before public launch):
 *   `/privacy/` & `/security/` include the Co-op & Cloudflare disclosures (`isCoopDisclosed` is `true`),
 *   ordinary visitors see solo only, and opening `?coop=1` or a `?j=ABCDEF` invite link unlocks
 *   "Fly with friends" for that browser tab only (`sessionStorage['gg_coop_preview']`).
 * - `'on'` (default in `astro dev` locally on `:84`/`:85`, and public production launch):
 *   "Fly with friends" and the Co-op privacy disclosures are visible to everyone, while solo visitors
 *   who press "Play the demo" still download zero Co-op chunks.
 */
export type CoopMode = 'off' | 'playtest' | 'on';

export const COOP_PREVIEW_STORAGE_KEY = 'gg_coop_preview';

export interface CoopEnvLike {
  PUBLIC_COOP_MODE?: unknown;
  PUBLIC_COOP_ENABLED?: unknown;
  DEV?: unknown;
}

function defaultEnv(): CoopEnvLike {
  const metaEnv = (import.meta as ImportMeta & { env?: CoopEnvLike }).env;
  const procEnv = typeof process !== 'undefined' ? process.env : undefined;
  return {
    PUBLIC_COOP_MODE: metaEnv?.PUBLIC_COOP_MODE ?? procEnv?.PUBLIC_COOP_MODE,
    PUBLIC_COOP_ENABLED: metaEnv?.PUBLIC_COOP_ENABLED ?? procEnv?.PUBLIC_COOP_ENABLED,
    DEV: metaEnv?.DEV === true && procEnv?.NODE_ENV !== 'production',
  };
}

export function resolveCoopMode(env?: CoopEnvLike): CoopMode {
  const e = env ?? defaultEnv();

  const raw = typeof e.PUBLIC_COOP_MODE === 'string' ? e.PUBLIC_COOP_MODE.trim().toLowerCase() : '';
  if (raw === 'on' || raw === 'true' || raw === '1') return 'on';
  if (raw === 'playtest' || raw === 'preview') return 'playtest';
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off';

  const legacy = typeof e.PUBLIC_COOP_ENABLED === 'string' ? e.PUBLIC_COOP_ENABLED.trim().toLowerCase() : '';
  if (legacy === 'true' || legacy === '1' || legacy === 'on') return 'on';
  if (legacy === 'playtest' || legacy === 'preview') return 'playtest';
  if (legacy === 'false' || legacy === '0' || legacy === 'off') return 'off';

  return e.DEV === true ? 'on' : 'off';
}

export function parseCoopModeAttr(raw: unknown): CoopMode {
  if (raw === 'on') return 'on';
  if (raw === 'playtest') return 'playtest';
  return 'off';
}

/** Whether `/privacy/` and `/security/` should include Co-op & Cloudflare disclosures. */
export function isCoopDisclosed(mode: CoopMode): boolean {
  return mode !== 'off';
}

/** Whether the "Fly with friends" button should be visible in the current browser tab. */
export function isCoopButtonUnlocked(
  mode: CoopMode,
  tabState?: {
    hasPreviewFlag?: boolean;
    hasInvite?: boolean;
    hasSavedSession?: boolean;
  },
): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return Boolean(tabState?.hasPreviewFlag || tabState?.hasInvite || tabState?.hasSavedSession);
}
