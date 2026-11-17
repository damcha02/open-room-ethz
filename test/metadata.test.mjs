import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FILTER_TYPES, CAPACITY_OPTIONS, ACCESS_OPTIONS, DEFAULT_FILTERS, normalizeCatalog, roomMeta, isComputerRoom, resolveAccess, normalizeFilters,
  isDefaultFilters, activeFilterCount, filterSummary, classifyRoom, matchesFilters, filterRooms, filterCoverage, coverageNotes, accessInfo, accessMark,
  computerRoomNotice, COMPUTER_ROOM_NOTICE, roomInfoRows, equipmentList, accessibilityList, officialRoomUrl, provenance
} from '../public/metadata.mjs';
import {planInitialLoad, orderCandidates, favoriteRooms, summarizeCoverage, describeCoverage, INITIAL_REQUEST_BUDGET} from '../public/recommend.mjs';

const real = JSON.parse(fs.readFileSync(new URL('../public/room-metadata.json', import.meta.url), 'utf8'));
const roomsJson = JSON.parse(fs.readFileSync(new URL('../public/rooms.json', import.meta.url), 'utf8'));
const catalog = normalizeCatalog(real);

/** A small synthetic catalog covering every combination the filters must handle. */
const T = {'Computer': {typeCode: '3650', filter: 'computer', label: 'Computer room'}, 'Seminars / Courses': {typeCode: '3420', filter: 'seminar', label: 'Seminar room'}, 'Lecture hall': {typeCode: '3430', filter: 'lecture', label: 'Lecture hall'}, 'Meeting room': {typeCode: '2110', filter: null, label: 'Meeting room'}};
const SRC = 'https://ethz.ch/rules.pdf';
const fixture = normalizeCatalog({
  schemaVersion: 1, catalogVersion: '2026-11-17', generatedAt: '2026-11-17', types: T,
  accessDefault: {accessStatus: 'unknown', accessNotes: 'not confirmed', accessSource: SRC, accessVerifiedAt: '2026-11-17'},
  accessOverrides: {
    'AA B 4': {accessStatus: 'general', accessNotes: 'open to all students', accessSource: SRC, accessVerifiedAt: '2026-11-17'},
    'AA B 5': {accessStatus: 'restricted', accessNotes: 'Only students of department X', accessSource: SRC, accessVerifiedAt: '2026-11-17'},
    'AA B 6': {accessStatus: 'general'}                       // claim without source and date: must fall back to unknown
  },
  rooms: {
    'AA B 1': {type: 'Computer', seats: null, extraSeats: null, workstations: 39, seating: 'variable'},
    'AA B 2': {type: 'Lecture hall', seats: 158, extraSeats: 12, workstations: null, seating: 'fixed'},
    'AA B 3': {type: 'Seminars / Courses', seats: 28, workstations: null, seating: 'variable'},
    'AA B 4': {type: 'Seminars / Courses', seats: 10, workstations: null, seating: null},
    'AA B 5': {type: 'Lecture hall', seats: 40, workstations: null, seating: null},
    'AA B 6': {type: 'Meeting room', seats: 20, workstations: null, seating: null},
    'AA B 7': {type: null, seats: null, workstations: 12, seating: null},       // workstations but unknown type
    'AA B 8': {type: 'Space station', seats: '25', workstations: '-3', seating: 'floating', detail: 'oops'}   // junk everywhere
  }
});
const ids = rooms => rooms.map(r => r.code);
const all = [...fixture.rooms.keys()].map(code => ({code, building: 'AA', campus: 'Zentrum'}));
const f = over => normalizeFilters({...DEFAULT_FILTERS, ...over});
/** criteria tests isolate the access setting: include restricted rooms so only type/capacity/furniture decide */
const g = over => f({access: 'restricted', ...over});

