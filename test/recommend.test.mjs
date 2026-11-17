import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDay, mergeBlockers, gapsOf, assessRecord, analyze, evaluateNow, evaluateSoon, evaluateRest, recommend,
  cardText, emptyMessage, orderCandidates, planBatch, favoriteRooms, summarizeCoverage, describeCoverage,
  normalizeMode, timeLabel, formatDuration, MIN_FREE_MINUTES, SOON_WINDOW_MINUTES, planInitialLoad, needsRequest, INITIAL_REQUEST_BUDGET, planRevalidation
} from '../public/recommend.mjs';
import {elapsedMinutes, wallToInstant} from '../public/schedule.mjs';

const D = '2026-11-18'; // Wednesday, winter time (UTC+1)
const hm = m => m >= 1440 ? '23:59' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const alloc = (a, b, type = 2, day = D, extra = {}) => ({start: `${day}T${hm(a)}:00`, end: `${day}T${hm(b)}:00`, type, ...extra});
const NOW_MS = 10_000_000;
const ctx = (now = 600, today = D) => ({today, now, nowMs: NOW_MS});
// A cache record. `cachedAt` in overrides is a shorthand for "the ORIGINAL ETH answer was (NOW_MS - cachedAt) ms old when
// it was received just now"; undefined removes the age information altogether; a future value simulates a moved clock.
const rec = (allocations, over = {}) => {
  const {cachedAt, ...rest} = over;
  const record = {state: 'ready', allocations, roomVerified: true, fetchedAt: '2026-11-18T09:00:00.000Z', receivedAt: NOW_MS, ageAtReceiptMs: 1000, ...rest};
  if ('cachedAt' in over) {
    if (cachedAt === undefined) { delete record.ageAtReceiptMs; delete record.receivedAt; }
    else if (cachedAt > NOW_MS) { record.receivedAt = cachedAt; record.ageAtReceiptMs = 0; }
    else record.ageAtReceiptMs = NOW_MS - cachedAt;
  }
  return record;
};
const room = (code, building = code.split(' ')[0], campus = 'Zentrum') => ({code, building, campus});
const view = (blockers, now = 600, today = D) => analyze(blockers, now, today);
const day = (allocs, d = D) => { const r = normalizeDay(allocs, d); assert.ok(r.ok, 'expected ok'); return r.blockers; };
const night = [alloc(0, 480, 8), alloc(1320, 1440, 8)]; // typical type-8 night intervals (00–08, 22–23:59)

// ---------- schedule normalisation, half-open intervals ----------
test('half-open intervals: adjacent blocks merge, a block ending at now leaves the room unbooked', () => {
  assert.deepEqual(mergeBlockers(day([alloc(540, 600), alloc(600, 660)])), [{start: 540, end: 660}]);
  assert.deepEqual(mergeBlockers(day([alloc(540, 620), alloc(600, 660), alloc(700, 720)])), [{start: 540, end: 660}, {start: 700, end: 720}]);
  assert.deepEqual(gapsOf([{start: 540, end: 660}]), [{start: 0, end: 540}, {start: 660, end: 1440}]);
  assert.equal(evaluateNow(view(day([alloc(540, 600)]), 600)) !== null, true, 'booking [9:00,10:00) is over at 10:00');
  assert.equal(evaluateNow(view(day([alloc(600, 700)]), 600)), null, 'booking [10:00,11:40) covers 10:00');
  assert.equal(evaluateNow(view(day([alloc(540, 600), alloc(600, 660)]), 620)), null, 'adjacent bookings leave no gap at 10:00');
  assert.equal(evaluateNow(view(day([alloc(540, 600), alloc(600, 660)]), 660)) !== null, true);
});
test('zero-length entries block nothing; 23:59 means end of day; entries from other days are ignored', () => {
  assert.deepEqual(day([alloc(600, 600)]), []);
  assert.deepEqual(day([alloc(1320, 1439)]).map(b => b.end), [1440]);
  assert.deepEqual(day([alloc(600, 700, 2, '2026-11-17'), alloc(600, 700, 2, '2026-11-19')]), []);
});
test('cross-midnight entries are clipped to the day', () => {
  const blockers = day([{start: '2026-11-17T22:00:00', end: `${D}T08:00:00`, type: 8}, {start: `${D}T22:00:00`, end: '2026-11-19T08:00:00', type: 8}]);
  assert.deepEqual(blockers.map(b => [b.start, b.end, b.overnight]), [[0, 480, false], [1320, 1440, true]]);
});
test('types: 2 is booked; 8, 13, unknown numbers and null are blocked; all of them block time', () => {
  for (const [type, kind] of [[2, 'booked'], [8, 'blocked'], [13, 'blocked'], [99, 'blocked'], [null, 'blocked']]) {
    const [b] = day([alloc(600, 700, type)]);
    assert.equal(b.kind, kind, `type ${type}`);
    assert.equal(evaluateNow(view([b], 650)), null, `type ${type} must block`);
  }
});
test('findetStatt 0 (event reported as not held) still blocks, as unverified semantics demand', () => {
  const blockers = day([alloc(600, 700, 13, D, {eventIsHeld: 0})]);
  assert.equal(evaluateNow(view(blockers, 650)), null);
  assert.equal(evaluateRest(view(blockers, 650))?.from, 700);
});
test('only an evening type-8 block that runs to the end of the day is the overnight boundary', () => {
  assert.equal(day([alloc(1320, 1440, 8)])[0].overnight, true);
  assert.equal(day([alloc(1200, 1440, 8)])[0].overnight, true);
  assert.equal(day([alloc(1320, 1440, 13)])[0].overnight, false, 'type 13 is an ordinary blocker');
  assert.equal(day([alloc(1320, 1440, 2)])[0].overnight, false);
  assert.equal(day([alloc(0, 480, 8)])[0].overnight, false, 'morning block is not the boundary');
  assert.equal(day([alloc(0, 1440, 8)])[0].overnight, false, 'a whole-day block is not an evening boundary');
});

