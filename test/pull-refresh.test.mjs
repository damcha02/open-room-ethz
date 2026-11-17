import test from 'node:test';
import assert from 'node:assert/strict';
import {PULL, PullGesture, isPullBlocked, attachPullToRefresh} from '../public/pull-refresh.mjs';

const pull = (g, from, to, scrollTop = 0, x = 100) => { g.start({x, y: from, scrollTop}); return g.move({x, y: to, scrollTop}); };

test('threshold: a pull only triggers when released past the threshold (resistance applies)', () => {
  const need = PULL.threshold / PULL.resistance;   // finger travel required
  let g = new PullGesture();
  let r = pull(g, 100, 100 + need - 4);
  assert.deepEqual([r.phase, r.preventDefault], ['pulling', true]);
  assert.deepEqual(g.end(), {triggered: false, engaged: true}, 'short pull springs back');
  g = new PullGesture();
  r = pull(g, 100, 100 + need);
  assert.equal(r.phase, 'ready');
  assert.equal(r.distance, PULL.threshold);
  assert.deepEqual(g.end(), {triggered: true, engaged: true});
  g = new PullGesture();
  pull(g, 100, 100 + 1000);
  assert.equal(g.distance, PULL.max, 'the indicator never travels further than the maximum');
});
test('scroll position: a touch that starts below the top is never a pull', () => {
  const g = new PullGesture();
  assert.equal(g.start({x: 1, y: 100, scrollTop: 1}), false);
  assert.deepEqual(g.move({x: 1, y: 400, scrollTop: 1}), {phase: 'idle', distance: 0, preventDefault: false});
  assert.deepEqual(g.end(), {triggered: false, engaged: false});
  assert.equal(new PullGesture().start({x: 1, y: 100, scrollTop: 0}), true);
  assert.equal(new PullGesture().start({x: 1, y: 100, scrollTop: -3}), true, 'rubber-band overscroll counts as the top');
});
test('the page starting to scroll during the gesture cancels it', () => {
  const g = new PullGesture();
  g.start({x: 0, y: 100, scrollTop: 0});
  assert.equal(g.move({x: 0, y: 200, scrollTop: 0}).phase, 'pulling');
  assert.equal(g.move({x: 0, y: 300, scrollTop: 12}).phase, 'idle');
  assert.deepEqual(g.end(), {triggered: false, engaged: false});
});
test('normal scrolling and horizontal swipes are left alone (no preventDefault)', () => {
  let g = new PullGesture();
  g.start({x: 100, y: 300, scrollTop: 0});
  assert.deepEqual(g.move({x: 100, y: 280, scrollTop: 0}), {phase: 'idle', distance: 0, preventDefault: false}, 'upward = ordinary scroll');
  assert.equal(g.tracking, false);
  g = new PullGesture();
  g.start({x: 100, y: 300, scrollTop: 0});
  assert.equal(g.move({x: 100, y: 304, scrollTop: 0}).preventDefault, false, 'tiny movement: not yet a pull');
  assert.equal(g.move({x: 100, y: 311, scrollTop: 0}).preventDefault, true, 'deliberate: engaged');
  g = new PullGesture();
  g.start({x: 100, y: 300, scrollTop: 0});
  assert.equal(g.move({x: 190, y: 315, scrollTop: 0}).preventDefault, false, 'mostly horizontal: not a pull');
  assert.equal(g.tracking, false);
  g = new PullGesture();
  assert.equal(g.start({x: 1, y: 1, scrollTop: 0, blocked: true}), false);
});
test('release without ever engaging never triggers', () => {
  const g = new PullGesture();
  g.start({x: 0, y: 100, scrollTop: 0});
  assert.deepEqual(g.end(), {triggered: false, engaged: false});
  assert.deepEqual(new PullGesture().end(), {triggered: false, engaged: false});
});
test('where a pull must not start: room detail, dialogs, inputs, horizontal strips', () => {
  const el = matches => ({closest: sel => sel.split(',').map(s => s.trim()).some(s => matches.includes(s)) ? {} : null});
  assert.equal(isPullBlocked(el([]), {}), false);
  assert.equal(isPullBlocked(el(['#room-detail'])), true);
  assert.equal(isPullBlocked(el(['dialog'])), true);
  assert.equal(isPullBlocked(el(['input'])), true);
  assert.equal(isPullBlocked(el(['.day-strip'])), true);
  assert.equal(isPullBlocked(el(['.rd-weekstrip'])), true);
  assert.equal(isPullBlocked(el([]), {detailOpen: true}), true);
  assert.equal(isPullBlocked(null), false);
});

