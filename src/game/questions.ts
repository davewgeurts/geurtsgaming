/**
 * When the game asks a question, and what the answer is worth.
 *
 * - The break before every wave: a line to type or, on a touch screen, three sums. Good work charges the
 *   cannons, and clean work repairs the hull.
 * - The question a capsule or a bomb asks in the middle of a wave, while the game runs in slow motion.
 *   A right answer pays out the capsule (or defuses the bomb); a wrong one jams the cannons (or sets it off).
 * - The choice of upgrade that follows an upgrade capsule answered right.
 *
 * What counts as a right answer is in challenge.ts, and hud.ts draws all of this. Nothing here draws or
 * touches the page: what the game should do about an answer is asked of it through `QuestionEnv`.
 */
import type { Mood } from './avatar';
import {
  accepts, choiceChallenge, entryChallenge, lineChallenge, press, tick,
  type Challenge, type ChoiceChallenge,
} from './challenge';
import { PINK, SAND, percent, pick } from './core';
import type { Grade } from './fireworks';
import { LINES, WORDS, type Taunt } from './lines';
import { makeProblem } from './maths';
import { MARK_BOMB, MARK_ENERGY, MARK_HULL, MARK_STAR, MINE, type Shape } from './shapes';
import type { Sfx } from './sound';
import { offerUpgrades, type Upgrade, type UpgradeId } from './upgrades';
import { TRIPLE_AT } from './weapons';

/** Accuracy needed on a finished line to repair one point of hull. */
export const REPAIR_ACCURACY = 0.9;
/** Points for clean work when the hull has nothing to repair. */
export const FULL_HULL_BONUS = 250;
/** Seconds at the start of a question when answers are ignored, so a last tap of Space is not a mistake. */
export const BREAK_GRACE = 0.6;
export const PROMPT_GRACE = 0.35;
/** Sums in the pre-wave break on touch, and the seconds allowed for each. */
export const ROUND_PROBLEMS = 3;
export const ROUND_SECONDS = 8;
/** Seconds to answer a capsule's question. */
export const PROMPT_SECONDS = 10;
/** Seconds the cannons stay jammed after a wrong answer. */
export const JAM_SECONDS = 2.5;
/** Points for defusing a bomb, and for an upgrade capsule when every upgrade is already owned. */
export const DEFUSE_POINTS = 300;
export const ALL_OWNED_POINTS = 500;
/** How much of the energy gauge a perfect answer to a power capsule fills. */
export const POWER_GAIN = 0.6;
/** Seconds before an offered upgrade can be picked, so a key or finger still down from the question picks nothing. */
export const OFFER_GRACE = 0.4;

/**
 * How one question went: failed (wrong, or out of time), good, or perfect. A typed line is perfect when it is
 * finished without a single wrong key, however slowly: accuracy comes first. A sum is perfect when it is
 * right first time with at least half the clock left.
 */
export function gradeOf(c: Challenge): Grade | null {
  const o = c.outcome;
  if (!o) return null;
  if (!o.success) return 'failed';
  if (c.kind === 'line') return c.misses === 0 ? 'perfect' : 'good';
  const slipped = c.kind === 'entry' && c.misses > 0;
  return !slipped && c.timeLeft >= c.limit / 2 ? 'perfect' : 'good';
}

/** What a boost capsule pays out. A blast clears the screen. */
export type Reward = 'hull' | 'energy' | 'blast' | 'upgrade';
/** What a question is being answered for: a capsule's reward, or to defuse a bomb. */
export type Stake = Reward | 'defuse';

export const STAKES: Record<Stake, { mark: Shape; label: string; goal: string }> = {
  hull: { mark: MARK_HULL, label: 'HULL', goal: 'TO REPAIR THE HULL' },
  energy: { mark: MARK_ENERGY, label: 'POWER', goal: 'TO POWER UP' },
  blast: { mark: MARK_BOMB, label: 'BLAST', goal: 'TO SET OFF A BLAST' },
  upgrade: { mark: MARK_STAR, label: 'UPGRADE', goal: 'TO WIN AN UPGRADE' },
  defuse: { mark: MINE, label: 'BOMB', goal: 'OR THE BOMB GOES OFF' },
};