// ---------- eligibility: failed, malformed, unverified, stale ----------
test('only fresh, verified, complete records are eligible; everything else is excluded with a reason', () => {
  const c = ctx();
  const cases = [
    [undefined, 'loading'],
    [{state: 'error', message: 'x'}, 'unavailable'],
    [{state: 'error', rateLimited: true}, 'rateLimited'],
    [{state: 'weird'}, 'unavailable'],
    [rec([], {roomVerified: false}), 'notFound'],
    [rec([], {roomVerified: null}), 'unverified'],
    [rec([], {roomVerified: undefined}), 'unverified'],
    [rec([alloc(600, 700)], {roomVerified: null}), 'unverified'],
    [rec([], {cachedAt: NOW_MS - 10 * 60_000}), 'stale'],
    [rec([], {cachedAt: NOW_MS - 3_600_000}), 'stale'],
    [rec([], {cachedAt: NOW_MS + 5000}), 'stale'],
    [rec([], {cachedAt: undefined}), 'stale'],
    [rec(null), 'malformed'],
    [rec('nope'), 'malformed'],
    [rec([], {from: '2026-11-23', to: '2026-11-29'}), 'unavailable'],
    [rec([], {}), 'ready'],
    [rec([], {cachedAt: NOW_MS - (10 * 60_000 - 1)}), 'ready']
  ];
  for (const [record, expected] of cases) assert.equal(assessRecord(record, c).state, expected, JSON.stringify(record));
});
test('one malformed entry makes the whole schedule ineligible (nothing is skipped silently)', () => {
  const bad = [
    {end: `${D}T10:00:00`, type: 2}, {start: `${D}T10:00:00`, type: 2}, {start: 'later', end: `${D}T10:00:00`},
    {start: `${D}T25:00:00`, end: `${D}T26:00:00`}, {start: `2026-02-30T10:00:00`, end: `2026-02-30T11:00:00`},
    {start: `${D}T12:00:00`, end: `${D}T11:00:00`}, {start: `${D}T10:00:00Z`, end: `${D}T11:00:00Z`}, null, 'booking', 42
  ];
  for (const entry of bad) {
    const record = rec([alloc(900, 960), entry]);
    assert.equal(assessRecord(record, ctx()).state, 'malformed', JSON.stringify(entry));
    assert.deepEqual(recommend({rooms: [room('HG E 27')], mode: 'now', getRecord: () => record, ctx: ctx()}), []);
  }
});
test('verified room with an empty schedule is eligible (unbooked, nothing listed); an unverified one is not', () => {
  const rooms = [room('HG E 21'), room('HG E 22')];
  const records = {'HG E 21': rec([], {roomVerified: true}), 'HG E 22': rec([], {roomVerified: false})};
  const items = recommend({rooms, mode: 'now', getRecord: c => records[c], ctx: ctx()});
  assert.deepEqual(items.map(i => i.room.code), ['HG E 21']);
  assert.equal(items[0].untilIsDayEnd, true);
});
test('stale data is never a current recommendation', () => {
  const stale = rec([], {cachedAt: NOW_MS - 11 * 60_000});
  for (const mode of ['now', 'soon', 'rest']) assert.deepEqual(recommend({rooms: [room('HG E 27')], mode, getRecord: () => stale, ctx: ctx()}), []);
});

// ---------- Free now ----------
test('Free now: needs at least 30 uninterrupted minutes (29 fails, 30 passes)', () => {
  assert.equal(evaluateNow(view(day([alloc(629, 700)]), 600)), null);
  const ok = evaluateNow(view(day([alloc(630, 700)]), 600));
  assert.equal(ok.remaining, 30);
  assert.equal(ok.until, 630);
  assert.equal(MIN_FREE_MINUTES, 30);
});
test('Free now: reports the next booking or block, and day end when nothing follows', () => {
  const booked = evaluateNow(view(day([alloc(840, 960, 2)]), 600));
  assert.deepEqual([booked.until, booked.next.kind, booked.next.start, booked.next.end, booked.untilIsDayEnd], [840, 'booked', 840, 960, false]);
  const blocked = evaluateNow(view(day([alloc(840, 960, 13)]), 600));
  assert.equal(blocked.next.kind, 'blocked');
  const withNight = evaluateNow(view(day(night), 600));
  assert.deepEqual([withNight.until, withNight.next.kind, withNight.next.overnight], [1320, 'blocked', true]);
  const empty = evaluateNow(view([], 600));
  assert.deepEqual([empty.until, empty.untilIsDayEnd, empty.next], [1440, true, null]);
  const tie = evaluateNow(view(day([alloc(840, 900, 8), alloc(840, 870, 2)]), 600));
  assert.equal(tie.next.kind, 'booked', 'when both start together, the booking is reported');
});
test('Free now: the morning block ends the block; the evening block bounds the free time', () => {
  assert.equal(evaluateNow(view(day(night), 420)), null, '07:00 is inside the 00–08 type-8 block');
  assert.equal(evaluateNow(view(day(night), 480)).until, 1320);
  assert.equal(evaluateNow(view(day(night), 1300)), null, 'only 20 minutes before the evening block');
  assert.equal(evaluateNow(view(day(night), 1330)), null);
});
test('Free now: sorted by longest remaining time, ties by room code', () => {
  const records = {
    'HG E 3': rec([alloc(700, 800)]),          // 100 min
    'HG E 21': rec([alloc(960, 1000)]),        // 360 min
    'CHN C 14': rec([alloc(700, 800)]),        // 100 min, tie with HG E 3
    'HCI D 2': rec([alloc(590, 700)]),         // booked now -> excluded
    'ETA F 5': rec([alloc(625, 700)])          // 25 min -> excluded
  };
  const rooms = Object.keys(records).map(c => room(c));
  const items = recommend({rooms, mode: 'now', getRecord: c => records[c], ctx: ctx()});
  assert.deepEqual(items.map(i => i.room.code), ['HG E 21', 'CHN C 14', 'HG E 3']);
});

