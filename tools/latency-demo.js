#!/usr/bin/env node
/**
 * What 30 ms actually feels like.
 *
 * Every query below is the same two dependent round trips. The point of the
 * table is the last two columns: what this design costs, versus what the same
 * bytes would cost if each range were fetched one after another — which is what
 * a pointer-chasing format (B-tree descent, dictionary-then-postings, leapfrog
 * `advance()`) does on object storage.
 */
import { Reader } from '../src/read/reader.js';
import { LatencyTransport } from '../src/transport/latency.js';

const path = new URL('../data/messages.l0', import.meta.url).pathname;
const LAT = Number(process.argv[2] ?? 30);
const BW = 100;

const reader = await new Reader(new LatencyTransport(path, { latencyMs: LAT, bandwidthMBs: BW })).open();

const queries = {
  'match_all': { match_all: {} },
  'term isRead=true': { term: { isRead: true } },
  'range createdAt (1 month)': { range: { createdAt: { gte: Date.UTC(2026, 5, 1), lt: Date.UTC(2026, 6, 1) } } },
  'range retryCount >= 3': { range: { retryCount: { gte: 3 } } },
  'term sender=Aatu': { term: { sender: 'Aatu' } },
  'wildcard subject *lasku*': { wildcard: { subject: '*lasku*' } },
  'A+B+C combined': {
    bool: {
      filter: [{ term: { isDelivered: true } }, { range: { retryCount: { lte: 2 } } },
               { wildcard: { subject: '*maksusta*' } }],
      must_not: [{ term: { sender: 'Testaaja' } }],
    } },
};

console.log(`\nsimulating ${LAT} ms latency, ${BW} MB/s bandwidth\n`);
console.log('query                          hits  rounds reads   bytes   actual   if serial');
console.log('─'.repeat(82));
let totalActual = 0, totalSerial = 0;
for (const [label, query] of Object.entries(queries)) {
  reader.resetStats();
  const t0 = Date.now();
  const res = await reader.search({ query, size: 25 });
  const wall = Date.now() - t0;
  const s = reader.stats;
  const serial = s.reads * LAT + s.bytes / (BW * 1024 * 1024) * 1000;
  totalActual += wall; totalSerial += serial;
  console.log(
    `${label.padEnd(30)} ${String(res.hits.total.value).padStart(5)} ` +
    `${String(s.rounds).padStart(6)} ${String(s.reads).padStart(6)} ${String(s.bytes).padStart(7)} ` +
    `${(wall + ' ms').padStart(8)} ${(serial.toFixed(0) + ' ms').padStart(10)}`);
}
console.log('─'.repeat(82));
console.log(`${'TOTAL'.padEnd(30)} ${''.padStart(5)} ${''.padStart(6)} ${''.padStart(6)} ${''.padStart(7)} ` +
            `${(totalActual + ' ms').padStart(8)} ${(totalSerial.toFixed(0) + ' ms').padStart(10)}`);
console.log(`\n→ ${(totalSerial / totalActual).toFixed(1)}x slower if the same ranges were fetched serially.\n`);

// Pagination under latency: the deep-page claim of §14.4, felt.
console.log('cursor pagination, 25 per page (clustering order):');
const q = { bool: { filter: [{ term: { isDelivered: true } }] } };
let cursor, page = 0;
for (;;) {
  reader.resetStats();
  const t0 = Date.now();
  const r = await reader.search({ query: q, size: 25, ...(cursor ? { search_after: cursor } : {}) });
  const wall = Date.now() - t0;
  if (r.hits.hits.length === 0) break;
  page++;
  if (page <= 3 || page % 15 === 0) {
    console.log(`  page ${String(page).padStart(2)}  ${wall} ms  rounds=${reader.stats.rounds}  bytes=${reader.stats.bytes}`);
  }
  cursor = r.hits.hits.at(-1).sort;
}
console.log(`  …${page} pages total, flat cost per page\n`);
await reader.close();
