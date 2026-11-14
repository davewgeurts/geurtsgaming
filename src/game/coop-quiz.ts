/**
 * Phase 3 Co-op Per-Device Quiz Controller & Squad Mission Summary Renderer.
 *
 * Privacy & Wire Rules (`samepage.md` §3 & `/privacy/`):
 * - Each pilot's `GradeBand` (`0 | 1 | 2`) is stored strictly in memory — NEVER in `localStorage` or
 *   `sessionStorage`, and NEVER sent over WebSocket or HTTP.
 * - All math/typing generation (`LINES`, `WORDS`, `makeProblem`) runs locally on each pilot's own device
 *   at their chosen `GradeBand`; only numeric `{ id, verdict, quality }` answers cross the relay.
 */

import {
  accepts,
  choiceChallenge,
  choose,
  entryChallenge,
  lineChallenge,
  press,
  tick,
  type Challenge,
  type ChoiceChallenge,
  type LineChallenge,
} from './challenge';
import { COOP_WORLD_H, COOP_WORLD_W } from './coop-protocol';
import type { CoopDeckCardView } from './coop-thumbdeck';
import type { CoopSeatIndex } from './coop-types';
import { NEON, PINK, SAND, SOUL, clamp, pad6, percent, pick, rand, type Ink } from './core';
import { GRADE_COLOR, type Grade } from './fireworks';
import { advance, fitTo, textWidth, traceText } from './font';
import { offerBoxes, optionBoxes } from './hud';
import { boxAt } from './input';
import { LINES, WORDS } from './lines';
import { makeProblem } from './maths';
import {
  BREAK_GRACE,
  GRADE_BANDS,
  OFFER_GRACE,
  PROMPT_GRACE,
  PROMPT_SECONDS,
  ROUND_SECONDS,
  STAKES,
  clockFor,
  gradeOf,
  lineTier,
  sumLevel,
  type GradeBand,
  type Stake,
} from './questions';
import { PERSON_UP, SHIP, trace } from './shapes';
import type { Sfx } from './sound';
import { UPGRADES, type Upgrade, type UpgradeId } from './upgrades';

export type CoopStakeOrBreak = Stake | 'break';

const STAKE_CODES: Record<CoopStakeOrBreak, number> = {
  break: 0,
  hull: 1,
  energy: 2,
  blast: 3,
  upgrade: 4,
  defuse: 5,
};

const CODE_TO_STAKE: readonly CoopStakeOrBreak[] = [
  'break',
  'hull',
  'energy',
  'blast',
  'upgrade',
  'defuse',
];

export const COOP_GRADE_GRACE_SEC = 0.3;
export const COOP_BREAK_TOUCH_ROUNDS = 2;
/**
 * How long the grade picker waits. A pilot who has not picked by then loses nothing: the host closes that question
 * (CLOSE_CANCELLED) and the picker comes back with the next one. Nothing is picked for them: a band picked
 * automatically would show the squad which band that pilot was given.
 */
export const COOP_GRADE_PICK_SEC = 12;
/**
 * After COOP_GRADE_PICK_SEC the picker says nothing is lost and stops taking picks, but stays (still "picking" on the
 * wire) until the host closes the question: the host's count of picking time only advances while inputs arrive, and
 * closing early would let it go on to set off the bomb. Only if the host is gone does it close itself, this late.
 */
const COOP_GRADE_PICK_FALLBACK_SEC = 45;
/** How long an upgrade offer stays open; the host fits the first offer when it runs out. */
export const COOP_OFFER_SEC = 16;
/** Pause between the touch break's sums, after a wrong answer (the longest of the two pauses). */
const BREAK_ROUND_PAUSE_MAX = 1.1;
/** The touch break's second and later sums open after this short grace. */
const BREAK_NEXT_GRACE = 0.25;

const ALL_BANDS: readonly GradeBand[] = [0, 1, 2];

/**
 * Privacy (`/privacy/`: the grade "never leaves" the device). In co-op every band gets the same clock, the most
 * generous one any band would get, so neither the moment a question runs out nor how a sum is scored tells the
 * host or the other pilots which band a pilot picked. Nobody gets less time than their own band would.
 */
export function coopClock(seconds: number): number {
  return Math.max(...ALL_BANDS.map((band) => clockFor(seconds, band)));
}

const longestLine = (pool: readonly string[] | undefined): number =>
  (pool ?? []).reduce((longest, line) => Math.max(longest, line.length), 0);

/**
 * The typing break's lines in co-op: one pool for every band (the youngest band's), so how long a pilot takes to type
 * the line says nothing about the band they picked.
 */
export function coopBreakLines(wave: number): readonly string[] {
  return LINES[lineTier(wave, 0)] ?? [];
}

/** The typing break's clock at `wave`: the most generous clock any band would get for the longest shared line. */
export function coopBreakLineClock(wave: number): number {
  return Math.max(...ALL_BANDS.map((band) => clockFor(5 + longestLine(coopBreakLines(wave)) * 0.6, band)));
}

/**
 * The longest a pilot's own break can run on their device once its card opens: the grace before the clock starts,
 * then the typed line, or the touch sums with their graces and pauses.
 */
export function coopBreakMaxSec(wave: number): number {
  const typed = BREAK_GRACE + coopBreakLineClock(wave);
  const round = coopClock(ROUND_SECONDS) + BREAK_ROUND_PAUSE_MAX;
  const touch = BREAK_GRACE + round + (COOP_BREAK_TOUCH_ROUNDS - 1) * (BREAK_NEXT_GRACE + round);
  return Math.max(typed, touch);
}

/** The longest a mid-wave question can run on a pilot's own device: its grace, then its clock. */
export function coopStakeMaxSec(): number {
  return PROMPT_GRACE + coopClock(PROMPT_SECONDS);
}

/** Only right or wrong crosses the wire. A score scaled by a band's clock would reveal the band. */
export function verdictQuality(verdict: Grade): number {
  return verdict === 'perfect' ? 1 : verdict === 'good' ? 0.7 : 0;
}

/** Why the host closed a question on a pilot's screen: `challenge-closed` event, `values[0]`. */
export const CLOSE_TIMED_OUT = 1;
export const CLOSE_CANCELLED = 2;
export const CLOSE_BREAK_OVER = 3;
/** `values[1]` is the `UPGRADES` index the host actually fitted (or -1 when every upgrade was already owned). */
export const CLOSE_OFFER_FITTED = 4;

export function encodeStakeCode(kind: CoopStakeOrBreak): number {
  return STAKE_CODES[kind];
}

export function decodeStakeCode(code: number | undefined): CoopStakeOrBreak | null {
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code >= CODE_TO_STAKE.length) {
    return null;
  }
  return CODE_TO_STAKE[code] ?? null;
}

/** Tab-scoped in-memory grade band (never persisted, never transmitted). */
let coopTabGrade: GradeBand | null = null;

export function getCoopTabGrade(): GradeBand | null {
  return coopTabGrade;
}

export function setCoopTabGrade(grade: GradeBand | null): void {
  coopTabGrade = grade;
}

export interface CoopQuizHooks {
  play(sfx: Sfx): void;
  announce(message: string): void;
  celebrate?(grade: Grade, big: boolean): void;
  getExternalGrade?(): GradeBand | null;
  setExternalGrade?(grade: GradeBand): void;
  onChallengeSettled(id: number, kind: CoopStakeOrBreak, verdict: Grade, quality: number): void;
  onUpgradeChosen(baseId: number, slotIndex: number, upgrade: Upgrade): void;
}

