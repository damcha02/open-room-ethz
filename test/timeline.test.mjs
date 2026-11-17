import test from 'node:test';
import assert from 'node:assert/strict';
import {dayAxis, assignLanes, buildDayModel, layoutTimeline, nextChange, statusBadge, freshnessInfo, intervalInfo, daySummary, currentStatus, resolveRecord, PX_PER_MIN} from '../public/timeline.mjs';
import {zurichParts} from '../public/schedule.mjs';

const D = '2026-11-18'; // winter day, 1440 real minutes
const hm = m => m >= 1440 ? '23:59' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const al = (a, b, type = 2, extra = {}, day = D) => ({start: `${day}T${hm(a)}:00`, end: `${day}T${hm(b)}:00`, type, ...extra});
const model = (allocs, day = D) => { const m = buildDayModel(allocs, day); assert.ok(m.ok, 'model should build'); return m; };
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

// ---------- interval construction ----------
test('timeline: heights and tops are exactly proportional to the durations (no padding, no minimum)', () => {
  const l = layoutTimeline(model([al(600, 720), al(725, 730, 13), al(900, 1080, 2)]));
  const by = Object.fromEntries(l.blocks.map(b => [b.start, b]));
  near(by[600].top, 600 * PX_PER_MIN); near(by[600].height, 120 * PX_PER_MIN);
  near(by[725].height, 5 * PX_PER_MIN);                     // a 5-minute block is NOT enlarged
  near(by[900].height, 180 * PX_PER_MIN);
  near(l.height, 1440 * PX_PER_MIN);
  assert.equal(l.totalMinutes, 1440);
  for (const b of l.blocks) near(b.height / b.minutes, PX_PER_MIN);
  for (const g of l.free) near(g.height / g.minutes, PX_PER_MIN);
});
test('timeline: free gaps fill exactly the space between blockers; blocks and gaps tile the whole day', () => {
  const l = layoutTimeline(model([al(480, 600), al(720, 780, 8)]));
  assert.deepEqual(l.free.map(g => [g.start, g.end]), [[0, 480], [600, 720], [780, 1440]]);
  const covered = [...l.free.map(g => g.minutes), ...l.blocks.map(b => b.minutes)].reduce((a, b) => a + b, 0);
  assert.equal(covered, 1440, 'no overlap, no hole');
  const empty = layoutTimeline(model([]));
  assert.deepEqual(empty.free.map(g => [g.start, g.end]), [[0, 1440]]);
  assert.deepEqual(empty.blocks, []);
});
test('timeline: kinds — type 2 booked; 8, 13, unknown and null are blocked; every kind blocks', () => {
  const m = model([al(60, 120, 2), al(180, 240, 8), al(300, 360, 13), al(420, 480, 99), {start: `${D}T09:00:00`, end: `${D}T10:00:00`}]);
  assert.deepEqual(m.intervals.map(i => i.kind), ['booked', 'blocked', 'blocked', 'blocked', 'blocked']);
  assert.equal(m.free.length, 6);
  assert.ok(m.free.every(g => !m.merged.some(b => b.start < g.end && g.start < b.end)), 'free gaps never overlap a block');
});
test('timeline: adjacent bookings keep full width and leave no free gap; overlapping ones share lanes', () => {
  const adj = layoutTimeline(model([al(540, 600), al(600, 660)]));
  assert.deepEqual(adj.blocks.map(b => [b.lane, b.lanes]), [[0, 1], [0, 1]]);
  assert.deepEqual(adj.free.map(g => [g.start, g.end]), [[0, 540], [660, 1440]], 'no 0-minute gap between adjacent bookings');
  const over = assignLanes(model([al(540, 660), al(600, 720), al(630, 700), al(800, 860)]).intervals);
  const find = s => over.find(i => i.start === s);
  assert.deepEqual([find(540).lane, find(600).lane, find(630).lane].sort(), [0, 1, 2]);
  assert.equal(find(540).lanes, 3);
  assert.deepEqual([find(800).lane, find(800).lanes], [0, 1], 'a later, separate booking is full width again');
  const merged = model([al(540, 660), al(600, 720)]).merged;
  assert.deepEqual(merged, [{start: 540, end: 720}], 'overlaps never create phantom free time');
});
test('timeline: identical and nested intervals are handled', () => {
  const same = assignLanes(model([al(600, 660), al(600, 660)]).intervals);
  assert.deepEqual(same.map(i => [i.lane, i.lanes]), [[0, 2], [1, 2]]);
  const nested = assignLanes(model([al(600, 900), al(660, 700), al(720, 760)]).intervals);
  assert.deepEqual(nested.map(i => [i.start, i.lane, i.lanes]), [[600, 0, 2], [660, 1, 2], [720, 1, 2]]);
});
test('timeline: cross-midnight entries are clipped and flagged', () => {
  const m = model([{start: '2026-11-17T22:00:00', end: `${D}T08:00:00`, type: 8}, {start: `${D}T22:00:00`, end: '2026-11-19T08:00:00', type: 8}]);
  assert.deepEqual(m.intervals.map(i => [i.start, i.end, i.continuesFromPrevDay, i.continuesToNextDay]), [[0, 480, true, false], [1320, 1440, false, true]]);
  const info = intervalInfo({...layoutTimeline(m).blocks[0]});
  assert.ok(info.notes.some(n => /previous day/.test(n)));
});
test('timeline: malformed, partial or non-array data never builds a model (so it can never be drawn as free)', () => {
  for (const bad of [null, 'x', [al(600, 700), {start: 'nope', end: `${D}T10:00:00`}], [al(600, 700), null], [{start: `${D}T12:00:00`, end: `${D}T11:00:00`}], [al(600, 700), {end: `${D}T10:00:00`}]]) {
    const m = buildDayModel(bad, D);
    assert.equal(m.ok, false, JSON.stringify(bad));
    assert.equal(m.reason, 'malformed');
  }
});
test('timeline: entries keep title, course number and the "not held" flag for the detail card', () => {
  const m = model([al(600, 720, 2, {title: 'Einsatz von Informatikmitteln', courseNumber: '252-0839-00', eventIsHeld: 0}), al(0, 480, 8)]);
  const booked = layoutTimeline(m).blocks.find(b => b.kind === 'booked');
  const info = intervalInfo(booked);
  assert.deepEqual([info.heading, info.range, info.duration, info.title, info.courseNumber], ['Booked', '10:00–12:00', '2 h', 'Einsatz von Informatikmitteln', '252-0839-00']);
  assert.ok(info.notes.some(n => /not taking place/.test(n) && /still shown as blocking/.test(n)), 'findetStatt 0 still blocks');
  const night = intervalInfo(layoutTimeline(m).blocks.find(b => b.type === 8));
  assert.deepEqual([night.heading, night.title], ['Blocked', 'Blocked interval (type 8)']);
  assert.ok(night.notes.some(n => /not treated as the building's opening hours/.test(n)), 'type 8 never claims opening hours');
  assert.equal(intervalInfo({kind: 'booked', type: 2, start: 600, end: 660, minutes: 60}).title, 'Reservation');
  assert.match(intervalInfo({kind: 'blocked', type: 13, start: 600, end: 660, minutes: 60}).notes[0], /type 13.*does not say/);
});

// ---------- axis, current time, 12h ----------
test('axis: a normal day has 25 hourly ticks labelled 00:00 … 24:00', () => {
  const axis = dayAxis(D);
  assert.equal(axis.total, 1440);
  assert.equal(axis.ticks.length, 25);
  assert.deepEqual(axis.ticks.slice(0, 3).map(t => [t.pos, t.minute, t.repeated]), [[0, 0, false], [60, 60, false], [120, 120, false]]);
  assert.deepEqual([axis.ticks.at(-1).pos, axis.ticks.at(-1).minute], [1440, 1440]);
});
test('current-time indicator: positioned at the elapsed time of "now", absent for other days', () => {
  const l = layoutTimeline(model([]), {nowMinute: 600});
  near(l.nowTop, 600 * PX_PER_MIN);
  assert.equal(layoutTimeline(model([])).nowTop, null);
  near(layoutTimeline(model([]), {nowMinute: 0}).nowTop, 0);
  near(layoutTimeline(model([]), {nowMinute: 1439}).nowTop, 1439 * PX_PER_MIN);
});

// ---------- Europe/Zurich daylight saving ----------
test('DST spring forward (2027-03-28): 23-hour axis, no 02:00 tick, proportional real durations', () => {
  const day = '2027-03-28';
  const axis = dayAxis(day);
  assert.equal(axis.total, 1380);
  assert.equal(axis.ticks.length, 24);
  assert.ok(!axis.ticks.some(t => t.minute === 120), 'the hour 02:00–03:00 does not exist');
  assert.deepEqual(axis.ticks.slice(0, 4).map(t => t.minute), [0, 60, 180, 240]);
  const l = layoutTimeline(model([al(60, 240, 2, {}, day)], day));   // wall 01:00–04:00 is only 2 real hours
  assert.equal(l.blocks[0].minutes, 120);
  near(l.blocks[0].height, 120 * PX_PER_MIN);
  near(l.height, 1380 * PX_PER_MIN);
  const covered = [...l.free, ...l.blocks].reduce((a, b) => a + b.minutes, 0);
  assert.equal(covered, 1380, 'blocks and free time tile the 23-hour day exactly');
  assert.equal(layoutTimeline(model([], day), {nowMinute: 180}).nowTop, 120 * PX_PER_MIN, 'wall 03:00 is exactly 2 real hours after midnight (the hour 02:00–03:00 does not exist)');
});
test('DST fall back (2026-10-25): 25-hour axis with the repeated hour marked', () => {
  const day = '2026-10-25';
  const axis = dayAxis(day);
  assert.equal(axis.total, 1500);
  assert.equal(axis.ticks.length, 26);
  assert.deepEqual(axis.ticks.slice(0, 5).map(t => [t.minute, t.repeated]), [[0, false], [60, false], [120, false], [120, true], [180, false]]);
  const l = layoutTimeline(model([al(60, 240, 2, {}, day)], day));    // wall 01:00–04:00 spans 4 real hours
  assert.equal(l.blocks[0].minutes, 240);
  near(l.height, 1500 * PX_PER_MIN);
  assert.equal([...l.free, ...l.blocks].reduce((a, b) => a + b.minutes, 0), 1500);
});
test('DST: every tick is strictly increasing and the labels equal the Zurich wall clock', () => {
  for (const day of ['2027-03-28', '2026-10-25', D]) {
    const axis = dayAxis(day);
    axis.ticks.forEach((t, i) => { if (i) assert.ok(t.pos > axis.ticks[i - 1].pos); });
    assert.equal(axis.ticks[0].minute, 0);
  }
  assert.equal(zurichParts(new Date(Date.UTC(2027, 2, 28, 1, 0))).minute, 180, 'sanity: 01:00Z on the spring day is 03:00 in Zurich');
});

// ---------- next change, status, freshness, summary ----------
test('next change: free now / booked now / blocked now / nothing later (never repeats the status line)', () => {
  const m = model([al(840, 960, 2), al(1320, 1440, 8)]);
  assert.deepEqual(nextChange(m, 600), {kind: 'free-until', at: 840, text: 'At 14:00 it becomes booked (until 16:00)'});
  assert.equal(nextChange(m, 900).text, 'At 16:00 it becomes free');
  assert.equal(nextChange(m, 1000).text, 'At 22:00 it becomes blocked (until 24:00)');
  assert.equal(nextChange(m, 1400).text, 'No change listed for the rest of today (blocked)');
  assert.equal(nextChange(model([]), 600).text, 'No later reservation listed today');
  assert.equal(nextChange(model([al(540, 600, 8)]), 570).text, 'At 10:00 it becomes free');
  assert.equal(nextChange(model([al(540, 600), al(600, 660, 13)]), 570).text, 'At 11:00 it becomes free', 'adjacent blocks are one block; the first free time is after both');
  assert.equal(nextChange(m, 900, '12').text, 'At 4:00 PM it becomes free');
  assert.doesNotMatch(nextChange(m, 600).text, /^Free until/, 'the status line already says that');
});
test('status badge: distinct labels, stale data is always marked', () => {
  assert.equal(statusBadge({state: 'free'}).text, 'Free');
  assert.equal(statusBadge({state: 'busy'}).text, 'Booked');
  assert.equal(statusBadge({state: 'blocked'}).text, 'Blocked');
  assert.equal(statusBadge({state: 'unknown'}).text, 'Unknown');
  assert.equal(statusBadge({state: 'loading'}).text, 'Loading');
  assert.equal(statusBadge({state: 'free', stale: true}).text, 'Free · Stale');
  assert.equal(statusBadge(undefined).text, 'Unknown');
  assert.doesNotMatch(['free', 'busy', 'blocked', 'unknown', 'loading'].map(s => statusBadge({state: s}).text).join(' '), /Unbooked|Reserved/);
});
test('freshness line is based on the ORIGINAL age and never claims confirmation for old data', () => {
  const now = Date.parse('2026-11-18T09:10:00Z'); // 10:10 Zurich
  const rec = ageMin => ({state: 'ready', allocations: [], roomVerified: true, receivedAt: now, ageAtReceiptMs: ageMin * 60000});
  assert.deepEqual([freshnessInfo(rec(3), now).level, freshnessInfo(rec(3), now).text], ['fresh', 'Updated 10:07 · 3 min ago']);
  assert.equal(freshnessInfo(rec(0), now).text, 'Updated 10:10 · just now');
  const stale = freshnessInfo(rec(14), now);
  assert.deepEqual([stale.level, stale.text], ['stale', 'Stale — updated 09:56 (14 min ago)']);
  assert.equal(freshnessInfo(rec(61), now).level, 'unknown');
  assert.equal(freshnessInfo(rec(9.9), now).level, 'fresh');
  assert.equal(freshnessInfo(rec(10), now).level, 'stale', 'exactly the limit is stale');
  assert.equal(freshnessInfo(undefined, now).level, 'none');
  assert.deepEqual([freshnessInfo({state: 'error', rateLimited: true}, now).level, freshnessInfo({state: 'error', rateLimited: true}, now).text], ['error', 'Rate limited — retrying later']);
  assert.equal(freshnessInfo({state: 'error'}, now).text, 'Could not be updated');
  assert.equal(freshnessInfo({state: 'ready', allocations: []}, now).level, 'unknown', 'no age information');
  assert.equal(freshnessInfo({...rec(1), receivedAt: now + 5000}, now).level, 'unknown', 'a clock that moved backwards');
});
test('day summary uses Free wording and real minutes', () => {
  assert.equal(daySummary(layoutTimeline(model([al(540, 600), al(600, 660, 8), al(900, 960)]))), '2 bookings, 1 block · 21 h free in total');
  assert.equal(daySummary(layoutTimeline(model([]))), 'No entries published · 24 h free in total');
  assert.equal(daySummary(layoutTimeline(model([al(0, 1440, 8)]))), '1 block · no free time');
  assert.doesNotMatch(daySummary(layoutTimeline(model([al(540, 600)]))), /Unbooked/i);
});

// ---------- current status and record resolution (what may be shown) ----------
test('current status comes from published intervals only (no opening hours assumed)', () => {
  const m = model([al(0, 480, 8), al(600, 720, 2), al(720, 780, 13), al(1320, 1440, 8)]);
  assert.deepEqual(currentStatus(m, 100), {state: 'blocked', text: 'Blocked until 08:00'});
  assert.deepEqual(currentStatus(m, 540), {state: 'free', text: 'Free until 10:00'});
  assert.deepEqual(currentStatus(m, 650), {state: 'busy', text: 'Booked until 13:00'}, 'adjacent booked + blocked: booked wins while a booking covers now');
  assert.deepEqual(currentStatus(m, 750), {state: 'blocked', text: 'Blocked until 13:00'});
  assert.deepEqual(currentStatus(m, 1400), {state: 'blocked', text: 'Blocked for the rest of today'});
  assert.deepEqual(currentStatus(model([]), 180), {state: 'free', text: 'Free — no later reservation listed today'}, 'no block published at 03:00 = free (no opening hours assumed)');
  assert.equal(currentStatus(m, 600).state, 'busy', 'half-open: a booking starting now covers now');
  assert.equal(currentStatus(m, 720).state, 'blocked');
  assert.equal(currentStatus(m, 780).state, 'free', 'a booking ending now no longer covers it');
});
const NOW = 7_000_000;
const okRec = (over = {}) => ({state: 'ready', allocations: [al(600, 720)], roomVerified: true, fetchedAt: '2026-11-18T09:00:00.000Z', receivedAt: NOW, ageAtReceiptMs: 60_000, ...over});
test('resolveRecord: a trustworthy fresh record is ready; old data is ready but stale', () => {
  const r = resolveRecord(okRec(), D, NOW);
  assert.deepEqual([r.kind, r.stale, r.ageMs], ['ready', false, 60_000]);
  assert.equal(r.model.free.length, 2);
  const old = resolveRecord(okRec({ageAtReceiptMs: 12 * 60_000}), D, NOW);
  assert.deepEqual([old.kind, old.stale], ['ready', true]);
  assert.deepEqual(resolveRecord(okRec({receivedAt: NOW - 3 * 60_000, ageAtReceiptMs: 8 * 60_000}), D, NOW).stale, true, 'local time since receipt counts: 8 + 3 = 11 minutes');
});
test('resolveRecord: failed, unverified, malformed, unknown-age and expired records never produce free time', () => {
  const cases = [
    [undefined, 'loading'], [{state: 'error'}, 'unavailable'], [{state: 'error', rateLimited: true}, 'unavailable'], [{state: 'weird'}, 'unavailable'],
    [okRec({allocations: null}), 'unavailable'], [okRec({roomVerified: false, allocations: []}), 'unavailable'], [okRec({roomVerified: null}), 'unavailable'],
    [okRec({allocations: [al(600, 720), {start: 'x', end: 'y'}]}), 'unavailable'],
    [okRec({ageAtReceiptMs: undefined}), 'loading'], [okRec({receivedAt: NOW + 1000}), 'loading'], [okRec({ageAtReceiptMs: 61 * 60_000}), 'loading']
  ];
  for (const [record, kind] of cases) {
    const r = resolveRecord(record, D, NOW);
    assert.equal(r.kind, kind, JSON.stringify(record));
    assert.equal(r.model, undefined, 'no model, so nothing can be drawn as free');
  }
  assert.equal(resolveRecord({state: 'error', rateLimited: true}, D, NOW).problem.heading, 'Rate limited');
  assert.equal(resolveRecord(okRec({roomVerified: false, allocations: []}), D, NOW).problem.heading, 'Room not found at ETH');
  assert.equal(resolveRecord(okRec({roomVerified: null}), D, NOW).problem.heading, 'Room not verified');
  assert.match(resolveRecord(okRec({allocations: [{}]}), D, NOW).problem.message, /availability is unknown/);
});
test('resolveRecord: the same weekly record serves every day of the week (no new request needed to switch days)', () => {
  const rec = okRec({allocations: [al(600, 720, 2, {}, '2026-11-18'), al(840, 900, 8, {}, '2026-11-19')]});
  const wed = resolveRecord(rec, '2026-11-18', NOW), thu = resolveRecord(rec, '2026-11-19', NOW), fri = resolveRecord(rec, '2026-11-20', NOW);
  assert.deepEqual([wed.model.intervals.length, thu.model.intervals.length, fri.model.intervals.length], [1, 1, 0]);
  assert.deepEqual(fri.model.free, [{start: 0, end: 1440}]);
});
