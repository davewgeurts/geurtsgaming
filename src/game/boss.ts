/**
 * The mini boss that closes every wave. Its red core is the only part that can be destroyed,
 * and it sits behind armour that is shut most of the time.
 *
 * - Odd waves bring the arms boss: jointed arms that shoot (and can be shot off), with armour
 *   that swings open on a timer.
 * - Even waves bring the sum boss: it shows a sum, and little ships line up under it carrying answers.
 *   Locking on to the ship with the right answer opens the armour; a wrong one makes it lash out.
 *
 * This file is the boss's behaviour and geometry. game.ts feeds it the world through `BossEnv`
 * and draws the `Part`s it hands back.
 */
import type { Problem } from './maths';
import { BOSS_CORE, BOSS_EYE, BOSS_SHELL, BOSS_WINGS, CLAW, POD, type Shape } from './shapes';

/** The loud colours kept for the boss and for anything exploding. */
export const NEON = {
  cyan: '#42f5ff',
  lime: '#9bff4d',
  yellow: '#ffe84a',
  orange: '#ff9b2f',
  red: '#ff3552',
  violet: '#b98cff',
} as const;
export const NEON_LIST: readonly string[] = Object.values(NEON);
const ARM_COLORS = [NEON.lime, NEON.yellow, NEON.orange, NEON.violet];
const WHITE = '#ffffff';

/** The boss is drawn larger than the ordinary ships: this multiplies the game's own scale. */
const SIZE = 1.3;
/** Sizes in px at scale 1. */
const CORE_R = 24;
const SHELL_R = 35;
const TIP_R = 13;
const POD_R = 19;
const POD_GAP = 92;
/** Hits in quick succession it takes to choose an answer ship, so a stray shot or two is not an answer. */
const LOCK = 5;
/** How far open the armour must be before shots reach the core. */
const EXPOSED = 0.6;
/** Seconds the boss stays before it gives up and leaves, so nobody is ever stuck on it. */
const PATIENCE = 45;

export interface BossEnv {
  w: number;
  h: number;
  /** Top safe-area inset. */
  top: number;
  scale: number;
  shipX: number;
  shipY: number;
  fire(x: number, y: number, vx: number, vy: number, color: string): void;
  burst(shape: Shape, x: number, y: number, scale: number, rot: number, color: string): void;
  problem(): Problem;
}

interface Arm { base: number; phase: number; color: string; hp: number; flash: number; fireIn: number }
interface Pod { slot: number; value: number; hits: number; cool: number; flash: number }

export interface Boss {
  kind: 'arms' | 'sum';
  wave: number;
  x: number;
  y: number;
  age: number;
  state: 'enter' | 'fight' | 'dying' | 'leaving' | 'gone';
  stateTime: number;
  hp: number;
  maxHp: number;
  defeated: boolean;
  /** Short timers for flashes: core hit, armour hit, lashing out. */
  flash: number;
  clang: number;
  rage: number;
  /** 0 is armour shut, 1 is wide open; it eases toward whichever `openFor` asks for. */
  open: number;
  /** Seconds the armour will stay open for. */
  openFor: number;
  /** Arms boss: seconds until the armour next opens. */
  cycle: number;
  arms: Arm[];
  /** Sum boss: the sum on show, the ships carrying answers, and a counter that ticks up with each new sum. */
  problem: Problem | null;
  problemId: number;
  pods: Pod[];
  /** Sum boss: seconds until the next sum appears. */
  nextSum: number;
  fireIn: number;
  timeLeft: number;
  popIn: number;
}

/** One stroke of the boss for the game to draw. `label` is a number to print on it. */
export interface Part { shape: Shape; x: number; y: number; scale: number; rot: number; color: string; width: number; alpha: number; label?: string }

/** What a player's shot did. */
export type Hit = 'miss' | 'blocked' | 'core' | 'down' | 'arm' | 'armOff' | 'lock' | 'right' | 'wrong';

const rand = (min: number, max: number) => min + Math.random() * (max - min);

