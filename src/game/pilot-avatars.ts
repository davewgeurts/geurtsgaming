/**
 * Playable low-poly 3D pilot heads and reactive emotion expressions (`nova`, `leo`, `maya`, `kai`,
 * `fox`, `cat`, `wolf`, `owl`), kept in their own module so `avatar.ts` stays focused on projection
 * and the core HUD/comms frame renderer.
 */
import type { PilotId } from './loadout';

export type Mood = 'calm' | 'worried' | 'happy' | 'hurt' | 'laugh' | 'talk' | 'out' | 'wink' | 'fierce';
export type HeadTone = 'base' | 'accent' | 'trim';
export type P3 = readonly [number, number, number];

export interface AvatarLine {
  pts: readonly P3[];
  closed?: boolean;
  tone?: HeadTone;
}

export const AVATAR_FRONT = 0.45;
export const AVATAR_BACK = -0.55;

export const ring3d = (pts: readonly (readonly [number, number])[], z: number, scale = 1): P3[] =>
  pts.map(([x, y]) => [x * scale, y * scale, z]);

export const flatLine = (pts: readonly (readonly [number, number])[], closed = false, tone?: HeadTone): AvatarLine => ({
  pts: ring3d(pts, AVATAR_FRONT + 0.02),
  closed,
  ...(tone ? { tone } : {}),
});

export const mirrorLine = (line: AvatarLine): AvatarLine => ({
  pts: line.pts.map(([x, y, z]) => [-x, y, z] as const),
  closed: line.closed,
  ...(line.tone ? { tone: line.tone } : {}),
});

export const bothSides = (line: AvatarLine): AvatarLine[] => [line, mirrorLine(line)];

export function prism3d(
  outline: readonly (readonly [number, number])[],
  shrink: number,
  tone: HeadTone = 'base',
): AvatarLine[] {
  const front = ring3d(outline, AVATAR_FRONT);
  const back = ring3d(outline, AVATAR_BACK, shrink);
  return [
    { pts: front, closed: true, tone },
    { pts: back, closed: true, tone },
    ...front.map((p, i) => ({ pts: [p, back[i]!], tone })),
  ];
}

export const PILOT_NOSE_LINES: AvatarLine[] = [
  { pts: [[0, -0.1, AVATAR_FRONT], [0, 0.2, 0.84], [-0.12, 0.27, AVATAR_FRONT]] },
  { pts: [[0, 0.2, 0.84], [0.12, 0.27, AVATAR_FRONT]] },
];

const NECK_AND_SUIT: AvatarLine[] = [
  { pts: [[-0.2, 0.88, 0.18], [-0.22, 1.18, 0]], tone: 'base' },
  { pts: [[0.2, 0.88, 0.18], [0.22, 1.18, 0]], tone: 'base' },
  { pts: [[-1.18, 1.58, 0], [-0.58, 1.18, 0], [0, 1.34, 0.14], [0.58, 1.18, 0], [1.18, 1.58, 0]], tone: 'trim' },
];

export const crossEye = (x: number, y: number, r: number): AvatarLine[] => [
  flatLine([[x - r, y - r], [x + r, y + r]]),
  flatLine([[x + r, y - r], [x - r, y + r]]),
];

function earLift(mood: Mood, time: number): { perk: number; splay: number } {
  const twitch = time % 5.1 < 0.18 ? Math.sin(time * 38) * 0.05 : 0;
  if (mood === 'happy' || mood === 'laugh') return { perk: 0.12 + twitch, splay: -0.05 };
  if (mood === 'wink') return { perk: 0.14 + twitch, splay: -0.03 };
  if (mood === 'fierce') return { perk: -0.08, splay: -0.1 };
  if (mood === 'worried' || mood === 'hurt') return { perk: -0.2, splay: 0.18 };
  if (mood === 'out') return { perk: -0.26, splay: 0.22 };
  if (mood === 'talk') return { perk: 0.04 + Math.sin(time * 9) * 0.04, splay: 0 };
  return { perk: twitch, splay: 0 };
}

