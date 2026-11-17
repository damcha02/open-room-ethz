import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {weekStart,shiftDate,minutes,dayAllocations,freeIntervals,describeStatus,statusFromRecord,zurichParts,sourceAgeMs,isFreshRecord,FRESH_MS} from '../public/schedule.mjs';
process.env.ETH_MIN_INTERVAL_MS='0'; // no artificial spacing in unit tests (scheduler timing has its own tests)
import handler,{validDate,validRoom,validLocalTimestamp} from '../api/allocations.js';
import {_resetForTests} from '../lib/eth-client.js';
const sample=[
  {start:'2026-10-26T10:00:00',end:'2026-10-26T12:00:00',type:2,title:'Grundlagen der Informatik'},
  {start:'2026-10-26T18:00:00',end:'2026-10-26T19:00:00',type:2,title:'Einsatz von Informatikmitteln'},
  {start:'2026-10-26T22:00:00',end:'2026-10-26T23:59:00',type:8,title:null},
  {start:'2026-10-26T00:00:00',end:'2026-10-26T08:00:00',type:8,title:null}
];
test('weekly calendar starts Monday and handles year boundaries',()=>{
 assert.equal(weekStart('2026-10-26'),'2026-10-26');
 assert.equal(weekStart('2026-11-01'),'2026-10-26');
 assert.equal(weekStart('2027-01-01'),'2026-12-28');
 assert.equal(shiftDate('2026-12-31',1),'2027-01-01');
});
test('blocks are parsed, sorted, and free gaps are calculated',()=>{
 const daily=dayAllocations(sample,'2026-10-26');
 assert.equal(daily.length,4);
 assert.deepEqual(freeIntervals(daily),[{start:480,end:600},{start:720,end:1080},{start:1140,end:1320}]);
 assert.equal(describeStatus(sample,'2026-10-26','2026-10-26',630).state,'busy');
 assert.equal(describeStatus(sample,'2026-10-26','2026-10-26',750).state,'free');
 assert.equal(describeStatus(sample,'2026-10-26','2026-10-26',1350).state,'blocked');
});
test('overlapping intervals are merged; no phantom gaps',()=>{
 assert.deepEqual(freeIntervals([{start:480,end:700},{start:600,end:900},{start:1000,end:1080}]),[{start:900,end:1000},{start:1080,end:1320}]);
});
test('cross-midnight reservations are clipped',()=>{
 const entry={start:'2026-10-26T23:00:00',end:'2026-10-27T08:00:00',type:8};
 assert.deepEqual(dayAllocations([entry],'2026-10-27').map(({start,end})=>[start,end]),[[0,480]]);
});
test('calendar inputs are validated',()=>{
 for(const room of ['HG E 27','HCI H 2.1','CHN C 14','ETZ E 10.002'])assert.ok(validRoom(room));
 for(const room of ['/etc/passwd','HG E 27/allocations?foo=bar','HG E 27#',''])assert.ok(!validRoom(room));
 assert.equal(validDate('2026-10-26'),true);
 assert.equal(validDate('2026-02-30'),false);
 assert.equal(validDate('2026-13-01'),false);
});
test('local Zurich date available',()=>{
 const p=zurichParts(new Date('2026-10-26T11:30:00Z'));
 assert.deepEqual(p,{date:'2026-10-26',minute:750});
});
function call(query,{keep=false}={}){if(!keep)_resetForTests();return new Promise(resolve=>{
 const headers={};const req={method:'GET',query};
 const res={statusCode:null,setHeader(k,v){headers[k]=v;},end(s){resolve({status:this.statusCode,json:JSON.parse(s),headers});}};
 handler(req,res);
});}
test('proxy returns sanitized ETH JSON using requested room/date',async()=>{
 const old=global.fetch;
 let called;
 global.fetch=async(url)=>{called=String(url);return {ok:true,status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify([{
   veranstaltungsort:'364',date_from:'2026-10-26T10:00:00',date_to:'2026-10-26T12:00:00',belegungsserie:{belegungstyp:2,veranstaltung:{allocationTitle:'Grundlagen',veranstaltungsnummer:'252-0852-00',findetStatt:1}}
 }])};};
 try{const {status,json}=await call({room:'HG E 27',from:'2026-10-26',to:'2026-11-01'});assert.equal(status,200);assert.equal(json.allocations.length,1);assert.equal(json.allocations[0].title,'Grundlagen');assert.ok(called.includes('HG+E+27'));assert.equal(json.allocations[0].type,2);}
 finally{global.fetch=old;}
});
test('invalid endpoint request rejected before ETH fetch',async()=>{
 assert.equal((await call({room:'HG E 27',from:'2026-10-26',to:'2026-11-03'})).status,400);
 assert.equal((await call({room:'../../etc',from:'2026-10-26',to:'2026-11-01'})).status,400);
});
test('upstream HTML error becomes 502, never fake free',async()=>{
 const old=global.fetch;
 global.fetch=async()=>({ok:true,status:200,headers:new Headers({'content-type':'text/html'}),text:async()=>'<html />'});
 try{const result=await call({room:'HG E 27',from:'2026-10-26',to:'2026-11-01'});assert.equal(result.status,502);}finally{global.fetch=old;}
});

