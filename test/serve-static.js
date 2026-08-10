'use strict';
// Tiny static server that mimics GitHub Pages: serves web/ under a repo subpath
// (http://localhost:8080/hguard/) with correct MIME types and 404s
// everywhere else (no API, no WebSocket — exactly like real Pages).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.join(__dirname, '..', 'web');
const PREFIX = '/hguard';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '': 'application/octet-stream',
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let p = decodeURIComponent(url.pathname);
  if (p === PREFIX || p === PREFIX + '/') p = PREFIX + '/index.html';
  if (!p.startsWith(PREFIX + '/')) { res.writeHead(404); res.end('not found'); return; }
  const rel = p.slice(PREFIX.length + 1);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '0.0.0.0', () => console.log(`static (Pages-like) server on http://localhost:${PORT}${PREFIX}/`));
