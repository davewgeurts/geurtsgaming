# Game Showcase Pages Plan: *Earl vs. The Mutants* & *Cool Typing Games*

> [!IMPORTANT]
> **Approved Plan & Staged Assets**: All design decisions are locked in and all **78 official videos, GIFs, character poses, mutant boss sprites, and mini-game artworks** are committed in `public/games/`:
> - **Routes**: `/games/cool-typing-games/` and `/games/earl-vs-the-mutants/`
> - **Card Behavior**: Clicking a `GameCard` (`src/components/GameCard.astro`) opens the internal GeurtsGaming showcase page first, with a secondary direct `"Play free ↗"` / `"Get on Steam ↗"` button alongside `"Explore world"`.
> - **Interactive Mini-Widgets**: Approved for both pages (**Mutant Boss Bounty Arena + Overdrive Speedometer** for Earl; **15-Second Playable WPM Race + Color-Shifting Racer Pod Selector** for Cool Typing Games).
> - **Asset Folders**:
>   - `public/games/cool-typing-games/` (33 files · 12 MB)
>   - `public/games/earl-vs-the-mutants/` (45 files · 33 MB)

---

## 1. Browser Research & Gathered Asset Inventory

### What We Uncovered & Downloaded
| Game | Videos & GIFs Gathered | Sprites, Characters & Artwork Gathered | Key Findings from Live Site / API / Press Kit |
| :--- | :--- | :--- | :--- |
| **Cool Typing Games** (`public/games/cool-typing-games/`) | `videos/tobor-hero-loop.webm` (30fps VP9 capture of the live WebGL2 Rive portal) | **6 logos** (`big_logo.png`, `logo_only_robot.png`, `logo_smaller_3x.png`, `robot_head.png`, `logo.png`, `cookiesforfish_logo.png`), **7 playable hero avatars** + `mystery.png` + **3 Fish avatars** (transparent PNGs), **10 mini-game HD cards** + **5 stage backdrops** | Powered by PixiJS + Rive. Public catalog reveals **10 distinct typing games** (up to **25 players** in *Track Meet*, 2–10p in *Tug of War* & *Battle Botz*, accuracy-focused *Gone Fishing*, *Burger Boss*, *Cookies for Fish*, *Mystery of Everlight*, *Rabbits vs Farmers*, *Rats Attack*, *Turbo Racers*) and rich character bios (species, homeworld, likes/dislikes, neon hex themes). |
| **Earl vs. The Mutants** (`public/games/earl-vs-the-mutants/`) | **3 biome WebM loops** (`gameplay-wasteland.webm`, `gameplay-snow-slime.webm`, `gameplay-night-road.webm`), **2 Steam combat MP4s** (`steam-combos.mp4`, `steam-carnage.mp4`), **1 Press Kit GIF** (`earl-action-2.gif`) | Transparent `evtm_logo.png`, `evtm_hero_with_logo.png`, `hero_banner.png`, `falling_state_logo.png`, **9 Earl reaction poses**, **4 Edna reaction poses**, **15 Mutant Boss emotion sprites** (5 bosses × `normal` / `laughing` / `angry`), **7 HD Press Kit screenshots** | Encoded ~1.5 MB VP9 WebM biome loops + grabbed Steam's compact MP4 loops. Steam page highlights **Very Positive** reviews, **Steam Deck Ready**, **5–10 min roguelite runs**, and Earl's **37 consecutive Employee of the Month awards** at Edna's Pest Control. |

> [!WARNING]
> **COPPA & Privacy Guardrail**: On `earlvsthemutants.com`, the embedded YouTube `<iframe>` immediately fires `doubleclick.net` ad-tracking requests. To keep `geurtsgaming.com` 100% true to `src/layouts/Base.astro` and `/privacy/` (*no third-party ad cookies or tracking*), all background and inline gameplay videos must be **100% self-hosted `<video muted loop playsinline>`** from `public/games/`, and the full trailer with audio will open cleanly via an external YouTube link.

---

## 2. Shared "Game-Like" UI System & Architecture

- **Routes**:
  - `src/pages/games/cool-typing-games.astro` → `/games/cool-typing-games/` (automatically highlights `Games` in `src/components/Nav.astro`)
  - `src/pages/games/earl-vs-the-mutants.astro` → `/games/earl-vs-the-mutants/`