export function buildPlayableHead(id: PilotId, mood: Mood, time: number): AvatarLine[] {
  const FRONT = AVATAR_FRONT;
  if (id === 'nova') {
    const face = [[-0.44, -0.88], [0.44, -0.88], [0.76, -0.4], [0.68, 0.3], [0.3, 0.86], [-0.3, 0.86], [-0.68, 0.3], [-0.76, -0.4]] as const;
    return [
      ...prism3d(face, 0.82, 'base'),
      ...bothSides({ pts: [[0.76, -0.4, FRONT], [0.92, 0.08, 0.18], [0.74, 0.62, 0.36], [0.68, 0.3, FRONT]], closed: true, tone: 'base' }),
      { pts: [[-0.76, -0.42, FRONT + 0.05], [-0.28, -0.88, FRONT + 0.06], [0.22, -0.46, FRONT + 0.12], [0.76, -0.42, FRONT + 0.05]], tone: 'accent' },
      { pts: [[-0.74, -0.44, FRONT + 0.06], [-0.18, -0.5, FRONT + 0.12], [0.22, -0.46, FRONT + 0.12]], tone: 'accent' },
      { pts: [[-0.62, -0.58, FRONT + 0.12], [-0.48, -0.68, FRONT + 0.14], [-0.38, -0.54, FRONT + 0.12], [-0.52, -0.44, FRONT + 0.1]], closed: true, tone: 'accent' },
      { pts: [[0.76, 0.05, 0.15], [0.62, 0.56, 0.62], [0.36, 0.62, 0.7]], tone: 'trim' },
      ...NECK_AND_SUIT,
    ];
  }

  if (id === 'leo') {
    const face = [[-0.46, -0.84], [0.46, -0.84], [0.78, -0.38], [0.7, 0.34], [0.36, 0.88], [-0.36, 0.88], [-0.7, 0.34], [-0.78, -0.38]] as const;
    return [
      ...prism3d(face, 0.82, 'base'),
      { pts: [[-0.58, -0.78, 0.2], [-0.36, -1.28, 0.32], [-0.08, -0.84, FRONT]], tone: 'trim' },
      { pts: [[-0.14, -0.84, 0.25], [0.08, -1.36, 0.38], [0.32, -0.84, FRONT]], tone: 'trim' },
      { pts: [[0.24, -0.84, 0.2], [0.56, -1.22, 0.28], [0.7, -0.66, FRONT]], tone: 'trim' },
      ...bothSides({
        pts: [[0.08, -0.64, FRONT + 0.12], [0.48, -0.68, FRONT + 0.1], [0.54, -0.44, FRONT + 0.1], [0.1, -0.42, FRONT + 0.12]],
        closed: true,
        tone: 'accent',
      }),
      { pts: [[-0.08, -0.54, FRONT + 0.12], [0.08, -0.54, FRONT + 0.12]], tone: 'accent' },
      ...bothSides({ pts: [[0.54, -0.54, FRONT + 0.08], [0.78, -0.38, FRONT]], tone: 'accent' }),
      ...NECK_AND_SUIT,
    ];
  }

  if (id === 'maya') {
    const face = [[-0.42, -0.84], [0.42, -0.84], [0.74, -0.36], [0.66, 0.32], [0.3, 0.86], [-0.3, 0.86], [-0.66, 0.32], [-0.74, -0.36]] as const;
    const bounce = mood === 'happy' || mood === 'laugh' ? -0.07 : mood === 'hurt' || mood === 'worried' ? 0.06 : 0;
    const py = -0.8 + bounce;
    return [
      ...prism3d(face, 0.82, 'base'),
      ...bothSides({ pts: [[0, -0.84, FRONT + 0.06], [0.38, -0.52, FRONT + 0.1], [0.74, -0.36, FRONT + 0.04]], tone: 'trim' }),
      ...bothSides({
        pts: [[0.58, py + 0.06, 0.18], [0.84, py - 0.38, 0.12], [1.14, py - 0.06, 0.08], [0.96, py + 0.3, 0.14]],
        closed: true,
        tone: 'accent',
      }),
      ...bothSides({ pts: [[0.84, py - 0.38, 0.12], [0.88, py - 0.02, 0.38], [0.96, py + 0.3, 0.14]], tone: 'accent' }),
      ...bothSides({ pts: [[0.58, py + 0.06, 0.18], [0.88, py - 0.02, 0.38], [1.14, py - 0.06, 0.08]], tone: 'accent' }),
      ...bothSides({ pts: [[0.54, py + 0.12, 0.25], [0.7, py + 0.24, 0.3]], tone: 'trim' }),
      ...bothSides({ pts: [[0.76, -0.02, 0.18], [0.9, 0.08, 0.1], [0.76, 0.2, 0.18]], closed: true, tone: 'accent' }),
      ...NECK_AND_SUIT,
    ];
  }

  if (id === 'kai') {
    const face = [[-0.48, -0.78], [0.48, -0.78], [0.78, -0.32], [0.72, 0.34], [0.38, 0.88], [-0.38, 0.88], [-0.72, 0.34], [-0.78, -0.32]] as const;
    const capCrown = [[-0.64, -0.68], [0.64, -0.68], [0.56, -1.08], [-0.56, -1.08]] as const;
    return [
      ...prism3d(face, 0.84, 'base'),
      ...prism3d(capCrown, 0.86, 'accent'),
      { pts: [[-0.66, -0.66, FRONT], [-0.46, -0.5, 0.96], [0.46, -0.5, 0.96], [0.66, -0.66, FRONT]], tone: 'accent' },
      { pts: [[-0.22, -0.88, FRONT + 0.04], [0, -0.98, FRONT + 0.06], [0.22, -0.88, FRONT + 0.04], [0, -0.78, FRONT + 0.04]], closed: true, tone: 'trim' },
      { pts: [[-0.78, 0.08, 0.16], [-0.62, 0.56, 0.64], [-0.34, 0.62, 0.72]], tone: 'trim' },
      ...NECK_AND_SUIT,
    ];
  }

  if (id === 'fox') {
    const { perk, splay } = earLift(mood, time);
    const foxFace = [
      [-0.46, -0.74], [0.46, -0.74], [0.78, -0.3], [0.98, 0.14],
      [0.54, 0.58], [0.18, 0.86], [-0.18, 0.86], [-0.54, 0.58], [-0.98, 0.14], [-0.78, -0.3],
    ] as const;
    const tipX = 0.78 + splay;
    const tipY = -1.44 - perk;
    return [
      ...prism3d(foxFace, 0.76, 'base'),
      ...bothSides({ pts: [[0.22, -0.74, 0.22], [tipX, tipY, 0.08], [0.74, -0.34, 0.2]], closed: true, tone: 'base' }),
      ...bothSides({ pts: [[tipX, tipY, 0.08], [0.48, -0.58, -0.32]], tone: 'base' }),
      ...bothSides({ pts: [[0.32, -0.68, 0.25], [tipX * 0.88, tipY * 0.84, 0.12], [0.64, -0.4, 0.23]], closed: true, tone: 'accent' }),
      ...bothSides({ pts: [[0.98, 0.14, FRONT], [0.58, 0.24, FRONT + 0.08], [0.54, 0.58, FRONT]], tone: 'accent' }),
      { pts: [[-0.28, 0.04, FRONT], [0, 0.2, 1.08], [0.28, 0.04, FRONT]], tone: 'accent' },
      { pts: [[-0.24, 0.36, FRONT + 0.06], [0, 0.2, 1.08], [0.24, 0.36, FRONT + 0.06]], tone: 'accent' },
      ...NECK_AND_SUIT,
    ];
  }

  if (id === 'cat') {
    const { perk, splay } = earLift(mood, time);
    const catFace = [
      [-0.48, -0.72], [0.48, -0.72], [0.8, -0.26], [0.84, 0.22],
      [0.48, 0.72], [0, 0.84], [-0.48, 0.72], [-0.84, 0.22], [-0.8, -0.26],
    ] as const;
    const tipX = 0.82 + splay;
    const tipY = -1.3 - perk;
    const wDrop = mood === 'worried' || mood === 'hurt' ? 0.1 : mood === 'happy' ? -0.06 : 0;
    return [
      ...prism3d(catFace, 0.8, 'base'),
      ...bothSides({ pts: [[0.2, -0.72, 0.22], [tipX, tipY, 0.1], [0.78, -0.28, 0.2]], closed: true, tone: 'base' }),
      ...bothSides({ pts: [[tipX, tipY, 0.1], [0.5, -0.52, -0.3]], tone: 'base' }),
      ...bothSides({ pts: [[0.32, -0.66, 0.25], [tipX * 0.86, tipY * 0.84, 0.14], [0.68, -0.34, 0.23]], closed: true, tone: 'accent' }),
      ...bothSides({ pts: [[0.52, 0.14, 0.56], [1.08, 0.04 + wDrop, 0.32]], tone: 'trim' }),
      ...bothSides({ pts: [[0.54, 0.26, 0.56], [1.12, 0.26 + wDrop, 0.32]], tone: 'trim' }),
      ...bothSides({ pts: [[0.5, 0.38, 0.54], [1.04, 0.48 + wDrop, 0.32]], tone: 'trim' }),
      { pts: [[0, 1.08, 0.3], [0.12, 1.22, 0.32], [0, 1.36, 0.3], [-0.12, 1.22, 0.32]], closed: true, tone: 'accent' },
      ...NECK_AND_SUIT,
    ];
  }

  if (id === 'wolf') {
    const { perk, splay } = earLift(mood, time);
    const pupFace = [
      [-0.5, -0.76], [0.5, -0.76], [0.8, -0.32], [0.78, 0.28],
      [0.46, 0.78], [0, 0.9], [-0.46, 0.78], [-0.78, 0.28], [-0.8, -0.32],
    ] as const;
    const tipY = -1.34 - perk * 1.1;
    const tipX = 0.68 + splay;
    return [
      ...prism3d(pupFace, 0.8, 'base'),
      ...bothSides({ pts: [[0.28, -0.76, 0.2], [tipX, tipY, 0.16], [0.94, tipY + 0.34, 0.24], [0.78, -0.32, 0.2]], closed: true, tone: 'base' }),
      ...bothSides({ pts: [[tipX, tipY, 0.16], [0.58, -0.54, -0.28]], tone: 'base' }),
      ...bothSides({ pts: [[0.08, -0.34, FRONT + 0.1], [0.56, -0.4, FRONT + 0.08]], tone: 'accent' }),
      {
        pts: [[-0.28, 0.06, FRONT + 0.04], [0.28, 0.06, FRONT + 0.04], [0.24, 0.22, 1.04], [-0.24, 0.22, 1.04]],
        closed: true,
        tone: 'trim',
      },
      {
        pts: [[-0.24, 0.22, 1.04], [0.24, 0.22, 1.04], [0.3, 0.48, FRONT + 0.06], [-0.3, 0.48, FRONT + 0.06]],
        closed: true,
        tone: 'trim',
      },
      ...NECK_AND_SUIT,
    ];
  }

  // 'owl' — Pip (Sky Owl)
  const { perk } = earLift(mood, time);
  const owlFace = [
    [-0.48, -0.8], [0.48, -0.8], [0.84, -0.34], [0.84, 0.24],
    [0.5, 0.78], [0, 0.9], [-0.5, 0.78], [-0.84, 0.24], [-0.84, -0.34],
  ] as const;
  const crestY = -1.32 - perk;
  return [
    ...prism3d(owlFace, 0.82, 'base'),
    ...bothSides({ pts: [[0.32, -0.78, 0.22], [0.88, crestY, 0.18], [0.72, -0.48, 0.24]], closed: true, tone: 'accent' }),
    ...bothSides({ pts: [[0.5, -0.72, 0.24], [1.02, crestY + 0.18, 0.16]], tone: 'accent' }),
    ...bothSides({
      pts: [
        [0.1, -0.36, FRONT + 0.06], [0.34, -0.44, FRONT + 0.06], [0.6, -0.34, FRONT + 0.06], [0.66, -0.1, FRONT + 0.06],
        [0.56, 0.12, FRONT + 0.06], [0.32, 0.16, FRONT + 0.06], [0.1, 0.06, FRONT + 0.06], [0.06, -0.16, FRONT + 0.06],
      ],
      closed: true,
      tone: 'trim',
    }),
    { pts: [[-0.36, 1.06, 0.22], [0, 1.28, 0.28], [0.36, 1.06, 0.22]], tone: 'base' },
    ...NECK_AND_SUIT,
  ];
}

