# L0_idx

An immutable, range-addressable search index. The reader is a pure function of
`(query, artifact)` — no server, no session, no process running between queries.

All four stages are implemented: **boolean bitmaps**, **sort-key intervals**,
**numeric/date columns**, **keyword bitmaps**, and **trigram infix search**.

## The claim

The design constraint on object storage is **dependent round trips**, not bytes
or CPU. One probe costs 20–50 ms while bandwidth is nearly free, so the objective
is to make every address computable from resident metadata and every remaining
fetch independent.

> **A warm query costs exactly two dependent round trips** — one wave for the
> index, one for the page — regardless of how many predicates it carries.

This is asserted by the test suite and made audible by a latency-simulating
transport.

## Quick start

```bash
npm run gen        # 1500 deterministic documents
npm run build      # -> data/messages.l0
npm run demo       # every query type, with probe accounting
npm run latency    # the same queries at 30 ms per round trip
npm test           # 110 tests
```

## What it does

```js
import { build, L0Client } from 'l0-idx';

await build({ docs, index: 'messages', outPath: 'messages.l0' });
const client = new L0Client({ artifacts: { messages: 'messages.l0' } });

await client.search({ index: 'messages', body: {
  query: { bool: {
    filter: [
      { term:     { isDelivered: true } },                                   // boolean bitmap
      { range:    { createdAt: { gte: '2026-06-01T00:00:00Z' } } },          // clustering interval
      { range:    { retryCount: { lte: 2 } } },                              // numeric column
      { term:     { sender: 'Aatu' } },                                     // keyword bitmap
      { wildcard: { subject: '*lasku*' } },                                  // trigram infix
    ],
    must_not: [{ term: { isTest: true } }],
  }},
  size: 25,
  sort: [{ createdAt: 'desc' }],
}});
```

Field types are **inferred at build time**, not declared: booleans become
bitmaps, numbers become sorted columns, strings become keyword bitmaps below 256
distinct values and trigram-indexed text above it.

### Query DSL

`match_all`, `match_none`, `term`, `terms`, `exists`, `range` (`gt`/`gte`/`lt`/`lte`,
numbers, `Date`, or ISO strings), `prefix`, `wildcard` (`*` and `?`), `bool`
(`must`/`filter`/`should`/`must_not`/`minimum_should_match`), `size`, `from`,
`sort`, `search_after`.

The response envelope is OpenSearch-shaped. Unsupported clauses **throw** rather
than silently returning wrong results.

## Measured

`npm run demo`, 1500 documents:

| query | hits | rounds | reads | bytes |
|---|---|---|---|---|
| `match_all` | 1500 | **1** | 1 | 9 645 |
| A · `isRead=true` | 638 | **2** | 2 | 9 833 |
| A · delivered AND unread | 611 | **2** | 3 | 10 021 |
| A′ · `createdAt` in June | 196 | **2** | 2 | 12 549 |
| B · `retryCount >= 3` | 459 | **2** | 3 | 15 357 |
| B · `sender = Aatu` | 132 | **2** | 2 | 9 833 |
| C · `subject *lasku*` | 182 | **2** | 6 | 53 646 |
| **A+B+C combined** | 92 | **2** | **10** | 44 100 |

Rounds stay at two as predicates accumulate; only the number of *independent*
reads in the wave grows. That is the entire thesis in one column.

### At 30 ms per round trip

`npm run latency`:

```
query                          hits  rounds reads   bytes   actual   if serial
match_all                       1500      1     1    9645    32 ms      30 ms
term isRead=true                 638      2     2    9833    62 ms      60 ms
range retryCount >= 3            459      2     3   15357    64 ms      90 ms
wildcard subject *lasku*         182      2     6   72838    66 ms     181 ms
A+B+C combined                    92      2    11   72840    65 ms     331 ms
```

The combined query issues eleven ranges and still costs two round trips: 65 ms
instead of 331 ms. Pagination stays flat at ~32 ms per page from page 1 to page
44, because a cursor is a sort-key value and the next page is an adjacent
interval.

The read counts here are lower than an earlier revision of this table reported,
because the reader no longer merges adjacent ranges by default — merging buys
nothing when the whole wave is already in flight, and it fetched the gaps as
well. See `src/transport/coalesce.js`.

