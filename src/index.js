/**
 * Core entry point — runtime-neutral.
 *
 * Nothing reachable from here imports `node:fs` or touches `fetch`, so this
 * module bundles for a browser unchanged. The I/O lives behind the transport
 * interface (`open`, `readRange`, `readWave`, `readTail`, `reset`); pick one
 * from `serverless-index/node` or `serverless-index/browser`, or write your own.
 */
export { Reader } from './read/reader.js';
export { L0Client } from './client.js';
export { Bitmap } from './bitmap.js';
export { compile, QueryError } from './query/compile.js';
export { Budget, BudgetExceeded, estimate, coalesce, priceOf, HOSTS } from './cost.js';
// The spatial clustering key: a bbox becomes a handful of contiguous key
// intervals, which is why a map view is a few range GETs rather than a scan.
export { xy2d, gridder, boxRanges, boxToGrid } from './hilbert.js';
export { encodeParts, decodeParts, DEFAULT_GRID } from './geom.js';
