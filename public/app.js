performance.mark('app-script-start');
import {zurichParts,shiftDate,weekStart,displayTime,statusFromRecord,isFreshRecord,sourceAgeMs,MAX_STALE_MS} from './schedule.mjs';
import {MORE_BATCH,INITIAL_SHOWN,MAX_SHOWN,normalizeMode,assessRecord,recommend,cardText,emptyMessage,orderCandidates,planBatch,planInitialLoad,favoriteRooms,summarizeCoverage,describeCoverage} from './recommend.mjs';

const $=id=>document.getElementById(id);
const STORAGE_KEY='openroom-prefs-v1';
const preferences=(()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}catch{return {}}})();
const CAMPUSES=['Zentrum','Hönggerberg'];
const state={
  campus: CAMPUSES.includes(preferences.campus)?preferences.campus:'Zentrum',
  mode: normalizeMode(preferences.mode),
  attempted:new Map(),      // campus -> Set of room codes the home screen has asked to check
  showAllRecs:false,
  expandedCards:new Set(),  // 'rec:CODE' / 'fav:CODE' detail panels on the home screen
  admitted:new Set(),       // rooms the app may request and keep refreshing on its own (bounded by the initial budget)
  planned:new Set(),        // campuses whose first load has been planned
  startupDone:false,
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
const MAX_SIMULTANEOUS=2;
const CACHE_KEY='openroom-cache-v2'; // v2 records carry the age of the original ETH answer
let pausedUntil=0,resumeTimer=null,retryTimer=null,retryTimerAt=0,persistTimer=null;
function store() {localStorage.setItem(STORAGE_KEY,JSON.stringify({campus:state.campus,mode:state.mode,freeOnly:state.freeOnly,favorites:[...state.favorites],extraRooms:state.extraRooms,timeFormat:state.timeFormat}));}
function html(s) {return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function escapeAttr(s){return html(s);}
function enqueue(work) {return new Promise((resolve,reject)=>{fetchQueue.push({work,resolve,reject});flushQueue();});}
function flushQueue() {if(Date.now()<pausedUntil)return;while(running<MAX_SIMULTANEOUS && fetchQueue.length){const task=fetchQueue.shift();running++;Promise.resolve().then(task.work).then(task.resolve,task.reject).finally(()=>{running--;flushQueue();});}}
// After a rate-limit answer nothing new is sent until the cooldown has passed; queued work simply waits.
function pauseQueue(ms){pausedUntil=Math.max(pausedUntil,Date.now()+ms);clearTimeout(resumeTimer);resumeTimer=setTimeout(()=>{flushQueue();loadCurrentVisible();},pausedUntil-Date.now()+50);}
function scheduleRetry(ms){const at=Date.now()+ms+100;if(retryTimer&&retryTimerAt<=at)return;clearTimeout(retryTimer);retryTimerAt=at;retryTimer=setTimeout(()=>{retryTimer=null;retryTimerAt=0;loadCurrentVisible();},at-Date.now());}
function loadPersistedCache(){try{const raw=JSON.parse(localStorage.getItem(CACHE_KEY)||'{}');if(raw.v!==2||!Array.isArray(raw.entries))return;const now=Date.now();for(const [k,r] of raw.entries){const age=sourceAgeMs(r,now);if(r&&r.state==='ready'&&Array.isArray(r.allocations)&&Number.isFinite(age)&&age<MAX_STALE_MS)state.cache.set(k,r);}}catch{}}
function persistCache(){clearTimeout(persistTimer);persistTimer=setTimeout(()=>{try{const entries=[...state.cache].filter(([,r])=>r.state==='ready').sort((a,b)=>b[1].receivedAt-a[1].receivedAt).slice(0,100);localStorage.setItem(CACHE_KEY,JSON.stringify({v:2,entries}));}catch{}},500);}
function cacheKey(room,day=state.day){return `${room}|${weekStart(day)}`;}
function isFresh(record,aheadMs=0){return isFreshRecord(record,Date.now(),aheadMs);} // judged by the age of the ORIGINAL ETH answer
// A room needs a request if it has no data, stale data, or an error whose backoff has expired.
function needsLoad(record,aheadMs=0){const now=Date.now();if(!record)return true;if(record.state==='error')return now>=(record.retryAt||0);return !isFresh(record,aheadMs)&&now>=(record.retryAt||0);}
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
      const response=await fetch(`/api/allocations?${params}`,{headers:{Accept:'application/json'},cache:'no-store'}); // our own cache tracks the source age; the HTTP cache must not hide it
      let json=null;try{json=await response.json();}catch{}
      if(!response.ok){const err=new Error((json&&json.error)||`API HTTP ${response.status}`);err.status=response.status;err.retryAfter=Number(response.headers.get('Retry-After'))||Number(json&&json.retryAfter)||0;throw err;}
      if(!json||!Array.isArray(json.allocations))throw new Error('Unexpected API response');
      // Age of the ORIGINAL ETH answer when it reached us (server-measured, plus any shared-cache Age header). Missing = unknown = never fresh.
      const ageMs=Number(json.ageMs),httpAgeMs=(Number(response.headers.get('Age'))||0)*1000;
      const data={state:'ready',allocations:json.allocations,roomVerified:json.roomVerified===true?true:json.roomVerified===false?false:null,fetchedAt:json.fetchedAt,from,to,receivedAt:Date.now(),ageAtReceiptMs:Number.isFinite(ageMs)&&ageMs>=0?ageMs+httpAgeMs:undefined};
      if(!isFreshRecord(data))data.retryAt=Date.now()+60_000; // already old on arrival (served from a cache): do not ask again straight away
      state.cache.set(key,data);persistCache();return data;
    } catch(error){
      // Errors are never "free". 429/503 pause the whole queue; every failure backs off for at least 30 s (10 s if ETH says so).
      const limited=error.status===429||error.status===503;
      const wait=(limited?Math.max(error.retryAfter||60,10):30)*1000;
      if(limited)pauseQueue(wait);
      scheduleRetry(wait);
      const prev=state.cache.get(key);
      if(prev&&prev.state==='ready'&&sourceAgeMs(prev)<MAX_STALE_MS){prev.retryAt=Date.now()+wait;return prev;} // keep showing older cached data
      const data={state:'error',message:error.message||'Failed to retrieve schedule',rateLimited:limited,retryAt:Date.now()+wait};
      state.cache.set(key,data);return data;
    }
  });
  state.inflight.set(key,promise);
  promise.finally(()=>{state.inflight.delete(key);renderSoon();});
  return promise;
}
// aheadMs>0 also refreshes data that is about to expire, so home recommendations do not vanish and reappear.
function scheduleLoad(codes,day=state.day,aheadMs=0){for(const code of codes){const key=cacheKey(code,day);const record=state.cache.get(key);if(needsLoad(record,aheadMs)&&!state.inflight.has(key))void ensureSchedule(code,day,aheadMs>0&&isFresh(record));}}
function getStatus(code,day=state.day){const now=zurichParts();return statusFromRecord(state.cache.get(cacheKey(code,day)),{day,today:now.date,now:now.minute,format:state.timeFormat});}
function isVisibleRoom(r){return r.campus===state.campus;}
function matchingRooms(){const search=state.search.toUpperCase().trim();return allRooms().filter(r=>isVisibleRoom(r)&&(!search||`${r.code} ${r.building}`.includes(search)));}
// A narrow search (<=5 rooms) auto-expands its buildings; broad searches stay collapsed to avoid a burst of ETH requests.
function searchExpands(rooms){return state.search.trim()!==''&&rooms.length<=5;}
function visibleByFilter(r){if(!state.freeOnly)return true;const status=getStatus(r.code);return status.state==='free';}
function weekdayIndex(ymd){return (new Date(`${ymd}T12:00:00Z`).getUTCDay()+6)%7;}
function labelDay(day,options){const d=new Date(day+'T12:00:00Z');return new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',...options}).format(d);}
function setDay(day){state.day=day;renderDateStrip();renderResults();loadCurrentVisible();}
function renderDateStrip(){
  const [start,end]=weekBounds(state.day);
  const a=labelDay(start,{day:'numeric',month:'short'}),b=labelDay(end,{day:'numeric',month:'short',year:'numeric'});
  $('week-label').textContent=`${a} – ${b}`;
  setHtml($('day-strip'),Array.from({length:7},(_,idx)=>{const day=shiftDate(start,idx);const today=day===zurichParts().date;return `<button type="button" class="day-btn ${state.day===day?'selected':''} ${today?'today':''}" data-day="${day}" aria-pressed="${day===state.day}"><span class="day-name">${labelDay(day,{weekday:'short'})}</span><span class="day-number">${Number(day.slice(-2))}</span></button>`;}).join(''));
  const now=zurichParts();$('time-caption').textContent=state.day===now.date?`Zurich · ${displayTime(now.minute,state.timeFormat)}`:`${labelDay(state.day,{weekday:'long',day:'numeric',month:'short'})}`;
}
function statusHtml(s){const classes={free:'status-free',busy:'status-busy',blocked:'status-blocked',unknown:'status-unknown',loading:'status-loading'};return `<div class="room-status ${classes[s.state]||'status-unknown'}"><span class="status-dot"></span><span class="status-text">${html(s.text)}${s.stale?' · Stale':''}</span></div>`;}
function favoriteButton(code){const saved=state.favorites.has(code);return `<button class="favorite-btn ${saved?'saved':''}" type="button" data-favorite="${escapeAttr(code)}" aria-pressed="${saved}" aria-label="${saved?'Remove':'Add'} ${escapeAttr(code)} ${saved?'from':'to'} favorites" title="${saved?'Remove from favorites':'Add to favorites'}">${saved?'★':'☆'}</button>`;}
function roomHtml(r){const s=getStatus(r.code);const open=state.expandedRooms.has(r.code);return `<div class="room-entry"><div class="room-row"><button class="room-main" type="button" data-open-room="${escapeAttr(r.code)}" aria-expanded="${open}"><div><div class="room-code">${html(r.code)}</div><div class="room-hint">${open?'Hide timetable':'View timetable'} ${open?'↑':'→'}</div></div>${statusHtml(s)}</button>${favoriteButton(r.code)}</div>${open?detailHtml(r,s):''}</div>`;}
function detailHtml(r,s,day=state.day){
  const viewFrom=480,viewTo=1320;
  let timeline='';
  let freeText='';
  let bookings='';
  if(s.state==='loading'||(s.state==='unknown'&&!s.blocks.length&&!s.free.length)){
    timeline=`<div class="empty-card">${s.state==='loading'?'Loading timetable…':html(s.text)+' — availability is unknown.'}${s.message?`<br><small>${html(s.message)}</small>`:''}</div>`;
  }else{
    const colors=s.blocks.map(b=>{
      const start=Math.max(viewFrom,b.start),end=Math.min(viewTo,b.end);
      if(end<=start)return '';
      return `<span class="timeline-segment ${b.type===8?'restricted':''}" style="left:${100*(start-viewFrom)/(viewTo-viewFrom)}%;width:${100*(end-start)/(viewTo-viewFrom)}%" title="${escapeAttr(b.title||'Blocked interval')}"></span>`;
    }).join('');
    timeline=`<div class="detail-small-title">Daily overview (08:00–22:00)</div><div class="timeline-wrap"><div class="timeline-bar" aria-label="Green indicates unreserved intervals, salmon indicates bookings, amber indicates block entries">${colors}</div><div class="timeline-labels"><span>08</span><span>12</span><span>16</span><span>20</span><span>22</span></div></div>`;
    freeText=`<div class="detail-small-title">Unreserved intervals</div><div class="free-windows">${s.free.length?s.free.map(i=>`${displayTime(i.start,state.timeFormat)}–${displayTime(i.end,state.timeFormat)}`).join(' · '):'None in displayed hours'}</div>`;
    bookings=`<div class="detail-small-title">Reservations and blocks</div><div class="slot-list">${s.blocks.length?s.blocks.map(b=>`<div class="slot"><span class="slot-time">${displayTime(b.start,state.timeFormat)}–${displayTime(b.end,state.timeFormat)}</span><span class="slot-title">${html(b.title|| (b.type===8?'Blocked interval (type 8)':b.type===2?'Reservation':`Blocked interval (type ${b.type??'unknown'})`))}</span></div>`).join(''):'<span class="slot-title">No published entries for this date.</span>'}</div>`;
  }
  const [from,to]=weekBounds(day);
  const ethUrl=new URL('https://ethz.ch/staffnet/de/service/raeume-gebaeude/rauminfo/raumdetails/allocation.html');ethUrl.searchParams.set('room',r.code);ethUrl.searchParams.set('from',from);ethUrl.searchParams.set('to',to);
  return `<div class="room-details">${s.stale&&s.fetchedAt?`<div class="detail-caveat">Cached data from ${displayTime(zurichParts(new Date(s.fetchedAt)).minute,state.timeFormat)} — refreshing…</div>`:''}${timeline}${freeText}${bookings}<div class="room-details-bottom"><a class="source-link" href="${escapeAttr(ethUrl.toString())}" target="_blank" rel="noopener noreferrer">View official Belegungsplan ↗</a><span class="detail-caveat">Schedule ≠ occupancy</span></div></div>`;
}
function renderResults(){
  if(state.loadingCatalog){setHtml($('room-results'),'<div class="empty-card">Loading room catalog…</div>');return;}
  if(state.catalogError){setHtml($('room-results'),'<div class="empty-card">Could not load room catalog. Refresh to try again.</div>');return;}
  const rooms=matchingRooms();
  $('list-heading').textContent='Buildings';
  $('list-caption').textContent=`${new Set(rooms.map(r=>r.building)).size} buildings · ${rooms.length} rooms in catalog${state.freeOnly?' · free-only lists only confirmed-free rooms in open buildings':''}`;
  if(!rooms.length){setHtml($('room-results'),`<div class="empty-card"><div class="empty-symbol">⌕</div>No rooms match your search.</div>`);return;}
  const auto=searchExpands(rooms);
  const groups=new Map();for(const room of rooms){if(!groups.has(room.building))groups.set(room.building,[]);groups.get(room.building).push(room);}
  const content=[...groups].map(([building,list])=>{
    const open=auto||state.expandedBuildings.has(building);
    const filtering=state.freeOnly;
    const statuses=new Map(list.map(r=>[r.code,getStatus(r.code)]));
    const shown=list.filter(visibleByFilter);
    const loadingN=list.filter(r=>statuses.get(r.code).state==='loading').length,unknownN=list.filter(r=>statuses.get(r.code).state==='unknown').length;
    const meta=`${list.length} room${list.length>1?'s':''}`;
    const pill=filtering && open?`${shown.length} ${loadingN||unknownN?'confirmed free':'free'}`:`${list.length} rooms`;
    const note=text=>`<div class="empty-card" style="border:0;border-top:1px solid var(--line);border-radius:0;padding:12px">${text}</div>`;
    const body=shown.map(roomHtml).join('')+(filtering?(loadingN?note(`Checking ${loadingN} more room${loadingN===1?'':'s'}…`):'')+(unknownN?note(`${unknownN} room${unknownN===1?' is':'s are'} hidden because availability is unknown (schedule unavailable, room not verified, or outside 08–22). Turn off the filter to see them.`):''):'');
    const emptyBody=filtering && !loadingN && !unknownN && !shown.length?'<div class="empty-card" style="border:0;border-radius:0">No rooms confirmed free in this building for the selected time.</div>':'';
    return `<article class="building-card ${open?'open':''}"><button type="button" class="building-head" data-building="${html(building)}" aria-expanded="${open}"><span class="building-avatar">${html(building)}</span><span><span class="building-title">${html(building)}</span><span class="building-meta" style="display:block">${meta}</span></span><span class="building-right"><span class="count-pill">${pill}</span><span class="chevron">›</span></span></button>${open?`<div class="building-rooms">${body||emptyBody}</div>`:''}</article>`;
  }).join('');
  setHtml($('room-results'),content);
}
// ---------- Rendering helpers: no DOM churn, coalesced renders, focus kept ----------
const FOCUS_ATTRS=['data-toggle-card','data-favorite','data-open-room','data-building'];
function focusKey(node){for(const a of FOCUS_ATTRS){const v=node.getAttribute&&node.getAttribute(a);if(v!==null&&v!==undefined)return [a,v];}return null;}
function restoreFocus(root,key){if(!key)return;for(const n of root.querySelectorAll(`[${key[0]}]`))if(n.getAttribute(key[0])===key[1]){n.focus({preventScroll:true});return;}}
// Replaces innerHTML only when the markup really changed (keeps scroll, focus, hover and layout stable).
function setHtml(el,markup){if(el.__markup===markup)return false;const active=document.activeElement;const key=active&&el.contains(active)?focusKey(active):null;el.innerHTML=markup;el.__markup=markup;restoreFocus(el,key);return true;}
function setText(el,text){if(el.textContent!==text)el.textContent=text;}
let renderQueued=false;
function renderSoon(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;renderAll();});} // many responses in one frame -> one render

