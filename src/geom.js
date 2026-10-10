/**
 * Geometry codec: quantise to a grid, delta against the previous vertex, zigzag
 * varint. Measured on MML 1:250 000: 16 B/point as float64 becomes 2.71 B/point,
 * a 5.9x reduction with nothing visible lost — at that scale one map millimetre
 * is 250 metres of ground, so sub-metre precision is noise.
 *
 * The output stays byte-addressable, which an entropy coder would destroy: the
 * whole point is fetching exactly the bytes a viewport needs, and you cannot
 * seek into the middle of a deflate stream.
 */

/** Grid in source units. MML ships EPSG:3067, i.e. metres, so 1 = one metre. */
export const DEFAULT_GRID = 1;

export function encodeParts(parts, grid = DEFAULT_GRID) {
  const out = [];
  const put = n => { let z = ((n << 1) ^ (n >> 31)) >>> 0;
    while (z > 0x7f) { out.push((z & 0x7f) | 0x80); z >>>= 7; } out.push(z); };
  put(parts.length);
  for (const ring of parts) {
    put(ring.length);
    let px = 0, py = 0;                      // delta runs per ring, not per feature
    for (const [x, y] of ring) {
      const qx = Math.round(x / grid), qy = Math.round(y / grid);
      put(qx - px); put(qy - py);
      px = qx; py = qy;
    }
  }
  return Buffer.from(out);
}

export function decodeParts(buf, grid = DEFAULT_GRID) {
  let o = 0;
  const get = () => { let z = 0, s = 0, b;
    do { b = buf[o++]; z |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    z >>>= 0; return (z >>> 1) ^ -(z & 1); };
  const nParts = get(), parts = [];
  for (let p = 0; p < nParts; p++) {
    const n = get(), ring = [];
    let px = 0, py = 0;
    for (let i = 0; i < n; i++) {
      px += get(); py += get();
      ring.push([px * grid, py * grid]);
    }
    parts.push(ring);
  }
  return parts;
}
