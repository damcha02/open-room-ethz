import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Gateway, gatewayConfig} from '../worker/gateway.js';
import {route, resolveEndpoint} from '../worker/router.js';
import {OFFICIAL_ENDPOINT, USER_AGENT} from '../lib/allocations-core.js';

let nodeSql = null;
try { ({nodeSql} = await import('../worker-tests/sql-adapter.mjs')); } catch { /* node:sqlite needs Node >= 22.5 */ }
const sqliteTest = (name, fn) => nodeSql ? test(name, fn) : test(name, {skip: 'node:sqlite is not available in this Node version'}, () => {});

const T0 = Date.parse('2026-11-18T09:00:00Z');
const D = {room: 'HG E 27', from: '2026-11-16', to: '2026-11-22'};
const entry = (from, to, type = 2, event = {allocationTitle: 'Lecture', veranstaltungsnummer: '1', findetStatt: 1}) => ({veranstaltungsort: '1', date_from: from, date_to: to, belegungsserie: {belegungstyp: type, veranstaltung: event}});
const BOOKING = [entry('2026-11-18T10:00:00', '2026-11-18T12:00:00')];
const json = (body, headers = {}, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {status, headers: {'content-type': 'application/json;charset=utf-8', ...headers}});
const html = () => new Response('<!DOCTYPE html><html></html>', {status: 200, headers: {'content-type': 'text/html;charset=utf-8'}});

/** A gateway on SQLite with a manual clock; `sleep` just advances the clock, so spacing is observable and tests are instant. */
function make({cfg = {}, alloc = () => json(BOOKING), info = () => json({nameWithoutLeadingZeros: D.room}), sql = nodeSql(), clock = {t: T0}, real = false} = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const p = url.searchParams.get('path');
    const kind = p.startsWith('/v2/rooms/') ? 'info' : 'alloc';
    const room = p.replace('/v2', '').split('/')[2];
    calls.push({kind, room, from: url.searchParams.get('from'), at: real ? Date.now() : clock.t, url: String(url), init});
    return (kind === 'info' ? info : alloc)({room, kind});
  };
  const gateway = new Gateway({sql, cfg: gatewayConfig({ETH_MIN_INTERVAL_MS: '0', ...cfg}), fetchFn, now: real ? () => Date.now() : () => clock.t, sleep: real ? undefined : async ms => { const target = clock.t + ms; await Promise.resolve(); clock.t = Math.max(clock.t, target); }}); // advances to the slot's time, like a real sleep
  return {gateway, sql, calls, clock};
}
const ask = (g, over = {}) => { const q = {...D, ...over}; return g.handleAllocations(q.room, q.from, q.to); };

