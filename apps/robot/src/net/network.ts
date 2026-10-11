import { execFile } from 'node:child_process';

export interface WifiNetwork {
  readonly ssid: string;
  /** 0–100. */
  readonly signal: number;
  readonly secure: boolean;
}

export interface NetworkStatus {
  readonly connected: boolean;
  /** The Wi-Fi network joined (null if none, or in setup mode). */
  readonly ssid: string | null;
  readonly ip: string | null;
  /** The setup network is up. */
  readonly hotspot: boolean;
}

/** Wi-Fi, as the setup flow needs it: on the robot through NetworkManager (nmcli), on a laptop pretended. */
export interface Network {
  status(): Promise<NetworkStatus>;
  scan(): Promise<WifiNetwork[]>;
  startHotspot(ssid: string, password: string): Promise<void>;
  stopHotspot(): Promise<void>;
  /** Joins a network (and remembers it, so it is joined again after a restart). */
  connect(ssid: string, password: string | null): Promise<{ readonly ok: boolean; readonly message: string }>;
  /** Whether its router answers (Wi-Fi can look connected and still have stopped passing anything). */
  reachable(): Promise<boolean>;
  /** Turns the Wi-Fi off and on again. */
  restartWifi(): Promise<void>;
}

export const HOTSPOT_CONNECTION = 'peeqo-setup';

/** Splits a line of nmcli's terse output (fields separated by ':', with '\:' and '\\' escaped). */
export function nmcliFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && i + 1 < line.length) current += line[++i];
    else if (ch === ':') {
      fields.push(current);
      current = '';
    } else current += ch;
  }
  fields.push(current);
  return fields;
}

/** The networks in `nmcli -t -f SSID,SIGNAL,SECURITY device wifi list`: named ones, strongest first, each once. */
export function parseWifiList(output: string): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [ssid = '', signal = '0', security = ''] = nmcliFields(line);
    if (!ssid.trim()) continue;
    const network = { ssid, signal: Math.max(0, Math.min(100, Number(signal) || 0)), secure: security.trim() !== '' && security.trim() !== '--' };
    const known = best.get(ssid);
    if (!known || known.signal < network.signal) best.set(ssid, network);
  }
  return [...best.values()].sort((a, b) => b.signal - a.signal);
}

type Run = (args: readonly string[], timeoutMs?: number) => Promise<string>;

/** Runs a program (not as root), resolving with what it printed; rejects if it fails. */
export type Exec = (file: string, args: readonly string[]) => Promise<string>;
const exec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/** NetworkManager through nmcli, run with sudo (the installer allows exactly that). */
export class NmcliNetwork implements Network {
  readonly #run: Run;
  readonly #exec: Exec;
  readonly #device: string;

  constructor(options: { device?: string; run?: Run; exec?: Exec } = {}) {
    this.#device = options.device ?? 'wlan0';
    this.#exec = options.exec ?? exec;
    this.#run =
      options.run ??
      ((args, timeoutMs = 20000) =>
        new Promise((resolve, reject) => {
          execFile('sudo', ['-n', 'nmcli', ...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
            if (error) reject(new Error((stderr || error.message).trim().split('\n').at(-1) ?? 'nmcli failed'));
            else resolve(stdout);
          });
        }));
  }

