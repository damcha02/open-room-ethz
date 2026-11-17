/** Runtime-neutral core of the room-allocation API: validation, strict parsing, room-details interpretation, response shaping.
 * Used by BOTH the Node development server (api/allocations.js) and the Cloudflare Worker (worker/). It touches no process
 * environment, no storage and no global clock: everything time-related is passed in, so the same code behaves identically
 * everywhere. Not an official or supported ETH API; nothing here ever forwards cookies or credentials.
 */
export const OFFICIAL_ENDPOINT = 'https://ethz.ch/bin/ethz/roominfo';
export const MAX_RESPONSE_BYTES = 1_500_000;
/** Identifies this client to ETH (transparency). No personal data. */
export const USER_AGENT = 'OpenRoomETHZ/1.0 (+https://github.com/damcha02/open-room-ethz; unofficial student project, read-only)';

const ROOM_RE = /^[A-Z]{2,4} [A-Z]{1,3} [0-9]{1,5}(?:\.[0-9]{1,5}){0,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// ETH publishes Zurich wall-clock timestamps without offset, e.g. 2026-10-26T10:00:00
const LOCAL_TS_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export class UpstreamError extends Error {
  constructor(status, message, {retryAfter = null, code = 'upstream'} = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter; // seconds
    this.code = code;
  }
}

export function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validRoom(value) {
  return typeof value === 'string' && ROOM_RE.test(value);
}
export function validLocalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const m = LOCAL_TS_RE.exec(value);
  return Boolean(m) && validDate(m[1]);
}
/** Strict input validation shared by every entry point. Returns {ok:true} or {ok:false,status,error}. */
export function validateQuery({room, from, to}) {
  if (!validRoom(room) || !validDate(from) || !validDate(to)) return {ok: false, status: 400, error: 'Invalid room or date (expected YYYY-MM-DD)'};
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
  if (days < 0 || days > 6) return {ok: false, status: 400, error: 'Date range must be 1–7 inclusive calendar days'};
  return {ok: true};
}

/** The fixed, trusted upstream request for one room/week. The endpoint is never taken from user input. */
export function upstreamUrl(endpoint, params) {
  const url = new URL(endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}
export const allocationsParams = (room, from, to) => ({path: `/rooms/${room}/allocations`, from, to});
export const roomDetailsParams = room => ({path: `/v2/rooms/${room}`, lang: 'en'});
export function upstreamInit(accept = 'application/json') {
  return {
    method: 'GET',
    headers: {'Accept': accept, 'Accept-Language': 'de-CH,de;q=0.9', 'User-Agent': USER_AGENT},
    redirect: 'manual', // a redirect (e.g. to a login page) is a failure, never followed
    signal: AbortSignal.timeout(10_000)
  };
}

/** Reads a body with a size cap (header first, then the real length). */
export async function readLimitedText(response) {
  const sizeHeader = Number(response.headers.get('content-length') || 0);
  if (sizeHeader > MAX_RESPONSE_BYTES) throw new UpstreamError(502, 'ETH response exceeds size limit');
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new UpstreamError(502, 'ETH response exceeds size limit');
  return text;
}

/** Strict parsing. ANY malformed entry fails the whole response: a skipped booking would make a room look free. */
export function parseAllocations(text) {
  let entries;
  try { entries = JSON.parse(text); }
  catch { throw new UpstreamError(502, 'ETH returned invalid JSON'); }
  if (!Array.isArray(entries)) throw new UpstreamError(502, 'Unexpected ETH response shape');
  const result = [];
  for (const entry of entries) {
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

/** Room existence from ETH's room-details answer: true / false, or null when it cannot be told (never guessed).
 * JSON naming the room = exists; an HTML page (ETH's "not found") = does not exist. */
export function interpretRoomDetails(contentType, text, room) {
  if (!/json/i.test(contentType || '')) return false;
  let info;
  try { info = JSON.parse(text); } catch { return null; }
  const name = info && typeof info === 'object' ? info.nameWithoutLeadingZeros : null;
  return typeof name === 'string' && name.trim().toUpperCase() === room.toUpperCase();
}

/** Every response states how old the ORIGINAL ETH answer is (`ageMs`, measured on the server clock so it is immune to wrong
 * client clocks). Caching never makes data look younger: `fetchedAt` is the original ETH fetch time. */
export function serveBody(body, cached, nowMs, extra = {}) {
  const fetched = Date.parse(body.fetchedAt);
  return {...body, cached, ...extra, ageMs: Number.isFinite(fetched) ? Math.max(0, nowMs - fetched) : null};
}
/** max-age=0: browsers never reuse a response on their own (the app keeps its own age-tracked cache).
 * s-maxage: a shared cache may hold only verified, fresh answers, for at most the server TTL. */
export function cacheControlFor(body, ttlMs, stale = false) {
  return body.roomVerified === true && !stale ? `public, max-age=0, s-maxage=${Math.round(ttlMs / 1000)}` : 'no-store';
}
/** HTTP shape of a failure: never an allocations body, so a failure can never be read as "free". */
export function errorPayload(error) {
  if (error instanceof UpstreamError) {
    return {
      status: error.status,
      body: {error: error.message, code: error.code, ...(error.retryAfter ? {retryAfter: error.retryAfter} : {})},
      headers: error.retryAfter ? {'Retry-After': String(error.retryAfter)} : {}
    };
  }
  return {status: 502, body: {error: 'ETH request failed'}, headers: {}};
}