/** A tiny fake document recording which listeners exist, to prove the non-passive touchmove listener is only there during a pull. */
function fakeDoc() {
  const listeners = new Map();
  return {
    documentElement: {scrollTop: 0}, listeners,
    addEventListener(type, fn, opts) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add({fn, opts}); },
    removeEventListener(type, fn) { const set = listeners.get(type); if (set) for (const l of set) if (l.fn === fn) set.delete(l); },
    count: type => listeners.get(type)?.size ?? 0,
    fire(type, event) { for (const l of [...(listeners.get(type) ?? [])]) l.fn(event); }
  };
}
const touch = (y, x = 100, extra = {}) => ({touches: [{clientX: x, clientY: y}], target: null, cancelable: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra});
function setup({scrollY = 0, blocked = false} = {}) {
  const doc = fakeDoc(), win = {scrollY}, calls = {pull: [], release: [], triggers: 0};
  attachPullToRefresh({doc, win, isBlocked: () => blocked, onTrigger: () => calls.triggers++, ui: {pull: (d, p) => calls.pull.push([Math.round(d), p]), release: (t, e) => calls.release.push([t, e])}});
  return {doc, win, calls};
}
test('binding: the non-passive touchmove listener exists only while a pull from the top is tracked', () => {
  const {doc} = setup();
  assert.deepEqual([doc.count('touchstart'), doc.count('touchmove')], [1, 0], 'at rest only a passive touchstart listener exists');
  assert.equal([...doc.listeners.get('touchstart')][0].opts.passive, true);
  doc.fire('touchstart', touch(100));
  assert.equal(doc.count('touchmove'), 1);
  assert.equal([...doc.listeners.get('touchmove')][0].opts.passive, false);
  doc.fire('touchend', touch(100));
  assert.deepEqual([doc.count('touchmove'), doc.count('touchend')], [0, 0], 'removed again after the touch');
});
test('binding: scrolled pages (and blocked areas) never get a touchmove listener, so scrolling is never intercepted', () => {
  for (const opts of [{scrollY: 250}, {blocked: true}]) {
    const {doc, calls} = setup(opts);
    doc.fire('touchstart', touch(100));
    assert.equal(doc.count('touchmove'), 0);
    doc.fire('touchend', touch(100));
    assert.equal(calls.triggers, 0);
  }
});
test('binding: a full pull past the threshold triggers once; preventDefault only after the gesture engaged', () => {
  const {doc, calls} = setup();
  doc.fire('touchstart', touch(100));
  const tiny = touch(105); doc.fire('touchmove', tiny);
  assert.equal(tiny.defaultPrevented, false, 'a 5 px move does not block the browser');
  const deliberate = touch(160); doc.fire('touchmove', deliberate);
  assert.equal(deliberate.defaultPrevented, true);
  const far = touch(100 + PULL.threshold / PULL.resistance + 2); doc.fire('touchmove', far);
  assert.equal(calls.pull.at(-1)[1], 'ready');
  doc.fire('touchend', touch(0));
  assert.equal(calls.triggers, 1);
  assert.deepEqual(calls.release.at(-1), [true, true]);
});
test('binding: a short pull springs back without triggering; a two-finger touch is ignored; an upward move cancels', () => {
  let s = setup();
  s.doc.fire('touchstart', touch(100)); s.doc.fire('touchmove', touch(190)); s.doc.fire('touchend', touch(0));
  assert.equal(s.calls.triggers, 0);
  s = setup();
  s.doc.fire('touchstart', {touches: [{clientX: 1, clientY: 100}, {clientX: 5, clientY: 100}], target: null});
  assert.equal(s.doc.count('touchmove'), 0);
  s = setup();
  s.doc.fire('touchstart', touch(300));
  const up = touch(250); s.doc.fire('touchmove', up);
  assert.equal(up.defaultPrevented, false);
  assert.equal(s.doc.count('touchmove'), 0, 'listener removed once it is clear this is ordinary scrolling');
  assert.equal(s.calls.triggers, 0);
});
test('binding: the page scrolling during the touch cancels the pull', () => {
  const {doc, win, calls} = setup();
  doc.fire('touchstart', touch(100));
  win.scrollY = 30;
  const m = touch(400); doc.fire('touchmove', m);
  assert.equal(m.defaultPrevented, false);
  doc.fire('touchend', touch(0));
  assert.equal(calls.triggers, 0);
});
