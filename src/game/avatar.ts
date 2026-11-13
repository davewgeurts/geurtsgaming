/**
 * The faces of the arcade demo: the playable low-poly pilots (boys, girls and animals, top left and in
 * the hangar picker), the boss (top right), and the flight commander on the cockpit's comms screen.
 *
 * Each is a small wireframe head: a handful of points in 3D, joined by straight lines, turned a little
 * and flattened onto the screen. Turning the head is what makes plain line polygons read as solid.
 * The eight playable pilot meshes and reactive emotion rigs live in `pilot-avatars.ts`.
 */
import { NEON, PINK, SAND, type Ink } from './core';
import { PILOT_BY_ID, isPilotId, type PilotId } from './loadout';
import {
  AVATAR_BACK as BACK,
  AVATAR_FRONT as FRONT,
  PILOT_NOSE_LINES as PILOT_NOSE,
  bothSides as both,
  buildPlayableFace,
  buildPlayableHead,
  crossEye as cross,
  flatLine as flat,
  prism3d as prism,
  type AvatarLine as Line,
  type HeadTone,
  type Mood,
} from './pilot-avatars';

export type { HeadTone, Mood };
export type Who = 'pilot' | 'boss' | 'commander' | PilotId;

const toned = (tone: HeadTone, lines: readonly Line[]): Line[] =>
  lines.map((l) => ({ ...l, tone }));

const PILOT_OUTLINE = [[-0.42, -0.9], [0.42, -0.9], [0.78, -0.45], [0.7, 0.3], [0.36, 0.88], [-0.36, 0.88], [-0.7, 0.3], [-0.78, -0.45]] as const;
const PILOT_HEAD: Line[] = [
  ...prism(PILOT_OUTLINE, 0.82),
  // Helmet brim, the stalk of a headset microphone, and a neck and shoulders.
  { pts: [[-0.78, -0.45, FRONT], [0.78, -0.45, FRONT]] },
  { pts: [[0.74, 0.02, 0.1], [0.62, 0.56, 0.62], [0.36, 0.62, 0.7]] },
  { pts: [[-0.2, 0.88, 0.2], [-0.2, 1.18, 0]] },
  { pts: [[0.2, 0.88, 0.2], [0.2, 1.18, 0]] },
  { pts: [[-1.2, 1.6, 0], [-0.6, 1.18, 0], [0.6, 1.18, 0], [1.2, 1.6, 0]] },
];

const BOSS_OUTLINE = [[-0.8, -0.62], [-0.3, -0.82], [0.3, -0.82], [0.8, -0.62], [0.62, 0.12], [0.24, 0.92], [-0.24, 0.92], [-0.62, 0.12]] as const;
const BOSS_HEAD: Line[] = [
  ...prism(BOSS_OUTLINE, 0.8),
  // Horns, each a spike with three edges, and a ridge down the forehead.
  ...both({ pts: [[-0.8, -0.62, FRONT], [-1.22, -1.38, 0], [-0.42, -0.78, FRONT]] }),
  ...both({ pts: [[-1.22, -1.38, 0], [-0.64, -0.5, BACK]] }),
  { pts: [[0, -0.82, FRONT], [0, -0.34, 0.68], [-0.1, -0.2, FRONT]] },
  { pts: [[0, -0.34, 0.68], [0.1, -0.2, FRONT]] },
];

const COMMANDER_OUTLINE = [[-0.62, -0.6], [0.62, -0.6], [0.76, -0.08], [0.68, 0.5], [0.36, 0.92], [-0.36, 0.92], [-0.68, 0.5], [-0.76, -0.08]] as const;
const CAP = [[-0.7, -0.6], [0.7, -0.6], [0.6, -1.06], [-0.6, -1.06]] as const;
const COMMANDER_HEAD: Line[] = [
  ...prism(COMMANDER_OUTLINE, 0.84),
  // A peaked cap: the crown, its peak sticking out over the eyes, and a badge.
  ...prism(CAP, 0.86),
  { pts: [[-0.7, -0.6, FRONT], [-0.5, -0.47, 0.98], [0.5, -0.47, 0.98], [0.7, -0.6, FRONT]] },
  { pts: [[0, -0.95, FRONT + 0.02], [0.1, -0.82, FRONT + 0.02], [0, -0.69, FRONT + 0.02], [-0.1, -0.82, FRONT + 0.02]], closed: true },
  // A headset: an ear cup on each side and a microphone on a stalk.
  ...both({ pts: [[0.78, -0.2, 0.2], [0.9, -0.2, 0], [0.9, 0.22, 0], [0.78, 0.22, 0.2]], closed: true }),
  { pts: [[-0.8, 0.2, 0.15], [-0.62, 0.62, 0.66], [-0.34, 0.66, 0.74]] },
  // Neck, shoulders, and a stripe on each shoulder.
  { pts: [[-0.22, 0.92, 0.2], [-0.22, 1.2, 0]] },
  { pts: [[0.22, 0.92, 0.2], [0.22, 1.2, 0]] },
  { pts: [[-1.3, 1.62, 0], [-0.66, 1.2, 0], [0.66, 1.2, 0], [1.3, 1.62, 0]] },
  ...both({ pts: [[0.74, 1.3, 0.02], [1.06, 1.5, 0.02]] }),
];

