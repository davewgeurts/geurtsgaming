/**
 * The questions the arcade demo asks: a line to type, a sum with options to pick from, or a sum
 * whose answer is typed in. This file is the rules only (what counts as right, how much it is
 * worth, when time runs out); game.ts decides when to ask and hud.ts draws it.
 */
import { clamp01 } from './core';
import type { Problem } from './maths';

export interface Outcome {
  success: boolean;
  /** 0 to 1: how much of the reward was earned. Cleaner and faster is worth more. */
  quality: number;
  /** Typing only: correct keys out of all keys pressed. */
  accuracy: number;
  /** Typing only: words per minute, counting five characters as a word. */
  wpm: number;
}

interface Common {
  age: number;
  /** Seconds at the start when answers are ignored, so a key still held from flying is not a mistake. */
  grace: number;
  limit: number;
  timeLeft: number;
  /** Counts down after a wrong key, for the flash. */
  error: number;
  outcome: Outcome | null;
}

export interface LineChallenge extends Common {
  kind: 'line';
  text: string;
  /** Characters typed correctly so far. A wrong key does not move this on. */
  index: number;
  misses: number;
  /** When the first and the latest correct keys landed, to measure speed. */
  firstAt: number;
  lastAt: number;
}
export interface ChoiceChallenge extends Common {
  kind: 'choice';
  question: string;
  options: string[];
  correct: number;
  picked: number | null;
}
export interface EntryChallenge extends Common {
  kind: 'entry';
  question: string;
  answer: string;
  typed: string;
  /** Wrong answers still allowed before the question is failed, and how many have been given. */
  retries: number;
  misses: number;
}
export type Challenge = LineChallenge | ChoiceChallenge | EntryChallenge;

/** Typing speeds, in words per minute, that earn the least and the most. A beginner still gets half. */
const SLOW_WPM = 10;
const FAST_WPM = 40;

const common = (limit: number, grace: number): Common => ({ age: 0, grace, limit, timeLeft: limit, error: 0, outcome: null });

export function lineChallenge(text: string, limit: number, grace: number): LineChallenge {
  return { kind: 'line', text, index: 0, misses: 0, firstAt: 0, lastAt: 0, ...common(limit, grace) };
}

export function choiceChallenge(problem: Problem, limit: number, grace: number): ChoiceChallenge {
  return {
    kind: 'choice',
    question: problem.question,
    options: problem.options.map(String),
    correct: problem.options.indexOf(problem.answer),
    picked: null,
    ...common(limit, grace),
  };
}

/** `retries` is how many wrong answers are forgiven: the field clears and the clock keeps running. */
export function entryChallenge(problem: Problem, limit: number, grace: number, retries = 0): EntryChallenge {
  return { kind: 'entry', question: problem.question, answer: String(problem.answer), typed: '', retries, misses: 0, ...common(limit, grace) };
}

function settle(c: Challenge, success: boolean): void {
  if (c.outcome) return;
  if (c.kind === 'line') {
    const pressed = c.index + c.misses;
    const accuracy = pressed ? c.index / pressed : 0;
    // Speed is measured between the first and last correct keys, so thinking time before starting is free.
    const seconds = Math.max(0.2, c.lastAt - c.firstAt);
    const wpm = c.index > 1 ? (c.index - 1) / 5 / (seconds / 60) : 0;
    const speed = 0.5 + 0.5 * clamp01((wpm - SLOW_WPM) / (FAST_WPM - SLOW_WPM));
    c.outcome = { success, quality: (c.index / c.text.length) * accuracy * speed, accuracy, wpm };
  } else {
    // A right answer is worth at least half; one given in the first third of the time is worth everything.
    const quick = clamp01((c.timeLeft / c.limit) * 1.5);
    c.outcome = { success, quality: success ? 0.5 + 0.5 * quick : 0, accuracy: success ? 1 : 0, wpm: 0 };
  }
}

/** Whether this key is an answer to the challenge, and so must not reach the game's own controls. */
export function accepts(c: Challenge, key: string): boolean {
  if (c.outcome) return false;
  if (c.kind === 'line') return key.length === 1;
  if (c.kind === 'choice') return key.length === 1 && key >= '1' && key <= String(c.options.length);
  return key === 'Backspace' || (key.length === 1 && key >= '0' && key <= '9');
}

export function press(c: Challenge, key: string): void {
  if (!accepts(c, key) || c.age < c.grace) return;
  if (c.kind === 'line') {
    if (key.toUpperCase() === c.text[c.index]) {
      if (c.index === 0) c.firstAt = c.age;
      c.lastAt = c.age;
      c.index += 1;
      if (c.index === c.text.length) settle(c, true);
    } else {
      c.misses += 1;
      c.error = 0.2;
    }
  } else if (c.kind === 'choice') {
    choose(c, Number(key) - 1);
  } else if (key === 'Backspace') {
    c.typed = c.typed.slice(0, -1);
  } else {
    c.typed += key;
    // The answer is checked as soon as it has as many digits as the right one: no Enter key to hunt for.
    if (c.typed.length < c.answer.length) return;
    if (c.typed === c.answer || c.retries <= 0) {
      settle(c, c.typed === c.answer);
    } else {
      // A slip of the finger, forgiven: wipe the field and let them try again.
      c.retries -= 1;
      c.misses += 1;
      c.typed = '';
      c.error = 0.45;
    }
  }
}

/** Pick an option of a multiple-choice problem, by click, tap or number key. */
export function choose(c: Challenge, option: number): void {
  if (c.kind !== 'choice' || c.outcome || c.age < c.grace) return;
  c.picked = option;
  settle(c, option === c.correct);
}

export function tick(c: Challenge, dt: number): void {
  c.age += dt;
  c.error = Math.max(0, c.error - dt);
  if (c.outcome || c.age < c.grace) return;
  c.timeLeft -= dt;
  if (c.timeLeft <= 0) {
    c.timeLeft = 0;
    settle(c, false);
  }
}