// ---- Stage 1: ETH API error handling, malformed data, and block semantics ----
const Q={room:'HG E 27',from:'2026-11-02',to:'2026-11-08'};
function mockEth(response){const old=global.fetch;const calls=[];global.fetch=async(url,opts)=>{calls.push({url:String(url),opts});return typeof response==='function'?response():response;};return {calls,restore(){global.fetch=old;}};}
function jsonResponse(body,init={}){return {ok:true,status:200,headers:new Headers({'content-type':'application/json;charset=utf-8'}),text:async()=>typeof body==='string'?body:JSON.stringify(body),...init};}
const rawEntry=(from,to,type,event=null)=>({veranstaltungsort:'364',date_from:from,date_to:to,belegungsserie:{belegungsserie:'1',veranstaltungsort:'364',belegungstyp:type,veranstaltung:event}});

test('real ETH response shape: types 2, 8 and 13 are all returned with intervals',async()=>{
 const m=mockEth(jsonResponse([
  rawEntry('2026-11-05T18:00:00','2026-11-05T19:00:00',2,{allocationTitle:'Einsatz von Informatikmitteln',veranstaltungsnummer:'252-0839-00',findetStatt:1}),
  rawEntry('2026-11-02T00:00:00','2026-11-02T08:00:00',8,null),
  rawEntry('2026-11-04T14:00:00','2026-11-04T16:00:00',13,{allocationTitle:'Cosmological Probes',veranstaltungsnummer:'402-0371-62',findetStatt:0})
 ]));
 try{
  const {status,json}=await call(Q);
  assert.equal(status,200);
  assert.deepEqual(json.allocations.map(a=>a.type),[2,8,13]);
  assert.deepEqual([json.allocations[1].start,json.allocations[1].end],['2026-11-02T00:00:00','2026-11-02T08:00:00']);
  assert.equal(json.allocations[2].eventIsHeld,0);
  assert.equal(m.calls.length,1);
  assert.equal(m.calls[0].opts.redirect,'manual');
  assert.equal(m.calls[0].opts.credentials,undefined);
  assert.ok(!('cookie' in (m.calls[0].opts.headers||{})));
 }finally{m.restore();}
});
test('type 8, type 13 and unknown types all block availability (even if findetStatt is 0)',()=>{
 const entries=[
  {start:'2026-11-04T09:00:00',end:'2026-11-04T10:00:00',type:8},
  {start:'2026-11-04T11:00:00',end:'2026-11-04T12:00:00',type:13,eventIsHeld:0},
  {start:'2026-11-04T13:00:00',end:'2026-11-04T14:00:00',type:99},
  {start:'2026-11-04T15:00:00',end:'2026-11-04T16:00:00',type:null}
 ];
 assert.deepEqual(freeIntervals(dayAllocations(entries,'2026-11-04')),[{start:480,end:540},{start:600,end:660},{start:720,end:780},{start:840,end:900},{start:960,end:1320}]);
 assert.equal(describeStatus(entries,'2026-11-04','2026-11-04',690).state,'blocked');
 assert.equal(describeStatus(entries,'2026-11-04','2026-11-04',810).state,'blocked');
 assert.equal(describeStatus(entries,'2026-11-04','2026-11-04',930).state,'blocked');
 assert.equal(describeStatus(entries,'2026-11-04','2026-11-04',570).state,'blocked');
});
for(const [name,response,expected] of [
 ['HTTP 500',{ok:false,status:500,headers:new Headers(),text:async()=>'err'},502],
 ['HTTP 403',{ok:false,status:403,headers:new Headers(),text:async()=>'no'},502],
 ['redirect to a login page',{ok:false,status:302,headers:new Headers({location:'https://example.org/login'}),text:async()=>''},502],
 ['HTTP 429 rate limit',{ok:false,status:429,headers:new Headers(),text:async()=>''},503],
 ['invalid JSON',jsonResponse('{not json'),502],
 ['JSON object instead of array',jsonResponse({error:'x'}),502],
 ['JSON null',jsonResponse('null'),502],
 ['oversized response',jsonResponse('[]',{headers:new Headers({'content-type':'application/json','content-length':'99999999'})}),502]
]){
 test(`upstream failure → error, never a schedule: ${name}`,async()=>{
  const m=mockEth(response);
  try{const r=await call(Q);assert.equal(r.status,expected);assert.ok(r.json.error);assert.equal(r.json.allocations,undefined);assert.equal(r.headers['Cache-Control'],'no-store');}
  finally{m.restore();}
 });
}
test('network failure and timeout → 502, no allocations',async()=>{
 for(const err of [new TypeError('fetch failed'),Object.assign(new Error('t'),{name:'TimeoutError'})]){
  const m=mockEth(()=>{throw err;});
  try{const r=await call(Q);assert.equal(r.status,502);assert.equal(r.json.allocations,undefined);}finally{m.restore();}
 }
});
for(const [name,bad] of [
 ['missing date_to',{date_from:'2026-11-02T10:00:00',belegungsserie:{belegungstyp:2}}],
 ['non-string date',{date_from:12345,date_to:'2026-11-02T11:00:00'}],
 ['unparseable date',{date_from:'yesterday',date_to:'2026-11-02T11:00:00'}],
 ['impossible date',{date_from:'2026-02-30T10:00:00',date_to:'2026-02-30T11:00:00'}],
 ['impossible time',{date_from:'2026-11-02T25:00:00',date_to:'2026-11-02T26:00:00'}],
 ['end before start',{date_from:'2026-11-02T12:00:00',date_to:'2026-11-02T11:00:00'}],
 ['null entry',null],
 ['primitive entry','booking']
]){
 test(`one malformed entry fails the whole response (not silently dropped): ${name}`,async()=>{
  const m=mockEth(jsonResponse([rawEntry('2026-11-02T10:00:00','2026-11-02T11:00:00',2),bad]));
  try{const r=await call(Q);assert.equal(r.status,502);assert.equal(r.json.allocations,undefined);}finally{m.restore();}
 });
}
test('empty array is a valid (empty) result; missing belegungsserie still yields a blocking interval',async()=>{
 let m=mockEth(jsonResponse([]));
 try{const r=await call(Q);assert.equal(r.status,200);assert.deepEqual(r.json.allocations,[]);}finally{m.restore();}
 m=mockEth(jsonResponse([{date_from:'2026-11-02T10:00:00',date_to:'2026-11-02T11:00:00'}]));
 try{const r=await call(Q);assert.equal(r.status,200);assert.equal(r.json.allocations.length,1);assert.equal(r.json.allocations[0].type,null);}finally{m.restore();}
});
test('validLocalTimestamp accepts ETH format only',()=>{
 for(const ok of ['2026-11-02T10:00:00','2026-11-02T23:59:00','2026-11-02T10:00'])assert.ok(validLocalTimestamp(ok));
 for(const bad of ['2026-11-02','2026-11-02T10:00:00Z','2026-11-02T24:00:00','',null,undefined,5])assert.ok(!validLocalTimestamp(bad));
});

