# An index file format defined by its write consistency model

Research notes. Status: exploratory, no implementation.

## 1. Thesis

Search index formats are usually described by their storage medium — "on disk",
"on S3", "in memory". That framing is wrong, or at least secondary. **What
determines the design is when a write becomes visible.** Everything else —
segment layout, caching, concurrency, whether a server must exist at all —
follows from that one decision.

So define the index by a ladder of write consistency models:

| | Model | A write becomes visible… | Requires a running process? |
|---|---|---|---|
| **L0** | **none** | never — the index is a fixed artifact | no |
| **L1** | **eventually available** | within a bounded lag | no |
| L2 | read-your-writes | immediately, to the writer | yes |
| L3 | linearizable | immediately, to everyone | yes, with consensus |

The claim this document explores:

> **L0 and L1 cover the large majority of real search workloads, and everything
> expensive about running a search engine lives at L2 and above.**

Always-on clusters, replica placement, consensus, shard allocation, node
failover — all of it exists to serve L2/L3 semantics. A search box over a
document corpus does not need them. "The document you just added appears within
a minute" is an acceptable contract almost everywhere it is honestly examined.

The programme follows the user's framing directly:

1. **Assume L0. Solve it completely.** No writes at all. This is not a toy case
   to be passed through — it is where the format is actually designed, and it
   admits optimisations that are impossible once writes exist (§4).
2. **Build L1 on top of L0.** An eventually-available index is an ordered list
   of L0 artifacts plus a tombstone overlay. The hard parts stay confined to a
   small, recent delta; the base never changes (§7).

This document is about the technique. The system that prompted it appears only
as a source of a realistic test corpus (Appendix A).

## 2. The temporal dimension

The ladder above is really a statement about time, and time turns out to be the
organising structure of the whole design rather than an incidental property.

### An index is a snapshot, and therefore has an identity

An immutable index is the state of a corpus **as of a moment**. That makes it a
value, not a place: it can be named by the hash of its contents, copied freely,
compared, retained, and discarded. Queries become pure functions of
`(query, version)`.

Three consequences fall out immediately, and all three are load-bearing:

**Caching becomes trivially correct.** Immutable bytes can be cached forever, at
every layer, with no invalidation logic: `Cache-Control: public, max-age=31536000,
immutable` in a browser, indefinitely in a CDN edge, in Lambda `/tmp`, in EFS.
The hardest problem in most caching systems simply does not arise. For the
browser host this is not a minor convenience — it is what makes client-side
search over a large corpus viable at all.

**Results are reproducible.** The same query against the same version returns
the same result, permanently. This is rare in search systems and quietly
valuable: regression tests that do not flake, bug reports that can be replayed,
audit trails that mean something.

**Time travel is nearly free.** Retaining old versions costs only what they do
not share with newer ones; with content addressing at block granularity, shared
blocks are stored once. "Search the corpus as it stood on 12 March" becomes a
parameter rather than a feature.

### Document identifiers can carry time

If the corpus has a natural temporal order — and most do: messages, articles,
logs, commits, releases — then at build time documents can be **assigned
identifiers in timestamp order**.

This collapses the single most common filter in temporal search. A predicate
`created_at BETWEEN a AND b` stops being a postings-list intersection and
becomes **a contiguous interval of document IDs**, resolved by binary search
over a sorted boundary table in the footer. No bitmap is read. No postings are
fetched for the time filter at all. Every other predicate then intersects
against a dense range rather than a sparse set.

This optimisation requires knowing every document at build time. **It is
available at L0 and degrades — but does not disappear — at L1** (§7.4).

### Staleness becomes an explicit, chosen contract

Once the index is versioned, staleness is not a defect to be minimised but a
parameter the caller selects:

```
query(q, as_of = pinned_version)   → exact, reproducible, infinitely cacheable
query(q, as_of = latest_base)      → stale by up to one rebuild interval
query(q, as_of = latest_base+delta) → stale by up to one flush interval
```

The third costs more fetches than the second. A UI listing can take the cheap
path; a "did my upload arrive?" check takes the expensive one. Most systems make
this choice once, globally, at architecture time. Here it is per query.

### Monotonicity is the one real obligation

A reader that has observed version *V* must never subsequently observe a version
older than *V*, or results will appear to travel backwards — items vanishing and
reappearing between keystrokes. With monotonically numbered versions this is a
single comparison in the reader, but it must be deliberate, because the
underlying caches (CDN edges especially) offer no such guarantee on their own.

## 3. L0: assume no writes

### 3.1 What it means

The index is produced by a batch build and published as a complete, versioned
artifact. Nothing mutates it. There is no writer to coordinate with, no lock, no
manifest compare-and-swap, no tombstone, no compaction, no merge policy, no
deleted-document filtering, and no possibility of a torn read.

Updating the corpus means building a new version and switching a pointer.

### 3.2 What L0 buys that nothing else can

This is the part that makes L0 worth treating as a destination rather than a
stepping stone. Because the builder sees the entire corpus at once and the
result will never change:

**Sort-ordered document IDs** (§2) — temporal range filters become interval
slicing. Not available incrementally.

**One segment.** No segment count to bound, no cross-segment result merging, no
per-segment footer reads, no skew. Query cost stops depending on write history.

**Minimal perfect hashing** for term → postings offset. Possible only when no
future insertion can occur. Removes the FST traversal from the critical path and
shrinks the dictionary further.

**Globally optimal encoding.** Term statistics, gap distributions and
cardinalities are all known before any byte is written, so block sizes, bit
widths and codec choices can be fitted to the actual data rather than guessed
from a prefix of it.

**Asymmetric compression.** Build time is offline and unbounded; only decode
speed matters. A minute of extra build effort to shave bytes off every future
fetch is an unambiguously good trade — and in the browser host, bytes are
latency the user feels.

**Query-affinity layout.** This is the one I find most interesting and have seen
least often. Given a query log, terms that co-occur in conjunctions can be
placed *adjacently in the file*, so that an AND of several terms is satisfied by
one contiguous range read instead of several scattered ones. On a medium where a
round trip costs 20–50 ms and contiguity is free, this converts a latency
problem into a build-time layout problem. It is only possible because the layout
is fixed and the workload can be profiled against it.

Taken together these are not marginal gains. An L0 index should be *meaningfully
faster and smaller* than an incrementally-built one over the same corpus, which
inverts the usual assumption that immutability is a limitation to be worked
around.

### 3.3 The one bit of mutable state

Even at L0 something must say which version is current. This is the only mutable
state in the system and it deserves to be named as such.

Two dispositions:

- **Externalise it into the deployment.** The site build, or the Lambda's
  environment, embeds the version identifier. Deploying *is* the pointer flip.
  At runtime there is then literally no mutable state — every byte fetched is
  immutable and eternally cacheable. For a static site this is clean and exact.
- **A small pointer object with a short TTL.** `latest` is fetched with
  `max-age=60`; everything it references is immutable. Simpler to operate,
  introduces a bounded propagation delay, and needs the monotonicity check of §2.

The first is strictly better where it is available. The second is what L1 will
need anyway, which is a reason to build it early.

### 3.4 Is L0 actually solvable?

Yes, and this should be stated plainly because it determines whether the rest is
worth attempting. Immutable, range-addressable search indexes served from object
storage or a CDN are demonstrated technology — Pagefind does it for static sites,
searchable snapshots do it for Elasticsearch, Quickwit does it for logs (§10).
The open questions at L0 are quantitative, not existential: how few round trips,
how few bytes, how large a corpus before it stops being pleasant (§11).

What is less explored is treating L0 as the *design centre* and pursuing the
optimisations in §3.2 aggressively, rather than treating immutability as a
constraint inherited from the storage layer.

## 4. Substrate and latency budget

L0 makes the index a set of immutable byte ranges. Three substrates can serve
them, and the same reader can address all three behind a transport adapter:

| | Latency | Parallelism | Cache |
|---|---|---|---|
| S3 Standard | 20–50 ms first byte | effectively unlimited | Lambda `/tmp`, EFS |
| S3 Express One Zone | 5–10 ms | unlimited | as above |
| CDN edge (HTTP `Range`) | 10–30 ms | H2/H3 multiplexed | **browser HTTP cache** |
| EFS | 1–3 ms | shared across containers | page cache |

A naive query plan pays one round trip per dependency level:

```
footer → dictionary → postings → documents     ≈ 4 × 30 ms = 120 ms
```

That floor is the central engineering problem, and L0 attacks it from both ends:
the upper levels (footer, dictionary) are small, immutable and therefore
permanently cacheable, so a warm reader starts at *postings*; and query-affinity
layout (§3.2) collapses the postings level from several fetches to one.

A warm L0 reader should be able to answer in **one round trip plus decode**.
Whether that holds in practice is Q1–Q3.

## 5. Segment format

Footer-first, after Parquet — metadata last so a single-pass builder can stream,
and so one read of the tail reveals the location of everything else.

```
┌─────────────────────────────────────────────────────────┐
│ magic + format version                                  │
├─────────────────────────────────────────────────────────┤
│ postings          (query-affinity ordered, block-aligned)│
├─────────────────────────────────────────────────────────┤
│ column chunks     (doc values, per field)               │
├─────────────────────────────────────────────────────────┤
│ stored fields     (doc-id addressable, heavy compression)│
├─────────────────────────────────────────────────────────┤
│ term dictionary   (MPH at L0 / FST at L1)               │
├─────────────────────────────────────────────────────────┤
│ sort-key boundary table   (doc-id interval lookup, §2)  │
├─────────────────────────────────────────────────────────┤
│ FOOTER: section offsets+lengths, doc count,             │
│         sort-key min/max, schema hash, version id       │
├─────────────────────────────────────────────────────────┤
│ footer length (fixed 8 bytes, last)                     │
└─────────────────────────────────────────────────────────┘
```

**Logical vs physical.** The format defines a *logical* layout of sections
addressed by `(section, offset, length)`. Two physical packagings serve it:

- **one object + range requests** — atomic publication, natural for S3
- **a shard tree of small objects** — no `Range:` dependency, each shard
  independently CDN-cacheable, better suited to prefix-sharded dictionaries for
  as-you-type search

The reader is written against the logical view. Same segments, same tests,
different transport. This matters more than it looks: it is what lets one
implementation serve a Lambda and a browser (§9).

## 6. Query execution at L0

```
1. footer            cached after first query, else 1 fetch
2. sort-key filter   binary search in boundary table → doc-id interval
                     (no I/O beyond the footer)
3. term lookup       MPH → postings offsets      (dictionary cached)
4. postings          ONE batched range fetch if affinity layout holds
5. intersect         against the doc-id interval from step 2
6. documents         one batched fetch of the result page only
```

Steps 1–3 are free on a warm reader. Step 5 is an interval test rather than a
set intersection. The query costs **two fetches warm, four cold** — and the cold
case is paid once per cache lifetime, which for immutable data can be very long.

Note what is absent: no deleted-document bitmap, no per-segment loop, no merge
of partial results, no version reconciliation. That absence is the L0 dividend.

## 7. L1: writes, eventually available

### 7.1 An L1 index is a list of L0 artifacts

The recursion is the whole trick. A delta is not a different kind of thing — it
is a small L0 artifact. So:

```
L1 index  =  ordered list of L0 artifacts  +  tombstone overlay
             ─────────────────────────────
             base (large, old)  …  deltas (small, recent)
```

Every artifact in the list is immutable and individually cacheable exactly as in
§3. **The only mutable state in an L1 index is the list itself** — the manifest.
This is the same single mutable bit as §3.3, now carrying an ordered set instead
of one identifier.

Writes buffer, flush as a new small L0 artifact, and append to the manifest.
Periodically a rebuild folds deltas into a new base and the old artifacts are
dropped once nothing references them.

#### Obligation: declare which aggregates merge

An L1 reader fans a query across segments and merges the results. That is
exact for counts, `min`, `max` and `stats` (with `avg` derived last, never
per segment), and for histograms bucket by bucket. It is **not** exact for
top-*k* `terms`, which must over-fetch from each segment and should report an
error bound. Measured: at 4 segments and `size: 40`, 22 of 40 counts were
wrong without over-fetch; 10x made the worst error 0.13 % and 50x made it
exact, with no measurable change in bytes read (Appendix B.6).

### 7.2 Visibility lag

The temporal contract of L1 is a sum of clearly separable terms:

```
write → buffer → flush → artifact published → manifest updated → reader observes
        (batch)  (build)   (upload)            (CAS)              (poll / TTL)
```

The last term differs sharply by host, and this asymmetry is worth designing for
rather than averaging over:

- **Lambda reading a strongly-consistent manifest store** (DynamoDB conditional
  update): the poll term is ~0. Lag ≈ flush interval.
- **Browser polling a CDN-cached pointer**: lag ≈ flush interval + pointer TTL,
  so tens of seconds to minutes.

A browser can subscribe out-of-band (WebSocket, SSE) to shortcut the TTL if
freshness matters, but that reintroduces a server — which is precisely the thing
L0/L1 exist to avoid. Better to be honest about the lag and let the caller pick
a path (§2, staleness as a contract).

### 7.3 Tombstones and their bound

A delete or update of a document in the base cannot modify the base. It is
recorded as a tombstone in a later artifact, and the reader applies the union of
tombstones from all artifacts newer than the one it is reading.

Tombstones therefore accumulate monotonically between rebuilds, and rebuild
frequency bounds them. This gives a clean and testable relationship:

> update rate × rebuild interval = tombstone burden

