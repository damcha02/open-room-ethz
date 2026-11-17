#!/usr/bin/env node
/** Builds public/room-metadata.json: a normalized, versioned catalog of verified ETH room metadata.
 *
 * Offline mode (default, makes no request): merges snapshots you already saved.
 *   node scripts/build-room-metadata.mjs --list rooms.json --rectorate rectorate.json --details ./details --date 2026-11-17
 *
 * Fetch helpers (polite by construction; ETH has not approved automated use, so these are deliberately limited):
 *   --fetch-list <file>              ONE request: ETH Rauminfo room list (what ETH's own search page loads once)
 *   --fetch-types <file>             ONE request: the room-type vocabulary
 *   --fetch-details "HG E 27,HG D 1.1" <dir>   at most 12 rooms, 3 s apart. Refused beyond that: this is NOT a crawler.
 *   --fetch-rectorate <file>         the 10 Rectorate list pages named in docs/ROOM_METADATA.md, 3 s apart
 *
 * Nothing is invented: a field ETH does not publish for a room stays null. Seats and computer workstations are separate fields. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'OpenRoomETHZ-metadata/1.0 (+https://github.com/damcha02/open-room-ethz; unofficial student project; deliberately minimal requests)';
const ROOMINFO = 'https://ethz.ch/bin/ethz/roominfo';
const RECTORATE_PAGES = ['hg', 'cab', 'chn', 'eta-etf-etz', 'hci', 'hil', 'hit', 'hph-hpv', 'hcp', 'hpk-hpl-hpt'];
const rectorateUrl = p => `https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume/bilder-raeume/${p}.html`;
const MAX_DETAIL_ROOMS = 12;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** How the app's three room-type filters map onto ETH's own room types. ETH calls seminar rooms "Seminars / Courses". */
export const TYPE_MAP = {
  'Computer': {filter: 'computer', label: 'Computer room'},
  'Seminars / Courses': {filter: 'seminar', label: 'Seminar room'},
  'Lecture hall': {filter: 'lecture', label: 'Lecture hall'}
};

/** Student access. Only OFFICIAL ETH documents may set a status. Reservation status is never used. As of 2026-11-17 no document states
 * (or restricts) student use of unbooked rooms, so every room is `unknown`; `general` and `restricted` are supported by the data model
 * and the app for when ETH publishes such rules, but no room has been classified that way. */
export const ACCESS_SOURCES = {
  reglement: 'https://ethz.ch/content/dam/ethz/main/eth-zurich/organisation/rechtssammlung/214.11.pdf',
  guidelines: 'https://ethz.ch/content/dam/ethz/common/docs/weisungssammlung/files-de/rektoratsraeume-benuetzung.pdf'
};
export const accessDefault = date => ({
  accessStatus: 'unknown',
  accessNotes: 'ETH publishes no access rule for this particular room. The general room-use regulation (RSETHZ 214.11) lists the purposes of ordinary use (teaching, research, administration, official events) and does not mention self-study by students, so it is not confirmed whether students may use the room when it has no booking.',
  accessSource: ACCESS_SOURCES.reglement,
  accessVerifiedAt: date
});
export const accessOverrides = date => ({
  'HIT E 51': {
    accessNotes: 'Siemens-Auditorium: allocated to the Rectorate but not used for general teaching (Rectorate guidelines, Art. 1 para. 2). The documents do not say whether students may use it when it has no booking.',
    accessSource: ACCESS_SOURCES.guidelines, accessVerifiedAt: date
  },
  'HG E 27': {
    accessNotes: 'Computer room. No official ETH page was found that lists computer rooms or says who may use them or when (checked 2026-11-17), so access is not confirmed.',
    accessVerifiedAt: date
  }
});

const num = v => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };
const code = r => `${r.building} ${r.floor} ${r.room}`;

export function normalizeSeating(label) {
  if (typeof label !== 'string') return null;
  if (/^variable seating$/i.test(label.trim())) return 'variable';
  if (/^fixed seating$/i.test(label.trim())) return 'fixed';
  return null; // any other wording is kept in the detail text but is not classified
}
/** Verified details of one room from ETH's room-details JSON. Labels and values are ETH's own English wording, verbatim. */
export function extractDetail(json) {
  const pairs = (tab, skip = () => false) => (tab?.attributes ?? []).filter(a => !a.isAttachment && a.value !== null && a.value !== '' && !skip(a)).map(a => [a.label, String(a.value)]);
  const tab = title => json.tabs.find(t => t.title === title);
  const overview = tab('Overview');
  const attr = name => overview?.attributes?.find(a => a.name === name)?.value ?? null;
  const taken = new Set(['RAUM.OBJ', 'RAUM.ETAGE', 'RAUM.TYP', 'PL.SITZ.SITZPL', 'PL.SITZ.SITZPLZU', 'PL.SITZ.ARBPL', 'PL.SITZ.BESTU', 'PL.SITZ.ZINFO', 'PRUEF.PL.FEST', 'RAUM.BODENFL', 'ISC.HG']);
  const detail = {
    seatingLabel: attr('PL.SITZ.BESTU'),
    examSeats: attr('PRUEF.PL.FEST'),
    floorArea: attr('RAUM.BODENFL'),
    other: pairs(overview, a => taken.has(a.name) || /Building responsibilities|Info \+ Service/.test(a.label)),
    equipment: [...pairs(tab('Room Equipment')), ...pairs(tab('Multimedia'))],
    accessibility: pairs(tab('Accessibility'))
  };
  for (const k of Object.keys(detail)) if (detail[k] === null || (Array.isArray(detail[k]) && !detail[k].length)) delete detail[k];
  return detail;
}