test('static server serves ES modules with a JavaScript MIME type (browsers reject octet-stream modules)',async()=>{
 const {spawn}=await import('node:child_process');
 const port=39000+Math.floor(Math.random()*500);
 const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','ignore']});
 try{
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);setTimeout(()=>reject(new Error('server did not start')),5000);});
  for(const file of ['/app.js','/schedule.mjs']){
   const r=await fetch(`http://localhost:${port}${file}`);
   assert.equal(r.status,200);
   assert.match(r.headers.get('content-type'),/^text\/javascript/);
  }
 }finally{child.kill();}
});

// ---- Stage 2: server cache, de-duplication, scheduling, rate limits, room verification ----
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const withEnv=async(vars,fn)=>{const old={};for(const k of Object.keys(vars)){old[k]=process.env[k];process.env[k]=vars[k];}try{await fn();}finally{for(const k of Object.keys(vars)){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}}};
const ROOM_INFO=name=>({id:name,nameWithoutLeadingZeros:name,building:'HG'});
const jsonRes=(body,headers={})=>({ok:true,status:200,headers:new Headers({'content-type':'application/json;charset=utf-8',...headers}),text:async()=>JSON.stringify(body)});
const htmlRes=()=>({ok:true,status:200,headers:new Headers({'content-type':'text/html;charset=utf-8'}),text:async()=>'<!DOCTYPE html><html></html>'});
const errRes=(status,headers={})=>({ok:false,status,headers:new Headers(headers),text:async()=>''});
/** Router mock: allocations and room-details requests get separate handlers; records every call with a timestamp. */
function mockRouter({alloc,info}){
 const old=global.fetch;const calls=[];
 global.fetch=async(url)=>{const u=new URL(String(url));const path=u.searchParams.get('path');const kind=path.startsWith('/v2/rooms/')?'info':'alloc';
  calls.push({kind,room:path.replace('/v2','').split('/')[2],from:u.searchParams.get('from'),at:Date.now()});
  const h=kind==='info'?info:alloc;return typeof h==='function'?h(calls.at(-1)):h;};
 return {calls,restore(){global.fetch=old;}};
}
const booking=[rawEntry('2026-11-05T18:00:00','2026-11-05T19:00:00',2,{allocationTitle:'X',veranstaltungsnummer:'1',findetStatt:1})];

