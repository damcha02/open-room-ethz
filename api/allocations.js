/** Read-only proxy for ETH's publicly displayed room allocation data.
 * Not an official or supported ETH API. Never forwards cookies or credentials.
 */
const ETH_ENDPOINT = 'https://ethz.ch/bin/ethz/roominfo';
const MAX_RESPONSE_BYTES = 1_500_000;
const ROOM_RE = /^[A-Z]{2,4} [A-Z]{1,3} [0-9]{1,5}(?:\.[0-9]{1,5}){0,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value;
}
export function validRoom(value) {
  return typeof value === 'string' && ROOM_RE.test(value);
}
function send(res, status, data, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
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
  const endpoint = new URL(ETH_ENDPOINT);
  endpoint.searchParams.set('path', `/rooms/${room}/allocations`);
  endpoint.searchParams.set('from', from);
  endpoint.searchParams.set('to', to);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {'Accept':'application/json', 'Accept-Language':'de-CH,de;q=0.9'},
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return send(res, 502, {error:`ETH returned HTTP ${response.status}`});
    const contentType = response.headers.get('content-type') || '';
    if (!/json/i.test(contentType)) return send(res, 502, {error:'ETH did not return JSON'});
    const sizeHeader = Number(response.headers.get('content-length') || 0);
    if (sizeHeader > MAX_RESPONSE_BYTES) return send(res, 502, {error:'ETH response exceeds size limit'});
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return send(res, 502, {error:'ETH response exceeds size limit'});
    let entries;
    try { entries = JSON.parse(text); }
    catch { return send(res, 502, {error:'ETH returned invalid JSON'}); }
    if (!Array.isArray(entries)) return send(res, 502, {error:'Unexpected ETH response shape'});
    const result = [];
    for (const entry of entries) {
      if (!entry || typeof entry.date_from !== 'string' || typeof entry.date_to !== 'string') continue;
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
    return send(res, 200, {room, from, to, allocations:result, source:'ETH Rauminfo', fetchedAt:new Date().toISOString()}, 'public, s-maxage=300, stale-while-revalidate=300');
  } catch (error) {
    return send(res, 502, {error: error?.name === 'TimeoutError' ? 'ETH did not respond in time' : 'ETH request failed'});
  }
}
