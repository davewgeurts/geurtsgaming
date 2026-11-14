/**
 * Structured content and pure playable Turbo WPM Dash logic for `/games/cool-typing-games/`.
 * Kept free of Astro runtime imports so Node unit tests verify all 10 games, 8 pods, and WPM math directly.
 */

export type CtgCategory = 'all' | 'classroom' | 'team' | 'accuracy' | 'frenzy';

export interface CtgRacer {
  id: string;
  name: string;
  species: string;
  homeworld: string;
  likes: readonly [string, string];
  dislikes: readonly [string, string];
  accent: string;
  glowLow: string;
  glowHigh: string;
  img: string;
  cheer: string;
  mystery?: boolean;
}

export interface CtgMiniGame {
  id: string;
  title: string;
  players: string;
  modeBadge: string;
  skillFocus: string;
  categories: readonly Exclude<CtgCategory, 'all'>[];
  cardImg: string;
  bgImg: string;
  accent: string;
  description: string;
}

export const CTG_PLAY_URL = 'https://cooltypinggames.com';
export const CTG_SIGNUP_URL = 'https://cooltypinggames.com/signup';
export const CTG_BIG_LOGO = '/games/cool-typing-games/logos/big_logo.png';
export const CTG_SMALL_LOGO = '/games/cool-typing-games/logos/logo_smaller_3x.png';
export const CTG_ROBOT_LOGO = '/games/cool-typing-games/logos/logo_only_robot.png';
export const CTG_ROBOT_HEAD = '/games/cool-typing-games/logos/robot_head.png';
export const CTG_HERO_VIDEO = '/games/cool-typing-games/videos/tobor-hero-loop.webm';

export const CTG_CATEGORIES: readonly { id: CtgCategory; label: string }[] = [
  { id: 'all', label: 'All 10 Games' },
  { id: 'classroom', label: 'Classroom Multiplayer (up to 25p)' },
  { id: 'team', label: 'Team & Head-to-Head' },
  { id: 'accuracy', label: 'Accuracy & Adventure' },
  { id: 'frenzy', label: 'Arcade Score Frenzy' },
] as const;