/** The commander: level brows, a moustache, and a mouth that moves when talking. */
function commanderFace(mood: Mood, time: number): Line[] {
  const ex = 0.33;
  const ey = -0.14;
  const my = 0.62;
  const lines: Line[] = [...PILOT_NOSE];
  const worried = mood === 'worried';
  if (mood === 'happy') {
    lines.push(...both(flat([[ex - 0.13, ey + 0.04], [ex, ey - 0.08], [ex + 0.13, ey + 0.04]])));
  } else if (worried) {
    lines.push(...both(flat([[ex - 0.13, ey - 0.1], [ex + 0.13, ey - 0.1], [ex + 0.11, ey + 0.09], [ex - 0.11, ey + 0.09]], true)));
  } else if (time % 4.3 < 0.12) {
    lines.push(...both(flat([[ex - 0.12, ey], [ex + 0.12, ey]])));
  } else {
    lines.push(...both(flat([[ex - 0.12, ey - 0.05], [ex + 0.12, ey - 0.05], [ex + 0.1, ey + 0.06], [ex - 0.1, ey + 0.06]], true)));
  }
  lines.push(...both(worried ? flat([[ex - 0.17, ey - 0.37], [ex + 0.19, ey - 0.22]]) : flat([[ex - 0.17, ey - 0.2], [ex + 0.17, ey - 0.2]])));
  lines.push(flat([[-0.3, 0.44], [-0.12, 0.34], [0, 0.4], [0.12, 0.34], [0.3, 0.44]]));
  if (worried) {
    const gape = 0.06 + 0.13 * Math.abs(Math.sin(time * 12));
    lines.push(flat([[-0.12, my - 0.05], [0.12, my - 0.05], [0.19, my + 0.02 + gape], [-0.19, my + 0.02 + gape]], true));
  } else if (mood === 'talk') {
    const gape = 0.03 + 0.13 * Math.abs(Math.sin(time * 11));
    lines.push(flat([[-0.16, my - 0.04], [0.16, my - 0.04], [0.11, my - 0.04 + gape], [-0.11, my - 0.04 + gape]], true));
  } else if (mood === 'happy') {
    lines.push(flat([[-0.24, my - 0.06], [-0.1, my + 0.05], [0.1, my + 0.05], [0.24, my - 0.06]]));
  } else {
    lines.push(flat([[-0.15, my], [0.15, my]]));
  }
  return lines;
}

function pilotFace(mood: Mood, time: number): Line[] {
  const ex = 0.34;
  const ey = -0.13;
  const my = 0.54;
  const lines: Line[] = [...PILOT_NOSE];
  if (mood === 'out') {
    lines.push(...cross(-ex, ey, 0.1), ...cross(ex, ey, 0.1));
  } else if (mood === 'happy') {
    lines.push(...both(flat([[ex - 0.13, ey + 0.05], [ex, ey - 0.09], [ex + 0.13, ey + 0.05]])));
  } else if (mood === 'hurt') {
    lines.push(...both(flat([[ex + 0.11, ey - 0.09], [ex - 0.09, ey], [ex + 0.11, ey + 0.09]])));
  } else if (time % 3.7 < 0.13) {
    lines.push(...both(flat([[ex - 0.11, ey], [ex + 0.11, ey]])));
  } else {
    lines.push(...both(flat([[ex - 0.11, ey], [ex, ey - 0.09], [ex + 0.11, ey], [ex, ey + 0.09]], true)));
  }
  if (mood === 'hurt' || mood === 'worried') lines.push(...both(flat([[ex + 0.17, ey - 0.2], [ex - 0.13, ey - 0.31]])));
  if (mood === 'happy') {
    lines.push(flat([[-0.3, my - 0.08], [0.3, my - 0.08], [0.17, my + 0.13], [-0.17, my + 0.13]], true));
  } else if (mood === 'hurt') {
    lines.push(flat([[-0.27, my + 0.11], [-0.13, my - 0.04], [0.13, my - 0.04], [0.27, my + 0.11]]));
  } else if (mood === 'worried') {
    lines.push(flat([[-0.2, my + 0.05], [-0.08, my - 0.02], [0.08, my - 0.02], [0.2, my + 0.05]]));
  } else if (mood === 'out') {
    lines.push(flat([[-0.2, my], [-0.1, my + 0.07], [0, my], [0.1, my + 0.07], [0.2, my]]));
  } else {
    lines.push(flat([[-0.18, my], [0.18, my]]));
  }
  return lines;
}

