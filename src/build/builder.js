import { writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Bitmap } from '../bitmap.js';
import { MAGIC, FOOTER_LEN, FORMAT_VERSION, DEFAULT_BLOCK_SIZE, DEFAULT_GRANULE, S, trigrams } from '../format.js';

const DEFAULT_KEYWORD_MAX_CARDINALITY = 256;

function f64(values) {
  const b = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => b.writeDoubleLE(v, i * 8));
  return b;
}
function u32(values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32LE(v, i * 4));
  return b;
}

/** Infer a field's indexing strategy from the data (§13.6: chosen, not declared). */
function inferTypes(docs, keywordMax = DEFAULT_KEYWORD_MAX_CARDINALITY) {
  const seen = new Map();
  for (const d of docs) {
    for (const [k, v] of Object.entries(d)) {
      if (k === 'id' || v === null || v === undefined) continue;
      if (v instanceof Uint8Array) continue;          // binary payload, never indexed
      let e = seen.get(k);
      if (!e) seen.set(k, e = { kinds: new Set(), distinct: new Set() });
      e.kinds.add(typeof v);
      if (e.distinct.size <= keywordMax + 1) e.distinct.add(v);
    }
  }
  const types = {};
  for (const [k, e] of seen) {
    if (e.kinds.size !== 1) continue;                       // mixed types: skip
    const [kind] = e.kinds;
    if (kind === 'boolean') types[k] = 'boolean';
    else if (kind === 'number') types[k] = 'numeric';
    else if (kind === 'string') types[k] = e.distinct.size <= keywordMax ? 'keyword' : 'text';
  }
  return types;
}

