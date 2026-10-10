import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build/builder.js';
import { L0Client } from '../src/client.js';
import { generate } from '../tools/gen-data.js';
import { refSearch } from './reference.js';

let dir, path, client, docs;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'l0-'));
  path = join(dir, 'messages.l0');
  docs = generate({ count: 1500, seed: 42 });
  await build({ docs, index: 'messages', outPath: path });
  client = new L0Client({ artifacts: { messages: path } });
});
after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });

/** Run a query through the index and through the reference; they must agree. */
async function agree(query, label) {
  const expected = refSearch(docs, query);
  const res = await client.search({ index: 'messages', body: { query, size: 10000 } });
  assert.equal(res.hits.total.value, expected.length, `${label}: total`);
  assert.deepEqual(
    res.hits.hits.map(h => h._id),
    expected.map(d => d.id),
    `${label}: ids and order`);
  return res;
}

describe('query DSL agrees with the reference implementation', () => {
  const cases = {
    'match_all': { match_all: {} },
    'match_none': { match_none: {} },
    'term true': { term: { isRead: true } },
    'term false': { term: { isRead: false } },
    'term on optional field true': { term: { isSecure: true } },
    'term on optional field false': { term: { isSecure: false } },
    'term long form': { term: { isDelivered: { value: true } } },
    'term string value': { term: { isTest: 'true' } },
    'term unknown field': { term: { nope: true } },
    'terms both values': { terms: { isRead: [true, false] } },
    'terms single': { terms: { isBounced: [true] } },
    'terms empty': { terms: { isRead: [] } },
    'exists present-always': { exists: { field: 'isRead' } },
    'exists optional': { exists: { field: 'isSecure' } },
    'exists unknown': { exists: { field: 'nope' } },
    'bool filter': { bool: { filter: [{ term: { isDelivered: true } }] } },
    'bool must x2': { bool: { must: [{ term: { isDelivered: true } }, { term: { isRead: false } }] } },
    'bool must_not': { bool: { must_not: [{ term: { isTest: true } }] } },
    'bool filter + must_not': {
      bool: { filter: [{ term: { isDelivered: true } }], must_not: [{ term: { isBounced: true } }] } },
    'bool should only (implicit OR)': {
      bool: { should: [{ term: { isBounced: true } }, { term: { isComplaint: true } }] } },
    'bool should ignored beside filter': {
      bool: { filter: [{ term: { isRead: true } }], should: [{ term: { isTest: true } }] } },
    'bool should required by msm': {
      bool: { filter: [{ term: { isRead: true } }], should: [{ term: { isTest: true } }], minimum_should_match: 1 } },
    'bool nested': {
      bool: {
        filter: [{ bool: { should: [{ term: { isBounced: true } }, { term: { isComplaint: true } }] } }],
        must_not: [{ term: { isTest: true } }],
      } },
    'bool empty': { bool: {} },
    'range on clustering key': { range: { createdAt: { gte: Date.UTC(2026, 3, 1), lt: Date.UTC(2026, 5, 1) } } },
    'range clustering open-ended': { range: { createdAt: { gte: Date.UTC(2026, 6, 1) } } },
    'range clustering exclusive': { range: { createdAt: { gt: Date.UTC(2026, 3, 1), lte: Date.UTC(2026, 5, 1) } } },
    'range clustering empty': { range: { createdAt: { gte: Date.UTC(2030, 0, 1) } } },
    'range ISO date string': { range: { createdAt: { gte: '2026-04-01T00:00:00.000Z' } } },
    'range on integer column': { range: { retryCount: { gte: 3 } } },
    'range integer single value': { range: { retryCount: { gte: 2, lte: 2 } } },
    'range integer exclusive both': { range: { retryCount: { gt: 0, lt: 3 } } },
    'range on optional date column': { range: { deliveredAt: { gte: Date.UTC(2026, 5, 1) } } },
    'term on integer': { term: { retryCount: 0 } },
    'term on integer absent value': { term: { retryCount: 99 } },
    'terms on integer': { terms: { retryCount: [0, 5] } },
    'term on keyword': { term: { sender: 'Aatu' } },
    'term on keyword unknown': { term: { sender: 'Nobody' } },
    'terms on keyword': { terms: { sender: ['Aatu', 'Bertta', 'Nobody'] } },
    'prefix on keyword': { prefix: { sender: 'Ee' } },
    'prefix on keyword no match': { prefix: { sender: 'Zz' } },
    'wildcard on keyword': { wildcard: { sender: '*a*o*' } },
    'exists on optional date': { exists: { field: 'deliveredAt' } },
    'wildcard infix on text': { wildcard: { subject: '*lasku*' } },
    'wildcard prefix on text': { wildcard: { subject: 'Muistutus*' } },
    'wildcard suffix on text': { wildcard: { subject: '*2026' } },
    'wildcard both sides on text': { wildcard: { subject: '*maksusta*' } },
    'wildcard short literal (no trigram narrowing)': { wildcard: { subject: '*Q1*' } },
    'wildcard with ?': { wildcard: { subject: 'Lasku m?ksusta*' } },
    'wildcard impossible trigram': { wildcard: { subject: '*zzqx*' } },
    'prefix on text': { prefix: { subject: 'Kutsu' } },
    'term on text (exact)': { term: { subject: 'Lasku maksusta Q2' } },
    'mixed stage A+B+C': {
      bool: {
        filter: [{ term: { isDelivered: true } },
                 { range: { retryCount: { lte: 2 } } },
                 { wildcard: { subject: '*maksusta*' } }],
        must_not: [{ term: { sender: 'Testaaja' } }],
      } },
    'bool deep': {
      bool: {
        must: [{ bool: { must_not: [{ term: { isDelivered: false } }] } }],
        filter: [{ exists: { field: 'isSecure' } }],
        must_not: [{ bool: { must: [{ term: { isRead: true } }, { term: { hasAttachment: true } }] } }],
      } },
  };

  for (const [label, query] of Object.entries(cases)) {
    test(label, async () => { await agree(query, label); });
  }
});

