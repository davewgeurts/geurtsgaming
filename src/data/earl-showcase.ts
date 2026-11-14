/**
 * Structured content and pure mini-game state helpers for `/games/earl-vs-the-mutants/`.
 * Kept free of Astro runtime imports so Node unit tests can verify every asset path and mechanic directly.
 */

export interface EarlBiome {
  id: 'desert' | 'tundra' | 'night';
  gearLabel: string;
  name: string;
  hazard: string;
  cruiseMph: number;
  overdriveMph: number;
  video: string;
  poster: string;
  blurb: string;
}

export interface MutantBoss {
  id: string;
  name: string;
  title: string;
  bounty: number;
  maxHp: number;
  weakness: string;
  taunt: string;
  defeatedLine: string;
  normalImg: string;
  laughingImg: string;
  angryImg: string;
  accent: string;
}

export interface CharacterPose {
  id: string;
  label: string;
  img: string;
}

export interface BanterScenario {
  id: string;
  buttonLabel: string;
  earlPoseId: string;
  ednaPoseId: string;
  ednaLine: string;
  earlLine: string;
}

export interface RigPart {
  id: string;
  name: string;
  perk: string;
  chaos: number;
  swarm: number;
  bossMelt: number;
}

export interface WastelandShot {
  src: string;
  alt: string;
  caption: string;
}

export const STEAM_URL = 'https://store.steampowered.com/app/2292010/Earl_vs_the_Mutants/';
export const TRAILER_URL = 'https://www.youtube.com/watch?v=Lbp3IPHTo4U';
export const DISCORD_URL = 'https://discord.gg/bfGwFRfeat';

export const EARL_LOGO = '/games/earl-vs-the-mutants/evtm_logo.png';
export const EARL_HERO_KEY_ART = '/games/earl-vs-the-mutants/evtm_hero_with_logo.png';
export const EARL_HERO_BANNER = '/games/earl-vs-the-mutants/hero_banner.png';
export const FALLING_STATE_LOGO = '/games/earl-vs-the-mutants/falling_state_logo.png';
export const EARL_ACTION_GIF = '/games/earl-vs-the-mutants/videos/earl-action-2.gif';
export const STEAM_COMBOS_VIDEO = '/games/earl-vs-the-mutants/videos/steam-combos.mp4';
export const STEAM_CARNAGE_VIDEO = '/games/earl-vs-the-mutants/videos/steam-carnage.mp4';

export const EARL_BIOMES: readonly EarlBiome[] = [
  {
    id: 'desert',
    gearLabel: 'Gear 1 · Scorched Badlands',
    name: 'Red-Dust Canyon',
    hazard: 'Fire-ant swarms & cultist ambushes',
    cruiseMph: 46,
    overdriveMph: 98,
    video: '/games/earl-vs-the-mutants/videos/gameplay-wasteland.webm',
    poster: '/games/earl-vs-the-mutants/screenshots/press_01.png',
    blurb: 'Catch air off red-rock ridges, drift into 200-strong mutant packs, and let roof turrets paint the canyon.',
  },
  {
    id: 'tundra',
    gearLabel: 'Gear 2 · Slime Tundra',
    name: 'Sub-Zero Pines',
    hazard: 'Giant bouncing cryo-slimes & black ice',
    cruiseMph: 52,
    overdriveMph: 104,
    video: '/games/earl-vs-the-mutants/videos/gameplay-snow-slime.webm',
    poster: '/games/earl-vs-the-mutants/screenshots/press_03.png',
    blurb: 'Swing spiked wrecking balls across frozen logging roads while towering blue slimes rain from the treeline.',
  },
  {
    id: 'night',
    gearLabel: 'Gear 3 · Deadwood Highway',
    name: 'Midnight Blacktop',
    hazard: 'High-beam ambushes & elevation drops',
    cruiseMph: 58,
    overdriveMph: 112,
    video: '/games/earl-vs-the-mutants/videos/gameplay-night-road.webm',
    poster: '/games/earl-vs-the-mutants/screenshots/press_05.png',
    blurb: 'High beams on, pedal buried. Thread narrow forest switchbacks and turn roadblocks into scrap.',
  },
] as const;

