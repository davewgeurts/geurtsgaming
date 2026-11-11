/**
 * The ten upgrades a pilot can earn. Flying into an upgrade capsule asks a question; a right answer
 * offers three of these to choose from. An upgrade lasts until the game is over, and each can be owned once.
 *
 * This file is the catalogue: names, the line that explains each one, and its icon.
 * What each upgrade actually does lives in game.ts, next to the thing it changes.
 */
import { closed, ngon, open, type Shape } from './shapes';

export type UpgradeId =
  | 'rapid' | 'pierce' | 'wide' | 'lance'
  | 'rockets' | 'nova'
  | 'wingmates' | 'guardian'
  | 'shield' | 'armour';

export interface Upgrade {
  id: UpgradeId;
  /** Which family it belongs to. An offer tries to show three different families. */
  family: 'LASER' | 'BOMB' | 'FRIEND' | 'SHIP';
  name: string;
  /** One short line, in the stroke font's upper case, that fits a phone screen. */
  blurb: string;
  /** Line art that fits a 24 px box. */
  icon: Shape;
}

export const UPGRADES: readonly Upgrade[] = [
  {
    id: 'rapid', family: 'LASER', name: 'RAPID FIRE', blurb: 'CANNONS FIRE MUCH FASTER',
    icon: [open([-7, -4], [0, -11], [7, -4]), open([-7, 3], [0, -4], [7, 3]), open([-7, 10], [0, 3], [7, 10])],
  },
  {
    id: 'pierce', family: 'LASER', name: 'PIERCING LASER', blurb: 'SHOTS GO RIGHT THROUGH',
    icon: [open([0, 11], [0, -11]), open([-3, -7], [0, -11], [3, -7]), closed([0, -5], [5, 0], [0, 5], [-5, 0])],
  },
  {
    id: 'wide', family: 'LASER', name: 'WIDE LASER', blurb: 'TWO MORE SHOTS OUT WIDE',
    icon: [open([0, 10], [0, -10]), open([0, 10], [-7, -8]), open([0, 10], [7, -8]), open([0, 10], [-11, -2]), open([0, 10], [11, -2])],
  },
  {
    id: 'lance', family: 'LASER', name: 'LANCE BEAM', blurb: 'A BIG BEAM EVERY 3 SECONDS',
    icon: [closed([-2, -11], [2, -11], [2, 8], [-2, 8]), open([-8, 8], [8, 8]), open([-5, -3], [-9, -7]), open([5, -3], [9, -7]), open([-5, 3], [-9, 1]), open([5, 3], [9, 1])],
  },
  {
    id: 'rockets', family: 'BOMB', name: 'SEEKER ROCKETS', blurb: 'ROCKETS THAT HUNT ENEMIES',
    icon: [closed([0, -11], [4, -4], [4, 5], [-4, 5], [-4, -4]), open([-4, 1], [-8, 8], [-4, 5]), open([4, 1], [8, 8], [4, 5]), open([-2, 5], [0, 11], [2, 5])],
  },
  {
    id: 'nova', family: 'BOMB', name: 'NOVA BOMB', blurb: 'A BLAST RING EVERY 9 SECONDS',
    icon: [closed(...ngon(8, 4)), closed(...ngon(8, 8, Math.PI / 8)), closed(...ngon(8, 11.5))],
  },
  {
    id: 'wingmates', family: 'FRIEND', name: 'WINGMATES', blurb: 'TWO FRIENDS FLY AND FIRE',
    icon: [closed([-6, -8], [-2, 5], [-6, 2], [-10, 5]), closed([6, -8], [10, 5], [6, 2], [2, 5]), open([-6, 5], [-6, 9]), open([6, 5], [6, 9])],
  },
  {
    id: 'guardian', family: 'FRIEND', name: 'GUARDIAN', blurb: 'A FRIEND WHO BLOCKS SHOTS',
    icon: [closed(...ngon(12, 10.5)), closed([0, -5], [4, 4], [-4, 4]), closed([10.5, -3.5], [14, 0], [10.5, 3.5], [7, 0])],
  },
  {
    id: 'shield', family: 'SHIP', name: 'SHIELD', blurb: 'SOAKS UP A HIT. RECHARGES',
    icon: [closed([0, -11], [9, -7], [9, 2], [0, 11], [-9, 2], [-9, -7]), open([0, -6], [0, 6])],
  },
  {
    id: 'armour', family: 'SHIP', name: 'ARMOUR', blurb: 'ONE MORE HULL POINT',
    icon: [closed(...ngon(6, 11, Math.PI / 6)), open([-5, 0], [5, 0]), open([0, -5], [0, 5])],
  },
];

/** Up to `count` upgrades the pilot does not own yet, from different families where possible. */
export function offerUpgrades(owned: ReadonlySet<UpgradeId>, count = 3): Upgrade[] {
  const pool = UPGRADES.filter((u) => !owned.has(u.id));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const picked: Upgrade[] = [];
  // First pass takes one per family; a second pass fills any places still empty.
  for (const u of pool) if (picked.length < count && !picked.some((p) => p.family === u.family)) picked.push(u);
  for (const u of pool) if (picked.length < count && !picked.includes(u)) picked.push(u);
  return picked;
}
