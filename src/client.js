import { Reader } from './read/reader.js';

/**
 * A deliberately OpenSearch-shaped client surface, so that calling code can be
 * moved across with minimal change. Only the subset of stage A is implemented;
 * anything else throws with a pointer to what is missing rather than silently
 * returning wrong results.
 */
export class L0Client {
  constructor({ artifacts = {} } = {}) {
    this._paths = artifacts;
    this._readers = new Map();
  }

  async _reader(index) {
    if (!this._readers.has(index)) {
      const path = this._paths[index];
      if (!path) throw new Error(`no artifact registered for index [${index}]`);
      this._readers.set(index, await new Reader(path).open());
    }
    return this._readers.get(index);
  }

  async search({ index, body = {} } = {}) {
    const reader = await this._reader(index);
    return reader.search(body);
  }

  async count({ index, body = {} } = {}) {
    const res = await this.search({ index, body: { ...body, size: 0 } });
    return { count: res.hits.total.value, _shards: res._shards };
  }

  async indices_stats(index) {
    const reader = await this._reader(index);
    return { index, catalog: reader.catalog };
  }

  statsFor(index) {
    return this._readers.get(index)?.stats;
  }

  resetStats(index) {
    this._readers.get(index)?.resetStats();
  }

  async close() {
    for (const r of this._readers.values()) await r.close();
    this._readers.clear();
  }
}
