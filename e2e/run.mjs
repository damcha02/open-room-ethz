/** Browser interaction tests for the home screen. Run: npm run test:e2e
 * Needs a Chromium/Chrome binary (set CHROMIUM=/path to override); exits 0 with a notice if none is found.
 * Everything runs locally against a mock ETH server; the page clock is frozen at Wed 2026-11-18 10:00 Europe/Zurich. */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startMock} from './mock-eth.mjs';
import {launch, findChromium, fakeClockScript, sleep} from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'e2e', 'screenshots');
const binary = findChromium();
if (!binary) { console.log('e2e: no Chromium/Chrome found (set CHROMIUM=...). Skipping browser tests.'); process.exit(0); }
fs.mkdirSync(shots, {recursive: true});

const NOW_ISO = '2026-11-18T09:00:00Z'; // 10:00 Zurich (CET)
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public', 'rooms.json'), 'utf8'));
const ZENTRUM_TOTAL = catalog.filter(r => r.campus === 'Zentrum').length;
const results = [];
const check = (name, ok, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '\n        → ' + detail : ''}`); };
const rand = () => 41000 + Math.floor(Math.random() * 3000);

// What each mock scenario must produce at 10:00 (derived from docs/UX_SPEC.md, independent of the app code).
const EXPECT = {
  now: {S0: {k: 720, h: 'Free until 22:00', d: 'Next: Blocked 22:00–24:00'}, S4: {k: 300, h: 'Free until 15:00', d: 'Next: Booked 15:00–16:00'}, S5: {k: 35, h: 'Free until 10:35', d: 'Next: Booked 10:35–11:00'}},
  soon: {S1: {k: 660, dur: 180, h: 'Free in 60 min', d: '11:00–14:00 · 3 h'}},
  rest: {
    S0: {k: 600, dur: 720, h: 'Free now until 22:00'}, S5: {k: 660, dur: 660, h: 'Free from 11:00 until 22:00'},
    S2: {k: 720, dur: 600, h: 'Free from 12:00 until 22:00'}, S3: {k: 780, dur: 540, h: 'Free from 13:00 until 22:00'},
    S1: {k: 960, dur: 360, h: 'Free from 16:00 until 22:00'}, S4: {k: 960, dur: 360, h: 'Free from 16:00 until 22:00'}
  }
};
const SORT = {now: (a, b) => b.k - a.k, soon: (a, b) => a.k - b.k || b.dur - a.dur, rest: (a, b) => a.k - b.k || b.dur - a.dur};
function expectedCards(mode, scenarios, extra = []) {
  const items = [...Object.entries(scenarios).map(([code, sc]) => ({code, ...EXPECT[mode][sc]})), ...extra].filter(i => i.h);
  return items.sort((a, b) => SORT[mode](a, b) || a.code.localeCompare(b.code, undefined, {numeric: true}));
}

async function startStack(env = {}) {
  const mockPort = rand(), appPort = mockPort + 5000;
  const mock = await startMock(mockPort);
  const server = spawn(process.execPath, ['server.mjs'], {cwd: root, stdio: ['ignore', 'pipe', 'inherit'],
    env: {...process.env, PORT: String(appPort), ETH_ENDPOINT: `http://127.0.0.1:${mockPort}/bin/ethz/roominfo`, ETH_MIN_INTERVAL_MS: '50', ...env}});
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('exit', reject); setTimeout(() => reject(new Error('app server did not start')), 8000); });
  return {mock, url: `http://127.0.0.1:${appPort}/`, stop() { server.kill(); mock.close(); }};
}
async function openBrowser(name) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `openroom-e2e-${name}-`));
  const b = await launch({binary, port: rand() + 100, profile});
  const clock = {id: await b.initScript(fakeClockScript(NOW_ISO))};
  b.setClock = async shiftMinutes => { await b.removeInitScript(clock.id); clock.id = await b.initScript(fakeClockScript(NOW_ISO, shiftMinutes)); };
  b.cleanup = () => { b.close(); try { fs.rmSync(profile, {recursive: true, force: true}); } catch {} };
  return b;
}
const cards = b => b.ev(`JSON.stringify([...document.querySelectorAll('#recommendations .rec-card')].map(c=>({code:c.querySelector('.rec-code').textContent,h:c.querySelector('.rec-headline').textContent,d:c.querySelector('.rec-detail').textContent})))`).then(JSON.parse);
const text = (b, sel) => b.ev(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim()||''`);
const click = (b, sel) => b.ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const settle = async (b, ms = 700) => { await sleep(ms); };
const apiCalls = b => b.ev(`performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/allocations')).length`);
const requested = stats => Object.keys(stats.alloc);
const totalAlloc = stats => Object.values(stats.alloc).reduce((a, c) => a + c, 0);

// ---------------------------------------------------------------- phase 1
async function phase1() {
  console.log('\n# Phase 1: new visitor, modes, batches, persistence, time, favorites, browse, rate limit');
  const stack = await startStack(); const b = await openBrowser('p1');
  try {
    await b.nav(stack.url);
    check('page loads without console errors or exceptions', b.errors.length === 0, b.errors.join(' | '));
    check('home hierarchy: header, campus, find-a-room, coverage, browse (Favorites hidden while empty)', await b.ev(`(()=>{
      const tops=['.topbar','.campus-tabs','.find-section','#coverage','.browse-section'].map(s=>{const e=document.querySelector(s);return e?e.getBoundingClientRect().top+scrollY:NaN;});
      return tops.every((v,i)=>!Number.isNaN(v)&&(i===0||v>tops[i-1]))&&document.getElementById('favorites-section').hidden===true;})()`));
    check('only two campus buttons (Zentrum, Hönggerberg); Zentrum selected by default', await b.ev(`JSON.stringify([...document.querySelectorAll('.campus-tab')].map(t=>[t.dataset.campus,t.getAttribute('aria-pressed')]))`) === '[["Zentrum","true"],["Hönggerberg","false"]]');
    check('"Free now" is the default mode', await b.ev(`document.querySelector('.mode-btn[aria-pressed=true]').dataset.mode`) === 'now');

    const loaded = await b.waitFor(`/based on 6 of \\d+ listed rooms checked/.test(document.getElementById('coverage-text').textContent)`, 20000);
    check(`coverage says "based on 6 of ${ZENTRUM_TOTAL} listed rooms checked" after the first batch`, loaded, await text(b, '#coverage-text'));
    await settle(b);
    let st = await (await fetch(`http://127.0.0.1:${new URL(stack.url).port - 5000}/__stats`)).json();
    check('first visit made exactly 6 ETH requests (no favorites, empty cache), one room each', requested(st).length === 6 && totalAlloc(st) === 6 && st.total === 6, JSON.stringify(st.alloc));
    check('first visit requested no room-existence checks (all schedules were non-empty)', Object.keys(st.info).length === 0);
    check('the catalog (129 rooms) was NOT fetched: requests are far fewer than the room count', st.total < 10 && catalog.length > 100);
    const mockApi = stack.mock;
    const expectNow = expectedCards('now', st.scenarios);
    const nowCards = await cards(b);
    check('Free now: cards match the expected rooms, sorted by longest remaining time', JSON.stringify(nowCards.map(c => [c.code, c.h, c.d])) === JSON.stringify(expectNow.slice(0, 3).map(i => [i.code, i.h, i.d])), JSON.stringify({got: nowCards, want: expectNow}));
    check('Free now never lists a booked room (S1), a type-13 blocked room (S2) or a room with <30 min (S3)', nowCards.every(c => ['S0', 'S4', 'S5'].includes(st.scenarios[c.code])));
    check('no "Show more" when only 3 rooms match', await b.ev(`document.getElementById('rec-more').hidden`) === true);
    await b.screenshot(path.join(shots, 'home-free-now.png'));

    await click(b, '.mode-btn[data-mode=soon]'); await settle(b, 200);
    const soonCards = await cards(b), wantSoon = expectedCards('soon', st.scenarios);
    check('Free soon: only the room that becomes unbooked within 60 minutes, "Free in 60 min"', JSON.stringify(soonCards.map(c => [c.code, c.h, c.d])) === JSON.stringify(wantSoon.map(i => [i.code, i.h, i.d])) && soonCards.length === 1, JSON.stringify({soonCards, wantSoon}));
    await click(b, '.mode-btn[data-mode=rest]'); await settle(b, 200);
    const restWant = expectedCards('rest', st.scenarios);
    let restCards = await cards(b);
    check('Rest of day: earliest availability first, exact "Free from … until 22:00" wording', JSON.stringify(restCards.map(c => [c.code, c.h])) === JSON.stringify(restWant.slice(0, 3).map(i => [i.code, i.h])), JSON.stringify({restCards, restWant}));
    check('Rest of day: overnight wording is supported by the data; "Free for the rest of the day" only where the free interval already started; no opening-hours claim', restCards.every(c => /no later reservations before overnight block/i.test(c.d)) && restCards.every(c => /^Free for the rest of the day/.test(c.d) === /^Free now/.test(c.h)) && !restCards.some(c => /open|clos/i.test(c.h + c.d)), JSON.stringify(restCards));
    check('"Show 3 more" appears when 6 rooms match and expands to all 6, then collapses', await (async () => {
      const label = await text(b, '#rec-more'); const visible = await b.ev(`!document.getElementById('rec-more').hidden`);
      await click(b, '#rec-more'); await settle(b, 150); const all = await cards(b); const fewer = await text(b, '#rec-more');
      await click(b, '#rec-more'); await settle(b, 150); const back = await cards(b);
      return visible && label === 'Show 3 more' && all.length === 6 && fewer === 'Show fewer' && back.length === 3 && JSON.stringify(all.map(c => c.code)) === JSON.stringify(restWant.map(i => i.code));
    })());
    await b.screenshot(path.join(shots, 'home-rest-of-day.png'));
    await click(b, '.mode-btn[data-mode=now]'); await settle(b, 150);

    // keyboard
    await b.ev(`document.querySelector('.mode-btn[data-mode=soon]').focus()`); await b.press('Enter'); await settle(b, 150);
    check('keyboard: Enter on a focused mode button activates it', await b.ev(`document.querySelector('.mode-btn[aria-pressed=true]').dataset.mode`) === 'soon');
    await b.ev(`document.querySelector('.mode-btn[data-mode=now]').focus()`); await b.press(' '); await settle(b, 150);
    check('keyboard: Space activates a mode button; all interactive elements are real buttons or links', await b.ev(`document.querySelector('.mode-btn[aria-pressed=true]').dataset.mode`) === 'now'
      && await b.ev(`![...document.querySelectorAll('[data-open-detail],[data-mode],[data-campus],[data-favorite]')].some(e=>!['BUTTON','A'].includes(e.tagName))`));

    // second batch
    const before = totalAlloc(st);
    check('"Check more rooms" is offered with a batch size of 6', /^Check 6 more rooms$/.test(await text(b, '#check-more')), await text(b, '#check-more'));
    await click(b, '#check-more');
    check('second batch: coverage grows to 12 rooms', await b.waitFor(`/based on 12 of/.test(document.getElementById('coverage-text').textContent)`, 20000), await text(b, '#coverage-text'));
    await sleep(1500);
    st = await (await fetch(`http://127.0.0.1:${new URL(stack.url).port - 5000}/__stats`)).json();
    check('"Check more rooms" requested exactly 6 more rooms and nothing repeated by itself', totalAlloc(st) === before + 6 && requested(st).length === 12, `alloc=${totalAlloc(st)}`);
    const now12 = expectedCards('now', st.scenarios), shown12 = await cards(b);
    check('Free now after 12 rooms: top 3 correct, "Show 3 more" lists all 6 matches', JSON.stringify(shown12.map(c => c.code)) === JSON.stringify(now12.slice(0, 3).map(i => i.code)) && now12.length === 6 && await text(b, '#rec-more') === 'Show 3 more', JSON.stringify({shown12, now12}));
    await click(b, '#rec-more'); await settle(b, 150);
    check('"Show more" reveals additional checked results in ranking order', JSON.stringify((await cards(b)).map(c => c.code)) === JSON.stringify(now12.map(i => i.code)));
    await click(b, '#rec-more');
    await b.screenshot(path.join(shots, 'home-after-check-more.png'));

    // layout at 375 px
    check('no horizontal scrolling at 375 px', await b.ev(`document.documentElement.scrollWidth<=window.innerWidth`));
    const small = await b.ev(`JSON.stringify([...document.querySelectorAll('.icon-button,.campus-tab,.mode-btn,.rec-main,.favorite-btn,#check-more,#rec-more,.small-button,.nav-arrow,.add-room-link,.day-btn,.building-head,.refresh-btn')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {c:e.className||e.id,w:Math.round(r.width),h:Math.round(r.height)}}).filter(x=>x.h<44||x.w<44))`);
    check('all buttons are at least 44×44 px', small === '[]', small);

    // persistence + clock-driven recalculation
    await click(b, '.mode-btn[data-mode=rest]');
    await sleep(900); // let the persisted cache flush (500 ms debounce)
    await b.nav(stack.url);
    check('mode is remembered across a reload', await b.ev(`document.querySelector('.mode-btn[aria-pressed=true]').dataset.mode`) === 'rest');
    await click(b, '.mode-btn[data-mode=now]'); await sleep(900);
    const totalBeforeShift = (await (await fetch(`http://127.0.0.1:${new URL(stack.url).port - 5000}/__stats`)).json()).total;
    await b.setClock(6); // from now on the page clock is 10:06: S5 has only 29 of its 35 minutes left
    await b.nav(stack.url);
    await b.waitFor(`document.querySelector('#recommendations .rec-card')`, 8000);
    await settle(b);
    st = await (await fetch(`http://127.0.0.1:${new URL(stack.url).port - 5000}/__stats`)).json();
    const afterShift = await cards(b);
    check('reload shows cached rooms immediately; 6 minutes later S5 (35 → 29 min left) dropped out of Free now', afterShift.length >= 1 && !afterShift.some(c => st.scenarios[c.code] === 'S5') && afterShift.every(c => ['S0', 'S4'].includes(st.scenarios[c.code])), JSON.stringify(afterShift));
    check('the home clock shows the Zurich time and no request was made to ETH or to our API for it', await text(b, '#home-time') === 'Zurich · 10:06' && st.total === totalBeforeShift && (await apiCalls(b)) === 0, JSON.stringify({time: await text(b, '#home-time'), total: st.total, before: totalBeforeShift, api: await apiCalls(b)}));
    await b.ev(`document.querySelector('.campus-tab[data-campus="Hönggerberg"]').click()`);
    check('campus choice is stored locally', await b.ev(`JSON.parse(localStorage.getItem('openroom-prefs-v1')).campus`) === 'Hönggerberg');
    await b.waitFor(`/based on|checked\\./.test(document.getElementById('coverage-text').textContent)`, 20000);
    await sleep(900);
    await b.nav(stack.url);
    check('campus and mode are applied on load (Hönggerberg + Free now)', await b.ev(`document.querySelector('.campus-tab.selected').dataset.campus`) === 'Hönggerberg' && await b.ev(`document.querySelector('.mode-btn[aria-pressed=true]').dataset.mode`) === 'now');
    await b.ev(`document.querySelector('.campus-tab[data-campus="Zentrum"]').click()`); await settle(b, 300);

    // favorites: both campuses, independent of filters
    const firstCard = (await cards(b))[0].code;
    await b.ev(`document.querySelector('#recommendations .rec-card [data-favorite]').click()`); await settle(b, 150);
    check('starring a recommendation makes the Favorites section appear', await b.ev(`!document.getElementById('favorites-section').hidden`) && await b.ev(`document.querySelector('#favorites-list .rec-code').textContent`) === firstCard);
    await b.ev(`document.querySelector('.campus-tab[data-campus="Hönggerberg"]').click()`); await settle(b, 1200);
    const hRoom = await b.ev(`(()=>{document.querySelector('.building-head').click();return document.querySelector('.building-rooms .room-code')?.textContent||null;})()`);
    await b.waitFor(`document.querySelector('.building-rooms .favorite-btn')`, 3000);
    await b.ev(`document.querySelector('.building-rooms .favorite-btn').click()`); await settle(b, 150);
    const favCodes = async () => b.ev(`JSON.stringify([...document.querySelectorAll('#favorites-list .rec-code')].map(e=>e.textContent))`).then(JSON.parse);
    let favs = await favCodes();
    check('Favorites holds rooms from BOTH campuses', favs.length === 2 && favs.includes(firstCard) && favs.includes(hRoom), JSON.stringify({favs, firstCard, hRoom}));
    await click(b, '.mode-btn[data-mode=rest]'); await b.ev(`(()=>{const c=document.getElementById('free-only');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));})()`); await settle(b, 200);
    favs = await favCodes();
    check('Favorites stay visible when the mode changes, the campus changes and free-only is on', favs.length === 2 && await b.ev(`!document.getElementById('favorites-section').hidden`));
    check('Favorites show a textual status (never blank) for rooms in either campus', await b.ev(`[...document.querySelectorAll('#favorites-list .status-text')].every(e=>e.textContent.trim().length>0)`));
    await b.screenshot(path.join(shots, 'home-favorites-two-campuses.png'));
    await b.ev(`(()=>{const c=document.getElementById('free-only');c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click(b, '.mode-btn[data-mode=now]');
    await b.ev(`document.querySelector('.campus-tab[data-campus="Zentrum"]').click()`); await settle(b, 300);
    await b.ev(`document.querySelectorAll('#favorites-list [data-favorite]').forEach(()=>0)`);
    // remove a favorite from the section itself
    await b.ev(`document.querySelector('#favorites-list [data-favorite]').click()`); await settle(b, 150);
    check('a favorite can be removed from the Favorites section', (await favCodes()).length === 1);
    await b.ev(`document.querySelector('#favorites-list [data-favorite]').click()`); await settle(b, 150);
    check('with no favorites the section is hidden again', await b.ev(`document.getElementById('favorites-section').hidden`));

    // detail screen (covered in depth in phase 7): opens from a card, closes again
    await b.ev(`document.querySelector('#recommendations .rec-main').click()`); await settle(b, 200);
    check('tapping a recommendation opens the room-detail screen; closing returns to the home screen', await b.ev(`!document.getElementById('room-detail').hidden&&document.querySelector('.app-shell').inert===true`));
    await click(b, '#rd-close'); await settle(b, 200);
    check('the home screen is usable again after closing the detail screen', await b.ev(`document.getElementById('room-detail').hidden&&document.querySelector('.app-shell').inert===false`));

    // browse is preserved
    await b.ev(`document.getElementById('search-btn').click()`); await settle(b, 150);
    check('header search icon focuses the search field', await b.ev(`document.activeElement.id`) === 'room-search');
    await b.ev(`(()=>{const i=document.getElementById('room-search');i.value='HG E 2';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    check('browse: a narrow search auto-expands its building and lists matching rooms', await b.waitFor(`document.querySelectorAll('#room-results .room-entry').length>=1`, 8000));
    await b.ev(`(()=>{const i=document.getElementById('room-search');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await b.ev(`document.querySelector('#room-results .building-head').click()`); await settle(b, 200);
    check('browse: tapping a building expands its rooms', await b.ev(`document.querySelectorAll('#room-results .room-entry').length>0`));
    await b.ev(`document.querySelector('#room-results .room-main').click()`); await settle(b, 200);
    check('browse: tapping a room opens its detail screen', await b.ev(`!document.getElementById('room-detail').hidden`));
    await click(b, '#rd-close'); await settle(b, 150);
    const day = await b.ev(`(()=>{const x=[...document.querySelectorAll('.day-btn')].find(d=>!d.classList.contains('today'));x.click();return x.dataset.day;})()`);
    check('browse: the date strip changes the day', await b.ev(`document.querySelector('.day-btn.selected').dataset.day`) === day);
    check('home recommendations are independent of the browsed day (the home clock still shows today)', /^Zurich · 10:0\d$/.test(await text(b, '#home-time')));
    await b.ev(`(()=>{const c=document.getElementById('free-only');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));})()`); await settle(b, 300);
    const freeOnlyView = await b.ev(`JSON.stringify({rooms:[...document.querySelectorAll('#room-results .room-entry')].map(e=>e.querySelector('.room-status').className),meta:document.querySelector('#room-results .building-meta').textContent,caption:document.getElementById('list-caption').textContent})`).then(JSON.parse);
    check('browse: free-only lists only rooms confirmed free (every row is free) and says so in the caption', freeOnlyView.rooms.length > 0 && freeOnlyView.rooms.every(c => c.includes('status-free')) && /free-only lists only confirmed-free rooms/.test(freeOnlyView.caption), JSON.stringify(freeOnlyView));
    check('free-only does not touch the recommendations', (await cards(b)).length > 0);
    await b.ev(`(()=>{const c=document.getElementById('free-only');c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));})()`);

    // rate limit
    st = await (await fetch(`http://127.0.0.1:${new URL(stack.url).port - 5000}/__stats`)).json();
    const hits0 = totalAlloc(st), roomsBefore = new Set(requested(st));
    mockApi.setRate429(true);
    await b.ev(`document.querySelector('.campus-tab[data-campus="Hönggerberg"]').click()`); await settle(b, 300);
    await click(b, '#check-more');
    check('rate limit: the coverage reports rate limiting and the check-more button pauses', await b.waitFor(`/rate limit|limiting|Paused/i.test(document.getElementById('coverage').innerText)&&document.getElementById('check-more').disabled`, 15000), await b.ev(`document.getElementById('coverage').innerText`));
    await sleep(1500);
    st = await (await fetch(`http://127.0.0.1:${new URL(stack.url).port - 5000}/__stats`)).json();
    check('rate limit: at most 2 requests reached ETH, then everything paused (no burst, no hammering)', totalAlloc(st) - hits0 <= 2, `burst=${totalAlloc(st) - hits0}`);
    await sleep(1500);
    const st2 = await (await fetch(`http://127.0.0.1:${new URL(stack.url).port - 5000}/__stats`)).json();
    check('rate limit: no further requests while paused', totalAlloc(st2) === totalAlloc(st), `${totalAlloc(st)} → ${totalAlloc(st2)}`);
    const limitedRooms = new Set(requested(st2).filter(r => !roomsBefore.has(r)));
    check('rate limit: rooms that were rate limited are never recommended; earlier fresh results stay', limitedRooms.size >= 1 && (await cards(b)).every(c => !limitedRooms.has(c.code)));
    await b.screenshot(path.join(shots, 'home-rate-limited.png'));
    check('no console exceptions during the whole phase', b.errors.filter(e => !/429|503|Failed to load resource/.test(e)).length === 0, b.errors.join(' | '));
  } finally { b.cleanup(); stack.stop(); }
}

// ---------------------------------------------------------------- phase 2
async function phase2() {
  console.log('\n# Phase 2: favorites with an unknown room, a failing room and a verified-empty room');
  const stack = await startStack(); const b = await openBrowser('p2');
  const port = new URL(stack.url).port - 5000;
  try {
    await b.initScript(`if(!localStorage.getItem('openroom-prefs-v1'))localStorage.setItem('openroom-prefs-v1',JSON.stringify({favorites:['HG E 21','HG E 22','HG E 23','HCI D 2']}));`);
    await b.nav(stack.url);
    check('page loads without console errors', b.errors.filter(e => !/Failed to load resource/.test(e)).length === 0, b.errors.join(' | '));
    check('favorites from both campuses are listed immediately (4 rows)', await b.waitFor(`document.querySelectorAll('#favorites-list .fav-entry').length===4`, 5000));
    await b.waitFor(`/checked\\./.test(document.getElementById('coverage-text').textContent)||/based on/.test(document.getElementById('coverage-text').textContent)`, 20000);
    await settle(b, 1500);
    const statuses = await b.ev(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('#favorites-list .fav-entry')].map(e=>[e.querySelector('.rec-code').textContent,[e.querySelector('.room-status').className.replace('room-status ',''),e.querySelector('.status-text').textContent]])))`).then(JSON.parse);
    check('verified-empty room (HG E 21) is shown as free with its text', statuses['HG E 21']?.[0] === 'status-free', JSON.stringify(statuses));
    check('unknown room (HG E 22, ETH 200 []) is "Room not found at ETH", never free', statuses['HG E 22']?.[0] === 'status-unknown' && /not found/i.test(statuses['HG E 22'][1]), JSON.stringify(statuses['HG E 22']));
    check('failing room (HG E 23, ETH 500) is "Schedule unavailable", never free', statuses['HG E 23']?.[0] === 'status-unknown' && /unavailable/i.test(statuses['HG E 23'][1]), JSON.stringify(statuses['HG E 23']));
    const recs = await cards(b);
    check('Free now: the verified-empty room is recommended with the narrower "no later reservations listed" wording', recs.some(c => c.code === 'HG E 21' && /no later reservations listed today/i.test(c.h + c.d)), JSON.stringify(recs));
    check('Free now: the unknown and the failing rooms are never recommended (any mode)', await (async () => {
      for (const mode of ['now', 'soon', 'rest']) { await click(b, `.mode-btn[data-mode=${mode}]`); await settle(b, 150); await click(b, '#rec-more').catch(() => {}); const c = await cards(b); if (c.some(x => x.code === 'HG E 22' || x.code === 'HG E 23')) return false; }
      return true;
    })());
    await click(b, '.mode-btn[data-mode=now]');
    const cov = await text(b, '#coverage-detail');
    check('coverage names the unavailable and unverified rooms', /1 unavailable/.test(cov) && /1 not verified/.test(cov), cov);
    const st = await (await fetch(`http://127.0.0.1:${port}/__stats`)).json();
    check('one shared budget: 4 favorites + 2 discovery rooms = exactly 6 schedule requests from the browser, plus 2 server-side room-existence checks', totalAlloc(st) === 6 && (await apiCalls(b)) === 6 && Object.keys(st.info).length === 2, JSON.stringify({alloc: st.alloc, info: st.info, api: await apiCalls(b)}));
    check('wording: no "Unbooked"/"Reserved" anywhere on the home screen; the information text is in Settings', await b.ev(`!/Unbooked|Reserved/i.test(document.body.innerText)`) && await b.ev(`(()=>{document.getElementById('settings-btn').click();const t=document.getElementById('settings-dialog').innerText;document.getElementById('settings-dialog').close();return t.includes("Availability is based on ETH's reservation schedule, not actual room occupancy.");})()`));
    await b.screenshot(path.join(shots, 'home-favorites-unknown-rooms.png'));
  } finally { b.cleanup(); stack.stop(); }
}

