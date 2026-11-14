/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder & crisp `<svg>` renderer (Byte mode, ECC Level M, Versions 1..6).
 *
 * Encodes Co-op invite URLs up to 106 UTF-8 bytes (e.g. `https://geurtsgaming.com/?j=2YCD44` in Version 3, 29x29)
 * with a mandatory 4-module quiet zone so iOS and Android cameras scan reliably against dark arcade backdrops.
 */

export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  /** Row-major boolean grid (`true` = dark module, `false` = light module), length `size * size`. */
  readonly modules: readonly boolean[];
}

export interface QrSvgOptions {
  /** Quiet-zone border in modules (ISO recommends >= 4). Defaults to `4`. */
  margin?: number;
  /** Dark module fill color. Defaults to `'#06102e'`. */
  darkColor?: string;
  /** Light background / quiet-zone fill color. Defaults to `'#f8fafc'`. */
  lightColor?: string;
  /** Accessible `aria-label` on the root `<svg>`. */
  label?: string;
}

interface VersionSpec {
  readonly version: number;
  readonly totalCodewords: number;
  readonly ecCodewordsPerBlock: number;
  readonly numBlocks: number;
  readonly alignmentCenters: readonly number[];
}

/** ISO/IEC 18004 Table 7 & Table 9 specifications for Error Correction Level M (15% recovery), Versions 1..6. */
const VERSION_SPECS_M: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecCodewordsPerBlock: 10, numBlocks: 1, alignmentCenters: [] },
  { version: 2, totalCodewords: 44, ecCodewordsPerBlock: 16, numBlocks: 1, alignmentCenters: [6, 18] },
  { version: 3, totalCodewords: 70, ecCodewordsPerBlock: 26, numBlocks: 1, alignmentCenters: [6, 22] },
  { version: 4, totalCodewords: 100, ecCodewordsPerBlock: 18, numBlocks: 2, alignmentCenters: [6, 26] },
  { version: 5, totalCodewords: 134, ecCodewordsPerBlock: 24, numBlocks: 2, alignmentCenters: [6, 30] },
  { version: 6, totalCodewords: 172, ecCodewordsPerBlock: 16, numBlocks: 4, alignmentCenters: [6, 34] },
];

// GF(256) log/antilog tables modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_EXP[i + 255] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Build the Reed-Solomon generator polynomial `(x - a^0)(x - a^1)...(x - a^(degree-1))` (monic, omitting leading `1`). */
function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const root = GF_EXP[i]!;
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, root);
    }
    poly = next;
  }
  return poly.subarray(1);
}

/** Compute `ecCount` Reed-Solomon error-correction codewords for `data` (exposed for ISO Annex I.2 unit tests). */
export function computeReedSolomonRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        rem[j] ^= gfMul(gen[j]!, factor);
      }
    }
  }
  return rem;
}

