#!/usr/bin/env node
/**
 * Measure every query shape the library supports: the ranges it plans, the
 * requests those become with and without coalescing, and the money either way.
 * The numbers in docs/queries.md and docs/billing.md come from this script.
 *
 *   node tools/cost-report.js [--docs 200000] [--host s3] [--md]
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build/builder.js';
import { Reader } from '../src/read/reader.js';
import { FileTransport } from '../src/transport/file.js';
import { estimate, coalesce } from '../src/cost.js';
import { planGroups } from '../src/transport/coalesce.js';

const arg = (f, d) => { const i = process.argv.indexOf(f); return i < 0 ? d : process.argv[i + 1]; };
const N = Number(arg('--docs', 200000));
const HOST = arg('--host', 's3');
const MD = process.argv.includes('--md');

const dir = mkdtempSync(join(tmpdir(), 'l0report-'));
const out = join(dir, 'report.l0');

const KUNTA = Array.from({ length: 309 }, (_, i) => `k${String(i).padStart(3, '0')}`);
const MERKKI = Array.from({ length: 180 }, (_, i) => `merkki-${i}`);
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const docs = Array.from({ length: N }, (_, i) => ({
  id: String(i),
  // a real date, so a range predicate selects a real slice: 1990-01-01 onwards
  ts: (() => { const d = new Date(Date.UTC(1990, 0, 1) + i * 5400e3);
               return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); })(),
  kunta: KUNTA[(i * 7919) % KUNTA.length],
  merkki: MERKKI[(i * 104729) % MERKKI.length],
  // deliberately high cardinality: this is the field that blows a budget
  malli: `malli-${i % 50000}`,
  teho: Math.floor(rnd() * 400),
  sahko: i % 11 === 0,
  nimi: `${MERKKI[(i * 104729) % MERKKI.length]} ${['sedan','farmari','viistoperä','maasturi'][i % 4]} ${i % 997}`,
}));

process.stderr.write(`building ${N} docs...\n`);
const t0 = Date.now();
const { catalog } = await build({ docs, index: 'report', clusteringField: 'ts',
  outPath: out, keywordMaxCardinality: 60000 });
const size = statSync(out).size;
process.stderr.write(`built in ${Date.now() - t0} ms, ${(size / 1e6).toFixed(1)} MB, ` +
  `${Object.keys(catalog.sections).length} sections\n\n`);

const CASES = [
  ['term on a low-cardinality keyword',
   { query: { term: { kunta: 'k042' } }, size: 10 }],
  ['term on a boolean',
   { query: { term: { sahko: true } }, size: 10 }],
  ['terms, 20 values (OR of 20 bitmaps)',
   { query: { terms: { merkki: MERKKI.slice(0, 20) } }, size: 10 }],
  ['range on the clustering key',
   { query: { range: { ts: { gte: 20100101, lt: 20110101 } } }, size: 10 }],
  ['range on a non-clustering numeric',
   { query: { range: { teho: { gte: 200 } } }, size: 10 }],
  ['bool: must + filter + must_not',
   { query: { bool: { must: [{ term: { kunta: 'k042' } }],
                      filter: [{ range: { teho: { gte: 100 } } }],
                      must_not: [{ term: { sahko: true } }] } }, size: 10 }],
  ['prefix on a keyword (catalog-side expansion)',
   { query: { prefix: { merkki: 'merkki-1' } }, size: 10 }],
  ['wildcard on text (trigram postings)',
   { query: { wildcard: { nimi: '*maasturi*' } }, size: 10 }],
  ['exists',
   { query: { exists: { field: 'merkki' } }, size: 10 }],
  ['sort by a non-clustering column',
   { query: { match_all: {} }, sort: [{ teho: 'desc' }], size: 20 }],
  ['terms agg, 180 buckets',
   { size: 0, aggs: { m: { terms: { field: 'merkki', size: 200 } } }}],
  ['histogram on the clustering key + terms sub-agg',
   { size: 0, aggs: { h: { histogram: { field: 'ts', interval: 'year',
                           aggs: { m: { terms: { field: 'merkki', size: 200 } } } } } } }],
  ['terms agg over 50 000 distinct values  <-- the expensive shape',
   { size: 0, aggs: { m: { terms: { field: 'malli', size: 50000 } } }}],
  ['numeric stats sub-agg (whole column)',
   { size: 0, aggs: { k: { terms: { field: 'kunta', size: 400 },
                           aggs: { t: { avg: { field: 'teho' } } } } } }],
  ['page 50 documents (stored blocks)',
   { query: { term: { kunta: 'k042' } }, size: 50 }],
];

const rows = [];
for (const [label, body] of CASES) {
  const t = new FileTransport(out);
  const waves = [];
  const real = t.readWave.bind(t);
  t.readWave = (p) => { waves.push(p.map(x => ({ ...x }))); return real(p); };
  const r = new Reader(t, { chunkSize: 0 });     // no chunk splitting: count logical ranges
  await r.open();
  waves.length = 0;
  const t1 = performance.now();
  const res = await r.search(body);
  const ms = performance.now() - t1;
  const all = waves.flat();
  const raw = coalesce(all, 0);
  // What the library actually issues: merge only to get under the parallel budget.
  const groups = planGroups(all, { gap: 65536, maxParallel: 24 });
  const req = (groups ?? all).map(g => g.members
    ? { offset: g.start, length: g.end - g.start } : g);
  const merged = { requests: req.length,
                   bytes: req.reduce((a, r) => a + r.length, 0),
                   overFetch: req.reduce((a, r) => a + r.length, 0) / Math.max(1, raw.bytes) };
  rows.push({ label, rounds: waves.length, ranges: all.length,
              reqRaw: raw.requests, reqMerged: merged.requests,
              bytes: merged.bytes, bytesRaw: raw.bytes, overFetch: merged.overFetch,
              usdRaw: estimate(raw, HOST).usd, usdMerged: estimate(merged, HOST).usd,
              hits: res.hits.total.value, ms });
  if (process.env.VERBOSE) process.stderr.write(`  ${label}: ${res.hits.total.value} hits\n`);
  await t.close?.();
}

const f = (n) => n.toLocaleString('en');
const usd = (n) => n === 0 ? '0' : n < 1e-4 ? n.toExponential(1) : `$${n.toFixed(5)}`;
if (MD) {
  console.log(`| query shape | hits | rounds | ranges | GETs naive | GETs policy | bytes raw | bytes merged | over-fetch | $ raw | $ merged |`);
  console.log(`|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|`);
  for (const r of rows) console.log(
    `| ${r.label} | ${f(r.hits)} | ${r.rounds} | ${f(r.ranges)} | ${f(r.reqRaw)} | ${f(r.reqMerged)} | ` +
    `${(r.bytesRaw / 1e6).toFixed(2)} MB | ${(r.bytes / 1e6).toFixed(2)} MB | ${r.overFetch.toFixed(2)}x | ` +
    `${usd(r.usdRaw)} | ${usd(r.usdMerged)} |`);
} else {
  const w = Math.max(...rows.map(r => r.label.length));
  console.log('query shape'.padEnd(w) + '    hits  rounds   ranges   GETs/raw  GETs/lib   bytes/raw  bytes/lib  over     $ raw   $ merged');
  for (const r of rows) console.log(
    r.label.padEnd(w) + f(r.hits).padStart(8) + String(r.rounds).padStart(8) + f(r.ranges).padStart(9) +
    f(r.reqRaw).padStart(11) + f(r.reqMerged).padStart(10) +
    `${(r.bytesRaw / 1e6).toFixed(2)} MB`.padStart(12) + `${(r.bytes / 1e6).toFixed(2)} MB`.padStart(11) +
    `${r.overFetch.toFixed(2)}x`.padStart(6) + usd(r.usdRaw).padStart(10) + usd(r.usdMerged).padStart(11));
}
rmSync(dir, { recursive: true, force: true });
