// RBush, the in-memory dynamic R-tree, on the same polygons and views.
//   node --expose-gc --max-old-space-size=12000 rbush.mjs <dir>
// Measures what it costs to get the index into memory (a compact binary of the
// boxes, as a Lambda would fetch it from S3), what a query costs once it is
// there, and what writes cost. Nothing here is durable: that is the point.
import RBush from 'rbush';
import { readFileSync } from 'node:fs';

const S = process.argv[2];
const { feats } = JSON.parse(readFileSync(S + '/poly.json', 'utf8'));
const Q = JSON.parse(readFileSync(new URL('./queries.json', import.meta.url), 'utf8'));
const gc = () => { global.gc?.(); global.gc?.(); };
const N = feats.length;

// The cold-start payload: 4 x f64 box + u32 row per feature = 36 B.
const bin = Buffer.alloc(N * 36);
feats.forEach((f, i) => { for (let j = 0; j < 4; j++) bin.writeDoubleLE(f.bbox[j], i * 36 + j * 8); bin.writeUInt32LE(i, i * 36 + 32); });

gc(); const h0 = process.memoryUsage().heapUsed;
let t = performance.now();
const items = new Array(N);
for (let i = 0; i < N; i++) {
  const o = i * 36;
  items[i] = { minX: bin.readDoubleLE(o), minY: bin.readDoubleLE(o + 8), maxX: bin.readDoubleLE(o + 16),
               maxY: bin.readDoubleLE(o + 24), row: bin.readUInt32LE(o + 32) };
}
const decodeMs = performance.now() - t;
gc(); const h1 = process.memoryUsage().heapUsed;
t = performance.now();
const tree = new RBush(); tree.load(items);
const loadMs = performance.now() - t;
gc(); const h2 = process.memoryUsage().heapUsed;

const out = {
  n: N, payloadBytes: bin.length, decodeMs, loadMs,
  heap: { itemsMB: (h1 - h0) / 1e6, treeMB: (h2 - h1) / 1e6, bytesPerFeature: (h2 - h0) / N },
  // transfer at one connection (100 MB/s) and at S3-from-Lambda parallel (~1 GB/s), plus one 30 ms round
  coldStartMs: { at100MBs: 30 + bin.length / 100e6 * 1000 + decodeMs + loadMs,
                 at1GBs: 30 + bin.length / 1e9 * 1000 + decodeMs + loadMs },
  views: {}, writesUsPerOp: {},
};
const [cx, cy] = Q.center;
for (const [k, h] of Object.entries(Q.boxes)) {
  if (h === null) continue;
  const box = { minX: cx - h, minY: cy - h, maxX: cx + h, maxY: cy + h };
  const exp = feats.filter(f => f.bbox[0] <= box.maxX && f.bbox[2] >= box.minX && f.bbox[1] <= box.maxY && f.bbox[3] >= box.minY).length;
  const times = []; let n = 0;
  for (let i = 0; i < 9; i++) { t = performance.now(); n = tree.search(box).length; times.push(performance.now() - t); }
  if (n !== exp) throw new Error(`${k}: rbush ${n} vs brute force ${exp}`);
  times.sort((a, b) => a - b);
  out.views[k] = { hits: n, medianMs: times[4] };
}
const OPS = 10000;
t = performance.now();
for (let i = 0; i < OPS; i++) tree.insert({ minX: cx + i, minY: cy, maxX: cx + i + 10, maxY: cy + 10, row: N + i });
out.writesUsPerOp.insert = (performance.now() - t) * 1000 / OPS;
t = performance.now();
for (let i = 0; i < OPS; i++) { const it = items[i]; tree.remove(it); it.minX += 10; it.maxX += 10; tree.insert(it); }
out.writesUsPerOp.move = (performance.now() - t) * 1000 / OPS;
t = performance.now();
for (let i = 0; i < OPS; i++) tree.remove(items[OPS + i]);
out.writesUsPerOp.delete = (performance.now() - t) * 1000 / OPS;
console.log(JSON.stringify(out, null, 1));
