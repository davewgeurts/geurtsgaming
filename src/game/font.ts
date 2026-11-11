/**
 * A stroke font for the arcade game: every glyph is a handful of straight lines on a 4 x 6 grid
 * (x 0..4 left to right, y 0..6 top to baseline), the way vector arcade machines drew text.
 * Strokes are separated by "|", points by spaces. Upper case only; unknown characters render as a space.
 */
const RAW: Record<string, string> = {
  A: '0,6 0,2 2,0 4,2 4,6|0,4 4,4',
  B: '0,6 0,0 3,0 4,1 4,2 3,3 0,3|3,3 4,4 4,5 3,6 0,6',
  C: '4,0 0,0 0,6 4,6',
  D: '0,0 2,0 4,2 4,4 2,6 0,6 0,0',
  E: '4,0 0,0 0,6 4,6|0,3 3,3',
  F: '4,0 0,0 0,6|0,3 3,3',
  G: '4,1 4,0 0,0 0,6 4,6 4,3 2,3',
  H: '0,0 0,6|4,0 4,6|0,3 4,3',
  I: '0,0 4,0|2,0 2,6|0,6 4,6',
  J: '4,0 4,6 2,6 0,4',
  K: '0,0 0,6|4,0 0,3 4,6',
  L: '0,0 0,6 4,6',
  M: '0,6 0,0 2,2 4,0 4,6',
  N: '0,6 0,0 4,6 4,0',
  O: '0,0 4,0 4,6 0,6 0,0',
  P: '0,6 0,0 4,0 4,3 0,3',
  Q: '0,0 4,0 4,4 2,6 0,6 0,0|2,4 4,6',
  R: '0,6 0,0 4,0 4,3 0,3|1,3 4,6',
  S: '4,0 0,0 0,3 4,3 4,6 0,6',
  T: '0,0 4,0|2,0 2,6',
  U: '0,0 0,6 4,6 4,0',
  V: '0,0 2,6 4,0',
  W: '0,0 0,6 2,4 4,6 4,0',
  X: '0,0 4,6|4,0 0,6',
  Y: '0,0 2,2 4,0|2,2 2,6',
  Z: '0,0 4,0 0,6 4,6',
  '0': '0,0 4,0 4,6 0,6 0,0|4,0 0,6',
  '1': '1,1 2,0 2,6|1,6 3,6',
  '2': '0,0 4,0 4,3 0,3 0,6 4,6',
  '3': '0,0 4,0 4,6 0,6|1,3 4,3',
  '4': '0,0 0,3 4,3|4,0 4,6',
  '5': '4,0 0,0 0,3 4,3 4,6 0,6',
  '6': '4,0 0,0 0,6 4,6 4,3 0,3',
  '7': '0,0 4,0 4,6',
  '8': '0,0 4,0 4,6 0,6 0,0|0,3 4,3',
  '9': '4,6 4,0 0,0 0,3 4,3',
  '.': '2,5.4 2,6',
  ':': '2,1.6 2,2.2|2,4 2,4.6',
  '-': '1,3 3,3',
  '+': '2,1.5 2,4.5|0.5,3 3.5,3',
  '=': '0.5,2 3.5,2|0.5,4 3.5,4',
  '/': '4,0 0,6',
  '!': '2,0 2,4|2,5.4 2,6',
  '?': '0,1 0,0 4,0 4,2.5 2,3 2,4|2,5.4 2,6',
  "'": '2,0 2,1.6',
  '×': '0.8,1.8 3.2,4.2|3.2,1.8 0.8,4.2',
  '÷': '0.5,3 3.5,3|2,1.1 2,1.6|2,4.4 2,4.9',
  '%': '4,0 0,6|0.3,0.3 1.3,0.3 1.3,1.5 0.3,1.5 0.3,0.3|2.7,4.5 3.7,4.5 3.7,5.7 2.7,5.7 2.7,4.5',
};

const CELL_HEIGHT = 6;
const CELL_WIDTH = 4;
const ADVANCE = 5.6;

const GLYPHS = new Map<string, number[][]>(
  Object.entries(RAW).map(([ch, def]) => [ch, def.split('|').map((stroke) => stroke.trim().split(/[ ,]+/).map(Number))]),
);

/** Distance in px from the start of one character to the start of the next, at the given cap height. */
export function advance(size: number): number {
  return ADVANCE * (size / CELL_HEIGHT);
}

/** Width in px of a line of text drawn at the given cap height. */
export function textWidth(text: string, size: number): number {
  if (!text.length) return 0;
  return (text.length * ADVANCE - (ADVANCE - CELL_WIDTH)) * (size / CELL_HEIGHT);
}

/** Add a line of text to the current canvas path. `y` is the top of the caps; `size` is the cap height in px. */
export function traceText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  align: 'left' | 'center' | 'right' = 'left',
): void {
  const unit = size / CELL_HEIGHT;
  const width = textWidth(text, size);
  let cx = align === 'left' ? x : align === 'center' ? x - width / 2 : x - width;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS.get(ch);
    if (glyph) {
      for (const stroke of glyph) {
        for (let i = 0; i < stroke.length; i += 2) {
          const px = cx + stroke[i]! * unit;
          const py = y + stroke[i + 1]! * unit;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
    }
    cx += ADVANCE * unit;
  }
}
