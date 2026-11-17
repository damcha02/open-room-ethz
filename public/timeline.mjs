/** Room timeline: pure functions (no DOM, no network). See docs/UX_SPEC.md §8.
 *
 * Data comes from the same strict normalisation as the recommendations (`normalizeDay`): one malformed entry makes the
 * whole day unavailable, so a broken schedule can never be drawn as free.
 *
 * Geometry is based on REAL elapsed time since local midnight (Europe/Zurich), not on wall-clock minutes:
 *   - a 23-hour day (spring forward) has no 02:00 hour and the axis is 1380 minutes long,
 *   - a 25-hour day (fall back) shows the repeated hour twice and the axis is 1500 minutes long.
 * ETH timestamps carry no offset, so an interval inside the repeated hour is ambiguous; it is placed in its first occurrence.
 */
import {normalizeDay, mergeBlockers, gapsOf, timeLabel, formatDuration, DAY_END} from './recommend.mjs';
import {wallToInstant, zurichParts, displayTime, sourceAgeMs, FRESH_MS, MAX_STALE_MS} from './schedule.mjs';

export const PX_PER_MIN = 1.2; // 72 px per hour: a 30-minute booking is 36 px tall

// ---------- axis ----------
const axisCache = new Map();
/** Real-time axis of one Zurich day: {total, pos(wallMinute), ticks:[{pos, minute, repeated}]}.
 * One tick per real hour; its label is the wall-clock time at that instant, so skipped and repeated hours come out right. */
export function dayAxis(day) {
  if (axisCache.has(day)) return axisCache.get(day);
  const t0 = wallToInstant(day, 0);
  const total = Math.round((wallToInstant(day, DAY_END) - t0) / 60000);
  const pos = wallMinute => Math.round((wallToInstant(day, Math.min(DAY_END, Math.max(0, wallMinute))) - t0) / 60000);
  const ticks = [];
  const seen = new Set();
  for (let p = 0; p <= total; p += 60) {
    const parts = zurichParts(new Date(t0 + p * 60000));
    const minute = parts.date === day ? parts.minute : DAY_END;
    ticks.push({pos: p, minute, repeated: seen.has(minute)});
    seen.add(minute);
  }
  const axis = {total, pos, ticks};
  if (axisCache.size > 120) axisCache.clear();
  axisCache.set(day, axis);
  return axis;
}

// ---------- overlapping intervals ----------
/** Puts overlapping intervals into side-by-side lanes (calendar style). Adjacent intervals (end == start, half-open) do not
 * overlap and keep the full width. Every item gets `lane` (0-based) and `lanes` (number of lanes in its overlap cluster). */
