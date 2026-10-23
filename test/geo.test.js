import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build/builder.js';
import { Reader } from '../src/read/reader.js';
import { DeltaWriter } from '../src/l1/writer.js';
import { gridder } from '../src/hilbert.js';

/**
 * geo_bounding_box: a document matches when its BOX intersects the query box.
 * Features are clustered by the Hilbert key of their centre, as in the map
 * artifacts; large features straddle many granules, which is exactly the case
 * a centre-only key loses and the resident granule boxes must not.
 */
const E = { minx: 0, miny: 0, maxx: 100000, maxy: 100000 };
let dir, path, reader, docs;
let seed = 3;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const hits = (ds, [x0, y0, x1, y1]) => ds.filter(d => d.bbox &&
  d.bbox[0] <= x1 && d.bbox[2] >= x0 && d.bbox[1] <= y1 && d.bbox[3] >= y0).map(d => d.id).sort();

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'geo-'));
  path = join(dir, 'g.l0');
  const key = gridder(16, E);
  docs = Array.from({ length: 5000 }, (_, i) => {
    const cx = rnd() * 100000, cy = rnd() * 100000;
    // mostly small, a few very large ("lakes", "municipalities"), some points
    const r = rnd() < 0.2 ? 0 : rnd() < 0.97 ? rnd() * 300 : 5000 + rnd() * 30000;
    const bbox = [Math.max(0, cx - r), Math.max(0, cy - r * 0.7), Math.min(1e5, cx + r), Math.min(1e5, cy + r * 1.3)];
    const d = { id: `f${String(i).padStart(5, '0')}`, avain: key(cx, cy), luokka: rnd() < 0.1 ? 'a' : 'b', bbox };
    if (i % 97 === 0) delete d.bbox;                           // absent box: never a hit
    return d;
  });
  await build({ docs, index: 'geo', clusteringField: 'avain', outPath: path, bboxFields: ['bbox'], granule: 64 });
  reader = await new Reader(path).open();
});
after(async () => { await reader.close(); await rm(dir, { recursive: true, force: true }); });

const q = ([x0, y0, x1, y1]) => ({ geo_bounding_box: { bbox: { top_left: [x0, y1], bottom_right: [x1, y0] } } });

test('random boxes agree with brute-force intersection', async () => {
  for (let i = 0; i < 200; i++) {
    const w = rnd() < 0.5 ? rnd() * 2000 : rnd() * 40000;
    const x0 = rnd() * (1e5 - w), y0 = rnd() * (1e5 - w);
    const box = [x0, y0, x0 + w, y0 + w * (0.5 + rnd())];
    const res = await reader.search({ query: q(box), size: 100000 });
    assert.deepEqual(res.hits.hits.map(h => h._id).sort(), hits(docs, box), `box ${box}`);
  }
});

test('large features are found far from their centre', async () => {
  const big = docs.find(d => d.bbox && d.bbox[2] - d.bbox[0] > 40000);
  const box = [big.bbox[2] - 10, big.bbox[3] - 10, big.bbox[2], big.bbox[3]];   // a corner, not the centre
  const res = await reader.search({ query: q(box), size: 100000 });
  assert.ok(res.hits.hits.some(h => h._id === big.id));
});

test('combines with other predicates and the top/left/bottom/right form', async () => {
  const box = [20000, 20000, 60000, 45000];
  const res = await reader.search({ size: 100000, query: { bool: { filter: [
    { geo_bounding_box: { bbox: { top: 45000, left: 20000, bottom: 20000, right: 60000 } } },
    { term: { luokka: 'a' } }] } } });
  const exp = hits(docs.filter(d => d.luokka === 'a'), box);
  assert.deepEqual(res.hits.hits.map(h => h._id).sort(), exp);
});

test('the bbox is indexed, not stored', async () => {
  const res = await reader.search({ query: q([0, 0, 1e5, 1e5]), size: 1 });
  assert.equal(res.hits.hits[0]._source.bbox, undefined);
});

test('one wave: two rounds with stored fields, one without', async () => {
  reader.clearCache(); reader.resetStats();
  await reader.search({ query: q([30000, 30000, 32000, 32000]), size: 10 });
  assert.equal(reader.stats.rounds, 2);
  reader.clearCache(); reader.resetStats();
  await reader.search({ query: q([30000, 30000, 32000, 32000]), size: 0 });
  assert.equal(reader.stats.rounds, 1);
});

