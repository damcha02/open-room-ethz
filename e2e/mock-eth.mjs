/** Mock ETH roominfo endpoint for browser tests (never contacts ETH).
 * Rooms get a schedule "scenario" in order of their first request, cycling S0..S5, so the outcome is deterministic
 * for a given request order and every expectation can be derived from `scenarioOf(room)`.
 * Named rooms: HG E 21 = exists, empty schedule; HG E 22 = unknown room (200 []); HG E 23 = ETH error (500).
 * All times are Zurich wall-clock; the browser clock is frozen at 10:00 on 2026-11-18. */
import http from 'node:http';

export const SCENARIOS = {
  // night = type-8 00:00-08:00 and 22:00-23:59 on every day
  S0: {label: 'free all day', blocks: []},
  S1: {label: 'booked 09-11 and 14-16', blocks: [['09:00', '11:00', 2], ['14:00', '16:00', 2]]},
  S2: {label: 'type-13 block 09:30-12:00', blocks: [['09:30', '12:00', 13]]},
  S3: {label: 'booked 10:20-12:00 and 12:30-13:00', blocks: [['10:20', '12:00', 2], ['12:30', '13:00', 2]]},
  S4: {label: 'booked 15-16', blocks: [['15:00', '16:00', 2]]},
  S5: {label: 'booked 10:35-11:00', blocks: [['10:35', '11:00', 2]]}
};
const ORDER = Object.keys(SCENARIOS);
const dayList = (from, to) => { const out = []; for (let d = new Date(from + 'T12:00:00Z'); d <= new Date(to + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };
const entry = (day, a, b, type) => ({veranstaltungsort: '1', date_from: `${day}T${a}:00`, date_to: `${day}T${b}:00`,
  belegungsserie: {belegungsserie: '1', veranstaltungsort: '1', belegungstyp: type,
    veranstaltung: type === 2 ? {allocationTitle: 'Lecture', veranstaltungsnummer: '1', findetStatt: 1} : null}});

export function startMock(port) {
  const stats = {alloc: {}, info: {}, total: 0, arrivals: []};
  const scenarios = new Map();
  let mode = {rate429: false, delayMs: 0, fail: ''};
  const scenarioOf = room => scenarios.get(room);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (u.pathname === '/__stats') return json({...stats, scenarios: Object.fromEntries(scenarios)});
    if (u.pathname === '/__mode') { mode = {rate429: u.searchParams.get('rate429') === '1', delayMs: Number(u.searchParams.get('delay') || 0), fail: u.searchParams.get('fail') || ''}; return res.end('ok'); }
    const path = u.searchParams.get('path') || '';
    const send = (status, type, body, h = {}) => { res.writeHead(status, {'content-type': type, 'x-ratelimit-remaining': '20', ...h}); res.end(body); };
    stats.total++;
    stats.arrivals.push({path, at: Date.now()});
    if (path.startsWith('/v2/rooms/')) {
      const room = path.slice(10);
      stats.info[room] = (stats.info[room] || 0) + 1;
      if (room === 'HG E 21') return send(200, 'application/json;charset=utf-8', JSON.stringify({id: 'HG E 021', nameWithoutLeadingZeros: 'HG E 21'}));
      return send(200, 'text/html;charset=utf-8', '<!DOCTYPE html><html><body>Not found</body></html>');
    }
    const m = /^\/rooms\/(.+)\/allocations$/.exec(path);
    if (!m) return send(404, 'text/plain', 'no');
    const room = m[1];
    stats.alloc[room] = (stats.alloc[room] || 0) + 1;
    const answer = () => {
      if (mode.rate429) return send(429, 'text/plain', 'slow down', {'retry-after': '3'});
      if (mode.fail === '500') return send(500, 'text/plain', 'boom');
      if (mode.fail === 'malformed') return send(200, 'application/json;charset=utf-8', JSON.stringify([{date_from: 'not a date', date_to: '2026-11-18T10:00:00'}]));
      if (mode.fail === 'html') return send(200, 'text/html;charset=utf-8', '<!DOCTYPE html><html>maintenance</html>');
      if (room === 'HG E 23') return send(500, 'text/plain', 'boom');
      if (room === 'HG E 21' || room === 'HG E 22') return send(200, 'application/json;charset=utf-8', '[]');
      if (!scenarios.has(room)) scenarios.set(room, ORDER[scenarios.size % ORDER.length]);
      const blocks = SCENARIOS[scenarios.get(room)].blocks;
      const list = [];
      for (const d of dayList(u.searchParams.get('from'), u.searchParams.get('to'))) {
        list.push(entry(d, '00:00', '08:00', 8), entry(d, '22:00', '23:59', 8));
        for (const [a, b, t] of blocks) list.push(entry(d, a, b, t));
      }
      return send(200, 'application/json;charset=utf-8', JSON.stringify(list));
    };
    if (mode.delayMs > 0) setTimeout(answer, mode.delayMs); else answer(); // a slow ETH
  });
  return new Promise(resolve => server.listen(port, () => resolve({
    stats, scenarioOf, close: () => server.close(),
    setRate429: on => { mode = {...mode, rate429: on}; },
    setFail: kind => { mode = {...mode, fail: kind}; },
    setDelay: ms => { mode = {...mode, delayMs: ms}; }
  })));
}
