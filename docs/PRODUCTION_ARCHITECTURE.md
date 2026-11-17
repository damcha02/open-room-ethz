# Proposed production architecture (design only — not implemented)

Status: **proposal**. Nothing in this document exists in the repository yet. The current Node backend (`server.mjs`,
`api/allocations.js`, `lib/eth-client.js`) is unchanged and remains the reference implementation.

Priorities, in order: **1. smooth mobile UX, 2. zero unexpected hosting cost, 3. minimal ETH traffic, 4. accurate availability.**

> **Platform numbers.** Free-plan quotas change. This document deliberately does not hard-code Cloudflare limits.
> Before building, read the *current* "Limits" and "Pricing" pages for Workers, Workers Static Assets and Durable Objects, and
> put the numbers you rely on into `wrangler.jsonc` vars and the budget table below. Items marked **(verify)** are
> assumptions that must be checked.

## 1. Why the current backend does not scale beyond one process

`lib/eth-client.js` keeps the response cache, in-flight de-duplication, request spacing and the 429 cooldown in the memory of
one Node process. On any multi-instance or serverless host each instance has its own copy, so the *global* ETH request rate is
not bounded and caching is mostly cold. A production deployment needs **one shared place** for: the reservation cache,
request de-duplication, the ETH rate limiter and the cooldown state.

## 2. Target architecture (Cloudflare, Free plan)

```
 phone (PWA, unchanged)
   │  static files                         /api/allocations?room=…&from=…&to=…
   ▼                                        ▼
 Workers Static Assets  ◄── same Worker ──► Worker (stateless router: validation, shaping, headers)
 (HTML, JS, CSS, rooms.json, icons)                │  one RPC per API call
                                                   ▼
                                  Durable Object "ETH-GATEWAY" (SQLite-backed, single global instance)
                                    • SQLite: allocation cache, room-existence cache, limiter state
                                    • in-memory: in-flight map (request de-duplication)
                                    • token bucket + daily budget + 429 cooldown
                                                   │  only on cache miss and only if budget allows
                                                   ▼
                                          ETH Rauminfo (read-only, unauthenticated)
```

### 2.1 Static Assets (the PWA)
- Serve `public/` with Workers Static Assets. Static asset requests are intended to be free and not count against Worker
  request quotas **(verify)**, so the app shell stays available even when the API quota is exhausted.
- Route only `/api/*` to the Worker (`assets.run_worker_first` for `/api/*`, or an equivalent routing rule).
- Keep `sw.js` caching only the static shell. Never cache `/api/` (already the case).

### 2.2 Worker (API)
- A small `fetch(request, env)` handler: validate method, `room`, `from`, `to` (reuse `validRoom`, `validDate`, the 7-day
  cap), forward to the Durable Object, add `Cache-Control`, `Retry-After`, `X-Content-Type-Options`.
- No state of its own. No secrets are needed (ETH is read without authentication).

### 2.3 Durable Object `ETH-GATEWAY` (SQLite-backed)
One global instance (name e.g. `"global"`), because the ETH budget is global. SQLite-backed objects are the storage backend
available on the Free plan **(verify)**.

SQLite tables (sketch):

| Table | Columns | Purpose |
|---|---|---|
| `allocations` | `room, from, to, body_json, fetched_at_ms, room_verified` | cache of successful responses; TTL from `fetched_at_ms` |
| `rooms` | `room, exists, checked_at_ms` | room-existence answers (long TTL for true, short for false) |
| `limiter` | `id=1, tokens, refilled_at_ms, cooldown_until_ms, strikes, day, day_count` | token bucket, cooldown and daily counter |

Behaviour (the same rules as today, made global):
1. **Cache first.** A hit returns `fetchedAt` and `ageMs = now − fetched_at` (never reset), exactly like `serve()` today. The
   TTL stays below the 10-minute freshness limit (default 5 minutes).
2. **De-duplicate.** Concurrent misses for the same key share one in-memory promise inside the object (the object is
   single-threaded, so this is race-free).
3. **Budget.** A miss may call ETH only if the token bucket has a token **and** the daily counter is under
   `ETH_DAILY_BUDGET`. Otherwise answer `503` + `Retry-After` immediately (see 3.2: no long sleeping queues).
4. **Cooldown.** `429`, or `x-ratelimit-remaining` at 0, or `Retry-After` from ETH sets `cooldown_until_ms` (exponential
   without `Retry-After`, as in `noteResponse`). During a cooldown no ETH call is made.
