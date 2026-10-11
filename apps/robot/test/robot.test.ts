import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MIC_CHUNK } from '../src/audio/microphone.ts';
import { UtteranceRecorder } from '../src/audio/recorder.ts';
import { ButtonGestures, SETUP_HOLD_MS, SHUTDOWN_HOLD_MS } from '../src/buttons.ts';
import { ConfigStore, hashPin, verifyPin } from '../src/config.ts';
import { REST_US } from '../src/hardware/calibration.ts';
import { CalibrationSession } from '../src/hardware/calibrationSession.ts';
import { healthChanges, HealthMonitor, parseThrottled } from '../src/health.ts';
import { FakeNetwork, NmcliNetwork, nmcliFields, parseWifiList } from '../src/net/network.ts';
import { SETUP_ADDRESS, SetupController, WIFI_CHECK_MS, WIFI_LOST_MS } from '../src/net/setup.ts';
import { ROBOT_LIMITS, Robot } from '../src/robot.ts';
import { RobotServer } from '../src/web/server.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'peeqo-robot-'));

describe('buttons', () => {
  it('tap to talk, press to see the address, hold 3 s to shut down, 10 s for setup', () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const did: string[] = [];
      const buttons = new ButtonGestures(
        { tap: (p) => did.push(`tap ${p}`), medium: (p) => did.push(`medium ${p}`), holding: (p, s) => did.push(`holding ${p} ${s}`), shutdown: () => did.push('shutdown'), setup: () => did.push('setup') },
        () => now,
      );
      const press = (ms: number) => {
        buttons.change(16, true);
        now += ms;
        vi.advanceTimersByTime(ms);
        buttons.change(16, false);
      };
      press(100); // not armed yet: ignored, but the release arms it
      expect(did).toEqual([]);
      press(100);
      press(1500);
      press(SHUTDOWN_HOLD_MS + 500);
      press(SETUP_HOLD_MS + 500);
      expect(did).toEqual(['tap 16', 'medium 16', 'holding 16 shutdown', 'shutdown', 'holding 16 shutdown', 'holding 16 setup', 'setup']);
      buttons.arm([17]);
      did.length = 0;
      buttons.change(17, true);
      buttons.change(17, false);
      expect(did).toEqual(['tap 17']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the utterance recorder', () => {
  const chunk = (level: number) => Int16Array.from({ length: MIC_CHUNK }, (_, i) => Math.round(Math.sin(i / 3) * level));

  it('records from the start until a short quiet after speech, and gives up on silence', () => {
    const utterances: string[] = [];
    let nothing = 0;
    const recorder = new UtteranceRecorder({ onUtterance: (wav) => utterances.push(wav), onNothing: () => nothing++ });
    for (let i = 0; i < 10; i++) recorder.chunk(chunk(0), 0);
    recorder.start();
    for (let i = 0; i < 8; i++) recorder.chunk(chunk(9000), 0.9);
    expect(recorder.recording).toBe(true);
    for (let i = 0; i < 10; i++) recorder.chunk(chunk(10), 0.05);
    expect(recorder.recording).toBe(false);
    expect(utterances).toHaveLength(1);
    const wav = Buffer.from(utterances[0]!, 'base64');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe((4 + 8 + 10) * MIC_CHUNK * 2); // 4 chunks from before it started, then all of it
    recorder.start(0);
    for (let i = 0; i < 60; i++) recorder.chunk(chunk(10), 0.02);
    expect(nothing).toBe(1);
    // Judged by loudness when there is no detector: a loud stretch is speech.
    recorder.start(0);
    for (let i = 0; i < 6; i++) recorder.chunk(chunk(12000), null);
    for (let i = 0; i < 12; i++) recorder.chunk(chunk(5), null);
    expect(utterances).toHaveLength(2);
  });
});

describe('Wi-Fi', () => {
  it("reads nmcli's terse output, escapes and all", () => {
    expect(nmcliFields('My\\:Net:72:WPA2')).toEqual(['My:Net', '72', 'WPA2']);
    expect(parseWifiList('Home:40:WPA2\nHome:80:WPA2\n:90:WPA2\nCafe:55:\nBack\\\\slash:10:WPA1 WPA2\n')).toEqual([
      { ssid: 'Home', signal: 80, secure: true },
      { ssid: 'Cafe', signal: 55, secure: false },
      { ssid: 'Back\\slash', signal: 10, secure: true },
    ]);
  });

  it('sets up with a QR code, joins, and comes back with the reason when joining fails', async () => {
    const dir = tempDir();
    const config = new ConfigStore(dir);
    const screens: (string | null)[] = [];
    const network = new FakeNetwork({ connected: false, delayMs: 0 });
    const setup = new SetupController({
      network,
      config,
      showScreen: (s) => screens.push(s ? `${s.title}${s.qr ? ` [${s.qr}]` : ''}` : null),
      applySettings: () => undefined,
      log: () => undefined,
      hostname: 'peeqo',
      random: () => 0.5,
      sleep: async () => undefined,
    });
    await setup.boot(0);
    expect(setup.open).toBe(true);
    expect(screens.at(-1)).toBe('Set me up! [WIFI:T:WPA;S:Peeqo-Setup-SSSS;P:ssssssss;;]'); // (random 0.5: the middle of the alphabet)
    expect(await setup.submit({ ssid: 'Home Wi-Fi', password: 'rightpassword' })).toEqual({ ok: false, message: 'Choose a PIN for the panel.' });
    expect((await setup.submit({ ssid: 'Home Wi-Fi', password: 'short', pin: '1234' })).message).toMatch(/8 to 63/);
    expect((await setup.submit({ ssid: 'Home Wi-Fi', password: 'wrongpassword', pin: '1234', openrouter: ' sk-or-x ' })).ok).toBe(true);
    await vi.waitFor(() => expect(setup.view().phase).toBe('failed'));
    expect(setup.view().error).toMatch(/not accepted/);
    expect(config.config.keys.openrouter).toBe('sk-or-x');
    expect(config.checkPin('1234')).toBe(true);
    expect(screens.at(-1)).toMatch(/^Setup: try again \[WIFI:/);
    await setup.submit({ ssid: 'Home Wi-Fi', password: 'rightpassword' }); // the PIN is kept
    await vi.waitFor(() => expect(setup.open).toBe(false));
    await vi.waitFor(() => expect(screens.at(-1)).toBe("I'm on Home Wi-Fi [http://127.0.0.1/]"));
  });

  it('turns the Wi-Fi off and on again once the router has not answered for two minutes (and not while setting up)', async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const network = new FakeNetwork({ delayMs: 0 });
      const setup = new SetupController({ network, config: new ConfigStore(tempDir()), showScreen: () => undefined, applySettings: () => undefined, log: (l) => logs.push(l), hostname: 'peeqo' });
      const stop = setup.watch();
      const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
      await wait(WIFI_CHECK_MS * 4);
      expect(network.wifiRestarts).toBe(0); // the router answers
      network.routerAnswers = false;
      await wait(WIFI_CHECK_MS);
      expect(logs.at(-1)).toMatch(/does not answer/);
      await wait(WIFI_LOST_MS - WIFI_CHECK_MS);
      expect(network.wifiRestarts).toBe(0);
      await wait(WIFI_CHECK_MS);
      expect(network.wifiRestarts).toBe(1);
      await wait(WIFI_LOST_MS);
      expect(network.wifiRestarts).toBe(2); // and again while it stays silent
      network.routerAnswers = true;
      await wait(WIFI_CHECK_MS);
      expect(logs.at(-1)).toMatch(/answers again/);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the router, through the default route', async () => {
    const ran: string[] = [];
    const network = (answers: boolean) =>
      new NmcliNetwork({
        run: async () => '',
        exec: async (file, args) => {
          ran.push(`${file} ${args.join(' ')}`);
          if (file === 'ip') return 'default via 10.15.75.1 dev wlan0 proto dhcp src 10.15.75.182 metric 600\n';
          if (!answers) throw new Error('no answer');
          return '';
        },
      });
    expect(await network(true).reachable()).toBe(true);
    expect(ran.at(-1)).toBe('ping -c 1 -W 3 10.15.75.1');
    expect(await network(false).reachable()).toBe(false);
  });
});

describe('heat and power', () => {
  it("reads the firmware's flags, and logs only what changes", async () => {
    expect(parseThrottled('throttled=0x0')).toEqual({ underVoltage: false, underVoltageSeen: false, slowedForHeat: false, throttled: false });
    expect(parseThrottled('throttled=0x50005')).toEqual({ underVoltage: true, underVoltageSeen: true, slowedForHeat: false, throttled: true });
    expect(parseThrottled('throttled=0x80008')).toMatchObject({ slowedForHeat: true, underVoltage: false });
    expect(parseThrottled('nonsense')).toBeNull();
    const calm = { tempC: 50, underVoltage: false, underVoltageSeen: false, slowedForHeat: false, throttled: false };
    expect(healthChanges(calm, calm)).toEqual([]);
    expect(healthChanges(calm, { ...calm, tempC: 61, slowedForHeat: true })).toEqual(['heat: the Pi is slowing itself down a little to stay cool (61 °C)']);
    expect(healthChanges(calm, { ...calm, underVoltage: true, underVoltageSeen: true })[0]).toMatch(/under-voltage/);
    let flags = 'throttled=0x0';
    const logs: string[] = [];
    const monitor = new HealthMonitor((l) => logs.push(l), { temperature: async () => '62838\n', throttled: async () => flags });
    await monitor.check();
    expect(monitor.health.tempC).toBe(62.8);
    expect(logs).toEqual([]);
    flags = 'throttled=0x80008';
    await monitor.check();
    await monitor.check();
    expect(logs).toEqual(['heat: the Pi is slowing itself down a little to stay cool (63 °C)']);
  });
});

describe('shutting down', () => {
  it('forces it if asking fails, and if even that fails says it is safe to unplug', async () => {
    const ran: string[] = [];
    const robot = new Robot({ dataDir: tempDir(), fake: true, appDir: APP_DIR, log: () => undefined, system: async (c) => (ran.push(c.join(' ')), 'Access denied') });
    await robot.shutdown();
    expect(ran).toEqual(['systemctl poweroff', 'systemctl poweroff --force']);
    expect(robot.face.screen).toMatchObject({ title: "I couldn't shut down", tone: 'warn' });
    expect(robot.face.screen?.lines).toContain('It is safe to unplug me now.');
  });

  it('forces it if the system has not stopped Peeqo half a minute after being asked', async () => {
    vi.useFakeTimers();
    try {
      const ran: string[] = [];
      const robot = new Robot({ dataDir: tempDir(), fake: true, appDir: APP_DIR, log: () => undefined, system: async (c) => (ran.push(c.join(' ')), null) });
      const done = robot.reboot();
      await vi.advanceTimersByTimeAsync(3000);
      await done;
      expect(ran).toEqual(['systemctl reboot']);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ran).toEqual(['systemctl reboot', 'systemctl reboot --force']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('config', () => {
  it('keeps the PIN only as a salted hash, and survives a damaged file', () => {
    const hash = hashPin('2468');
    expect(hash).not.toContain('2468');
    expect(verifyPin('2468', hash)).toBe(true);
    expect(verifyPin('2469', hash)).toBe(false);
    expect(hashPin('2468')).not.toBe(hash); // salted
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
    expect(new ConfigStore(dir).config.pinHash).toBeNull();
    const store = new ConfigStore(dir);
    store.setPin('1234');
    expect((fs.statSync(path.join(dir, 'config.json')).mode & 0o777).toString(8)).toBe('600'); // keys inside: only the robot's user
  });
});

describe('the robot (no hardware) and its web server', () => {
  let robot: Robot;
  let server: RobotServer;
  let base: string;
  let dir: string;
  let session = '';

  beforeAll(async () => {
    dir = tempDir();
    robot = new Robot({ dataDir: dir, fake: true, appDir: APP_DIR, log: () => undefined });
    const calibration = new CalibrationSession({ raw: (p) => robot.servos.raw(p), neutral: robot.governor.neutral, save: (c) => robot.useCalibration(c), cancel: () => undefined });
    const setup = new SetupController({ network: new FakeNetwork(), config: robot.config, showScreen: () => undefined, applySettings: () => undefined, log: () => undefined, hostname: 'peeqo' });
    server = new RobotServer({ robot, setup, calibration, webDir: path.join(APP_DIR, 'dist', 'web'), port: 0, host: '127.0.0.1', setupAddress: SETUP_ADDRESS, sessionsFile: path.join(dir, 'sessions.json') });
    await robot.start();
    await server.listen();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await robot.stop();
    await server.close();
  });

  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });

  it('keeps everything behind the PIN, refuses other sites, and locks out guessing', async () => {
    expect(robot.governor.limits).toBe(ROBOT_LIMITS);
    expect(robot.governor.neutral).toEqual({ pitchDeg: 0, rollDeg: 0, heaveMm: 0 }); // arms level
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    // Before a PIN exists, the setup endpoint takes one.
    expect((await post('/api/setup', { pin: '24' })).status).toBe(400);
    expect((await post('/api/setup', { pin: '2468' })).status).toBe(200);
    // Changes from another site are refused before anything else.
    expect((await post('/api/login', { pin: '2468' }, { Origin: 'http://evil.example' })).status).toBe(403);
    const ok = await post('/api/login', { pin: '2468' });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly; SameSite=Strict/);
    session = cookie.split(';')[0]!;
    const state = (await (await fetch(`${base}/api/state`, { headers: { Cookie: session } })).json()) as { robot: { servos: { calibrated: boolean } }; settings: { keys: { openrouter: boolean } } };
    expect(state.robot.servos.calibrated).toBe(false);
    expect(JSON.stringify(state)).not.toContain('pinHash');
    // Keys are write-only: the panel learns whether one is set, never what it is.
    expect((await post('/api/settings', { openrouter: 'sk-or-secret' }, { Cookie: session })).status).toBe(200);
    const after = await (await fetch(`${base}/api/state`, { headers: { Cookie: session } })).text();
    expect(after).not.toContain('sk-or-secret');
    expect(after).toContain('"openrouter":true');
    // Once a PIN exists, setup is closed (unless signed in, or setting up).
    expect((await fetch(`${base}/api/setup`)).status).toBe(403);
    // Guessing: five wrong PINs, then even the right one waits.
    for (let i = 0; i < 5; i++) expect((await post('/api/login', { pin: '0000' })).status).toBe(401);
    expect((await post('/api/login', { pin: '2468' })).status).toBe(429);
    // Sessions survive a restart (kept hashed).
    const saved = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
    expect(saved).not.toContain(session.split('=')[1]!);
  });

  it('takes a calibration with measured ranges into the governor, and refuses ranges that leave no room for its normal pose', () => {
    const base = { version: 1 as const, channels: [1, 0, 2] as const, directions: [-1, -1, -1] as const, levelUs: [1530, 1530, 1530] as const, usPerDeg: 2060 / 180, checked: true };
    // Without measured ranges, no.
    expect(robot.useCalibration(base)).toMatch(/no measured ranges/);
    // Every arm only goes from 2.6° to 37.6° above level: its neutral pose (level) is out of reach.
    const tight = { ...base, rangeUs: [[1100, 1500], [1100, 1500], [1100, 1500]] as const };
    expect(robot.useCalibration(tight)).toMatch(/does not fit inside the ranges you marked/);
    expect(robot.governor.limits.hornRangesDeg).toBeUndefined();
    // A real range: the governor holds each servo inside it, a margin in from the marks.
    const fine = { ...base, rangeUs: [[900, 1560], [950, 1560], [900, 1560]] as const };
    expect(robot.useCalibration(fine)).toBeNull();
    const ranges = robot.governor.limits.hornRangesDeg!;
    expect(ranges[1][1]).toBeCloseTo((1530 - 950) / (2060 / 180) - 1.5, 6);
    expect(robot.config.config.calibration?.rangeUs).toEqual(fine.rangeUs);
    expect(robot.servos.calibration).toEqual(fine);
    // Head moves are sized to the room the marks leave: little below level here, so they shrink; much more with arms
    // that swing far either way (like the dev kit's), so they grow.
    expect(robot.animator.size).toBeLessThan(0.5);
    const wide = { ...base, rangeUs: [[600, 2400], [600, 2400], [600, 2400]] as const };
    expect(robot.useCalibration(wide)).toBeNull();
    expect(robot.animator.size).toBeGreaterThan(2.2);
  });

  it('talks, and calibrates only from the resting pulse', async () => {
    expect((await post('/api/say', { text: 'hi' }, { Cookie: `peeqo_session=${'0'.repeat(64)}` })).status).toBe(401); // a made-up session is no good
    // Back to the offline brain (the last test set a made-up OpenRouter key), through the session from before.
    expect((await post('/api/settings', { openrouter: '' }, { Cookie: session })).status).toBe(200);
    expect((await post('/api/say', { text: 'My name is Ada' }, { Cookie: session })).status).toBe(200);
    await vi.waitFor(() => expect(robot.memory.facts).toContain('Their name is Ada.'), { timeout: 5000 });
    await vi.waitFor(() => expect(robot.transcript.map((l) => l.text)).toContain('Nice to meet you, Ada!'), { timeout: 5000 });
    robot.calibrating = true;
    robot.servos.raw([REST_US, REST_US, REST_US]);
    expect(robot.servos.state.mode).toBe('raw');
    robot.calibrating = false;
  });

  it('plays expressions, head moves and light patterns from the panel, and nothing it does not know', async () => {
    expect((await fetch(`${base}/api/expressions`)).status).toBe(401);
    const list = (await (await fetch(`${base}/api/expressions`, { headers: { Cookie: session } })).json()) as Record<string, { name: string; description: string }[]>;
    expect([list.expressions!.length, list.moves!.length, list.lights!.length]).toEqual([23, 16, 12]);
    expect(list.expressions!.find((e) => e.name === 'happy')?.description).toBeTruthy();
    expect((await post('/api/play', { kind: 'expression', name: 'happy' }, { Cookie: session })).status).toBe(200);
    expect(robot.character.expression).toBe('happy');
    expect((await post('/api/play', { kind: 'move', name: 'nod' }, { Cookie: session })).status).toBe(200);
    expect(robot.animator.playing).toBe('nod');
    expect((await post('/api/play', { kind: 'lights', name: 'rainbow' }, { Cookie: session })).status).toBe(200);
    expect(robot.state().character.lights).toBe('rainbow');
    for (const bad of [{ kind: 'expression', name: 'nod' }, { kind: 'move', name: 'rm -rf' }, { kind: 'sound', name: 'happy' }, {}]) {
      expect((await post('/api/play', bad, { Cookie: session })).status).toBe(400);
    }
    expect((await post('/api/play', { kind: 'expression', name: 'happy' })).status).toBe(401);
  });
});
