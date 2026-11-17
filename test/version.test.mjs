import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {computeVersion, precacheList, render, check, GENERATED} from '../scripts/stamp-version.mjs';

const publicDir = new URL('../public/', import.meta.url).pathname;
const read = f => fs.readFileSync(path.join(publicDir, f), 'utf8');
function copyPublic() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openroom-ver-'));
  fs.cpSync(publicDir, dir, {recursive: true});
  return dir;
}

// ---------------------------------------------------------------- the version identifier
test('version: deterministic and reproducible', () => {
  const dir = copyPublic();
  assert.equal(computeVersion(dir), computeVersion(publicDir));
  assert.match(computeVersion(dir), /^[0-9a-f]{12}$/);
  assert.deepEqual(render(dir), render(publicDir));
  fs.rmSync(dir, {recursive: true});
});
test('version: EVERY shipped file changes it (this is what makes each deployment detectable)', () => {
  const dir = copyPublic();
  const base = computeVersion(dir);
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, {withFileTypes: true})) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); })(dir);
  const shipped = files.filter(f => !['version.json', 'sw-version.js', '_headers'].includes(path.basename(f)));
  assert.ok(shipped.length >= 20);
  for (const f of shipped) {
    const original = fs.readFileSync(f);
    fs.appendFileSync(f, Buffer.from('\n'));
    assert.notEqual(computeVersion(dir), base, `${path.relative(dir, f)} must change the version`);
    fs.writeFileSync(f, original);
  }
  assert.equal(computeVersion(dir), base);
  fs.writeFileSync(path.join(dir, 'new-file.txt'), 'x');
  assert.notEqual(computeVersion(dir), base, 'a new file changes it');
  fs.rmSync(path.join(dir, 'new-file.txt'));
  fs.renameSync(path.join(dir, 'rooms.json'), path.join(dir, 'rooms2.json'));
  assert.notEqual(computeVersion(dir), base, 'a rename changes it');
  fs.rmSync(dir, {recursive: true});
});
test('version: the generated files and _headers do not feed the hash (so stamping is stable)', () => {
  const dir = copyPublic();
  const base = computeVersion(dir);
  for (const f of [...GENERATED, '_headers']) fs.appendFileSync(path.join(dir, f), '\n// x');
  assert.equal(computeVersion(dir), base);
  fs.rmSync(dir, {recursive: true});
});
test('version: the committed version files match the current sources (run `npm run stamp` after any change to public/)', () => {
  assert.deepEqual(check(publicDir), [], 'version.json / sw-version.js are stale: run npm run stamp and commit');
  const version = JSON.parse(read('version.json')).version;
  assert.match(read('sw-version.js'), new RegExp(`self.OPENROOM_VERSION = "${version}"`));
  assert.equal(version, computeVersion(publicDir));
});
test('version: sw.js changes with it, because it imports the generated file (a byte-identical sw.js alone would miss updates)', () => {
  assert.match(read('sw.js'), /importScripts\('\/sw-version\.js'\)/);
  assert.match(read('index.html'), /<script src="\/sw-version\.js"><\/script>/, 'the page reads the same version file');
});

// ---------------------------------------------------------------- the precache list
test('precache list: complete, no generated or never-cached files, every imported module included', () => {
  const list = precacheList(publicDir);
  assert.equal(list[0], '/');
  for (const f of list.slice(1)) assert.ok(fs.existsSync(path.join(publicDir, f.slice(1))), `${f} exists`);
  for (const never of ['/version.json', '/sw.js', '/_headers', '/404.html', '/index.html']) assert.ok(!list.includes(never), `${never} is never precached`);
  for (const must of ['/', '/app.js', '/styles.css', '/sw-version.js', '/rooms.json', '/room-metadata.json', '/manifest.webmanifest', '/icons/apple-touch-icon.png', '/icons/icon-maskable-512.png']) assert.ok(list.includes(must), must);
  const sources = ['app.js', 'recommend.mjs', 'timeline.mjs', 'detail-view.mjs', 'schedule.mjs', 'metadata.mjs', 'update.mjs', 'pull-refresh.mjs'].filter(f => fs.existsSync(path.join(publicDir, f)));
  for (const f of sources) for (const m of read(f).matchAll(/from '\.\/([a-z-]+\.mjs)'/g)) assert.ok(list.includes(`/${m[1]}`), `${f} imports ${m[1]}`);
  const html = read('index.html');
  for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)) assert.ok(list.includes(m[1]) || m[1] === '/', `index.html references ${m[1]}`);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const i of manifest.icons) assert.ok(list.includes(i.src), i.src);
  assert.equal(new Set(list).size, list.length);
});