test('200 randomly generated bool queries agree with the reference', async () => {
  const fields = ['isDelivered', 'isRead', 'hasAttachment', 'isSecure', 'isTest', 'isBounced', 'isComplaint'];
  const senders = ['Aatu', 'Bertta', 'Celsius', 'Daavid', 'Eemeli', 'Faarao', 'Gideon', 'Heikki'];
  const words = ['lasku', 'maksusta', 'metsan', 'kutsu', 'hakkuusta', '2026', 'kevat'];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const leaf = () => {
    const r = rnd();
    if (r < 0.32) return { term: { [pick(fields)]: rnd() < 0.5 } };
    if (r < 0.44) return { exists: { field: pick([...fields, 'deliveredAt']) } };
    if (r < 0.58) {
      const lo = Math.floor(rnd() * 5);
      return { range: { retryCount: rnd() < 0.5 ? { gte: lo } : { gte: lo, lte: lo + 1 } } };
    }
    if (r < 0.70) {
      const a = Date.UTC(2026, Math.floor(rnd() * 8), 1);
      return { range: { createdAt: rnd() < 0.5 ? { gte: a } : { gte: a, lt: a + 40 * 864e5 } } };
    }
    if (r < 0.80) return { term: { sender: pick(senders) } };
    if (r < 0.88) return { prefix: { sender: pick(senders).slice(0, 2) } };
    return { wildcard: { subject: `*${pick(words)}*` } };
  };

  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(rnd() * 3);
    const query = {
      bool: {
        filter: Array.from({ length: n }, leaf),
        ...(rnd() < 0.5 ? { must_not: [leaf()] } : {}),
        ...(rnd() < 0.3 ? { should: [leaf(), leaf()], minimum_should_match: 1 } : {}),
      },
    };
    await agree(query, `random #${i} ${JSON.stringify(query)}`);
  }
});

test('exact totals need no track_total_hits', async () => {
  const res = await client.search({ index: 'messages', body: { query: { match_all: {} }, size: 0 } });
  assert.equal(res.hits.total.value, 1500);
  assert.equal(res.hits.total.relation, 'eq');
  assert.equal(res.hits.hits.length, 0);
});

test('count() matches search total', async () => {
  const q = { term: { isDelivered: true } };
  const c = await client.count({ index: 'messages', body: { query: q } });
  const s = await client.search({ index: 'messages', body: { query: q, size: 0 } });
  assert.equal(c.count, s.hits.total.value);
});

test('unsupported query types fail loudly', async () => {
  await assert.rejects(
    () => client.search({ index: 'messages', body: { query: { match: { subject: 'x' } } } }),
    /unsupported query type \[match\]/);
});

test('sorting on a field with no ordered column is refused clearly', async () => {
  await assert.rejects(
    () => client.search({ index: 'messages', body: { query: { match_all: {} }, sort: [{ isRead: 'asc' }] } }),
    /no ordered column/);
  await assert.rejects(
    () => client.search({ index: 'messages', body: { query: { match_all: {} }, sort: [{ sender: 'asc' }] } }),
    /no ordered column/);
});

describe('secondary sort orders use the column as a permutation (§12.8)', () => {
  const Q = { bool: { filter: [{ term: { isDelivered: true } }] } };
  for (const field of ['retryCount', 'deliveredAt']) {
    for (const order of ['asc', 'desc']) {
      test(`${field} ${order}`, async () => {
        // The column only holds documents that have the field, so the
        // reference must drop the absent ones BEFORE sorting.
        const present = docs.filter(d => d[field] !== undefined && d[field] !== null);
        const expected = refSearch(present, Q, { sortField: field, order });
        const r = await client.search({
          index: 'messages', body: { query: Q, size: 10000, sort: [{ [field]: order }] } });
        assert.deepEqual(r.hits.hits.map(h => h._id), expected.map(d => d.id));
      });
    }
  }

  test('paging a secondary sort with from/size is consistent', async () => {
    const present = docs.filter(d => d.retryCount !== undefined);
    const expected = refSearch(present, Q, { sortField: 'retryCount', order: 'asc' }).map(d => d.id);
    const got = [];
    for (let from = 0; from < expected.length; from += 50) {
      const r = await client.search({
        index: 'messages', body: { query: Q, from, size: 50, sort: [{ retryCount: 'asc' }] } });
      got.push(...r.hits.hits.map(h => h._id));
    }
    assert.deepEqual(got, expected);
  });
});