interface PendingOpen {
  id: number;
  kind: CoopStakeOrBreak;
  wave: number;
  /** Seconds the host still allows, when it asked again after a reconnect (the clock starts from there). */
  remaining?: number;
}

type LocalQuizState =
  | {
      stage: 'grade';
      age: number;
      next: PendingOpen;
    }
  | {
      stage: 'stake';
      id: number;
      stake: Stake;
      wave: number;
      challenge: Challenge;
      settled: boolean;
      note: string;
      noteColor: string;
      hold: number;
    }
  | {
      stage: 'break';
      id: number;
      wave: number;
      challenge: Challenge;
      total: number;
      left: number;
      right: number;
      earned: number;
      pause: number;
      counted: boolean;
      done: boolean;
      headline: string;
      subline: string;
      hold: number;
    }
  | {
      stage: 'offer';
      baseId: number;
      upgrades: Upgrade[];
      age: number;
    }
  | {
      stage: 'result';
      headline: string;
      subline: string;
      color: string;
      hold: number;
    };

export class CoopLocalQuizController {
  private readonly isolatedGrade: boolean;
  private localGrade: GradeBand | null;
  private inputMode: 'keys' | 'touch';
  private active: LocalQuizState | null = null;
  private lastText = '';
  private readonly handledIds = new Set<number>();
  /** The upgrade offer this pilot just picked from, until the host says what it really fitted. */
  private awaitingOfferBase: number | null = null;
  /** Questions this screen settled lately, so a host's "too late" still shows after the card has gone. */
  private readonly recentSettled = new Map<number, { stake: Stake; ok: boolean }>();
  /** A break card that arrived while a result was still showing: it opens when the result's hold ends. */
  private queuedBreak: { id: number; wave: number } | null = null;

  constructor(opts: {
    isolatedGrade: boolean;
    initialGrade?: GradeBand | null;
    initialInputMode?: 'keys' | 'touch';
  }) {
    this.isolatedGrade = opts.isolatedGrade;
    this.localGrade =
      opts.initialGrade !== undefined
        ? opts.initialGrade
        : opts.isolatedGrade
          ? null
          : coopTabGrade;
    this.inputMode = opts.initialInputMode ?? 'keys';
  }

  getGrade(external?: () => GradeBand | null): GradeBand | null {
    if (this.localGrade !== null) return this.localGrade;
    if (!this.isolatedGrade) {
      if (coopTabGrade !== null) {
        this.localGrade = coopTabGrade;
        return coopTabGrade;
      }
      const ext = external?.() ?? null;
      if (ext !== null) {
        this.localGrade = ext;
        coopTabGrade = ext;
        return ext;
      }
    }
    return null;
  }

  setGrade(grade: GradeBand | null, setExternal?: (g: GradeBand) => void): void {
    this.localGrade = grade;
    if (!this.isolatedGrade) {
      coopTabGrade = grade;
      if (grade !== null) setExternal?.(grade);
    }
  }

  setInputMode(mode: 'keys' | 'touch'): void {
    this.inputMode = mode;
  }

  get activeChallenge(): Challenge | null {
    if (!this.active) return null;
    if (this.active.stage === 'stake') return this.active.settled ? null : this.active.challenge;
    if (this.active.stage === 'break') return this.active.done ? null : this.active.challenge;
    return null;
  }

  get stage(): LocalQuizState['stage'] | null {
    return this.active?.stage ?? null;
  }

  isOpen(): boolean {
    return this.active !== null;
  }

  isInteractive(): boolean {
    if (!this.active) return false;
    if (this.active.stage === 'grade' || this.active.stage === 'offer') return true;
    if (this.active.stage === 'stake') return !this.active.settled;
    if (this.active.stage === 'break') return !this.active.done;
    return false;
  }

  clearActive(clearHandled = false): void {
    this.active = null;
    this.awaitingOfferBase = null;
    this.queuedBreak = null;
    if (clearHandled) {
      this.handledIds.clear();
      this.recentSettled.clear();
    }
  }

  /** The pilot tapped a card that only shows a result: put it away. A pending upgrade reply still shows when it comes. */
  dismissCard(): void {
    if (this.active && !this.isInteractive()) this.active = null;
  }

  /**
   * The host asked again with `seconds` left (after a reconnect): this screen's clock for that question must not run
   * past the host's.
   */
  limitClock(id: number, seconds: number): void {
    const st = this.active;
    if (!Number.isFinite(seconds)) return;
    const left = Math.max(1, seconds);
    if (st?.stage === 'grade' && st.next.id === id) {
      st.next.remaining = left;
    } else if (st?.stage === 'stake' && st.id === id && !st.settled) {
      st.challenge.timeLeft = Math.min(st.challenge.timeLeft, left);
    }
  }

  /** True while the grade picker is up. The host holds this pilot's question clock until a grade is picked. */
  isPickingGrade(): boolean {
    return this.active?.stage === 'grade';
  }

  /** The squad is flying again: a break card still on screen (unanswered, or standing by) is over. */
  closeBreakCard(): void {
    this.queuedBreak = null;
    const st = this.active;
    if (st?.stage === 'break') {
      this.handledIds.add(st.id);
      this.active = null;
    } else if (st?.stage === 'grade' && st.next.kind === 'break') {
      this.handledIds.add(st.next.id);
      this.active = null;
    }
  }

  /**
   * The host closed question `id` (or the offer starting at `id`) on this pilot's screen. Whatever this screen
   * shows next must match what the host decided, because the host's decision is what happened in the squad.
   */
  hostClosed(id: number, code: number, extra: number | null, useThumbDeck: boolean, hooks: CoopQuizHooks): void {
    this.handledIds.add(id);
    if (this.queuedBreak?.id === id) this.queuedBreak = null;
    const st = this.active;
    const hold = useThumbDeck ? 0.9 : 1.4;

    if (code === CLOSE_OFFER_FITTED) {
      const ours =
        (st?.stage === 'offer' && st.baseId === id) ||
        (this.awaitingOfferBase === id && (st === null || st.stage === 'result'));
      if (!ours) return;
      const wasOpen = st?.stage === 'offer';
      this.awaitingOfferBase = null;
      const fitted = extra !== null && extra >= 0 ? UPGRADES[extra] : undefined;
      this.active = {
        stage: 'result',
        headline: fitted ? `${fitted.name} EQUIPPED!` : 'SQUAD FULLY UPGRADED',
        subline: wasOpen ? 'PICKED FOR YOU - TIME RAN OUT' : 'ACTIVE FOR ALL SQUAD PILOTS',
        color: NEON.lime,
        hold,
      };
      const name = fitted?.name.toLowerCase();
      hooks.announce(
        !fitted
          ? 'The squad already has every upgrade.'
          : wasOpen
            ? `Time ran out, so ${name} was picked for you. It is equipped for the squad.`
            : `${name} equipped for the squad.`,
      );
      return;
    }

    const matches =
      st !== null &&
      (((st.stage === 'stake' || st.stage === 'break') && st.id === id) || (st.stage === 'grade' && st.next.id === id));
    if (!st || !matches) {
      // The card has gone, after this screen showed a right answer that reached the host too late.
      const settled = this.recentSettled.get(id);
      if (code === CLOSE_TIMED_OUT && settled?.ok && (st === null || st.stage === 'result')) {
        this.recentSettled.delete(id);
        this.showTooLate(settled.stake, hold, hooks);
      }
      return;
    }

    if (st.stage === 'grade' && code === CLOSE_CANCELLED) {
      this.showNoLevelPicked(id, useThumbDeck, hooks);
      return;
    }

    if (code === CLOSE_TIMED_OUT && (st.stage === 'stake' || (st.stage === 'grade' && st.next.kind !== 'break'))) {
      const stake = st.stage === 'stake' ? st.stake : (st.next.kind as Stake);
      if (st.stage === 'stake' && st.settled) {
        this.recentSettled.delete(id);
        this.showTooLate(stake, hold, hooks);
        return;
      }
      this.active = {
        stage: 'result',
        headline: "TIME'S UP",
        subline: stake === 'defuse' ? 'THE BOMB WENT OFF' : 'CANNONS JAMMED',
        color: stake === 'defuse' ? NEON.red : PINK,
        hold,
      };
      hooks.play('wrong');
      hooks.announce(`Time's up. ${stake === 'defuse' ? 'The bomb went off' : 'Cannons jammed'}.`);
      return;
    }

    if (code === CLOSE_BREAK_OVER || code === CLOSE_TIMED_OUT) {
      // The break ended for the whole squad; an answer still on this screen no longer counts.
      if (st.stage !== 'break' || !st.done) hooks.announce('The break is over.');
      this.active = null;
      return;
    }

    // CLOSE_CANCELLED, or anything newer this build does not know: close the card.
    if (st.stage === 'stake' && !st.settled) hooks.announce('That question was closed.');
    this.active = null;
  }

