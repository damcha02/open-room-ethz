/** Room metadata and filtering: pure functions (no DOM, no network). See docs/ROOM_METADATA.md and docs/UX_SPEC.md §9.
 *
 * Principles that every function here keeps:
 *   - UNKNOWN IS NOT A CLASSIFICATION. A missing field never makes a room match a positive filter and never counts as a negative.
 *   - Seats and computer workstations are different attributes. The capacity filter looks at seats only.
 *   - Access status comes from ETH documents only (catalog fields with a source and a date). Reservation status is never an input.
 *   - Filtering is local and instant: nothing here makes a request, and candidates are chosen BEFORE any schedule is requested.
 */

export const FILTER_TYPES = [
  {value: 'all', label: 'All'},
  {value: 'computer', label: 'Computer room'},
  {value: 'seminar', label: 'Seminar room'},
  {value: 'lecture', label: 'Lecture hall'}
];
export const CAPACITY_OPTIONS = [
  {value: 'any', label: 'Any', min: 0},
  {value: '10', label: 'At least 10 seats', min: 10},
  {value: '20', label: 'At least 20 seats', min: 20},
  {value: '40', label: 'At least 40 seats', min: 40}
];
/** "all" is the default: recommendations leave out rooms with KNOWN restrictions; unknown rooms stay (marked as unverified). */
export const ACCESS_OPTIONS = [
  {value: 'all', label: 'All rooms', help: 'Rooms with known access restrictions are left out of recommendations.'},
  {value: 'general', label: 'General access confirmed only', help: 'Only rooms whose general student access is confirmed by an official ETH source.'},
  {value: 'restricted', label: 'Include restricted rooms', help: 'Also recommend rooms with documented access restrictions.'}
];
export const DEFAULT_FILTERS = Object.freeze({type: 'all', capacity: 'any', flexible: false, access: 'all'});

const ACCESS_STATUSES = ['general', 'restricted', 'unknown'];
const SEATING = ['fixed', 'variable'];
const KNOWN_FILTER_IDS = ['computer', 'seminar', 'lecture'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const count = v => {
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v);
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
};
const text = v => typeof v === 'string' && v.trim() ? v.trim() : null;
const httpUrl = v => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; } };
const pairs = v => Array.isArray(v) ? v.filter(p => Array.isArray(p) && typeof p[0] === 'string' && p[1] !== undefined && p[1] !== null).map(p => [String(p[0]), String(p[1])]) : [];

/** Access of one room. `general` and `restricted` are claims that need an official source URL AND a check date; without both the
 * status falls back to `unknown`, so unverified data can never silently become "confirmed". */
export function resolveAccess(raw) {
  const status = ACCESS_STATUSES.includes(raw?.accessStatus) ? raw.accessStatus : 'unknown';
  const source = httpUrl(raw?.accessSource);
  const verifiedAt = typeof raw?.accessVerifiedAt === 'string' && DATE_RE.test(raw.accessVerifiedAt) ? raw.accessVerifiedAt : null;
  const supported = Boolean(source && verifiedAt);
  return {status: status !== 'unknown' && !supported ? 'unknown' : status, notes: text(raw?.accessNotes), source, verifiedAt};
}

/** A room's raw access fields. An override that CLAIMS general or restricted access must bring its own source and check date: it never
 * inherits the catalog default's (a generic source does not support a room-specific claim). Anything else inherits the default. */
function accessFor(base, override) {
  const o = override && typeof override === 'object' ? override : null;
  if (o && (o.accessStatus === 'general' || o.accessStatus === 'restricted')) return o;
  return {...base, ...(o ?? {})};
}

/** Validates the static catalog. Anything unusable is dropped or becomes null; a broken catalog yields an empty one (the app then
 * simply has no metadata: every filter that needs it matches nothing, and nothing is claimed). */
