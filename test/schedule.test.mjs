import test from 'node:test';
import assert from 'node:assert/strict';
import {weekStart,shiftDate,minutes,dayAllocations,freeIntervals,describeStatus,zurichParts} from '../public/schedule.mjs';
import handler,{validDate,validRoom} from '../api/allocations.js';
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
function call(query){return new Promise(resolve=>{
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
