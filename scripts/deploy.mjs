#!/usr/bin/env node
/** Safe deploy: stamps the version, refuses to deploy unless the stamped files are committed (so the deployed version is exactly what
 * the repository says), then runs `wrangler deploy`. Every deployment whose content differs therefore gets a different version. */
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, {cwd: root, stdio: 'inherit', ...opts});
if (run('node', ['scripts/stamp-version.mjs']).status !== 0) process.exit(1);
const dirty = spawnSync('git', ['status', '--porcelain', '--', 'public', 'worker', 'lib', 'wrangler.jsonc'], {cwd: root, encoding: 'utf8'}).stdout.trim();
if (dirty) {
  console.error(`\nRefusing to deploy: these files are not committed, so the deployed version would not match the repository:\n${dirty}\nCommit them (including the stamped version files) and run again.`);
  process.exit(1);
}
process.exit(run(path.join(root, 'node_modules', '.bin', 'wrangler'), ['deploy', ...process.argv.slice(2)]).status ?? 1);
