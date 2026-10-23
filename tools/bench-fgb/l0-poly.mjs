// Polygons as L0: Hilbert key of the bbox centre as clustering, bbox column +
// resident granule boxes for geo_bounding_box, ring as binary (1 m grid).
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { build } from '../../src/build/builder.js';
import { Reader } from '../../src/read/reader.js';
import { LatencyTransport } from '../../src/transport/latency.js';
import { gridder, boxRanges, boxToGrid } from '../../src/hilbert.js';
import { encodeParts } from '../../src/geom.js';

const S = process.argv[2], LAT = Number(process.argv[3] ?? 30), ORDER = 18;
const { extent: E, feats } = JSON.parse(readFileSync(S + '/poly.json', 'utf8'));
const Q = JSON.parse(readFileSync(new URL('./queries.json', import.meta.url), 'utf8'));
const key = gridder(ORDER, E);
const CLASSED = process.env.CLASSED === '1';
const sizeClass = f => { const e = Math.max(f.bbox[2] - f.bbox[0], f.bbox[3] - f.bbox[1]); return e < 100 ? 0 : e < 2000 ? 1 : 2; };
const docs = feats.map(f => ({ id: f.id, luokka: f.luokka, vuosi: f.vuosi, nimi: f.nimi, bbox: f.bbox,
  avain: (CLASSED ? sizeClass(f) * 4 ** ORDER : 0) + key((f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2),
  geom: encodeParts([f.ring]) }));
const path = S + '/bench-poly.l0';
let t0 = performance.now();
await build({ docs, index: 'alueet', clusteringField: 'avain', outPath: path, bboxFields: ['bbox'],
              indexFields: ['avain', 'luokka', 'vuosi'], storedFields: ['id', 'luokka', 'vuosi', 'nimi', 'geom'] });
const buildMs = performance.now() - t0;
docs.length = 0;

const [cx, cy] = Q.center;
const rects = {};
for (const [k, h] of Object.entries(Q.boxes)) rects[k] = h === null ? [E.minx, E.miny, E.maxx, E.maxy] : [cx - h, cy - h, cx + h, cy + h];
const meets = (b, q) => b[0] <= q[2] && b[2] >= q[0] && b[1] <= q[3] && b[3] >= q[1];

const tr = new LatencyTransport(path, { latencyMs: LAT, bandwidthMBs: 100 });
t0 = performance.now();
const reader = await new Reader(tr).open();
const openMs = performance.now() - t0;
const cat = reader.catalog;
const out = { format: 'L0 + geo_bounding_box', bytes: statSync(path).size,
  catalogBytes: Buffer.byteLength(JSON.stringify(cat)),
  granuleBoxBytes: Buffer.from(cat.fields.bbox.granuleBoxes, 'base64').length,
  bboxColumnBytes: cat.sections['geo:bbox:bbox'].length, buildMs, open: { rounds: 2, ms: openMs }, queries: {} };
const run = async (label, body, check) => {
  reader.clearCache(); reader.resetStats();
  const s = performance.now(); const res = await reader.search(body); const ms = performance.now() - s;
  out.queries[label] = { hits: res.hits.total.value, ...(check ? check(res) : {}), ...reader.stats, ms };
};
for (const [label, bb] of Object.entries(rects)) {
  const exp = feats.filter(f => meets(f.bbox, bb)).length;
  const gq = { geo_bounding_box: { bbox: { top_left: [bb[0], bb[3]], bottom_right: [bb[2], bb[1]] } } };
  await run(label, { query: gq, size: 2000000 }, res => {
    if (res.hits.total.value !== exp) throw new Error(`${label}: ${res.hits.total.value} vs ${exp}`);
    return { expected: exp };
  });
  // the earlier centre-only approach, for its recall
  const g = boxToGrid(ORDER, E, bb);
  const rr = boxRanges(ORDER, g[0], g[1], g[2], g[3], 128);
  const hq = { bool: { should: (CLASSED ? [0, 1, 2] : [0]).flatMap(c => rr.map(([lo, hi]) =>
    ({ range: { avain: { gte: c * 4 ** ORDER + lo, lte: c * 4 ** ORDER + hi } } }))) } };
  await run(`${label} (Hilbert centre only)`, { query: hq, size: 2000000 }, res => {
    const ids = new Set(res.hits.hits.map(h => h._id));
    const found = feats.filter(f => meets(f.bbox, bb) && ids.has(f.id)).length;
    return { expected: exp, found, recall: found / exp };
  });
  await run(`${label} agg`, { query: gq, size: 0, aggs: { l: { terms: { field: 'luokka', size: 20 } } } });
}
await reader.close();
writeFileSync(S + `/l0-poly${CLASSED ? '-classed' : ''}-results.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