// ---------- Free soon ----------
test('Free soon: next unbooked interval within 60 minutes and at least 30 minutes long', () => {
  const soon = evaluateSoon(view(day([alloc(500, 630), alloc(700, 800)]), 600));
  assert.deepEqual([soon.minutesUntil, soon.start, soon.end, soon.duration], [30, 630, 700, 70]);
  assert.equal(evaluateSoon(view(day([alloc(500, 660)]), 600)).minutesUntil, 60, 'exactly 60 minutes qualifies');
  assert.equal(evaluateSoon(view(day([alloc(500, 661)]), 600)), null, '61 minutes does not');
  assert.equal(evaluateSoon(view(day([alloc(500, 630), alloc(659, 800)]), 600)), null, 'a 29-minute gap is too short');
  assert.equal(evaluateSoon(view(day([alloc(500, 630), alloc(660, 800)]), 600)).duration, 30);
  assert.equal(SOON_WINDOW_MINUTES, 60);
});
test('Free soon: rooms that already qualify for Free now are not listed; a short current gap can still lead to one', () => {
  assert.equal(evaluateSoon(view(day([alloc(800, 900)]), 600)), null);
  const short = evaluateSoon(view(day([alloc(620, 650)]), 600)); // 20 minutes left, then booked, then free from 10:50
  assert.deepEqual([short.start, short.minutesUntil], [650, 50]);
});
test('Free soon: sorted by earliest start, then longest interval', () => {
  const records = {
    A: rec([alloc(560, 650), alloc(700, 740)]), // starts 10:50, 50 min
    B: rec([alloc(560, 620), alloc(700, 1000)]), // starts 10:20, 280 min
    C: rec([alloc(560, 620), alloc(650, 700)]),  // starts 10:20, 30 min
    D: rec([alloc(560, 700), alloc(800, 900)])   // starts 11:40 -> too late
  };
  const items = recommend({rooms: Object.keys(records).map(c => room(c, 'X')), mode: 'soon', getRecord: c => records[c], ctx: ctx()});
  assert.deepEqual(items.map(i => i.room.code), ['B', 'C', 'A']);
});

// ---------- Rest of day ----------
test('Rest of day: a booking later in the afternoon prevents "continuously free"', () => {
  const r = evaluateRest(view(day([...night, alloc(900, 960)]), 600)); // free now, booked 15:00-16:00
  assert.equal(r.freeNow, false);
  assert.deepEqual([r.from, r.until, r.hasBoundary], [960, 1320, true]);
  assert.match(cardText({mode: 'rest', ...r, room: room('X')}).headline, /^Free from 16:00 until 22:00$/);
});
test('Rest of day: already unbooked until the overnight block', () => {
  const r = evaluateRest(view(day(night), 600));
  assert.deepEqual([r.from, r.until, r.freeNow, r.duration], [600, 1320, true, 720]);
  assert.deepEqual(cardText({mode: 'rest', ...r}), {headline: 'Free now until 22:00', detail: 'Free for the rest of the day: no later reservations before overnight block'});
});
test('Rest of day: becomes unbooked later today after a morning booking or the morning block', () => {
  const a = evaluateRest(view(day([...night, alloc(540, 840)]), 600));
  assert.deepEqual([a.from, a.until, a.freeNow], [840, 1320, false]);
  assert.deepEqual(cardText({mode: 'rest', ...a}), {headline: 'Free from 14:00 until 22:00', detail: 'No later reservations before overnight block'});
  const b = evaluateRest(view(day(night), 180)); // 03:00, inside the morning block
  assert.equal(b.from, 480);
});
test('Rest of day: without an overnight block only the narrower verified fact is stated', () => {
  const r = evaluateRest(view(day([alloc(540, 840)]), 600));
  assert.deepEqual([r.from, r.until, r.hasBoundary], [840, 1440, false]);
  const text = cardText({mode: 'rest', ...r});
  assert.equal(text.headline, 'Free from 14:00');
  assert.equal(text.detail, 'No later reservations listed today');
  assert.doesNotMatch(text.headline + text.detail, /overnight|until 2[24]|closes|open/i);
  assert.equal(cardText({mode: 'rest', ...evaluateRest(view([], 600))}).headline, 'Free now');
  assert.doesNotMatch(cardText({mode: 'rest', ...evaluateRest(view([], 600))}).detail, /rest of the day/i, '"rest of the day" needs an overnight boundary');
});
test('Rest of day: a type-13 (or any non-8) block at night is an ordinary blocker, not a boundary', () => {
  assert.equal(evaluateRest(view(day([alloc(1320, 1440, 13)]), 600)), null, 'blocked until the end of the day: nothing unbooked remains');
  assert.equal(evaluateRest(view(day([alloc(1320, 1440, 2)]), 600)), null);
  const entryWithoutType = {start: `${D}T22:00:00`, end: `${D}T23:59:00`};
  assert.equal(day([entryWithoutType])[0].kind, 'blocked');
  assert.equal(evaluateRest(view(day([entryWithoutType]), 600)), null, 'an entry without a type blocks and is not a boundary');
});
test('Rest of day: needs 30 minutes; a booking that overlaps the overnight block leaves nothing', () => {
  assert.equal(evaluateRest(view(day([...night, alloc(540, 1291)]), 600)), null, '29 minutes left');
  assert.equal(evaluateRest(view(day([...night, alloc(540, 1290)]), 600)).duration, 30);
  assert.equal(evaluateRest(view(day([...night, alloc(540, 1350, 2)]), 600)), null, 'booking runs into the boundary');
  assert.equal(evaluateRest(view(day(night), 1320)), null, 'inside the overnight block');
  assert.equal(evaluateRest(view(day(night), 1400)), null);
  assert.equal(evaluateRest(view(day([alloc(0, 1440, 8)]), 600)), null, 'whole-day block');
});
test('Rest of day: sorted by earliest availability, then longest interval', () => {
  const records = {
    late: rec([...night, alloc(540, 1000)]),                // from 16:40
    early: rec([...night]),                                  // from now (10:00)
    mid: rec([...night, alloc(540, 720)]),                   // from 12:00
    mid2: rec([alloc(540, 720)]),                            // from 12:00, until 24:00 (longer)
    none: rec([...night, alloc(900, 1310)])                  // only 10 min left
  };
  const items = recommend({rooms: Object.keys(records).map(c => room(c, 'X')), mode: 'rest', getRecord: c => records[c], ctx: ctx()});
  assert.deepEqual(items.map(i => i.room.code), ['early', 'mid2', 'mid', 'late']);
});