// ---------------------------------------------------------------- sw.js behaviour in a simulated worker
function runWorker({files, fetchImpl, existingCaches = {}}) {
  const handlers = {};
  const stores = new Map(Object.entries(existingCaches).map(([n, entries]) => [n, new Map(Object.entries(entries))]));
  const calls = {skipWaiting: 0, claim: 0, fetches: [], deleted: []};
  const cacheApi = {
    async open(name) { if (!stores.has(name)) stores.set(name, new Map()); const s = stores.get(name); return {
      async put(req, res) { s.set(typeof req === 'string' ? req : new URL(req.url).pathname, res.clone()); },
      async match(req) { const k = typeof req === 'string' ? req : new URL(req.url).pathname; return s.get(k)?.clone(); } }; },
    async keys() { return [...stores.keys()]; },
    async delete(name) { calls.deleted.push(name); return stores.delete(name); }
  };
  const selfObj = {
    location: {origin: 'https://app.example'}, clients: {claim: async () => { calls.claim++; }}, skipWaiting: () => { calls.skipWaiting++; },
    addEventListener: (type, fn) => { handlers[type] = fn; }
  };
  const ResolvingRequest = class extends Request { constructor(u, i) { super(typeof u === 'string' ? new URL(u, 'https://app.example').href : u, i); } };
  const basic = r => (Object.defineProperty(r, 'type', {value: 'basic'}), r);
  const sandbox = {self: selfObj, caches: cacheApi, URL, Request: ResolvingRequest, Response, importScripts: p => vm.runInContext(fs.readFileSync(path.join(publicDir, p), 'utf8'), ctx),
    fetch: async (req) => { const url = typeof req === 'string' ? req : req.url; calls.fetches.push({url, cache: req.cache}); return basic(await fetchImpl(new URL(url, 'https://app.example').pathname, req)); }};
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8'), ctx);
  const lifecycle = async (type) => { let p; handlers[type]({waitUntil: x => { p = x; }}); await p; };
  const fetchEvent = (pathname, {mode = 'cors', method = 'GET', origin = 'https://app.example'} = {}) => {
    let responded; const e = {request: {url: `${origin}${pathname}`, method, mode, cache: 'default'}, respondWith: p => { responded = p; }};
    handlers.fetch(e); return responded ? Promise.resolve(responded) : null;
  };
  return {handlers, calls, stores, selfObj, lifecycle, fetchEvent, send: data => handlers.message({data, source: {postMessage: m => calls.posted = m}})};
}
const okFetch = async (p) => new Response(`content of ${p}`, {status: 200});
const version = JSON.parse(read('version.json')).version;

