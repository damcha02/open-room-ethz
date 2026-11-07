import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import handler from './api/allocations.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const port = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/allocations') {
    req.query = Object.fromEntries(url.searchParams);
    return handler(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405);return res.end();}
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  let safe;
  try { safe = decodeURIComponent(requested); } catch {res.writeHead(400);return res.end();}
  const file = path.resolve(root, '.' + safe);
  if (!file.startsWith(root + path.sep)) {res.writeHead(403);return res.end();}
  try {
    const data = await fs.readFile(file);
    const headers = {'Content-Type':types[path.extname(file)] || 'application/octet-stream', 'Cache-Control':file.endsWith('sw.js')?'no-cache':'no-cache', 'X-Content-Type-Options':'nosniff'};
    res.writeHead(200,headers); res.end(req.method==='HEAD'?'':data);
  } catch {res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');}
}).listen(port, () => console.log(`ETH Room Finder at http://localhost:${port}`));
