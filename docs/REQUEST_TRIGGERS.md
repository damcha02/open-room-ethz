# When does Open Room contact the server (and ETH)?

Every schedule request goes browser → `/api/allocations` → (server cache) → ETH. The browser sends **no request on a timer**,
none while the tab is hidden, and none for switching recommendation modes, starring rooms, opening a room whose data is fresh,
or moving between days of a cached week. This table is the complete list; `e2e/run.mjs` (phases 4–8) checks it.

## What triggers a browser → server request

| # | Trigger | Rooms requested | Bound |
|---|---|---|---|
| 1 | **First visit / first load of a campus** | favorites of the selected campus, then other favorites (startup only), then discovery rooms | **≤ 6 schedule requests in total.** Fresh cache entries are reused and cost nothing. |
| 2 | **Tap "Check N favorites"** (favorites over budget) | the favorites that were not requested | ≤ 6 per tap |
| 3 | **Tap a favorite that is "Not checked yet"** | that room (opens its detail screen) | 1 |
| 4 | **Tap "Check more rooms"** | further discovery rooms of the campus | ≤ 6 per tap |
| 5 | **Open a room (detail screen)** | that room's week | **0** if the week is fresh (< 10 min old at the source); **1** if missing, stale or unreadable |
| 6 | **Change day in the detail screen** | the week of that day | **0** if any data for that week is cached (even stale, shown as stale); **1** if the week was never loaded |
| 7 | **Tap "Refresh" in the detail screen** | the viewed room and week | 1 (forced) |
| 8 | **Tap "Refresh N stale rooms"** (coverage line, shown only when data expired) | the expired checked rooms | ≤ 6 per tap |
| 9 | **Return to the app** (tab becomes visible again, or page restored) and schedules have expired | the open room first, then favorites of the selected campus, then the other checked rooms; only expired ones | **≤ 6 per event**, at most one event per 30 s, nothing while hidden |
| 10 | **Expand a building / narrow search (≤ 5 rooms) / change browse day** (Browse section) | the rooms shown | only rooms without fresh data; the user chose to look |
| 11 | **Browse refresh button** | the open buildings' rooms and the checked rooms | deliberate, forced |
| 12 | **Retry after a failure** | only rooms whose request **failed** and whose backoff (30 s, or the server's `Retry-After`) has ended, for rooms the user can currently see | automatic, but never for merely stale data; after a 429/503 the whole queue pauses first |
| 13 | **Pull-to-refresh / Refresh button** | favorites, then currently recommended, then other checked rooms | ≤ 6 per refresh (shared queue and Durable Object cache; 20 s minimum between refreshes); the version check itself is a static file and makes **0** ETH requests |

## What does NOT trigger a request

- **Changing a filter** (room type, capacity, equipment, student access, reset): local metadata only, 0 requests. Filters decide which rooms are candidates *before* schedules are requested.
- Loading `room-metadata.json` and `version.json`: static files, never ETH.

- Switching **Free now / Free soon / Rest of day** (pure recalculation, 0 requests).
- Starring or un-starring a room, switching campus tabs back and forth to a campus that is already loaded.
- The **once-a-minute tick**: it only re-renders from the cache (status text, current-time line, clock). In earlier versions it also
  refreshed every checked room once its data was 8 minutes old; that polling was removed in Stage 3B.
- A hidden tab, a background tab, or a tab that merely stays open while data expires. Expired data is shown as **Stale** (never as
  a current recommendation) and refreshed on return, on tap, or when the room is opened.

## Deduplication and caches (what makes triggers cheap)

- One in-flight map is shared by Home, Browse and the detail screen: a room/week is never requested twice at once.
- Browser cache (`localStorage`) keeps the **age of the original ETH answer**; freshness is 10 minutes of source age.
- Server cache: 5-minute TTL per room/week, in-flight de-duplication, global spacing and cooldown (`lib/eth-client.js`).
  A revalidation that hits the server cache costs no ETH request.
- The browser never lets the HTTP cache serve schedules on its own (`cache: 'no-store'` / `max-age=0`).

## Budget arithmetic (for the future production architecture)

| Situation | Browser → API | ETH (best case with warm server cache) |
|---|---|---|
| Fresh visit | ≤ 6 | ≤ 6 (+ one room-existence check per empty schedule) |
| Reload within 10 min | 0 (or 1 discovery top-up) | 0 |
| Open a room with fresh data | 0 | 0 |
| Return after > 10 min with 9 checked rooms | ≤ 6 (then ≤ 3 after 30 s) | ≤ 9, usually fewer (server cache) |
| Leave the tab open for an hour, never touch it | **0** | **0** |

So the request volume is driven by **user actions and returns to the app**, not by time. This is what a global ETH budget in a
shared cache (see `docs/PRODUCTION_ARCHITECTURE.md`) can plan with: per visit about 6–12 API calls, no background load.

## What the server adds (production)

Everything above describes the **browser → API** side. In production the API runs on a Cloudflare Worker whose single global
Durable Object adds, for all users together: a shared 5-minute cache (a request that hits it costs ETH nothing), de-duplication,
global request spacing, a shared 429 cooldown and a hard daily budget of upstream requests (default 200 per UTC day, counting
schedule requests and room-existence checks). When ETH may not be asked, only a stored schedule can be returned, with its true age
and a stale marker. See [`DEPLOYMENT.md`](DEPLOYMENT.md).