// ---------------------------------------------------------------- normalization
test('catalog: valid file loads; broken, wrong-version or missing catalogs become an empty catalog (nothing is claimed)', () => {
  assert.equal(catalog.valid, true);
  for (const bad of [null, undefined, 'x', 5, [], {}, {schemaVersion: 2, rooms: {}}, {schemaVersion: 1}, {schemaVersion: 1, rooms: 'no'}]) {
    const c = normalizeCatalog(bad);
    assert.deepEqual([c.valid, c.rooms.size], [false, 0], JSON.stringify(bad));
  }
  assert.equal(roomMeta(normalizeCatalog(null), 'HG E 27'), null);
  assert.equal(classifyRoom(null, f({type: 'lecture'})), 'unknown', 'no metadata: a positive filter is never matched');
  assert.equal(classifyRoom(null, DEFAULT_FILTERS, 'browse'), 'match');
});
test('catalog: missing, malformed and out-of-vocabulary fields become null, never a guess', () => {
  const m = roomMeta(fixture, 'AA B 8');
  assert.deepEqual([m.type, m.typeFilter, m.seats, m.workstations, m.seating, m.detail], [null, null, 25, null, null, null], 'numeric strings are accepted; negatives, junk types and junk seating are not');
  const bare = normalizeCatalog({schemaVersion: 1, rooms: {'HG E 27': {}, 'not a room': {type: 'Computer'}, 'HG E 28': null}, types: T});
  assert.deepEqual([...bare.rooms.keys()], ['HG E 27']);
  assert.equal(bare.problems.length, 2);
  const e = roomMeta(bare, 'HG E 27');
  assert.deepEqual([e.type, e.typeFilter, e.seats, e.extraSeats, e.workstations, e.seating, e.detail], [null, null, null, null, null, null, null]);
  assert.equal(e.access.status, 'unknown');
});
test('catalog: a type counts only if it is in ETH\'s vocabulary; the filter category comes from the catalog mapping', () => {
  assert.equal(roomMeta(fixture, 'AA B 3').typeFilter, 'seminar');
  assert.equal(roomMeta(fixture, 'AA B 6').typeFilter, null, 'a meeting room is a known type without an app filter');
  assert.equal(roomMeta(fixture, 'AA B 6').type, 'Meeting room');
  const odd = normalizeCatalog({schemaVersion: 1, types: {'Computer': {filter: 'rocket'}}, rooms: {'HG E 27': {type: 'Computer'}}});
  assert.equal(roomMeta(odd, 'HG E 27').typeFilter, null, 'an unknown filter id is ignored');
});