function pilotEyes(ex: number, ey: number, mood: Mood, time: number, lashes = false, catSlit = false): AvatarLine[] {
  const lines: AvatarLine[] = [];
  if (mood === 'out') {
    lines.push(...crossEye(-ex, ey, 0.11), ...crossEye(ex, ey, 0.11));
    return lines;
  }
  if (mood === 'wink') {
    // Left eye wide & bright; right eye winks shut in a cheeky chevron!
    const tall = 0.095;
    lines.push(flatLine([[-ex - 0.12, ey], [-ex, ey - tall], [-ex + 0.12, ey], [-ex, ey + tall]], true));
    if (catSlit) lines.push(flatLine([[-ex, ey - tall * 0.68], [-ex, ey + tall * 0.68]]));
    if (lashes) lines.push(flatLine([[-ex - 0.09, ey - tall * 0.5], [-ex - 0.18, ey - tall * 1.15]]));
    lines.push(flatLine([[ex + 0.14, ey - 0.07], [ex - 0.1, ey + 0.01], [ex + 0.14, ey + 0.08]]));
    return lines;
  }
  if (mood === 'fierce') {
    // Determined narrowed eyes with angled upper lid
    lines.push(
      ...bothSides(
        flatLine(
          [
            [ex - 0.13, ey - 0.01],
            [ex + 0.13, ey - 0.08],
            [ex + 0.11, ey + 0.07],
            [ex - 0.09, ey + 0.07],
          ],
          true,
        ),
      ),
    );
    if (catSlit) lines.push(...bothSides(flatLine([[ex, ey - 0.03], [ex, ey + 0.06]])));
    return lines;
  }
  if (mood === 'happy' || mood === 'laugh') {
    lines.push(...bothSides(flatLine([[ex - 0.14, ey + 0.05], [ex, ey - 0.1], [ex + 0.14, ey + 0.05]])));
    return lines;
  }
  if (mood === 'hurt') {
    lines.push(...bothSides(flatLine([[ex + 0.12, ey - 0.09], [ex - 0.09, ey], [ex + 0.12, ey + 0.09]])));
    return lines;
  }
  if (time % 3.7 < 0.13 && mood !== 'worried') {
    lines.push(...bothSides(flatLine([[ex - 0.12, ey], [ex + 0.12, ey]])));
    return lines;
  }
  const tall = mood === 'worried' ? 0.12 : 0.095;
  lines.push(...bothSides(flatLine([[ex - 0.12, ey], [ex, ey - tall], [ex + 0.12, ey], [ex, ey + tall]], true)));
  if (catSlit) {
    lines.push(...bothSides(flatLine([[ex, ey - tall * 0.68], [ex, ey + tall * 0.68]])));
  }
  if (lashes) {
    lines.push(...bothSides(flatLine([[ex + 0.09, ey - tall * 0.5], [ex + 0.18, ey - tall * 1.15]])));
  }
  return lines;
}

