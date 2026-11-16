/** Conservative upstream access to ETH Rauminfo: TTL cache, in-flight de-duplication and a request scheduler.
 *
 * IMPORTANT: all state here lives in the memory of ONE Node process. On serverless hosting (e.g. Vercel) each
 * instance has its own cache, queue and cooldown, so these protections are only best-effort there; see README.
 */
const num = (name, fallback) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(value) && value >= 0 ? value : fallback;
};
/** Read lazily so tests (and operators) can change env values without reloading the module. */
export function config() {
  return {
    endpoint: process.env.ETH_ENDPOINT || 'https://ethz.ch/bin/ethz/roominfo',
    cacheTtlMs: num('ETH_CACHE_TTL_MS', 600_000),            // successful room/week responses
    verifyTtlMs: num('ETH_VERIFY_TTL_MS', 86_400_000),       // "room exists" answers
    notFoundTtlMs: num('ETH_NOT_FOUND_TTL_MS', 600_000),     // "room does not exist" answers
    unverifiedTtlMs: num('ETH_UNVERIFIED_TTL_MS', 30_000),   // empty result whose room check itself failed
    maxCacheEntries: num('ETH_CACHE_MAX_ENTRIES', 500),
    minIntervalMs: num('ETH_MIN_INTERVAL_MS', 1000),         // spacing between upstream request starts
    lowRemaining: num('ETH_LOW_REMAINING', 5),               // slow down at or below this x-ratelimit-remaining
    lowIntervalMs: num('ETH_LOW_INTERVAL_MS', 5000),
    maxQueueWaitMs: num('ETH_MAX_QUEUE_WAIT_MS', 20_000),    // reject instead of queueing longer than this
    defaultCooldownMs: num('ETH_DEFAULT_COOLDOWN_MS', 60_000), // used on 429 without Retry-After
    maxCooldownMs: num('ETH_MAX_COOLDOWN_MS', 900_000)
  };
}

export class UpstreamError extends Error {
  constructor(status, message, {retryAfter = null, code = 'upstream'} = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter; // seconds
    this.code = code;
  }
}

// ---------- TTL cache ----------
const cache = new Map();
export function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) { cache.delete(key); return undefined; }
  return hit.value;
}
export function cacheSet(key, value, ttlMs) {
  if (!(ttlMs > 0)) return;
  const {maxCacheEntries} = config();
  cache.delete(key);
  cache.set(key, {value, expires: Date.now() + ttlMs});
  if (cache.size > maxCacheEntries) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value); // oldest first
  }
}

// ---------- in-flight de-duplication ----------
const inflight = new Map();
export function dedupe(key, factory) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(factory).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// ---------- scheduler ----------
const sched = {nextSlotAt: 0, cooldownUntil: 0, strikes: 0, lastRemaining: null};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseRetryAfter(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
export function rateLimitedError() {
  const retryAfter = Math.max(1, Math.ceil((sched.cooldownUntil - Date.now()) / 1000));
  return new UpstreamError(503, 'ETH rate limit reached; try again later', {retryAfter, code: 'rate_limited'});
}

/** Run `task` (which performs ONE upstream request) in the next free slot. Requests are spaced out, never bursted. */
export async function scheduled(task) {
  const cfg = config();
  const now = Date.now();
  if (now < sched.cooldownUntil) throw rateLimitedError();
  const startAt = Math.max(now, sched.nextSlotAt);
  if (startAt - now > cfg.maxQueueWaitMs) {
    throw new UpstreamError(503, 'Too many pending ETH requests; try again shortly', {retryAfter: Math.ceil((startAt - now) / 1000), code: 'busy'});
  }
  sched.nextSlotAt = startAt + cfg.minIntervalMs;
  if (startAt > now) await sleep(startAt - now);
  if (Date.now() < sched.cooldownUntil) throw rateLimitedError(); // a 429 arrived while this request waited
  return task();
}

/** Feed every upstream response through here: honours Retry-After and x-ratelimit-remaining. No refill window is assumed. */
export function noteResponse(response) {
  const cfg = config();
  const now = Date.now();
  const header = name => response?.headers?.get?.(name) ?? null;
  const remainingHeader = header('x-ratelimit-remaining');
  const remaining = remainingHeader === null || remainingHeader === '' ? NaN : Number(remainingHeader);
  sched.lastRemaining = Number.isFinite(remaining) ? remaining : null;
  const retryAfterMs = parseRetryAfter(header('retry-after'));
  if (response.status === 429 || (response.status === 503 && retryAfterMs !== null)) {
    sched.strikes += 1;
    const backoff = cfg.defaultCooldownMs * 2 ** (sched.strikes - 1); // repeated 429s back off exponentially
    const wait = Math.min(cfg.maxCooldownMs, retryAfterMs ?? backoff);
    sched.cooldownUntil = Math.max(sched.cooldownUntil, now + wait);
    return;
  }
  if (response.ok) sched.strikes = 0;
  if (Number.isFinite(remaining)) {
    if (remaining <= 0) sched.cooldownUntil = Math.max(sched.cooldownUntil, now + cfg.defaultCooldownMs);
    else if (remaining <= cfg.lowRemaining) sched.nextSlotAt = Math.max(sched.nextSlotAt, now + cfg.lowIntervalMs);
  }
}
export function schedulerStatus() {
  return {cooldownUntil: sched.cooldownUntil, nextSlotAt: sched.nextSlotAt, strikes: sched.strikes, lastRemaining: sched.lastRemaining};
}

export function _resetForTests() {
  cache.clear(); inflight.clear();
  Object.assign(sched, {nextSlotAt: 0, cooldownUntil: 0, strikes: 0, lastRemaining: null});
}