function bossFace(mood: Mood, time: number): Line[] {
  const lines: Line[] = [];
  if (mood === 'out') {
    lines.push(...cross(-0.36, -0.22, 0.13), ...cross(0.36, -0.22, 0.13));
  } else if (mood === 'laugh') {
    lines.push(...both(flat([[0.16, -0.16], [0.36, -0.32], [0.56, -0.18]])));
  } else if (mood === 'hurt') {
    lines.push(...both(flat([[0.54, -0.36], [0.2, -0.22], [0.54, -0.08]])));
  } else {
    lines.push(...both(flat([[0.58, -0.4], [0.14, -0.14], [0.5, -0.1]], true)));
  }
  const top = 0.38;
  const teeth: [number, number][] = [[-0.36, top], [-0.24, top + 0.08], [-0.12, top], [0, top + 0.08], [0.12, top], [0.24, top + 0.08], [0.36, top]];
  if (mood === 'laugh' || mood === 'talk') {
    const gape = mood === 'laugh' ? 0.14 + 0.2 * Math.abs(Math.sin(time * 13)) : 0.04 + 0.15 * Math.abs(Math.sin(time * 9));
    lines.push(flat([...teeth, [0.25, top + gape + 0.1], [-0.25, top + gape + 0.1]], true));
  } else if (mood === 'hurt') {
    lines.push(flat([[-0.3, 0.62], [-0.15, 0.46], [0, 0.56], [0.15, 0.46], [0.3, 0.62]]));
  } else if (mood === 'out') {
    lines.push(flat([[-0.28, 0.5], [-0.14, 0.56], [0, 0.5], [0.14, 0.56], [0.28, 0.5]]));
  } else {
    lines.push(flat([[-0.34, top + 0.06], [-0.2, top + 0.13], [-0.07, top + 0.05], [0.07, top + 0.12], [0.2, top + 0.03], [0.36, top - 0.05]]));
  }
  return lines;
}

function projectLines(
  ctx: CanvasRenderingContext2D,
  lines: readonly Line[],
  x: number,
  y: number,
  size: number,
  yaw: number,
  pitch: number,
  toneFilter?: HeadTone,
): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  for (const line of lines) {
    if (toneFilter && (line.tone ?? 'base') !== toneFilter) continue;
    line.pts.forEach(([px, py, pz], i) => {
      const x1 = px * cy + pz * sy;
      const z1 = -px * sy + pz * cy;
      const y1 = py * cp - z1 * sp;
      const z2 = py * sp + z1 * cp;
      // A touch of perspective: nearer points are drawn a little larger.
      const k = size / (1 - z2 * 0.18);
      if (i === 0) ctx.moveTo(x + x1 * k, y + y1 * k);
      else ctx.lineTo(x + x1 * k, y + y1 * k);
    });
    if (line.closed) ctx.closePath();
  }
}

/**
 * Add one layer of a face to the current canvas path: 'head' is the wireframe skull, 'face' the expression.
 * (x, y) is the centre of the head, `size` the px one unit stands for (the head is about 1.8 units tall),
 * `yaw` and `pitch` how far it is turned, in radians.
 */
export function traceAvatar(
  ctx: CanvasRenderingContext2D,
  who: Who,
  layer: 'head' | 'face',
  x: number,
  y: number,
  size: number,
  yaw: number,
  pitch: number,
  mood: Mood,
  time: number,
  toneFilter?: HeadTone,
): void {
  let lines: readonly Line[];
  if (isPilotId(who)) {
    lines = layer === 'head' ? buildPlayableHead(who, mood, time) : buildPlayableFace(who, mood, time);
  } else if (layer === 'head') {
    lines = toned('base', who === 'pilot' ? PILOT_HEAD : who === 'boss' ? BOSS_HEAD : COMMANDER_HEAD);
  } else {
    lines = who === 'pilot' ? pilotFace(mood, time) : who === 'boss' ? bossFace(mood, time) : commanderFace(mood, time);
  }
  projectLines(ctx, lines, x, y, size, yaw, pitch, layer === 'head' ? toneFilter : undefined);
}

