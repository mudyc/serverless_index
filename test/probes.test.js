import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build/builder.js';
import { Reader } from '../src/read/reader.js';
import { generate } from '../tools/gen-data.js';

let dir, reader;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'l0p-'));
  const path = join(dir, 'm.l0');
  await build({ docs: generate({ count: 1500, seed: 42 }), index: 'messages', outPath: path });
  reader = await new Reader(path).open();
});
after(async () => { await reader.close(); await rm(dir, { recursive: true, force: true }); });

async function probe(body) {
  reader.clearCache();          // these tests assert the COLD contract
  reader.resetStats();
  const res = await reader.search(body);
  return { res, stats: { ...reader.stats } };
}

/**
 * The contract of the research notes §10.6 / §14.7: a warm query is TWO
 * dependent round trips — one wave for the index, one for the page — regardless
 * of how many predicates it carries.
 */
test('a warm query costs exactly 2 rounds', async () => {
  const { stats } = await probe({ query: { term: { isRead: true } }, size: 10 });
  assert.equal(stats.rounds, 2, 'rounds');
});

test('probe depth does not grow with predicate count', async () => {
  const one = await probe({ query: { term: { isRead: true } }, size: 10 });
  const many = await probe({
    query: {
      bool: {
        filter: [
          { term: { isDelivered: true } }, { term: { isRead: false } },
          { term: { hasAttachment: true } }, { exists: { field: 'isSecure' } },
        ],
        must_not: [{ term: { isTest: true } }, { term: { isBounced: true } }],
      },
    }, size: 10,
  });
  assert.equal(one.stats.rounds, 2);
  assert.equal(many.stats.rounds, 2, 'still 2 rounds with 6 predicates');
  assert.ok(many.stats.reads > one.stats.reads, 'but more independent reads in the wave');
});

test('size:0 skips phase 2 entirely', async () => {
  const { stats, res } = await probe({ query: { term: { isRead: true } }, size: 0 });
  assert.equal(stats.rounds, 1, 'index wave only');
  assert.ok(res.hits.total.value > 0);
});

test('match_all needs no index wave', async () => {
  const { stats } = await probe({ query: { match_all: {} }, size: 10 });
  assert.equal(stats.rounds, 1, 'data wave only — no section to fetch');
});

test('the catalog is phase 0 and is not re-read per query', async () => {
  reader.clearCache();
  reader.resetStats();
  await reader.search({ query: { term: { isRead: true } }, size: 5 });
  const first = { ...reader.stats };
  reader.clearCache();
  reader.resetStats();
  await reader.search({ query: { term: { isDelivered: true } }, size: 5 });
  assert.deepEqual({ ...reader.stats }.rounds, first.rounds, 'no extra round for catalog');
});

test('deep pagination costs the same as the first page (clustering order)', async () => {
  const shallow = await probe({ query: { match_all: {} }, size: 50 });
  let cursor = shallow.res.hits.hits.at(-1).sort;
  reader.clearCache();
  for (let i = 0; i < 20; i++) {
    const r = await reader.search({ query: { match_all: {} }, size: 50, search_after: cursor });
    if (r.hits.hits.length === 0) break;
    cursor = r.hits.hits.at(-1).sort;
  }
  const deep = await probe({ query: { match_all: {} }, size: 50, search_after: cursor });
  assert.equal(deep.stats.rounds, shallow.stats.rounds, 'same round count');
  assert.ok(deep.stats.bytes <= shallow.stats.bytes * 1.5,
    `deep page bytes ${deep.stats.bytes} vs shallow ${shallow.stats.bytes}`);
});

test('the index is cheap; the data page dominates', async () => {
  const q = { term: { isRead: true } };
  const idx = await probe({ query: q, size: 0 });      // phase 1 only
  const full = await probe({ query: q, size: 10 });    // phase 1 + 2
  const dataBytes = full.stats.bytes - idx.stats.bytes;
  assert.ok(idx.stats.bytes <= 256, `index wave moved ${idx.stats.bytes} B`);
  assert.ok(dataBytes > idx.stats.bytes * 10, 'stored fields dominate, as expected');
});

/**
 * Read amplification (§13.5), reported rather than asserted away. A 128-doc
 * block is fetched whole to serve a 10-doc page, so amplification is ~13x here.
 * This is the number that block sizing (§13.8) exists to tune, and it belongs
 * in the evaluation set as a first-class metric.
 */
test('read amplification is measured and bounded by block size', async () => {
  const q = { term: { isRead: true } };
  const { res, stats } = await probe({ query: q, size: 10 });
  const useful = res.hits.hits.reduce((n, h) => n + Buffer.byteLength(JSON.stringify(h._source)), 0);
  const amplification = stats.bytes / useful;
  console.log(`      read amplification: ${amplification.toFixed(1)}x ` +
              `(${stats.bytes} B fetched / ${useful} B used, blockSize=128)`);
  assert.ok(amplification < 25, `amplification ${amplification.toFixed(1)}x`);

  // A page as large as a block amortises it away.
  const big = await probe({ query: q, size: 128 });
  const usefulBig = big.res.hits.hits.reduce((n, h) => n + Buffer.byteLength(JSON.stringify(h._source)), 0);
  const ampBig = big.stats.bytes / usefulBig;
  console.log(`      at size=128: ${ampBig.toFixed(1)}x`);
  assert.ok(ampBig < amplification, 'larger pages amortise block over-fetch');
});
