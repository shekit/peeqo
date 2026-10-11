import type { ConfigStore } from '../config.ts';
import { validPin } from '../config.ts';
import type { FaceScreen } from '../face/mirroredFace.ts';
import type { Network, WifiNetwork } from './network.ts';

export type SetupPhase = 'off' | 'hotspot' | 'connecting' | 'failed';

export interface SetupView {
  readonly phase: SetupPhase;
  /** The setup network to join (while it is up). */
  readonly hotspot: { readonly ssid: string; readonly password: string } | null;
  readonly error: string | null;
  readonly networks: readonly WifiNetwork[];
  /** Whether a PIN has been chosen (the setup page asks for one if not). */
  readonly hasPin: boolean;
}

export interface SetupForm {
  readonly ssid?: string;
  readonly password?: string | null;
  readonly pin?: string;
  readonly openrouter?: string;
  readonly klipy?: string;
}

export interface SetupDeps {
  readonly network: Network;
  readonly config: ConfigStore;
  readonly showScreen: (screen: FaceScreen | null) => void;
  /** The config's keys changed: rebuild the brain. */
  readonly applySettings: () => void;
  readonly log: (line: string) => void;
  /** Name on the network (peeqo → peeqo.local). */
  readonly hostname: string;
  readonly random?: () => number;
  /** Waits (replaced in tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The time, ms (replaced in tests). */
  readonly now?: () => number;
}

/** The Wi-Fi watchdog: how often it checks, and how long the router may stay silent before the Wi-Fi is restarted. */
export const WIFI_CHECK_MS = 30_000;
export const WIFI_LOST_MS = 120_000;

/** The robot's address on its own setup network (NetworkManager's shared-connection default). */
export const SETUP_ADDRESS = '10.42.0.1';

/** Letters and digits that cannot be mistaken for each other when read off a screen. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * Getting Peeqo onto someone's Wi-Fi, like a smart speaker: when it knows no network (or a button is held for 10 s)
 * it starts its own "Peeqo-Setup-XXXX" network and shows a QR code on its face. Scanning it joins that network and
 * opens the setup page, where they choose their Wi-Fi, a PIN for the panel and (optionally) the API keys. Peeqo then
 * joins their network and shows its address; if that fails it puts the setup network back up and says why.
 */
export class SetupController {
  readonly #deps: SetupDeps;
  readonly #sleep: (ms: number) => Promise<void>;
  #phase: SetupPhase = 'off';
  #hotspot: { ssid: string; password: string } | null = null;
  #error: string | null = null;
  #networks: WifiNetwork[] = [];
  #addressTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SetupDeps) {
    this.#deps = deps;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The setup page and its captive portal are open (only while setting up). */
  get open(): boolean {
    return this.#phase !== 'off';
  }

