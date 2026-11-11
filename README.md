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
- `src/game/` — the hero arcade game, downloaded only when someone presses "Play the demo": `game.ts` (loop, waves, input, drawing), `boss.ts` (the mini boss that ends each wave), `challenge.ts` (rules for the typing and maths questions), `maths.ts` (problem generator), `lines.ts` (lines and words to type), `shapes.ts` (line-art ships), `font.ts` (stroke font)
- `src/data/games.ts` — the list of games; add a game here and it shows up everywhere
- `src/styles/global.css` — design tokens ("Lapis velvet evening" palette) and base styles
- `public/` — favicon, logo.svg, og.png, CNAME

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