export async function build({
  docs, index = 'docs', clusteringField = 'createdAt',
  blockSize = DEFAULT_BLOCK_SIZE, granule = DEFAULT_GRANULE, outPath, fieldTypes,
  keywordMaxCardinality = DEFAULT_KEYWORD_MAX_CARDINALITY,
  indexFields, storedFields,
  // Fields holding a bounding box [minx, miny, maxx, maxy]. Indexed for
  // geo_bounding_box (intersection), never stored: the geometry is the payload.
  bboxFields = [],
}) {
  // ---- 1. Clustering order: doc IDs ascend with the clustering key (§2) ----
  const ordered = [...docs].sort((a, b) => {
    const av = a[clusteringField], bv = b[clusteringField];
    if (av === bv) return String(a.id).localeCompare(String(b.id));
    return av < bv ? -1 : 1;
  });
  const docCount = ordered.length;
  const types = { ...inferTypes(ordered, keywordMaxCardinality), ...(fieldTypes ?? {}) };
  // Stored and indexed are different jobs. A numeric column costs 12 B per
  // document that carries the field — on topographic data that was ~100 B/doc,
  // as much as the entire payload, for fields nobody queries: a building's
  // orientation in degrees has to be DRAWN, never range-scanned. An allow-list
  // keeps those out of the index while leaving them in the stored record.
  if (indexFields) {
    const keep = new Set([...indexFields, clusteringField]);
    for (const f of Object.keys(types)) if (!keep.has(f)) delete types[f];
  }

  const chunks = [];
  let offset = 0;
  const sections = {};
  const putBM = (name, bm) => { const e = bm.encode(); return put(name, e.buf, { kind: e.kind }); };
  const put = (name, buf, meta = {}) => {
    sections[name] = { offset, length: buf.length, ...meta };
    chunks.push(buf); offset += buf.length;
    return sections[name];
  };

  const fields = {};

  // ---- 2. Stage A: booleans -----------------------------------------------
  for (const [f, t] of Object.entries(types)) {
    if (t !== 'boolean') continue;
    const tb = Bitmap.empty(docCount), eb = Bitmap.empty(docCount);
    ordered.forEach((d, i) => {
      if (d[f] === undefined || d[f] === null) return;
      eb.set(i);
      if (d[f] === true) tb.set(i);
    });
    putBM(S.boolTrue(f), tb);
    putBM(S.exists(f), eb);
    fields[f] = { type: 'boolean', sections: { true: S.boolTrue(f), exists: S.exists(f) },
                  stats: { trueCount: tb.popcount(), existsCount: eb.popcount() } };
  }

  // ---- 3. Stage A′/B: numeric & date columns ------------------------------
  for (const [f, t] of Object.entries(types)) {
    if (t !== 'numeric') continue;
    const pairs = [];
    const eb = Bitmap.empty(docCount);
    ordered.forEach((d, i) => {
      const v = d[f];
      if (v === undefined || v === null) return;
      eb.set(i); pairs.push([v, i]);
    });
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const values = pairs.map(p => p[0]), dids = pairs.map(p => p[1]);

    putBM(S.exists(f), eb);
    put(S.colValues(f), f64(values));
    put(S.colDocs(f), u32(dids));

    // Sparse index over POSITIONS, not values (§12.8) — bounds the fetch span.
    const sparse = [];
    for (let p = 0; p < values.length; p += granule) sparse.push([values[p], p]);
    if (values.length) sparse.push([values[values.length - 1], values.length - 1]);

    fields[f] = {
      type: 'numeric',
      clustering: f === clusteringField,
      sections: { exists: S.exists(f), values: S.colValues(f), docs: S.colDocs(f) },
      granule, count: values.length, sparse,
      // For the clustering field with no gaps, sorted position == document ID,
      // so the docs array is implicit and need never be fetched (§2).
      implicitDocs: f === clusteringField && eb.popcount() === docCount,
      stats: { min: values[0] ?? null, max: values[values.length - 1] ?? null, existsCount: eb.popcount() },
    };
  }

  // ---- 4. Stage B: keyword strings (bitmap per value) ---------------------
  for (const [f, t] of Object.entries(types)) {
    if (t !== 'keyword') continue;
    const byValue = new Map(); const eb = Bitmap.empty(docCount);
    ordered.forEach((d, i) => {
      const v = d[f];
      if (v === undefined || v === null) return;
      eb.set(i);
      if (!byValue.has(v)) byValue.set(v, Bitmap.empty(docCount));
      byValue.get(v).set(i);
    });
    putBM(S.exists(f), eb);
    const values = {};
    for (const v of [...byValue.keys()].sort()) {
      const name = S.keyword(f, v);
      putBM(name, byValue.get(v));
      values[v] = { section: name, count: byValue.get(v).popcount() };
    }
    fields[f] = { type: 'keyword', sections: { exists: S.exists(f) }, values,
                  stats: { cardinality: byValue.size, existsCount: eb.popcount() } };
  }

  // ---- 5. Stage C: text (trigram postings + values for verification) ------
  for (const [f, t] of Object.entries(types)) {
    if (t !== 'text') continue;
    const eb = Bitmap.empty(docCount);
    const posting = new Map();
    const vals = new Array(docCount).fill('');
    ordered.forEach((d, i) => {
      const v = d[f];
      if (v === undefined || v === null) return;
      eb.set(i); vals[i] = String(v);
      for (const g of trigrams(v)) {
        if (!posting.has(g)) posting.set(g, []);
        posting.get(g).push(i);
      }
    });
    putBM(S.exists(f), eb);

    // values section: [u32 offset table][utf8 payloads] — fetched whole when a
    // wildcard needs exact verification (see README on scaling).
    const payloads = vals.map(v => Buffer.from(v, 'utf8'));
    const table = Buffer.alloc(4 * (docCount + 1));
    let p = 0;
    payloads.forEach((b, i) => { table.writeUInt32LE(p, i * 4); p += b.length; });
    table.writeUInt32LE(p, docCount * 4);
    put(S.textValues(f), Buffer.concat([table, ...payloads]));

    // trigram postings: one blob, per-trigram ranges in the catalog (the
    // catalog is the resident navigator — §12.3).
    const grams = [...posting.keys()].sort();
    const parts = []; let rel = 0; const map = {};
    for (const g of grams) {
      const buf = u32(posting.get(g));
      map[g] = [rel, buf.length];
      parts.push(buf); rel += buf.length;
    }
    const tri = put(S.trigrams(f), Buffer.concat(parts));
    fields[f] = {
      type: 'text',
      sections: { exists: S.exists(f), values: S.textValues(f), trigrams: S.trigrams(f) },
      trigramBase: tri.offset, trigrams: map,
      stats: { distinctTrigrams: grams.length, existsCount: eb.popcount() },
    };
  }

  // ---- 5b. bounding boxes (geo_bounding_box) -------------------------------
  // A bbox column in DOCUMENT order (f64 x 4 per doc, NaN when absent): the
  // address of any document's box is arithmetic, like a bitmap's bit. Beside it,
  // one box per granule of the clustering order, resident in the catalog — the
  // lowest inner level of an R-tree, kept in memory so that choosing granules
  // costs no I/O. A feature is found when its BOX meets the query box, not only
  // its centre, which is what a Hilbert key alone cannot promise.
  for (const f of bboxFields) {
    const col = Buffer.alloc(docCount * 32);
    const eb = Bitmap.empty(docCount);
    const ng = Math.ceil(docCount / granule);
    const gb = new Float32Array(ng * 4).fill(NaN);
    ordered.forEach((d, i) => {
      const b = d[f];
      const ok = Array.isArray(b) && b.length === 4 && b.every(Number.isFinite);
      for (let j = 0; j < 4; j++) col.writeDoubleLE(ok ? b[j] : NaN, i * 32 + j * 8);
      if (!ok) return;
      eb.set(i);
      const g = Math.floor(i / granule) * 4;
      // float32 rounded OUTWARD: a granule box may only ever be too large.
      const lo = v => { const x = Math.fround(v); return x > v ? nextDown32(x) : x; };
      const hi = v => { const x = Math.fround(v); return x < v ? nextUp32(x) : x; };
      if (Number.isNaN(gb[g])) { gb[g] = lo(b[0]); gb[g + 1] = lo(b[1]); gb[g + 2] = hi(b[2]); gb[g + 3] = hi(b[3]); }
      else {
        gb[g] = Math.min(gb[g], lo(b[0])); gb[g + 1] = Math.min(gb[g + 1], lo(b[1]));
        gb[g + 2] = Math.max(gb[g + 2], hi(b[2])); gb[g + 3] = Math.max(gb[g + 3], hi(b[3]));
      }
    });
    putBM(S.exists(f), eb);
    put(S.geoBox(f), col);
    fields[f] = {
      type: 'geo_bbox', granule,
      sections: { exists: S.exists(f), bbox: S.geoBox(f) },
      granuleBoxes: Buffer.from(gb.buffer).toString('base64'),
      stats: { existsCount: eb.popcount() },
    };
  }

  // ---- 6. stored fields ---------------------------------------------------
  // A binary value rides BESIDE the JSON, not inside it. Base64 would add a third
  // to the largest component of a geometry artifact, and geometry is the payload
  // there — so the record is `u32 jsonLen | json | (u32 len | bytes) per field`.
  // An artifact with no binary field keeps the old plain-JSON record, so readers
  // and older artifacts stay compatible.
  // Indexed and stored are now independent. A clustering key, a collection tag
  // and a centroid all have to exist for the BUILD, but none of them has to be
  // kept in the record: the position is the id, the catalog maps positions to key
  // ranges, the collection is in the key's high bits and the centroid is in the
  // geometry. Measured on one map sheet those four fields were 65% of the
  // attribute bytes — all of it duplication I had introduced myself.
  const storedSet = storedFields ? new Set(storedFields) : null;
  const bboxSet = new Set(bboxFields);
  const isStored = k => !bboxSet.has(k) && (!storedSet || storedSet.has(k));

  const binarySet = new Set();
  for (const d of ordered) for (const [k, v] of Object.entries(d))
    if (v instanceof Uint8Array && isStored(k)) binarySet.add(k);
  const binaryFields = [...binarySet].sort();
  const ABSENT = 0xffffffff;

  // Field names are the single largest cost in a stored record: measured on the
  // national topographic data they were 77% of the attribute bytes and 53% of the
  // whole payload, because eight small integers carry eight long keys on every
  // one of millions of features. So the names live ONCE, in a schema table in the
  // catalog, and a record names its schema by id and then gives values in order.
  // Documents here are heterogeneous — one artifact holds many feature classes —
  // so there is a schema per distinct field set, not one for the artifact.
  // An absent field is absent, as JSON.stringify always treated undefined — so a
  // shape is the set of keys actually carried.
  const shapeKey = d => {
    const ks = [];
    for (const k of Object.keys(d))
      if (d[k] !== undefined && isStored(k) && !(d[k] instanceof Uint8Array)) ks.push(k);
    ks.sort();
    return ks;
  };
  let schemas = [], schemaOf = new Map();
  for (const d of ordered) {
    const ks = shapeKey(d), key = ks.join('\u0000');
    if (!schemaOf.has(key)) { schemaOf.set(key, schemas.length); schemas.push(ks); }
  }
  // Sparse data can produce a shape per combination of optional fields — twenty
  // optional fields is a million shapes in the worst case, which would move the
  // cost from the records into the catalog. Past a threshold, collapse to one
  // schema over the union of fields and mark the gaps instead.
  let unionSchema = null;
  if (schemas.length > 1024) {
    const all = new Set();
    for (const ks of schemas) for (const k of ks) all.add(k);
    unionSchema = [...all].sort();
    schemas = [unionSchema];
    schemaOf = null;
  }

  // Values stay self-describing per value: a tag byte then the payload. Inferring
  // a fixed type per column would save the tag, but a single stray null or mixed
  // type would then corrupt a record silently, which is the one failure this
  // format must not have.
  const T = { NULL: 0, INT: 1, DOUBLE: 2, STRING: 3, TRUE: 4, FALSE: 5, ABSENT: 6 };
  const putVarint = (out, n) => { let z = ((n << 1) ^ (n >> 31)) >>> 0;
    while (z > 0x7f) { out.push((z & 0x7f) | 0x80); z >>>= 7; } out.push(z); };
  const putUvarint = (out, n) => { let z = n >>> 0;
    while (z > 0x7f) { out.push((z & 0x7f) | 0x80); z >>>= 7; } out.push(z); };

  const encodeDoc = d => {
    const ks = unionSchema ?? shapeKey(d);
    const sid = unionSchema ? 0 : schemaOf.get(ks.join('\u0000'));
    const out = [];
    putUvarint(out, sid);
    for (const k of ks) {
      const v = d[k];
      if (v === undefined) { out.push(T.ABSENT); continue; }
      if (v === null) { out.push(T.NULL); continue; }
      if (v === true) { out.push(T.TRUE); continue; }
      if (v === false) { out.push(T.FALSE); continue; }
      if (typeof v === 'number') {
        if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) { out.push(T.INT); putVarint(out, v); }
        else { out.push(T.DOUBLE); const b = Buffer.alloc(8); b.writeDoubleLE(v, 0);
               for (const x of b) out.push(x); }
        continue;
      }
      const b = Buffer.from(String(v), 'utf8');
      out.push(T.STRING); putUvarint(out, b.length);
      for (const x of b) out.push(x);
    }
    const body = Buffer.from(out);
    if (binaryFields.length === 0) return body;
    const parts = [body];
    for (const f of binaryFields) {
      const v = d[f], n = Buffer.alloc(4);
      if (v instanceof Uint8Array) {
        n.writeUInt32LE(v.length, 0);
        parts.push(n, Buffer.from(v.buffer, v.byteOffset, v.length));
      } else { n.writeUInt32LE(ABSENT, 0); parts.push(n); }
    }
    return Buffer.concat(parts);
  };

  const blocks = [];
  for (let start = 0; start < docCount; start += blockSize) {
    const slice = ordered.slice(start, start + blockSize);
    const payloads = slice.map(encodeDoc);
    const header = Buffer.alloc(4 + 4 * payloads.length);
    header.writeUInt32LE(payloads.length, 0);
    let p = 0;
    payloads.forEach((b, i) => { header.writeUInt32LE(p, 4 + i * 4); p += b.length; });
    const block = Buffer.concat([header, ...payloads]);
    blocks.push({ offset, length: block.length, firstDoc: start, count: slice.length });
    chunks.push(block); offset += block.length;
  }

  // ---- 7. catalog + footer ------------------------------------------------
  const hasher = createHash('sha256');
  for (const c of chunks) hasher.update(c);
  const contentHash = hasher.digest('hex').slice(0, 16);
  const clusteringMeta = fields[clusteringField];
  const catalog = {
    formatVersion: FORMAT_VERSION, index, version: 1,
    contentHash,
    docCount,
    clustering: {
      field: clusteringField, direction: 'asc',
      // A′ boundary table: doc-ID interval for a clustering range, zero probes.
      boundaries: buildBoundaries(ordered, clusteringField, granule),
    },
    capabilities: capabilitiesOf(fields),
    fields, sections,
    stored: { blockSize, blocks, schemas, ...(binaryFields.length ? { binaryFields } : {}) },
  };
  void clusteringMeta;
  const catBuf = Buffer.from(JSON.stringify(catalog), 'utf8');
  const footer = Buffer.alloc(FOOTER_LEN);
  MAGIC.copy(footer, 0);
  footer.writeUInt32LE(offset, 8);
  footer.writeUInt32LE(catBuf.length, 12);

  const totalBytes = offset + catBuf.length + footer.length;
  if (outPath) {
    // Stream the chunks rather than concatenating: at multi-GB artifact sizes a
    // single Buffer.concat needs twice the artifact in RAM and simply fails.
    await pipeline(Readable.from([...chunks, catBuf, footer]), createWriteStream(outPath));
    return { catalog, bytes: totalBytes };
  }
  return { file: Buffer.concat([...chunks, catBuf, footer]), catalog, bytes: totalBytes };
}

