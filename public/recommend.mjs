/** Room recommendations: pure functions, no DOM and no network. See docs/UX_SPEC.md.
 *
 * Vocabulary: a *record* is what the app caches per room and week (see public/app.js):
 *   {state:'ready', allocations:[{start,end,type,...}], roomVerified:true|false|null, fetchedAt, ageAtReceiptMs, receivedAt}
 *   {state:'error', rateLimited?, retryAt?}
 * Times are Europe/Zurich wall-clock minutes of the day (0..1440). Intervals are half-open [start, end).
 * Durations and thresholds use REAL elapsed minutes (daylight-saving safe, see elapsedMinutes).
 */
import {displayTime, elapsedMinutes, FRESH_MS, sourceAgeMs, isFreshRecord} from './schedule.mjs';

export const MODES = ['now', 'soon', 'rest'];
export const MODE_LABELS = {now:'Free now', soon:'Free soon', rest:'Rest of day'};
export const DEFAULT_MODE = 'now';
export const MIN_FREE_MINUTES = 30;
export const SOON_WINDOW_MINUTES = 60;
export const DAY_END = 1440;
export const INITIAL_REQUEST_BUDGET = 6; // schedule requests a fresh visit may make in total, favorites included
export const INITIAL_CANDIDATES = 6;     // discovery candidates considered at startup (fresh cached rooms count)
export const MORE_BATCH = 6;             // rooms requested per "Check more rooms" / "Check favorites" (a deliberate action)
export const INITIAL_SHOWN = 3;
export const MAX_SHOWN = 10;

export function normalizeMode(value) { return MODES.includes(value) ? value : DEFAULT_MODE; }

