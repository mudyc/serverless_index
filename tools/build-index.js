#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { build } from '../src/build/builder.js';
import { mkdirSync } from 'node:fs';

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const docs = JSON.parse(await readFile(new URL('../data/docs.json', import.meta.url), 'utf8'));
const outPath = new URL('../data/messages.l0', import.meta.url).pathname;
const { catalog, bytes } = await build({ docs, index: 'messages', outPath });

console.log(`built ${outPath}`);
console.log(`  documents : ${catalog.docCount}`);
console.log(`  artifact  : ${bytes} bytes (${(bytes / catalog.docCount).toFixed(1)} B/doc)`);
console.log(`  sections  : ${Object.keys(catalog.sections).length}`);
console.log(`  blocks    : ${catalog.stored.blocks.length} × ${catalog.stored.blockSize} docs`);
console.log(`  version   : ${catalog.version} (${catalog.contentHash})`);
const bmBytes = Object.values(catalog.sections).reduce((a, s) => a + s.length, 0);
console.log(`  bitmaps   : ${bmBytes} bytes total = ${(bmBytes / bytes * 100).toFixed(1)}% of artifact`);