export const MUTANT_BOSSES: readonly MutantBoss[] = [
  {
    id: 'skeleton',
    name: 'Bone-Horn Overlord',
    title: 'Warchief of the Crater',
    bounty: 900,
    maxHp: 1400,
    weakness: 'High-speed bumper rams + explosive shells',
    taunt: 'Your rusted pest-van makes a crunchy toothpick, Earl!',
    defeatedLine: 'Ribcage rattled into spare parts! Edna already cashed the check.',
    normalImg: '/games/earl-vs-the-mutants/bosses/skeleton_normal.png',
    laughingImg: '/games/earl-vs-the-mutants/bosses/skeleton_laughing.png',
    angryImg: '/games/earl-vs-the-mutants/bosses/skeleton_angry.png',
    accent: '#ff5d47',
  },
  {
    id: 'hellbilly',
    name: 'Two-Headed Hellbilly',
    title: 'Backwoods Bruiser',
    bounty: 700,
    maxHp: 1150,
    weakness: 'Kiting drifts & twin attack drones',
    taunt: 'Three eyes, two mouths, and zero respect for traffic laws!',
    defeatedLine: 'Both heads agree: getting run over by Edna’s truck hurts.',
    normalImg: '/games/earl-vs-the-mutants/bosses/hellbilly_normal.png',
    laughingImg: '/games/earl-vs-the-mutants/bosses/hellbilly_laughing.png',
    angryImg: '/games/earl-vs-the-mutants/bosses/hellbilly_angry.png',
    accent: '#63e884',
  },
  {
    id: 'slime',
    name: 'Chairman Ooze',
    title: 'Toxic Meltdown',
    bounty: 650,
    maxHp: 1050,
    weakness: 'Flamethrowers & wide-arc shockwaves',
    taunt: 'Step into my office—watch your boots on the radioactive puddles!',
    defeatedLine: 'Mopped up cleanly! Hazard surcharge billed to the wasteland.',
    normalImg: '/games/earl-vs-the-mutants/bosses/slime_normal.png',
    laughingImg: '/games/earl-vs-the-mutants/bosses/slime_laughing.png',
    angryImg: '/games/earl-vs-the-mutants/bosses/slime_angry.png',
    accent: '#b6f22c',
  },
  {
    id: 'cultist',
    name: 'Grand Cultist',
    title: 'Herald of the Glow',
    bounty: 600,
    maxHp: 950,
    weakness: 'Interrupting rituals with nitro boosts',
    taunt: 'Behold the sacred fallout! Wait—why do I hear a horn?!',
    defeatedLine: 'Chant cancelled! Pest Control waits for nobody.',
    normalImg: '/games/earl-vs-the-mutants/bosses/cultist_normal.png',
    laughingImg: '/games/earl-vs-the-mutants/bosses/cultist_laughing.png',
    angryImg: '/games/earl-vs-the-mutants/bosses/cultist_angry.png',
    accent: '#c76bff',
  },
  {
    id: 'lake',
    name: 'Lagoon Gill-Beast',
    title: 'Terror of Sump Creek',
    bounty: 650,
    maxHp: 1100,
    weakness: 'High-ground elevation & lightning coils',
    taunt: 'Drive near the shoreline, exterminator—I dare ya!',
    defeatedLine: 'Sent straight back to the murky depths!',
    normalImg: '/games/earl-vs-the-mutants/bosses/lake_normal.png',
    laughingImg: '/games/earl-vs-the-mutants/bosses/lake_laughing.png',
    angryImg: '/games/earl-vs-the-mutants/bosses/lake_angry.png',
    accent: '#3be7ff',
  },
] as const;

export const EARL_POSES: readonly CharacterPose[] = [
  { id: 'normal', label: 'Clocked In', img: '/games/earl-vs-the-mutants/poses/earl_normal.png' },
  { id: 'determined', label: 'Locked On', img: '/games/earl-vs-the-mutants/poses/earl_determined.png' },
  { id: 'godmode', label: 'God Mode!', img: '/games/earl-vs-the-mutants/poses/earl_godmode.png' },
  { id: 'laughing', label: 'Swarm Cleared', img: '/games/earl-vs-the-mutants/poses/earl_laughing.png' },
  { id: 'smile', label: '37× Winner', img: '/games/earl-vs-the-mutants/poses/earl_smile.png' },
  { id: 'surprised', label: 'Boss Incoming!', img: '/games/earl-vs-the-mutants/poses/earl_surprised.png' },
  { id: 'scared', label: 'Low Fuel?!', img: '/games/earl-vs-the-mutants/poses/earl_scared.png' },
  { id: 'sad', label: 'Paycheck Docked', img: '/games/earl-vs-the-mutants/poses/earl_sad.png' },
  { id: 'crying', label: 'Truck Scratched', img: '/games/earl-vs-the-mutants/poses/earl_crying.png' },
] as const;

export const EDNA_POSES: readonly CharacterPose[] = [
  { id: 'smile', label: 'Sweet Boss', img: '/games/earl-vs-the-mutants/poses/edna_smile.png' },
  { id: 'normal', label: 'Strictly Business', img: '/games/earl-vs-the-mutants/poses/edna_normal.png' },
  { id: 'onery', label: 'Counting Cash', img: '/games/earl-vs-the-mutants/poses/edna_onery.png' },
  { id: 'open_mouth', label: 'Radio Dispatch!', img: '/games/earl-vs-the-mutants/poses/edna_open_mouth.png' },
] as const;