5. **Never serve old data as fresh.** If ETH cannot be asked, return `503` (the client shows "unavailable"/"rate limited").
   An optional "stale-if-error" response may be returned only with its true `ageMs`; the client already refuses to treat
   it as current.

### 2.4 Configurable global ETH budget
All values are Worker `vars` so they can be tightened without a deploy of code:

| Variable | Meaning | Suggested start |
|---|---|---|
| `ETH_BUCKET_CAPACITY` | burst size of the token bucket | 4 |
| `ETH_REFILL_PER_MINUTE` | steady ETH requests per minute, all users together | 20 (below the observed ETH window, which is unknown) |
| `ETH_DAILY_BUDGET` | hard daily cap on upstream requests | a few thousand |
| `ETH_CACHE_TTL_MS` | allocation cache TTL | 300000 |
| `ETH_DEFAULT_COOLDOWN_MS` / `ETH_MAX_COOLDOWN_MS` | 429 handling | 60000 / 900000 |

The ETH refill window is not documented; the budget is intentionally conservative and must not assume one.

## 3. Cost control: stop the service instead of paying

Goal: **no code path can generate a bill.**

### 3.1 Account setup rules
- Stay on the **Workers Free** plan; do not subscribe to Workers Paid and do not enable usage-based add-ons. On Free, an
  exhausted quota makes requests fail (errors) rather than charging **(verify in the current Limits docs)**.
- Use only Workers, Static Assets and a SQLite-backed Durable Object. Do **not** add R2, Queues, Workers AI, Analytics
  Engine, Logpush, paid KV/D1 tiers, third-party telemetry or any service with usage-based pricing.
- No payment method on the account unless it is unavoidable; if one is required, add Cloudflare billing notifications and a
  spending alert **(verify availability)**.

### 3.2 Design rules that keep usage inside the free quotas
- **Fail fast, never sleep.** The current Node scheduler *waits* (up to 20 s) for a free slot. On Workers, waiting inside a
  request keeps it open and consumes wall-clock time in the Durable Object. The Workers version must answer `503` with
  `Retry-After` immediately when no token is available; the browser already pauses its queue on `503`.
- **Cache aggressively at the edge of the object.** Every user request that hits the SQLite cache costs one Worker
  request plus one Durable Object request. Estimate the daily capacity as
  `min(Worker requests, Durable Object requests) / API calls per visit` (one visit ≈ 6–8 API calls) and compare it with
  the current free quotas **(verify)**. The app's own budget (≤ 6 schedule requests on a fresh visit, none for mode
  switches, no polling in hidden tabs) was designed with this limit in mind.
- **Budget in the object, not in the dashboard.** `ETH_DAILY_BUDGET` and a per-day request counter stop upstream traffic
  before ETH or Cloudflare limits do. Add a daily counter for *incoming* API requests too; when it exceeds a configured
  fraction of the free quota the Worker returns `503` for `/api/*` while the static app keeps working.
- **Degraded mode is a feature.** When the API is stopped, the PWA still loads (static assets), shows cached schedules as
  Stale where allowed, and says "Schedule unavailable" otherwise. It never shows unknown data as free.
- **Small payloads.** Keep the proxy's sanitising (it strips course details), which keeps SQLite rows and bandwidth small.
- **Row-count discipline.** SQLite reads/writes are quota-limited **(verify)**. Use one upsert per cache fill, prune
  expired rows with a single `DELETE … WHERE fetched_at_ms < ?` at most once per hour, and avoid per-request counters that
  write on every read (keep counters in memory and flush at most once per minute).

## 4. Migrating the current Node backend

### 4.1 What maps one-to-one
| Today | Workers |
|---|---|
| `api/allocations.js` validation (`validRoom`, `validDate`, 7-day cap, `validLocalTimestamp`) | unchanged, pure functions |
| `parseAllocations` (strict, fail-whole-response on malformed entries) | unchanged |
| `serve()` (`fetchedAt`, `ageMs`) | unchanged, inside the Durable Object |
| `verifyRoom` (room-details check only on `[]`) | unchanged, inside the Durable Object |
| `public/*` | Static Assets, unchanged |
| `lib/eth-client.js` cache / in-flight / scheduler / cooldown | rewritten inside the Durable Object (SQLite + in-memory map) |
| `server.mjs` | deleted (replaced by the Worker `fetch` handler and the assets binding) |

