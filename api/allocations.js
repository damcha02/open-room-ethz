/** Read-only proxy for ETH's publicly displayed room allocation data.
 * Not an official or supported ETH API. Never forwards cookies or credentials.
 * Caching, de-duplication and rate-limit handling live in ../lib/eth-client.js (single-process only).
 */
import {config, rateLimitedError, cacheGet, cacheSet, dedupe, scheduled, noteResponse} from '../lib/eth-client.js';
import {
  UpstreamError, validDate, validRoom, validLocalTimestamp, validateQuery, upstreamUrl, allocationsParams, roomDetailsParams,
  upstreamInit, readLimitedText, parseAllocations, interpretRoomDetails, serveBody, cacheControlFor, errorPayload
} from '../lib/allocations-core.js';

export {validDate, validRoom, validLocalTimestamp};
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
  const url = upstreamUrl(config().endpoint, params);
  let response;
  try {
    response = await scheduled(() => fetch(url, upstreamInit(accept)));
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(502, error?.name === 'TimeoutError' ? 'ETH did not respond in time' : 'ETH request failed');
  }
  noteResponse(response);
  if (response.status === 429) throw rateLimitedError();
  if (!response.ok) throw new UpstreamError(502, `ETH returned HTTP ${response.status}`);
  return response;
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
      const response = await ethGet(roomDetailsParams(room), 'application/json');
      const text = await readLimitedText(response);
      const exists = interpretRoomDetails(response.headers.get('content-type'), text, room);
      if (exists !== null) cacheSet(key, exists, exists ? cfg.verifyTtlMs : cfg.notFoundTtlMs);
      return exists;
    } catch { return null; }
  });
}

/** Cached + de-duplicated allocations for one room/week. Only successful results are cached; errors never are. */
export async function getAllocations(room, from, to) {
  const key = `alloc|${room}|${from}|${to}`;
  const hit = cacheGet(key);
  if (hit) return serveBody(hit, true, Date.now());
  return dedupe(key, async () => {
    const response = await ethGet(allocationsParams(room, from, to));
    if (!/json/i.test(response.headers.get('content-type') || '')) throw new UpstreamError(502, 'ETH did not return JSON');
    const allocations = parseAllocations(await readLimitedText(response));
    // A non-empty result proves the room exists. An empty one proves nothing (ETH answers 200 [] for unknown rooms).
    const roomVerified = allocations.length > 0 ? true : await verifyRoom(room);
    const body = {room, from, to, allocations, roomVerified, source: 'ETH Rauminfo', fetchedAt: new Date().toISOString()};
    const cfg = config();
    cacheSet(key, body, roomVerified === null ? cfg.unverifiedTtlMs : cfg.cacheTtlMs);
    return serveBody(body, false, Date.now());
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, {error:'Method not allowed'});
  const query = req.query ?? Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  const {room, from, to} = query;
  const valid = validateQuery({room, from, to});
  if (!valid.ok) return send(res, valid.status, {error: valid.error});
  try {
    const body = await getAllocations(room, from, to);
    return send(res, 200, body, cacheControlFor(body, config().cacheTtlMs));
  } catch (error) {
    const failure = errorPayload(error);
    return send(res, failure.status, failure.body, 'no-store', failure.headers);
  }
}
