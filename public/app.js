performance.mark('app-script-start');
import {zurichParts,shiftDate,weekStart,displayTime,statusFromRecord,isFreshRecord,sourceAgeMs,MAX_STALE_MS} from './schedule.mjs';
import {MORE_BATCH,INITIAL_SHOWN,MAX_SHOWN,INITIAL_REQUEST_BUDGET,normalizeMode,assessRecord,recommend,cardText,emptyMessage,orderCandidates,planBatch,planInitialLoad,planRevalidation,needsRequest,favoriteRooms,summarizeCoverage,describeCoverage,selectRefreshTargets,describeRefresh} from './recommend.mjs';
import {DEFAULT_FILTERS,FILTER_TYPES,CAPACITY_OPTIONS,ACCESS_OPTIONS,normalizeCatalog,roomMeta,normalizeFilters,isDefaultFilters,activeFilterCount,filterSummary,filterRooms,filterCoverage,coverageNotes,accessInfo,accessMark,computerRoomNotice,roomInfoRows,equipmentList,accessibilityList,otherDetails,officialRoomUrl,provenance} from './metadata.mjs';
import {GUARD_KEY,fetchDeployedVersion,checkAndApply,applyOnLaunch,applyWaiting,UPDATE_MESSAGES} from './update.mjs';
import {PULL,isPullBlocked,attachPullToRefresh} from './pull-refresh.mjs';
import {layoutTimeline,nextChange,currentStatus,resolveRecord,statusBadge,freshnessInfo,intervalInfo,daySummary} from './timeline.mjs';
import * as dv from './detail-view.mjs';

