import { COOP_PREVIEW_STORAGE_KEY, isCoopDisclosed, resolveCoopMode } from '../game/coop-mode';

/**
 * Facts the privacy, security and AI pages are written from. Keep these true: the pages say only what is
 * here and what the code does. A field left `null` leaves its sentence off the page rather than guessing.
 */
export const trust = {
  /** When the three pages were last revised. */
  updated: '13 November 2026',
  email: 'hello@geurtsgaming.com',
  /**
   * The SOC 2 examination. Fill these in from the report itself: 'Type 1' or 'Type 2', the firm that
   * issued it, and the date or period it covers (for example '1 January to 30 June 2026').
   * Nothing on the site mentions SOC 2 until the auditor and the period are both here (see `soc2Shown`):
   * a claim of an audit has to say whose audit it was and when.
   */
  soc2: {
    type: null as string | null,
    auditor: null as string | null,
    period: null as string | null,
  },
  /**
   * Facts for "Fly with friends" (Co-op), shown on `/privacy/` and `/security/` whenever Co-op is
   * enabled (`playtest` or `on`). Keep these in lockstep with `coop-client.ts`, `coop-lobby.ts`,
   * `coop-flight.ts`, `coop-mode.ts` and `relay/room.mjs`.
   */
  coop: {
    relayHost: 'relay.geurtsgaming.com',
    reconnectGraceSeconds: 30,
    lobbyTimeoutMinutes: 10,
    maxRoomHours: 2,
    /** Exact `sessionStorage` keys/prefixes Co-op uses inside a single browser tab (never `localStorage`). */
    sessionKeys: [
      'gg_coop_invite',
      COOP_PREVIEW_STORAGE_KEY,
      'gg_coop_cid',
      'gg_coop_active',
      'gg_coop_token_',
      'gg_coop_host_state_',
      'gg_coop_host_session',
    ],
  },
} as const;

/** Whether the site may say that GeurtsGaming has a SOC 2 report: only once the report's details are filled in above. */
export const soc2Shown = Boolean(trust.soc2.auditor && trust.soc2.period);

/** Whether Co-op ("Fly with friends") is active (`playtest` or `on`) and disclosed on `/privacy/` & `/security/`. */
export const coopShown = isCoopDisclosed(resolveCoopMode());

export const trustPages = [
  { href: '/privacy/', label: 'Privacy' },
  { href: '/security/', label: 'Security' },
  { href: '/ai/', label: 'AI' },
] as const;
