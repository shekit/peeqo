// Drives the robot's pages in Chrome against the service with fake hardware (no Pi needed), and fails on any
// problem: the phone setup (a wrong Wi-Fi password, then the right one), signing in, talking, memory, the face
// screen, the buttons, and the whole calibration wizard (the range step included).
//
//   npm run build -w @peeqo/robot && npm run verify -w @peeqo/robot [-- <screenshot-dir>]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(app, '../sim/package.json'));
const { chromium } = require('playwright-core');
const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const port = 8000 + Math.floor(Math.random() * 900);
const base = `http://localhost:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peeqo-verify-'));
const results = [];
let failed = false;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
};

// The service, as if Peeqo knew no Wi-Fi (so setup runs first).
const service = spawn(process.execPath, [path.join(app, 'src/main.ts'), '--fake', '--setup', '--port', String(port), '--data', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
service.stdout.on('data', (d) => (log += d));
service.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 80; i++) {
  const up = await fetch(`${base}/api/info`).then((r) => r.ok, () => false);
  if (up) break;
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
const watch = (page, label) => {
  page.on('pageerror', (e) => problems.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    // Answers the checks below provoke on purpose (a wrong PIN, a refused setup) show up as failed requests.
    if (m.type() === 'error' && !/status of (400|401|403|429)/.test(m.text())) problems.push(`${label}: ${m.text()}`);
  });
};
const shot = async (page, name) => shots && page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

try {
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  const face = await context.newPage();
  watch(face, 'face');
  await face.setViewportSize({ width: 800, height: 480 });
  await face.goto(`${base}/face`);
  await face.waitForFunction(() => /Set me up/.test(document.getElementById('screen').innerText), null, { timeout: 8000 });
  check('setup: the face shows how to join, with a QR code', (await face.locator('#screen svg').count()) === 1);
  await shot(face, '1-face-setup');

  // The dev kit's screen is 480×800 on its side: turned, the face fills it.
  const turned = await context.newPage();
  watch(turned, 'turned face');
  await turned.setViewportSize({ width: 480, height: 800 });
  await turned.goto(`${base}/face?rotate=90`);
  const box = await turned.locator('.stage').boundingBox();
  check('face: turned for a screen on its side, it fills the screen', box && Math.abs(box.x) < 1 && Math.abs(box.y) < 1 && Math.abs(box.width - 480) < 1 && Math.abs(box.height - 800) < 1, JSON.stringify(box));
  await shot(turned, '1-face-turned');
  await turned.close();

  // (fetch will not send another Host; a phone asking captive.apple.com arrives here with that Host.)
  const probe = await new Promise((resolve, reject) =>
    http.get({ host: 'localhost', port, path: '/hotspot-detect.html', headers: { Host: 'captive.apple.com' } }, (res) => resolve({ status: res.statusCode, location: res.headers.location })).on('error', reject),
  );
  check('setup: a phone checking for a captive portal is sent to the setup page', probe.status === 302 && probe.location === 'http://10.42.0.1/setup', JSON.stringify(probe));

  const phone = await context.newPage();
  watch(phone, 'setup');
  await phone.setViewportSize({ width: 400, height: 800 });
  await phone.goto(`${base}/setup`);
  await phone.waitForSelector('input[type=radio]');
  check('setup: the networks are listed, and the other-network box hidden', (await phone.locator('label.row').count()) === 4 && !(await phone.getByText('Other network', { exact: true }).isVisible()));
  await phone.locator('input[type=password]').first().fill('short');
  await phone.fill('input[inputmode=numeric]', '2468');
  await phone.click('button[type=submit]');
  await phone.waitForFunction(() => /8 to 63/.test(document.body.innerText));
  await phone.locator('input[type=password]').first().fill('wrongpassword');
  await phone.click('button[type=submit]');
  await face.waitForFunction(() => /Setup: try again/.test(document.getElementById('screen').innerText), null, { timeout: 10000 });
  check('setup: a wrong password brings the setup network back, and the face says why', /not accepted/.test(await face.locator('#screen').innerText()));
  await phone.reload();
  await phone.waitForSelector('input[type=radio]');
  await phone.locator('input[type=password]').first().fill('rightpassword');
  await phone.click('button[type=submit]');
  await face.waitForFunction(() => /I'm on Home Wi-Fi/.test(document.getElementById('screen').innerText), null, { timeout: 10000 });
  check('setup: the right password joins, and the face shows the address', true);
  await shot(face, '2-face-address');

  const panel = await context.newPage();
  watch(panel, 'panel');
  await panel.goto(base);
  await panel.fill('input[type=password]', '1111');
  await panel.click('button.primary');
  await panel.waitForFunction(() => /not right/.test(document.body.innerText));
  await panel.fill('input[type=password]', '2468');
  await panel.click('button.primary');
  await panel.waitForSelector('text=What Peeqo remembers');
  check('panel: a wrong PIN is refused, the right one signs in', true);

  await panel.fill('input[placeholder^="Say something"]', 'My name is Sam');
  await panel.keyboard.press('Enter');
  await panel.waitForFunction(() => /Nice to meet you, Sam/.test(document.body.innerText), null, { timeout: 15000 });
  check('panel: Peeqo answers, and remembers the name', (await panel.locator('text=Their name is Sam.').count()) > 0);
  await face.waitForFunction(() => true);

  // The calibration wizard, through its buttons.
  const card = panel.locator('section.card', { hasText: 'Calibration' });
  const click = async (name, times = 1) => {
    for (let i = 0; i < times; i++) {
      await card.getByRole('button', { name, exact: true }).click();
      await panel.waitForTimeout(40);
    }
  };
  const state = () => panel.evaluate(() => fetch('/api/state').then((r) => r.json()));
  await click('Start calibration');
  await card.getByText('Plug 1 of 3', { exact: false }).waitFor();
  for (const [i, arm] of ['1 · Front', '2 · Peeqo’s right', '3 · Peeqo’s left'].entries()) {
    await card.getByText(`Plug ${i + 1} of 3`, { exact: false }).waitFor();
    await click('▲', 3);
    await card.getByText('moved 3°', { exact: true }).waitFor();
    if (i === 0) await shot(panel, '3-calibration-find');
    await card.getByRole('group', { name: arm }).getByRole('button', { name: 'Up', exact: true }).click();
    await panel.waitForTimeout(150);
  }
  for (let s = 0; s < 3; s++) {
    await card.getByRole('button', { name: 'It’s level', exact: true }).waitFor();
    await click('It’s level');
    await panel.waitForTimeout(150);
  }
  // The range, with the whole head: down 10° (room to tilt below level, where Peeqo stands), then up to 45°.
  await card.getByRole('button', { name: 'Mark lowest', exact: true }).waitFor();
  await click('▼▼', 4);
  await card.getByText(/Arms at -10\.0°/).waitFor();
  await click('Mark lowest');
  await click('▲▲', 22);
  await card.getByText(/Arms at 45\.0°/).waitFor();
  await shot(panel, '4-calibration-range');
  await click('Mark highest');
  await panel.waitForTimeout(150);
  let st = await state();
  check('calibration: the range marked with the whole head, and Peeqo at its neutral pose', st.calibration.step === 'level' && st.calibration.rangeUs.every((r) => r && r[1] - r[0] > 600));
  await click('Tilt back');
  await click('Next: check the tilt');
  await card.locator('input[type=number]').fill('3.0');
  await click('Use reading');
  await card.getByText('Calibrated. Fine-tune').waitFor();
  await click('Save');
  await panel.waitForTimeout(800);
  st = await state();
  check('calibration: saved, with the measured ranges', st.robot.servos.calibrated && st.calibration.step === 'off' && st.logs.some((l) => /calibration saved: .* ranges /.test(l)));
  await shot(panel, '5-panel');

  // Expressions: a click plays it on Peeqo, and the panel marks it.
  const expressions = panel.locator('section.card', { hasText: 'Head moves' });
  await expressions.getByRole('button', { name: 'happy', exact: true }).click();
  await expressions.locator('button.active', { hasText: 'happy' }).waitFor({ timeout: 3000 });
  await expressions.getByRole('button', { name: 'nod', exact: true }).click();
  await panel.waitForTimeout(300);
  st = await state();
  check('expressions: a click plays it on Peeqo, and the panel marks it', st.robot.character.move === 'nod' && (await expressions.locator('button.active').count()) >= 1);
  await shot(panel, '6-expressions');

  // Buttons (pretend ones on a laptop): a tap listens (no microphone here, and it says so).
  await panel.click('text=Tap');
  await panel.waitForFunction(() => /no microphone to listen with/.test(document.body.innerText), null, { timeout: 5000 });
  check('buttons: a tap listens', true);
} catch (error) {
  check('run completed', false, error.message);
}
check('no errors on the pages', problems.length === 0, problems.join(' | '));
await browser.close();
service.kill('SIGTERM');
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(results.join('\n'));
if (failed) console.log(`\nService log:\n${log.split('\n').slice(-30).join('\n')}`);
process.exit(failed ? 1 : 0);
