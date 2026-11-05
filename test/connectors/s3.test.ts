import { describe, it, expect, afterEach, vi } from 'vitest';
import { S3Connector } from '../../src/connectors/s3.js';

// == Mock SDK ================================================================
//
// The connector imports @aws-sdk/client-s3 at runtime unless the module is
// passed as the `sdk` option, which these tests do with a fake SDK.

/** Simulated S3 object store: keys are "bucket/key" */
type ObjectStore = Record<string, Uint8Array>;

function createMockSdk(store: ObjectStore) {
  class GetObjectCommand {
    readonly input: { Bucket: string; Key: string; Range: string };
    constructor(input: { Bucket: string; Key: string; Range: string }) {
      this.input = input;
    }
  }

  const sendFn = vi.fn(async (command: GetObjectCommand) => {
    const { Bucket, Key, Range } = command.input;
    const objectKey = `${Bucket}/${Key}`;
    const data = store[objectKey];
    if (!data) {
      const err = new Error(`NoSuchKey: ${objectKey}`);
      (err as any).Code = 'NoSuchKey';
      throw err;
    }

    const match = Range.match(/bytes=(\d+)-(\d+)/);
    if (!match) throw new Error(`Invalid Range header: ${Range}`);

    const start = Number(match[1]);
    if (start >= data.length) {
      const err = new Error('The requested range is not satisfiable');
      Object.assign(err, { name: 'InvalidRange', $metadata: { httpStatusCode: 416 }, ActualObjectSize: String(data.length) });
      throw err;
    }
    const end = Math.min(Number(match[2]), data.length - 1);
    const slice = data.slice(start, end + 1);

    // Like S3: the satisfiable part of the range, with ContentRange
    return {
      ContentRange: `bytes ${start}-${end}/${data.length}`,
      ContentLength: slice.length,
      Body: {
        transformToByteArray: async () => new Uint8Array(slice),
      },
    };
  });

  class S3Client {
    send = sendFn;
    destroy = vi.fn();
  }

  return { S3Client, GetObjectCommand, sendFn };
}


// == Test data ===============================================================

// 256 sequential bytes: value at index i === i
const TEST_BYTES = new Uint8Array(256);
for (let i = 0; i < 256; i++) TEST_BYTES[i] = i;

const STORE: ObjectStore = {
  'test-bucket/data/counties.fgb': TEST_BYTES,
  'other-bucket/nested/path/roads.fgb': TEST_BYTES,
};

// == Tests ===================================================================

