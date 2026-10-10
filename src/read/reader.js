import { Bitmap } from '../bitmap.js';
import { MAGIC, FOOTER_LEN } from '../format.js';
import { compile, QueryError } from '../query/compile.js';
import { planFetches, evaluate, decodeSet as decodeSection } from './plan.js';
import { Budget } from '../cost.js';

export class Reader {
  /**
   * §13.4 derived the coalescing rule as "merge when gap < latency x bandwidth",
   * i.e. ~3 MB on S3. That derivation assumed the alternative was a SECOND ROUND
   * TRIP. It is wrong for a parallel wave: there the alternative is one more
   * independent range at ~zero extra latency, so merging only adds bytes.
   *
   * Measured on the 1M-vehicle artifact: a 20-document page cost 16 MB with a
   * 3 MB gap, versus ~240 kB when ranges are left separate — same round count.
   *
   * Correct rule: keep ranges separate while they fit the concurrency budget;
   * coalesce only to get BELOW that budget, or across trivially small gaps.
   */
  constructor(transportOrPath, { coalesceGap = 32 * 1024, maxParallel = 64,
                                 cacheLimit = 128 * 1024 * 1024,
                                 chunkSize = 4 * 1024 * 1024, maxChunks = 32,
                                 budget = null } = {}) {
    // A path is resolved to a file transport lazily in open(): importing it here
    // would pull `node:fs` into every bundle, and the whole point of the format
    // is that a browser can read it over HTTP ranges with no Node at all.
    this.transport = typeof transportOrPath === 'string' ? null : transportOrPath;
    this._path = typeof transportOrPath === 'string' ? transportOrPath : null;
    this.catalog = null;
    this.coalesceGap = coalesceGap;
    this.maxParallel = maxParallel;
    // Sections are immutable for a given version, so a cached one can never be
    // stale (§2). This is what makes faceted redraws free after the first load:
    // fetch the 320 municipality sections once, then every filter change is
    // popcount in memory with no network at all.
    this.cache = new Map();
    this.cacheBytes = 0;
    this.cacheLimit = cacheLimit;
    // A single range GET is limited by ONE connection's throughput, while object
    // storage scales across many. Splitting a large logical range into parallel
    // chunks costs no extra round trip (they are independent) and multiplies
    // effective bandwidth.
    this.chunkSize = chunkSize;
    this.maxChunks = maxChunks;
    // The planner knows every byte range before a single one is issued, so the
    // bill is knowable in advance — and therefore refusable. Without a budget the
    // reader behaves as before; with one, a wave that would blow the limit throws
    // at the chokepoint below instead of spending the money. See src/cost.js.
    this.budget = budget instanceof Budget ? budget : budget ? new Budget(budget) : null;
  }

  clearCache() { this.cache.clear(); this.cacheBytes = 0; }

  async open() {
    if (!this.transport) {
      const { FileTransport } = await import('../transport/file.js');
      this.transport = new FileTransport(this._path);
    }
    await this.transport.open();
    const footer = await this.transport.readTail(FOOTER_LEN);
    if (!footer.subarray(0, 8).equals(MAGIC)) throw new Error('not an L0 artifact (bad magic)');
    const buf = await this.transport.readRange(footer.readUInt32LE(8), footer.readUInt32LE(12));
    this.catalog = JSON.parse(buf.toString('utf8'));
    this.transport.reset();                      // catalog is phase 0 — free thereafter
    return this;
  }

  async close() { await this.transport.close?.(); }
  get stats() { return this.transport.stats; }
  resetStats() { this.transport.reset(); }

