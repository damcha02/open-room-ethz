/** Integration and load tests of the REAL Worker + SQLite Durable Object (workerd, local mode) against a MOCK ETH.
 * Run: npm run test:worker    Never contacts ETH or Cloudflare. */
import fs from 'node:fs';
import {startMock} from '../e2e/mock-eth.mjs';
import {startWorker, sleep, tempDir} from './harness.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '\n        → ' + detail : ''}`); };
const rand = () => 52000 + Math.floor(Math.random() * 2500);
const metrics = {};
const q = (room, from = '2026-11-16', to = '2026-11-22') => `/api/allocations?room=${encodeURIComponent(room)}&from=${from}&to=${to}`;
const get = async (base, url, init) => { const r = await fetch(base + url, init); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {} return {status: r.status, headers: r.headers, text, body}; };
const upstream = async mockPort => (await fetch(`http://127.0.0.1:${mockPort}/__stats`)).json();
const rooms = n => Array.from({length: n}, (_, i) => `HG E ${i + 1}`);
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

async function withStack(vars, fn, {persist = tempDir('openroom-do-')} = {}) {
  const mockPort = rand(), port = mockPort + 3000;
  const mock = await startMock(mockPort);
  const stack = {mock, mockPort, persist, port, worker: await startWorker({mockPort, port, persist, vars}), get base() { return this.worker.base; },
    async restart(newVars = vars) { await this.worker.stop(); this.worker = await startWorker({mockPort, port, persist, vars: newVars}); }};
  try { await fn(stack); } finally { await stack.worker.stop(); mock.close(); fs.rmSync(persist, {recursive: true, force: true}); }
}