export function buildCatalog({catalogRooms, list, types, rectorate, detailsByCode, date}) {
  const byCode = new Map(list.map(r => [code(r), r]));
  const rectSeats = new Map();
  for (const page of Object.values(rectorate)) for (const e of page.rooms) rectSeats.set(e.room, e.seats);
  const rooms = {};
  const problems = [];
  let rectCompared = 0, rectAgree = 0;
  for (const c of catalogRooms) {
    const l = byCode.get(c.code);
    if (!l) { problems.push(`${c.code}: not in the ETH room list`); continue; }
    const campus = l.locationName === 'Zürich Zentrum' ? 'Zentrum' : l.locationName === 'Zürich Hönggerberg' ? 'Hönggerberg' : null;
    if (campus !== c.campus) problems.push(`${c.code}: campus ${c.campus} in the app catalog vs ${l.locationName} at ETH`);
    const seats = num(l.seats);
    if (rectSeats.has(c.code) && seats !== null) { rectCompared++; if (rectSeats.get(c.code) === seats) rectAgree++; else problems.push(`${c.code}: seats ${seats} (Rauminfo list) vs ${rectSeats.get(c.code)} (Rectorate list)`); }
    const entry = {type: l.type ?? null, seats, extraSeats: num(l.additionalSeats), workstations: num(l.workplaces), seating: null};
    const d = detailsByCode.get(c.code);
    if (d) { const detail = extractDetail(d); entry.seating = normalizeSeating(detail.seatingLabel); entry.detail = detail; }
    rooms[c.code] = entry;
  }
  const vocab = Object.fromEntries(types.map(t => [t.type, {typeCode: String(t.typecode), ...(TYPE_MAP[t.type] ?? {filter: null, label: t.type})}]));
  const values = Object.values(rooms);
  return {
    problems,
    catalog: {
      schemaVersion: 1,
      catalogVersion: date,
      generatedAt: date,
      description: 'Verified ETH room metadata for the rooms in rooms.json. A null field means ETH does not publish it for that room (or it was not verified): unknown, never a negative or positive classification.',
      sources: {
        'rauminfo-list': {name: 'ETH Rauminfo room list', url: `${ROOMINFO}?path=/v2/rooms&lang=en`, retrieved: date, provides: ['type', 'seats', 'extraSeats', 'workstations', 'campus'], note: 'One request. Seats and Workplaces are separate ETH fields; computer rooms have workplaces and no seats.'},
        'rauminfo-types': {name: 'ETH Rauminfo room types', url: `${ROOMINFO}?path=/types&lang=en`, retrieved: date, provides: ['types']},
        'rauminfo-details': {name: 'ETH Rauminfo room details', url: `${ROOMINFO}?path=/v2/rooms/<room>&lang=en`, retrieved: date, provides: ['seating', 'detail'], rooms: Object.keys(rooms).filter(k => rooms[k].detail), note: 'A representative sample only, deliberately not the whole catalog. Rooms without detail have unknown seating, equipment and accessibility.'},
        'rectorate-lists': {name: 'ETH Rectorate room lists (Staffnet)', urls: RECTORATE_PAGES.map(rectorateUrl), retrieved: date, provides: ['seats (cross-check only)'], crossCheck: {compared: rectCompared, agree: rectAgree, disagree: rectCompared - rectAgree}},
        'computer-room-info': {name: 'Official ETH computer-room information', status: 'no official page found', retrieved: date, checked: ['https://ethz.ch/services/en/service/rooms-and-buildings.html', 'https://ethz.ch/staffnet/de/service/raeume-gebaeude/rektoratsraeume.html', 'https://ethz.ch/services/en/it-services/', 'https://ethz.ch/students/en/studies/'], note: 'No official page lists computer rooms, workstation counts or access rules, so ETH does not say here who may use a computer room or when.'}
      },
      accessRules: {
        checkedOn: date,
        documents: [
          {name: 'Raumbenützungsreglement (RSETHZ 214.11), version of 2026-09-01', url: ACCESS_SOURCES.reglement, says: 'Art. 5 lists the purposes of ordinary use (teaching, research, administration, official events). Art. 2: the unit a room is assigned to decides its use; the Rectorate decides for general teaching rooms. Self-study by students is neither listed nor prohibited.'},
          {name: 'Richtlinien für die Benützung der Rektoratsräume (2010)', url: ACCESS_SOURCES.guidelines, says: 'Regulates reservations and priorities (teaching has priority; separate rules for specific rooms remain reserved). It names HG F 30, HG G 60, MM C 78.1 and HIT E 51 as rooms not used for general teaching. It does not say whether students may use unbooked rooms.'},
          {name: 'ETH Rauminfo room data', url: `${ROOMINFO}?path=/v2/rooms/<room>&lang=en`, says: 'No field describes who may use a room. `responsible` and `orgunits` only name who manages it.'}
        ],
        conclusion: 'No document confirms general student access to any room and none documents a student-specific restriction, so every room is unknown. Reservation status is never used to derive access.'
      },
      accessDefault: accessDefault(date),
      accessOverrides: accessOverrides(date),
      fieldSources: {accessStatus: 'ETH regulations (see accessRules)', type: 'rauminfo-list', seats: 'rauminfo-list', extraSeats: 'rauminfo-list', workstations: 'rauminfo-list', seating: 'rauminfo-details', detail: 'rauminfo-details'},
      types: vocab,
      coverage: {
        rooms: values.length,
        withType: values.filter(r => r.type).length,
        withSeats: values.filter(r => r.seats !== null).length,
        withWorkstations: values.filter(r => r.workstations !== null).length,
        withSeating: values.filter(r => r.seating).length,
        withDetail: values.filter(r => r.detail).length,
        access: {general: 0, restricted: 0, unknown: values.length}
      },
      rooms
    }
  };
}

