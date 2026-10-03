// End-to-end check of the built simulator in real Chrome.
//
//   npm run build -w @peeqo/sim && npm run verify -w @peeqo/sim -- [screenshot-dir]
//
// Serves dist/, drives the page through window.__peeqo and checks that:
//  - every commanded pose is safe, and unsafe requests stop at the edge of the safe range;
//  - the drawn robot matches the kinematics (horn tips exactly; leg tops within the model's 0.2 mm);
//  - at random safe poses, the REAL mesh-to-mesh gaps (measured live, independently of the collision tables)
//    are never smaller than the core promises (its table reading, or the smallest clearance verified once over
//    every admitted pose, whichever is less), less the kinematic model's 0.2 mm;
//  - 2019 animations, LEDs and the face work, with no console errors.
// Needs Google Chrome.

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
const hook = (name, ...args) => page.evaluate(([n, a]) => window.__peeqo[n](...a), [name, args]);
const state = () => hook('state');
async function waitFor(predicate, timeoutMs = 6000) {
  const start = Date.now();
  for (;;) {
    const s = await state();
    if (predicate(s)) return s;
    if (Date.now() - start > timeoutMs) return null;
    await page.waitForTimeout(40);
  }
}
/** Sets a target, waits until the governor has taken exactly that request, then until the head settles. */
async function setTargetAndSettle(target, timeoutMs = 6000) {
  await hook('setTarget', target);
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
  // Idle off to start: the first checks expect the head exactly at neutral. It is switched on near the end.
  await page.goto(`${url}?idle=0`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  const neutral = await hook('neutral');
  const near = (a, b, tol = 1e-3) => ['pitchDeg', 'rollDeg', 'heaveMm'].every((k) => Math.abs(a[k] - b[k]) < tol);

  let s = await state();
  check('starts at the neutral pose, safe', near(s.output.pose, neutral) && s.output.status === 'ok', JSON.stringify(neutral));
  check('drawn horn tips match the kinematics', (await hook('hornTipError')) < 1e-6);
  check('drawn legs reach their ball joints', (await hook('legTopError')) < 0.25, `${(await hook('legTopError')).toFixed(3)} mm`);
  const verifiedMm = await hook('verifiedClearance');
  let table = await hook('tableClearance');
  let probe = await hook('probeCollisions');
  check(
    'real mesh gaps at neutral are at least what the core promises',
    probe.minMm >= Math.min(table.minMm, verifiedMm) - 0.25 && probe.minMm >= 0.25,
    `measured ${probe.minMm.toFixed(3)} mm (${probe.between}), tables promise ${table.minMm.toFixed(3)} mm (${table.between}), verified pairs ${verifiedMm.toFixed(2)} mm`,
  );
  await page.waitForTimeout(400);
  await shot('01-neutral');

  const pitchTarget = { ...neutral, pitchDeg: 20 };
  const pitchEdge = (await hook('safeEdge', pitchTarget)).pitchDeg;
  s = await setTargetAndSettle(pitchTarget);
  check(
    'unsafe request (pitch 20°) is held at the safe edge',
    !!s && s.output.status === 'limited' && Math.abs(s.output.pose.pitchDeg - pitchEdge) < 1e-3,
    s ? `pitch ${s.output.pose.pitchDeg.toFixed(3)}° (edge ${pitchEdge.toFixed(3)}°)` : 'timed out',
  );
  probe = await hook('probeCollisions');
  check('real mesh gaps at the pitch edge stay above 0.25 mm', probe.minMm >= 0.25, `${probe.minMm.toFixed(3)} mm (${probe.between})`);
  await shot('02-limited-pitch');

  s = await setTargetAndSettle(neutral);
  check('returns to neutral when asked', !!s && near(s.output.pose, neutral) && s.output.status === 'ok');

  // Randomised: many safe poses across the range, each checked against the real meshes.
  let rng = 12345;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
  let worst = { margin: Infinity, detail: '' };
  let edges = 0;
  for (let n = 0; n < 24; n++) {
    const target = { pitchDeg: neutral.pitchDeg + (rand() - 0.5) * 30, rollDeg: neutral.rollDeg + (rand() - 0.5) * 30, heaveMm: neutral.heaveMm + (rand() - 0.5) * 10 };
    s = await setTargetAndSettle(target, 8000);
    if (!s) {
      check(`random pose ${n} settles`, false);
      continue;
    }
    if (s.output.status === 'limited') edges++;
    table = await hook('tableClearance');
    probe = await hook('probeCollisions');
    const margin = probe.minMm - Math.max(0.25, Math.min(table.minMm, verifiedMm) - 0.25);
    if (margin < worst.margin) worst = { margin, detail: `pose ${JSON.stringify(s.output.pose)}: measured ${probe.minMm.toFixed(3)} mm (${probe.between}), tables ${table.minMm.toFixed(3)} mm (${table.between})` };
  }
  check('at 24 random poses (many at the safe edge) real gaps never fall below what the core promises', worst.margin >= 0, `${edges} at the edge; tightest: ${worst.detail}`);

  await setTargetAndSettle(neutral);
  await hook('playAnimation', 'look-up');
  s = await waitFor((x) => x.output.pose.pitchDeg > neutral.pitchDeg + 2, 4000);
  check('2019 "look-up" tilts the face up from neutral', !!s, s ? `pitch ${s.output.pose.pitchDeg.toFixed(2)}°` : 'timed out');
  await shot('03-look-up');
  s = await waitFor((x) => x.playing === null && near(x.output.pose, neutral), 6000);
  check('"look-up" finishes and returns to neutral', !!s);

  await hook('playAnimation', 'jiggle');
  s = await waitFor((x) => Math.abs(x.output.pose.rollDeg - neutral.rollDeg) > 1.5, 4000);
  check('2019 "jiggle" rolls the head', !!s, s ? `roll ${s.output.pose.rollDeg.toFixed(2)}°` : 'timed out');
  await waitFor((x) => x.playing === null && near(x.output.pose, neutral), 6000);

  await hook('react', 'wakeword');
  s = await waitFor((x) => x.litLeds.length >= 4 && x.output.pose.heaveMm > neutral.heaveMm + 1, 4000);
  check('"wakeword": LED circle and alert rise together', !!s, s ? `LEDs ${s.litLeds.join(',')}, heave ${s.output.pose.heaveMm.toFixed(2)} mm` : 'timed out');
  await shot('04-wakeword');
  await waitFor((x) => x.playing === null && near(x.output.pose, neutral) && x.litLeds.length === 0, 6000);

  await hook('playLeds', 'on', 'purple');
  s = await waitFor((x) => x.litLeds.length === 12, 2000);
  check('LED ring shows all 12 LEDs', !!s);
  await hook('setView', 'top');
  await page.waitForTimeout(300);
  await shot('05-leds-top');
  await hook('playLeds', 'off', 'red');

  await hook('setView', 'face');
  await page.waitForTimeout(300);
  s = await state();
  check('eyes are open at rest', s.eyes.rx === 87.5);
  await shot('06-face');

  await hook('setView', 'neck');
  const compound = { pitchDeg: neutral.pitchDeg - 1.5, rollDeg: neutral.rollDeg + 1.5, heaveMm: neutral.heaveMm + 0.5 };
  s = await setTargetAndSettle(compound);
  check('reaches a safe compound pose exactly', !!s && s.output.status === 'ok' && near(s.output.pose, compound, 1e-4));
  check('drawn horn tips match the kinematics in a compound pose', (await hook('hornTipError')) < 1e-6);
  check('drawn legs reach their ball joints in a compound pose', (await hook('legTopError')) < 0.25, `${(await hook('legTopError')).toFixed(3)} mm`);
  await page.waitForTimeout(200);
  await shot('07-neck');

  await hook('setView', 'three-quarter');
  const rollTarget = { ...neutral, rollDeg: 15 };
  const rollEdge = (await hook('safeEdge', rollTarget)).rollDeg;
  s = await setTargetAndSettle(rollTarget);
  check(
    'unsafe request (roll 15°) is held at the safe edge',
    !!s && s.output.status === 'limited' && Math.abs(s.output.pose.rollDeg - rollEdge) < 1e-3,
    s ? `roll ${s.output.pose.rollDeg.toFixed(3)}° (edge ${rollEdge.toFixed(3)}°)` : 'timed out',
  );
  await shot('08-limited-roll');

  // New head gestures: each plays through with the governor never holding it back.
  await hook('goNeutral');
  s = await waitFor((x) => x.mode === 'animator' && near(x.output.pose, neutral), 5000);
  check('"Neutral" hands the head back to the animator', !!s);
  const gestures = await hook('headAnimations');
  const gestureProblems = [];
  for (const { name, durationS } of gestures) {
    await hook('playHead', name);
    const started = Date.now();
    let worst = 'ok';
    let moved = 0;
    let shotTaken = false;
    for (;;) {
      const x = await state();
      if (x.output.status !== 'ok' && worst === 'ok') worst = `${x.output.status}: ${x.output.notes.join('; ')}`;
      const p = x.output.pose;
      moved = Math.max(moved, Math.hypot(p.pitchDeg - neutral.pitchDeg, p.rollDeg - neutral.rollDeg) + Math.abs(p.heaveMm - neutral.heaveMm));
      if (name === 'tilt' && !shotTaken && Date.now() - started > 700) {
        await hook('setView', 'face');
        await shot('09-gesture-tilt');
        await hook('setView', 'three-quarter');
        shotTaken = true;
      }
      if (x.gesture === null && Date.now() - started > 300) break;
      if (Date.now() - started > (durationS * 2 + 3) * 1000) {
        worst = 'never finished';
        break;
      }
      await page.waitForTimeout(25);
    }
    if (worst !== 'ok' || moved < 0.8) gestureProblems.push(`${name}: ${worst}, moved ${moved.toFixed(2)}`);
  }
  check(`all ${gestures.length} head gestures play without the governor holding them back`, gestureProblems.length === 0, gestureProblems.join(' | '));

  // The idle layer: small, smooth, safe motion.
  await hook('setIdle', true);
  let idleWorst = 'ok';
  let idleTilt = 0;
  let idleHeave = 0;
  for (let n = 0; n < 120; n++) {
    const x = await state();
    if (x.output.status !== 'ok' && idleWorst === 'ok') idleWorst = `${x.output.status}: ${x.output.notes.join('; ')}`;
    const p = x.output.pose;
    idleTilt = Math.max(idleTilt, Math.hypot(p.pitchDeg - neutral.pitchDeg, p.rollDeg - neutral.rollDeg));
    idleHeave = Math.max(idleHeave, Math.abs(p.heaveMm - neutral.heaveMm));
    await page.waitForTimeout(40);
  }
  check('idle: the head stays alive (breathing, drifting), small and safe', idleWorst === 'ok' && idleTilt + idleHeave > 0.05 && idleTilt < 3 && idleHeave < 1, `${idleWorst}; up to ${idleTilt.toFixed(2)}° and ${idleHeave.toFixed(2)} mm`);
} catch (error) {
  check('run completed', false, error.message);
}

check('no console errors, warnings or failed requests', problems.length === 0, problems.join(' | '));
console.log(results.join('\n'));
console.log(`Screenshots: ${outDir}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
