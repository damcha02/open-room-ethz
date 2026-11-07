import {zurichParts,shiftDate,weekStart,dayAllocations,freeIntervals,displayTime,describeStatus} from './schedule.mjs';

const $=id=>document.getElementById(id);
const STORAGE_KEY='openroom-prefs-v1';
const preferences=(()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}catch{return {}}})();
const state={
  campus: 'Zentrum',
  day: zurichParts().date,
  search:'',
  freeOnly:Boolean(preferences.freeOnly),
  favorites:new Set(Array.isArray(preferences.favorites)?preferences.favorites:[]),
  extraRooms:Array.isArray(preferences.extraRooms)?preferences.extraRooms:[],
  timeFormat:preferences.timeFormat==='12'?'12':'24',
  rooms:[],
  expandedBuildings:new Set(),
  expandedRooms:new Set(),
  cache:new Map(),
  inflight:new Map(),
  loadingCatalog:true,
  catalogError:false
};
const fetchQueue=[];
let running=0;
const MAX_SIMULTANEOUS=3;
function store() {localStorage.setItem(STORAGE_KEY,JSON.stringify({freeOnly:state.freeOnly,favorites:[...state.favorites],extraRooms:state.extraRooms,timeFormat:state.timeFormat}));}
function html(s) {return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function escapeAttr(s){return html(s);}
function enqueue(work) {return new Promise((resolve,reject)=>{fetchQueue.push({work,resolve,reject});flushQueue();});}
function flushQueue() {while(running<MAX_SIMULTANEOUS && fetchQueue.length){const task=fetchQueue.shift();running++;Promise.resolve().then(task.work).then(task.resolve,task.reject).finally(()=>{running--;flushQueue();});}}
function cacheKey(room,day=state.day){return `${room}|${weekStart(day)}`;}
function isFresh(record){return record && record.state==='ready' && Date.now()-record.cachedAt < 300_000;}
function allRooms(){const map=new Map(state.rooms.map(r=>[r.code,r]));for(const r of state.extraRooms){if(r?.code && r?.building && r?.campus && !map.has(r.code))map.set(r.code,r);}return [...map.values()].sort((a,b)=>a.building.localeCompare(b.building)||a.code.localeCompare(b.code,undefined,{numeric:true}));}
function weekBounds(day){const first=weekStart(day);return [first,shiftDate(first,6)];}
async function ensureSchedule(code,day=state.day,force=false){
  const key=cacheKey(code,day);
  if(!force&&isFresh(state.cache.get(key)))return state.cache.get(key);
  if(state.inflight.has(key))return state.inflight.get(key);
  const [from,to]=weekBounds(day);
  const promise=enqueue(async()=>{
    try{
      const params=new URLSearchParams({room:code,from,to});
      const response=await fetch(`/api/allocations?${params}`,{headers:{Accept:'application/json'},cache:'default'});
      const json=await response.json();
      if(!response.ok)throw new Error(json.error||`API HTTP ${response.status}`);
      if(!Array.isArray(json.allocations))throw new Error('Unexpected API response');
      const data={state:'ready',allocations:json.allocations,fetchedAt:json.fetchedAt,cachedAt:Date.now()};
      state.cache.set(key,data);return data;
    } catch(error){const data={state:'error',message:error.message||'Failed to retrieve schedule'};state.cache.set(key,data);return data;}
  });
  state.inflight.set(key,promise);
  promise.finally(()=>{state.inflight.delete(key);renderResults();});
  return promise;
}
function scheduleLoad(codes,day=state.day){for(const code of codes){const key=cacheKey(code,day);if(!isFresh(state.cache.get(key))&&!state.inflight.has(key))void ensureSchedule(code,day);}}
function getStatus(code){const key=cacheKey(code);const record=state.cache.get(key);if(!record || (!isFresh(record) && record.state==='ready'))return {state:'loading',text:'Checking…',blocks:[],free:[]};if(record.state==='error')return {state:'unknown',text:'Schedule unavailable',message:record.message,blocks:[],free:[]};const now=zurichParts();return {...describeStatus(record.allocations,state.day,now.date,now.minute,state.timeFormat),fetchedAt:record.fetchedAt};}
function isVisibleRoom(r){if(state.campus==='Favorites')return state.favorites.has(r.code);return r.campus===state.campus;}
function matchingRooms(){const search=state.search.toUpperCase().trim();return allRooms().filter(r=>isVisibleRoom(r)&&(!search||`${r.code} ${r.building}`.includes(search)));}
function visibleByFilter(r){if(state.campus==='Favorites'||!state.freeOnly)return true;const status=getStatus(r.code);return status.state==='free';}
function weekdayIndex(ymd){return (new Date(`${ymd}T12:00:00Z`).getUTCDay()+6)%7;}
function labelDay(day,options){const d=new Date(day+'T12:00:00Z');return new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',...options}).format(d);}
function setDay(day){state.day=day;renderDateStrip();renderResults();loadCurrentVisible();}
function renderDateStrip(){
  const [start,end]=weekBounds(state.day);
  const a=labelDay(start,{day:'numeric',month:'short'}),b=labelDay(end,{day:'numeric',month:'short',year:'numeric'});
  $('week-label').textContent=`${a} – ${b}`;
  $('day-strip').innerHTML=Array.from({length:7},(_,idx)=>{const day=shiftDate(start,idx);const today=day===zurichParts().date;return `<button type="button" class="day-btn ${state.day===day?'selected':''} ${today?'today':''}" data-day="${day}" aria-pressed="${day===state.day}"><span class="day-name">${labelDay(day,{weekday:'short'})}</span><span class="day-number">${Number(day.slice(-2))}</span></button>`;}).join('');
  const now=zurichParts();$('time-caption').textContent=state.day===now.date?`Zurich · ${displayTime(now.minute,state.timeFormat)}`:`${labelDay(state.day,{weekday:'long',day:'numeric',month:'short'})}`;
}
function statusHtml(s){const classes={free:'status-free',busy:'status-busy',blocked:'status-blocked',unknown:'status-unknown',loading:'status-unknown'};return `<div class="room-status ${classes[s.state]||'status-unknown'}"><span class="status-dot"></span><span class="status-text">${html(s.text)}</span></div>`;}
function roomHtml(r){const s=getStatus(r.code);const saved=state.favorites.has(r.code);const open=state.expandedRooms.has(r.code);return `<div class="room-entry"><div class="room-row"><button class="room-main" type="button" data-open-room="${escapeAttr(r.code)}" aria-expanded="${open}"><div><div class="room-code">${html(r.code)}</div><div class="room-hint">${open?'Hide timetable':'View timetable'} ${open?'↑':'→'}</div></div>${statusHtml(s)}</button><button class="favorite-btn ${saved?'saved':''}" type="button" data-favorite="${escapeAttr(r.code)}" aria-label="${saved?'Remove':'Add'} ${escapeAttr(r.code)} ${saved?'from':'to'} favorites" title="${saved?'Remove from favorites':'Add to favorites'}">${saved?'★':'☆'}</button></div>${open?detailHtml(r,s):''}</div>`;}
function detailHtml(r,s){
  const viewFrom=480,viewTo=1320;
  let timeline='';
  let freeText='';
  let bookings='';
  if(s.state==='unknown'||s.state==='loading'){
    timeline=`<div class="empty-card">${s.state==='loading'?'Loading timetable…':'Could not read ETH reservations. Availability is unknown.'}${s.message?`<br><small>${html(s.message)}</small>`:''}</div>`;
  }else{
    const colors=s.blocks.map(b=>{
      const start=Math.max(viewFrom,b.start),end=Math.min(viewTo,b.end);
      if(end<=start)return '';
      return `<span class="timeline-segment ${b.type===8?'restricted':''}" style="left:${100*(start-viewFrom)/(viewTo-viewFrom)}%;width:${100*(end-start)/(viewTo-viewFrom)}%" title="${escapeAttr(b.title||'Blocked interval')}"></span>`;
    }).join('');
    timeline=`<div class="detail-small-title">Daily overview (08:00–22:00)</div><div class="timeline-wrap"><div class="timeline-bar" aria-label="Green indicates unreserved intervals, salmon indicates bookings, amber indicates block entries">${colors}</div><div class="timeline-labels"><span>08</span><span>12</span><span>16</span><span>20</span><span>22</span></div></div>`;
    freeText=`<div class="detail-small-title">Unreserved intervals</div><div class="free-windows">${s.free.length?s.free.map(i=>`${displayTime(i.start,state.timeFormat)}–${displayTime(i.end,state.timeFormat)}`).join(' · '):'None in displayed hours'}</div>`;
    bookings=`<div class="detail-small-title">Reservations and blocks</div><div class="slot-list">${s.blocks.length?s.blocks.map(b=>`<div class="slot"><span class="slot-time">${displayTime(b.start,state.timeFormat)}–${displayTime(b.end,state.timeFormat)}</span><span class="slot-title">${html(b.title|| (b.type===8?'Blocked interval (type 8)':'Reservation / restriction'))}</span></div>`).join(''):'<span class="slot-title">No published entries for this date.</span>'}</div>`;
  }
  const [from,to]=weekBounds(state.day);
  const ethUrl=new URL('https://ethz.ch/staffnet/de/service/raeume-gebaeude/rauminfo/raumdetails/allocation.html');ethUrl.searchParams.set('room',r.code);ethUrl.searchParams.set('from',from);ethUrl.searchParams.set('to',to);
  return `<div class="room-details">${timeline}${freeText}${bookings}<div class="room-details-bottom"><a class="source-link" href="${escapeAttr(ethUrl.toString())}" target="_blank" rel="noopener noreferrer">View official Belegungsplan ↗</a><span class="detail-caveat">Schedule ≠ occupancy</span></div></div>`;
}
function renderResults(){
  if(state.loadingCatalog){$('room-results').innerHTML='<div class="empty-card">Loading room catalog…</div>';return;}
  if(state.catalogError){$('room-results').innerHTML='<div class="empty-card">Could not load room catalog. Refresh to try again.</div>';return;}
  const rooms=matchingRooms();
  $('list-heading').textContent=state.campus==='Favorites'?'Favorite rooms':'Buildings';
  $('favorites-sub').textContent=`${state.favorites.size} saved room${state.favorites.size===1?'':'s'}`;
  $('list-caption').textContent=state.campus==='Favorites'?'Favorites are shown regardless of the free-only filter':`${new Set(rooms.map(r=>r.building)).size} buildings · ${rooms.length} rooms in catalog`;
  if(!rooms.length){$('room-results').innerHTML=`<div class="empty-card"><div class="empty-symbol">${state.campus==='Favorites'?'☆':'⌕'}</div>${state.campus==='Favorites'?'No favorites yet. Use the star beside any room to save it.':'No rooms match your search.'}</div>`;return;}
  const groups=new Map();for(const room of rooms){if(!groups.has(room.building))groups.set(room.building,[]);groups.get(room.building).push(room);}
  const content=[...groups].map(([building,list])=>{
    const open=state.campus==='Favorites'?!state.expandedBuildings.has('!closed:'+building):state.expandedBuildings.has(building);
    const shown=list.filter(visibleByFilter),pending=list.filter(r=>!isFresh(state.cache.get(cacheKey(r.code))) && !state.cache.has(cacheKey(r.code)));
    const meta=state.campus==='Favorites'?`${list.length} favorite room${list.length>1?'s':''}`:`${list.length} room${list.length>1?'s':''}`;
    const pill=state.freeOnly && state.campus!=='Favorites' && open?`${shown.length} free`:`${list.length} rooms`;
    const body=shown.map(roomHtml).join('')+((state.freeOnly && state.campus!=='Favorites'&&pending.length>0)?`<div class="empty-card" style="border:0;border-top:1px solid var(--line);border-radius:0;padding:12px">Checking ${pending.length} more room${pending.length===1?'':'s'}…</div>`:'');
    const emptyBody=state.freeOnly && !pending.length && !shown.length?'<div class="empty-card" style="border:0;border-radius:0">No rooms confirmed free in this building for the selected time.</div>':'';
    return `<article class="building-card ${open?'open':''}"><button type="button" class="building-head" data-building="${html(building)}" aria-expanded="${open}"><span class="building-avatar">${html(building)}</span><span><span class="building-title">${html(building)}</span><span class="building-meta" style="display:block">${meta}</span></span><span class="building-right"><span class="count-pill">${pill}</span><span class="chevron">›</span></span></button>${open?`<div class="building-rooms">${body||emptyBody}</div>`:''}</article>`;
  }).join('');
  $('room-results').innerHTML=content;
}
function loadCurrentVisible(){if(state.loadingCatalog)return;const grouped=matchingRooms();const openCodes=grouped.filter(r=>state.campus==='Favorites'||state.expandedBuildings.has(r.building)).map(r=>r.code);scheduleLoad(openCodes);}
function switchCampus(next){state.campus=next;document.querySelectorAll('.campus-tab').forEach(b=>{b.classList.toggle('selected',b.dataset.campus===next);b.setAttribute('aria-pressed',String(b.dataset.campus===next));});renderResults();loadCurrentVisible();}

$('day-strip').addEventListener('click',e=>{const b=e.target.closest('[data-day]');if(b)setDay(b.dataset.day);});
$('prev-week').addEventListener('click',()=>setDay(shiftDate(state.day,-7)));
$('next-week').addEventListener('click',()=>setDay(shiftDate(state.day,7)));
$('today-btn').addEventListener('click',()=>setDay(zurichParts().date));
$('room-search').addEventListener('input',e=>{state.search=e.target.value;renderResults();loadCurrentVisible();});
$('free-only').addEventListener('change',e=>{state.freeOnly=e.target.checked;$('settings-free-only').checked=state.freeOnly;store();renderResults();});
document.querySelectorAll('.campus-tab').forEach(b=>b.addEventListener('click',()=>switchCampus(b.dataset.campus)));
$('room-results').addEventListener('click',e=>{
  const fav=e.target.closest('[data-favorite]');if(fav){const code=fav.dataset.favorite;if(state.favorites.has(code))state.favorites.delete(code);else state.favorites.add(code);store();renderResults();return;}
  const room=e.target.closest('[data-open-room]');if(room){const code=room.dataset.openRoom;if(state.expandedRooms.has(code))state.expandedRooms.delete(code);else state.expandedRooms.add(code);renderResults();return;}
  const building=e.target.closest('[data-building]');if(building){const code=building.dataset.building;if(state.campus==='Favorites'){const closed='!closed:'+code;if(state.expandedBuildings.has(closed))state.expandedBuildings.delete(closed);else state.expandedBuildings.add(closed);}else if(state.expandedBuildings.has(code))state.expandedBuildings.delete(code);else state.expandedBuildings.add(code);renderResults();loadCurrentVisible();}
});
$('refresh-btn').addEventListener('click',()=>{
  const all=matchingRooms().filter(r=>state.campus==='Favorites'||state.expandedBuildings.has(r.building));
  for(const r of all)state.cache.delete(cacheKey(r.code));
  renderResults();loadCurrentVisible();
});
$('settings-btn').addEventListener('click',()=>$('settings-dialog').showModal());
$('settings-free-only').checked=state.freeOnly;$('free-only').checked=state.freeOnly;
$('settings-clock').value=state.timeFormat;
$('settings-free-only').addEventListener('change',e=>{state.freeOnly=e.target.checked;$('free-only').checked=state.freeOnly;store();renderResults();});
$('settings-clock').addEventListener('change',e=>{state.timeFormat=e.target.value;store();renderResults();renderDateStrip();});
$('add-room-btn').addEventListener('click',()=>{$('custom-room-code').value='';$('custom-room-campus').value=state.campus==='Hönggerberg'?'Hönggerberg':'Zentrum';$('add-room-error').textContent='';$('add-room-dialog').showModal();});
$('close-add-room').addEventListener('click',()=>$('add-room-dialog').close());
$('add-room-form').addEventListener('submit',e=>{
  e.preventDefault();const code=$('custom-room-code').value.toUpperCase().trim().replace(/\s+/g,' ');
  const valid=/^[A-Z]{2,4} [A-Z]{1,3} [0-9]{1,5}(?:\.[0-9]{1,5}){0,2}$/.test(code);
  if(!valid){$('add-room-error').textContent='Use the format HG E 27 or HCI H 2.1.';return;}
  if(allRooms().some(r=>r.code===code)){$('add-room-error').textContent='Room is already in the catalog. You can find it via search.';return;}
  const room={code,building:code.split(' ')[0],campus:$('custom-room-campus').value};state.extraRooms.push(room);state.expandedBuildings.add(room.building);store();$('add-room-dialog').close();state.search='';$('room-search').value='';switchCampus(room.campus);
});

async function start(){renderDateStrip();renderResults();try{const response=await fetch('/rooms.json');if(!response.ok)throw Error('Cannot load catalog');const list=await response.json();if(!Array.isArray(list))throw Error('Invalid catalog');state.rooms=list;state.loadingCatalog=false;renderResults();}catch{state.loadingCatalog=false;state.catalogError=true;renderResults();}}
start();
setInterval(()=>{const {date}=zurichParts();if(date!==state.day && state.day===shiftDate(date,-1))setDay(date);else{renderDateStrip();renderResults();loadCurrentVisible();}},60000);
if('serviceWorker' in navigator && window.isSecureContext){navigator.serviceWorker.register('/sw.js').catch(()=>{});}
