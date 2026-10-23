import { Bitmap } from '../bitmap.js';
import { wildcardToRegExp } from '../format.js';

export function decodeSet(cat, name, buf) {
  return cat.sections[name].kind === 'ids'
    ? Bitmap.fromIdBytes(cat.docCount, buf)
    : Bitmap.fromBytes(cat.docCount, buf);
}

/**
 * Resolve a plan into byte ranges, using only the catalog. Nothing here does
 * I/O — that is the point: every address is computed from resident metadata, so
 * the fetches that follow are independent and cost one round trip (§14.3).
 */
export function planFetches(node, cat, out = new Map()) {
  switch (node.op) {
    case 'section': {
      const s = cat.sections[node.name];
      if (!s) throw new Error(`unknown section ${node.name}`);
      out.set(node.name, { offset: s.offset, length: s.length });
      break;
    }
    case 'column': {
      const m = cat.fields[node.field];
      const [posLo, posHi] = spanFor(m, node.lo, node.hi);
      node._span = [posLo, posHi];
      if (posHi < posLo) break;
      const n = posHi - posLo + 1;
      const v = cat.sections[m.sections.values];
      node._valuesKey = `${m.sections.values}@${posLo}:${posHi}`;
      out.set(node._valuesKey, { offset: v.offset + posLo * 8, length: n * 8 });
      if (!m.implicitDocs) {
        const d = cat.sections[m.sections.docs];
        node._docsKey = `${m.sections.docs}@${posLo}:${posHi}`;
        out.set(node._docsKey, { offset: d.offset + posLo * 4, length: n * 4 });
      }
      break;
    }
    case 'wildcard': {
      const m = cat.fields[node.field];
      node._gramKeys = node.grams.map(g => {
        const [rel, len] = m.trigrams[g];
        const key = `tri:${node.field}:${g}`;
        out.set(key, { offset: m.trigramBase + rel, length: len });
        return key;
      });
      const vs = cat.sections[m.sections.values];
      node._valuesKey = m.sections.values;
      out.set(node._valuesKey, { offset: vs.offset, length: vs.length });
      const ex = cat.sections[m.sections.exists];
      node._existsKey = m.sections.exists;
      out.set(node._existsKey, { offset: ex.offset, length: ex.length });
      break;
    }
    case 'and': case 'or': case 'xor':
      node.children.forEach(c => planFetches(c, cat, out)); break;
    case 'andNot':
      planFetches(node.left, cat, out); planFetches(node.right, cat, out); break;
    // The overlay adds nothing to the wave: its data is resident (§5.1, inline).
    case 'overlay': planFetches(node.inner, cat, out); break;
    case 'geobox': {
      // Granule choice is pure arithmetic on resident boxes; only the per-doc
      // boxes of the chosen granules are fetched, all in this one wave.
      const m = cat.fields[node.field];
      const sec = cat.sections[m.sections.bbox];
      const n = cat.baseDocCount ?? cat.docCount;
      node._spans = geoSpans(m, node.box, n);
      node._keys = node._spans.map(([d0, d1]) => {
        const key = `${m.sections.bbox}@${d0}:${d1}`;
        out.set(key, { offset: sec.offset + d0 * 32, length: (d1 - d0) * 32 });
        return key;
      });
      break;
    }
    default: break;
  }
  return out;
}

const _granuleCache = new WeakMap();
function granuleBoxes(m) {
  let gb = _granuleCache.get(m);
  if (!gb) {
    const raw = typeof Buffer !== 'undefined' ? Buffer.from(m.granuleBoxes, 'base64')
      : Uint8Array.from(atob(m.granuleBoxes), c => c.charCodeAt(0));
    gb = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    _granuleCache.set(m, gb);
  }
  return gb;
}

/**
 * Doc-ID spans [d0, d1) of the granules whose resident box meets the query box.
 * Neighbouring spans closer than `mergeGap` granules are joined: a few granules
 * of over-read cost less than one more request in the wave.
 */
function geoSpans(m, [x0, y0, x1, y1], n, mergeGap = 2) {
  const gb = granuleBoxes(m), G = m.granule, ng = gb.length / 4;
  const spans = [];
  for (let g = 0; g < ng; g++) {
    const b = g * 4;
    if (!(gb[b] <= x1 && gb[b + 2] >= x0 && gb[b + 1] <= y1 && gb[b + 3] >= y0)) continue;
    const d0 = g * G, d1 = Math.min(n, d0 + G);
    const last = spans[spans.length - 1];
    if (last && d0 - last[1] <= mergeGap * G) last[1] = d1; else spans.push([d0, d1]);
  }
  return spans;
}

/**
 * Conservative position span from the sparse index. One granule of slack on
 * each side covers duplicate values straddling a granule boundary — cheap
 * insurance, and exactly the over-fetch §13.2 says is free.
 */
