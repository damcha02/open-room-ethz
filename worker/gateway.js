/** ETH gateway: the single, globally shared coordination point for every upstream request.
 *
 * It runs inside ONE SQLite-backed Durable Object (see worker/index.js), so all users share:
 *   - the schedule cache (about five minutes, original fetch time kept),
 *   - in-flight request de-duplication,
 *   - request spacing and the ETH rate-limit cooldown (both persisted),
 *   - a hard daily budget of upstream requests (persisted, atomic).
 *
 * Portable by design: it only needs `sql.exec(query, ...bindings)` returning a cursor with `toArray()` (the Durable Object SQL API,
 * or the small adapter used by the Node tests), a `fetchFn`, a clock and a `sleep`. All SQL statements between two `await`s run
 * without interleaving, which is what makes the budget check-and-increment atomic: concurrent requests cannot bypass it.
 *
 * Rules that never bend:
 *   - ETH is a fixed, trusted upstream (config.endpoint is chosen by the deployer, never by a request).
 *   - A failure is never turned into a schedule. Answers always say how old the ORIGINAL ETH data is (`ageMs`).
 *   - When ETH cannot or may not be asked, only a stored schedule can be returned, with its true age (stale ones are marked).
 */
import {
  OFFICIAL_ENDPOINT, UpstreamError, allocationsParams, roomDetailsParams, upstreamUrl, upstreamInit, readLimitedText, parseAllocations,
  interpretRoomDetails, serveBody, cacheControlFor, errorPayload
} from '../lib/allocations-core.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS alloc_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS room_cache (room TEXT PRIMARY KEY, exists_flag INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS limiter (id INTEGER PRIMARY KEY CHECK (id = 1), next_slot_at INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, last_remaining INTEGER)',
  'INSERT OR IGNORE INTO limiter (id) VALUES (1)',
  'CREATE TABLE IF NOT EXISTS budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0)'
];

const num = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== null && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};
/** Builds the gateway configuration from Worker vars. Every value has a conservative default. */
export function gatewayConfig(env = {}, endpoint = OFFICIAL_ENDPOINT) {
  return {
    endpoint,                                                           // fixed, trusted upstream (see resolveEndpoint in worker/router.js)
    cacheTtlMs: num(env.ETH_CACHE_TTL_MS, 300_000),                     // successful room/week answers: 5 minutes
    verifyTtlMs: num(env.ETH_VERIFY_TTL_MS, 86_400_000),                // "room exists"
    notFoundTtlMs: num(env.ETH_NOT_FOUND_TTL_MS, 600_000),              // "room does not exist"
    unverifiedTtlMs: num(env.ETH_UNVERIFIED_TTL_MS, 30_000),            // empty answer whose existence check failed
    maxStaleMs: num(env.ETH_MAX_STALE_MS, 3_600_000),                   // oldest stored answer that may still be shown (marked stale)
    minIntervalMs: num(env.ETH_MIN_INTERVAL_MS, 1000),                  // spacing between upstream request starts, globally
    lowRemaining: num(env.ETH_LOW_REMAINING, 5),                        // slow down at/below this x-ratelimit-remaining
    lowIntervalMs: num(env.ETH_LOW_INTERVAL_MS, 5000),
    maxQueueWaitMs: num(env.ETH_MAX_QUEUE_WAIT_MS, 8000),               // refuse instead of queueing longer than this
    defaultCooldownMs: num(env.ETH_DEFAULT_COOLDOWN_MS, 60_000),        // 429 without Retry-After
    maxCooldownMs: num(env.ETH_MAX_COOLDOWN_MS, 900_000),
    dailyBudget: num(env.ETH_DAILY_BUDGET, 200),                        // upstream requests per UTC day: a safety ceiling, not a target
    maxCacheRows: num(env.ETH_MAX_CACHE_ROWS, 600)
  };
}

const parseRetryAfter = value => {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
};

