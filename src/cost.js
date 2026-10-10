/**
 * What a query costs, known before any byte is fetched.
 *
 * The planner computes byte ranges without I/O, so the request count and the
 * bytes are both knowable in advance. That makes the bill predictable — and
 * enforceable. One measured query asked for 193 088 byte ranges; uncoalesced
 * that is ~77 USD of S3 GETs for a single view, against 0.000004 USD once the
 * ranges are merged. A format whose cost can swing by seven orders of magnitude
 * on one parameter should not let that happen silently.
 */

/** List prices, per host. Bytes are per byte; requests are per request. */
export const HOSTS = {
  // S3 in the same region as the caller: transfer is free, GETs are not.
  's3': { label: 'S3, same region', requestUSD: 0.0004 / 1000, byteUSD: 0 },
  // S3 straight to the internet: both.
  's3-internet': { label: 'S3 to internet', requestUSD: 0.0004 / 1000, byteUSD: 0.09 / 1e9 },
  // CloudFront in front of S3.
  'cloudfront': { label: 'CloudFront', requestUSD: 0.0075 / 10000, byteUSD: 0.085 / 1e9 },
  // Static hosting with no per-request price but a monthly transfer quota.
  'pages': { label: 'GitHub Pages', requestUSD: 0, byteUSD: 0, quotaBytesPerMonth: 100e9 },
  'local': { label: 'local disk', requestUSD: 0, byteUSD: 0 },
};

export function priceOf(host) {
  const h = typeof host === 'string' ? HOSTS[host] : host;
  if (!h) throw new Error(`unknown host [${host}]; known: ${Object.keys(HOSTS).join(', ')}`);
  return h;
}

/** Money for a given request/byte count on a host. */
export function estimate({ requests = 0, bytes = 0 }, host = 's3') {
  const h = priceOf(host);
  const usd = requests * h.requestUSD + bytes * h.byteUSD;
  return { host: h.label, requests, bytes, usd,
    ...(h.quotaBytesPerMonth ? { viewsPerMonth: Math.floor(h.quotaBytesPerMonth / Math.max(1, bytes)) } : {}) };
}

/**
 * What the transport will actually ask for.
 *
 * A guard that counts planned ranges would refuse queries the transport merges
 * down to a handful of GETs — the 193 088-range view really does cost 9 requests
 * once a 64 kB gap is bridged. So the budget bills the coalesced plan, and keeps
 * the raw count only to explain how close the query came to the cliff.
 */
export function coalesce(ranges, gap = 0) {
  const bytesRaw = ranges.reduce((a, r) => a + r.length, 0);
  if (!(gap > 0) || ranges.length < 2)
    return { requests: ranges.length, bytes: bytesRaw, bytesRaw, raw: ranges.length, overFetch: 1 };
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  // Merging means fetching the holes too — that is the price of the merge, and
  // on a transfer-priced host it is the whole bill. Report it, don't hide it.
  let requests = 0, bytes = 0, start = 0, end = -Infinity;
  for (const r of sorted) {
    if (r.offset > end + gap) {
      if (end > -Infinity) bytes += end - start;
      requests++; start = r.offset; end = r.offset + r.length;
    } else end = Math.max(end, r.offset + r.length);
  }
  if (end > -Infinity) bytes += end - start;
  return { requests, bytes, bytesRaw, raw: ranges.length,
           overFetch: bytesRaw > 0 ? bytes / bytesRaw : 1 };
}

export class BudgetExceeded extends Error {
  constructor(message, detail) { super(message); this.name = 'BudgetExceeded'; this.detail = detail; }
}

/**
 * A spend limit checked before each wave is issued.
 *
 * `mode: 'throw'` refuses the query; `'warn'` reports and continues. The refusal
 * names the fields responsible, because the range keys carry them — a terms
 * aggregation over a high-cardinality field shows up as thousands of
 * `bm:<field>:<value>` ranges, and that is the actionable fact.
 */
export class Budget {
  constructor({ requests = Infinity, bytes = Infinity, rounds = Infinity,
                usd = Infinity, host = 's3', mode = 'throw', onReport } = {}) {
    this.limit = { requests, bytes, rounds, usd };
    this.host = priceOf(host);
    this.mode = mode;
    this.onReport = onReport;
    this.reset();
  }

  reset() { this.spent = { requests: 0, bytes: 0, rounds: 0, usd: 0 }; }

  /** Group range keys by `kind:field` so a refusal can name the cause. */
  static blame(keys) {
    const by = new Map();
    for (const k of keys) {
      const p = String(k).split(':');
      const name = p.length >= 2 ? `${p[0]}:${p[1]}` : String(k);
      by.set(name, (by.get(name) ?? 0) + 1);
    }
    return [...by].sort((a, b) => b[1] - a[1]);
  }

  /**
   * Account for one wave. `pieces` are the requests about to be issued and
   * `keys` the range key per piece. Throws before any I/O when over budget.
   */
  charge(pieces, keys = [], { gap = 0 } = {}) {
    const plan = coalesce(pieces, gap);
    const { requests, bytes, raw, overFetch } = plan;
    const next = {
      requests: this.spent.requests + requests,
      bytes: this.spent.bytes + bytes,
      rounds: this.spent.rounds + 1,
      usd: this.spent.usd + requests * this.host.requestUSD + bytes * this.host.byteUSD,
    };
    const over = Object.keys(this.limit).filter(k => next[k] > this.limit[k]);
    if (over.length) {
      const blame = Budget.blame(keys).slice(0, 5);
      const detail = { over, spent: this.spent, wave: { requests, bytes, raw, gap }, next,
                       limit: this.limit, host: this.host.label, blame };
      const lines = [
        `query refused: ${over.map(k => `${k} ${fmt(k, next[k])} > limit ${fmt(k, this.limit[k])}`).join(', ')}`,
        `  this wave: ${requests.toLocaleString('en')} requests, ${fmt('bytes', bytes)}` +
        `, $${next.usd.toFixed(6)} on ${this.host.label}`,
      ];
      if (raw !== requests)
        lines.push(`  (${raw.toLocaleString('en')} planned ranges coalesced into ${requests.toLocaleString('en')}` +
                   ` at a ${(gap / 1024).toFixed(0)} kB gap, ${overFetch.toFixed(2)}x over-fetch)`);
      else if (raw > 1000 && !gap)
        lines.push(`  the transport does not coalesce; with a 64 kB gap this wave would` +
                   ` likely collapse to a handful of requests. Pass {coalesceGap: 65536}.`);
      if (blame.length) {
        lines.push('  ranges by field:');
        for (const [name, n] of blame) lines.push(`    ${name.padEnd(28)} ${n.toLocaleString('en')}`);
        const [top, n] = blame[0];
        if (n > requests * 2) lines.push(
          `  [${top}] dominates. A terms aggregation over a high-cardinality field asks` +
          ` for one range per value; reduce its size, or move the selector into the` +
          ` clustering key so the rows are contiguous.`);
      }
      const err = new BudgetExceeded(lines.join('\n'), detail);
      if (this.mode === 'throw') throw err;
      this.onReport?.(err);
    }
    this.spent = next;
    this.onReport?.(null, { requests, bytes, raw, spent: this.spent });
    return this.spent;
  }
}

const fmt = (k, v) =>
  v === Infinity ? '∞'
  : k === 'bytes' ? bytes(v)
  : k === 'usd' ? `$${v.toFixed(6)}`
  : v.toLocaleString('en');

const bytes = (v) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB`
  : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB`
  : v >= 1e3 ? `${(v / 1e3).toFixed(1)} kB`
  : `${v} B`;