export interface AvatarFrameOpts {
  ctx: CanvasRenderingContext2D;
  ink: Ink;
  who: Who;
  x: number;
  y: number;
  box: number;
  yaw: number;
  pitch: number;
  mood: Mood;
  time: number;
  cutRatio?: number;
  cyRatio?: number;
  sizeRatio?: number;
  fade?: number;
  fillStyle?: string;
  headColor?: string;
  headAlpha?: number;
  headWidth?: number;
  faceColor?: string;
  faceWidth?: number;
  frameColor?: string;
  frameAlpha?: number;
  frameWidth?: number;
  frameGlow?: boolean;
  scanlines?: boolean;
  pilotConsole?: boolean;
  consoleColor?: string;
}

/**
 * Draw an octagonal cut-corner avatar/comms box, clipping the wireframe head & face inside it,
 * with optional radio scanlines or cockpit console.
 */
export function renderAvatarFrame(opts: AvatarFrameOpts): void {
  const {
    ctx,
    ink,
    who,
    x,
    y,
    box,
    yaw,
    pitch,
    mood,
    time,
    cutRatio = 0.16,
    cyRatio = 0.5,
    sizeRatio = 0.3,
    fade = 1,
    fillStyle,
    headColor = NEON.cyan,
    headAlpha = 0.5,
    headWidth = 1,
    faceColor = SAND,
    faceWidth = 1.5,
    frameColor = headColor,
    frameAlpha = 0.9,
    frameWidth = 1.5,
    frameGlow = true,
    scanlines = false,
    pilotConsole = false,
    consoleColor = SAND,
  } = opts;

  const cut = box * cutRatio;
  const frame = (): void => {
    ctx.moveTo(x + cut, y);
    ctx.lineTo(x + box - cut, y);
    ctx.lineTo(x + box, y + cut);
    ctx.lineTo(x + box, y + box - cut);
    ctx.lineTo(x + box - cut, y + box);
    ctx.lineTo(x + cut, y + box);
    ctx.lineTo(x, y + box - cut);
    ctx.lineTo(x, y + cut);
    ctx.closePath();
  };

  const cx = x + box / 2;
  const cy = y + box * cyRatio;
  const size = box * sizeRatio;

  ctx.save();
  ctx.beginPath();
  frame();
  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }
  ctx.clip();

  if (isPilotId(who)) {
    const spec = PILOT_BY_ID[who];
    const headLines = buildPlayableHead(who, mood, time);
    ink(spec.colors.base, Math.max(headAlpha, 0.62) * fade, headWidth, () =>
      projectLines(ctx, headLines, cx, cy, size, yaw, pitch, 'base'),
    false);
    ink(spec.colors.accent, 0.92 * fade, headWidth * 1.15, () =>
      projectLines(ctx, headLines, cx, cy, size, yaw, pitch, 'accent'),
    false);
    ink(spec.colors.trim, 0.78 * fade, headWidth, () =>
      projectLines(ctx, headLines, cx, cy, size, yaw, pitch, 'trim'),
    false);
    const exprColor =
      mood === 'hurt'
        ? PINK
        : mood === 'happy' || mood === 'laugh'
          ? NEON.lime
          : spec.colors.face;
    const faceLines = buildPlayableFace(who, mood, time);
    ink(exprColor, fade, faceWidth, () => projectLines(ctx, faceLines, cx, cy, size, yaw, pitch));
  } else {
    ink(headColor, headAlpha * fade, headWidth, () => traceAvatar(ctx, who, 'head', cx, cy, size, yaw, pitch, mood, time), false);
    ink(faceColor, fade, faceWidth, () => traceAvatar(ctx, who, 'face', cx, cy, size, yaw, pitch, mood, time));
  }

  if (scanlines) {
    ink(NEON.cyan, 0.12 * fade, 1, () => {
      for (let sy = y + ((time * 14) % 6); sy < y + box; sy += 6) {
        ctx.moveTo(x, sy);
        ctx.lineTo(x + box, sy);
      }
    }, false);
  }
  if (pilotConsole) {
    ink(consoleColor, 0.6 * fade, 1, () => {
      ctx.moveTo(x, y + box * 0.86);
      ctx.lineTo(x + box, y + box * 0.86);
      for (let i = 1; i < 4; i++) {
        ctx.moveTo(x + (box * i) / 4, y + box * 0.86);
        ctx.lineTo(x + (box * i) / 4, y + box * 0.93);
      }
    }, false);
  }
  ctx.restore();
  ink(frameColor, frameAlpha * fade, frameWidth, frame, frameGlow);
}