export function createBoss(wave: number, env: BossEnv): Boss {
  const kind = wave % 2 === 0 ? 'sum' : 'arms';
  const hp = kind === 'arms' ? 16 + 7 * wave : 14 + 6 * wave;
  const count = Math.min(4, 2 + Math.floor((wave - 1) / 2));
  // Arms fan out below the body, from lower left round to lower right.
  const arms: Arm[] =
    kind === 'arms'
      ? Array.from({ length: count }, (_, i) => ({
          base: ((30 + (120 * i) / (count - 1)) * Math.PI) / 180,
          phase: i * 1.7,
          color: ARM_COLORS[i % ARM_COLORS.length]!,
          hp: 3 + Math.floor(wave / 2),
          flash: 0,
          fireIn: 2.4 + i * 0.9,
        }))
      : [];
  return {
    kind, wave,
    x: env.w / 2, y: -90 * env.scale * SIZE,
    age: 0, state: 'enter', stateTime: 0,
    hp, maxHp: hp, defeated: false,
    flash: 0, clang: 0, rage: 0,
    open: 0, openFor: 0, cycle: 2.2,
    arms,
    problem: null, problemId: 0, pods: [], nextSum: 0.4,
    fireIn: 2.4, timeLeft: PATIENCE, popIn: 0,
  };
}

function setState(b: Boss, state: Boss['state']): void {
  b.state = state;
  b.stateTime = 0;
}

function aim(b: Boss, env: BossEnv, x: number, y: number, color: string): void {
  const dx = env.shipX - x;
  const dy = env.shipY - y;
  const dist = Math.hypot(dx, dy) || 1;
  const speed = Math.min(280, 200 + b.wave * 8);
  env.fire(x, y, (dx / dist) * speed, (dy / dist) * speed, color);
}

/** The first bosses are gentle; later ones shoot faster and throw wider rings. */
const tempo = (b: Boss) => Math.max(0.65, 1 - 0.07 * (b.wave - 1));
const volley = (b: Boss) => Math.min(12, 7 + b.wave);

/** A ring of shots in every direction. */
function lashOut(env: BossEnv, x: number, y: number, count: number, color: string): void {
  const offset = rand(0, Math.PI * 2);
  for (let i = 0; i < count; i++) {
    const a = offset + (i / count) * Math.PI * 2;
    env.fire(x, y, Math.cos(a) * 170, Math.sin(a) * 170, color);
  }
}

/** Where an arm's shoulder, elbow and hand are right now. */
function armPoints(b: Boss, arm: Arm, s: number) {
  const angle = arm.base + Math.sin(b.age * 1.4 + arm.phase) * 0.22;
  const reach = SHELL_R + 66 + Math.sin(b.age * 0.9 + arm.phase) * 8;
  const bend = angle + (arm.base < Math.PI / 2 ? -0.42 : 0.42);
  return {
    sx: b.x + Math.cos(angle) * SHELL_R * s, sy: b.y + Math.sin(angle) * SHELL_R * s,
    ex: b.x + Math.cos(bend) * (SHELL_R + 30) * s, ey: b.y + Math.sin(bend) * (SHELL_R + 30) * s,
    tx: b.x + Math.cos(angle) * reach * s, ty: b.y + Math.sin(angle) * reach * s,
    angle,
  };
}

/** The little ships hang in a row under the boss, far enough apart to aim at one without hitting its neighbours. */
function podPoint(b: Boss, pod: Pod, s: number) {
  const middle = (b.pods.length - 1) / 2;
  return { x: b.x + (pod.slot - middle) * POD_GAP * s, y: b.y + (82 + Math.sin(b.age * 2 + pod.slot * 2) * 5) * s };
}

function newSum(b: Boss, env: BossEnv): void {
  b.problem = env.problem();
  b.problemId += 1;
  b.pods = b.problem.options.map((value, slot) => ({ slot, value, hits: 0, cool: 0, flash: 0 }));
}