// ---------------------------------------------------------------- the shipped catalog
test('shipped catalog: covers exactly the app\'s room list, every field validated', () => {
  assert.deepEqual([...catalog.rooms.keys()].sort(), roomsJson.map(r => r.code).sort());
  assert.equal(catalog.problems.length, 0);
  assert.match(catalog.version, /^\d{4}-\d{2}-\d{2}$/);
  for (const [code, m] of catalog.rooms) {
    assert.ok(m.type, `${code} has an ETH type`);
    assert.ok(['computer', 'seminar', 'lecture', null].includes(m.typeFilter));
    for (const k of ['seats', 'extraSeats', 'workstations']) assert.ok(m[k] === null || (Number.isInteger(m[k]) && m[k] >= 0), `${code}.${k}`);
    assert.ok(m.access.verifiedAt && m.access.source && ['general', 'restricted', 'unknown'].includes(m.access.status), `${code} access fields`);
  }
});
test('shipped catalog: classification counts match the documented coverage', () => {
  const by = {};
  for (const m of catalog.rooms.values()) by[m.type] = (by[m.type] ?? 0) + 1;
  assert.deepEqual(by, {'Lecture hall': 53, 'Seminars / Courses': 72, 'Computer': 1, 'Meeting room': 2, 'Multipurpose room': 1});
  assert.deepEqual(catalog.coverage, {rooms: 129, withType: 129, withSeats: 128, withWorkstations: 1, withSeating: 10, withDetail: 10, access: {general: 0, restricted: 0, unknown: 129}});
  assert.equal([...catalog.rooms.values()].filter(m => m.seating).length, 10);
  assert.equal([...catalog.rooms.values()].filter(m => m.detail).length, 10);
});
test('shipped catalog: seats and workstations are separate attributes (HG E 27 is the one computer room)', () => {
  const hg = roomMeta(catalog, 'HG E 27');
  assert.deepEqual([hg.type, hg.typeFilter, hg.seats, hg.workstations, hg.seating, isComputerRoom(hg)], ['Computer', 'computer', null, 39, 'variable', true]);
  assert.deepEqual([...catalog.rooms.values()].filter(isComputerRoom).map(m => m.code), ['HG E 27']);
  assert.deepEqual([...catalog.rooms.values()].filter(m => m.workstations !== null).map(m => m.code), ['HG E 27'], 'only computer rooms carry workstations');
  const lecture = roomMeta(catalog, 'HG D 1.1');
  assert.deepEqual([lecture.type, lecture.seats, lecture.extraSeats, lecture.workstations, lecture.seating], ['Lecture hall', 158, 12, null, 'fixed']);
  assert.equal(roomMeta(catalog, 'HG D 3.1').seating, 'variable');
  assert.equal(roomMeta(catalog, 'HG D 3.1').typeFilter, 'seminar');
});
test('shipped catalog: sources, provenance and the cross-check are recorded', () => {
  assert.ok(catalog.sources['rauminfo-list'].url.includes('/bin/ethz/roominfo'));
  assert.deepEqual(catalog.sources['rectorate-lists'].crossCheck, {compared: 122, agree: 122, disagree: 0});
  assert.equal(catalog.sources['computer-room-info'].status, 'no official page found');
  assert.equal(catalog.sources['rauminfo-details'].rooms.length, 10);
  assert.match(provenance(catalog), /^Source: ETH Rauminfo \(room list 2026-11-17, details for 10 rooms\)\. Catalog version 2026-11-17\.$/);
  assert.equal(provenance(normalizeCatalog(null)), null);
  assert.ok(catalog.accessRules.conclusion.includes('every room is unknown'));
  assert.equal(catalog.accessRules.documents.length, 3);
});
test('shipped catalog: nothing is classified general or restricted without an official source; reservation status plays no role', () => {
  for (const m of catalog.rooms.values()) assert.equal(m.access.status, 'unknown');
  assert.ok(/214\.11/.test(roomMeta(catalog, 'HG D 1.1').access.source));
  assert.match(roomMeta(catalog, 'HIT E 51').access.notes, /not used for general teaching/);
  assert.match(roomMeta(catalog, 'HG E 27').access.notes, /No official ETH page was found/);
  assert.ok(!/metadata|reserv|free|booked/i.test(JSON.stringify(Object.keys(resolveAccess({})))), 'access has no reservation-derived field');
  assert.equal(fs.readFileSync(new URL('../public/metadata.mjs', import.meta.url), 'utf8').includes('fetch('), false, 'the metadata module makes no network request');
});

// ---------------------------------------------------------------- computer rooms, seats vs workstations
test('computer-room identification uses ETH\'s type only; workstations alone never make a computer room', () => {
  assert.equal(isComputerRoom(roomMeta(fixture, 'AA B 1')), true);
  assert.equal(isComputerRoom(roomMeta(fixture, 'AA B 7')), false, '12 workstations but unknown type');
  assert.equal(isComputerRoom(roomMeta(fixture, 'AA B 2')), false);
  assert.equal(isComputerRoom(null), false);
  assert.equal(matchesFilters(roomMeta(fixture, 'AA B 7'), f({type: 'computer'})), false);
  assert.equal(classifyRoom(roomMeta(fixture, 'AA B 7'), f({type: 'computer'})), 'unknown', 'unknown type: not a non-match either');
});
test('seats are not workstations: the capacity filter looks at seats only', () => {
  const pc = roomMeta(fixture, 'AA B 1');
  for (const cap of ['10', '20', '40']) assert.equal(classifyRoom(pc, f({capacity: cap})), 'unknown', `a computer room with 39 workstations has no published seat count (>=${cap})`);
  assert.equal(matchesFilters(pc, f({capacity: 'any'})), true);
  assert.equal(matchesFilters(pc, f({type: 'computer'})), true);
  assert.equal(matchesFilters(pc, f({type: 'computer', capacity: '10'})), false, 'combined: still not confirmed');
  const rows = roomInfoRows(pc, fixture, 'Zentrum');
  const get = l => rows.find(r => r.label === l);
  assert.deepEqual([get('Seats').value, get('Seats').unknown], ['Not published for computer rooms', true]);
  assert.deepEqual([get('Computer workstations').value, get('Computer workstations').unknown], ['39', false]);
  assert.ok(!roomInfoRows(roomMeta(fixture, 'AA B 2'), fixture).some(r => r.label === 'Computer workstations'), 'workstations are omitted where not applicable');
  assert.equal(roomInfoRows(roomMeta(fixture, 'AA B 2'), fixture).find(r => r.label === 'Seats').value, '158 (+12 additional)');
});
test('computer rooms are never described as freely accessible', () => {
  assert.equal(computerRoomNotice(roomMeta(fixture, 'AA B 1')), COMPUTER_ROOM_NOTICE);
  assert.match(COMPUTER_ROOM_NOTICE, /does not mean it is freely accessible/);
  assert.equal(computerRoomNotice(roomMeta(fixture, 'AA B 2')), null);
  assert.match(accessInfo(roomMeta(catalog, 'HG E 27')).summary, /has not confirmed/);
});

