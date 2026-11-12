/**
 * HUD, corner faces, commander asteroid alert, fuel tanker overlay, and challenge/upgrade panels.
 */
import { renderAvatarFrame, type Mood, type Who } from './avatar';
import type { Boss } from './boss';
import type { Challenge, LineChallenge } from './challenge';
import { NEON, NEON_LIST, PINK, SAND, SOUL, clamp, pad6, percent, rand, type Ink } from './core';
import { advance, fitTo, textWidth, traceText } from './font';
import { BRIEFING } from './lines';
import { DROGUE, MARK_BOMB, MARK_ENERGY, MARK_HULL, MARK_STAR, MINE, PERSON_OUT, PERSON_UP, SHIP, TANKER, trace, type Shape } from './shapes';
import { FUEL_SECONDS, TANKER_SIZE, tankerTail, type Tanker, type TankerEnv } from './tanker';
import { UPGRADES, type Upgrade, type UpgradeId } from './upgrades';
import { TRIPLE_AT } from './weapons';

/**
 * The commander's warning: how long it is on screen, when the commander turns from the alarm to the choice
 * of ways through, and how far in the asteroids set off.
 */
export const ALERT_SECONDS = 6;
export const ALERT_TURN = 2.4;
export const ALERT_LEAD = 3.4;

/**
 * On a short screen: how far in from the right edge the boss's corner reaches (its face, then its health
 * bar and its taunts, which are kept to SHORT_TAUNT px wide there).
 */
export const SHORT_TAUNT = 130;
export const BOSS_CORNER = 12 + 50 + 10 + SHORT_TAUNT + 10;

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

export interface Box { x: number; y: number; w: number; h: number }
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

export interface VillainState {
  mood: Mood;
  until: number;
  line: string;
  lineUntil: number;
  nextIdle: number;
  show: number;
  warned: boolean;
  bye: boolean;
  beaten: boolean;
}

/** The boss's face before it has done or said anything. */
export const freshVillain = (): VillainState => ({
  mood: 'calm',
  until: 0,
  line: '',
  lineUntil: 0,
  nextIdle: 0,
  show: 0,
  warned: false,
  bye: false,
  beaten: false,
});

/** Side of the square each corner face sits in: large on a desktop, smaller on phones (either way up). */
export function faceBoxSize(w: number, h: number): number {
  if (w < 480 || h < 480) return 50;
  return w >= 1000 && h >= 640 ? 88 : 66;
}

export { fitTo };

/** Small print is drawn a quarter larger on a big screen, where it would otherwise be tiny. */
export function printSize(size: number, w: number, h: number): number {
  return w >= 1000 && h >= 640 ? Math.round(size * 1.25) : size;
}

/** Where the score is written, and so where the count of people freed goes: just after it. */
export function scoreLineLayout(
  w: number,
  h: number,
  leftInset: number,
  topInset: number,
  score: number,
): { text: string; size: number; x: number; y: number } {
  const box = faceBoxSize(w, h);
  return {
    text: w < 360 ? pad6(score) : `SCORE ${pad6(score)}`,
    size: box < 60 ? 10 : 12,
    x: leftInset + 12 + box + 10,
    y: topInset + 13,
  };
}

export function freedCounterPos(
  w: number,
  h: number,
  leftInset: number,
  topInset: number,
  score: number,
): { x: number; y: number } {
  const line = scoreLineLayout(w, h, leftInset, topInset, score);
  return { x: line.x + textWidth(line.text, line.size) + (line.size < 12 ? 13 : 18), y: line.y + line.size / 2 };
}

/** Top of the question panel. A break sits mid-screen; a capsule's question sits higher, clear of the ship. */
export function challengeTopY(h: number, topInset: number, homeY: number, isBreak: boolean): number {
  const usual = isBreak ? h * 0.42 - 44 : Math.max(topInset + 96, h * 0.2);
  // On a very short screen the whole question moves up, so that its last line stays clear of the ship.
  return Math.max(topInset + 40, Math.min(usual, homeY - 196));
}

/** Where the answer boxes of a multiple-choice sum go. Used to draw them and to tell which one was clicked. */
export function optionBoxes(w: number, room: number, count: number, top: number): Box[] {
  const gap = 14;
  const bw = Math.min(96, (room - gap * (count - 1)) / count);
  const x0 = w / 2 - (bw * count + gap * (count - 1)) / 2;
  return Array.from({ length: count }, (_, i) => ({ x: x0 + i * (bw + gap), y: top + 76, w: bw, h: 50 }));
}