  async status(): Promise<NetworkStatus> {
    const devices = await this.#run(['-t', '-f', 'DEVICE,STATE,CONNECTION', 'device']);
    const row = devices
      .split('\n')
      .map(nmcliFields)
      .find((f) => f[0] === this.#device);
    const state = row?.[1] ?? '';
    const connection = row?.[2] ?? '';
    const connected = state === 'connected';
    const hotspot = connected && connection === HOTSPOT_CONNECTION;
    let ip: string | null = null;
    let ssid: string | null = null;
    if (connected) {
      const show = await this.#run(['-t', '-f', 'IP4.ADDRESS', 'device', 'show', this.#device]).catch(() => '');
      ip = /IP4\.ADDRESS\[\d+\]:([\d.]+)/.exec(show)?.[1] ?? null;
      if (!hotspot) {
        const active = await this.#run(['-t', '-f', 'ACTIVE,SSID', 'device', 'wifi', 'list', '--rescan', 'no']).catch(() => '');
        ssid = active.split('\n').map(nmcliFields).find((f) => f[0] === 'yes')?.[1] ?? connection;
      }
    }
    return { connected: connected && !hotspot, ssid, ip, hotspot };
  }

  async reachable(): Promise<boolean> {
    try {
      const routes = await this.#exec('ip', ['-4', 'route', 'show', 'default', 'dev', this.#device]);
      const gateway = /via ([\d.]+)/.exec(routes)?.[1];
      if (!gateway) return false;
      await this.#exec('ping', ['-c', '1', '-W', '3', gateway]);
      return true;
    } catch {
      return false;
    }
  }

  async restartWifi(): Promise<void> {
    await this.#run(['radio', 'wifi', 'off']);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await this.#run(['radio', 'wifi', 'on']);
  }

  async scan(): Promise<WifiNetwork[]> {
    return parseWifiList(await this.#run(['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'], 30000));
  }

  async startHotspot(ssid: string, password: string): Promise<void> {
    await this.#run(['device', 'wifi', 'hotspot', 'ifname', this.#device, 'con-name', HOTSPOT_CONNECTION, 'ssid', ssid, 'password', password], 30000);
    // Only on purpose: never come up by itself after a restart.
    await this.#run(['connection', 'modify', HOTSPOT_CONNECTION, 'connection.autoconnect', 'no']).catch(() => '');
  }

  async stopHotspot(): Promise<void> {
    await this.#run(['connection', 'down', HOTSPOT_CONNECTION]).catch(() => '');
  }

  async connect(ssid: string, password: string | null): Promise<{ ok: boolean; message: string }> {
    try {
      await this.#run(['--wait', '45', 'device', 'wifi', 'connect', ssid, ...(password ? ['password', password] : []), 'ifname', this.#device], 60000);
      return { ok: true, message: `Connected to ${ssid}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: /secrets|password|802-1x|psk/i.test(message) ? 'The password was not accepted.' : message };
    }
  }
}

/** A laptop's stand-in: a few made-up networks; any password but "wrongpassword" works. */
export class FakeNetwork implements Network {
  #state: NetworkStatus;
  readonly networks: WifiNetwork[] = [
    { ssid: 'Home Wi-Fi', signal: 82, secure: true },
    { ssid: 'Cafe', signal: 55, secure: false },
    { ssid: 'Neighbours', signal: 31, secure: true },
  ];
  readonly #delayMs: number;

  constructor(options: { connected?: boolean; delayMs?: number } = {}) {
    this.#delayMs = options.delayMs ?? 800;
    this.#state = options.connected === false ? { connected: false, ssid: null, ip: null, hotspot: false } : { connected: true, ssid: 'Home Wi-Fi', ip: '127.0.0.1', hotspot: false };
  }

  async status(): Promise<NetworkStatus> {
    return this.#state;
  }

  async scan(): Promise<WifiNetwork[]> {
    return [...this.networks];
  }

  /** (Pretend: the router answers whenever connected, unless told otherwise.) */
  routerAnswers = true;
  wifiRestarts = 0;

  async reachable(): Promise<boolean> {
    return this.#state.connected && this.routerAnswers;
  }

  async restartWifi(): Promise<void> {
    this.wifiRestarts++;
  }

  async startHotspot(): Promise<void> {
    this.#state = { connected: false, ssid: null, ip: '10.42.0.1', hotspot: true };
  }

  async stopHotspot(): Promise<void> {
    if (this.#state.hotspot) this.#state = { connected: false, ssid: null, ip: null, hotspot: false };
  }

  async connect(ssid: string, password: string | null): Promise<{ ok: boolean; message: string }> {
    await new Promise((r) => setTimeout(r, this.#delayMs));
    if (password === 'wrongpassword') {
      this.#state = { connected: false, ssid: null, ip: null, hotspot: false };
      return { ok: false, message: 'The password was not accepted.' };
    }
    this.#state = { connected: true, ssid, ip: '127.0.0.1', hotspot: false };
    return { ok: true, message: `Connected to ${ssid}` };
  }
}
