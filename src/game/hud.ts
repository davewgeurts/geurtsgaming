/**
 * HUD, corner faces, commander asteroid alert, fuel tanker overlay, and challenge/upgrade panels.
 */
import { renderAvatarFrame, type Mood, type Who } from './avatar';
import type { Boss } from './boss';
import type { Challenge, LineChallenge } from './challenge';
import { NEON, NEON_LIST, PINK, SAND, SOUL, clamp, pad6, percent, rand, type Ink } from './core';
import { GRADE_COLOR, type Grade } from './fireworks';
import { advance, fitTo, textWidth, traceText } from './font';
import { BRIEFING } from './lines';
import { THEME_BY_ID, type PilotId, type ShipId, type ThemeId } from './loadout';
import { renderLeaderboardPanel, type PilotScore } from './multiplayer';
import { GRADE_BANDS, STAKES, gradeOf, type Break, type Prompt } from './questions';
import { ALERT_SECONDS, ALERT_TURN } from './setpieces';
import { DROGUE, PERSON_OUT, PERSON_UP, SHIP, TANKER, shipShape, trace } from './shapes';
import { FUEL_SECONDS, PATIENCE, TANKER_SIZE, tankerTail, type Tanker, type TankerEnv } from './tanker';
import { UPGRADES, type Upgrade, type UpgradeId } from './upgrades';
import { TRIPLE_AT } from './weapons';

/**
 * On a short screen: how far in from the right edge the boss's corner reaches (its face, then its health
 * bar and its taunts, which are kept to SHORT_TAUNT px wide there).
 */
export const SHORT_TAUNT = 130;
export const BOSS_CORNER = 12 + 50 + 10 + SHORT_TAUNT + 10;

export interface Box { x: number; y: number; w: number; h: number }

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
  /**
   * How far down, in these coordinates, the page's own buttons reach (top right). Co-op's scaled arena can start
   * under them; solo leaves it out (its HUD is in screen pixels, already clear of them).
   */
  controlsBottom?: number;
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
  callsign?: string;
  onlineCount?: number;
  wingmenCount?: number;
  lastRank?: number | null;
  totalLiberated?: number;
  topPilots?: readonly PilotScore[];
  showLeaderboard?: boolean;
  /** Optional Co-op role (`'host'` or `'guest'`) so Game Over / Pause prompts match squad capabilities. */
  coopRole?: 'host' | 'guest';
  /** Seconds the question "what grade are you in?" has been up, or null when it is not being asked. */
  grading?: number | null;
  /** Chosen playable pilot face, colour theme and ship silhouette from the hangar. */
  pilotId?: PilotId;
  themeId?: ThemeId;
  shipId?: ShipId;
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
    const size = printSize(8, w, h);
    ink(lost ? NEON.red : NEON.lime, alpha, 1.2, () => traceText(ctx, label, t.drogue.x, t.drogue.y + 9 * sc, size, 'center'), false);
    // Under it, how long the fuel ship will still wait: the clock only runs while nobody is on the line.
    renderCountdown(v, t.drogue.x - size * 0.7, t.drogue.y + 9 * sc + size + 11, Math.max(30, 34 * sc), t.patience / PATIENCE, t.patience, 1, printSize(9, w, h));
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
  const theme = THEME_BY_ID[v.themeId ?? 'starlight'];
  const avatarWho: Who = pilot && v.pilotId ? v.pilotId : who;
  const head = pilot ? theme.hull : NEON.violet;
  const face = pilot ? (mood === 'hurt' ? PINK : mood === 'happy' ? NEON.lime : SAND) : mood === 'hurt' ? '#ffffff' : NEON.red;

  renderAvatarFrame({
    ctx,
    ink,
    who: avatarWho,
    x,
    y,
    box,
    yaw,
    pitch,
    mood,
    time: t,
    cutRatio: 0.18,
    cyRatio: pilot ? 0.48 : 0.54,
    sizeRatio: pilot ? 0.32 : 0.3,
    headColor: head,
    headAlpha: 0.5,
    headWidth: 1.05,
    faceColor: face,
    faceWidth: 1.5,
    frameColor: head,
    frameAlpha: 0.78,
    frameWidth: 1.3,
    frameGlow: false,
    pilotConsole: pilot,
    consoleColor: theme.hull,
  });
}

