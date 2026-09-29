// End-to-end check of the built simulator in real Chrome.
//
//   npm run build -w @peeqo/sim && npm run verify -w @peeqo/sim -- [screenshot-dir]
//
// Serves dist/, drives the page through window.__peeqo, asserts the robot behaves (safety clamping, 2019
// animations, LEDs, drawn model matching the kinematics) and fails on any console error. Needs Google Chrome.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'peeqo-sim-verify'));
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('No build found. Run `npm run build -w @peeqo/sim` first.');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.json': 'application/json', '.svg': 'image/svg+xml',
};
const problems = [];
const server = http
  .createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.join(dist, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(dist) || !fs.existsSync(file)) {
      problems.push(`[server 404] ${pathname}`);
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(0);
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()}`));
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.url()}`);
});

const results = [];
let failed = false;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
}
const state = () => page.evaluate(() => window.__peeqo.state());
const hornTipError = () => page.evaluate(() => window.__peeqo.hornTipError());
async function waitFor(predicate, timeoutMs = 6000) {
  const start = Date.now();
  for (;;) {
    const s = await state();
    if (predicate(s)) return s;
    if (Date.now() - start > timeoutMs) return null;
    await page.waitForTimeout(40);
  }
}
const atHome = (s) => Math.abs(s.output.pose.pitchDeg) < 1e-3 && Math.abs(s.output.pose.rollDeg) < 1e-3 && Math.abs(s.output.pose.heaveMm) < 1e-3;
/** Sets a target, waits until the governor has taken exactly that request, then until the head settles. */
async function setTargetAndSettle(target, timeoutMs = 6000) {
  await page.evaluate((t) => window.__peeqo.setTarget(t), target);
  return waitFor((x) => {
    const o = x.output;
    const taken = ['pitchDeg', 'rollDeg', 'heaveMm'].every((k) => o.requested[k] === target[k]);
    const settled = ['pitchDeg', 'rollDeg', 'heaveMm'].every((k) => Math.abs(o.pose[k] - o.goal[k]) < 1e-4);
    const still = Math.abs(o.rates.pitchDegPerS) + Math.abs(o.rates.rollDegPerS) + Math.abs(o.rates.heaveMmPerS) < 1e-3;
    return taken && settled && still;
  }, timeoutMs);
}
const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

try {
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

  let s = await state();
  check('starts at home and safe', atHome(s) && s.output.status === 'ok');
  check('drawn horn tips match the kinematics at home', (await hornTipError()) < 1e-6, `${(await hornTipError()).toExponential(2)} mm`);
  await page.waitForTimeout(500);
  await shot('01-home');

  s = await setTargetAndSettle({ pitchDeg: 20, rollDeg: 0, heaveMm: 0 });
  check(
    'unsafe request (pitch 20°) is held at the safe edge',
    !!s && s.output.status === 'limited' && s.output.pose.pitchDeg > 6.9 && s.output.pose.pitchDeg < 7.1,
    s ? `pitch ${s.output.pose.pitchDeg.toFixed(3)}°, status ${s.output.status}` : 'timed out',
  );
  check('drawn horn tips match the kinematics at the edge', (await hornTipError()) < 1e-6);
  await shot('02-limited-pitch');

  s = await setTargetAndSettle({ pitchDeg: 0, rollDeg: 0, heaveMm: 0 });
  check('returns home when asked', !!s && atHome(s) && s.output.status === 'ok');

  await page.evaluate(() => window.__peeqo.playAnimation('look-up'));
  s = await waitFor((x) => x.output.pose.pitchDeg > 6.5, 4000);
  check('2019 "look-up" tilts the face up', !!s, s ? `pitch ${s.output.pose.pitchDeg.toFixed(2)}°` : 'timed out');
  await shot('03-look-up');
  s = await waitFor((x) => x.playing === null && atHome(x), 6000);
  check('"look-up" finishes and returns home', !!s);

  await page.evaluate(() => window.__peeqo.playAnimation('jiggle'));
  s = await waitFor((x) => Math.abs(x.output.pose.rollDeg) > 3, 4000);
  check('2019 "jiggle" rolls the head', !!s, s ? `roll ${s.output.pose.rollDeg.toFixed(2)}°` : 'timed out');
  await waitFor((x) => x.playing === null && atHome(x), 6000);

  await page.evaluate(() => window.__peeqo.react('wakeword'));
  s = await waitFor((x) => x.litLeds.length >= 4 && x.output.pose.heaveMm > 2, 4000);
  check('"wakeword" reaction: LED circle and alert rise together', !!s, s ? `LEDs ${s.litLeds.join(',')}, heave ${s.output.pose.heaveMm.toFixed(2)} mm` : 'timed out');
  await shot('04-wakeword');
  await waitFor((x) => x.playing === null && atHome(x) && x.litLeds.length === 0, 6000);

  await page.evaluate(() => window.__peeqo.playLeds('on', 'purple'));
  s = await waitFor((x) => x.litLeds.length === 12, 2000);
  check('LED ring shows all 12 LEDs', !!s);
  await page.evaluate(() => window.__peeqo.setView('top'));
  await page.waitForTimeout(300);
  await shot('05-leds-top');
  await page.evaluate(() => window.__peeqo.playLeds('off', 'red'));

  await page.evaluate(() => window.__peeqo.setView('face'));
  await page.waitForTimeout(300);
  s = await state();
  check('eyes are open at rest', s.eyes.rx === 87.5);
  await shot('06-face');

  await page.evaluate(() => window.__peeqo.setView('neck'));
  s = await setTargetAndSettle({ pitchDeg: -3, rollDeg: 3, heaveMm: 2 });
  check(
    'reaches a safe compound pose exactly',
    !!s && s.output.status === 'ok' && Math.abs(s.output.pose.pitchDeg + 3) < 1e-4 && Math.abs(s.output.pose.rollDeg - 3) < 1e-4 && Math.abs(s.output.pose.heaveMm - 2) < 1e-4,
  );
  check('drawn horn tips match the kinematics in a compound pose', (await hornTipError()) < 1e-6);
  await page.waitForTimeout(200);
  await shot('07-neck');

  await page.evaluate(() => window.__peeqo.setView('three-quarter'));
  s = await setTargetAndSettle({ pitchDeg: 0, rollDeg: 15, heaveMm: 0 });
  check(
    'unsafe request (roll 15°) is held at the safe edge',
    !!s && s.output.status === 'limited' && s.output.pose.rollDeg > 4 && s.output.pose.rollDeg < 4.3,
    s ? `roll ${s.output.pose.rollDeg.toFixed(3)}°` : 'timed out',
  );
  await shot('08-limited-roll');
} catch (error) {
  check('run completed', false, error.message);
}

check('no console errors, warnings or failed requests', problems.length === 0, problems.join(' | '));
console.log(results.join('\n'));
console.log(`Screenshots: ${outDir}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
