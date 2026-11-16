/** Read-only proxy for ETH's publicly displayed room allocation data.
 * Not an official or supported ETH API. Never forwards cookies or credentials.
 * Caching, de-duplication and rate-limit handling live in ../lib/eth-client.js (single-process only).
 */
import {config, UpstreamError, rateLimitedError, cacheGet, cacheSet, dedupe, scheduled, noteResponse} from '../lib/eth-client.js';

const MAX_RESPONSE_BYTES = 1_500_000;
const ROOM_RE = /^[A-Z]{2,4} [A-Z]{1,3} [0-9]{1,5}(?:\.[0-9]{1,5}){0,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// ETH publishes Zurich wall-clock timestamps without offset, e.g. 2026-10-26T10:00:00
const LOCAL_TS_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value;
}
export function validRoom(value) {
  return typeof value === 'string' && ROOM_RE.test(value);
}
export function validLocalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const m = LOCAL_TS_RE.exec(value);
  return Boolean(m) && validDate(m[1]);
}
function send(res, status, data, cache = 'no-store', extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

/** One scheduled, validated GET to ETH. Failures become UpstreamError; redirects are never followed. */
async function ethGet(params, accept = 'application/json') {
  const endpoint = new URL(config().endpoint);
  for (const [k, v] of Object.entries(params)) endpoint.searchParams.set(k, v);
  let response;
  try {
    response = await scheduled(() => fetch(endpoint, {
      method: 'GET',
      headers: {'Accept': accept, 'Accept-Language': 'de-CH,de;q=0.9'},
      redirect: 'manual', // a redirect (e.g. to a login page) is a failure, never followed
      signal: AbortSignal.timeout(10_000)
    }));
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(502, error?.name === 'TimeoutError' ? 'ETH did not respond in time' : 'ETH request failed');
  }
  noteResponse(response);
  if (response.status === 429) throw rateLimitedError();
  if (!response.ok) throw new UpstreamError(502, `ETH returned HTTP ${response.status}`);
  return response;
}
async function readText(response) {
  const sizeHeader = Number(response.headers.get('content-length') || 0);
  if (sizeHeader > MAX_RESPONSE_BYTES) throw new UpstreamError(502, 'ETH response exceeds size limit');
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new UpstreamError(502, 'ETH response exceeds size limit');
  return text;
}

/** Does this room exist at ETH? true / false, or null when the check itself failed (never guessed). Uses the details
 * interface of ETH's own Rauminfo page (undocumented publicly): JSON for a real room, an HTML error page otherwise. */
export function verifyRoom(room) {
  const key = `verify|${room}`;
  const known = cacheGet(key);
  if (known !== undefined) return Promise.resolve(known);
  return dedupe(key, async () => {
    const cfg = config();
    try {
      const response = await ethGet({path: `/v2/rooms/${room}`, lang: 'en'}, 'application/json');
      const contentType = response.headers.get('content-type') || '';
      const text = await readText(response);
      if (!/json/i.test(contentType)) { cacheSet(key, false, cfg.notFoundTtlMs); return false; }
      let info;
      try { info = JSON.parse(text); } catch { return null; }
      const name = info && typeof info === 'object' ? info.nameWithoutLeadingZeros : null;
      const exists = typeof name === 'string' && name.trim().toUpperCase() === room.toUpperCase();
      cacheSet(key, exists, exists ? cfg.verifyTtlMs : cfg.notFoundTtlMs);
      return exists;
    } catch { return null; }
  });
}

function parseAllocations(text) {
  let entries;
  try { entries = JSON.parse(text); }
  catch { throw new UpstreamError(502, 'ETH returned invalid JSON'); }
  if (!Array.isArray(entries)) throw new UpstreamError(502, 'Unexpected ETH response shape');
  const result = [];
  for (const entry of entries) {
    // Never skip a malformed record: it might be a real booking, and dropping it would show the room as free.
    if (!entry || typeof entry !== 'object' || !validLocalTimestamp(entry.date_from) || !validLocalTimestamp(entry.date_to) || entry.date_to < entry.date_from) {
      throw new UpstreamError(502, 'ETH returned a malformed reservation entry');
    }
    const series = entry.belegungsserie ?? {};
    const event = series.veranstaltung ?? null;
    result.push({
      start: entry.date_from,
      end: entry.date_to,
      type: typeof series.belegungstyp === 'number' ? series.belegungstyp : null,
      title: typeof event?.allocationTitle === 'string' ? event.allocationTitle : null,
      courseNumber: typeof event?.veranstaltungsnummer === 'string' ? event.veranstaltungsnummer : null,
      eventIsHeld: typeof event?.findetStatt === 'number' ? event.findetStatt : null
    });
  }
  return result;
}

/** Cached + de-duplicated allocations for one room/week. Only successful results are cached; errors never are. */
export async function getAllocations(room, from, to) {
  const key = `alloc|${room}|${from}|${to}`;
  const hit = cacheGet(key);
  if (hit) return {...hit, cached: true};
  return dedupe(key, async () => {
    const response = await ethGet({path: `/rooms/${room}/allocations`, from, to});
    if (!/json/i.test(response.headers.get('content-type') || '')) throw new UpstreamError(502, 'ETH did not return JSON');
    const allocations = parseAllocations(await readText(response));
    // A non-empty result proves the room exists. An empty one proves nothing (ETH answers 200 [] for unknown rooms).
    const roomVerified = allocations.length > 0 ? true : await verifyRoom(room);
    const body = {room, from, to, allocations, roomVerified, source: 'ETH Rauminfo', fetchedAt: new Date().toISOString()};
    const cfg = config();
    cacheSet(key, body, roomVerified === null ? cfg.unverifiedTtlMs : cfg.cacheTtlMs);
    return {...body, cached: false};
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, {error:'Method not allowed'});
  const query = req.query ?? Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  const {room, from, to} = query;
  if (!validRoom(room) || !validDate(from) || !validDate(to)) {
    return send(res, 400, {error:'Invalid room or date (expected YYYY-MM-DD)'});
  }
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
  if (days < 0 || days > 6) return send(res, 400, {error:'Date range must be 1–7 inclusive calendar days'});
  try {
    const body = await getAllocations(room, from, to);
    const cfg = config();
    const shareable = body.roomVerified === true;
    const cache = shareable ? `public, max-age=60, s-maxage=${Math.round(cfg.cacheTtlMs / 1000)}` : 'no-store';
    return send(res, 200, body, cache);
  } catch (error) {
    if (error instanceof UpstreamError) {
      const headers = error.retryAfter ? {'Retry-After': String(error.retryAfter)} : {};
      return send(res, error.status, {error: error.message, code: error.code, ...(error.retryAfter ? {retryAfter: error.retryAfter} : {})}, 'no-store', headers);
    }
    return send(res, 502, {error:'ETH request failed'});
  }
}