const $=id=>document.getElementById(id);
const STORAGE_KEY='openroom-prefs-v1';
const preferences=(()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}catch{return {}}})();
const CAMPUSES=['Zentrum','Hönggerberg'];
const RUNNING_VERSION=self.OPENROOM_VERSION; // version of the files THIS page loaded (sw-version.js)
const state={
  campus: CAMPUSES.includes(preferences.campus)?preferences.campus:'Zentrum',
  mode: normalizeMode(preferences.mode),
  filters: normalizeFilters(preferences.filters),   // room type / capacity / flexible furniture / student access (local, persisted)
  catalog: normalizeCatalog(null),                   // static room metadata, loaded once at start
  refreshing:false,lastDataRefreshAt:0,
  attempted:new Map(),      // campus -> Set of room codes the home screen has asked to check
  showAllRecs:false,
  detail:{open:false,code:null,day:null,selected:null,opener:null,pushed:false,scrollKey:null}, // the room-detail screen
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
function store() {localStorage.setItem(STORAGE_KEY,JSON.stringify({campus:state.campus,mode:state.mode,filters:state.filters,freeOnly:state.freeOnly,favorites:[...state.favorites],extraRooms:state.extraRooms,timeFormat:state.timeFormat}));}
function html(s) {return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function escapeAttr(s){return html(s);}
function enqueue(work) {return new Promise((resolve,reject)=>{fetchQueue.push({work,resolve,reject});flushQueue();});}
function flushQueue() {if(Date.now()<pausedUntil)return;while(running<MAX_SIMULTANEOUS && fetchQueue.length){const task=fetchQueue.shift();running++;Promise.resolve().then(task.work).then(task.resolve,task.reject).finally(()=>{running--;flushQueue();});}}
// After a rate-limit answer nothing new is sent until the cooldown has passed; queued work simply waits.
function pauseQueue(ms){pausedUntil=Math.max(pausedUntil,Date.now()+ms);clearTimeout(resumeTimer);resumeTimer=setTimeout(()=>{flushQueue();retryErrors();},pausedUntil-Date.now()+50);}
function scheduleRetry(ms){const at=Date.now()+ms+100;if(retryTimer&&retryTimerAt<=at)return;clearTimeout(retryTimer);retryTimerAt=at;retryTimer=setTimeout(()=>{retryTimer=null;retryTimerAt=0;retryErrors();},at-Date.now());}
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
      const data={state:'ready',allocations:json.allocations,roomVerified:json.roomVerified===true?true:json.roomVerified===false?false:null,fetchedAt:json.fetchedAt,fromCache:json.cached===true,from,to,receivedAt:Date.now(),ageAtReceiptMs:Number.isFinite(ageMs)&&ageMs>=0?ageMs+httpAgeMs:undefined};
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
// Requests only rooms that have no data, stale data or an expired error backoff, and are not already in flight.
function scheduleLoad(codes,day=state.day){for(const code of codes){const key=cacheKey(code,day);if(needsLoad(state.cache.get(key))&&!state.inflight.has(key))void ensureSchedule(code,day);}}
function getStatus(code,day=state.day){const now=zurichParts();return statusFromRecord(state.cache.get(cacheKey(code,day)),{day,today:now.date,now:now.minute,format:state.timeFormat});}
function isVisibleRoom(r){return r.campus===state.campus;}
function baseMatchingRooms(){const search=state.search.toUpperCase().trim();return allRooms().filter(r=>isVisibleRoom(r)&&(!search||`${r.code} ${r.building}`.includes(search)));}
// Browse buildings: the filters apply, but a room with unknown access is never hidden by the default access setting.
function matchingRooms(){return filterRooms(baseMatchingRooms(),state.catalog,state.filters,'browse');}
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
function roomHtml(r){const s=getStatus(r.code);return `<div class="room-entry"><div class="room-row"><button class="room-main" type="button" data-open-detail="${escapeAttr(r.code)}" aria-haspopup="dialog"><div><div class="room-code">${html(r.code)}</div><div class="room-hint">View timetable →</div></div>${statusHtml(s)}</button>${favoriteButton(r.code)}</div></div>`;}
function renderResults(){
  if(state.loadingCatalog){setHtml($('room-results'),'<div class="empty-card">Loading room catalog…</div>');return;}
  if(state.catalogError){setHtml($('room-results'),'<div class="empty-card">Could not load room catalog. Refresh to try again.</div>');return;}
  const rooms=matchingRooms();
  $('list-heading').textContent='Buildings';
  const filtering=!isDefaultFilters(state.filters),all=baseMatchingRooms().length;
  $('list-caption').textContent=`${new Set(rooms.map(r=>r.building)).size} buildings · ${filtering?`${rooms.length} of ${all} rooms match your filters`:`${rooms.length} rooms in catalog`}${state.freeOnly?' · free-only lists only confirmed-free rooms in open buildings':''}`;
  if(!rooms.length){setHtml($('room-results'),`<div class="empty-card"><div class="empty-symbol">⌕</div>No rooms match your search${isDefaultFilters(state.filters)?'':' and filters'}.</div>`);return;}
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
const FOCUS_ATTRS=['data-open-detail','data-favorite','data-building'];
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
// Recommendation candidates: ONLY rooms whose verified metadata matches the filters. Filtering is local; schedules are requested for these rooms only.
function candidateRooms(){return filterRooms(campusRooms(),state.catalog,state.filters,'recommendation');}
function attemptedSet(){let set=state.attempted.get(state.campus);if(!set){set=new Set();state.attempted.set(state.campus,set);}return set;}
// Rooms whose fresh data may be used: those the home screen asked for, plus any room of the campus that happens to be fresh.
function checkedRooms(){const ctx=homeCtx(),rooms=candidateRooms(),attempted=new Set(attemptedSet());for(const r of rooms)if(assessRecord(todayRecord(r.code),ctx).state==='ready')attempted.add(r.code);return {rooms,attempted,ctx};}
function uncheckedCandidates(){const {rooms,attempted,ctx}=checkedRooms();return orderCandidates({rooms,favorites:state.favorites,getRecord:todayRecord,ctx}).filter(code=>!attempted.has(code));}
// Deliberate "Check more rooms": up to `count` further rooms of this campus (fresh cache joins for free).
function addBatch(count){const rooms=candidateRooms(),ctx=homeCtx(),set=attemptedSet();const ordered=orderCandidates({rooms,favorites:state.favorites,getRecord:todayRecord,ctx});for(const code of planBatch({ordered,attempted:set,count,getRecord:todayRecord,ctx})){set.add(code);state.admitted.add(code);}}
// First load of a campus under ONE shared request budget (favorites + discovery); see planInitialLoad.
function runInitialPlan(startup){const plan=planInitialLoad({rooms:candidateRooms(),allRooms:allRooms(),favorites:[...state.favorites],getRecord:todayRecord,ctx:homeCtx(),includeOtherFavorites:startup});for(const c of plan.attempted)attemptedSet().add(c);for(const c of plan.admit)state.admitted.add(c);}
function admitAndLoad(codes){for(const c of codes)state.admitted.add(c);scheduleLoad(codes,zurichParts().date);}
// Favorites that are visible but whose schedule nobody has asked for (budget exhausted): they load only on a deliberate action.
function uncheckedFavorites(){const day=zurichParts().date;return favoriteRooms(allRooms(),state.favorites).map(r=>r.code).filter(c=>!state.admitted.has(c)&&!state.cache.has(cacheKey(c,day))&&!state.inflight.has(cacheKey(c,day)));}
function getHomeStatus(code){const day=zurichParts().date;if(uncheckedFavorites().includes(code))return {state:'unknown',text:'Not checked yet',blocks:[],free:[],message:'This favorite has not been requested yet to keep ETH traffic low. Tap it to load its schedule.'};return getStatus(code,day);}
// First load of a campus only (see runInitialPlan). Never polls: nothing is requested while the tab is hidden, and expired data is
// revalidated only on return to the app (revalidateForeground), on a deliberate tap, or when a room is opened.
function loadHome(){if(state.loadingCatalog||state.catalogError)return;if(!state.planned.has(state.campus)){state.planned.add(state.campus);runInitialPlan(!state.startupDone);state.startupDone=true;}if(document.hidden)return;scheduleLoad([...state.admitted],zurichParts().date);}
function toggleFavorite(code){if(state.favorites.has(code))state.favorites.delete(code);else state.favorites.add(code);store();renderAll();} // starring never triggers a request by itself
function zurichClock(iso){const t=Date.parse(iso);return Number.isFinite(t)?displayTime(zurichParts(new Date(t)).minute,state.timeFormat):null;}
function favRowHtml(r){const s=getHomeStatus(r.code);const place=r.campus?`${html(r.building)} · ${html(r.campus)}`:html(r.building);
  return `<div class="fav-entry"><div class="fav-row"><button class="fav-main" type="button" data-open-detail="${escapeAttr(r.code)}" aria-haspopup="dialog"><span class="rec-id"><span class="rec-code">${html(r.code)}</span><span class="rec-building">${place}</span></span>${statusHtml(s)}</button>${favoriteButton(r.code)}</div></div>`;}
function recCardHtml(item){const code=item.room.code;const text=cardText(item,state.timeFormat);
  return `<article class="rec-card"><div class="rec-row"><button class="rec-main" type="button" data-open-detail="${escapeAttr(code)}" aria-haspopup="dialog"><span class="rec-id"><span class="rec-code">${html(code)}</span><span class="rec-building">${html(item.room.building)}</span></span><span class="rec-info"><span class="rec-headline"><span class="status-dot" aria-hidden="true"></span>${html(text.headline)}</span><span class="rec-detail">${html(text.detail)}</span><span class="rec-access is-${html(roomMeta(state.catalog,code)?.access.status??'unknown')}">${html(accessMark(roomMeta(state.catalog,code)))}</span></span></button>${favoriteButton(code)}</div></article>`;}
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
  renderFilterBar();
  const z=zurichParts();setText($('home-time'),`Zurich · ${displayTime(z.minute,state.timeFormat)}`);
  const box=$('recommendations'),more=$('rec-more'),check=$('check-more');
  if(state.loadingCatalog||state.catalogError){setHtml(box,`<div class="rec-empty" role="status">${state.catalogError?'Could not load the room catalog. Refresh to try again.':'Loading room catalog…'}</div>`);more.hidden=true;check.hidden=true;$('refresh-stale').hidden=true;setText($('coverage-text'),'');setText($('coverage-detail'),'');return;}
  const {rooms,attempted,ctx}=checkedRooms();
  const filtersOn=!isDefaultFilters(state.filters),filteredOut=filtersOn&&rooms.length===0;
  const items=recommend({rooms:rooms.filter(r=>attempted.has(r.code)),mode:state.mode,getRecord:todayRecord,ctx});
  const summary=summarizeCoverage({rooms,attempted,getRecord:todayRecord,ctx,isInflight:code=>state.inflight.has(cacheKey(code,ctx.today))});
  const cov=describeCoverage(summary,{pausedUntilMs:pausedUntil,nowMs:Date.now()});
  const shown=items.slice(0,state.showAllRecs?MAX_SHOWN:INITIAL_SHOWN);
  let markup;
  if(filteredOut)markup='<div class="rec-empty">No room on this campus matches these filters. Change or reset the filters.</div>';
  else if(shown.length)markup=shown.map(recCardHtml).join('');
  else if(cov.kind==='idle'&&filtersOn)markup='<div class="rec-empty">No matching room has been checked yet. Use “Check more rooms” below; changing filters never contacts ETH by itself.</div>';
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
  const stale=$('refresh-stale'),staleN=Math.min(MORE_BATCH,summary.staleCodes.length);stale.hidden=staleN===0;stale.disabled=Date.now()<pausedUntil;setText(stale,Date.now()<pausedUntil?'Paused — ETH rate limit':`Refresh ${staleN} stale room${staleN===1?'':'s'}`);
  const candidates=uncheckedCandidates(),paused=Date.now()<pausedUntil;
  check.hidden=candidates.length===0;check.disabled=paused;setText(check,paused?'Paused — ETH rate limit':`Check ${Math.min(MORE_BATCH,candidates.length)} more room${Math.min(MORE_BATCH,candidates.length)===1?'':'s'}`);
}
function renderAll(){renderHome();renderResults();renderDetail();if(!firstRenderMarked){firstRenderMarked=true;performance.mark('first-render');}}
// ---------- Room detail screen (Stage 3B). Pure logic: timeline.mjs; markup: detail-view.mjs ----------
const shell=()=>document.querySelector('.app-shell');
function roomFor(code){return allRooms().find(r=>r.code===code)||{code,building:code.split(' ')[0],campus:null};}
function dayLabelOf(day,long=false){return labelDay(day,long?{weekday:'long',day:'numeric',month:'long'}:{weekday:'short',day:'numeric',month:'short'});}
function detailRecord(){return state.cache.get(cacheKey(state.detail.code,state.detail.day));}
// Opening a room needs no request when its week is fresh in the cache; otherwise exactly one request (a deliberate action).
function ensureDetailData(onOpen){const {code,day}=state.detail,key=cacheKey(code,day);if(state.inflight.has(key))return;
  if(onOpen){if(needsLoad(state.cache.get(key)))void ensureSchedule(code,day);}      // fresh: none; missing/stale/expired backoff: one
  else if(!state.cache.has(key))void ensureSchedule(code,day);}                       // date navigation reuses ANY cached week, requests only a missing one
function openRoom(code,opener){
  if(state.detail.open)return;
  Object.assign(state.detail,{open:true,code,day:zurichParts().date,selected:null,opener:opener||null,scrollKey:null});
  try{history.pushState({openroomDetail:code},'','#room');state.detail.pushed=true;}catch{state.detail.pushed=false;}
  document.body.classList.add('rd-open');shell().inert=true;$('room-detail').hidden=false;
  renderDetail();$('rd-close').focus({preventScroll:true});performance.mark('detail-opened');
  ensureDetailData(true);
}
function closeRoom(fromPop=false){
  if(!state.detail.open)return;
  const {opener,pushed}=state.detail;
  state.detail.open=false;state.detail.pushed=false;$('room-detail').hidden=true;shell().inert=false;document.body.classList.remove('rd-open');
  if(!fromPop&&pushed){try{history.back();}catch{}}
  if(opener&&document.contains(opener))opener.focus({preventScroll:true});
}
function setDetailDay(day){state.detail.day=day;state.detail.selected=null;state.detail.scrollKey=null;ensureDetailData(false);renderDetail();}
function refreshDetail(){if(Date.now()<pausedUntil)return;const {code,day}=state.detail;void ensureSchedule(code,day,true);renderDetail();} // manual refresh
function renderDetail(){
  const d=state.detail;if(!d.open)return;
  const room=roomFor(d.code),z=zurichParts(),nowMs=Date.now(),fmt=state.timeFormat,paused=nowMs<pausedUntil;
  // 1. current status (today) -------------------------------------------------
  const todayRes=resolveRecord(state.cache.get(cacheKey(d.code,z.date)),z.date,nowMs);
  let badge,text,nextText=null;
  if(todayRes.kind==='ready'){const cs=currentStatus(todayRes.model,z.minute,fmt);badge=statusBadge({state:cs.state,stale:todayRes.stale});text=cs.text;nextText=nextChange(todayRes.model,z.minute,fmt).text;}
  else if(todayRes.kind==='loading'){badge=statusBadge({state:'loading'});text='Loading schedule…';}
  else{badge=statusBadge({state:'unknown'});text=todayRes.problem.heading;}
  const viewRec=detailRecord(),fresh=freshnessInfo(viewRec,nowMs,fmt);
  setHtml($('rd-head'),dv.headHtml({room,favoriteButton:favoriteButton(room.code)}));
  setHtml($('rd-status'),dv.statusHtml({badge,text,nextText,fresh,paused}));
  // 2. day navigation ---------------------------------------------------------
  const first=weekStart(d.day);
  setHtml($('rd-daybar'),dv.dayBarHtml({label:dayLabelOf(d.day),isToday:d.day===z.date}));
  setHtml($('rd-weekstrip'),dv.weekStripHtml(Array.from({length:7},(_,i)=>{const day=shiftDate(first,i);return {day,short:labelDay(day,{weekday:'short'}),num:Number(day.slice(-2)),selected:day===d.day,today:day===z.date,aria:dayLabelOf(day,true)};})));
  // 3. timeline for the viewed day -------------------------------------------
  const viewRes=resolveRecord(viewRec,d.day,nowMs);
  let summary='',timeline,list='',card=null,layout=null;
  if(viewRes.kind==='ready'){
    layout=layoutTimeline(viewRes.model,{nowMinute:d.day===z.date?z.minute:null});
    if(d.selected&&!layout.blocks.some(b=>b.id===d.selected))d.selected=null;
    summary=daySummary(layout);
    timeline=dv.legendHtml()+(viewRes.stale?'<p class="rd-stale-note" role="status">Stale data: this schedule may have changed. Free time is shown hatched until it is refreshed.</p>':'')+dv.timelineHtml({layout,format:fmt,stale:viewRes.stale,selectedId:d.selected,dayLabel:dayLabelOf(d.day)});
    list=dv.listHtml({layout,format:fmt,selectedId:d.selected});
    const picked=layout.blocks.find(b=>b.id===d.selected);if(picked)card=intervalInfo(picked,fmt);
  }else if(viewRes.kind==='loading')timeline=dv.unavailableHtml({heading:'Loading schedule…',message:'Availability is unknown until the schedule has loaded.',retry:false});
  else timeline=dv.unavailableHtml({heading:viewRes.problem.heading,message:viewRes.problem.message,retry:true,paused});
  setText($('rd-summary'),summary);setHtml($('rd-timeline'),timeline);setHtml($('rd-list'),list);
  const cardEl=$('rd-card');cardEl.hidden=!card;setHtml(cardEl,dv.cardHtml(card));
  const [from,to]=weekBounds(d.day);const url=new URL('https://ethz.ch/staffnet/de/service/raeume-gebaeude/rauminfo/raumdetails/allocation.html');url.searchParams.set('room',room.code);url.searchParams.set('from',from);url.searchParams.set('to',to);
  setHtml($('rd-foot'),`Free means no published reservation; it does not mean the room is empty, open or accessible. Availability is based on ETH's reservation schedule, not actual room occupancy. Blocked intervals (for example type 8) are shown as published and are not treated as opening hours. <a class="source-link" href="${escapeAttr(url.toString())}" target="_blank" rel="noopener noreferrer">View official Belegungsplan ↗</a>`);
  // 3b. student access and room information (static metadata; no request)
  const meta=roomMeta(state.catalog,room.code);
  setHtml($('rd-access'),dv.accessSectionHtml({info:accessInfo(meta),notice:computerRoomNotice(meta)}));
  setHtml($('rd-info-body'),dv.roomInfoHtml({rows:roomInfoRows(meta,state.catalog,room.campus),equipment:equipmentList(meta),accessibility:accessibilityList(meta),other:otherDetails(meta),provenance:provenance(state.catalog),officialUrl:officialRoomUrl(room.code),detailCount:state.catalog.coverage?.withDetail??0}));
  // 4. first scroll position per room and day (today: around now; other days: around 08:00) ----
  const key=`${d.code}|${d.day}`;
  if(layout&&d.scrollKey!==key){d.scrollKey=key;const y=layout.nowTop!==null?layout.nowTop-120:(layout.ticks.find(t=>t.minute===480)?.top??0)-24;const sc=$('rd-scroll'),tl=$('rd-timeline'); // the offset below is measured inside the scroller, not against the fixed overlay
    requestAnimationFrame(()=>{const offset=tl.getBoundingClientRect().top-sc.getBoundingClientRect().top+sc.scrollTop;sc.scrollTop=Math.max(0,offset+y);});}
}
// A tap on a block (or a list row) selects it; a second tap closes the details again.
function selectInterval(id){state.detail.selected=state.detail.selected===id?null:id;renderDetail();}
$('room-detail').addEventListener('click',e=>{
  const t=e.target;
  if(t.closest('#rd-close')){closeRoom();return;}
  if(t.closest('#rd-prev')){setDetailDay(shiftDate(state.detail.day,-1));return;}
  if(t.closest('#rd-next')){setDetailDay(shiftDate(state.detail.day,1));return;}
  if(t.closest('#rd-today')){setDetailDay(zurichParts().date);return;}
  const dayBtn=t.closest('[data-rd-day]');if(dayBtn){setDetailDay(dayBtn.dataset.rdDay);return;}
  const iv=t.closest('[data-interval]');if(iv){selectInterval(iv.dataset.interval);return;}
  if(t.closest('#rd-card-close')){state.detail.selected=null;renderDetail();return;}
  if(t.closest('#rd-refresh')||t.closest('#rd-retry')){refreshDetail();}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.detail.open&&!document.querySelector('dialog[open]')){if(state.detail.selected){state.detail.selected=null;renderDetail();}else closeRoom();}});
window.addEventListener('popstate',()=>{if(state.detail.open)closeRoom(true);});

// ---------- When are requests made? (docs/REQUEST_TRIGGERS.md) ----------
// Failed requests are retried once their backoff has ended, only for rooms the user can currently see. Merely stale data is never refetched here.
function relevantCodes(){const codes=new Set(state.admitted);if(state.detail.open)codes.add(state.detail.code);if(!state.loadingCatalog){const grouped=matchingRooms();for(const r of grouped)if(searchExpands(grouped)||state.expandedBuildings.has(r.building))codes.add(r.code);}return codes;}
function retryErrors(){const days=new Set([zurichParts().date,state.day]);if(state.detail.open)days.add(state.detail.day);const now=Date.now();
  for(const code of relevantCodes())for(const day of days){const key=cacheKey(code,day),rec=state.cache.get(key);if(rec&&rec.state==='error'&&now>=(rec.retryAt||0)&&!state.inflight.has(key))void ensureSchedule(code,day);}}
// Foreground revalidation: when the app comes back to the front, expired schedules are re-requested within the request budget
// (the open room first, then favorites of this campus, then the other checked rooms). At most once per 30 s; never in a hidden tab.
let lastRevalidateAt=0;
function revalidateForeground(){
  if(state.loadingCatalog||state.catalogError||document.hidden)return;
  const now=Date.now();if(now-lastRevalidateAt<30_000)return;lastRevalidateAt=now;
  const ctx=homeCtx(),today=ctx.today,inflightToday=c=>state.inflight.has(cacheKey(c,today));
  let budget=INITIAL_REQUEST_BUDGET,detailCode=null;
  if(state.detail.open){const {code,day}=state.detail,key=cacheKey(code,day);if(!state.inflight.has(key)&&needsRequest(state.cache.get(key),ctx)){detailCode=code;budget--;void ensureSchedule(code,day,true);}}
  const campus=new Set(campusRooms().map(r=>r.code));
  const favs=favoriteRooms(allRooms(),state.favorites).map(r=>r.code).filter(c=>state.admitted.has(c)).sort((a,b)=>campus.has(b)-campus.has(a));
  const candidates=[...favs,...attemptedSet(),...state.admitted].filter(c=>!inflightToday(c)&&!(c===detailCode&&cacheKey(c,state.detail.day)===cacheKey(c,today)));
  for(const code of planRevalidation({candidates,getRecord:todayRecord,ctx,budget}))void ensureSchedule(code,today,true);
}
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
  const open=e.target.closest('[data-open-detail]');if(open){openRoom(open.dataset.openDetail,open);return;} // every room entry opens the same detail screen
  const mode=e.target.closest('[data-mode]');if(mode){state.mode=normalizeMode(mode.dataset.mode);state.showAllRecs=false;store();renderHome();}
});
$('rec-more').addEventListener('click',()=>{state.showAllRecs=!state.showAllRecs;renderHome();});
$('check-more').addEventListener('click',()=>{if(Date.now()<pausedUntil)return;addBatch(MORE_BATCH);renderHome();loadHome();});
$('refresh-stale').addEventListener('click',()=>{if(Date.now()<pausedUntil)return;const day=zurichParts().date;for(const code of summarizeCoverage({rooms:checkedRooms().rooms,attempted:checkedRooms().attempted,getRecord:todayRecord,ctx:homeCtx(),isInflight:c=>state.inflight.has(cacheKey(c,day))}).staleCodes.slice(0,MORE_BATCH)){state.admitted.add(code);void ensureSchedule(code,day,true);}renderHome();}); // manual, bounded refresh
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

