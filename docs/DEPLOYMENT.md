# Deployment: Open Room ETHZ on Cloudflare Workers Free

Production URL: https://open-room-ethz.danil-poluyanov13.workers.dev
Repository: https://github.com/damcha02/open-room-ethz

This document describes what is deployed, what it costs (nothing, by design), how to operate it, and what is *not* verified.

## 1. What is deployed

| Resource | Name | Notes |
|---|---|---|
| Worker (with static assets) | `open-room-ethz` | `worker/index.js`; static files from `public/` |
| Durable Object class | `EthGateway` | **SQLite-backed**, one global instance named `global` |
| URL | `https://open-room-ethz.<account-subdomain>.workers.dev` | the free `workers.dev` subdomain; no custom domain |

Nothing else exists: no KV, D1, R2, Queues, Workers AI, Analytics Engine, Logpush, custom domain, paid add-on or secret. `wrangler.jsonc` contains no credentials, and no account ID is stored in the repository.

### Request routing

- **Static files** (`/`, `/app.js`, icons, `manifest.webmanifest`, `sw.js`, …) are served by Workers Static Assets **without running the Worker**. Requests to static assets are documented as free and unlimited, so the app shell stays available even when API quotas run out.
- **`/api/*`** always runs the Worker (`assets.run_worker_first: ["/api/*"]`). The Worker validates the request, then calls the Durable Object.
- A path that matches no file and is not `/api/*` reaches the Worker, which hands it to the assets binding (a 404 page). This is the only case where a non-API request runs the Worker; the docs describe no way to avoid it.
- Static-asset security headers (CSP, nosniff, frame denial, referrer policy, HSTS) come from `public/_headers`.

## 2. The ETH gateway (Durable Object)

One global instance gives every user the same cache and the same limits.

| Concern | Behavior |
|---|---|
| Schedule cache | About 5 minutes (`ETH_CACHE_TTL_MS`), persisted in SQLite. The original ETH fetch time is kept; every response carries `fetchedAt` and `ageMs`, so caching never makes data look younger. |
| De-duplication | Concurrent identical requests share one upstream request (in the Durable Object, which is single-threaded). |
| Spacing | Upstream requests start at least `ETH_MIN_INTERVAL_MS` (1 s) apart, globally. The waiting queue is bounded (`ETH_MAX_QUEUE_WAIT_MS`, 8 s); beyond it the answer is `503 busy` + `Retry-After`. |
| Rate limits | `429` or `Retry-After` starts a global cooldown (persisted). Without `Retry-After`: 60 s, doubling on repeats, capped at 15 min. `x-ratelimit-remaining` ≤ 5 slows spacing to 5 s; 0 starts a cooldown. No refill window is assumed. |
| **Daily budget** | `ETH_DAILY_BUDGET` upstream requests per **UTC day**, default **200**, counted persistently and atomically. A schedule request and a room-existence check each count. It is a safety ceiling, not a target. |
| When ETH cannot or may not be asked (budget used up, cooldown, queue full, upstream error) | ETH is not called. A **stored** schedule is returned with its true age and `stale: true, staleReason: …` (the app shows it as Stale after 10 minutes, and drops it after 1 hour). Otherwise `503`/`502` with no schedule. A failure is never turned into a schedule, and nothing is ever reported as free. |
| Fixed upstream | `https://ethz.ch/bin/ethz/roominfo`. A test endpoint is accepted only when `ALLOW_TEST_UPSTREAM=1` and only on localhost; production never sets it. |

Operational status (no secrets): `GET /api/status` returns the day, budget used/limit, cooldown seconds, strikes, last `x-ratelimit-remaining` and the number of cached schedules.

### Changing the budget

Edit `vars` in `wrangler.jsonc` (for example `"ETH_DAILY_BUDGET": "300"`), then `npm run deploy`. A lower value is always safe; the app then shows more data as Stale or unavailable.

## 3. Free-plan limits and what happens at the limit

Read from Cloudflare's official pages on 2026-11-17 (Workers limits and pricing, Static Assets billing, Durable Objects pricing and limits). Re-check them before relying on a number; they can change.

| Resource (Free plan) | Limit |
|---|---|
| Worker requests | 100,000 per day (resets 00:00 UTC) |
| Worker CPU time | 10 ms per request |
| Static asset requests | free and unlimited |
| SQLite-backed Durable Objects | available on Free (the key-value backend is Paid only) |
| Durable Object requests | 100,000 per day |
| Durable Object duration | 13,000 GB-s per day |
| SQLite rows read / written | 5 million / 100,000 per day |
| SQLite storage | 5 GB per account |

At the limit, operations **fail with errors**; the pages say nothing about charges on Free. Specifically: Worker requests over the daily limit get Error 1027, a `run_worker_first` route over quota gets a `429`, and Durable Object operations over a limit fail with an error. The app handles all of these: the API answers `503` (`gateway_unavailable`), which the app shows as unavailable or Stale, never as free.

### Capacity for this app

One API call = one Worker request + one Durable Object request. A first visit makes at most 6 schedule calls, mode switches and cached room openings make none, and there is no polling (see `docs/REQUEST_TRIGGERS.md`). Even 10 API calls per visit allows about 10,000 visits per day inside the 100,000-request quotas, while ETH sees at most the configured daily budget. Row use is tiny: a cache hit is one read; an upstream request is about six writes.

## 4. Cost and billing risk

- **Plan:** Workers Free. Nothing in this repository requires a payment method or a paid plan, and the only way this deployment can be billed is by upgrading the account to Workers Paid.
- **Do not:** upgrade the plan, buy a domain, or add paid or usage-based resources.
- **Verification status:** the Free plan could not be confirmed from the command line (Wrangler shows the account, not the subscription). Confirm in the dashboard under *Workers & Pages → Plans* that the account says **Free**.

