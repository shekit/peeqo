// Sets up the wake word detector's Python environment (packages/wakeword/.venv), with microWakeWord and its
// voice-activity detector (their models come with them).
//
//   npm run setup -w @peeqo/wakeword
//
// Safe to run again: it only does anything when python/requirements.txt has changed since the last setup, and then
// starts the environment afresh (so nothing an older setup installed is left behind). Needs Python 3.9 or newer;
// uses uv when it is installed (fast), otherwise python3 -m venv and pip.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const venv = `${here}.venv`;
const python = `${venv}/bin/python`;
const requirements = `${here}python/requirements.txt`;
const stamp = `${venv}/peeqo-requirements.txt`;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const has = (cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const wanted = fs.readFileSync(requirements, 'utf8');
if (fs.existsSync(python) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === wanted) {
  console.log(`Wake word detector already set up: ${python}`);
  process.exit(0);
}
fs.rmSync(venv, { recursive: true, force: true });
if (has('uv')) run('uv', ['venv', '--python', '3.12', venv]);
else run('python3', ['-m', 'venv', venv]);
if (has('uv')) run('uv', ['pip', 'install', '--python', python, '-r', requirements]);
else run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements]);
// A quick check that the models load, before saying it is ready.
run(python, ['-c', 'from pymicro_wakeword import MicroWakeWord, Model; from pymicro_vad import MicroVad; MicroWakeWord.from_builtin(Model.HEY_JARVIS); MicroVad()']);
fs.writeFileSync(stamp, wanted);
console.log(`\nWake word detector ready: ${python}`);
