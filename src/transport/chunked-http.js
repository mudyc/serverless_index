/**
 * HTTP Range transport over an artifact split into parts.
 *
 * Hosts that cap file size (GitHub blocks over 100 MiB) cannot hold a large
 * artifact whole. The split is a plain byte split; this transport maps a global
 * byte range onto the parts that cover it and concatenates the pieces, so the
 * reader sees one continuous file and nothing in the format changes.
 *
 * A range that straddles a part boundary becomes two requests, but they are
 * independent and issued together — the cost model counts DEPENDENT round trips,
 * so a wave is still one round however many parts it touches.
 */
import { planGroups } from './coalesce.js';

export class ChunkedHttpTransport {
  constructor(manifestUrl, { maxParallel = 24, coalesceGap = 65536,
                             maxFetchBytes = 64 * 1024 * 1024 } = {}) {
    this.manifestUrl = manifestUrl;
    this.maxParallel = maxParallel;
    this.coalesceGap = coalesceGap;
    this.maxFetchBytes = maxFetchBytes;
    this.size = null;
    this.reset();
  }

  reset() { this.stats = { rounds: 0, reads: 0, bytes: 0, fetchMs: 0 }; }

  async open() {
    if (this.size !== null) return this;
    const r = await fetch(this.manifestUrl);
    if (!r.ok) throw new Error(`${this.manifestUrl}: HTTP ${r.status}`);
    const m = await r.json();
    if (m.format !== 'l0-split-1') throw new Error(`${this.manifestUrl}: unknown format ${m.format}`);
    this.size = m.size; this.part = m.part; this.parts = m.parts;
    this.base = new URL(m.name, this.manifestUrl).href;
    // Osien nimet eivät muutu kun artefakti rakennetaan uudelleen, joten selain
    // voi tarjota vanhan palan uuden manifestin rinnalle. Silloin footer osuu
    // väärään kohtaan ja lukija kaatuu "bad magic" -virheeseen. Manifestin koko
    // vaihtuu aina kun sisältö vaihtuu, joten se kelpaa versioksi.
    this.ver = String(m.size);
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

  _url(i) {
    const u = `${this.base}.${String(i).padStart(3, '0')}`;
    return this.ver ? `${u}?v=${this.ver}` : u;
  }

  /**
   * Same policy as the single-file transport (see coalesce.js), applied BEFORE
   * the ranges are cut at part boundaries — otherwise the split multiplies the
   * request count back up again.
   */
  _coalesce(ranges) {
    return planGroups(ranges, { gap: this.coalesceGap, maxParallel: this.maxParallel,
                                maxFetchBytes: this.maxFetchBytes });
  }

  /**
   * Kaikki I/O kulkee tästä, joten odotusaika mitataan yhdessä paikassa.
   * Kysely jakautuu kahtia: tämä on se osa jota odotetaan, ja loput on
   * laskentaa. Indeksin koko väite on että jälkimmäinen on pieni.
   */
  async _raw(ranges) {
    const now = () => (globalThis.performance ?? Date).now();
    const t0 = now();
    try { return await this._rawTimed(ranges); }
    finally { this.stats.fetchMs += now() - t0; }
  }

  async _rawTimed(ranges) {
    const groups = this._coalesce(ranges);
    if (groups) {
      const merged = groups.map(g => ({ offset: g.start, length: g.end - g.start }));
      const bufs = await this._rawSplit(merged);
      const out = new Array(ranges.length);
      groups.forEach((g, gi) => {
        for (const i of g.members) {
          const r = ranges[i], at = r.offset - g.start;
          out[i] = bufs[gi].subarray(at, at + r.length);
        }
      });
      return out;
    }
    return this._rawSplit(ranges);
  }

  async _rawSplit(ranges) {
    // Cut every logical range at the part boundaries it crosses.
    const jobs = [];
    ranges.forEach(({ offset, length }, i) => {
      let at = offset, left = length, seq = 0;
      while (left > 0) {
        const p = Math.floor(at / this.part);
        const within = at - p * this.part;
        const take = Math.min(left, this.part - within);
        jobs.push({ i, seq: seq++, p, within, take });
        at += take; left -= take;
      }
    });

    const got = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const k = next++;
        const { p, within, take } = jobs[k];
        const res = await fetch(this._url(p), {
          headers: { Range: `bytes=${within}-${within + take - 1}` },
        });
        if (res.status === 200) {
          throw new Error(
            `${this._url(p)}: server ignored Range and sent the whole part ` +
            `(HTTP 200). This host cannot serve the artifact.`);
        }
        if (res.status !== 206) throw new Error(`part ${p} ${within}+${take}: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== take) throw new Error(`part ${p} ${within}+${take}: got ${buf.length}`);
        this.stats.reads += 1;
        this.stats.bytes += buf.length;
        got[k] = buf;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxParallel, jobs.length) }, worker));

    const out = ranges.map(() => []);
    jobs.forEach((j, k) => { out[j.i][j.seq] = got[k]; });
    return out.map(pieces => pieces.length === 1 ? pieces[0] : Buffer.concat(pieces));
  }
}
