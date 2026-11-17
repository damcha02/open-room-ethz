# Open Room ETHZ — UX specification

Open Room ETHZ is a recommendation-first mobile app (an unofficial student project, not affiliated with ETH Zürich). It suggests ETH Zürich rooms that have **no published reservation**,
based on ETH's Rauminfo schedules. It reports reservations, **never physical occupancy**. A room can be free and
still be locked, in use or unsuitable.

**Primary principle:** a student finds a suitable room in a few seconds, without opening buildings or choosing a duration.

## 1. Home screen hierarchy (mobile, ~375 px)

1. **Header** — Open Room ETHZ, search icon (jumps to and focuses the search field in *Browse buildings*), settings icon.
2. **Campus selector** — Zentrum / Hönggerberg. Remembered locally.
3. **Favorites** — compact rows, shown whenever at least one favorite exists. Contains favorites from **both** campuses and is
   never affected by the campus selector, the recommendation mode or the free-only filter.
4. **Find a room** — three modes: **Free now** (default), **Free soon**, **Rest of day**. The mode is remembered locally.
5. **Recommendations** — three cards at first; "Show N more" reveals further *checked* matches (at most 10 in total).
6. **Coverage and loading** — rooms checked, last data refresh, unchecked/unavailable rooms, rate-limit state, and the
   "Check more rooms" action.
7. **Browse buildings** — the existing expandable building lists with date strip, search, free-only toggle, "Add a room"
   and refresh. Unchanged in behaviour.

Progressive disclosure: cards show a headline and one line of detail. Tapping a card or favorite row expands the existing
room detail (timetable, unreserved intervals, reservations). Course titles are not shown on cards.

## 2. Terminology and booking semantics

| Term | Meaning |
|---|---|
| **Free** | No published interval covers that time, using half-open intervals `[start, end)`. This matches the wording of ETH's official Belegungsplan. |
| **Booked** | Allocation type 2 (teaching event). |
| **Blocked** | Allocation type 8, 13 and every other / unknown type. Semantics are unverified. |
| **Loading** | Requested, not yet answered. |
| **Not checked yet** | A favorite whose schedule has not been requested (initial request budget used up). Loads on a deliberate tap. |
| **Stale** | The original ETH answer is older than 10 minutes. Shown as "· Stale" information; never a current recommendation. |
| **Unavailable / unknown** | The request failed, was rate limited, was malformed, or the room is unverified. Never "free". |

All allocation types block time. `findetStatt: 0` (an event that is flagged as not taking place) still blocks, because its
meaning is unverified. Status colour is never the only signal: every status has text.

## 3. Recommendation eligibility (all modes)

A room is recommended only if **all** of these hold:

- its schedule was retrieved successfully and completely (every entry has valid `start`/`end`, `end >= start`);
- the proxy reports `roomVerified === true` (ETH confirmed the room exists; an empty schedule alone proves nothing);
- the data is fresh: the **original ETH answer** is less than 10 minutes old (see *Freshness* below);
- a confirmed free interval meets the mode's criteria.

Missing, malformed, stale, unverified or failed data is never inferred to be free. "Free" never means the room is physically empty, unlocked or open.

The app says **"Free for the rest of the day"** only for a room that is free now and whose free interval runs to an overnight block. Without such a boundary it says only "No later reservations listed today".

### Time handling

- "Now" is the current Europe/Zurich wall-clock date and minute.
- ETH timestamps are Zurich wall-clock values without offset and are never interpreted in the visitor's time zone.
- Intervals are compared as wall-clock minutes of the day. **Durations and thresholds use real elapsed time**: they are
  converted through Zurich UTC offsets, so a 02:00–03:00 span on a daylight-saving transition day counts correctly.
- A block that ends at 23:59 is treated as ending at 24:00 (ETH uses 23:59 as an end-of-day marker).
- Overlapping and adjacent blockers are merged before gaps are computed.

### The overnight boundary