  async search(body = {}) {
    const t0 = performance.now();
    const cat = this.catalog;
    const size = body.size ?? 10;
    const from = body.from ?? 0;
    const { field: sortField, order } = resolveSort(body.sort, cat);
    const secondary = sortField !== cat.clustering.field;

    // ---- plan: local, no I/O -------------------------------------------
    const plan = compile(body.query, cat);
    const ranges = planFetches(plan, cat);

    // A secondary sort needs the sorted column as a permutation (§12.8/§14.9).
    // Its span is estimated from catalog statistics so it rides in the SAME
    // wave — speculative over-fetch instead of a dependent probe (§13.2).
    let sortPlan = null;
    if (secondary) {
      sortPlan = this._planSecondarySort(sortField, order, from + size, plan, body);
      for (const [k, r] of sortPlan.ranges) ranges.set(k, r);
    }

    // Faceted aggregations (§14.5): every bucket is popcount(hits AND value),
    // and popcount is exact and free. The value sections are addressable from
    // the catalog, so they ride in the SAME wave — a facetted query is still
    // two round trips.
    const aggPlans = this._planAggs(body.aggs);
    for (const a of aggPlans) for (const [k, r] of a.ranges) ranges.set(k, r);

    // ---- phase 1: one wave ---------------------------------------------
    const got = await this._wave(ranges);
    const hits = evaluate(plan, got, cat);
    const total = hits.popcount();
    const aggregations = this._runAggs(aggPlans, hits, got);

    // ---- page selection --------------------------------------------------
    let docIds;
    if (secondary) {
      docIds = this._pageBySortColumn(hits, sortPlan, got, body, from, size);
      if (docIds.length < size && !sortPlan.complete) {
        // Estimate fell short: one supplementary fetch, counted honestly.
        const full = await this._fetchWholeSortColumn(sortField);
        docIds = this._pageBySortColumn(hits, { ...sortPlan, ...full, complete: true },
                                        full.got, body, from, size);
      }
    } else if (body.search_after !== undefined) {
      const cur = Array.isArray(body.search_after) ? body.search_after.at(-1) : body.search_after;
      docIds = hits.after(cur === null || cur === undefined ? null : Number(cur), size, order === 'desc');
    } else if (order === 'desc') {
      docIds = hits.after(null, from + size, true).slice(from);
    } else {
      docIds = hits.page(from, size);
    }

    // ---- phase 2: one wave ---------------------------------------------
    const sources = await this._fetchStored(docIds);
    const took = performance.now() - t0;

    return {
      took: Math.round(took), timed_out: false,
      ...(aggregations ? { aggregations } : {}),
      _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
      hits: {
        total: { value: total, relation: 'eq' },
        max_score: null,
        hits: docIds.map((docId, i) => {
          const src = sources[i];
          return {
            _index: cat.index, _id: String(src.id ?? docId), _score: null, _source: src,
            sort: [src[sortField], docId],
          };
        }),
      },
    };
  }

  _planAggs(aggs) {
    if (!aggs) return [];
    const cat = this.catalog;
    return Object.entries(aggs).map(([name, spec]) => {
      if (spec.histogram) return this._planHistogram(name, spec);
      const terms = spec.terms;
      if (!terms) throw new QueryError(`aggregation [${name}]: supported types are "terms" and "histogram"`);
      const field = terms.field;
      const m = cat.fields[field];
      if (!m) throw new QueryError(`aggregation [${name}]: unknown field [${field}]`);
      if (m.type !== 'keyword' && m.type !== 'boolean') {
        throw new QueryError(`aggregation [${name}]: terms needs a keyword or boolean field, ` +
          `[${field}] is [${m.type}]`);
      }
      const entries = m.type === 'boolean'
        ? [['true', { section: m.sections.true }]]
        : Object.entries(m.values);
      const ranges = new Map();
      for (const [, e] of entries) {
        const s2 = cat.sections[e.section];
        ranges.set(e.section, { offset: s2.offset, length: s2.length });
      }
      const subs = Object.entries(spec.aggs ?? {}).map(([n2, s2]) => {
        const st = s2.stats ?? s2.avg ?? s2.sum ?? s2.min ?? s2.max;
        if (!st) throw new QueryError(`aggregation [${name}]: sub-aggregations must be numeric statistics`);
        const fm = cat.fields[st.field];
        if (!fm || fm.type !== 'numeric') {
          throw new QueryError(`aggregation [${name}]: [${st.field}] is not a numeric column`);
        }
        const v = cat.sections[fm.sections.values];
        const vKey = `stat:${st.field}:v`;
        ranges.set(vKey, { offset: v.offset, length: v.length });
        let dKey = null;
        if (!fm.implicitDocs) {
          const d = cat.sections[fm.sections.docs];
          dKey = `stat:${st.field}:d`;
          ranges.set(dKey, { offset: d.offset, length: d.length });
        }
        const kind = s2.stats ? 'stats' : (s2.avg ? 'avg' : s2.sum ? 'sum' : s2.min ? 'min' : 'max');
        return { name: n2, kind, field: st.field, fm, vKey, dKey };
      });
      return { name, field, entries, ranges, subs, size: terms.size ?? 10,
               minDocCount: terms.min_doc_count ?? 1 };
    });
  }

