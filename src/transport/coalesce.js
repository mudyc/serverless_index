/**
 * Deciding which byte ranges to merge into one request.
 *
 * idx_research §13.4 derived "merge when gap < latency x bandwidth" (~3 MB on
 * S3). That derivation assumed the alternative was a SECOND ROUND TRIP. It is
 * wrong for a parallel wave, where the alternative is one more independent
 * range at essentially zero added latency — so merging there only buys bytes.
 *
 * Measured on a 200k-document artifact: a 20-value `terms` query plans 21
 * ranges. Merging them at a 64 kB gap turns 21 requests into 2 — and 0.10 MB
 * into 0.77 MB, a 7.8x over-fetch, for no round-trip saved, because 21 requests
 * already fit one wave.
 *
 * So the rule is: merge to get BELOW the concurrency budget, not by default.
 *   1. Always merge touching or overlapping ranges — that is free.
 *   2. Under the budget, stop. The requests are concurrent; bytes are the cost.
 *   3. Over the budget, widen the gap until the count fits — the 50 000-range
 *      aggregation that would otherwise be 50 000 GETs ($0.02 a query, and 77
 *      USD for the view that planned 193 088 of them).
 *   4. Stop widening if it would pull in more than `maxFetchBytes`. Past that
 *      point the query is genuinely expensive and the budget should refuse it
 *      rather than the transport quietly buying a whole artifact.
 */
export function planGroups(ranges, { gap = 65536, maxParallel = 24,
                                     maxFetchBytes = 64 * 1024 * 1024 } = {}) {
  if (ranges.length < 2) return null;
  const order = ranges.map((_, i) => i).sort((a, b) => ranges[a].offset - ranges[b].offset);
  const rawBytes = ranges.reduce((a, r) => a + r.length, 0);

  const group = (g) => {
    const groups = [];
    let cur = null;
    for (const i of order) {
      const { offset, length } = ranges[i];
      if (cur && offset <= cur.end + g) { cur.end = Math.max(cur.end, offset + length); cur.members.push(i); }
      else { cur = { start: offset, end: offset + length, members: [i] }; groups.push(cur); }
    }
    return groups;
  };
  const bytesOf = (groups) => groups.reduce((a, g) => a + (g.end - g.start), 0);

  // 1. Touching ranges: strictly free, so always.
  let best = group(0);
  if (best.length <= maxParallel) return best.length < ranges.length ? best : null;

  // 2-4. Widen only as far as the concurrency budget demands.
  for (let g = Math.max(1, gap); ; g *= 4) {
    const cand = group(g);
    const bytes = bytesOf(cand);
    if (bytes > maxFetchBytes && bytes > rawBytes * 2) break;  // too greedy; let the budget speak
    best = cand;
    if (cand.length <= maxParallel || cand.length === 1) break;
  }
  return best.length < ranges.length ? best : null;
}