test('cache: a repeated room/week is served from cache without a new ETH request',async()=>{
 const m=mockRouter({alloc:()=>jsonRes(booking)});
 try{
  const a=await call(Q);const b=await call(Q,{keep:true});
  assert.equal(a.json.cached,false);assert.equal(b.json.cached,true);
  assert.equal(m.calls.length,1);
  assert.equal(b.json.fetchedAt,a.json.fetchedAt);
  assert.match(b.headers['Cache-Control'],/s-maxage=300/); // default server TTL 5 min (< the 10 min freshness limit)
  assert.match(b.headers['Cache-Control'],/max-age=0/);    // browsers never reuse a response on their own
  await call({...Q,to:'2026-11-07'},{keep:true}); // different window = different key
  assert.equal(m.calls.length,2);
 }finally{m.restore();}
});
test('cache: TTL is configurable and expired entries are refetched',async()=>{
 await withEnv({ETH_CACHE_TTL_MS:'40'},async()=>{
  const m=mockRouter({alloc:()=>jsonRes(booking)});
  try{await call(Q);await wait(70);const r=await call(Q,{keep:true});assert.equal(r.json.cached,false);assert.equal(m.calls.length,2);}finally{m.restore();}
 });
});
test('cache: errors are never cached; the next request retries ETH',async()=>{
 let n=0;const m=mockRouter({alloc:()=>++n===1?errRes(500):jsonRes(booking)});
 try{const a=await call(Q);assert.equal(a.status,502);const b=await call(Q,{keep:true});assert.equal(b.status,200);assert.equal(b.json.allocations.length,1);assert.equal(m.calls.length,2);}finally{m.restore();}
});
test('dedupe: identical concurrent requests share one ETH request',async()=>{
 const m=mockRouter({alloc:async()=>{await wait(30);return jsonRes(booking);}});
 try{
  const rs=await Promise.all([call(Q),call(Q,{keep:true}),call(Q,{keep:true})]);
  assert.deepEqual(rs.map(r=>r.status),[200,200,200]);
  assert.equal(m.calls.length,1);
 }finally{m.restore();}
});
test('dedupe: a failed shared request fails every waiter and is not cached',async()=>{
 const m=mockRouter({alloc:async()=>{await wait(20);return errRes(500);}});
 try{const rs=await Promise.all([call(Q),call(Q,{keep:true})]);assert.deepEqual(rs.map(r=>r.status),[502,502]);assert.equal(m.calls.length,1);}finally{m.restore();}
});
test('scheduler: different rooms are spaced out instead of sent as a burst',async()=>{
 await withEnv({ETH_MIN_INTERVAL_MS:'60'},async()=>{
  const m=mockRouter({alloc:()=>jsonRes(booking)});
  try{
   await Promise.all(['HG E 27','CHN C 14','HCI D 2','HG E 21'].map((room,i)=>call({...Q,room},{keep:i>0})));
   const gaps=m.calls.slice(1).map((c,i)=>c.at-m.calls[i].at);
   assert.equal(m.calls.length,4);
   for(const g of gaps)assert.ok(g>=50,`gap ${g}ms should be ≥ ~60ms`);
  }finally{m.restore();}
 });
});
test('scheduler: queue wait is capped; excess requests are refused with Retry-After instead of piling up',async()=>{
 await withEnv({ETH_MIN_INTERVAL_MS:'100',ETH_MAX_QUEUE_WAIT_MS:'150'},async()=>{
  const m=mockRouter({alloc:()=>jsonRes(booking)});
  try{
   const rooms=['HG E 27','CHN C 14','HCI D 2','HG E 21','HG E 22','HG E 23'];
   const rs=await Promise.all(rooms.map((room,i)=>call({...Q,room},{keep:i>0})));
   const busy=rs.filter(r=>r.status===503);
   assert.ok(busy.length>=3,'later requests must be refused');
   assert.ok(busy.every(r=>r.json.code==='busy'&&Number(r.headers['Retry-After'])>=1));
   assert.equal(m.calls.length,rs.filter(r=>r.status===200).length);
  }finally{m.restore();}
 });
});
test('rate limit: 429 with Retry-After → 503 + Retry-After, then no ETH requests during the cooldown',async()=>{
 const m=mockRouter({alloc:()=>errRes(429,{'retry-after':'7'})});
 try{
  const a=await call(Q);
  assert.equal(a.status,503);assert.equal(a.json.code,'rate_limited');assert.equal(a.headers['Retry-After'],'7');assert.equal(a.headers['Cache-Control'],'no-store');
  const b=await call({...Q,room:'CHN C 14'},{keep:true});
  assert.equal(b.status,503);assert.equal(m.calls.length,1,'cooldown must prevent any further upstream call');
  assert.ok(Number(b.headers['Retry-After'])>=1&&Number(b.headers['Retry-After'])<=7);
 }finally{m.restore();}
});
test('rate limit: 429 without Retry-After uses a default cooldown and backs off exponentially',async()=>{
 await withEnv({ETH_DEFAULT_COOLDOWN_MS:'60',ETH_MAX_COOLDOWN_MS:'10000'},async()=>{
  const m=mockRouter({alloc:()=>errRes(429)});
  try{
   const a=await call(Q);assert.equal(a.status,503);
   await wait(80);                                   // first cooldown (60 ms) over
   const b=await call(Q,{keep:true});assert.equal(b.status,503);assert.equal(m.calls.length,2);
   await wait(80);                                   // second cooldown is 120 ms: still blocked
   const c=await call(Q,{keep:true});assert.equal(c.status,503);assert.equal(m.calls.length,2,'second strike doubles the cooldown');
  }finally{m.restore();}
 });
});
test('rate limit: Retry-After as an HTTP date is honoured',async()=>{
 const m=mockRouter({alloc:()=>errRes(429,{'retry-after':new Date(Date.now()+30_000).toUTCString()})});
 try{const a=await call(Q);assert.equal(a.status,503);const s=Number(a.headers['Retry-After']);assert.ok(s>=25&&s<=31);}finally{m.restore();}
});
test('rate limit: x-ratelimit-remaining 0 starts a cooldown; low remaining slows the next request',async()=>{
 const m=mockRouter({alloc:()=>jsonRes(booking,{'x-ratelimit-remaining':'0'})});
 try{const a=await call(Q);assert.equal(a.status,200);const b=await call({...Q,room:'CHN C 14'},{keep:true});assert.equal(b.status,503);assert.equal(m.calls.length,1);}finally{m.restore();}
 await withEnv({ETH_LOW_REMAINING:'5',ETH_LOW_INTERVAL_MS:'80'},async()=>{
  const m2=mockRouter({alloc:()=>jsonRes(booking,{'x-ratelimit-remaining':'3'})});
  try{await call(Q);await call({...Q,room:'CHN C 14'},{keep:true});assert.ok(m2.calls[1].at-m2.calls[0].at>=70);}finally{m2.restore();}
 });
});
test('rate limit: nothing is sent when the cooldown starts while a request is still waiting for its slot',async()=>{
 await withEnv({ETH_MIN_INTERVAL_MS:'60'},async()=>{
  const m=mockRouter({alloc:()=>errRes(429,{'retry-after':'5'})});
  try{const rs=await Promise.all([call(Q),call({...Q,room:'CHN C 14'},{keep:true}),call({...Q,room:'HCI D 2'},{keep:true})]);
   assert.deepEqual(rs.map(r=>r.status),[503,503,503]);assert.equal(m.calls.length,1);}finally{m.restore();}
 });
});
test('rooms: a non-empty answer proves the room exists and costs no extra request',async()=>{
 const m=mockRouter({alloc:()=>jsonRes(booking)});
 try{const r=await call(Q);assert.equal(r.json.roomVerified,true);assert.equal(m.calls.filter(c=>c.kind==='info').length,0);}finally{m.restore();}
});
test('rooms: 200 [] for an existing room is verified via ETH room details',async()=>{
 const m=mockRouter({alloc:()=>jsonRes([]),info:()=>jsonRes(ROOM_INFO('HG E 27'))});
 try{
  const r=await call(Q);assert.equal(r.status,200);assert.deepEqual(r.json.allocations,[]);assert.equal(r.json.roomVerified,true);
  assert.match(r.headers['Cache-Control'],/s-maxage/);
  const r2=await call({...Q,from:'2026-11-09',to:'2026-11-15'},{keep:true}); // other week: details answer is cached
  assert.equal(r2.json.roomVerified,true);assert.equal(m.calls.filter(c=>c.kind==='info').length,1);
 }finally{m.restore();}
});
test('rooms: 200 [] plus an HTML "not found" page → roomVerified=false, never shareable/cached downstream',async()=>{
 const m=mockRouter({alloc:()=>jsonRes([]),info:()=>htmlRes()});
 try{const r=await call({...Q,room:'ZZZ Z 9999'});assert.equal(r.status,200);assert.deepEqual(r.json.allocations,[]);assert.equal(r.json.roomVerified,false);assert.equal(r.headers['Cache-Control'],'no-store');}finally{m.restore();}
});
test('rooms: JSON details for a different room does not verify',async()=>{
 const m=mockRouter({alloc:()=>jsonRes([]),info:()=>jsonRes(ROOM_INFO('HG E 99'))});
 try{assert.equal((await call(Q)).json.roomVerified,false);}finally{m.restore();}
});
for(const [name,info] of [['details HTTP 500',()=>errRes(500)],['details rate limited',()=>errRes(429)],['details invalid JSON',()=>({ok:true,status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>'{oops'})],['details network error',()=>{throw new TypeError('fetch failed');}]]){
 test(`rooms: empty result with failed room check → roomVerified=null (unknown), not cached long: ${name}`,async()=>{
  const m=mockRouter({alloc:()=>jsonRes([]),info});
  try{const r=await call(Q);assert.equal(r.status,200);assert.equal(r.json.roomVerified,null);assert.equal(r.headers['Cache-Control'],'no-store');}finally{m.restore();}
 });
}
test('rooms: an invalid room code is rejected before any ETH request',async()=>{
 const m=mockRouter({alloc:()=>jsonRes([])});
 try{for(const room of ['zzz','HG E 27/../x','HG','']){assert.equal((await call({...Q,room})).status,400);}assert.equal(m.calls.length,0);}finally{m.restore();}
});

