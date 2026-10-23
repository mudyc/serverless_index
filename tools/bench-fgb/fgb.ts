// Build an INDEXED FlatGeobuf (packed Hilbert R-tree, node size 16) from the
// shared points and query it with FlatGeobuf's own HttpReader over a simulated
// latency range client. The JS writer in the repo writes no index, so the tree
// is built here following the spec; correctness is checked against brute force.
// Run with bun from a FlatGeobuf source checkout (its src/ts), e.g.
//   FGB_SRC=/path/to/flatgeobuf/src/ts bun run fgb.ts <dataDir> 30 points|poly
const F = process.env.FGB_SRC;
if (!F) throw new Error('set FGB_SRC to flatgeobuf/src/ts');
const flatbuffers: any = await import(Bun.resolveSync('flatbuffers', F));
const geojson: any = await import(F + '/geojson.ts');
const { HttpReader } = await import(F + '/http-reader.ts');
const { fromByteBuffer } = await import(F + '/header-meta.ts');
const { Header } = await import(F + '/flat-geobuf/header.ts');
const { Column } = await import(F + '/flat-geobuf/column.ts');
const { generateLevelBounds, calcTreeSize, NODE_ITEM_BYTE_LEN } = await import(F + '/packedrtree.ts');
const { magicbytes, SIZE_PREFIX_LEN } = await import(F + '/constants.ts');
const { xy2d } = await import('../../src/hilbert.js');
import { readFileSync, writeFileSync } from 'node:fs';

console.debug = () => {};
const S = process.argv[2];
const MODE = process.argv[4] ?? 'points';
const data = JSON.parse(readFileSync(S + (MODE === 'poly' ? '/poly.json' : '/pts.json'), 'utf8'));
const E = data.extent;
// every item gets a bbox; points have a degenerate one
const pts = MODE === 'poly' ? data.feats : data.pts.map((p: any) => ({ ...p, bbox: [p.x, p.y, p.x, p.y] }));
const geomOf = (p: any) => MODE === 'poly' ? { type: 'Polygon', coordinates: [p.ring] } : { type: 'Point', coordinates: [p.x, p.y] };
const Q = JSON.parse(readFileSync(new URL('./queries.json', import.meta.url), 'utf8'));
const LAT = Number(process.argv[3] ?? 30), BW = 100e6;   // 30 ms per request, 100 MB/s per connection
const NODE = 16;

// ---- build ---------------------------------------------------------------
let t0 = performance.now();
const H = (1 << 16) - 1;
const hk = (p: any) => { const x = (p.bbox[0] + p.bbox[2]) / 2, y = (p.bbox[1] + p.bbox[3]) / 2;
  return xy2d(16, Math.round((x - E.minx) / (E.maxx - E.minx) * H), Math.round((y - E.miny) / (E.maxy - E.miny) * H)); };
// CLASSED=1: size class first, then Hilbert (keeps large boxes out of small nodes)
const sizeClass = (p: any) => { const e = Math.max(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]); return e < 100 ? 0 : e < 2000 ? 1 : 2; };
const CLASSED = process.env.CLASSED === '1';
const sorted = pts.map((p: any) => [(CLASSED ? sizeClass(p) * 2 ** 32 : 0) + hk(p), p]).sort((a: any, b: any) => a[0] - b[0]).map((x: any) => x[1]);
const fc = { type: 'FeatureCollection', features: sorted.map((p: any) => ({ type: 'Feature',
  geometry: geomOf(p), properties: { id: p.id, luokka: p.luokka, vuosi: p.vuosi, nimi: p.nimi } })) };
const flat = geojson.serialize(fc as any);
const dv = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
const hLen = dv.getUint32(8, true);
const hm = fromByteBuffer(new flatbuffers.ByteBuffer(flat.subarray(8)));
const featStart = 8 + SIZE_PREFIX_LEN + hLen;
const features = flat.subarray(featStart);
const offsets: number[] = [];
for (let o = 0; o < features.length;) { offsets.push(o); o += SIZE_PREFIX_LEN + new DataView(features.buffer, features.byteOffset + o, 4).getUint32(0, true); }
if (offsets.length !== sorted.length) throw new Error('feature walk mismatch');

// header with index node size and envelope (the library's buildHeader writes 0)
const b = new flatbuffers.Builder();
const cols = Header.createColumnsVector(b, hm.columns!.map(c => { const n = b.createString(c.name);
  Column.startColumn(b); Column.addName(b, n); Column.addType(b, c.type); Column.addNullable(b, true); return Column.endColumn(b); }));
