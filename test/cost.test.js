import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build/builder.js';
import { Reader } from '../src/read/reader.js';
import { FileTransport } from '../src/transport/file.js';
import { Budget, BudgetExceeded, coalesce, estimate, HOSTS } from '../src/cost.js';

const dir = mkdtempSync(join(tmpdir(), 'l0cost-'));
const out = join(dir, 'cost.l0');

const N = 4000;
const docs = Array.from({ length: N }, (_, i) => ({
  id: String(i),
  ts: 20200101 + i,
  // 4000 distinct values: one bitmap section each, i.e. the shape that makes a
  // terms aggregation ask for thousands of ranges.
  sarja: `s${i}`,
  luokka: ['a', 'b', 'c'][i % 3],
}));

test('coalescing is what makes the bill affordable', () => {
  // 1 kB every 8 kB: contiguous enough that a 64 kB gap swallows the lot.
  const ranges = Array.from({ length: 10000 }, (_, i) => ({ offset: i * 8192, length: 1024 }));
  assert.equal(coalesce(ranges, 0).requests, 10000);
  assert.equal(coalesce(ranges, 65536).requests, 1);
  // ...and that is the seven-orders-of-magnitude swing, in money.
  const raw = estimate(coalesce(ranges, 0), 's3').usd;
  const merged = estimate(coalesce(ranges, 65536), 's3').usd;
  assert.ok(raw / merged > 1000, `expected a >1000x swing, got ${raw / merged}`);
  // A gap wider than the holes merges; narrower does not.
  assert.equal(coalesce(ranges, 4096).requests, 10000);
});

test('a budget refuses the query before a single byte is fetched', async () => {
  await build({ docs, index: 'cost', clusteringField: 'ts', blockSize: 256,
                granule: 64, outPath: out, keywordMaxCardinality: 10000 });

  const t = new FileTransport(out);
  let waves = 0;
  const realWave = t.readWave.bind(t);
  t.readWave = (p) => { waves++; return realWave(p); };
  // No coalescing: every planned range is its own request, the expensive shape.
  t.coalesceGap = 0;

  const r = new Reader(t, { budget: { requests: 50, host: 's3' } });
  await r.open();
  waves = 0;

  await assert.rejects(
    () => r.search({ size: 0, aggs: { s: { terms: { field: 'sarja', size: 4000 } } } }),
    (e) => {
      assert.ok(e instanceof BudgetExceeded, `expected BudgetExceeded, got ${e.name}`);
      assert.match(e.message, /query refused/);
      assert.match(e.message, /sarja/, 'the refusal names the field responsible');
      assert.ok(e.detail.blame[0][0].includes('sarja'));
      return true;
    });
  assert.equal(waves, 0, 'refused before any I/O');
  await t.close?.();
});

test('the same query is allowed once the transport coalesces', async () => {
  const t = new FileTransport(out);
  t.coalesceGap = 65536;
  const r = new Reader(t, { budget: { requests: 50, host: 's3' } });
  await r.open();
  const res = await r.search({ size: 0, aggs: { s: { terms: { field: 'sarja', size: 4000 } } } });
  assert.equal(res.aggregations.s.buckets.length, 4000);
  assert.ok(r.budget.spent.requests <= 50, `spent ${r.budget.spent.requests}`);
  assert.ok(r.budget.spent.usd < 0.0001);
  await t.close?.();
});

test('warn mode reports instead of refusing', async () => {
  const seen = [];
  const t = new FileTransport(out);
  t.coalesceGap = 0;
  const r = new Reader(t, { budget: new Budget({ requests: 10, mode: 'warn',
                                                 onReport: (e) => e && seen.push(e) }) });
  await r.open();
  const res = await r.search({ size: 0, aggs: { s: { terms: { field: 'sarja', size: 4000 } } } });
  assert.equal(res.aggregations.s.buckets.length, 4000);
  assert.ok(seen.length > 0, 'warn mode still reports');
  await t.close?.();
});

test('an ordinary query stays far under any sane budget', async () => {
  const t = new FileTransport(out);
  const r = new Reader(t, { budget: { requests: 64, bytes: 8e6, rounds: 8, host: 's3' } });
  await r.open();
  const res = await r.search({ query: { term: { luokka: 'a' } }, size: 10 });
  assert.equal(res.hits.hits.length, 10);
  assert.ok(r.budget.spent.rounds <= 8);
  await t.close?.();
});