export interface Banner { text: string; size: number; color: string; alpha: number }

/** The stop before a wave: the ship holds still while the player earns energy for it. */
export interface Break {
  /** The wave this break leads into. */
  wave: number;
  challenge: Challenge;
  /** A round of sums asks several in a row: how many there are, how many are still to come, how they went. */
  total: number;
  left: number;
  right: number;
  earned: number;
  /** Counts down while an answered sum stays on screen, before the next one. */
  pause: number;
  counted: boolean;
  /** Set once the break is scored; the lines then stay on screen for `hold` seconds. */
  result: Banner[] | null;
  hold: number;
  /** How the break went as a whole, once it is scored. */
  grade: Grade | null;
}

/** The question a boost capsule asks in the middle of a wave, while the game runs in slow motion. */
export interface Prompt {
  stake: Stake;
  challenge: Challenge;
  settled: boolean;
  /** A bomb that was not defused: when the result has been read, the ship is lost. */
  fatal: boolean;
  /** What the answer earned or cost, shown once it is settled. */
  note: string;
  hold: number;
  /** An upgrade capsule answered right: the upgrades to choose from, until one is picked. */
  offer: Upgrade[] | null;
  offerAge: number;
}

/**
 * Which school years the player says they are in: 0 for kindergarten to grade 2, 1 for grades 3 to 5,
 * 2 for grade 6 and up. It sets how hard the questions are and how long there is to answer them, and
 * nothing else: it is kept only while the page is open, and is never saved or sent anywhere.
 */
export type GradeBand = 0 | 1 | 2;

export const GRADE_BANDS: readonly { label: string; ages: string; spoken: string }[] = [
  { label: 'GRADES K-2', ages: 'AGES 5-7', spoken: 'kindergarten to grade 2' },
  { label: 'GRADES 3-5', ages: 'AGES 8-10', spoken: 'grades 3 to 5' },
  { label: 'GRADE 6 AND UP', ages: 'AGES 11+', spoken: 'grade 6 and up' },
];

/** How much longer than the usual clock the youngest players get. */
const CLOCK: readonly number[] = [1.6, 1, 1];

/** The seconds allowed for a question that would usually get `seconds`. */
export function clockFor(seconds: number, grade: GradeBand): number {
  return seconds * CLOCK[grade]!;
}

/**
 * How hard the sums are, 1 to 3 (see maths.ts). For grades 3 to 5 it rises with the waves: 1 for the first
 * two, 2 for the next two, 3 from wave five. The youngest stay on sums within 20 throughout. The oldest
 * start a level up: times tables from the first wave, the full tables and division from the third.
 */
export function sumLevel(wave: number, grade: GradeBand = 1): number {
  const byWave = Math.min(3, 1 + Math.floor((Math.max(1, wave) - 1) / 2));
  return grade === 0 ? 1 : grade === 2 ? Math.min(3, byWave + 1) : byWave;
}

/**
 * Which group of lines to type from (see LINES in lines.ts: short, medium, long). Lines get longer every two
 * waves; the youngest keep the short ones for three waves and never get the longest, the oldest start on medium.
 */
export function lineTier(wave: number, grade: GradeBand = 1): number {
  const w = Math.max(1, wave) - 1;
  const tier = grade === 0 ? Math.min(1, Math.floor(w / 3)) : Math.floor(w / 2) + (grade === 2 ? 1 : 0);
  return Math.min(LINES.length - 1, tier);
}