- **Tactile 3D Arcade Buttons (`.arcade-btn`)**:
  - Physical raised bottom bevel (`box-shadow: 0 6px 0 ...`) that squishes down `4px` on `:active` and keyboard `Space`/`Enter`, with springy hover glow and optional **opt-in Sound FX toggle** in the hero corner (zero-dependency WebAudio synth clicks, keycap clacks, engine revs, and blaster pops — **muted by default**).
- **Performance & Accessibility**:
  - `IntersectionObserver` pauses `<video>` and `<canvas>` loops whenever scrolled off-screen or when `document.hidden` is true (matching `src/components/Starfield.astro`).
  - Full `prefers-reduced-motion: reduce` support: freezes background videos on crisp poster frames, disables recoil/screen-shake, and keeps all interactive widgets keyboard-accessible.

---

## 3. Page 1 Design: `/games/earl-vs-the-mutants/`

**Theme**: *Wasteland Road-Trip Arcade* — bridges GeurtsGaming's midnight navy (`#081849`) into scorched wasteland crimson (`#870300`), blaze orange (`#ff7a1a`), and hazard yellow (`#f6de18`).

1. **Multi-Biome Wasteland Video Hero + Interactive Speedometer HUD**
   - Full-bleed darkened `<video>` cycling through **Desert Wasteland**, **Snow Slime Storm**, and **Night Forest** (`gameplay-wasteland.webm` → `gameplay-snow-slime.webm` → `gameplay-night-road.webm`), topped with transparent `evtm_logo.png`, **Steam Deck Ready** + **Very Positive** pills, and Steam CTA.
   - **Button Tinkering — `"HOLD TO REV OVERDRIVE"` & Biome Shifter**: Holding or hovering the Overdrive throttle button revs an authentic SVG **Speedometer HUD** (matching the in-game bottom-right gauge) from `35 MPH` → `99 MPH`, accelerates the background gameplay video (`playbackRate = 1.45`), and kicks up ember sparks across a lightweight foreground canvas. Gear-shift tabs (`1: DESERT`, `2: TUNDRA`, `3: NIGHT RUN`) switch background biomes on demand.

2. **Interactive Mini-Game Section: *"Edna's Pest Control — Boss Bounty Arena"***
   - Showcases all **5 Mutant Bosses** (`Skeleton Overlord`, `Hellbilly`, `Slime Boss`, `Cultist`, `Lake Monster`) using their 3 official Press Kit expression sprites:
     - **Idle**: `*_normal.png`
     - **Hover**: Boss taunts & laughs (`*_laughing.png`)
     - **Click / Tap to Blast**: Cursor acts as Earl's red twin-stick crosshair; clicking fires a particle blast, pops floating roguelite damage numbers (`-450 CRIT!`), shakes the card, and swaps the boss into `*_angry.png` as their HP bar drops.
     - **Clear All 5 Bounties**: Unlocks an **"Employee of the Month #38"** stamp while Earl celebrates in `earl_godmode.png`!

3. **Interactive Earl & Edna Reaction Stage (*9 Earl Poses + 4 Edna Poses*)**
   - Visitors click situation buttons (*"37x Employee of the Month"*, *"Mutant Ambush!"*, *"God Mode Build"*, *"Edna's Cut"*) — or poke the characters directly — to swap Earl across all 9 sprites (`normal`, `smile`, `determined`, `godmode`, `laughing`, `surprised`, `scared`, `sad`, `crying`) and Edna across her 4 sprites (`normal`, `smile`, `onery`, `open_mouth`) with in-character banter.

4. **"Build Crazy Combos" Loadout Tinkerer + Combat Reel**
   - Interactive 3-slot roguelite combo builder (*Vehicle Weapon* + *Attack Drone* + *Wild Powerup*) paired with `steam-combos.mp4` and `steam-carnage.mp4`, plus a lightbox strip of the 7 Press Kit HD screenshots and a bottom Steam + Trailer CTA band.

---

## 4. Page 2 Design: `/games/cool-typing-games/`

**Theme**: *Neon Cyber-Arcade Classroom* — GeurtsGaming's cosmic navy (`#081849`) illuminated with electric cyan (`#1ee5e5`), magenta (`#FF63E1`), and alien lime (`#7CE86B`), dynamically tinted by whichever Racer Avatar the visitor selects.

1. **Interactive Keycap Hero + Ambient Typing Skirmish Backdrop**
   - Features `big_logo.png` alongside the animated `tobor-hero-loop.webm` portal and a background `<canvas>` (inspired by `src/components/hero-cameos.ts`) where tiny racer pods chase glowing words around the margins.
   - **Keyboard Easter Egg**: Pressing *any* letter key while viewing the hero lights up a floating neon keycap and zaps a background word with a cyan laser beam!

