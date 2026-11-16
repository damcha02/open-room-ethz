/** ETH timestamps are local Swiss wall-clock timestamps, e.g. 2026-10-26T10:00:00.
 * We deliberately do not interpret them in the viewer's local timezone.
 */
export function zurichParts(date = new Date()) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone:'Europe/Zurich', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type,p.value]));
  return {date:`${values.year}-${values.month}-${values.day}`, minute:Number(values.hour)*60 + Number(values.minute)};
}
export function shiftDate(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate()+n);
  return d.toISOString().slice(0,10);
}
export function weekStart(ymd) {
  const day = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return shiftDate(ymd, -(day === 0 ? 6 : day-1));
}
export function minutes(time) {
  const m = /T(\d\d):(\d\d)/.exec(time || '');
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? h*60+min : null;
}
export function displayTime(minute, format = '24') {
  if (!Number.isFinite(minute)) return '—';
  const h=Math.floor(minute/60), m=minute%60;
  if (format === '12') return `${h%12 || 12}:${String(m).padStart(2,'0')} ${h<12?'AM':'PM'}`;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
export function dayAllocations(entries, day) {
  return (Array.isArray(entries) ? entries : []).flatMap(entry => {
    if (!entry || typeof entry.start !== 'string' || typeof entry.end !== 'string') return [];
    const startDay=entry.start.slice(0,10), endDay=entry.end.slice(0,10);
    if (startDay > day || endDay < day || entry.end < entry.start) return [];
    const start = startDay < day ? 0 : minutes(entry.start);
    const end = endDay > day ? 1440 : minutes(entry.end);
    if (start===null || end===null || start >= end) return [];
    return [{start,end,type:entry.type,title:entry.title??null,courseNumber:entry.courseNumber??null}];
  }).sort((a,b)=>a.start-b.start || a.end-b.end);
}
export function mergeIntervals(entries) {
  const sorted = entries.map(({start,end})=>({start,end})).filter(i => i.start<i.end).sort((a,b)=>a.start-b.start);
  const result=[];
  for (const interval of sorted) {
    const last=result.at(-1);
    if (last && interval.start<=last.end) last.end=Math.max(last.end,interval.end);
    else result.push({...interval});
  }
  return result;
}
export function freeIntervals(entries, from=480, to=1320) {
  const blockers=mergeIntervals(entries);
  const free=[];
  let cursor=from;
  for (const item of blockers) {
    if (item.end <= from || item.start >= to) continue;
    if (item.start > cursor) free.push({start:cursor,end:Math.min(to,item.start)});
    cursor=Math.max(cursor, Math.min(to,item.end));
  }
  if (cursor < to) free.push({start:cursor,end:to});
  return free;
}
/** Status of one room for one day.
 * booked  = a type-2 (teaching event) reservation   -> state "busy"
 * blocked = any other published interval (type 8, 13, unknown ...) -> state "blocked"; semantics are unverified, so it never counts as free
 * unknown = no usable data: an empty ETH answer for a room ETH has not confirmed exists must never be shown as free.
 * `verified` comes from the proxy (roomVerified): only an explicit true means the room is confirmed (no default!).
 */
export function describeStatus(entries, day, today, now, format='24', verified) {
  if (!Array.isArray(entries)) return {state:'unknown',text:'Schedule unavailable',free:[],blocks:[]};
  if (entries.length===0 && verified!==true) {
    return {state:'unknown',text:verified===false?'Room not found at ETH':'Room not verified',free:[],blocks:[],message:'ETH returned no data for this room and its existence could not be confirmed, so availability is unknown.'};
  }
  const blocks=dayAllocations(entries,day);
  const free=freeIntervals(blocks);
  const booked=list=>list.some(b=>b.type===2);
  if (day===today) {
    // The timeline is displayed within 08:00–22:00; do not claim free outside that interval.
    const active=blocks.filter(b=>b.start<=now && now<b.end);
    if (active.length) {
      const until=Math.max(...active.map(b=>b.end));
      return booked(active)
        ? {state:'busy',text:`Reserved until ${displayTime(until,format)}`,free,blocks}
        : {state:'blocked',text:`Blocked until ${displayTime(until,format)}`,free,blocks};
    }
    if(now<480 || now>=1320) return {state:'unknown',text:'Outside 08–22 view',free,blocks};
    const next=blocks.find(b=>b.start>now);
    return {state:'free',text:next?`Free until ${displayTime(next.start,format)}`:'No booking now',free,blocks};
  }
  return free.length
    ? {state:'free',text:blocks.length?'Free periods available':'No bookings listed',free,blocks}
    : booked(blocks)
      ? {state:'busy',text:'Booked all day',free,blocks}
      : {state:'blocked',text:'Blocked all day',free,blocks};
}

export const FRESH_MS = 600_000;       // data younger than this is not refetched
export const MAX_STALE_MS = 3_600_000; // older data is discarded; in between it is shown while being refreshed

/** Status from a cache record: undefined -> loading, {state:'error'} -> unknown, {state:'ready'} -> describeStatus. */
export function statusFromRecord(record, {day, today, now, format='24', nowMs=Date.now()}) {
  if (!record) return {state:'loading',text:'Checking…',blocks:[],free:[]};
  if (record.state==='error') {
    return {state:'unknown',text:record.rateLimited?'Rate limited — retrying later':'Schedule unavailable',message:record.message,blocks:[],free:[]};
  }
  if (record.state!=='ready' || !Array.isArray(record.allocations)) return {state:'unknown',text:'Schedule unavailable',blocks:[],free:[]};
  const age=nowMs-record.cachedAt;
  if (!(age>=0) || age>=MAX_STALE_MS) return {state:'loading',text:'Checking…',blocks:[],free:[]};
  return {...describeStatus(record.allocations,day,today,now,format,record.roomVerified),fetchedAt:record.fetchedAt,stale:age>=FRESH_MS};
}
