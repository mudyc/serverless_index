import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build/builder.js';
import { Reader } from '../src/read/reader.js';
import { LatencyTransport } from '../src/transport/latency.js';
import { generate } from '../tools/gen-data.js';

const LAT = 5;                       // keep the suite quick; the shape is what matters
let dir, path;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'l0lat-'));
  path = join(dir, 'm.l0');
  await build({ docs: generate({ count: 1500, seed: 42 }), index: 'messages', outPath: path });
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

async function timed(query, size = 25) {
  const reader = await new Reader(new LatencyTransport(path, { latencyMs: LAT, bandwidthMBs: 100 })).open();
  reader.clearCache();
  reader.resetStats();
  const t0 = Date.now();
  const res = await reader.search({ query, size });
  const wall = Date.now() - t0;
  const s = { ...reader.stats };
  await reader.close();
  return { res, wall, s };
}

test('wall-clock tracks ROUNDS, not reads', async () => {
  const simple = await timed({ term: { isRead: true } });                    // 2 reads
  const complex = await timed({
    bool: {
      filter: [{ term: { isDelivered: true } }, { range: { retryCount: { lte: 2 } } },
               { wildcard: { subject: '*maksusta*' } }],
      must_not: [{ term: { sender: 'Testaaja' } }],
    } });                                                                     // many reads

  assert.equal(simple.s.rounds, 2);
  assert.equal(complex.s.rounds, 2);
  assert.ok(complex.s.reads > simple.s.reads + 5, 'complex query issues many more ranges');

  // The whole claim: many more ranges, essentially the same latency cost.
  const perRound = LAT;
  assert.ok(complex.s.simulatedMs < simple.s.simulatedMs + perRound,
    `complex ${complex.s.simulatedMs.toFixed(1)}ms vs simple ${simple.s.simulatedMs.toFixed(1)}ms`);
});

test('serial execution of the same ranges would cost far more', async () => {
  const { s } = await timed({
    bool: {
      filter: [{ term: { isDelivered: true } }, { range: { retryCount: { lte: 2 } } },
               { wildcard: { subject: '*maksusta*' } }],
      must_not: [{ term: { sender: 'Testaaja' } }],
    } });
  const serialMs = s.reads * LAT;
  assert.ok(serialMs > s.simulatedMs * 2,
    `serial ${serialMs}ms vs waved ${s.simulatedMs.toFixed(1)}ms`);
});

test('deep pages cost the same as the first page under latency', async () => {
  const reader = await new Reader(new LatencyTransport(path, { latencyMs: LAT })).open();
  const q = { bool: { filter: [{ term: { isDelivered: true } }] } };
  const cost = [];
  let cursor;
  for (let i = 0; i < 12; i++) {
    reader.clearCache();
    reader.resetStats();
    const r = await reader.search({ query: q, size: 25, ...(cursor ? { search_after: cursor } : {}) });
    if (r.hits.hits.length === 0) break;
    cost.push(reader.stats.simulatedMs);
    cursor = r.hits.hits.at(-1).sort;
  }
  await reader.close();
  assert.ok(cost.length >= 10);
  const first = cost[0], last = cost.at(-1);
  assert.ok(last < first * 1.6, `page 1 ${first.toFixed(1)}ms vs page ${cost.length} ${last.toFixed(1)}ms`);
});

test('over-fetching is cheap relative to a round trip (§13.2)', async () => {
  // 30 ms at 100 MB/s is worth ~3 MB of transfer; our whole artifact is smaller.
  const { s } = await timed({ wildcard: { subject: '*lasku*' } });
  const transferMs = s.bytes / (100 * 1024 * 1024) * 1000;
  assert.ok(transferMs < LAT, `transfer ${transferMs.toFixed(2)}ms vs one round ${LAT}ms`);
});