// ---- Stage 2: frontend status model (pure functions shared with public/app.js) ----
const DAY='2026-11-04';
const ctx={day:DAY,today:DAY,now:690,nowMs:1_000_000};
const rec=(over={})=>{const {cachedAt,...rest}=over;const r={state:'ready',allocations:[],roomVerified:true,fetchedAt:'x',receivedAt:ctx.nowMs,ageAtReceiptMs:1000,...rest};
 if('cachedAt' in over){if(cachedAt===undefined){delete r.ageAtReceiptMs;delete r.receivedAt;}else if(cachedAt>ctx.nowMs){r.receivedAt=cachedAt;r.ageAtReceiptMs=0;}else r.ageAtReceiptMs=ctx.nowMs-cachedAt;}return r;};
test('status: no record → loading; it is never free',()=>{const s=statusFromRecord(undefined,ctx);assert.equal(s.state,'loading');assert.equal(s.free.length,0);});
test('status: request errors are unknown/unavailable, never free (also when rate limited)',()=>{
 for(const r of [{state:'error',message:'x'},{state:'error',rateLimited:true},{state:'error'},{state:'weird'},{state:'ready',allocations:null,cachedAt:ctx.nowMs}]){
  const s=statusFromRecord(r,ctx);assert.equal(s.state,'unknown');assert.deepEqual(s.free,[]);assert.notEqual(s.state,'free');
 }
 assert.match(statusFromRecord({state:'error',rateLimited:true},ctx).text,/Rate limited/);
});
test('status: empty ETH result for an unverified room is unknown, for a verified room it is free',()=>{
 for(const v of [false,null,undefined]){const s=statusFromRecord(rec({roomVerified:v}),ctx);assert.equal(s.state,'unknown');assert.deepEqual(s.free,[]);}
 assert.equal(statusFromRecord(rec({roomVerified:false}),ctx).text,'Room not found at ETH');
 assert.equal(statusFromRecord(rec({roomVerified:true}),ctx).state,'free');
 assert.equal(describeStatus([],'2026-11-05',DAY,690,'24',false).state,'unknown'); // other days too
});
test('status: booked (type 2) vs blocked (type 8 / 13 / unknown) vs free',()=>{
 const at=(type,v)=>describeStatus([{start:`${DAY}T10:00:00`,end:`${DAY}T12:00:00`,type}],DAY,DAY,v??630);
 assert.equal(at(2).state,'busy');assert.match(at(2).text,/^Booked until 12:00/);
 for(const t of [8,13,99,null]){assert.equal(at(t).state,'blocked');assert.match(at(t).text,/^Blocked until 12:00/);}
 assert.equal(at(2,780).state,'free');
 const allDay=[{start:`${DAY}T00:00:00`,end:`${DAY}T23:59:00`,type:8}];
 assert.deepEqual([describeStatus(allDay,DAY,'2026-11-05',0).state,describeStatus(allDay,DAY,'2026-11-05',0).text],['blocked','Blocked all day']);
 assert.equal(describeStatus([{...allDay[0],type:2}],DAY,'2026-11-05',0).state,'busy');
});
test('status: cached data is shown while stale and discarded when too old',()=>{
 assert.equal(statusFromRecord(rec({cachedAt:ctx.nowMs-30_000}),ctx).stale,false);
 const stale=statusFromRecord(rec({cachedAt:ctx.nowMs-700_000}),ctx);assert.equal(stale.state,'free');assert.equal(stale.stale,true);
 assert.equal(statusFromRecord(rec({cachedAt:ctx.nowMs-4_000_000}),ctx).state,'loading');
 assert.equal(statusFromRecord(rec({cachedAt:ctx.nowMs+5_000}),ctx).state,'loading'); // clock skew: do not trust
});