// ---------------------------------------------------------------- polite fetching
async function getJson(url) {
  const r = await fetch(url, {headers: {'User-Agent': UA, 'Accept': 'application/json'}});
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function fetchRectorate() {
  const out = {};
  for (const p of RECTORATE_PAGES) {
    await sleep(3000);
    const r = await fetch(rectorateUrl(p), {headers: {'User-Agent': UA}});
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    const text = (await r.text()).replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const rooms = new Map();
    for (const m of text.matchAll(/([A-Z]{2,4} [A-Z]{1,3} [0-9]{1,5}(?:\.[0-9]{1,5}){0,2})\s+(\d{1,4})\s+(Plätze|Seats)\b/g)) rooms.set(m[1], {room: m[1], seats: Number(m[2])});
    out[p] = {url: rectorateUrl(p), rooms: [...rooms.values()]};
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  if (args.includes('--fetch-list')) { const f = arg('--fetch-list'); fs.writeFileSync(f, JSON.stringify(await getJson(`${ROOMINFO}?path=/v2/rooms&lang=en`))); console.log('saved', f); return; }
  if (args.includes('--fetch-types')) { const f = arg('--fetch-types'); fs.writeFileSync(f, JSON.stringify(await getJson(`${ROOMINFO}?path=/types&lang=en`))); console.log('saved', f); return; }
  if (args.includes('--fetch-rectorate')) { const f = arg('--fetch-rectorate'); fs.writeFileSync(f, JSON.stringify(await fetchRectorate(), null, 1)); console.log('saved', f); return; }
  if (args.includes('--fetch-details')) {
    const rooms = arg('--fetch-details').split(',').map(s => s.trim()).filter(Boolean);
    const dir = args[args.indexOf('--fetch-details') + 2];
    if (rooms.length > MAX_DETAIL_ROOMS) throw new Error(`Refusing to fetch ${rooms.length} room-detail pages (limit ${MAX_DETAIL_ROOMS}). This script is not a crawler; ETH has not approved bulk automated use.`);
    fs.mkdirSync(dir, {recursive: true});
    for (const room of rooms) { await sleep(3000); fs.writeFileSync(path.join(dir, `${room.replace(/ /g, '_')}.json`), JSON.stringify(await getJson(`${ROOMINFO}?path=/v2/rooms/${encodeURIComponent(room)}&lang=en`))); console.log('saved', room); }
    return;
  }
  const date = arg('--date') ?? new Date().toISOString().slice(0, 10);
  const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const detailsByCode = new Map();
  const dir = arg('--details');
  if (dir) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) { const j = read(path.join(dir, f)); detailsByCode.set(j.nameWithoutLeadingZeros, j); }
  const {catalog, problems} = buildCatalog({
    catalogRooms: read(path.join(root, 'public', 'rooms.json')), list: read(arg('--list')), types: read(arg('--types')),
    rectorate: read(arg('--rectorate')), detailsByCode, date
  });
  for (const p of problems) console.error('PROBLEM:', p);
  if (problems.length) process.exitCode = 1;
  fs.writeFileSync(path.join(root, 'public', 'room-metadata.json'), JSON.stringify(catalog, null, 1) + '\n');
  console.log('written public/room-metadata.json', JSON.stringify(catalog.coverage));
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exit(1); });
