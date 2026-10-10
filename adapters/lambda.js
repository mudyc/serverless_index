/**
 * AWS Lambda adapter.
 *
 * The reader is built once per container and reused: the catalog and every
 * section it has already seen survive between invocations, so a warm Lambda
 * answers a repeat facet query with no network at all. That is the whole point
 * of an immutable artifact — a cached section can never be stale.
 *
 * Usage:
 *   import { createHandler } from 'serverless-index/lambda';
 *   export const handler = createHandler({
 *     url: `https://${process.env.BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/idx.l0`,
 *     budget: { requests: 2048, bytes: 256e6, usd: 0.001, host: 's3' },
 *   });
 */
import { Reader } from '../src/read/reader.js';
import { HttpTransport } from '../src/transport/http.js';
import { ChunkedHttpTransport } from '../src/transport/chunked-http.js';
import { BudgetExceeded } from '../src/cost.js';
import { QueryError } from '../src/query/compile.js';

/** Container-scoped, so a warm invocation skips the catalog fetch entirely. */
const readers = new Map();

export async function getReader(url, opts = {}) {
  if (!readers.has(url)) {
    const T = url.endsWith('.json') ? ChunkedHttpTransport : HttpTransport;
    const { coalesceGap = 65536, maxParallel = 48, budget, ...rest } = opts;
    const transport = new T(url, { coalesceGap, maxParallel });
    readers.set(url, new Reader(transport, { budget, ...rest }).open());
  }
  return readers.get(url);
}

export function createHandler({ url, budget = { requests: 2048, bytes: 256e6, host: 's3' },
                                maxBodyBytes = 5 * 1024 * 1024, ...opts } = {}) {
  if (!url) throw new Error('createHandler needs a url');
  return async function handler(event) {
    const t0 = Date.now();
    try {
      const body = typeof event?.body === 'string'
        ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body)
        : (event?.body ?? event ?? {});
      const reader = await getReader(url, { budget, ...opts });
      // Each invocation gets its own allowance; the spend is per request, not
      // per container, or a long-lived warm Lambda would refuse everything.
      reader.budget?.reset();
      const res = await reader.search(body);
      const out = JSON.stringify(res);
      if (out.length > maxBodyBytes)
        return json(413, { error: 'response too large',
                           hint: 'use `size`/`from` to page, or `_source` to narrow the stored fields',
                           bytes: out.length, limit: maxBodyBytes });
      return { statusCode: 200, headers: head(reader, t0), body: out };
    } catch (e) {
      // A budget refusal is the client's fault and is actionable, so it comes
      // back as 400 with the diagnosis — not as a 500 and a surprise invoice.
      if (e instanceof BudgetExceeded)
        return json(400, { error: 'budget exceeded', message: e.message, ...e.detail });
      if (e instanceof QueryError || e?.name === 'QueryError')
        return json(400, { error: 'bad query', message: e.message });
      return json(500, { error: 'internal', message: String(e?.message ?? e) });
    }
  };

  function head(reader, t0) {
    const s = reader.budget?.spent;
    return { 'content-type': 'application/json',
             'x-l0-ms': String(Date.now() - t0),
             ...(s ? { 'x-l0-requests': String(s.requests), 'x-l0-bytes': String(s.bytes),
                       'x-l0-rounds': String(s.rounds), 'x-l0-usd': s.usd.toFixed(8) } : {}) };
  }
  function json(statusCode, o) {
    return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) };
  }
}
