# Open Room — ETH room timetable finder

An independent, mobile-first progressive web app (PWA) showing **published reservation intervals**, not physical occupancy, for ETH Zürich rooms.

## Included features

- Zentrum, Hönggerberg and Favorites tabs
- Grouped, expandable building → room lists
- 129 curated room identifiers in 17 buildings, sourced from ETH's publicly listed room-information pages (a starter catalog, **not a complete ETH inventory**)
- Search by room code or building
- Monday–Sunday week navigation, selected day, automatic Europe/Zurich time
- Free-only toggle (favorites always show all saved rooms)
- Room details: reservations, potential blocks, timetable visualization and remaining unreserved intervals
- Device-local favorites and preferences; manual entry of additional room codes
- Installable PWA shell; live schedules are **never served from offline service-worker cache**
- Zero npm dependencies: only Node.js >=20

## Run locally

```bash
cd eth-room-finder
npm start
```

Open http://localhost:3000 on the same computer. `npm test` runs the unit tests.

To use the PWA on a phone from any network, deploy it to HTTPS. Localhost on your computer is **not** reachable from a phone on mobile data.

## Deploy on Vercel

1. Install Node.js >=20 if not already installed.
2. In this project's folder, run `npx vercel login` (you need a Vercel account).
3. Run `npx vercel --prod`, choosing the project defaults and the current folder when prompted.
4. Open the HTTPS URL that Vercel returns. On iPhone, use **Safari → Share → Add to Home Screen**. On Android Chrome, choose **Install app** or **Add to Home screen**.

Vercel recognizes `api/allocations.js` as a serverless function and serves the static files in `public/`. No database or external JavaScript dependencies are required.

If deployment errors, inspect its build/function logs before assuming the ETH endpoint is unavailable.

## ETH data source

The front end requests its own backend:

`GET /api/allocations?room=HG%20E%2027&from=2026-10-26&to=2026-11-01`

The serverless function proxies a **read-only**, unauthenticated request to the endpoint identified in browser Network tools:

`https://ethz.ch/bin/ethz/roominfo?path=%2Frooms%2FHG+E+27%2Fallocations&from=2026-10-26&to=2026-11-01`

The server validates room/date inputs, caps the calendar window at 7 days, applies a 10-second timeout, validates JSON, strips out additional event details, and permits CDN caching (default 5 minutes, verified rooms only; browsers never reuse a response on their own). It does **not** transmit authentication cookies or expose an arbitrary proxy destination.

The API path is **undocumented from our perspective** and was discovered from a real ETH calendar request. The ETH service can change, return errors, or restrict automated traffic. At the time of building, **the code could not connect to the live ETH endpoint from the development environment**. Browser behavior and unit tests were validated using a mocked response based on a genuine sample; production end-to-end traffic is still unverified.

**Before offering this publicly**, ask ETH whether this use is permitted and whether a supported interface, caching policy or request limit exists. You should not treat the existence of a browser-readable endpoint as permission for high-volume crawling.

## Interpretation of schedules

- Every returned date interval is treated as **unavailable** in availability calculations. Ignoring unidentified types could falsely mark a reserved room as free.
- In the supplied sample, `belegungstyp = 2` corresponded to teaching events; `belegungstyp = 8` looked like a recurring opening-hours restriction (00:00–08:00 and evenings). **The exact semantics of type 8 remain unconfirmed.** The app labels these records “Blocked interval (type 8)” rather than asserting the room is physically closed.
- “Free” means there is no published blocking interval at that moment, **not** that the room is empty, unlocked, legally usable or bookable.
- The displayed free-period visualization is limited to **08:00–22:00**, and might include intervals outside local building opening hours if ETH does not publish restriction records.
- ETH timestamps from the shared example are local Zurich wall-clock values (`2026-10-26T10:00:00` without an offset). The app avoids parsing these as UTC or as the viewer's timezone.
- Failed fetches are labeled **Schedule unavailable** rather than falsely **Free**.
- Status colours: **free** (green), **booked** (type 2 teaching event, red), **blocked** (type 8, 13 or any other/unknown type, amber), **loading** (pulsing grey) and **unknown/unavailable** (grey). Only booked and blocked intervals are ever drawn as reservations; unknown is never shown as free.
- An empty JSON array (`[]`) proves nothing: ETH also answers `200 []` for rooms that do not exist. See “Reliability and rate limits” for how this is handled.