// ---------- schedule normalisation ----------
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
function parseStamp(value) {
  if (typeof value !== 'string') return null;
  const m = STAMP_RE.exec(value);
  if (!m) return null;
  const d = new Date(`${m[1]}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1]) return null;
  return {date: m[1], minute: Number(m[2]) * 60 + Number(m[3])};
}

/** Strictly turn raw allocations into the blocking intervals of one Zurich day. ANY malformed entry fails the whole
 * day ({ok:false}); nothing is skipped silently, because a skipped booking would make a room look unbooked.
 * Every type blocks; type 2 is "booked", every other type (8, 13, unknown, null) is "blocked".
 * `overnight` marks the end-of-day boundary: a type-8 block that starts after 00:00 and runs to the end of the day. */
export function normalizeDay(allocations, day) {
  if (!Array.isArray(allocations)) return {ok:false, reason:'malformed'};
  const blockers = [];
  let index = -1;
  for (const entry of allocations) {
    index++;
    if (!entry || typeof entry !== 'object') return {ok:false, reason:'malformed'};
    const s = parseStamp(entry.start), e = parseStamp(entry.end);
    if (!s || !e || s.date > e.date || (s.date === e.date && e.minute < s.minute)) return {ok:false, reason:'malformed'};
    if (s.date > day || e.date < day) continue;                    // does not touch this day
    const start = s.date < day ? 0 : s.minute;
    let end = e.date > day ? DAY_END : e.minute;
    if (end <= start) continue;                                    // zero length: blocks nothing in [start, end)
    if (end === 1439) end = DAY_END;                               // ETH uses 23:59 as an end-of-day marker
    const type = typeof entry.type === 'number' ? entry.type : null;
    blockers.push({
      id: `i${index}`, start, end, type, kind: type === 2 ? 'booked' : 'blocked', overnight: type === 8 && start > 0 && end === DAY_END,
      title: typeof entry.title === 'string' && entry.title ? entry.title : null,
      courseNumber: typeof entry.courseNumber === 'string' && entry.courseNumber ? entry.courseNumber : null,
      eventIsHeld: typeof entry.eventIsHeld === 'number' ? entry.eventIsHeld : null,
      continuesFromPrevDay: s.date < day, continuesToNextDay: e.date > day
    });
  }
  blockers.sort((a, b) => a.start - b.start || a.end - b.end);
  return {ok:true, blockers};
}
/** Merge overlapping AND adjacent intervals (half-open, so [8,10) and [10,12) join into [8,12)). */
export function mergeBlockers(blockers) {
  const sorted = blockers.map(({start, end}) => ({start, end})).filter(i => i.start < i.end).sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({...i});
  }
  return out;
}
/** Free gaps of the day [0, 1440) between merged blockers. */
export function gapsOf(merged) {
  const gaps = [];
  let cursor = 0;
  for (const b of merged) {
    if (b.start > cursor) gaps.push({start: cursor, end: b.start});
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < DAY_END) gaps.push({start: cursor, end: DAY_END});
  return gaps;
}

// ---------- eligibility ----------
/** Can this cached record support a recommendation for `ctx.today` right now? Anything but state "ready" is not
 * eligible: loading, unavailable, rateLimited, malformed, unverified, notFound, stale. */
export function assessRecord(record, ctx) {
  const {today, nowMs = Date.now(), freshMs = FRESH_MS} = ctx;
  if (!record) return {state:'loading'};
  if (record.state === 'error') return {state: record.rateLimited ? 'rateLimited' : 'unavailable'};
  if (record.state !== 'ready') return {state:'unavailable'};
  if (!Array.isArray(record.allocations)) return {state:'malformed'};
  if (record.roomVerified !== true) return {state: record.roomVerified === false ? 'notFound' : 'unverified'};
  // Freshness is the age of the ORIGINAL ETH answer (server cache and browser cache never reset it).
  const age = sourceAgeMs(record, nowMs);
  if (!Number.isFinite(age) || age >= freshMs) return {state:'stale'}; // unknown age counts as stale
  if (record.from && record.to && (today < record.from || today > record.to)) return {state:'unavailable'};
  const day = normalizeDay(record.allocations, today);
  if (!day.ok) return {state:'malformed'};
  return {state:'ready', blockers: day.blockers, fetchedAt: record.fetchedAt ?? null};
}

/** Per-room facts derived from blockers at minute `now` of `today`. */
export function analyze(blockers, now, today) {
  const merged = mergeBlockers(blockers);
  const overnight = blockers.filter(b => b.overnight);
  return {
    today, now, blockers, merged,
    gaps: gapsOf(merged),
    current: merged.find(b => b.start <= now && now < b.end) ?? null,
    overnightStart: overnight.length ? Math.min(...overnight.map(b => b.start)) : null
  };
}
/** The reservation/block that starts exactly where an unbooked gap ends (booked wins ties, then the longer one). */
function blockerStartingAt(blockers, minute) {
  const starting = blockers.filter(b => b.start === minute).sort((a, b) => (b.kind === 'booked') - (a.kind === 'booked') || b.end - a.end);
  return starting[0] ? {kind: starting[0].kind, type: starting[0].type, start: starting[0].start, end: starting[0].end, overnight: starting[0].overnight} : null;
}

// ---------- the three modes ----------
/** Free now: unbooked at this minute for at least MIN_FREE_MINUTES (elapsed). */
export function evaluateNow(a) {
  if (a.current) return null;
  const gap = a.gaps.find(g => g.start <= a.now && a.now < g.end);
  if (!gap) return null;
  const remaining = elapsedMinutes(a.today, a.now, gap.end);
  if (remaining < MIN_FREE_MINUTES) return null;
  return {mode:'now', until: gap.end, remaining, untilIsDayEnd: gap.end === DAY_END, next: blockerStartingAt(a.blockers, gap.end)};
}
/** Free soon: not already a Free-now match; the next unbooked interval starts within SOON_WINDOW_MINUTES and lasts
 * at least MIN_FREE_MINUTES. */
export function evaluateSoon(a) {
  if (evaluateNow(a)) return null;
  for (const gap of a.gaps) {
    if (gap.start <= a.now) continue;
    const minutesUntil = elapsedMinutes(a.today, a.now, gap.start);
    if (minutesUntil > SOON_WINDOW_MINUTES) return null;
    const duration = elapsedMinutes(a.today, gap.start, gap.end);
    if (duration >= MIN_FREE_MINUTES) {
      return {mode:'soon', start: gap.start, end: gap.end, minutesUntil, duration, endIsDayEnd: gap.end === DAY_END, next: blockerStartingAt(a.blockers, gap.end)};
    }
  }
  return null;
}
/** Rest of day: from `from` until the end boundary there is no reservation or block. A later booking pushes `from` to
 * the end of that booking, so a room with an afternoon booking is never "continuously free". The overnight block is
 * the boundary (not a blocker); without one the boundary is unknown (24:00) and only "no later reservations listed". */
export function evaluateRest(a) {
  const boundary = a.overnightStart ?? DAY_END;
  if (a.now >= boundary) return null;
  let from = a.now;
  for (const b of mergeBlockers(a.blockers.filter(x => !x.overnight))) {
    if (b.end > a.now && b.start < boundary) from = Math.max(from, b.end);
  }
  if (from >= boundary) return null;
  const duration = elapsedMinutes(a.today, from, boundary);
  if (duration < MIN_FREE_MINUTES) return null;
  return {mode:'rest', from, until: boundary, duration, freeNow: from === a.now, hasBoundary: a.overnightStart !== null};
}
export function evaluate(mode, analysis) {
  if (mode === 'soon') return evaluateSoon(analysis);
  if (mode === 'rest') return evaluateRest(analysis);
  return evaluateNow(analysis);
}

const byCode = (a, b) => a.room.code.localeCompare(b.room.code, undefined, {numeric:true});
const SORTERS = {
  now: (a, b) => b.remaining - a.remaining || byCode(a, b),                                  // longest uninterrupted first
  soon: (a, b) => a.start - b.start || b.duration - a.duration || byCode(a, b),               // earliest start, then longest
  rest: (a, b) => a.from - b.from || b.duration - a.duration || byCode(a, b)                  // earliest, then longest
};
/** Every eligible room for `mode`, best first. Rooms without fresh, complete, verified data never appear. */
export function recommend({rooms, mode, getRecord, ctx}) {
  const items = [];
  for (const room of rooms) {
    const assessed = assessRecord(getRecord(room.code), ctx);
    if (assessed.state !== 'ready') continue;
    const result = evaluate(mode, analyze(assessed.blockers, ctx.now, ctx.today));
    if (result) items.push({room, fetchedAt: assessed.fetchedAt, ...result});
  }
  return items.sort(SORTERS[mode] ?? SORTERS.now);
}

// ---------- text ----------
export function timeLabel(minute, format = '24') {
  if (minute >= DAY_END) return format === '12' ? '12:00 AM' : '24:00';
  return displayTime(minute, format);
}
export function formatDuration(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
const nextText = (next, format) => next ? `Next: ${next.kind === 'booked' ? 'Booked' : 'Blocked'} ${timeLabel(next.start, format)}–${timeLabel(next.end, format)}` : null;
/** Headline and detail line of a recommendation card. States only what the schedule verifies. */
export function cardText(item, format = '24') {
  const t = m => timeLabel(m, format);
  if (item.mode === 'soon') {
    return {
      headline: `Free in ${item.minutesUntil} min`,
      detail: `${t(item.start)}–${item.endIsDayEnd ? 'end of day' : t(item.end)} · ${formatDuration(item.duration)}`
    };
  }
  if (item.mode === 'rest') {
    // "Free for the rest of the day" is only said when an overnight block bounds a free interval that already started.
    if (item.hasBoundary) {
      return {
        headline: item.freeNow ? `Free now until ${t(item.until)}` : `Free from ${t(item.from)} until ${t(item.until)}`,
        detail: item.freeNow ? 'Free for the rest of the day: no later reservations before overnight block' : 'No later reservations before overnight block'
      };
    }
    return {headline: item.freeNow ? 'Free now' : `Free from ${t(item.from)}`, detail: 'No later reservations listed today'};
  }
  return {
    headline: item.untilIsDayEnd ? 'Free now' : `Free until ${t(item.until)}`,
    detail: nextText(item.next, format) ?? 'No later reservations listed today'
  };
}
export function emptyMessage(mode) {
  return {
    now: `No checked room is free for at least ${MIN_FREE_MINUTES} minutes right now.`,
    soon: `No checked room becomes free for at least ${MIN_FREE_MINUTES} minutes within the next ${SOON_WINDOW_MINUTES} minutes.`,
    rest: `No checked room is free until the end of the day.`
  }[mode] ?? '';
}

// ---------- which rooms to check (rate-limit aware) ----------
/** Order in which rooms of one campus should be checked: fresh cached results first (no request needed), then favorites,
 * then stale data, then unchecked rooms spread round-robin across buildings, then rooms with errors. Rooms ETH says do not
 * exist are left out. Deterministic for a given catalog and cache. */
export function orderCandidates({rooms, favorites = new Set(), getRecord, ctx}) {
  const groups = {fresh: [], favorite: [], stale: [], unchecked: [], troubled: []};
  for (const room of rooms) {
    const {state} = assessRecord(getRecord(room.code), ctx);
    if (state === 'notFound') continue;
    if (state === 'ready') groups.fresh.push(room);
    else if (favorites.has(room.code) && (state === 'loading' || state === 'stale')) groups.favorite.push(room);
    else if (state === 'stale') groups.stale.push(room);
    else if (state === 'loading') groups.unchecked.push(room);
    else groups.troubled.push(room);
  }
  const byBuilding = new Map();
  for (const room of groups.unchecked) {
    if (!byBuilding.has(room.building)) byBuilding.set(room.building, []);
    byBuilding.get(room.building).push(room);
  }
  const lists = [...byBuilding.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, list]) => list);
  const roundRobin = [];
  for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length) roundRobin.push(l[i]);
  return [...groups.fresh, ...groups.favorite, ...groups.stale, ...roundRobin, ...groups.troubled].map(r => r.code);
}
/** Next rooms to add to the checked set. Rooms with fresh data always join (they cost nothing). At most `count` rooms
 * that need a request are added. With `cachedCountsTowardBudget` (the initial batch) fresh rooms also use up the
 * budget, so a visitor with six or more fresh cached rooms triggers no request at all. Never returns rooms already
 * in `attempted`. */
export function planBatch({ordered, attempted, count, getRecord, ctx, cachedCountsTowardBudget = false}) {
  const added = [];
  let used = 0;
  for (const code of ordered) {
    if (attempted.has(code)) continue;
    if (assessRecord(getRecord(code), ctx).state === 'ready') { added.push(code); if (cachedCountsTowardBudget) used++; continue; }
    if (used >= count) continue;
    used++;
    added.push(code);
  }
  return added;
}
/** Does this record require an upstream request right now? Fresh data and errors still in their backoff do not. */
export function needsRequest(record, ctx) {
  const nowMs = ctx.nowMs ?? Date.now();
  if (!record) return true;
  if (record.state === 'error') return nowMs >= (record.retryAt || 0);
  if (isFreshRecord(record, nowMs)) return false;
  return nowMs >= (record.retryAt || 0);
}
/** The first load of a campus under ONE shared request budget (default 6) for favorites AND discovery:
 *   1. favorites of the selected campus, 2. other favorites (startup only), 3. discovery rooms of the campus.
 * Fresh cache entries are reused for free (they are never requested again and never use the budget). Favorites that do
 * not fit stay visible but are returned in `deferred`; they load only through a deliberate action.
 * Returns {request, admit, attempted, deferred}: request = rooms to fetch now, admit = rooms the app may keep refreshing,
 * attempted = campus rooms that feed recommendations and coverage. */
export function planInitialLoad({rooms, allRooms = rooms, favorites = [], getRecord, ctx, includeOtherFavorites = true, budget = INITIAL_REQUEST_BUDGET, target = INITIAL_CANDIDATES}) {
  const plan = {request: [], admit: [], attempted: [], deferred: []};
  const favSet = new Set(favorites);
  const byCode = (a, b) => a.localeCompare(b, undefined, {numeric: true});
  const campusFavs = rooms.filter(r => favSet.has(r.code)).map(r => r.code).sort(byCode);
  const otherFavs = includeOtherFavorites ? [...favSet].filter(c => !campusFavs.includes(c)).sort(byCode) : [];
  let used = 0;
  const consider = code => {
    if (!needsRequest(getRecord(code), ctx)) { plan.admit.push(code); return true; }
    if (used < budget) { used++; plan.request.push(code); plan.admit.push(code); return true; }
    plan.deferred.push(code);
    return false;
  };
  for (const code of campusFavs) if (consider(code)) plan.attempted.push(code);
  for (const code of otherFavs) consider(code);
  const ordered = orderCandidates({rooms: rooms.filter(r => !campusFavs.includes(r.code)), favorites: new Set(), getRecord, ctx});
  for (const code of ordered) {
    if (!needsRequest(getRecord(code), ctx)) { plan.admit.push(code); plan.attempted.push(code); continue; } // cache hit: free
    if (plan.attempted.length >= target || used >= budget) continue;
    used++;
    plan.request.push(code); plan.admit.push(code); plan.attempted.push(code);
  }
  return plan;
}
/** Which rooms to re-request when the app returns to the foreground. `candidates` is already in priority order (the open
 * room, rooms shown as recommendations, favorites, other checked rooms). Only rooms whose data expired (or whose backoff
 * ended) are returned, at most `budget` of them, without duplicates: revalidation never exceeds the request budget. */
export function planRevalidation({candidates, getRecord, ctx, budget = INITIAL_REQUEST_BUDGET}) {
  const out = [];
  for (const code of candidates) {
    if (out.length >= budget) break;
    if (out.includes(code)) continue;
    const record = getRecord(code);
    if (record && isFreshRecord(record, ctx.nowMs ?? Date.now())) continue; // still current: no request
    if (needsRequest(record, ctx)) out.push(code);
  }
  return out;
}
/** Rooms to refresh when the user pulls to refresh, in priority order, without duplicates and never more than `limit`
 * (the request budget). Callers pass favorites first (selected campus first), then the rooms currently recommended, then the rest. */
export function selectRefreshTargets({favorites = [], recommended = [], attempted = [], limit = INITIAL_REQUEST_BUDGET}) {
  const out = [];
  for (const code of [...favorites, ...recommended, ...attempted]) {
    if (out.length >= limit) break;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}
/** Honest result of a data refresh. A shared-cache answer is NOT reported as fresh from ETH. `newest` is the ETH fetch time (formatted). */
export function describeRefresh({targets = 0, eth = 0, cache = 0, failed = 0, newest = null}) {
  if (!targets) return 'Nothing to refresh yet — no rooms have been checked.';
  const parts = [];
  if (eth + cache) parts.push(`Updated ${plural(eth + cache, 'room')}: ${eth} from ETH, ${cache} from the shared cache`);
  if (failed) parts.push(`${plural(failed, 'room')} could not be updated`);
  if (newest && eth + cache) parts.push(`newest ETH data ${newest}`);
  return parts.join(' · ') || 'Nothing could be refreshed right now.';
}

/** Favorites from BOTH campuses, independent of campus, mode and free-only. Codes missing from the catalog are kept. */
export function favoriteRooms(rooms, favorites) {
  const known = new Map(rooms.map(r => [r.code, r]));
  return [...favorites].map(code => known.get(code) ?? {code, building: code.split(' ')[0], campus: null})
    .sort((a, b) => a.code.localeCompare(b.code, undefined, {numeric:true}));
}

// ---------- coverage ----------
export function summarizeCoverage({rooms, attempted, getRecord, ctx, isInflight = () => false}) {
  const s = {total: rooms.length, attempted: 0, checked: 0, loading: 0, refreshing: 0, unavailable: 0, rateLimited: 0, unverified: 0, notFound: 0, stale: 0, malformed: 0, staleCodes: [], lastRefresh: null};
  for (const room of rooms) {
    if (!attempted.has(room.code)) continue;
    s.attempted++;
    const a = assessRecord(getRecord(room.code), ctx);
    if (a.state === 'ready') {
      s.checked++;
      if (a.fetchedAt && Number.isFinite(Date.parse(a.fetchedAt)) && (!s.lastRefresh || Date.parse(a.fetchedAt) > Date.parse(s.lastRefresh))) s.lastRefresh = a.fetchedAt;
    } else if (a.state === 'stale') {
      // stale = older than the freshness limit and NOT being refreshed right now; refreshing = a request is in flight
      if (isInflight(room.code)) s.refreshing++; else { s.stale++; s.staleCodes.push(room.code); }
    } else s[a.state]++;
  }
  return s;
}
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** Honest coverage line. kind: empty | idle | loading | rateLimited | unavailable | stale | partial | complete */
export function describeCoverage(s, {pausedUntilMs = 0, nowMs = Date.now()} = {}) {
  const wait = Math.max(0, Math.ceil((pausedUntilMs - nowMs) / 1000));
  if (s.total === 0) return {kind:'empty', text:'No rooms are listed for this campus.', detail:''};
  if (s.attempted === 0) return {kind:'idle', text:'No rooms checked yet.', detail:''};
  if (s.checked === 0) {
    // Rate limiting wins over "loading": after a 429 the queue is paused, so most rooms are still unanswered but not "loading".
    if (s.rateLimited > 0 || wait > 0) {
      return {kind:'rateLimited', text:`ETH is limiting requests; no schedule loaded yet.${wait ? ` Retrying in about ${wait} s.` : ' Retrying shortly.'}`, detail:''};
    }
    if (s.loading > 0) return {kind:'loading', text:`Checking ${plural(s.attempted, 'room')}…`, detail:''};
    if (s.refreshing > 0) return {kind:'loading', text:`Refreshing ${plural(s.refreshing, 'room')}…`, detail:''};
    if (s.unavailable + s.malformed > 0) return {kind:'unavailable', text:`Schedules for the ${plural(s.attempted, 'room')} checked could not be loaded. Try again later.`, detail:''};
    if (s.stale > 0) return {kind:'stale', text:`Schedule data is older than 10 minutes, so nothing is recommended as free.`, detail:'Refresh to see current availability.'};
    return {kind:'unavailable', text:`None of the ${plural(s.attempted, 'room')} checked could be verified at ETH.`, detail:''};
  }
  const parts = [];
  if (s.loading) parts.push(`${s.loading} loading`);
  if (s.refreshing) parts.push(`${s.refreshing} refreshing`);
  if (s.stale) parts.push(`${s.stale} stale`);
  if (s.rateLimited) parts.push(`${s.rateLimited} rate limited`);
  if (s.unavailable + s.malformed) parts.push(`${s.unavailable + s.malformed} unavailable`);
  if (s.unverified + s.notFound) parts.push(`${s.unverified + s.notFound} not verified`);
  if (wait > 0) parts.push(`ETH pause: ${wait} s`);
  const notRequested = s.total - s.attempted;
  if (notRequested > 0) parts.push(`${notRequested} not checked yet`);
  if (s.checked === s.total) return {kind:'complete', text:`All ${plural(s.total, 'listed room')} checked.`, detail: parts.join(' · ')};
  return {kind:'partial', text:`Recommendations based on ${s.checked} of ${s.total} listed rooms checked.`, detail: parts.join(' · ')};
}