An **overnight block** is a type-8 interval that starts after 00:00 and runs to the end of the day (typically 20:00 or
22:00 to 23:59). It is used as the end of the usable day. The app does **not** claim that it defines opening hours. When a
day has no such block, the end boundary is unknown and the app states only the narrower fact ("No later reservations
listed today").

## 4. Modes

### Free now (default)
Free at this minute **and** uninterrupted for at least **30 minutes** (elapsed).
- Headline: "Free until HH:MM" (or "Free now" when nothing later is listed; the detail then says so).
- Detail: "Next: Booked HH:MM–HH:MM" / "Next: Blocked HH:MM–HH:MM".
- Sort: longest uninterrupted remaining time first, then room code.

### Free soon
Not already a Free-now match, and its next free interval **starts within 60 minutes** (after now) and lasts at least
**30 minutes**.
- Headline: "Free in N min".
- Detail: "HH:MM–HH:MM · D min" (end shown as "end of day" when no later block exists).
- Sort: earliest start, then longest interval, then room code.

### Rest of day
Today's remaining schedule has an free interval of at least 30 minutes that extends to the end boundary, with **no
reservation or block after it starts** (other than the overnight block). The room may be free now or become free later.
- Headline: "Free now until HH:MM" or "Free from HH:MM until HH:MM" (without an overnight block: "Free now" / "Free from HH:MM").
- Detail: "No later reservations before overnight block" when an overnight block bounds the interval; otherwise
  "No later reservations listed today" (and no end time is promised).
- A room that is free now but has another booking later does **not** show as continuously free: its interval starts after
  that booking ends.
- Sort: earliest start, then longest interval, then room code.

## 5. Request budget, freshness and coverage

### One shared initial budget
A fresh visit makes **at most 6 schedule requests in total, favorites included**. Priority:
1. favorites of the selected campus; 2. other favorites (startup only); 3. discovery rooms of the selected campus.

- Fresh cache entries are reused and never count as requests (six or more fresh cached discovery rooms mean no request).
- **All favorites stay visible.** Those that do not fit the budget show "Not checked yet". They load only on a deliberate
  action: tapping the row (+1 request) or "Check N favorites" (at most 6 per tap).
- Starring or un-starring never requests anything. Switching recommendation mode never requests anything.
- Discovery candidates (6): rooms with fresh cached data, then favorites of the campus, then stale rooms, then unchecked
  rooms spread round-robin across buildings. Rooms known not to exist and rooms in an error backoff are skipped.
- **Check more rooms** requests up to 6 further rooms of the campus. No automatic repeat batching, no infinite scrolling,
  and the catalog is never fetched wholesale.
- All requests use one queue (2 at a time), one in-flight map shared by Home and Browse (no room is requested twice), the
  server scheduler, caches and cooldown handling. Nothing is requested while the tab is hidden.

### Freshness follows the original ETH timestamp
The proxy answers with `fetchedAt` (when ETH was asked) and `ageMs` (its age at response time, measured on the server
clock). The browser stores `ageAtReceiptMs` (plus the HTTP `Age` header of any shared cache) and `receivedAt`; the age of a
record is `ageAtReceiptMs + time elapsed locally`. Consequences:
- caching never makes data younger, in the server cache, a CDN or the browser;
- a wrong phone clock cannot distort freshness, because only local differences are used;
- records without a usable age, or with a clock that moved backwards, are never fresh;
- data older than 10 minutes is Stale (shown, marked, refreshed); older than 1 hour it is dropped;
- the server cache TTL is 5 minutes, so a cached answer is always younger than the freshness limit when it is served.
A response that is already old on arrival is not re-requested for 60 seconds.

### Coverage
Reported exactly: "Recommendations based on 8 of 64 listed rooms checked." It distinguishes *loading*, *incomplete coverage*,
*all checked rooms unavailable* and *rate limited* (which takes priority over loading while the queue is paused). The app
never claims to have found the best room on a campus unless every listed room was checked.

### Local recalculation and revalidation
Time-dependent results (status text, the current-time line, recommendations) are recalculated every minute **from the cache
only**: the tick never makes a request. Expired data is shown as **Stale** and never recommended. It is refreshed
(a) when the app returns to the foreground, within the request budget and at most every 30 s, (b) on a deliberate tap
("Refresh N stale rooms", the detail screen's Refresh, opening a room), or (c) after a failed request once its backoff ended.
The complete list of triggers is in [`REQUEST_TRIGGERS.md`](REQUEST_TRIGGERS.md).

## 5b. Performance rules

- The interface never waits for ETH: cached schedules render immediately; requests run in the background; loading states
  have a reserved minimum height (no layout shift).
- Renders are coalesced into one animation frame and DOM is replaced only when the markup changed (focus is restored).
- Mode switches, starring, campus-independent recalculation and card opening need no network.
- Reproducible measurements (`npm run test:e2e`, headless Chromium, local mock ETH) are written to
  `e2e/screenshots/performance.json`: first render, first recommendation, interaction latency, layout shift, idle DOM
  mutations and request counts.

## 6. Visual direction

Calm, compact, light neutral background, strong typographic hierarchy, restrained green for confirmed free
intervals, a distinct red-brown treatment for bookings, amber for blocks and neutral gray for unknown. Cards use moderate
radii. All interactive targets are at least 44 px. No decorative animation (the loading dot pulse respects
`prefers-reduced-motion`). Keyboard navigation and visible focus rings are preserved.

## 7. Out of scope

Accounts, location or Bluetooth features, and any new backend infrastructure.

## 8. Room detail screen (Stage 3B)

Every room entry (recommendation card, favorite row, building list) opens **one** full-screen detail view. It is a modal
dialog: the page behind it is inert and does not scroll, focus moves into it and returns to the opener on close, Escape closes
the selected entry first and the screen second, and the phone's back button closes it (`#room` history entry).

Layout, top to bottom (the first three parts stay fixed, the rest scrolls):
1. **Header** — back button, room code, building · campus, favorite star.
2. **Current status** — badge **Free / Booked / Blocked / Unknown / Loading** with its sentence ("Free until 14:00"), **Next change**
   ("At 14:00 it becomes booked (until 16:00)"), and a **freshness line** with a Refresh button ("Updated 10:02 · 3 min ago",
   "Stale — updated 09:56 (14 min ago)", "Rate limited — retrying later").
3. **Day navigation** — previous / next day, label with a Today tag, a Today button, and the seven days of the week.
4. **Timeline** — vertical, 24 hours, **72 px per hour** (1.2 px/min). Free, Booked and Blocked intervals are drawn with heights
   exactly proportional to their real durations; hourly labels and boundaries; a red **Now** line on today; the first view is
   positioned around now (today) or 08:00 (other days). Free time is a green block, bookings are red-brown, blocks are hatched
   amber; a legend and text labels mean colour is never the only signal.
5. **Entries list** — an accessible alternative listing every entry (a collapsed `details` element).
6. **Details card** — tapping a booking or block (or a list row) shows its type, time range, real duration, title and course
   number, plus notes ("ETH marks this event as not taking place; still shown as blocking", type-8 blocks "are shown as
   published and are not treated as opening hours"). A second tap, the × button or Escape closes it.

Rules:
- The screen opens immediately from the cache. A fresh week needs **no request**; a missing, stale or unreadable one needs one.
- Moving between days of a cached week needs no request; a week that was never loaded needs one, and shows "Loading schedule…"
  with **no free time** while it loads.
- **Unknown or failed schedules are never drawn as free:** an error, rate limit, unverified or unreadable (malformed) schedule
  shows a status of Unknown, an explanation and a retry (paused during an ETH cooldown) and no timeline at all.
- **Stale data is never shown as confirmed:** the badge reads "Free · Stale", free time is hatched and labelled "Free · stale",
  and a warning note and the freshness line explain it. Data older than one hour is not shown.
- Overlapping entries are placed in side-by-side lanes; adjacent entries (end = start, half-open) keep the full width; the
  merged blockers decide where free time is (no phantom gaps).
- **Daylight saving:** the axis is real elapsed time since local midnight: 23 hours (spring forward, no 02:00 label) or 25 hours
  (fall back, the repeated hour is labelled "02:00 2nd"). ETH timestamps have no offset, so an entry inside the repeated hour is
  drawn in its first occurrence (documented limitation).
- No opening hours are assumed: type-8 blocks are drawn as published blocks only. With no published block, a room at 03:00 is
  "Free" (no published entry) and the screen says Free never means empty, open or accessible.
- No duration has to be chosen anywhere.
