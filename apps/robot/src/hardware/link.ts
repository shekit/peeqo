import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * The hardware helper (python/hardware.py) as a child process: servo pulses and LED frames go to it, button presses
 * come back. It only does what it is told; ServoOutput decides (and checks) what the servos are told.
 */
export interface HardwareStatus {
  readonly servos: boolean;
  readonly leds: boolean;
  readonly buttons: readonly number[];
  readonly fake: boolean;
}

export interface HardwareLinkOptions {
  readonly script: string;
  readonly python?: string;
  /** No hardware: the helper accepts everything and pretends (development on a laptop). */
  readonly fake?: boolean;
  readonly buttons?: readonly number[];
  /** Buttons read low when pressed (2019: high). */
  readonly activeLow?: boolean;
  readonly onButton?: (pin: number, pressed: boolean) => void;
  readonly onError?: (message: string) => void;
  /** The helper stopped (it had started). */
  readonly onExit?: (message: string) => void;
}

/** What the servo output and LED ring need from the link (tests use a fake). */
export interface HardwareOutputs {
  servos(pulsesUs: readonly number[]): void;
  leds(frame: Uint8Array): void;
}

export class HardwareLink implements HardwareOutputs {
  readonly #options: HardwareLinkOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #stderr = '';

  constructor(options: HardwareLinkOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#child !== null;
  }

  /** Starts the helper; resolves once it reports what hardware it found. */
  start(): Promise<HardwareStatus> {
    if (this.#child) throw new Error('The hardware helper is already running');
    const o = this.#options;
    const args = [o.script, '--buttons', (o.buttons ?? [4, 16, 17, 23]).join(',')];
    if (o.fake) args.push('--fake');
    if (o.activeLow) args.push('--active-low');
    const child = spawn(o.python ?? 'python3', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-2000);
    });
    child.stdin.on('error', () => undefined); // reported through 'exit'
    return new Promise((resolve, reject) => {
      let ready = false;
      createInterface({ input: child.stdout }).on('line', (line) => {
        let event: { type?: string; message?: string; pin?: number; pressed?: boolean } & Partial<HardwareStatus>;
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          return;
        }
        if (event.type === 'ready' && !ready) {
          ready = true;
          resolve({ servos: !!event.servos, leds: !!event.leds, buttons: event.buttons ?? [], fake: !!event.fake });
        } else if (event.type === 'button' && typeof event.pin === 'number') {
          o.onButton?.(event.pin, event.pressed === true);
        } else if (event.type === 'error') {
          o.onError?.(event.message ?? 'unknown hardware error');
        }
      });
      child.on('exit', (code) => {
        if (this.#child === child) this.#child = null;
        const message = `The hardware helper stopped (exit ${code})${this.#stderr ? `: ${this.#stderr.trim().split('\n').at(-1)}` : ''}`;
        if (!ready) reject(new Error(message));
        else o.onExit?.(message);
      });
      child.on('error', (error) => {
        if (this.#child === child) this.#child = null;
        if (!ready) reject(error);
        else o.onExit?.(error.message);
      });
    });
  }

  /** Pulse widths for channels 0, 1, 2, … in microseconds (0 = off). */
  servos(pulsesUs: readonly number[]): void {
    if (pulsesUs.some((us) => !Number.isFinite(us))) return;
    this.#send(`S ${pulsesUs.map((us) => (Math.round(us * 10) / 10).toString()).join(' ')}`);
  }

  leds(frame: Uint8Array): void {
    this.#send(`L ${Buffer.from(frame).toString('hex')}`);
  }

  /** Fake mode: a button press, as if from the hardware. */
  press(pin: number, pressed: boolean): void {
    if (this.#options.fake) this.#send(`B ${pin} ${pressed ? 1 : 0}`);
  }

  stop(): void {
    this.#child?.stdin.end();
    this.#child = null;
  }

  #send(line: string): void {
    this.#child?.stdin.write(`${line}\n`);
  }
}