  /** A break card that waited behind a note opens now, if the squad is still on its break. */
  private openQueuedBreak(squadParked: boolean, useThumbDeck: boolean, hooks: CoopQuizHooks): void {
    const queued = this.queuedBreak;
    this.queuedBreak = null;
    if (queued && squadParked) this.openChallenge(queued.id, 'break', queued.wave, useThumbDeck, hooks);
  }

  /** The host decided an answer this screen showed as right came too late. */
  private showTooLate(stake: Stake, hold: number, hooks: CoopQuizHooks): void {
    this.active = {
      stage: 'result',
      headline: 'TOO LATE',
      subline: stake === 'defuse' ? 'THE BOMB WENT OFF' : 'CANNONS JAMMED',
      color: stake === 'defuse' ? NEON.red : PINK,
      hold,
    };
    hooks.play('wrong');
    hooks.announce(`Too late. ${stake === 'defuse' ? 'The bomb went off' : 'Cannons jammed'}.`);
  }

  /** The grade picker ran out: nothing is lost, and it comes back with the next question. */
  /**
   * The host's snapshots show this pilot no longer answering. Past the picker's own window that means the host closed
   * the question: if its message to say so was lost, close the picker here rather than wait out the fallback (picks
   * are refused by then anyway, and an open picker stops this pilot firing).
   */
  hostShowsNotAnswering(useThumbDeck: boolean, hooks: CoopQuizHooks): void {
    const st = this.active;
    if (st?.stage === 'grade' && st.age >= COOP_GRADE_PICK_SEC + 1) this.showNoLevelPicked(st.next.id, useThumbDeck, hooks);
  }

  private showNoLevelPicked(id: number, useThumbDeck: boolean, hooks: CoopQuizHooks): void {
    this.handledIds.add(id);
    this.active = {
      stage: 'result',
      headline: 'NO LEVEL PICKED',
      subline: 'NOTHING LOST - PICK ONE NEXT TIME',
      color: SAND,
      hold: useThumbDeck ? 0.9 : 1.4,
    };
    hooks.announce('No level picked. Nothing is lost. You can pick one with the next question.');
  }

  openChallenge(
    id: number,
    kind: CoopStakeOrBreak,
    wave: number,
    useThumbDeck: boolean,
    hooks: CoopQuizHooks,
  ): boolean {
    if (this.handledIds.has(id)) return false;
    if (
      this.active &&
      ((this.active.stage === 'stake' && this.active.id === id) ||
        (this.active.stage === 'break' && this.active.id === id) ||
        (this.active.stage === 'grade' && this.active.next.id === id))
    ) {
      return false;
    }
    const showing = this.active;
    if (
      kind === 'break' &&
      showing &&
      ((showing.stage === 'result' && showing.hold > 0) || (showing.stage === 'stake' && showing.settled))
    ) {
      // Let "BOMB DEFUSED +300" or "X EQUIPPED!" be read first; the break card opens when that note's moment is over.
      if (this.queuedBreak?.id === id) return false;
      this.queuedBreak = { id, wave };
      return true;
    }

    const grade = this.getGrade(hooks.getExternalGrade);
    if (grade === null) {
      this.active = {
        stage: 'grade',
        age: 0,
        next: { id, kind, wave },
      };
      const touch = useThumbDeck || this.inputMode === 'touch';
      const how = touch ? 'Tap' : 'Press';
      hooks.announce(
        `What grade are you in? ${GRADE_BANDS.map((band, i) => `${how}${touch ? '' : ` ${i + 1} for`} ${band.spoken}`).join('. ')}. ` +
          `Only this device knows. This closes in ${COOP_GRADE_PICK_SEC} seconds.`,
      );
      return true;
    }

    this.launchChallengeWithGrade(id, kind, wave, grade, useThumbDeck, hooks);
    return true;
  }

  openUpgradeOffer(baseId: number, upgradeIndices: readonly number[], hooks: CoopQuizHooks): boolean {
    if (this.handledIds.has(baseId)) return false;
    if (this.active && this.active.stage === 'offer' && this.active.baseId === baseId) return false;
    const upgrades: Upgrade[] = [];
    for (const idx of upgradeIndices) {
      const u = UPGRADES[idx];
      if (u && !upgrades.includes(u)) upgrades.push(u);
    }
    if (upgrades.length === 0) return false;
    this.active = {
      stage: 'offer',
      baseId,
      upgrades,
      age: 0,
    };
    const touch = this.inputMode === 'touch';
    hooks.announce(
      `Correct. Choose an upgrade for the squad. ${upgrades.map((u, i) => `${touch ? 'Tap' : `Press ${i + 1} for`} ${u.name.toLowerCase()}: ${u.blurb.toLowerCase()}`).join('. ')}.`,
    );
    return true;
  }