function humanMouth(my: number, mood: Mood, time: number): AvatarLine[] {
  if (mood === 'wink') {
    // Asymmetrical sly smirk kicked up on the winking side
    return [flatLine([[-0.18, my + 0.03], [0.02, my + 0.04], [0.22, my - 0.06], [0.28, my - 0.13]])];
  }
  if (mood === 'fierce') {
    // Determined gritted game-face grin
    return [
      flatLine([[-0.24, my - 0.04], [0.24, my - 0.04], [0.2, my + 0.08], [-0.2, my + 0.08]], true),
      flatLine([[-0.21, my + 0.02], [0.21, my + 0.02]]),
    ];
  }
  if (mood === 'happy' || mood === 'laugh') {
    const deep = mood === 'laugh' ? 0.16 + 0.08 * Math.abs(Math.sin(time * 12)) : 0.13;
    return [flatLine([[-0.3, my - 0.08], [0.3, my - 0.08], [0.18, my + deep], [-0.18, my + deep]], true)];
  }
  if (mood === 'talk') {
    const gape = 0.05 + 0.13 * Math.abs(Math.sin(time * 11));
    return [flatLine([[-0.18, my - 0.04], [0.18, my - 0.04], [0.13, my + gape], [-0.13, my + gape]], true)];
  }
  if (mood === 'hurt') {
    return [flatLine([[-0.27, my + 0.11], [-0.13, my - 0.04], [0.13, my - 0.04], [0.27, my + 0.11]])];
  }
  if (mood === 'worried') {
    return [flatLine([[-0.2, my + 0.06], [-0.08, my - 0.02], [0.08, my - 0.02], [0.2, my + 0.06]])];
  }
  if (mood === 'out') {
    return [flatLine([[-0.2, my], [-0.1, my + 0.07], [0, my], [0.1, my + 0.07], [0.2, my]])];
  }
  return [flatLine([[-0.19, my - 0.02], [-0.08, my + 0.03], [0.08, my + 0.03], [0.19, my - 0.02]])];
}