// ---- Stage 3A.1: end-to-end freshness (the age of the ORIGINAL ETH answer survives every cache) ----
test('freshness (server): every response reports ageMs of the original ETH fetch; the server cache never resets it',async()=>{
 await withEnv({ETH_CACHE_TTL_MS:'3600000'},async()=>{
  mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-18T09:00:00Z')});
  const m=mockRouter({alloc:()=>jsonRes(booking)});
  try{
   const first=await call(Q);
   assert.equal(first.json.cached,false);assert.equal(first.json.ageMs,0);
   assert.equal(first.json.fetchedAt,'2026-11-18T09:00:00.000Z');
   mock.timers.tick(9*60_000);
   const second=await call(Q,{keep:true});
   assert.equal(second.json.cached,true);
   assert.equal(second.json.fetchedAt,first.json.fetchedAt,'the original fetch time is kept');
   assert.equal(second.json.ageMs,9*60_000);
   mock.timers.tick(3*60_000); // the server may still hold it (TTL 1 h) but it is now older than the freshness limit
   const third=await call(Q,{keep:true});
   assert.equal(third.json.ageMs,12*60_000);
   assert.ok(third.json.ageMs>FRESH_MS,'an old response is reported as old');
   assert.equal(m.calls.length,1);
  }finally{m.restore();mock.timers.reset();}
 });
});
test('freshness (server): the default TTL keeps cached answers younger than the browser freshness limit',async()=>{
 mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-18T09:00:00Z')});
 const m=mockRouter({alloc:()=>jsonRes(booking)});
 try{
  await call(Q);
  mock.timers.tick(299_000);assert.equal((await call(Q,{keep:true})).json.cached,true);
  mock.timers.tick(2_000);   const after=await call(Q,{keep:true});
  assert.equal(after.json.cached,false,'expired at 5 minutes: ETH is asked again');assert.equal(after.json.ageMs,0);assert.equal(m.calls.length,2);
 }finally{m.restore();mock.timers.reset();}
});
test('freshness (server): a room-existence answer never makes an empty schedule look newer',async()=>{
 mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-18T09:00:00Z')});
 const m=mockRouter({alloc:()=>jsonRes([]),info:()=>jsonRes(ROOM_INFO('HG E 27'))});
 try{
  const a=await call(Q);mock.timers.tick(120_000);const b=await call(Q,{keep:true});
  assert.equal(a.json.fetchedAt,b.json.fetchedAt);assert.equal(b.json.ageMs,120_000);
 }finally{m.restore();mock.timers.reset();}
});

