import { describe, it, expect } from 'vitest';
import { PbfWriter } from '../../src/pbf/writer.js';

/** Reference varint encoding of a 64-bit two's complement value. */
function refVarint(v: bigint): number[] {
  let x = BigInt.asUintN(64, v);
  const out: number[] = [];
  while (x > 0x7fn) {
    out.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}

/** Reference 64-bit zigzag. */
function zigzag64(v: bigint): bigint {
  return v >= 0n ? v * 2n : -v * 2n - 1n;
}

function encode(fn: (w: PbfWriter) => void): number[] {
  const w = new PbfWriter();
  fn(w);
  return [...w.finish()];
}

const UNSIGNED: Array<number | bigint> = [
  0, 1, 127, 128, 300, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 5,
  2 ** 35, 5_000_000_019, 1_700_000_000_019, Number.MAX_SAFE_INTEGER,
  2n ** 53n + 1n, 2n ** 63n, 2n ** 64n - 1n,
];

const SIGNED: Array<number | bigint> = [
  0, -1, 1, -2, 2 ** 31 - 1, -(2 ** 31), -(2 ** 31) - 1, -3_000_000_019,
  -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, -(2n ** 63n), 2n ** 63n - 1n,
];

describe('64-bit varints', () => {
  it.each(UNSIGNED)('writeVarint(%s) matches the reference encoding', (v) => {
    expect(encode(w => w.writeVarint(v))).toEqual(refVarint(BigInt(v)));
  });

  it.each(SIGNED)('writeSVarint(%s) matches the reference zigzag encoding', (v) => {
    expect(encode(w => w.writeSVarint(v))).toEqual(refVarint(zigzag64(BigInt(v))));
  });

  it('writes negative values as 10-byte two\'s complement', () => {
    expect(encode(w => w.writeVarint(-1))).toEqual(refVarint(-1n));
    expect(encode(w => w.writeVarint(-1))).toHaveLength(10);
  });

  it('rejects values that are not exactly representable', () => {
    const w = new PbfWriter();
    expect(() => w.writeVarint(1.5)).toThrow(RangeError);
    expect(() => w.writeVarint(2 ** 53 + 2)).toThrow(RangeError);
    expect(() => w.writeVarint(2n ** 64n)).toThrow(RangeError);
    expect(() => w.writeSVarint(2n ** 63n)).toThrow(RangeError);
  });

  it('sizes packed fields correctly around the 32-bit boundary', () => {
    const w = new PbfWriter();
    w.writePackedVarint(1, [2 ** 28 - 1, 2 ** 28, 2 ** 32 - 1]);
    const bytes = [...w.finish()];
    // tag, length, then 4 + 5 + 5 payload bytes
    expect(bytes[1]).toBe(14);
    expect(bytes).toHaveLength(2 + 14);
  });
});
