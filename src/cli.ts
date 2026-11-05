#!/usr/bin/env node
/**
 * @module cli
 *
 * `fgb-vt` command line tool.
 *
 * ```sh
 * npx @geozelot/fgb-vt check data/buildings.fgb https://cdn.example.com/roads.fgb
 * ```
 */

import { checkFile, type CheckReport } from './check.js';
import { LocalConnector } from './connectors/local.js';
import { HttpConnector } from './connectors/http.js';
import { S3Connector } from './connectors/s3.js';
import type { Connector } from './connectors/connector.js';

const USAGE = `Usage: fgb-vt check [options] <file|url|s3://bucket/key>...

Verify FlatGeobuf files completely: header, every spatial index node, and
every feature (offsets and boxes against the index). Exits with 1 if any
file has errors.

Options:
  --quick           check the header and the spatial index only
  --max-bytes <n>   read at most n bytes of features per file
  --json            print the reports as JSON
  -h, --help        show this help
`;

interface Args {
  paths: string[];
  quick: boolean;
  json: boolean;
  maxBytes: number;
}

function parseArgs(argv: string[]): Args | string {
  const [command, ...rest] = argv;
  if (command === '-h' || command === '--help' || command === undefined) return USAGE;
  if (command !== 'check') return `Unknown command: ${command}\n\n${USAGE}`;
  const args: Args = { paths: [], quick: false, json: false, maxBytes: Infinity };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '-h' || arg === '--help') return USAGE;
    else if (arg === '--quick') args.quick = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--max-bytes') {
      const n = Number(rest[++i]);
      if (!(n > 0)) return `--max-bytes needs a positive number\n\n${USAGE}`;
      args.maxBytes = n;
    } else if (arg.startsWith('-')) return `Unknown option: ${arg}\n\n${USAGE}`;
    else args.paths.push(arg);
  }
  if (args.paths.length === 0) return `No file given\n\n${USAGE}`;
  return args;
}

/** The connector for a path: HTTP(S) URLs, S3 URIs, or local files. */
function connectorFor(path: string, connectors: Map<string, Connector>): Connector {
  const kind = /^https?:\/\//i.test(path) ? 'http' : path.startsWith('s3://') ? 's3' : 'local';
  let connector = connectors.get(kind);
  if (!connector) {
    connector = kind === 'http' ? new HttpConnector() : kind === 's3' ? new S3Connector() : new LocalConnector();
    connectors.set(kind, connector);
  }
  return connector;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

function formatReport(r: CheckReport): string {
  const lines = [`${r.path}  ${r.ok ? 'OK' : 'ERRORS'}`];
  const h = r.header;
  if (h) {
    const parts = [`FlatGeobuf ${r.version}`];
    if (r.size !== null) parts.push(formatBytes(r.size));
    parts.push(h.geometryType, `${h.featuresCount || 'unknown number of'} features`, plural(h.columns.length, 'column'));
    lines.push(`  ${parts.join(', ')}`);
    const support = h.crsSupport === 'needs-projection' ? 'needs a projection' : h.crsSupport === 'lonlat' ? 'longitude/latitude' : 'Web Mercator';
    lines.push(`  CRS: ${h.crs ?? 'none (longitude/latitude assumed)'} (${support})${h.idColumn ? `, feature ids from "${h.idColumn}"` : ''}`);
  }
  if (r.index) {
    const overlap = r.index.overlap !== null ? `, node overlap ${r.index.overlap.toFixed(2)}` : '';
    lines.push(`  Index: node size ${r.index.nodeSize}, ${r.index.levels} levels, ${formatBytes(r.index.bytes)}${overlap}`);
  } else if (h) {
    lines.push('  Index: none');
  }
  if (r.features) {
    const f = r.features;
    lines.push(`  Features: ${f.checked} checked (${formatBytes(f.bytes)})${f.complete ? '' : ', not all'}` +
      `${f.withoutGeometry ? `, ${f.withoutGeometry} without geometry` : ''}`);
  }
  for (const p of r.problems) {
    lines.push(`  ${p.severity}: ${p.message}${p.offset !== undefined ? ` (byte ${p.offset})` : ''}`);
  }
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    const help = args === USAGE;
    (help ? process.stdout : process.stderr).write(args);
    return help ? 0 : 2;
  }

  const connectors = new Map<string, Connector>();
  const reports: CheckReport[] = [];
  let failed = false;
  try {
    for (const path of args.paths) {
      try {
        const report = await checkFile(connectorFor(path, connectors), path, { quick: args.quick, maxBytes: args.maxBytes });
        reports.push(report);
        if (!report.ok) failed = true;
        if (!args.json) process.stdout.write(`${formatReport(report)}\n\n`);
      } catch (err) {
        failed = true;
        process.stderr.write(`${path}: ${(err as Error).message}\n\n`);
      }
    }
  } finally {
    await Promise.all([...connectors.values()].map(c => c.close()));
  }
  if (args.json) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 2;
  },
);
