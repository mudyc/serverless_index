/**
 * HTTP Range transport — the piece that makes the artifact readable without a
 * search server. The reader only ever asks for byte ranges, so object storage or
 * any static host that honours `Range` is enough.
 *
 * A wave is issued as independent parallel requests rather than one multipart
 * range request: multipart/byteranges support is uneven across CDNs, and the
 * cost model counts DEPENDENT round trips, which parallel requests do not add to.
 */
import { planGroups } from './coalesce.js';

export class HttpTransport {
  constructor(url, { maxParallel = 24, coalesceGap = 65536,
                     maxFetchBytes = 64 * 1024 * 1024 } = {}) {
    this.url = url;
    this.maxParallel = maxParallel;
    this.coalesceGap = coalesceGap;
    this.maxFetchBytes = maxFetchBytes;
    this.size = null;
    this.reset();
  }

  reset() { this.stats = { rounds: 0, reads: 0, bytes: 0 }; }

  async open() {
    if (this.size !== null) return this;
    // A HEAD is one round trip; some hosts refuse it, so fall back to a 0-0 range
    // whose Content-Range carries the total length.
    let r = await fetch(this.url, { method: 'HEAD' });
    if (r.ok && (r.headers.get('accept-ranges') ?? '').toLowerCase() === 'none') {
      throw new Error(`${this.url}: host advertises Accept-Ranges: none`);
    }
    let len = r.ok ? Number(r.headers.get('content-length')) : NaN;
    if (!Number.isFinite(len) || !len) {
      r = await fetch(this.url, { headers: { Range: 'bytes=0-0' } });
      const cr = r.headers.get('content-range') ?? '';
      len = Number(cr.split('/')[1]);
    }
    if (!Number.isFinite(len) || !len) throw new Error(`cannot determine size of ${this.url}`);
    this.size = len;
    return this;
  }

  async close() {}
  async sizeOf() { return this.size; }

  async readTail(length) {
    if (this.size === null) await this.open();
    const offset = Math.max(0, this.size - length);
    return this.readRange(offset, Math.min(length, this.size));
  }

  async readRange(offset, length) {
    const [b] = await this._raw([{ offset, length }]);
    this.stats.rounds += 1;
    return b;
  }

  async readWave(ranges) {
    if (ranges.length === 0) return [];
    const bufs = await this._raw(ranges);
    this.stats.rounds += 1;
    return bufs;
  }

  /** See src/transport/coalesce.js for why this is not an unconditional merge. */
  _coalesce(ranges) {
    return planGroups(ranges, { gap: this.coalesceGap, maxParallel: this.maxParallel,
                                maxFetchBytes: this.maxFetchBytes });
  }

  async _raw(ranges) {
    const groups = this._coalesce(ranges);
    if (groups) {
      const merged = groups.map(g => ({ offset: g.start, length: g.end - g.start }));
      const bufs = await this._rawDirect(merged);
      const out = new Array(ranges.length);
      groups.forEach((g, gi) => {
        for (const i of g.members) {
          const r = ranges[i], at = r.offset - g.start;
          out[i] = bufs[gi].subarray(at, at + r.length);
        }
      });
      return out;
    }
    return this._rawDirect(ranges);
  }

  async _rawDirect(ranges) {
    const out = new Array(ranges.length);
    let next = 0;
    const worker = async () => {
      while (next < ranges.length) {
        const i = next++;
        const { offset, length } = ranges[i];
        const res = await fetch(this.url, {
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        });
        // A host that ignores Range answers 200 with the WHOLE file. Accepting
        // that would read from offset 0 and quietly return the wrong bytes — the
        // one failure this format must never have. Python's `http.server` does
        // exactly this, so the check names it.
        if (res.status === 200) {
          throw new Error(
            `${this.url}: server ignored Range and sent the whole file ` +
            `(HTTP 200, ${res.headers.get('content-length') ?? '?'} bytes). ` +
            `This host cannot serve the artifact — python3 -m http.server is one ` +
            `that cannot; use map-viz/serve.js, or any CDN or object store.`);
        }
        if (res.status !== 206) throw new Error(`range ${offset}+${length}: HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (buf.length !== length && offset + length <= this.size) {
          throw new Error(`range ${offset}+${length}: got ${buf.length} bytes`);
        }
        this.stats.reads += 1;
        this.stats.bytes += buf.length;
        out[i] = buf;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxParallel, ranges.length) }, worker));
    return out;
  }
}