  /**
   * Histogram over the clustering key. Buckets are contiguous doc-ID intervals,
   * so no per-bucket bitmap work is needed — only popcountRange. Sub-aggregations
   * therefore cost one pass per term over the whole bitmap, not one per bucket.
   */
  _planHistogram(name, spec) {
    const cat = this.catalog;
    const h = spec.histogram;
    const field = h.field;
    if (field !== cat.clustering.field) {
      throw new QueryError(`histogram on [${field}] requires the clustering key ` +
        `[${cat.clustering.field}]; any other field would need its own ordering`);
    }
    const m = cat.fields[field];
    const v = cat.sections[m.sections.values];
    const key = `hist:${field}`;
    const ranges = new Map([[key, { offset: v.offset, length: v.length }]]);
    const subs = Object.entries(h.aggs ?? spec.aggs ?? {}).map(([n2, s2]) => {
      // Numeric statistics over a histogram bucket.
      //
      // The columns are stored in VALUE order with a doc-ID permutation, which
      // answers range predicates but not "what is document X's value?". A sum
      // would normally need a second copy in document order — except that here
      // every bucket is a contiguous doc-ID interval (§2), so ONE scan of the
      // (value, doc) pairs fills every bucket at once. Doc-order storage would
      // only pay off for a query restricted to a narrow range of years.
      const st = s2.stats ?? s2.avg ?? s2.sum ?? s2.min ?? s2.max;
      if (st) {
        const fm = cat.fields[st.field];
        if (!fm || fm.type !== 'numeric') {
          throw new QueryError(`histogram [${name}]: [${st.field}] is not a numeric column`);
        }
        const v = cat.sections[fm.sections.values];
        const vKey = `stat:${st.field}:v`;
        ranges.set(vKey, { offset: v.offset, length: v.length });
        let dKey = null;
        if (!fm.implicitDocs) {
          const d = cat.sections[fm.sections.docs];
          dKey = `stat:${st.field}:d`;
          ranges.set(dKey, { offset: d.offset, length: d.length });
        }
        const kind = s2.stats ? 'stats' : (s2.avg ? 'avg' : s2.sum ? 'sum' : s2.min ? 'min' : 'max');
        return { name: n2, numeric: true, kind, field: st.field, fm, vKey, dKey };
      }
      const t = s2.terms;
      if (!t) throw new QueryError(`histogram [${name}]: sub-aggregations must be "terms" or a numeric statistic`);
      const fm = cat.fields[t.field];
      if (!fm) throw new QueryError(`histogram [${name}]: unknown field [${t.field}]`);
      const entries = fm.type === 'boolean'
        ? [['true', { section: fm.sections.true }]] : Object.entries(fm.values);
      for (const [, e] of entries) {
        const sec = cat.sections[e.section];
        ranges.set(e.section, { offset: sec.offset, length: sec.length });
      }
      return { name: n2, entries, size: t.size ?? 20 };
    });
    const interval = h.interval ?? 'year';
    // `year` means "the integer is YYYYMMDD" — it buckets by v/10000. On an
    // epoch-millisecond key that silently yields nonsense buckets, so check it
    // against the catalog's clustering boundaries, which are resident and free.
    if (interval === 'year') {
      const b = cat.clustering?.boundaries;
      const lo = b?.[0]?.[0], hi = b?.[b.length - 1]?.[0];
      if (Number.isFinite(lo) && (lo < 10000101 || hi > 99991231)) {
        throw new QueryError(
          `histogram interval "year" expects [${field}] to be a YYYYMMDD integer, ` +
          `but its values run ${lo}..${hi}. Pass a numeric interval instead ` +
          `(e.g. interval: ${Math.max(1, Math.round((hi - lo) / 20))} for ~20 buckets).`);
      }
    }
    if (interval !== 'year' && !(Number(interval) > 0))
      throw new QueryError(`histogram [${name}]: interval must be "year" or a positive number`);
    return { kind: 'histogram', name, field, key, ranges, subs,
             interval, min: h.min, max: h.max };
  }