// ---------------------------------------------------------------- type, capacity, flexible furniture
test('room-type filter: only confirmed matches; unknown types never match', () => {
  assert.deepEqual(ids(filterRooms(all, fixture, g({type: 'lecture'}))), ['AA B 2', 'AA B 5']);
  assert.deepEqual(ids(filterRooms(all, fixture, g({type: 'seminar'}))), ['AA B 3', 'AA B 4']);
  assert.deepEqual(ids(filterRooms(all, fixture, g({type: 'computer'}))), ['AA B 1']);
  assert.equal(filterRooms(all, fixture, g({type: 'all'})).length, 8, 'All = no type restriction');
  assert.ok(!ids(filterRooms(all, fixture, g({type: 'lecture'}))).includes('AA B 8'), 'a junk type is unknown, not a lecture hall');
});
test('capacity filter: inclusive thresholds 10 / 20 / 40, unknown seat counts never match', () => {
  assert.deepEqual(ids(filterRooms(all, fixture, g({capacity: '10'}))), ['AA B 2', 'AA B 3', 'AA B 4', 'AA B 5', 'AA B 6', 'AA B 8']);
  assert.deepEqual(ids(filterRooms(all, fixture, g({capacity: '20'}))), ['AA B 2', 'AA B 3', 'AA B 5', 'AA B 6', 'AA B 8']);
  assert.deepEqual(ids(filterRooms(all, fixture, g({capacity: '40'}))), ['AA B 2', 'AA B 5']);
  assert.equal(matchesFilters(roomMeta(fixture, 'AA B 4'), g({capacity: '10'})), true, '10 seats is "at least 10"');
  assert.equal(matchesFilters(roomMeta(fixture, 'AA B 3'), g({capacity: '40'})), false);
  assert.equal(classifyRoom(roomMeta(fixture, 'AA B 3'), g({capacity: '40'})), 'excluded', 'a KNOWN small room is excluded, not unknown');
});
test('flexible-furniture filter: only verified "variable seating" matches; fixed excludes; unknown is neither', () => {
  assert.deepEqual(ids(filterRooms(all, fixture, g({flexible: true}))), ['AA B 1', 'AA B 3']);
  assert.equal(classifyRoom(roomMeta(fixture, 'AA B 2'), g({flexible: true})), 'excluded');
  assert.equal(classifyRoom(roomMeta(fixture, 'AA B 4'), g({flexible: true})), 'unknown');
  assert.equal(matchesFilters(roomMeta(fixture, 'AA B 4'), g({flexible: true})), false);
  const shipped = filterRooms(roomsJson, catalog, g({flexible: true}));
  assert.deepEqual(ids(shipped).sort(), ['GLC E 38.1', 'HG D 3.1', 'HG E 21', 'HG E 27', 'HIT E 51']);
});
test('combined filters: every criterion must be confirmed', () => {
  assert.deepEqual(ids(filterRooms(all, fixture, g({type: 'seminar', capacity: '20', flexible: true}))), ['AA B 3']);
  assert.deepEqual(ids(filterRooms(all, fixture, g({type: 'lecture', capacity: '40'}))), ['AA B 2', 'AA B 5']);
  assert.deepEqual(ids(filterRooms(all, fixture, g({type: 'lecture', flexible: true}))), []);
  assert.deepEqual(ids(filterRooms(all, fixture, g({type: 'computer', flexible: true}))), ['AA B 1']);
});
test('unknown metadata is never a classification: counts of match / excluded / unknown', () => {
  assert.deepEqual(filterCoverage(all, fixture, g({flexible: true}), 'browse'), {total: 8, match: 2, excluded: 1, unknown: 5});
  assert.deepEqual(filterCoverage(all, fixture, DEFAULT_FILTERS), {total: 8, match: 7, excluded: 1, unknown: 0});
  const c = filterCoverage(all, fixture, g({type: 'lecture'}));
  assert.equal(c.match + c.excluded + c.unknown, c.total);
  assert.equal(c.unknown, 2, 'AA B 7 and AA B 8 have no verified type');
});
test('coverage notes say that results reflect rooms with verified metadata', () => {
  assert.deepEqual(coverageNotes(all, fixture, g({flexible: true})), ['Flexible furniture is verified for 3 of 8 rooms here; the others are not listed.']);
  assert.deepEqual(coverageNotes(all, fixture, g({type: 'lecture'})), ['Room type is verified for 6 of 8 rooms here; the others are not listed.']);
  assert.deepEqual(coverageNotes(all, fixture, g({capacity: '20'})), ['The seat count is verified for 6 of 8 rooms here; the others are not listed.']);
  assert.deepEqual(coverageNotes(all, fixture, g({access: 'general'})), ['General student access is verified for 2 of 8 rooms here; the others are not listed.']);
  assert.deepEqual(coverageNotes(all, fixture, DEFAULT_FILTERS), []);
  const shipped = coverageNotes(roomsJson, catalog, g({flexible: true}));
  assert.deepEqual(shipped, ['Flexible furniture is verified for 10 of 129 rooms here; the others are not listed.']);
  assert.deepEqual(coverageNotes(roomsJson, catalog, g({type: 'lecture'})), [], 'room type is known for every catalog room: nothing to caveat');
});