// ---------------------------------------------------------------- phase 3
async function phase3() {
  console.log('\n# Phase 3: ETH rate limits every request from the very start');
  const stack = await startStack(); stack.mock.setRate429(true); const b = await openBrowser('p3');
  const port = new URL(stack.url).port - 5000;
  try {
    await b.nav(stack.url);
    check('rate-limited start: coverage explains rate limiting (not "no rooms free")', await b.waitFor(`/limiting requests|Paused|rate limit/i.test(document.getElementById('coverage').innerText)`, 15000), await b.ev(`document.getElementById('coverage').innerText`));
    check('rate-limited start: no recommendation cards, and the empty state points to the status below', await b.ev(`document.querySelectorAll('#recommendations .rec-card').length===0&&/status below|Looking for/.test(document.getElementById('recommendations').innerText)`));
    check('rate-limited start: coverage is styled as a warning (data-kind=rateLimited)', await b.ev(`document.getElementById('coverage').dataset.kind`) === 'rateLimited');
    await sleep(1500);
    const st = await (await fetch(`http://127.0.0.1:${port}/__stats`)).json();
    check('rate-limited start: at most 2 requests reached ETH', st.total <= 2, JSON.stringify(st.alloc));
    await b.screenshot(path.join(shots, 'home-rate-limited-start.png'));
  } finally { b.cleanup(); stack.stop(); }
}