// ---------- cards text ----------
test('Free now card text, including 12-hour display and no-later-reservation wording', () => {
  assert.deepEqual(cardText({mode: 'now', ...evaluateNow(view(day([alloc(840, 960)]), 600))}), {headline: 'Free until 14:00', detail: 'Next: Booked 14:00–16:00'});
  assert.deepEqual(cardText({mode: 'now', ...evaluateNow(view(day([alloc(840, 960, 13)]), 600))}).detail, 'Next: Blocked 14:00–16:00');
  assert.deepEqual(cardText({mode: 'now', ...evaluateNow(view(day(night), 600))}), {headline: 'Free until 22:00', detail: 'Next: Blocked 22:00–24:00'});
  assert.deepEqual(cardText({mode: 'now', ...evaluateNow(view([], 600))}), {headline: 'Free now', detail: 'No later reservations listed today'});
  assert.equal(cardText({mode: 'now', ...evaluateNow(view(day([alloc(840, 960)]), 600))}, '12').headline, 'Free until 2:00 PM');
});
test('Free soon card text', () => {
  const item = evaluateSoon(view(day([alloc(500, 630), alloc(700, 800)]), 600));
  assert.deepEqual(cardText({mode: 'soon', ...item}), {headline: 'Free in 30 min', detail: '10:30–11:40 · 1 h 10 min'});
  assert.equal(cardText({mode: 'soon', ...evaluateSoon(view(day([alloc(500, 630)]), 600))}).detail, '10:30–end of day · 13 h 30 min');
});
test('helpers: labels, durations, mode validation, empty messages', () => {
  assert.equal(timeLabel(1440), '24:00');
  assert.equal(timeLabel(1440, '12'), '12:00 AM');
  assert.deepEqual([formatDuration(45), formatDuration(60), formatDuration(150)], ['45 min', '1 h', '2 h 30 min']);
  assert.deepEqual([normalizeMode('soon'), normalizeMode('x'), normalizeMode(undefined)], ['soon', 'now', 'now']);
  for (const mode of ['now', 'soon', 'rest']) assert.match(emptyMessage(mode), /^No checked room/);
});

// ---------- Europe/Zurich daylight saving ----------
test('DST (spring forward, 2027-03-28): thresholds use real elapsed minutes, not wall-clock', () => {
  const spring = '2027-03-28'; // 02:00 -> 03:00 does not exist
  assert.equal(elapsedMinutes(spring, 0, 1440), 23 * 60);
  assert.equal(elapsedMinutes(spring, 105, 195), 30); // 01:45 -> 03:15 is only 30 real minutes
  const at = (b, now = 105) => analyze(normalizeDay([{start: `${spring}T${hm(b)}:00`, end: `${spring}T${hm(b + 60)}:00`, type: 2}], spring).blockers, now, spring);
  assert.equal(evaluateNow(at(195))?.remaining, 30, 'wall-clock says 90 min, real time is exactly 30 (qualifies)');
  assert.equal(evaluateNow(at(194)), null, '29 real minutes does not qualify (wall-clock would say 89)');
  // blocked until 03:00 wall clock; the gap starts 15 real minutes after 01:45, wall-clock says 75
  const soon = evaluateSoon(analyze(normalizeDay([{start: `${spring}T01:00:00`, end: `${spring}T03:00:00`, type: 2}], spring).blockers, 105, spring));
  assert.equal(soon.minutesUntil, 15);
});
test('DST (fall back, 2026-10-25): the repeated hour makes spans longer than the wall-clock difference', () => {
  const fall = '2026-10-25'; // 03:00 -> 02:00, 02:00-03:00 happens twice
  assert.equal(elapsedMinutes(fall, 0, 1440), 25 * 60);
  assert.equal(elapsedMinutes(fall, 105, 195), 150);
  const soonCandidate = analyze(normalizeDay([{start: `${fall}T02:00:00`, end: `${fall}T03:30:00`, type: 2}], fall).blockers, 165, fall);
  assert.equal(evaluateSoon(soonCandidate), null, '02:45 -> 03:30 is 105 real minutes, not 45');
  const rest = evaluateRest(analyze(normalizeDay([{start: `${fall}T22:00:00`, end: `${fall}T23:59:00`, type: 8}], fall).blockers, 1260, fall));
  assert.equal(rest.duration, 60, '21:00 -> 22:00 after the transition is a normal 60 minutes');
});
test('wallToInstant is monotonic across both transitions', () => {
  for (const d of ['2027-03-28', '2026-10-25', '2026-11-18']) {
    let previous = -Infinity;
    for (let m = 0; m <= 1440; m += 5) {
      const t = wallToInstant(d, m);
      assert.ok(t >= previous, `${d} ${m}`);
      previous = t;
    }
  }
  assert.equal(wallToInstant('2026-11-18', 600), Date.UTC(2026, 10, 18, 9, 0)); // CET = UTC+1
  assert.equal(wallToInstant('2026-07-15', 600), Date.UTC(2026, 6, 15, 8, 0));  // CEST = UTC+2
});

