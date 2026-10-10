#!/usr/bin/env node
/**
 * Run the same handler locally against a file:// or http:// artifact, so the
 * budget and the response shape can be exercised without deploying anything.
 *
 *   node tools/serve.js . 8080 &
 *   node examples/lambda-api/local.js http://127.0.0.1:8080/data/messages.l0
 */
import { createHandler } from '../../adapters/lambda.js';

const url = process.argv[2] ?? 'http://127.0.0.1:8080/data/messages.l0';
const handler = createHandler({
  url,
  budget: { requests: 2048, bytes: 256e6, rounds: 8, usd: 0.001, host: 's3' },
});

const QUERIES = [
  { query: { term: { sender: 'Aatu' } }, size: 3 },
  { size: 0, aggs: { s: { terms: { field: 'sender', size: 20 } } } },
  { query: { wildcard: { subject: '*lasku*' } }, size: 2 },
  { query: { range: { retryCount: { gte: 3 } } }, size: 2 },
  { size: 0, aggs: { s: { terms: { field: 'nonexistent' } } } },   // -> 400
];

for (const body of QUERIES) {
  const res = await handler({ body: JSON.stringify(body) });
  const j = JSON.parse(res.body);
  const label = JSON.stringify(body).slice(0, 56).padEnd(58);
  console.log(`${res.statusCode} ${label} ` +
    `${res.headers['x-l0-ms'] ?? '-'}ms  ` +
    `req=${res.headers['x-l0-requests'] ?? '-'} ` +
    `bytes=${res.headers['x-l0-bytes'] ?? '-'} ` +
    `usd=${res.headers['x-l0-usd'] ?? '-'}  ` +
    (res.statusCode === 200 ? `hits=${j.hits.total.value}` : `${j.error}: ${j.message}`));
}