test('L1: moved, added and deleted features', async () => {
  const r = await new Reader(path).open();
  const w = await DeltaWriter.open(r);
  const live = new Map(docs.map(d => [d.id, d]));
  const moved = docs.find(d => d.bbox);
  w.patch(moved.id, { bbox: [90000, 90000, 90010, 90010] });
  live.set(moved.id, { ...moved, bbox: [90000, 90000, 90010, 90010] });
  const tail = Math.max(...docs.map(d => d.avain)) + 1;
  const added = { id: 'zz-new', avain: tail, luokka: 'a', bbox: [10, 10, 99990, 20] };
  w.upsert(added); live.set(added.id, added);
  const gone = docs.filter(d => d.bbox)[10];
  w.delete(gone.id); live.delete(gone.id);
  r.applyDelta(w.toJSON());
  for (const box of [[89990, 89990, 90005, 90005], [moved.bbox[0], moved.bbox[1], moved.bbox[2], moved.bbox[3]],
                     [50000, 0, 50001, 30], gone.bbox]) {
    const res = await r.search({ query: q(box), size: 100000 });
    assert.deepEqual(res.hits.hits.map(h => h._id).sort(), hits([...live.values()], box), `box ${box}`);
  }
  await r.close();
});

test('L1: spatial appends anywhere (unordered) stay exact for geo, ordering is refused', async () => {
  const r = await new Reader(path).open();
  const w = await DeltaWriter.open(r, { unordered: true });
  const live = new Map(docs.map(d => [d.id, d]));
  const key = gridder(16, E);
  for (let i = 0; i < 300; i++) {
    const cx = rnd() * 1e5, cy = rnd() * 1e5, s = rnd() * 200;
    const d = { id: `u${i}`, avain: key(cx, cy), luokka: 'a', bbox: [cx - s, cy - s, cx + s, cy + s] };
    w.upsert(d); live.set(d.id, d);
  }
  // moving a feature changes its key: it must carry its box
  const mv = docs.find(d => d.bbox);
  assert.throws(() => w.patch(mv.id, { avain: 1 }), /include \[bbox\]/);
  w.patch(mv.id, { avain: 1, bbox: [1, 1, 2, 2] }); live.set(mv.id, { ...mv, avain: 1, bbox: [1, 1, 2, 2] });
  const delta = JSON.parse(JSON.stringify(w.toJSON()));
  assert.equal(delta.unordered, true);
  r.applyDelta(delta);
  for (let i = 0; i < 50; i++) {
    const wdt = rnd() * 20000, x0 = rnd() * (1e5 - wdt), y0 = rnd() * (1e5 - wdt);
    const box = [x0, y0, x0 + wdt, y0 + wdt];
    const res = await r.search({ query: q(box), size: 100000 });
    assert.deepEqual(res.hits.hits.map(h => h._id).sort(), hits([...live.values()], box), `box ${box}`);
  }
  const res = await r.search({ query: q([0, 0, 3, 3]), size: 10 });
  assert.ok(res.hits.hits.some(h => h._id === mv.id));
  await assert.rejects(() => r.search({ query: q([0, 0, 1e5, 1e5]), sort: [{ avain: 'asc' }] }), /out-of-order/);
  await assert.rejects(() => r.search({ query: q([0, 0, 1e5, 1e5]), search_after: [5] }), /out-of-order/);
  await r.close();
});

test('L1: binary values survive the JSON delta', async () => {
  const r = await new Reader(path).open();
  const w = await DeltaWriter.open(r, { unordered: true });
  w.upsert({ id: 'bin', avain: 7, bbox: [5, 5, 6, 6], geom: Buffer.from([1, 2, 3, 250]) });
  r.applyDelta(JSON.parse(JSON.stringify(w.toJSON())));
  const res = await r.search({ query: q([5, 5, 6, 6]), size: 10 });
  const h = res.hits.hits.find(x => x._id === 'bin');
  assert.deepEqual([...h._source.geom], [1, 2, 3, 250]);
  await r.close();
});