/** What the questions know of the game, and what they can ask of it. */
export interface QuestionEnv {
  // Brought up to date by the game each time it is asked for:
  /** Answers are tapped, not typed. */
  touch: boolean;
  /** The wave being flown and the player's school years, which together set how hard the questions are. */
  wave: number;
  grade: GradeBand;
  hull: number;
  maxHull: number;
  /** The energy gauge, 0 to 1. */
  energy: number;
  /** A boss is on screen, and has something to say about bombs. */
  boss: boolean;
  owned: ReadonlySet<UpgradeId>;
  // Made once:
  play(sound: Sfx): void;
  /** A line for the screen reader. */
  say(message: string): void;
  /** The pilot calls this out. */
  call(text: string): void;
  /** Fireworks for how a challenge went. `big` is for a whole challenge; one sum in a round of them gets a small burst. */
  celebrate(grade: Grade, big: boolean): void;
  feel(mood: Mood, seconds: number): void;
  /** The boss says its piece. */
  taunt(kind: Taunt, mood: Mood, seconds: number): void;
  award(points: number): void;
  /** Add to the energy gauge, which stops at full (1). */
  charge(amount: number): void;
  /** Mend one point of hull. */
  repair(): void;
  /** Jam the cannons for this many seconds. */
  jam(seconds: number): void;
  /** Set off a blast: everything hostile on screen goes. */
  blast(): void;
  /** Fit an upgrade that has just been chosen. */
  equip(id: UpgradeId): void;
  /** A bomb has gone off under the ship. */
  explode(): void;
  /** A question in the middle of a wave is over: the ship cannot be hit for this many seconds. */
  shelter(seconds: number): void;
  /** A break is starting: the ship parks, and the sky is cleared of shots, capsules and bombs. */
  park(wave: number): void;
  /** A break is over: start the wave it led into. */
  launch(wave: number): void;
}

export class Questions {
  brk: Break | null = null;
  prompt: Prompt | null = null;
  private lastText = '';

  /** A new game: nothing is being asked. */
  reset(): void {
    this.brk = null;
    this.prompt = null;
  }

  /** The question waiting for an answer, if there is one. */
  get challenge(): Challenge | null {
    if (this.brk) return this.brk.result ? null : this.brk.challenge;
    return this.prompt?.challenge ?? null;
  }

  /** A capsule's question is open and still waiting (or an upgrade is being chosen, or a bomb is about to go off). */
  get asking(): boolean {
    const p = this.prompt;
    return p !== null && (!p.settled || p.fatal || p.offer !== null);
  }

  /** Whether typing this character would answer the open question, or pick one of the upgrades on offer. */
  wants(key: string): boolean {
    const challenge = this.challenge;
    if (challenge && accepts(challenge, key)) return true;
    const offer = this.prompt?.offer;
    return Boolean(offer && key >= '1' && key <= String(offer.length));
  }

  /** A character that `wants` said yes to: it goes to the question, with a click if it counted and a buzz if it was wrong. */
  type(key: string, env: QuestionEnv): void {
    const c = this.challenge;
    if (!c || !accepts(c, key)) {
      // Number keys pick one of the upgrades on offer.
      if (this.prompt?.offer) this.chooseUpgrade(Number(key) - 1, env);
      return;
    }
    const before = c.kind === 'line' ? c.index : c.kind === 'entry' ? c.typed.length : 0;
    const misses = c.kind === 'choice' ? 0 : c.misses;
    press(c, key);
    if (c.kind === 'line') {
      if (c.index > before) env.play('key');
      else if (c.misses > misses) env.play('slip');
    } else if (c.kind === 'entry' && c.misses > misses) {
      env.play('slip');
      env.say(`Not quite. One more try. What is ${c.question}?`);
    } else if (c.kind === 'entry' && c.typed.length !== before) {
      env.play('key');
    }
  }

  /** Someone on a touch screen has no keys, so a question that needs typing becomes one with answers to tap. */
  byTouch(env: QuestionEnv): void {
    if (this.brk && !this.brk.result && this.brk.challenge.kind === 'line') {
      this.startBreak(this.brk.wave, env);
    } else if (this.prompt && !this.prompt.challenge.outcome && this.prompt.challenge.kind !== 'choice') {
      this.prompt.challenge = this.sum(env.wave, PROMPT_SECONDS, PROMPT_GRACE, env);
      this.announce(this.prompt.challenge, '', env);
    }
  }

