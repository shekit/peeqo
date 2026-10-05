// Peeqo's service on the robot: node apps/robot/src/main.ts [--fake] [--port N] [--data DIR] [--setup] [--mic DEV] [--speaker DEV]
//
//   --fake     no hardware (a laptop): the hardware helper pretends, Wi-Fi is made up, nothing is shut down
//   --port     the web server's port (default 80 on the robot, 8080 with --fake)
//   --data     where config, memory and the conversation are kept (default ~/.peeqo, or apps/robot/.data with --fake)
//   --setup    with --fake: start as if no Wi-Fi were known (to try the setup page)
//   --mic      ALSA capture device (default: the default one; see arecord -L)
//   --speaker  ALSA playback device (default: the default one; see aplay -L)

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST_US } from './hardware/calibration.ts';
import { CalibrationSession } from './hardware/calibrationSession.ts';
import { FakeNetwork, NmcliNetwork } from './net/network.ts';
import { SETUP_ADDRESS, SetupController } from './net/setup.ts';
import { Robot } from './robot.ts';
import { RobotServer } from './web/server.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const appDir = fileURLToPath(new URL('..', import.meta.url));
const fake = flag('fake');
const dataDir = path.resolve(option('data') ?? (fake ? path.join(appDir, '.data') : path.join(os.homedir(), '.peeqo')));
const port = Number(option('port') ?? (fake ? 8080 : 80));

const robot = new Robot({ dataDir, fake, appDir, micDevice: option('mic') ?? null, speakerDevice: option('speaker') ?? null });
const calibration = new CalibrationSession({
  raw: (pulses) => robot.servos.raw(pulses),
  neutral: robot.governor.neutral,
  save: (result) => {
    robot.config.update({ calibration: result });
    robot.servos.setCalibration(result);
    robot.calibrating = false;
    robot.log(`calibration saved: channels ${result.channels.join(',')}, level ${result.levelUs.map((u) => u.toFixed(0)).join('/')} µs, ${result.usPerDeg.toFixed(2)} µs/°${result.checked ? ' (checked)' : ''}`);
  },
  cancel: () => {
    robot.calibrating = false;
    // Not calibrated before: hold at the resting pulse. Calibrated before: the governor takes over again.
    if (!robot.servos.calibration) robot.servos.raw([REST_US, REST_US, REST_US]);
    robot.log('calibration cancelled');
  },
});
const network = fake ? new FakeNetwork({ connected: !flag('setup') }) : new NmcliNetwork();
const setup = new SetupController({
  network,
  config: robot.config,
  showScreen: (screen) => robot.showScreen(screen),
  applySettings: () => robot.applySettings(),
  log: (line) => robot.log(line),
  hostname: os.hostname().split('.')[0] || 'peeqo',
});
robot.onSetupRequested = () => void setup.enter('a button was held');
robot.onShowAddress = () => setup.showAddress();
const server = new RobotServer({
  robot,
  setup,
  calibration,
  webDir: path.join(appDir, 'dist', 'web'),
  port,
  setupAddress: SETUP_ADDRESS,
  sessionsFile: path.join(dataDir, 'sessions.json'),
});

await robot.start();
await server.listen();
robot.log(`panel: http://${fake ? 'localhost' : `${os.hostname().split('.')[0]}.local`}${port === 80 ? '' : `:${port}`}/  face: /face  data: ${dataDir}`);
void setup.boot(fake ? 0 : 45000);

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  robot.log(`stopping (${signal})`);
  await Promise.race([Promise.all([robot.stop(), server.close()]), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
