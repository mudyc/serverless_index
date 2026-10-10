#!/usr/bin/env node
import { Reader } from '../src/read/reader.js';

const path = new URL('../data/messages.l0', import.meta.url).pathname;
const reader = await new Reader(path).open();
const cat = reader.catalog;

console.log(`\nartifact  ${cat.index} v${cat.version} (${cat.contentHash})`);
console.log(`docs      ${cat.docCount}, clustered by ${cat.clustering.field} ${cat.clustering.direction}`);
console.log(`caps      ${cat.capabilities.join(', ')}`);
console.log(`fields    ${Object.keys(cat.fields).join(', ')}\n`);

const queries = {
  'all':                          { match_all: {} },
  'A  isRead=true':               { term: { isRead: true } },
  'A  delivered AND unread':      { bool: { filter: [{ term: { isDelivered: true } }, { term: { isRead: false } }] } },
  'A  bounced OR complaint':      { bool: { should: [{ term: { isBounced: true } }, { term: { isComplaint: true } }] } },
  "A' createdAt in June":         { range: { createdAt: { gte: Date.UTC(2026, 5, 1), lt: Date.UTC(2026, 6, 1) } } },
  'B  retryCount >= 3':           { range: { retryCount: { gte: 3 } } },
  'B  deliveredAt after Jun':     { range: { deliveredAt: { gte: Date.UTC(2026, 5, 1) } } },
  'B  sender = Kanto':            { term: { sender: 'Kanto' } },
  'B  sender prefix "Me"':        { prefix: { sender: 'Me' } },
  'C  subject *lasku*':           { wildcard: { subject: '*lasku*' } },
  'C  subject Muistutus*':        { wildcard: { subject: 'Muistutus*' } },
  'ABC combined':                 { bool: {
      filter: [{ term: { isDelivered: true } }, { range: { retryCount: { lte: 2 } } },
               { wildcard: { subject: '*maksusta*' } }],
      must_not: [{ term: { sender: 'Testaaja' } }] } },
};

console.log('query                           hits   rounds  reads    bytes');
console.log('─'.repeat(66));
for (const [label, query] of Object.entries(queries)) {
  reader.resetStats();
  const r = await reader.search({ query, size: 10 });
  const s = reader.stats;
  console.log(
    `${label.padEnd(30)} ${String(r.hits.total.value).padStart(5)} ` +
    `${String(s.rounds).padStart(7)} ${String(s.reads).padStart(6)} ${String(s.bytes).padStart(7)}`);
}

console.log('\ncursor pagination through "delivered AND unread":');
const q = { bool: { filter: [{ term: { isDelivered: true } }, { term: { isRead: false } }] } };
let cursor, page = 0, seen = 0;
for (;;) {
  reader.resetStats();
  const r = await reader.search({ query: q, size: 25, ...(cursor ? { search_after: cursor } : {}) });
  if (r.hits.hits.length === 0) break;
  seen += r.hits.hits.length; page++;
  if (page <= 2 || r.hits.hits.length < 25) {
    console.log(`  page ${String(page).padStart(2)}  ${r.hits.hits.length} hits  ` +
                `rounds=${reader.stats.rounds} bytes=${reader.stats.bytes}  first=${r.hits.hits[0]._id}`);
  } else if (page === 3) console.log('  …');
  cursor = r.hits.hits.at(-1).sort;
}
console.log(`  ${page} pages, ${seen} documents, constant cost per page\n`);
await reader.close();
