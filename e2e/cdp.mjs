/** Minimal Chrome DevTools Protocol driver (Node 22+ global WebSocket). No dependencies. */
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function findChromium() {
  for (const candidate of [process.env.CHROMIUM, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].filter(Boolean)) {
    const r = spawnSync('which', [candidate], {encoding: 'utf8'});
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}
/** Starts Chromium, retrying with another debugging port if the first attempt does not come up. */
export async function launch(options) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await launchOnce({...options, port: options.port + attempt * 7}); } catch (error) { lastError = error; await sleep(500); }
  }
  throw lastError;
}
async function launchOnce({binary, port, profile, width = 375, height = 812}) {
  const proc = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {stdio: 'ignore'});
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await sleep(200);
  }
  if (!target) { proc.kill(); throw new Error('Chromium did not start'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise(r => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({id, method, params})); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 2, mobile: true});
  const api = {
    errors,
    async ev(expression) {
      const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result.result.value;
    },
    async waitFor(expression, ms = 8000) {
      const t = Date.now();
      while (Date.now() - t < ms) { if (await api.ev(`Boolean(${expression})`)) return true; await sleep(100); }
      return false;
    },
    async initScript(source) { return (await send('Page.addScriptToEvaluateOnNewDocument', {source})).result.identifier; },
    async removeInitScript(identifier) { await send('Page.removeScriptToEvaluateOnNewDocument', {identifier}); },
    async nav(url) { await send('Page.navigate', {url}); await sleep(500); await api.waitFor(`document.readyState==='complete'`); },
    async screenshot(file) { const r = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false}); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); },
    async press(key) {
      const code = {Enter: 13, ' ': 32, Tab: 9}[key];
      const base = {key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: code, text: key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined};
      await send('Input.dispatchKeyEvent', {type: 'keyDown', ...base}); await send('Input.dispatchKeyEvent', {type: 'keyUp', ...base});
    },
    close() { try { ws.close(); } catch {} proc.kill(); }
  };
  return api;
}
/** Freezes the page clock at `iso` (+ shiftMinutes). Time only moves when a test changes the shift, so results do not
 * drift with the wall clock and records persisted before a reload never look like they come from the future. */
export const fakeClockScript = (isoUtc, shiftMinutes = 0) => `(()=>{const R=Date;const base=R.parse(${JSON.stringify(isoUtc)})+${shiftMinutes}*60000;
class FD extends R{constructor(...a){if(a.length===0)super(base);else super(...a);}static now(){return base;}}window.Date=FD;})();`;