// ---------------------------------------------------------------- phase 4
async function phase4() {
  console.log('\n# Phase 4: initial request budget — 9 favorites on a fresh visit');
  const byCode = (a, b) => a.localeCompare(b, undefined, {numeric: true});
  const zen = catalog.filter(r => r.campus === 'Zentrum').slice(0, 5).map(r => r.code);
  const hon = catalog.filter(r => r.campus === 'Hönggerberg').slice(0, 4).map(r => r.code);
  const favs = [...zen, ...hon];
  const firstOther = [...hon].sort(byCode)[0];
  const stack = await startStack(); const b = await openBrowser('p4');
  const port = new URL(stack.url).port - 5000;
  const stats = async () => (await fetch(`http://127.0.0.1:${port}/__stats`)).json();
  try {
    await b.initScript(`if(!localStorage.getItem('openroom-prefs-v1'))localStorage.setItem('openroom-prefs-v1',JSON.stringify({favorites:${JSON.stringify(favs)}}));`);
    await b.nav(stack.url);
    check('all 9 favorites are visible immediately, even before any schedule has loaded', await b.waitFor(`document.querySelectorAll('#favorites-list .fav-entry').length===9`, 5000));
    await b.waitFor(`document.querySelectorAll('#favorites-list .status-loading').length===0`, 20000);
    await sleep(1500);
    let st = await stats();
    check('a fresh visit with 9 favorites made exactly 6 schedule requests (browser and ETH side)', totalAlloc(st) === 6 && (await apiCalls(b)) === 6, JSON.stringify({alloc: st.alloc, api: await apiCalls(b)}));
    check('priority: the 5 favorites of the selected campus first, then ONE favorite of the other campus, no discovery', JSON.stringify(requested(st).sort(byCode)) === JSON.stringify([...zen, firstOther].sort(byCode)), JSON.stringify(requested(st)));
    const rows = await b.ev(`JSON.stringify([...document.querySelectorAll('#favorites-list .fav-entry')].map(e=>[e.querySelector('.rec-code').textContent,e.querySelector('.status-text').textContent]))`).then(JSON.parse);
    const unchecked = rows.filter(r => r[1] === 'Not checked yet').map(r => r[0]);
    check('the 3 favorites over budget stay visible with the label "Not checked yet" (not "Checking…", not Free)', unchecked.length === 3 && unchecked.every(c => hon.includes(c) && c !== firstOther), JSON.stringify(rows));
    check('coverage counts only what was checked (5 favorites of the campus) and the section offers "Check 3 favorites"', /based on 5 of \d+ listed rooms/.test(await text(b, '#coverage-text')) && await text(b, '#check-favorites') === 'Check 3 favorites', `${await text(b, '#coverage-text')} | ${await text(b, '#check-favorites')}`);
    await b.screenshot(path.join(shots, 'home-favorites-over-budget.png'));
    // deliberate interaction 1: open one unchecked favorite
    await b.ev(`[...document.querySelectorAll('#favorites-list .fav-entry')].find(e=>e.querySelector('.status-text').textContent==='Not checked yet').querySelector('.fav-main').click()`);
    await b.waitFor(`!document.getElementById('room-detail').hidden&&document.querySelector('#rd-timeline .tl')`, 8000);
    await sleep(800);
    await click(b, '#rd-close'); await sleep(300);
    st = await stats();
    check('opening an unchecked favorite loads exactly that one room (+1 request)', totalAlloc(st) === 7 && (await apiCalls(b)) === 7, JSON.stringify(st.alloc));
    // deliberate interaction 2: the bounded "Check favorites" action
    await click(b, '#check-favorites');
    await b.waitFor(`document.getElementById('check-favorites').hidden`, 8000);
    await sleep(1200);
    st = await stats();
    check('"Check favorites" loads the remaining 2 and then disappears; still no discovery requests', totalAlloc(st) === 9 && requested(st).every(c => favs.includes(c)) && await b.ev(`document.getElementById('check-favorites').hidden`), JSON.stringify(st.alloc));
    await sleep(900);
    await b.nav(stack.url);
    await b.waitFor(`document.querySelectorAll('#favorites-list .fav-entry').length>=8`, 5000);
    await sleep(1200);
    const reloaded = await stats();
    const newRooms = requested(reloaded).filter(c => !requested(st).includes(c));
    check('reload with all 9 favorites fresh in the browser cache: none of them is requested again, no "Not checked yet"; only 1 discovery room tops the candidates up to six', totalAlloc(reloaded) === totalAlloc(st) + 1 && (await apiCalls(b)) === 1 && newRooms.length === 1 && !favs.includes(newRooms[0]) && await b.ev(`![...document.querySelectorAll('#favorites-list .status-text')].some(e=>e.textContent==='Not checked yet')`), `${totalAlloc(st)} → ${totalAlloc(reloaded)}, api=${await apiCalls(b)}, new=${newRooms}`);
    check('starring and un-starring never request anything', await (async () => {
      const before = totalAlloc(await stats()), api0 = await apiCalls(b);
      await b.ev(`document.querySelector('#favorites-list [data-favorite]').click()`); await sleep(400);
      await b.ev(`document.querySelector('#room-results [data-favorite], #recommendations [data-favorite]')?.click()`); await sleep(400);
      return totalAlloc(await stats()) === before && (await apiCalls(b)) === api0;
    })());
    check('no console errors in phase 4', b.errors.filter(e => !/Failed to load resource/.test(e)).length === 0, b.errors.join(' | '));
  } finally { b.cleanup(); stack.stop(); }
}

