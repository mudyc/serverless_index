/**
 * A search API on one S3 object. No cluster, no node, no provisioned anything.
 *
 * The reader is container-scoped, so a warm invocation reuses the catalog and
 * every section it has already fetched — a repeat facet query answers with no
 * network at all. Sections of an immutable artifact can never be stale, which
 * is what makes that cache safe rather than merely fast.
 */
import { createHandler } from 'serverless-index/lambda';

const BUCKET = process.env.ARTIFACT_BUCKET;
const KEY = process.env.ARTIFACT_KEY ?? 'messages.l0';
const REGION = process.env.AWS_REGION ?? 'eu-north-1';

export const handler = createHandler({
  url: `https://${BUCKET}.s3.${REGION}.amazonaws.com/${KEY}`,

  // Refused BEFORE any byte is fetched, and returned as HTTP 400 with the
  // field responsible named. In-region bytes are free, so `requests` and
  // `rounds` are the limits that matter; `usd` is a belt-and-braces ceiling.
  budget: { requests: 2048, bytes: 256e6, rounds: 8, usd: 0.001, host: 's3' },

  // 48 parallel ranges per wave. Coalescing kicks in above this, which is what
  // keeps a high-cardinality terms aggregation from becoming 50 000 GETs.
  maxParallel: 48,
  coalesceGap: 65536,
});
