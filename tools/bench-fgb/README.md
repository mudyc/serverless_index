# L0 vs FlatGeobuf

Same data, same boxes, same simulated network (30 ms per request, 100 MB/s per
connection) for both formats. Results and conclusions: `docs/vertailu-flatgeobuf.md`.

```bash
D=/tmp/fgb-bench && mkdir -p $D
node gen-points.mjs 1000000 $D/pts.json
node gen-poly.mjs   1000000 $D/poly.json

# L0 (from this directory)
node --max-old-space-size=8000  l0-points.mjs $D 30
CLASSED=1 node --max-old-space-size=12000 l0-poly.mjs $D 30     # CLASSED=0 for Hilbert only

# FlatGeobuf: its own HttpReader, run with bun from a source checkout
git clone https://github.com/flatgeobuf/flatgeobuf && (cd flatgeobuf && npm install)
FGB_SRC=$PWD/flatgeobuf/src/ts bun run fgb.ts $D 30 points
FGB_SRC=$PWD/flatgeobuf/src/ts CLASSED=1 bun run fgb.ts $D 30 poly
```

The FlatGeobuf JS writer writes no spatial index, so `fgb.ts` serialises the
features with the library and builds the packed Hilbert R-tree (node size 16)
itself, following the spec. Every query's result count is checked against brute
force in both formats; a mismatch aborts the run.