  step(dt: number, useThumbDeck: boolean, squadParked: boolean, hooks: CoopQuizHooks): void {
    const st = this.active;
    if (!st) return;

    if (st.stage === 'grade') {
      st.age += dt;
      // The host closes the question when the picker runs out (COOP_GRADE_PICK_SEC); this is only a fallback.
      if (st.age >= COOP_GRADE_PICK_FALLBACK_SEC) this.showNoLevelPicked(st.next.id, useThumbDeck, hooks);
      return;
    }

    if (st.stage === 'offer') {
      st.age += dt;
      // The host fits the first offer when its own clock runs out and says so; this is only a fallback.
      if (st.age >= COOP_OFFER_SEC + 3) {
        this.handledIds.add(st.baseId);
        this.active = null;
      }
      return;
    }

    if (st.stage === 'result') {
      st.hold -= dt;
      if (st.hold <= 0) {
        this.active = null;
        this.openQueuedBreak(squadParked, useThumbDeck, hooks);
      }
      return;
    }

    if (st.stage === 'stake') {
      const c = st.challenge;
      if (!c.outcome) {
        this.advanceClock(c, dt, hooks);
        if (!c.outcome) return;
      }
      if (!st.settled) {
        st.settled = true;
        this.handledIds.add(st.id);
        const verdict = gradeOf(c) ?? 'failed';
        const ok = c.outcome.success;
        const quality = verdictQuality(verdict);
        this.recentSettled.set(st.id, { stake: st.stake, ok });
        while (this.recentSettled.size > 8) this.recentSettled.delete(this.recentSettled.keys().next().value as number);

        if (st.stake === 'defuse') {
          st.note = ok ? 'BOMB DEFUSED +300' : 'THE BOMB GOES OFF!';
          st.noteColor = ok ? NEON.lime : NEON.red;
        } else if (!ok) {
          st.note = 'CANNONS JAMMED';
          st.noteColor = PINK;
          hooks.play('jam');
        } else if (st.stake === 'upgrade') {
          st.note = 'CORRECT - PREPARING UPGRADES';
          st.noteColor = NEON.lime;
        } else if (st.stake === 'blast') {
          st.note = 'SCREEN BLAST!';
          st.noteColor = NEON.orange;
        } else if (st.stake === 'energy') {
          st.note = 'SQUAD POWER UP!';
          st.noteColor = NEON.cyan;
        } else {
          st.note = 'SQUAD HULL REPAIRED!';
          st.noteColor = NEON.lime;
        }
        st.hold = useThumbDeck ? 0.55 : 0.95;
        hooks.play(ok ? 'right' : 'wrong');
        hooks.celebrate?.(verdict, true);
        hooks.announce(`${ok ? 'Correct.' : 'Not quite.'} ${st.note.toLowerCase()}.`);

        // Note: `onChallengeSettled` may immediately call `openUpgradeOffer`, replacing `this.active`!
        hooks.onChallengeSettled(st.id, st.stake, verdict, quality);
        return;
      }
      st.hold -= dt;
      if (st.hold <= 0) {
        this.active = null;
        this.openQueuedBreak(squadParked, useThumbDeck, hooks);
      }
      return;
    }

    // `st.stage === 'break'`
    if (st.done) {
      st.hold -= dt;
      if (!squadParked && st.hold <= 0) {
        this.active = null;
      }
      return;
    }

    const c = st.challenge;
    this.advanceClock(c, dt, hooks);
    if (!c.outcome) return;

    if (c.kind === 'line') {
      this.finishLocalBreak(st, hooks);
      return;
    }

    if (!st.counted) {
      st.counted = true;
      st.earned += c.outcome.quality;
      if (c.outcome.success) st.right += 1;
      hooks.play(c.outcome.success ? 'right' : 'wrong');
      hooks.celebrate?.(gradeOf(c) ?? 'failed', false);
      st.pause = c.outcome.success ? 0.45 : 1.1;
    }
    st.pause -= dt;
    if (st.pause > 0) return;

    if (st.left > 0) {
      const grade = this.getGrade(hooks.getExternalGrade) ?? 1;
      st.left -= 1;
      st.counted = false;
      st.challenge = this.makeChoiceSum(st.wave, ROUND_SECONDS, BREAK_NEXT_GRACE, grade);
    } else {
      this.finishLocalBreak(st, hooks);
    }
  }

  wantsKey(key: string): boolean {
    const st = this.active;
    if (!st) return false;
    if (st.stage === 'grade') {
      return key.length === 1 && key >= '1' && key <= String(GRADE_BANDS.length);
    }
    if (st.stage === 'offer') {
      return key.length === 1 && key >= '1' && key <= String(st.upgrades.length);
    }
    const c = this.activeChallenge;
    return Boolean(c && accepts(c, key));
  }

  typeKey(key: string, useThumbDeck: boolean, hooks: CoopQuizHooks): boolean {
    this.inputMode = 'keys';
    const st = this.active;
    if (!st) return false;

    // In the short grace before a pick counts (so a key still held from the last answer cannot pick), a key gets the
    // wrong-key sound instead of nothing: the card is not ready yet, and silence looks broken.
    if (st.stage === 'grade') {
      if (st.age < COOP_GRADE_GRACE_SEC) {
        hooks.play('slip');
        return true;
      }
      return this.selectGrade(Number(key) - 1, useThumbDeck, hooks);
    }

    if (st.stage === 'offer') {
      if (st.age < OFFER_GRACE) {
        hooks.play('slip');
        return true;
      }
      return this.selectUpgrade(Number(key) - 1, useThumbDeck, hooks);
    }

    const c = this.activeChallenge;
    if (!c || !accepts(c, key)) return false;

    const before = c.kind === 'line' ? c.index : c.kind === 'entry' ? c.typed.length : 0;
    const misses = c.kind === 'choice' ? 0 : c.misses;
    press(c, key);
    if (c.kind === 'line') {
      if (c.index > before) hooks.play('key');
      else if (c.misses > misses) hooks.play('slip');
    } else if (c.kind === 'entry' && c.misses > misses) {
      hooks.play('slip');
      hooks.announce(`Not quite. One more try. What is ${c.question}?`);
    } else if (c.kind === 'entry' && c.typed.length !== before) {
      hooks.play('key');
    }
    return true;
  }

  onTouchDetected(useThumbDeck: boolean, hooks: CoopQuizHooks): void {
    this.inputMode = 'touch';
    const st = this.active;
    if (!st) return;
    const grade = this.getGrade(hooks.getExternalGrade) ?? 1;
    if (st.stage === 'stake' && !st.settled && st.challenge.kind !== 'choice' && !st.challenge.outcome) {
      st.challenge = this.makeChoiceSum(st.wave, PROMPT_SECONDS, PROMPT_GRACE, grade);
    } else if (st.stage === 'break' && !st.done && st.challenge.kind === 'line' && !st.challenge.outcome) {
      st.challenge = this.makeChoiceSum(st.wave, ROUND_SECONDS, BREAK_GRACE, grade);
      st.total = COOP_BREAK_TOUCH_ROUNDS;
      st.left = COOP_BREAK_TOUCH_ROUNDS - 1;
      st.right = 0;
      st.earned = 0;
      st.counted = false;
    }
    void useThumbDeck;
  }

  pickArena(arenaX: number, arenaY: number, useThumbDeck: boolean, hooks: CoopQuizHooks): boolean {
    if (useThumbDeck || !this.active) return false;
    const room = COOP_WORLD_W - 64;
    const st = this.active;

    if (st.stage === 'grade') {
      const top = 300;
      const hit = boxAt(arenaX, arenaY, offerBoxes(COOP_WORLD_W, COOP_WORLD_H, room, top, GRADE_BANDS.length));
      if (hit !== null) {
        this.selectGrade(hit, false, hooks);
        return true;
      }
      return false;
    }

    if (st.stage === 'offer') {
      const top = 220;
      const hit = boxAt(arenaX, arenaY, offerBoxes(COOP_WORLD_W, COOP_WORLD_H, room, top, st.upgrades.length));
      if (hit !== null) {
        this.selectUpgrade(hit, false, hooks);
        return true;
      }
      return false;
    }

    const c = this.activeChallenge;
    if (c && c.kind === 'choice' && !c.outcome) {
      const top = st.stage === 'break' ? 320 : 210;
      const hit = boxAt(arenaX, arenaY, optionBoxes(COOP_WORLD_W, room, c.options.length, top));
      if (hit !== null) {
        choose(c, hit);
        return true;
      }
    }
    return false;
  }

