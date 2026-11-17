/** Pull-to-refresh: a small state machine plus a DOM binding. See docs/UPDATES.md.
 *
 * Design rules:
 *   - Starts ONLY when the page is scrolled to the very top at touch start; a touch that starts lower never becomes a pull.
 *   - Engages only after a deliberate downward movement (not horizontal, not upward); anything else is left to the browser.
 *   - Triggers only if released past the threshold. A short pull just springs back.
 *   - It never blocks normal scrolling: the (non-passive) touchmove listener exists ONLY while a pull from the top is being tracked,
 *     and preventDefault is called only once the gesture has engaged.
 *   - Touches inside the room-detail screen, dialogs, inputs or horizontally scrolling strips are ignored. */
export const PULL = Object.freeze({threshold: 72, resistance: 0.5, max: 120, engageDistance: 10, horizontalSlack: 1});

export class PullGesture {
  constructor(opts = {}) { this.o = {...PULL, ...opts}; this.reset(); }
  reset() { this.tracking = false; this.engaged = false; this.startX = 0; this.startY = 0; this.distance = 0; this.phase = 'idle'; }
  /** scrollTop: current page scroll offset; blocked: the touch started somewhere a pull must not start. */
  start({x, y, scrollTop, blocked = false}) {
    this.reset();
    if (blocked || !(scrollTop <= 0)) return false;
    this.tracking = true; this.startX = x; this.startY = y;
    return true;
  }
  /** Returns {phase, distance, preventDefault}. phase: idle | pulling | ready. */
  move({x, y, scrollTop = 0}) {
    if (!this.tracking) return {phase: 'idle', distance: 0, preventDefault: false};
    if (!(scrollTop <= 0)) { this.cancel(); return {phase: 'idle', distance: 0, preventDefault: false}; } // the page started scrolling
    const dy = y - this.startY, dx = x - this.startX;
    if (!this.engaged) {
      if (dy < 0 || Math.abs(dx) > Math.abs(dy) * this.o.horizontalSlack) { if (dy < 0 || Math.abs(dx) > this.o.engageDistance) this.cancel(); return {phase: 'idle', distance: 0, preventDefault: false}; }
      if (dy < this.o.engageDistance) return {phase: 'idle', distance: 0, preventDefault: false};
      this.engaged = true;
    }
    this.distance = Math.max(0, Math.min(this.o.max, dy * this.o.resistance));
    this.phase = this.distance >= this.o.threshold ? 'ready' : 'pulling';
    return {phase: this.phase, distance: this.distance, preventDefault: true};
  }
  end() {
    const triggered = this.engaged && this.phase === 'ready';
    const result = {triggered, engaged: this.engaged};
    this.reset();
    return result;
  }
  cancel() { this.reset(); }
}

/** Where a pull must not start. `target` is the touch target element. */
export function isPullBlocked(target, {detailOpen = false} = {}) {
  if (detailOpen) return true;
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest('#room-detail, dialog, input, textarea, select, .day-strip, .rd-weekstrip, [data-no-pull]'));
}

/** Attaches the gesture to the document. ui: {pull(distance, phase), release(triggered)}. */
export function attachPullToRefresh({doc = document, win = window, ui, onTrigger, isBlocked = () => false, gesture = new PullGesture()}) {
  const scrollTop = () => win.scrollY || doc.documentElement.scrollTop || 0;
  const onMove = e => {
    const t = e.touches[0];
    const r = gesture.move({x: t.clientX, y: t.clientY, scrollTop: scrollTop()});
    if (r.preventDefault && e.cancelable) e.preventDefault(); // only after the gesture engaged
    if (r.phase === 'idle') { if (!gesture.tracking) detach(); ui.release(false, false); } else ui.pull(r.distance, r.phase);
  };
  const onEnd = () => { const r = gesture.end(); detach(); ui.release(r.triggered, r.engaged); if (r.triggered) onTrigger(); };
  const detach = () => {
    doc.removeEventListener('touchmove', onMove);
    doc.removeEventListener('touchend', onEnd);
    doc.removeEventListener('touchcancel', onEnd);
  };
  const onStart = e => {
    if (e.touches.length !== 1) { gesture.cancel(); detach(); return; }
    const t = e.touches[0];
    if (!gesture.start({x: t.clientX, y: t.clientY, scrollTop: scrollTop(), blocked: isBlocked(e.target)})) return;
    doc.addEventListener('touchmove', onMove, {passive: false}); // exists only while a pull from the top is possible
    doc.addEventListener('touchend', onEnd);
    doc.addEventListener('touchcancel', onEnd);
  };
  doc.addEventListener('touchstart', onStart, {passive: true});
  return () => { doc.removeEventListener('touchstart', onStart); detach(); };
}