### 4.2 Required code changes
1. **Entry point:** replace `http.createServer` and the Express-style `(req, res)` handler with
   `export default { fetch(request, env, ctx) }` returning `Response` objects; read query parameters from `new URL(request.url)`.
2. **Configuration:** `process.env.*` becomes `env.*` (Worker vars). `config()` takes `env` as an argument.
3. **State:** module-level `Map`s and the `sched` object must move into the Durable Object class. Workers isolates are
   short-lived and many may run at once; module state is *not* shared and is *not* a cache you can rely on.
4. **Scheduler:** replace "reserve a slot and `await sleep()`" with a token bucket that returns an immediate decision
   (`ok` / `retryAfter`). Remove the 20-second queue wait.
5. **Time:** see 4.3 (Workers clock behaviour).
6. **Upstream fetch:** keep `redirect: 'manual'` and the 10-second `AbortSignal.timeout` **(verify support and that a manual
   redirect yields a readable 3xx response)**; keep sending no cookies or credentials.
7. **Headers:** keep `Cache-Control: public, max-age=0, s-maxage=<ttl>` or switch to `no-store`; the Worker can add the
   `Age` header so any shared cache is accounted for by the client (the client already adds `Age` to `ageMs`).
8. **Tests:** run the existing unit tests against the shared pure modules; add Worker/DO tests with the Workers Vitest pool
   or `wrangler dev` (local mode needs no account and no charges). The Node proxy tests keep running until the cut-over.
9. **Config files:** `wrangler.jsonc` with the assets directory, the `/api/*` routing, the Durable Object binding and the
   `new_sqlite_classes` migration; `vercel.json` is removed.

### 4.3 Compatibility limitations and traps
- **Not Node.** No `node:http`, `node:fs`, no `process`. `Intl.DateTimeFormat` with `timeZone: 'Europe/Zurich'` is available
  in the runtime, but confirm the DST tests (`wallToInstant`) pass inside the Workers runtime.
- **Clock behaviour.** In Workers, `Date.now()` does not advance during pure CPU work, only across I/O. The cache expiry and
  `ageMs` arithmetic are safe (they compare against I/O boundaries), but never use busy loops or CPU-time based timing.
- **No shared module state** (see 4.2). Anything that "worked because it was one process" must be re-checked: the in-flight
  map, the cooldown, the cache.
- **CPU limit per invocation** on the Free plan is small **(verify)**. Parsing and validating one week of one room is tiny,
  but do not parse bulk data in the Worker; keep the 1.5 MB response cap.
- **Durable Object throughput.** A single global object serialises work. At the app's traffic this is intended (it is what
  makes the budget global), but a hot object is a single point of contention; keep handlers short, never await slow I/O
  while holding other requests (ETH calls are the only slow I/O, and are de-duplicated).
- **Storage quotas.** SQLite row reads/writes and storage size are limited on Free **(verify)**; the cache holds at most a
  few thousand small rows.
- **Cold starts.** The first request after idle wakes the object and loads SQLite state; acceptable, but measure it.
- **Service worker and routing.** `/api/*` must be excluded from the PWA's offline cache and routed to the Worker first;
  everything else is a static asset.
- **Local development parity.** `wrangler dev` runs Durable Objects locally with local SQLite; behaviour around hibernation
  and quotas differs from production, so the quota-stop paths need explicit tests with low configured budgets.

### 4.4 Suggested rollout
1. Extract the pure parts (validation, parsing, `serve`, `describe…`) into a shared module used by both backends.
2. Implement the Durable Object and Worker behind `wrangler dev` only; run the same mock-ETH scenarios used by
   `e2e/` (cache, de-duplication, 429 cooldown, malformed entries, old-response ageing).
3. Add the low-budget tests: exhaust the bucket, the daily budget and the incoming-request counter and assert `503` +
   `Retry-After` and a still-working static app.
4. Deploy to a Free-plan account with the conservative budget; watch usage for a week using only the dashboard that is
   included in the plan (no telemetry subscriptions).
5. Only then point the production domain at it.

## 5. Risks and open questions
- **ETH permission and limits** are still unconfirmed with ETH. The global budget exists to make a policy conversation easy
  ("at most N requests per minute, all users together").
- **Free-plan quota changes** can lower the capacity; the budgets are configuration, not code.
- **Single global object** means a bug or a poisoned cache entry affects everyone; keep a kill switch (a var that forces
  `503` for `/api/*`) and cache only validated, sanitised bodies.
- **Visits per day** that exceed the free capacity will see "unavailable" instead of a bill. That is the intended trade-off.
