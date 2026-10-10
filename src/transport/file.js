import { open } from 'node:fs/promises';

/**
 * Transport adapter — the VFS separation of §10.5 / §5.
 *
 * The reader is written against readRange/readWave only, so swapping this for
 * an S3 or HTTP-Range transport later touches nothing above it.
 *
 * Instrumentation is the point: `rounds` counts *dependent* round trips, which
 * is the cost model of §10.6 and §15.2. `reads` counts individual ranges — on
 * object storage those are free within a wave; here we record both so tests can
 * assert the probe-depth contract.
 */
export class FileTransport {
  constructor(path) {
    this.path = path;
    this.fh = null;
    this.reset();
  }

  reset() {
    this.stats = { rounds: 0, reads: 0, bytes: 0 };
  }

  async open() {
    if (!this.fh) this.fh = await open(this.path, 'r');
    return this;
  }

  async close() {
    if (this.fh) { await this.fh.close(); this.fh = null; }
  }

  async size() {
    const s = await this.fh.stat();
    return s.size;
  }

  /** One dependent round trip carrying one range. */
  async readRange(offset, length) {
    const [buf] = await this._raw([{ offset, length }]);
    this.stats.rounds += 1;
    return buf;
  }

  /** One dependent round trip carrying N independent ranges (§14.8). */
  async readWave(ranges) {
    if (ranges.length === 0) return [];
    const bufs = await this._raw(ranges);
    this.stats.rounds += 1;
    return bufs;
  }

  async readTail(length) {
    const total = await this.size();
    const offset = Math.max(0, total - length);
    return this.readRange(offset, Math.min(length, total));
  }

  async _raw(ranges) {
    return Promise.all(ranges.map(async ({ offset, length }) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await this.fh.read(buf, 0, length, offset);
      this.stats.reads += 1;
      this.stats.bytes += bytesRead;
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    }));
  }
}