export const CTG_RACERS: readonly CtgRacer[] = [
  {
    id: 'ricky',
    name: 'Ricky',
    species: 'Raccoon',
    homeworld: 'Earth',
    likes: ['Midnight Snacks', 'Shiny Trophies'],
    dislikes: ['Empty Trash Cans', 'Loud Dogs'],
    accent: '#F79331',
    glowLow: '#1C0F02',
    glowHigh: '#854A0F',
    img: '/games/cool-typing-games/avatars/ricky_raccoon.png',
    cheer: 'Paws on the home row—let’s swipe first place!',
  },
  {
    id: 'tobor',
    name: 'Tobor',
    species: 'Android',
    homeworld: 'Robot Factory',
    likes: ['Fresh Batteries', 'Word Puzzles'],
    dislikes: ['Water Spills', 'Rusty Keys'],
    accent: '#3BE7FF',
    glowLow: '#02181C',
    glowHigh: '#0E7A85',
    img: '/games/cool-typing-games/avatars/tobor_robot.png',
    cheer: 'BEEP BOOP! Calibrating turbo keystrokes to 110%!',
  },
  {
    id: 'ally',
    name: 'Ally Alien',
    species: 'OZMA-7',
    homeworld: 'Zeta Reticuli',
    likes: ['Stargazing', 'Space Rocks'],
    dislikes: ['Heavy Gravity', 'Sunburn'],
    accent: '#7CE86B',
    glowLow: '#061C02',
    glowHigh: '#1F850F',
    img: '/games/cool-typing-games/avatars/ally_alien.png',
    cheer: 'Three eyes on the screen, zero typos in orbit!',
  },
  {
    id: 'sue',
    name: 'Sister Sue',
    species: 'Human',
    homeworld: 'Earth',
    likes: ['Video Games', 'Turbo Racing'],
    dislikes: ['Broccoli', 'Mushrooms'],
    accent: '#FF63E1',
    glowLow: '#1C0224',
    glowHigh: '#850F71',
    img: '/games/cool-typing-games/avatars/sister_sue.png',
    cheer: 'Catch my neon dust at the finish line!',
  },
  {
    id: 'hops',
    name: 'Hops',
    species: 'Rabbit',
    homeworld: 'Secret Lab',
    likes: ['Crunchy Carrots', 'Big Jumps'],
    dislikes: ['Sneaky Foxes', 'Sitting Still'],
    accent: '#FF8FB8',
    glowLow: '#1C020B',
    glowHigh: '#850F36',
    img: '/games/cool-typing-games/avatars/hops_rabbit.png',
    cheer: 'Every word is a mega-hop over the farmer’s fence!',
  },
  {
    id: 'cooper',
    name: 'Cooper',
    species: 'Human',
    homeworld: 'Earth',
    likes: ['Skateboards', 'Hot Pizza'],
    dislikes: ['Pop Quizzes', 'Rainy Days'],
    accent: '#ff4d42',
    glowLow: '#1C0402',
    glowHigh: '#631008',
    img: '/games/cool-typing-games/avatars/cooper.png',
    cheer: 'Kickflip those keys and stack the combo meter!',
  },
  {
    id: 'freddy',
    name: 'Freddy',
    species: 'Space Fox',
    homeworld: 'Rings of Saturn',
    likes: ['Clever Riddles', 'Autumn Leaves'],
    dislikes: ['Traps', 'Cold Paws'],
    accent: '#FF6A3D',
    glowLow: '#1C0802',
    glowHigh: '#852A0F',
    img: '/games/cool-typing-games/avatars/freddy_fox.png',
    cheer: 'Quick wits and quicker fingers win every riddle!',
  },
  {
    id: 'mystery',
    name: 'Unlockable ???',
    species: 'Classified',
    homeworld: 'Hidden Sector',
    likes: ['High XP Levels', 'Secret Codes'],
    dislikes: ['Spoilers', 'Slowpokes'],
    accent: '#B47CFF',
    glowLow: '#0E021C',
    glowHigh: '#440F85',
    img: '/games/cool-typing-games/avatars/mystery.png',
    cheer: 'Level up your XP in live matches to unlock secret racers!',
    mystery: true,
  },
] as const;

export const CTG_FISH_HEROES = [
  { name: 'Finelope Flutterfin', img: '/games/cool-typing-games/avatars/fish_finelope_flutterfin.png' },
  { name: 'Brighton Sparklefish', img: '/games/cool-typing-games/avatars/fish_brighton_sparklefish.png' },
  { name: 'Puff Mommy', img: '/games/cool-typing-games/avatars/fish_puff_mommy.png' },
] as const;

