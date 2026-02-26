import { describe, it, expect } from 'vitest';
import { FlatBufferReader } from '../../src/fgb/flatbuffers.js';

describe('FlatBufferReader', () => {
  describe('scalar reads', () => {
    it('should read uint8', () => {
      const buf = new Uint8Array([42]);
      const fb = new FlatBufferReader(buf);
      expect(fb.readUint8(0)).toBe(42);
    });

    it('should read uint16 LE', () => {
      const buf = new Uint8Array([0x34, 0x12]); // 0x1234 LE
      const fb = new FlatBufferReader(buf);
      expect(fb.readUint16(0)).toBe(0x1234);
    });

    it('should read uint32 LE', () => {
      const buf = new Uint8Array([0x78, 0x56, 0x34, 0x12]); // 0x12345678 LE
      const fb = new FlatBufferReader(buf);
      expect(fb.readUint32(0)).toBe(0x12345678);
    });

    it('should read int32 LE', () => {
      // -1 in LE = FF FF FF FF
      const buf = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
      const fb = new FlatBufferReader(buf);
      expect(fb.readInt32(0)).toBe(-1);
    });

    it('should read float64', () => {
      const buf = new Uint8Array(8);
      const view = new DataView(buf.buffer);
      view.setFloat64(0, Math.PI, true);
      const fb = new FlatBufferReader(buf);
      expect(fb.readFloat64(0)).toBeCloseTo(Math.PI, 15);
    });
  });

  describe('typed array reads', () => {
    it('should read Float64Array', () => {
      const buf = new Uint8Array(24);
      const view = new DataView(buf.buffer);
      view.setFloat64(0, 1.0, true);
      view.setFloat64(8, 2.0, true);
      view.setFloat64(16, 3.0, true);

      const fb = new FlatBufferReader(buf);
      const arr = fb.readFloat64Array(0, 3);
      expect(arr.length).toBe(3);
      expect(arr[0]).toBe(1.0);
      expect(arr[1]).toBe(2.0);
      expect(arr[2]).toBe(3.0);
    });

    it('should read Uint32Array', () => {
      const buf = new Uint8Array(12);
      const view = new DataView(buf.buffer);
      view.setUint32(0, 10, true);
      view.setUint32(4, 20, true);
      view.setUint32(8, 30, true);

      const fb = new FlatBufferReader(buf);
      const arr = fb.readUint32Array(0, 3);
      expect(arr.length).toBe(3);
      expect(arr[0]).toBe(10);
      expect(arr[1]).toBe(20);
      expect(arr[2]).toBe(30);
    });
  });
});
