import { createServer } from 'node:http';
import { readFile, open, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TileServer,
  TileClient,
  tile,
  LocalConnector,
  HttpConnector,
  S3Connector,
} from '@geozelot/fgb-vt';

const PORT = 3000;
const FGB_FILE = './data/us_counties.fgb';
const FGB_URL  = `http://localhost:${PORT}/data/us_counties.fgb`;

// ── Mock S3 SDK ─────────────────────────────────────────────────────
//
// Simulates S3 GetObject with Range headers by reading from the local
// filesystem. Maps s3://fgb-data/{key} → ./data/{key} so the source
// path "s3://fgb-data/us_counties.fgb" reads "./data/us_counties.fgb".
//
// This exercises the real S3Connector code (path parsing, range header
// construction, concurrency throttling) without @aws-sdk/client-s3.

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'data');

class MockGetObjectCommand {
  constructor(input) { this.input = input; }
}

class MockS3Client {
  async send(command) {
    const { Key, Range } = command.input;
    const filePath = resolve(DATA_DIR, Key);

    const match = Range.match(/bytes=(\d+)-(\d+)/);
    if (!match) throw new Error(`Invalid Range: ${Range}`);

    const start = Number(match[1]);
    const end   = Number(match[2]);
    const len   = end - start + 1;

    const fh  = await open(filePath);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    await fh.close();

    return {
      Body: {
        transformToByteArray: async () =>
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      },
    };
  }
  destroy() {}
}

/** Create an S3Connector backed by the local-filesystem mock SDK. */
function createMockS3Connector() {
  const connector = new S3Connector({ region: 'us-east-1' });
  // Inject mock SDK — bypasses the lazy dynamic import of @aws-sdk/client-s3
  connector.sdk    = { S3Client: MockS3Client, GetObjectCommand: MockGetObjectCommand };
  connector.client = new MockS3Client();
  return connector;
}

// ── Sources ─────────────────────────────────────────────────────────

const SOURCES = {
  us_counties_local: { name: 'us_counties', path: FGB_FILE },
  us_counties_http:  { name: 'us_counties', path: FGB_URL },
  us_counties_s3:    { name: 'us_counties', path: 's3://fgb-data/us_counties.fgb' },
};

// ── Tier 1: TileServer (stateful) — one per connector type ─────────
const tileServers = {
  us_counties_local: new TileServer({
    connector: new LocalConnector(),
    sources: SOURCES.us_counties_local,
  }),
  us_counties_http: new TileServer({
    connector: new HttpConnector(),
    sources: SOURCES.us_counties_http,
  }),
  us_counties_s3: new TileServer({
    connector: createMockS3Connector(),
    sources: SOURCES.us_counties_s3,
  }),
};

// ── Tier 2: TileClient (semi-stateful) ─────────────────────────────
const tileClients = {
  us_counties_local: new TileClient(new LocalConnector()),
  us_counties_http:  new TileClient(new HttpConnector()),
  us_counties_s3:    new TileClient(createMockS3Connector()),
};

// ── Tier 3: tile() (stateless) ─────────────────────────────────────
const statelessConnectors = {
  us_counties_local: new LocalConnector(),
  us_counties_http:  new HttpConnector(),
  us_counties_s3:    createMockS3Connector(),
};

// ── HTTP server ────────────────────────────────────────────────────
const VALID_DATASETS = new Set(Object.keys(SOURCES));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');

  // --- Static: serve index.html ---
  if (url.pathname === '/') {
    try {
      const html = await readFile(new URL('./index.html', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('Failed to read index.html');
    }
    return;
  }

  // --- Static FGB: support HTTP Range Requests for HttpConnector ---
  if (url.pathname === '/data/us_counties.fgb') {
    try {
      const filePath = new URL(FGB_FILE, import.meta.url);
      const { size } = await stat(filePath);
      const range = req.headers.range;

      if (range) {
        const match = range.match(/bytes=(\d+)-(\d*)/);
        if (!match) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }

        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : size - 1;
        const len = end - start + 1;

        const fh = await open(filePath);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        await fh.close();

        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': len,
          'Accept-Ranges': 'bytes',
        });
        res.end(buf);
      } else {
        // Full file (shouldn't happen with our connector, but handle it)
        const data = await readFile(filePath);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
          'Accept-Ranges': 'bytes',
        });
        res.end(data);
      }
    } catch (err) {
      console.error('FGB static error:', err);
      res.writeHead(500);
      res.end('Failed to read FGB file');
    }
    return;
  }

  // --- TileJSON ---
  if (url.pathname === '/tilejson.json') {
    try {
      const tj = await tileServers.us_counties_local.tileJSON();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tj));
    } catch (err) {
      console.error('TileJSON error:', err);
      res.writeHead(500);
      res.end('TileJSON generation failed');
    }
    return;
  }

  // --- Tile endpoints: /tiles/{dataset}/{tier}/{z}/{x}/{y}.pbf ---
  const tileMatch = url.pathname.match(
    /^\/tiles\/([a-z0-9_]+)\/(server|client|fn)\/(\d+)\/(\d+)\/(\d+)\.pbf$/,
  );
  if (tileMatch) {
    const [, dataset, tier, zStr, xStr, yStr] = tileMatch;
    if (!VALID_DATASETS.has(dataset)) {
      res.writeHead(404);
      res.end('Unknown dataset');
      return;
    }
    const z = Number(zStr), x = Number(xStr), y = Number(yStr);
    try {
      let pbf;
      switch (tier) {
        case 'server':
          pbf = await tileServers[dataset].tile(z, x, y);
          break;
        case 'client':
          pbf = await tileClients[dataset].tile(z, x, y, SOURCES[dataset]);
          break;
        case 'fn':
          pbf = await tile(statelessConnectors[dataset], z, x, y, SOURCES[dataset]);
          break;
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-protobuf',
        'Content-Encoding': 'identity',
      });
      res.end(pbf);
    } catch (err) {
      console.error(`Tile [${dataset}/${tier}] ${z}/${x}/${y} error:`, err);
      res.writeHead(500);
      res.end('Tile generation failed');
    }
    return;
  }

  // --- 404 ---
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Tile server running at http://localhost:${PORT}`);
  console.log('  /tiles/{dataset}/{tier}/{z}/{x}/{y}.pbf');
  console.log(`  datasets: ${[...VALID_DATASETS].join(', ')}`);
  console.log('  tiers:    server, client, fn');
});

// ── Graceful shutdown ──────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\nShutting down…');
  server.close();
  await Promise.all([
    ...Object.values(tileServers).map(s => s.close()),
    ...Object.values(tileClients).map(c => c.close()),
    ...Object.values(statelessConnectors).map(c => c.close()),
  ]);
  process.exit(0);
});
