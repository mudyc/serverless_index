/**
 * Dense bitmap over document IDs.
 *
 * Per §13.8 of the research notes: a bitmap needs no resident navigator at all,
 * because the byte offset of any document's bit is arithmetic. That is what
 * makes it the cheapest structure in the design and the right Stage A target.
 */
export class Bitmap {
  constructor(size, words) {
    this.size = size;
    this.words = words ?? new Uint32Array((size + 31) >>> 5);
  }

  static full(size) {
    const b = new Bitmap(size);
    b.words.fill(0xffffffff);
    const tail = size & 31;
    if (tail) b.words[b.words.length - 1] = (1 << tail) - 1;
    return b;
  }

  static empty(size) {
    return new Bitmap(size);
  }

  static fromBytes(size, bytes) {
    const wordCount = (size + 31) >>> 5;
    const words = new Uint32Array(wordCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < wordCount && i * 4 + 4 <= bytes.byteLength; i++) {
      words[i] = view.getUint32(i * 4, true);
    }
    return new Bitmap(size, words);
  }

  toBytes() {
    const out = Buffer.alloc(this.words.length * 4);
    for (let i = 0; i < this.words.length; i++) out.writeUInt32LE(this.words[i], i * 4);
    return out;
  }

  static byteLengthFor(size) {
    return ((size + 31) >>> 5) * 4;
  }

  /**
   * Sparse encoding: [u32 count][u32 docId]*. Chosen per section at BUILD time
   * from observed density (§11.4b) — an L0 freedom, since the builder sees the
   * density and a live engine would have to guess.
   *
   * At 5.3M documents a dense bitmap is 662 kB regardless of how few documents
   * match, so for a rare value this is three orders of magnitude smaller.
   */
  toIdBytes() {
    const ids = this.page(0, this.size);
    const b = Buffer.alloc(4 + ids.length * 4);
    b.writeUInt32LE(ids.length, 0);
    ids.forEach((id, i) => b.writeUInt32LE(id, 4 + i * 4));
    return b;
  }

  static fromIdBytes(size, bytes) {
    const bm = new Bitmap(size);
    const n = bytes.readUInt32LE(0);
    for (let i = 0; i < n; i++) bm.set(bytes.readUInt32LE(4 + i * 4));
    return bm;
  }

  /** Smaller of the two encodings, with the kind recorded for the reader. */
  encode() {
    const dense = Bitmap.byteLengthFor(this.size);
    const sparse = 4 + this.popcount() * 4;
    return sparse < dense
      ? { kind: 'ids', buf: this.toIdBytes() }
      : { kind: 'bitmap', buf: this.toBytes() };
  }

  get(i) {
    return (this.words[i >>> 5] & (1 << (i & 31))) !== 0;
  }

  set(i) {
    this.words[i >>> 5] |= 1 << (i & 31);
    return this;
  }

  clone() {
    return new Bitmap(this.size, this.words.slice());
  }

  and(o) {
    for (let i = 0; i < this.words.length; i++) this.words[i] &= o.words[i];
    return this;
  }
  or(o) {
    for (let i = 0; i < this.words.length; i++) this.words[i] |= o.words[i];
    return this;
  }
  xor(o) {
    for (let i = 0; i < this.words.length; i++) this.words[i] ^= o.words[i];
    return this;
  }
  andNot(o) {
    for (let i = 0; i < this.words.length; i++) this.words[i] &= ~o.words[i];
    return this;
  }
  not() {
    for (let i = 0; i < this.words.length; i++) this.words[i] = ~this.words[i];
    const tail = this.size & 31;
    if (tail) this.words[this.words.length - 1] &= (1 << tail) - 1;
    return this;
  }

  /** Exact cardinality. Free for us — so there is no track_total_hits tradeoff. */
  popcount() {
    let n = 0;
    for (let i = 0; i < this.words.length; i++) {
      let w = this.words[i];
      w = w - ((w >>> 1) & 0x55555555);
      w = (w & 0x33333333) + ((w >>> 2) & 0x33333333);
      w = (w + (w >>> 4)) & 0x0f0f0f0f;
      n += (Math.imul(w, 0x01010101) >>> 24);
    }
    return n;
  }

  /**
   * Cardinality restricted to a document-ID interval.
   *
   * This is what makes a histogram over the CLUSTERING KEY nearly free: each
   * bucket is a contiguous doc-ID range (§2), so a bucket count is a popcount
   * over a word range rather than an AND over the whole bitmap.
   */
  popcountRange(from, to) {
    if (to <= from) return 0;
    const lo = Math.max(0, from), hi = Math.min(this.size, to);
    const wLo = lo >>> 5, wHi = (hi - 1) >>> 5;
    if (wLo === wHi) {
      const mask = (hi - lo === 32) ? 0xffffffff
        : (((1 << (hi - lo)) - 1) << (lo & 31));
      return popcnt32(this.words[wLo] & mask);
    }
    let n = popcnt32(this.words[wLo] & (0xffffffff << (lo & 31)));
    for (let i = wLo + 1; i < wHi; i++) n += popcnt32(this.words[i]);
    const tail = hi & 31;
    n += popcnt32(this.words[wHi] & (tail === 0 ? 0xffffffff : ((1 << tail) - 1)));
    return n;
  }

  /**
   * select(k): position of the k-th set bit (0-based), or -1.
   * §14.8 — this is the succinct-structures primitive, and for a transient
   * result bitmap a popcount scan is enough; no index is needed.
   */
  select(k) {
    let seen = 0;
    for (let i = 0; i < this.words.length; i++) {
      const w = this.words[i];
      if (w === 0) continue;
      const c = popcnt32(w);
      if (seen + c > k) {
        let rest = k - seen;
        for (let b = 0; b < 32; b++) {
          if (w & (1 << b)) {
            if (rest === 0) return (i << 5) + b;
            rest--;
          }
        }
      }
      seen += c;
    }
    return -1;
  }

  /** Doc IDs in ascending order, offset/limit. Offset-based paging (see §14.11). */
  page(offset, limit) {
    const out = [];
    let seen = 0;
    for (let i = 0; i < this.words.length && out.length < limit; i++) {
      let w = this.words[i];
      if (w === 0) continue;
      const c = popcnt32(w);
      if (seen + c <= offset) { seen += c; continue; }
      for (let b = 0; b < 32 && out.length < limit; b++) {
        if (w & (1 << b)) {
          if (seen >= offset) out.push((i << 5) + b);
          seen++;
        }
      }
    }
    return out;
  }

  /**
   * Cursor pagination (§14.4): first `limit` set bits strictly after `afterId`.
   * In the clustering order this is interval continuation — page 500 costs what
   * page 1 costs, with no cursor state anywhere but the caller's hand.
   */
  after(afterId, limit, descending = false) {
    const out = [];
    if (descending) {
      const start = afterId === null ? this.size - 1 : afterId - 1;
      for (let i = start; i >= 0 && out.length < limit; i--) if (this.get(i)) out.push(i);
      return out;
    }
    const start = afterId === null ? 0 : afterId + 1;
    for (let i = start; i < this.size && out.length < limit; i++) if (this.get(i)) out.push(i);
    return out;
  }
}

function popcnt32(w) {
  w = w - ((w >>> 1) & 0x55555555);
  w = (w & 0x33333333) + ((w >>> 2) & 0x33333333);
  w = (w + (w >>> 4)) & 0x0f0f0f0f;
  return Math.imul(w, 0x01010101) >>> 24;
}