export const BANTER_SCENARIOS: readonly BanterScenario[] = [
  {
    id: 'eotm',
    buttonLabel: '🏆 37× Employee of the Month',
    earlPoseId: 'smile',
    ednaPoseId: 'smile',
    ednaLine: 'Thirty-seven plaques on the wall, sugar! Granted, you ARE my only employee left standing.',
    earlLine: 'Thirty-seven and counting, ma’am. Just point the bumper toward the next crater.',
  },
  {
    id: 'godmode',
    buttonLabel: '🔥 Unstoppable Combo Build',
    earlPoseId: 'godmode',
    ednaPoseId: 'open_mouth',
    ednaLine: 'Sweet mercy, Earl—did you weld TWO flamethrowers and a saw-drone onto company property?!',
    earlLine: 'TESTED AND APPROVED! Nothing with tentacles gets within fifty yards!',
  },
  {
    id: 'ambush',
    buttonLabel: '☢️ Boss Ambush!',
    earlPoseId: 'surprised',
    ednaPoseId: 'normal',
    ednaLine: 'Eyes on the ridge! That skull-horned freak isn’t covered by basic liability!',
    earlLine: 'Whoa nelly—hang onto your slippers, Edna, we’re hitting the ramp!',
  },
  {
    id: 'payday',
    buttonLabel: '💸 Edna’s Cut',
    earlPoseId: 'sad',
    ednaPoseId: 'onery',
    ednaLine: 'Ninety percent goes to Edna’s Pest Control R&D, fuel, and slipper maintenance. Fair’s fair!',
    earlLine: '...Wait a second, I’m the one driving through radioactive slime!',
  },
  {
    id: 'dent',
    buttonLabel: '🔧 Fender Scratched',
    earlPoseId: 'crying',
    ednaPoseId: 'open_mouth',
    ednaLine: 'THAT COMES OUTTA YOUR BONUS, MISTER! Buff it out on the next horde!',
    earlLine: 'Not the fresh flame decal! Those hellbillies are gonna pay for that!',
  },
  {
    id: 'victory',
    buttonLabel: '🎯 Sector Cleared',
    earlPoseId: 'laughing',
    ednaPoseId: 'smile',
    ednaLine: 'Clean sweep in eight minutes flat! Load up—next county’s paying double.',
    earlLine: 'Ha! Best pest control gig in the apocalypse.',
  },
] as const;

export const RIG_WEAPONS: readonly RigPart[] = [
  { id: 'twin-vulcan', name: 'Twin Roof Vulcan', perk: '360° lead curtain while drifting', chaos: 28, swarm: 32, bossMelt: 26 },
  { id: 'napalm-arc', name: 'Scorcher Projector', perk: 'Leaves blazing wasteland tire trails', chaos: 35, swarm: 36, bossMelt: 22 },
  { id: 'wrecking-flail', name: 'Spiked Tow-Flail', perk: 'Physics-driven bumper carnage on turns', chaos: 38, swarm: 34, bossMelt: 30 },
  { id: 'rail-cannon', name: 'Crater Rail-Slug', perk: 'Pierces armored boss skulls clean through', chaos: 26, swarm: 22, bossMelt: 40 },
] as const;

export const RIG_DRONES: readonly RigPart[] = [
  { id: 'buzzsaw', name: 'Orbiting Saw-Drone', perk: 'Shreds anything hugging your doors', chaos: 30, swarm: 34, bossMelt: 24 },
  { id: 'tesla', name: 'Arc-Zap Sentinel', perk: 'Chains lightning across 8 mutants at once', chaos: 32, swarm: 36, bossMelt: 26 },
  { id: 'mortar', name: 'Thumper Hound', perk: 'Lobs high-arc shells over 3D hills', chaos: 34, swarm: 28, bossMelt: 34 },
  { id: 'medic', name: 'Scrap-Welder Bot', perk: 'Vacuums salvage & patches armor mid-run', chaos: 18, swarm: 24, bossMelt: 28 },
] as const;

export const RIG_POWERUPS: readonly RigPart[] = [
  { id: 'nitro-shock', name: 'Afterburner Shockwave', perk: 'Every boost blasts nearby tribes airborne', chaos: 34, swarm: 32, bossMelt: 26 },
  { id: 'ricochet', name: ' Uranium Ricochet', perk: 'Shots bounce twice between mutant heads', chaos: 30, swarm: 34, bossMelt: 30 },
  { id: 'cryo-slick', name: 'Sub-Zero Coolant Leak', perk: 'Freezes pursuers solid for shatter crits', chaos: 28, swarm: 30, bossMelt: 34 },
  { id: 'overclock', name: 'Edna’s Double-Shift', perk: '+45% fire rate during kill streaks', chaos: 32, swarm: 30, bossMelt: 36 },
] as const;

