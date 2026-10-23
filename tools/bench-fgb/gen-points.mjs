// Deterministic synthetic point set over Finland's EPSG:3067 box: 70 % in
// Zipf-weighted city clusters, 30 % spread uniformly. Shared by both formats.
import { writeFileSync } from 'node:fs';
const N = Number(process.argv[2] ?? 1000000);
const out = process.argv[3];
let seed = 12345;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const EXT = { minx: 50000, miny: 6570000, maxx: 760000, maxy: 7800000 };
const cities = Array.from({ length: 30 }, (_, i) => ({
  x: 200000 + rnd() * 400000, y: 6650000 + rnd() * (i < 20 ? 500000 : 1000000),
  s: 3000 + rnd() * 12000, w: 1 / (i + 1) }));
const W = cities.reduce((a, c) => a + c.w, 0);
const CLASSES = Array.from({ length: 12 }, (_, i) => `k${i}`);
const cw = CLASSES.map((_, i) => 1 / (i + 1) ** 1.5), CW = cw.reduce((a, b) => a + b, 0);
const pickClass = () => { let r = rnd() * CW; for (let i = 0; i < cw.length; i++) { r -= cw[i]; if (r <= 0) return CLASSES[i]; } return CLASSES.at(-1); };
const pts = [];
for (let i = 0; i < N; i++) {
  let x, y;
  if (rnd() < 0.7) {
    let r = rnd() * W, c = cities[0];
    for (const k of cities) { r -= k.w; if (r <= 0) { c = k; break; } }
    x = c.x + gauss() * c.s; y = c.y + gauss() * c.s;
  } else { x = EXT.minx + rnd() * (EXT.maxx - EXT.minx); y = EXT.miny + rnd() * (EXT.maxy - EXT.miny); }
  x = Math.min(EXT.maxx, Math.max(EXT.minx, Math.round(x))); y = Math.min(EXT.maxy, Math.max(EXT.miny, Math.round(y)));
  pts.push({ id: `p${String(i).padStart(7, '0')}`, x, y, luokka: pickClass(),
             vuosi: 1950 + Math.floor(rnd() * 77), nimi: `Kohde ${Math.floor(rnd() * 1e6)}` });
}
writeFileSync(out, JSON.stringify({ extent: EXT, cities: cities.slice(0, 3), pts }));
console.log(`wrote ${N} points; densest city at ${Math.round(cities[0].x)}, ${Math.round(cities[0].y)}`);