export class Gateway {
  constructor({sql, cfg, fetchFn = (...a) => fetch(...a), now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms))}) {
    this.sql = sql; this.cfg = cfg; this.fetchFn = fetchFn; this.now = now; this.sleep = sleep;
    this.inflight = new Map();
    for (const statement of SCHEMA) this.sql.exec(statement);
  }
  rows(query, ...bindings) { return this.sql.exec(query, ...bindings).toArray(); }

  // ---------- budget (persistent, atomic) ----------
  utcDay() { return new Date(this.now()).toISOString().slice(0, 10); }
  budgetUsed() { return this.rows('SELECT used FROM budget WHERE day = ?', this.utcDay())[0]?.used ?? 0; }
  budgetAvailable() { return this.budgetUsed() < this.cfg.dailyBudget; }
  /** Check-and-increment in one statement: two concurrent requests can never both take the last unit. */
  consumeBudget() {
    const day = this.utcDay();
    this.sql.exec('INSERT OR IGNORE INTO budget (day, used) VALUES (?, 0)', day);
    const taken = this.rows('UPDATE budget SET used = used + 1 WHERE day = ? AND used < ? RETURNING used', day, this.cfg.dailyBudget);
    this.sql.exec('DELETE FROM budget WHERE day < ?', new Date(this.now() - 7 * 86_400_000).toISOString().slice(0, 10));
    return taken.length > 0;
  }
  budgetError() {
    const tomorrow = Date.parse(`${this.utcDay()}T00:00:00Z`) + 86_400_000;
    return new UpstreamError(503, 'Daily ETH request budget used up; try again after 00:00 UTC', {retryAfter: Math.max(1, Math.ceil((tomorrow - this.now()) / 1000)), code: 'budget_exhausted'});
  }

  // ---------- limiter: spacing and cooldown (persistent, shared by all users) ----------
  limiter() { return this.rows('SELECT next_slot_at, cooldown_until, strikes, last_remaining FROM limiter WHERE id = 1')[0]; }
  saveLimiter(l) { this.sql.exec('UPDATE limiter SET next_slot_at = ?, cooldown_until = ?, strikes = ?, last_remaining = ? WHERE id = 1', l.next_slot_at, l.cooldown_until, l.strikes, l.last_remaining ?? null); }
  rateLimitedError() {
    const l = this.limiter();
    return new UpstreamError(503, 'ETH rate limit reached; try again later', {retryAfter: Math.max(1, Math.ceil((l.cooldown_until - this.now()) / 1000)), code: 'rate_limited'});
  }
  /** Reserves the next free start slot. Requests are spaced out globally, never bursted; waiting is bounded. */
  async slot() {
    const now = this.now(), l = this.limiter();
    if (now < l.cooldown_until) throw this.rateLimitedError();
    const startAt = Math.max(now, l.next_slot_at);
    if (startAt - now > this.cfg.maxQueueWaitMs) {
      throw new UpstreamError(503, 'Too many pending ETH requests; try again shortly', {retryAfter: Math.max(1, Math.ceil((startAt - now) / 1000)), code: 'busy'});
    }
    this.saveLimiter({...l, next_slot_at: startAt + this.cfg.minIntervalMs});
    if (startAt > now) await this.sleep(startAt - now);
    if (this.now() < this.limiter().cooldown_until) throw this.rateLimitedError(); // a 429 arrived while this request waited
  }
  /** Honours Retry-After and x-ratelimit-remaining. No refill window is assumed. */
  noteResponse(response) {
    const cfg = this.cfg, now = this.now(), l = this.limiter();
    const header = name => response.headers?.get?.(name) ?? null;
    const remainingHeader = header('x-ratelimit-remaining');
    const remaining = remainingHeader === null || remainingHeader === '' ? NaN : Number(remainingHeader);
    l.last_remaining = Number.isFinite(remaining) ? remaining : null;
    const retryAfterMs = parseRetryAfter(header('retry-after'));
    if (response.status === 429 || (response.status === 503 && retryAfterMs !== null)) {
      l.strikes += 1;
      const wait = Math.min(cfg.maxCooldownMs, retryAfterMs ?? cfg.defaultCooldownMs * 2 ** (l.strikes - 1));
      l.cooldown_until = Math.max(l.cooldown_until, now + wait);
    } else {
      if (response.ok) l.strikes = 0;
      if (Number.isFinite(remaining)) {
        if (remaining <= 0) l.cooldown_until = Math.max(l.cooldown_until, now + cfg.defaultCooldownMs);
        else if (remaining <= cfg.lowRemaining) l.next_slot_at = Math.max(l.next_slot_at, now + cfg.lowIntervalMs);
      }
    }
    this.saveLimiter(l);
  }

  /** ONE upstream GET: budget pre-check, global slot, atomic budget use, fetch, rate-limit bookkeeping. */
  async upstream(params, accept) {
    if (!this.budgetAvailable()) throw this.budgetError();
    await this.slot();
    if (!this.consumeBudget()) throw this.budgetError();
    let response;
    try {
      response = await this.fetchFn(upstreamUrl(this.cfg.endpoint, params), upstreamInit(accept));
    } catch (error) {
      throw new UpstreamError(502, error?.name === 'TimeoutError' ? 'ETH did not respond in time' : 'ETH request failed');
    }
    this.noteResponse(response);
    if (response.status === 429) throw this.rateLimitedError();
    if (!response.ok) throw new UpstreamError(502, `ETH returned HTTP ${response.status}`);
    return response;
  }

  // ---------- room existence ----------
  /** true / false, or null when the check itself failed (never guessed). */
  verifyRoom(room) {
    const now = this.now();
    const known = this.rows('SELECT exists_flag FROM room_cache WHERE room = ? AND expires_at > ?', room, now)[0];
    if (known) return Promise.resolve(known.exists_flag === 1);
    return this.dedupe(`verify|${room}`, async () => {
      try {
        const response = await this.upstream(roomDetailsParams(room), 'application/json');
        const exists = interpretRoomDetails(response.headers.get('content-type'), await readLimitedText(response), room);
        if (exists !== null) {
          const ttl = exists ? this.cfg.verifyTtlMs : this.cfg.notFoundTtlMs;
          this.sql.exec('INSERT OR REPLACE INTO room_cache (room, exists_flag, expires_at) VALUES (?, ?, ?)', room, exists ? 1 : 0, this.now() + ttl);
        }
        return exists;
      } catch { return null; }
    });
  }

  // ---------- allocations ----------
  dedupe(key, factory) {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(factory).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
  storedAllocations(key) { return this.rows('SELECT body, fetched_at, expires_at FROM alloc_cache WHERE key = ?', key)[0] ?? null; }
  storeAllocations(key, body, ttlMs) {
    const now = this.now();
    this.sql.exec('INSERT OR REPLACE INTO alloc_cache (key, body, fetched_at, expires_at) VALUES (?, ?, ?, ?)', key, JSON.stringify(body), Date.parse(body.fetchedAt), now + ttlMs);
    this.sql.exec('DELETE FROM alloc_cache WHERE fetched_at < ?', now - this.cfg.maxStaleMs);
    const count = this.rows('SELECT COUNT(*) AS n FROM alloc_cache')[0].n;
    if (count > this.cfg.maxCacheRows) this.sql.exec('DELETE FROM alloc_cache WHERE key IN (SELECT key FROM alloc_cache ORDER BY fetched_at ASC LIMIT ?)', count - this.cfg.maxCacheRows);
    this.sql.exec('DELETE FROM room_cache WHERE expires_at < ?', now);
  }

  /** Cached + de-duplicated allocations for one room/week. When ETH cannot or may not be asked (budget, cooldown, queue, error)
   * only a STORED answer is returned, with its true age and a stale marker; otherwise the error is passed on. */
  async getAllocations(room, from, to) {
    const key = `alloc|${room}|${from}|${to}`;
    const stored = this.storedAllocations(key);
    if (stored && stored.expires_at > this.now()) return serveBody(JSON.parse(stored.body), true, this.now());
    return this.dedupe(key, async () => {
      try {
        const response = await this.upstream(allocationsParams(room, from, to));
        if (!/json/i.test(response.headers.get('content-type') || '')) throw new UpstreamError(502, 'ETH did not return JSON');
        const allocations = parseAllocations(await readLimitedText(response));
        // A non-empty result proves the room exists. An empty one proves nothing (ETH answers 200 [] for unknown rooms).
        const roomVerified = allocations.length > 0 ? true : await this.verifyRoom(room);
        const body = {room, from, to, allocations, roomVerified, source: 'ETH Rauminfo', fetchedAt: new Date(this.now()).toISOString()};
        this.storeAllocations(key, body, roomVerified === null ? this.cfg.unverifiedTtlMs : this.cfg.cacheTtlMs);
        return serveBody(body, false, this.now());
      } catch (error) {
        const old = this.storedAllocations(key);
        if (old && error instanceof UpstreamError && this.now() - old.fetched_at <= this.cfg.maxStaleMs) {
          const body = JSON.parse(old.body);
          if (body.roomVerified === true) return serveBody(body, true, this.now(), {stale: true, staleReason: error.code});
        }
        throw error;
      }
    });
  }

  /** The complete HTTP-level answer for one request (also the Durable Object's RPC result). Never throws. */
  async handleAllocations(room, from, to) {
    try {
      const body = await this.getAllocations(room, from, to);
      return {status: 200, body, cacheControl: cacheControlFor(body, this.cfg.cacheTtlMs, body.stale === true), headers: {}};
    } catch (error) {
      const failure = errorPayload(error);
      return {status: failure.status, body: failure.body, cacheControl: 'no-store', headers: failure.headers};
    }
  }

  /** Read-only operational status (no secrets). */
  status() {
    const l = this.limiter(), now = this.now();
    return {
      day: this.utcDay(), budgetUsed: this.budgetUsed(), budgetLimit: this.cfg.dailyBudget,
      cooldownSeconds: Math.max(0, Math.ceil((l.cooldown_until - now) / 1000)), strikes: l.strikes, lastRemaining: l.last_remaining,
      cachedSchedules: this.rows('SELECT COUNT(*) AS n FROM alloc_cache')[0].n, cacheTtlMs: this.cfg.cacheTtlMs
    };
  }
}
