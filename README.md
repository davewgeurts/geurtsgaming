# geurtsgaming.com

Static marketing site for **GeurtsGaming** — educational and fun games for kids and teenagers.

Built with [Astro](https://astro.build), deployed to GitHub Pages via `.github/workflows/deploy.yml`, served at https://geurtsgaming.com (see `public/CNAME`).

## Develop

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # outputs to dist/
npm run preview    # serve the production build locally
```

## Where things live

- `src/pages/` — one `.astro` file per route (`/`, `/games/`, `/about/`, `/contact/`)
- `src/layouts/Base.astro` — HTML shell, meta/OG tags, fonts, nav + footer
- `src/components/` — `Logo` (GG monogram), `Nav`, `Footer`, `GameCard`, `Starfield`
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
