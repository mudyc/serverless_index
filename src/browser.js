/**
 * Browser entry point: HTTP Range transports plus a one-call opener.
 *
 * Any static host that answers `Range:` works — S3, CloudFront, GitHub Pages.
 * `coalesceGap` defaults to 64 kB here because that single parameter is the
 * difference between nine requests and a hundred and ninety thousand; see
 * `docs/billing.md`.
 */
// The reader was written against Node's Buffer. An audit found twelve methods
// and one `node:` import — and that import is the file transport the browser
// replaces anyway — so a shim is smaller than a port, and the SAME reader code
// runs in both places. A second implementation is a second thing that can
// disagree. Installing it at module scope means importing this file is enough.
import { installBuffer } from './buffer-shim.js';
installBuffer();

export * from './index.js';
export { installBuffer, Buf } from './buffer-shim.js';
export { HttpTransport } from './transport/http.js';
export { ChunkedHttpTransport } from './transport/chunked-http.js';

import { Reader } from './read/reader.js';
import { HttpTransport } from './transport/http.js';
import { ChunkedHttpTransport } from './transport/chunked-http.js';

/**
 * Open an artifact over HTTP. A `.json` url is read as a split manifest (for
 * hosts with a per-file size cap); anything else is a single object.
 */
export async function open(url, { budget = { requests: 4096, bytes: 512e6, host: 'pages' },
                                  coalesceGap = 65536, maxParallel = 24, ...opts } = {}) {
  const T = url.endsWith('.json') ? ChunkedHttpTransport : HttpTransport;
  const transport = new T(url, { coalesceGap, maxParallel });
  return new Reader(transport, { budget, ...opts }).open();
}