export function updateBoss(b: Boss, dt: number, env: BossEnv): void {
  const s = env.scale * SIZE;
  b.age += dt;
  b.stateTime += dt;
  b.flash = Math.max(0, b.flash - dt);
  b.clang = Math.max(0, b.clang - dt);
  b.rage = Math.max(0, b.rage - dt);
  for (const arm of b.arms) arm.flash = Math.max(0, arm.flash - dt);
  for (const pod of b.pods) {
    pod.flash = Math.max(0, pod.flash - dt);
    // A lock that is not kept up fades, so brushing past a ship never adds up to choosing it.
    pod.cool -= dt;
    if (pod.cool <= 0) pod.hits = 0;
  }
  b.open += ((b.openFor > 0 ? 1 : 0) - b.open) * (1 - Math.exp(-dt * 7));

  if (b.state === 'enter') {
    const restY = Math.max(env.top + 170, env.h * 0.25);
    b.y += (restY - b.y) * (1 - Math.exp(-dt * 2.4));
    if (b.stateTime > 2) setState(b, 'fight');
    return;
  }
  if (b.state === 'leaving') {
    b.y -= 240 * dt;
    if (b.y < -140 * s) setState(b, 'gone');
    return;
  }
  if (b.state === 'dying') {
    // It comes apart in a string of small explosions, then one big one.
    b.popIn -= dt;
    if (b.popIn <= 0) {
      b.popIn = 0.1;
      env.burst(BOSS_EYE, b.x + rand(-60, 60) * s, b.y + rand(-40, 40) * s, s * rand(0.8, 1.8), rand(0, 6), NEON_LIST[Math.floor(rand(0, NEON_LIST.length))]!);
    }
    if (b.stateTime > 1.2) {
      env.burst(BOSS_CORE, b.x, b.y, s * 1.4, 0, NEON.red);
      env.burst(BOSS_SHELL, b.x, b.y, s * 1.2, 0, NEON.cyan);
      env.burst(BOSS_SHELL, b.x, b.y, s * 1.2, Math.PI, NEON.cyan);
      env.burst(BOSS_WINGS, b.x, b.y, s, 0, NEON.violet);
      env.burst(BOSS_EYE, b.x, b.y, s * 2.4, 0, NEON.yellow);
      setState(b, 'gone');
    }
    return;
  }
  if (b.state !== 'fight') return;

  b.timeLeft -= dt;
  if (b.timeLeft <= 0) {
    b.pods = [];
    b.openFor = 0;
    setState(b, 'leaving');
    return;
  }
  // It sweeps from side to side, but never so far that its wings or its answer ships leave the screen.
  const halfWidth = b.kind === 'sum' ? POD_GAP + POD_R + 6 : 106;
  b.x = env.w / 2 + Math.sin(b.stateTime * 0.55) * Math.max(0, Math.min(env.w / 2 - halfWidth * s, 190 * s));

  if (b.kind === 'arms') {
    if (b.openFor > 0) {
      b.openFor -= dt;
      // With its arms gone it has nothing left to hide behind for long.
      if (b.openFor <= 0) b.cycle = b.arms.length ? 4.2 : 2.2;
    } else {
      b.cycle -= dt;
      if (b.cycle <= 0) {
        b.openFor = 3.2;
        lashOut(env, b.x, b.y, volley(b), NEON.red);
      }
    }
    for (const arm of b.arms) {
      arm.fireIn -= dt;
      if (arm.fireIn <= 0) {
        arm.fireIn = rand(3.2, 4.6) * tempo(b);
        const p = armPoints(b, arm, s);
        aim(b, env, p.tx, p.ty, arm.color);
      }
    }
  } else {
    if (b.openFor > 0) {
      b.openFor -= dt;
      if (b.openFor <= 0) b.nextSum = 0.5;
    } else if (!b.pods.length) {
      b.nextSum -= dt;
      if (b.nextSum <= 0) newSum(b, env);
    }
    b.fireIn -= dt;
    if (b.fireIn <= 0) {
      b.fireIn = rand(3, 4.2) * tempo(b);
      aim(b, env, b.x, b.y + SHELL_R * s, NEON.orange);
    }
  }
}

/** Test a player's shot at (x, y) against the boss, and apply whatever it does. */
export function shootBoss(b: Boss, x: number, y: number, env: BossEnv): Hit {
  const s = env.scale * SIZE;
  if (b.state !== 'fight' && b.state !== 'enter') return 'miss';
  const fighting = b.state === 'fight';

  for (const arm of b.arms) {
    const p = armPoints(b, arm, s);
    if (Math.hypot(x - p.tx, y - p.ty) > TIP_R * s) continue;
    if (!fighting) return 'blocked';
    arm.hp -= 1;
    arm.flash = 0.1;
    if (arm.hp > 0) return 'arm';
    env.burst(CLAW, p.tx, p.ty, s * 1.4, p.angle - Math.PI / 2, arm.color);
    env.burst([{ pts: [[p.sx, p.sy], [p.ex, p.ey], [p.tx, p.ty]], closed: false }], 0, 0, 1, 0, arm.color);
    b.arms = b.arms.filter((a) => a !== arm);
    return 'armOff';
  }

  for (const pod of b.pods) {
    const p = podPoint(b, pod, s);
    if (Math.hypot(x - p.x, y - p.y) > POD_R * s) continue;
    if (!fighting || !b.problem) return 'blocked';
    pod.hits += 1;
    pod.cool = 0.7;
    pod.flash = 0.08;
    if (pod.hits < LOCK) return 'lock';
    const right = pod.value === b.problem.answer;
    // That ship is chosen, and this round of ships is over: the right one opens the armour, a wrong one sets the boss off.
    for (const other of b.pods) {
      const q = podPoint(b, other, s);
      env.burst(POD, q.x, q.y, s, 0, other === pod ? (right ? NEON.lime : NEON.red) : NEON.yellow);
    }
    b.pods = [];
    if (right) {
      b.openFor = 5;
    } else {
      b.rage = 0.6;
      b.nextSum = 1.4;
      lashOut(env, b.x, b.y, volley(b) + 2, NEON.red);
    }
    return right ? 'right' : 'wrong';
  }

  const dist = Math.hypot(x - b.x, y - b.y);
  if (fighting && b.open > EXPOSED) {
    if (dist > (CORE_R + 4) * s) return 'miss';
    b.hp -= 1;
    b.flash = 0.08;
    if (b.hp > 0) return 'core';
    b.defeated = true;
    b.pods = [];
    setState(b, 'dying');
    return 'down';
  }
  if (dist > (SHELL_R + 3) * s) return 'miss';
  b.clang = 0.12;
  return 'blocked';
}