  deckCard(useThumbDeck: boolean): CoopDeckCardView | null {
    if (!useThumbDeck || !this.active) return null;
    const st = this.active;

    if (st.stage === 'grade') {
      return {
        kind: 'grade',
        interactive: st.age >= COOP_GRADE_GRACE_SEC && st.age < COOP_GRADE_PICK_SEC,
        timeLeft: Math.max(0, COOP_GRADE_PICK_SEC - st.age),
        timeLimit: COOP_GRADE_PICK_SEC,
      };
    }

    if (st.stage === 'offer') {
      return {
        kind: 'offer',
        upgrades: st.upgrades,
        interactive: st.age >= OFFER_GRACE,
      };
    }

    if (st.stage === 'result') {
      return {
        kind: 'result',
        headline: st.headline,
        subline: st.subline,
        color: st.color,
      };
    }

    if (st.stage === 'stake') {
      // Ensure choice challenge on thumb deck
      if (st.challenge.kind !== 'choice') {
        const grade = this.getGrade() ?? 1;
        st.challenge = this.makeChoiceSum(st.wave, PROMPT_SECONDS, PROMPT_GRACE, grade);
      }
      const c = st.challenge;
      return {
        kind: 'choice',
        title: `SOLVE ${STAKES[st.stake].goal}`,
        titleColor: st.stake === 'defuse' ? NEON.red : NEON.yellow,
        question: c.question,
        options: c.options,
        correctIndex: c.correct,
        pickedIndex: c.picked,
        done: c.outcome !== null,
        interactive: c.outcome === null && c.age >= c.grace,
        timeLeft: c.timeLeft,
        timeLimit: c.limit,
        note: st.note,
        noteColor: st.noteColor || SAND,
      };
    }

    // `st.stage === 'break'`
    if (st.done) {
      return {
        kind: 'result',
        headline: st.headline,
        subline: st.subline,
        color: NEON.cyan,
      };
    }
    if (st.challenge.kind !== 'choice') {
      const grade = this.getGrade() ?? 1;
      st.challenge = this.makeChoiceSum(st.wave, ROUND_SECONDS, BREAK_GRACE, grade);
      st.total = COOP_BREAK_TOUCH_ROUNDS;
      st.left = COOP_BREAK_TOUCH_ROUNDS - 1;
    }
    const c = st.challenge;
    return {
      kind: 'choice',
      title: `CHARGE FOR WAVE ${st.wave} - ${st.total - st.left}/${st.total}`,
      titleColor: NEON.cyan,
      question: c.question,
      options: c.options,
      correctIndex: c.correct,
      pickedIndex: c.picked,
      done: c.outcome !== null,
      interactive: c.outcome === null && c.age >= c.grace,
      timeLeft: c.timeLeft,
      timeLimit: c.limit,
      note: '',
      noteColor: SAND,
    };
  }

  pickDeckCard(optionIndex: number, useThumbDeck: boolean, hooks: CoopQuizHooks): boolean {
    if (!this.active) return false;
    this.inputMode = 'touch';
    const st = this.active;

    if (st.stage === 'grade') {
      return this.selectGrade(optionIndex, useThumbDeck, hooks);
    }
    if (st.stage === 'offer') {
      return this.selectUpgrade(optionIndex, useThumbDeck, hooks);
    }
    const c = this.activeChallenge;
    if (c && c.kind === 'choice' && !c.outcome) {
      choose(c, optionIndex);
      return c.outcome !== null;
    }
    return false;
  }

  renderArenaQuiz(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    time: number,
    reduceMotion: boolean,
    useThumbDeck: boolean,
  ): void {
    if (useThumbDeck || !this.active) return;
    const st = this.active;
    const w = COOP_WORLD_W;
    const h = COOP_WORLD_H;
    const room = w - 64;
    const cx = w / 2;

    if (st.stage === 'grade') {
      const top = 300;
      const alpha = Math.min(1, Math.max(0.2, st.age / 0.3));
      this.drawBackdropCard(ctx, ink, cx, top - 44, 520, 272, NEON.cyan, alpha);
      this.drawCentred(ctx, ink, 'WHAT GRADE ARE YOU IN, PILOT?', cx, top - 26, 15, room, alpha, NEON.cyan);
      this.drawCentred(
        ctx,
        ink,
        'IT SETS HOW HARD YOUR QUESTIONS ARE. IT IS NOT SAVED.',
        cx,
        top,
        8.5,
        room,
        alpha * 0.78,
        SAND,
      );
      offerBoxes(w, h, room, top, GRADE_BANDS.length).forEach((b, i) => {
        const band = GRADE_BANDS[i]!;
        const big = fitTo(band.label, b.h > 50 ? 15 : 13, b.w * 0.6);
        ink(SAND, alpha, 1.6, () => ctx.rect(b.x, b.y, b.w, b.h));
        ink(SAND, alpha, 1.8, () =>
          traceText(ctx, band.label, b.x + (this.inputMode === 'keys' ? 34 : 16), b.y + (b.h - big) / 2, big),
        );
        ink(
          NEON.cyan,
          alpha * 0.9,
          1.2,
          () => traceText(ctx, band.ages, b.x + b.w - 14, b.y + (b.h - 9) / 2, 9, 'right'),
          false,
        );
        if (this.inputMode === 'keys') {
          ink(SAND, alpha * 0.6, 1.2, () => traceText(ctx, String(i + 1), b.x + 12, b.y + (b.h - 9) / 2, 9), false);
        }
      });
      const left = Math.max(0, Math.ceil(COOP_GRADE_PICK_SEC - st.age));
      const note = left > 0 ? `CLOSES IN ${left} - NOTHING LOST` : 'NO LEVEL PICKED - NOTHING LOST';
      this.drawCentred(ctx, ink, note, cx, top + 214, 8, room, alpha * 0.7, SAND);
      return;
    }

    if (st.stage === 'offer') {
      const top = 220;
      const alpha = Math.min(1, Math.max(0.2, st.age / 0.25));
      const boxes = offerBoxes(w, h, room, top, st.upgrades.length);
      const cardH = 74 + st.upgrades.length * 64;
      this.drawBackdropCard(ctx, ink, cx, top - 22, 500, cardH, NEON.lime, alpha);
      this.drawCentred(ctx, ink, 'CORRECT - CHOOSE A SQUAD UPGRADE', cx, top, 13, room, alpha, NEON.lime);
      boxes.forEach((b, i) => {
        const u = st.upgrades[i]!;
        const textX = b.x + b.h + 10;
        const avail = b.w - b.h - 22;
        const nameSize = fitTo(u.name, 13, avail);
        ink(SAND, alpha * 0.9, 1.4, () => ctx.rect(b.x, b.y, b.w, b.h));
        ink(NEON.lime, alpha, 1.6, () => {
          trace(ctx, u.icon, b.x + 4 + b.h / 2, b.y + b.h / 2, b.h / 40, 0);
          traceText(ctx, u.name, textX, b.y + b.h / 2 - nameSize - 2, nameSize);
        });
        ink(
          SAND,
          alpha * 0.82,
          1.1,
          () => traceText(ctx, u.blurb, textX, b.y + b.h / 2 + 6, fitTo(u.blurb, 8.5, avail)),
          false,
        );
        if (this.inputMode === 'keys') {
          ink(SAND, alpha * 0.6, 1, () => traceText(ctx, String(i + 1), b.x + b.w - 8, b.y + 6, 8, 'right'), false);
        }
      });
      const last = boxes[boxes.length - 1];
      if (last) {
        this.drawCentred(
          ctx,
          ink,
          this.inputMode === 'keys' ? 'CLICK ONE OR PRESS ITS NUMBER' : 'TAP ONE FOR THE WHOLE SQUAD',
          cx,
          last.y + last.h + 12,
          8.5,
          room,
          alpha * 0.7,
          SAND,
        );
      }
      return;
    }

    if (st.stage === 'result') {
      const top = 250;
      const alpha = Math.min(1, st.hold / 0.3);
      this.drawBackdropCard(ctx, ink, cx, top - 18, 440, 88, st.color, alpha);
      this.drawCentred(ctx, ink, st.headline, cx, top + 6, 18, room, alpha, st.color);
      if (st.subline) {
        this.drawCentred(ctx, ink, st.subline, cx, top + 38, 10, room, alpha * 0.85, SAND);
      }
      return;
    }

    if (st.stage === 'break' && st.done) {
      const top = 320;
      const alpha = 0.95;
      this.drawBackdropCard(ctx, ink, cx, top - 24, 520, 120, NEON.cyan, alpha);
      this.drawCentred(ctx, ink, st.headline, cx, top + 6, 20, room, alpha, NEON.lime);
      this.drawCentred(ctx, ink, st.subline, cx, top + 42, 11, room, alpha * 0.9, NEON.cyan);
      return;
    }

    const isBreak = st.stage === 'break';
    const top = isBreak ? 320 : 210;
    const c = st.challenge;
    const alpha = Math.min(1, Math.max(0.25, c.age / 0.25));
    const title = isBreak
      ? c.kind === 'line'
        ? `TYPE TO CHARGE SQUAD FOR WAVE ${st.wave}`
        : `SOLVE TO CHARGE SQUAD - ${st.total - st.left} OF ${st.total}`
      : `${c.kind === 'line' ? 'TYPE' : 'SOLVE'} ${STAKES[st.stake].goal}`;
    const titleColor = !isBreak && st.stake === 'defuse' ? NEON.red : NEON.yellow;

    this.drawBackdropCard(ctx, ink, cx, top - 42, Math.min(room + 20, 620), 236, titleColor, alpha);
    this.renderArenaChallenge(ctx, ink, c, top, title, titleColor, alpha, time, reduceMotion, room);

    if (st.stage === 'stake' && st.settled && st.note) {
      this.drawCentred(ctx, ink, st.note, cx, top + 174, 13, room, 1, st.noteColor || PINK);
    }
  }

