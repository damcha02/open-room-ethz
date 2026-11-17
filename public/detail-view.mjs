/** Markup for the room-detail screen. Pure string builders (no DOM), so they can be unit tested.
 * Every dynamic value is escaped. Colour is never the only signal: each state also has a text label. */
import {timeLabel} from './recommend.mjs';
import {intervalInfo} from './timeline.mjs';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const kindClass = kind => kind === 'booked' ? 'tl-booked' : 'tl-blocked';
const LABEL_MIN_HEIGHT = {range: 20, title: 42, free: 30}; // px; below these the text is left out (the aria-label stays)

export function headHtml({room, favoriteButton}) {
  const place = room.campus ? `${room.building} · ${room.campus}` : room.building;
  return `<button type="button" class="rd-back" id="rd-close" aria-label="Close room details"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>`
    + `<div class="rd-title"><h2 id="rd-title">${esc(room.code)}</h2><div class="rd-sub">${esc(place)}</div></div>${favoriteButton}`;
}
export function statusHtml({badge, text, nextText, fresh, paused}) {
  const stale = badge.stale || fresh.level === 'stale' || fresh.level === 'unknown';
  const refresh = fresh.refreshable
    ? `<button type="button" class="rd-refresh" id="rd-refresh"${paused ? ' disabled' : ''}>${paused ? 'Paused — ETH rate limit' : 'Refresh'}</button>` : '';
  return `<div class="rd-state"><span class="rd-badge rd-tone-${esc(badge.tone)}${badge.stale ? ' is-stale' : ''}">${esc(badge.text)}</span><span class="rd-state-text">${esc(text)}</span></div>`
    + `<div class="rd-next">${nextText ? `<span class="rd-next-label">Next change</span> ${esc(nextText)}` : '&nbsp;'}</div>`
    + `<div class="rd-fresh rd-fresh-${esc(fresh.level)}${stale ? ' is-stale' : ''}"><span>${esc(fresh.text)}</span>${refresh}</div>`;
}
/** Fixed bar: previous day / label / next day / today. */
export function dayBarHtml({label, isToday}) {
  return `<button type="button" class="rd-navbtn" id="rd-prev" aria-label="Previous day">‹</button>`
    + `<div class="rd-daylabel" aria-live="polite">${esc(label)}${isToday ? ' <span class="rd-today-tag">Today</span>' : ''}</div>`
    + `<button type="button" class="rd-navbtn" id="rd-next" aria-label="Next day">›</button>`
    + `<button type="button" class="rd-todaybtn" id="rd-today"${isToday ? ' disabled' : ''}>Today</button>`;
}
/** The seven days of the viewed week (scrolls with the timeline). */
export function weekStripHtml(days) {
  return days.map(d => `<button type="button" class="rd-daybtn${d.selected ? ' selected' : ''}${d.today ? ' today' : ''}" data-rd-day="${esc(d.day)}" aria-pressed="${d.selected}" aria-label="${esc(d.aria)}"><span class="rd-dayname">${esc(d.short)}</span><span class="rd-daynum">${esc(d.num)}</span></button>`).join('');
}
/** Vertical, proportional timeline. `stale` draws free time hatched and labelled "Free · stale" (never as confirmed). */
export function timelineHtml({layout, format = '24', stale = false, selectedId = null, dayLabel = ''}) {
  const t = m => timeLabel(m, format);
  const ticks = layout.ticks.map(k => `<div class="tl-tick" style="top:${k.top}px"><span class="tl-tick-label">${esc(t(k.minute))}${k.repeated ? '<sup>2nd</sup>' : ''}</span></div>`).join('');
  const free = layout.free.map(g => {
    const label = g.height >= LABEL_MIN_HEIGHT.free ? `<span class="tl-label">${stale ? 'Free · stale' : 'Free'} ${esc(t(g.start))}–${esc(t(g.end))}</span>` : '';
    return `<div class="tl-free" style="top:${g.top}px;height:${g.height}px" role="listitem" aria-label="${stale ? 'Free, stale data' : 'Free'} ${esc(t(g.start))} to ${esc(t(g.end))}">${label}</div>`;
  }).join('');
  const blocks = layout.blocks.map(b => {
    const info = intervalInfo(b, format);
    const width = 100 / b.lanes, left = width * b.lane;
    const range = b.height >= LABEL_MIN_HEIGHT.range ? `<span class="tl-range">${esc(info.range)}</span>` : '';
    const name = b.height >= LABEL_MIN_HEIGHT.title ? `<span class="tl-name">${esc(info.title)}</span>` : '';
    return `<button type="button" class="tl-block ${kindClass(b.kind)}${b.id === selectedId ? ' selected' : ''}" style="top:${b.top}px;height:${b.height}px;left:${left}%;width:${width}%" data-interval="${esc(b.id)}" aria-pressed="${b.id === selectedId}" aria-label="${esc(info.heading)} ${esc(info.range)}, ${esc(info.title)}. Show details">${range}${name}</button>`;
  }).join('');
  const now = layout.nowTop === null ? '' : `<div class="tl-now" style="top:${layout.nowTop}px" id="tl-now"><span>Now</span></div>`;
  return `<div class="tl${stale ? ' tl-stale' : ''}" style="height:${layout.height}px" role="list" aria-label="Timeline ${esc(dayLabel)}, ${layout.totalMinutes / 60} hours">${ticks}<div class="tl-track">${free}${blocks}${now}</div></div>`;
}
export function legendHtml() {
  return '<ul class="rd-legend" aria-label="Legend"><li><span class="lg lg-free"></span>Free</li><li><span class="lg lg-booked"></span>Booked</li><li><span class="lg lg-blocked"></span>Blocked</li></ul>';
}
/** Accessible list of every entry of the day; tapping a row selects it like tapping its block. */
export function listHtml({layout, format = '24', selectedId = null}) {
  if (!layout.blocks.length) return '<p class="rd-note">No reservations or blocks are published for this day.</p>';
  const rows = [...layout.blocks].sort((a, b) => a.start - b.start || a.end - b.end).map(b => {
    const info = intervalInfo(b, format);
    return `<li><button type="button" class="rd-row${b.id === selectedId ? ' selected' : ''}" data-interval="${esc(b.id)}" aria-pressed="${b.id === selectedId}"><span class="rd-row-kind ${kindClass(b.kind)}">${esc(info.heading)}</span><span class="rd-row-range">${esc(info.range)}</span><span class="rd-row-title">${esc(info.title)}</span></button></li>`;
  }).join('');
  return `<details class="rd-list"><summary>All entries this day (${layout.blocks.length})</summary><ul>${rows}</ul></details>`;
}
export function cardHtml(info) {
  if (!info) return '';
  const notes = info.notes.map(n => `<li>${esc(n)}</li>`).join('');
  return `<div class="rd-card-head"><span class="rd-card-kind ${kindClass(info.kind)}">${esc(info.heading)}</span><span class="rd-card-range">${esc(info.range)}${info.duration ? ` · ${esc(info.duration)}` : ''}</span>`
    + `<button type="button" class="rd-card-close" id="rd-card-close" aria-label="Close details">×</button></div>`
    + `<div class="rd-card-title">${esc(info.title)}</div>${info.courseNumber ? `<div class="rd-card-course">Course ${esc(info.courseNumber)}</div>` : ''}${notes ? `<ul class="rd-card-notes">${notes}</ul>` : ''}`;
}
/** Shown instead of a timeline when there is no trustworthy schedule. Never contains free time. */
export function unavailableHtml({heading, message, retry, paused}) {
  return `<div class="rd-unknown" role="status"><div class="rd-unknown-title">${esc(heading)}</div><p>${esc(message)}</p>${retry ? `<button type="button" class="secondary-button" id="rd-retry"${paused ? ' disabled' : ''}>${paused ? 'Paused — ETH rate limit' : 'Try again'}</button>` : ''}</div>`;
}