// ---------------------------------------------------------------- contract and cache
sqliteTest('contract: a fresh answer has the fields the app expects, a source timestamp and age 0', async () => {
  const {gateway, calls} = make();
  const r = await ask(gateway);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['ageMs', 'allocations', 'cached', 'fetchedAt', 'from', 'room', 'roomVerified', 'source', 'to']);
  assert.deepEqual([r.body.room, r.body.from, r.body.to, r.body.source, r.body.cached, r.body.ageMs, r.body.roomVerified], [D.room, D.from, D.to, 'ETH Rauminfo', false, 0, true]);
  assert.equal(r.body.fetchedAt, '2026-11-18T09:00:00.000Z');
  assert.deepEqual(r.body.allocations[0], {start: '2026-11-18T10:00:00', end: '2026-11-18T12:00:00', type: 2, title: 'Lecture', courseNumber: '1', eventIsHeld: 1});
  assert.match(r.cacheControl, /^public, max-age=0, s-maxage=300$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['User-Agent'], USER_AGENT);
  assert.ok(!('cookie' in calls[0].init.headers) && !('Cookie' in calls[0].init.headers) && !('Authorization' in calls[0].init.headers));
  assert.equal(new URL(calls[0].url).origin + new URL(calls[0].url).pathname, OFFICIAL_ENDPOINT);
});
sqliteTest('cache: a repeated request is a cache hit that keeps the ORIGINAL fetch time and ages with the clock', async () => {
  const {gateway, calls, clock, sql} = make();
  const first = await ask(gateway);
  clock.t += 200_000;
  sql.log.length = 0;
  const second = await ask(gateway);
  assert.equal(calls.length, 1);
  assert.deepEqual([second.body.cached, second.body.fetchedAt, second.body.ageMs], [true, first.body.fetchedAt, 200_000]);
  assert.equal(sql.log.length, 1, 'a cache hit is exactly one statement (cheap on the free SQLite quotas)');
  assert.ok(sql.log.every(s => s.startsWith('SELECT')), 'and it is a read, not a write');
});
sqliteTest('cache: expires after about five minutes; the next request asks ETH again and gets age 0', async () => {
  const {gateway, calls, clock} = make();
  await ask(gateway);
  clock.t += 299_000; assert.equal((await ask(gateway)).body.cached, true);
  clock.t += 2_000;
  const r = await ask(gateway);
  assert.deepEqual([r.body.cached, r.body.ageMs, calls.length], [false, 0, 2]);
});
sqliteTest('cache: keys are per room and week; different weeks or rooms are different upstream requests', async () => {
  const {gateway, calls} = make();
  await ask(gateway); await ask(gateway, {from: '2026-11-23', to: '2026-11-29'}); await ask(gateway, {room: 'CHN C 14'});
  assert.equal(calls.length, 3);
});
sqliteTest('cache: errors are never cached; the next request tries ETH again', async () => {
  let fail = true;
  const {gateway, calls} = make({alloc: () => fail ? new Response('boom', {status: 500}) : json(BOOKING)});
  assert.equal((await ask(gateway)).status, 502);
  fail = false;
  const r = await ask(gateway);
  assert.deepEqual([r.status, r.body.cached, calls.length], [200, false, 2]);
});

