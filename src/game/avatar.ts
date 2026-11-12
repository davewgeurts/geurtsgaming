/**
 * The faces of the arcade demo: the pilot (top left), the boss (top right), and the flight commander
 * who briefs the pilot from the cockpit's comms screen before take-off.
 *
 * Each is a small wireframe head: a handful of points in 3D, joined by straight lines, turned a little
 * and flattened onto the screen. Turning the head is what makes plain line polygons read as solid.
 * The expression (eyes, brows, mouth) is redrawn from the mood, so a face can smile, frown or laugh.
 *
 * game.ts decides the mood and which way each head is turned; this file only knows how to draw them.
 */
export type Mood = 'calm' | 'worried' | 'happy' | 'hurt' | 'laugh' | 'talk' | 'out';
export type Who = 'pilot' | 'boss' | 'commander';

type P3 = readonly [number, number, number];
interface Line { pts: readonly P3[]; closed?: boolean }

/** Depth of the plane the face is drawn on, and of the back of the head. */
const FRONT = 0.45;
const BACK = -0.55;

const ring = (pts: readonly (readonly [number, number])[], z: number, scale = 1): P3[] => pts.map(([x, y]) => [x * scale, y * scale, z]);
/** A flat stroke on the face plane. */
const flat = (pts: readonly (readonly [number, number])[], closed = false): Line => ({ pts: ring(pts, FRONT + 0.02), closed });
const mirror = (line: Line): Line => ({ pts: line.pts.map(([x, y, z]) => [-x, y, z] as const), closed: line.closed });
const both = (line: Line): Line[] => [line, mirror(line)];

/** A head as a prism: the outline of the face, a smaller copy behind it, and an edge joining each pair of corners. */
function prism(outline: readonly (readonly [number, number])[], shrink: number): Line[] {
  const front = ring(outline, FRONT);
  const back = ring(outline, BACK, shrink);
  return [{ pts: front, closed: true }, { pts: back, closed: true }, ...front.map((p, i) => ({ pts: [p, back[i]!] }))];
}

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
/** A nose that sticks out is the strongest cue that the head is turning. */
const PILOT_NOSE: Line[] = [
  { pts: [[0, -0.1, FRONT], [0, 0.2, 0.84], [-0.12, 0.27, FRONT]] },
  { pts: [[0, 0.2, 0.84], [0.12, 0.27, FRONT]] },
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
    // Eyes wide open.
    lines.push(...both(flat([[ex - 0.13, ey - 0.1], [ex + 0.13, ey - 0.1], [ex + 0.11, ey + 0.09], [ex - 0.11, ey + 0.09]], true)));
  } else if (time % 4.3 < 0.12) {
    lines.push(...both(flat([[ex - 0.12, ey], [ex + 0.12, ey]])));
  } else {
    lines.push(...both(flat([[ex - 0.12, ey - 0.05], [ex + 0.12, ey - 0.05], [ex + 0.1, ey + 0.06], [ex - 0.1, ey + 0.06]], true)));
  }
  // Brows: level, or with the inner ends up when something is wrong.
  lines.push(...both(worried ? flat([[ex - 0.17, ey - 0.37], [ex + 0.19, ey - 0.22]]) : flat([[ex - 0.17, ey - 0.2], [ex + 0.17, ey - 0.2]])));
  lines.push(flat([[-0.3, 0.44], [-0.12, 0.34], [0, 0.4], [0.12, 0.34], [0.3, 0.44]]));
  if (worried) {
    // Shouting: the mouth opens wide, and wider at the bottom.
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

const cross = (x: number, y: number, r: number): Line[] => [
  flat([[x - r, y - r], [x + r, y + r]]),
  flat([[x + r, y - r], [x - r, y + r]]),
];

function pilotFace(mood: Mood, time: number): Line[] {
  const ex = 0.34;
  const ey = -0.13;
  const my = 0.54;
  const lines: Line[] = [...PILOT_NOSE];
  // Eyes.
  if (mood === 'out') {
    lines.push(...cross(-ex, ey, 0.1), ...cross(ex, ey, 0.1));
  } else if (mood === 'happy') {
    lines.push(...both(flat([[ex - 0.13, ey + 0.05], [ex, ey - 0.09], [ex + 0.13, ey + 0.05]])));
  } else if (mood === 'hurt') {
    lines.push(...both(flat([[ex + 0.11, ey - 0.09], [ex - 0.09, ey], [ex + 0.11, ey + 0.09]])));
  } else if (time % 3.7 < 0.13) {
    lines.push(...both(flat([[ex - 0.11, ey], [ex + 0.11, ey]]))); // a blink
  } else {
    lines.push(...both(flat([[ex - 0.11, ey], [ex, ey - 0.09], [ex + 0.11, ey], [ex, ey + 0.09]], true)));
  }
  // Brows: only when something is wrong, with the inner ends raised.
  if (mood === 'hurt' || mood === 'worried') lines.push(...both(flat([[ex + 0.17, ey - 0.2], [ex - 0.13, ey - 0.31]])));
  // Mouth.
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
  // Eyes: slanted and scowling by default.
  if (mood === 'out') {
    lines.push(...cross(-0.36, -0.22, 0.13), ...cross(0.36, -0.22, 0.13));
  } else if (mood === 'laugh') {
    lines.push(...both(flat([[0.16, -0.16], [0.36, -0.32], [0.56, -0.18]])));
  } else if (mood === 'hurt') {
    lines.push(...both(flat([[0.54, -0.36], [0.2, -0.22], [0.54, -0.08]])));
  } else {
    lines.push(...both(flat([[0.58, -0.4], [0.14, -0.14], [0.5, -0.1]], true)));
  }
  // Mouth: a row of teeth. It gapes when laughing or talking.
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
    // A lopsided smirk.
    lines.push(flat([[-0.34, top + 0.06], [-0.2, top + 0.13], [-0.07, top + 0.05], [0.07, top + 0.12], [0.2, top + 0.03], [0.36, top - 0.05]]));
  }
  return lines;
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
): void {
  const lines =
    layer === 'head'
      ? who === 'pilot' ? PILOT_HEAD : who === 'boss' ? BOSS_HEAD : COMMANDER_HEAD
      : who === 'pilot' ? pilotFace(mood, time) : who === 'boss' ? bossFace(mood, time) : commanderFace(mood, time);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  for (const line of lines) {
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