test('sw.js: install precaches the complete list into this version\'s cache, bypassing the HTTP cache, and does NOT skip waiting', async () => {
  const w = runWorker({fetchImpl: okFetch});
  await w.lifecycle('install');
  const cache = w.stores.get(`openroom-shell-${version}`);
  assert.deepEqual([...cache.keys()].sort(), [...precacheList(publicDir)].sort());
  assert.ok(w.calls.fetches.filter(f => f.url.startsWith('https://app.example/')).every(f => f.cache === 'reload'), 'precache requests use cache: reload');
  assert.equal(w.calls.skipWaiting, 0, 'a new worker waits until the page asks');
});
test('sw.js: a precache that fails (for example a 404 right after a deployment) fails the install, so the old version keeps running', async () => {
  const w = runWorker({fetchImpl: async p => p === '/app.js' ? new Response('nope', {status: 404}) : okFetch(p)});
  await assert.rejects(w.lifecycle('install'));
  const w2 = runWorker({fetchImpl: async p => { const r = await okFetch(p); return p === '/styles.css' ? Object.defineProperty(r, 'redirected', {value: true}) : r; }});
  await assert.rejects(w2.lifecycle('install'), 'redirects are never precached');
});
test('sw.js: activation deletes every older shell cache (including the pre-versioned v4) and claims the clients', async () => {
  const w = runWorker({fetchImpl: okFetch, existingCaches: {'openroom-shell-v4': {}, 'openroom-shell-oldversion1': {}, 'openroom-static-v1': {}, 'unrelated-cache': {}}});
  await w.lifecycle('install');
  await w.lifecycle('activate');
  assert.deepEqual(w.calls.deleted.sort(), ['openroom-shell-oldversion1', 'openroom-shell-v4', 'openroom-static-v1']);
  assert.ok(w.stores.has('unrelated-cache') && w.stores.has(`openroom-shell-${version}`));
  assert.equal(w.calls.claim, 1);
});
test('sw.js: SKIP_WAITING activates the worker; GET_VERSION reports its version; other messages are ignored', () => {
  const w = runWorker({fetchImpl: okFetch});
  w.send({type: 'SKIP_WAITING'});
  assert.equal(w.calls.skipWaiting, 1);
  w.send({type: 'GET_VERSION'});
  assert.equal(JSON.stringify(w.calls.posted), JSON.stringify({type: 'VERSION', version}));
  w.send({type: 'whatever'}); w.send(undefined);
  assert.equal(w.calls.skipWaiting, 1);
});
test('sw.js: shell files come from this version\'s cache (never mixed with the network); navigations get the cached start page, even offline', async () => {
  const w = runWorker({fetchImpl: okFetch});
  await w.lifecycle('install');
  w.calls.fetches.length = 0;
  for (const p of ['/app.js', '/styles.css', '/room-metadata.json', '/sw-version.js']) assert.equal(await (await w.fetchEvent(p)).text(), `content of ${p}`);
  assert.equal(await (await w.fetchEvent('/', {mode: 'navigate'})).text(), 'content of /');
  assert.equal(w.calls.fetches.length, 0, 'served entirely from the cache: no network involved');
  const offline = runWorker({fetchImpl: async () => { throw new TypeError('offline'); }, existingCaches: {[`openroom-shell-${version}`]: {'/': new Response('INDEX'), '/app.js': new Response('APP')}}});
  assert.equal(await (await offline.fetchEvent('/', {mode: 'navigate'})).text(), 'INDEX');
  assert.equal(await (await offline.fetchEvent('/some/deep/link', {mode: 'navigate'})).text(), 'INDEX', 'an offline navigation falls back to the start page');
  assert.equal(await (await offline.fetchEvent('/app.js')).text(), 'APP');
});
test('sw.js: /api/ and /version.json are never touched (no respondWith), other origins and non-GET are ignored', async () => {
  const w = runWorker({fetchImpl: okFetch});
  await w.lifecycle('install');
  assert.equal(w.fetchEvent('/api/allocations?room=HG%20E%2027'), null);
  assert.equal(w.fetchEvent('/api/status'), null);
  assert.equal(w.fetchEvent('/version.json'), null, 'the update check always goes to the network');
  assert.equal(w.fetchEvent('/app.js', {origin: 'https://evil.example'}), null);
  assert.equal(w.fetchEvent('/app.js', {method: 'POST'}), null);
  for (const [, cache] of w.stores) for (const key of cache.keys()) assert.ok(!key.startsWith('/api/') && key !== '/version.json');
});
test('sw.js: an error response for an unknown path is returned to the page but never stored', async () => {
  const w = runWorker({fetchImpl: async p => p === '/missing' ? new Response('gone', {status: 404}) : okFetch(p)});
  await w.lifecycle('install');
  const before = [...w.stores.get(`openroom-shell-${version}`).keys()].length;
  const res = await w.fetchEvent('/missing');
  assert.equal(res.status, 404);
  assert.equal([...w.stores.get(`openroom-shell-${version}`).keys()].length, before);
});
