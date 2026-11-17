/** Request routing for the Worker. Only dynamic API routes ever reach this code: static files are served by Workers Static Assets
 * without invoking the Worker (see `assets.run_worker_first` in wrangler.jsonc). Depends only on web-standard Request/Response,
 * so it is unit-tested in Node with a fake Durable Object stub. */
import {OFFICIAL_ENDPOINT, validateQuery} from '../lib/allocations-core.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Served-By': 'open-room-worker'   // static assets never carry this header: it proves which requests ran the Worker
};
function json(status, body, cacheControl = 'no-store', extra = {}) {
  return new Response(JSON.stringify(body), {status, headers: {...JSON_HEADERS, 'Cache-Control': cacheControl, ...extra}});
}

/** The upstream is fixed. A different endpoint is accepted ONLY when a test deployment sets ALLOW_TEST_UPSTREAM=1, and then only
 * on localhost. Production never sets that variable, and no request can influence the choice. */
export function resolveEndpoint(env) {
  if (env.ALLOW_TEST_UPSTREAM === '1' && env.ETH_ENDPOINT) {
    try {
      const url = new URL(env.ETH_ENDPOINT);
      if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return url.toString();
    } catch { /* fall through to the official endpoint */ }
  }
  return OFFICIAL_ENDPOINT;
}

/** The Durable Object being unreachable (e.g. a free-plan quota is used up) must never look like an empty or free schedule. */
const gatewayDown = () => json(503, {error: 'The room-data service is temporarily unavailable', code: 'gateway_unavailable', retryAfter: 60}, 'no-store', {'Retry-After': '60'});

export async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/allocations' || path === '/api/status') {
    if (request.method !== 'GET') return json(405, {error: 'Method not allowed'}, 'no-store', {Allow: 'GET'});
    if (path === '/api/status') {
      try { return json(200, await env.ETH_GATEWAY.getByName('global').status()); } catch { return gatewayDown(); }
    }
    const query = {room: url.searchParams.get('room'), from: url.searchParams.get('from'), to: url.searchParams.get('to')};
    const valid = validateQuery(query); // rejected here: invalid requests cost no Durable Object request and never reach ETH
    if (!valid.ok) return json(valid.status, {error: valid.error});
    try {
      const result = await env.ETH_GATEWAY.getByName('global').allocations(query.room, query.from, query.to);
      return json(result.status, result.body, result.cacheControl, result.headers);
    } catch { return gatewayDown(); }
  }
  if (path.startsWith('/api/')) return json(404, {error: 'Not found'});
  return env.ASSETS.fetch(request); // not an API route and no file matched: the assets binding answers (its 404 page)
}