async function start(){loadPersistedCache();syncCampusTabs();setText($('app-version'),RUNNING_VERSION||'dev');renderDateStrip();renderAll();try{const [response,metaResponse]=await Promise.all([fetch('/rooms.json'),fetch('/room-metadata.json').catch(()=>null)]);if(!response.ok)throw Error('Cannot load catalog');const list=await response.json();if(!Array.isArray(list))throw Error('Invalid catalog');try{if(metaResponse&&metaResponse.ok)state.catalog=normalizeCatalog(await metaResponse.json());}catch{}state.rooms=list;state.loadingCatalog=false;renderAll();loadHome();}catch{state.loadingCatalog=false;state.catalogError=true;renderAll();}}
start();
// Once a minute the app only RECALCULATES from its cache (time-dependent status, 'now' line, labels). It never requests anything.
setInterval(()=>{if(document.hidden)return;const {date}=zurichParts();if(date!==state.day && state.day===shiftDate(date,-1))setDay(date);else{renderDateStrip();renderAll();}},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){renderDateStrip();renderAll();revalidateForeground();}});
window.addEventListener('pageshow',e=>{if(e.persisted){renderDateStrip();renderAll();revalidateForeground();}});
// ---------- Filters (Stage 4). Everything here is local: changing a filter never makes a request. ----------
function radioHtml(name,options,selected){return options.map(o=>`<label class="radio-pill"><input type="radio" name="${name}" value="${html(o.value)}"${o.value===selected?' checked':''}><span>${html(o.label)}</span></label>`).join('');}
function renderFilterBar(){
  const f=state.filters,n=activeFilterCount(f),btn=$('filters-btn'),count=$('filters-count');
  btn.dataset.active=String(n>0);btn.setAttribute('aria-label',n?`Filters, ${n} active`:'Filters');
  count.hidden=n===0;setText(count,String(n));
  setText($('filter-summary'),filterSummary(f).join(' · '));$('filters-reset').hidden=n===0;
  const lines=state.catalog.valid?coverageNotes(campusRooms(),state.catalog,f):(n>0?['Room metadata could not be loaded, so filters cannot be applied.']:[]);
  if(n>0&&state.catalog.valid)lines.push('Results reflect rooms with verified metadata, not necessarily every room on the campus.');
  const note=$('filter-note');note.hidden=lines.length===0;setText(note,lines.join(' '));
}
function renderFilterResult(){
  const f=state.filters,rooms=campusRooms(),c=filterCoverage(rooms,state.catalog,f,'recommendation'),notes=coverageNotes(rooms,state.catalog,f);
  setText($('fg-access-help'),ACCESS_OPTIONS.find(o=>o.value===f.access).help);
  setText($('filters-result'),isDefaultFilters(f)?`No filters: all ${rooms.length} rooms on this campus are considered.`:`${c.match} of ${rooms.length} rooms on this campus match.${notes.length?' '+notes.join(' '):''}`);
}
function renderFilterDialog(){const f=state.filters;$('fg-type').innerHTML=radioHtml('ft',FILTER_TYPES,f.type);$('fg-capacity').innerHTML=radioHtml('fc',CAPACITY_OPTIONS,f.capacity);$('fg-access').innerHTML=radioHtml('fa',ACCESS_OPTIONS,f.access);$('fg-flexible').checked=f.flexible;renderFilterResult();}
function setFilters(next,{rebuild=false}={}){state.filters=normalizeFilters(next);store();if(rebuild)renderFilterDialog();else renderFilterResult();renderAll();}
$('filters-btn').addEventListener('click',()=>{renderFilterDialog();$('filters-dialog').showModal();});
$('filters-form').addEventListener('change',e=>{const t=e.target;
  if(t.name==='ft')setFilters({...state.filters,type:t.value});else if(t.name==='fc')setFilters({...state.filters,capacity:t.value});
  else if(t.name==='fa')setFilters({...state.filters,access:t.value});else if(t.id==='fg-flexible')setFilters({...state.filters,flexible:t.checked});});
