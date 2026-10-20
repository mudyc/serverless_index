import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build/builder.js';
import { Reader } from '../src/read/reader.js';
import { DeltaWriter, L1OrderError } from '../src/l1/writer.js';
import { generate } from '../tools/gen-data.js';
import { refSearch, refMatch } from './reference.js';

/**
 * Differential test for L1 phase 1 (docs/l1-malli.md §11): the same sequence of
 * inserts, updates and deletes is applied to the artifact (as a delta) and to a
 * plain array (the reference). Every query must then agree on hits and order.
 */

let dir, path, reader, writer, live;

const mulberry = seed => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rnd = mulberry(99);
const pick = a => a[Math.floor(rnd() * a.length)];

const SENDERS = ['Aatu', 'Bertta', 'Celsius', 'Uusi', 'Toinen Uusi'];      // two unknown to the base
const SUBJECTS = ['Lasku maksusta Q3', 'Tarjous metsanhoidosta', 'Kutsu uusi', 'Lasku tarjouksesta'];
const BOOLS = ['isDelivered', 'isRead', 'hasAttachment', 'isSecure', 'isTest', 'isBounced', 'isComplaint'];

const clusterOrder = (a, b) =>
  a.createdAt === b.createdAt ? String(a.id).localeCompare(String(b.id)) : a.createdAt - b.createdAt;

// The writer's tail never moves backwards, even when the last document is
// deleted, so the test keeps its own monotone tail rather than max(live).
let tail = -Infinity;
function nextTail() { tail += 1 + Math.floor(rnd() * 3.6e6); return tail; }

let newId = 0;
function randomFields() {
  const f = {};
  if (rnd() < 0.5) f[pick(BOOLS)] = rnd() < 0.5;
  if (rnd() < 0.4) f.retryCount = Math.floor(rnd() * 7);
  if (rnd() < 0.4) f.sender = pick(SENDERS);
  if (rnd() < 0.3) f.subject = pick(SUBJECTS);
  if (rnd() < 0.15) f.deliveredAt = undefined;                    // remove an optional field
  if (rnd() < 0.15) f.isSecure = undefined;
  if (rnd() < 0.15) f.deliveredAt = Date.UTC(2026, 9, 1) + Math.floor(rnd() * 1e9);
  return f;
}

/** One random operation, applied to both sides. */
function step() {
  const r = rnd();
  const pks = [...live.keys()];
  if (r < 0.25) {                                               // insert at the tail
    const createdAt = nextTail();
    const doc = { id: `new-${String(newId++).padStart(5, '0')}`, createdAt,
                  isDelivered: rnd() < 0.7, isRead: rnd() < 0.5, hasAttachment: rnd() < 0.3,
                  isTest: rnd() < 0.1, isBounced: rnd() < 0.05,
                  retryCount: Math.floor(rnd() * 6), sender: pick(SENDERS), subject: pick(SUBJECTS) };
    if (rnd() < 0.7) doc.deliveredAt = createdAt + 1000;
    writer.upsert(doc); live.set(doc.id, doc);
  } else if (r < 0.60) {                                        // partial update
    const pk = pick(pks), f = randomFields();
    writer.patch(pk, f);
    const next = { ...live.get(pk) };
    for (const [k, v] of Object.entries(f)) if (v === undefined) delete next[k]; else next[k] = v;
    live.set(pk, next);
  } else if (r < 0.70) {                                        // full replace, same key
    const pk = pick(pks), old = live.get(pk);
    const doc = { id: pk, createdAt: old.createdAt, isDelivered: rnd() < 0.5, isRead: rnd() < 0.5,
                  hasAttachment: false, isTest: false, isBounced: false,
                  retryCount: Math.floor(rnd() * 6), sender: pick(SENDERS), subject: pick(SUBJECTS) };
    writer.upsert(doc); live.set(pk, doc);
  } else if (r < 0.78) {                                        // move: clustering key changes
    const pk = pick(pks);
    const createdAt = nextTail();
    writer.patch(pk, { createdAt });
    live.set(pk, { ...live.get(pk), createdAt });
  } else {                                                      // delete
    const pk = pick(pks);
    writer.delete(pk); live.delete(pk);
  }
}

const docsNow = () => [...live.values()];

