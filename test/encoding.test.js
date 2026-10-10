import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bitmap } from '../src/bitmap.js';
import { build } from '../src/build/builder.js';
import { L0Client } from '../src/client.js';
import { refSearch } from './reference.js';

test('encode() picks the smaller representation', () => {
  const n = 100_000;                       // dense form is 12 500 bytes
  const sparse = Bitmap.empty(n);
  [1, 500, 99_999].forEach(i => sparse.set(i));
  const e1 = sparse.encode();
  assert.equal(e1.kind, 'ids');
  assert.equal(e1.buf.length, 4 + 3 * 4);

  const dense = Bitmap.empty(n);
  for (let i = 0; i < n; i += 2) dense.set(i);
  const e2 = dense.encode();
  assert.equal(e2.kind, 'bitmap');
  assert.equal(e2.buf.length, Bitmap.byteLengthFor(n));
});

test('both encodings round-trip identically', () => {
  const n = 50_000;
  const bm = Bitmap.empty(n);
  [0, 7, 64, 1023, 49_999].forEach(i => bm.set(i));
  const viaIds = Bitmap.fromIdBytes(n, bm.toIdBytes());
  const viaBits = Bitmap.fromBytes(n, bm.toBytes());
  assert.deepEqual(viaIds.page(0, 99), bm.page(0, 99));
  assert.deepEqual(viaBits.page(0, 99), bm.page(0, 99));
});

test('a high-cardinality keyword field stays small and stays correct', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'l0enc-'));
  const path = join(dir, 'm.l0');
  // 20 000 documents, 2 000 distinct values => 10 docs per value.
  // Dense bitmaps would be 2 000 x 2 500 B = 5 MB; id lists are ~2 000 x 44 B.
  const docs = Array.from({ length: 20_000 }, (_, i) => ({
    id: `d${i}`, t: i, code: `c${i % 2000}`,
  }));
  const { catalog, bytes } = await build({
    docs, index: 'x', clusteringField: 't', outPath: path, keywordMaxCardinality: 4096,
  });
  assert.equal(catalog.fields.code.type, 'keyword');
  assert.equal(catalog.fields.code.stats.cardinality, 2000);

  const kinds = Object.values(catalog.fields.code.values)
    .map(v => catalog.sections[v.section].kind);
  assert.ok(kinds.every(k => k === 'ids'), 'every rare value stored as an id list');

  const sectionBytes = Object.values(catalog.sections).reduce((a, s) => a + s.length, 0);
  assert.ok(sectionBytes < 500_000,
    `sections ${sectionBytes} B — dense bitmaps would have been ~5 MB`);
  void bytes;

  const client = new L0Client({ artifacts: { x: path } });
  const q = { term: { code: 'c1234' } };
  const res = await client.search({ index: 'x', body: { query: q, size: 100 } });
  const expected = refSearch(docs, q, { sortField: 't' });
  assert.equal(res.hits.total.value, expected.length);
  assert.deepEqual(res.hits.hits.map(h => h._id), expected.map(d => d.id));
  await client.close();
  await rm(dir, { recursive: true, force: true });
});
