# Open Room ETHZ

> **Unofficial student project. Not affiliated with or endorsed by ETH Zürich. Room availability is based on ETH's published reservation data.**

Open Room ETHZ is a mobile-first progressive web app (PWA) that suggests ETH Zürich rooms with **no published reservation** right now, soon, or for the rest of the day, and shows each room's published schedule as a timeline. It reports **reservations, never physical occupancy**: a room that is "Free" here can still be locked, in use or unsuitable.

- **Live app:** https://open-room-ethz.danil-poluyanov13.workers.dev
- **Source:** https://github.com/damcha02/open-room-ethz
- **ETH logo:** the official ETH Zürich logo is deliberately **not** used (its use needs confirmation under ETH's logo guidelines). The app icon is a custom open-doorway design.

## Features

- **Free now / Free soon / Rest of day** recommendations for the selected campus (Zentrum or Hönggerberg), with an honest coverage line ("based on 8 of 64 listed rooms checked").
- **Favorites** from both campuses, always visible.
- **Room detail screen:** current status (Free / Booked / Blocked / Unknown), next change, freshness, day navigation and a proportional 24-hour timeline with a current-time line; tap a booking for course information.
- Browse buildings, search, week/day navigation, "free only" filter, manual room codes.
- Installable PWA, works offline for the app shell and previously cached schedules (marked Stale when old; never shown as current).
- No accounts, no tracking, no location, no cookies.

## Install on a phone

Open the live app in the phone's browser, then:

- **iPhone (Safari):** Share → **Add to Home Screen** → Add. (iOS only installs from Safari.)
- **Android (Chrome):** menu ⋮ → **Install app** (or **Add to Home screen**).

The home-screen label is "Open Room". More detail in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## How it works

```
phone (PWA)  ──▶  Cloudflare Workers Static Assets   public/ (HTML, JS, CSS, icons) — served WITHOUT running any code
      │
      └─ /api/*  ──▶  Worker  (validates the request, routes it)
                        └──▶  ONE SQLite-backed Durable Object  "ETH gateway"
                                • shared schedule cache (about five minutes, original fetch time kept)
                                • in-flight de-duplication, global request spacing, shared 429 cooldown
                                • persistent daily budget of upstream requests (default 200)
                                └──▶  ETH Rauminfo (read-only, unauthenticated, fixed upstream)
```

| Path | Purpose |
|---|---|
| `public/` | The PWA: `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, icons, `_headers`, `404.html`, `rooms.json` |
| `public/schedule.mjs`, `recommend.mjs`, `timeline.mjs`, `detail-view.mjs` | Pure logic: time/DST handling, recommendations, timeline geometry, markup builders |
| `lib/allocations-core.js` | Runtime-neutral API core shared by Node and the Worker: validation, strict parsing, room verification, age/cache headers |
| `worker/` | Cloudflare Worker (`router.js`, `index.js`) and the Durable Object logic (`gateway.js`) |
| `wrangler.jsonc` | Worker, assets, Durable Object and safety-budget configuration (no secrets) |
| `api/allocations.js`, `lib/eth-client.js`, `server.mjs` | Single-process Node implementation for local development (`npm start`) |
| `test/`, `e2e/`, `worker-tests/` | Unit tests, browser tests, real-runtime Worker tests and load test |
| `docs/` | UX specification, request triggers, deployment and architecture notes |

## Run locally

Requires Node.js **22.5 or newer** (`node:sqlite` is used by the tests).

```bash
npm ci
npm start            # Node development server on http://localhost:3000 (single-process cache)
npm run dev:worker   # the real Worker + Durable Object + static assets locally (wrangler dev, no account needed)
```

## Tests

```bash
npm test             # unit tests (pure logic, timeline, gateway on SQLite, router) — never contacts ETH
npm run test:e2e     # browser tests in headless Chromium against a mock ETH (E2E_BACKEND=worker uses the real Worker)
npm run test:worker  # the real Worker + Durable Object (workerd) against a mock ETH, incl. a load test
```

All tests use mocked ETH data. `npm run test:e2e` writes screenshots to `e2e/screenshots/` (git-ignored).

## Deployment

The production deployment is a Cloudflare Workers **Free** plan deployment (`npm run deploy`). Resources, limits, budgets, rollback, cost risks and the Cloudflare Access findings are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## ETH data source and its limits

The app reads ETH's public room-information JSON (`https://ethz.ch/bin/ethz/roominfo`), the same data ETH's own Belegungsplan page shows. It is **read-only**, sends no cookies or credentials, uses one fixed upstream, and identifies itself with a descriptive `User-Agent` that links to this repository.

**Permission:** automated use of ETH Rauminfo has **not** been explicitly approved by ETH. The endpoint is undocumented, can change or restrict automated traffic, and its rate limit is not a published contractual limit (it is only observed through the `x-ratelimit-remaining` header). The app therefore keeps its traffic minimal (see [`docs/REQUEST_TRIGGERS.md`](docs/REQUEST_TRIGGERS.md)), enforces a global daily budget and honours `429`/`Retry-After`. It does not bypass any limit or restriction. Before wider use, ask ETH whether this use is permitted and whether a supported interface or request limit exists.

### Interpretation of schedules

- Every returned interval blocks its time, whatever its type. Type 2 is shown as **Booked**; type 8, 13 and every other or unknown type are shown as **Blocked**. The meaning of type 8 and 13 is unverified, so they are never treated as opening hours or as free time.
- **Free** means no published interval covers that time. It does not mean the room is empty, unlocked, open or usable.
- ETH timestamps are Zurich wall-clock times without an offset. The app never parses them in the visitor's time zone and handles the 23- and 25-hour daylight-saving days.
- An error, a malformed response, an unverified room or an expired schedule is never shown as free. `200 []` is also what ETH answers for rooms that do not exist, so an empty schedule counts only after the room's existence was verified.
- Schedules carry the age of the **original ETH answer** through every cache; data older than 10 minutes is Stale and never recommended.

See [`docs/UX_SPEC.md`](docs/UX_SPEC.md) for the full behavior specification.

## Room inventory

The seed catalog is `public/rooms.json` (129 entries in 17 buildings; not a complete ETH inventory). Custom rooms added in the UI are stored in `localStorage` on that device. The codes were compiled from ETH's public room pages:

- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/hg.html (and `cab`, `chn`, `eta-etf-etz`, `hci`, `hil`, `hit`, `hph-hpv`, `hcp`, `hpk-hpl-hpt` in the same folder)
- A few additionally documented rooms, including HG E 27.

ETH says it manages 118 teaching rooms in Zentrum and 58 in Hönggerberg; this starter catalog includes some meeting and event rooms and should not be read as those 176 teaching rooms.

## Documentation

- [`docs/UX_SPEC.md`](docs/UX_SPEC.md): behavior of the home screen, modes, request budget, freshness and room detail.
- [`docs/REQUEST_TRIGGERS.md`](docs/REQUEST_TRIGGERS.md): the complete list of what causes a request.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): production deployment, limits, budgets, costs, Cloudflare Access, installation.
- [`docs/PRODUCTION_ARCHITECTURE.md`](docs/PRODUCTION_ARCHITECTURE.md): the design rationale behind the Worker and Durable Object.

## License

No license file is included yet. Without one, the source is publicly visible but all rights are reserved by default.