For append-mostly corpora the burden is negligible. For update-heavy ones it
sets the rebuild cadence, and if the required cadence approaches continuous
rebuild, L1 is the wrong model — that is the honest signal to reconsider (§8).

### 7.4 What L1 costs, relative to L0

Each §3.2 optimisation degrades, and it is worth being precise about how,
because the degradation is gentler than one might expect:

| L0 property | At L1 |
|---|---|
| Sort-ordered doc IDs | **Preserved per artifact.** Each artifact keeps its own ordering, so the range filter becomes one interval slice *per artifact* rather than one globally. Cost grows with artifact count, not corpus size. |
| Single segment | Lost. Query fans out across the list; bounded by rebuild policy. |
| Minimal perfect hashing | Lost for the delta tier — deltas must tolerate incremental construction, so FST there. **The base keeps MPH.** |
| Globally optimal encoding | Preserved in the base, approximate in deltas. |
| Asymmetric compression | Preserved in the base; deltas must build fast, so light compression. |
| Query-affinity layout | Preserved in the base only. Deltas are small enough that layout barely matters. |

The pattern is consistent and is the reason the ladder works: **the base retains
essentially every L0 advantage, and the deltas are small enough that losing them
there costs little.** Rebuild frequency is the knob that trades freshness
against how much of the corpus enjoys L0 properties.

### 7.5 Manifest concurrency

Two mechanisms, both adequate:

- **Conditional writes on the pointer object** (`If-Match` on an ETag) — a
  compare-and-swap with no external dependency. Preferable for a format intended
  to be self-contained.
- **A conditional update in a key-value store** — strongly consistent reads and
  no retry ambiguity, at the cost of a dependency.

Under concurrent writers both need batching to avoid retry storms; the natural
batching unit is the flush interval, which is already a tunable of §7.2.

## 8. Why the ladder stops at L1

**L2, read-your-writes**, requires that a query issued by a writer consult that
writer's unflushed buffer. Either writer and reader are the same process — which
means a stateful, long-lived node — or they share mutable state, which means
coordination. Either way the "no running process" property is gone.

**L3, linearizable**, requires consensus across replicas. At that point one has
rebuilt a distributed search cluster, and should use one.

So the entire value of this design — no always-on node, immutable and therefore
freely cacheable bytes, a reader that is a pure function — exists strictly at L0
and L1. The ladder is not a roadmap toward L3; **L2 is where the approach ends**,
and recognising that early is what keeps the design honest.

## 9. Hosts

The format is host-agnostic; two hosts exercise it differently and between them
cover the interesting corners.

**Lambda over S3/EFS.** Compute is generous, parallelism effectively unlimited,
manifest reads can be strongly consistent. Caching is best-effort — a warm
container is not guaranteed — so the cold path must stay acceptable.

**JavaScript over a CDN.** `Range:` requests against a CDN are the same
primitive as range GETs against S3, so a single reader (Rust, compiled native
and to WASM) can serve both. The differences that actually drive design:

- **Bytes are latency the user feels**, not a cost line. "Bytes to first result"
  becomes the primary metric.
- **The HTTP cache is better than a warm container** — it persists across page
  loads and is exactly aligned with immutable artifacts.
- **The dominant query is a prefix that changes per keystroke**, not a range
  filter. That shifts the critical structure from the boundary table to
  dictionary sharding, and favours the shard-tree packaging of §5.
- **Idle time exists.** Footer and dictionary can be prefetched on page load or
  search-box focus, so the first keystroke already has a warm reader.
- **Queries never leave the client** — a real privacy property, not a claimed one.
- **The index is public.** No per-user filtering is possible; access control must
  happen before the bytes are served. A hard boundary on applicability.

## 10. Analysis of existing formats

Four formats are worth dissecting properly, because between them they have
already solved most of the sub-problems — just never in the same artifact.

### 10.1 The axes that matter

For an index served over high-latency storage, the conventional benchmarks
(bytes on disk, CPU per row) are secondary. What matters is:

- **Dependent round trips** — the depth of the pointer-chasing chain before the
  first useful byte. Two fetches that can be issued simultaneously cost one
  round trip; two where the second address comes from the first cost two.
- **Whether row order is value order** — decides if a range predicate is an
  interval slice or a set operation.
- **Index density** — dense (one entry per row) or sparse (one per block).
  Sparse indexes can live in memory permanently; dense ones cannot.
- **Objects per artifact** — one packed object, or a directory of files.
- **Substring capability** — the predicate all four handle worst.
- **Requests per query** — distinct from round trips, and billed separately.
  Parallel fetches cost one round trip but *n* requests; on S3 that is a real
  line item, and a high-cardinality `terms` aggregation can ask for six
  figures of them (Appendix B.4).

| | ClickHouse | Lucene | Parquet+DuckDB | SQLite |
|---|---|---|---|---|
| Immutable artifacts | yes (parts) | yes (segments) | yes | no (B-tree, mutable) |
| Row order = value order | **yes** (ORDER BY) | no (assignment order) | only if sorted at write | by rowid / index order |
| Primary index density | **sparse** (1/granule) | dense postings | sparse (row-group stats) | dense B-tree |
| Dependent round trips, point query | ~2 (marks → data) | 2–3 (tip → tim → doc) | 2 (footer → page) | **B-tree depth, 3–4** |
| Objects per artifact | many (per column) | many (or one, CFS) | **one** | **one** |
| Inverted index | no (bloom skip only) | **yes** | no | FTS5, in-file |
| Substring / infix | ngram bloom filters | poor (leading wildcard) | scan | prefix only |
| Proven over HTTP Range | partially (S3 disk) | via snapshot cache | **yes** (httpfs) | **yes** (sql.js-httpvfs) |
| Runs in browser | no | poorly (JVM) | yes (WASM) | **yes** (WASM) |

### 10.2 ClickHouse MergeTree — the sparse index over sorted data

The core idea, and the most valuable one here: rows within a part are physically
**sorted by the table's ORDER BY key**, and the primary index stores only one
entry per *granule* (8192 rows by default). For a billion rows that is ~122k
index entries — a few megabytes, permanently resident in memory.

Because the data is sorted, a sparse index is sufficient: binary search the
granule boundaries, then read only the granules that can contain matches. This
is the generalised, production-hardened form of the sort-ordered-doc-ID idea in
§2 — the boundary table *is* a sparse primary index, and ClickHouse has spent
years proving the shape works.

Secondary "skip indexes" extend it: `minmax`, `set`, `bloom_filter`, and
crucially **`ngrambf_v1` / `tokenbf_v1`** — n-gram bloom filters evaluated per
granule. Of the four formats this is the only one that takes substring matching
seriously at the index level.

Parts are immutable and merged in the background: the L0/L1 ladder, already
built. The part list is the manifest.

**Where it fails for this design.** Each part is a directory with at least one
file per column plus marks and index files, which on object storage means many
objects and an extra indirection (marks must be read to locate a granule inside
the compressed stream). ClickHouse's own S3 support runs into exactly this. It
is also fundamentally an *analytical scan* engine — there is no ranked retrieval,
and the inverted-index work remains peripheral. And the merge daemon assumes a
server.

**Steal:** sparse index over sorted data; granule as the I/O unit; n-gram
structures for substring predicates.

### 10.3 Lucene — the term dictionary

Lucene's `.tip`/`.tim` split is the best-engineered term dictionary in wide use:
a compact FST in `.tip` maps term prefixes to block offsets in `.tim`, and the
FST is small enough to stay resident. Postings (`.doc`/`.pos`) use delta+PFOR
encoding with **skip lists** so that `advance(docID)` during conjunctive
intersection does not decode everything in between. Numeric and range predicates
go through **BKD trees** (`.kdd`/`.kdi`) — a disk-friendly block KD-tree.

The **compound file** (`.cfs`) already demonstrates that a segment's many files
can be packed into one object, which is the §5 packaging argument with a
twenty-year head start.