// ---------- Home: favorites, recommendations, coverage (pure logic lives in recommend.mjs) ----------
const MODE_HELP={now:'Free right now for at least 30 minutes.',soon:'Becomes free within the next hour, for at least 30 minutes.',rest:'Free until the end of the day, with no later reservations.'};
function homeCtx(){const z=zurichParts();return {today:z.date,now:z.minute,nowMs:Date.now()};}
function todayRecord(code){return state.cache.get(cacheKey(code,zurichParts().date));}
function campusRooms(){return allRooms().filter(r=>r.campus===state.campus);}
function attemptedSet(){let set=state.attempted.get(state.campus);if(!set){set=new Set();state.attempted.set(state.campus,set);}return set;}
// Rooms whose fresh data may be used: those the home screen asked for, plus any room of the campus that happens to be fresh.
function checkedRooms(){const ctx=homeCtx(),rooms=campusRooms(),attempted=new Set(attemptedSet());for(const r of rooms)if(assessRecord(todayRecord(r.code),ctx).state==='ready')attempted.add(r.code);return {rooms,attempted,ctx};}
function uncheckedCandidates(){const {rooms,attempted,ctx}=checkedRooms();return orderCandidates({rooms,favorites:state.favorites,getRecord:todayRecord,ctx}).filter(code=>!attempted.has(code));}
// Deliberate "Check more rooms": up to `count` further rooms of this campus (fresh cache joins for free).
function addBatch(count){const rooms=campusRooms(),ctx=homeCtx(),set=attemptedSet();const ordered=orderCandidates({rooms,favorites:state.favorites,getRecord:todayRecord,ctx});for(const code of planBatch({ordered,attempted:set,count,getRecord:todayRecord,ctx})){set.add(code);state.admitted.add(code);}}
// First load of a campus under ONE shared request budget (favorites + discovery); see planInitialLoad.
function runInitialPlan(startup){const plan=planInitialLoad({rooms:campusRooms(),allRooms:allRooms(),favorites:[...state.favorites],getRecord:todayRecord,ctx:homeCtx(),includeOtherFavorites:startup});for(const c of plan.attempted)attemptedSet().add(c);for(const c of plan.admit)state.admitted.add(c);}
function admitAndLoad(codes){for(const c of codes)state.admitted.add(c);scheduleLoad(codes,zurichParts().date);}
// Favorites that are visible but whose schedule nobody has asked for (budget exhausted): they load only on a deliberate action.
function uncheckedFavorites(){const day=zurichParts().date;return favoriteRooms(allRooms(),state.favorites).map(r=>r.code).filter(c=>!state.admitted.has(c)&&!state.cache.has(cacheKey(c,day))&&!state.inflight.has(cacheKey(c,day)));}
function getHomeStatus(code){const day=zurichParts().date;if(uncheckedFavorites().includes(code))return {state:'unknown',text:'Not checked yet',blocks:[],free:[],message:'This favorite has not been requested yet to keep ETH traffic low. Tap it to load its schedule.'};return getStatus(code,day);}
// Never polls in the background: nothing is requested while the tab is hidden. aheadMs>0 (minute tick only) refreshes data that is about to expire.
function loadHome(aheadMs=0){if(state.loadingCatalog||state.catalogError)return;if(!state.planned.has(state.campus)){state.planned.add(state.campus);runInitialPlan(!state.startupDone);state.startupDone=true;}if(document.hidden)return;scheduleLoad([...state.admitted],zurichParts().date,aheadMs);}
function toggleFavorite(code){if(state.favorites.has(code))state.favorites.delete(code);else state.favorites.add(code);store();renderAll();} // starring never triggers a request by itself
function zurichClock(iso){const t=Date.parse(iso);return Number.isFinite(t)?displayTime(zurichParts(new Date(t)).minute,state.timeFormat):null;}
function favRowHtml(r){const z=zurichParts();const s=getHomeStatus(r.code);const key='fav:'+r.code;const open=state.expandedCards.has(key);const place=r.campus?`${html(r.building)} · ${html(r.campus)}`:html(r.building);
  return `<div class="fav-entry"><div class="fav-row"><button class="fav-main" type="button" data-toggle-card="${escapeAttr(key)}" aria-expanded="${open}"><span class="rec-id"><span class="rec-code">${html(r.code)}</span><span class="rec-building">${place}</span></span>${statusHtml(s)}</button>${favoriteButton(r.code)}</div>${open?detailHtml(r,s,z.date):''}</div>`;}
