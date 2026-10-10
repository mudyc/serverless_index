#!/usr/bin/env node
/**
 * Static file server that honours Range. Nothing here knows about the index —
 * that is the point: the artifact is a file, and any host that serves bytes by
 * range is enough to query it.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const ROOT = process.argv[2] ?? process.cwd();
const PORT = Number(process.argv[3] ?? 8300);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.l0': 'application/octet-stream' };

createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const path = join(ROOT, normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, ''));
  if (!existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404).end('not found'); return; }
  const { size } = statSync(path);
  const type = TYPES[extname(path)] ?? 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes',
                 'Access-Control-Allow-Origin': '*',
                 'Access-Control-Expose-Headers': 'Content-Range, Content-Length' };
  if (req.method === 'HEAD') { res.writeHead(200, { ...base, 'Content-Length': size }).end(); return; }

  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!m) { res.writeHead(200, { ...base, 'Content-Length': size }); createReadStream(path).pipe(res); return; }
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === '' ? size - 1 : (m[2] === '' ? size - 1 : Number(m[2]));
  start = Math.max(0, start); end = Math.min(size - 1, end);
  if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
  res.writeHead(206, { ...base, 'Content-Length': end - start + 1,
                       'Content-Range': `bytes ${start}-${end}/${size}` });
  createReadStream(path, { start, end }).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}  <- ${ROOT}`));