/** Where the upgrades on offer go: one row each. Used to draw them and to tell which one was clicked. */
export function offerBoxes(w: number, h: number, room: number, top: number, count: number): Box[] {
  const big = w >= 1000 && h >= 640;
  const rowHeight = h < 480 ? 44 : big ? 64 : 54;
  const bw = Math.min(room, 420);
  return Array.from({ length: count }, (_, i) => ({ x: w / 2 - bw / 2, y: top + 26 + i * (rowHeight + 8), w: bw, h: rowHeight }));
}

export interface HudViewContext {
  ctx: CanvasRenderingContext2D;
  ink: Ink;
  w: number;
  h: number;
  scale: number;
  shipScale: number;
  inset: { top: number; right: number; bottom: number; left: number };
  room: number;
  homeY: number;
  time: number;
  reduceMotion: boolean;
  coarse: boolean;
  input: 'keys' | 'touch';
  state: 'ready' | 'playing' | 'over';
  stateTime: number;
  paused: boolean;
  shipX: number;
  shipY: number;
  lean: number;
  hull: number;
  maxHull: number;
  energy: number;
  jam: number;
  score: number;
  best: number;
  newBest: boolean;
  wave: number;
  banner: number;
  freed: number;
  freedPulse: number;
  soulsInFlight: number;
  bossFreed: number;
  bossNote: string;
  intermission: number;
  fuelNote: { text: string; until: number; color: string };
  upgrades: ReadonlySet<UpgradeId>;
  boss: Boss | null;
  tanker: Tanker | null;
  brk: Break | null;
  prompt: Prompt | null;
  pilotMood: Mood;
  villainMood: Mood;
  villain: VillainState;
}

function drawCentred(
  v: HudViewContext,
  text: string,
  y: number,
  size: number,
  alpha = 1,
  color = SAND,
): void {
  const fitted = fitTo(text, size, v.room);
  v.ink(color, alpha, fitted > 16 ? 1.8 : 1.4, () => traceText(v.ctx, text, v.w / 2, y, fitted, 'center'));
}

/**
 * The flight commander, large in the middle of the screen, with what they are saying underneath: first
 * the alarm, worried, and then the choice between the two ways through.
 */
export function renderAlert(v: HudViewContext, age: number): void {
  const { ctx, ink, w, h, time: t, reduceMotion: steady, inset, room, homeY } = v;
  const fade = clamp(Math.min(age / 0.2, (ALERT_SECONDS - age) / 0.35), 0, 1);
  const alarm = age < ALERT_TURN;
  const [headline, order] = BRIEFING.asteroids;
  const [look, or, choose] = BRIEFING.choice;
  const big = fitTo(headline, h < 500 ? 20 : 28, room);
  const small = Math.min(fitTo(order, h < 500 ? 11 : 15, room), fitTo(look, h < 500 ? 11 : 15, room));
  // The screen, then the words, centred as a block a little above the middle. (It is sized for the longer
  // of the two things said, so that it does not jump when the commander moves on.)
  const box = Math.round(Math.min(w - inset.left - inset.right - 60, h * (h < 500 ? 0.36 : 0.4), 320));
  const block = box + 20 + small + 8 + small + 12 + big;
  const x = w / 2 - box / 2;
  const y = Math.max(inset.top + 58, Math.min(h * 0.44 - block / 2, homeY - 44 - block));
  const flash = steady || Math.floor(t * 6) % 2 === 0;
  // How far through saying the second thing: the mouth moves until it is said.
  const told = Math.floor((age - ALERT_TURN) * 46);
  const mood: Mood = alarm ? 'worried' : told < look.length + or.length + choose.length ? 'talk' : 'calm';
  // Worried: looking this way and that, and shuddering. Then steadier, looking straight at the pilot.
  const yaw = alarm ? Math.sin(t * 4.2) * 0.3 : Math.sin(t * 0.9) * 0.08;
  const pitch = 0.05 + (steady ? 0 : alarm ? Math.sin(t * 34) * 0.025 : mood === 'talk' ? Math.sin(t * 7) * 0.035 : 0);

  renderAvatarFrame({
    ctx,
    ink,
    who: 'commander',
    x,
    y,
    box,
    yaw,
    pitch,
    mood,
    time: t,
    fade,
    fillStyle: `rgba(3, 7, 26, ${(0.86 * fade).toFixed(3)})`,
    headColor: NEON.cyan,
    headAlpha: 0.5,
    headWidth: 1.2,
    faceColor: SAND,
    faceWidth: 2,
    frameColor: alarm ? (flash ? NEON.red : NEON.yellow) : NEON.cyan,
    frameAlpha: 1,
    frameWidth: 2,
    scanlines: true,
  });

  // The words appear as they are spoken. Each line starts where it will end up, so it does not slide about.
  const ty = y + box + 20;
  const write = (text: string, shown: number, top: number, size: number, color: string, width: number): void => {
    const part = text.slice(0, Math.max(0, shown));
    if (part) ink(color, fade, width, () => traceText(ctx, part, w / 2 - textWidth(text, size) / 2, top, size));
  };
  if (alarm) {
    const said = Math.floor(age * 46);
    write(headline, said, ty, big, flash ? NEON.red : NEON.yellow, 2);
    write(order, said - headline.length, ty + big + 14, small, SAND, 1.6);
  } else {
    const last = fitTo(choose, big, room);
    write(look, told, ty, small, SAND, 1.6);
    write(or, told - look.length, ty + small + 8, small, SAND, 1.6);
    write(choose, told - look.length - or.length, ty + small + 8 + small + 12, last, NEON.yellow, 2);
  }
}