// ---------------------------------------------------------------- phase 5
async function phase5() {
  console.log('\n# Phase 5: freshness follows the ORIGINAL ETH timestamp (old answers served by a cache)');
  const stack = await startStack(); const b = await openBrowser('p5');
  const port = new URL(stack.url).port - 5000;
  const stats = async () => (await fetch(`http://127.0.0.1:${port}/__stats`)).json();
  try {
    // The proxy is made to answer with ETH data that is 15 minutes old (as a server or CDN cache could), received just now.
    await b.initScript(`window.__oldAgeMs=900000;(()=>{const f=window.fetch;window.fetch=async(...a)=>{const r=await f(...a);if(String(a[0]).includes('/api/allocations')&&window.__oldAgeMs){const j=await r.clone().json();j.ageMs=window.__oldAgeMs;j.fetchedAt=new Date(Date.now()-window.__oldAgeMs).toISOString();return new Response(JSON.stringify(j),{status:r.status,headers:r.headers});}return r;};})();`);
    await b.nav(stack.url);
    await b.waitFor(`performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/allocations')).length>=6`, 20000);
    await sleep(1500);
    check('answers that were 15 min old at the source are NOT recommendations, although the browser cache was just populated', (await cards(b)).length === 0, JSON.stringify(await cards(b)));
    check('the coverage line says the data is older than 10 minutes (stale) and offers a manual refresh — it does not claim a refresh is running', /older than 10 minutes/.test(await text(b, '#coverage-text')) && await text(b, '#refresh-stale') === 'Refresh 6 stale rooms', `${await text(b, '#coverage-text')} | ${await text(b, '#refresh-stale')}`);
    const apiBefore = await apiCalls(b);
    await sleep(3500);
    check('no refetch storm: stale-on-arrival data is not re-requested straight away', (await apiCalls(b)) === apiBefore && (await stats()).total === 6, `${apiBefore} → ${await apiCalls(b)}`);
    await b.ev(`window.__oldAgeMs=0`); await click(b, '#refresh-stale');
    await b.waitFor(`performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/allocations')).length>=12`, 15000);
    check('after a genuine refresh (source age ~0) the recommendations appear', await b.waitFor(`document.querySelectorAll('#recommendations .rec-card').length>0`, 15000), await text(b, '#coverage-text'));
    check('the refresh cost one request per room in the browser and was absorbed by the server cache (ETH asked once per room)', (await apiCalls(b)) === 12 && (await stats()).total === 6, `api=${await apiCalls(b)} eth=${(await stats()).total}`);
    // source age keeps growing locally: the same record turns stale without any new response
    await sleep(900);
    await b.setClock(11);
    await b.nav(stack.url);
    await b.waitFor(`document.querySelector('#coverage-text').textContent.length>0`, 5000); await sleep(800);
    check('11 minutes later the cached answers are stale and no longer recommended (age measured from the source, not from the cache write)', (await cards(b)).length === 0 && /older than 10 minutes/.test(await text(b, '#coverage-text')), await text(b, '#coverage-text'));
  } finally { b.cleanup(); stack.stop(); }
}