async function agree(body, label) {
  const query = body.query;
  const expected = refSearch(docsNow(), query);
  const res = await reader.search({ size: 100000, ...body });
  assert.equal(res.hits.total.value, expected.length, `${label}: total`);
  assert.deepEqual(res.hits.hits.map(h => h._id), expected.map(d => d.id), `${label}: ids and order`);
  // The returned _source must be the CURRENT document, not the base one.
  for (const h of res.hits.hits.slice(0, 50)) {
    assert.deepEqual(h._source, live.get(h._id), `${label}: _source of ${h._id}`);
  }
}

const CASES = {
  'match_all': { match_all: {} },
  'term bool true': { term: { isRead: true } },
  'term bool false': { term: { isRead: false } },
  'optional bool false': { term: { isSecure: false } },
  'exists optional': { exists: { field: 'deliveredAt' } },
  'exists optional bool': { exists: { field: 'isSecure' } },
  'range numeric': { range: { retryCount: { gte: 3 } } },
  'term numeric new value': { term: { retryCount: 6 } },
  'range clustering tail': { range: { createdAt: { gte: Date.UTC(2026, 7, 1) } } },
  'range clustering head': { range: { createdAt: { lt: Date.UTC(2026, 2, 1) } } },
  'range date optional': { range: { deliveredAt: { gte: Date.UTC(2026, 9, 1) } } },
  'term keyword base value': { term: { sender: 'Aatu' } },
  'term keyword new value': { term: { sender: 'Uusi' } },
  'terms keyword mixed': { terms: { sender: ['Bertta', 'Toinen Uusi'] } },
  'prefix keyword new': { prefix: { sender: 'Uu' } },
  'wildcard keyword': { wildcard: { sender: '*uu*' } },
  'wildcard text base gram': { wildcard: { subject: '*lasku*' } },
  'wildcard text new grams': { wildcard: { subject: '*tarjou*' } },
  'term text exact': { term: { subject: 'Kutsu uusi' } },
  'prefix text': { prefix: { subject: 'Lasku' } },
  'bool mixed': { bool: {
    filter: [{ term: { isDelivered: true } }, { range: { retryCount: { lte: 3 } } }],
    must_not: [{ term: { sender: 'Uusi' } }] } },
  'bool should': { bool: { should: [{ term: { isBounced: true } }, { wildcard: { subject: '*tarjous*' } }] } },
};

function randomQuery() {
  const leaf = () => {
    const r = rnd();
    if (r < 0.3) return { term: { [pick(BOOLS)]: rnd() < 0.5 } };
    if (r < 0.4) return { exists: { field: pick([...BOOLS, 'deliveredAt']) } };
    if (r < 0.55) return { range: { retryCount: { gte: Math.floor(rnd() * 6) } } };
    if (r < 0.65) return { range: { createdAt: { gte: Date.UTC(2026, Math.floor(rnd() * 10), 1) } } };
    if (r < 0.8) return { term: { sender: pick([...SENDERS, 'Daavid', 'Heikki']) } };
    return { wildcard: { subject: `*${pick(['lasku', 'tarjo', 'kutsu', 'maksusta', 'uusi'])}*` } };
  };
  return { bool: {
    filter: Array.from({ length: 1 + Math.floor(rnd() * 3) }, leaf),
    ...(rnd() < 0.5 ? { must_not: [leaf()] } : {}),
    ...(rnd() < 0.3 ? { should: [leaf(), leaf()], minimum_should_match: 1 } : {}),
  } };
}

async function checkAll(tag) {
  for (const [label, query] of Object.entries(CASES)) await agree({ query }, `${tag} ${label}`);
  for (let i = 0; i < 60; i++) {
    const q = randomQuery();
    await agree({ query: q }, `${tag} random #${i} ${JSON.stringify(q)}`);
  }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'l1-'));
  path = join(dir, 'm.l0');
  const docs = generate({ count: 1500, seed: 42 });
  await build({ docs, index: 'messages', outPath: path });
  reader = await new Reader(path).open();
  writer = await DeltaWriter.open(reader);
  live = new Map(docs.map(d => [d.id, d]));
  tail = Math.max(...docs.map(d => d.createdAt));
});
after(async () => { await reader.close(); await rm(dir, { recursive: true, force: true }); });

