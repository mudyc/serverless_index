// Same points, same boxes, as an L0 artifact clustered by a Hilbert key.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { build } from '../../src/build/builder.js';
import { Reader } from '../../src/read/reader.js';
import { LatencyTransport } from '../../src/transport/latency.js';
import { gridder, boxRanges, boxToGrid } from '../../src/hilbert.js';

const S = process.argv[2];
const LAT = Number(process.argv[3] ?? 30);
const ORDER = 18;
const { extent: E, pts } = JSON.parse(readFileSync(S + '/pts.json', 'utf8'));
const Q = JSON.parse(readFileSync(new URL('./queries.json', import.meta.url), 'utf8'));
const key = gridder(ORDER, E);
const docs = pts.map(p => ({ ...p, avain: key(p.x, p.y), bbox: [p.x, p.y, p.x, p.y] }));
const path = S + '/bench.l0';
let t0 = performance.now();
await build({ docs, index: 'pisteet', clusteringField: 'avain', outPath: path, bboxFields: ['bbox'],
              indexFields: ['avain', 'luokka', 'vuosi', 'x', 'y'],
              storedFields: ['id', 'x', 'y', 'luokka', 'vuosi', 'nimi'] });
const buildMs = performance.now() - t0;

const [cx, cy] = Q.center;
const rects = {};
for (const [k, h] of Object.entries(Q.boxes)) rects[k] = h === null ? [E.minx, E.miny, E.maxx, E.maxy]
  : [cx - h, cy - h, cx + h, cy + h];
const hilbertQuery = (bb) => {
  const g = boxToGrid(ORDER, E, bb);
  const ranges = boxRanges(ORDER, g[0], g[1], g[2], g[3], 128);
  return { ranges: ranges.length, q: { bool: { should: ranges.map(([lo, hi]) => ({ range: { avain: { gte: lo, lte: hi } } })) } } };
};
const exactQuery = (bb) => ({ bool: { filter: [ { range: { x: { gte: bb[0], lte: bb[2] } } }, { range: { y: { gte: bb[1], lte: bb[3] } } } ] } });
const inBox = (d, bb) => d.x >= bb[0] && d.x <= bb[2] && d.y >= bb[1] && d.y <= bb[3];

// cold open: footer + catalog
const tr = new LatencyTransport(path, { latencyMs: LAT, bandwidthMBs: 100 });
t0 = performance.now();
const reader = await new Reader(tr).open();
const openMs = performance.now() - t0;
const catBytes = Buffer.byteLength(JSON.stringify(reader.catalog));

const out = { format: 'L0 (Hilbert-clustered, order 18)', bytes: statSync(path).size, catalogBytes: catBytes,
              buildMs, open: { rounds: 2, ms: openMs }, queries: {} };
const run = async (label, body, check) => {
  reader.clearCache(); reader.resetStats();
  const s = performance.now();
  const res = await reader.search(body);
  const ms = performance.now() - s;
  const st = { ...reader.stats };
  out.queries[label] = { hits: res.hits.total.value, ...check(res), rounds: st.rounds, reads: st.reads, bytes: st.bytes, ms };
};
for (const [label, bb] of Object.entries(rects)) {
  const exp = pts.filter(p => inBox(p, bb)).length;
  const { q, ranges } = hilbertQuery(bb);
  await run(label, { query: q, size: 2000000 }, res => {
    const kept = res.hits.hits.filter(h => inBox(h._source, bb)).length;
    if (kept !== exp) throw new Error(`${label}: L0 kept ${kept}, brute force ${exp}`);
    return { kept, expected: exp, ranges };
  });
  // the same box as geo_bounding_box: resident granule boxes + per-doc bbox column, exact in the index
  await run(`${label} (geo_bounding_box)`, { query: { geo_bounding_box: { bbox: { top_left: [bb[0], bb[3]], bottom_right: [bb[2], bb[1]] } } }, size: 2000000 }, res => {
    if (res.hits.total.value !== exp) throw new Error(`${label} geo: ${res.hits.total.value} vs ${exp}`);
    return { expected: exp };
  });
  // attribute filter riding the same wave: a rare class
  const rare = pts.filter(p => inBox(p, bb) && p.luokka === 'k9').length;
  await run(`${label} + luokka=k9`, { query: { bool: { filter: [q, { term: { luokka: 'k9' } }] } }, size: 2000000 }, res => {
    const kept = res.hits.hits.filter(h => inBox(h._source, bb)).length;
    if (kept !== rare) throw new Error(`${label}+k9: ${kept} vs ${rare}`);
    return { kept, expected: rare };
  });
  // counts by class: Hilbert cells only (approximate), and exact with x/y columns
  const expCounts = {};
  for (const p of pts) if (inBox(p, bb)) expCounts[p.luokka] = (expCounts[p.luokka] ?? 0) + 1;
  await run(`${label} agg (Hilbert, approx)`, { query: q, size: 0, aggs: { l: { terms: { field: 'luokka', size: 20 } } } }, res => {
    const got = Object.fromEntries(res.aggregations.l.buckets.map(b => [b.key, b.doc_count]));
    const err = Math.max(...Object.keys(expCounts).map(k => Math.abs((got[k] ?? 0) - expCounts[k]) / expCounts[k]));
    return { maxRelError: err };
  });
  await run(`${label} agg (exact x/y)`, { query: { bool: { filter: [q, exactQuery(bb)] } }, size: 0,
                                         aggs: { l: { terms: { field: 'luokka', size: 20 } } } }, res => {
    const got = Object.fromEntries(res.aggregations.l.buckets.map(b => [b.key, b.doc_count]));
    const ok = Object.keys(expCounts).every(k => got[k] === expCounts[k]);
    if (!ok) throw new Error(`${label}: exact agg mismatch`);
    return { exact: true };
  });
}
await reader.close();
writeFileSync(S + '/l0-points-results.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