  view(): SetupView {
    return { phase: this.#phase, hotspot: this.#hotspot, error: this.#error, networks: this.#networks, hasPin: this.#deps.config.config.pinHash !== null };
  }

  /** At start-up: wait a while for a known network; without one, set up. */
  async boot(waitMs = 45000): Promise<void> {
    const until = Date.now() + waitMs;
    for (;;) {
      const status = await this.#deps.network.status().catch(() => null);
      if (status?.connected) {
        this.#showAddress(20000);
        return;
      }
      if (Date.now() >= until) break;
      await this.#sleep(3000);
    }
    await this.enter('no known Wi-Fi network');
  }

  /** Starts the setup network and shows how to join it. */
  async enter(reason: string): Promise<void> {
    this.#deps.log(`setup mode: ${reason}`);
    this.#clearAddress();
    // Look around first: with one radio, scanning is unreliable once the setup network is up.
    this.#networks = await this.#deps.network.scan().catch(() => this.#networks);
    const random = this.#deps.random ?? Math.random;
    const pick = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]!).join('');
    this.#hotspot ??= { ssid: `Peeqo-Setup-${pick(4).toUpperCase()}`, password: pick(8) };
    try {
      await this.#deps.network.startHotspot(this.#hotspot.ssid, this.#hotspot.password);
      this.#phase = this.#error ? 'failed' : 'hotspot';
      this.#showJoin();
    } catch (error) {
      this.#phase = 'failed';
      this.#error = `The setup network would not start: ${error instanceof Error ? error.message : String(error)}`;
      this.#deps.log(this.#error);
      this.#deps.showScreen({ title: 'Setup could not start', lines: [this.#error, 'Restart Peeqo to try again.'], tone: 'warn' });
    }
  }

  /** Networks seen (scanned again when possible). */
  async networks(): Promise<readonly WifiNetwork[]> {
    if (!this.#hotspot || this.#phase === 'off') this.#networks = await this.#deps.network.scan().catch(() => this.#networks);
    return this.#networks;
  }

  /**
   * The setup page's form. Saves the PIN and keys straight away; joining the network happens a moment later (so the
   * phone hears back before the setup network goes down).
   */
  async submit(form: SetupForm): Promise<{ readonly ok: boolean; readonly message: string }> {
    const config = this.#deps.config;
    if (form.pin !== undefined && form.pin !== '' && !validPin(form.pin)) return { ok: false, message: 'The PIN must be 4 to 8 digits.' };
    if (!form.pin && config.config.pinHash === null) return { ok: false, message: 'Choose a PIN for the panel.' };
    const ssid = form.ssid?.trim() ?? '';
    if (this.#phase !== 'off' && !ssid) return { ok: false, message: 'Choose a Wi-Fi network.' };
    const password = form.password ? form.password : null;
    if (password !== null && (password.length < 8 || password.length > 63)) return { ok: false, message: 'Wi-Fi passwords are 8 to 63 characters.' };
    if (form.pin) config.setPin(form.pin);
    const keys = { ...config.config.keys };
    if (form.openrouter?.trim()) keys.openrouter = form.openrouter.trim();
    if (form.klipy?.trim()) keys.klipy = form.klipy.trim();
    config.update({ keys });
    this.#deps.applySettings();
    if (!ssid) return { ok: true, message: 'Saved.' };
    this.#phase = 'connecting';
    this.#error = null;
    this.#deps.showScreen({ title: `Joining ${ssid}…`, lines: ['This takes up to a minute.'] });
    void this.#join(ssid, password);
    return { ok: true, message: `Peeqo is joining ${ssid}. Watch its screen for its new address.` };
  }

  async #join(ssid: string, password: string | null): Promise<void> {
    await this.#sleep(1500);
    await this.#deps.network.stopHotspot();
    const result = await this.#deps.network.connect(ssid, password);
    if (result.ok) {
      this.#deps.log(`joined ${ssid}`);
      this.#phase = 'off';
      this.#error = null;
      this.#showAddress(60000);
      return;
    }
    this.#deps.log(`could not join ${ssid}: ${result.message}`);
    this.#error = `Could not join ${ssid}: ${result.message}`;
    await this.enter('joining failed');
  }

  /** Shows how to join the setup network: a QR code, and the name and password for a laptop. */
  #showJoin(): void {
    const h = this.#hotspot;
    if (!h) return;
    this.#deps.showScreen({
      title: this.#error ? 'Setup: try again' : 'Set me up!',
      lines: [
        ...(this.#error ? [this.#error] : []),
        'Scan with your phone camera to join my setup network.',
        `Laptop: join "${h.ssid}", password ${h.password}, then open http://${SETUP_ADDRESS}`,
      ],
      qr: `WIFI:T:WPA;S:${escapeWifi(h.ssid)};P:${escapeWifi(h.password)};;`,
      tone: this.#error ? 'warn' : 'info',
    });
  }

  /** Shows where to find the panel, for a while. */
  #showAddress(ms: number): void {
    void this.#deps.network.status().then((status) => {
      if (!status.connected) return;
      const host = `http://${this.#deps.hostname}.local`;
      this.#deps.showScreen({
        title: status.ssid ? `I'm on ${status.ssid}` : "I'm online",
        lines: [`Open ${host}`, ...(status.ip ? [`or http://${status.ip}`] : [])],
        ...(status.ip ? { qr: `http://${status.ip}/` } : {}),
      });
      this.#clearAddress();
      this.#addressTimer = setTimeout(() => this.#deps.showScreen(null), ms);
    });
  }

  /**
   * Keeps Peeqo on its Wi-Fi: while not setting up, it checks every WIFI_CHECK_MS that the router answers; once it
   * has not for WIFI_LOST_MS (the Pi's Wi-Fi can stop passing anything while it still looks connected), it turns the
   * Wi-Fi off and on again, and tries again every WIFI_LOST_MS while it stays silent. Returns a function that stops.
   */
  watch(): () => void {
    const now = this.#deps.now ?? Date.now;
    let silentSince: number | null = null;
    let checking = false;
    const check = async () => {
      if (checking || this.#phase !== 'off') return;
      checking = true;
      try {
        const answers = await this.#deps.network.reachable().catch(() => false);
        const t = now();
        if (answers) {
          if (silentSince !== null) this.#deps.log('Wi-Fi: the router answers again');
          silentSince = null;
        } else if (silentSince === null) {
          silentSince = t;
          this.#deps.log('Wi-Fi: the router does not answer');
        } else if (t - silentSince >= WIFI_LOST_MS) {
          silentSince = t;
          this.#deps.log('Wi-Fi: still no answer from the router, so turning the Wi-Fi off and on again');
          await this.#deps.network.restartWifi().catch((error: unknown) => this.#deps.log(`Wi-Fi could not be restarted: ${error instanceof Error ? error.message : String(error)}`));
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), WIFI_CHECK_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Shows the address again (a medium press of a button). */
  showAddress(): void {
    if (this.#phase === 'off') this.#showAddress(20000);
    else this.#showJoin();
  }

  #clearAddress(): void {
    if (this.#addressTimer) clearTimeout(this.#addressTimer);
    this.#addressTimer = null;
  }
}

/** Wi-Fi QR codes escape \ ; , : and " with a backslash. */
function escapeWifi(text: string): string {
  return text.replace(/([\\;,:"])/g, '\\$1');
}
