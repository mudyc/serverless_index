/**
 * Hilbert curve index over a square grid. Spatially near features get near
 * indices, so clustering by it turns a bounding box into a handful of contiguous
 * position ranges — which is the one query shape this format answers fastest.
 */
export function xy2d(order, x, y) {
  const side = 1 << order;
  let rx, ry, d = 0;
  for (let s = side >> 1; s > 0; s >>= 1) {
    rx = (x & s) > 0 ? 1 : 0;
    ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      const t = x; x = y; y = t;
    }
  }
  return d;
}

/** Quantiser from a projected extent (metres) onto the curve's integer grid. */
export function gridder(order, { minx, miny, maxx, maxy }) {
  const side = (1 << order) - 1;
  const sx = side / (maxx - minx), sy = side / (maxy - miny);
  return (x, y) => xy2d(order,
    Math.max(0, Math.min(side, Math.round((x - minx) * sx))),
    Math.max(0, Math.min(side, Math.round((y - miny) * sy))));
}

/**
 * Decompose a grid-space box into contiguous Hilbert intervals.
 *
 * Descend the quadtree: a cell wholly inside the box is one interval, because a
 * quadrant at any level is contiguous on the curve; a cell wholly outside is
 * dropped; a straddling cell is split further until the budget runs out, after
 * which it is emitted whole and over-selects a little. The decomposition reads
 * no data — it is pure geometry, so the ranges are known before any fetch.
 */
export function boxRanges(order, bx0, by0, bx1, by1, budget = 128) {
  const side = 1 << order;
  let cells = [{ lvl: 0, cx: 0, cy: 0 }];
  const out = [];
  const emit = c => {
    const sz = side >> c.lvl, d = xy2d(order, c.cx * sz, c.cy * sz);
    const o = Math.floor(d / (sz * sz));
    out.push([o * sz * sz, (o + 1) * sz * sz - 1]);
  };
  while (cells.length) {
    const next = [];
    for (const c of cells) {
      const sz = side >> c.lvl;
      const x0 = c.cx * sz, y0 = c.cy * sz, x1 = x0 + sz - 1, y1 = y0 + sz - 1;
      if (x1 < bx0 || x0 > bx1 || y1 < by0 || y0 > by1) continue;
      if (x0 >= bx0 && x1 <= bx1 && y0 >= by0 && y1 <= by1) { emit(c); continue; }
      if (c.lvl >= order - 1) { emit(c); continue; }
      for (let i = 0; i < 4; i++)
        next.push({ lvl: c.lvl + 1, cx: c.cx * 2 + (i & 1), cy: c.cy * 2 + (i >> 1) });
    }
    if (out.length + next.length > budget && next.length) { next.forEach(emit); break; }
    cells = next;
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** Project a metre-space box onto the grid, clamped to the extent. */
export function boxToGrid(order, { minx, miny, maxx, maxy }, bbox) {
  const side = (1 << order) - 1;
  const sx = side / (maxx - minx), sy = side / (maxy - miny);
  const q = (v, lo, s) => Math.max(0, Math.min(side, Math.round((v - lo) * s)));
  return [q(bbox[0], minx, sx), q(bbox[1], miny, sy), q(bbox[2], minx, sx), q(bbox[3], miny, sy)];
}