$('filters-reset').addEventListener('click',()=>setFilters(DEFAULT_FILTERS));
$('filters-reset-dialog').addEventListener('click',()=>setFilters(DEFAULT_FILTERS,{rebuild:true}));

// ---------- App updates, pull-to-refresh and the Refresh action (see docs/UPDATES.md) ----------
const swSupported='serviceWorker' in navigator&&window.isSecureContext;
let reloadScheduled=false;
const guardStore={get:k=>{try{return sessionStorage.getItem(k);}catch{return null;}},set:(k,v)=>{try{sessionStorage.setItem(k,v);}catch{}},remove:k=>{try{sessionStorage.removeItem(k);}catch{}}};
function reloadOnce(){if(reloadScheduled)return;reloadScheduled=true;location.reload();}
function updateEnv(){return {
  running:RUNNING_VERSION,installTimeoutMs:30000,storage:guardStore,reload:reloadOnce,
  fetchVersion:()=>fetchDeployedVersion((u,i)=>fetch(u,i)),
  getRegistration:async()=>swSupported?navigator.serviceWorker.getRegistration():undefined,
  waitForControllerChange:ms=>new Promise(resolve=>{const done=v=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',on);resolve(v);};const on=()=>done(true);const timer=setTimeout(()=>done(false),ms);navigator.serviceWorker.addEventListener('controllerchange',on);})
};}
const ptrEl=$('ptr'),ptrText=$('ptr-text');let ptrTimer=null;
function ptrSet(phase,text,distance=0){clearTimeout(ptrTimer);ptrEl.hidden=false;ptrEl.dataset.phase=phase;ptrEl.style.setProperty('--pull',`${distance}px`);ptrEl.style.setProperty('--pull-progress',String(Math.min(1,distance/PULL.threshold)));setText(ptrText,text);}
function ptrHide(delay=0){clearTimeout(ptrTimer);ptrTimer=setTimeout(()=>{ptrEl.dataset.phase='releasing';ptrEl.style.setProperty('--pull','0px');ptrEl.style.setProperty('--pull-progress','0');ptrTimer=setTimeout(()=>{ptrEl.hidden=true;},220);},delay);}
function currentRecommendationCodes(){const {rooms,attempted,ctx}=checkedRooms();return recommend({rooms:rooms.filter(r=>attempted.has(r.code)),mode:state.mode,getRecord:todayRecord,ctx}).slice(0,state.showAllRecs?MAX_SHOWN:INITIAL_SHOWN).map(i=>i.room.code);}
// Refreshes today's prioritized rooms: favorites, then the rooms currently recommended, then the rest; at most the request budget (6).
// Requests go through the shared queue and the Durable Object cache, so a server cache hit is reported as such and keeps its ETH fetch time.
async function refreshReservations(){
  if(Date.now()-state.lastDataRefreshAt<20_000)return 'Already refreshed moments ago';
  if(Date.now()<pausedUntil)return `ETH rate limit active — try again in ${Math.ceil((pausedUntil-Date.now())/1000)} s`;
  const day=zurichParts().date,campus=new Set(campusRooms().map(r=>r.code));
  const favorites=favoriteRooms(allRooms(),state.favorites).map(r=>r.code).filter(c=>state.admitted.has(c)).sort((a,b)=>campus.has(b)-campus.has(a));
  const targets=selectRefreshTargets({favorites,recommended:currentRecommendationCodes(),attempted:[...checkedRooms().attempted]});
  if(!targets.length)return describeRefresh({targets:0});
  state.lastDataRefreshAt=Date.now();
  const before=new Map(targets.map(c=>[c,state.cache.get(cacheKey(c,day))]));
  await Promise.allSettled(targets.map(c=>ensureSchedule(c,day,true)));
  let eth=0,cache=0,failed=0,newest=null;
  for(const c of targets){const rec=state.cache.get(cacheKey(c,day));
    if(rec&&rec!==before.get(c)&&rec.state==='ready'){if(rec.fromCache)cache++;else eth++;if(rec.fetchedAt&&(!newest||Date.parse(rec.fetchedAt)>Date.parse(newest)))newest=rec.fetchedAt;}else failed++;}
  return describeRefresh({targets:targets.length,eth,cache,failed,newest:newest?zurichClock(newest):null});
}
async function refreshAll(){
  if(state.refreshing)return;
  state.refreshing=true;$('refresh-app').disabled=true;
  let reloading=false;
  ptrSet('loading',swSupported?'Checking for updates…':'Refreshing…');
  try{
    const update=await checkAndApply(updateEnv());                              // zero ETH requests: static files only
    if(update.outcome==='reloading'){reloading=true;ptrSet('loading',UPDATE_MESSAGES.reloading);return;}
    ptrSet('loading','Refreshing availability…');
    const data=await refreshReservations();
    ptrSet('done',[UPDATE_MESSAGES[update.outcome],data].filter(Boolean).join(' · '));ptrHide(4000);
  }catch{ptrSet('done','Refresh failed');ptrHide(3000);}
  finally{if(!reloading){state.refreshing=false;$('refresh-app').disabled=false;}}
}
attachPullToRefresh({
  onTrigger:()=>refreshAll(),isBlocked:target=>isPullBlocked(target,{detailOpen:state.detail.open}),
  ui:{pull:(distance,phase)=>{if(!state.refreshing)ptrSet(phase,phase==='ready'?'Release to refresh':'Pull to refresh',distance);},release:(triggered,engaged)=>{if(!triggered&&!state.refreshing&&engaged)ptrHide(0);}}
});
$('refresh-app').addEventListener('click',()=>refreshAll());
function showUpdateBanner(){$('update-banner').hidden=false;}
$('update-now').addEventListener('click',async()=>{const r=await applyWaiting(updateEnv(),'banner');if(r.outcome==='pending'||r.outcome==='none'){ptrSet('done',UPDATE_MESSAGES.pending);ptrHide(5000);}else ptrSet('loading',UPDATE_MESSAGES.reloading);});
if(swSupported){
  navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).then(async reg=>{          // updateViaCache none: sw.js AND sw-version.js are always revalidated
    await applyOnLaunch(updateEnv()).catch(()=>{});                                          // an update that finished installing while the app was closed is applied now, once per session
    if(reg.waiting&&navigator.serviceWorker.controller)showUpdateBanner();
    reg.addEventListener('updatefound',()=>{const worker=reg.installing;if(worker)worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)showUpdateBanner();});});
  }).catch(()=>{});
  let hadController=Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange',()=>{ // another tab activated a new version: reload once so this page matches the active worker
    if(!hadController){hadController=true;return;}
    if(reloadScheduled||guardStore.get('openroom-ctrl-reload'))return;
    guardStore.set('openroom-ctrl-reload','1');reloadOnce();});
}