export function normalizeCatalog(raw) {
  const empty = {valid: false, version: null, generatedAt: null, rooms: new Map(), types: {}, sources: {}, coverage: null, problems: ['catalog missing or unsupported'], accessRules: null};
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1 || !raw.rooms || typeof raw.rooms !== 'object') return empty;
  const problems = [];
  const types = {};
  for (const [name, t] of Object.entries(raw.types && typeof raw.types === 'object' ? raw.types : {})) {
    types[name] = {typeCode: text(t?.typeCode), filter: KNOWN_FILTER_IDS.includes(t?.filter) ? t.filter : null, label: text(t?.label) ?? name};
  }
  const accessBase = raw.accessDefault && typeof raw.accessDefault === 'object' ? raw.accessDefault : {};
  const overrides = raw.accessOverrides && typeof raw.accessOverrides === 'object' ? raw.accessOverrides : {};
  const rooms = new Map();
  for (const [code, r] of Object.entries(raw.rooms)) {
    if (!r || typeof r !== 'object' || !/^[A-Z]{2,4} [A-Z]{1,3} [0-9]{1,5}(?:\.[0-9]{1,5}){0,2}$/.test(code)) { problems.push(`${code}: invalid entry`); continue; }
    const type = typeof r.type === 'string' && types[r.type] ? r.type : null; // a type outside ETH's vocabulary is unknown
    const detail = r.detail && typeof r.detail === 'object' ? {
      seatingLabel: text(r.detail.seatingLabel), examSeats: text(r.detail.examSeats), floorArea: text(r.detail.floorArea),
      other: pairs(r.detail.other), equipment: pairs(r.detail.equipment), accessibility: pairs(r.detail.accessibility)
    } : null;
    const [building, floor, room] = code.split(' ');
    rooms.set(code, {
      code, building, floor, room,
      type, typeFilter: type ? types[type].filter : null,
      seats: count(r.seats), extraSeats: count(r.extraSeats), workstations: count(r.workstations),
      seating: SEATING.includes(r.seating) ? r.seating : null,
      detail,
      access: resolveAccess(accessFor(accessBase, overrides[code]))
    });
  }
  return {valid: true, version: text(raw.catalogVersion), generatedAt: text(raw.generatedAt), rooms, types, sources: raw.sources ?? {}, coverage: raw.coverage ?? null, problems, accessRules: raw.accessRules ?? null};
}
export const roomMeta = (catalog, code) => catalog?.rooms?.get(code) ?? null;
/** Computer room = ETH's own room type "Computer". A workstation count alone never makes a room one. */
export const isComputerRoom = meta => meta?.typeFilter === 'computer';

// ---------------------------------------------------------------- filters
/** Stored or user-supplied filters, validated field by field (invalid values fall back to the default). */
export function normalizeFilters(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    type: FILTER_TYPES.some(o => o.value === v.type) ? v.type : DEFAULT_FILTERS.type,
    capacity: CAPACITY_OPTIONS.some(o => o.value === v.capacity) ? v.capacity : DEFAULT_FILTERS.capacity,
    flexible: v.flexible === true,
    access: ACCESS_OPTIONS.some(o => o.value === v.access) ? v.access : DEFAULT_FILTERS.access
  };
}
export const isDefaultFilters = f => { const n = normalizeFilters(f); return n.type === 'all' && n.capacity === 'any' && !n.flexible && n.access === 'all'; };
export const activeFilterCount = f => { const n = normalizeFilters(f); return (n.type !== 'all') + (n.capacity !== 'any') + n.flexible + (n.access !== 'all'); };
export function filterSummary(f) {
  const n = normalizeFilters(f), parts = [];
  if (n.type !== 'all') parts.push(FILTER_TYPES.find(o => o.value === n.type).label);
  if (n.capacity !== 'any') parts.push(CAPACITY_OPTIONS.find(o => o.value === n.capacity).label);
  if (n.flexible) parts.push('Flexible furniture');
  if (n.access !== 'all') parts.push(ACCESS_OPTIONS.find(o => o.value === n.access).label);
  return parts;
}

/** One criterion at a time: true (confirmed match), false (confirmed non-match) or null (the needed metadata is unknown). */
function typeCriterion(meta, f) { return f.type === 'all' ? true : !meta || meta.type === null ? null : meta.typeFilter === f.type; }
function capacityCriterion(meta, f) {
  const min = CAPACITY_OPTIONS.find(o => o.value === f.capacity).min;
  if (min === 0) return true;
  return !meta || meta.seats === null ? null : meta.seats >= min; // seats only: a computer room's workstations are not seats
}
function flexibleCriterion(meta, f) { return !f.flexible ? true : !meta || meta.seating === null ? null : meta.seating === 'variable'; }
/** context 'recommendation' leaves known-restricted rooms out under the default; 'browse' never hides rooms under the default. */
function accessCriterion(meta, f, context) {
  const status = meta?.access.status ?? 'unknown';
  if (f.access === 'general') return status === 'general' ? true : status === 'restricted' ? false : null;
  if (f.access === 'restricted') return true;
  return context === 'recommendation' ? status !== 'restricted' : true;
}
/** 'match' | 'excluded' | 'unknown'. Only 'match' is ever shown as a result of a positive filter. */
export function classifyRoom(meta, filters, context = 'recommendation') {
  const f = normalizeFilters(filters);
  const results = [typeCriterion(meta, f), capacityCriterion(meta, f), flexibleCriterion(meta, f), accessCriterion(meta, f, context)];
  if (results.includes(false)) return 'excluded';
  return results.includes(null) ? 'unknown' : 'match';
}
export const matchesFilters = (meta, filters, context = 'recommendation') => classifyRoom(meta, filters, context) === 'match';
/** Rooms that confirmably match, in their original order. Candidates are chosen from THIS list before any schedule is requested. */
export const filterRooms = (rooms, catalog, filters, context = 'recommendation') => rooms.filter(r => matchesFilters(roomMeta(catalog, r.code), filters, context));