describe('L1 phase 1: base + inline delta agrees with the reference', () => {
  test('no delta: unchanged behaviour', async () => { await checkAll('base'); });

  for (const [round, ops] of [[1, 20], [2, 150], [3, 600]]) {
    test(`after ${ops} more operations (delta ${round})`, async () => {
      for (let i = 0; i < ops; i++) step();
      reader.applyDelta(JSON.parse(JSON.stringify(writer.toJSON())));   // as if read from storage
      await checkAll(`delta${round}`);
    });
  }

  test('secondary sort merges base and overlay, both directions, paged', async () => {
    const Q = { bool: { filter: [{ term: { isDelivered: true } }] } };
    for (const field of ['retryCount', 'deliveredAt']) {
      for (const order of ['asc', 'desc']) {
        const present = docsNow().filter(d => typeof d[field] === 'number');
        const expected = refSearch(present, Q, { sortField: field, order }).map(d => d.id);
        const all = await reader.search({ query: Q, size: 100000, sort: [{ [field]: order }] });
        assert.deepEqual(all.hits.hits.map(h => h._id), expected, `${field} ${order}`);
        // small pages force the estimated span to fall short sometimes
        const got = [];
        for (let from = 0; from < expected.length; from += 23) {
          const r = await reader.search({ query: Q, from, size: 23, sort: [{ [field]: order }] });
          got.push(...r.hits.hits.map(h => h._id));
        }
        assert.deepEqual(got, expected, `${field} ${order} paged`);
        // search_after on the secondary order
        const viaCursor = [];
        let cursor;
        for (;;) {
          const r = await reader.search({ query: Q, size: 31, sort: [{ [field]: order }],
                                          ...(cursor ? { search_after: cursor } : {}) });
          if (r.hits.hits.length === 0) break;
          viaCursor.push(...r.hits.hits.map(h => h._id));
          cursor = r.hits.hits.at(-1).sort;
        }
        assert.deepEqual(viaCursor, expected, `${field} ${order} search_after`);
      }
    }
  });

  test('clustering order: search_after and desc cover the live set exactly', async () => {
    const Q = { term: { isRead: true } };
    const expected = refSearch(docsNow(), Q).map(d => d.id);
    const got = [];
    let cursor;
    for (;;) {
      const r = await reader.search({ query: Q, size: 40, ...(cursor ? { search_after: cursor } : {}) });
      if (r.hits.hits.length === 0) break;
      got.push(...r.hits.hits.map(h => h._id));
      cursor = r.hits.hits.at(-1).sort;
    }
    assert.deepEqual(got, expected);
    const d = await reader.search({ query: Q, size: 100000, sort: [{ createdAt: 'desc' }] });
    assert.deepEqual(d.hits.hits.map(h => h._id), [...expected].reverse());
  });

  test('terms aggregation counts base, changed and new values', async () => {
    const Q = { range: { retryCount: { lte: 4 } } };
    const hits = docsNow().filter(d => refMatch(d, Q));
    for (const field of ['sender', 'isRead']) {
      const exp = new Map();
      for (const d of hits) {
        const v = d[field];
        if (v === undefined || v === null) continue;
        if (typeof v === 'boolean' && v !== true) continue;          // boolean terms report "true"
        const k = String(v);
        exp.set(k, (exp.get(k) ?? 0) + 1);
      }
      const expected = [...exp].map(([key, doc_count]) => ({ key, doc_count }))
        .sort((a, b) => b.doc_count - a.doc_count || a.key.localeCompare(b.key));
      const r = await reader.search({ query: Q, size: 0, aggs: { t: { terms: { field, size: 1000 } } } });
      assert.deepEqual(r.aggregations.t.buckets, expected, field);
    }
    // numeric sub-aggregation over overlay values
    const r = await reader.search({ query: Q, size: 0,
      aggs: { s: { terms: { field: 'sender', size: 1000 }, aggs: { a: { stats: { field: 'retryCount' } } } } } });
    for (const b of r.aggregations.s.buckets) {
      const vs = hits.filter(d => d.sender === b.key && typeof d.retryCount === 'number').map(d => d.retryCount);
      assert.equal(b.a.count, vs.length, `stats count ${b.key}`);
      assert.equal(b.a.sum, vs.reduce((x, y) => x + y, 0), `stats sum ${b.key}`);
    }
  });

  test('histogram over the clustering key includes appended documents', async () => {
    const interval = 30 * 864e5;
    const Q = { term: { isDelivered: true } };
    const hits = docsNow().filter(d => refMatch(d, Q));
    const byKey = new Map();
    for (const d of hits) {
      const k = Math.floor(d.createdAt / interval) * interval;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(d);
    }
    const r = await reader.search({ query: Q, size: 0, aggs: { h: { histogram: {
      field: 'createdAt', interval,
      aggs: { s: { terms: { field: 'sender', size: 100 } }, rc: { sum: { field: 'retryCount' } } } } } } });
    const got = r.aggregations.h.buckets;
    assert.deepEqual(got.map(b => [b.key, b.doc_count]),
      [...byKey].sort((a, b) => a[0] - b[0]).map(([k, ds]) => [k, ds.length]));
    for (const b of got) {
      const ds = byKey.get(b.key);
      const exp = new Map();
      for (const d of ds) exp.set(d.sender, (exp.get(d.sender) ?? 0) + 1);
      const norm = a => [...a].sort((x, y) => x.key.localeCompare(y.key));
      assert.deepEqual(norm(b.s.buckets),
        norm([...exp].map(([key, doc_count]) => ({ key, doc_count }))), `terms in ${b.key}`);
      assert.equal(b.rc.value, ds.reduce((x, d) => x + (d.retryCount ?? 0), 0), `sum in ${b.key}`);
    }
  });

  test('a delta adds no round trip and no byte range to the wave', async () => {
    const body = { query: { bool: { filter: [{ term: { isDelivered: true } },
      { range: { retryCount: { lte: 2 } } }, { wildcard: { subject: '*maksusta*' } }] } }, size: 25 };
    const fresh = await new Reader(path).open();
    fresh.clearCache(); fresh.resetStats();
    await fresh.search(body);
    const base = { ...fresh.stats };
    fresh.applyDelta(writer.toJSON());
    fresh.clearCache(); fresh.resetStats();
    await fresh.search(body);
    const withDelta = { ...fresh.stats };
    await fresh.close();
    assert.equal(withDelta.rounds, base.rounds, 'rounds');
    assert.ok(withDelta.reads <= base.reads, `reads ${withDelta.reads} vs ${base.reads}`);
  });
});

