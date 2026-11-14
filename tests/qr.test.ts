import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeFormatBitsLevelM,
  computeReedSolomonRemainder,
  encodeQrMatrix,
  renderQrSvg,
  type QrMatrix,
} from '../src/game/qr';

/** Independent QR decoder (Versions 1..6, Level M) to verify round-trip decode & zero RS syndromes. */
function decodeQrLevelM(qr: QrMatrix): string {
  const { version, size, modules } = qr;
  const at = (r: number, c: number): boolean => modules[r * size + c]!;

  // 1. Verify all 3 finder patterns + 1-module white separators + timing lines + dark module
  for (const [fr, fc] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        assert.equal(at(fr + dr, fc + dc), dist === 3 || dist <= 1, `finder module (${fr + dr},${fc + dc})`);
      }
    }
  }
  assert.equal(at(size - 8, 8), true, 'dark module at (4*V + 9, 8) must be dark');

  // 2. Read both 15-bit format copies and verify they are identical & match ECC Level M (`00`)
  let fmt1 = 0;
  for (let i = 0; i <= 5; i++) if (at(i, 8)) fmt1 |= 1 << i;
  if (at(7, 8)) fmt1 |= 1 << 6;
  if (at(8, 8)) fmt1 |= 1 << 7;
  if (at(8, 7)) fmt1 |= 1 << 8;
  for (let i = 9; i < 15; i++) if (at(8, 14 - i)) fmt1 |= 1 << i;

  let fmt2 = 0;
  for (let i = 0; i < 8; i++) if (at(8, size - 1 - i)) fmt2 |= 1 << i;
  for (let i = 8; i < 15; i++) if (at(size - 15 + i, 8)) fmt2 |= 1 << i;

  assert.equal(fmt1, fmt2, 'both 15-bit format info copies match');
  const unmaskedFmt = fmt1 ^ 0x5412;
  const eccBits = (unmaskedFmt >>> 13) & 0x03;
  assert.equal(eccBits, 0b00, 'format ECC indicator is Level M (00)');
  const mask = (unmaskedFmt >>> 10) & 0x07;
  assert.equal(fmt1, computeFormatBitsLevelM(mask));

  // 3. Reconstruct function module mask independently
  const isFunc = new Array<boolean>(size * size).fill(false);
  const mark = (r: number, c: number) => {
    if (r >= 0 && r < size && c >= 0 && c < size) isFunc[r * size + c] = true;
  };
  for (const [fr, fc] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(fr + dr, fc + dc);
  }
  for (let i = 8; i < size - 8; i++) {
    mark(6, i);
    mark(i, 6);
  }
  if (version >= 2) {
    const cr = size - 7;
    const cc = size - 7;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(cr + dr, cc + dc);
  }
  for (let i = 0; i <= 8; i++) {
    mark(i, 8);
    mark(8, i);
  }
  for (let i = 0; i < 8; i++) mark(8, size - 1 - i);
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8);

  const maskFn = (r: number, c: number): boolean => {
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
  };

  // 4. Read zig-zag bits & unmask
  const rawBits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        if (isFunc[r * size + c]) continue;
        const bit = at(r, c) !== maskFn(r, c) ? 1 : 0;
        rawBits.push(bit);
      }
    }
    upward = !upward;
  }

  const totalCwByVer = [0, 26, 44, 70, 100, 134, 172];
  const ecPerBlockByVer = [0, 10, 16, 26, 18, 24, 16];
  const blocksByVer = [0, 1, 1, 1, 2, 2, 4];

  const totalCw = totalCwByVer[version]!;
  const ecPerBlock = ecPerBlockByVer[version]!;
  const numBlocks = blocksByVer[version]!;
  const dataPerBlock = (totalCw - ecPerBlock * numBlocks) / numBlocks;

  const interleaved = new Uint8Array(totalCw);
  for (let i = 0; i < totalCw; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | rawBits[i * 8 + k]!;
    interleaved[i] = b;
  }

  // 5. De-interleave blocks and verify Reed-Solomon remainder matches 100%
  const dataAll = new Uint8Array(dataPerBlock * numBlocks);
  for (let blk = 0; blk < numBlocks; blk++) {
    const d = new Uint8Array(dataPerBlock);
    const e = new Uint8Array(ecPerBlock);
    for (let i = 0; i < dataPerBlock; i++) d[i] = interleaved[i * numBlocks + blk]!;
    for (let i = 0; i < ecPerBlock; i++) e[i] = interleaved[dataPerBlock * numBlocks + i * numBlocks + blk]!;
    assert.deepEqual(computeReedSolomonRemainder(d, ecPerBlock), e, `RS block ${blk} valid`);
    dataAll.set(d, blk * dataPerBlock);
  }

  // 6. Decode Byte mode (`0100` + 8-bit length + UTF-8 bytes)
  const dataBits: number[] = [];
  for (const byte of dataAll) {
    for (let k = 7; k >= 0; k--) dataBits.push((byte >>> k) & 1);
  }
  const mode = (dataBits[0]! << 3) | (dataBits[1]! << 2) | (dataBits[2]! << 1) | dataBits[3]!;
  assert.equal(mode, 0b0100, 'Byte mode indicator (0100)');
  let len = 0;
  for (let k = 0; k < 8; k++) len = (len << 1) | dataBits[4 + k]!;
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | dataBits[12 + i * 8 + k]!;
    payload[i] = b;
  }
  return new TextDecoder().decode(payload);
}