describe('S3Connector', () => {
  let connector: S3Connector;

  afterEach(async () => {
    if (connector) await connector.close();
  });

  describe('path parsing', () => {
    it('should parse s3:// URIs', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      await connector.read('s3://test-bucket/data/counties.fgb', 0, 4);

      expect(sdk.sendFn).toHaveBeenCalledOnce();
      const cmd = sdk.sendFn.mock.calls[0][0];
      expect(cmd.input.Bucket).toBe('test-bucket');
      expect(cmd.input.Key).toBe('data/counties.fgb');
    });

    it('should parse bare bucket/key paths', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      await connector.read('other-bucket/nested/path/roads.fgb', 0, 4);

      const cmd = sdk.sendFn.mock.calls[0][0];
      expect(cmd.input.Bucket).toBe('other-bucket');
      expect(cmd.input.Key).toBe('nested/path/roads.fgb');
    });

    it('should reject paths without a key', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      await expect(connector.read('bucket-only', 0, 1)).rejects.toThrow('Invalid S3 path');
    });

    it('should reject s3:// paths without a key', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      await expect(connector.read('s3://bucket-only', 0, 1)).rejects.toThrow('Invalid S3 path');
    });
  });

  describe('read', () => {
    it('should read a byte range', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      const result = await connector.read('s3://test-bucket/data/counties.fgb', 10, 5);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(5);
      expect([...result]).toEqual([10, 11, 12, 13, 14]);
    });

    it('should construct the correct Range header', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      await connector.read('s3://test-bucket/data/counties.fgb', 100, 50);

      const cmd = sdk.sendFn.mock.calls[0][0];
      expect(cmd.input.Range).toBe('bytes=100-149');
    });

    it('should read single byte at offset 0', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      const result = await connector.read('s3://test-bucket/data/counties.fgb', 0, 1);

      expect([...result]).toEqual([0]);
      const cmd = sdk.sendFn.mock.calls[0][0];
      expect(cmd.input.Range).toBe('bytes=0-0');
    });

    it('should propagate S3 errors', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      await expect(
        connector.read('s3://nonexistent/file.fgb', 0, 1),
      ).rejects.toThrow('NoSuchKey');
    });

    it('should throw on empty response body', async () => {
      const sdk = createMockSdk(STORE);
      // Override send to return null body
      sdk.sendFn.mockResolvedValueOnce({ Body: null });

      connector = new S3Connector({ region: 'us-east-1', sdk });

      await expect(
        connector.read('s3://test-bucket/data/counties.fgb', 0, 1),
      ).rejects.toThrow('Empty response body');
    });
  });

  describe('readRanges', () => {
    it('should return empty array for empty ranges', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      const results = await connector.readRanges('s3://test-bucket/data/counties.fgb', []);

      expect(results).toEqual([]);
      expect(sdk.sendFn).not.toHaveBeenCalled();
    });

    it('should handle single range', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      const results = await connector.readRanges('s3://test-bucket/data/counties.fgb', [
        { offset: 5, length: 3 },
      ]);

      expect(results.length).toBe(1);
      expect([...results[0]]).toEqual([5, 6, 7]);
    });

    it('should read multiple ranges in order', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      const ranges = [
        { offset: 0, length: 3 },
        { offset: 100, length: 4 },
        { offset: 200, length: 5 },
      ];

      const results = await connector.readRanges('s3://test-bucket/data/counties.fgb', ranges);

      expect(results.length).toBe(3);
      expect([...results[0]]).toEqual([0, 1, 2]);
      expect([...results[1]]).toEqual([100, 101, 102, 103]);
      expect([...results[2]]).toEqual([200, 201, 202, 203, 204]);
    });

    it('should preserve result order regardless of completion order', async () => {
      // Introduce variable delays so requests complete out of order
      const store: ObjectStore = { 'b/k.fgb': TEST_BYTES };
      const sdk = createMockSdk(store);
      const originalSend = sdk.sendFn.getMockImplementation()!;

      let callIdx = 0;
      sdk.sendFn.mockImplementation(async (cmd: any) => {
        const idx = callIdx++;
        // First range completes last, last range completes first
        const delays = [30, 20, 10];
        await new Promise(r => setTimeout(r, delays[idx] ?? 0));
        return originalSend(cmd);
      });

      connector = new S3Connector({ region: 'us-east-1', sdk });

      const results = await connector.readRanges('s3://b/k.fgb', [
        { offset: 10, length: 1 },
        { offset: 20, length: 1 },
        { offset: 30, length: 1 },
      ]);

      expect([...results[0]]).toEqual([10]);
      expect([...results[1]]).toEqual([20]);
      expect([...results[2]]).toEqual([30]);
    });

    it('should respect maxConcurrency', async () => {
      const sdk = createMockSdk(STORE);
      let peakConcurrency = 0;
      let activeConcurrency = 0;

      const originalSend = sdk.sendFn.getMockImplementation()!;
      sdk.sendFn.mockImplementation(async (cmd: any) => {
        activeConcurrency++;
        peakConcurrency = Math.max(peakConcurrency, activeConcurrency);
        await new Promise(r => setTimeout(r, 10));
        const result = await originalSend(cmd);
        activeConcurrency--;
        return result;
      });

      connector = new S3Connector({ region: 'us-east-1', maxConcurrency: 2, sdk });

      // 6 ranges, maxConcurrency=2 — should never exceed 2 in-flight
      const ranges = Array.from({ length: 6 }, (_, i) => ({
        offset: i * 10,
        length: 5,
      }));

      const results = await connector.readRanges('s3://test-bucket/data/counties.fgb', ranges);

      expect(results.length).toBe(6);
      expect(peakConcurrency).toBeLessThanOrEqual(2);
      expect(sdk.sendFn).toHaveBeenCalledTimes(6);
    });
  });

  describe('streamToUint8Array fallback', () => {
    it('should handle async iterable body (no transformToByteArray)', async () => {
      const sdk = createMockSdk(STORE);
      // Override send to return an async iterable instead of transformToByteArray
      sdk.sendFn.mockResolvedValueOnce({
        ContentRange: 'bytes 10-14/100',
        Body: {
          async *[Symbol.asyncIterator]() {
            yield new Uint8Array([10, 11]);
            yield new Uint8Array([12, 13, 14]);
          },
        },
      });

      connector = new S3Connector({ region: 'us-east-1', sdk });

      const result = await connector.read('s3://test-bucket/data/counties.fgb', 10, 5);

      expect([...result]).toEqual([10, 11, 12, 13, 14]);
    });
  });

  describe('close', () => {
    it('should destroy the client', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      // Trigger a read to ensure client is "active"
      await connector.read('s3://test-bucket/data/counties.fgb', 0, 1);

      const client = (connector as any).client;
      await connector.close();

      expect(client.destroy).toHaveBeenCalledOnce();
      expect((connector as any).client).toBeNull();
    });

    it('should not destroy a client passed in', async () => {
      const sdk = createMockSdk(STORE);
      const client = new sdk.S3Client();
      connector = new S3Connector({ client, sdk });
      expect([...await connector.read('s3://test-bucket/data/counties.fgb', 3, 2)]).toEqual([3, 4]);
      await connector.close();
      expect(client.destroy).not.toHaveBeenCalled();
      expect(sdk.sendFn).toHaveBeenCalledOnce();
    });

    it('should be safe to call twice', async () => {
      const sdk = createMockSdk(STORE);
      connector = new S3Connector({ region: 'us-east-1', sdk });

      await connector.close();
      await connector.close(); // should not throw
    });
  });

  describe('SDK loading', () => {
    it('should explain how to install the SDK when it is missing', async () => {
      // @aws-sdk/client-s3 is not installed in this repository
      connector = new S3Connector({ region: 'us-east-1' });
      await expect(connector.read('s3://test-bucket/data/counties.fgb', 0, 1))
        .rejects.toThrow(/npm install @aws-sdk\/client-s3/);
    });

    it('should not use the Function constructor (CSP without unsafe-eval)', async () => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync(new URL('../../src/connectors/s3.ts', import.meta.url), 'utf8');
      expect(source).not.toMatch(/Function\(/);
    });
  });
});
