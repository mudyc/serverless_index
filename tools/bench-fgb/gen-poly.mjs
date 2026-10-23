// Polygons over the same box: 84 % small (buildings), 15 % medium (fields, yards),
// 1 % large (lakes, districts up to ~30 km). Centres follow the point generator.
import { writeFileSync } from 'node:fs';
const N = Number(process.argv[2] ?? 1000000), out = process.argv[3];
let seed = 12345;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const E = { minx: 50000, miny: 6570000, maxx: 760000, maxy: 7800000 };
const cities = Array.from({ length: 30 }, (_, i) => ({ x: 200000 + rnd() * 400000,
  y: 6650000 + rnd() * (i < 20 ? 500000 : 1000000), s: 3000 + rnd() * 12000, w: 1 / (i + 1) }));
const W = cities.reduce((a, c) => a + c.w, 0);
const CL = Array.from({ length: 12 }, (_, i) => `k${i}`), cw = CL.map((_, i) => 1 / (i + 1) ** 1.5), CW = cw.reduce((a, b) => a + b);
const cls = () => { let r = rnd() * CW; for (let i = 0; i < 12; i++) { r -= cw[i]; if (r <= 0) return CL[i]; } return 'k11'; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const feats = [];
for (let i = 0; i < N; i++) {
  let x, y;
  if (rnd() < 0.7) { let r = rnd() * W, c = cities[0]; for (const k of cities) { r -= k.w; if (r <= 0) { c = k; break; } }
    x = c.x + gauss() * c.s; y = c.y + gauss() * c.s; }
  else { x = E.minx + rnd() * (E.maxx - E.minx); y = E.miny + rnd() * (E.maxy - E.miny); }
  const u = rnd();
  const r = u < 0.84 ? 5 + rnd() * 25 : u < 0.99 ? 50 + rnd() * 450 : 2000 + rnd() ** 2 * 28000;
  const k = 8, ring = [];
  for (let j = 0; j < k; j++) { const a = 2 * Math.PI * j / k, rr = r * (0.6 + 0.4 * rnd());
    ring.push([Math.round(clamp(x + rr * Math.cos(a), E.minx, E.maxx)), Math.round(clamp(y + rr * Math.sin(a), E.miny, E.maxy))]); }
  ring.push(ring[0]);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [px, py] of ring) { bx0 = Math.min(bx0, px); by0 = Math.min(by0, py); bx1 = Math.max(bx1, px); by1 = Math.max(by1, py); }
  feats.push({ id: `a${String(i).padStart(7, '0')}`, ring, bbox: [bx0, by0, bx1, by1],
               luokka: cls(), vuosi: 1950 + Math.floor(rnd() * 77), nimi: `Kohde ${Math.floor(rnd() * 1e6)}` });
}
writeFileSync(out, JSON.stringify({ extent: E, feats }));
console.log(`wrote ${N} polygons`);
