# Vertailut

Mittausskriptit dokumenttiin `docs/vertailut.md` (yhteenveto) ja
`docs/vertailu-flatgeobuf.md` (FlatGeobuf yksityiskohtaisesti). Sama aineisto,
samat näkymät ja sama simuloitu verkko (30 ms per pyyntö, 100 MB/s per yhteys)
kaikille. Jokaisen haun tulosmäärä tarkistetaan raa'alla läpikäynnillä; ero
keskeyttää ajon.

```bash
D=/tmp/vertailut && mkdir -p $D
node gen-points.mjs 1000000 $D/pts.json
node gen-poly.mjs   1000000 $D/poly.json

# L0, luku
node --max-old-space-size=10000 l0-points.mjs $D 30
CLASSED=1 node --max-old-space-size=12000 l0-poly.mjs $D 30     # CLASSED=0: pelkkä Hilbert

# L0 + L1, kirjoitukset (ajetaan l0-poly.mjs:n artefaktia vastaan)
node --max-old-space-size=14000 l1-write.mjs $D 30

# FlatGeobuf: kirjaston oma HttpReader, ajetaan bunilla lähdekoodista
git clone https://github.com/flatgeobuf/flatgeobuf && (cd flatgeobuf && npm install)
FGB_SRC=$PWD/flatgeobuf/src/ts bun run fgb.ts $D 30 points
FGB_SRC=$PWD/flatgeobuf/src/ts CLASSED=1 bun run fgb.ts $D 30 poly

# RBush (devDependency: npm install)
node --expose-gc --max-old-space-size=12000 rbush.mjs $D
```

FlatGeobufin JS-kirjoittaja ei tee spatiaalista indeksiä, joten `fgb.ts`
serialisoi kohteet kirjastolla ja rakentaa pakatun Hilbert-R-puun (solmukoko 16)
spesifikaation mukaan.
