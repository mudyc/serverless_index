import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build/builder.js';
import { L0Client } from '../src/client.js';
import { generate } from '../tools/gen-data.js';
import { refSearch } from './reference.js';

let dir, client, docs;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'l0pg-'));
  const path = join(dir, 'm.l0');
  docs = generate({ count: 1500, seed: 42 });
  await build({ docs, index: 'messages', outPath: path });
  client = new L0Client({ artifacts: { messages: path } });
});
after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });

const Q = { bool: { filter: [{ term: { isDelivered: true } }] } };

test('from/size walks the result set in clustering order', async () => {
  const expected = refSearch(docs, Q).map(d => d.id);
  const collected = [];
  for (let from = 0; from < expected.length; from += 37) {
    const r = await client.search({ index: 'messages', body: { query: Q, from, size: 37 } });
    collected.push(...r.hits.hits.map(h => h._id));
  }
  assert.deepEqual(collected, expected);
});

test('search_after covers the set with no duplicates and no gaps', async () => {
  const expected = refSearch(docs, Q).map(d => d.id);
  const collected = [];
  let cursor;
  for (;;) {
    const body = { query: Q, size: 40, ...(cursor ? { search_after: cursor } : {}) };
    const r = await client.search({ index: 'messages', body });
    if (r.hits.hits.length === 0) break;
    collected.push(...r.hits.hits.map(h => h._id));
    cursor = r.hits.hits.at(-1).sort;
  }
  assert.deepEqual(collected, expected);
  assert.equal(new Set(collected).size, collected.length, 'no duplicates');
});

test('descending order is the exact reverse', async () => {
  const expected = refSearch(docs, Q).map(d => d.id).reverse();
  const r = await client.search({
    index: 'messages',
    body: { query: Q, size: 10000, sort: [{ createdAt: 'desc' }] },
  });
  assert.deepEqual(r.hits.hits.map(h => h._id), expected);
});

test('descending search_after also covers the set exactly', async () => {
  const expected = refSearch(docs, Q).map(d => d.id).reverse();
  const collected = [];
  let cursor;
  for (;;) {
    const body = { query: Q, size: 40, sort: [{ createdAt: 'desc' }], ...(cursor ? { search_after: cursor } : {}) };
    const r = await client.search({ index: 'messages', body });
    if (r.hits.hits.length === 0) break;
    collected.push(...r.hits.hits.map(h => h._id));
    cursor = r.hits.hits.at(-1).sort;
  }
  assert.deepEqual(collected, expected);
});

test('hits carry an OpenSearch-shaped envelope', async () => {
  const r = await client.search({ index: 'messages', body: { query: Q, size: 1 } });
  const h = r.hits.hits[0];
  assert.equal(r._shards.successful, 1);
  assert.equal(h._index, 'messages');
  assert.equal(typeof h._id, 'string');
  assert.ok(Array.isArray(h.sort) && h.sort.length === 2);
  assert.equal(h._source.id, h._id);
});
