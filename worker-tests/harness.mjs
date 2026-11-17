/** Starts the REAL Worker (workerd via `wrangler dev --local`) with a persistent Durable Object store, pointing at a mock ETH.
 * Local mode needs no Cloudflare account, makes no network call to Cloudflare and cannot incur any charge. */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** @returns {Promise<{base:string, stop:()=>Promise<void>, log:()=>string}>} */
export async function startWorker({mockPort, port, persist, vars = {}}) {
  const allVars = {ALLOW_TEST_UPSTREAM: '1', ETH_ENDPOINT: `http://127.0.0.1:${mockPort}/bin/ethz/roominfo`, ETH_MIN_INTERVAL_MS: '50', ETH_DAILY_BUDGET: '100000', ...vars};
  const args = ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(allVars)) args.push('--var', `${k}:${v}`);
  const child = spawn(path.join(root, 'node_modules', '.bin', 'wrangler'), args, {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1', }
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const started = Date.now();
  const base = `http://127.0.0.1:${port}`;
  for (;;) { // ready = the Worker answers (assets are served as soon as it is up)
    try { if ((await fetch(`${base}/404.html`, {signal: AbortSignal.timeout(1500)})).status < 500) break; } catch { /* not up yet */ }
    if (Date.now() - started > 90_000) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} throw new Error(`wrangler dev did not start:\n${output.slice(-1500)}`); }
    await sleep(250);
  }
  return {
    base,
    log: () => output,
    async stop() {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await Promise.race([exited, sleep(4000)]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  };
}
