import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** The Pi's temperature, and the firmware's power and heat flags (vcgencmd get_throttled). */
export interface Health {
  readonly tempC: number | null;
  /** The supply is too low now, or has been since start-up: the usual cause of Wi-Fi and servo trouble on a Pi. */
  readonly underVoltage: boolean;
  readonly underVoltageSeen: boolean;
  /** Slowed a little to keep cool (a Pi 3 B+ does from 60 °C: a gentle first step). */
  readonly slowedForHeat: boolean;
  /** Throttled hard (from 80 °C, or for low power). */
  readonly throttled: boolean;
}

const NOTHING: Health = { tempC: null, underVoltage: false, underVoltageSeen: false, slowedForHeat: false, throttled: false };

/** The flags in `vcgencmd get_throttled` output (null if it is not that). */
export function parseThrottled(text: string): Omit<Health, 'tempC'> | null {
  const match = /throttled=0x([0-9a-f]+)/i.exec(text);
  if (!match) return null;
  const bits = Number.parseInt(match[1]!, 16);
  return { underVoltage: (bits & 0x1) !== 0, underVoltageSeen: (bits & 0x10000) !== 0, slowedForHeat: (bits & 0x8) !== 0, throttled: (bits & 0x4) !== 0 };
}

/** What changed between two readings, as lines for the log (only changes, so a steady state is said once). */
export function healthChanges(before: Health, now: Health): string[] {
  const lines: string[] = [];
  const temp = now.tempC === null ? '' : ` (${now.tempC.toFixed(0)} °C)`;
  if (now.underVoltage && !before.underVoltage) lines.push('power: the supply is dipping too low (under-voltage); Wi-Fi and the servos can misbehave. A stronger supply fixes it.');
  if (!now.underVoltage && before.underVoltage) lines.push('power: the supply is fine again');
  if (now.slowedForHeat && !before.slowedForHeat) lines.push(`heat: the Pi is slowing itself down a little to stay cool${temp}`);
  if (!now.slowedForHeat && before.slowedForHeat) lines.push(`heat: cool enough again${temp}`);
  if (now.throttled && !before.throttled) lines.push(`heat or power: the Pi is throttled hard${temp}`);
  if (!now.throttled && before.throttled) lines.push('no longer throttled');
  return lines;
}

export interface HealthReader {
  /** Millidegrees, as /sys/class/thermal/thermal_zone0/temp has it. */
  temperature(): Promise<string>;
  /** `vcgencmd get_throttled` output. */
  throttled(): Promise<string>;
}

const PI_READER: HealthReader = {
  temperature: () => readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8'),
  throttled: () =>
    new Promise((resolve, reject) => {
      execFile('vcgencmd', ['get_throttled'], { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    }),
};

/** Keeps an eye on the Pi's temperature and power, logging changes. */
export class HealthMonitor {
  readonly #log: (line: string) => void;
  readonly #reader: HealthReader;
  #health: Health = NOTHING;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(log: (line: string) => void, reader: HealthReader = PI_READER) {
    this.#log = log;
    this.#reader = reader;
  }

  get health(): Health {
    return this.#health;
  }

  start(everyMs = 30_000): void {
    void this.check();
    this.#timer = setInterval(() => void this.check(), everyMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async check(): Promise<void> {
    const milli = Number((await this.#reader.temperature().catch(() => '')).trim());
    const flags = parseThrottled(await this.#reader.throttled().catch(() => ''));
    const now: Health = { ...(flags ?? NOTHING), tempC: Number.isFinite(milli) && milli > 0 ? Math.round(milli / 100) / 10 : null };
    for (const line of healthChanges(this.#health, now)) this.#log(line);
    this.#health = now;
  }
}