/** The fuel ship, its line and basket, and how the refuelling is going. */
export function renderTanker(v: HudViewContext, t: Tanker, env: TankerEnv): void {
  const { ctx, ink, scale: sc, shipScale, reduceMotion: steady, time, state, shipX, shipY, w, h } = v;
  const tail = tankerTail(t, sc);
  const end = t.hooked ? { x: env.noseX, y: env.noseY } : t.drogue;
  // The line is green while it is easy, yellow as it tightens and red when it is about to come off.
  const lineColor = t.strain > 0.8 ? NEON.red : t.strain > 0.5 ? NEON.yellow : NEON.lime;
  // It hangs in a lazy curve while it is slack, pulls straight as it tightens, and shivers at the end.
  const bow = (1 - t.strain) * 20 * sc * (t.hooked ? Math.sin(time * 2.2 + t.phases[0]) : 0.35);
  const shiver = t.strain > 0.8 && !steady ? rand(-1.5, 1.5) : 0;
  const mx = (tail.x + end.x) / 2 + bow + shiver;
  const my = (tail.y + end.y) / 2;
  const top = end.y - 5 * sc;
  ink(lineColor, 1, 1.5, () => {
    ctx.moveTo(tail.x, tail.y);
    ctx.quadraticCurveTo(mx, my, end.x, top);
    trace(ctx, DROGUE, end.x, end.y, sc, 0);
  });
  if (t.hooked) {
    // Fuel on its way down the line.
    ink(SAND, 1, 1.3, () => {
      for (let i = 0; i < 4; i++) {
        const u = (time * 1.1 + i / 4) % 1;
        const x = (1 - u) * (1 - u) * tail.x + 2 * (1 - u) * u * mx + u * u * end.x;
        const y = (1 - u) * (1 - u) * tail.y + 2 * (1 - u) * u * my + u * u * top;
        const r = 2.2 * sc;
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
      }
    }, false);
  }

  // It flickers when it is about to give up waiting.
  const impatient = t.state === 'station' && !t.hooked && t.patience < 3;
  const faint = impatient && (steady || Math.floor(time * 6) % 2 === 0);
  const big = sc * TANKER_SIZE;
  ink(NEON.lime, faint ? 0.45 : 1, 1.7, () => trace(ctx, TANKER, t.x, t.y, big, 0));
  ink(PINK, 1, 1.4, () => {
    for (const side of [-1, 1]) {
      const x = t.x + side * 14.5 * big;
      const y = t.y + 21.5 * big;
      ctx.moveTo(x - 3 * big, y);
      ctx.lineTo(x, y + rand(6, 12) * big);
      ctx.lineTo(x + 3 * big, y);
    }
  });

  if (state !== 'playing') return;
  // How full the tank is: a ring round the ship that closes as the fuel goes in.
  if (t.fuel > 0) {
    const r = 27 * shipScale;
    ink(NEON.lime, 0.22, 1.2, () => {
      ctx.moveTo(shipX + r, shipY);
      ctx.arc(shipX, shipY, r, 0, Math.PI * 2);
    }, false);
    ink(NEON.lime, 1, 2, () => {
      ctx.moveTo(shipX, shipY - r);
      ctx.arc(shipX, shipY, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t.fuel);
    });
    ink(NEON.lime, 0.9, 1.2, () => traceText(ctx, `FUEL ${percent(t.fuel)}%`, shipX, shipY + r + 6, printSize(8, w, h), 'center'), false);
  }
  // By the basket: what to do, or what just went wrong.
  if (t.state === 'station' && !t.hooked) {
    const lost = t.why !== null && t.whyAge < 1.1;
    const label = lost ? (t.why === 'close' ? 'TOO CLOSE!' : 'TOO FAR!') : t.fuel > 0 ? 'HOOK ON AGAIN' : 'HOOK ON HERE';
    const alpha = lost || steady ? 1 : 0.6 + 0.35 * Math.sin(time * 6);
    ink(lost ? NEON.red : NEON.lime, alpha, 1.2, () => traceText(ctx, label, t.drogue.x, t.drogue.y + 9 * sc, printSize(8, w, h), 'center'), false);
  }
}