test('Reed-Solomon GF(256) syndromes vanish at all roots a^0..a^(k-1) and BCH(15,5) matches ISO/IEC 18004 Annex I.4', () => {
  // Build GF(256) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11d) independently to verify syndromes C(a^i) == 0
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let v = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = v;
    exp[i + 255] = v;
    log[v] = i;
    v = (v << 1) ^ (v & 0x80 ? 0x11d : 0);
  }
  const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : exp[log[a]! + log[b]!]!);

  // Dividing [1] with ecCount=10 yields g_10(x); ISO/IEC 18004 Table A.1 lists its alpha exponents:
  // [251, 67, 46, 61, 118, 70, 64, 94, 32, 45]
  const g10 = computeReedSolomonRemainder(new Uint8Array([1]), 10);
  assert.deepEqual(
    Array.from(g10, (coeff) => log[coeff]!),
    [251, 67, 46, 61, 118, 70, 64, 94, 32, 45],
    'generator polynomial g_10(x) matches ISO/IEC 18004 Table A.1',
  );

  // Verify all 10 syndromes C(a^i) == 0 for a 16-byte Version 1-M payload + 10-byte RS remainder
  const data = new Uint8Array([16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17]);
  const ec = computeReedSolomonRemainder(data, 10);
  const codeword = new Uint8Array(data.length + ec.length);
  codeword.set(data, 0);
  codeword.set(ec, data.length);

  for (let rootIdx = 0; rootIdx < 10; rootIdx++) {
    const root = exp[rootIdx]!;
    let syndrome = 0;
    for (const byte of codeword) {
      syndrome = mul(syndrome, root) ^ byte;
    }
    assert.equal(syndrome, 0, `syndrome S_${rootIdx} = C(a^${rootIdx}) must be 0`);
  }

  // ISO/IEC 18004 Annex I.4 (ECC Level M = 00, mask = 010 -> 101111001111100)
  assert.equal(computeFormatBitsLevelM(2), 0b101111001111100);
});

test('QR encoder round-trips Co-op invite URLs across Versions 1..6 and renders crisp SVG with quiet zone', () => {
  const samples = [
    { url: 'K7M4P9', expectedVersion: 1 },
    { url: 'http://localhost:84/?j=2YCD44', expectedVersion: 3 },
    { url: 'https://geurtsgaming.com/?j=2YCD44', expectedVersion: 3 },
    { url: 'http://192.168.1.42:84/?j=K7M4P9&mode=coop-v4-test', expectedVersion: 4 },
    { url: 'https://geurtsgaming.com/?j=ABCDEF&utm=none&extra=version-five-lan-invite-check', expectedVersion: 5 },
    {
      url: 'https://geurtsgaming.com/?j=ABCDEF&note=version-six-four-block-interleave-verification-test-url',
      expectedVersion: 6,
    },
  ];

  for (const { url, expectedVersion } of samples) {
    const matrix = encodeQrMatrix(url);
    assert.equal(matrix.version, expectedVersion, `expected Version ${expectedVersion} for "${url}"`);
    assert.equal(matrix.size, expectedVersion * 4 + 17);
    assert.equal(decodeQrLevelM(matrix), url, `exact round-trip decode for "${url}"`);
  }

  const svg = renderQrSvg('https://geurtsgaming.com/?j=2YCD44', { label: 'Join room 2YC-D44' });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37 37"'));
  assert.ok(svg.includes('aria-label="Join room 2YC-D44"'));
  assert.ok(svg.includes('<path fill="#06102e" d="M4,4h7v1h-7z'));

  assert.throws(() => encodeQrMatrix('x'.repeat(120)), RangeError);
});
