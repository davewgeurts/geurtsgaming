/**
 * Speech: the flight commander, the boss and the pilot say their lines out loud.
 *
 * It uses the voices built in to the browser (the Web Speech API), so there are no audio files and nothing to
 * download. Only voices that run on the device are used: some browsers also offer voices that send the text to
 * a server to be spoken, and this site makes no requests of that kind. A device with no English voice of its
 * own simply stays silent, and the lines are on screen as before.
 *
 * One line is spoken at a time. A new line cuts in on the one being spoken if its speaker matters at least as
 * much (the commander over the boss, the boss over the pilot); otherwise it is dropped, not queued, because a
 * line that arrives late is worse than one that is missed.
 */

import { PILOT_BY_ID, PILOT_IDS, type PilotId } from './loadout';

export type Speaker = 'commander' | 'boss' | 'pilot';

/** How each speaker sounds, and who may talk over whom (a higher `rank` wins). */
const CAST: Record<Speaker, { rank: number; pitch: number; rate: number }> = {
  commander: { rank: 3, pitch: 0.9, rate: 1.08 },
  boss: { rank: 2, pitch: 0.35, rate: 0.92 },
  pilot: { rank: 1, pitch: 1.4, rate: 1.12 },
};

const VOLUME = 0.9;

/** Voices that are jokes or sound effects (macOS has many). Nobody should be given one by accident. */
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ/i;
/** Names that are usually a deeper voice, to tell the boss from the commander when there is a choice, and a lighter one for the pilot. */
const DEEPER = /daniel|alex|fred|david|mark|george|guy|ralph|arthur|oliver|aaron|rishi|\bmale\b/i;
const LIGHTER = /samantha|karen|zira|aria|jenny|susan|victoria|moira|tessa|kathy|hazel|serena|martha|female/i;