/** One of the corner faces: a wireframe head in a frame, turned and wearing whatever it is feeling. */
export function renderFace(v: HudViewContext, who: Who, x: number, y: number, box: number): void {
  const { ctx, ink, time: t, pilotMood, villainMood, lean, reduceMotion, boss, shipX, w } = v;
  const pilot = who === 'pilot';
  const mood = pilot ? pilotMood : villainMood;
  let yaw: number;
  let pitch: number;
  if (pilot) {
    // The pilot looks the way the ship is turning, nods when pleased and shudders when hit.
    yaw = lean * 0.55 + Math.sin(t * 0.8) * 0.07;
    pitch = Math.sin(t * 1.1) * 0.05 + (mood === 'hurt' && !reduceMotion ? Math.sin(t * 40) * 0.06 : 0) - (mood === 'happy' ? 0.1 : 0);
  } else {
    // The boss keeps its eyes on the ship, and its head bobs when it laughs.
    const look = boss ? clamp((shipX - boss.x) / (w * 0.5), -1, 1) : 0;
    yaw = look * 0.5 + Math.sin(t * 0.6) * 0.1;
    pitch = 0.12 + (mood === 'laugh' && !reduceMotion ? Math.sin(t * 15) * 0.13 : 0);
  }
  const head = pilot ? SAND : NEON.violet;
  const face = pilot ? (mood === 'hurt' ? PINK : mood === 'happy' ? NEON.lime : SAND) : mood === 'hurt' ? '#ffffff' : NEON.red;

  renderAvatarFrame({
    ctx,
    ink,
    who,
    x,
    y,
    box,
    yaw,
    pitch,
    mood,
    time: t,
    cutRatio: 0.18,
    cyRatio: pilot ? 0.46 : 0.54,
    sizeRatio: pilot ? 0.33 : 0.3,
    headColor: head,
    headAlpha: 0.45,
    headWidth: 1,
    faceColor: face,
    faceWidth: 1.5,
    frameColor: head,
    frameAlpha: 0.75,
    frameWidth: 1.3,
    frameGlow: false,
    pilotConsole: pilot,
  });
}