## 5. Deploying and operating

```bash
npm ci
npm test && npm run test:worker && npm run test:e2e   # all mock-based
npx wrangler login                                      # once; interactive, stores a token outside the repo
npm run deploy                                          # wrangler deploy
npx wrangler tail                                       # live logs (free)
npx wrangler rollback                                   # back to the previous version
```

The Durable Object schema is created by the code (`CREATE TABLE IF NOT EXISTS`); the single migration `v1` declares the SQLite-backed class.

Static assets revalidate on every load (`Cache-Control: public, max-age=0, must-revalidate` with ETags), so a new deployment reaches installed apps on their next launch. When shell files change in a way that must reach installed apps, bump `CACHE` in `public/sw.js` (old caches are deleted on activation).

## 6. Cloudflare Access (restricting the app to your email)

**Not enabled.** What the documentation and my investigation show:

- Cloudflare's docs say Access can protect `workers.dev` URLs (production, preview and version URLs).
- The pages I read do **not** state the Free-plan terms of Zero Trust (user limit, whether a payment method must be on file) or how Access behaves with PWAs and service workers.
- They do say that, once an Access session expires, Access **can block `fetch` sub-requests without prompting the user**, and that AJAX requests can be made to receive a `401` instead by sending `X-Requested-With: XMLHttpRequest`. The default session length is 24 hours.
- My assessment (reasoning, not verified): in an installed iPhone app the login would redirect to `<team>.cloudflareaccess.com` inside the standalone window; after the session lapses, the app's API calls would fail until the next page navigation. The app would show schedules as unavailable (never free), but the experience would degrade.

Because enabling Access needs your account authorization and may involve a payment method, I did not set it up. **If you want it:** in the dashboard open *Workers & Pages → open-room-ethz → Settings → Domains & Routes → workers.dev → Enable Cloudflare Access*, complete the Zero Trust onboarding **only if it does not ask for payment details**, and add an *Allow* policy with **your own email address** (enter it yourself). Then test the installed app on your phone for a day, including after the 24-hour session expires. If anything misbehaves, disable Access again; nothing in the app depends on it.

**Current state:** the URL is public. Protection against abuse is the global daily budget, bounded queues, input validation, the fixed upstream and the free-plan quotas that stop service instead of billing.

## 7. ETH permission

Automated use of ETH Rauminfo has not been explicitly approved by ETH. The endpoint is undocumented and may change or restrict automated traffic, and its rate limit is not a published contractual limit. This deployment keeps ETH traffic minimal, identifies itself with a descriptive `User-Agent` linking to the repository, honours `429`/`Retry-After`, and never bypasses a limit. Please ask ETH whether this use is acceptable and whether they prefer a different interface or limit.

## 8. Installing the PWA

- **iPhone (Safari only):** open the production URL → Share → *Add to Home Screen* → *Add*. Launch from the home-screen icon (standalone, no browser bar).
- **Android (Chrome):** open the URL → menu ⋮ → *Install app*. 
- Offline: after one online visit the app shell and previously loaded fresh schedules work without a connection; expired schedules are shown as Stale and never recommended.
- Updates arrive on the next launch; fully closing and reopening the app applies them.

## 9. Abuse and budget exhaustion (known limitation of a public URL)

The URL is public and `/api/allocations` accepts any well-formed room code, so a third party could spend the daily budget by requesting many different (even non-existent) rooms: each unknown room costs one schedule request plus one room check. The effect is **availability, not cost**: ETH never sees more than `ETH_DAILY_BUDGET` requests per UTC day, cached schedules and stored (Stale-marked) schedules keep being served, and nothing is ever shown as free. Possible hardening, not implemented: a separate small daily budget for rooms outside `public/rooms.json`, or restricting access with Cloudflare Access (section 6).

## 10. Verification record (2026-11-17)

- Deployed version `0ad748da-defa-469a-8587-de71cb1dfb35` of commit `a3858e9` with `wrangler deploy` (19 static files, Worker startup 5 ms).
- Right after a deployment, individual static files can answer 404 for a few seconds while the edge catches up (observed once: `/app.js`, `/timeline.mjs`). The service worker never caches non-2xx responses, so nothing wrong persists.
- Static files and `/manifest.webmanifest` are served without running the Worker; `/api/*` runs the Worker; security headers and CSP are present on the homepage.
- Live ETH check through the production API: HG E 27, CHN C 14 and HCI D 2 returned verified schedules (23, 27 and 38 entries; types 2, 5, 8 and 13 seen), a repeat request was a cache hit keeping the original `fetchedAt`, invalid input and POST never reached ETH. 8 upstream requests were used that day (3 manual + 5 from one real first visit in a browser).
- Real-browser check of the production origin (headless Chromium, 375 px): HTTPS secure context, service worker active and controlling with scope `/`, one versioned cache and no `/api/` entry in it, manifest without errors, **no installability errors**, no console or CSP errors, mode switches and opening a room made 0 API requests. First render about 0.4 s, first recommendation about 0.65 s, homepage TTFB about 0.13 s, 49 KB of static transfer.
- Offline behavior (app shell from the service worker, cached fresh schedules, Stale handling, no `/api/` caching) was verified against the identical build by stopping the server in the browser tests; it was not repeated against production.
- Not verified: installation on a physical iPhone or Android phone (only Chromium's installability check and the iOS metadata were verified), the Cloudflare plan (see section 4), Cloudflare Access (section 6).
