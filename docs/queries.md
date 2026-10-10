# Queries: what each one reads, and what it costs

The client surface is deliberately OpenSearch-shaped so that calling code moves
across with little change. What differs is that **every query's byte cost is
computable before any I/O happens** — the planner turns a query into a list of
byte ranges using only the resident catalog. That is what makes the guard in
[billing.md](billing.md) possible, and it is the organising idea of this
document: for each clause, *which structure does it read, and how does the cost
scale?*

An unsupported clause throws `QueryError` naming what is missing. It never
silently returns wrong results.

## The structures

An artifact is a footer, a catalog, and a run of immutable sections. Five kinds
of structure answer everything:

| structure | section key | what it is | what reads it |
|---|---|---|---|
| **bitmap** | `bm:<field>:kw:<value>`, `bm:<field>:true`, `bm:<field>:exists` | one bit per document | `term`, `terms`, `exists`, `prefix`/`wildcard` on keyword, `terms` aggs |
| **sorted column** | `col:<field>:values` (8 B/entry), `col:<field>:docs` (4 B/entry) | (value, doc-id) pairs in **value** order | `range`, numeric `term`, sort, numeric stats |
| **sparse boundary table** | *in the catalog* — `fields.<f>.sparse` | every 128th value, resident | locating the span of a `range` without probing |
| **trigram postings** | `tri:<field>:<gram>` | candidate value-ids per 3-gram | `wildcard`/`prefix` on `text` |
| **stored blocks** | `stored.blocks[]` | the documents themselves, 128 per block (`blockSize`) | returning `hits` |

Two properties do most of the work. Bitmaps make set algebra **exact and free**:
`popcount(hits AND value)` is a bucket count, with no scan and no round trip.
And the catalog is **resident**, so value enumeration, span location and section
addressing all happen in memory — which is why every address in a wave is known
at once and the wave costs one round trip rather than one per step.

---

## Leaf clauses

### `term` — one value

```js
{ query: { term: { kunta: 'k042' } } }
```

| field type | reads | ranges | cost |
|---|---|---|---|
| `keyword` | the value's bitmap | 1 | flat; independent of corpus size |
| `boolean` | `bm:f:true` (and `bm:f:exists` for `false`) | 1–2 | flat |
| `numeric` | a **span** of the sorted column | 1–2 | ∝ number of matching entries |
| `text` | routed to the trigram path below | 3+ | see `wildcard` |

A keyword `term` is the cheapest thing in the index: the catalog already holds
the value → section mapping, so one range is planned and one bitmap comes back.
**Measured: 2 requests, 0.22 MB, 648 hits.**

A numeric `term` is *not* a bitmap lookup — it is a degenerate range, `[v, v]`,
over the sorted column. Fine, but it reads column bytes, not a bitmap.

### `terms` — several values

```js
{ query: { terms: { merkki: ['a', 'b', 'c'] } } }
```

An `OR` over one bitmap per value. **One range per value named.** 20 values →
21 ranges, 0.10 MB. The scaling is linear in the *list length*, not the corpus:
20 values is nothing; 20 000 is the shape that gets refused.

### `exists`

```js
{ query: { exists: { field: 'merkki' } } }
```

One bitmap, `bm:f:exists`. 2 requests, 0.03 MB. Absence is stored explicitly, so
`exists`, boolean-`false` and null are all distinguishable.

### `range` — the only clause that uses the boundary table

```js
{ query: { range: { ts: { gte: 20100101, lt: 20110101 } } } }
```

Requires a **numeric** column; anything else throws. The column holds (value,
doc-id) pairs sorted by value, and the catalog holds every 128th value. So:

1. Scan the resident sparse table for the granules bracketing `lo` and `hi`.
   **No I/O** — this is the whole point of keeping it in the catalog.
2. Fetch exactly that span of `values` (8 B/entry) and `docs` (4 B/entry).
3. Verify the edges and build the bitmap.

The cost is proportional to the *matching span*, not the column. But:

> **On the clustering key, a range is also contiguous in document order.** 5 840
> hits for **0.06 MB**. The same selectivity on a non-clustering numeric costs
> **1.18 MB** — 20× the bytes for a comparable number of rows.
>
> This is the finding the whole project turns on: **a predicate outside the
> clustering key selects rows, not bytes.** Only the clustering key reduces I/O.
> Choosing it is the single most consequential decision at build time.

When a field's doc-ids are already identity (`implicitDocs`), the `docs` range is
skipped entirely — one range instead of two.

### `prefix`

```js
{ query: { prefix: { merkki: 'merkki-1' } } }
```

On a **keyword** field the catalog is enumerated in memory to find every matching
value, then their bitmaps are OR-ed. Zero probes to discover the matches — but
**one range per matching value**. `merkki-1` matches 92 of 180 values: 92 ranges,
0.41 MB, 101 113 hits. The library's coalescing collapses those to **2 requests**
because keyword bitmaps for one field are laid out together.

On a **text** field it becomes `wildcard` with `value*`.

A prefix over a 50 000-value field plans 50 000 ranges. Same shape as the
dangerous aggregation; same remedy.

### `wildcard`

```js
{ query: { wildcard: { nimi: '*maasturi*' } } }
```

On **keyword**: the pattern becomes a regexp, applied to the catalog's value
list. Same cost shape as `prefix`.

On **text**: literal runs of ≥3 characters become trigrams, and the postings for
those trigrams narrow the candidate value-ids. The postings, the values section
and the exists bitmap are all catalog-addressable, so **they ride in the same
wave** — one round trip, not a probe per trigram. The exact pattern is then
verified against the fetched values, so trigram narrowing never produces a false
positive.

If any required trigram is absent from the index, the clause compiles straight to
`match_none` with no I/O at all.

Measured: 9 ranges, 6.44 MB, 50 000 hits. The bytes come from the values section
— a text field pays in bytes where a keyword field pays in requests.

### `match_all` / `match_none`

Free. No ranges.

---

## `bool`

```js
{ query: { bool: {
    must:     [{ term: { kunta: 'k042' } }],
    filter:   [{ range: { teho: { gte: 100 } } }],
    must_not: [{ term: { sahko: true } }],
    should:   [{ term: { merkki: 'a' } }],
    minimum_should_match: 1,
} } }
```

`must` and `filter` are identical here — there is no scoring, so there is nothing
for `filter` to skip. `should` contributes only when there is no other required
clause, or when `minimum_should_match >= 1`. The tree becomes `and` / `or` /
`andNot` over bitmaps, evaluated with word-wise bit operations after a single
wave fetches every leaf.

**Every leaf of the whole tree is planned before any of it is fetched.** A
six-leaf bool is still 2 rounds: 6 ranges, 1.99 MB. Depth costs nothing; only
the number of distinct values named costs anything.

---

## Aggregations

### `terms`

```js
{ size: 0, aggs: { m: { terms: { field: 'merkki', size: 200 } } } }
```

Every bucket is `popcount(hits AND valueBitmap)` — exact, no scan, no second
round trip. The bitmaps are catalog-addressable so they all ride one wave: **1
round trip for the entire facet**. 180 buckets: 180 ranges, 0.80 MB, collapsing
to **1 request**.

Requires a `keyword` or `boolean` field.

> **This is the shape that costs money.** The plan is one range per *distinct
> value in the field* — not per bucket returned. `size: 10` on a 50 000-value
> field still plans 50 000 ranges, because the top 10 cannot be known without
> counting all of them. Measured: 50 000 ranges, **$0.02 per query, $20 per
> thousand** if issued as written.
>
> It is also exactly why the counts are *correct*. Top-k that merges across
> segments silently undercounts — measured up to 20.9 % error. Counting every
> value avoids that, and coalescing makes it affordable: 50 000 ranges → **1
> request**, because one field's bitmaps are contiguous.

After the first load the sections are **cached**, and sections of an immutable
artifact can never be stale. So every subsequent filter change over the same
facet is popcount in memory with **no network at all**. This is why faceted
redraws feel instant and cost nothing.

### `histogram`

