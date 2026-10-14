// Minimal static file server for local testing.  node serve.js [port]
const http = require('http');
const fs = require('fs');
const { createHash } = require('crypto');
const { extname, join, normalize } = require('path');

const root = __dirname;
const port = parseInt(process.argv[2] || '8123', 10);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bin': 'application/octet-stream',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
};

// Source files change while you work, so they must be revalidated. Vendored
// assets - textures, models, Three.js - never change without a git commit, so
// they are allowed to sit in the browser's disk cache indefinitely.
//
// This matters more than it looks: the scenery models are ~3.8 MB of .bin and
// texture set, and re-fetching all of it on every refresh is both slow and, if a
// download manager is watching, a pile of junk files in Downloads. The previous
// version sent `Cache-Control: no-store` on every response, which guaranteed a
// full re-download every single load.
const IMMUTABLE = /\.(jpg|jpeg|png|bin|gltf|glb|webp|ktx2|hdr)$/i;
const REVALIDATE = 'no-cache';          // may be stored, must be revalidated
const IMMUTABLE_MAX_AGE = '365d';      // stored, never revalidated

const etagCache = new Map();            // path -> { etag, mtimeMs, size }

function etagFor(file, stat, data) {
  const key = file;
  const hit = etagCache.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.etag;
  // Weak-ish: content hash. Cheap enough for a dev server and correct.
  const etag = '"' + createHash('sha1').update(data).digest('hex').slice(0, 20) + '"';
  etagCache.set(key, { etag, mtimeMs: stat.mtimeMs, size: stat.size });
  return etag;
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('not found'); return; }
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('not found'); return; }
      const etag = etagFor(file, stat, data);
      const immutable = IMMUTABLE.test(file);

      const headers = {
        'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': immutable ? `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`
          : REVALIDATE,
        ETag: etag,
        'Last-Modified': stat.mtime.toUTCString(),
      };

      // Conditional request: the browser already has this exact copy.
      const inm = req.headers['if-none-match'];
      if (inm && inm.split(',').some((t) => t.trim() === etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      headers['Content-Length'] = data.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}).listen(port, () => console.log(`fpv-lab on http://localhost:${port}`));