test('price table covers the hosts the examples run on', () => {
  for (const k of ['s3', 's3-internet', 'cloudfront', 'pages', 'local']) assert.ok(HOSTS[k]);
  assert.equal(estimate({ requests: 1000, bytes: 0 }, 's3').usd.toFixed(5), '0.00040');
  // GitHub Pages bills no request, but the monthly quota is the real limit.
  const p = estimate({ requests: 9, bytes: 114e6 }, 'pages');
  assert.equal(p.usd, 0);
  assert.ok(p.viewsPerMonth > 800 && p.viewsPerMonth < 900, `${p.viewsPerMonth} views/month`);
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// --- the coalescing policy -------------------------------------------------
import { planGroups } from '../src/transport/coalesce.js';

const count = (g, n) => (g ? g.length : n);

test('merging touching ranges is free, so it always happens', () => {
  const r = [{ offset: 0, length: 100 }, { offset: 100, length: 100 },
             { offset: 200, length: 100 }];
  const g = planGroups(r, { gap: 65536, maxParallel: 24 });
  assert.equal(g.length, 1);
  assert.equal(g[0].end - g[0].start, 300, 'no gap, so no over-fetch');
});

test('below the parallel budget, scattered ranges are left alone', () => {
  // 21 ranges 64 kB apart: a naive 64 kB merge collapses them to 1 and pulls
  // 8x the bytes, for no round trip saved — they already fit one wave.
  const r = Array.from({ length: 21 }, (_, i) => ({ offset: i * 64 * 1024, length: 8192 }));
  const g = planGroups(r, { gap: 65536, maxParallel: 24 });
  assert.equal(count(g, r.length), 21, 'left alone');
  const bytes = (g ?? r).reduce((a, x) => a + (x.end !== undefined ? x.end - x.start : x.length), 0);
  assert.equal(bytes, 21 * 8192, 'no over-fetch');
});

test('above the parallel budget, the gap widens until the count fits', () => {
  const r = Array.from({ length: 5000 }, (_, i) => ({ offset: i * 4096, length: 64 }));
  const g = planGroups(r, { gap: 65536, maxParallel: 24 });
  assert.ok(g.length <= 24, `expected <= 24 requests, got ${g.length}`);
  assert.ok(g.length >= 1);
});

test('widening stops before buying the whole artifact', () => {
  // Ranges 100 MB apart: merging them would pull 1 GB to save 9 requests.
  const r = Array.from({ length: 10 }, (_, i) => ({ offset: i * 100e6, length: 1024 }));
  const g = planGroups(r, { gap: 65536, maxParallel: 1, maxFetchBytes: 64 * 1024 * 1024 });
  const bytes = (g ?? r).reduce((a, x) => a + (x.end !== undefined ? x.end - x.start : x.length), 0);
  assert.ok(bytes < 64 * 1024 * 1024, `pulled ${bytes} bytes`);
  // It cannot satisfy maxParallel=1 without overspending, so it hands the
  // problem to the budget rather than solving it by buying the file.
  assert.ok(count(g, r.length) > 1);
});

test('coalesce() reports the over-fetch merging causes', () => {
  const r = [{ offset: 0, length: 100 }, { offset: 10000, length: 100 }];
  assert.equal(coalesce(r, 0).overFetch, 1);
  const m = coalesce(r, 65536);
  assert.equal(m.requests, 1);
  assert.equal(m.bytes, 10100, 'the gap is fetched too');
  assert.equal(m.bytesRaw, 200);
  assert.equal(m.overFetch, 50.5);
});

test('the document-fetch phase is billed too', async () => {
  // Phase 2 reads stored blocks and on a wide page is the larger half of the
  // bill. It used to call the transport directly and escape the guard entirely.
  const t = new FileTransport(out);
  let waves = 0;
  const real = t.readWave.bind(t);
  t.readWave = (p) => { waves++; return real(p); };
  const r = new Reader(t, { budget: { bytes: 1e9, host: 's3' } });
  await r.open();
  // Warm the bitmap so phase 1 is free; whatever trips the guard now is phase 2.
  await r.search({ query: { term: { luokka: 'a' } }, size: 0 });
  r.budget.limit.bytes = 20_000;
  r.budget.reset();
  waves = 0;
  await assert.rejects(
    () => r.search({ query: { term: { luokka: 'a' } }, size: 2000 }),
    (e) => {
      assert.ok(e instanceof BudgetExceeded);
      assert.match(e.message, /stored:blocks/, 'names the stored phase');
      return true;
    });
  assert.ok(waves <= 1, `stopped at the stored wave, issued ${waves}`);
  await t.close?.();
});

test('a cached section costs nothing the second time', async () => {
  // Sections of an immutable artifact can never be stale, which is what makes
  // repeat facet queries free — and the budget must agree.
  const t = new FileTransport(out);
  const r = new Reader(t, { budget: { requests: 1e6, host: 's3' } });
  await r.open();
  const body = { size: 0, aggs: { l: { terms: { field: 'luokka', size: 10 } } } };
  await r.search(body);
  const first = { ...r.budget.spent };
  r.budget.reset();
  await r.search(body);
  assert.equal(r.budget.spent.requests, 0, 'second run touches the network not at all');
  assert.ok(first.requests > 0);
  await t.close?.();
});
