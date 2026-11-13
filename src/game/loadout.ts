/**
 * Pilot loadout: playable low-poly pilot avatars (boys, girls and animals), neon colour themes,
 * and the three Space Pilot School ships parked in the hangar.
 *
 * The player picks once on their first visit; the choice is kept in localStorage (`gg-arcade-loadout`)
 * on this device only and never sent anywhere.
 */
import { MINT, NEON, PINK, SAND } from './core';

export const LOADOUT_KEY = 'gg-arcade-loadout';

export const PILOT_IDS = ['nova', 'leo', 'maya', 'kai', 'fox', 'cat', 'wolf', 'owl'] as const;
export type PilotId = (typeof PILOT_IDS)[number];

export const THEME_IDS = ['starlight', 'cyber', 'solar', 'emerald', 'nebula', 'plasma'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const SHIP_IDS = ['swift', 'starhawk', 'bastion'] as const;
export type ShipId = (typeof SHIP_IDS)[number];

export type HangarHat = 'visor' | 'goggles' | 'puffs' | 'cap' | 'fox' | 'cat' | 'wolf' | 'owl';

export interface PilotSpec {
  readonly id: PilotId;
  readonly name: string;
  readonly tag: string;
  readonly colors: {
    readonly base: string;
    readonly accent: string;
    readonly trim: string;
    readonly face: string;
  };
  readonly hangarHat: HangarHat;
}

export interface ThemeSpec {
  readonly id: ThemeId;
  readonly name: string;
  /** Ship outline, cockpit struts, HUD lives and avatar frame. */
  readonly hull: string;
  /** Engine exhaust flames and lit energy ticks. */
  readonly thruster: string;
  /** Primary cannon bolts (never enemy red or wingmate lime). */
  readonly bolt: string;
  /** Secondary cockpit and UI highlight trim. */
  readonly accent: string;
}

export interface ShipSpec {
  readonly id: ShipId;
  readonly name: string;
  readonly role: string;
  readonly weapon: string;
  readonly baseHull: number;
  readonly speedMul: number;
  readonly hitRadius: number;
  readonly cooldown: number;
  readonly rapidCooldown: number;
  /** 1..5 stat pips shown above each bay in the hangar. */
  readonly bars: {
    readonly armor: number;
    readonly fire: number;
    readonly speed: number;
  };
  /** 3D parking spot in the hangar (metres). */
  readonly bay: {
    readonly x: number;
    readonly z: number;
    readonly face: number;
    /** Which flank the boarding ladder leans against (-1 left, +1 right), chosen to face the camera. */
    readonly ladderSide: -1 | 1;
  };
}

export interface PilotLoadout {
  pilot: PilotId;
  theme: ThemeId;
  ship: ShipId;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PILOTS: readonly PilotSpec[] = [
  {
    id: 'nova',
    name: 'NOVA',
    tag: 'STAR PILOT',
    colors: { base: NEON.cyan, accent: PINK, trim: SAND, face: SAND },
    hangarHat: 'visor',
  },
  {
    id: 'leo',
    name: 'LEO',
    tag: 'STAR PILOT',
    colors: { base: NEON.cyan, accent: NEON.lime, trim: NEON.yellow, face: SAND },
    hangarHat: 'goggles',
  },
  {
    id: 'maya',
    name: 'MAYA',
    tag: 'COMET ACE',
    colors: { base: NEON.violet, accent: NEON.yellow, trim: PINK, face: SAND },
    hangarHat: 'puffs',
  },
  {
    id: 'kai',
    name: 'KAI',
    tag: 'COMET ACE',
    colors: { base: SAND, accent: NEON.orange, trim: NEON.cyan, face: SAND },
    hangarHat: 'cap',
  },
  {
    id: 'fox',
    name: 'RUSTY',
    tag: 'SPACE FOX',
    colors: { base: NEON.orange, accent: SAND, trim: NEON.yellow, face: SAND },
    hangarHat: 'fox',
  },
  {
    id: 'cat',
    name: 'MOCHI',
    tag: 'STAR CAT',
    colors: { base: NEON.violet, accent: PINK, trim: MINT, face: SAND },
    hangarHat: 'cat',
  },
  {
    id: 'wolf',
    name: 'REX',
    tag: 'ASTRO PUP',
    colors: { base: NEON.cyan, accent: NEON.yellow, trim: SAND, face: SAND },
    hangarHat: 'wolf',
  },
  {
    id: 'owl',
    name: 'PIP',
    tag: 'SKY OWL',
    colors: { base: MINT, accent: NEON.yellow, trim: NEON.cyan, face: SAND },
    hangarHat: 'owl',
  },
] as const;

/**
 * Six hull/thruster/trim themes. Every hull stays well clear of enemy hulls (`PINK`, `LILAC`, `AMBER`, `ROSE`),
 * boss arms/shots (`NEON.lime`, `NEON.yellow`, `NEON.orange`, `NEON.violet`), mines (`NEON.red`) and rocks (`ROCK`),
 * and primary cannon bolts stay `SAND` across every theme so friendly fire never looks like a hostile shot.
 */
export const THEMES: readonly ThemeSpec[] = [
  {
    id: 'starlight',
    name: 'STARLIGHT',
    hull: SAND,
    thruster: PINK,
    bolt: SAND,
    accent: NEON.cyan,
  },
  {
    id: 'cyber',
    name: 'CYBER CYAN',
    hull: NEON.cyan,
    thruster: PINK,
    bolt: SAND,
    accent: MINT,
  },
  {
    id: 'solar',
    name: 'SUNGLOW',
    hull: '#fff099',
    thruster: NEON.orange,
    bolt: SAND,
    accent: NEON.cyan,
  },
  {
    id: 'emerald',
    name: 'JADE MINT',
    hull: MINT,
    thruster: NEON.cyan,
    bolt: SAND,
    accent: '#fff099',
  },
  {
    id: 'nebula',
    name: 'SKYLINE',
    hull: '#4da6ff',
    thruster: NEON.cyan,
    bolt: SAND,
    accent: MINT,
  },
  {
    id: 'plasma',
    name: 'AURORA',
    hull: '#2ee6d6',
    thruster: NEON.yellow,
    bolt: SAND,
    accent: '#4da6ff',
  },
] as const;

export const SHIPS: readonly ShipSpec[] = [
  {
    id: 'swift',
    name: 'SWIFT',
    role: 'FAST · LIGHT',
    weapon: 'TWIN RAPID',
    baseHull: 2,
    speedMul: 1.2,
    hitRadius: 8,
    cooldown: 0.13,
    rapidCooldown: 0.088,
    bars: { armor: 2, fire: 3, speed: 5 },
    bay: { x: -6.8, z: 15.2, face: 0.1, ladderSide: 1 },
  },
  {
    id: 'starhawk',
    name: 'STARHAWK',
    role: 'BALANCED',
    weapon: 'TRI-CANNON',
    baseHull: 3,
    speedMul: 1,
    hitRadius: 9,
    cooldown: 0.17,
    rapidCooldown: 0.11,
    bars: { armor: 3, fire: 3, speed: 3 },
    bay: { x: 0, z: 13, face: 0, ladderSide: -1 },
  },
  {
    id: 'bastion',
    name: 'BASTION',
    role: 'HEAVY ARMOR',
    weapon: 'HEAVY PIERCE',
    baseHull: 4,
    speedMul: 0.88,
    hitRadius: 9.5,
    cooldown: 0.23,
    rapidCooldown: 0.15,
    bars: { armor: 5, fire: 4, speed: 2 },
    bay: { x: 6.8, z: 15.2, face: -0.1, ladderSide: -1 },
  },
] as const;

export const PILOT_BY_ID: Record<PilotId, PilotSpec> = Object.fromEntries(
  PILOTS.map((p) => [p.id, p]),
) as Record<PilotId, PilotSpec>;

export const THEME_BY_ID: Record<ThemeId, ThemeSpec> = Object.fromEntries(
  THEMES.map((t) => [t.id, t]),
) as Record<ThemeId, ThemeSpec>;

export const SHIP_BY_ID: Record<ShipId, ShipSpec> = Object.fromEntries(
  SHIPS.map((s) => [s.id, s]),
) as Record<ShipId, ShipSpec>;

export const DEFAULT_LOADOUT: Readonly<PilotLoadout> = {
  pilot: 'nova',
  theme: 'starlight',
  ship: 'starhawk',
};

export function isPilotId(v: unknown): v is PilotId {
  return typeof v === 'string' && (PILOT_IDS as readonly string[]).includes(v);
}

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}

export function isShipId(v: unknown): v is ShipId {
  return typeof v === 'string' && (SHIP_IDS as readonly string[]).includes(v);
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Read a previously saved loadout from localStorage, or null if the player has not picked yet. */
export function loadSavedLoadout(storage: StorageLike | null = defaultStorage()): PilotLoadout | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LOADOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!isPilotId(parsed.pilot) || !isThemeId(parsed.theme) || !isShipId(parsed.ship)) {
      return null;
    }
    return {
      pilot: parsed.pilot,
      theme: parsed.theme,
      ship: parsed.ship,
    };
  } catch {
    return null;
  }
}

/** Save the player's chosen avatar, colour theme and ship locally so they only have to pick once. */
export function saveLoadout(
  loadout: PilotLoadout,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      LOADOUT_KEY,
      JSON.stringify({
        v: 1,
        pilot: loadout.pilot,
        theme: loadout.theme,
        ship: loadout.ship,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