/** Compute the 15-bit BCH(15, 5) masked format sequence for ECC Level M (`00`) and `mask` (`0..7`). */
export function computeFormatBitsLevelM(mask: number): number {
  const data = (0b00 << 3) | (mask & 0x07);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function appendBits(out: number[], value: number, bitLen: number): void {
  for (let i = bitLen - 1; i >= 0; i--) {
    out.push((value >>> i) & 1);
  }
}

function encodeDataCodewords(utf8: Uint8Array, spec: VersionSpec): Uint8Array {
  const totalDataCodewords = spec.totalCodewords - spec.ecCodewordsPerBlock * spec.numBlocks;
  const totalDataBits = totalDataCodewords * 8;
  const bits: number[] = [];

  // Byte mode indicator (0100) + 8-bit byte length (for QR Versions 1..9)
  appendBits(bits, 0b0100, 4);
  appendBits(bits, utf8.length, 8);
  for (let i = 0; i < utf8.length; i++) {
    appendBits(bits, utf8[i]!, 8);
  }

  // Terminator (up to 4 zero bits) + zero-pad to byte boundary
  const terminator = Math.min(4, totalDataBits - bits.length);
  appendBits(bits, 0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(totalDataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | bits[i * 8 + b]!;
    }
    codewords[i] = byte;
  }

  // Alternating pad bytes 0xEC, 0x11
  for (let i = bits.length / 8, padIdx = 0; i < totalDataCodewords; i++, padIdx++) {
    codewords[i] = padIdx % 2 === 0 ? 0xec : 0x11;
  }
  return codewords;
}

function interleaveCodewords(dataCodewords: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataPerBlock = dataCodewords.length / spec.numBlocks;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];

  for (let b = 0; b < spec.numBlocks; b++) {
    const slice = dataCodewords.subarray(b * dataPerBlock, (b + 1) * dataPerBlock);
    dataBlocks.push(slice);
    ecBlocks.push(computeReedSolomonRemainder(slice, spec.ecCodewordsPerBlock));
  }

  const out = new Uint8Array(spec.totalCodewords);
  let pos = 0;
  for (let i = 0; i < dataPerBlock; i++) {
    for (let b = 0; b < spec.numBlocks; b++) {
      out[pos++] = dataBlocks[b]![i]!;
    }
  }
  for (let i = 0; i < spec.ecCodewordsPerBlock; i++) {
    for (let b = 0; b < spec.numBlocks; b++) {
      out[pos++] = ecBlocks[b]![i]!;
    }
  }
  return out;
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function drawFormatBits(modules: boolean[], isFunc: boolean[], size: number, mask: number): void {
  const bits = computeFormatBitsLevelM(mask);
  const setFunc = (r: number, c: number, dark: boolean) => {
    modules[r * size + c] = dark;
    isFunc[r * size + c] = true;
  };

  for (let i = 0; i <= 5; i++) setFunc(i, 8, ((bits >>> i) & 1) === 1);
  setFunc(7, 8, ((bits >>> 6) & 1) === 1);
  setFunc(8, 8, ((bits >>> 7) & 1) === 1);
  setFunc(8, 7, ((bits >>> 8) & 1) === 1);
  for (let i = 9; i < 15; i++) setFunc(8, 14 - i, ((bits >>> i) & 1) === 1);

  for (let i = 0; i < 8; i++) setFunc(8, size - 1 - i, ((bits >>> i) & 1) === 1);
  for (let i = 8; i < 15; i++) setFunc(size - 15 + i, 8, ((bits >>> i) & 1) === 1);
  // Mandatory dark module
  setFunc(size - 8, 8, true);
}

function computePenalty(modules: readonly boolean[], size: number): number {
  let penalty = 0;

  // Rule 1: 5+ consecutive same-color modules in rows & columns
  for (let r = 0; r < size; r++) {
    let runColor = modules[r * size]!;
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      const cur = modules[r * size + c]!;
      if (cur === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = cur;
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[c]!;
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      const cur = modules[r * size + c]!;
      if (cur === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = cur;
        runLen = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks of identical color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r * size + c]!;
      if (
        modules[r * size + c + 1] === v &&
        modules[(r + 1) * size + c] === v &&
        modules[(r + 1) * size + c + 1] === v
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 3: 1:1:3:1:1 finder-like patterns preceded or followed by 4 light modules
  const hasFinderLike = (get: (idx: number) => boolean): number => {
    let hits = 0;
    for (let i = 0; i <= size - 11; i++) {
      const p1 =
        get(i) &&
        !get(i + 1) &&
        get(i + 2) &&
        get(i + 3) &&
        get(i + 4) &&
        !get(i + 5) &&
        get(i + 6) &&
        !get(i + 7) &&
        !get(i + 8) &&
        !get(i + 9) &&
        !get(i + 10);
      const p2 =
        !get(i) &&
        !get(i + 1) &&
        !get(i + 2) &&
        !get(i + 3) &&
        get(i + 4) &&
        !get(i + 5) &&
        get(i + 6) &&
        get(i + 7) &&
        get(i + 8) &&
        !get(i + 9) &&
        get(i + 10);
      if (p1 || p2) hits += 40;
    }
    return hits;
  };
  for (let r = 0; r < size; r++) penalty += hasFinderLike((c) => modules[r * size + c]!);
  for (let c = 0; c < size; c++) penalty += hasFinderLike((r) => modules[r * size + c]!);

  // Rule 4: Dark/light ratio balance
  let darkCount = 0;
  for (let i = 0; i < modules.length; i++) if (modules[i]) darkCount++;
  const total = size * size;
  const fivePercentSteps = Math.floor((Math.abs(darkCount * 20 - total * 10) + total - 1) / total) - 1;
  if (fivePercentSteps > 0) penalty += fivePercentSteps * 10;

  return penalty;
}

/** Encode `text` into a QR Code module matrix (Byte mode, ECC Level M, Versions 1..6). */
export function encodeQrMatrix(text: string): QrMatrix {
  const utf8 = new TextEncoder().encode(text);
  const spec = VERSION_SPECS_M.find((s) => {
    const dataCw = s.totalCodewords - s.ecCodewordsPerBlock * s.numBlocks;
    // 4-bit mode + 8-bit byte count = 12 bits -> 2 header bytes max
    return utf8.length + 2 <= dataCw;
  });
  if (!spec) {
    throw new RangeError(`QR payload too long (${utf8.length} bytes; max 106 bytes for Version 6-M)`);
  }

  const size = spec.version * 4 + 17;
  const baseModules = new Array<boolean>(size * size).fill(false);
  const isFunc = new Array<boolean>(size * size).fill(false);

  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    baseModules[r * size + c] = dark;
    isFunc[r * size + c] = true;
  };

  // Finder patterns + 1-module white separators at 3 corners
  const drawFinder = (topR: number, leftC: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        const dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dist === 3 || dist <= 1);
        setFunc(topR + dr, leftC + dc, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns along row 6 & column 6
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns (skipping the 3 finder corners)
  const centers = spec.alignmentCenters;
  for (let rIdx = 0; rIdx < centers.length; rIdx++) {
    for (let cIdx = 0; cIdx < centers.length; cIdx++) {
      if (
        (rIdx === 0 && cIdx === 0) ||
        (rIdx === 0 && cIdx === centers.length - 1) ||
        (rIdx === centers.length - 1 && cIdx === 0)
      ) {
        continue;
      }
      const cr = centers[rIdx]!;
      const cc = centers[cIdx]!;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(cr + dr, cc + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info cells before zig-zag data placement
  drawFormatBits(baseModules, isFunc, size, 0);

  const allCodewords = interleaveCodewords(encodeDataCodewords(utf8, spec), spec);
  let bitIdx = 0;
  const totalBits = allCodewords.length * 8;

  // Place data & EC bits in 2-column vertical zig-zag strips from right to left
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // Skip vertical timing column
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        if (isFunc[r * size + c]) continue;
        let dark = false;
        if (bitIdx < totalBits) {
          const byte = allCodewords[bitIdx >>> 3]!;
          dark = ((byte >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
        }
        baseModules[r * size + c] = dark;
      }
    }
    upward = !upward;
  }

  // Evaluate all 8 masks and choose the lowest ISO penalty score
  let bestModules = baseModules;
  let bestPenalty = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = baseModules.slice();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const idx = r * size + c;
        if (!isFunc[idx] && maskBit(mask, r, c)) {
          candidate[idx] = !candidate[idx]!;
        }
      }
    }
    drawFormatBits(candidate, isFunc, size, mask);
    const score = computePenalty(candidate, size);
    if (score < bestPenalty) {
      bestPenalty = score;
      bestModules = candidate;
    }
  }

  return { version: spec.version, size, modules: bestModules };
}

function escapeXmlAttr(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Render `text` as a crisp, self-contained `<svg>` QR code with a quiet-zone margin. */
export function renderQrSvg(text: string, opts: QrSvgOptions = {}): string {
  const { size, modules } = encodeQrMatrix(text);
  const margin = Math.max(2, Math.floor(opts.margin ?? 4));
  const darkColor = escapeXmlAttr(opts.darkColor ?? '#06102e');
  const lightColor = escapeXmlAttr(opts.lightColor ?? '#f8fafc');
  const label = escapeXmlAttr(opts.label ?? 'Scan QR code to join squad');
  const viewSize = size + margin * 2;

  let path = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules[r * size + c]) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < size && modules[r * size + c + run]) run++;
      path += `M${c + margin},${r + margin}h${run}v1h-${run}z`;
      c += run;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${viewSize}" height="${viewSize}" fill="${lightColor}"/><path fill="${darkColor}" d="${path}"/></svg>`;
}