// ---------- choosing which rooms to check ----------
const catalog = [
  room('AA 1', 'AA'), room('AA 2', 'AA'), room('AA 3', 'AA'), room('BB 1', 'BB'), room('BB 2', 'BB'), room('CC 1', 'CC'),
  room('CC 2', 'CC'), room('DD 1', 'DD'), room('DD 2', 'DD'), room('EE 1', 'EE')
];
test('candidate order: fresh cache, then favorites, then stale, then round-robin across buildings, then troubled; not-found skipped', () => {
  const records = {
    'EE 1': rec([]),                                               // fresh
    'DD 2': rec([], {cachedAt: NOW_MS - 20 * 60_000}),             // stale
    'CC 2': {state: 'error', message: 'x', retryAt: NOW_MS + 9999}, // troubled
    'AA 3': rec([], {roomVerified: false})                          // does not exist
  };
  const order = orderCandidates({rooms: catalog, favorites: new Set(['BB 2', 'AA 3']), getRecord: c => records[c], ctx: ctx()});
  assert.deepEqual(order, ['EE 1', 'BB 2', 'DD 2', 'AA 1', 'BB 1', 'CC 1', 'DD 1', 'AA 2', 'CC 2']);
  assert.ok(!order.includes('AA 3'));
  assert.equal(order.length, catalog.length - 1);
});
test('initial batch: cached rooms count toward the budget of 6; "check more" requests 6 further rooms; no duplicates', () => {
  const records = {'EE 1': rec([]), 'DD 1': rec([])};
  const get = c => records[c];
  const ordered = orderCandidates({rooms: catalog, getRecord: get, ctx: ctx()});
  const first = planBatch({ordered, attempted: new Set(), count: 6, getRecord: get, ctx: ctx(), cachedCountsTowardBudget: true});
  assert.equal(first.length, 6, '2 cached + 4 requests = 6 candidate rooms');
  assert.equal(first.filter(c => !records[c]).length, 4);
  const attempted = new Set(first);
  const more = planBatch({ordered, attempted, count: 6, getRecord: get, ctx: ctx()});
  assert.equal(more.length, 4, 'only 4 rooms remain');
  assert.ok(more.every(c => !attempted.has(c)));
  assert.deepEqual(planBatch({ordered, attempted: new Set([...attempted, ...more]), count: 6, getRecord: get, ctx: ctx()}), []);
});
test('initial batch: six or more fresh cached rooms mean no request at all; stale rooms are refreshed within the budget', () => {
  const many = Object.fromEntries(catalog.slice(0, 7).map(r => [r.code, rec([])]));
  const get = c => many[c];
  const batch = planBatch({ordered: orderCandidates({rooms: catalog, getRecord: get, ctx: ctx()}), attempted: new Set(), count: 6, getRecord: get, ctx: ctx(), cachedCountsTowardBudget: true});
  assert.equal(batch.length, 7, 'all seven fresh rooms are used (free)');
  assert.ok(batch.every(c => many[c]), 'and nothing else is requested');
  const stale = Object.fromEntries(catalog.map(r => [r.code, rec([], {cachedAt: NOW_MS - 30 * 60_000})]));
  const staleBatch = planBatch({ordered: orderCandidates({rooms: catalog, getRecord: c => stale[c], ctx: ctx()}), attempted: new Set(), count: 6, getRecord: c => stale[c], ctx: ctx(), cachedCountsTowardBudget: true});
  assert.equal(staleBatch.length, 6, 'at most 6 stale rooms are refreshed');
});
test('with nothing cached, the first batch is exactly 6 rooms spread across buildings', () => {
  const ordered = orderCandidates({rooms: catalog, getRecord: () => undefined, ctx: ctx()});
  const batch = planBatch({ordered, attempted: new Set(), count: 6, getRecord: () => undefined, ctx: ctx()});
  assert.deepEqual(batch, ['AA 1', 'BB 1', 'CC 1', 'DD 1', 'EE 1', 'AA 2']);
});
test('favorites list covers both campuses and is independent of anything else', () => {
  const rooms = [room('HG E 27', 'HG', 'Zentrum'), room('CHN C 14', 'CHN', 'Zentrum'), room('HCI D 2', 'HCI', 'Hönggerberg')];
  const list = favoriteRooms(rooms, new Set(['HCI D 2', 'HG E 27', 'ZZ X 9']));
  assert.deepEqual(list.map(r => r.code), ['HCI D 2', 'HG E 27', 'ZZ X 9']);
  assert.deepEqual(list.map(r => r.campus), ['Hönggerberg', 'Zentrum', null]);
  assert.deepEqual(favoriteRooms(rooms, new Set()), []);
});

