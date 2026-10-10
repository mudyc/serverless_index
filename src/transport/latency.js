import { FileTransport } from './file.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Wraps a transport and charges object-storage economics:
 *
 *   • `latencyMs` per ROUND — a wave of independent ranges pays it once,
 *     because on S3 they are issued in parallel.
 *   • `bandwidthMBs` per byte transferred.
 *
 * This is what makes the probe-depth contract felt rather than merely asserted.
 * It also makes §13.2 visible: at 30 ms and 100 MB/s, one round trip is worth
 * ~3 MB of transfer, so over-fetching is nearly free and round trips are not.
 */
export class LatencyTransport {
  constructor(path, { latencyMs = 30, bandwidthMBs = 100, jitterMs = 0,
                      aggregateMBs = 1000 } = {}) {
    this.inner = path instanceof FileTransport ? path : new FileTransport(path);
    this.latencyMs = latencyMs;
    this.bandwidthMBs = bandwidthMBs;
    this.jitterMs = jitterMs;
    // Per-connection throughput is `bandwidthMBs`; many parallel connections add
    // up until the aggregate cap. This is why splitting one big range into
    // several pays: same round trip, several times the bandwidth.
    this.aggregateMBs = aggregateMBs;
    this.reset();
  }

  reset() {
    this.inner.reset?.();
    this.stats = { rounds: 0, reads: 0, bytes: 0, simulatedMs: 0 };
  }

  async open() { await this.inner.open(); return this; }
  async close() { await this.inner.close(); }
  async size() { return this.inner.size(); }

  async _charge(bytes, streams = 1) {
    const jitter = this.jitterMs ? Math.random() * this.jitterMs : 0;
    const effective = Math.min(streams * this.bandwidthMBs, this.aggregateMBs);
    const transferMs = bytes / (effective * 1024 * 1024) * 1000;
    const ms = this.latencyMs + jitter + transferMs;
    this.stats.simulatedMs += ms;
    await sleep(Math.min(ms, 2000));
    return ms;
  }

  async readRange(offset, length) {
    const buf = await this.inner.readRange(offset, length);
    this._sync(); await this._charge(buf.length);
    return buf;
  }

  async readWave(ranges) {
    if (ranges.length === 0) return [];
    const bufs = await this.inner.readWave(ranges);
    this._sync();
    // Parallel ranges: one latency, but the bytes still have to arrive.
    await this._charge(bufs.reduce((n, b) => n + b.length, 0), bufs.length);
    return bufs;
  }

  async readTail(length) {
    const buf = await this.inner.readTail(length);
    this._sync(); await this._charge(buf.length);
    return buf;
  }

  _sync() {
    const s = this.inner.stats;
    this.stats.rounds = s.rounds; this.stats.reads = s.reads; this.stats.bytes = s.bytes;
  }
}
