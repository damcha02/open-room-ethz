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

The server validates room/date inputs, caps the calendar window at 7 days, applies a 10-second timeout, validates JSON, strips out additional event details, and permits CDN caching for 5 minutes. It does **not** transmit authentication cookies or expose an arbitrary proxy destination.

The API path is **undocumented from our perspective** and was discovered from a real ETH calendar request. The ETH service can change, return errors, or restrict automated traffic. At the time of building, **the code could not connect to the live ETH endpoint from the development environment**. Browser behavior and unit tests were validated using a mocked response based on a genuine sample; production end-to-end traffic is still unverified.

**Before offering this publicly**, ask ETH whether this use is permitted and whether a supported interface, caching policy or request limit exists. You should not treat the existence of a browser-readable endpoint as permission for high-volume crawling.

## Interpretation of schedules

- Every returned date interval is treated as **unavailable** in availability calculations. Ignoring unidentified types could falsely mark a reserved room as free.
- In the supplied sample, `belegungstyp = 2` corresponded to teaching events; `belegungstyp = 8` looked like a recurring opening-hours restriction (00:00–08:00 and evenings). **The exact semantics of type 8 remain unconfirmed.** The app labels these records “Blocked interval (type 8)” rather than asserting the room is physically closed.
- “Free” means there is no published blocking interval at that moment, **not** that the room is empty, unlocked, legally usable or bookable.
- The displayed free-period visualization is limited to **08:00–22:00**, and might include intervals outside local building opening hours if ETH does not publish restriction records.
- ETH timestamps from the shared example are local Zurich wall-clock values (`2026-10-26T10:00:00` without an offset). The app avoids parsing these as UTC or as the viewer's timezone.
- Failed fetches are labeled **Schedule unavailable** rather than falsely **Free**.
- A genuinely empty JSON array will show “No bookings listed”; whether ETH has omitted bookings cannot be guaranteed.

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
