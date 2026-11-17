import test from 'node:test';
import assert from 'node:assert/strict';
import {GUARD_KEY, UpdateError, parseVersionJson, compareVersions, fetchDeployedVersion, findInstalledWorker, applyWaiting, checkAndApply, applyOnLaunch, UPDATE_MESSAGES} from '../public/update.mjs';

const OLD = 'aaaaaaaaaaaa', NEW = 'bbbbbbbbbbbb';

/** A fake world: registration, workers, storage, reload counter. `after` decides what reg.update() produces. */
function world({running = OLD, deployed = NEW, fetchFails = null, after = 'waiting', controllerChanges = true, hasRegistration = true, updateThrows = false} = {}) {
  const log = {reloads: 0, posted: [], updates: 0, fetches: [], storageWrites: []};
  const store = new Map();
  const worker = {state: 'installed', listeners: [], addEventListener(t, fn) { this.listeners.push(fn); }, postMessage(m) { log.posted.push(m); if (controllerChanges) setTimeout(() => waiters.splice(0).forEach(r => r(true)), 0); }};
  const waiters = [];
  const reg = {waiting: after === 'already-waiting' ? worker : null, installing: null,
    async update() {
      log.updates++;
      if (updateThrows) throw new Error('update failed');
      if (after === 'waiting') this.waiting = worker;
      if (after === 'installing') { worker.state = 'installing'; this.installing = worker; setTimeout(() => { worker.state = 'installed'; this.waiting = worker; worker.listeners.forEach(f => f()); }, 0); }
      if (after === 'redundant') { worker.state = 'installing'; this.installing = worker; setTimeout(() => { worker.state = 'redundant'; worker.listeners.forEach(f => f()); }, 0); }
    }};
  const env = {
    running, installTimeoutMs: 200,
    async fetchVersion() { log.fetches.push('/version.json'); if (fetchFails) throw fetchFails; return deployed; },
    async getRegistration() { return hasRegistration ? reg : undefined; },
    reload() { log.reloads++; },
    waitForControllerChange(ms) { return new Promise(res => { waiters.push(res); if (!controllerChanges) setTimeout(() => res(false), 5); }); },
    storage: {get: k => store.get(k) ?? null, set: (k, v) => { log.storageWrites.push(k); store.set(k, v); }, remove: k => store.delete(k)}
  };
  return {env, log, reg, store, worker};
}

test('version parsing and comparison', () => {
  assert.equal(parseVersionJson('{"name":"x","version":"f1b56bf8cf90"}'), 'f1b56bf8cf90');
  for (const bad of ['', 'nope', '{}', '{"version":5}', '{"version":"zzz"}', '{"version":"abc"}', '{"version":"../../x"}', 'null']) assert.equal(parseVersionJson(bad), null, bad);
  assert.equal(compareVersions(OLD, OLD), 'current');
  assert.equal(compareVersions(OLD, NEW), 'different');
  assert.equal(compareVersions(NEW, OLD), 'different', 'a rollback is a different version too');
  for (const [a, b] of [[undefined, NEW], ['dev', NEW], [OLD, undefined], [OLD, 'dev'], [null, null]]) assert.equal(compareVersions(a, b), 'unsupported');
});
test('fetching the deployed version: no-store, and every failure is classified', async () => {
  let seen;
  const ok = async (url, init) => { seen = {url, init}; return new Response('{"version":"f1b56bf8cf90"}', {status: 200}); };
  assert.equal(await fetchDeployedVersion(ok), 'f1b56bf8cf90');
  assert.equal(seen.url, '/version.json');
  assert.equal(seen.init.cache, 'no-store', 'never answered from an HTTP cache');
  await assert.rejects(fetchDeployedVersion(async () => { throw new TypeError('Failed to fetch'); }), e => e instanceof UpdateError && e.kind === 'offline');
  await assert.rejects(fetchDeployedVersion(async () => { throw Object.assign(new Error('t'), {name: 'TimeoutError'}); }), e => e.kind === 'offline');
  await assert.rejects(fetchDeployedVersion(async () => new Response('x', {status: 500})), e => e.kind === 'http');
  await assert.rejects(fetchDeployedVersion(async () => new Response('<html>', {status: 200})), e => e.kind === 'invalid');
});

