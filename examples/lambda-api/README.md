# Lambda API example

A search API over one S3 object. No cluster, no node, no provisioned capacity —
the Lambda reads byte ranges of an immutable artifact and answers.

```bash
aws s3 cp data/messages.l0 s3://$BUCKET/messages.l0
sam deploy --guided --parameter-overrides ArtifactBucket=$BUCKET

curl -s -XPOST "$URL/search" -d '{"query":{"term":{"sender":"Aatu"}},"size":3}'
```

Run it locally first — same handler, no deploy:

```bash
node tools/serve.js . 8080 &
node examples/lambda-api/local.js http://127.0.0.1:8080/data/messages.l0
```

```
200 {"query":{"term":{"sender":"Aatu"}},"size":3}      26ms  req=2 bytes=12132  usd=0.00000080  hits=1651
200 {"size":0,"aggs":{"s":{"terms":{"field":"sender"...  2ms  req=1 bytes=30000  usd=0.00000040  hits=20000
200 {"query":{"wildcard":{"subject":"*lasku*"}},...     10ms  req=5 bytes=600774 usd=0.00000200  hits=2567
200 {"query":{"range":{"retryCount":{"gte":3}}},...      3ms  req=2 bytes=135968 usd=0.00000080  hits=5772
400 {"size":0,"aggs":{"s":{"terms":{"field":"nonexi...   -     bad query: aggregation [s] unknown field [nonexistent]
```

## What the adapter adds

**A cached reader per container.** The catalog and every section already fetched
survive between invocations, so a warm Lambda answers a repeat facet query with
**no network at all**. An immutable artifact's sections can never be stale,
which is what makes this cache correct rather than merely fast.

**A budget, reset per invocation.** Per invocation, not per container — a
long-lived warm Lambda would otherwise refuse everything after a while. A
refusal comes back as **HTTP 400** with the offending field named, because the
client's query is at fault and is fixable. A surprise invoice is not.

**Cost headers on every response.** `x-l0-requests`, `x-l0-bytes`, `x-l0-rounds`
and `x-l0-usd`, so spend shows up in ordinary access logs rather than on the
bill.

**A 413 instead of a truncated body** when a response exceeds API Gateway's
limit, with the fix named (`size`/`from`, or narrow `_source`).

## Sizing

In-region reads make **bytes free**, so `requests` and dependent `rounds` are
the limits that matter:

```js
budget: { requests: 2048, bytes: 256e6, rounds: 8, usd: 0.001, host: 's3' }
```

512 MB of memory is generous for a 50 MB artifact and buys proportionally more
CPU, which shortens the cold start. Figure 400–600 ms cold against S3, and a
fraction of that warm. Lambda itself costs about **$0.00000083** per invocation —
a fifth of one query's S3 GETs.