/** The parts of the browser's speech engine this uses. Stood in for in the tests. */
export interface SpeechEngine {
  speaking: boolean;
  pending: boolean;
  getVoices(): VoiceLike[];
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  addEventListener?(type: 'voiceschanged', listener: () => void): void;
  removeEventListener?(type: 'voiceschanged', listener: () => void): void;
}
export interface VoiceLike { name: string; lang: string; localService: boolean; default: boolean }
export interface UtteranceLike {
  text: string;
  lang: string;
  voice: VoiceLike | null;
  pitch: number;
  rate: number;
  volume: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

/**
 * Turn a line as it is written on screen (upper case, for the stroke font) into one a voice reads well.
 * Lower case stops short words being spelled out letter by letter; the few things that should be are put back.
 */
export function spoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bwasd\b/g, 'W, A, S, D')
    .replace(/\bp pauses\b/g, 'P pauses')
    // A long wail reads better as a short one.
    .replace(/no{3,}/g, 'nooo')
    // On-screen notes carry points ("FULL TANK +400") and dashes; a voice should not read those out.
    .replace(/\s*[+-]\s*\d+%?/g, '')
    .replace(/\s+-\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Roughly how long a line takes to say, in seconds: used only to give up waiting on an engine that never reports back. */
function longest(text: string, rate: number): number {
  return 2.5 + (text.length * 0.11) / rate;
}

/**
 * Choose a voice for each speaker from what the device offers: English, running on the device, and not a
 * novelty. Returns null when there is no such voice (stay silent), or an empty cast when the browser has
 * not listed its voices yet (speak with its default).
 */
export function castVoices(voices: readonly VoiceLike[], language = 'en-GB'): Record<Speaker, VoiceLike | null> | null {
  const none = { commander: null, boss: null, pilot: null };
  if (!voices.length) return none;
  const english = voices.filter((v) => v.localService && /^en(?:[-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
  if (!english.length) return null;
  // The reader's own kind of English first (the script is written in British English, so that is the fallback).
  const want = /^en(?:[-_]|$)/i.test(language) ? language.toLowerCase().replace('_', '-') : 'en-gb';
  const near = english.filter((v) => v.lang.toLowerCase().replace('_', '-') === want);
  const pool = near.length ? near : english;
  const commander = pool.find((v) => v.default) ?? pool[0]!;
  const others = english.filter((v) => v !== commander);
  // The pilot gets a lighter voice if there is one. The boss gets a deeper one, or failing that shares the
  // commander's, pitched right down: that still sounds like someone else, where a light voice would not.
  const light = others.find((v) => LIGHTER.test(v.name));
  const spare = others.filter((v) => v !== light);
  const boss = spare.find((v) => DEEPER.test(v.name)) ?? spare.find((v) => !LIGHTER.test(v.name)) ?? commander;
  const pilot = light ?? spare.find((v) => v !== boss) ?? commander;
  return { commander, boss, pilot };
}

/**
 * Pick an on-device English voice for one of the eight playable pilots according to their `voice.pool`
 * (`'light' | 'mid' | 'deep'`), spreading pilots deterministically across matching device voices when
 * more than one is installed. Returns `null` when the device lists voices and none are local English,
 * or `undefined` when the browser has not listed its voices yet (use default voice with custom pitch/rate).
 */
export function pickPilotVoice(
  voices: readonly VoiceLike[],
  pilotId: PilotId,
  language = 'en-GB',
): VoiceLike | null | undefined {
  if (!voices.length) return undefined;
  const english = voices.filter((v) => v.localService && /^en(?:[-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
  if (!english.length) return null;

  const spec = PILOT_BY_ID[pilotId];
  const idx = Math.max(0, PILOT_IDS.indexOf(pilotId));
  const want = /^en(?:[-_]|$)/i.test(language) ? language.toLowerCase().replace('_', '-') : 'en-gb';
  const sorted = [
    ...english.filter((v) => v.lang.toLowerCase().replace('_', '-') === want),
    ...english.filter((v) => v.lang.toLowerCase().replace('_', '-') !== want),
  ];

  const lightPool = sorted.filter((v) => LIGHTER.test(v.name));
  const deepPool = sorted.filter((v) => DEEPER.test(v.name));
  const midPool = sorted.filter((v) => !LIGHTER.test(v.name) && !DEEPER.test(v.name));

  let candidates: VoiceLike[];
  if (spec.voice.pool === 'light') {
    candidates = lightPool.length ? lightPool : midPool.length ? midPool : sorted;
  } else if (spec.voice.pool === 'deep') {
    candidates = deepPool.length ? deepPool : midPool.length ? midPool : sorted;
  } else {
    candidates = midPool.length ? midPool : lightPool.length ? lightPool : sorted;
  }
  return candidates[idx % candidates.length] ?? sorted[0]!;
}

export class Voice {
  private on = true;
  private cast: Record<Speaker, VoiceLike | null> | null | undefined;
  private activePilot: PilotId | null = null;
  /** The line being spoken, who is speaking it, whether the browser has begun it, and when to stop waiting for it to finish. */
  private current: {
    utterance: UtteranceLike;
    who: Speaker;
    pilotId?: PilotId;
    line: string;
    rank: number;
    until: number;
    started: boolean;
  } | null = null;
  /** The browser has spoken for this page at least once, which is the proof that it will. */
  private heard = false;
  /** How many times `unlock` has tried, so a browser that never reports a line starting is not asked for ever. */
  private tries = 0;
  private readonly engine: SpeechEngine | null;
  private readonly make: (text: string) => UtteranceLike;
  private readonly now: () => number;
  private readonly language: string;

  /**
   * With no arguments this uses the browser's speech engine, if it has one. The arguments are for tests:
   * an engine, how to make an utterance, a clock in seconds, and the reader's language.
   */
  constructor(
    engine?: SpeechEngine | null,
    make?: (text: string) => UtteranceLike,
    now?: () => number,
    language?: string,
  ) {
    const hasSpeech = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
    this.engine = engine !== undefined ? engine : hasSpeech ? (speechSynthesis as unknown as SpeechEngine) : null;
    this.make = make ?? ((text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike);
    this.now = now ?? (() => performance.now() / 1000);
    this.language = language ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-GB');
    // Browsers often list their voices a moment after the page loads: choose again when they do.
    this.engine?.addEventListener?.('voiceschanged', this.recast);
  }

  private recast = (): void => {
    this.cast = undefined;
  };

  get enabled(): boolean {
    return this.on;
  }

  /** Switch speech on or off. Switching it off stops whatever is being said. */
  setEnabled(on: boolean): void {
    this.on = on;
    if (!on) this.hush();
  }

  /** Set which playable pilot is flying so in-game `say('pilot', ...)` lines use their custom voice. */
  setPilot(pilotId: PilotId | null): void {
    this.activePilot = pilotId;
  }

  /**
   * Some browsers (Safari, and every browser on an iPhone) only let a page speak once it has started speaking
   * from inside a key press or a tap. The game calls this from each of those until the browser has spoken:
   * a line that was asked for too early and never began is said again, now that it can be, and otherwise
   * it says nothing, silently, which is enough to be allowed to speak later.
   */
  unlock(): void {
    const engine = this.engine;
    if (this.heard || !this.on || !engine || this.tries >= 4) return;
    this.tries += 1;
    try {
      const waiting = this.current;
      if (waiting && !waiting.started && this.now() < waiting.until) {
        engine.cancel();
        this.current = null;
        if (waiting.pilotId) this.sayPilot(waiting.pilotId, waiting.line);
        else this.say(waiting.who, waiting.line);
        return;
      }
      if (waiting) return;
      const silent = this.make(' ');
      silent.volume = 0;
      silent.onstart = () => {
        this.heard = true;
      };
      engine.speak(silent);
    } catch {
      /* a browser that refuses is a browser that stays silent */
    }
  }

  /** Someone is talking: the line has not finished, as far as can be told. */
  get busy(): boolean {
    const c = this.current;
    if (!c) return false;
    if (this.now() < c.until) return true;
    this.current = null;
    return false;
  }

  /**
   * Say a line in a specific playable pilot's custom on-device voice (`pitch`, `rate`, and voice pool).
   * Used when hovering/previewing pilots in the hangar and for in-flight pilot callouts.
   */
  sayPilot(pilotId: PilotId, text: string): boolean {
    const engine = this.engine;
    if (!this.on || !engine) return false;
    const line = spoken(text);
    if (!line) return false;
    const rank = CAST.pilot.rank;
    if (this.busy && this.current!.rank > rank) return false;
    try {
      const voices = engine.getVoices();
      const picked = pickPilotVoice(voices, pilotId, this.language);
      if (picked === null) return false;
      if (this.current || engine.speaking || engine.pending) engine.cancel();
      const spec = PILOT_BY_ID[pilotId].voice;
      const utterance = this.make(line);
      if (picked) {
        utterance.voice = picked;
        utterance.lang = picked.lang;
      } else {
        utterance.lang = /^en(?:[-_]|$)/i.test(this.language) ? this.language : 'en-GB';
      }
      utterance.pitch = spec.pitch;
      utterance.rate = spec.rate;
      utterance.volume = VOLUME;
      const done = (): void => {
        if (this.current?.utterance === utterance) this.current = null;
      };
      utterance.onstart = () => {
        this.heard = true;
        if (this.current?.utterance === utterance) this.current.started = true;
      };
      utterance.onend = done;
      utterance.onerror = done;
      this.current = {
        utterance,
        who: 'pilot',
        pilotId,
        line,
        rank,
        until: this.now() + longest(line, spec.rate),
        started: false,
      };
      engine.speak(utterance);
      return true;
    } catch {
      this.current = null;
      return false;
    }
  }

  /**
   * Say a line. Returns whether it is being said: false when speech is off or the device has no suitable
   * voice, or when someone who matters more is still talking.
   */
  say(who: Speaker, text: string): boolean {
    if (who === 'pilot' && this.activePilot) {
      return this.sayPilot(this.activePilot, text);
    }
    const engine = this.engine;
    if (!this.on || !engine) return false;
    // (A line being said again by `unlock` is already in its spoken form; doing it twice changes nothing.)
    const line = spoken(text);
    if (!line) return false;
    const part = CAST[who];
    if (this.busy && this.current!.rank > part.rank) return false;
    try {
      if (this.cast === undefined) this.cast = castVoices(engine.getVoices(), this.language);
      const cast = this.cast;
      if (!cast) return false;
      // Stop whatever was being said. (Asking an idle engine to stop can make some browsers drop the next line.)
      if (this.current || engine.speaking || engine.pending) engine.cancel();
      const utterance = this.make(line);
      const voice = cast[who];
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = /^en(?:[-_]|$)/i.test(this.language) ? this.language : 'en-GB';
      }
      // When the boss or the pilot has to share the commander's voice, pitch alone tells them apart.
      utterance.pitch = part.pitch;
      utterance.rate = part.rate;
      utterance.volume = VOLUME;
      const done = (): void => {
        if (this.current?.utterance === utterance) this.current = null;
      };
      utterance.onstart = () => {
        this.heard = true;
        if (this.current?.utterance === utterance) this.current.started = true;
      };
      utterance.onend = done;
      utterance.onerror = done;
      this.current = { utterance, who, line, rank: part.rank, until: this.now() + longest(line, part.rate), started: false };
      engine.speak(utterance);
      return true;
    } catch {
      this.current = null;
      return false;
    }
  }

  /** Stop talking, now: the game has been paused, closed or muted. */
  hush(): void {
    this.current = null;
    try {
      this.engine?.cancel();
    } catch {
      /* nothing was being said */
    }
  }

  /** Stop talking and stop listening for new voices. */
  dispose(): void {
    this.hush();
    this.engine?.removeEventListener?.('voiceschanged', this.recast);
  }
}
