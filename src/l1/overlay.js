import { Bitmap } from '../bitmap.js';
import { decodeDoc } from './codec.js';

/**
 * L1, phase 1: a base L0 artifact plus ONE inline delta (docs/l1-malli.md §5, §11).
 *
 * The delta is absolute, never relative (§5.2): it says what a document IS now,
 * not what changed. That keeps it idempotent, which is what a re-applied flush
 * and a rebase after compaction both need.
 *
 *   {
 *     format:   'l1-delta/1',
 *     base:     <contentHash of the base artifact>,
 *     seq:      <last applied operation sequence number>,
 *     docCount: <size of the doc-ID space: base + appended>,
 *     deleted:  [docId, ...],              live-mask clears
 *     docs:     [[docId, doc], ...],       current value of every touched, live doc
 *     dirty:    { field: [docId, ...] }    base docs whose value of `field` changed
 *   }
 *
 * Appended documents (docId >= base docCount) are dirty in every field, since
 * the base knows nothing about them.
 *
 * Evaluation rule, per single-field leaf predicate P on field f:
 *
 *   P(base) ANDNOT dirty(f)   OR   scan(P, overlay docs dirty in f)
 *
 * and the final hit set is AND live. Every term on the left is the unchanged L0
 * plan, so the delta adds no byte range to the wave: phase 1 keeps the whole
 * delta inline (resident) and measures what that costs.
 */
export class Overlay {
  constructor(baseCatalog, delta) {
    if (delta.format !== 'l1-delta/1') throw new Error(`unknown delta format ${delta.format}`);
    if (delta.base !== baseCatalog.contentHash) {
      throw new Error(`delta was written against base ${delta.base}, ` +
        `this artifact is ${baseCatalog.contentHash}`);
    }
    this.baseN = baseCatalog.docCount;
    this.N = delta.docCount;
    if (this.N < this.baseN) throw new Error('delta docCount is smaller than the base');
    this.seq = delta.seq ?? 0;
    this.docs = new Map(delta.docs.map(([d, doc]) => [d, decodeDoc(doc)]));
    // Appends that broke the clustering order (spatial keys): filters stay
    // exact, ordering by the clustering key does not.
    this.unordered = !!delta.unordered;
    this.live = Bitmap.full(this.N);
    for (const d of delta.deleted) clearBit(this.live, d);
    this._dirtyLists = new Map(Object.entries(delta.dirty ?? {}).map(([f, ids]) => [f, new Set(ids)]));
    this._dirtyBm = new Map();
  }

  isDirty(field, docId) {
    return docId >= this.baseN || (this._dirtyLists.get(field)?.has(docId) ?? false);
  }

  /** Base docs changed in `field`, plus every appended doc. */
  dirty(field) {
    let bm = this._dirtyBm.get(field);
    if (!bm) {
      bm = Bitmap.empty(this.N);
      for (const d of this._dirtyLists.get(field) ?? []) bm.set(d);
      for (let d = this.baseN; d < this.N; d++) bm.set(d);
      this._dirtyBm.set(field, bm);
    }
    return bm;
  }

  /** Live overlay docs whose `field` is dirty, as [docId, value] pairs. */
  *entries(field) {
    for (const [d, doc] of this.docs) {
      if (!this.isDirty(field, d) || !this.live.get(d)) continue;
      yield [d, doc[field]];
    }
  }

  /** Overlay docs dirty in `field` whose value satisfies `test`. */
  scan(field, test) {
    const bm = Bitmap.empty(this.N);
    for (const [d, v] of this.entries(field)) if (test(v)) bm.set(d);
    return bm;
  }
}

function clearBit(bm, i) { bm.words[i >>> 5] &= ~(1 << (i & 31)); }