const f32 = new Float32Array(1), u32v = new Uint32Array(f32.buffer);
function nextUp32(x) { f32[0] = x; if (x >= 0) u32v[0]++; else u32v[0]--; return f32[0]; }
function nextDown32(x) { f32[0] = x; if (x > 0) u32v[0]--; else if (x === 0) { f32[0] = -1e-45; return f32[0]; } else u32v[0]++; return f32[0]; }

/** [value, docId] every `granule` documents, in clustering order (§2). */
function buildBoundaries(ordered, field, granule) {
  const out = [];
  for (let i = 0; i < ordered.length; i += granule) out.push([ordered[i][field], i]);
  if (ordered.length) out.push([ordered[ordered.length - 1][field], ordered.length - 1]);
  return out;
}

function capabilitiesOf(fields) {
  const caps = new Set(['stored_fields', 'cursor_pagination', 'exact_count', 'sort_interval']);
  for (const [f, m] of Object.entries(fields)) {
    if (m.type === 'boolean') caps.add('bitmap:boolean');
    if (m.type === 'numeric') caps.add(`column:${f}`);
    if (m.type === 'keyword') caps.add(`bitmap:${f}`);
    if (m.type === 'text') caps.add(`trigram:${f}`);
    if (m.type === 'geo_bbox') caps.add(`geo_bbox:${f}`);
  }
  return [...caps];
}