export function renderHud(v: HudViewContext): void {
  const { ctx, ink, w, h, inset, hull, maxHull, wave, score, best, reduceMotion, freed, freedPulse, jam, energy, time, upgrades, villain, boss } = v;
  const box = faceBoxSize(w, h);
  const small = box < 60;
  const left = inset.left + 12;
  const top = inset.top + 12;

  // Top left: the pilot in the cockpit, with score, hull, wave and energy beside the face.
  renderFace(v, 'pilot', left, top, box);
  const x0 = left + box + 10;
  const hullY = top + (small ? 26 : Math.round(box * 0.5) + 1);
  const hullGap = small ? 20 : 24;
  const hullScale = small ? 0.48 : 0.55;
  const waveY = top + box - (small ? 9 : 10);
  const waveSize = small ? 8 : 9;
  const waveText = `WAVE ${wave}`;
  const line = scoreLineLayout(w, h, inset.left, inset.top, score);
  ink(SAND, 1, 1.4, () => {
    traceText(ctx, line.text, line.x, line.y, line.size);
    for (let i = 0; i < hull; i++) trace(ctx, SHIP, x0 + 8 + i * hullGap, hullY, hullScale, 0);
    if (w >= 720) traceText(ctx, `BEST ${pad6(best)}`, w / 2, top + 1, 12, 'center');
  });
  // Hull points that have been lost stay as faint outlines, so it is clear how many there are to win back.
  if (hull < maxHull) {
    ink(SAND, 0.25, 1, () => {
      for (let i = Math.max(0, hull); i < maxHull; i++) trace(ctx, SHIP, x0 + 8 + i * hullGap, hullY, hullScale, 0);
    }, false);
  }
  ink(SAND, 0.7, 1.2, () => traceText(ctx, waveText, x0, waveY, waveSize));

  // After the score: how many people have been set free. The little figure jumps as each one arrives.
  const at = freedCounterPos(w, h, inset.left, inset.top, score);
  const jump = reduceMotion ? 0 : freedPulse / 0.3;
  ink(SOUL, 1, 1.2, () => {
    trace(ctx, jump > 0 ? PERSON_UP : PERSON_OUT, at.x, at.y + 1 - jump * 2, (line.size / 17) * (1 + jump * 0.25), 0);
    traceText(ctx, String(freed), at.x + line.size * 0.62, line.y, line.size);
  });

  // Energy gauge: ten ticks. The taller ones are the half that buys the third cannon.
  // It sits beside the hull, or beside the wave number where there is less room.
  const gauge = small ? x0 + textWidth(waveText, waveSize) + 10 : x0 + maxHull * hullGap + 8;
  const foot = small ? waveY + waveSize : hullY + 6;
  const step = small ? 4 : 5;
  if (jam > 0) {
    if (reduceMotion || time % 0.5 < 0.32) ink(PINK, 1, 1.3, () => traceText(ctx, 'JAMMED', gauge, foot - waveSize, waveSize));
  } else if (energy > 0) {
    const lit = Math.ceil(energy * 10);
    const ticks = (from: number, to: number) => () => {
      for (let i = from; i < to; i++) {
        ctx.moveTo(gauge + i * step, foot - (small ? 8 : 11) - (i >= TRIPLE_AT * 10 ? 3 : 0));
        ctx.lineTo(gauge + i * step, foot);
      }
    };
    ink(PINK, 1, 1.6, ticks(0, lit));
    if (lit < 10) ink(SAND, 0.3, 1.2, ticks(lit, 10), false);
  }

  // The upgrades earned so far, as a row of small icons under the cockpit.
  // On a phone they are drawn smaller and closer together, to leave room beside them for the boss's health.
  const iconStep = small ? 14 : 18;
  const iconsEnd = upgrades.size ? left + 8 + (upgrades.size - 1) * iconStep + 7 : left;
  if (upgrades.size) {
    ink(NEON.lime, 0.85, 1.1, () => {
      let i = 0;
      for (const u of UPGRADES) if (upgrades.has(u.id)) trace(ctx, u.icon, left + 8 + i++ * iconStep, top + box + (small ? 12 : 14), small ? 0.45 : 0.55, 0);
    }, false);
  }

  // Top right, under the Sound and Exit buttons: the boss, with its health and whatever it is saying beside it.
  if (!boss && villain.show <= time) return;
  const bx = w - inset.right - 12 - box;
  const by = inset.top + 64;
  renderFace(v, 'boss', bx, by, box);
  const edge = bx - 10;
  const room = edge - left;
  if (boss && (boss.state === 'fight' || boss.state === 'enter')) {
    const length = Math.min(150, room, small ? Math.max(48, edge - iconsEnd - 10) : Infinity, h < 500 ? SHORT_TAUNT : Infinity);
    ink(NEON.red, 0.25, 2, () => {
      ctx.moveTo(edge - length, by + 5);
      ctx.lineTo(edge, by + 5);
    }, false);
    ink(NEON.red, 1, 2.6, () => {
      ctx.moveTo(edge - length * Math.max(0, boss.hp / boss.maxHp), by + 5);
      ctx.lineTo(edge, by + 5);
    });
  }
  if (villain.lineUntil > time) {
    const size = fitTo(villain.line, small ? 9 : 11, h < 500 ? SHORT_TAUNT : room);
    const alpha = Math.min(1, (villain.lineUntil - time) / 0.3);
    // (A line lower on a phone, so a long taunt runs under the upgrade icons and not through them.)
    ink(NEON.yellow, alpha, 1.5, () => traceText(ctx, villain.line, edge, by + (small ? 24 : 17), size, 'right'));
  }
}