  _runHistogram(p, hits, got) {
    const cat = this.catalog;
    const vbuf = got.get(p.key);
    const n = cat.fields[p.field].count;
    const bucketOf = p.interval === 'year'
      ? v => Math.floor(v / 10000)
      : v => Math.floor(v / p.interval) * p.interval;
    // One scan of the clustering column gives every bucket's doc-ID interval.
    const bounds = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      const b = bucketOf(vbuf.readDoubleLE(i * 8));
      if (cur === null || b !== cur.key) { if (cur) cur.to = i; bounds.push(cur = { key: b, from: i, to: n }); }
    }
    if (cur) cur.to = n;
    // doc -> bucket, filled once so the column scan below is O(1) per entry
    const bucketOfDoc = new Int32Array(cat.docCount).fill(-1);
    bounds.forEach((b, bi) => { for (let d = b.from; d < b.to; d++) bucketOfDoc[d] = bi; });

    // Per-term counts per bucket, built WITHOUT a dense bitmap per term. An id
    // list is a sorted array of positions, so one pass over it fills every
    // bucket at once; only an already-dense section is decoded. The old form
    // held one 661 kB bitmap per value — at 15 651 brands that is ~10 GB
    // resident before a single count is produced.
    const nb = bounds.length;
    const subCounts = p.subs.map(s => {
      if (s.numeric) return null;
      return s.entries.map(([k, e]) => {
        const sec = cat.sections[e.section], buf = got.get(e.section);
        const row = new Int32Array(nb);
        if (sec.kind === 'ids') {
          const cnt = buf.readUInt32LE(0);
          for (let i = 0; i < cnt; i++) {
            const d = buf.readUInt32LE(4 + i * 4);
            if (!hits.get(d)) continue;
            const bi = bucketOfDoc[d];
            if (bi >= 0) row[bi]++;
          }
        } else {
          const bm = decodeSection(cat, e.section, buf).and(hits);
          for (let bi = 0; bi < nb; bi++) row[bi] = bm.popcountRange(bounds[bi].from, bounds[bi].to);
        }
        return [k, row];
      });
    });