// ---------------------------------------------------------------- phase 6
const metrics = {};
async function phase6() {
  console.log('\n# Phase 6: performance, responsiveness and network efficiency');
  const stack = await startStack(); const b = await openBrowser('p6');
  const port = new URL(stack.url).port - 5000;
  const stats = async () => (await fetch(`http://127.0.0.1:${port}/__stats`)).json();
  const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const latency = selector => b.ev(`(async()=>{const el=document.querySelector(${JSON.stringify(selector)});const t0=performance.now();el.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-t0;})()`);
  const marks = () => b.ev(`JSON.stringify({render:performance.getEntriesByName('first-render')[0]?.startTime??null,rec:performance.getEntriesByName('first-recommendation')[0]?.startTime??null,cls:window.__cls||0})`).then(JSON.parse);
  try {
    await b.initScript(`window.__cls=0;try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__cls+=e.value}).observe({type:'layout-shift',buffered:true});}catch{}`);
    await b.nav(stack.url);
    await b.waitFor(`document.querySelectorAll('#recommendations .rec-card').length>0`, 20000);
    await sleep(1500);
    const cold = await marks();
    metrics.cold = {firstRenderMs: Math.round(cold.render), firstRecommendationMs: Math.round(cold.rec), cls: Number(cold.cls.toFixed(4)), scheduleRequests: (await stats()).total};
    check(`cold visit: first render ${metrics.cold.firstRenderMs} ms, first recommendation ${metrics.cold.firstRecommendationMs} ms (local mock ETH)`, cold.render !== null && cold.render < 1500 && cold.rec !== null && cold.rec < 5000, JSON.stringify(cold));
    check(`layout shift while recommendations arrive: CLS ${metrics.cold.cls} (< 0.1)`, cold.cls < 0.1, String(cold.cls));
    // mode switches: instant and offline-capable
    const apiBefore = await apiCalls(b), ethBefore = (await stats()).total;
    const modeLatencies = [];
    for (let i = 0; i < 3; i++) for (const m of ['soon', 'rest', 'now']) modeLatencies.push(await latency(`.mode-btn[data-mode=${m}]`));
    metrics.modeSwitch = {medianMs: Math.round(median(modeLatencies)), maxMs: Math.round(Math.max(...modeLatencies))};
    check(`switching modes: median ${metrics.modeSwitch.medianMs} ms, max ${metrics.modeSwitch.maxMs} ms to the next painted frame (< 100 ms)`, Math.max(...modeLatencies) < 100, JSON.stringify(modeLatencies));
    check('9 mode switches made ZERO network requests (browser and ETH side)', (await apiCalls(b)) === apiBefore && (await stats()).total === ethBefore, `${apiBefore} → ${await apiCalls(b)}`);
    const cardLatencies = [await latency('#recommendations .rec-main'), await latency('#recommendations .rec-main')];
    metrics.cardToggleMs = Math.round(Math.max(...cardLatencies));
    check(`opening and closing a card: ${metrics.cardToggleMs} ms (< 100 ms)`, Math.max(...cardLatencies) < 100, JSON.stringify(cardLatencies));
    // idle: no polling, no DOM rebuilding
    const idle = await b.ev(`(async()=>{let n=0;const mo=new MutationObserver(m=>{n+=m.length});for(const id of ['recommendations','favorites-list','room-results','coverage'])mo.observe(document.getElementById(id),{childList:true,subtree:true,characterData:true,attributes:true});await new Promise(r=>setTimeout(r,5000));mo.disconnect();return n;})()`);
    check('5 s idle: no DOM mutations in the home or browse sections and no requests (no polling, no redundant rendering)', idle === 0 && (await apiCalls(b)) === apiBefore && (await stats()).total === ethBefore, `mutations=${idle}`);
    // warm reload
    await sleep(700);
    await b.nav(stack.url);
    await b.waitFor(`document.querySelectorAll('#recommendations .rec-card').length>0`, 5000);
    const warm = await marks();
    metrics.warm = {firstRenderMs: Math.round(warm.render), firstRecommendationMs: Math.round(warm.rec), cls: Number(warm.cls.toFixed(4)), apiRequests: await apiCalls(b)};
    check(`warm reload: cached recommendations after ${metrics.warm.firstRecommendationMs} ms with ${metrics.warm.apiRequests} requests`, warm.rec !== null && warm.rec < 1500 && metrics.warm.apiRequests === 0, JSON.stringify(warm));
    check(`warm reload: CLS ${metrics.warm.cls} (< 0.1)`, warm.cls < 0.1);
    // dedupe across features: browse a building whose rooms the home screen already requested
    await b.ev(`document.querySelector('#room-results .building-head').click()`);
    await sleep(2500);
    const st = await stats();
    check('deduplication: opening a building in Browse never requests a room twice (home + browse share one cache and queue)', Math.max(...Object.values(st.alloc)) === 1, JSON.stringify(st.alloc));
    // slow ETH: the UI stays responsive and results arrive progressively
    stack.mock.setDelay(1500);
    await click(b, '.campus-tab[data-campus="Hönggerberg"]');
    await sleep(200);
    const samples = new Set();
    const pending = await b.ev(`JSON.stringify({placeholder:/Looking for free rooms|Checking/.test(document.getElementById('recommendations').innerText+document.getElementById('coverage-text').textContent)})`).then(JSON.parse);
    const busyLatency = [await latency('.mode-btn[data-mode=rest]'), await latency('.mode-btn[data-mode=soon]'), await latency('#settings-btn')];
    await b.ev(`document.getElementById('settings-dialog').close()`);
    await b.ev(`window.scrollTo(0,400)`); await sleep(100);
    const scrolled = await b.ev(`window.scrollY`);
    metrics.slowEth = {interactionMsWhileWaiting: Math.round(Math.max(...busyLatency)), scrollY: Math.round(scrolled)};
    check(`slow ETH (1.5 s per answer): the UI answers within ${metrics.slowEth.interactionMsWhileWaiting} ms while requests are pending, a loading state is shown, and scrolling works`, pending.placeholder && Math.max(...busyLatency) < 100 && scrolled >= 300, JSON.stringify({pending, busyLatency, scrolled}));
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      const t = await text(b, '#coverage-text');
      const m = /based on (\d+) of/.exec(t); if (m) samples.add(Number(m[1]));
      if (/based on 6 of|All \d+ listed/.test(t)) break;
      await sleep(250);
    }
    metrics.slowEth.progressiveSteps = [...samples].sort((x, y) => x - y);
    check(`progressive results: coverage grew in steps ${metrics.slowEth.progressiveSteps.join(' → ')} instead of waiting for all rooms`, samples.size >= 2, JSON.stringify([...samples]));
    stack.mock.setDelay(0);
    check('no console errors in phase 6', b.errors.filter(e => !/Failed to load resource/.test(e)).length === 0, b.errors.join(' | '));
  } finally { b.cleanup(); stack.stop(); }
}