2. **Playable Micro-Demo: *"15-Second Turbo WPM Dash"***
   - Compact zero-latency typing race lane where **Ricky Raccoon** races **Tobor the Robot**.
   - Visitors type a short kid-friendly prompt (or tap tactile on-screen arcade keys on phones/tablets) to watch Ricky boost forward with nitro flames, see their live **WPM & Accuracy**, and hit a celebratory **"Race Real Classmates Free on CoolTypingGames.com ↗"** button.

3. **"Choose Your Racer" Interactive Avatar Pod Selector (*All 7 Official Characters*)**
   - Interactive pod strip featuring:
     - **Ricky** (`Raccoon` · Earth · `#F79331` · Likes: *Midnight Snacks, Shiny Things*)
     - **Tobor** (`Android` · Robot Factory · `#3BE7FF` · Likes: *Fresh Batteries, Puzzles*)
     - **Ally Alien** (`OZMA-7` · Zeta Reticuli · `#7CE86B` · Likes: *Stargazing, Space Rocks*)
     - **Sister Sue** (`Human` · Earth · `#FF63E1` · Likes: *Video Games, Racing*)
     - **Hops** (`Rabbit` · Unknown Laboratory · `#FF8FB8` · Likes: *Carrots, Big Jumps*)
     - **Cooper** (`Human` · Earth · `#ff0d00` · Likes: *Skateboards, Pizza*)
     - **Freddy** (`Fox` · Saturn · `#FF6A3D` · Likes: *Riddles, Autumn Leaves*)
     - Plus the unlockable **Mystery `???`** pod (`#B47CFF`).
   - Clicking any racer switches `--game-accent` to their signature color and flips open their trading card.

4. **10-Game Interactive Arcade Wall**
   - Tactile filter buttons: **All 10 Games** · **Whole Classroom (up to 25p)** · **Team Tug & Race** · **Accuracy & Chill** · **Action Frenzy**.
   - Showcases all 10 official HD cards (*Turbo Racers*, *Tug of War*, *Track Meet*, *Battle Botz*, *Burger Boss*, *Cookies for Fish*, *Gone Fishing*, *Rabbits vs Farmers*, *Rats Attack*, *Mystery of Everlight*) with player-count badges, skill tags (*Speed*, *Accuracy*, *Endurance*), and dynamic backdrop previews (`*_bg.png`).

5. **Classroom & Parent Trust Band**
   - Highlights zero-install browser play (Chromebooks, Macs, PCs), instant nickname `"Let's Play!"` entry, up-to-25-player classroom *Track Meet* heats, and links to GeurtsGaming's `/privacy/` (COPPA) and `/security/` pages.

---

## 5. Planned Implementation Files

### New Files
- `src/pages/games/earl-vs-the-mutants.astro` — Full interactive showcase page + `VideoGame` JSON-LD structured data.
- `src/pages/games/cool-typing-games.astro` — Full interactive showcase page + `VideoGame` JSON-LD structured data.
- `src/components/games/ArcadeAudio.ts` — Tiny opt-in WebAudio synth helper (muted by default; respects `prefers-reduced-motion`).
- `src/data/earl-showcase.ts` & `src/data/ctg-showcase.ts` — Typed metadata for Earl poses/bosses/biomes and Cool Typing Games' 7 avatars & 10 mini-games.

### Existing Files to Update
- `src/data/games.ts` — Add `pageHref: '/games/cool-typing-games/'` and `'/games/earl-vs-the-mutants/'`.
- `src/components/GameCard.astro` — Link card media/title + `"Explore world"` button to `game.pageHref` alongside the secondary direct external `"Play free ↗"` / `"Get the game ↗"` CTA.
- `src/components/Footer.astro` — Point Footer "Games" links to `/games/cool-typing-games/` and `/games/earl-vs-the-mutants/`.
- `tests/` — Add unit/build assertions verifying both new routes, JSON-LD `VideoGame` metadata, and link integrity.

---

## 6. Verification Plan (Docker-Only Workflow)
1. Run `docker compose run --rm build` and `docker compose run --rm test` to verify zero TypeScript/Astro/unit errors.
2. Verify `http://localhost:84/games/earl-vs-the-mutants/` and `http://localhost:84/games/cool-typing-games/` across desktop (`1440×900`) and mobile (`390×844`), testing keyboard navigation, `prefers-reduced-motion: reduce`, video loop smoothness, and zero third-party ad/tracker network requests.