function recCardHtml(item){const code=item.room.code,key='rec:'+code,open=state.expandedCards.has(key),z=zurichParts();const text=cardText(item,state.timeFormat);
  return `<article class="rec-card"><div class="rec-row"><button class="rec-main" type="button" data-toggle-card="${escapeAttr(key)}" aria-expanded="${open}"><span class="rec-id"><span class="rec-code">${html(code)}</span><span class="rec-building">${html(item.room.building)}</span></span><span class="rec-info"><span class="rec-headline"><span class="status-dot" aria-hidden="true"></span>${html(text.headline)}</span><span class="rec-detail">${html(text.detail)}</span></span></button>${favoriteButton(code)}</div>${open?detailHtml(item.room,getStatus(code,z.date),z.date):''}</article>`;}
function renderFavorites(){const list=favoriteRooms(allRooms(),state.favorites);$('favorites-section').hidden=list.length===0;const btn=$('check-favorites');
  if(!list.length){setHtml($('favorites-list'),'');btn.hidden=true;return;}
  const pending=uncheckedFavorites(),paused=Date.now()<pausedUntil;
  setText($('favorites-note'),`${list.length} saved · both campuses${pending.length?` · ${pending.length} not checked yet`:''}`);
  setHtml($('favorites-list'),list.map(favRowHtml).join(''));
  btn.hidden=pending.length===0;btn.disabled=paused;setText(btn,paused?'Paused — ETH rate limit':`Check ${Math.min(MORE_BATCH,pending.length)} favorite${Math.min(MORE_BATCH,pending.length)===1?'':'s'}`);}