// ---------------------------------------------------------------- phase 7
const PX = 1.2; // px per minute of the timeline (docs/UX_SPEC.md §8)
async function phase7() {
  console.log('\n# Phase 7: room detail screen and interactive timeline');
  const stack = await startStack(); const b = await openBrowser('p7');
  const port = new URL(stack.url).port - 5000;
  const stats = async () => (await fetch(`http://127.0.0.1:${port}/__stats`)).json();
  const lat = selector => b.ev(`(async()=>{const el=document.querySelector(${JSON.stringify(selector)});const t0=performance.now();el.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-t0;})()`);
  const detailOpen = () => b.ev(`!document.getElementById('room-detail').hidden`);
  const title = () => text(b, '#rd-title');
  const openFromSearch = async code => {
    await b.ev(`(()=>{const i=document.getElementById('room-search');i.value=${JSON.stringify(code)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await b.waitFor(`document.querySelector('#room-results [data-open-detail=${JSON.stringify(code)}]')`, 8000);
    await b.ev(`document.querySelector('#room-results [data-open-detail=${JSON.stringify(code)}]').click()`);
    await b.waitFor(`!document.getElementById('room-detail').hidden&&document.getElementById('rd-title').textContent===${JSON.stringify(code)}`, 5000);
  };
  const close = async () => { await click(b, '#rd-close'); await sleep(150); };
  const blocksDom = () => b.ev(`JSON.stringify([...document.querySelectorAll('#rd-timeline .tl-block')].map(e=>({kind:e.classList.contains('tl-booked')?'booked':'blocked',top:parseFloat(e.style.top),h:parseFloat(e.style.height),label:e.getAttribute('aria-label')})))`).then(JSON.parse);
  const freeDom = () => b.ev(`JSON.stringify([...document.querySelectorAll('#rd-timeline .tl-free')].map(e=>({top:parseFloat(e.style.top),h:parseFloat(e.style.height),label:e.textContent,aria:e.getAttribute('aria-label')})))`).then(JSON.parse);
  const near = (a, bb) => Math.abs(a - bb) <= 0.6;
  try {
    await b.initScript(`if(!localStorage.getItem('openroom-prefs-v1'))localStorage.setItem('openroom-prefs-v1',JSON.stringify({favorites:['HG E 21','HG E 22','HG E 23']}));
window.__cls=0;try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__cls+=e.value}).observe({type:'layout-shift',buffered:true});}catch{}
(()=>{const f=window.fetch;window.fetch=async(...a)=>{const r=await f(...a);if(String(a[0]).includes('/api/allocations')&&window.__oldAgeMs){const j=await r.clone().json();j.ageMs=window.__oldAgeMs;j.fetchedAt=new Date(Date.now()-window.__oldAgeMs).toISOString();return new Response(JSON.stringify(j),{status:r.status,headers:r.headers});}return r;};})();`);
    await b.nav(stack.url);
    await b.waitFor(`document.querySelectorAll('#recommendations .rec-card').length>0&&/based on 6/.test(document.getElementById('coverage-text').textContent)`, 20000);
    await sleep(1500);
    let st = await stats();
    const sc = st.scenarios; // room -> scenario for the 3 discovery rooms
    const s0 = Object.keys(sc).find(c => sc[c] === 'S0'), s1 = Object.keys(sc).find(c => sc[c] === 'S1'), s2 = Object.keys(sc).find(c => sc[c] === 'S2');
    check('setup: 3 favorites + 3 discovery rooms loaded with exactly 6 schedule requests', totalAlloc(st) === 6 && s0 && s1 && s2, JSON.stringify({alloc: st.alloc, sc}));
    const apiN = () => apiCalls(b);

    // ---- entry point 1: recommendation card
    const a0 = await apiN(), st0 = (await stats()).total;
    const cardCode = (await cards(b))[0].code;
    const t0 = Date.now();
    await b.ev(`document.querySelector('#recommendations .rec-main').click()`);
    const opened = await b.waitFor(`!document.getElementById('room-detail').hidden&&document.querySelector('#rd-timeline .tl')`, 3000);
    const openMs = Date.now() - t0;
    check(`opens from a recommendation card (${cardCode}) with the cached schedule, no loading state`, opened && await title() === cardCode, `${await title()} vs ${cardCode}`);
    check('opening a room with fresh cached data makes NO request (browser or ETH)', (await apiN()) === a0 && (await stats()).total === st0, `${a0} → ${await apiN()}`);
    check('dialog semantics: role=dialog, aria-modal, labelled by the room code; background inert; page scroll locked; focus moved into the dialog', await b.ev(`(()=>{const d=document.getElementById('room-detail');return d.getAttribute('role')==='dialog'&&d.getAttribute('aria-modal')==='true'&&document.getElementById(d.getAttribute('aria-labelledby')).textContent===document.getElementById('rd-title').textContent&&document.querySelector('.app-shell').inert&&document.body.classList.contains('rd-open')&&document.activeElement.id==='rd-close';})()`));
    check('history: opening pushes #room so the phone back button closes the screen', await b.ev(`location.hash`) === '#room');
    await b.ev(`history.back()`); await sleep(300);
    check('back button closes the detail screen and focus returns to the card that opened it', !(await detailOpen()) && await b.ev(`document.activeElement.getAttribute('data-open-detail')`) === cardCode && await b.ev(`location.hash`) === '');

    // ---- entry point 2: favorites
    await b.ev(`document.querySelector('#favorites-list [data-open-detail="HG E 21"]').click()`); await sleep(300);
    check('opens from the Favorites list (verified-empty room: free, with the empty schedule drawn as free time)', await title() === 'HG E 21' && /^Free/.test(await text(b, '#rd-status .rd-badge')) && (await blocksDom()).length === 0 && (await freeDom()).length === 1);
    await close();

    // ---- entry point 3: building list (browse); room S1 has bookings 09–11 and 14–16 plus night blocks
    const a1 = (await stats()).alloc[s1];
    await openFromSearch(s1);
    check(`opens from a building list (search auto-expands the building): ${s1}`, await title() === s1);
    check('...and opening it requested nothing for that room', (await stats()).alloc[s1] === a1, `${a1} → ${(await stats()).alloc[s1]}`);
    const stNow = await text(b, '#rd-status');
    check('current status at 10:00 is "Booked until 11:00" with the next change, a freshness line and a refresh button', /Booked/.test(stNow) && /Booked until 11:00/.test(stNow) && /At 11:00 it becomes free/.test(stNow) && /Updated (09:59|10:00)/.test(stNow) && await b.ev(`Boolean(document.getElementById('rd-refresh'))`), stNow);
    check('day navigation shows "Wed 18 Nov" with a Today tag', /Wed 18 Nov/.test(await text(b, '#rd-daybar')) && /Today/.test(await text(b, '#rd-daybar .rd-today-tag')));

    // ---- timeline geometry
    const blocks = await blocksDom(), free = await freeDom();
    const wantBlocks = [[0, 480, 'blocked'], [540, 660, 'booked'], [840, 960, 'booked'], [1320, 1440, 'blocked']];
    const wantFree = [[480, 540], [660, 840], [960, 1320]];
    check('timeline: 4 blocks with heights and positions proportional to their durations (1.2 px/min)', blocks.length === 4 && wantBlocks.every(([a, e, k], i) => blocks[i].kind === k && near(blocks[i].top, a * PX) && near(blocks[i].h, (e - a) * PX)), JSON.stringify(blocks));
    check('timeline: free time fills exactly the gaps between blocks', free.length === 3 && wantFree.every(([a, e], i) => near(free[i].top, a * PX) && near(free[i].h, (e - a) * PX)), JSON.stringify(free));
    check('timeline: blocks and free time tile the 24-hour axis (1728 px) with nothing missing or overlapping', near([...blocks, ...free].reduce((sum, x) => sum + x.h, 0), 1440 * PX) && await b.ev(`parseFloat(document.querySelector('#rd-timeline .tl').style.height)`) === 1728);
    check('timeline: 25 hourly labels from 00:00 to 24:00 with boundaries', await b.ev(`JSON.stringify([...document.querySelectorAll('#rd-timeline .tl-tick-label')].map(e=>e.textContent))`) === JSON.stringify(Array.from({length: 25}, (_, i) => `${String(i).padStart(2, '0')}:00`)));
    check('timeline: the current-time indicator sits at 10:00 (720 px) and is labelled', await b.ev(`parseFloat(document.getElementById('tl-now').style.top)`) === 720 && /Now/.test(await text(b, '#tl-now')));
    check('timeline: free, booked and blocked are distinguishable by text, not only by colour (legend + labels)', /Free/.test(await text(b, '.rd-legend')) && /Booked/.test(await text(b, '.rd-legend')) && /Blocked/.test(await text(b, '.rd-legend')) && free.every(f => /^Free \d\d:\d\d–\d\d:\d\d$/.test(f.label.trim())) && blocks.every(x => /^(Booked|Blocked) /.test(x.label)));
    check('timeline: the first view is positioned around the current time (not at midnight)', await b.ev(`document.getElementById('rd-scroll').scrollTop`) > 400);
    await b.screenshot(path.join(shots, 'detail-booked-now.png'));

    // ---- booking detail expansion
    await click(b, '#rd-timeline .tl-booked'); await sleep(150);
    const card = await text(b, '#rd-card');
    check('tapping a booking shows course information: type, time, duration, title and course number', !(await b.ev(`document.getElementById('rd-card').hidden`)) && /Booked/.test(card) && /09:00–11:00/.test(card) && /2 h/.test(card) && /Lecture/.test(card) && /Course 1/.test(card), card);
    check('the selected booking is marked (aria-pressed) and a second tap closes the details', await b.ev(`document.querySelector('#rd-timeline .tl-booked').getAttribute('aria-pressed')`) === 'true');
    await b.screenshot(path.join(shots, 'detail-booking-card.png'));
    await click(b, '#rd-timeline .tl-booked'); await sleep(120);
    check('...second tap on the same booking closes the details', await b.ev(`document.getElementById('rd-card').hidden`));
    await click(b, '#rd-timeline .tl-blocked'); await sleep(120);
    const bcard = await text(b, '#rd-card');
    check('a blocked interval is explained without claiming opening hours (type 8 shown as published)', /Blocked/.test(bcard) && /type 8/.test(bcard) && /not treated as the building's opening hours/.test(bcard), bcard);
    await b.press('Escape'); await sleep(120);
    check('Escape closes the details first, the screen second', await b.ev(`document.getElementById('rd-card').hidden`) && await detailOpen());
    await b.ev(`document.querySelector('#rd-list summary').click()`); await sleep(100);
    await b.ev(`document.querySelectorAll('#rd-list .rd-row')[1].click()`); await sleep(120);
    check('the accessible list of entries opens the same details (9:00 booking is the 2nd row)', /09:00–11:00/.test(await text(b, '#rd-card')) && await b.ev(`document.querySelectorAll('#rd-list .rd-row').length`) === 4);
    await b.press('Escape'); await sleep(100);

    // ---- layout, touch targets, keyboard at 375 px
    check('no horizontal scrolling in the detail screen or on the page at 375 px', await b.ev(`(()=>{const s=document.getElementById('rd-scroll'),d=document.getElementById('room-detail');return s.scrollWidth<=s.clientWidth&&d.scrollWidth<=d.clientWidth&&document.documentElement.scrollWidth<=window.innerWidth;})()`));
    const small = await b.ev(`JSON.stringify([...document.querySelectorAll('#room-detail button, #room-detail summary')].filter(e=>e.getClientRects().length&&!e.classList.contains('tl-block')).map(e=>{const r=e.getBoundingClientRect();return {c:(e.id||e.className||e.tagName),w:Math.round(r.width),h:Math.round(r.height)}}).filter(x=>x.h<44||x.w<44))`);
    check('every control in the detail screen is at least 44×44 px (timeline blocks keep their exact proportional height and get a larger touch area)', small === '[]', small);
    check('timeline blocks are keyboard-reachable buttons with accessible names', await b.ev(`[...document.querySelectorAll('#rd-timeline .tl-block')].every(e=>e.tagName==='BUTTON'&&/^(Booked|Blocked) \\d\\d:\\d\\d–/.test(e.getAttribute('aria-label')))`));
    await b.ev(`document.querySelector('#rd-timeline .tl-booked').focus()`); await b.press('Enter'); await sleep(120);
    check('keyboard: Enter on a focused booking opens its details', !(await b.ev(`document.getElementById('rd-card').hidden`)));
    await b.press('Escape'); await sleep(100);
    check('keyboard: focus stays inside the dialog while it is open (background is inert)', await (async () => {
      await b.ev(`document.getElementById('rd-close').focus()`);
      for (let i = 0; i < 14; i++) { await b.press('Tab'); if (!await b.ev(`document.getElementById('room-detail').contains(document.activeElement)||document.activeElement===document.body`)) return false; }
      return true;
    })());

    // ---- date navigation reuses the cached week
    const aDay0 = await apiN(), stDay0 = (await stats()).alloc[s1];
    await click(b, '#rd-next'); await sleep(200);
    check('date navigation: next day shows "Thu 19 Nov" without a current-time line, from the cached week (no request)', /Thu 19 Nov/.test(await text(b, '#rd-daybar')) && await b.ev(`!document.getElementById('tl-now')`) && (await apiN()) === aDay0 && (await stats()).alloc[s1] === stDay0);
    check('another day of the same cached week is drawn from the same record (the mock publishes the same entries daily): 4 blocks, 3 free gaps', (await blocksDom()).length === 4 && (await freeDom()).length === 3);
    await b.ev(`document.querySelector('[data-rd-day]').click()`); await sleep(150);
    check('week strip jumps to Monday 16 Nov (cached)', /Mon 16 Nov/.test(await text(b, '#rd-daybar')) && (await apiN()) === aDay0);
    await click(b, '#rd-today'); await sleep(150);
    check('Today returns to today with the current-time line at 720 px', /Today/.test(await text(b, '#rd-daybar')) && await b.ev(`parseFloat(document.getElementById('tl-now').style.top)`) === 720);
    stack.mock.setDelay(900);
    const aWeek0 = await apiN();
    for (let i = 0; i < 5; i++) await click(b, '#rd-next'); // Mon 23 Nov: a different week
    await sleep(150);
    const loadingView = await b.ev(`JSON.stringify({text:document.getElementById('rd-timeline').innerText,free:document.querySelectorAll('#rd-timeline .tl-free').length,blocks:document.querySelectorAll('#rd-timeline .tl-block').length})`).then(JSON.parse);
    check('a week that is not cached shows "Loading schedule…" with NO free time while it loads', /Loading schedule/.test(loadingView.text) && loadingView.free === 0 && loadingView.blocks === 0, JSON.stringify(loadingView));
    await b.waitFor(`document.querySelector('#rd-timeline .tl')`, 8000);
    stack.mock.setDelay(0);
    check('crossing into a new week costs exactly one request; its timeline then appears', (await apiN()) === aWeek0 + 1 && /Mon 23 Nov/.test(await text(b, '#rd-daybar')), `${aWeek0} → ${await apiN()}`);
    for (let i = 0; i < 5; i++) await click(b, '#rd-prev');
    for (let i = 0; i < 5; i++) await click(b, '#rd-next');
    await sleep(200);
    check('going back and forth between weeks afterwards reuses the cache (no further request)', (await apiN()) === aWeek0 + 1);
    await click(b, '#rd-today'); await sleep(100);

    // ---- cached reopen
    await close();
    const aRe = await apiN();
    await b.ev(`document.querySelector('#room-results [data-open-detail=${JSON.stringify(s1)}]').click()`); await sleep(250);
    check('closing and reopening the same room uses the cache (no request) and resets to today', await title() === s1 && (await apiN()) === aRe && /Today/.test(await text(b, '#rd-daybar')));
    await close();

    // ---- performance of the screen
    const clsBefore = await b.ev(`window.__cls`);
    await b.ev(`window.__clsSources=[];new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__clsSources.push({v:e.value,s:e.sources.map(x=>x.node&&(x.node.id||x.node.className||x.node.nodeName))});}).observe({type:'layout-shift',buffered:false});`);
    const openLat = [], dayLat = [], pickLat = [];
    for (let i = 0; i < 3; i++) {
      openLat.push(await lat(`#room-results [data-open-detail=${JSON.stringify(s1)}]`));
      dayLat.push(await lat('#rd-next')); dayLat.push(await lat('#rd-prev'));
      pickLat.push(await lat('#rd-timeline .tl-booked')); pickLat.push(await lat('#rd-timeline .tl-booked'));
      await close();
    }
    const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    metrics.detail = {openCachedMs: Math.round(med(openLat)), openFirstMs: openMs, dayChangeMs: Math.round(Math.max(...dayLat)), selectBookingMs: Math.round(Math.max(...pickLat)), cls: Number(((await b.ev(`window.__cls`)) - clsBefore).toFixed(4))};
    check(`open (cached): median ${metrics.detail.openCachedMs} ms, day change max ${metrics.detail.dayChangeMs} ms, booking tap max ${metrics.detail.selectBookingMs} ms — all < 100 ms to the next painted frame`, Math.max(...openLat) < 100 && Math.max(...dayLat) < 100 && Math.max(...pickLat) < 100, JSON.stringify({openLat, dayLat, pickLat}));
    check(`no layout shift caused by opening the screen or moving through days (CLS ${metrics.detail.cls})`, metrics.detail.cls < 0.1, JSON.stringify(await b.ev(`window.__clsSources`)));

    // ---- invalid / failing rooms: never free
    await b.ev(`document.querySelector('#favorites-list [data-open-detail="HG E 23"]').click()`); await sleep(300);
    const failing = await b.ev(`JSON.stringify({badge:document.querySelector('#rd-status .rd-badge').textContent,t:document.getElementById('rd-timeline').innerText,free:document.querySelectorAll('#rd-timeline .tl-free').length,blocks:document.querySelectorAll('#rd-timeline .tl-block').length,retry:Boolean(document.getElementById('rd-retry'))})`).then(JSON.parse);
    check('a failed schedule (ETH 500) shows Unknown, "availability is unknown" and a retry — never free time', failing.badge === 'Unknown' && /Schedule unavailable/.test(failing.t) && /availability is unknown/.test(failing.t) && failing.free === 0 && failing.blocks === 0 && failing.retry, JSON.stringify(failing));
    await b.screenshot(path.join(shots, 'detail-unknown.png'));
    await close();
    await b.ev(`document.querySelector('#favorites-list [data-open-detail="HG E 22"]').click()`); await sleep(300);
    check('an unknown room (ETH answered 200 []) shows "Room not found at ETH", never free time', /Room not found at ETH/.test(await text(b, '#rd-timeline')) && await b.ev(`document.querySelectorAll('#rd-timeline .tl-free').length`) === 0 && await text(b, '#rd-status .rd-badge') === 'Unknown');
    await close();

    // ---- stale data: visibly stale, never "freshly confirmed free"
    await openFromSearch(s0);
    check('before: a fresh free room shows the plain "Free" badge and an unhatched timeline', await text(b, '#rd-status .rd-badge') === 'Free' && await b.ev(`!document.querySelector('#rd-timeline .tl-stale')`));
    await b.ev(`window.__oldAgeMs=900000`);
    await click(b, '#rd-refresh'); await sleep(900);
    const stale = await b.ev(`JSON.stringify({badge:document.querySelector('#rd-status .rd-badge').textContent,fresh:document.querySelector('.rd-fresh').innerText,cls:Boolean(document.querySelector('#rd-timeline .tl-stale')),note:Boolean(document.querySelector('.rd-stale-note')),labels:[...document.querySelectorAll('#rd-timeline .tl-free')].map(e=>e.getAttribute('aria-label'))})`).then(JSON.parse);
    check('15-minute-old ETH data: badge "Free · Stale", "Stale — updated …" line, hatched free time labelled stale, and a warning note', stale.badge === 'Free · Stale' && /^Stale — updated/.test(stale.fresh) && stale.cls && stale.note && stale.labels.length > 0 && stale.labels.every(l => /stale/i.test(l)), JSON.stringify(stale));
    await b.screenshot(path.join(shots, 'detail-stale.png'));
    await b.ev(`window.__oldAgeMs=0`);
    await click(b, '#rd-refresh'); await sleep(900);
    check('after a genuine refresh the badge is plain "Free" again and the stale styling is gone', await text(b, '#rd-status .rd-badge') === 'Free' && await b.ev(`!document.querySelector('#rd-timeline .tl-stale')&&!document.querySelector('.rd-stale-note')`));
    await close();

    // ---- clock moves, no request: the current-time line recalculates locally
    await sleep(700);
    await b.setClock(6);
    await b.nav(stack.url);
    await b.waitFor(`document.querySelector('#recommendations .rec-card')`, 8000);
    const aClock = await apiN(), eClock = (await stats()).total;
    await openFromSearch(s1); await sleep(200);
    check('6 minutes later (reload): the current-time line moved to 10:06 (727.2 px) from cached data without a request', await b.ev(`parseFloat(document.getElementById('tl-now').style.top)`) === 727.2 && (await apiN()) === aClock && (await stats()).total === eClock, `${await b.ev(`document.getElementById('tl-now').style.top`)}`);

    // ---- rate limit while opening an unchecked room
    await close();
    const lastCode = catalog.filter(r => r.campus === 'Zentrum').at(-1).code;
    stack.mock.setRate429(true);
    await openFromSearch(lastCode); await sleep(1200);
    const limited = await b.ev(`JSON.stringify({badge:document.querySelector('#rd-status .rd-badge').textContent,t:document.getElementById('rd-timeline').innerText,free:document.querySelectorAll('#rd-timeline .tl-free').length,retryDisabled:document.getElementById('rd-retry')?.disabled})`).then(JSON.parse);
    check('opening an unchecked room during an ETH rate limit shows "Rate limited", a paused retry and never free time', limited.badge === 'Unknown' && /Rate limited/.test(limited.t) && limited.free === 0 && limited.retryDisabled === true, JSON.stringify(limited));
    stack.mock.setRate429(false);
    check('no console errors in phase 7', b.errors.filter(e => !/Failed to load resource|429|503/.test(e)).length === 0, b.errors.join(' | '));
  } finally { b.cleanup(); stack.stop(); }
}