// ---------- coverage, partial coverage, rate limits ----------
const coverage = (records, attempted, rooms = catalog) => summarizeCoverage({rooms, attempted: new Set(attempted), getRecord: c => records[c], ctx: ctx()});
test('coverage counts and the partial-coverage sentence', () => {
  const records = {'AA 1': rec([]), 'AA 2': rec([]), 'BB 1': {state: 'error'}, 'BB 2': undefined, 'CC 1': {state: 'error', rateLimited: true}, 'CC 2': rec([], {roomVerified: false}), 'DD 1': rec([], {cachedAt: 1})};
  const s = coverage(records, ['AA 1', 'AA 2', 'BB 1', 'BB 2', 'CC 1', 'CC 2', 'DD 1']);
  assert.deepEqual([s.total, s.attempted, s.checked, s.unavailable, s.loading, s.rateLimited, s.notFound, s.stale], [10, 7, 2, 1, 1, 1, 1, 1]);
  assert.equal(s.lastRefresh, '2026-11-18T09:00:00.000Z');
  const text = describeCoverage(s);
  assert.equal(text.kind, 'partial');
  assert.equal(text.text, 'Recommendations based on 2 of 10 listed rooms checked.');
  assert.match(text.detail, /1 loading/);
  assert.match(text.detail, /1 stale/, 'stale and idle is reported as stale, not as refreshing');
  assert.match(text.detail, /1 rate limited/);
  assert.match(text.detail, /1 unavailable/);
  assert.match(text.detail, /1 not verified/);
  assert.match(text.detail, /3 not checked yet/);
});
test('coverage wording for 8 of 64 and for complete coverage', () => {
  const rooms = Array.from({length: 64}, (_, i) => room(`HG E ${i + 1}`));
  const records = Object.fromEntries(rooms.slice(0, 8).map(r => [r.code, rec([])]));
  const s = summarizeCoverage({rooms, attempted: new Set(rooms.slice(0, 8).map(r => r.code)), getRecord: c => records[c], ctx: ctx()});
  assert.equal(describeCoverage(s).text, 'Recommendations based on 8 of 64 listed rooms checked.');
  const all = summarizeCoverage({rooms: catalog, attempted: new Set(catalog.map(r => r.code)), getRecord: () => rec([]), ctx: ctx()});
  assert.deepEqual([describeCoverage(all).kind, describeCoverage(all).text], ['complete', 'All 10 listed rooms checked.']);
});
test('coverage with nothing checked distinguishes loading, rate limiting, unavailability and "not yet requested"', () => {
  assert.equal(describeCoverage(coverage({}, [])).kind, 'idle');
  assert.equal(describeCoverage(coverage({}, ['AA 1', 'AA 2'])).kind, 'loading');
  assert.equal(describeCoverage(coverage({'AA 1': {state: 'error'}, 'AA 2': {state: 'error'}}, ['AA 1', 'AA 2'])).kind, 'unavailable');
  const limited = coverage({'AA 1': {state: 'error', rateLimited: true}, 'AA 2': {state: 'error'}}, ['AA 1', 'AA 2']);
  const d = describeCoverage(limited, {pausedUntilMs: 50_000, nowMs: 20_000});
  assert.equal(d.kind, 'rateLimited');
  assert.match(d.text, /Retrying in about 30 s/);
  // after a 429 the queue is paused: some rooms are rate limited, the rest still unanswered -> report the rate limit, not "Checking…"
  const pausedMix = coverage({'AA 1': {state: 'error', rateLimited: true}, 'AA 2': {state: 'error', rateLimited: true}}, ['AA 1', 'AA 2', 'BB 1', 'BB 2']);
  assert.equal(pausedMix.loading, 2);
  assert.equal(describeCoverage(pausedMix, {pausedUntilMs: 90_000, nowMs: 20_000}).kind, 'rateLimited');
  assert.equal(describeCoverage(coverage({}, ['AA 1', 'AA 2']), {pausedUntilMs: 90_000, nowMs: 20_000}).kind, 'rateLimited', 'an active pause alone is enough');
  assert.equal(describeCoverage(coverage({'AA 1': rec([], {roomVerified: false})}, ['AA 1'])).kind, 'unavailable');
  const idleStale = describeCoverage(coverage({'AA 1': rec([], {cachedAt: 1})}, ['AA 1']));
  assert.equal(idleStale.kind, 'stale', 'no request is running, so it must not say "Refreshing"');
  assert.match(idleStale.text, /older than 10 minutes/);
  assert.match(idleStale.detail, /Refresh/);
  const running = summarizeCoverage({rooms: catalog, attempted: new Set(['AA 1']), getRecord: () => rec([], {cachedAt: 1}), ctx: ctx(), isInflight: c => c === 'AA 1'});
  assert.deepEqual([running.refreshing, running.stale, describeCoverage(running).kind, describeCoverage(running).text], [1, 0, 'loading', 'Refreshing 1 room…']);
  assert.equal(describeCoverage(coverage({}, [], [])).kind, 'empty');
  // a pause while some rooms are already checked is reported next to the partial coverage, not as an error
  const partial = describeCoverage(coverage({'AA 1': rec([])}, ['AA 1', 'AA 2']), {pausedUntilMs: 40_000, nowMs: 20_000});
  assert.equal(partial.kind, 'partial');
  assert.match(partial.detail, /ETH pause: 20 s/);
});
test('rate-limited, failed and loading rooms never produce a recommendation', () => {
  const records = {a: {state: 'error', rateLimited: true}, b: {state: 'error'}, c: undefined, d: rec([])};
  const items = recommend({rooms: ['a', 'b', 'c', 'd'].map(c => room(c, 'X')), mode: 'now', getRecord: c => records[c], ctx: ctx()});
  assert.deepEqual(items.map(i => i.room.code), ['d']);
});