## Room inventory

The seed catalog is `public/rooms.json`. You can add/remove verified codes there; custom rooms added in the UI are stored in localStorage on that device. Building and campus metadata are maintained locally.

The included room codes were compiled from these ETH pages:

- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/hg.html
- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/cab.html
- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/chn.html
- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/eta-etf-etz.html
- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/hci.html
- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/hil.html
- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/hit.html
- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/hph-hpv.html
- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/hcp.html
- https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/hpk-hpl-hpt.html
- A few additionally documented rooms, including HG E 27 from the supplied API response.

ETH says it manages **118 teaching rooms in Zentrum and 58 in Hönggerberg**; this starter catalog has 129 entries, including some meeting and event rooms, so it should not be interpreted as a complete set of those 176 teaching rooms.

## Architecture

```
public/                 Standalone PWA (HTML / CSS / JS / manifest / icons)
public/schedule.mjs     Pure time/date/interval handling logic
public/rooms.json       Seed room catalog
api/allocations.js      Vercel Node serverless ETH read-only proxy
server.mjs              Built-in local Node server for `npm start`
test/                   Node's built-in test runner
```

No user accounts, notifications, GPS, Bluetooth scanning or actual occupancy sensors are included. The PWA can be improved further after confirming ETH permission and its room inventory API.

## Testing checklist for the real endpoint

1. In an incognito/private window, open the ETH JSON URL from the sample and confirm it works without login.
2. Deploy the app and expand **HG** → **HG E 27**. Confirm the bookings match ETH's official Belegungsplan.
3. Test one additional room at Zentrum and one at Hönggerberg.
4. Check a room's `belegungstyp: 8` intervals against opening-hour rules.
5. If any API request fails, examine the browser Network response for `/api/allocations` and Vercel function logs, then fix the adapter rather than marking it free.

### Notes on scope

An empty slot in a published schedule **does not grant a room reservation**. ETH policy and local access rules still apply. This app is not endorsed by ETH Zürich.

## Reliability and rate limits (Stage 2)

ETH sends an `x-ratelimit-remaining` header (observed ≈18–20; it rose between requests spaced a few seconds apart, but **the refill window is unknown and is not assumed**).

**Server cache** (`lib/eth-client.js`): successful room/week responses are cached in memory for `ETH_CACHE_TTL_MS` (default 300000 = 5 min, deliberately below the 10-minute freshness limit). Identical in-flight requests share one ETH request. Errors are never cached, so the next request retries. At most `ETH_CACHE_MAX_ENTRIES` (500) entries are kept. Every response carries `fetchedAt` (when ETH was asked) and `ageMs` (its age now, on the server clock): caching never makes data look younger.

**Upstream scheduling:** ETH requests are started at least `ETH_MIN_INTERVAL_MS` (1000) apart, never in a burst. A request that would have to wait longer than `ETH_MAX_QUEUE_WAIT_MS` (20000) is refused with `503` + `Retry-After` (`code: "busy"`). `x-ratelimit-remaining ≤ ETH_LOW_REMAINING` (5) slows the spacing to `ETH_LOW_INTERVAL_MS` (5000); `0` starts a cooldown. A `429` (or `503` with `Retry-After`) starts a cooldown honouring `Retry-After` (seconds or HTTP date); without that header it is `ETH_DEFAULT_COOLDOWN_MS` (60000), doubling on repeated 429s up to `ETH_MAX_COOLDOWN_MS` (15 min). During a cooldown **no** request is sent to ETH; our API answers `503` with `Retry-After`, `code: "rate_limited"`.

**Browser:** only buildings you expand (or a search with ≤5 matches) are loaded by Browse, two requests at a time; the home screen follows the shared request budget below. Results are cached in `localStorage` with the age of the **original ETH answer** (`ageAtReceiptMs` + time elapsed locally, so a wrong phone clock cannot distort it). Data is current for 10 minutes of source age, shown as **Stale** up to 1 hour, then discarded; a reload shows cached results immediately. After a 429/503 the browser pauses its whole queue for the advertised time (min. 10 s); other failures back off 30 s per room. Failed rooms show "Schedule unavailable" / "Rate limited — retrying later", never "Free". Free-only mode lists only confirmed-free rooms and tells you how many rooms are hidden because availability is unknown.