  // ------------------------------------------------------------------ helpers

  private selectGrade(index: number, useThumbDeck: boolean, hooks: CoopQuizHooks): boolean {
    const st = this.active;
    if (!st || st.stage !== 'grade' || st.age < COOP_GRADE_GRACE_SEC || st.age >= COOP_GRADE_PICK_SEC) return false;
    if (!GRADE_BANDS[index]) return false;
    const band = index as GradeBand;
    this.setGrade(band, hooks.setExternalGrade);
    hooks.play('power');
    this.launchChallengeWithGrade(st.next.id, st.next.kind, st.next.wave, band, useThumbDeck, hooks);
    const launched = this.active;
    if (st.next.remaining !== undefined && launched?.stage === 'stake') {
      launched.challenge.timeLeft = Math.min(launched.challenge.timeLeft, st.next.remaining);
    }
    return true;
  }

  private selectUpgrade(index: number, useThumbDeck: boolean, hooks: CoopQuizHooks): boolean {
    const st = this.active;
    if (!st || st.stage !== 'offer' || st.age < OFFER_GRACE) return false;
    const chosen = st.upgrades[index];
    if (!chosen) return false;
    this.handledIds.add(st.baseId);
    // Shown at once; the host's `challenge-closed` replaces it with what was really fitted (another pilot may
    // have taken the same upgrade a moment earlier).
    this.awaitingOfferBase = st.baseId;
    hooks.play('power');
    this.active = {
      stage: 'result',
      headline: `${chosen.name} CHOSEN`,
      subline: 'FITTING IT FOR THE SQUAD',
      color: NEON.lime,
      hold: useThumbDeck ? 0.9 : 1.4,
    };
    hooks.announce(`${chosen.name.toLowerCase()} chosen. Fitting it for the squad.`);
    hooks.onUpgradeChosen(st.baseId, index, chosen);
    return true;
  }

  private launchChallengeWithGrade(
    id: number,
    kind: CoopStakeOrBreak,
    wave: number,
    grade: GradeBand,
    useThumbDeck: boolean,
    hooks: CoopQuizHooks,
  ): void {
    const touch = useThumbDeck || this.inputMode === 'touch';

    if (kind === 'break') {
      let challenge: Challenge;
      if (!touch) {
        const text = this.pickDistinctText(coopBreakLines(wave));
        challenge = lineChallenge(text, coopBreakLineClock(wave), BREAK_GRACE);
      } else {
        challenge = this.makeChoiceSum(wave, ROUND_SECONDS, BREAK_GRACE, grade);
      }
      this.active = {
        stage: 'break',
        id,
        wave,
        challenge,
        total: touch ? COOP_BREAK_TOUCH_ROUNDS : 1,
        left: touch ? COOP_BREAK_TOUCH_ROUNDS - 1 : 0,
        right: 0,
        earned: 0,
        pause: 0,
        counted: false,
        done: false,
        headline: '',
        subline: '',
        hold: 0,
      };
      hooks.announce(`Charge the squad for wave ${wave}.`);
      return;
    }

    const roll = Math.random();
    const challenge: Challenge =
      touch || roll < 0.4
        ? this.makeChoiceSum(wave, PROMPT_SECONDS, PROMPT_GRACE, grade)
        : roll < 0.7
          ? entryChallenge(
              makeProblem(sumLevel(wave, grade)),
              coopClock(PROMPT_SECONDS),
              PROMPT_GRACE,
              kind === 'defuse' ? 1 : 0,
            )
          : lineChallenge(this.pickDistinctText(WORDS), coopClock(PROMPT_SECONDS), PROMPT_GRACE);

    this.active = {
      stage: 'stake',
      id,
      stake: kind,
      wave,
      challenge,
      settled: false,
      note: '',
      noteColor: SAND,
      hold: 0,
    };
    hooks.play(kind === 'defuse' ? 'bomb' : 'capsule');
    const what = kind === 'defuse' ? 'Bomb alert' : kind === 'upgrade' ? 'Upgrade capsule' : 'Boost capsule';
    hooks.announce(`${what}. ${STAKES[kind].goal.toLowerCase()}.`);
  }

  private finishLocalBreak(st: Extract<LocalQuizState, { stage: 'break' }>, hooks: CoopQuizHooks): void {
    const o = st.challenge.outcome;
    if (!o || st.done) return;
    st.done = true;
    this.handledIds.add(st.id);

    const typed = st.challenge.kind === 'line';
    const verdict: Grade = typed
      ? (gradeOf(st.challenge) ?? 'failed')
      : st.right === st.total
        ? 'perfect'
        : st.right === 0
          ? 'failed'
          : 'good';
    const quality = verdictQuality(verdict);

    st.headline = `SQUAD CHARGE +${percent(quality)}%`;
    st.subline = `READY FOR WAVE ${st.wave} - STANDING BY FOR WINGMEN`;
    st.hold = 0.8;
    hooks.play(verdict === 'failed' ? 'wrong' : 'power');
    hooks.celebrate?.(verdict, true);
    hooks.onChallengeSettled(st.id, 'break', verdict, quality);
  }

  private makeChoiceSum(wave: number, seconds: number, grace: number, grade: GradeBand): ChoiceChallenge {
    return choiceChallenge(makeProblem(sumLevel(wave, grade)), coopClock(seconds), grace);
  }

  private pickDistinctText(pool: readonly string[]): string {
    let text = pick(pool);
    if (text === this.lastText && pool.length > 1) {
      text = pool[(pool.indexOf(text) + 1) % pool.length]!;
    }
    this.lastText = text;
    return text;
  }

  private advanceClock(c: Challenge, dt: number, hooks: CoopQuizHooks): void {
    const before = Math.ceil(c.timeLeft);
    tick(c, dt);
    const left = Math.ceil(c.timeLeft);
    if (!c.outcome && left < before && left <= 3) {
      hooks.play('tick');
    }
  }

