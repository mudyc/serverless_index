import { decodeDoc } from './codec.js';

/**
 * L1 phase 1 writer: turns insert / update / delete operations into an absolute
 * delta against one base artifact (docs/l1-malli.md §5, §7).
 *
 * Phase 1 shortcuts, each named so the measurements are read honestly:
 *  - pk → docId comes from one scan of the base's stored fields at open().
 *    The model puts a paged pk dictionary in the artifact (§4); until it exists
 *    the scan is a one-off writer cost, reported by `bootstrap`.
 *  - old values come from the stored record, not from forward columns (§6).
 *  - the whole delta is inline. Diff blocks in packs and COW pages are phase 2.
 */
/** Binary values (geometry) travel in the JSON delta as { $b64 }. */
function encodeDoc(doc) {
  let out = null;
  for (const [k, v] of Object.entries(doc)) {
    if (v instanceof Uint8Array) {
      out ??= { ...doc };
      out[k] = { $b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
    }
  }
  return out ?? doc;
}

export class L1OrderError extends Error {
  constructor(message) { super(message); this.name = 'L1OrderError'; }
}

const same = (a, b) => Object.is(a, b) ||
  (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' &&
   JSON.stringify(a) === JSON.stringify(b));

export class DeltaWriter {
  /**
   * @param reader  an opened Reader on the base artifact (any delta on it is ignored)
   * @param delta   optional delta to continue from (same base)
   */
  static async open(reader, { delta = null, pkField = 'id', unordered = false } = {}) {
    const w = new DeltaWriter(reader, pkField);
    // A spatial clustering key has no "tail": a new feature lands anywhere. With
    // `unordered`, appends may break the clustering order. Filters and
    // geo_bounding_box stay exact; ordering by the clustering key does not, so
    // the reader refuses it until compaction restores the order.
    w.unordered = unordered;
    w.outOfOrder = false;
    await w._bootstrap();
    if (delta) { w._load(delta); w.outOfOrder = !!delta.unordered; }
    return w;
  }

  constructor(reader, pkField) {
    this.reader = reader;
    this.base = reader.baseCatalog;
    this.pkField = pkField;
    this.cf = this.base.clustering.field;
    this.baseN = this.base.docCount;
    this.N = this.baseN;
    this.seq = 0;
    this.deleted = new Set();
    this.docs = new Map();          // docId -> current doc (touched, live)
    this.baseDocs = new Map();      // docId -> original base doc (for dirty diffs)
    this.dirty = new Map();         // field -> Set(docId), base docs only
    this.pk = new Map();            // pk -> docId (live)
    this.tail = null;               // [clusteringValue, pk] of the last doc in order
  }

  async _bootstrap() {
    const r = this.reader;
    const saved = { overlay: r.overlay, catalog: r.catalog };
    r.overlay = null; r.catalog = this.base;
    const before = { ...r.stats };
    const ids = Array.from({ length: this.baseN }, (_, i) => i);
    const docs = await r._fetchStored(ids);
    this.bootstrap = { docs: docs.length, bytes: r.stats.bytes - before.bytes,
                       reads: r.stats.reads - before.reads };
    r.overlay = saved.overlay; r.catalog = saved.catalog;
    docs.forEach((d, i) => {
      this.baseDocs.set(i, d);
      this.pk.set(String(d[this.pkField]), i);
    });
    const last = docs.at(-1);
    if (last) this.tail = [last[this.cf], String(last[this.pkField])];
  }

  _load(delta) {
    if (delta.base !== this.base.contentHash) throw new Error('delta is for another base');
    this.N = delta.docCount;
    this.seq = delta.seq;
    for (const d of delta.deleted) {
      this.deleted.add(d);
      if (d < this.baseN) this.pk.delete(String(this.baseDocs.get(d)[this.pkField]));
    }
    for (const [d, raw] of delta.docs) {
      const doc = decodeDoc(raw);
      this.docs.set(d, doc);
      this.pk.set(String(doc[this.pkField]), d);
    }
    for (const [f, ids] of Object.entries(delta.dirty ?? {})) this.dirty.set(f, new Set(ids));
    for (let d = this.N - 1; d >= this.baseN; d--) {
      const doc = this.docs.get(d);
      if (doc) { this.tail = [doc[this.cf], String(doc[this.pkField])]; break; }
    }
  }

  current(pk) {
    const d = this.pk.get(String(pk));
    if (d === undefined) return undefined;
    return this.docs.get(d) ?? this.baseDocs.get(d);
  }

  /** Insert, or replace the whole document if the pk exists. */
  upsert(doc, seq) {
    if (this._skip(seq)) return;
    const pk = String(doc[this.pkField]);
    const d = this.pk.get(pk);
    if (d === undefined) this._append(doc);
    else this._replace(d, doc);
  }

  /** Partial update; a field set to undefined is removed. */
  patch(pk, fields, seq) {
    if (this._skip(seq)) return;
    const d = this.pk.get(String(pk));
    if (d === undefined) throw new Error(`patch: no document with ${this.pkField}=${pk}`);
    const next = { ...(this.docs.get(d) ?? this.baseDocs.get(d)) };
    for (const [k, v] of Object.entries(fields)) {
      if (k === this.pkField) throw new Error('patch cannot change the primary key');
      if (v === undefined) delete next[k]; else next[k] = v;
    }
    this._replace(d, next);
  }

  delete(pk, seq) {
    if (this._skip(seq)) return;
    const d = this.pk.get(String(pk));
    if (d === undefined) return;                         // idempotent
    this._kill(d);
  }

  /** Operations at or below the applied seq are re-deliveries (§7): skip them. */
  _skip(seq) {
    if (seq === undefined) { this.seq++; return false; }
    if (seq <= this.seq) return true;
    this.seq = seq;
    return false;
  }

  _kill(d) {
    this.deleted.add(d);
    const doc = this.docs.get(d) ?? this.baseDocs.get(d);
    this.pk.delete(String(doc[this.pkField]));
    this.docs.delete(d);
    for (const s of this.dirty.values()) s.delete(d);
  }

  _replace(d, next) {
    const prev = this.docs.get(d) ?? this.baseDocs.get(d);
    if (!same(prev[this.cf], next[this.cf])) {
      // Phase 1 reads old values from the stored record, and bbox fields are
      // indexed but not stored: a document moved to a new doc ID must carry its
      // box explicitly, or it would silently drop out of geo_bounding_box.
      for (const [f, m] of Object.entries(this.base.fields))
        if (m.type === 'geo_bbox' && !(f in next))
          throw new Error(`moving ${this.pkField}=${next[this.pkField]}: include [${f}] in the update ` +
            `(indexed, not stored; forward columns are phase 3)`);
      // The clustering key decides the doc ID (§5.3): moving it is delete + append.
      this._checkOrder(next);
      this._kill(d);
      this._append(next);
      return;
    }
    if (d >= this.baseN) { this.docs.set(d, next); return; }
    // Dirty is absolute: relative to the BASE value, not to the previous delta.
    const orig = this.baseDocs.get(d);
    const fields = new Set([...Object.keys(orig), ...Object.keys(next)]);
    let any = false;
    for (const f of fields) {
      let s = this.dirty.get(f);
      if (!same(orig[f], next[f])) {
        if (!s) this.dirty.set(f, s = new Set());
        s.add(d); any = true;
      } else s?.delete(d);
    }
    if (any) this.docs.set(d, next); else this.docs.delete(d);
  }

  _checkOrder(doc) {
    const v = doc[this.cf];
    if (typeof v !== 'number') throw new L1OrderError(`clustering key [${this.cf}] must be a number`);
    if (!this.tail) return;
    const [tv, tpk] = this.tail;
    const pk = String(doc[this.pkField]);
    if (v > tv || (v === tv && pk.localeCompare(tpk) > 0)) return;
    if (this.unordered) { this.outOfOrder = true; return; }
    throw new L1OrderError(
      `[${this.cf}]=${v} would land before the last document (${tv}); an append must ` +
      `continue the clustering order. Out-of-order inserts need a rebuild (docs/l1-malli.md §8).`);
  }

  _append(doc) {
    this._checkOrder(doc);
    const d = this.N++;
    this.docs.set(d, doc);
    this.pk.set(String(doc[this.pkField]), d);
    const t = [doc[this.cf], String(doc[this.pkField])];
    if (!this.tail || t[0] > this.tail[0] || (t[0] === this.tail[0] && t[1].localeCompare(this.tail[1]) > 0)) this.tail = t;
  }

  toJSON() {
    const dirty = {};
    for (const [f, s] of this.dirty) if (s.size) dirty[f] = [...s].sort((a, b) => a - b);
    return {
      format: 'l1-delta/1',
      base: this.base.contentHash,
      seq: this.seq,
      docCount: this.N,
      deleted: [...this.deleted].sort((a, b) => a - b),
      docs: [...this.docs].sort((a, b) => a[0] - b[0]).map(([d, doc]) => [d, encodeDoc(doc)]),
      dirty,
      ...(this.outOfOrder ? { unordered: true } : {}),
    };
  }
}