**Invalid / unknown rooms:** when ETH returns `[]`, the proxy asks ETH's room-details interface (`/bin/ethz/roominfo?path=/v2/rooms/<room>`, the one ETH's own Rauminfo page uses; not publicly documented) whether the room exists. The result is `roomVerified`: `true` (room exists → “No bookings listed”, free), `false` (“Room not found at ETH”) or `null` (check failed → “Room not verified”). A non-empty reservation list proves the room exists, so it needs no extra request. `false`/`null` rooms are always **unknown**, never free, and are not cached by shared caches. No assumption is made about type-8 records.

### Limits of the in-memory protections (important for serverless)

Cache, in-flight de-duplication, request spacing and cooldown all live **in the memory of one Node process**. `npm start` (single process) gets the full benefit. On Vercel (or any serverless/multi-instance host) every instance has its own cache, queue and cooldown, instances start cold, and concurrent instances do **not** coordinate, so the global ETH request rate is *not* bounded. Only the CDN cache (`s-maxage`, verified rooms only) and the per-browser protections apply across instances. A real deployment that must protect ETH needs shared storage (e.g. Redis/KV) for the cache, a shared rate-limit/cooldown counter and a single request queue.

## Tests

`npm test` runs unit tests with mocked ETH responses (never contacts ETH). Browser behaviour was checked manually in headless Chromium against a mock ETH server (`ETH_ENDPOINT` overrides the upstream URL for testing only).

## Smart discovery home screen (Stage 3A)

The home screen is recommendation-first: header → campus (Zentrum / Hönggerberg) → Favorites (both campuses, always shown when non-empty) → **Find a room** (Free now / Free soon / Rest of day) → coverage → Browse buildings. The full specification, including exact definitions of the three modes, eligibility rules, time handling and the request budget, is in [`docs/UX_SPEC.md`](docs/UX_SPEC.md).

- Pure logic (eligibility, modes, ranking, candidate choice, coverage text) lives in `public/recommend.mjs` and `public/schedule.mjs` and is covered by `test/recommend.test.mjs`.
- **One shared initial budget:** a fresh visit makes at most **6 schedule requests in total, favorites included** (favorites of the selected campus first, then other favorites, then discovery rooms). Fresh cache entries are reused and cost nothing. Favorites over budget stay visible as "Not checked yet" and load only when tapped or via "Check N favorites" (≤6 per tap). "Check more rooms" requests 6 more discovery rooms. Switching modes, starring and hidden tabs never request anything; there is no polling.
- `npm run test:e2e` runs the browser tests in `e2e/` (headless Chromium over the DevTools protocol, a mock ETH server, a frozen Zurich clock, 375 px viewport) and writes screenshots to `e2e/screenshots/`. It is not part of `npm test` because it needs a Chromium/Chrome binary (`CHROMIUM=/path` to choose one).

## Freshness, wording and performance (Stage 3A.1)

- **Freshness** follows the original ETH timestamp through the server cache, any CDN and the browser cache (see `docs/UX_SPEC.md` §5). An old answer received from a recently filled cache is Stale, never a current recommendation.
- **Wording:** "Free" (as in ETH's Belegungsplan), "Booked" (type 2), "Blocked" (type 8/13/other), "Loading", "Not checked yet", "Unknown/Unavailable" and "Stale" are distinct. "Free for the rest of the day" is shown only when an overnight block supports it. Availability is based on ETH's reservation schedule, not actual room occupancy (also stated in Settings).
- **Performance** is measured by `npm run test:e2e` (first render, first recommendation, interaction latency, layout shift, idle DOM mutations, request counts) and written to `e2e/screenshots/performance.json`.
- **Future hosting:** `docs/PRODUCTION_ARCHITECTURE.md` proposes a zero-cost Cloudflare design (Static Assets + Worker + SQLite Durable Object with a global ETH budget). It is a design only; nothing of it is implemented.