// ---------------------------------------------------------------- de-duplication
sqliteTest('dedupe: 50 identical concurrent requests share ONE upstream request', async () => {
  const {gateway, calls} = make({alloc: async () => { await new Promise(r => setTimeout(r, 15)); return json(BOOKING); }});
  const results = await Promise.all(Array.from({length: 50}, () => ask(gateway)));
  assert.equal(calls.length, 1);
  assert.ok(results.every(r => r.status === 200 && r.body.fetchedAt === results[0].body.fetchedAt));
});
sqliteTest('dedupe: concurrent requests for an empty schedule share the schedule request AND the room check', async () => {
  const {gateway, calls} = make({alloc: async () => { await new Promise(r => setTimeout(r, 10)); return json([]); }});
  await Promise.all(Array.from({length: 20}, () => ask(gateway)));
  assert.deepEqual([calls.filter(c => c.kind === 'alloc').length, calls.filter(c => c.kind === 'info').length], [1, 1]);
});
sqliteTest('dedupe: a failed shared request fails every waiter once and is not cached', async () => {
  const {gateway, calls} = make({alloc: async () => { await new Promise(r => setTimeout(r, 10)); return new Response('x', {status: 500}); }});
  const results = await Promise.all([ask(gateway), ask(gateway), ask(gateway)]);
  assert.deepEqual(results.map(r => r.status), [502, 502, 502]);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- shared spacing
sqliteTest('spacing: upstream requests for different rooms start at least minInterval apart (global, persisted slots; real clock)', async () => {
  const {gateway, calls} = make({real: true, cfg: {ETH_MIN_INTERVAL_MS: '60', ETH_MAX_QUEUE_WAIT_MS: '5000'}});
  await Promise.all(['HG E 27', 'CHN C 14', 'HCI D 2', 'HG E 21', 'HG E 22'].map(room => ask(gateway, {room})));
  const starts = calls.map(c => c.at).sort((a, b) => a - b);
  assert.equal(calls.length, 5);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 55, `gap ${starts[i] - starts[i - 1]} ms`);
});
sqliteTest('spacing: the waiting queue is bounded; excess requests are refused with Retry-After instead of piling up', async () => {
  const {gateway, calls} = make({cfg: {ETH_MIN_INTERVAL_MS: '1000', ETH_MAX_QUEUE_WAIT_MS: '2500'}});
  const rooms = Array.from({length: 10}, (_, i) => `HG E ${i + 1}`);
  const results = await Promise.all(rooms.map(room => ask(gateway, {room})));
  const refused = results.filter(r => r.status === 503);
  assert.ok(refused.length >= 6, 'later requests must be refused');
  assert.ok(refused.every(r => r.body.code === 'busy' && Number(r.headers['Retry-After']) >= 1));
  assert.equal(calls.length, results.filter(r => r.status === 200).length);
  assert.ok(calls.length <= 4);
});

// ---------------------------------------------------------------- the daily budget
sqliteTest('budget: concurrent requests can never exceed the daily budget, and nothing is fabricated when it is used up', async () => {
  const {gateway, calls} = make({cfg: {ETH_DAILY_BUDGET: '5'}});
  const rooms = Array.from({length: 40}, (_, i) => `HG E ${i + 1}`);
  const results = await Promise.all(rooms.map(room => ask(gateway, {room})));
  assert.equal(calls.length, 5, 'exactly the budget, even under 40-way concurrency');
  assert.equal(results.filter(r => r.status === 200).length, 5);
  const refused = results.filter(r => r.status === 503);
  assert.equal(refused.length, 35);
  assert.ok(refused.every(r => r.body.code === 'budget_exhausted' && r.body.allocations === undefined && r.cacheControl === 'no-store' && Number(r.headers['Retry-After']) > 0));
  assert.deepEqual([gateway.status().budgetUsed, gateway.status().budgetLimit], [5, 5]);
});
sqliteTest('budget: when it is used up, cached answers are still served and nothing calls ETH', async () => {
  const {gateway, calls} = make({cfg: {ETH_DAILY_BUDGET: '1'}});
  await ask(gateway);
  assert.equal((await ask(gateway)).body.cached, true);
  const other = await ask(gateway, {room: 'CHN C 14'});
  assert.deepEqual([other.status, other.body.code], [503, 'budget_exhausted']);
  assert.equal(calls.length, 1);
});
sqliteTest('budget: room-existence checks count against it too', async () => {
  const {gateway, calls} = make({alloc: () => json([]), cfg: {ETH_DAILY_BUDGET: '2'}});
  await ask(gateway);                                   // schedule + room check = 2 upstream requests
  assert.equal(calls.length, 2);
  assert.equal(gateway.status().budgetUsed, 2);
  const r = await ask(gateway, {room: 'CHN C 14'});     // budget is gone
  assert.equal(r.body.code, 'budget_exhausted');
  assert.equal(calls.length, 2);
});
sqliteTest('budget: the counter is persistent (survives a restart) and resets with the next UTC day', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openroom-')), 'do.sqlite');
  const clock = {t: T0};
  const a = make({sql: nodeSql(file), clock, cfg: {ETH_DAILY_BUDGET: '3'}});
  for (const room of ['HG E 1', 'HG E 2']) await ask(a.gateway, {room});
  a.sql.close();
  const b = make({sql: nodeSql(file), clock, cfg: {ETH_DAILY_BUDGET: '3'}}); // a "restart": new instance, same storage
  assert.equal(b.gateway.status().budgetUsed, 2, 'persisted accounting');
  assert.equal((await ask(b.gateway, {room: 'HG E 3'})).status, 200);
  assert.equal((await ask(b.gateway, {room: 'HG E 4'})).body.code, 'budget_exhausted');
  assert.equal((await ask(b.gateway, {room: 'HG E 1'})).body.cached, true, 'the persisted cache survives too');
  clock.t = Date.parse('2026-11-19T00:00:05Z');
  assert.equal(b.gateway.status().budgetUsed, 0);
  assert.equal((await ask(b.gateway, {room: 'HG E 4'})).status, 200);
  b.sql.close(); fs.rmSync(path.dirname(file), {recursive: true, force: true});
});