describe('L1 writer contract', () => {
  test('re-delivered operations are skipped by seq (idempotent flush)', async () => {
    const w = await DeltaWriter.open(reader);
    w.patch('msg-00001', { retryCount: 5 }, 10);
    const once = JSON.stringify(w.toJSON());
    w.patch('msg-00001', { retryCount: 5 }, 10);                      // same seq again
    w.patch('msg-00001', { retryCount: 1 }, 9);                       // older seq
    assert.equal(JSON.stringify(w.toJSON()), once);
  });

  test('an append before the tail of the clustering order is refused', async () => {
    const w = await DeltaWriter.open(reader);
    assert.throws(() => w.upsert({ id: 'late', createdAt: Date.UTC(2026, 0, 2), sender: 'Aatu' }), L1OrderError);
  });

  test('a writer can continue from a stored delta', async () => {
    const saved = writer.toJSON();
    const w = await DeltaWriter.open(reader, { delta: saved });
    assert.deepEqual(w.toJSON(), saved);
  });

  test('an older delta is refused (monotonic versions)', async () => {
    const r = await new Reader(path).open();
    r.applyDelta({ ...writer.toJSON(), seq: 1000 });
    assert.throws(() => r.applyDelta({ ...writer.toJSON(), seq: 999 }), /older/);
    await r.close();
  });

  test('restoring a field to its base value clears it from the dirty set', async () => {
    const w = await DeltaWriter.open(reader);
    const orig = w.current('msg-00002').retryCount;
    w.patch('msg-00002', { retryCount: orig + 1 });
    assert.ok(w.toJSON().dirty.retryCount.length === 1);
    w.patch('msg-00002', { retryCount: orig });
    assert.equal(w.toJSON().dirty.retryCount, undefined);
    assert.equal(w.toJSON().docs.length, 0);
  });
});