## Format

Footer-first — one read of the tail reveals everything.

```
┌────────────────────────────────────────────────────────┐
│ bitmaps     bm:<field>:true | :exists | :kw:<value>    │
│ columns     col:<field>:values (f64) + :docs (u32)     │
│ text        txt:<field>:values, tri:<field>:postings   │
│ stored      [count][offset table][json payloads]       │ ← offsets ride WITH the block
│ catalog     JSON                                       │
│ footer      magic(8) + catalogOffset + length          │ ← fixed 16 bytes, last
└────────────────────────────────────────────────────────┘
```

The **catalog is the resident navigator**. The rule deciding its contents:

> Anything needed to *compute a byte range* belongs in the catalog.
> Anything that *is* the answer belongs in the payload.

So it carries section offsets, per-block offsets, the clustering boundary table,
a sparse index per numeric column, the keyword value list, the trigram
dictionary, statistics, capabilities, version and content hash.

A bitmap needs no navigator at all — `offset = base + docID/8` is arithmetic.

### Structures

| Stage | Predicate | Structure | Ranges fetched |
|---|---|---|---|
| A | boolean `term`/`exists` | bitmap | 1 |
| A′ | range on clustering key | column slice, doc IDs implicit | 1 |
| B | range on number/date | column slice + doc slice, span from sparse index | 2 |
| B | keyword `term`/`prefix` | bitmap per value; enumeration in the catalog | 1 per value |
| C | `wildcard` / infix | trigram postings ∩, verified against stored values | n grams + 2 |

**Sparse indexes are built over positions, not values.** Indexing at value
boundaries would leave the fetch span unbounded when one value is very common;
every 128th *position* bounds it to two granules regardless of distribution.

**Secondary sort orders reuse the range index.** A sorted-by-`x` column *is* the
permutation needed to sort by `x`, so `sort: [{ retryCount: 'desc' }]` costs no
extra structure. Its scan depth is estimated from catalog statistics and
over-fetched speculatively, so it rides in the same wave; if the estimate falls
short a supplementary fetch happens and is counted honestly.

## Design notes

- **Transport is abstracted** — `readRange` / `readWave`, counting `rounds`,
  `reads` and `bytes`. `FileTransport` today; S3 or HTTP-Range changes nothing
  above it. `LatencyTransport` wraps either and charges latency per *round* and
  bandwidth per byte.
- **Validation is differential.** `test/reference.js` re-implements the whole DSL
  as a brute-force filter over plain objects. Every query — including 200
  randomly generated ones mixing all five predicate types — must agree with it on
  both hit count and order.
- **Exact counts are free.** `popcount` on the result bitmap, so no
  `track_total_hits` tradeoff exists.
- **Trigram AND is a superset**, since it ignores gram order, so wildcards are
  always verified against the stored values before a document is returned.

## Known limits

- **Single segment.** No multi-segment artifacts or partition pruning, so the
  whole corpus is one file. Fine to ~10 M documents on the sizing rule *"a full
  predicate bitmap should fit the host's free-over-fetch budget"*; beyond that,
  segments are needed.
- **Wildcard verification fetches the whole values section.** Exact and one
  round trip at this scale, but it is `O(corpus)` bytes. A real implementation
  would verify against block-resident values or accept a third round trip.
- **No writes.** This is L0 by construction: build a new artifact and swap the
  version pointer. Deltas, tombstones and a manifest would be L1.
- **No compression.** Payloads are raw JSON; the artifact is ~415 B/doc where a
  compressed one would be a fraction of that.
- **`from`-based paging on a secondary sort** scans the permutation, so it grows
  with offset. Only the clustering order gives genuinely flat deep pagination.

## Layout

```
src/bitmap.js          bitmaps: and/or/xor/andNot, popcount, select(k), cursors
src/format.js          magic, section naming, trigram + wildcard helpers
src/build/builder.js   type inference, clustering order, all five structures
src/query/compile.js   DSL -> plan tree (every producer yields a bitmap)
src/read/plan.js       plan -> byte ranges (no I/O), then evaluation
src/read/reader.js     three-phase execution, sorting, pagination, coalescing
src/transport/         file.js, latency.js
src/client.js          OpenSearch-shaped surface
```
