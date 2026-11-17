# App updates, pull-to-refresh and the service worker (Stage 4)

## Version identifier
`npm run stamp` (`scripts/stamp-version.mjs`) hashes **every file under `public/`** (except the generated files and `_headers`) into a 12-hex version and writes `public/version.json` and `public/sw-version.js`. `sw.js` imports `sw-version.js`, so its bytes change with any shipped file; a byte-identical `sw.js` would otherwise never notice a changed stylesheet. `npm run deploy` stamps first and refuses to deploy with uncommitted changes under `public/`, `worker/`, `lib/` or `wrangler.jsonc`. A unit test fails if the committed stamp is stale.

## Service worker lifecycle
- Install precaches the **complete** shell into `openroom-shell-<version>` (bypassing the HTTP cache). Any failure (for example a 404 right after a deployment, or a redirect) fails the install and the old version keeps running. `/index.html` is not precached because Cloudflare redirects it to `/`; the start page is cached as `/`.
- A new worker **waits**; the page asks it to activate (`SKIP_WAITING`), then reloads **once**. Every page therefore sees a complete old or a complete new file set, never a mix. Activation deletes older shell caches (including the pre-versioned `openroom-shell-v4`) and claims clients.
- `/api/*` and `/version.json` are never handled by the worker. The page registers with `updateViaCache: 'none'`; `_headers` sets `no-store` on `version.json` and `no-cache` on `sw.js`/`sw-version.js`.

## Refresh (pull-to-refresh or the Refresh button)
1. Fetch `/version.json` with `cache: 'no-store'` (zero ETH requests) and compare with the version this page runs.
2. Different: `registration.update()`, wait for the new worker to finish installing, activate it, reload once. A guard in `sessionStorage` allows at most one attempt per target version and session, so there is no reload loop; if the new worker does not take over the message says to close and reopen the app. Favorites, campus, filters and preferences live in `localStorage` and are untouched.
3. Same version: "App is up to date", then today's rooms are refreshed in a small bounded batch: favorites first, then the rooms currently recommended, then other checked rooms, **at most 6** (the initial budget), through the existing queue and Durable Object cache (cooldowns, spacing, daily budget all apply). The result states how many answers came from ETH vs the shared cache; the original ETH fetch time is preserved and a cache hit is never described as freshly fetched.
4. Offline / failed check: a calm message, the app keeps running. At launch, an update that finished installing while the app was closed is applied once per session.

The pull gesture only starts at the top of the page, after a deliberate downward move (threshold 72 px after resistance); it never starts in the room-detail screen, dialogs, inputs or the day strip. The non-passive `touchmove` listener exists only while a pull from the top is tracked, so normal scrolling is never intercepted.

## Manual test on a physical phone (not performed by the author)
1. Install the production URL as a PWA, open it, note the version in Settings → About.
2. Deploy a visible change (`npm run deploy`).
3. Open the installed app, pull down from the top (or tap Refresh). Expect "Checking for updates…", one reload, and the new version in Settings; favorites/campus/filters unchanged.
4. Pull again: "App is up to date". Enable airplane mode and pull: an offline message, no reload.
5. Scroll down and swipe down: no refresh. Open a room and swipe in the timeline: no refresh.