**Where it fails for this design.** The whole format assumes `mmap` and a page
cache — many small random reads that are nearly free locally and ruinous at
30 ms each. Elasticsearch's searchable snapshots exist precisely to layer a
block cache underneath and survive this. But the shallow answer ("it assumes
mmap") understates it: the *execution model* is built to avoid materialisation,
which is exactly backwards when round trips rather than bytes are the scarce
resource. §11 treats this properly.

More fundamentally: **document IDs are assignment order, not value order.** A
temporal range predicate must therefore produce a *set* of doc IDs via BKD and
then intersect it, rather than slicing an interval. Index sorting exists but is
optional and not what the format is built around. This is the single clearest
divergence from ClickHouse, and for temporal corpora ClickHouse is right.

**Steal:** FST block-tree dictionary; skip lists for intersection; the compound
file precedent. **Replace:** BKD range handling with interval slicing over
sorted IDs, where the corpus is temporal.

### 10.4 Parquet + DuckDB — footer-first, and the HTTP proof

Parquet's structural contribution is the **footer**: a single trailing metadata
block describing schema, row-group offsets, and per-column-chunk statistics
(min/max/null counts), with optional `ColumnIndex`/`OffsetIndex` giving
page-level statistics and bloom filters. One read of the tail reveals the
location and content bounds of everything. Hierarchical pruning follows
naturally — row group, then page.

DuckDB's `httpfs` extension turns that into the thing that matters here: it
reads the footer by range request, then fetches only the column chunks and pages
the query needs. **DuckDB-WASM does this from a browser.** That is an existence
proof for §9, running today against ordinary static hosting.

**Where it fails for this design.** Parquet has no inverted index. A predicate
like `Subject LIKE '%foo%'` has nothing to prune with — bloom filters are
equality-only — so it decompresses and scans the column. For the wildcard-heavy
workload this format is a scan engine wearing an index's clothes. There is also
no ranked retrieval, no top-k, and deletes require rewriting files, which is why
Iceberg and Delta bolt a manifest-plus-delete-file layer on top — an L1 built
the hard way, above the format rather than within it.

**Steal:** footer-first layout; hierarchical statistics; the httpfs transport
model. **Recognise:** this is the "no custom format" baseline (§15), and for
projection-and-filter workloads it is already enough.

### 10.5 SQLite + `sql.js-httpvfs` — flat addressing and the VFS

SQLite's file format is a flat array of fixed-size **pages**; any page is at
`(pgno - 1) × page_size`. There are no marks files, no offset tables, no
indirection — the address of everything is computable. For a medium where you
must name a byte range before you can read it, that property is worth a great
deal.

`sql.js-httpvfs` exploits it directly: SQLite compiled to WASM, with a VFS whose
`xRead` issues HTTP `Range` requests. It runs a real relational database in a
browser against static hosting, with no server. The practical lessons from that
project transfer wholesale — raise the page size well above the 4 KiB default to
cut request count, `VACUUM` before publishing so pages are contiguous, and cache
the upper B-tree levels aggressively.

The **VFS abstraction itself is the lesson**: SQLite separated *format* from
*transport* decades ago, and that separation is exactly what §5 proposes when it
distinguishes the logical layout from its physical packaging. It is worth
copying as a design discipline, not just as an implementation detail.

**Where it fails for this design.** B-trees are pointer-chasing structures: a
four-level tree is four *dependent* round trips before data. Caching the upper
levels helps enormously — they are few pages and always hot — but the shape is
wrong for high-latency media, and it is inherent rather than incidental. SQLite
also carries the machinery of mutability (freelist, WAL/journal) even when the
database will never be written, and it is row-oriented, so compression is far
behind columnar formats. FTS5's inverted index lives in B-trees too, inheriting
the same traversal cost.

**Steal:** flat computable page addressing; the VFS/transport separation; the
published operational lessons about page size and contiguity. **Avoid:**
pointer-chasing depth on the critical path.

### 10.6 What none of them do

Setting the four side by side, the gaps are specific rather than vague.

**Nobody combines sorted-order interval pruning with a real inverted index in an
immutable, single-object, range-addressable artifact.** ClickHouse has the
sorting and the sparse index but no retrieval index and many files. Lucene has
the retrieval index but assignment-order IDs and an mmap-shaped access pattern.
Parquet has the packaging and the footer but no index at all. SQLite has flat
addressing and one file but pays B-tree depth and is row-oriented. Each holds
roughly one quarter of the answer.

**Dependent round trips are nobody's declared budget.** All four optimise bytes
and CPU; none states a round-trip bound as a property of the format. On a medium
where one round trip costs more than decoding a megabyte, that is the wrong
objective function. A format designed for this would publish a contract —
*any single-term query is one dependent fetch warm, two cold* — and structure
itself to hold it: everything needed to compute the *address* of the data must
come from metadata small enough to be permanently resident.

**Nobody lays out data according to the query log.** All four choose layout from
data statistics — cardinality, distribution, sort key. None uses *access*
statistics. The closest analogue is not in databases at all but in
profile-guided binary layout (PGO, BOLT), where hot code is packed together to
reduce cache misses. Query-affinity layout (§3.2) is the same idea one level
out, and the economics are stronger: the penalty being avoided is 30 ms, not
30 ns. ClickHouse's `ORDER BY` is a manual, single-dimensional approximation.

**Deletion is bolted on in all four.** Lucene's `.liv` bitmap, Iceberg and
Delta's delete files, ClickHouse mutations, SQLite's freelist. Because none of
them declares a consistency model, deletion arrives as a retrofit. A format that
states L0/L1 up front (§1) can make the tombstone overlay a first-class, bounded
element of the manifest, with the explicit bound of §7.3.

**Aggregate mergeability is nobody's declared property.** Counts, `min`/`max`
and `stats` merge across segments by construction. Top-*k* `terms` does not:
a term below the cut in one segment loses that segment's contribution
entirely, so the merged count is a silent undercount. None of the four
declares which aggregates survive segmentation; Elasticsearch reports
`doc_count_error_upper_bound` and is the exception that proves the gap is
real. A format that declares L1 up front (§7) should state the obligation
with it. Measured error and the over-fetch fix are in Appendix B.6.

**Version identity is always a layer above.** A Parquet file does not know which
version of a table it belongs to; Iceberg adds that. A Lucene segment does not
carry a corpus version. Putting a content hash and a monotonic version **into
the footer** makes immutable caching and the monotonic-read obligation of §2
native properties rather than the responsibility of whatever sits on top.

**Substring matching is weak everywhere.** ClickHouse's n-gram bloom filters are
the best of the four and are still only a probabilistic skip. Lucene rewrites
wildcards into term enumeration, which collapses on a leading wildcard. Parquet
scans. SQLite FTS5 does prefixes but not infixes. **N-gram postings as a
first-class section** — not merely a bloom filter, but an actual trigram
inverted index sharing the segment's layout and compression — looks like an
underexplored point in the design space, and it happens to be exactly what a
`wildcard`-heavy workload needs.

### 10.7 What to take without reinventing

Equally important, because the temptation runs the other way:

- **FST / block-tree dictionary** — Lucene's design, Tantivy's implementation.
- **Roaring bitmaps** — for predicates that do not reduce to intervals.
- **ZSTD**, with a trained dictionary per column — no codec research needed.
- **Footer layout and statistics hierarchy** — Parquet's, essentially verbatim.
- **Sparse index over sorted data** — ClickHouse's, generalised.
- **VFS-style transport separation** — SQLite's, as a discipline.

The contribution, if there is one, is not in any of these pieces. It is in
assembling them under a declared consistency model (§1) and a declared
round-trip budget (§10.6), and then exploiting the freedoms that L0 grants
(§3.2) — which none of the four can use, because none of them is willing to give
up writes.

## 11. Lucene's contract, and the cost model that inverts

Lucene is extremely fast, and it is worth being precise about *why*, because the
reasons are specific and most of them stop applying — or reverse — on
high-latency storage. §10.3 said "it assumes mmap", which is true and too
shallow.

### 11.1 The codec contract

The architectural core is that **the engine is written against interfaces and
the file formats are plugins**. A `Codec` is a bundle of independently
swappable format implementations:

```
PostingsFormat       FieldsProducer / FieldsConsumer
DocValuesFormat      DocValuesProducer / DocValuesConsumer
StoredFieldsFormat   StoredFieldsReader / StoredFieldsWriter
PointsFormat         PointsReader / PointsWriter          (BKD)
KnnVectorsFormat     vector indexes
NormsFormat, TermVectorsFormat, LiveDocsFormat,
SegmentInfoFormat, FieldInfosFormat, CompoundFormat
```

Query execution never touches bytes. It talks to producers, and a producer may
store its data however it likes as long as it honours the interface. This is
precisely the separation §12.6 argues for — *general envelope, specialised
structures* — and Lucene has had it for two decades.

The postings read path is a three-level descent:

```
Fields → Terms (per field) → TermsEnum (seek/iterate terms) → PostingsEnum
```

`TermsEnum` offers `seekExact(BytesRef)`, `seekCeil`, `next()`, and the
statistics `docFreq()` and `totalTermFreq()`. `PostingsEnum` then yields
documents.

Two details of the contract matter more than they look:

**Demand-driven decoding.** `TermsEnum.postings(reuse, flags)` takes flags —
`NONE`, `FREQS`, `POSITIONS`, `OFFSETS`, `PAYLOADS`. The consumer declares what
it needs and the codec skips decoding the rest. A pure filter asks for `NONE`
and never pays for frequencies.

**Reuse.** Nearly every iterator accepts a `reuse` argument so buffers are
recycled rather than reallocated. Lucene's hot path allocates almost nothing.

### 11.2 The query pipeline

Three levels, and the split is exactly the right one:

| Stage | Lifetime | Holds |
|---|---|---|
| `Query` | immutable, shared | the *description* — with `equals`/`hashCode` |
| `Weight` | per search | index-wide statistics (IDF, collection stats) |
| `Scorer` | per segment | the actual iteration state |

`Query.equals`/`hashCode` is not incidental — **it is what makes the query cache
possible** (§11.5). A query is a value, so it can be a cache key.

The planner's hooks live here too:

- **`ScorerSupplier`** — `Weight.scorerSupplier(ctx)` returns an object exposing
  `cost()` *before* committing to build the scorer, so the planner can order
  clauses by cost without paying to construct them.
- **`ScoreMode`** — `COMPLETE`, `COMPLETE_NO_SCORES`, `TOP_SCORES`, … The caller
  declares whether it needs every match or only the top *k*. Structures are
  *permitted to skip* accordingly; this is what enables block-max WAND. The
  contract carries an optimisation licence, not just data.
- **`Collector` / `LeafCollector`** — `collect(int doc)` per segment, with
  `CollectionTerminatedException` for per-segment early exit, and
  `CollectorManager.reduce()` for concurrent search.

### 11.3 The universal currency: DocIdSetIterator

Everything — postings, filters, cached bitsets, deleted-document masks, and
since Lucene 7 even doc values — presents itself as:

```java
abstract class DocIdSetIterator {
  int docID();
  int nextDoc();                  // strictly increasing
  int advance(int target);        // first doc >= target
  long cost();                    // estimated cardinality
}
```

Two invariants carry the whole design. **Ascending order** makes intersection a
merge rather than a hash join. **`cost()`** gives the planner cheap approximate
cardinality, which is how `ConjunctionDISI` chooses its lead iterator.

`TwoPhaseIterator` extends the contract where confirmation is expensive:

```java
DocIdSetIterator approximation();
boolean matches();
float matchCost();              // estimated ops, so confirmations
                                // can be ordered cheapest-first
```

Note that `cost()` and `matchCost()` are **a cost model exposed through the
interface**. Each structure declares its own expense and the planner composes
them. That is the mechanism §12.4 needs when it tabulates probe costs per
predicate — Lucene's version is estimated operations; ours would be estimated
probes and bytes.

### 11.4 How intermediate results are actually made

Four distinct mechanisms, chosen by circumstance.

**(a) Lazy composition — the default.** `ConjunctionDISI` leapfrogs: sort
iterators by `cost()`, let the cheapest lead, `advance()` the others to its
document, re-lead on mismatch. Disjunctions use a priority queue of iterators.
Nothing is stored; doc IDs are produced on demand. Combined with multi-level
**skip data** inside the postings, `advance()` jumps forward without decoding
what it passes over.

**(b) Adaptive materialisation.** `DocIdSetBuilder` accumulates doc IDs into a
sparse buffer and **upgrades to a `FixedBitSet` once density crosses a
threshold** relative to `maxDoc`. The representation is chosen from observed
density at runtime, not declared in advance. The family is
`IntArrayDocIdSet` → `SparseFixedBitSet` / `RoaringDocIdSet` → `FixedBitSet`.

Some producers have no choice: **BKD point queries emit documents out of
order**, so they must materialise, sort and deduplicate. `DocIdSetBuilder` is
where that happens.

**(c) Windowed bulk scoring.** `BulkScorer.score(collector, acceptDocs, min,
max)` inverts control — push rather than pull. For wide disjunctions
`BooleanScorer` processes a fixed window (2048 documents), accumulating scores
and frequencies into a small bucket array indexed by `doc & MASK`, then flushes
the window to the collector.

This matters for §11.7: **Lucene already does bulk, windowed, array-oriented
processing** when density makes it worthwhile. The claim is therefore not that
Lucene never materialises — it is that its *thresholds are calibrated for local
memory*, where the crossover sits at high density. Move the cost of a miss from
100 ns to 30 ms and the crossover moves with it.

**(d) The query cache.** `LRUQueryCache` stores a `DocIdSet` keyed by
`(Query, segment core key)`. `UsageTrackingQueryCachingPolicy` decides what earns
a slot — filter-shaped clauses, seen often enough, not so cheap that caching is
pointless. On a hit the result is a `ConstantScoreScorer` over the stored set.

### 11.5 Why that cache needs no invalidation

The cache key is the segment's **core** cache key, and a segment's postings
never change. So a cached bitset cannot go stale — there is no invalidation
logic anywhere in it. Entries are dropped wholesale when the segment is merged
away.

Deletions are deliberately kept *outside* the cached set: they live in a separate
live-docs mask with its own cache key, applied after the cached set, precisely so
that deleting a document does not invalidate every cached filter that matched it.

So Lucene already exploits immutability for **intermediate-result caching**, not
merely byte caching — a stronger use of the property than anything in §2, and it
was sitting in the most mature of the four systems all along.

### 11.6 Impacts: the format already ships precomputed summaries

This is the detail that generalises furthest, and it is easy to miss because it
is framed as a scoring feature.

Postings carry **impacts** — per-block upper bounds on the score contribution
achievable within that block, written at index time. `ImpactsEnum` exposes
`advanceShallow(target)`, which positions *without decoding*, and `getImpacts()`,
which returns the bounds. Block-max WAND uses them to prove that an entire block
cannot enter the current top-*k* heap and skips it unread.

Stated structurally: **the format stores precomputed per-block summaries that
let a reader skip blocks it has not read.** That is exactly ClickHouse's skip
index (§10.2) — minmax, set, bloom — applied to a different predicate. Lucene
summarises *score bounds* for ranking; ClickHouse summarises *value bounds* for
filtering. Neither generalises the mechanism to the other's use.

The generalisation is obvious once the two are set side by side, and it is free
real estate for a new format: **per-block summaries for every predicate type in
the algebra of §12.4** — value ranges for the sort key, presence bitmaps for
keywords, trigram bloom filters for infix. Each turns a would-be fetch into a
skip, and each is computed at build time where computation is free (§3.2).

### 11.7 On object storage the cost model inverts

Every technique in §11.3 and §11.4(a) is optimal under one assumption:
**reading is cheap and computation is expensive.** A skipped block saves
decoding; an `advance()` landing in the page cache costs nanoseconds.

On object storage that ratio reverses. An `advance()` crossing a block boundary
is not a page fault but a **probe** — 20–50 ms. Leapfrog intersection issues
many small jumps whose targets depend on previous results: the worst possible
pattern where round trips dominate and bandwidth is nearly free (§13.2 puts the
free-over-fetch budget at ~3 MB on S3).

The conclusion is sharper than "it assumes mmap":

> Lucene's *default* strategy avoids materialisation and its adaptive
> mechanisms (§11.4b, §11.4c) switch to bulk processing only at high density.
> An object-storage format should sit at the other end of that dial by default —
> fetch whole postings slices in one range GET and intersect them in memory —
> because the scarce resource is round trips, not bytes or cycles.

Bulk-fetch-then-intersect is *wasteful* by Lucene's metric and *optimal* by this
one. That is why porting the engine cannot work, and why the answer is not a
better block cache underneath it but a different execution model above a
different format.

It also retires machinery: skip lists exist to make `advance()` cheap, but if
slices are fetched whole, they are dead weight — and Elias-Fano (§15.3) already
gives random access into the compressed slice without them.

### 11.8 Precomputing intermediate results

Here §11.4(d) meets L0, and it is the most promising idea in this comparison.

Lucene's query cache discovers **at runtime** which filter bitsets are worth
materialising. An immutable artifact built with knowledge of the query
distribution can decide that **at build time** — and ship the bitsets inside the
file.

Common filters (`SendingStatus = 'FAILED'`, a month bucket, a sender) become
precomputed sets stored as ordinary sections, retrievable in one range GET, with
no term lookup and no postings decoding. A query that is entirely a conjunction
of precomputed filters degenerates to: fetch *k* bitsets in one parallel wave,
intersect in memory, fetch the result page. **One dependent probe.**

This generalises §3.2 from *layout* to *content*: the artifact holds not only
data arranged well, but **precomputed answers to anticipated sub-queries**. Of
the four formats in §10, Lucene comes closest and does it reactively, in memory,
discarded on restart. Impacts (§11.6) show the format is already willing to
carry build-time summaries; this is the same move applied to doc sets.

And it sits exactly on the theoretical curve of §15.8: Pătrașcu–Thorup says
probes can be bought with space. Precomputed bitsets are that purchase, made
explicit and shipped.

### 11.9 Which results to precompute is a known problem

The obvious objection is combinatorial explosion — you cannot materialise every
conjunction. So it becomes selection: *given a query distribution and a space
budget, which sub-query results should be materialised?*

That is **materialised view selection**, studied in data warehousing since the
1990s, NP-hard, with well-developed greedy approximations exploiting
submodularity. The candidate lattice, the cost model, the benefit-per-byte
heuristic all transfer, reading "view" as "bitset" and "workload" as query log.

With §13.6 and §15.6 this makes three build-time optimisations that are all the
same problem — *spend space and build time to remove probes, under a budget,
given a query distribution* — and one framework should serve all three.

### 11.10 On OpenSearch Serverless next generation

Since it prompted this enquiry: the next-generation offering is a *provisioning*
advance, not a format one, and the disappointment is well-founded.

AWS describes stateless OCUs reading from and writing to a shared distributed
storage layer, with capacity released after ten idle minutes. The published
material does not describe index format, segment structure or caching tiers at
all. OpenSearch is Lucene-based and nothing published suggests that changed, so
the reasonable reading is that the index is still Lucene segments, with object
storage beneath a compute tier that caches locally — not a format queried
directly from object storage.

That is precisely the distinction this document turns on. Storage/compute
separation with scale-to-zero solves *who pays while idle*. It does not change
*what shape the index has*, so a stateful tier must still warm before it can
answer — hence queued requests during spin-up, and hence an OCU rather than a
function invocation.

An index whose format is designed for range access needs no warm tier: the
artifact is the database, and any stateless reader can query it. Next generation
moved the boundary of what must be running. It did not remove it.

## 12. The query algebra, and the limits of generality

### 12.1 The rbush observation

`rbush` is an in-memory R-tree in JavaScript, and it is very fast. It is fast
because it makes two assumptions this design cannot make:

1. **Everything is in memory.** No probe cost exists at all.
2. **There is one query type.** Bounding-box intersection, nothing else.

Both are load-bearing. A single-algorithm, memory-resident index is a far easier
artifact to build well than a format that must serve a *toolbox* of query types
over data that does not fit in memory. The comparison is not really fair to
either, and the temptation it creates — "make it general, like Lucene" — is the
main way this project could fail by scope rather than by physics.

Worth noting in passing that even `rbush` demonstrates the L0 pattern of §12.3
below: its bulk `load()` builds a markedly better-balanced tree than repeated
insertion, because bulk loading sees the whole set at once. The same principle,
at the smallest possible scale.

### 12.2 Generality is cheap if the interface is narrow

Lucene's answer to this tension is instructive, and it is not "be general". It
is: **one universal intermediate representation, many producers.**

Every query type — term, range, phrase, geo, script — is obliged to present
itself as a `DocIdSetIterator`. The *interface* is narrow even though the query
types are many. Composition (AND, OR, NOT) is then defined once, over that one
interface, and adding a query type means adding a producer rather than touching
the engine.

So the cost of generality is not paid per query type. It is paid once, in
choosing a representation that every operator can produce and consume. Get that
right and the toolbox extends cheaply; get it wrong and every addition is
surgery.

For this format the representation is already implied by §11.7: since the
execution model materialises rather than iterates, the universal currency is a
**document-ID set** — as an interval when the predicate is temporal (§2), as a
bitset when dense, as a compressed list when sparse. Three physical forms, one
logical type, closed under intersection, union and difference.

**Closure is the property to protect.** Every operator takes doc-ID sets and
returns a doc-ID set. Nothing in the toolbox may require a different shape.

### 12.3 The design rule this implies

`rbush` keeps the whole structure in memory. This format cannot — but it does
not have to, and the resolution turns out to be a rule that every format in §10
already follows without naming it:

> **Split every structure into a resident navigator and a fetched payload, and
> size the split so the navigator always fits in memory.**

- ClickHouse: sparse primary index (resident) → granules (fetched)
- Lucene: `.tip` FST (resident) → `.tim` blocks, postings (fetched)
- Parquet: footer and statistics (resident) → column chunk pages (fetched)
- SQLite: upper B-tree levels (hot in cache) → leaf pages (fetched)
- §12.5: a learned model (resident, kilobytes) → data (fetched)

This is the same rule as §11.4's residency requirement, now generalised from
metadata to *every* structure. It is also what makes the round-trip contract of
§10.6 statable: if navigation is always resident, then navigation is free, and
the only probes left are payload fetches — which are independent, hence one
round trip.

An R-tree fits this rule perfectly well, incidentally. Internal nodes are tiny
relative to leaves; a bulk-loaded, STR-packed R-tree over an immutable set would
have a resident node layer and fetched leaves. `rbush` does not do this only
because it has never needed to.

### 12.4 The toolbox, stated explicitly

Scope discipline requires naming the algebra rather than letting it accrete.
Proposed, and deliberately small:

**Producers** — predicates that yield a doc-ID set:

| Predicate | Structure | Probes |
|---|---|---|
| Sort-key range | interval from boundary table or learned model (§2, §15.5) | **0** |
| Term equality | dictionary → postings slice | 1 |
| Keyword / low-cardinality equality | precomputed bitset (§11.8) | **1, or 0 if batched** |
| Prefix | dictionary range → postings union | 1 |
| Infix / wildcard | trigram postings, or FM-index (§15.4) | 1–2 |
| Existence / null | column presence bitmap | 1 |

**Combinators** — closed over doc-ID sets: intersection, union, difference.

**Terminals** — what a query may finally ask for: count; the first *n* in
sort-key order; the stored fields of a given doc-ID set.

That is the whole algebra. Everything in it produces or consumes one type, and
every producer's probe cost is bounded and known — which is what allows the
format to publish a round-trip contract at all.

### 12.5 What is deliberately excluded

Equally important, and the discipline that keeps §12.1's failure mode away:

- **Relevance ranking and top-k by score.** No BM25, no impacts, no WAND. Results
  are ordered by the sort key. This removes a large fraction of Lucene's
  machinery (§11.3) and is acceptable for the target workloads, where "most
  recent matching" is the natural order.
- **Joins and aggregations** beyond counting. One artifact, one document set.
- **Geo and vector search.** Both are genuine query types with good specialised
  structures; both would be *additional producers* under §12.2 rather than
  changes to the algebra, and neither belongs in a first version.
- **Phrase and positional queries.** Positional postings roughly double index
  size and serve a predicate the target workloads do not use.
- **Anything requiring a second round of address discovery** after the payload
  fetch — that is the one exclusion that is structural rather than a matter of
  taste, because it breaks the probe-depth contract.

If a workload needs ranked full-text retrieval, it should use Lucene. That is
not a concession; it is the boundary that makes the rest tractable.

### 12.6 Generality in the envelope, specialisation in the sections

The synthesis of the rbush observation: do not build one general structure. Build
a **general envelope** — segment layout, footer, addressing, transport
adapter, manifest, versioning — and populate it with **single-purpose
structures**, each as specialised as `rbush` is for bounding boxes.

An interval table for the sort key. A trigram index for infix. Precomputed
bitmaps for low-cardinality keywords. An FST or MPH for the dictionary. Later,
perhaps, a packed R-tree for geo. Each is the best-known structure for exactly
one predicate; none of them has to be general, because generality lives in the
container and in the doc-ID-set algebra that joins their outputs.

Parquet does this with column encodings; Lucene does it with per-field-type
structures inside a shared segment. It is the established answer, and it is the
one that reconciles the user's observation with the ambition: **single-algorithm
indexes, composed — not a general index.**

### 12.7 Implementation order, and why it is shorter than it looks

A natural build order runs from the simplest domain to the hardest: boolean,
integer, time, float, then strings. That ordering is right, but working through
it reveals that **three of the five are the same structure under a transform**,
so the real plan has three stages rather than five.

#### Stage A — the boolean bitmap

One bit per document per value; intersection is `AND` over machine words. No
encoding decisions, no ordering questions, no dictionary.

But it is not merely the easiest case. The bitmap **is the universal
intermediate representation** of §12.2 — the currency every other producer must
eventually mint. Building it first means building the algebra's type before
anything that produces it, which is the right dependency order rather than
merely the easy one.

What Stage A alone makes testable is surprising:

- precomputed filter bitsets (§11.8) and their selection (§11.9)
- in-memory intersection versus leapfrog (Q19)
- the whole three-phase protocol (§14), including catalog design
- **pagination as sort-key continuation** (§14.4)
- coalescing thresholds (§13.4)

That is a large fraction of the thesis, falsifiable with the simplest structure
in the document.

#### Stage A′ — the sort-key interval

Worth splitting out because it is nearly free and unlocks disproportionate
value: a boundary table plus binary search, no encoding at all (§2). It is what
makes the temporal range predicate cost **zero probes**, and together with
Stage A it is enough to run §14.7's worked query end to end.

#### Stage B — the ordered integer column

Here the real work is, and here the consolidation happens. Integers introduce
the distinction that booleans avoid: **sorted or not**.

- Sorted by this column → interval, as Stage A′.
- Not sorted → per-block summaries (min/max zone maps), scan candidate blocks.
  This is the generalisation of Lucene's impacts and ClickHouse's skip indexes
  proposed in §11.6, and Stage B is where it gets built.

Encoding is frame-of-reference plus bitpacking with the width chosen per block —
one of the L0 freedoms of §3.2, since the builder sees every value.

Now the three collapses:

**Time is an integer.** Once normalised at build time to a declared epoch and
unit, a timestamp is an ordinary integer column. It deserves no separate
structure — only a declared contract in the catalog. Calendar, timezone and
precision questions are *parsing* concerns resolved by the builder, never by the
reader. Its privileges — being the sort key, and having a near-monotone
distribution that makes the learned model of §15.5 unusually effective — are
properties of *this* column, not of a new type.

**Float is an integer under a monotone bijection.** IEEE-754 values map to
order-preserving unsigned integers by flipping the sign bit for positives and
all bits for negatives — the transform Lucene uses for numeric points. After it,
every integer mechanism applies unchanged: intervals, zone maps, bitpacking.
What remains is semantics, not structure: NaN (exclude, or order last), ±0.0
(normalise to one), and the observation that float *equality* is usually a
modelling error while float *range* is the meaningful predicate.

**Exact string equality is integer equality.** Dictionary-encode the column to
ordinals at build time; equality becomes an ordinal comparison, and low
cardinality collapses to Stage A bitmaps. If the dictionary is stored in sorted
order, **prefix predicates become ordinal ranges** — Stage B machinery again.

So Stage B, plus a dictionary, covers integers, timestamps, floats, string
equality and string prefixes. Five of the six producers in §12.4's table.

#### Stage C — infix search over strings

The only genuinely new structure, and correspondingly the only stage with real
risk. It needs trigram postings or an FM-index (§15.4), and it is where Q3
(dictionary residency), Q14 (trigrams versus FM-index) and Q10 (prefix shard
granularity) get answered.

One simplification carries over from the target workload (§5): the string fields
are `wildcard`-typed, so there is **no analysis chain** — no tokenisation,
stemming, stop words or language handling. Terms are whole field values or their
n-grams. That removes an entire subsystem that a general search engine cannot
avoid, and it is a direct consequence of the scope discipline of §12.5.

#### What the order buys

| Stage | New machinery | Predicates unlocked | Thesis claims testable |
|---|---|---|---|
| A | bitmap | boolean, low-cardinality equality | protocol, precomputation, intersection |
| A′ | boundary table | sort-key range | zero-probe interval, pagination |
| B | ordered column + zone maps + dictionary | integer, time, float, string equality, prefix | block summaries, learned model, coalescing |
| C | trigram / FM-index | infix, wildcard | dictionary residency, substring cost |

Each stage is independently useful and independently falsifying, and the
sequence is a dependency order rather than a difficulty order — which is why it
also works as the experimental plan (§18).


### 12.8 The ordered-column index in detail

Stage B's structure, worked through, because it is the one that carries most of
the algebra.

#### The mechanism

For a column *x*, store the documents **ordered by x** — a permutation, as
parallel arrays of values and document IDs — and put a **sparse index** of
`(value → position)` in the catalog. To answer `6 < x <= 11`:

```
catalog (resident)          -100 → 0
                              -2 → 3 400
                               3 → 56 900     ← last entry with value ≤ 6
                              10 → 78 000
                              18 → 141 000    ← first entry with value ≥ 11
                              40 → 210 000

fetch   positions [56 900, 141 000)   values slice ∥ docID slice, one wave
binary search within                  exact bounds for (6, 11]
emit                                  doc IDs → set bits in the result map
```

Two refinements on the sketch. First, the fetched values are **sorted**, so no
per-entry test is needed — binary search the slice for the exact boundaries and
take the doc IDs between them. Second, fetch the values slice and the doc-ID
slice as **two independent range GETs in one wave**: both addresses come from
resident metadata, so they cost one round trip, not two. Fetching values first
and doc IDs after would be a dependent probe, which §11.7 forbids.

The output is a bitmap, as §12.2 requires — though when the match is sparse a
sorted doc-ID list is cheaper, and the combinator should accept either. This is
Lucene's adaptive representation choice (§11.4b) applied at the producer.

#### Index by position, not by value

The one correction worth making to the sketch. Indexing at *value* boundaries —
recording a position whenever the value changes, or at chosen values — leaves
the **fetch size unbounded**: a single very common value can span millions of
positions between two index entries, and the reader has no way to know before
fetching.

Indexing every *G*-th **position** inverts this: index entries are evenly spaced
by construction, so the fetched span is at most `2G` entries regardless of
distribution. Values between entries are then uneven, which is harmless — the
binary search inside the fetched slice handles it.

The rule generalises: **make the granularity of a resident navigator uniform in
the dimension you must bound**, which is bytes fetched, never values covered.

#### Choosing G, and an independent confirmation

Two budgets bracket the granularity. With *N* rows, ~12 bytes per index entry,
and *w* bytes per payload entry:

```
resident:    (N / G) × 12  ≤  R
over-fetch:   2G × w       ≤  F
```

For N = 10 M, a resident budget R = 1 MB and the S3 over-fetch budget F = 3 MB
at w = 6 bytes, that gives **120 ≤ G ≤ 250 000** — an enormous latitude, which
is itself reassuring. Taking G = 8192:

- resident index: 1 220 entries × 12 B ≈ **15 KB**
- worst-case over-fetch: 2 × 8192 × 6 B ≈ **98 KB**

Both comfortable, on every host including mobile. And 8192 is exactly
ClickHouse's granule size (§10.2) — arrived at here from latency budgets rather
than from cache-line arithmetic, which is a pleasant independent confirmation
that the constant is not arbitrary.

#### The dividend: one structure, two jobs

A sorted-by-*x* index **is** the permutation needed to sort results by *x*. The
same bytes that accelerate a range predicate on `x` also serve §14.9's secondary
ordering for `x`, so the permutation tables that section called prohibitive for
browsers are not an additional cost — they are the index, already built.

Build once, use for filtering and for ordering. That materially improves the
economics of secondary sort orders, and it means the decision "should this
column have a sorted index?" is answered by the *union* of its range-predicate
and sort-order usage, not either alone.

#### When not to build one

The alternative for a range predicate is zone maps over the clustering order —
min/max per block, scan the candidates — which costs almost nothing
(`N/blocksize` pairs) against a sorted index's `N × (value + docID)` bytes.

The two differ in exactly one respect:

- **Zone maps work only when the column correlates with the clustering order.**
  If `x` is uncorrelated with time, every block's min/max spans nearly the full
  range and nothing is pruned.
- **A sorted index works regardless of correlation**, at the cost of space.

So the decision rule is measurable rather than a matter of judgement: compute
each column's correlation with the clustering key at build time, use zone maps
where it is high, and spend a sorted index where it is low *and* the column is
queried or sorted often enough to earn the bytes. That is another parameter for
§13.7's build-time search, and another instance of the single framework of
§11.9 — space and build time traded for probes, under a budget, given a query
distribution.


## 13. Granularity and structure selection: the configuration problem

### 13.1 Scatter versus bulk copy, at three scales

ClickHouse's speed has a second source beyond the sparse index of §10.2, and it
is worth naming separately: **contiguity**. A granule of 8192 values in one
column decompresses into a flat array. Predicates then run as tight, branch-free,
SIMD-friendly loops over adjacent memory — no pointer chasing, no per-row
dispatch, no scattered cache lines. The work is bulk copy and bulk arithmetic
rather than navigation.

That is the same observation as §11.7, one level down. And it recurs at a third:

| Scale | Scattered | Bulk | Ratio |
|---|---|---|---|
| CPU cache | pointer-chasing a tree | vectorised scan of a flat array | ~100× |
| Disk page | random small reads | sequential large reads | ~100× |
| Object storage | many dependent probes | few large parallel range GETs | ~1000× |

At every scale the same answer has been winning for thirty years, and for the
same reason: **bandwidth and compute improve far faster than latency does**
(Patterson's "latency lags bandwidth"). Each generation of hardware makes
brute-force bulk transfer look better relative to clever navigation, and the
effect is strongest at the outermost scale — which is the one this format
operates at.

So §11.7's conclusion is not a quirk of object storage. It is the general trend,
observed at its extreme.

### 13.2 How much over-fetch is free

This can be made quantitative, and the number is surprising.

Fetching *X* extra bytes costs `X / bandwidth`. Avoiding one dependent probe
saves `L`. So over-fetching pays whenever

> **X < L × bandwidth**

Call that product the **latency-equivalent bytes** — the budget for free waste.
Rough values:

| Host | L | Bandwidth | Free over-fetch |
|---|---|---|---|
| Lambda + S3 Standard | ~30 ms | ~100 MB/s | **~3 MB** |
| Lambda + S3 Express One Zone | ~7 ms | ~100 MB/s | ~700 KB |
| Lambda + EFS | ~2 ms | ~100 MB/s | ~200 KB |
| Browser + CDN, desktop | ~20 ms | ~50 MB/s | ~1 MB |
| Browser + CDN, mobile | ~40 ms | ~3 MB/s | **~120 KB** |

Reading three megabytes to avoid one round trip is *free* on Lambda over S3.
That is a licence to over-fetch far more aggressively than instinct allows, and
it is the quantitative form of §11.7.

It also shows a **25× spread across hosts**, which means no single block size is
right for both. That is the configuration problem in its sharpest form.

### 13.3 Two regimes, and which one you are in

The rule above assumes probes are *serial*. When they can be issued in parallel
the economics invert, and this is the subtlety that makes the configuration
question genuinely hard rather than a lookup.

For **k scattered items** of useful size *s*, with block size *B*:

- read amplification = *B / s*
- probe count = *k*, but if all *k* are independent they cost **one round trip**

So:

- **Latency-bound regime** — few accesses, or accesses whose addresses depend on
  earlier results. Minimise probe *depth*; over-fetch freely up to §13.2's
  budget; prefer large blocks and coalescing.
- **Amplification-bound regime** — many accesses, all independent, issued
  together. One round trip regardless of count, so minimise *bytes*: prefer
  **small** blocks and high parallelism.

Counter-intuitively, on S3 with generous concurrency, **many small range GETs
can beat a few large ones** — you pay one round trip either way and transfer far
less. Request charges are negligible at $0.0004/1000. The constraint is
concurrency, not cost.

In the browser the balance shifts: HTTP/2 multiplexing gives concurrency, but
per-request overhead is higher and mobile bandwidth is thin, so the
amplification-bound regime arrives much sooner.

The design implication is that **the reader must know which regime it is in**,
and the answer is a property of the host, not of the format.

### 13.4 One artifact, two strategies: coalescing

The resolution avoids publishing per-host artifacts, which would fragment
caching and double build cost.

**Choose a small base block size — sized for the tightest host, the mobile
browser, so roughly 64–128 KB — and let readers coalesce.** A range GET can span
many contiguous logical blocks, so a Lambda reader fetching blocks 5–40 issues
*one* request covering the span, including any gaps, as long as the wasted bytes
stay inside §13.2's budget. A mobile browser fetches the two blocks it needs.

The coalescing rule follows directly:

> Merge two fetches separated by a gap *g* into one whenever
> `g < L × bandwidth`, i.e. whenever reading the gap is cheaper than a second
> round trip.

Same bytes on the server, same artifact, same cache entries — one parameter in
the reader. And it composes with query-affinity layout (§3.2): the better the
layout clusters co-accessed blocks, the smaller the gaps, and the more
aggressively coalescing wins. The two ideas reinforce rather than compete.

### 13.5 Read amplification as a declared budget

Alongside the probe-depth contract of §10.6, the format should declare an
amplification budget: *what fraction of fetched bytes does a typical query
actually use?*

This is the metric that makes §13.3's two regimes measurable rather than
rhetorical, and it is the one most likely to expose a bad block-size choice. It
belongs in the evaluation set of §16 as a first-class number, reported per host,
not folded into a latency figure where a bad ratio can hide behind a fast link.

### 13.6 Which tools to build

The second half of the configuration problem, and the direct answer to "which
indexable tools are worth having".

§12.6 says the envelope is general and the structures are specialised. But not
every structure is worth building for every field. A trigram index over
`Subject` serves infix queries and costs perhaps 2–4× the field's size. A
precomputed bitmap for `SendingStatus` costs one bit per document per distinct
value and serves an enormous share of queries. A dictionary over a high-entropy
GUID column may serve almost nothing.

So per field, per structure, there is a **cost in bytes and build time** and a
**benefit in probes avoided across the query distribution**. Choosing the subset
is the same shape of problem as §11.9's materialised-view selection: NP-hard,
submodular benefit, well-served by benefit-per-byte greedy selection under a
space budget.

Which means the two build-time optimisations and this one are all instances of
the same thing — *spend space and build time to remove probes, subject to a
budget, given a query distribution.* That is a single framework, not three
separate mechanisms, and it should be implemented once.

### 13.7 The build can be a search

Here is the part only L0 permits, and it may be the most practical advantage in
this entire document.

A live index must commit to its configuration before it sees the workload. **An
offline build can try several and measure.** Block size, coalescing threshold,
which structures per field, which bitsets to precompute, ordering strategy — the
whole configuration vector can be swept, each candidate artifact evaluated
against the recorded query log, and the best one published.

The artifact is immutable and rebuilt periodically anyway (§7), so the build is
already a batch job with slack in it. Turning that job into an optimisation loop
costs machine time, which is cheap, and removes the need to guess any of the
parameters above — including the ones this document has been reasoning about
analytically.

It also changes what the research has to deliver. The open questions of §14 stop
needing *answers* and start needing a *search space and an objective function*.
A format that ships with a measured configuration for a given corpus and query
log is a more honest artifact than one that ships with defaults justified by
argument.

### 13.8 Segment sizing, and what a billion documents costs

Bitmaps are the cheapest structure in the design, and their arithmetic sets the
sizing of everything else.

| Documents | Dense bitmap |
|---|---|
| 10 000 | 1.25 KB |
| 1 000 000 | 125 KB |
| 10 000 000 | 1.25 MB |
| 100 000 000 | 12.5 MB |
| 1 000 000 000 | 125 MB |

#### Bitmaps need no navigator at all

A bitmap is a flat array indexed by document ID, so the byte offset of any
document's bit is **arithmetic**: `offset = base + docID/8`. There is no
dictionary, no marks file, no tree — the reader computes the range and issues
the GET.

By §12.3's rule the resident navigator for a bitmap is *empty*. That makes it
the ideal structure for this substrate, and it is why Stage A (§12.7) is both
the easiest and the most useful starting point.

It also means bitmaps are **range-sliceable**. Combined with the sort-key
interval of §2, a query never fetches a whole bitmap: if the time filter narrows
a billion documents to a million, every predicate fetches only the 125 KB slice
covering that interval. The bitmap's size is bounded by the *query*, not by the
corpus.

#### Segment size is a derived parameter, not a guess

Cap documents per segment — as ClickHouse caps parts, Lucene segments and
Quickwit splits — and the natural criterion follows from §13.2:

> **Choose the segment size so that a full predicate bitmap fits inside the
> host's free-over-fetch budget.**

| Host | Free over-fetch | Implied segment size |
|---|---|---|
| Browser, mobile | ~120 KB | ~1 M documents |
| Browser, desktop | ~1 MB | ~8 M documents |
| Lambda + S3 | ~3 MB | ~20 M documents |

At those sizes an *unsliced* bitmap fetch is free, so even a query with no
temporal selectivity costs one round trip per segment rather than a scan. That
is a pleasingly concrete answer to a parameter this document had been treating
analytically, and exactly the kind of thing §13.7's build-time search should
confirm rather than assume.

Local document IDs then need 24 bits at 10 M per segment; 32 is convenient. A
global identifier is `(segment, local)`.

#### A billion documents

At 10 M per segment, 10⁹ documents is **100 segments**.

- **Catalog**: perhaps 1 KB per segment — section offsets, sort-key min/max,
  per-column statistics, capability list — so ~100 KB total. Comfortably
  resident, which means planning stays probe-free at this scale (§14.2).
- **Temporally selective queries** — the common case — prune by sort-key min/max
  in the catalog. A 30-day window over three years touches ~3 segments. Fan-out
  is small in practice, and the cost is essentially independent of corpus size.
- **Non-selective queries** are the honest pathological case: touching all 100
  segments means ~125 MB of bitmap, which is 40 round trips' worth of bytes even
  at S3's generous budget.

#### The pruning hierarchy

The pathological case is what the summary hierarchy exists for, and it is the
§11.6 generalisation applied at three granularities:

```
segment presence bitmap   1 bit per segment per value   100 bits ≈ 13 bytes
  ↓ prunes
block summaries           min/max, bloom, per block
  ↓ prunes
document bitmap           1 bit per document
```

A segment-level presence bitmap for a low-cardinality column costs **13 bytes
per distinct value** at 100 segments. Thousands of such vectors fit in the
catalog. A query whose predicate appears in three segments skips ninety-seven
without fetching anything from them.

This is ClickHouse's partition pruning and Lucene's impacts, unified and applied
to every predicate in the algebra of §12.4 — and it is what makes 10⁹ tractable
rather than merely arithmetically describable.


## 14. The protocol

### 14.1 The shape

The interaction is three phases, and the client drives all of them:

```
0.  CATALOG   what structures exist, where, how big      ← cacheable
1.  INDEX     fetch index ranges → compute the hit set   ← the search
2.  DATA      fetch stored fields for this page only     ← depends on 1
```

The server is `GET` with a `Range` header. There is no query endpoint, no
planner on the far side, no session. **The planner lives in the client**, which
is what makes the reader a pure function and the substrate ordinary static
hosting.

The whole design exists to make phase 0 free and phase 1 a single round trip.

### 14.2 What the catalog must contain

The catalog is the *resident navigator* of §12.3 raised to the artifact level.
The rule that determines its contents is exact:

> Anything needed to **compute a byte range** belongs in the catalog. Anything
> that *is* the answer belongs in the payload.

So it carries:

- **version identity** — content hash and monotonic version (§2)
- **file references, offsets and lengths** for every section of every segment
- **the sort-key boundary table**, or the learned model's coefficients (§14.5)
- **per-structure statistics** — cardinalities, distinct counts, selectivity
  estimates — so the client can *plan* without probing
- **the capability list** (§14.6)
- optionally, **direct postings offsets for hot terms**, and the offsets of any
  precomputed bitsets (§11.8)

It must stay small enough to hold in a warm Lambda or a browser tab, because
every probe it saves is a round trip. For a 1.2 GB corpus a catalog of a few
hundred kilobytes is ample, and it compresses well.

Note what is *not* in it: the term dictionary, if the dictionary is large. That
creates the one real design fork of the protocol (§14.3).

### 14.3 Collapsing phase 0 and phase 1

Phase 0 is free whenever the catalog is already held: browser HTTP cache keyed
by version, or warm-container memory. Since the catalog is immutable per version,
caching it is trivially correct (§2). Only a version change forces a refetch,
and the version pointer is the one short-TTL object in the system (§3.3).

Phase 1 is where probe depth is won or lost:

- **Sort-key range predicate** → the boundary table is in the catalog, so the
  doc-ID interval is computed locally. **Zero probes.**
- **Precomputed bitset predicate** → offset is in the catalog. **One probe**, and
  it is independent of any other.
- **Term predicate** → if the term's postings offset is in the catalog, one
  independent probe. If the dictionary must be consulted first, **two dependent
  probes** — dictionary, then postings.

That last case is the only source of depth in the whole protocol, and there are
three ways to remove it:

1. Embed the dictionary in the catalog when it fits (§13.1's MPH makes this far
   more achievable than an FST would).
2. Carry direct offsets for the hot term set, sized from the query log.
3. Speculatively coalesce — fetch the dictionary block *and* the postings region
   it probably points into as one range, exploiting §13.2's budget. With 3 MB of
   free over-fetch on S3, "fetch the dictionary block and its whole neighbourhood"
   is often free.

All three are configuration choices for the build to decide by measurement
(§13.7), not by argument.

Phase 2 is inherently dependent on phase 1 — document identity cannot be known
before the hits are computed — so **two round trips warm is the floor**, and the
protocol reaches it whenever phase 1 avoids the dictionary hop.

### 14.4 Pagination: the cursor is a sort-key value

This is the part the three-phase sketch makes visible, and it is a real
consequence of §2 that the document had not drawn out.

Because results are ordered by the sort key and document IDs are assigned in
that order, **"the next page" is an adjacent interval, not a re-execution.** A
cursor is simply the sort-key value of the last row returned:

```
page 1   sort_key < now,  take 50   → hits, last_key = K
page 2   sort_key < K,    take 50   → continues the same scan
```

The consequences are worth stating because they invert the usual situation:

- **No server-side cursor state.** The cursor is a value the client holds; any
  client, any time, can resume.
- **No deep-pagination penalty — in the clustering order.** Page 500 costs what
  page 1 costs, where a conventional engine must compute and discard 25 000
  rows. This holds only when results are ordered by the clustering key;
  secondary orders pay a scan, quantified in §14.9.
- **Pages are stable.** Pinned to a version, paging through a result set cannot
  produce duplicates or gaps, even while new documents are being written — the
  new ones simply are not in this version.
- **Hit sets need not be materialised in full.** Evaluate predicates lazily over
  the interval and stop at 50 survivors. The expensive case is a very selective
  predicate over a wide interval, where many blocks must be scanned to find few
  hits — which is exactly what the auxiliary structures of §12.4 exist to prune.

The hit set therefore does not need to live anywhere between pages. That removes
the statefulness that pagination normally drags into a search system, and it is
a direct dividend of sort-key ordering.

### 14.5 Counting is a separate decision

Total hit counts do not come free from §14.4, since lazy evaluation stops early
by design. Three options, and the format should support choosing per query:

- **No count** — "more results" from whether a 51st hit exists. One extra
  document of work.
- **Exact count** — materialise the whole hit set: fetch all relevant postings
  and intersect. Costs bytes proportional to selectivity, still one round trip.
- **Estimated count** — from catalog statistics and independence assumptions.
  Free, and usually good enough for "about 1 200 results".

Most UIs want the first or third. Exact counting is the expensive one and should
be opt-in rather than the default, which is the opposite of what most search
APIs do.

### 14.6 The catalog as a capability manifest

The user's "structure and library" framing implies something worth making
explicit: the catalog declares *which tools this artifact actually contains*.

```
capabilities: [ sort_interval, mph_dictionary, trigram:Subject,
                bitmap:SendingStatus, stored_fields ]
```

The client plans against the declared set. A trigram index for `Subject`? Use
it. Absent? Fall back to fetching candidates and filtering locally, slower but
correct. An unknown capability? Ignore it.

This gives two properties cheaply:

- **Forward compatibility.** Adding a structure type does not break existing
  readers; they simply do not use it.
- **Per-corpus configuration without per-corpus code.** §13.6 chooses different
  structures for different fields and corpora; the client discovers the choice
  rather than being compiled against it.

The planner is therefore *data-driven*, which also means the build-time search of
§13.7 can change the configuration between versions without a client release.

### 14.7 A worked query

Realistic shape: messages from the last 30 days, status `FAILED`, subject
containing `lasku`, first 50 by recency. Catalog held, version pinned.

```
plan (local, no I/O)
  ├ sort_key ∈ [t0, t1]        → doc-ID interval [812400, 947310)   0 probes
  ├ SendingStatus = FAILED     → bitmap at 0x4A20, len 118 KB
  └ Subject ~ "lasku"          → trigram postings, 3 grams, offsets in catalog

phase 1   ONE parallel wave, coalesced by §13.4
  GET bytes=304128-436224      bitmap slice for the interval
  GET bytes=8910336-9043968    trigram postings, 3 ranges merged (gaps < 3 MB)
  → intersect in memory → 1 273 hits, take first 50 by doc ID

phase 2
  GET bytes=…                  stored fields for 50 doc IDs, coalesced
  → 50 documents, last_key → cursor
```

**Two round trips.** Phase 1's fetches are independent so they cost one; phase 2
depends on phase 1 so it costs a second. Next page: identical, with the interval
starting at the cursor.

The contract of §10.6 is met, and it is met because everything that computed a
*byte range* was already resident — which is the single rule the whole design
reduces to.

### 14.8 Execution in detail: from bitmaps to bytes

The pipeline, stated concretely:

```
each producer          → bitmap
combine                → AND / OR / XOR / ANDNOT     (in memory)
page                   → select(150) … select(200)   → doc IDs
order                  → clustering order, or a permutation
locate                 → doc ID → (offset, length) in stored fields
fetch                  → coalesce, fire in parallel, range-limited
```

**`select(k)` has a name.** Taking "bits 150–200" of a result bitmap is the
*select* primitive — the position of the k-th set bit — and together with *rank*
it is the operation succinct data structures are built around (Jacobson, 1989;
§15.1). For a transient in-memory result bitmap no index is needed: accumulate
`popcount` over 64-bit words until the running total reaches 150, then walk bits.
That is a few microseconds over millions of bits, and it is why the result set
never needs to exist as anything but a bitmap.

**XOR is worth having.** §12.4 listed intersection, union and difference;
symmetric difference costs exactly the same machine instruction and occasionally
expresses a predicate ("changed in exactly one of these two states") that would
otherwise need two passes. Add it.

### 14.9 Sort orders, and the privilege of the clustering order

Here is the subtlety the pipeline above hides, and it forces a correction to
§14.4.

A bitmap is ordered by document ID. When the requested order **is** the
clustering order — which by §2 is the sort key, typically time — `select(k)`
yields results already in the right sequence. Free.

When the requested order is anything else (`length`, `birthday`, `sender`), the
bits are in the wrong order and `select(k)` is meaningless for paging. Two
options:

- **Materialise and sort** the whole hit set by the secondary key. Cost grows
  with hit-set size, not page size — wrong shape.
- **Iterate a permutation.** For each rank *k* in the secondary order, take
  `doc = perm[k]` and test membership in the result bitmap; collect until the
  page is full. Cost is proportional to how deep into the permutation you must
  go, roughly `(offset + pagesize) / selectivity` bit tests.

The second is correct and, in memory, cheap: even ten million bit tests is
milliseconds. **The real cost is the permutation table itself** — one per
supported secondary order, N·⌈log₂N⌉ bits, so ~30 MB for ten million documents.
Resident on Lambda, prohibitive in a browser. (§12.8 softens this considerably:
a sorted-column index built for range predicates *is* that permutation, so the
two uses share one structure.)

And it cannot be fetched incrementally without breaking the probe contract: you
do not know how far you must scan until you have scanned, so fetching
permutation blocks on demand is a chain of *dependent* probes — the one pattern
§11.7 forbids.

The resolution uses the catalog statistics of §14.2 and the over-fetch budget of
§13.2: **estimate the required scan depth from the selectivity estimate and
fetch that much speculatively, generously over-provisioned.** One probe, with a
rare second fetch when the estimate falls short. Three megabytes of free
over-fetch on S3 buys roughly a million permutation entries, which covers deep
pagination into all but the most selective queries.

#### The correction

§14.4 claimed pagination has no deep-pagination penalty. That is true **only in
the clustering order**. In a secondary order, page 500 does cost more than page
1 — not the quadratic blow-up of offset-based pagination in a conventional
engine, but a scan proportional to offset divided by selectivity.

This sharpens rather than weakens §2's argument: the clustering order is not
merely *one* useful order, it is the one that is structurally free, and every
other order is bought with a permutation table. Choosing it to match the
dominant query ordering is therefore the highest-leverage decision in the whole
build.

### 14.10 From document ID to bytes

The last step of the user's model — "instance ref" — is a doc ID → `(offset,
length)` lookup into the stored-fields section, and it obeys §12.3's rule
directly.

A flat table of N offsets is too large to keep resident. Two levels solve it:

- **per-block offsets** in the catalog — N/blocksize entries, small, resident
- **within-block offsets** in each block's own header — fetched *with* the block
  it describes, so they cost nothing extra

The reader computes the block from the doc ID, fetches the block, and reads the
local offset from its header. No dependent probe, because the block header
arrives in the same range as its payload.

Then coalescing (§13.4), and the same asymmetry appears a third time:

- **Clustering order** — a page of 50 consecutive documents is physically
  adjacent, so coalescing merges them into **one range GET**.
- **Secondary order** — the 50 documents are scattered across the section, so
  up to 50 ranges. Parallel, therefore still *one round trip*, but many more
  requests and more wasted bytes.

Which is the same conclusion as §14.9 arrived at from a different direction, and
a good sign that the model is coherent: **the clustering order is free at every
stage of the pipeline — selection, ordering and fetching — and every other order
pays at each.**


### 14.11 Why there is no result window

OpenSearch defaults `index.max_result_window` to 10 000 and requires an explicit
override beyond it. The limit is not arbitrary: in a scatter-gather engine, page
*p* of size *s* obliges **every shard** to produce its top `(p·s + s)` documents
so the coordinator can merge and discard. Cost grows with offset *and* with
shard count, and the memory is on one node. The cap is a defence against the
architecture.

This design has no such node. Pagination is interval continuation (§14.4) in the
clustering order, so there is nothing to merge and nothing to discard — page
500 fetches the same 50 documents' worth of bytes as page 1. No window is
needed because the cost the window exists to bound does not arise.

Two honest qualifications:

- In a **secondary sort order** the permutation scan of §14.9 does grow with
  offset — linearly in `offset / selectivity`, over in-memory bit tests rather
  than materialised documents. Far cheaper than scatter-gather, but not free.
- **Exact total counts** (§14.5) still cost proportionally to selectivity. Most
  of what a result window protects against is really the count, not the page.

Worth noting that OpenSearch's own escape hatch validates the model: the
recommended way past `max_result_window` is `search_after`, which is a
sort-key cursor — precisely §14.4. The difference is that there it is an opt-in
workaround for an architecture that prefers offsets, whereas here it is the only
mechanism there is.


## 15. What theory says about knowing in advance

The question "how much does foreknowledge buy?" has a substantial literature,
and it gives a sharper answer than one might expect: **static knowledge buys
space and lets search be replaced by computation, but it does not remove the
probe lower bound.** What it *can* remove is the *dependence* between probes —
and that, not the total count, is what matters on high-latency storage.

### 15.1 The right cost model already exists

The **cell-probe model** (Yao, 1981) counts only memory accesses and treats
computation as free. That is an odd model for a CPU and an exact model for
object storage, where a range GET costs 20–50 ms and decoding a megabyte costs
microseconds. The formalism for §10.6's "dependent round trips" is not new; it
is simply rarely applied to storage engine design.

Alongside it, the **external memory model** (Aggarwal & Vitter, 1988) with
parameters *N* (data), *M* (memory), *B* (block) counts block transfers, and
gives search as O(log_B N). This is worth evaluating concretely, because it
quietly supports the two-fetch claim of §6:

> With B = 1 MB and ~100-byte entries, B ≈ 10⁴. For N = 10⁹ records,
> log_B N ≈ 2.25.

So a properly fanned-out search structure over a billion records needs **two to
three block transfers** — and SQLite's 3–4 round trips (§10.5) are not inherent
to B-trees but to a 4 KiB page size. The theory says: on a medium where the
block can be a megabyte, make the fanout enormous and the depth collapses.
**Cache-oblivious** structures (Frigo et al., 1999) get there without knowing B,
which matters when the block size is a CDN's business rather than yours.

### 15.2 Where the classical models fall short

Both models count probes *in total*. Neither distinguishes:

- **k independent probes**, issuable simultaneously — one round trip of latency
- **k dependent probes**, each address derived from the previous — k round trips

On a local disk the distinction is minor. On S3 it is the entire problem: a
hundred parallel range GETs finish in the time of one. A useful cost model here
would count **probe depth** — the longest chain of address dependencies — and
treat width as nearly free up to a concurrency limit.

There is adjacent work (parallel disk models, batched predecessor problems), but
a clean dependent-depth model for object storage is not standard equipment. If
this project has a theoretical contribution rather than merely an engineering
one, it is most likely here: *restating index design as minimising probe depth
subject to a width budget*, and asking which classical structures are optimal
under that objective rather than under total-probe count.

Under such a model, the design rule of §10.6 follows formally: everything needed
to **compute an address** must be resident, so that the only probes remaining
are the ones that fetch the answer — and those are independent, hence one round
trip.

### 15.3 Structures that exist only for static data

This is the strongest theoretical support for taking L0 seriously (§3.2). A
consistent pattern runs through the literature: **for static sets, strictly
better structures exist, and they are unavailable the moment insertion must be
supported.**

| Dynamic | Static equivalent | Gain |
|---|---|---|
| Hash table | **Minimal perfect hashing** (RecSplit, CHD) | ~1.5–1.6 bits/key vs pointers; lower bound is log₂e ≈ 1.44 |
| Bloom filter | **XOR / ribbon filters** | ~1.23× the information-theoretic bound vs Bloom's ~1.44× |
| Skip lists over postings | **Elias-Fano** (Vigna, 2013) | n⌈log₂(u/n)⌉ + 2n bits *with O(1) random access* |
| Balanced BST | **Optimal BST** (Knuth, 1971) | expected cost → H(access distribution) |
| B-tree | **Learned index** (PGM, RMI) | see §15.5 |

Elias-Fano deserves emphasis for this design specifically: it gives **random
access into a compressed postings list without decoding from the start**. That
means a range GET can fetch a *slice* of a postings list and use it directly —
which is precisely what the range-request substrate wants, and it removes the
need for skip lists (§10.3) as a separate structure.

The pattern is not incidental. Each of these structures works by fitting itself
to the exact set it will hold; the ability to do that is what insertion
destroys. **L0 is not a restricted version of L1 — it is a different regime with
better structures available**, which is the formal version of the §3.2 claim.

### 15.4 Compression: how small can it get

Space has clean bounds. The k-th order empirical entropy *H_k(T)* lower-bounds
any representation that must reconstruct the text, and **compressed self-indexes
reach it**:

- **FM-index** (Ferragina & Manzini, 2000) — full-text substring search in space
  ≈ *nH_k(T) + o(n log σ)*. It answers *arbitrary substring* queries, which is
  exactly the predicate all four formats of §10 handle worst.
- **r-index** (Gagie, Navarro, Prezza) — space proportional to *r*, the number of
  BWT runs, which collapses on repetitive collections.
- **Wavelet trees** (Grossi, Gupta, Vitter, 2003) — rank/select/access at
  *nH₀ + o(n log σ)*.

This is a serious observation for §10.6's n-gram-postings suggestion: the
literature already has a structure that does infix search in
entropy-bounded space with no n-gram expansion at all. Whether an FM-index can
be laid out for range-request access — its locate step is pointer-chasing over
the suffix array, which is exactly the dependent-probe pattern to avoid — is an
open and genuinely interesting question. It may be that the sampling rate of the
suffix array becomes the probe-depth knob.

### 15.5 Knowing the data: search becomes computation

If the data is sorted and fully known, its distribution can be *learned* and the
index replaced by a function. **Learned indexes** (Kraska et al., 2018) predict
position from key; the **PGM-index** (Ferragina & Vinciguerra, 2020) does it
with provable guarantees — piecewise linear approximation with bounded error ε,
space proportional to the number of segments, not to the number of keys.

For temporal data this is unusually favourable, because timestamp CDFs are often
close to piecewise linear over long stretches. A boundary lookup that §2 gives
to a sparse table could instead be **a few kilobytes of model coefficients and
zero probes** — the address is computed, not looked up, regardless of corpus
size.

That directly strengthens §15.2's design rule and §10.6's round-trip contract:
the residency requirement becomes trivially satisfiable, because what must be
resident is a model rather than a table.

### 15.6 Knowing the queries: optimal layout is a known NP-hard problem

Foreknowledge of the *query distribution* has its own theory, older than the
data-structure work:

- **Optimal binary search trees** (Knuth, 1971): given access probabilities,
  the minimal expected search cost is achievable in O(n²), and it approaches the
  entropy H(p) of the access distribution. Entropy is the floor.
- **Splay trees** (Sleator & Tarjan, 1985) achieve static optimality *without*
  knowing the distribution — a useful corrective: adaptivity can asymptotically
  match foreknowledge, so "we know the queries" is worth a constant factor, not
  an asymptotic one.

Query-affinity layout (§3.2) has a precise formalisation: build a graph whose
nodes are terms and whose edge weights are co-occurrence frequencies in the query
log, then find a linear arrangement minimising total weighted edge length. This
is **Minimum Linear Arrangement**, and it is NP-hard. In practice it is attacked
by **recursive graph bisection**, which is exactly what BOLT and PGO do to
binaries — and, importantly, what Dhulipala et al. (KDD 2016) do to *inverted
indexes*, reordering document identifiers to improve postings compression.

So the idea has both a theory and a demonstrated application in this exact
domain. It is less novel than §10.6 implied, and better supported.

### 15.7 The conflict this exposes

Reading §15.6 next to §2 surfaces a genuine tension, and it is better to state it
as a formal trade-off than to discover it in benchmarks:

> Document identifier assignment is a single degree of freedom, and at least two
> objectives compete for it.
>
> - **Order by timestamp** → range predicates become interval slices (§2), but
>   any given term's postings are scattered across the whole ID space, so gaps
>   are large and delta-compression degrades.
> - **Order by co-occurrence** (recursive bisection) → postings cluster and
>   compress well, but temporal locality is destroyed and the interval-slicing
>   advantage disappears.

This is the doubt recorded in §19 and it is real, but the framing suggests a
resolution rather than a choice: **the two objectives operate at different
scales.** Order coarsely by time into blocks — preserving interval pruning at
block granularity, which is all the sparse index of §10.2 needs — then order
*within* each block by co-occurrence, recovering compression locally. The sparse
index only requires monotonicity between granules, not within them.

Whether that hybrid captures most of both advantages is a concrete, measurable
question and probably the most interesting experiment in this document.

### 15.8 What knowing does not buy

The honest limit. Cell-probe lower bounds for predecessor search
(Pătrașcu & Thorup, 2006) are tight and apply to **static, fully known sets**.
Knowing everything in advance does not make search free; there remains a
space/probe trade-off curve that no amount of preprocessing removes. With
near-linear space some problems genuinely require Ω(log n / log log n) probes;
buying O(1) probes costs superlinear space.

So the theoretical summary is:

- **Space** — foreknowledge buys entropy-optimality, and it is achievable
  (§15.4). This is the largest and most certain gain.
- **Probes** — foreknowledge does *not* lower the bound, but with a large block
  size the bound is already only 2–3 (§15.1).
- **Probe depth** — foreknowledge *can* collapse this, by making addresses
  computable rather than discoverable (§15.5). This is the gain that matters
  most for object storage, and the one the classical models do not name.
- **Query knowledge** — worth a constant factor, bounded below by the entropy of
  the access distribution (§15.6).

Which is a reasonably precise answer to "how much can we do, knowing things in
advance": *a constant factor on latency, an asymptotic win on space, and the
ability to trade discovery for arithmetic — but not a free search.*

### 15.9 Reading list

Jacobson (1989) succinct structures · Yao (1981) cell-probe · Aggarwal & Vitter
(1988) external memory · Frigo et al. (1999) cache-oblivious · Ferragina &
Manzini (2000) FM-index · Grossi, Gupta & Vitter (2003) wavelet trees · Gagie,
Navarro & Prezza r-index · Vigna (2013) quasi-succinct indices · Ottaviano &
Venturini (2014) partitioned Elias-Fano · Pătrașcu & Thorup (2006) predecessor
lower bounds · Knuth (1971) optimal BSTs · Sleator & Tarjan (1985) splay trees ·
Kraska et al. (2018) learned indexes · Ferragina & Vinciguerra (2020) PGM-index ·
Dhulipala et al. (2016) recursive graph bisection for index compression ·
Navarro, *Compact Data Structures* (2016), as the single best entry point.

## 16. Open questions

**L0 core**
1. How few round trips can a warm conjunctive query be reduced to — is one
   achievable, and at what corpus size does it stop holding?
2. Does **query-affinity layout** (§3.2) measurably reduce fetches on a real
   query log, and by how much? §15.6 shows this is less novel than it first
   appeared — it is Minimum Linear Arrangement, NP-hard, already applied to
   inverted indexes by Dhulipala et al. — which makes it better supported but
   also means the achievable gain is probably already documented. Check the
   literature before measuring.
3. How large is the term dictionary under MPH vs FST, and where is the corpus
   size at which it stops fitting in a WASM heap?
4. What is the real size and speed cost of asymmetric build-time compression?

**Temporal**
5. Does sort-ordered doc ID assignment (§2) hold its advantage at L1 across a
   realistic artifact count, or does the per-artifact fan-out erase it?
6. What retention policy makes time travel cheap — at what block granularity
   does content addressing actually share bytes between versions?

**L1**
7. Where is the rebuild-interval sweet spot as a function of update rate
   (§7.3), and at what update rate does L1 stop being the right model?
8. How many concurrent writers before manifest CAS needs batching (§7.5)?

**Hosts**
9. Bytes to first result at 10k / 100k / 1M documents, against Pagefind on the
   same corpus.
10. Prefix-shard granularity: how many shards, split where, to keep per-keystroke
    fetches small without exploding object count?
11. WASM reader binary size — it competes with the index for bandwidth.
12. **Does one logical format genuinely serve both hosts**, or do the divergent
    query shapes force separate layouts? If they diverge, the unification
    argument collapses.

**Format synthesis** (from §10.6)

13. **Can a round-trip contract actually be held?** For the budget of §10.6 to
    be real, every structure needed to *compute an address* — footer, sparse
    boundary table, dictionary — must stay resident. At what corpus size does
    that stop being true, and does packaging (§5) change the answer?
14. **Do n-gram postings beat n-gram bloom filters** for infix matching, and at
    what index-size cost? ClickHouse's `ngrambf_v1` is a probabilistic skip; a
    real trigram postings section should be exact and more selective, but may
    cost more bytes than the workload justifies. **And both may be beaten by an
    FM-index** (§15.4), which answers arbitrary substrings in entropy-bounded
    space — if its locate step can be laid out to avoid dependent probes. That
    is the more interesting form of the question.
17. **Can a learned boundary model replace the sparse index** (§15.5)? For
    timestamp data a PGM-index should need kilobytes and zero probes. This is
    cheap to test on the real corpus and would make the residency requirement
    of §15.2 trivially satisfiable.
18. **Does the two-scale ordering hybrid of §15.7 work** — coarse temporal
    blocks for interval pruning, co-occurrence ordering within blocks for
    compression? Probably the single most informative experiment here.

**Intermediate results** (from §11)

19. **Does bulk-materialise beat leapfrog** on object storage, and where is the
    selectivity crossover? §11.7 asserts the inversion; it needs measuring, and
    there will be a point at which a very rare term makes skipping worth the
    extra probes after all.
20. **What fraction of a real query workload reduces to conjunctions of
    precomputable filters** (§11.8)? If it is high, the one-probe query is
    routine rather than a best case. If it is low, precomputation is a
    sideshow.
21. **Which bitsets to precompute, under what space budget?** Treatable as
    materialised view selection (§11.9) — the question is whether the standard
    greedy approximation behaves well on a search workload's query lattice.
22. **How fast does a precomputed set decay** as the query distribution drifts,
    and does that decay rate sit inside or outside the rebuild cadence of §7?
15. **Is sparse-index-over-sorted strictly better than BKD** for temporal range
    predicates, or is there a selectivity crossover where Lucene's approach
    wins? This decides §10.3's "replace" recommendation.
16. **Does query-affinity layout transfer from the PGO analogy?** Binary layout
    optimisation works because call graphs are stable. Are query co-occurrence
    graphs stable enough over time, or does layout decay faster than rebuild
    cadence can fix?

Q1 and Q2 decide whether there is anything here at all. Q9 decides whether the
browser host is competitive. Q13 decides whether the central claim of §10.6 —
that a declared round-trip budget is achievable — is more than rhetoric. All
four are cheap to answer.

## 17. Evaluation

**Corpora.** A temporal, append-mostly corpus for the L0/L1 ladder — the message
corpus of Appendix A serves, scaled 1× / 10× / 100×. A public documentation or
catalogue corpus at 10k / 100k / 1M documents for the browser host, so numbers
are comparable with published Pagefind figures.

**Query sets.** Real query logs where available. For temporal search: range
filter plus field predicates, including unselective wildcards and deep
pagination. For the browser: keystroke sequences including single-character
prefixes and misspellings.

**Metrics.** Latency p50/p95/p99 reported separately warm and cold; **fetches and
bytes per query, and bytes to first result**; index size relative to source;
build time; and for L1, visibility lag and tombstone burden over time.

**Baselines, increasing effort.** (1) an always-on cluster, for reference;
(2) DuckDB over time-partitioned Parquet, the "no custom format" control;
(3) Pagefind, for the browser; (4) Tantivy on EFS; (5) Quickwit on S3;
(6) this format.

**What would falsify the thesis.** If L0 cannot reach one warm round trip at
realistic corpus sizes; if query-affinity layout gives no measurable benefit; or
if an L1 index with a realistic artifact count loses the temporal advantages of
§2 — then the ladder is not buying what it claims.

## 18. Stages

- **Stage 0 — L0 read path only.** Build an artifact offline, query it from both
  hosts. No writes, no manifest, no deltas. Answers Q1–Q3 and Q9. This is the
  whole idea in its smallest honest form.
- **Stage 1 — measure against baselines.** DuckDB+Parquet, Pagefind, Quickwit on
  the same corpora. Establishes whether Stage 0 is worth continuing.
- **Stage 2 — L0 optimisations.** Sort-ordered IDs, MPH, query-affinity layout,
  the two-scale ordering hybrid (§15.7), and precomputed filter bitsets (§11.8).
  Answers Q2, Q18 and Q19–Q21 — the substance of the whole idea.

The predicate ladder of §12.7 cuts across these stages and is the more useful
build order in practice: Stage A (bitmap) and A′ (interval) are enough to run
the protocol of §14 end to end and to falsify most of the thesis; Stage B
(ordered columns) absorbs integers, time, floats, string equality and prefixes
in one structure; Stage C (infix) is the only genuinely new machinery and
carries the only real structural risk.
- **Stage 3 — the version pointer.** Publication, monotonicity, immutable
  caching end to end. Still no writes.
- **Stage 4 — L1.** Deltas as L0 artifacts, manifest, tombstones, rebuild policy.
  Answers Q5, Q7, Q8.
- **Stage 5 — hardening.** Schema evolution, observability, failure modes.

Each stage is a stopping point, and Stage 0 is deliberately shaped so that a
negative result ends the project after a few days rather than a few months.

## 19. Limits and honest doubts

- **Q2 may simply not pay.** Query-affinity layout is the most interesting idea
  here and rests on the assumption that real query logs have exploitable
  co-occurrence structure. They may not, and the fallback is an ordinary layout.
- **The unification may be wrong** (Q12). A temporal range-filter workload and an
  as-you-type prefix workload want different things from a dictionary. The
  single-format claim is the intellectually appealing part and therefore the
  part to distrust.
- **Interactive latency on S3 Standard is genuinely hard.** If the warm path
  cannot reach one round trip, the floor of §4 may need Express One Zone or EFS.
- **L1's tombstone bound may be tighter than it looks** for update-heavy corpora
  (§7.3), pushing rebuild cadence toward continuous — at which point the model
  is wrong for that workload.
- **Prior art is substantial.** Quickwit and Pagefind have solved much of the
  architecture; ClickHouse, Lucene, Parquet and SQLite have solved the
  structures (§10). The contribution, if any, is assembling them under a
  declared consistency model and round-trip budget, and exploiting what L0
  grants (§3.2) — not the overall shape, which is known.
- **The four-formats synthesis may be naive.** Each of them omits what the
  others have for reasons, and some of those reasons will only become visible
  on contact. The clearest such reason is now named rather than feared: an
  inverted index over sorted-order IDs compresses worse than over
  assignment-order IDs, because sorting by timestamp scatters each term's doc
  IDs. §15.7 frames this as a competition for a single degree of freedom and
  proposes a two-scale hybrid — coarse temporal blocks, co-occurrence order
  within them. **That hybrid is a hypothesis, not a result**, and it belongs in
  Stage 2 rather than being discovered in Stage 4.
- **Precomputation cannot adapt.** §11.8's advantage over Lucene's query cache
  is that it is decided at build time; that is also its weakness. Lucene's cache
  follows the workload continuously, while a shipped bitset is fixed until the
  next rebuild. A drifting query distribution degrades it silently, and the
  degradation is invisible without measuring hit rates that a stateless reader
  has nowhere to report. Q22 exists because of this.
- **The theory may flatter the design.** §11 was assembled to answer a question
  about foreknowledge, and it is easy to read a literature selectively when it
  agrees with you. The load-bearing claim — that probe *depth* rather than probe
  count is the right objective (§15.2) — is the one least supported by existing
  work, precisely because it is the part presented as a gap.
- **Public-index-only** in the browser host (§9). No per-user access control,
  ever.

---

## Appendix A — origin and test corpus

This line of enquiry came out of operating a small OpenSearch domain whose only
job was to serve a derived, fully rebuildable index: ~1.2 GB across three
indices, 600–2000 document writes per day, tens of queries per hour, and a
source of truth in DynamoDB that could reconstruct the whole thing in seconds.
It required a cluster running continuously, could not be paused, and lost its
entire contents seven times in two months when the underlying node was replaced.

The mismatch is instructive rather than merely annoying: a workload whose write
model is comfortably L1 — nobody would have noticed a minute of indexing lag —
was being served by infrastructure built to guarantee L3.

That corpus also makes a good L0/L1 benchmark, being temporal, append-mostly,
and realistically shaped: mostly `wildcard`-matched string fields, one
low-cardinality keyword, and a timestamp that every query filters on.

## Appendix B — measured against two corpora

Two L0 artifacts were built and instrumented end to end: a national topographic
map (MML, 6 683 615 features, 72 collections, 883.7 MB) served to a browser, and
the Finnish vehicle register (Traficom, 5 288 425 vehicles) served to the same.
Both answer any view in **2–4 round trips and 20–40 ms**. Everything below is
measured on those two, not argued.

Three of the findings contradict assumptions made earlier in this document and
are marked accordingly.

### B.1 A predicate outside the clustering key does not reduce I/O

Filtering `TieViiva@250k` from 458 161 rows to the 12 205 trunk roads — **2.7 %
of rows** — saved **3.6 % of bytes** (16.78 → 16.17 MB). The matching rows are
scattered across every stored block, so selectivity never becomes I/O.

Moving the selector into the clustering key instead (collection renamed by road
class, and map names by scale relevance) was rebuilt from the same data and
measured:

| layer | predicate in query | predicate in key | ratio |
|---|---|---|---|
| trunk roads | 19.84 MB | 0.50 MB | **40x** |
| place names, top tier | 10.02 MB | 0.04 MB | **227x** |

This is the first quantitative evidence for **query-affinity layout (§3.2)**.
The doc argued the idea from the cost asymmetry; the number is 40–227x on the
dominant cost of a view, achieved by a one-string change at ingest. It also
sharpens §10.6's observation that nobody lays out data by access statistics:
the penalty for not doing so is not marginal.

### B.2 A key derived by reduction has a blind spot proportional to extent

The clustering key is `collection x 4^18 + hilbert(centroid)`: a 32-point
polygon is reduced to one point. An object is therefore found only if its
*centroid* falls in the query box, not if its geometry intersects it.

| view | lakes missed | municipal borders | built-up areas |
|---|---|---|---|
| whole country | 0.0 % | 0.0 % | 0.0 % |
| region | 0.6 % | 10.8 % | 1.8 % |
| city | 2.2 % | **29.4 %** | 8.5 % |
| block | **10.0 %** | 0.0 % | **36.4 %** |

The loss grows as you zoom *in*, which is counter-intuitive, and the percentage
understates it: one missing lake covers half the screen.

**This generalises beyond geometry.** Any key derived by reducing a document to
a point has it — a document with a *time interval* keyed by its start timestamp
is missed by a range query that overlaps its middle. That is directly relevant
to §2's temporal framing, which assumes a document is a point in time.

Mitigation measured: widening the query box per layer by the layer's own typical
object size. A 25 km floor gave 100 % recall at every zoom and cost 0.16 → 0.56
MB at the deepest. It is a heuristic, not a guarantee; the sound fix is to tier
objects by size at build time so each tier's maximum radius is known.

### B.3 A coarser artifact is not a subset of the finer one

`VesiViiva@250k` does not contain class 36311 (watercourses under 2 m) **at
all** — 1 592 062 features absent, not thinned. Cartographic generalisation is
selection, not sampling. Any multi-resolution scheme that assumes the coarse
level is a prefix or sample of the fine one is wrong about this data, and a
view needing that class must pin itself to the scale that has it.

### B.4 Request count is a cost the round-trip model misses — CONTRADICTS §10.1

§10.1 names dependent round trips as the metric and treats parallel fetches as
free. That holds for latency and fails for billing.

A high-cardinality `terms` aggregation asks for tens of thousands of small byte
ranges. Measured on the vehicle corpus:

| query | byte ranges | as S3 GETs | after coalescing |
|---|---|---|---|
| counts by year | 12 | 12 | **2** |
| traits (6 averages) | 118 | 118 | **7** |
| Porsche models | **193 088** | 193 088 | **9** |
| mileage by brand | 15 661 | 15 661 | **3** |

At S3 list price, the uncoalesced Porsche query is ~77 USD **per view**; the
coalesced one is 0.000004 USD. Over HTTP it was also the difference between
56 680 ms and 10 ms. Merging ranges within 64 KB into one request costs the
bytes in the gaps and saves everything else — and measured, bytes went *down*,
because overlapping small reads collapsed.

**Coalescing is not an optimisation for this format; it is a precondition.**
The format should declare a requests-per-query bound alongside the round-trip
bound of §10.6.

### B.5 Resident metadata scales with cardinality, not corpus — CONTRADICTS §10.6

§10.6 requires that "everything needed to compute the address of the data must
come from metadata small enough to be permanently resident". Measured:

| corpus | documents | distinct keyword values | sections | catalog |
|---|---|---|---|---|
| map | 6 683 615 | 214 | 227 | **4.0 MB** |
| vehicles | 5 288 425 | 112 635 | 112 667 | **24.9 MB** |

Nearly the same document count; a six-fold difference in catalog. One field,
`kaupallinenNimi` (96 521 model names), accounts for 7.38 MB of the catalog on
its own, because every distinct value gets its own section entry.

Cold start was 128 ms locally, of which 84 ms is `JSON.parse` — trivial against
a 10–30 s container start, so this is a budget item rather than a blocker. But
the residency assumption is conditional on cardinality, and an L1 index
multiplies the catalog by segment count. The fix is to make the catalog itself
range-addressable: a small root plus per-field section tables fetched on demand,
so a query touching three fields reads kilobytes rather than 24.9 MB.

### B.6 Top-k `terms` does not merge across segments — NOT IN §10.6's gap list

One corpus, built once as a single artifact and once as four time-ordered
segments, same query:

```
exact    Toyota 80 494 | Muuli 65 885 | Omavalmiste 62 164 | Volkswagen 45 726
merged   Toyota 77 858 | Muuli 65 885 | Omavalmiste 57 929 | Volvo      37 552
```

Toyota is undercounted by 3.3 %, Volkswagen is displaced, and one term vanishes.
The error is always an undercount and grows toward the tail of the list.
Over-fetching from each segment fixes it:

| over-fetch | wrong counts (size 10) | wrong counts (size 40) | worst error |
|---|---|---|---|
| 1x | 8 | 22 | 20.9 % |
| 2x | 3 | 14 | 6.5 % |
| 4x | 2 | 6 | 1.3 % |
| 10x | 1 | 2 | **0.13 %** |
| 50x | **0** | **0** | **0 %** |

Bytes read did not change measurably between 1x and 50x: the bitmaps are read
either way, and extra terms are additional popcounts over data already fetched.
**The correction is effectively free, and omitting it is silent.**

### B.7 Segmentation costs less than the literature implies

Same million documents as one artifact and as four time-ordered segments:

| | time | round trips | bytes |
|---|---|---|---|
| 1 segment | 9 ms | 1 | 8.4 MB |
| 4 segments, parallel | 10 ms | **1** | 8.4 MB |
| 4 segments, serial | 7 ms | 4 | 8.4 MB |

Merged histogram results were identical to the single artifact. Space was
**1.00x** and catalogs **1.20x** (7 199 → 10 191 distinct keyword values —
sub-linear, because values recur across periods).

With a monotone key the segments are key-disjoint, so the manifest alone prunes:

| query | segments opened |
|---|---|
| year 1980 | 1 of 4 |
| year 2010 | 1 of 4 |
| year 2024 | **0 of 4** |

Read amplification across segments is a *bytes and memory* cost here, not a
latency cost, because the fetches are independent. This supports §13's derived
segment size and weakens the usual LSM worry about segment count — but only
while the key advances monotonically with arrival. Keyed by an attribute that
may take any value (a 1968 vehicle registered today; a Hilbert index), segments
overlap, pruning stops working, and compaction becomes a real merge.

### B.8 What the stored payload costs, and what a format change buys

The vehicle artifact was 2 371 MB, of which **1 832 MB (77.3 %) was stored
documents held as raw JSON** — every field name repeated 5.3 million times,
346 bytes per document. Three independent levers, each measured:

| lever | result |
|---|---|
| tagged encoding + schema table (already in the format) | 346 → **72 bytes/doc** (4.8x) |
| per-block compression: gzip / zstd / brotli | **9.2x / 9.0x / 13.5x** |
| columnar within block, before compression | 1 505 → 588 kB raw; 156 → **105 kB** gzipped |
| sorted column values, delta + varint | 8 bytes → **1.00 byte/value** (8x) |

A rebuild using only what the format already supports — correct field types,
tagged encoding, and dropping stored fields no query reads — took **2 371 MB →
581 MB** without touching the reader. Field typing alone was 884 → 581 MB:
mistyping a numeric-looking keyword (`kunta` = "740") both broke every `terms`
aggregation and cost 300 MB.

Two caveats on compression. Stored blocks tolerate it because they are fetched
whole; sorted columns are binary-searched by element index and need chunked
compression with a skip index to stay seekable (Lucene's shape). Bitmaps should
not be compressed with a general codec at all — that would forfeit the free
popcount — which is the argument for Roaring in §10.7.

**Query cost did not improve.** The 4x smaller artifact answers each chart with
exactly the same bytes, because the savings were in stored blocks and unused
fields that the queries never read. Size and bandwidth are separate problems,
and only the column encoding addresses the second.