export function assignLanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let cluster = [], laneEnds = [], clusterEnd = -1;
  const flush = () => { const lanes = laneEnds.length || 1; for (const it of cluster) it.lanes = lanes; out.push(...cluster); cluster = []; laneEnds = []; };
  for (const item of sorted) {
    if (cluster.length && item.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex(end => end <= item.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(item.end); } else laneEnds[lane] = item.end;
    cluster.push({...item, lane});
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (cluster.length) flush();
  return out;
}

// ---------- model and layout ----------
/** {ok:false, reason} for malformed data, otherwise the day's intervals (with lanes), merged blockers and free gaps. */
export function buildDayModel(allocations, day) {
  const normalized = normalizeDay(allocations, day);
  if (!normalized.ok) return {ok: false, reason: normalized.reason};
  return {ok: true, day, intervals: assignLanes(normalized.blockers), merged: mergeBlockers(normalized.blockers), free: gapsOf(mergeBlockers(normalized.blockers))};
}
/** Pixel geometry. Heights are exactly proportional to REAL durations; nothing is padded or enlarged. */
export function layoutTimeline(model, {pxPerMin = PX_PER_MIN, nowMinute = null} = {}) {
  const axis = dayAxis(model.day);
  const px = minutes => Math.round(minutes * pxPerMin * 100) / 100;
  const place = (start, end) => { const a = axis.pos(start), b = axis.pos(end); return {top: px(a), height: px(b - a), minutes: b - a}; };
  return {
    height: px(axis.total),
    totalMinutes: axis.total,
    pxPerMin,
    ticks: axis.ticks.map(t => ({...t, top: px(t.pos)})),
    free: model.free.map(g => ({start: g.start, end: g.end, ...place(g.start, g.end)})).filter(g => g.height > 0),
    blocks: model.intervals.map(i => ({...i, ...place(i.start, i.end)})).filter(b => b.height > 0),
    nowTop: nowMinute === null ? null : px(axis.pos(nowMinute))
  };
}

// ---------- texts ----------
const kindWord = kind => kind === 'booked' ? 'Booked' : 'Blocked';
/** What changes next, relative to `nowMinute` of the model's day. States only facts the published schedule contains. */
export function nextChange(model, nowMinute, format = '24') {
  const t = m => timeLabel(m, format);
  const covering = model.intervals.filter(i => i.start <= nowMinute && nowMinute < i.end);
  const current = model.merged.find(b => b.start <= nowMinute && nowMinute < b.end);
  if (current) {
    const what = covering.some(i => i.kind === 'booked') ? 'Booked' : 'Blocked';
    if (current.end >= DAY_END) return {kind: 'none', at: null, text: `No change listed for the rest of today (${what.toLowerCase()})`};
    return {kind: 'free-from', at: current.end, text: `At ${t(current.end)} it becomes free`};
  }
  const gap = model.free.find(g => g.start <= nowMinute && nowMinute < g.end);
  if (!gap || gap.end >= DAY_END) return {kind: 'none', at: null, text: 'No later reservation listed today'};
  const next = model.intervals.filter(i => i.start === gap.end).sort((a, b) => (b.kind === 'booked') - (a.kind === 'booked') || b.end - a.end)[0];
  return {kind: 'free-until', at: gap.end, text: next ? `At ${t(gap.end)} it becomes ${kindWord(next.kind).toLowerCase()} (until ${t(next.end)})` : `At ${t(gap.end)} the free time ends`};
}
/** Badge for the current status. Stale data is always labelled as such and never reads as confirmed. */
export function statusBadge(status) {
  const label = {free: 'Free', busy: 'Booked', blocked: 'Blocked', unknown: 'Unknown', loading: 'Loading'}[status?.state] ?? 'Unknown';
  return {label, tone: status?.state ?? 'unknown', stale: Boolean(status?.stale), text: `${label}${status?.stale ? ' · Stale' : ''}`};
}
/** Freshness line: level fresh | stale | none | error | unknown. Age is the age of the ORIGINAL ETH answer. */
export function freshnessInfo(record, nowMs, format = '24') {
  if (!record) return {level: 'none', text: 'Not loaded yet', refreshable: true};
  if (record.state === 'error') return {level: 'error', text: record.rateLimited ? 'Rate limited — retrying later' : 'Could not be updated', refreshable: true};
  const age = sourceAgeMs(record, nowMs);
  if (record.state !== 'ready' || !Number.isFinite(age)) return {level: 'unknown', text: 'Age of this data is unknown — treated as stale', refreshable: true};
  if (age >= MAX_STALE_MS) return {level: 'unknown', text: 'Too old to show', refreshable: true};
  const at = displayTime(zurichParts(new Date(nowMs - age)).minute, format);
  const mins = Math.floor(age / 60000);
  const ago = mins < 1 ? 'just now' : `${mins} min ago`;
  return age >= FRESH_MS
    ? {level: 'stale', text: `Stale — updated ${at} (${ago})`, refreshable: true}
    : {level: 'fresh', text: `Updated ${at} · ${ago}`, refreshable: true};
}
/** Facts about one interval for the detail card. `layoutBlock` supplies the real duration. */
export function intervalInfo(block, format = '24') {
  const t = m => timeLabel(m, format);
  const isBooked = block.kind === 'booked';
  const notes = [];
  if (!isBooked) {
    notes.push(block.type === 8
      ? 'Published block (type 8). It is shown as published; it is not treated as the building\'s opening hours.'
      : `Published block (type ${block.type ?? 'unknown'}). ETH does not say what it means here; it blocks the room.`);
  }
  if (block.eventIsHeld === 0) notes.push('ETH marks this event as not taking place. It is still shown as blocking because the meaning of that flag is unverified.');
  if (block.continuesFromPrevDay) notes.push('Started on the previous day.');
  if (block.continuesToNextDay) notes.push('Continues on the next day.');
  return {
    id: block.id, kind: block.kind, heading: kindWord(block.kind),
    range: `${t(block.start)}–${t(block.end)}`,
    duration: typeof block.minutes === 'number' ? formatDuration(block.minutes) : null,
    title: block.title ?? (isBooked ? 'Reservation' : `Blocked interval (type ${block.type ?? 'unknown'})`),
    courseNumber: block.courseNumber, notes
  };
}
/** One-line summary of a day, in real minutes. */
export function daySummary(layout) {
  const booked = layout.blocks.filter(b => b.kind === 'booked').length, blocked = layout.blocks.length - booked;
  const free = layout.free.reduce((sum, g) => sum + g.minutes, 0);
  const parts = [];
  if (booked) parts.push(`${booked} booking${booked === 1 ? '' : 's'}`);
  if (blocked) parts.push(`${blocked} block${blocked === 1 ? '' : 's'}`);
  if (!parts.length) parts.push('No entries published');
  return `${parts.join(', ')} · ${free ? `${formatDuration(free)} free in total` : 'no free time'}`;
}

/** Current status at `nowMinute`, from the published intervals only. No opening hours are assumed: without a published
 * block, the room is simply free (no published entry). */
export function currentStatus(model, nowMinute, format = '24') {
  const t = m => timeLabel(m, format);
  const current = model.merged.find(b => b.start <= nowMinute && nowMinute < b.end);
  if (current) {
    const booked = model.intervals.some(i => i.start <= nowMinute && nowMinute < i.end && i.kind === 'booked');
    const word = booked ? 'Booked' : 'Blocked';
    return {state: booked ? 'busy' : 'blocked', text: current.end >= DAY_END ? `${word} for the rest of today` : `${word} until ${t(current.end)}`};
  }
  const gap = model.free.find(g => g.start <= nowMinute && nowMinute < g.end);
  if (!gap || gap.end >= DAY_END) return {state: 'free', text: 'Free — no later reservation listed today'};
  return {state: 'free', text: `Free until ${t(gap.end)}`};
}
/** Turns a cache record into what the detail screen may show for `day`:
 *   ready       -> a model (free time may be drawn; `stale` marks data older than the freshness limit)
 *   loading     -> no record yet, or one too old / of unknown age to show
 *   unavailable -> error, rate limit, unverified or unreadable data: NEVER free time */
export function resolveRecord(record, day, nowMs = Date.now()) {
  if (!record) return {kind: 'loading'};
  if (record.state === 'error') {
    return {kind: 'unavailable', problem: record.rateLimited
      ? {heading: 'Rate limited', message: 'ETH is limiting requests, so availability is unknown. Try again in a moment.'}
      : {heading: 'Schedule unavailable', message: 'The schedule could not be loaded, so availability is unknown.'}};
  }
  if (record.state !== 'ready' || !Array.isArray(record.allocations)) {
    return {kind: 'unavailable', problem: {heading: 'Schedule unavailable', message: 'The schedule could not be read, so availability is unknown.'}};
  }
  const age = sourceAgeMs(record, nowMs);
  if (!Number.isFinite(age) || age >= MAX_STALE_MS) return {kind: 'loading', expired: true};
  if (record.roomVerified !== true) {
    return {kind: 'unavailable', problem: {heading: record.roomVerified === false ? 'Room not found at ETH' : 'Room not verified', message: 'ETH returned no usable schedule for this room and its existence could not be confirmed, so availability is unknown.'}};
  }
  const model = buildDayModel(record.allocations, day);
  if (!model.ok) return {kind: 'unavailable', problem: {heading: 'Schedule unavailable', message: 'ETH sent data that could not be read completely, so availability is unknown.'}};
  return {kind: 'ready', model, stale: age >= FRESH_MS, ageMs: age, fetchedAt: record.fetchedAt ?? null};
}