// ------------------------------------------------------------------ routing, static assets, headers
await withStack({}, async s => {
  console.log('\n# Routing, static assets and headers');
  const home = await get(s.base, '/');
  check('homepage is served (200, HTML) and mentions Open Room ETHZ', home.status === 200 && /text\/html/.test(home.headers.get('content-type')) && /Open Room ETHZ/.test(home.text));
  check('static files are served WITHOUT running the Worker (no X-Served-By header)', !home.headers.get('x-served-by') && !(await get(s.base, '/app.js')).headers.get('x-served-by'));
  check('API responses are produced by the Worker (X-Served-By present)', (await get(s.base, q('HG E 27'))).headers.get('x-served-by') === 'open-room-worker');
  const csp = home.headers.get('content-security-policy') || '';
  check('static assets carry the security headers from public/_headers (CSP, nosniff, frame deny, referrer policy)', /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('x-frame-options') === 'DENY' && home.headers.get('referrer-policy') === 'no-referrer', csp);
  const sw = await get(s.base, '/sw.js'), man = await get(s.base, '/manifest.webmanifest');
  check('service worker and manifest: correct types, revalidated on every load (no long HTTP caching of sw.js)', /javascript/.test(sw.headers.get('content-type')) && /max-age=0/.test(sw.headers.get('cache-control')) && /manifest\+json|json/.test(man.headers.get('content-type')));
  const manifest = JSON.parse(man.text);
  check('manifest: name, short name, scope, standalone, start_url and any + maskable icons', manifest.name === 'Open Room ETHZ' && manifest.short_name === 'Open Room' && manifest.scope === '/' && manifest.start_url === '/' && manifest.display === 'standalone' && manifest.icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512') && manifest.icons.some(i => i.purpose === 'any' && i.sizes === '192x192'));
  let iconsOk = true;
  for (const icon of manifest.icons) { const r = await fetch(s.base + icon.src); iconsOk &&= r.status === 200 && r.headers.get('content-type') === icon.type && (await r.arrayBuffer()).byteLength > 500; }
  for (const f of ['/icons/apple-touch-icon.png', '/icons/favicon-32.png', '/icons/icon.svg']) iconsOk &&= (await fetch(s.base + f)).status === 200;
  check('every icon in the manifest (plus the iOS touch icon and favicons) is served', iconsOk);
  const notFound = await get(s.base, '/definitely-not-here');
  check('an unknown path is a 404 page (from the assets binding), not an API answer', notFound.status === 404 && /Page not found/.test(notFound.text));
  check('_headers is configuration, never a downloadable file', (await get(s.base, '/_headers')).status === 404);
  const unknownApi = await get(s.base, '/api/unknown');
  check('an unknown /api/ path is a JSON 404 from the Worker', unknownApi.status === 404 && unknownApi.body?.error === 'Not found' && unknownApi.headers.get('x-served-by') === 'open-room-worker');
  check('the API accepts GET only (405 + Allow for POST, PUT, DELETE, HEAD-less)', (await Promise.all(['POST', 'PUT', 'DELETE'].map(m => get(s.base, q('HG E 27'), {method: m})))).every(r => r.status === 405 && r.headers.get('allow') === 'GET'));
  check('no permissive CORS headers anywhere (same-origin only)', !home.headers.get('access-control-allow-origin') && !(await get(s.base, q('HG E 27'))).headers.get('access-control-allow-origin'));
  check('no cookies are ever set', !home.headers.get('set-cookie') && !(await get(s.base, '/api/status')).headers.get('set-cookie'));
  const spyPort = s.mockPort + 1, spy = await startMock(spyPort);
  const trick = await get(s.base, q('HG E 40') + `&endpoint=http://127.0.0.1:${spyPort}/bin/ethz/roominfo&url=http://127.0.0.1:${spyPort}&host=127.0.0.1:${spyPort}`);
  check('the upstream is fixed: query parameters naming another endpoint are ignored (a spy server receives nothing)', trick.status === 200 && (await upstream(spyPort)).total === 0 && (await upstream(s.mockPort)).alloc['HG E 40'] === 1);
  spy.close();
});

// ------------------------------------------------------------------ API contract, validation, invalid rooms, malformed upstream
await withStack({}, async s => {
  console.log('\n# API contract and error handling');
  const ok = await get(s.base, q('HG E 27'));
  check('contract: 200 with room/from/to/allocations/roomVerified/source/fetchedAt/cached/ageMs', ok.status === 200 && ['room', 'from', 'to', 'allocations', 'roomVerified', 'source', 'fetchedAt', 'cached', 'ageMs'].every(k => k in ok.body) && ok.body.source === 'ETH Rauminfo' && ok.body.cached === false && ok.body.roomVerified === true && ok.body.allocations.length > 0);
  check('allocations carry start/end/type/title/courseNumber/eventIsHeld in Zurich wall-clock format; the published type-8 night blocks are present', ok.body.allocations.every(a => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(a.start) && 'type' in a && 'title' in a && 'courseNumber' in a && 'eventIsHeld' in a) && ok.body.allocations.some(a => a.type === 8));
  check('cache-control: shareable for 5 minutes, never browser-cached', ok.headers.get('cache-control') === 'public, max-age=0, s-maxage=300');
  const again = await get(s.base, q('HG E 27'));
  check('second request: cached=true, SAME original fetchedAt, ageMs grows (caching never makes data younger)', again.body.cached === true && again.body.fetchedAt === ok.body.fetchedAt && again.body.ageMs >= ok.body.ageMs);
  const invalid = ['', '?room=x&from=2026-11-16&to=2026-11-22', `?room=${encodeURIComponent('HG E 27/../x')}&from=2026-11-16&to=2026-11-22`, '?room=HG%20E%2027&from=2026-02-30&to=2026-03-01', '?room=HG%20E%2027&from=2026-11-16&to=2026-11-30', '?room=HG%20E%2027&from=2026-11-22&to=2026-11-16'];
  const before = (await upstream(s.mockPort)).total;
  const bad = await Promise.all(invalid.map(x => get(s.base, '/api/allocations' + x)));
  check('invalid input: 400 with no-store, and ETH is never contacted', bad.every(r => r.status === 400 && r.headers.get('cache-control') === 'no-store' && !r.body.allocations) && (await upstream(s.mockPort)).total === before);
  const unknown = await get(s.base, q('HG E 22'));
  check('unknown room (ETH answers 200 []): roomVerified=false, no-store — never "free"', unknown.status === 200 && unknown.body.allocations.length === 0 && unknown.body.roomVerified === false && unknown.headers.get('cache-control') === 'no-store');
  const empty = await get(s.base, q('HG E 21'));
  check('existing room with an empty schedule is verified through the room-details interface', empty.body.roomVerified === true && empty.body.allocations.length === 0);
  s.mock.setFail('malformed');
  const malformed = await get(s.base, q('CHN C 14'));
  check('malformed upstream entry: 502, an error and NO allocations (never a partial schedule)', malformed.status === 502 && !malformed.body.allocations && malformed.headers.get('cache-control') === 'no-store', malformed.text);
  s.mock.setFail('html');
  const maintenance = await get(s.base, q('CHN C 15'));
  check('upstream HTML (maintenance page) instead of JSON: 502, never a schedule', maintenance.status === 502 && !maintenance.body.allocations);
  s.mock.setFail('500');
  const down = await get(s.base, q('CHN C 16'));
  check('upstream HTTP 500: 502, never a schedule', down.status === 502 && !down.body.allocations);
  s.mock.setFail('');
  const recovered = await get(s.base, q('CHN C 16'));
  check('failures were not cached: the same room works once ETH works again', recovered.status === 200 && recovered.body.cached === false);
  const nothing = await get(s.base, '/api/status');
  check('status endpoint: budget accounting visible, no secrets', nothing.body.budgetLimit === 100000 && nothing.body.budgetUsed >= 6 && !/token|secret|key/i.test(nothing.text));
});

// ------------------------------------------------------------------ concurrency, spacing, budget
await withStack({ETH_MIN_INTERVAL_MS: '150'}, async s => {
  console.log('\n# Concurrency and global request spacing');
  const before = (await upstream(s.mockPort)).total;
  const same = await Promise.all(Array.from({length: 60}, () => get(s.base, q('HG E 27'))));
  check('60 identical concurrent requests → exactly ONE upstream request', same.every(r => r.status === 200) && (await upstream(s.mockPort)).total - before === 1, `${(await upstream(s.mockPort)).total - before}`);
  const t0 = (await upstream(s.mockPort)).arrivals.length;
  const distinct = await Promise.all(rooms(6).map(r => get(s.base, q(r))));
  const arrivals = (await upstream(s.mockPort)).arrivals.slice(t0).map(a => a.at).sort((x, y) => x - y);
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
  check(`6 concurrent distinct rooms → ${arrivals.length} upstream requests, globally spaced ≥ ~150 ms apart (min gap ${Math.min(...gaps)} ms)`, distinct.every(r => r.status === 200) && arrivals.length === 6 && Math.min(...gaps) >= 130, JSON.stringify(gaps));
});
await withStack({ETH_DAILY_BUDGET: '6', ETH_MIN_INTERVAL_MS: '20', ETH_MAX_QUEUE_WAIT_MS: '20000'}, async s => {
  console.log('\n# Daily budget: never exceeded, never bypassed by concurrency, persistent');
  const results = await Promise.all(rooms(40).map(r => get(s.base, q(r))));
  const served = results.filter(r => r.status === 200), refused = results.filter(r => r.status === 503);
  check('40 concurrent distinct rooms with a budget of 6 → exactly 6 upstream requests', (await upstream(s.mockPort)).total === 6 && served.length >= 1 && served.length <= 6, `upstream=${(await upstream(s.mockPort)).total} served=${served.length}`);
  check('the rest are 503 budget_exhausted with Retry-After, no body of allocations, no-store', refused.length >= 34 && refused.every(r => r.body.code === 'budget_exhausted' && !r.body.allocations && r.headers.get('cache-control') === 'no-store' && Number(r.headers.get('retry-after')) > 0));
  const status = await get(s.base, '/api/status');
  check('status shows 6 of 6 used', status.body.budgetUsed === 6 && status.body.budgetLimit === 6, status.text);
  const cachedRoom = rooms(40).find((_, i) => results[i].status === 200);
  const hit = await get(s.base, q(cachedRoom));
  check('with the budget used up, a cached schedule is still served (and ETH is not called)', hit.status === 200 && hit.body.cached === true && (await upstream(s.mockPort)).total === 6);
  await s.restart();
  const after = await get(s.base, '/api/status');
  check('the budget counter survives a Worker/Durable Object restart (persistent accounting)', after.body.budgetUsed === 6, after.text);
  const stillCached = await get(s.base, q(cachedRoom));
  check('the schedule cache survives the restart too, with the original fetch time', stillCached.body.cached === true && stillCached.body.fetchedAt === hit.body.fetchedAt);
  const fresh = await get(s.base, q('CHN C 99'));
  check('after the restart a new room still cannot bypass the exhausted budget', fresh.status === 503 && fresh.body.code === 'budget_exhausted' && (await upstream(s.mockPort)).total === 6);
});

// ------------------------------------------------------------------ cooldown, stale-if-error
await withStack({ETH_DEFAULT_COOLDOWN_MS: '60000'}, async s => {
  console.log('\n# Shared ETH rate-limit cooldown');
  s.mock.setRate429(true);
  const first = await get(s.base, q('HG E 1'));
  check('ETH 429 with Retry-After → 503 rate_limited with Retry-After (no schedule)', first.status === 503 && first.body.code === 'rate_limited' && Number(first.headers.get('retry-after')) >= 1 && !first.body.allocations, first.text);
  const t = (await upstream(s.mockPort)).total;
  const others = await Promise.all(rooms(12).slice(1).map(r => get(s.base, q(r))));
  check('during the cooldown 11 other requests make ZERO upstream requests', others.every(r => r.status === 503 && r.body.code === 'rate_limited') && (await upstream(s.mockPort)).total === t);
  s.mock.setRate429(false);
  await s.restart();
  const afterRestart = await get(s.base, q('HG E 30'));
  check('the cooldown is persistent: still no upstream request after a restart', afterRestart.status === 503 && afterRestart.body.code === 'rate_limited' && (await upstream(s.mockPort)).total === t, afterRestart.text);
});
await withStack({ETH_CACHE_TTL_MS: '1200', ETH_MIN_INTERVAL_MS: '10'}, async s => {
  console.log('\n# Stale results are marked, never fabricated');
  const fresh = await get(s.base, q('HG E 27'));
  await sleep(1500);
  s.mock.setFail('500');
  const stale = await get(s.base, q('HG E 27'));
  check('ETH down after the cache expired: the STORED schedule is returned, marked stale, with its true age and original fetch time', stale.status === 200 && stale.body.stale === true && stale.body.staleReason === 'upstream' && stale.body.fetchedAt === fresh.body.fetchedAt && stale.body.ageMs >= 1400 && stale.headers.get('cache-control') === 'no-store', stale.text.slice(0, 200));
  const unseen = await get(s.base, q('HG E 28'));
  check('a room that was never stored cannot be answered at all while ETH is down (503/502, no schedule)', unseen.status >= 500 && !unseen.body.allocations);
  s.mock.setFail('');
  const back = await get(s.base, q('HG E 27'));
  check('when ETH works again the answer is fresh again (cached=false, age ~0)', back.body.cached === false && back.body.ageMs < 1000 && !back.body.stale);
});

// ------------------------------------------------------------------ load test with the mock
await withStack({ETH_MIN_INTERVAL_MS: '20', ETH_MAX_QUEUE_WAIT_MS: '60000', ETH_DAILY_BUDGET: '1000'}, async s => {
  console.log('\n# Load test (mock ETH only)');
  const roomList = Array.from({length: 60}, (_, i) => `CHN C ${i + 1}`); // neutral rooms (the mock treats HG E 21/22/23 specially)
  const latencies = [];
  const timed = async url => { const t = Date.now(); const r = await get(s.base, url); latencies.push(Date.now() - t); return r; };
  const start = Date.now();
  const wave1 = [];
  for (let i = 0; i < 600; i++) wave1.push(timed(q(roomList[i % 60])));
  const r1 = await Promise.all(wave1);
  const seconds = (Date.now() - start) / 1000;
  const up1 = (await upstream(s.mockPort)).total;
  check(`600 concurrent requests over 60 rooms → ${up1} upstream requests (one per room, none duplicated), all answered`, r1.every(r => r.status === 200) && up1 === 60, `status=${[...new Set(r1.map(r => r.status))]} upstream=${up1}`);
  const wave2 = await Promise.all(Array.from({length: 600}, (_, i) => timed(q(roomList[i % 60]))));
  const up2 = (await upstream(s.mockPort)).total;
  check('a second wave of 600 requests is served entirely from the shared cache (0 further upstream requests)', wave2.every(r => r.status === 200 && r.body.cached === true) && up2 === up1);
  metrics.load = {requests: 1200, rooms: 60, upstream: up2, firstWaveSeconds: Number(seconds.toFixed(2)), latencyMs: {p50: pct(latencies, .5), p95: pct(latencies, .95), max: Math.max(...latencies)}};
  console.log('        load metrics:', JSON.stringify(metrics.load));
  const hitLat = [];
  for (let i = 0; i < 40; i++) { const t = Date.now(); await get(s.base, q(roomList[0])); hitLat.push(Date.now() - t); }
  metrics.cachedSequentialMs = {p50: pct(hitLat, .5), p95: pct(hitLat, .95)};
  check(`cached API answers (sequential, local): p50 ${metrics.cachedSequentialMs.p50} ms, p95 ${metrics.cachedSequentialMs.p95} ms`, metrics.cachedSequentialMs.p95 < 250);
  const status = await get(s.base, '/api/status');
  check('budget accounting after the load test equals the upstream requests actually made', status.body.budgetUsed === up2, status.text);
});

console.log(`\n${results.filter(Boolean).length}/${results.length} Worker checks passed`);
fs.writeFileSync(new URL('./last-metrics.json', import.meta.url), JSON.stringify(metrics, null, 2));
process.exit(results.every(Boolean) ? 0 : 1);