// ---------------------------------------------------------------- student access
test('access claims need an official source and a check date, else they fall back to unknown', () => {
  assert.equal(roomMeta(fixture, 'AA B 4').access.status, 'general');
  assert.equal(roomMeta(fixture, 'AA B 5').access.status, 'restricted');
  assert.equal(roomMeta(fixture, 'AA B 6').access.status, 'unknown', 'general without source/date is not trusted');
  for (const bad of [{accessStatus: 'general'}, {accessStatus: 'general', accessSource: SRC}, {accessStatus: 'general', accessVerifiedAt: '2026-11-17'}, {accessStatus: 'general', accessSource: 'javascript:alert(1)', accessVerifiedAt: '2026-11-17'}, {accessStatus: 'general', accessSource: SRC, accessVerifiedAt: 'yesterday'}, {accessStatus: 'restricted'}, {accessStatus: 'open to all'}, {}, null]) {
    assert.equal(resolveAccess(bad).status, 'unknown', JSON.stringify(bad));
  }
  assert.equal(resolveAccess({accessStatus: 'unknown'}).status, 'unknown', 'unknown never silently becomes confirmed');
  assert.equal(resolveAccess({accessStatus: 'restricted', accessSource: SRC, accessVerifiedAt: '2026-11-17', accessNotes: 'x'}).status, 'restricted');
});
test('restricted rooms: left out of recommendations by default, included on request', () => {
  const rec = f => ids(filterRooms(all, fixture, f, 'recommendation'));
  assert.ok(!rec(f({})).includes('AA B 5'), 'default: known restriction is excluded from recommendations');
  assert.ok(rec(f({})).includes('AA B 4') && rec(f({})).includes('AA B 6') && rec(f({})).includes('AA B 1'), 'general and unknown rooms stay');
  assert.ok(rec(f({access: 'restricted'})).includes('AA B 5'), 'Include restricted rooms');
  assert.equal(rec(f({access: 'restricted'})).length, 8);
  assert.deepEqual(rec(f({access: 'general'})), ['AA B 4'], 'General access confirmed only: exactly the confirmed room');
});
test('unknown access: allowed in recommendations (marked unverified), never hidden from Browse by default', () => {
  const browse = ids(filterRooms(all, fixture, f({}), 'browse'));
  assert.equal(browse.length, 8, 'Browse shows every room under the default, restricted ones included');
  assert.ok(browse.includes('AA B 6') && browse.includes('AA B 5'));
  assert.equal(accessMark(roomMeta(fixture, 'AA B 6')), 'Access not verified');
  assert.equal(accessMark(roomMeta(fixture, 'AA B 4')), 'General access confirmed');
  assert.equal(accessMark(roomMeta(fixture, 'AA B 5')), 'Restricted access');
  assert.equal(accessMark(null), 'Access not verified');
  assert.deepEqual(ids(filterRooms(all, fixture, f({access: 'general'}), 'browse')), ['AA B 4'], 'an explicit "confirmed only" filter does apply in Browse');
  assert.equal(classifyRoom(roomMeta(fixture, 'AA B 6'), f({access: 'general'})), 'unknown');
});
test('student access section: three states, separate from Free / Booked / Blocked, with source and date', () => {
  const a = accessInfo(roomMeta(fixture, 'AA B 4')), r = accessInfo(roomMeta(fixture, 'AA B 5')), u = accessInfo(roomMeta(fixture, 'AA B 6'));
  assert.deepEqual([a.label, r.label, u.label], ['General access confirmed', 'Restricted access', 'Access unknown']);
  assert.deepEqual([a.source, a.verifiedAt, r.notes], [SRC, '2026-11-17', 'Only students of department X']);
  assert.match(u.summary, /"Free" only means no published reservation/);
  for (const info of [a, r, u]) assert.doesNotMatch(JSON.stringify(info), /Booked|Blocked/);
  assert.doesNotMatch(u.summary, /confirmed that students may/);
  assert.equal(accessInfo(null).status, 'unknown');
});

