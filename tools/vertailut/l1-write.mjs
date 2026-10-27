// Writes on the polygon artifact: what an update costs as an L1 delta, and what
// the reads cost afterwards. Run after `CLASSED=1 node l0-poly.mjs <dir>`.
//   node --max-old-space-size=12000 l1-write.mjs <dir> [latencyMs]
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Reader } from '../../src/read/reader.js';
import { LatencyTransport } from '../../src/transport/latency.js';
import { DeltaWriter } from '../../src/l1/writer.js';
import { gridder } from '../../src/hilbert.js';
import { encodeParts } from '../../src/geom.js';

const S = process.argv[2], LAT = Number(process.argv[3] ?? 30), ORDER = 18;
const RATES = [0.001, 0.01, 0.1];
const { extent: E, feats } = JSON.parse(readFileSync(S + '/poly.json', 'utf8'));
const Q = JSON.parse(readFileSync(new URL('./queries.json', import.meta.url), 'utf8'));
const path = S + '/bench-poly.l0';
const grid = gridder(ORDER, E);
const sizeClass = b => { const e = Math.max(b[2] - b[0], b[3] - b[1]); return e < 100 ? 0 : e < 2000 ? 1 : 2; };
const keyOf = b => sizeClass(b) * 4 ** ORDER + grid((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
const meets = (b, q) => b[0] <= q[2] && b[2] >= q[0] && b[1] <= q[3] && b[3] >= q[1];
const [cx, cy] = Q.center;
const views = { '20 km': 10000, '2 km': 1000, '200 m': 100 };

let seed = 99;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const polygon = (x, y, r) => {
  const ring = [];
  for (let j = 0; j < 8; j++) { const a = 2 * Math.PI * j / 8, rr = r * (0.6 + 0.4 * rnd());
    ring.push([Math.round(x + rr * Math.cos(a)), Math.round(y + rr * Math.sin(a))]); }
  ring.push(ring[0]);
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  return { ring, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
};

const base = await new Reader(path).open();
let t0 = performance.now();
const probe = await DeltaWriter.open(base, { unordered: true });
const bootstrap = { ...probe.bootstrap, ms: performance.now() - t0 };
console.log(`writer bootstrap (phase-1 pk scan): ${(bootstrap.bytes / 1e6).toFixed(0)} MB, ${bootstrap.ms.toFixed(0)} ms`);

const out = { bootstrap, rates: [] };
for (const rate of RATES) {
  const w = await DeltaWriter.open(base, { unordered: true });
  const ref = new Map(feats.map(f => [f.id, { bbox: f.bbox, luokka: f.luokka }]));
  const ids = feats.map(f => f.id);
  const ops = Math.round(feats.length * rate);
  t0 = performance.now();
  for (let i = 0; i < ops; i++) {
    const r = rnd();
    if (r < 0.3) {                                   // new feature near the centre or anywhere
      const near = rnd() < 0.5;
      const x = near ? cx + (rnd() - 0.5) * 40000 : E.minx + rnd() * (E.maxx - E.minx);
      const y = near ? cy + (rnd() - 0.5) * 40000 : E.miny + rnd() * (E.maxy - E.miny);
      const p = polygon(x, y, 5 + rnd() * 25);
      const id = `new${i}`;
      w.upsert({ id, luokka: 'k0', vuosi: 2026, nimi: 'Uusi', bbox: p.bbox, avain: keyOf(p.bbox), geom: encodeParts([p.ring]) });
      ref.set(id, { bbox: p.bbox, luokka: 'k0' }); ids.push(id);
    } else {
      let id; do id = ids[Math.floor(rnd() * ids.length)]; while (!ref.has(id));
      if (r < 0.55) {                                // attribute change
        const l = `k${Math.floor(rnd() * 12)}`;
        w.patch(id, { luokka: l }); ref.get(id).luokka = l;
      } else if (r < 0.8) {                          // geometry moved by up to ~50 m
        const b = ref.get(id).bbox, dx = Math.round((rnd() - 0.5) * 100), dy = Math.round((rnd() - 0.5) * 100);
        const nb = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
        const ring = [[nb[0], nb[1]], [nb[2], nb[1]], [nb[2], nb[3]], [nb[0], nb[3]], [nb[0], nb[1]]];
        w.patch(id, { bbox: nb, avain: keyOf(nb), geom: encodeParts([ring]) });
        ref.get(id).bbox = nb;
      } else { w.delete(id); ref.delete(id); }
    }
  }
  const writeMs = performance.now() - t0;
  const json = JSON.stringify(w.toJSON());

  const lat = await new Reader(new LatencyTransport(path, { latencyMs: LAT, bandwidthMBs: 100 })).open();
  t0 = performance.now(); lat.applyDelta(JSON.parse(json)); const applyMs = performance.now() - t0;
  const cpu = await new Reader(path).open(); cpu.applyDelta(JSON.parse(json));
  const q = {};
  for (const [name, h] of Object.entries(views)) {
    const bb = [cx - h, cy - h, cx + h, cy + h];
    const body = { query: { geo_bounding_box: { bbox: { top_left: [bb[0], bb[3]], bottom_right: [bb[2], bb[1]] } } }, size: 2000000 };
    lat.clearCache(); lat.resetStats();
    let s = performance.now(); const res = await lat.search(body); const coldMs = performance.now() - s;
    const st = { ...lat.stats };
    let exp = 0; for (const v of ref.values()) if (meets(v.bbox, bb)) exp++;
    if (res.hits.total.value !== exp) { console.error(`MISMATCH ${rate} ${name}: ${res.hits.total.value} vs ${exp}`); process.exitCode = 1; }
    const agg = { query: body.query, size: 0, aggs: { l: { terms: { field: 'luokka', size: 20 } } } };
    const ares = await cpu.search(agg);
    const expL = {}; for (const v of ref.values()) if (meets(v.bbox, bb)) expL[v.luokka] = (expL[v.luokka] ?? 0) + 1;
    for (const b of ares.aggregations.l.buckets) if (b.doc_count !== expL[b.key]) { console.error(`AGG MISMATCH ${rate} ${name} ${b.key}`); process.exitCode = 1; }
    await cpu.search(body);
    const warm = []; for (let k = 0; k < 5; k++) { s = performance.now(); await cpu.search(body); warm.push(performance.now() - s); }
    warm.sort((a, b) => a - b);
    q[name] = { hits: res.hits.total.value, rounds: st.rounds, reads: st.reads, bytes: st.bytes, coldMs, warmMs: warm[2] };
  }
  await lat.close(); await cpu.close();
  const row = { rate, ops, writeMs, deltaBytes: json.length, deltaGz: gzipSync(json).length, applyMs, q };
  out.rates.push(row);
  console.log(JSON.stringify(row));
}
await base.close();
writeFileSync(S + '/l1-write-results.json', JSON.stringify(out, null, 1));
