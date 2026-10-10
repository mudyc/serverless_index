import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build/builder.js';
import { Reader } from '../src/read/reader.js';

const dir = mkdtempSync(join(tmpdir(), 'l0bin-'));
const out = join(dir, 'bin.l0');

const N = 600;                                  // more than one 512-doc block
const docs = Array.from({ length: N }, (_, i) => ({
  id: String(i),
  ts: 20200101 + i,
  luokka: i % 7 === 0 ? 'a' : 'b',
  // every third document carries no geometry, so absence must survive too
  geom: i % 3 === 0 ? undefined : Buffer.from(Array.from({ length: 3 + (i % 11) }, (_, k) => (i * 31 + k) & 0xff)),
}));

test('binary stored fields round-trip byte for byte', async () => {
  const { catalog } = await build({ docs, index: 'bin', clusteringField: 'ts',
    blockSize: 128, granule: 64, outPath: out });
  assert.deepEqual(catalog.stored.binaryFields, ['geom'], 'catalog names the binary field');
  assert.ok(!catalog.fields.geom, 'a binary field is never indexed');

  const r = await new Reader(out).open();
  const res = await r.search({ query: { match_all: {} }, size: N, sort: [{ ts: 'asc' }] });
  assert.equal(res.hits.hits.length, N);

  let withGeom = 0, without = 0;
  for (const h of res.hits.hits) {
    const want = docs[Number(h._source.id)];
    if (want.geom === undefined) { assert.equal(h._source.geom, undefined); without++; continue; }
    assert.ok(Buffer.isBuffer(h._source.geom) || h._source.geom instanceof Uint8Array);
    assert.equal(Buffer.compare(Buffer.from(h._source.geom), want.geom), 0,
      `doc ${h._source.id}: bytes differ`);
    withGeom++;
  }
  assert.equal(withGeom + without, N);
  assert.ok(withGeom > 0 && without > 0, 'both present and absent cases exercised');
  await r.close();
});

test('binary beats base64 on disk', async () => {
  const b64 = docs.map(d => ({ ...d, geom: d.geom ? d.geom.toString('base64') : undefined }));
  const outB = join(dir, 'b64.l0');
  await build({ docs: b64, index: 'b64', clusteringField: 'ts',
    blockSize: 128, granule: 64, outPath: outB });
  const binBytes = statSync(out).size, b64Bytes = statSync(outB).size;
  assert.ok(binBytes < b64Bytes, `binary ${binBytes} should be under base64 ${b64Bytes}`);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('sparse documents collapse to one union schema instead of exploding', async () => {
  // Twelve optional fields over 3 000 documents gives ~3 000 distinct shapes —
  // past the threshold, so the per-shape table would cost more than the names it
  // saves and the builder must fall back to one union schema.
  const M = 3000, OPT = 12;
  const sparse = Array.from({ length: M }, (_, i) => {
    const d = { id: String(i), ts: 20200101 + i };
    for (let f = 0; f < OPT; f++) if ((i >> f) & 1) d['opt' + f] = f * 1000 + (i % 97);
    return d;
  });
  const outS = join(dir, 'sparse.l0');
  const { catalog } = await build({ docs: sparse, index: 'sparse', clusteringField: 'ts',
    blockSize: 128, granule: 64, outPath: outS });
  assert.equal(catalog.stored.schemas.length, 1, 'collapsed to a single union schema');
  assert.ok(catalog.stored.schemas[0].includes('opt' + (OPT - 1)), 'union covers every optional field');

  const r = await new Reader(outS).open();
  const res = await r.search({ query: { match_all: {} }, size: M, sort: [{ ts: 'asc' }] });
  assert.equal(res.hits.hits.length, M);
  for (const h of res.hits.hits) {
    const want = sparse[Number(h._source.id)];
    assert.deepEqual(Object.keys(h._source).sort(), Object.keys(want).sort(),
      `doc ${h._source.id}: absent fields must stay absent, not become null`);
    for (const k of Object.keys(want)) assert.equal(h._source[k], want[k]);
  }
  await r.close();
});