/** How much of the room list the filters could actually judge. */
export function filterCoverage(rooms, catalog, filters, context = 'recommendation') {
  const c = {total: rooms.length, match: 0, excluded: 0, unknown: 0};
  for (const r of rooms) c[classifyRoom(roomMeta(catalog, r.code), filters, context)]++;
  return c;
}
/** One sentence per active filter that depends on metadata which not every room has. Empty when nothing needs saying. */
export function coverageNotes(rooms, catalog, filters) {
  const f = normalizeFilters(filters), notes = [];
  const known = pick => rooms.filter(r => pick(roomMeta(catalog, r.code))).length;
  const add = (label, n) => { if (n < rooms.length) notes.push(`${label} is verified for ${n} of ${rooms.length} rooms here; the others are not listed.`); };
  if (f.type !== 'all') add('Room type', known(m => m && m.type !== null));
  if (CAPACITY_OPTIONS.find(o => o.value === f.capacity).min > 0) add('The seat count', known(m => m && m.seats !== null));
  if (f.flexible) add('Flexible furniture', known(m => m && m.seating !== null));
  if (f.access === 'general') add('General student access', known(m => m && m.access.status !== 'unknown'));
  return notes;
}

// ---------------------------------------------------------------- what the screens show
const STATUS_LABELS = {general: 'General access confirmed', restricted: 'Restricted access', unknown: 'Access unknown'};
/** Student access section of the room detail. Separate from Free / Booked / Blocked. */
export function accessInfo(meta) {
  const a = meta?.access ?? {status: 'unknown', notes: null, source: null, verifiedAt: null};
  const common = {status: a.status, label: STATUS_LABELS[a.status], source: a.source, verifiedAt: a.verifiedAt};
  if (a.status === 'general') return {...common, summary: 'Official ETH rules confirm that students may use this room.', notes: a.notes};
  if (a.status === 'restricted') return {...common, summary: 'Official ETH rules restrict who may use this room.', notes: a.notes ?? 'Details of the restriction are in the linked source.'};
  return {
    ...common,
    summary: 'ETH has not confirmed whether students may use this room when it has no booking. "Free" only means no published reservation.',
    notes: a.notes
  };
}
/** Short marker for recommendation cards. Unknown access is always marked; nothing is claimed for it. */
export function accessMark(meta) {
  const s = meta?.access.status ?? 'unknown';
  return s === 'general' ? 'General access confirmed' : s === 'restricted' ? 'Restricted access' : 'Access not verified';
}
export const COMPUTER_ROOM_NOTICE = 'Computer room: ETH does not publish who may use it or when. No current booking does not mean it is freely accessible.';
export const computerRoomNotice = meta => isComputerRoom(meta) ? COMPUTER_ROOM_NOTICE : null;

const SEATING_LABEL = {fixed: 'Fixed seating', variable: 'Variable seating (flexible furniture)'};
/** Rows of the "Room information" section. Unknown fields say Unknown; fields that do not apply are left out. */
export function roomInfoRows(meta, catalog, campus = null) {
  const rows = [];
  const row = (label, value, extra = {}) => rows.push({label, value: value ?? 'Unknown', unknown: value === null || value === undefined, ...extra});
  if (!meta) { row('Room type', null); row('Seats', null); return rows; }
  row('Room type', meta.type, meta.type && catalog?.types?.[meta.type]?.filter && catalog.types[meta.type].label !== meta.type ? {note: `ETH type "${meta.type}"`} : {});
  row('Seats', meta.seats === null ? null : `${meta.seats}${meta.extraSeats ? ` (+${meta.extraSeats} additional)` : ''}`,
    isComputerRoom(meta) && meta.seats === null ? {value: 'Not published for computer rooms', unknown: true} : {});
  if (isComputerRoom(meta) || meta.workstations !== null) row('Computer workstations', meta.workstations === null ? null : String(meta.workstations));
  row('Seating', meta.seating ? SEATING_LABEL[meta.seating] : null);
  if (meta.detail?.examSeats) row('Seats for written examinations', meta.detail.examSeats);
  if (meta.detail?.floorArea) row('Floor area', meta.detail.floorArea);
  row('Building and campus', campus ? `${meta.building} · ${campus}` : meta.building);
  return rows;
}
/** Equipment/furniture and accessibility lists as ETH words them (verbatim labels and values), or null when not verified. */
export const equipmentList = meta => meta?.detail?.equipment.length ? meta.detail.equipment : null;
export const accessibilityList = meta => meta?.detail?.accessibility.length ? meta.detail.accessibility : null;
export const otherDetails = meta => meta?.detail?.other.length ? meta.detail.other : null;

/** Link to ETH's own room page. */
export function officialRoomUrl(code) {
  const m = /^([A-Z]{2,4}) ([A-Z]{1,3}) ([0-9.]+)$/.exec(code);
  if (!m) return null;
  const u = new URL('https://ethz.ch/staffnet/de/service/raeume-gebaeude/rauminfo/raumdetails.html');
  u.searchParams.set('building', m[1]); u.searchParams.set('floor', m[2]); u.searchParams.set('room', m[3]);
  return u.toString();
}
export function provenance(catalog) {
  if (!catalog?.valid) return null;
  const s = catalog.sources;
  return `Source: ETH Rauminfo (room list ${s['rauminfo-list']?.retrieved ?? '?'}${catalog.coverage?.withDetail ? `, details for ${catalog.coverage.withDetail} rooms` : ''}). Catalog version ${catalog.version ?? '?'}.`;
}