const env = Header.createEnvelopeVector(b, [E.minx, E.miny, E.maxx, E.maxy]);
const name = b.createString('bench');
Header.startHeader(b);
Header.addFeaturesCount(b, BigInt(sorted.length)); Header.addGeometryType(b, hm.geometryType);
Header.addIndexNodeSize(b, NODE); Header.addColumns(b, cols); Header.addEnvelope(b, env); Header.addName(b, name);
b.finishSizePrefixed(Header.endHeader(b));
const header = b.asUint8Array();

// packed Hilbert R-tree: storage top-down, leaves last
const n = sorted.length;
const levels = generateLevelBounds(n, NODE);
const total = levels.at(-1)![1] > levels[0][1] ? levels.at(-1)![1] : levels[0][1];
const numNodes = calcTreeSize(n, NODE) / NODE_ITEM_BYTE_LEN;
const box = new Float64Array(numNodes * 4), off = new BigUint64Array(numNodes);
const [leafStart] = levels[0];
sorted.forEach((p: any, i: number) => { const k = leafStart + i; box.set(p.bbox, k * 4); off[k] = BigInt(offsets[i]); });
for (let l = 1; l < levels.length; l++) {
  const [cs, ce] = levels[l - 1], [ps] = levels[l];
  for (let c = cs, p = ps; c < ce; c += NODE, p++) {
    let a = Infinity, bb = Infinity, cc = -Infinity, d = -Infinity;
    for (let k = c; k < Math.min(c + NODE, ce); k++) {
      a = Math.min(a, box[k * 4]); bb = Math.min(bb, box[k * 4 + 1]); cc = Math.max(cc, box[k * 4 + 2]); d = Math.max(d, box[k * 4 + 3]);
    }
    box.set([a, bb, cc, d], p * 4); off[p] = BigInt(c);
  }
}
const tree = new Uint8Array(numNodes * NODE_ITEM_BYTE_LEN); const tv = new DataView(tree.buffer);
for (let k = 0; k < numNodes; k++) { for (let j = 0; j < 4; j++) tv.setFloat64(k * 40 + j * 8, box[k * 4 + j], true); tv.setBigUint64(k * 40 + 32, off[k], true); }
const file = new Uint8Array(8 + header.length + tree.length + features.length);
file.set(magicbytes); file.set(header, 8); file.set(tree, 8 + header.length); file.set(features, 8 + header.length + tree.length);
writeFileSync(S + `/bench-${MODE}.fgb`, file);
const buildMs = performance.now() - t0;

// ---- range client with simulated latency ----------------------------------
class SimClient {
  stats = { requests: 0, rounds: 0, bytes: 0 }; inflight = 0;
  async getRange(begin: number, length: number) {
    if (this.inflight === 0) this.stats.rounds++;           // nothing in flight: a new dependent round
    this.inflight++; this.stats.requests++; this.stats.bytes += length;
    await new Promise(r => setTimeout(r, LAT + length / BW * 1000));
    this.inflight--;
    return file.buffer.slice(file.byteOffset + begin, file.byteOffset + begin + length);
  }
}

const [cx, cy] = Q.center;
const rects: Record<string, any> = {};
for (const [k, h] of Object.entries(Q.boxes)) rects[k] = h === null
  ? { minX: E.minx, minY: E.miny, maxX: E.maxx, maxY: E.maxy }
  : { minX: cx - (h as number), minY: cy - (h as number), maxX: cx + (h as number), maxY: cy + (h as number) };

const results: any = { format: 'FlatGeobuf (packed Hilbert R-tree, node 16)', bytes: file.length,
  treeBytes: tree.length, buildMs, queries: {} };
const run = async (label: string, rect: any, filter?: (props: any) => boolean, agg = false) => {
  const c = new SimClient(); const s = performance.now();
  const r = await HttpReader.openSource(c as any);
  let hits = 0, kept = 0; const counts: Record<string, number> = {};
  for await (const f of r.selectBbox(rect)) {
    hits++;
    const g = f.feature.geometry()!; g.xyArray();           // touch the geometry, as a renderer would
    kept++;
  }
  results.queries[label] = { hits, kept, ...c.stats, ms: performance.now() - s };
};

// brute-force check of the index
for (const [label, rect] of Object.entries(rects)) {
  const exp = pts.filter((p: any) => p.bbox[0] <= rect.maxX && p.bbox[2] >= rect.minX && p.bbox[1] <= rect.maxY && p.bbox[3] >= rect.minY).length;
  await run(label, rect);
  const got = results.queries[label];
  if (got.kept !== exp) throw new Error(`${label}: FGB returned ${got.kept}, brute force ${exp}`);
  got.expected = exp;
}
writeFileSync(S + `/fgb-${MODE}${CLASSED ? '-classed' : ''}-results.json`, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
