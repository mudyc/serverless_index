/**
 * The twelve Buffer methods the read path actually uses, over Uint8Array.
 *
 * The reader was written against Node's Buffer; auditing it showed twelve
 * methods and a single `node:` import, and that import is the file transport
 * which the browser replaces anyway. So the shim is smaller than a port would
 * be, and the SAME reader code runs in both places — which matters, because a
 * second implementation is a second thing that can disagree.
 */
export class Buf extends Uint8Array {
  readUInt8(o) { return this[o]; }
  readUInt32LE(o) { return (this[o] | this[o+1] << 8 | this[o+2] << 16) + this[o+3] * 0x1000000; }
  readInt32LE(o) { return this[o] | this[o+1] << 8 | this[o+2] << 16 | this[o+3] << 24; }
  readInt32BE(o) { return this[o] << 24 | this[o+1] << 16 | this[o+2] << 8 | this[o+3]; }
  writeUInt32LE(v, o) { this[o] = v; this[o+1] = v >>> 8; this[o+2] = v >>> 16; this[o+3] = v >>> 24; return o + 4; }
  readDoubleLE(o) { return new DataView(this.buffer, this.byteOffset + o, 8).getFloat64(0, true); }
  writeDoubleLE(v, o) { new DataView(this.buffer, this.byteOffset + o, 8).setFloat64(0, v, true); return o + 8; }
  equals(other) {
    if (this.length !== other.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }
  toString(enc = 'utf8', start = 0, end = this.length) {
    return new TextDecoder(enc === 'latin1' ? 'latin1' : 'utf-8').decode(this.subarray(start, end));
  }
}

const B = {
  alloc: n => new Buf(n),
  from: (src, enc) => {
    if (typeof src === 'string') return new Buf(new TextEncoder().encode(src));
    if (src instanceof ArrayBuffer) return new Buf(src);
    if (ArrayBuffer.isView(src)) return new Buf(src.buffer, src.byteOffset, src.byteLength);
    return new Buf(src);
  },
  concat: list => {
    const n = list.reduce((a, b) => a + b.length, 0), out = new Buf(n);
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  },
  isBuffer: v => v instanceof Buf || v instanceof Uint8Array,
  compare: (a, b) => { const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1); },
};

/** Install before importing the reader; Uint8Array gets the methods too, so a
 *  slice handed back by `subarray` behaves like a Buffer whatever produced it. */
export function installBuffer() {
  if (globalThis.Buffer) return;
  for (const k of Object.getOwnPropertyNames(Buf.prototype)) {
    if (k === 'constructor') continue;
    if (!(k in Uint8Array.prototype)) Uint8Array.prototype[k] = Buf.prototype[k];
  }
  // toString must be overridden explicitly: Uint8Array already has one.
  Uint8Array.prototype.toString = Buf.prototype.toString;
  globalThis.Buffer = B;
}