    // One pass per numeric sub-aggregation fills every bucket simultaneously.
    const numStats = p.subs.map(s => {
      if (!s.numeric) return null;
      const vbuf = got.get(s.vKey), dbuf = s.dKey ? got.get(s.dKey) : null;
      const n2 = s.fm.count;
      const acc = bounds.map(() => ({ count: 0, sum: 0, min: Infinity, max: -Infinity }));
      for (let i = 0; i < n2; i++) {
        const doc = dbuf ? dbuf.readUInt32LE(i * 4) : i;
        if (!hits.get(doc)) continue;
        const bi = bucketOfDoc[doc];
        if (bi < 0) continue;
        const v = vbuf.readDoubleLE(i * 8);
        const a = acc[bi];
        a.count++; a.sum += v;
        if (v < a.min) a.min = v;
        if (v > a.max) a.max = v;
      }
      return acc;
    });
    const buckets = bounds
      .filter(b => (p.min === undefined || b.key >= p.min) && (p.max === undefined || b.key <= p.max))
      .map(b => {
        const bIdx = bounds.indexOf(b);
        const out = { key: b.key, doc_count: hits.popcountRange(b.from, b.to) };
        p.subs.forEach((s, si) => {
          if (s.numeric) {
            const a = numStats[si][bIdx];
            const avg = a.count ? a.sum / a.count : null;
            out[s.name] = s.kind === 'stats'
              ? { count: a.count, min: a.count ? a.min : null, max: a.count ? a.max : null,
                  avg, sum: a.sum }
              : { value: s.kind === 'avg' ? avg : s.kind === 'sum' ? a.sum
                        : s.kind === 'min' ? (a.count ? a.min : null) : (a.count ? a.max : null) };
            return;
          }
          const bs = subCounts[si]
            .map(([k, row]) => ({ key: k, doc_count: row[bIdx] }))
            .filter(x => x.doc_count > 0)
            .sort((x, y) => y.doc_count - x.doc_count);
          out[s.name] = { buckets: bs.slice(0, s.size) };
        });
        return out;
      })
      .filter(b => b.doc_count > 0);
    return { buckets };
  }

  _runAggs(plans, hits, got) {
    if (plans.length === 0) return null;
    const cat = this.catalog;
    const out = {};
    for (const p of plans) {
      if (p.kind === 'histogram') { out[p.name] = this._runHistogram(p, hits, got); continue; }
      const buckets = [];
      const masks = [];
      const wantMasks = (p.subs ?? []).length > 0;
      // Count every term first, materialise a bitmap only for the ones that
      // survive min_doc_count. An id-list section answers a count with a
      // membership test over a handful of ids; turning it into a dense bitmap
      // costs a pass over the whole document space. Doing that BEFORE
      // min_doc_count could discard it was the entire cost of a faceted query
      // over a high-cardinality field — 15 651 brands decoded and AND-ed to keep
      // 26, measured at 3 898 ms against 31 ms for the same 26 buckets.
      for (const [key, e] of p.entries) {
        const sec = cat.sections[e.section];
        const buf = got.get(e.section);
        let n, bm = null;
        if (sec.kind === 'ids') {
          const cnt = buf.readUInt32LE(0);
          n = 0;
          for (let i = 0; i < cnt; i++) if (hits.get(buf.readUInt32LE(4 + i * 4))) n++;
        } else {
          bm = decodeSection(cat, e.section, buf).and(hits);
          n = bm.popcount();
        }
        if (n < p.minDocCount) continue;
        buckets.push({ key, doc_count: n });
        // Built here, after the term has earned it — and only when a numeric
        // sub-aggregation will actually scan it.
        if (wantMasks) masks.push(bm ?? decodeSection(cat, e.section, buf).and(hits));
      }

      // Numeric sub-aggregations: a terms bucket is a scattered bitmap rather
      // than a contiguous range, so build doc -> bucket once and then the column
      // scan is O(1) per entry — one pass fills every bucket.
      if (wantMasks && buckets.length > 0) {
        const bucketOfDoc = new Int32Array(cat.docCount).fill(-1);
        masks.forEach((bm, bi) => { for (const d of bm.page(0, cat.docCount)) bucketOfDoc[d] = bi; });
        for (const sub of p.subs) {
          const vbuf = got.get(sub.vKey), dbuf = sub.dKey ? got.get(sub.dKey) : null;
          const acc = buckets.map(() => ({ count: 0, sum: 0, min: Infinity, max: -Infinity }));
          const n2 = sub.fm.count;
          for (let i = 0; i < n2; i++) {
            const doc = dbuf ? dbuf.readUInt32LE(i * 4) : i;
            const bi = bucketOfDoc[doc];
            if (bi < 0) continue;
            const v = vbuf.readDoubleLE(i * 8);
            const a = acc[bi];
            a.count++; a.sum += v;
            if (v < a.min) a.min = v;
            if (v > a.max) a.max = v;
          }
          buckets.forEach((b, bi) => {
            const a = acc[bi];
            const avg = a.count ? a.sum / a.count : null;
            b[sub.name] = sub.kind === 'stats'
              ? { count: a.count, min: a.count ? a.min : null, max: a.count ? a.max : null, avg, sum: a.sum }
              : { value: sub.kind === 'avg' ? avg : sub.kind === 'sum' ? a.sum
                        : sub.kind === 'min' ? (a.count ? a.min : null) : (a.count ? a.max : null) };
          });
        }
      }
      buckets.sort((a, b) => b.doc_count - a.doc_count || String(a.key).localeCompare(String(b.key)));
      out[p.name] = {
        doc_count_error_upper_bound: 0,
        sum_other_doc_count: buckets.slice(p.size).reduce((a, b) => a + b.doc_count, 0),
        buckets: buckets.slice(0, p.size),
      };
    }
    return out;
  }

  async _wave(ranges) {
    const out = new Map();
    const miss = [];
    for (const [k, r] of ranges) {
      const hit = this.cache.get(k);
      if (hit) out.set(k, hit); else miss.push([k, r]);
    }
    if (miss.length > 0) {
      // A numeric sub-aggregation plans the WHOLE column while a range filter on
      // the same column plans a span inside it. Both ride this wave, so the same
      // bytes would cross the wire twice. Fetch each maximal range once and cut
      // the contained ones out of it: on the 2010-cohort query that is 90 MB -> 55 MB.
      const sorted = [...miss].sort(([, a], [, b]) =>
        a.offset - b.offset || (b.offset + b.length) - (a.offset + a.length));
      const fetch = [];
      const slices = [];
      for (const [k, r] of sorted) {
        const last = fetch.length ? fetch[fetch.length - 1][1] : null;
        if (last && r.offset >= last.offset &&
            r.offset + r.length <= last.offset + last.length) {
          slices.push([k, fetch.length - 1, r.offset - last.offset, r.length]);
        } else fetch.push([k, r]);
      }

      // Split oversized ranges; all pieces stay in the SAME wave.
      const pieces = [];
      const owner = [];
      for (let j = 0; j < fetch.length; j++) {
        const [, r] = fetch[j];
        const parts = this.chunkSize > 0 && r.length > this.chunkSize
          ? Math.min(this.maxChunks, Math.ceil(r.length / this.chunkSize)) : 1;
        const per = Math.ceil(r.length / parts);
        for (let p = 0; p < parts; p++) {
          const off = r.offset + p * per;
          const len = Math.min(per, r.offset + r.length - off);
          if (len > 0) { pieces.push({ offset: off, length: len }); owner.push(j); }
        }
      }
      if (this.budget) {
        // Bill what the transport will really ask for: it merges nearby ranges,
        // and on the measured map artifact that is the difference between 193 088
        // GETs and 9. Attribute each piece to its range key so a refusal can name
        // the field responsible.
        const gap = this.transport.coalesceGap ?? this.coalesceGap ?? 0;
        this.budget.charge(pieces, pieces.map((_, i) => fetch[owner[i]][0]), { gap });
      }
      const bufs = await this.transport.readWave(pieces);
      const acc = fetch.map(() => []);
      bufs.forEach((b, i) => acc[owner[i]].push(b));
      const whole = fetch.map((_, j) => acc[j].length === 1 ? acc[j][0] : Buffer.concat(acc[j]));
      const keep = (k, buf) => {
        out.set(k, buf);
        if (this.cacheLimit > 0 && this.cacheBytes + buf.length <= this.cacheLimit) {
          this.cache.set(k, buf);
          this.cacheBytes += buf.length;
        }
      };
      fetch.forEach(([k], j) => keep(k, whole[j]));
      for (const [k, j, rel, len] of slices) keep(k, whole[j].subarray(rel, rel + len));
    }
    return out;
  }

  /** Estimate how deep into the sort column we must scan, then over-fetch. */
  _planSecondarySort(field, order, need, plan, body) {
    const cat = this.catalog;
    const m = cat.fields[field];
    if (!m || m.type !== 'numeric') {
      throw new QueryError(`sort field [${field}] has no ordered column; ` +
        `only the clustering key [${cat.clustering.field}] and numeric columns can be sorted on`);
    }
    const sel = Math.max(estimateSelectivity(plan, cat), 1 / cat.docCount);
    const depth = Math.min(m.count, Math.ceil((need / sel) * 4) + m.granule);
    const complete = depth >= m.count;
    let posLo = 0, posHi = m.count - 1;
    if (!complete) {
      if (order === 'desc') posLo = m.count - depth; else posHi = depth - 1;
    }
    // search_after: start near the cursor value instead of at the end.
    if (body.search_after !== undefined && Array.isArray(body.search_after)) {
      const v = Number(body.search_after[0]);
      if (Number.isFinite(v)) {
        const idx = m.sparse.findIndex(([sv]) => sv >= v);
        const anchor = idx < 0 ? m.count - 1 : m.sparse[Math.max(idx - 1, 0)][1];
        if (order === 'desc') { posHi = Math.min(anchor + m.granule, m.count - 1); posLo = Math.max(0, posHi - depth); }
        else { posLo = Math.max(0, anchor - m.granule); posHi = Math.min(m.count - 1, posLo + depth); }
      }
    }
    const n = posHi - posLo + 1;
    const v = cat.sections[m.sections.values], d = cat.sections[m.sections.docs];
    const vKey = `sort:${field}:v@${posLo}:${posHi}`;
    const dKey = `sort:${field}:d@${posLo}:${posHi}`;
    const ranges = new Map([
      [vKey, { offset: v.offset + posLo * 8, length: n * 8 }],
      [dKey, { offset: d.offset + posLo * 4, length: n * 4 }],
    ]);
    return { field, order, posLo, posHi, complete, ranges, m, vKey, dKey };
  }

  async _fetchWholeSortColumn(field) {
    const cat = this.catalog, m = cat.fields[field];
    const v = cat.sections[m.sections.values], d = cat.sections[m.sections.docs];
    const vKey = `sort:${field}:v@0:${m.count - 1}`;
    const dKey = `sort:${field}:d@0:${m.count - 1}`;
    const ranges = new Map([
      [vKey, { offset: v.offset, length: m.count * 8 }],
      [dKey, { offset: d.offset, length: m.count * 4 }],
    ]);
    return { posLo: 0, posHi: m.count - 1, m, vKey, dKey, got: await this._wave(ranges), ranges };
  }

  _pageBySortColumn(hits, sp, got, body, from, size) {
    const { order, posLo, posHi, m } = sp;
    const vbuf = got.get(sp.vKey), dbuf = got.get(sp.dKey);
    const n = posHi - posLo + 1;
    const out = [];
    let skipped = 0;
    let cursorValue = null, cursorDoc = null, passedCursor = true;
    if (body.search_after !== undefined && Array.isArray(body.search_after)) {
      cursorValue = Number(body.search_after[0]);
      cursorDoc = Number(body.search_after.at(-1));
      passedCursor = false;
    }
    const step = order === 'desc' ? -1 : 1;
    const start = order === 'desc' ? n - 1 : 0;
    for (let k = start; k >= 0 && k < n && out.length < size; k += step) {
      const docId = dbuf.readUInt32LE(k * 4);
      if (!passedCursor) {
        const v = vbuf.readDoubleLE(k * 8);
        if (v === cursorValue && docId === cursorDoc) passedCursor = true;
        continue;
      }
      if (!hits.get(docId)) continue;
      if (skipped < from) { skipped++; continue; }
      out.push(docId);
    }
    void m;
    return out;
  }

  async _fetchStored(docIds) {
    if (docIds.length === 0) return [];
    const { blockSize, blocks } = this.catalog.stored;
    const wanted = [...new Set(docIds.map(d => Math.floor(d / blockSize)))].sort((a, b) => a - b);
    let groups = coalesce(wanted, blocks, this.coalesceGap);
    // Only merge harder if we would otherwise exceed the concurrency budget.
    let gap = this.coalesceGap;
    while (groups.length > this.maxParallel && gap < 64 * 1024 * 1024) {
      gap *= 8;
      groups = coalesce(wanted, blocks, gap);
    }
    const req = groups.map(g => ({ offset: g.offset, length: g.length }));
    // Phase 2 is billable too, and on a wide page it is the larger half: 50
    // documents cost 1.13 MB of stored blocks against 0.22 MB of bitmaps. The
    // blocks are already merged above, so charge the list as it will be issued.
    this.budget?.charge(req, groups.map(() => 'stored:blocks'), { gap: 0 });
    const bufs = await this.transport.readWave(req);
    const blockBufs = new Map();
    groups.forEach((g, gi) => g.members.forEach(bi => {
      const b = blocks[bi];
      blockBufs.set(bi, bufs[gi].subarray(b.offset - g.offset, b.offset - g.offset + b.length));
    }));
    const binaryFields = this.catalog.stored.binaryFields ?? [];
    const schemas = this.catalog.stored.schemas;
    return docIds.map(docId => {
      const bi = Math.floor(docId / blockSize), buf = blockBufs.get(bi), b = blocks[bi];
      const local = docId - b.firstDoc, count = buf.readUInt32LE(0), tableEnd = 4 + 4 * count;
      const s = buf.readUInt32LE(4 + local * 4);
      const e = local + 1 < count ? buf.readUInt32LE(4 + (local + 1) * 4) : buf.length - tableEnd;
      const rec = buf.subarray(tableEnd + s, tableEnd + e);
      if (!schemas) return JSON.parse(rec.toString('utf8'));   // artifact written before schemas
      return decodeRecord(rec, schemas, binaryFields);
    });
  }
}