export const CTG_GAMES: readonly CtgMiniGame[] = [
  {
    id: 'track-meet',
    title: 'Track Meet',
    players: '1–25 Players',
    modeBadge: 'Whole-Class Sprint',
    skillFocus: 'Pure Speed & Focus',
    categories: ['classroom', 'frenzy'],
    cardImg: '/games/cool-typing-games/games/track_meet.png',
    bgImg: '/games/cool-typing-games/games/track_meet_bg.png',
    accent: '#1ee5e5',
    description:
      'Launch off the starting blocks with up to 25 classmates at once! Stay locked on your lane and sprint your way onto the gold-medal podium.',
  },
  {
    id: 'turbo-racers',
    title: 'Turbo Racers',
    players: '2 Players',
    modeBadge: 'Head-to-Head',
    skillFocus: 'Burst WPM',
    categories: ['team'],
    cardImg: '/games/cool-typing-games/games/turbo_racers.png',
    bgImg: '/games/cool-typing-games/games/turbo_racers_bg.png',
    accent: '#ffd137',
    description:
      'Every word fuels your nitro booster! Vault track jumps, dodge hazards, and race past a roaring stadium of cheering robots.',
  },
  {
    id: 'tug-of-war',
    title: 'Tug of War',
    players: '2–10 Players',
    modeBadge: 'Team Showdown',
    skillFocus: 'Endurance & Rhythm',
    categories: ['classroom', 'team'],
    cardImg: '/games/cool-typing-games/games/tug_of_war.png',
    bgImg: '/games/cool-typing-games/games/tug_of_war_bg.png',
    accent: '#ff63e1',
    description:
      'Two robot squads, one cosmic power cable! Team up with friends and type in sync to haul the opposing squad across the star-line.',
  },
  {
    id: 'battle-botz',
    title: 'Battle Botz',
    players: '2–10 Players',
    modeBadge: 'Arena Clash',
    skillFocus: 'Clutch Combos',
    categories: ['classroom', 'team', 'frenzy'],
    cardImg: '/games/cool-typing-games/games/battle_botz.png',
    bgImg: '/games/cool-typing-games/games/tug_of_war_bg.png',
    accent: '#ff8907',
    description:
      'Step into the neon boxing ring! String clean typing combos to power up rocket-glove haymakers and shield your mech.',
  },
  {
    id: 'cookies-for-fish',
    title: 'Cookies for Fish',
    players: '2–10 Players',
    modeBadge: 'Maze & Scroller',
    skillFocus: 'Quick Reflexes',
    categories: ['classroom', 'frenzy'],
    cardImg: '/games/cool-typing-games/games/cookies_for_fish.png',
    bgImg: '/games/cool-typing-games/games/cookies_kitchen_bg.png',
    accent: '#3be7ff',
    description:
      'Swim with Finelope Flutterfin, Brighton Sparklefish, and Puff Mommy to chomp glowing chocolate-chip cookies before time runs out!',
  },
  {
    id: 'burger-boss',
    title: 'Burger Boss',
    players: '2 Players',
    modeBadge: 'Diner Rush',
    skillFocus: 'Order Accuracy',
    categories: ['team', 'frenzy'],
    cardImg: '/games/cool-typing-games/games/burger_boss.png',
    bgImg: '/games/cool-typing-games/games/turbo_racers_bg.png',
    accent: '#ff6a3d',
    description:
      'The lunch rush is on! Type ingredients at lightning speed to stack towering burgers and serve hungry customers first.',
  },
  {
    id: 'gone-fishing',
    title: 'Gone Fishing',
    players: '2 Players',
    modeBadge: 'Chill Accuracy',
    skillFocus: 'Zero-Typo Precision',
    categories: ['accuracy', 'team'],
    cardImg: '/games/cool-typing-games/games/gone_fishing.png',
    bgImg: '/games/cool-typing-games/games/gone_fishing_bg.png',
    accent: '#7ce86b',
    description:
      'Breathe easy out on the sunny lake—here careful accuracy beats button-mashing! Type cleanly to reel rare trophy fish into your collection.',
  },
  {
    id: 'rabbits-vs-farmers',
    title: 'Rabbits vs. Farmers',
    players: '2–10 Players',
    modeBadge: 'Garden Heist',
    skillFocus: 'Speed & Evasion',
    categories: ['classroom', 'frenzy'],
    cardImg: '/games/cool-typing-games/games/rabbits_vs_farmers.png',
    bgImg: '/games/cool-typing-games/games/track_meet_bg.png',
    accent: '#ff8fb8',
    description:
      'Outsmart watchful farmers, dash between picket fences, and type fast to snatch golden carrots without getting caught!',
  },
  {
    id: 'rats-attack',
    title: 'Rats Attack',
    players: '2–10 Players',
    modeBadge: 'Village Defense',
    skillFocus: 'Rapid Target Switching',
    categories: ['classroom', 'frenzy'],
    cardImg: '/games/cool-typing-games/games/rats_attack.png',
    bgImg: '/games/cool-typing-games/games/tug_of_war_bg.png',
    accent: '#b47cff',
    description:
      'UFO-riding space rats are swarming the village! Zap incoming words fast to defend your territory and survive the wave.',
  },
  {
    id: 'mystery-of-everlight',
    title: 'Mystery of Everlight',
    players: '2–10 Players',
    modeBadge: 'Story Quest',
    skillFocus: 'Reading & Spelling',
    categories: ['classroom', 'accuracy'],
    cardImg: '/games/cool-typing-games/games/mystery_of_everlight.png',
    bgImg: '/games/cool-typing-games/games/gone_fishing_bg.png',
    accent: '#ffd137',
    description:
      'Team up with wizards and rangers to unlock secret paths, solve enchanted town riddles, and uncover the Mystery of Everlight.',
  },
] as const;