  /** A sum with answers to pick from. */
  private sum(wave: number, seconds: number, grace: number, env: QuestionEnv): ChoiceChallenge {
    return choiceChallenge(makeProblem(sumLevel(wave, env.grade)), clockFor(seconds, env.grade), grace);
  }

  /** A piece of text to type, never the same one twice running. */
  private text(from: readonly string[]): string {
    let text = pick(from);
    if (text === this.lastText) text = from[(from.indexOf(text) + 1) % from.length]!;
    this.lastText = text;
    return text;
  }

  /** Read the question out for a screen reader, after `lead` (what just happened). */
  private announce(c: Challenge, lead: string, env: QuestionEnv): void {
    const ask =
      c.kind === 'line'
        ? `Type: ${c.text}`
        : c.kind === 'choice'
          ? env.touch
            ? `What is ${c.question}? Tap the answer: ${c.options.join(', ')}.`
            : `What is ${c.question}? ${c.options.map((o, i) => `Press ${i + 1} for ${o}`).join(', ')}.`
          : `What is ${c.question}? Type the answer.`;
    env.say(`${lead} ${ask}`.trim());
  }

  /** Run a question's clock, with a tick for each of its last three seconds. */
  private clock(c: Challenge, dt: number, env: QuestionEnv): void {
    const before = Math.ceil(c.timeLeft);
    tick(c, dt);
    const left = Math.ceil(c.timeLeft);
    if (!c.outcome && left < before && left <= 3) env.play('tick');
  }

  /** Stop before `wave` and ask for the work that charges the ship for it. */
  startBreak(wave: number, env: QuestionEnv): void {
    env.park(wave);
    const typing = !env.touch;
    let challenge: Challenge;
    if (typing) {
      // Lines get longer every two waves. The time allowed is generous enough for a beginner
      // (about 15 words a minute); a fast typist simply finishes early.
      const text = this.text(LINES[lineTier(wave, env.grade)]!);
      challenge = lineChallenge(text, clockFor(5 + text.length * 0.6, env.grade), BREAK_GRACE);
    } else {
      challenge = this.sum(wave, ROUND_SECONDS, BREAK_GRACE, env);
    }
    this.brk = {
      wave, challenge,
      total: typing ? 1 : ROUND_PROBLEMS, left: typing ? 0 : ROUND_PROBLEMS - 1,
      right: 0, earned: 0, pause: 0, counted: false, result: null, hold: 0, grade: null,
    };
    this.announce(challenge, `${wave === 1 ? 'Game started.' : `Wave ${wave - 1} cleared.`} Charge the ship for wave ${wave}.`, env);
  }

  /** Run the break. `dt` is real time: questions and their clocks are never slowed down. */
  updateBreak(dt: number, env: QuestionEnv): void {
    const b = this.brk;
    if (!b) return;
    if (b.result) {
      b.hold -= dt;
      if (b.hold <= 0) {
        this.brk = null;
        env.launch(b.wave);
      }
      return;
    }
    const c = b.challenge;
    this.clock(c, dt, env);
    if (!c.outcome) return;
    if (c.kind === 'line') {
      this.scoreBreak(b, env);
      return;
    }
    // A round of sums: leave each answer up for a moment (longer when it was wrong, to read the right one).
    if (!b.counted) {
      b.counted = true;
      b.earned += c.outcome.quality;
      if (c.outcome.success) b.right += 1;
      env.play(c.outcome.success ? 'right' : 'wrong');
      env.feel(c.outcome.success ? 'happy' : 'hurt', 1.2);
      env.celebrate(gradeOf(c)!, false);
      b.pause = c.outcome.success ? 0.7 : 1.7;
    }
    b.pause -= dt;
    if (b.pause > 0) return;
    if (b.left > 0) {
      b.left -= 1;
      b.counted = false;
      b.challenge = this.sum(b.wave, ROUND_SECONDS, 0.25, env);
      this.announce(b.challenge, c.outcome.success ? 'Correct.' : 'Not quite.', env);
    } else {
      this.scoreBreak(b, env);
    }
  }