export function renderMessages(v: HudViewContext): void {
  const { h, time, paused, coarse, state, brk, prompt, boss, input, reduceMotion, intermission, bossNote, bossFreed, tanker, homeY, fuelNote, banner, wave, stateTime, score, best, newBest, freed, soulsInFlight, inset } = v;
  const mid = h * 0.42;
  const blink = time % 1.1 < 0.75;

  if (paused) {
    drawCentred(v, 'PAUSED', mid, 28);
    drawCentred(v, coarse ? 'TAP TO RESUME' : 'PRESS P TO RESUME', mid + 52, 11, 0.8);
    return;
  }

  // In the cockpit, the words on the glass and the commander's briefing are intro.ts's.
  if (state === 'ready') return;

  if (brk) {
    renderBreak(v, brk);
    return;
  }

  if (prompt) {
    const top = challengeTopY(h, inset.top, homeY, false);
    if (prompt.offer) {
      renderOffer(v, prompt.offer, prompt.offerAge, top);
      return;
    }
    renderChallenge(v, prompt.challenge, top, `${prompt.challenge.kind === 'line' ? 'TYPE' : 'SOLVE'} ${STAKES[prompt.stake].goal}`, prompt.stake === 'defuse' ? NEON.red : SAND);
    if (prompt.settled) drawCentred(v, prompt.note, top + 180, 13, 1, prompt.fatal ? NEON.red : prompt.challenge.outcome?.success ? PINK : SAND);
    return;
  }

  // A boss arrives under a flashing warning, and leaves under a line saying how it went.
  if (state === 'playing' && boss?.state === 'enter') {
    const flash = reduceMotion || Math.floor(time * 7) % 2 === 0;
    drawCentred(v, 'WARNING', mid, 30, 1, flash ? NEON.red : NEON.yellow);
    drawCentred(
      v,
      boss.kind === 'sum'
        ? `${input === 'touch' ? 'TAP' : 'BLAST'} THE RIGHT ANSWER TO CRACK ITS ARMOUR`
        : 'HIT THE RED CORE WHEN ITS ARMOUR OPENS',
      mid + 56, 11, 0.9, NEON.cyan,
    );
    return;
  }
  if (state === 'playing' && intermission > 0) {
    const color = reduceMotion ? NEON.yellow : NEON_LIST[Math.floor(time * 10) % NEON_LIST.length]!;
    const alpha = Math.min(1, intermission / 0.4);
    drawCentred(v, bossNote, mid, 26, alpha, color);
    if (bossFreed) drawCentred(v, `${bossFreed} PEOPLE SET FREE`, mid + 48, 13, alpha, SOUL);
    return;
  }

  // The fuel ship is announced below where the ship will be flying, and so is how the refuelling went.
  if (state === 'playing') {
    const t = tanker;
    const low = Math.min(h * 0.58, homeY - 96);
    if (t && t.fuel === 0 && !t.hooked && t.age < 3.2 && t.state !== 'leaving') {
      const alpha = Math.min(1, t.age / 0.3, (3.2 - t.age) / 0.4);
      drawCentred(v, 'FUEL SHIP', low, 22, alpha, NEON.lime);
      drawCentred(v, 'FLY IN BEHIND IT AND CATCH THE FUEL LINE', low + 40, 11, alpha * 0.9);
      drawCentred(v, `STAY HOOKED ON FOR ${FUEL_SECONDS} SECONDS`, low + 62, 11, alpha * 0.9);
      return;
    }
    if (fuelNote.until > time) {
      drawCentred(v, fuelNote.text, low, 16, Math.min(1, (fuelNote.until - time) / 0.4), fuelNote.color);
      return;
    }
  }

  if (state === 'playing' && banner > 0) {
    drawCentred(v, `WAVE ${wave}`, mid, 26, Math.min(1, banner / 0.5));
    return;
  }

  if (state === 'over') {
    const alpha = Math.min(1, stateTime / 0.5);
    drawCentred(v, 'GAME OVER', mid - 30, 32, alpha);
    drawCentred(v, `SCORE ${pad6(score)}`, mid + 30, 15, alpha);
    drawCentred(v, newBest ? 'NEW BEST!' : `BEST ${pad6(best)}`, mid + 60, 11, alpha * 0.8, newBest ? PINK : SAND);
    const totalFreed = freed + soulsInFlight;
    drawCentred(v, totalFreed === 1 ? 'YOU SET 1 PERSON FREE' : `YOU SET ${totalFreed} PEOPLE FREE`, mid + 86, 11, alpha, SOUL);
    if (stateTime > 0.9 && blink) {
      drawCentred(v, coarse ? 'TAP TO RETRY' : 'PRESS SPACE TO RETRY - ESC TO EXIT', mid + 122, 11, 0.9);
    }
  }
}

