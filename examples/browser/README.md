# Browser example

Query an index directly from a web page. No server, no API, no build step — the
page imports `src/browser.js` as an ES module and fetches byte ranges of one
immutable file.

```bash
node tools/gen-data.js 20000      # -> data/docs.json
node tools/build-index.js         # -> data/messages.l0  (4.6 MB, 20 000 docs)
node tools/serve.js . 8080        # any host that honours Range will do
open http://127.0.0.1:8080/examples/browser/
```

`tools/serve.js` is a plain static server; nothing in it knows about the index.
That is the point — S3, CloudFront and GitHub Pages all work unchanged.

## What to look at

Each query prints its **rounds, requests, bytes and cost** under the editor.
Measured on this artifact over local HTTP:

| preset | hits | rounds | requests | bytes |
|---|--:|--:|--:|--:|
| term — one keyword | 1 651 | 2 | 2 | 12 kB |
| bool — must + must_not | 13 322 | 2 | 2 | 20 kB |
| range — clustering key | 7 884 | 2 | 2 | 60 kB |
| terms aggregation | 20 000 | 1 | 1 | 30 kB |
| histogram + terms sub-agg | 20 000 | 1 | 1 | 160 kB |
| wildcard on text | 2 567 | 1 | 4 | 590 kB |

Three things worth doing:

1. **Run the same query twice.** The second run costs nothing. Sections of an
   immutable artifact can never be stale, so they are cached outright — this is
   why faceted redraws are free after the first load.
2. **Set the request limit to 1 and run the aggregation.** It is refused before
   any byte is fetched, and the message names the field responsible. See
   [../../docs/billing.md](../../docs/billing.md).
3. **Switch the histogram's `interval` to `'year'`.** It is refused too: `'year'`
   means "this key is a `YYYYMMDD` integer", and this corpus stores epoch
   milliseconds. Returning nonsense buckets would have been the easier option.

## Buffer

The reader was written against Node's `Buffer`. An audit found twelve methods
and one `node:` import — and that import is the file transport the browser
replaces anyway — so `src/buffer-shim.js` is smaller than a port would be, and
**the same reader code runs in both places**. Importing `src/browser.js`
installs it; there is nothing to configure.
