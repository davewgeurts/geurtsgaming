/**
 * Fireworks for how a challenge went: a sky full of them for a perfect answer, a few for a good one,
 * and a red fizzle for one that failed.
 *
 * Each burst is a shell that goes off at a moment and a place and throws out sparks; the sparks slow down,
 * sink and fade. They are drawn as short glowing streaks, like everything else in the game.
 */
import { NEON, rand, type Ink } from './core';

/** How a challenge went. */
export type Grade = 'failed' | 'good' | 'perfect';

/** The colour that says each grade: red, yellow, green. */
export const GRADE_COLOR: Record<Grade, string> = { failed: NEON.red, good: NEON.yellow, perfect: NEON.lime };

const PINK = '#ff5ea8';
/** The colours a perfect answer's fireworks go through: green first, then the rest of the game's neon. */
const PARTY = [NEON.lime, NEON.lime, NEON.cyan, NEON.yellow, PINK, NEON.violet, NEON.lime] as const;

/** Never more sparks than this in the air at once, however many challenges are answered in a hurry. */
export const MAX_SPARKS = 520;

interface Shell { in: number; x: number; y: number; color: string; sparks: number; power: number; life: number; sink: number }
interface Spark { x: number; y: number; vx: number; vy: number; age: number; life: number; color: string; sink: number }

/** How many shells each grade sets off, how many sparks each throws and how hard, and how long they last. */
const SHOW: Record<Grade, { big: [shells: number, sparks: number, power: number]; small: [number, number, number]; life: number; sink: number }> = {
  perfect: { big: [9, 54, 400], small: [1, 34, 260], life: 1.5, sink: 110 },
  good: { big: [4, 32, 260], small: [1, 20, 190], life: 1.05, sink: 150 },
  // A dud: a handful of sparks that barely get going and drop.
  failed: { big: [1, 18, 130], small: [1, 9, 95], life: 0.85, sink: 460 },
};

export class Fireworks {
  private shells: Shell[] = [];
  readonly sparks: Spark[] = [];

  /** Whether there is anything in the air, or about to be. */
  get active(): boolean {
    return this.shells.length > 0 || this.sparks.length > 0;
  }

  /** Shells still to go off. */
  get pending(): number {
    return this.shells.length;
  }

  clear(): void {
    this.shells = [];
    this.sparks.length = 0;
  }

  /**
   * Set off the show for a grade, centred on (x, y) and spread over `spread` px each way across (and about
   * half that up and down). `big` is the full show, for a whole challenge; otherwise it is one small burst,
   * for one sum in a round of them. `scale` is the game's size multiplier.
   */
  launch(grade: Grade, big: boolean, x: number, y: number, spread: number, scale: number): void {
    const show = SHOW[grade];
    const [shells, sparks, power] = big ? show.big : show.small;
    for (let i = 0; i < shells; i++) {
      // The first goes off where the challenge is; the rest go off around it, a beat apart.
      const first = i === 0;
      this.shells.push({
        in: first ? 0 : 0.1 + i * 0.17 + rand(0, 0.12),
        x: first ? x : x + rand(-1, 1) * spread,
        y: first ? y : y + rand(-0.75, 0.35) * spread * 0.5,
        color: grade === 'perfect' ? PARTY[i % PARTY.length]! : GRADE_COLOR[grade],
        sparks,
        power: power * scale * (first ? 1 : rand(0.75, 1.1)),
        life: show.life,
        sink: show.sink * scale,
      });
    }
  }

  update(dt: number): void {
    for (const shell of this.shells) {
      shell.in -= dt;
      if (shell.in <= 0) this.burst(shell);
    }
    if (this.shells.some((shell) => shell.in <= 0)) this.shells = this.shells.filter((shell) => shell.in > 0);

    const drag = Math.exp(-dt * 2.4);
    for (const s of this.sparks) {
      s.age += dt;
      s.vx *= drag;
      s.vy = s.vy * drag + s.sink * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) if (this.sparks[i]!.age >= this.sparks[i]!.life) this.sparks.splice(i, 1);
  }

  private burst(shell: Shell): void {
    const room = Math.max(0, MAX_SPARKS - this.sparks.length);
    const count = Math.min(shell.sparks, room);
    const turn = rand(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      // Evenly round the circle, with enough wobble that it does not look ruled.
      const angle = turn + (i / count) * Math.PI * 2 + rand(-0.12, 0.12);
      const speed = shell.power * rand(0.45, 1);
      this.sparks.push({
        x: shell.x, y: shell.y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        age: 0, life: shell.life * rand(0.65, 1.1), color: shell.color, sink: shell.sink,
      });
    }
  }
}

/** Draw the sparks: bright streaks while they are young, thin embers as they die. One stroke per colour and age. */
export function renderFireworks(ctx: CanvasRenderingContext2D, ink: Ink, fireworks: Fireworks): void {
  const sparks = fireworks.sparks;
  if (!sparks.length) return;
  const colors = new Set(sparks.map((s) => s.color));
  for (const color of colors) {
    for (const young of [true, false]) {
      ink(color, young ? 1 : 0.55, young ? 2 : 1.2, () => {
        for (const s of sparks) {
          const spent = s.age / s.life;
          if (s.color !== color || spent < 0.5 !== young) continue;
          // The streak is the last few hundredths of a second of the spark's flight, never less than a dot.
          const tail = 0.075 * (1 - spent * 0.6);
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - s.vx * tail - 0.5, s.y - s.vy * tail - 0.5);
        }
      }, young);
    }
  }
}
