// Sets up the wake word detector's Python environment (packages/wakeword/.venv) and downloads its models.
//
//   npm run setup -w @peeqo/wakeword [-- --word hey_jarvis …]
//
// Needs Python 3.10 or newer. Uses uv when it is installed (fast), otherwise python3 -m venv and pip.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const venv = `${here}.venv`;
const python = `${venv}/bin/python`;
const words = process.argv.flatMap((arg, i, all) => (arg === '--word' && all[i + 1] ? [all[i + 1]] : []));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const has = (cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

if (!fs.existsSync(python)) {
  if (has('uv')) run('uv', ['venv', '--python', '3.12', venv]);
  else run('python3', ['-m', 'venv', venv]);
}
const install = (...args) =>
  has('uv') ? run('uv', ['pip', 'install', '--python', python, ...args]) : run(python, ['-m', 'pip', 'install', ...args]);
install('-r', `${here}python/requirements.txt`);
install('--no-deps', 'openwakeword==0.6.0'); // its dependencies are in requirements.txt, less tflite-runtime
const names = JSON.stringify(words.length > 0 ? words : ['hey_jarvis']);
run(python, ['-c', `from openwakeword import utils; utils.download_models(model_names=${names})`]);
console.log(`\nWake word detector ready: ${python}`);