  /** Turn the break's work into rewards: energy for how well it went, a repair for clean work. */
  private scoreBreak(b: Break, env: QuestionEnv): void {
    const o = b.challenge.outcome;
    if (!o) return;
    const typed = b.challenge.kind === 'line';
    const gain = typed ? o.quality : b.earned / b.total;
    const clean = typed ? o.success && o.accuracy >= REPAIR_ACCURACY : b.right === b.total;
    const hurt = env.hull < env.maxHull;
    const repaired = clean && hurt;
    const bonus = clean && !hurt ? FULL_HULL_BONUS : 0;
    const energy = Math.min(1, env.energy + gain);
    if (repaired) env.repair();
    env.award(bonus);
    env.charge(gain);

    const lines: Banner[] = [];
    const add = (text: string, size: number, color = SAND, alpha = 1) => lines.push({ text, size, color, alpha });
    if (typed && !o.success) {
      add('OUT OF TIME', 24);
      add(`ENERGY +${percent(gain)}%`, 13);
    } else if (typed) {
      add(`ENERGY +${percent(gain)}%`, 24);
      add(`ACCURACY ${percent(o.accuracy)}% - SPEED ${Math.round(o.wpm)} WPM`, 11, SAND, 0.85);
    } else {
      add(`${b.right} OF ${b.total} CORRECT`, 24);
      add(`ENERGY +${percent(gain)}%`, 13);
    }
    const cannons = energy > TRIPLE_AT ? 'TRIPLE CANNONS' : energy > 0 ? 'TWIN CANNONS' : '';
    if (cannons) {
      add(cannons, 13, PINK);
      env.call(cannons);
    }
    if (repaired) add('HULL REPAIRED', 11, PINK);
    else if (bonus) add(`HULL IS FULL - BONUS ${bonus}`, 11, PINK);
    else if (hurt) {
      const how = !typed ? 'ALL CORRECT REPAIRS' : o.success ? `${percent(REPAIR_ACCURACY)}% ACCURACY REPAIRS` : 'FINISHING THE LINE REPAIRS';
      add(`${how} THE HULL`, 11, SAND, 0.8);
    }
    b.result = lines;
    b.hold = 2.6;
    // A round of sums is perfect when every one was right, and failed when none was.
    b.grade = typed ? gradeOf(b.challenge)! : b.right === b.total ? 'perfect' : b.right === 0 ? 'failed' : 'good';
    env.celebrate(b.grade, true);
    if (typed && !o.success) env.play('wrong');
    if (gain > 0) env.play('power');
    env.feel(gain >= 0.5 || clean ? 'happy' : gain > 0 ? 'calm' : 'hurt', 2.2);
    if (repaired) env.play('repair');
    env.say(lines.map((l) => l.text.replace('%', ' percent').replace(' - ', ', ').toLowerCase()).join('. ') + '.');
  }

  /** Flying into a boost capsule or a bomb: time slows and one question decides what happens next. */
  startPrompt(stake: Stake, env: QuestionEnv): void {
    const roll = Math.random();
    const challenge =
      env.touch || roll < 0.4
        ? this.sum(env.wave, PROMPT_SECONDS, PROMPT_GRACE, env)
        : roll < 0.7
          ? // A bomb is do or die, so one slip of the finger on a typed answer is forgiven.
            entryChallenge(makeProblem(sumLevel(env.wave, env.grade)), clockFor(PROMPT_SECONDS, env.grade), PROMPT_GRACE, stake === 'defuse' ? 1 : 0)
          : lineChallenge(this.text(WORDS), clockFor(PROMPT_SECONDS, env.grade), PROMPT_GRACE);
    this.prompt = { stake, challenge, settled: false, fatal: false, note: '', hold: 0, offer: null, offerAge: 0 };
    env.play(stake === 'defuse' ? 'bomb' : 'capsule');
    const what = stake === 'defuse' ? 'You hit a bomb' : stake === 'upgrade' ? 'Upgrade capsule' : 'Boost capsule';
    this.announce(challenge, `${what}. Answer in ${Math.round(challenge.limit)} seconds ${STAKES[stake].goal.toLowerCase()}.`, env);
  }