test('freshness (browser): source age = age when received + local time since; re-caching never resets it',()=>{
 const t0=1_000_000;
 const record={state:'ready',allocations:[],roomVerified:true,receivedAt:t0,ageAtReceiptMs:4*60_000};
 assert.equal(sourceAgeMs(record,t0),4*60_000);
 assert.equal(sourceAgeMs(record,t0+3*60_000),7*60_000);
 assert.equal(isFreshRecord(record,t0+5*60_000),true);
 assert.equal(isFreshRecord(record,t0+6*60_000),false,'4 min old at receipt + 6 min locally = 10 min');
 assert.equal(isFreshRecord(record,t0+6*60_000-1),true);
 assert.equal(isFreshRecord(record,t0+4*60_000,3*60_000),false,'look-ahead refresh window');
});
test('freshness (browser): an OLD ETH response served from a RECENTLY populated browser cache is not current',()=>{
 const now=5_000_000;
 const old={state:'ready',allocations:[],roomVerified:true,fetchedAt:'2026-11-18T08:48:00.000Z',receivedAt:now-1000,ageAtReceiptMs:12*60_000}; // received 1 s ago, but ETH answered 12 min ago
 const st=statusFromRecord(old,{day:'2026-11-18',today:'2026-11-18',now:600,nowMs:now});
 assert.equal(st.stale,true);assert.equal(st.state,'free');assert.ok(st.ageMs>=12*60_000);
 assert.equal(isFreshRecord(old,now),false);
 // the same record seconds before the limit is still current
 assert.equal(statusFromRecord({...old,ageAtReceiptMs:9*60_000},{day:'2026-11-18',today:'2026-11-18',now:600,nowMs:now}).stale,false);
});
test('freshness (browser): records without a usable age, or with a moved clock, are never fresh',()=>{
 const now=5_000_000;
 const base={state:'ready',allocations:[],roomVerified:true};
 for(const record of [{...base},{...base,receivedAt:now},{...base,ageAtReceiptMs:0},{...base,receivedAt:now,ageAtReceiptMs:-5},{...base,receivedAt:now+60_000,ageAtReceiptMs:0},{...base,receivedAt:'x',ageAtReceiptMs:0},{...base,cachedAt:now}]){
  assert.equal(isFreshRecord(record,now),false,JSON.stringify(record));
  assert.notEqual(statusFromRecord(record,{day:'2026-11-18',today:'2026-11-18',now:600,nowMs:now}).stale,false);
 }
 assert.equal(isFreshRecord({...base,state:'error',receivedAt:now,ageAtReceiptMs:0},now),false);
});
test('freshness (browser): data older than one hour is discarded, between 10 and 60 minutes it is shown as stale',()=>{
 const now=9_000_000;const at=age=>({state:'ready',allocations:[],roomVerified:true,receivedAt:now,ageAtReceiptMs:age});
 const c={day:'2026-11-18',today:'2026-11-18',now:600,nowMs:now};
 assert.equal(statusFromRecord(at(30*60_000),c).stale,true);
 assert.equal(statusFromRecord(at(61*60_000),c).state,'loading');
});

// ---- Stage 3A.1: wording ----
test('wording: Free / Booked / Blocked are distinct, and "Reserved"/"Unbooked" are gone from statuses',()=>{
 const D='2026-11-04';
 const one=(type,at)=>describeStatus([{start:`${D}T10:00:00`,end:`${D}T12:00:00`,type}],D,D,at,'24',true);
 assert.match(one(2,630).text,/^Booked until 12:00$/);
 assert.match(one(8,630).text,/^Blocked until 12:00$/);
 assert.match(one(2,540).text,/^Free until 10:00$/);
 for(const text of [one(2,630).text,one(8,630).text,one(2,540).text,statusFromRecord(undefined,{day:D,today:D,now:600}).text,statusFromRecord({state:'error'},{day:D,today:D,now:600}).text])assert.doesNotMatch(text,/Unbooked|Reserved/i);
});