/** Student access: a section of its own, separate from the Free / Booked / Blocked status. `info` comes from accessInfo(). */
export function accessSectionHtml({info, notice = null}) {
  const source = info.source
    ? `<p class="rd-src">Source: <a href="${esc(info.source)}" target="_blank" rel="noopener noreferrer">official ETH document ↗</a>${info.verifiedAt ? ` · checked ${esc(info.verifiedAt)}` : ''}</p>` : '';
  return `<h3 class="rd-h">Student access</h3><div class="rd-access-card is-${esc(info.status)}"><span class="rd-access-badge">${esc(info.label)}</span>`
    + `<p>${esc(info.summary)}</p>${info.notes ? `<p>${esc(info.notes)}</p>` : ''}${notice ? `<p class="rd-warn">${esc(notice)}</p>` : ''}${source}`
    + `<p class="rd-src">Access rules are separate from the Free / Booked / Blocked status.</p></div>`;
}
/** "Room information": verified facts only. Unknown fields say so; verbatim ETH labels for equipment and accessibility. */
export function roomInfoHtml({rows, equipment, accessibility, other, provenance, officialUrl, detailCount}) {
  const list = (title, items, unknown) => `<h4 class="info-h">${esc(title)}</h4>${items
    ? `<ul class="info-list">${items.map(([label, value]) => `<li><span>${esc(label)}</span><span>${esc(value)}</span></li>`).join('')}</ul>`
    : `<p class="info-unknown">${esc(unknown)}</p>`}`;
  const dl = rows.map(r => `<dt>${esc(r.label)}</dt><dd${r.unknown ? ' class="is-unknown"' : ''}>${esc(r.value)}${r.note ? ` <small>(${esc(r.note)})</small>` : ''}</dd>`).join('');
  return `<dl class="info-rows">${dl}</dl>`
    + list('Equipment and furniture', equipment, 'Unknown — not verified for this room.')
    + list('Accessibility', accessibility, 'Unknown — not verified for this room.')
    + (other ? list('Other details from ETH', other, '') : '')
    + `<p class="info-foot">${provenance ? `${esc(provenance)} ` : ''}Equipment, furniture and accessibility details are verified for ${esc(detailCount ?? 0)} rooms only; “Unknown” means not verified, not absent.`
    + `${officialUrl ? ` <a class="source-link" href="${esc(officialUrl)}" target="_blank" rel="noopener noreferrer">Official ETH Rauminfo page ↗</a>` : ''}</p>`;
}
