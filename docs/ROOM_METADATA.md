# Room metadata, filters and student access (Stage 4)

`public/room-metadata.json` is a **static, versioned catalog** generated offline by `scripts/build-room-metadata.mjs`. It is separate from the reservation cache and is **never fetched during availability checks**; the app loads it once (precached by the service worker) and every filter runs locally on it.

## Sources (retrieved 2026-11-17, a handful of requests, no crawling)

| Source | Used for |
|---|---|
| ETH Rauminfo room list `…/roominfo?path=/v2/rooms` (1 request) | type, seats, extra seats, computer workstations, campus |
| ETH Rauminfo types `…?path=/types` (1 request) | type names |
| ETH Rauminfo room details `…?path=/v2/rooms/<room>` (**10 sample rooms only**) | seating style, equipment, accessibility, floor area, other details |
| Rectorate Staffnet room lists (10 pages) | cross-check of seats only: 122 compared, 122 agree, 0 disagree |
| RSETHZ 214.11 and the Rectorate room guidelines (PDFs) | read for access rules (see below) |

No official page lists computer rooms, workstation counts or who may use them.

## Fields and rules

- Every field is nullable; **unknown is never treated as a positive or a negative**. `seats` and `workstations` are separate (computer rooms have workstations and no seats; null seats are not 0). Each room carries provenance through `fieldSources`, plus generation dates.
- Type mapping: ETH "Computer" → *Computer room*, "Seminars / Courses" → *Seminar room*, "Lecture hall" → *Lecture hall*.
- **Coverage:** 129 rooms: type 129, seats 128, workstations 1 (HG E 27), seating style and equipment/accessibility details 10.
- **Student access** (`accessStatus` general / restricted / unknown, `accessNotes`, `accessSource`, `accessVerifiedAt`): a claim of *general* or *restricted* must bring its own official source URL and date, otherwise it is read as *unknown* (`accessFor()` in `public/metadata.mjs`). Access is never derived from reservation status. The official documents read say who decides a room's use but neither confirm nor forbid self-study, so **all 129 rooms are Access unknown** with a documented note and source. Computer rooms additionally show a notice that "no current booking" does not mean freely accessible.

## Filters

Room type (All / Computer room / Seminar room / Lecture hall), Capacity (Any / ≥10 / ≥20 / ≥40 seats; computer rooms have no seat count, so they only appear with *Any*), Equipment (Flexible furniture: only the 10 rooms verified as variable seating), Student access (All rooms / General access confirmed only / Include restricted rooms).

- A positive filter matches only **confirmed** metadata. Unknown rooms are excluded from positive filters and the UI says metadata coverage is incomplete.
- Filters apply to Free now / soon / Rest of day and Browse buildings. **Favorites ignore filters.** The campus selector is unchanged. Choice persists locally (`openroom-prefs-v1`).
- Recommendations hide known-restricted rooms by default; unknown-access rooms are recommended and marked "Access not verified". Browse buildings never hides unknown-access rooms.
- **Candidate rooms are chosen from the filtered set before any schedule is requested**, so the 6-request initial budget is unchanged, and changing a filter makes **zero** requests (verified by tests in the browser).

## Regenerating

```bash
node scripts/build-room-metadata.mjs --list rooms.json --types types.json --rectorate rectorate.json --details <dir> --date YYYY-MM-DD
```
(Without offline inputs the script fetches with a 3 s spacing and at most 12 detail requests.) Then `npm run stamp` and deploy.

## Gaps and limits

21 other ETH computer rooms exist in Rauminfo but are not in the app's room catalog; equipment/accessibility are known for 10 rooms only; no room has confirmed general or restricted access; the metadata is a snapshot and can become outdated.
