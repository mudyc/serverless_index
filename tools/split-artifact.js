#!/usr/bin/env node
/**
 * Split an L0 artifact into parts small enough for hosts with a per-file cap.
 *
 * GitHub blocks files over 100 MiB and warns over 50 MiB, so the default part is
 * 45 MiB: no warnings, no refusals. Nothing about the format changes — the parts
 * are a plain byte split, and `ChunkedHttpTransport` stitches them back while
 * serving ranges, so the reader never knows.
 *
 *   node tools/split-artifact.js data/mtk-map.l0 [partMiB]
 */
import { createReadStream, createWriteStream, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';

const src = process.argv[2];
if (!src) { console.error('usage: split-artifact.js <artifact.l0> [partMiB]'); process.exit(1); }
const part = Math.round((Number(process.argv[3]) || 45) * 1024 * 1024);
const size = statSync(src).size;
const parts = Math.ceil(size / part);

for (let i = 0; i < parts; i++) {
  const start = i * part, end = Math.min(start + part, size) - 1;
  const out = `${src}.${String(i).padStart(3, '0')}`;
  await pipeline(createReadStream(src, { start, end }), createWriteStream(out));
  process.stdout.write(`\r${i + 1}/${parts}`);
}

// The manifest is what the transport opens; it replaces the HEAD the single-file
// transport would have made, so the extra request costs nothing.
writeFileSync(`${src}.json`, JSON.stringify({
  name: basename(src), size, part, parts, format: 'l0-split-1',
}, null, 2) + '\n');
console.log(`\n${basename(src)}  ${(size / 1048576).toFixed(1)} MB -> ${parts} osaa à ${(part / 1048576).toFixed(0)} MiB`);
