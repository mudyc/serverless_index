#!/usr/bin/env node
/**
 * L1 phase 1 measurements (docs/l1-malli.md §11).
 *
 *   node tools/l1-measure.js [docCount=100000] [latencyMs=30]
 *
 * One base artifact; deltas at increasing change rates (operations as a share
 * of the corpus: 30 % inserts, 50 % partial updates, 20 % deletes). For each:
 * delta size, apply cost, and every query's rounds / reads / bytes / time —
 * cold (empty section cache, simulated latency) and warm (cached, CPU only).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from '../src/build/builder.js';
import { Reader } from '../src/read/reader.js';
import { LatencyTransport } from '../src/transport/latency.js';
import { DeltaWriter } from '../src/l1/writer.js';
import { generate } from './gen-data.js';
import { refSearch } from '../test/reference.js';

const N = Number(process.argv[2] ?? 100000);
const LAT = Number(process.argv[3] ?? 30);
const RATES = [0, 0.001, 0.01, 0.1];

const QUERIES = {
  'match_all': { query: { match_all: {} }, size: 25 },
  'term bool': { query: { term: { isRead: true } }, size: 25 },
  'range clustering': { query: { range: { createdAt: { gte: Date.UTC(2026, 5, 1), lt: Date.UTC(2026, 6, 1) } } }, size: 25 },
  'range numeric': { query: { range: { retryCount: { gte: 3 } } }, size: 25 },
  'term keyword': { query: { term: { sender: 'Aatu' } }, size: 25 },
  'wildcard text': { query: { wildcard: { subject: '*lasku*' } }, size: 25 },
  'A+B+C': { query: { bool: {
    filter: [{ term: { isDelivered: true } }, { range: { retryCount: { lte: 2 } } },
             { wildcard: { subject: '*maksusta*' } }],
    must_not: [{ term: { sender: 'Testaaja' } }] } }, size: 25 },
  'sort retryCount desc': { query: { term: { isDelivered: true } }, size: 25, sort: [{ retryCount: 'desc' }] },
  'terms agg sender': { size: 0, aggs: { s: { terms: { field: 'sender', size: 50 } } } },
};

const mulberry = seed => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const dir = await mkdtemp(join(tmpdir(), 'l1m-'));
const path = join(dir, 'base.l0');
const docs = generate({ count: N, seed: 42 });
let t0 = performance.now();
const { bytes: baseBytes, catalog } = await build({ docs, index: 'messages', outPath: path });
const buildMs = performance.now() - t0;
const catBytes = Buffer.byteLength(JSON.stringify(catalog));

console.log(`\nbase: ${N} docs, ${(baseBytes / 1e6).toFixed(1)} MB, catalog ${(catBytes / 1e3).toFixed(0)} kB, ` +
            `build ${buildMs.toFixed(0)} ms; simulated latency ${LAT} ms/round\n`);

const writerReader = await new Reader(path).open();
t0 = performance.now();
const boot = await DeltaWriter.open(writerReader);
console.log(`writer bootstrap (pk scan of stored fields, phase-1 shortcut): ` +
            `${(boot.bootstrap.bytes / 1e6).toFixed(1)} MB in ${boot.bootstrap.reads} reads, ` +
            `${(performance.now() - t0).toFixed(0)} ms\n`);

const rows = [];
for (const rate of RATES) {
  const w = await DeltaWriter.open(writerReader);
  const rnd = mulberry(7);
  const pks = docs.map(d => d.id);
  const alive = new Set(pks);
  const ref = new Map(docs.map(d => [d.id, d]));     // the same operations, on plain objects
  let tail = docs.reduce((m, d) => Math.max(m, d.createdAt), -Infinity);
  const ops = Math.round(N * rate);
  t0 = performance.now();
  for (let i = 0; i < ops; i++) {
    const r = rnd();
    if (r < 0.3) {
      tail += 1 + Math.floor(rnd() * 60000);
      const id = `new-${i}`;
      const doc = { id, createdAt: tail, isDelivered: rnd() < 0.7, isRead: rnd() < 0.5,
                 hasAttachment: rnd() < 0.3, isTest: false, isBounced: false,
                 retryCount: Math.floor(rnd() * 6), sender: rnd() < 0.5 ? 'Aatu' : 'Uusi',
                 subject: rnd() < 0.5 ? 'Lasku maksusta' : 'Tarjous' };
      w.upsert(doc); ref.set(id, doc);
      pks.push(id); alive.add(id);
    } else {
      let pk;
      do pk = pks[Math.floor(rnd() * pks.length)]; while (!alive.has(pk));
      if (r < 0.8) {
        const f = rnd() < 0.5 ? { isRead: rnd() < 0.5 } : { retryCount: Math.floor(rnd() * 6) };
        w.patch(pk, f); ref.set(pk, { ...ref.get(pk), ...f });
      } else { w.delete(pk); alive.delete(pk); ref.delete(pk); }
    }
  }
  const writeMs = performance.now() - t0;
  const delta = w.toJSON();
  const json = JSON.stringify(delta);

  const reader = await new Reader(new LatencyTransport(path, { latencyMs: LAT })).open();
  t0 = performance.now();
  if (rate > 0) reader.applyDelta(JSON.parse(json));
  const applyMs = performance.now() - t0;
  // CPU-only timing: a plain file reader with every section cached.
  const cpu = await new Reader(path).open();
  if (rate > 0) cpu.applyDelta(JSON.parse(json));
  const refDocs = [...ref.values()];

  const q = {};
  for (const [name, body] of Object.entries(QUERIES)) {
    reader.clearCache(); reader.resetStats();
    let s = performance.now();
    const res = await reader.search(body);
    const coldMs = performance.now() - s;
    const st = { ...reader.stats };
    // Correctness at this scale, against the reference on the same operations.
    if (body.query) {
      const sort = body.sort ? Object.entries(body.sort[0])[0] : null;
      const pool = sort ? refDocs.filter(d => typeof d[sort[0]] === 'number') : refDocs;
      const exp = refSearch(pool, body.query, sort ? { sortField: sort[0], order: sort[1] } : {});
      const ok = (sort || res.hits.total.value === exp.length) &&
        JSON.stringify(res.hits.hits.map(h => h._id)) === JSON.stringify(exp.slice(0, body.size).map(d => d.id));
      if (!ok) { console.error(`MISMATCH at rate ${rate}: ${name}`); process.exitCode = 1; }
    }
    await cpu.search(body);                                   // fill the cache
    const warm = [];
    for (let k = 0; k < 7; k++) { s = performance.now(); await cpu.search(body); warm.push(performance.now() - s); }
    warm.sort((a, b) => a - b);
    q[name] = { hits: res.hits.total.value, rounds: st.rounds, reads: st.reads, bytes: st.bytes,
                coldMs, warmMs: warm[3] };
  }
  await reader.close();
  await cpu.close();
  rows.push({ rate, ops, writeMs, deltaBytes: json.length, deltaGz: gzipSync(json).length,
              docsInDelta: delta.docs.length, deleted: delta.deleted.length, appended: delta.docCount - N,
              applyMs, q });
}

const pct = r => r === 0 ? 'base' : `${(r * 100).toFixed(1)} %`;
console.log('delta per change rate');
console.log('rate     ops     write ms   delta kB   gzip kB   docs   deleted  appended  apply ms');
for (const r of rows) {
  console.log(`${pct(r.rate).padEnd(8)} ${String(r.ops).padStart(6)} ${r.writeMs.toFixed(0).padStart(9)} ` +
    `${(r.deltaBytes / 1e3).toFixed(1).padStart(10)} ${(r.deltaGz / 1e3).toFixed(1).padStart(9)} ` +
    `${String(r.docsInDelta).padStart(6)} ${String(r.deleted).padStart(8)} ${String(r.appended).padStart(9)} ` +
    `${r.applyMs.toFixed(1).padStart(9)}`);
}

console.log('\nper query: rounds / reads / kB and wall ms with an empty cache at the simulated latency,');
console.log('then CPU ms with every section cached (median of 7), at each rate');
const head = 'query'.padEnd(22) + RATES.map(r => pct(r).padStart(27)).join('');
console.log(head);
for (const name of Object.keys(QUERIES)) {
  let line = name.padEnd(22);
  for (const r of rows) {
    const x = r.q[name];
    line += `${x.rounds}/${x.reads}/${(x.bytes / 1e3).toFixed(0)}`.padStart(13) +
            `${x.coldMs.toFixed(0)}ms`.padStart(7) + `${x.warmMs.toFixed(1)}ms`.padStart(7);
  }
  console.log(line);
}
console.log();
await writerReader.close();
await rm(dir, { recursive: true, force: true });