export function renderHud(v: HudViewContext): void {
  const { ctx, ink, w, h, inset, hull, maxHull, wave, score, best, reduceMotion, freed, freedPulse, jam, energy, time, upgrades, villain, boss } = v;
  const theme = THEME_BY_ID[v.themeId ?? 'starlight'];
  const hullIcon = v.shipId ? shipShape(v.shipId) : SHIP;
  const box = faceBoxSize(w, h);
  const small = box < 60;
  const left = inset.left + 12;
  const top = inset.top + 12;

  // Top left: the pilot in the cockpit, with score, hull, wave and energy beside the face.
  renderFace(v, 'pilot', left, top, box);
  const x0 = left + box + 10;
  const hullY = top + (small ? 26 : Math.round(box * 0.5) + 1);
  const hullGap = small ? (maxHull > 4 ? 17 : 20) : (maxHull > 4 ? 20 : 24);
  const hullScale = small ? 0.48 : 0.55;
  const waveY = top + box - (small ? 9 : 10);
  const waveSize = small ? 8 : 9;
  const waveText = `WAVE ${wave}`;
  const line = scoreLineLayout(w, h, inset.left, inset.top, score);
  ink(SAND, 1, 1.4, () => {
    traceText(ctx, line.text, line.x, line.y, line.size);
    if (w >= 720) traceText(ctx, `BEST ${pad6(best)}`, w / 2, top + 1, 12, 'center');
  });
  if (hull > 0) {
    ink(theme.hull, 1, 1.4, () => {
      for (let i = 0; i < hull; i++) trace(ctx, hullIcon, x0 + 8 + i * hullGap, hullY, hullScale, 0);
    });
  }
  if (w >= 720 && v.callsign) {
    const squadText = `${v.callsign} - ${Math.max(1, v.onlineCount ?? 1)} ONLINE`;
    ink(NEON.cyan, 0.65, 1.1, () => traceText(ctx, squadText, w / 2, top + 18, 7.5, 'center'), false);
  }
  // Hull points that have been lost stay as faint outlines, so it is clear how many there are to win back.
  if (hull < maxHull) {
    ink(theme.hull, 0.25, 1, () => {
      for (let i = Math.max(0, hull); i < maxHull; i++) trace(ctx, hullIcon, x0 + 8 + i * hullGap, hullY, hullScale, 0);
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
    ink(theme.thruster, 1, 1.6, ticks(0, lit));
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
  const by = Math.max(inset.top + 64, (v.controlsBottom ?? 0) + 8);
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

  if (v.showLeaderboard && (paused || state !== 'playing')) {
    renderLeaderboardPanel(
      v.ctx,
      v.ink,
      v.w,
      h,
      v.room,
      Math.max(inset.top + 64, h * 0.14),
      v.topPilots ?? [],
      v.callsign ?? 'PILOT',
      v.lastRank ?? null,
      v.totalLiberated ?? 0,
      v.onlineCount ?? 1,
      1,
      coarse,
    );
    return;
  }

  if (paused) {
    drawCentred(v, 'PAUSED', mid, 28);
    drawCentred(v, coarse ? 'TAP TO RESUME' : 'PRESS P TO RESUME', mid + 52, 11, 0.8);
    if (!v.coopRole) {
      drawCentred(v, coarse ? 'TAP THE STAR FOR THE TOP 10 PILOTS' : 'PRESS L FOR TOP 10 PILOTS', mid + 78, 9, 0.72, NEON.cyan);
    }
    return;
  }

  // In the cockpit, the words on the glass and the commander's briefing are intro.ts's.
  if (state === 'ready') return;

  if (v.grading != null) {
    renderGradePicker(v, v.grading);
    return;
  }

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
    // A squad's game over is its mission summary (coop-quiz.ts renderSquadMissionSummary), not these solo lines.
    if (v.coopRole) return;
    const alpha = Math.min(1, stateTime / 0.5);
    drawCentred(v, 'GAME OVER', mid - 38, 32, alpha);
    drawCentred(v, `SCORE ${pad6(score)}`, mid + 20, 15, alpha);
    drawCentred(v, newBest ? 'NEW BEST!' : `BEST ${pad6(best)}`, mid + 48, 11, alpha * 0.8, newBest ? PINK : SAND);
    const totalFreed = freed + soulsInFlight;
    drawCentred(v, totalFreed === 1 ? 'YOU SET 1 PERSON FREE' : `YOU SET ${totalFreed} PEOPLE FREE`, mid + 72, 11, alpha, SOUL);
    if (v.lastRank) {
      drawCentred(v, `TOP 10 PILOT RANK ${v.lastRank} - ${v.callsign ?? 'PILOT'}`, mid + 96, 10, alpha, NEON.cyan);
    } else if (v.callsign) {
      drawCentred(v, coarse ? `PILOT ${v.callsign} - TAP THE STAR FOR THE TOP 10` : `PILOT ${v.callsign} - L: TOP 10 PILOTS`, mid + 96, 9, alpha * 0.8, NEON.cyan);
    }
    if (stateTime > 0.9 && blink) {
      drawCentred(v, coarse ? 'TAP TO RETRY' : 'PRESS SPACE TO RETRY - L FOR TOP 10 - ESC TO EXIT', mid + 126, 10, 0.9);
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

/**
 * Before the first challenge: which school years the player is in, so the questions fit. Three rows to click,
 * tap or pick by number, laid out by `offerBoxes` (which is also how a click is matched to one).
 */
function renderGradePicker(v: HudViewContext, age: number): void {
  const { ctx, ink, w, h, room, input, inset, homeY } = v;
  const alpha = Math.min(1, age / 0.35);
  const top = challengeTopY(h, inset.top, homeY, true);
  drawCentred(v, 'WHAT GRADE ARE YOU IN, PILOT?', top - 26, printSize(13, w, h), alpha, NEON.cyan);
  drawCentred(v, 'IT SETS HOW HARD THE QUESTIONS ARE. IT IS NOT SAVED.', top, printSize(8, w, h), alpha * 0.7);
  offerBoxes(w, h, room, top, GRADE_BANDS.length).forEach((b, i) => {
    const band = GRADE_BANDS[i]!;
    const big = fitTo(band.label, b.h > 50 ? 16 : 13, b.w * 0.6);
    const small = printSize(8, w, h);
    ink(SAND, alpha, 1.6, () => ctx.rect(b.x, b.y, b.w, b.h));
    ink(SAND, alpha, 1.8, () => traceText(ctx, band.label, b.x + (input === 'keys' ? 34 : 16), b.y + (b.h - big) / 2, big));
    ink(NEON.cyan, alpha * 0.9, 1.2, () => traceText(ctx, band.ages, b.x + b.w - 14, b.y + (b.h - small) / 2, small, 'right'), false);
    if (input === 'keys') ink(SAND, alpha * 0.6, 1.2, () => traceText(ctx, String(i + 1), b.x + 12, b.y + (b.h - small) / 2, small), false);
  });
}

function renderBreak(v: HudViewContext, b: Break): void {
  const top = challengeTopY(v.h, v.inset.top, v.homeY, true);
  if (b.result) {
    const alpha = Math.min(1, b.hold / 0.4);
    renderBadge(v, b.challenge.kind === 'line' ? 'TYPING CHALLENGE' : 'MATH CHALLENGE', top, b.grade, alpha);
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
  renderBadge(v, c.kind === 'line' ? 'TYPING CHALLENGE' : 'MATH CHALLENGE', top, gradeOf(c), alpha);
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

/** Time left to answer: a bar that drains, with the seconds beside it. Once the answer is in it stops, and dims. */
function renderTimer(v: HudViewContext, c: Challenge, y: number, alpha: number): void {
  const size = printSize(12, v.w, v.h);
  // The bar sits a little left of centre, to leave room for the number after it.
  const half = Math.min(150, (v.room - 32) / 2 - size);
  renderCountdown(v, v.w / 2 - size * 0.7, y, half, c.timeLeft / c.limit, c.timeLeft, alpha * (c.outcome ? 0.4 : 1), size, c.outcome === null);
}

/**
 * A countdown: a track with a bar in it that drains from the right, and the whole seconds left after it.
 * Green with time to spare, yellow under half, red under a quarter; in the last three seconds the number
 * beats once a second. `left` is the share of the time that remains, 0 to 1.
 */
function renderCountdown(
  v: HudViewContext,
  cx: number,
  y: number,
  half: number,
  left: number,
  seconds: number,
  alpha: number,
  size: number,
  running = true,
): void {
  const { ctx, ink, reduceMotion } = v;
  const share = clamp(left, 0, 1);
  const color = share > 0.5 ? NEON.lime : share > 0.25 ? NEON.yellow : NEON.red;
  const count = Math.max(0, Math.ceil(seconds));
  const urgent = running && count <= 3 && share > 0;
  // The beat: big at the start of each of the last seconds, easing back before the next.
  const beat = urgent && !reduceMotion ? 1 + 0.45 * (seconds - Math.floor(seconds)) : 1;
  const x0 = cx - half;
  const tall = Math.max(6, size * 0.6);
  ink(SAND, alpha * 0.3, 1, () => ctx.rect(x0, y - tall / 2, half * 2, tall), false);
  if (share > 0) {
    const inset = tall / 2;
    ink(color, alpha, tall - 3, () => {
      ctx.moveTo(x0 + inset, y);
      ctx.lineTo(x0 + inset + (half * 2 - inset * 2) * share, y);
    }, running);
  }
  const text = size * beat;
  ink(color, alpha, urgent ? 2 : 1.6, () => traceText(ctx, String(count), cx + half + 8, y - text / 2, text), urgent);
}

/** The neon colours the "Play the demo" button's frame cycles through, in order round the circle. */
const BADGE_COLORS = ['#42f5ff', '#b98cff', '#ff5ea8', '#ffe84a', '#9bff4d', '#42f5ff'];
/** What the badge says once the challenge is over. */
const VERDICTS: Record<Grade, string> = { failed: 'CHALLENGE FAILED', good: 'GOOD JOB!', perfect: 'PERFECT!' };

/**
 * The badge above a challenge: what kind it is, in a frame that glows and cycles through the game's neon
 * colours like the "Play the demo" button. Once the challenge is over the frame and the words turn to how
 * it went: red for failed, yellow for good, green for perfect. `top` is where the challenge's title starts.
 */
function renderBadge(v: HudViewContext, label: string, top: number, grade: Grade | null, alpha: number): void {
  const { ctx, ink, w, h, room, time, reduceMotion } = v;
  const text = grade ? VERDICTS[grade] : label;
  const size = fitTo(text, printSize(grade ? 13 : 11, w, h), room - 56);
  const tall = size + 16;
  const wide = textWidth(text, size) + size * 2.6;
  const x = w / 2 - wide / 2;
  const y = top - tall - 12;
  const cx = w / 2;
  const cy = y + tall / 2;
  const frame = (): void => {
    const r = Math.min(10, tall / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + wide, y, x + wide, y + tall, r);
    ctx.arcTo(x + wide, y + tall, x, y + tall, r);
    ctx.arcTo(x, y + tall, x, y, r);
    ctx.arcTo(x, y, x + wide, y, r);
    ctx.closePath();
  };
  // The frame's colours: the neon wheel, turning once every five seconds, or the one colour of the verdict.
  let stroke: string | CanvasGradient = grade ? GRADE_COLOR[grade] : BADGE_COLORS[0]!;
  let glow: string = grade ? GRADE_COLOR[grade] : BADGE_COLORS[Math.floor(time * 1.2) % (BADGE_COLORS.length - 1)]!;
  if (!grade && typeof ctx.createConicGradient === 'function') {
    const wheel = ctx.createConicGradient(reduceMotion ? 0.7 : (time * Math.PI * 2) / 5, cx, cy);
    BADGE_COLORS.forEach((color, i) => wheel.addColorStop(i / (BADGE_COLORS.length - 1), color));
    stroke = wheel;
    glow = '#b98cff';
  }
  const breath = reduceMotion ? 1 : 0.8 + 0.2 * Math.sin(time * (grade ? 9 : 2.4));

  ctx.save();
  ctx.beginPath();
  frame();
  ctx.globalAlpha = alpha * 0.82;
  ctx.fillStyle = 'rgb(4, 10, 40)';
  ctx.fill();
  // A soft halo, then the frame itself.
  ctx.strokeStyle = stroke;
  ctx.shadowColor = glow;
  ctx.shadowBlur = 22;
  ctx.globalAlpha = alpha * 0.35 * breath;
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.shadowBlur = 10;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  ink(grade ? GRADE_COLOR[grade] : SAND, alpha * (grade ? breath : 1), grade ? 2 : 1.7, () => traceText(ctx, text, cx, y + 8, size, 'center'));
}