let firstRenderMarked=false,firstRecMarked=false;
function renderHome(){
  renderFavorites();
  document.querySelectorAll('.mode-btn').forEach(b=>{const on=b.dataset.mode===state.mode;b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));});
  setText($('mode-help'),MODE_HELP[state.mode]);
  const z=zurichParts();setText($('home-time'),`Zurich · ${displayTime(z.minute,state.timeFormat)}`);
  const box=$('recommendations'),more=$('rec-more'),check=$('check-more');
  if(state.loadingCatalog||state.catalogError){setHtml(box,`<div class="rec-empty" role="status">${state.catalogError?'Could not load the room catalog. Refresh to try again.':'Loading room catalog…'}</div>`);more.hidden=true;check.hidden=true;setText($('coverage-text'),'');setText($('coverage-detail'),'');return;}
  const {rooms,attempted,ctx}=checkedRooms();
  const items=recommend({rooms:rooms.filter(r=>attempted.has(r.code)),mode:state.mode,getRecord:todayRecord,ctx});
  const summary=summarizeCoverage({rooms,attempted,getRecord:todayRecord,ctx});
  const cov=describeCoverage(summary,{pausedUntilMs:pausedUntil,nowMs:Date.now()});
  const shown=items.slice(0,state.showAllRecs?MAX_SHOWN:INITIAL_SHOWN);
  let markup;
  if(shown.length)markup=shown.map(recCardHtml).join('');
  else if(cov.kind==='loading'||cov.kind==='idle')markup='<div class="rec-empty" role="status">Looking for free rooms…</div>';
  else if(summary.checked>0)markup=`<div class="rec-empty">${html(emptyMessage(state.mode))} ${rooms.length>summary.checked?'Try another mode or check more rooms.':''}</div>`;
  else markup='<div class="rec-empty">No recommendations yet — see the status below.</div>';
  setHtml(box,markup);
  if(shown.length&&!firstRecMarked){firstRecMarked=true;performance.mark('first-recommendation');}
  const extra=Math.min(items.length,MAX_SHOWN)-INITIAL_SHOWN;
  more.hidden=items.length<=INITIAL_SHOWN;setText(more,state.showAllRecs?'Show fewer':`Show ${extra} more`);more.setAttribute('aria-expanded',String(state.showAllRecs));
  const refreshed=zurichClock(summary.lastRefresh);
  $('coverage').dataset.kind=cov.kind;
  setText($('coverage-text'),cov.text);
  setText($('coverage-detail'),[refreshed?`Last refresh ${refreshed}`:'',cov.detail].filter(Boolean).join(' · '));
  const candidates=uncheckedCandidates(),paused=Date.now()<pausedUntil;
  check.hidden=candidates.length===0;check.disabled=paused;setText(check,paused?'Paused — ETH rate limit':`Check ${Math.min(MORE_BATCH,candidates.length)} more room${Math.min(MORE_BATCH,candidates.length)===1?'':'s'}`);
}
function renderAll(){renderHome();renderResults();if(!firstRenderMarked){firstRenderMarked=true;performance.mark('first-render');}}
function loadCurrentVisible(){if(state.loadingCatalog)return;const grouped=matchingRooms();const openCodes=grouped.filter(r=>searchExpands(grouped)||state.expandedBuildings.has(r.building)).map(r=>r.code);scheduleLoad(openCodes);loadHome();}
function syncCampusTabs(){document.querySelectorAll('.campus-tab').forEach(b=>{const on=b.dataset.campus===state.campus;b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));});}
function switchCampus(next){if(!CAMPUSES.includes(next))return;state.campus=next;state.showAllRecs=false;syncCampusTabs();store();renderAll();loadCurrentVisible();}