// ---------- Stage 3A.1: one shared initial request budget ----------
const campusRoomsList = Array.from({length: 20}, (_, i) => room(`B${String(i % 5).padStart(2, '0')} X ${i}`, `B${i % 5}`));
const otherCampus = [room('HCI D 2', 'HCI', 'Hönggerberg'), room('HCI D 3', 'HCI', 'Hönggerberg')];
const everyRoom = [...campusRoomsList, ...otherCampus];
const plan = (favorites, records = {}, over = {}) => planInitialLoad({rooms: campusRoomsList, allRooms: everyRoom, favorites, getRecord: c => records[c], ctx: ctx(), ...over});
test('initial budget: a fresh visitor without favorites requests exactly 6 rooms', () => {
  const p = plan([]);
  assert.equal(INITIAL_REQUEST_BUDGET, 6);
  assert.equal(p.request.length, 6);
  assert.equal(p.attempted.length, 6);
  assert.deepEqual(p.deferred, []);
});
test('initial budget: favorites and discovery share ONE budget of 6 — campus favorites first, then other favorites, then discovery', () => {
  const [f1, f2] = [campusRoomsList[7].code, campusRoomsList[3].code];
  const p = plan([f1, f2, 'HCI D 2']);
  assert.equal(p.request.length, 6, 'never more than 6 in total');
  assert.deepEqual(p.request.slice(0, 3), ['B02 X 7', 'B03 X 3', 'HCI D 2'], 'campus favorites (sorted) first, then the other-campus favorite');
  assert.equal(p.request.filter(c => c.startsWith('B')).length, 5, 'the remaining 3 slots go to discovery: 2 campus favorites + 3 discovery rooms');
  assert.ok(p.request.includes('HCI D 2'));
  assert.deepEqual(p.deferred, []);
  assert.ok(p.attempted.includes(f1) && p.attempted.includes(f2) && !p.attempted.includes('HCI D 2'), 'only campus rooms feed the campus recommendations');
  assert.equal(new Set(p.request).size, p.request.length, 'no duplicate requests');
});
test('initial budget: more favorites than the budget — extra favorites are deferred, never requested, and there is no discovery', () => {
  const campusFavs = campusRoomsList.slice(0, 5).map(r => r.code);
  const p = plan([...campusFavs, 'HCI D 2', 'HCI D 3']);
  assert.equal(p.request.length, 6);
  assert.deepEqual(p.request.slice(0, 5).sort(), [...campusFavs].sort(), 'all five campus favorites come first');
  assert.equal(p.request[5], 'HCI D 2');
  assert.deepEqual(p.deferred, ['HCI D 3']);
  assert.equal(p.request.filter(c => !campusFavs.includes(c) && c !== 'HCI D 2').length, 0, 'no budget left for discovery');
  const many = plan(campusRoomsList.slice(0, 9).map(r => r.code));
  assert.equal(many.request.length, 6);
  assert.equal(many.deferred.length, 3, 'campus favorites beyond the budget stay visible but unrequested');
  assert.ok(many.deferred.every(c => !many.attempted.includes(c) && !many.request.includes(c)));
});
test('initial budget: fresh cache entries are reused for free and never use the budget', () => {
  const fresh = Object.fromEntries(campusRoomsList.slice(0, 4).map(r => [r.code, rec([])]));
  const p = plan([campusRoomsList[0].code, campusRoomsList[1].code, 'HCI D 2'], {...fresh, 'HCI D 2': rec([])});
  assert.ok(!p.request.includes(campusRoomsList[0].code) && !p.request.includes('HCI D 2'), 'fresh favorites are not requested again');
  assert.ok(p.admit.includes('HCI D 2') && p.admit.includes(campusRoomsList[0].code));
  assert.equal(p.attempted.length, 6, 'six candidates: 4 fresh cache hits (2 of them favorites) + 2 requested');
  assert.equal(p.request.length, 2, 'only the two missing candidates are requested');
  const six = plan([], Object.fromEntries(campusRoomsList.slice(0, 7).map(r => [r.code, rec([])])));
  assert.deepEqual(six.request, [], 'six or more fresh cached rooms mean no request at all');
  assert.equal(six.attempted.length, 7, 'and they all feed the recommendations');
});
test('initial budget: stale data, errors in backoff and fresh data are told apart', () => {
  const c = ctx();
  assert.equal(needsRequest(undefined, c), true);
  assert.equal(needsRequest(rec([]), c), false);
  assert.equal(needsRequest(rec([], {cachedAt: NOW_MS - 11 * 60_000}), c), true, 'stale (source older than 10 min)');
  assert.equal(needsRequest(rec([], {cachedAt: undefined}), c), true, 'unknown age');
  assert.equal(needsRequest({state: 'error', retryAt: NOW_MS + 5000}, c), false, 'still in backoff');
  assert.equal(needsRequest({state: 'error', retryAt: NOW_MS - 1}, c), true);
  assert.equal(needsRequest(rec([], {cachedAt: NOW_MS - 11 * 60_000, retryAt: NOW_MS + 5000}), c), false, 'stale but backing off');
});
test('initial budget: switching campus plans that campus only (no other-campus favorites), still within the budget', () => {
  const p = planInitialLoad({rooms: otherCampus, allRooms: everyRoom, favorites: [campusRoomsList[0].code, 'HCI D 2'], getRecord: () => undefined, ctx: ctx(), includeOtherFavorites: false});
  assert.ok(!p.request.includes(campusRoomsList[0].code), 'favorites of the other campus are not requested on a campus switch');
  assert.deepEqual(p.request.sort(), ['HCI D 2', 'HCI D 3']);
  assert.ok(p.request.length <= 6);
});
test('initial budget: a custom budget is honoured and rooms unknown to the catalog cannot break planning', () => {
  const p = plan(['ZZ X 9', campusRoomsList[0].code], {}, {budget: 2});
  assert.equal(p.request.length, 2);
  assert.equal(p.attempted.length, 1, 'only catalog rooms feed the campus recommendations; discovery has no budget left');
  assert.ok(p.deferred.includes('ZZ X 9') === false, 'ZZ X 9 is requested as an other favorite');
});

