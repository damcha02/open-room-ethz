/** App update flow: pure logic with injected dependencies (no direct use of window, navigator or fetch), see docs/UPDATES.md.
 *
 * "Is there a newer app?" is answered by comparing the running version (from /sw-version.js, the version of the files this page loaded)
 * with /version.json fetched from the network (cache: 'no-store'). That check costs ZERO ETH requests: both are static files.
 *
 * Safety rules:
 *   - The page reloads at most once per target version per browser session (a guard in sessionStorage), so a version that cannot be
 *     activated can never cause a reload loop. The user then sees "new version ready, close and reopen the app".
 *   - A new service worker is activated only after it finished installing, which means its complete file set is precached: old or new,
 *     never a mix. A failed install keeps the old version running.
 *   - Every failure (offline, HTTP error, bad data, timeout) ends in a calm message; the running version keeps working.
 *   - User data (favorites, campus, filters, preferences, cached schedules) lives in localStorage and is untouched by a reload. */
export const GUARD_KEY = 'openroom-update-guard';
export const VERSION_RE = /^[0-9a-f]{6,64}$/;

export class UpdateError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; } // kind: offline | http | invalid
}
/** version.json text -> version string or null */
export function parseVersionJson(text) {
  try { const v = JSON.parse(text)?.version; return typeof v === 'string' && VERSION_RE.test(v) ? v : null; } catch { return null; }
}
/** 'unsupported' (no usable running version, e.g. local dev), 'current' or 'different'. A DIFFERENT version also covers a rollback. */
export function compareVersions(running, remote) {
  if (typeof running !== 'string' || !VERSION_RE.test(running) || typeof remote !== 'string' || !VERSION_RE.test(remote)) return 'unsupported';
  return running === remote ? 'current' : 'different';
}
/** Fetches the deployed version. Network failures are 'offline'; everything else is a precise error. */
export async function fetchDeployedVersion(fetchFn, {timeoutMs = 8000, timeout = ms => AbortSignal.timeout(ms)} = {}) {
  let response;
  try { response = await fetchFn('/version.json', {cache: 'no-store', headers: {Accept: 'application/json'}, signal: timeout(timeoutMs)}); }
  catch (error) { throw new UpdateError('offline', error?.name === 'TimeoutError' ? 'timed out' : 'network unavailable'); }
  if (!response.ok) throw new UpdateError('http', `HTTP ${response.status}`);
  const version = parseVersionJson(await response.text());
  if (!version) throw new UpdateError('invalid', 'unreadable version file');
  return version;
}

const withTimeout = (promise, ms, fallback) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);

/** Resolves with a worker that finished installing (reg.waiting), or null (nothing new, install failed, or timeout). */
export async function findInstalledWorker(registration, timeoutMs = 30000) {
  if (registration.waiting) return registration.waiting;
  const installing = registration.installing;
  if (!installing) return null;
  return withTimeout(new Promise(resolve => {
    const done = () => {
      if (installing.state === 'installed') resolve(registration.waiting ?? installing);
      else if (installing.state === 'redundant') resolve(null);
    };
    installing.addEventListener('statechange', done);
    done();
  }), timeoutMs, null);
}

/** True once per (session, target): the loop guard. */
function claimReload(env, target) {
  if (env.storage.get(GUARD_KEY) === target) return false;
  env.storage.set(GUARD_KEY, target);
  return true;
}

/** Activates a waiting worker and reloads exactly once when it takes control. */
export async function applyWaiting(env, target) {
  const registration = await env.getRegistration();
  const worker = registration?.waiting;
  if (!worker) return {outcome: 'none'};
  if (!claimReload(env, target)) return {outcome: 'pending'};
  const changed = env.waitForControllerChange(10000); // armed BEFORE the message is sent: no race
  worker.postMessage({type: 'SKIP_WAITING'});
  if (await changed) { env.reload(); return {outcome: 'reloading'}; }
  return {outcome: 'pending'};
}

/** The user-triggered check (pull to refresh or the Refresh button). Never throws. */
export async function checkAndApply(env) {
  if (compareVersions(env.running, env.running) === 'unsupported') return {outcome: 'unsupported'};
  let remote;
  try { remote = await env.fetchVersion(); }
  catch (error) { return {outcome: error?.kind === 'offline' ? 'offline' : 'failed'}; }
  if (compareVersions(env.running, remote) === 'current') return {outcome: 'current', remote};
  const registration = await env.getRegistration();
  if (!registration) { // no service worker (unsupported or not registered): a plain reload fetches the new files
    if (!claimReload(env, remote)) return {outcome: 'pending', remote};
    env.reload();
    return {outcome: 'reloading', remote};
  }
  try { await registration.update(); } catch { return {outcome: 'failed', remote}; }
  const worker = await findInstalledWorker(registration, env.installTimeoutMs ?? 30000);
  if (!worker) return {outcome: 'failed', remote};
  return {...(await applyWaiting(env, remote)), remote};
}

/** At launch: clears the guard once an update arrived, and applies an update that finished installing while the app was closed.
 * Happens at most once per session, before the user has done anything. */
export async function applyOnLaunch(env) {
  const guard = env.storage.get(GUARD_KEY);
  if (guard && guard === env.running) env.storage.remove(GUARD_KEY); // the update we reloaded for is now running
  const registration = await env.getRegistration();
  if (!registration?.waiting) return {outcome: 'none'};
  if (env.storage.get(GUARD_KEY)) return {outcome: 'pending'}; // already tried in this session
  return applyWaiting(env, 'waiting');
}

export const UPDATE_MESSAGES = {
  unsupported: '',
  current: 'App is up to date',
  offline: "You're offline — couldn't check for a new version",
  failed: "Couldn't check for a new version",
  reloading: 'Updating the app…',
  pending: 'A new version is ready. Close and reopen the app to finish updating.'
};
