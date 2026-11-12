# geurtsgaming.com

Static marketing site for **GeurtsGaming** — educational and fun games for kids and teenagers.

Built with [Astro](https://astro.build), deployed to GitHub Pages via `.github/workflows/deploy.yml`, served at https://geurtsgaming.com (see `public/CNAME`).

## Develop

```sh
npm install
npm run dev        # http://localhost:4321
npm run check      # type-check .astro and .ts files
npm run build      # type-check, then output to dist/ (a type error fails the deploy)
npm run preview    # serve the production build locally
```

## Where things live

- `src/pages/` — one `.astro` file per route (`/`, `/games/`, `/about/`, `/contact/`)
- `src/layouts/Base.astro` — HTML shell, meta/OG tags, fonts, nav + footer
- `src/components/` — `Logo` (GG monogram), `Nav`, `Footer`, `GameCard`, `Starfield`, `HeroGame` (the "Play the demo" launcher and the full-screen overlay the game plays in)
- `src/game/` — the hero arcade game, downloaded only when someone presses "Play the demo":
  - `game.ts` — the loop: state, input, collisions, and wiring the rest together
  - `core.ts` — colours, maths helpers and the glowing stroke everything is drawn with (small on purpose: the home page's starfield loads it too)
  - `enemies.ts` (enemy kinds, how a wave is laid out, movement), `weapons.ts` (shots, rockets, debris, the people set free), `hud.ts` (the HUD, messages and question panels)
  - `boss.ts` (the mini boss that ends each wave), `tanker.ts` (the fuel ship and its fuel line), `asteroids.ts` (the asteroid field and the two ways through it), `upgrades.ts` (the ten ship upgrades)
  - `hangar.ts` and `intro.ts` (the opening: the school's hangar, then the cockpit briefing and take-off), `backdrop.ts` (low-poly planets, moons and rocks behind the game), `avatar.ts` (the wireframe pilot, boss and commander)
  - `challenge.ts` (rules for the typing and maths questions), `maths.ts` (problem generator), `lines.ts` (lines to type, the briefing, the boss's taunts)
  - `shapes.ts` (line-art ships), `font.ts` (stroke font), `sound.ts` (synthesised sound effects, no audio files)
- `tests/` — tests for the game's rules, run with `npm test` (see below)
- `src/data/games.ts` — the list of games; add a game here and it shows up everywhere
- `src/styles/global.css` — design tokens ("Lapis velvet evening" palette) and base styles
- `public/` — favicon, logo.svg, og.png, CNAME
- `logos/` — the logo as PNG and SVG files for social media and print (not part of the site): the gg badge and mark, lockups with the name, a wordmark, banner sizes, and favicons

## Tests

```sh
npm test
```

Runs in about three seconds with Node's own test runner; there is nothing extra to install. It covers the question rules, the sums, the boss, the upgrade offers and how a wave is laid out. Two of the files fly a simulated pilot: one through the fuel ship's visit at several reaction times, to keep its difficulty where it was tuned, and one through both ways of the asteroid field on four screen sizes, to prove they can always be flown.

The tests do not open a browser, so they say nothing about drawing, input or sound.

## Brand

| Token   | Hex       |
| ------- | --------- |
| navy    | `#081849` |
| lapis   | `#213885` |
| plum    | `#5F3475` |
| magenta | `#893172` |
| sand    | `#ECDFD2` |
| silver  | `#CCCACC` |

Display font: Orbitron. Body font: Nunito.