export function buildPlayableFace(id: PilotId, mood: Mood, time: number): AvatarLine[] {
  const FRONT = AVATAR_FRONT;
  const worriedBrows = (ex: number, ey: number): AvatarLine[] =>
    mood === 'fierce'
      ? bothSides(flatLine([[ex + 0.19, ey - 0.28], [ex - 0.15, ey - 0.11]]))
      : mood === 'wink'
        ? [
            flatLine([[-ex - 0.14, ey - 0.2], [-ex + 0.13, ey - 0.23]]),
            flatLine([[ex - 0.13, ey - 0.27], [ex + 0.02, ey - 0.32], [ex + 0.16, ey - 0.24]]),
          ]
        : mood === 'hurt' || mood === 'worried'
          ? bothSides(flatLine([[ex + 0.17, ey - 0.2], [ex - 0.12, ey - 0.31]]))
          : mood === 'happy' || mood === 'laugh'
            ? bothSides(flatLine([[ex - 0.13, ey - 0.22], [ex, ey - 0.26], [ex + 0.14, ey - 0.2]]))
            : [];

  if (id === 'nova' || id === 'maya') {
    const ex = 0.33;
    const ey = -0.1;
    return [
      ...PILOT_NOSE_LINES,
      ...pilotEyes(ex, ey, mood, time, true, false),
      ...worriedBrows(ex, ey),
      ...humanMouth(0.54, mood, time),
    ];
  }

  if (id === 'leo' || id === 'kai') {
    const ex = 0.34;
    const ey = -0.11;
    return [
      ...PILOT_NOSE_LINES,
      ...pilotEyes(ex, ey, mood, time, false, false),
      ...worriedBrows(ex, ey),
      ...humanMouth(0.55, mood, time),
    ];
  }

  if (id === 'fox' || id === 'cat' || id === 'wolf') {
    const ex = 0.35;
    const ey = -0.15;
    const noseZ = id === 'cat' ? 0.88 : 1.08;
    const lines: AvatarLine[] = [
      ...pilotEyes(ex, ey, mood, time, false, id === 'cat'),
      ...worriedBrows(ex, ey),
      { pts: [[-0.11, 0.14, noseZ - 0.04], [0.11, 0.14, noseZ - 0.04], [0, 0.25, noseZ]], closed: true },
      { pts: [[0, 0.25, noseZ], [0, 0.42, FRONT + 0.1]] },
    ];
    const my = 0.48;
    if (mood === 'talk' || mood === 'laugh') {
      const gape = mood === 'laugh' ? 0.16 + 0.09 * Math.abs(Math.sin(time * 12)) : 0.07 + 0.11 * Math.abs(Math.sin(time * 11));
      lines.push({
        pts: [[-0.24, my - 0.04, FRONT + 0.08], [0, my - 0.08, FRONT + 0.12], [0.24, my - 0.04, FRONT + 0.08], [0, my + gape, FRONT + 0.06]],
        closed: true,
      });
    } else if (mood === 'wink') {
      lines.push({
        pts: [
          [-0.22, my + 0.02, FRONT + 0.06],
          [-0.08, my + 0.06, FRONT + 0.08],
          [0, my - 0.01, FRONT + 0.1],
          [0.14, my + 0.04, FRONT + 0.08],
          [0.3, my - 0.1, FRONT + 0.06],
        ],
      });
    } else if (mood === 'fierce') {
      lines.push(
        {
          pts: [
            [-0.26, my + 0.06, FRONT + 0.06],
            [-0.14, my - 0.02, FRONT + 0.08],
            [0, my + 0.05, FRONT + 0.1],
            [0.14, my - 0.02, FRONT + 0.08],
            [0.26, my + 0.06, FRONT + 0.06],
          ],
        },
        { pts: [[-0.17, my, FRONT + 0.08], [-0.14, my + 0.1, FRONT + 0.08]] },
        { pts: [[0.17, my, FRONT + 0.08], [0.14, my + 0.1, FRONT + 0.08]] },
      );
    } else if (mood === 'happy') {
      lines.push({
        pts: [[-0.28, my - 0.04, FRONT + 0.06], [-0.13, my + 0.08, FRONT + 0.08], [0, my - 0.02, FRONT + 0.1], [0.13, my + 0.08, FRONT + 0.08], [0.28, my - 0.04, FRONT + 0.06]],
      });
    } else if (mood === 'hurt' || mood === 'worried') {
      lines.push({ pts: [[-0.24, my + 0.1, FRONT + 0.06], [0, my - 0.02, FRONT + 0.1], [0.24, my + 0.1, FRONT + 0.06]] });
    } else if (mood === 'out') {
      lines.push(flatLine([[-0.22, my + 0.04], [-0.1, my + 0.1], [0, my + 0.04], [0.1, my + 0.1], [0.22, my + 0.04]]));
    } else {
      lines.push({
        pts: [[-0.22, my, FRONT + 0.06], [-0.1, my + 0.06, FRONT + 0.08], [0, my - 0.01, FRONT + 0.1], [0.1, my + 0.06, FRONT + 0.08], [0.22, my, FRONT + 0.06]],
      });
    }
    return lines;
  }

  // 'owl' — Pip: expressive big eyes + articulated 3D upper & lower diamond beak.
  const ex = 0.35;
  const ey = -0.14;
  const openBeak =
    mood === 'talk'
      ? 0.06 + 0.12 * Math.abs(Math.sin(time * 12))
      : mood === 'laugh'
        ? 0.14 + 0.08 * Math.abs(Math.sin(time * 13))
        : mood === 'fierce'
          ? 0.11
          : mood === 'wink'
            ? 0.04
            : mood === 'worried' || mood === 'hurt'
              ? 0.09
              : 0;
  return [
    ...pilotEyes(ex, ey, mood, time, false, false),
    ...worriedBrows(ex, ey),
    { pts: [[-0.16, 0.12, FRONT + 0.06], [0, 0.02, FRONT + 0.12], [0.16, 0.12, FRONT + 0.06], [0, 0.28 - openBeak * 0.25, 1.04]], closed: true },
    { pts: [[-0.13, 0.16 + openBeak * 0.2, FRONT + 0.06], [0, 0.34 + openBeak, 0.92], [0.13, 0.16 + openBeak * 0.2, FRONT + 0.06]] },
  ];
}