// ---------------------------------------------------------------- the user-triggered check
test('no update: the running version is kept — nothing is touched, nothing reloads', async () => {
  const w = world({deployed: OLD});
  const r = await checkAndApply(w.env);
  assert.deepEqual([r.outcome, w.log.reloads, w.log.updates, w.log.posted.length, w.log.storageWrites.length], ['current', 0, 0, 0, 0]);
  assert.equal(UPDATE_MESSAGES.current, 'App is up to date');
});
test('update available: the new worker is activated and the page reloads EXACTLY once', async () => {
  const w = world({});
  const r = await checkAndApply(w.env);
  assert.deepEqual([r.outcome, r.remote, w.log.reloads, w.log.updates], ['reloading', NEW, 1, 1]);
  assert.deepEqual(w.log.posted, [{type: 'SKIP_WAITING'}]);
  assert.equal(w.store.get(GUARD_KEY), NEW);
});
test('update available: a worker still installing is awaited until it has finished installing', async () => {
  const w = world({after: 'installing'});
  assert.equal((await checkAndApply(w.env)).outcome, 'reloading');
  assert.equal(w.log.reloads, 1);
  assert.equal((await findInstalledWorker({waiting: null, installing: null})), null);
});
test('a failed install (redundant worker) keeps the old version: no activation, no reload', async () => {
  const w = world({after: 'redundant'});
  assert.deepEqual([(await checkAndApply(w.env)).outcome, w.log.reloads, w.log.posted.length], ['failed', 0, 0]);
});
test('install that never finishes times out calmly', async () => {
  const w = world({after: 'nothing'});
  const r = await checkAndApply(w.env);
  assert.deepEqual([r.outcome, w.log.reloads], ['failed', 0]);
});
test('no reload loop: if the new worker does not take control, there is no reload and a second try never reloads either', async () => {
  const w = world({controllerChanges: false});
  const first = await checkAndApply(w.env);
  assert.deepEqual([first.outcome, w.log.reloads], ['pending', 0]);
  const second = await checkAndApply(w.env);
  assert.deepEqual([second.outcome, w.log.reloads, w.log.posted.length], ['pending', 0, 1], 'guard: at most one activation attempt per target and session');
  assert.match(UPDATE_MESSAGES.pending, /close and reopen/i);
});
test('after a successful update the guard is cleared at launch; a LATER version can update again', async () => {
  const w = world({});
  await checkAndApply(w.env);
  assert.equal(w.log.reloads, 1);
  const afterReload = world({running: NEW, deployed: NEW});
  afterReload.store.set(GUARD_KEY, NEW);
  await applyOnLaunch(afterReload.env);
  assert.equal(afterReload.store.get(GUARD_KEY), undefined, 'running === target: cleared');
  const later = world({running: NEW, deployed: 'cccccccccccc'});
  assert.equal((await checkAndApply(later.env)).outcome, 'reloading');
});
test('offline update check: calm result, nothing changes', async () => {
  const w = world({fetchFails: new UpdateError('offline', 'network unavailable')});
  const r = await checkAndApply(w.env);
  assert.deepEqual([r.outcome, w.log.reloads, w.log.updates, w.log.posted.length], ['offline', 0, 0, 0]);
  assert.match(UPDATE_MESSAGES.offline, /offline/);
});
test('failed update checks (HTTP error, unreadable file, failing registration update) are calm failures', async () => {
  for (const error of [new UpdateError('http', 'HTTP 500'), new UpdateError('invalid', 'x'), new Error('boom')]) {
    const w = world({fetchFails: error});
    assert.deepEqual([(await checkAndApply(w.env)).outcome, w.log.reloads], ['failed', 0]);
  }
  const w = world({updateThrows: true});
  assert.deepEqual([(await checkAndApply(w.env)).outcome, w.log.reloads, w.log.posted.length], ['failed', 0, 0]);
});
test('without a service worker a plain reload fetches the new files — once', async () => {
  const w = world({hasRegistration: false});
  assert.equal((await checkAndApply(w.env)).outcome, 'reloading');
  assert.equal((await checkAndApply(w.env)).outcome, 'pending');
  assert.equal(w.log.reloads, 1);
});
test('local development (no real version): the flow does nothing at all', async () => {
  for (const running of [null, 'dev']) {
    const w = world({running});
    assert.equal((await checkAndApply(w.env)).outcome, 'unsupported');
    assert.deepEqual([w.log.fetches.length, w.log.reloads], [0, 0]);
  }
});
test('local user data is untouched: the flow writes only its own session guard', async () => {
  const w = world({});
  const local = new Map([['openroom-prefs-v1', '{"favorites":["HG E 27"],"campus":"Hönggerberg","filters":{"type":"lecture"}}'], ['openroom-cache-v2', '{}']]);
  const before = JSON.stringify([...local]);
  await checkAndApply(w.env);
  assert.deepEqual([...new Set(w.log.storageWrites)], [GUARD_KEY]);
  assert.equal(JSON.stringify([...local]), before);
});

// ---------------------------------------------------------------- launch-time application
test('launch: an update that finished installing while the app was closed is applied once per session', async () => {
  const w = world({after: 'already-waiting', running: OLD});
  const r = await applyOnLaunch(w.env);
  assert.deepEqual([r.outcome, w.log.reloads, w.log.posted.length], ['reloading', 1, 1]);
  const again = await applyOnLaunch(w.env);          // the page reloaded but the worker is still "waiting"
  assert.deepEqual([again.outcome, w.log.reloads], ['pending', 1], 'no launch-time reload loop');
});
test('launch: nothing waiting means nothing happens', async () => {
  const w = world({after: 'nothing'});
  const r = await applyOnLaunch(w.env);
  assert.deepEqual([r.outcome, w.log.reloads, w.log.posted.length], ['none', 0, 0]);
  assert.equal((await applyWaiting(w.env, 'x')).outcome, 'none');
});
