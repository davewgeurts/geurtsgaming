import type { ImageMetadata } from 'astro';
import coolTyping from '../assets/cool-typing-games.jpg';
import earl from '../assets/earl-vs-the-mutants.jpg';

export interface Game {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  audience: string;
  platform: string;
  status: string;
  pageHref: string;
  url: string;
  cta: string;
  image: ImageMetadata;
  accent: string;
}

export const games: Game[] = [
  {
    slug: 'cool-typing-games',
    title: 'Cool Typing Games',
    tagline: 'Multiplayer typing games for kids & classrooms',
    description:
      'Race, battle and tug-of-war your way to faster typing. Jump into a live match with friends or classmates, level up your words-per-minute, and actually look forward to practice.',
    audience: 'Ages 6–14',
    platform: 'Browser',
    status: 'Free to play',
    pageHref: '/games/cool-typing-games/',
    url: 'https://cooltypinggames.com',
    cta: 'Play free',
    image: coolTyping,
    accent: '#1ee5e5',
  },
  {
    slug: 'earl-vs-the-mutants',
    title: 'Earl vs. The Mutants',
    tagline: 'Drive, blast and survive the mutant wasteland',
    description:
      'Earl is a hardened mutant exterminator in a world ravaged by apocalypse. Civilization has crumbled, replaced by a perilous wasteland roamed by ferocious mutant tribes. Load up, hit the road, and take the fight to them.',
    audience: 'Teens & up',
    platform: 'PC · Steam',
    status: 'Out now',
    pageHref: '/games/earl-vs-the-mutants/',
    url: 'https://earlvsthemutants.com',
    cta: 'Get the game',
    image: earl,
    accent: '#ff7a1a',
  },
];
