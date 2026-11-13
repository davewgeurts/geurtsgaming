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
} as const;

/** Whether the site may say that GeurtsGaming has a SOC 2 report: only once the report's details are filled in above. */
export const soc2Shown = Boolean(trust.soc2.auditor && trust.soc2.period);

export const trustPages = [
  { href: '/privacy/', label: 'Privacy' },
  { href: '/security/', label: 'Security' },
  { href: '/ai/', label: 'AI' },
] as const;
