#!/usr/bin/env node
/**
 * Deterministic test corpus.
 *   Stage A   boolean fields
 *   Stage A'  clustering key (createdAt)
 *   Stage B   integer (retryCount), date (deliveredAt), keyword (sender)
 *   Stage C   text (subject)
 * Some fields are deliberately absent on some documents so that `exists`,
 * boolean-false and null semantics are actually exercised.
 */
import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOOLS = [
  ['isDelivered', 0.72], ['isRead', 0.45], ['hasAttachment', 0.30],
  ['isSecure', 0.18], ['isTest', 0.08], ['isBounced', 0.06], ['isComplaint', 0.02],
];
const OPTIONAL_BOOLS = new Set(['isComplaint', 'isSecure']);

const SENDERS = ['Metsakeskus', 'Aatu', 'Riihi', 'Sermi', 'Mie', 'Ite',
                 'Jarvikyla', 'Testaaja', 'VPsender', '50102', '70203', 'Aakkonen'];
const SUBJ_A = ['Lasku', 'Muistutus', 'Ilmoitus', 'Paatos', 'Kutsu', 'Vahvistus', 'Tiedote', 'Kysely'];
const SUBJ_B = ['metsanhoidosta', 'maksusta', 'kayntikerrasta', 'sopimuksesta',
                'hakkuusta', 'taimikosta', 'kiinteistosta', 'tilauksesta'];
const SUBJ_C = ['2026', 'kevat', 'syksy', 'Q1', 'Q2', 'uusi', 'korjattu', ''];

export function generate({ count = 1500, seed = 42 } = {}) {
  const rnd = mulberry32(seed);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const base = Date.UTC(2026, 0, 1);
  const docs = [];
  for (let i = 0; i < count; i++) {
    const createdAt = base + Math.floor(rnd() * 240 * 24 * 3600 * 1000);
    const doc = { id: `msg-${String(i).padStart(5, '0')}`, createdAt };
    for (const [f, p] of BOOLS) {
      if (OPTIONAL_BOOLS.has(f) && rnd() < 0.25) continue;
      doc[f] = rnd() < p;
    }
    doc.retryCount = Math.floor(rnd() ** 2 * 6);                 // 0..5, skewed low
    if (rnd() < 0.8) doc.deliveredAt = createdAt + Math.floor(rnd() * 72 * 3600 * 1000);
    doc.sender = pick(SENDERS);
    doc.subject = [pick(SUBJ_A), pick(SUBJ_B), pick(SUBJ_C)].filter(Boolean).join(' ');
    docs.push(doc);
  }
  return docs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
  const docs = generate({ count: Number(process.argv[2] ?? 1500) });
  await writeFile(new URL('../data/docs.json', import.meta.url), JSON.stringify(docs));
  console.log(`generated ${docs.length} documents -> data/docs.json`);
  console.log('  sample:', JSON.stringify(docs[0]));
}