// ---------- Stage 3B: foreground revalidation stays inside the request budget ----------
test('revalidation: only expired rooms are requested, in priority order, never more than the budget', () => {
  const c = ctx();
  const records = {
    open: rec([], {cachedAt: NOW_MS - 12 * 60_000}), a: rec([]), b: rec([], {cachedAt: NOW_MS - 20 * 60_000}),
    c: {state: 'error', retryAt: NOW_MS + 9999}, d: {state: 'error', retryAt: NOW_MS - 1}, e: undefined,
    f1: rec([], {cachedAt: NOW_MS - 15 * 60_000}), f2: rec([], {cachedAt: NOW_MS - 15 * 60_000}), f3: rec([], {cachedAt: NOW_MS - 15 * 60_000}), f4: rec([], {cachedAt: NOW_MS - 15 * 60_000})
  };
  const get = code => records[code];
  assert.deepEqual(planRevalidation({candidates: ['open', 'a', 'b', 'c', 'd', 'e'], getRecord: get, ctx: c}), ['open', 'b', 'd', 'e'], 'fresh (a) and backing-off (c) rooms are skipped');
  assert.deepEqual(planRevalidation({candidates: ['open', 'open', 'b', 'b'], getRecord: get, ctx: c}), ['open', 'b'], 'no duplicates');
  const many = planRevalidation({candidates: ['open', 'b', 'd', 'e', 'f1', 'f2', 'f3', 'f4'], getRecord: get, ctx: c});
  assert.equal(many.length, INITIAL_REQUEST_BUDGET, 'at most the request budget');
  assert.deepEqual(many.slice(0, 2), ['open', 'b'], 'the open room and recommended rooms come first');
  assert.deepEqual(planRevalidation({candidates: ['open', 'b'], getRecord: get, ctx: c, budget: 1}), ['open']);
  assert.deepEqual(planRevalidation({candidates: ['a'], getRecord: get, ctx: c}), [], 'everything fresh: zero requests');
  assert.deepEqual(planRevalidation({candidates: [], getRecord: get, ctx: c}), []);
});
test('revalidation: a stale record that is backing off after a failed refresh is not asked again yet', () => {
  const backoff = rec([], {cachedAt: NOW_MS - 15 * 60_000, retryAt: NOW_MS + 30_000});
  assert.deepEqual(planRevalidation({candidates: ['x'], getRecord: () => backoff, ctx: ctx()}), []);
  assert.deepEqual(planRevalidation({candidates: ['x'], getRecord: () => ({...backoff, retryAt: NOW_MS - 1}), ctx: ctx()}), ['x']);
});

// ---------- Stage 4: pull-to-refresh targets and honest result wording ----------
import {selectRefreshTargets, describeRefresh} from '../public/recommend.mjs';
test('refresh targets: favorites first, then recommended, then the rest; unique and bounded by the request budget', () => {
  assert.deepEqual(selectRefreshTargets({favorites: ['f1', 'f2'], recommended: ['f2', 'r1'], attempted: ['a1', 'a2', 'a3', 'a4', 'a5']}), ['f1', 'f2', 'r1', 'a1', 'a2', 'a3']);
  assert.equal(selectRefreshTargets({favorites: Array.from({length: 20}, (_, i) => `f${i}`)}).length, INITIAL_REQUEST_BUDGET, 'never more than 6, however many favorites');
  assert.deepEqual(selectRefreshTargets({favorites: ['f1'], limit: 1, recommended: ['r1']}), ['f1']);
  assert.deepEqual(selectRefreshTargets({}), []);
  assert.deepEqual(selectRefreshTargets({recommended: ['x', 'x', 'x']}), ['x']);
});
test('refresh wording: a shared-cache answer is never reported as fresh from ETH', () => {
  assert.equal(describeRefresh({targets: 6, eth: 2, cache: 3, failed: 1, newest: '12:03'}), 'Updated 5 rooms: 2 from ETH, 3 from the shared cache · 1 room could not be updated · newest ETH data 12:03');
  assert.equal(describeRefresh({targets: 3, eth: 0, cache: 3, newest: '12:01'}), 'Updated 3 rooms: 0 from ETH, 3 from the shared cache · newest ETH data 12:01');
  assert.equal(describeRefresh({targets: 1, eth: 1, cache: 0, newest: '12:05'}), 'Updated 1 room: 1 from ETH, 0 from the shared cache · newest ETH data 12:05');
  assert.equal(describeRefresh({targets: 2, failed: 2}), '2 rooms could not be updated');
  assert.equal(describeRefresh({targets: 0}), 'Nothing to refresh yet — no rooms have been checked.');
  assert.doesNotMatch(describeRefresh({targets: 4, eth: 0, cache: 4, newest: '12:00'}), /from ETH: [1-9]|freshly/i);
});
