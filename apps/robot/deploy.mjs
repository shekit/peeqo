// Puts Peeqo on its robot from this computer: builds the pages, copies the software to ~/peeqo on the Raspberry Pi
// and runs the installer there (which sets everything up the first time, and restarts Peeqo after that).
//
//   npm run deploy -w @peeqo/robot                  (to pi@peeqo.local)
//   npm run deploy -w @peeqo/robot -- me@10.0.0.7   (somewhere else)
//   npm run deploy -w @peeqo/robot -- --stage DIR   (only put together what would be copied, in DIR)
//
// Needs SSH to the robot (turn it on in Raspberry Pi Imager when making its SD card) and rsync.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stageOnly = process.argv.indexOf('--stage');
const target = stageOnly >= 0 ? null : (process.argv[2] ?? 'pi@peeqo.local');
const app = fileURLToPath(new URL('.', import.meta.url));
const repo = path.resolve(app, '../..');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options });

console.log('Building the pages…');
run('npx', ['vite', 'build'], { cwd: app });

// Only what the robot runs: the packages' and the robot app's sources, the built pages, the system files.
const stage = stageOnly >= 0 ? path.resolve(process.argv[stageOnly + 1] ?? 'peeqo-stage') : fs.mkdtempSync(path.join(os.tmpdir(), 'peeqo-deploy-'));
fs.mkdirSync(stage, { recursive: true });
const skip = (src) => /(^|[/\\])(node_modules|test|\.venv|\.data|__pycache__|\.cache)([/\\]|$)/.test(path.relative(repo, src));
const copy = (from) => fs.cpSync(path.join(repo, from), path.join(stage, from), { recursive: true, filter: (src) => !skip(src) });
for (const name of ['core', 'face', 'character', 'brain', 'wakeword']) {
  for (const part of ['package.json', 'src', 'python', 'setup.mjs']) if (fs.existsSync(path.join(repo, 'packages', name, part))) copy(path.join('packages', name, part));
}
for (const part of ['package.json', 'src', 'python', 'dist', 'system', 'install.sh']) copy(path.join('apps', 'robot', part));
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({ name: 'peeqo', private: true, type: 'module', workspaces: ['packages/*', 'apps/robot'] }, null, 2)}\n`);
if (!target) {
  console.log(`Staged in ${stage}`);
  process.exit(0);
}

console.log(`Copying to ${target}:~/peeqo …`);
run('rsync', ['-az', '--delete', '--exclude', 'node_modules', '--exclude', '.venv', '--exclude', '__pycache__', `${stage}/`, `${target}:peeqo/`]);
fs.rmSync(stage, { recursive: true, force: true });

console.log('Installing on the robot…');
run('ssh', ['-t', target, 'bash ~/peeqo/apps/robot/install.sh']);