export const DASH_PROMPTS: readonly string[] = [
  'TURBO RACERS BOOST TO GOLD',
  'ROBOTS TUG ACROSS THE STARS',
  'COOKIES FOR HUNGRY SPACE FISH',
  'JUMP THE GATE AND SPRINT FAST',
  'ZERO TYPOS ON THE SUNNY LAKE',
] as const;

export interface DashState {
  prompt: string;
  index: number;
  correct: number;
  mistakes: number;
  streak: number;
  bestStreak: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

export function createDashState(prompt: string = DASH_PROMPTS[0]): DashState {
  return {
    prompt: prompt.toUpperCase(),
    index: 0,
    correct: 0,
    mistakes: 0,
    streak: 0,
    bestStreak: 0,
    startedAtMs: null,
    finishedAtMs: null,
  };
}

export interface DashKeyStep {
  state: DashState;
  hit: boolean;
  completedNow: boolean;
}

/** Advance the playable Turbo WPM Dash by one character key (`a`–`z` or space). */
export function pressDashKey(prev: DashState, rawKey: string, nowMs: number): DashKeyStep {
  if (prev.finishedAtMs !== null || prev.index >= prev.prompt.length) {
    return { state: prev, hit: false, completedNow: false };
  }
  if (rawKey.length !== 1) {
    return { state: prev, hit: false, completedNow: false };
  }
  const key = rawKey.toUpperCase();
  if (!/^[A-Z ]$/.test(key)) {
    return { state: prev, hit: false, completedNow: false };
  }

  const startedAtMs = prev.startedAtMs ?? nowMs;
  const expected = prev.prompt[prev.index];

  if (key === expected) {
    const nextIndex = prev.index + 1;
    const streak = prev.streak + 1;
    const done = nextIndex >= prev.prompt.length;
    return {
      hit: true,
      completedNow: done,
      state: {
        ...prev,
        index: nextIndex,
        correct: prev.correct + 1,
        streak,
        bestStreak: Math.max(prev.bestStreak, streak),
        startedAtMs,
        finishedAtMs: done ? Math.max(startedAtMs + 250, nowMs) : null,
      },
    };
  }

  return {
    hit: false,
    completedNow: false,
    state: {
      ...prev,
      mistakes: prev.mistakes + 1,
      streak: 0,
      startedAtMs,
    },
  };
}

export interface DashStats {
  progressPct: number;
  wpm: number;
  accuracyPct: number;
  medal: 'gold' | 'silver' | 'bronze';
}

export function computeDashStats(state: DashState, nowMs: number): DashStats {
  const totalTyped = state.correct + state.mistakes;
  const accuracyPct = totalTyped === 0 ? 100 : Math.round((state.correct / totalTyped) * 100);
  const progressPct = state.prompt.length === 0 ? 100 : Math.round((state.index / state.prompt.length) * 100);

  let wpm = 0;
  if (state.startedAtMs !== null && state.correct > 0) {
    const end = state.finishedAtMs ?? nowMs;
    const elapsedMinutes = Math.max(0.02, (end - state.startedAtMs) / 60000);
    wpm = Math.min(220, Math.round(state.correct / 5 / elapsedMinutes));
  }

  const medal: 'gold' | 'silver' | 'bronze' =
    wpm >= 45 && accuracyPct >= 92 ? 'gold' : wpm >= 25 && accuracyPct >= 82 ? 'silver' : 'bronze';

  return { progressPct, wpm, accuracyPct, medal };
}

export function filterCtgGames(category: CtgCategory): readonly CtgMiniGame[] {
  if (category === 'all') return CTG_GAMES;
  return CTG_GAMES.filter((g) => g.categories.includes(category));
}