// ---------------------------------------------------------------- phase 8
async function phase8() {
  console.log('\n# Phase 8: when requests happen — no polling, foreground revalidation within the budget, manual refresh');
  const byCode = (a, bb) => a.localeCompare(bb, undefined, {numeric: true});
  const zen = catalog.filter(r => r.campus === 'Zentrum').slice(0, 5).map(r => r.code);
  const hon = catalog.filter(r => r.campus === 'Hönggerberg').slice(0, 4).map(r => r.code);
  const stack = await startStack(); const b = await openBrowser('p8');
  const port = new URL(stack.url).port - 5000;
  const stats = async () => (await fetch(`http://127.0.0.1:${port}/__stats`)).json();
  const setHidden = hidden => b.ev(`(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>${hidden}});document.dispatchEvent(new Event('visibilitychange'));})()`);
  try {
    await b.initScript(`if(!localStorage.getItem('openroom-prefs-v1'))localStorage.setItem('openroom-prefs-v1',JSON.stringify({favorites:${JSON.stringify([...zen, ...hon])}}));`);
    await b.nav(stack.url);
    await b.waitFor(`document.querySelectorAll('#favorites-list .status-loading').length===0`, 20000);
    await sleep(1200);
    await click(b, '#check-favorites'); await b.waitFor(`document.getElementById('check-favorites').hidden`, 8000); await sleep(1200);
    let n = await apiCalls(b);
    check('setup: 9 favorites loaded (6 initial requests + 3 on a deliberate tap)', n === 9, `api=${n}`);
    // -- no polling: the minute tick only recalculates
    await b.ev(`window.__advance(12*60000)`); // the data is now 12 minutes old
    await b.ev(`window.__intervals.forEach(i=>i.fn())`); await sleep(1500);
    check('the minute tick (fired by hand) recalculates but makes NO request, even with expired data', (await apiCalls(b)) === 9 && (await stats()).total === 9, `${await apiCalls(b)}`);
    await sleep(2500);
    check('3 more seconds of an open, visible tab with expired data: still no request (no polling, no look-ahead refresh)', (await apiCalls(b)) === 9);
    check('expired data is never recommended or shown as confirmed: no cards, rows marked Stale, coverage says older than 10 minutes with a manual refresh', (await cards(b)).length === 0 && await b.ev(`[...document.querySelectorAll('#favorites-list .status-text')].filter(e=>/Stale/.test(e.textContent)).length`) >= 5 && /older than 10 minutes/.test(await text(b, '#coverage-text')) && await text(b, '#refresh-stale') !== '', `${await text(b, '#coverage-text')} | ${await text(b, '#refresh-stale')}`);
    await b.screenshot(path.join(shots, 'home-stale-data.png'));
    // -- hidden tab: nothing
    await setHidden(true); await sleep(500);
    await b.ev(`window.__intervals.forEach(i=>i.fn())`); await sleep(800);
    check('hidden tab: no request', (await apiCalls(b)) === 9);
    // -- returning to the foreground revalidates, within the budget of 6
    await setHidden(false); await sleep(2500);
    const afterFirst = await apiCalls(b);
    check('returning to the app revalidates expired schedules within the budget: exactly 6 of the 9 (campus favorites first)', afterFirst === 9 + 6, `api=${afterFirst}`);
    const refreshedFirst = await b.ev(`JSON.stringify([...document.querySelectorAll('#favorites-list .fav-entry')].filter(e=>!/Stale/.test(e.querySelector('.status-text').textContent)).map(e=>e.querySelector('.rec-code').textContent))`).then(JSON.parse);
    check('the 5 favorites of the selected campus were refreshed first', zen.every(c => refreshedFirst.includes(c)), JSON.stringify(refreshedFirst));
    await setHidden(true); await setHidden(false); await sleep(1200);
    check('repeated foreground events within 30 s do not request again (throttled)', (await apiCalls(b)) === afterFirst, `${afterFirst} → ${await apiCalls(b)}`);
    await b.ev(`window.__advance(31000)`); await setHidden(true); await setHidden(false); await sleep(2500);
    check('after 30 s the remaining 3 expired favorites are revalidated (never more than 6 per foreground event)', (await apiCalls(b)) === afterFirst + 3, `${afterFirst} → ${await apiCalls(b)}`);
    check('ETH itself was asked only 9 times in total (the server cache absorbed the revalidations)', (await stats()).total === 9);
    // -- manual refresh from the coverage line
    await b.ev(`window.__advance(12*60000)`); await b.ev(`window.__intervals.forEach(i=>i.fn())`); await sleep(500);
    const manual0 = await apiCalls(b);
    check('manual refresh is offered when data expired ("Refresh N stale rooms", at most 6)', /^Refresh \d stale rooms?$/.test(await text(b, '#refresh-stale')) && Number((/\d/.exec(await text(b, '#refresh-stale')))[0]) <= 6, await text(b, '#refresh-stale'));
    await click(b, '#refresh-stale'); await sleep(2500);
    const manualDelta = (await apiCalls(b)) - manual0;
    check(`manual refresh requested ${manualDelta} schedules (≤ 6) and the app shows fresh data again`, manualDelta >= 1 && manualDelta <= 6 && await b.ev(`document.getElementById('refresh-stale').hidden||/Refresh \\d stale/.test(document.getElementById('refresh-stale').textContent)`), `delta=${manualDelta}`);
    // -- an open room is revalidated first
    await b.ev(`window.__advance(12*60000)`); await sleep(300);
    const pre = await apiCalls(b);
    await click(b, `#favorites-list [data-open-detail="${zen[0]}"]`); await sleep(1200);
    const detail0 = await apiCalls(b);
    check('opening a room whose data expired requests exactly that room, once', detail0 === pre + 1, `${pre} → ${detail0}`);
    await setHidden(true); await setHidden(false); await sleep(2500);
    check('foreground revalidation with a room open stays within the budget of 6', (await apiCalls(b)) - detail0 <= 6, `${detail0} → ${await apiCalls(b)}`);
    check('no console errors in phase 8', b.errors.filter(e => !/Failed to load resource/.test(e)).length === 0, b.errors.join(' | '));
  } finally { b.cleanup(); stack.stop(); }
}

try { await phase1(); await phase2(); await phase3(); await phase4(); await phase5(); await phase6(); await phase7(); await phase8(); }
catch (error) { check('e2e ran to completion', false, error.stack); }
fs.writeFileSync(path.join(shots, 'performance.json'), JSON.stringify(metrics, null, 2));
console.log('\nPerformance (headless Chromium, local mock ETH):', JSON.stringify(metrics));
console.log(`\n${results.filter(Boolean).length}/${results.length} browser checks passed. Screenshots and metrics: ${shots}`);
process.exit(results.every(Boolean) ? 0 : 1);