function spanFor(m, lo, hi) {
  const sp = m.sparse;
  if (!sp || sp.length === 0 || m.count === 0) return [0, -1];

  // Values are non-decreasing with position, so:
  //   first match is at or after the granule BEFORE the first entry with value >= lo
  //   last  match is at or before the granule AFTER  the last  entry with value <= hi
  let kLo = -1;
  for (let k = 0; k < sp.length; k++) if (sp[k][0] >= lo) { kLo = k; break; }
  if (kLo === -1) return [0, -1];                       // every value is below lo

  let kHi = -1;
  for (let k = sp.length - 1; k >= 0; k--) if (sp[k][0] <= hi) { kHi = k; break; }
  if (kHi === -1) return [0, -1];                       // every value is above hi

  const posLo = sp[Math.max(kLo - 1, 0)][1];
  const posHi = sp[Math.min(kHi + 1, sp.length - 1)][1];
  return posHi < posLo ? [0, -1] : [posLo, Math.min(posHi, m.count - 1)];
}

export function evaluate(node, got, cat) {
  const n = cat.docCount;
  switch (node.op) {
    case 'all':  return Bitmap.full(n);
    case 'none': return Bitmap.empty(n);
    case 'section': return decodeSet(cat, node.name, got.get(node.name));
    case 'column': return evalColumn(node, got, cat);
    case 'wildcard': return evalWildcard(node, got, cat);
    case 'and': {
      const [a, ...r] = node.children;
      return r.reduce((acc, c) => acc.and(evaluate(c, got, cat)), evaluate(a, got, cat));
    }
    case 'or': {
      const [a, ...r] = node.children;
      return r.reduce((acc, c) => acc.or(evaluate(c, got, cat)), evaluate(a, got, cat));
    }
    case 'xor': {
      const [a, ...r] = node.children;
      return r.reduce((acc, c) => acc.xor(evaluate(c, got, cat)), evaluate(a, got, cat));
    }
    case 'andNot':
      return evaluate(node.left, got, cat).andNot(evaluate(node.right, got, cat));
    case 'geobox': {
      const bm = Bitmap.empty(n);
      const [x0, y0, x1, y1] = node.box;
      node._spans.forEach(([d0], i) => {
        const buf = got.get(node._keys[i]);
        for (let k = 0, d = d0; k + 32 <= buf.length; k += 32, d++) {
          // NaN (absent) fails every comparison, so it is never a hit.
          if (buf.readDoubleLE(k) <= x1 && buf.readDoubleLE(k + 16) >= x0 &&
              buf.readDoubleLE(k + 8) <= y1 && buf.readDoubleLE(k + 24) >= y0) bm.set(d);
        }
      });
      return bm;
    }
    case 'overlay': {
      const ov = cat._overlay;
      return evaluate(node.inner, got, cat).andNot(ov.dirty(node.field))
        .or(ov.scan(node.field, node.test));
    }
    default: throw new Error(`unknown plan op ${node.op}`);
  }
}

function evalColumn(node, got, cat) {
  const bm = Bitmap.empty(cat.docCount);
  const [posLo, posHi] = node._span ?? [0, -1];
  if (posHi < posLo) return bm;
  const m = cat.fields[node.field];
  const vbuf = got.get(node._valuesKey);
  const dbuf = m.implicitDocs ? null : got.get(node._docsKey);
  const n = posHi - posLo + 1;
  for (let k = 0; k < n; k++) {
    const v = vbuf.readDoubleLE(k * 8);
    if (node.loInc ? v < node.lo : v <= node.lo) continue;
    if (node.hiInc ? v > node.hi : v >= node.hi) continue;
    bm.set(m.implicitDocs ? posLo + k : dbuf.readUInt32LE(k * 4));
  }
  return bm;
}

function evalWildcard(node, got, cat) {
  const m = cat.fields[node.field];
  // Narrow by trigram intersection…
  let candidates = null;
  for (const key of node._gramKeys) {
    const buf = got.get(key);
    const bm = Bitmap.empty(cat.docCount);
    for (let o = 0; o + 4 <= buf.length; o += 4) bm.set(buf.readUInt32LE(o));
    candidates = candidates === null ? bm : candidates.and(bm);
  }
  if (candidates === null) candidates = decodeSet(cat, node._existsKey, got.get(node._existsKey));

  // …then verify exactly against the stored values. Trigram AND is a superset:
  // it ignores gram order, so "abcabc" matches patterns it should not.
  const vbuf = got.get(node._valuesKey);
  const re = wildcardToRegExp(node.pattern);
  const out = Bitmap.empty(cat.docCount);
  // The values table belongs to the base artifact; with a delta applied the doc-ID
  // space is larger than the table, and docs past it are answered by the overlay.
  const tableLen = 4 * ((cat.baseDocCount ?? cat.docCount) + 1);
  for (const docId of candidates.page(0, cat.docCount)) {
    const s = vbuf.readUInt32LE(docId * 4);
    const e = vbuf.readUInt32LE((docId + 1) * 4);
    if (e <= s && node.pattern !== '') continue;
    if (re.test(vbuf.subarray(tableLen + s, tableLen + e).toString('utf8'))) out.set(docId);
  }
  return out;
}