  /** Run a capsule's or a bomb's question, and settle up once it is answered. `dt` is real time. */
  updatePrompt(dt: number, env: QuestionEnv): void {
    const p = this.prompt;
    if (!p) return;
    const o = p.challenge.outcome;
    if (!o) {
      this.clock(p.challenge, dt, env);
      return;
    }
    if (!p.settled) {
      p.settled = true;
      if (p.stake === 'defuse') {
        if (o.success) {
          env.award(DEFUSE_POINTS);
          p.note = `BOMB DEFUSED +${DEFUSE_POINTS}`;
          p.hold = 1;
          if (env.boss) env.taunt('defused', 'hurt', 1.5);
        } else {
          p.fatal = true;
          p.note = 'THE BOMB GOES OFF';
          p.hold = 1.7;
          if (env.boss) env.taunt('boom', 'laugh', 4);
        }
      } else if (!o.success) {
        p.note = 'CANNONS JAMMED';
        p.hold = 1.8;
        env.jam(JAM_SECONDS + p.hold);
        env.play('jam');
      } else {
        p.hold = 1;
        if (p.stake === 'upgrade') {
          const offer = offerUpgrades(env.owned);
          if (offer.length) {
            p.offer = offer;
          } else {
            env.award(ALL_OWNED_POINTS);
            p.note = `EVERY UPGRADE OWNED - BONUS ${ALL_OWNED_POINTS}`;
          }
        } else if (p.stake === 'blast') {
          env.blast();
          p.note = 'BOOM';
        } else if (p.stake === 'energy') {
          const gain = POWER_GAIN * o.quality;
          env.charge(gain);
          p.note = `POWER +${percent(gain)}%`;
        } else if (env.hull < env.maxHull) {
          env.repair();
          p.note = 'HULL REPAIRED';
        } else {
          env.award(FULL_HULL_BONUS);
          p.note = `HULL IS FULL - BONUS ${FULL_HULL_BONUS}`;
        }
      }
      env.play(o.success ? 'right' : 'wrong');
      env.feel(o.success ? 'happy' : 'hurt', 1.6);
      env.celebrate(gradeOf(p.challenge)!, true);
      // The pilot calls out what happened (a bomb about to go off leaves them speechless).
      if (p.note && !p.fatal) env.call(p.stake === 'energy' && o.success ? 'POWER UP' : p.note);
      env.say(
        p.offer
          ? `Correct. Choose an upgrade. ${p.offer.map((u, i) => `${env.touch ? 'Tap' : `Press ${i + 1} for`} ${u.name.toLowerCase()}: ${u.blurb.toLowerCase()}`).join('. ')}.`
          : `${o.success ? 'Correct.' : 'Not quite.'} ${p.note.toLowerCase().replace('%', ' percent')}.`,
      );
    }
    if (p.offer) {
      p.offerAge += dt;
      return;
    }
    p.hold -= dt;
    if (p.hold <= 0) {
      this.prompt = null;
      if (p.fatal) {
        env.explode();
        return;
      }
      env.shelter(1);
    }
  }

  /** Take one of the upgrades on offer. */
  chooseUpgrade(index: number, env: QuestionEnv): void {
    const p = this.prompt;
    const u = p?.offer?.[index];
    if (!p || !u || p.offerAge < OFFER_GRACE) return;
    env.equip(u.id);
    p.offer = null;
    p.note = `${u.name} READY`;
    p.hold = 1.3;
    env.play('power');
    env.feel('happy', 2);
    env.call(p.note);
    env.say(`${u.name.toLowerCase()} ready.`);
  }
}