// ---------------------------------------------------------------- filter state and persistence
test('filters: stored values are validated, defaults are the neutral set, counts and summaries', () => {
  assert.deepEqual(normalizeFilters(undefined), DEFAULT_FILTERS);
  assert.deepEqual(normalizeFilters({type: 'spaceship', capacity: '99', flexible: 'yes', access: 'everything'}), DEFAULT_FILTERS);
  assert.deepEqual(normalizeFilters({type: 'lecture', capacity: '40', flexible: true, access: 'general'}), {type: 'lecture', capacity: '40', flexible: true, access: 'general'});
  assert.deepEqual(normalizeFilters(JSON.parse(JSON.stringify(f({type: 'seminar', capacity: '20'})))), f({type: 'seminar', capacity: '20'}), 'survives a JSON round trip (localStorage)');
  assert.equal(isDefaultFilters(DEFAULT_FILTERS), true);
  assert.equal(isDefaultFilters(f({flexible: true})), false);
  assert.equal(activeFilterCount(DEFAULT_FILTERS), 0);
  assert.equal(activeFilterCount(f({type: 'lecture', capacity: '40', flexible: true, access: 'general'})), 4);
  assert.deepEqual(filterSummary(f({type: 'lecture', capacity: '40'})), ['Lecture hall', 'At least 40 seats']);
  assert.deepEqual(filterSummary(f({access: 'restricted', flexible: true})), ['Flexible furniture', 'Include restricted rooms']);
  assert.deepEqual(FILTER_TYPES.map(o => o.label), ['All', 'Computer room', 'Seminar room', 'Lecture hall']);
  assert.deepEqual(CAPACITY_OPTIONS.map(o => o.label), ['Any', 'At least 10 seats', 'At least 20 seats', 'At least 40 seats']);
  assert.deepEqual(ACCESS_OPTIONS.map(o => o.label), ['All rooms', 'General access confirmed only', 'Include restricted rooms']);
  assert.equal(Object.isFrozen(DEFAULT_FILTERS), true);
});
test('favorites bypass every filter', () => {
  const favs = new Set(['AA B 1', 'AA B 5', 'ZZ X 9']);
  const strict = f({type: 'lecture', capacity: '40', flexible: true, access: 'general'});
  assert.deepEqual(filterRooms(all, fixture, strict), []);
  assert.deepEqual(favoriteRooms(all, favs).map(r => r.code), ['AA B 1', 'AA B 5', 'ZZ X 9'], 'favorites list ignores filters, even for rooms without metadata');
});