$('day-strip').addEventListener('click',e=>{const b=e.target.closest('[data-day]');if(b)setDay(b.dataset.day);});
$('prev-week').addEventListener('click',()=>setDay(shiftDate(state.day,-7)));
$('next-week').addEventListener('click',()=>setDay(shiftDate(state.day,7)));
$('today-btn').addEventListener('click',()=>setDay(zurichParts().date));
$('room-search').addEventListener('input',e=>{state.search=e.target.value;renderResults();loadCurrentVisible();});
$('free-only').addEventListener('change',e=>{state.freeOnly=e.target.checked;$('settings-free-only').checked=state.freeOnly;store();renderResults();});
document.querySelectorAll('.campus-tab').forEach(b=>b.addEventListener('click',()=>switchCampus(b.dataset.campus)));
document.querySelectorAll('.mode-btn').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode)));
$('room-results').addEventListener('click',e=>{
  const room=e.target.closest('[data-open-room]');if(room){const code=room.dataset.openRoom;if(state.expandedRooms.has(code))state.expandedRooms.delete(code);else state.expandedRooms.add(code);renderResults();return;}
  const building=e.target.closest('[data-building]');if(building){const code=building.dataset.building;if(state.expandedBuildings.has(code))state.expandedBuildings.delete(code);else state.expandedBuildings.add(code);renderResults();loadCurrentVisible();}
});
$('refresh-btn').addEventListener('click',()=>{
  const all=matchingRooms().filter(r=>searchExpands(matchingRooms())||state.expandedBuildings.has(r.building));
  for(const r of all)state.cache.delete(cacheKey(r.code));
  for(const code of state.admitted)void ensureSchedule(code,zurichParts().date,true); // keeps showing the old data until the new arrives
  renderAll();loadCurrentVisible();
});
// Home screen: one delegated handler for stars, expandable cards, modes and the two batch buttons.
document.addEventListener('click',e=>{
  const fav=e.target.closest('[data-favorite]');if(fav){toggleFavorite(fav.dataset.favorite);return;}
  const card=e.target.closest('[data-toggle-card]');if(card){const key=card.dataset.toggleCard;if(state.expandedCards.has(key))state.expandedCards.delete(key);else{state.expandedCards.add(key);if(key.startsWith('fav:')){const code=key.slice(4);if(uncheckedFavorites().includes(code))admitAndLoad([code]);}}renderHome();return;} // opening an unchecked favorite is a deliberate request
  const mode=e.target.closest('[data-mode]');if(mode){state.mode=normalizeMode(mode.dataset.mode);state.showAllRecs=false;store();renderHome();}
});
$('rec-more').addEventListener('click',()=>{state.showAllRecs=!state.showAllRecs;renderHome();});
$('check-more').addEventListener('click',()=>{if(Date.now()<pausedUntil)return;addBatch(MORE_BATCH);renderHome();loadHome();});
$('check-favorites').addEventListener('click',()=>{if(Date.now()<pausedUntil)return;admitAndLoad(uncheckedFavorites().slice(0,MORE_BATCH));renderHome();});
$('search-btn').addEventListener('click',()=>{const input=$('room-search');input.scrollIntoView({block:'center'});input.focus();});
$('settings-btn').addEventListener('click',()=>$('settings-dialog').showModal());
$('settings-free-only').checked=state.freeOnly;$('free-only').checked=state.freeOnly;
$('settings-clock').value=state.timeFormat;
$('settings-free-only').addEventListener('change',e=>{state.freeOnly=e.target.checked;$('free-only').checked=state.freeOnly;store();renderResults();});
$('settings-clock').addEventListener('change',e=>{state.timeFormat=e.target.value;store();renderAll();renderDateStrip();});
$('add-room-btn').addEventListener('click',()=>{$('custom-room-code').value='';$('custom-room-campus').value=state.campus==='Hönggerberg'?'Hönggerberg':'Zentrum';$('add-room-error').textContent='';$('add-room-dialog').showModal();});
$('close-add-room').addEventListener('click',()=>$('add-room-dialog').close());
$('add-room-form').addEventListener('submit',e=>{
  e.preventDefault();const code=$('custom-room-code').value.toUpperCase().trim().replace(/\s+/g,' ');
  const valid=/^[A-Z]{2,4} [A-Z]{1,3} [0-9]{1,5}(?:\.[0-9]{1,5}){0,2}$/.test(code);
  if(!valid){$('add-room-error').textContent='Use the format HG E 27 or HCI H 2.1.';return;}
  if(allRooms().some(r=>r.code===code)){$('add-room-error').textContent='Room is already in the catalog. You can find it via search.';return;}
  const room={code,building:code.split(' ')[0],campus:$('custom-room-campus').value};state.extraRooms.push(room);state.expandedBuildings.add(room.building);store();$('add-room-dialog').close();state.search='';$('room-search').value='';switchCampus(room.campus);
});

async function start(){loadPersistedCache();syncCampusTabs();renderDateStrip();renderAll();try{const response=await fetch('/rooms.json');if(!response.ok)throw Error('Cannot load catalog');const list=await response.json();if(!Array.isArray(list))throw Error('Invalid catalog');state.rooms=list;state.loadingCatalog=false;renderAll();loadHome();}catch{state.loadingCatalog=false;state.catalogError=true;renderAll();}}
start();
setInterval(()=>{if(document.hidden)return;const {date}=zurichParts();if(date!==state.day && state.day===shiftDate(date,-1))setDay(date);else{renderDateStrip();renderAll();loadCurrentVisible();loadHome(120000);}},60000); // local recalculation every minute; ETH is only asked for data about to expire, never while hidden
document.addEventListener('visibilitychange',()=>{if(!document.hidden){renderDateStrip();renderAll();loadCurrentVisible();}});
if('serviceWorker' in navigator && window.isSecureContext){navigator.serviceWorker.register('/sw.js').catch(()=>{});}