function renderOffer(v: HudViewContext, offer: Upgrade[], age: number, top: number): void {
  const { ctx, ink, w, h, room, input } = v;
  const alpha = Math.min(1, age / 0.3);
  const boxes = offerBoxes(w, h, room, top, offer.length);
  drawCentred(v, 'CORRECT - CHOOSE AN UPGRADE', top, printSize(11, w, h), alpha, NEON.lime);
  boxes.forEach((b, i) => {
    const u = offer[i]!;
    const textX = b.x + b.h + 10;
    const avail = b.w - b.h - 22;
    const nameSize = fitTo(u.name, printSize(12, w, h), avail);
    ink(SAND, alpha * 0.9, 1.4, () => ctx.rect(b.x, b.y, b.w, b.h));
    ink(NEON.lime, alpha, 1.6, () => {
      trace(ctx, u.icon, b.x + 4 + b.h / 2, b.y + b.h / 2, b.h / 40, 0);
      traceText(ctx, u.name, textX, b.y + b.h / 2 - nameSize - 2, nameSize);
    });
    ink(SAND, alpha * 0.8, 1.1, () => traceText(ctx, u.blurb, textX, b.y + b.h / 2 + 6, fitTo(u.blurb, printSize(8, w, h), avail)), false);
    // The number key that picks this one, for players at a keyboard.
    if (input === 'keys') ink(SAND, alpha * 0.55, 1, () => traceText(ctx, String(i + 1), b.x + b.w - 8, b.y + 6, printSize(7, w, h), 'right'), false);
  });
  const last = boxes[boxes.length - 1];
  if (last) drawCentred(v, input === 'keys' ? 'CLICK ONE OR PRESS ITS NUMBER' : 'TAP ONE', last.y + last.h + 12, printSize(8, w, h), alpha * 0.6);
}

function renderBreak(v: HudViewContext, b: Break): void {
  const top = challengeTopY(v.h, v.inset.top, v.homeY, true);
  if (b.result) {
    const alpha = Math.min(1, b.hold / 0.4);
    let y = top + 10;
    for (const line of b.result) {
      drawCentred(v, line.text, y, line.size, alpha * line.alpha, line.color);
      y += line.size + (line.size > 20 ? 24 : 17);
    }
    return;
  }
  const title =
    b.challenge.kind === 'line'
      ? `TYPE TO CHARGE THE SHIP FOR WAVE ${b.wave}`
      : `SOLVE TO CHARGE THE SHIP - ${b.total - b.left} OF ${b.total}`;
  renderChallenge(v, b.challenge, top, title);
}