/**
 * `uvarint schemaId | tagged value per field, in schema order | (u32 len | bytes)
 * per binary field`. Names come from the catalog's schema table, never from the
 * record — that is the whole saving.
 */
function decodeRecord(rec, schemas, binaryFields) {
  let o = 0;
  const uvar = () => { let z = 0, sh = 0, b;
    do { b = rec[o++]; z |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return z >>> 0; };
  const zig = () => { const z = uvar(); return (z >>> 1) ^ -(z & 1); };
  const fields = schemas[uvar()];
  const doc = {};
  for (const f of fields) {
    const tag = rec[o++];
    if (tag === 0) { doc[f] = null; continue; }
    if (tag === 1) { doc[f] = zig(); continue; }
    if (tag === 2) { doc[f] = rec.readDoubleLE(o); o += 8; continue; }
    if (tag === 3) { const n = uvar(); doc[f] = rec.toString('utf8', o, o + n); o += n; continue; }
    if (tag === 4) { doc[f] = true; continue; }
    if (tag === 5) { doc[f] = false; continue; }
    if (tag === 6) continue;                                  // absent, not null

    throw new Error(`stored record: unknown value tag ${tag} for field [${f}]`);
  }
  for (const f of binaryFields) {
    const n = rec.readUInt32LE(o); o += 4;
    if (n === 0xffffffff) continue;
    doc[f] = rec.subarray(o, o + n); o += n;
  }
  return doc;
}

function coalesce(wanted, blocks, gap) {
  const groups = [];
  for (const bi of wanted) {
    const b = blocks[bi], last = groups.at(-1);
    if (last && b.offset - (last.offset + last.length) <= gap) {
      last.length = b.offset + b.length - last.offset; last.members.push(bi);
    } else groups.push({ offset: b.offset, length: b.length, members: [bi] });
  }
  return groups;
}

function resolveSort(sort, cat) {
  if (!sort) return { field: cat.clustering.field, order: 'asc' };
  const arr = Array.isArray(sort) ? sort : [sort];
  if (arr.length === 0) return { field: cat.clustering.field, order: 'asc' };
  const first = arr[0];
  const [field, spec] = typeof first === 'string' ? [first, 'asc'] : Object.entries(first)[0];
  const order = (typeof spec === 'string' ? spec : (spec?.order ?? 'asc')) === 'desc' ? 'desc' : 'asc';
  return { field: field === '_doc' ? cat.clustering.field : field, order };
}

/** Crude selectivity estimate from catalog statistics — used only for sizing. */
function estimateSelectivity(node, cat) {
  const n = cat.docCount;
  switch (node.op) {
    case 'all': return 1;
    case 'none': return 0;
    case 'section': {
      for (const m of Object.values(cat.fields)) {
        if (m.sections?.true && cat.sections[m.sections.true] && m.sections.true === node.name)
          return (m.stats.trueCount ?? n) / n;
        if (m.values) for (const e of Object.values(m.values))
          if (e.section === node.name) return e.count / n;
      }
      return 0.5;
    }
    case 'column': return 0.3;
    case 'wildcard': return 0.1;
    case 'and': return node.children.reduce((p, c) => p * estimateSelectivity(c, cat), 1);
    case 'or': return Math.min(1, node.children.reduce((p, c) => p + estimateSelectivity(c, cat), 0));
    case 'xor': return 0.5;
    case 'andNot': return estimateSelectivity(node.left, cat) * (1 - estimateSelectivity(node.right, cat));
    default: return 0.5;
  }
}