/** Whether something of radius `r` at (x, y), such as the player's ship, is touching the boss. */
export function touchesBoss(b: Boss, x: number, y: number, r: number, env: BossEnv): boolean {
  const s = env.scale * SIZE;
  if (b.state !== 'fight' && b.state !== 'enter') return false;
  if (Math.hypot(x - b.x, y - b.y) < SHELL_R * s + r) return true;
  for (const arm of b.arms) {
    const p = armPoints(b, arm, s);
    if (Math.hypot(x - p.tx, y - p.ty) < TIP_R * s + r) return true;
  }
  return b.pods.some((pod) => {
    const p = podPoint(b, pod, s);
    return Math.hypot(x - p.x, y - p.y) < POD_R * s + r;
  });
}

/** Everything to draw, back to front. */
export function bossParts(b: Boss, env: BossEnv, time: number): Part[] {
  const s = env.scale * SIZE;
  const parts: Part[] = [];
  if (b.state === 'gone') return parts;
  // It fades in as it arrives and flickers as it dies.
  const alpha = b.state === 'enter' ? Math.min(1, b.stateTime / 0.8) : b.state === 'dying' ? (Math.floor(time * 30) % 2 ? 1 : 0.35) : 1;
  const add = (shape: Shape, x: number, y: number, scale: number, rot: number, color: string, width: number, a = 1, label?: string) =>
    parts.push({ shape, x, y, scale, rot, color, width, alpha: alpha * a, label });

  add(BOSS_WINGS, b.x, b.y, s, 0, b.rage > 0 ? NEON.red : NEON.violet, 1.8);

  for (const arm of b.arms) {
    const p = armPoints(b, arm, s);
    const color = arm.flash > 0 ? WHITE : arm.color;
    add([{ pts: [[p.sx, p.sy], [p.ex, p.ey], [p.tx, p.ty]], closed: false }], 0, 0, 1, 0, color, 1.8);
    add(CLAW, p.tx, p.ty, s * 1.15, p.angle - Math.PI / 2, color, 2);
  }

  // The core: dull behind shut armour, blazing and beating once it is exposed.
  const beat = 1 + 0.07 * Math.sin(time * 9) * b.open;
  const coreColor = b.flash > 0 ? WHITE : NEON.red;
  add(BOSS_CORE, b.x, b.y, s * beat, 0, coreColor, 2 + 1.6 * b.open, 0.4 + 0.6 * b.open);
  add(BOSS_EYE, b.x, b.y, s * beat, time * 1.5, coreColor, 1.6 + b.open, 0.4 + 0.6 * b.open);

  // The armour: two half shells that slide apart.
  const gap = b.open * 26 * s;
  const shell = b.clang > 0 ? WHITE : b.rage > 0 ? NEON.red : NEON.cyan;
  add(BOSS_SHELL, b.x + gap, b.y, s, 0, shell, 2.2);
  add(BOSS_SHELL, b.x - gap, b.y, s, Math.PI, shell, 2.2);

  for (const pod of b.pods) {
    const p = podPoint(b, pod, s);
    // A ship being locked on to swells and brightens with every hit.
    add(POD, p.x, p.y, s * (1 + 0.05 * pod.hits), 0, pod.flash > 0 ? WHITE : NEON.yellow, 1.8 + 0.5 * pod.hits, 1, String(pod.value));
  }
  return parts;
}
