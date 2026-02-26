import { describe, it, expect } from 'vitest';
import { PbfWriter } from '../../src/pbf/writer.js';

describe('PbfWriter', () => {
  describe('writeVarint', () => {
    it('should encode 0 as single byte', () => {
      const w = new PbfWriter(16);
      w.writeVarint(0);
      const buf = w.finish();
      expect(buf.length).toBe(1);
      expect(buf[0]).toBe(0);
    });

    it('should encode 127 as single byte', () => {
      const w = new PbfWriter(16);
      w.writeVarint(127);
      const buf = w.finish();
      expect(buf.length).toBe(1);
      expect(buf[0]).toBe(127);
    });

    it('should encode 128 as two bytes', () => {
      const w = new PbfWriter(16);
      w.writeVarint(128);
      const buf = w.finish();
      expect(buf.length).toBe(2);
      expect(buf[0]).toBe(0x80);
      expect(buf[1]).toBe(0x01);
    });

    it('should encode 300 correctly', () => {
      const w = new PbfWriter(16);
      w.writeVarint(300);
      const buf = w.finish();
      expect(buf.length).toBe(2);
      // 300 = 0b100101100
      // byte 0: 0b0101100 | 0x80 = 0xAC
      // byte 1: 0b0000010 = 0x02
      expect(buf[0]).toBe(0xAC);
      expect(buf[1]).toBe(0x02);
    });
  });

  describe('writeSVarint', () => {
    it('should zigzag encode 0 as 0', () => {
      const w = new PbfWriter(16);
      w.writeSVarint(0);
      const buf = w.finish();
      expect(buf[0]).toBe(0);
    });

    it('should zigzag encode -1 as 1', () => {
      const w = new PbfWriter(16);
      w.writeSVarint(-1);
      const buf = w.finish();
      expect(buf[0]).toBe(1);
    });

    it('should zigzag encode 1 as 2', () => {
      const w = new PbfWriter(16);
      w.writeSVarint(1);
      const buf = w.finish();
      expect(buf[0]).toBe(2);
    });

    it('should zigzag encode -2 as 3', () => {
      const w = new PbfWriter(16);
      w.writeSVarint(-2);
      const buf = w.finish();
      expect(buf[0]).toBe(3);
    });
  });

  describe('writeString', () => {
    it('should encode a string with length prefix', () => {
      const w = new PbfWriter(64);
      w.writeString('hello');
      const buf = w.finish();
      // Length prefix: 5 (1 byte), then 5 ASCII bytes
      expect(buf.length).toBe(6);
      expect(buf[0]).toBe(5);
      expect(new TextDecoder().decode(buf.subarray(1))).toBe('hello');
    });

    it('should handle empty strings', () => {
      const w = new PbfWriter(16);
      w.writeString('');
      const buf = w.finish();
      expect(buf.length).toBe(1);
      expect(buf[0]).toBe(0);
    });

    it('should handle UTF-8 strings', () => {
      const w = new PbfWriter(64);
      w.writeString('café');
      const buf = w.finish();
      // 'café' is 5 bytes in UTF-8 (é = 2 bytes)
      expect(buf[0]).toBe(5);
    });
  });

  describe('writeDouble', () => {
    it('should encode a double correctly', () => {
      const w = new PbfWriter(16);
      w.writeDouble(3.14);
      const buf = w.finish();
      expect(buf.length).toBe(8);
      const view = new DataView(buf.buffer, buf.byteOffset);
      expect(view.getFloat64(0, true)).toBeCloseTo(3.14, 10);
    });
  });

  describe('writeFloat', () => {
    it('should encode a float correctly', () => {
      const w = new PbfWriter(16);
      w.writeFloat(3.14);
      const buf = w.finish();
      expect(buf.length).toBe(4);
      const view = new DataView(buf.buffer, buf.byteOffset);
      expect(view.getFloat32(0, true)).toBeCloseTo(3.14, 5);
    });
  });

  describe('nested messages', () => {
    it('should encode a nested message with correct length', () => {
      const w = new PbfWriter(64);
      // Field 1, nested message containing a single varint field 1 = 42
      w.beginMessage(1);
      w.writeVarintField(1, 42);
      w.endMessage();

      const buf = w.finish();

      // Tag for field 1 LEN = (1 << 3) | 2 = 0x0A
      expect(buf[0]).toBe(0x0A);

      // The nested message content is: tag(1,0)=0x08 + varint(42)=0x2A = 2 bytes
      expect(buf[1]).toBe(2); // length

      expect(buf[2]).toBe(0x08); // tag for field 1, varint
      expect(buf[3]).toBe(42);   // value
    });
  });

  describe('packed varints', () => {
    it('should encode packed varint field', () => {
      const w = new PbfWriter(64);
      w.writePackedVarint(4, [1, 2, 3]);
      const buf = w.finish();

      // Tag for field 4 LEN = (4 << 3) | 2 = 0x22
      expect(buf[0]).toBe(0x22);

      // Each value is 1 byte varint, total 3 bytes
      expect(buf[1]).toBe(3); // length

      expect(buf[2]).toBe(1);
      expect(buf[3]).toBe(2);
      expect(buf[4]).toBe(3);
    });

    it('should skip empty arrays', () => {
      const w = new PbfWriter(16);
      w.writePackedVarint(1, []);
      const buf = w.finish();
      expect(buf.length).toBe(0);
    });
  });

  describe('buffer growth', () => {
    it('should grow buffer when needed', () => {
      const w = new PbfWriter(4); // Very small initial buffer
      // Write enough data to trigger growth
      for (let i = 0; i < 100; i++) {
        w.writeVarint(i * 1000);
      }
      const buf = w.finish();
      expect(buf.length).toBeGreaterThan(4);
    });
  });
});