  private drawBackdropCard(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    cx: number,
    y: number,
    w: number,
    h: number,
    borderColor: string,
    alpha: number,
  ): void {
    ctx.fillStyle = `rgba(4, 10, 36, ${(0.86 * alpha).toFixed(3)})`;
    ctx.fillRect(cx - w / 2, y, w, h);
    ink(borderColor, 0.72 * alpha, 1.5, () => {
      ctx.rect(cx - w / 2, y, w, h);
    });
  }

  private drawCentred(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    text: string,
    cx: number,
    y: number,
    size: number,
    room: number,
    alpha: number,
    color: string,
  ): void {
    const fitted = fitTo(text, size, room);
    ink(color, alpha, fitted > 15 ? 1.8 : 1.4, () => traceText(ctx, text, cx, y, fitted, 'center'));
  }

  private renderArenaChallenge(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    c: Challenge,
    top: number,
    title: string,
    titleColor: string,
    alpha: number,
    time: number,
    reduceMotion: boolean,
    room: number,
  ): void {
    const w = COOP_WORLD_W;
    const cx = w / 2;
    const done = c.outcome !== null;
    const grade = gradeOf(c);
    const badgeColor = grade ? GRADE_COLOR[grade] : NEON.cyan;
    const badgeLabel = c.kind === 'line' ? 'SQUAD TYPING QUIZ' : 'SQUAD MATH QUIZ';
    const bw = textWidth(badgeLabel, 8) + 22;
    ink(badgeColor, alpha * 0.85, 1.3, () => {
      ctx.rect(cx - bw / 2, top - 28, bw, 18);
      traceText(ctx, badgeLabel, cx, top - 23, 8, 'center');
    });

    this.drawCentred(ctx, ink, title, cx, top, 11.5, room, alpha, titleColor);

    if (c.kind === 'line') {
      this.renderArenaLine(ctx, ink, c, top + 38, alpha, reduceMotion, room);
    } else {
      this.drawCentred(
        ctx,
        ink,
        `${c.question} = ${done && c.kind === 'entry' ? c.answer : '?'}`,
        cx,
        top + 32,
        22,
        room,
        alpha,
        SAND,
      );
      if (c.kind === 'choice') {
        optionBoxes(w, room, c.options.length, top).forEach((b, i) => {
          const correct = done && i === c.correct;
          const wrongPick = done && i === c.picked && i !== c.correct;
          const a = alpha * (done && !correct && !wrongPick ? 0.35 : 1);
          ink(correct ? PINK : SAND, a, correct ? 2.6 : 1.5, () => {
            ctx.rect(b.x, b.y, b.w, b.h);
            if (wrongPick) {
              ctx.moveTo(b.x, b.y);
              ctx.lineTo(b.x + b.w, b.y + b.h);
              ctx.moveTo(b.x + b.w, b.y);
              ctx.lineTo(b.x, b.y + b.h);
            }
          });
          ink(correct ? PINK : SAND, a, 1.8, () =>
            traceText(ctx, c.options[i]!, b.x + b.w / 2, b.y + (b.h - 16) / 2, 16, 'center'),
          );
          if (!done && this.inputMode === 'keys') {
            ink(SAND, a * 0.55, 1, () => traceText(ctx, String(i + 1), b.x + 6, b.y + 6, 8), false);
          }
        });
      } else {
        const field = { x: cx - 66, y: top + 76, w: 132, h: 50 };
        const right = done && c.outcome?.success;
        const wiped = !done && c.error > 0;
        if (wiped && !reduceMotion) field.x += rand(-3, 3);
        ink(right ? PINK : wiped ? NEON.red : SAND, alpha, right || wiped ? 2.6 : 1.5, () =>
          ctx.rect(field.x, field.y, field.w, field.h),
        );
        const typedWidth = textWidth(c.typed, 18);
        if (c.typed) {
          ink(right ? PINK : SAND, alpha, 1.8, () => traceText(ctx, c.typed, cx, field.y + 16, 18, 'center'));
        }
        if (!done && time % 0.9 < 0.55) {
          const curX = cx + typedWidth / 2 + (c.typed ? 5 : -6);
          ink(SAND, alpha, 1.8, () => {
            ctx.moveTo(curX, field.y + 37);
            ctx.lineTo(curX + 12, field.y + 37);
          });
        }
      }
      this.renderTimerBar(ctx, ink, cx, top + 144, c.timeLeft, c.limit, alpha * (done ? 0.45 : 1), !done);
    }

    const o = c.outcome;
    const hintY = c.kind === 'line' ? top + 126 : top + 158;
    if (o && !o.success && c.kind !== 'line') {
      const rightAns = c.kind === 'choice' ? c.options[c.correct] : c.answer;
      this.drawCentred(
        ctx,
        ink,
        `${c.timeLeft <= 0 ? 'OUT OF TIME' : 'NOT QUITE'} - ${c.question} = ${rightAns}`,
        cx,
        hintY,
        10,
        room,
        1,
        SAND,
      );
    } else if (!o && c.kind !== 'line') {
      const again = c.kind === 'entry' && c.misses > 0;
      const how = again
        ? 'NOT QUITE - ONE MORE TRY'
        : c.kind === 'entry'
          ? 'TYPE THE ANSWER'
          : this.inputMode === 'keys'
            ? 'CLICK AN ANSWER OR PRESS 1-3'
            : 'TAP THE ANSWER';
      this.drawCentred(ctx, ink, how, cx, hintY, again ? 10 : 8.5, room, alpha * (again ? 1 : 0.68), again ? NEON.red : SAND);
    }
  }

  private renderArenaLine(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    c: LineChallenge,
    y: number,
    alpha: number,
    reduceMotion: boolean,
    room: number,
  ): void {
    const cx = COOP_WORLD_W / 2;
    const wrong = c.error > 0;
    const size = fitTo(c.text, 20, room - 24);
    const step = advance(size);
    const x = cx - textWidth(c.text, size) / 2 + (wrong && !reduceMotion ? rand(-3, 3) : 0);
    const next = x + c.index * step;
    if (c.index > 0) ink(PINK, alpha, 1.8, () => traceText(ctx, c.text.slice(0, c.index), x, y, size));
    if (c.index < c.text.length) {
      ink(SAND, alpha * (wrong ? 1 : 0.85), 1.6, () => traceText(ctx, c.text.slice(c.index), next, y, size));
      ink(wrong ? PINK : SAND, alpha, wrong ? 3 : 1.8, () => {
        ctx.moveTo(next, y + size + 7);
        ctx.lineTo(next + (size / 6) * 4, y + size + 7);
      });
    }
    this.renderTimerBar(ctx, ink, cx, y + size + 30, c.timeLeft, c.limit, alpha * (c.outcome ? 0.45 : 1), c.outcome === null);
    const pressed = c.index + c.misses;
    if (!c.outcome) {
      this.drawCentred(
        ctx,
        ink,
        `ACCURACY ${pressed ? percent(c.index / pressed) : 100}%`,
        cx,
        y + size + 46,
        9,
        room,
        alpha * 0.72,
        SAND,
      );
    }
  }