export const WASTELAND_SHOTS: readonly WastelandShot[] = [
  {
    src: '/games/earl-vs-the-mutants/screenshots/press_07_commercial.png',
    alt: 'Edna’s Pest Control retro TV commercial intro frame',
    caption: 'Edna’s Pest Control: open for business even after civilization ends.',
  },
  {
    src: '/games/earl-vs-the-mutants/screenshots/press_01.png',
    alt: 'Earl drifting through a desert canyon blasting mutant hordes',
    caption: 'High-octane 5–10 minute survival runs across 3D desert ridges.',
  },
  {
    src: '/games/earl-vs-the-mutants/screenshots/press_02.png',
    alt: 'Explosive combo weapons lighting up a swarm in Earl vs. The Mutants',
    caption: 'Stack roof weapons, attack drones, and wild mutations into screen-clearing builds.',
  },
  {
    src: '/games/earl-vs-the-mutants/screenshots/press_03.png',
    alt: 'Snow biome battle against giant blue slime mutants',
    caption: 'Use terrain elevation and physics momentum to smash through slime storms.',
  },
  {
    src: '/games/earl-vs-the-mutants/screenshots/press_04.png',
    alt: 'Vehicle upgrade selection during a roguelite wasteland run',
    caption: 'Every run offers fresh roguelite synergies plus permanent garage upgrades.',
  },
  {
    src: '/games/earl-vs-the-mutants/screenshots/press_05.png',
    alt: 'Nighttime forest highway ambush with headlights cutting through mutant tribes',
    caption: 'Steam Deck Ready: twin-stick driving and blasting tuned for handheld or PC.',
  },
  {
    src: '/games/earl-vs-the-mutants/screenshots/press_06.png',
    alt: 'Mutant boss showdown in Earl vs. The Mutants',
    caption: 'Towering wasteland bosses test your driving lines and build synergy.',
  },
] as const;

export interface StrikeResult {
  nextHp: number;
  damage: number;
  crit: boolean;
  defeated: boolean;
}

/**
 * Pure damage step for the Mutant Boss Bounty Arena.
 * `roll` in [0, 1) keeps unit tests deterministic while live play passes `Math.random()`.
 */
export function strikeBoss(currentHp: number, maxHp: number, roll = 0.5): StrikeResult {
  const clampedRoll = Math.max(0, Math.min(0.9999, roll));
  if (currentHp <= 0) {
    return { nextHp: 0, damage: 0, crit: false, defeated: true };
  }
  const crit = clampedRoll >= 0.7;
  const base = Math.round(maxHp * (0.2 + clampedRoll * 0.1));
  const damage = crit ? Math.round(base * 1.45) : base;
  const nextHp = Math.max(0, currentHp - damage);
  return {
    nextHp,
    damage,
    crit,
    defeated: nextHp === 0,
  };
}

export interface RigSynergy {
  title: string;
  chaos: number;
  swarm: number;
  bossMelt: number;
  summary: string;
  clip: string;
}

/** Combine 3 chosen garage parts into a roguelite build readout (0–100 bars + matching combat reel). */
export function computeRigSynergy(weaponId: string, droneId: string, powerupId: string): RigSynergy {
  const w = RIG_WEAPONS.find((p) => p.id === weaponId) ?? RIG_WEAPONS[0];
  const d = RIG_DRONES.find((p) => p.id === droneId) ?? RIG_DRONES[0];
  const p = RIG_POWERUPS.find((x) => x.id === powerupId) ?? RIG_POWERUPS[0];

  const chaos = Math.min(100, w.chaos + d.chaos + p.chaos);
  const swarm = Math.min(100, w.swarm + d.swarm + p.swarm);
  const bossMelt = Math.min(100, w.bossMelt + d.bossMelt + p.bossMelt);

  const prefix =
    bossMelt >= swarm && bossMelt >= chaos
      ? 'Boss-Cracking'
      : swarm >= chaos
        ? 'Horde-Shredding'
        : 'Full-Throttle';

  const clip = chaos >= 96 || w.id === 'wrecking-flail' ? STEAM_CARNAGE_VIDEO : STEAM_COMBOS_VIDEO;

  return {
    title: `${prefix} ${w.name.split(' ').pop()} + ${d.name.split(' ')[0]} Rig`,
    chaos,
    swarm,
    bossMelt,
    summary: `${w.perk} · ${d.perk} · ${p.perk.trim()}.`,
    clip,
  };
}