function renderChallenge(v: HudViewContext, c: Challenge, top: number, title: string, titleColor = SAND): void {
  const { ctx, ink, w, h, room, input, reduceMotion, time } = v;
  const alpha = Math.min(1, c.age / 0.35);
  const done = c.outcome !== null;
  drawCentred(v, title, top, printSize(11, w, h), alpha * (titleColor === SAND ? 0.8 : 1), titleColor);

  if (c.kind === 'line') {
    renderLine(v, c, top + 40, alpha);
  } else {
    drawCentred(v, `${c.question} = ${done && c.kind === 'entry' ? c.answer : '?'}`, top + 32, 22, alpha);
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
        ink(correct ? PINK : SAND, a, 1.8, () => traceText(ctx, c.options[i]!, b.x + b.w / 2, b.y + (b.h - 16) / 2, 16, 'center'));
        // The number key that picks this answer, for players at a keyboard.
        if (!done && input === 'keys') ink(SAND, a * 0.55, 1, () => traceText(ctx, String(i + 1), b.x + 6, b.y + 6, printSize(7, w, h)), false);
      });
    } else {
      // The answer field: what has been typed so far, and a cursor after it.
      const field = { x: w / 2 - 66, y: top + 76, w: 132, h: 50 };
      const right = done && c.outcome?.success;
      // The field flashes red, and shakes, when a wrong answer has just been wiped for a second try.
      const wiped = !done && c.error > 0;
      if (wiped && !reduceMotion) field.x += rand(-3, 3);
      ink(right ? PINK : wiped ? NEON.red : SAND, alpha, right || wiped ? 2.6 : 1.5, () => ctx.rect(field.x, field.y, field.w, field.h));
      const typedWidth = textWidth(c.typed, 18);
      if (c.typed) ink(right ? PINK : SAND, alpha, 1.8, () => traceText(ctx, c.typed, w / 2, field.y + 16, 18, 'center'));
      if (!done && time % 0.9 < 0.55) {
        const cx = w / 2 + typedWidth / 2 + (c.typed ? 5 : -6);
        ink(SAND, alpha, 1.8, () => {
          ctx.moveTo(cx, field.y + 37);
          ctx.lineTo(cx + 12, field.y + 37);
        });
      }
    }
    renderTimer(v, c, top + 144, alpha);
  }

  // Under the question: how to answer it, then how the answer went. A miss always shows the right answer.
  const o = c.outcome;
  const hintY = c.kind === 'line' ? top + 124 : top + 158;
  if (o) {
    const said =
      o.success
        ? c.kind === 'line' ? 'NICE TYPING' : 'CORRECT'
        : c.kind === 'line' ? 'OUT OF TIME'
          : `${c.timeLeft <= 0 ? 'OUT OF TIME' : 'NOT QUITE'} - ${c.question} = ${c.kind === 'choice' ? c.options[c.correct] : c.answer}`;
    drawCentred(v, said, hintY, printSize(10, w, h), 1, o.success ? PINK : SAND);
  } else if (c.kind !== 'line') {
    const again = c.kind === 'entry' && c.misses > 0;
    const how = again ? 'NOT QUITE - ONE MORE TRY' : c.kind === 'entry' ? 'TYPE THE ANSWER' : input === 'keys' ? 'CLICK AN ANSWER OR PRESS ITS NUMBER' : 'TAP THE ANSWER';
    drawCentred(v, how, hintY, printSize(again ? 10 : 8, w, h), alpha * (again ? 1 : 0.6), again ? NEON.red : SAND);
  }
}

function renderLine(v: HudViewContext, c: LineChallenge, y: number, alpha: number): void {
  const { ctx, ink, w, h, room, reduceMotion } = v;
  const wrong = c.error > 0;
  // The line is laid out once, so typed and untyped letters keep their places as the colour moves across.
  const size = fitTo(c.text, 20, room);
  const step = advance(size);
  const x = w / 2 - textWidth(c.text, size) / 2 + (wrong && !reduceMotion ? rand(-3, 3) : 0);
  const next = x + c.index * step;
  if (c.index > 0) ink(PINK, alpha, 1.8, () => traceText(ctx, c.text.slice(0, c.index), x, y, size));
  if (c.index < c.text.length) {
    ink(SAND, alpha * (wrong ? 1 : 0.85), 1.6, () => traceText(ctx, c.text.slice(c.index), next, y, size));
    // Cursor under the next letter; it thickens and turns pink on a wrong key.
    ink(wrong ? PINK : SAND, alpha, wrong ? 3 : 1.8, () => {
      ctx.moveTo(next, y + size + 7);
      ctx.lineTo(next + (size / 6) * 4, y + size + 7);
    });
  }
  renderTimer(v, c, y + size + 30, alpha);
  const pressed = c.index + c.misses;
  if (!c.outcome) drawCentred(v, `ACCURACY ${pressed ? percent(c.index / pressed) : 100}%`, y + size + 46, printSize(9, w, h), alpha * 0.7);
}

/** Time left, as a line that shrinks toward the centre and turns pink for the last quarter. */
function renderTimer(v: HudViewContext, c: Challenge, y: number, alpha: number): void {
  const { ctx, ink, w, room } = v;
  const left = Math.max(0, c.timeLeft / c.limit);
  const half = Math.min(170, (room - 32) / 2) * left;
  ink(left < 0.25 ? PINK : SAND, alpha * 0.7, 1.4, () => {
    ctx.moveTo(w / 2 - half, y);
    ctx.lineTo(w / 2 + half, y);
  }, false);
}