// ---------------------------------------------------------------- shared rate-limit handling
sqliteTest('429 with Retry-After: global cooldown, persisted and shared by every instance; no ETH call during it', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openroom-')), 'do.sqlite');
  const clock = {t: T0};
  const a = make({sql: nodeSql(file), clock, alloc: () => new Response('slow down', {status: 429, headers: {'retry-after': '7'}})});
  const first = await ask(a.gateway);
  assert.deepEqual([first.status, first.body.code, first.headers['Retry-After'], first.cacheControl], [503, 'rate_limited', '7', 'no-store']);
  assert.equal(a.gateway.status().cooldownSeconds, 7);
  const b = make({sql: nodeSql(file), clock});            // a second "isolate" on the same storage
  const second = await ask(b.gateway, {room: 'CHN C 14'});
  assert.deepEqual([second.status, second.body.code, b.calls.length], [503, 'rate_limited', 0]);
  clock.t += 8000;
  assert.equal((await ask(b.gateway, {room: 'CHN C 14'})).status, 200);
  a.sql.close(); b.sql.close(); fs.rmSync(path.dirname(file), {recursive: true, force: true});
});
sqliteTest('429 without Retry-After backs off exponentially; x-ratelimit-remaining 0 starts a cooldown; low remaining slows down', async () => {
  const {gateway, calls, clock} = make({alloc: () => new Response('x', {status: 429}), cfg: {ETH_DEFAULT_COOLDOWN_MS: '60000'}});
  await ask(gateway); assert.equal(gateway.status().cooldownSeconds, 60);
  clock.t += 61_000; await ask(gateway); assert.equal(gateway.status().cooldownSeconds, 120);
  assert.equal(calls.length, 2);
  const zero = make({alloc: () => json(BOOKING, {'x-ratelimit-remaining': '0'})});
  assert.equal((await ask(zero.gateway)).status, 200);
  assert.equal((await ask(zero.gateway, {room: 'CHN C 14'})).body.code, 'rate_limited');
  const low = make({alloc: () => json(BOOKING, {'x-ratelimit-remaining': '3'}), cfg: {ETH_LOW_INTERVAL_MS: '5000', ETH_MAX_QUEUE_WAIT_MS: '60000'}});
  await ask(low.gateway); await ask(low.gateway, {room: 'CHN C 14'});
  assert.ok(low.calls[1].at - low.calls[0].at >= 5000);
});
sqliteTest('a 429 that arrives while other requests wait for their slot stops them from calling ETH', async () => {
  const {gateway, calls} = make({alloc: () => new Response('x', {status: 429, headers: {'retry-after': '30'}}), cfg: {ETH_MIN_INTERVAL_MS: '100', ETH_MAX_QUEUE_WAIT_MS: '10000'}});
  const results = await Promise.all(['HG E 1', 'HG E 2', 'HG E 3', 'HG E 4'].map(room => ask(gateway, {room})));
  assert.ok(results.every(r => r.status === 503 && r.body.code === 'rate_limited'));
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- stale results, never fabricated
sqliteTest('stale-if-error: when ETH cannot be asked, a STORED schedule is returned with its true age and a stale marker', async () => {
  let mode = 'ok';
  const {gateway, clock, calls} = make({alloc: () => mode === 'ok' ? json(BOOKING) : mode === '429' ? new Response('x', {status: 429, headers: {'retry-after': '120'}}) : new Response('x', {status: 500})});
  const fresh = await ask(gateway);
  clock.t += 7 * 60_000;                               // past the 5-minute TTL, still inside the 10-minute freshness window
  mode = '500';
  const a = await ask(gateway);
  assert.deepEqual([a.status, a.body.stale, a.body.staleReason, a.body.cached, a.body.fetchedAt, a.body.ageMs, a.cacheControl], [200, true, 'upstream', true, fresh.body.fetchedAt, 7 * 60_000, 'no-store']);
  mode = '429';
  clock.t += 3 * 60_000;
  const b = await ask(gateway);                         // ETH answers 429: stale again, now 10 min old (the app shows it as Stale)
  assert.deepEqual([b.status, b.body.staleReason, b.body.ageMs], [200, 'rate_limited', 10 * 60_000]);
  const c = await ask(gateway);                         // cooldown now active: ETH is not even called
  assert.deepEqual([c.body.staleReason, calls.length], ['rate_limited', 3]);
  clock.t += 51 * 60_000;                               // older than one hour: nothing is shown any more
  const d = await ask(gateway);
  assert.deepEqual([d.status, d.body.allocations], [503, undefined]);
});
sqliteTest('stale-if-error: also when the daily budget is used up; unverified schedules are never resurrected', async () => {
  const {gateway, clock} = make({cfg: {ETH_DAILY_BUDGET: '1'}});
  await ask(gateway); clock.t += 6 * 60_000;
  const r = await ask(gateway);
  assert.deepEqual([r.status, r.body.stale, r.body.staleReason], [200, true, 'budget_exhausted']);
  const u = make({alloc: () => json([]), info: () => new Response('x', {status: 500}), cfg: {ETH_UNVERIFIED_TTL_MS: '1000'}});
  assert.equal((await ask(u.gateway)).body.roomVerified, null);
  u.clock.t += 2000;
  u.gateway.cfg.dailyBudget = 0;
  const r2 = await ask(u.gateway);
  assert.deepEqual([r2.status, r2.body.allocations], [503, undefined], 'an unverified (empty) schedule is not served as stale');
});

// ---------------------------------------------------------------- invalid rooms and malformed upstream data
sqliteTest('invalid room: 200 [] plus an HTML "not found" page → roomVerified=false, not shareable; the verdict is cached', async () => {
  const {gateway, calls} = make({alloc: () => json([]), info: () => html()});
  const r = await ask(gateway, {room: 'ZZZ Z 9999'});
  assert.deepEqual([r.status, r.body.allocations, r.body.roomVerified, r.cacheControl], [200, [], false, 'no-store']);
  await ask(gateway, {room: 'ZZZ Z 9999', from: '2026-11-23', to: '2026-11-29'});
  assert.equal(calls.filter(c => c.kind === 'info').length, 1, 'the "room does not exist" verdict is cached');
});
sqliteTest('valid room with an empty schedule is verified via the room-details interface; a different name does not verify', async () => {
  const ok = make({alloc: () => json([])});
  const r = await ask(ok.gateway);
  assert.deepEqual([r.body.roomVerified, r.cacheControl], [true, 'public, max-age=0, s-maxage=300']);
  assert.equal(new URL(ok.calls.find(c => c.kind === 'info').url).searchParams.get('path'), '/v2/rooms/HG E 27');
  const other = make({alloc: () => json([]), info: () => json({nameWithoutLeadingZeros: 'HG E 99'})});
  assert.equal((await ask(other.gateway)).body.roomVerified, false);
  const nonEmpty = make();
  await ask(nonEmpty.gateway);
  assert.equal(nonEmpty.calls.filter(c => c.kind === 'info').length, 0, 'a non-empty schedule proves existence at no extra cost');
});
for (const [name, info] of [['500', () => new Response('x', {status: 500})], ['429', () => new Response('x', {status: 429})], ['invalid JSON', () => json('{oops')], ['network error', () => { throw new TypeError('fetch failed'); }]]) {
  sqliteTest(`invalid room: an empty schedule whose room check fails (${name}) → roomVerified=null (unknown), never "free"`, async () => {
    const {gateway} = make({alloc: () => json([]), info});
    const r = await ask(gateway);
    assert.deepEqual([r.status, r.body.roomVerified, r.cacheControl], [200, null, 'no-store']);
  });
}
for (const [name, response] of [
  ['invalid JSON', () => json('{not json')], ['object instead of array', () => json({error: 'x'})], ['null', () => json('null')],
  ['missing date_to', () => json([entry('2026-11-18T10:00:00', '2026-11-18T11:00:00'), {date_from: '2026-11-18T10:00:00'}])],
  ['impossible date', () => json([{date_from: '2026-02-30T10:00:00', date_to: '2026-02-30T11:00:00'}])],
  ['end before start', () => json([{date_from: '2026-11-18T12:00:00', date_to: '2026-11-18T11:00:00'}])],
  ['null entry', () => json([null])], ['not JSON at all', html], ['HTTP 500', () => new Response('x', {status: 500})],
  ['HTTP 403', () => new Response('x', {status: 403})], ['redirect to a login page', () => new Response(null, {status: 302, headers: {location: 'https://example.org/login'}})],
  ['oversized', () => json('[]', {'content-length': '99999999'})]
]) {
  sqliteTest(`malformed or failed upstream (${name}): an error, never a schedule, never stored`, async () => {
    const {gateway, calls} = make({alloc: response});
    const r = await ask(gateway);
    assert.equal(r.status, 502);
    assert.equal(r.body.allocations, undefined);
    assert.equal(r.cacheControl, 'no-store');
    await ask(gateway);
    assert.equal(calls.length, 2, 'the failure was not cached');
  });
}
sqliteTest('timeouts and network errors are errors too', async () => {
  for (const error of [new TypeError('fetch failed'), Object.assign(new Error('t'), {name: 'TimeoutError'})]) {
    const {gateway} = make({alloc: () => { throw error; }});
    const r = await ask(gateway);
    assert.deepEqual([r.status, r.body.allocations], [502, undefined]);
  }
});
sqliteTest('every booking type is passed through unchanged (type 8, 13 and unknown are the client\'s job to treat as blocking)', async () => {
  const {gateway} = make({alloc: () => json([entry('2026-11-18T00:00:00', '2026-11-18T08:00:00', 8, null), entry('2026-11-18T14:00:00', '2026-11-18T16:00:00', 13, {allocationTitle: 'X', findetStatt: 0}), entry('2026-11-18T18:00:00', '2026-11-18T19:00:00', 99, null)])});
  const r = await ask(gateway);
  assert.deepEqual(r.body.allocations.map(a => [a.type, a.eventIsHeld]), [[8, null], [13, 0], [99, null]]);
});
sqliteTest('status: budget, limiter and cache summary without secrets', async () => {
  const {gateway} = make({cfg: {ETH_DAILY_BUDGET: '9'}});
  await ask(gateway);
  assert.deepEqual(gateway.status(), {day: '2026-11-18', budgetUsed: 1, budgetLimit: 9, cooldownSeconds: 0, strikes: 0, lastRemaining: null, cachedSchedules: 1, cacheTtlMs: 300000});
});
sqliteTest('the cache table stays bounded', async () => {
  const {gateway} = make({cfg: {ETH_MAX_CACHE_ROWS: '5'}});
  for (let i = 1; i <= 12; i++) await ask(gateway, {room: `HG E ${i}`});
  assert.ok(gateway.status().cachedSchedules <= 5);
});

// ---------------------------------------------------------------- router: the API contract and routing
function fakeEnv({gateway, assets = () => new Response('asset', {headers: {'content-type': 'text/html'}})} = {}) {
  const asked = [];
  // the Durable Object's RPC surface: allocations() and status()
  const stub = gateway.handleAllocations ? {allocations: (r, f, t) => gateway.handleAllocations(r, f, t), status: async () => gateway.status()} : gateway;
  return {asked, ETH_GATEWAY: {getByName: name => { asked.push(name); return stub; }}, ASSETS: {fetch: assets}};
}
const request = (pathAndQuery, method = 'GET') => new Request(`https://open-room-ethz.example.workers.dev${pathAndQuery}`, {method});
sqliteTest('router: GET /api/allocations returns the Node-compatible JSON with security headers and the gateway cache policy', async () => {
  const {gateway} = make();
  const env = fakeEnv({gateway});
  const res = await route(request(`/api/allocations?room=${encodeURIComponent(D.room)}&from=${D.from}&to=${D.to}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=0, s-maxage=300');
  assert.equal(res.headers.get('x-served-by'), 'open-room-worker');
  const body = await res.json();
  assert.deepEqual([body.room, body.roomVerified, body.source, body.cached, typeof body.ageMs, Array.isArray(body.allocations)], [D.room, true, 'ETH Rauminfo', false, 'number', true]);
  assert.deepEqual(env.asked, ['global'], 'one global coordination point');
});
sqliteTest('router: strict input validation happens BEFORE the Durable Object (invalid requests cost nothing upstream)', async () => {
  const {gateway, calls} = make();
  const env = fakeEnv({gateway});
  const bad = ['', '?room=x&from=2026-11-16&to=2026-11-22', `?room=${encodeURIComponent('HG E 27/../x')}&from=2026-11-16&to=2026-11-22`, `?room=${encodeURIComponent(D.room)}&from=2026-02-30&to=2026-03-01`,
    `?room=${encodeURIComponent(D.room)}&from=2026-11-16&to=2026-11-30`, `?room=${encodeURIComponent(D.room)}&from=2026-11-22&to=2026-11-16`, `?room=${encodeURIComponent('/etc/passwd')}&from=2026-11-16&to=2026-11-22`];
  for (const query of bad) {
    const res = await route(request(`/api/allocations${query}`), env);
    assert.equal(res.status, 400, query);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).allocations, undefined);
  }
  assert.deepEqual([calls.length, env.asked.length], [0, 0]);
});
sqliteTest('router: only GET; unknown API paths are 404 JSON; everything else goes to the assets binding', async () => {
  const {gateway} = make();
  const env = fakeEnv({gateway});
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await route(request('/api/allocations', method), env);
    assert.deepEqual([res.status, res.headers.get('allow')], [405, 'GET'], method);
  }
  const unknown = await route(request('/api/unknown'), env);
  assert.deepEqual([unknown.status, (await unknown.json()).error], [404, 'Not found']);
  assert.equal(await (await route(request('/nothing-here'), env)).text(), 'asset');
  assert.equal(env.asked.length, 0);
});
sqliteTest('router: a Durable Object failure (for example an exhausted free quota) is a 503, never an empty or free schedule', async () => {
  const env = fakeEnv({gateway: {allocations: async () => { throw new Error('Durable Object quota exceeded'); }, status: async () => { throw new Error('x'); }}});
  const res = await route(request(`/api/allocations?room=${encodeURIComponent(D.room)}&from=${D.from}&to=${D.to}`), env);
  const body = await res.json();
  assert.deepEqual([res.status, body.code, res.headers.get('retry-after'), res.headers.get('cache-control'), body.allocations], [503, 'gateway_unavailable', '60', 'no-store', undefined]);
  assert.equal((await route(request('/api/status'), env)).status, 503);
});
sqliteTest('router: /api/status exposes the budget without secrets', async () => {
  const {gateway} = make({cfg: {ETH_DAILY_BUDGET: '200'}});
  const res = await route(request('/api/status'), fakeEnv({gateway}));
  const body = await res.json();
  assert.deepEqual([res.status, body.budgetLimit, body.budgetUsed], [200, 200, 0]);
  assert.doesNotMatch(JSON.stringify(body), /token|secret|key|account/i);
});
test('upstream selection: always the official endpoint; a test endpoint only with the explicit flag and only on localhost', () => {
  assert.equal(resolveEndpoint({}), OFFICIAL_ENDPOINT);
  assert.equal(resolveEndpoint({ETH_ENDPOINT: 'http://127.0.0.1:9/bin/ethz/roominfo'}), OFFICIAL_ENDPOINT, 'no flag, no override');
  assert.equal(resolveEndpoint({ALLOW_TEST_UPSTREAM: '1', ETH_ENDPOINT: 'http://127.0.0.1:9/bin/ethz/roominfo'}), 'http://127.0.0.1:9/bin/ethz/roominfo');
  for (const evil of ['https://evil.example/x', 'http://evil.example/x', 'https://127.0.0.1/x', 'http://169.254.169.254/latest', 'not a url', 'http://127.0.0.1.evil.example/x']) {
    assert.equal(resolveEndpoint({ALLOW_TEST_UPSTREAM: '1', ETH_ENDPOINT: evil}), OFFICIAL_ENDPOINT, evil);
  }
  assert.equal(resolveEndpoint({ALLOW_TEST_UPSTREAM: '0', ETH_ENDPOINT: 'http://localhost:1/x'}), OFFICIAL_ENDPOINT);
});
test('configuration: conservative defaults (budget 200/day, 5-minute cache, 1 s spacing) and bad values fall back', () => {
  const cfg = gatewayConfig({});
  assert.deepEqual([cfg.dailyBudget, cfg.cacheTtlMs, cfg.minIntervalMs, cfg.maxQueueWaitMs, cfg.endpoint], [200, 300000, 1000, 8000, OFFICIAL_ENDPOINT]);
  const bad = gatewayConfig({ETH_DAILY_BUDGET: 'many', ETH_CACHE_TTL_MS: '-5', ETH_MIN_INTERVAL_MS: ''});
  assert.deepEqual([bad.dailyBudget, bad.cacheTtlMs, bad.minIntervalMs], [200, 300000, 1000]);
  assert.equal(gatewayConfig({ETH_DAILY_BUDGET: '25'}).dailyBudget, 25);
});