  private renderTimerBar(
    ctx: CanvasRenderingContext2D,
    ink: Ink,
    cx: number,
    y: number,
    seconds: number,
    limit: number,
    alpha: number,
    running: boolean,
  ): void {
    const share = clamp(seconds / Math.max(0.1, limit), 0, 1);
    const color = share > 0.5 ? NEON.lime : share > 0.25 ? NEON.yellow : NEON.red;
    const half = 135;
    const x0 = cx - half - 10;
    ink(SAND, alpha * 0.3, 1, () => ctx.rect(x0, y - 4, half * 2, 8), false);
    if (share > 0) {
      ink(color, alpha, 4, () => {
        ctx.moveTo(x0 + 2, y);
        ctx.lineTo(x0 + 2 + (half * 2 - 4) * share, y);
      }, running);
    }
    const secText = String(Math.max(0, Math.ceil(seconds)));
    ink(color, alpha, 1.6, () => traceText(ctx, secText, x0 + half * 2 + 10, y - 6, 12, 'left'));
  }
}

export interface SquadSummaryPilotRow {
  seat: CoopSeatIndex;
  callsign: string;
  color: string;
  questionsRight: number;
  revives: number;
}

/**
 * Render the Co-op Squad Mission Summary overlay inside the `768 x 1024` shared arena at Game Over.
 * Pure vector rendering with zero pointer hitboxes, so tapping anywhere on a Host phone triggers relaunch.
 */
export function renderSquadMissionSummary(
  ctx: CanvasRenderingContext2D,
  ink: Ink,
  info: {
    formattedCode: string;
    isHost: boolean;
    coarse: boolean;
    time: number;
    stateTime: number;
    score: number;
    wave: number;
    totalFreed: number;
    upgrades: ReadonlySet<UpgradeId>;
    pilots: readonly SquadSummaryPilotRow[];
  },
): void {
  const cx = COOP_WORLD_W / 2;
  const alpha = Math.min(1, Math.max(0.15, info.stateTime / 0.45));
  const roster = info.pilots;
  const cardW = 612;
  const cardH = 310 + roster.length * 42;
  const cardX = cx - cardW / 2;
  const cardY = Math.max(150, (COOP_WORLD_H - cardH) * 0.44);

  ctx.fillStyle = `rgba(3, 8, 30, ${(0.9 * alpha).toFixed(3)})`;
  ctx.fillRect(cardX, cardY, cardW, cardH);
  ink(NEON.cyan, 0.85 * alpha, 1.7, () => {
    ctx.rect(cardX, cardY, cardW, cardH);
  });

  // Title + Room Code
  ink(NEON.cyan, alpha, 2.0, () => {
    traceText(ctx, 'SQUAD MISSION SUMMARY', cx, cardY + 22, 22, 'center');
  });
  ink(SAND, 0.72 * alpha, 1.2, () => {
    traceText(ctx, `SQUAD ROOM ${info.formattedCode} - UNRANKED CO-OP RUN`, cx, cardY + 54, 8.5, 'center');
  }, false);

  // 3-Column Primary Metrics (`TEAM SCORE`, `WAVE REACHED`, `PEOPLE SET FREE`)
  const statY = cardY + 86;
  const colW = (cardW - 48) / 3;
  const cols = [
    { label: 'TEAM SCORE', val: pad6(info.score), color: SAND },
    { label: 'WAVE REACHED', val: `WAVE ${Math.max(1, info.wave)}`, color: NEON.yellow },
    { label: 'PEOPLE SET FREE', val: String(info.totalFreed), color: SOUL },
  ] as const;

  cols.forEach((col, i) => {
    const bx = cardX + 24 + i * colW;
    const bw = colW - 8;
    const bcx = bx + bw / 2;
    ink(col.color, 0.32 * alpha, 1.1, () => ctx.rect(bx, statY, bw, 66), false);
    ink(SAND, 0.72 * alpha, 1.1, () => traceText(ctx, col.label, bcx, statY + 10, 7.5, 'center'), false);
    if (i === 2) {
      ink(SOUL, alpha, 1.6, () => {
        trace(ctx, PERSON_UP, bcx - textWidth(col.val, 18) / 2 - 12, statY + 42, 0.95, 0);
        traceText(ctx, col.val, bcx + 8, statY + 32, 18, 'center');
      });
    } else {
      ink(col.color, alpha, 1.8, () => traceText(ctx, col.val, bcx, statY + 32, 18, 'center'));
    }
  });

  // Squad Upgrades Strip
  const upgY = statY + 84;
  const earnedList = UPGRADES.filter((u) => info.upgrades.has(u.id));
  if (earnedList.length === 0) {
    ink(SAND, 0.62 * alpha, 1.1, () => {
      traceText(ctx, 'SQUAD UPGRADES: NONE EQUIPPED THIS RUN', cx, upgY + 6, 8.5, 'center');
    }, false);
  } else {
    const label = `SQUAD UPGRADES - ${earnedList.length}:`;
    const iconSpan = earnedList.length * 24;
    const startX = cx - (textWidth(label, 8.5) + 14 + iconSpan) / 2;
    ink(NEON.lime, 0.9 * alpha, 1.3, () => {
      traceText(ctx, label, startX, upgY + 6, 8.5, 'left');
      const ix0 = startX + textWidth(label, 8.5) + 18;
      earnedList.forEach((u, idx) => {
        trace(ctx, u.icon, ix0 + idx * 24, upgY + 10, 0.58, 0);
      });
    });
  }

  // Per-Pilot Squad Roster (`P1..P4`)
  let rowY = upgY + 34;
  ink(SAND, 0.58 * alpha, 1.0, () => {
    traceText(ctx, 'SQUAD ROSTER', cardX + 28, rowY, 7.5, 'left');
    traceText(ctx, 'QUIZZES', cardX + cardW - 160, rowY, 7.5, 'right');
    traceText(ctx, 'RESCUES', cardX + cardW - 28, rowY, 7.5, 'right');
  }, false);
  rowY += 16;

  for (const p of roster) {
    ctx.fillStyle = 'rgba(12, 24, 68, 0.45)';
    ctx.fillRect(cardX + 24, rowY, cardW - 48, 34);
    ink(p.color, 0.48 * alpha, 1.1, () => {
      ctx.rect(cardX + 24, rowY, cardW - 48, 34);
    }, false);
    ink(p.color, alpha, 1.5, () => {
      trace(ctx, SHIP, cardX + 44, rowY + 17, 0.56, 0);
      traceText(ctx, `P${p.seat + 1} ${p.callsign}`, cardX + 64, rowY + 11, 10.5, 'left');
    });
    ink(SAND, 0.92 * alpha, 1.3, () => {
      traceText(ctx, String(p.questionsRight), cardX + cardW - 160, rowY + 11, 10.5, 'right');
    }, false);
    ink(NEON.lime, 0.92 * alpha, 1.3, () => {
      traceText(ctx, String(p.revives), cardX + cardW - 28, rowY + 11, 10.5, 'right');
    }, false);
    rowY += 40;
  }

  // Host / Guest Relaunch Footer
  const footY = cardY + cardH - 32;
  const blink = info.time % 1.1 < 0.75;
  if (!info.isHost) {
    ink(NEON.cyan, 0.92 * alpha, 1.4, () => {
      traceText(ctx, 'WAITING FOR THE HOST TO RELAUNCH', cx, footY, 10.5, 'center');
    });
  } else if (info.stateTime > 0.9 && blink) {
    const prompt = info.coarse
      ? 'TAP ANYWHERE TO RELAUNCH SQUAD'
      : 'PRESS SPACE OR ENTER TO RELAUNCH - ESC TO LEAVE';
    const promptSz = fitTo(prompt, 10.5, cardW - 48);
    ink(NEON.lime, 0.95, 1.5, () => {
      traceText(ctx, prompt, cx, footY, promptSz, 'center');
    });
  }
}