// ---------------------------------------------------------------- recommendation candidates are chosen BEFORE requesting schedules
const ctx = {today: '2026-11-18', now: 600, nowMs: 5_000_000};
test('candidate selection: only rooms that match the filters are ever requested', () => {
  const big = roomsJson.filter(r => r.campus === 'Zentrum');
  const lecture = filterRooms(big, catalog, f({type: 'lecture'}));
  assert.ok(lecture.length > 6 && lecture.length < big.length);
  const plan = planInitialLoad({rooms: lecture, allRooms: roomsJson, favorites: [], getRecord: () => undefined, ctx});
  assert.equal(plan.request.length, INITIAL_REQUEST_BUDGET);
  for (const code of plan.request) assert.equal(roomMeta(catalog, code).typeFilter, 'lecture', `${code} must be a lecture hall`);
  const computer = filterRooms(big, catalog, f({type: 'computer'}));
  assert.deepEqual(ids(computer), ['HG E 27']);
  const one = planInitialLoad({rooms: computer, allRooms: roomsJson, favorites: [], getRecord: () => undefined, ctx});
  assert.deepEqual(one.request, ['HG E 27'], 'one matching room: one request, not six');
  const none = planInitialLoad({rooms: filterRooms(big, catalog, f({access: 'general'})), allRooms: roomsJson, favorites: [], getRecord: () => undefined, ctx});
  assert.deepEqual([none.request, none.attempted], [[], []], 'nothing is confirmed general access: no schedule is requested for it');
});
test('candidate selection: non-matching rooms with cached data are not recommended, and order is deterministic', () => {
  const big = roomsJson.filter(r => r.campus === 'Hönggerberg');
  const sem = filterRooms(big, catalog, f({type: 'seminar', capacity: '20'}));
  const order = orderCandidates({rooms: sem, getRecord: () => undefined, ctx});
  assert.ok(order.every(c => roomMeta(catalog, c).typeFilter === 'seminar' && roomMeta(catalog, c).seats >= 20));
  assert.deepEqual(order, orderCandidates({rooms: sem, getRecord: () => undefined, ctx}));
});
test('coverage with filters counts only the matching rooms and stays honest', () => {
  const big = roomsJson.filter(r => r.campus === 'Zentrum');
  const sem = filterRooms(big, catalog, f({type: 'seminar'}));
  const attempted = new Set(sem.slice(0, 4).map(r => r.code));
  const rec = {state: 'ready', allocations: [], roomVerified: true, fetchedAt: 'x', receivedAt: ctx.nowMs, ageAtReceiptMs: 0};
  const s = summarizeCoverage({rooms: sem, attempted, getRecord: () => rec, ctx});
  assert.deepEqual([s.total, s.checked], [sem.length, 4]);
  assert.equal(describeCoverage(s).text, `Recommendations based on 4 of ${sem.length} listed rooms checked.`);
});

// ---------------------------------------------------------------- room information content
test('room information: unknown fields say Unknown, verified details appear verbatim, link points to ETH', () => {
  const hg = roomMeta(catalog, 'HG E 27'), plain = roomMeta(catalog, 'HG D 3.3');
  assert.ok(equipmentList(hg).some(([l, v]) => l === 'Printer' && v === 'available 2'));
  assert.ok(accessibilityList(hg).some(([l, v]) => l === 'Access' && v === 'wheelchair accessible'));
  assert.equal(equipmentList(plain), null, 'not verified for this room');
  assert.equal(accessibilityList(plain), null);
  const rows = roomInfoRows(plain, catalog, 'Zentrum');
  assert.deepEqual(rows.find(r => r.label === 'Seating'), {label: 'Seating', value: 'Unknown', unknown: true});
  assert.equal(rows.find(r => r.label === 'Building and campus').value, 'HG · Zentrum');
  assert.equal(rows.find(r => r.label === 'Room type').value, 'Seminars / Courses');
  assert.equal(roomInfoRows(roomMeta(catalog, 'HG D 3.1'), catalog).find(r => r.label === 'Seating').value, 'Variable seating (flexible furniture)');
  assert.equal(officialRoomUrl('HG E 27'), 'https://ethz.ch/staffnet/de/service/raeume-gebaeude/rauminfo/raumdetails.html?building=HG&floor=E&room=27');
  assert.equal(officialRoomUrl('HG D 1.1'), 'https://ethz.ch/staffnet/de/service/raeume-gebaeude/rauminfo/raumdetails.html?building=HG&floor=D&room=1.1');
  assert.equal(officialRoomUrl('not a room'), null);
  assert.deepEqual(roomInfoRows(null, catalog).map(r => [r.label, r.value]), [['Room type', 'Unknown'], ['Seats', 'Unknown']]);
});