```js
{ size: 0, aggs: { h: { histogram: { field: 'ts', interval: 'year',
    aggs: { m: { terms: { field: 'merkki', size: 200 } } } } } } }
```

**Only on the clustering key**; anything else throws, because any other field
would need its own ordering. `interval` is either a positive number or the
literal `'year'`, which means *"this key is a `YYYYMMDD` integer"* and buckets by
`v / 10000`. On an epoch-millisecond key that would produce nonsense, so the
reader checks `interval: 'year'` against the catalog's clustering boundaries —
resident, free — and refuses the mismatch with the numeric interval to use
instead. Buckets are contiguous doc-id intervals, so bucket
membership is `popcountRange` — no per-bucket bitmap at all. A `terms` sub-agg
therefore costs one pass per term over the whole bitmap, not one per bucket:
181 ranges for 35 buckets × 180 terms. 2 requests, 2.40 MB.

### Numeric sub-aggregations — `stats`, `avg`, `sum`, `min`, `max`

These read the **whole** sorted column (values + docs), not a span, because they
must visit every document in the bucket. 3.20 MB for one column over 200 000
documents, in 1 round trip.

The columns are stored in *value* order with a doc-id permutation. That answers
range predicates but not "what is document X's value?" — a sum would normally
need a second copy in document order. Under a histogram it does not, because
every bucket is a contiguous doc-id interval, so one scan of the (value, doc)
pairs fills every bucket at once. Doc-order storage would only pay off for a
query restricted to a narrow slice.

Sub-aggregations under `terms` must be numeric statistics. `terms` nested inside
`terms` is not supported; use a histogram, or run the second facet client-side
from the cached bitmaps.

---

## Sorting and paging

| request | mechanism | cost |
|---|---|---|
| default / clustering key | the hit bitmap is already in clustering order | free |
| `sort: [{ other: 'desc' }]` | the sorted column used as a permutation | a span, over-fetched |
| `search_after` | seek within the bitmap | free |
| `from` / `size` | bitmap page | free |

A sort on a non-clustering column needs the column span covering the requested
page. That span is *estimated from catalog statistics and over-fetched in the
same wave* — speculative over-fetch instead of a dependent probe. If the estimate
falls short, one supplementary fetch happens and is counted honestly in `took`
and in the budget. Measured: 9 ranges, 0.30 MB, 2 rounds.

Returning the documents reads **stored blocks** (`blockSize`, 128 by default), so the
bytes scale with how many distinct blocks the page touches. Hits in clustering
order touch few blocks; hits scattered by a non-clustering sort touch many. 50
documents from one neighbourhood: 2 requests, 1.13 MB.

---

## The shape of a query's cost

Every clause reduces to the same question — **how many distinct values does this
query name?**

| plans ~1 range | plans one range **per value** | plans the whole column |
|---|---|---|
| `term` (keyword/bool) | `terms` (per listed value) | numeric `stats`/`avg`/`sum` |
| `exists` | `prefix`, `wildcard` (keyword) | sort on a non-clustering field |
| `range` (a span) | `terms` **aggregation** (per distinct value) | |
| `match_all` | | |

The middle column is where bills come from, and the responsible field is always
nameable. That is why `BudgetExceeded` prints the range keys grouped by field:

```
  ranges by field:
    bm:kaupallinenNimi           193,088
```

Three remedies, in order of preference:

1. **Move the selector into the clustering key.** The only change that reduces
   bytes rather than rows.
2. **Change the field's representation at build time.** A string field with more
   than `keywordMaxCardinality` distinct values (default 256) is indexed as
   `text` — trigram postings, which plan a handful of ranges rather than one per
   value. Raising the threshold buys exact bitmaps and pays in request count;
   lowering it does the reverse. `indexFields` drops a field from the index
   altogether while leaving it in the stored record, which is the right answer
   for anything that is displayed but never queried.
3. **Let the transport coalesce.** `coalesceGap: 65536` is the default and turns
   50 000 ranges into 1 request. It is a precondition, not an optimisation.

## Reproducing every number here

```
node tools/cost-report.js --docs 200000 --md
```

Builds the artifact, runs every shape above, and prints the table in
[billing.md](billing.md).
