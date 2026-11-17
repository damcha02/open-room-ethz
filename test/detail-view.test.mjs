import test from 'node:test';
import assert from 'node:assert/strict';
import {esc, headHtml, statusHtml, dayBarHtml, weekStripHtml, timelineHtml, listHtml, cardHtml, unavailableHtml, legendHtml} from '../public/detail-view.mjs';
import {buildDayModel, layoutTimeline, intervalInfo, statusBadge, freshnessInfo} from '../public/timeline.mjs';

const D = '2026-11-18';
const al = (a, b, type = 2, extra = {}) => ({start: `${D}T${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}:00`, end: `${D}T${String(Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}:00`, type, ...extra});
const layout = (allocs, opts) => layoutTimeline(buildDayModel(allocs, D), opts);

test('markup: every dynamic value is escaped (titles, course numbers, room codes)', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const l = layout([al(600, 720, 2, {title: evil, courseNumber: evil})]);
  const html = timelineHtml({layout: l}) + listHtml({layout: l}) + cardHtml(intervalInfo(l.blocks[0])) + headHtml({room: {code: evil, building: evil, campus: evil}, favoriteButton: ''});
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(esc(null), '');
  assert.equal(esc('a&b'), 'a&amp;b');
});
test('markup: timeline blocks are buttons with accessible names, exact proportional geometry and lanes as widths', () => {
  const l = layout([al(540, 660, 2, {title: 'Lecture'}), al(600, 720, 13)]);
  const html = timelineHtml({layout: l, selectedId: l.blocks[0].id});
  const buttons = [...html.matchAll(/<button type="button" class="tl-block ([^"]*)" style="([^"]*)" data-interval="([^"]*)" aria-pressed="([^"]*)" aria-label="([^"]*)"/g)];
  assert.equal(buttons.length, 2);
  assert.match(buttons[0][5], /^Booked 09:00–11:00, Lecture\. Show details$/);
  assert.match(buttons[1][5], /^Blocked 10:00–12:00, Blocked interval \(type 13\)\. Show details$/);
  assert.match(buttons[0][2], /top:648px;height:144px;left:0%;width:50%/);   // 540 min * 1.2, 120 min * 1.2, lane 0 of 2
  assert.match(buttons[1][2], /left:50%;width:50%/);
  assert.equal(buttons[0][4], 'true');
  assert.equal(buttons[1][4], 'false');
  assert.match(buttons[0][1], /selected/);
});
test('markup: tiny blocks keep their exact height; their text is dropped but the accessible name stays', () => {
  const l = layout([al(600, 605, 2, {title: 'Short'})]);
  const html = timelineHtml({layout: l});
  assert.match(html, /height:6px/);
  assert.doesNotMatch(html, /tl-range|tl-name/);
  assert.match(html, /aria-label="Booked 10:00–10:05, Short/);
});
test('markup: stale data is hatched and labelled "Free · stale"; fresh data is plain "Free"', () => {
  const l = layout([al(600, 720)]);
  const fresh = timelineHtml({layout: l, stale: false}), stale = timelineHtml({layout: l, stale: true});
  assert.doesNotMatch(fresh, /tl-stale/);
  assert.match(fresh, /Free 00:00–10:00/);
  assert.match(stale, /class="tl tl-stale"/);
  assert.match(stale, /Free · stale 00:00–10:00/);
  assert.ok([...stale.matchAll(/class="tl-free"[^>]*aria-label="([^"]*)"/g)].every(m => /stale/.test(m[1])), 'screen readers hear "stale" too');
  assert.doesNotMatch(stale, /aria-label="Free 00/);
});
test('markup: the current-time indicator exists only when a "now" position is given', () => {
  assert.match(timelineHtml({layout: layout([], {nowMinute: 600})}), /class="tl-now" style="top:720px" id="tl-now"/);
  assert.doesNotMatch(timelineHtml({layout: layout([])}), /tl-now/);
});
test('markup: ticks are hourly; a repeated daylight-saving hour is marked', () => {
  const html = timelineHtml({layout: layout([])});
  assert.equal([...html.matchAll(/class="tl-tick-label"/g)].length, 25);
  assert.match(html, />24:00</);
  const fall = '2026-10-25';
  const l = layoutTimeline(buildDayModel([], fall));
  assert.match(timelineHtml({layout: l, dayLabel: 'x'}), /02:00<sup>2nd<\/sup>/);
  assert.match(timelineHtml({layout: l}), /height:1800px/); // 1500 min * 1.2
});
test('markup: 12-hour format is honoured in labels', () => {
  const html = timelineHtml({layout: layout([al(840, 960)]), format: '12'});
  assert.match(html, /Booked 2:00 PM–4:00 PM/);
  assert.match(html, />12:00 AM</);
});
test('markup: unavailable never contains timeline or free time; retry can be paused', () => {
  const html = unavailableHtml({heading: 'Schedule unavailable', message: 'The schedule could not be loaded, so availability is unknown.', retry: true, paused: true});
  assert.doesNotMatch(html, /tl-free|tl-block|class="tl"/);
  assert.match(html, /availability is unknown/);
  assert.match(html, /id="rd-retry" disabled>Paused — ETH rate limit/);
  assert.doesNotMatch(unavailableHtml({heading: 'x', message: 'y', retry: false}), /rd-retry/);
});
test('markup: status block shows badge, next change, freshness and refresh; stale is flagged', () => {
  const html = statusHtml({badge: statusBadge({state: 'free', stale: true}), text: 'Free until 14:00', nextText: 'At 14:00 it becomes booked (until 16:00)', fresh: freshnessInfo({state: 'ready', receivedAt: 0, ageAtReceiptMs: 15 * 60000}, 0), paused: false});
  assert.match(html, /rd-badge rd-tone-free is-stale">Free · Stale/);
  assert.match(html, /Next change<\/span> At 14:00 it becomes booked/);
  assert.match(html, /rd-fresh rd-fresh-stale is-stale/);
  assert.match(html, /id="rd-refresh">Refresh/);
  assert.match(statusHtml({badge: statusBadge({state: 'free'}), text: 't', nextText: null, fresh: {level: 'none', text: 'Not loaded yet', refreshable: true}, paused: true}), /rd-refresh" disabled>Paused/);
  for (const state of ['free', 'busy', 'blocked', 'unknown', 'loading']) assert.doesNotMatch(statusHtml({badge: statusBadge({state}), text: 't', nextText: null, fresh: {level: 'fresh', text: 'x'}}), /Unbooked|Reserved/);
});
test('markup: day bar and week strip are real buttons with names and pressed state; Today is disabled on today', () => {
  const bar = dayBarHtml({label: 'Wed 18 Nov', isToday: true});
  assert.match(bar, /id="rd-prev" aria-label="Previous day"/);
  assert.match(bar, /id="rd-next" aria-label="Next day"/);
  assert.match(bar, /id="rd-today" disabled/);
  assert.doesNotMatch(dayBarHtml({label: 'Thu', isToday: false}), /id="rd-today" disabled/);
  const strip = weekStripHtml([{day: D, short: 'Wed', num: 18, selected: true, today: true, aria: 'Wednesday 18 November'}, {day: '2026-11-19', short: 'Thu', num: 19, selected: false, today: false, aria: 'Thursday 19 November'}]);
  assert.match(strip, /data-rd-day="2026-11-18" aria-pressed="true" aria-label="Wednesday 18 November"/);
  assert.match(strip, /aria-pressed="false"/);
});
test('markup: the entry list is an accessible alternative; the card carries notes; legend names all states', () => {
  const l = layout([al(600, 720, 2, {title: 'Lecture', courseNumber: '252-0839-00', eventIsHeld: 0}), al(0, 480, 8)]);
  const list = listHtml({layout: l});
  assert.match(list, /<summary>All entries this day \(2\)<\/summary>/);
  assert.match(list, /data-interval="i1"/);
  assert.equal(listHtml({layout: layout([])}).includes('No reservations or blocks are published'), true);
  const card = cardHtml(intervalInfo(l.blocks.find(b => b.kind === 'booked')));
  assert.match(card, /Booked<\/span>/);
  assert.match(card, /10:00–12:00 · 2 h/);
  assert.match(card, /Course 252-0839-00/);
  assert.match(card, /not taking place/);
  assert.equal(cardHtml(null), '');
  assert.match(legendHtml(), /Free[\s\S]*Booked[\s\S]*Blocked/);
});

// ---------------------------------------------------------------- Stage 4: student access and room information
import {accessSectionHtml, roomInfoHtml} from '../public/detail-view.mjs';
test('student access section: separate from the booking status, three states, source and date, nothing unescaped', () => {
  const unknown = accessSectionHtml({info: {status: 'unknown', label: 'Access unknown', summary: 'ETH has not confirmed it. "Free" only means no published reservation.', notes: 'n <b>x</b>', source: 'https://ethz.ch/a.pdf', verifiedAt: '2026-11-17'}, notice: 'Computer room: not freely accessible.'});
  assert.match(unknown, /<h3 class="rd-h">Student access<\/h3>/);
  assert.match(unknown, /rd-access-card is-unknown/);
  assert.match(unknown, /Access unknown/);
  assert.match(unknown, /rd-warn">Computer room/);
  assert.match(unknown, /href="https:\/\/ethz\.ch\/a\.pdf" target="_blank" rel="noopener noreferrer"/);
  assert.match(unknown, /checked 2026-11-17/);
  assert.match(unknown, /Access rules are separate from the Free \/ Booked \/ Blocked status\./);
  assert.doesNotMatch(unknown, /<b>/);
  assert.match(accessSectionHtml({info: {status: 'general', label: 'General access confirmed', summary: 's', notes: null, source: null, verifiedAt: null}}), /is-general/);
  const restricted = accessSectionHtml({info: {status: 'restricted', label: 'Restricted access', summary: 's', notes: 'Only students of department X', source: 'https://ethz.ch/x', verifiedAt: '2026-11-17'}});
  assert.match(restricted, /is-restricted[\s\S]*Only students of department X/);
  assert.doesNotMatch(unknown + restricted, /rd-warn[\s\S]*rd-warn/);
});
test('room information: rows, verbatim ETH labels, Unknown for unverified lists, provenance and official link', () => {
  const html = roomInfoHtml({
    rows: [{label: 'Room type', value: 'Computer'}, {label: 'Seats', value: 'Not published for computer rooms', unknown: true}, {label: 'Computer workstations', value: '39'}],
    equipment: [['Printer', 'available 2']], accessibility: null, other: null, provenance: 'Source: ETH Rauminfo (room list 2026-11-17).', officialUrl: 'https://ethz.ch/x?a=1&b=2', detailCount: 10
  });
  assert.match(html, /<dt>Computer workstations<\/dt><dd>39<\/dd>/);
  assert.match(html, /<dd class="is-unknown">Not published for computer rooms<\/dd>/);
  assert.match(html, /<li><span>Printer<\/span><span>available 2<\/span><\/li>/);
  assert.match(html, /Accessibility<\/h4><p class="info-unknown">Unknown — not verified for this room\./);
  assert.doesNotMatch(html, /Other details/);
  assert.match(html, /verified for 10 rooms only; “Unknown” means not verified, not absent/);
  assert.match(html, /href="https:\/\/ethz\.ch\/x\?a=1&amp;b=2"/);
  const none = roomInfoHtml({rows: [], equipment: null, accessibility: null, other: [['Windows', 'available']], provenance: null, officialUrl: null, detailCount: 0});
  assert.match(none, /Equipment and furniture<\/h4><p class="info-unknown">Unknown/);
  assert.match(none, /Other details from ETH/);
  assert.doesNotMatch(none, /Official ETH Rauminfo page/);
});
