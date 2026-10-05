import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseCalibration, type Calibration } from './hardware/calibration.ts';

/**
 * The robot's settings, kept in config.json in its data folder (~/.peeqo on the robot), readable only by its user:
 * the API keys, the panel PIN (hashed), the calibration and a few choices. Memory, the conversation and timers sit
 * beside it in their own files.
 */
export interface RobotConfig {
  readonly name: string;
  /** scrypt hash of the panel PIN ("scrypt$salt$hash"), or null before setup. */
  readonly pinHash: string | null;
  readonly keys: { readonly openrouter: string | null; readonly klipy: string | null };
  /** OpenRouter model, or null for the default. */
  readonly model: string | null;
  /** Speak replies aloud (off: GIFs and captions, as Peeqo has always been). */
  readonly voice: boolean;
  readonly calibration: Calibration | null;
  readonly buttons: { readonly pins: readonly number[]; readonly activeLow: boolean };
  /** openWakeWord models, or null for the default (hey_jarvis). */
  readonly wakeWords: readonly string[] | null;
}

export const DEFAULT_CONFIG: RobotConfig = Object.freeze({
  name: 'Peeqo',
  pinHash: null,
  keys: { openrouter: null, klipy: null },
  model: null,
  voice: false,
  calibration: null,
  buttons: { pins: [4, 16, 17, 23], activeLow: false },
  wakeWords: null,
});

export interface DataPaths {
  readonly dir: string;
  readonly config: string;
  readonly memory: string;
  readonly conversation: string;
  readonly alarms: string;
  readonly gifSearches: string;
}

export function dataPaths(dir: string): DataPaths {
  return {
    dir,
    config: path.join(dir, 'config.json'),
    memory: path.join(dir, 'memory.md'),
    conversation: path.join(dir, 'conversation.json'),
    alarms: path.join(dir, 'alarms.json'),
    gifSearches: path.join(dir, 'klipy-searches.json'),
  };
}

/** Written to a temporary file and renamed, so a crash or power cut mid-write cannot leave a damaged file. */
export function writeFileSafely(file: string, text: string, mode = 0o600): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode });
  fs.renameSync(temp, file);
}

/** Reads a file, or null if it is not there. */
export function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export class ConfigStore {
  readonly paths: DataPaths;
  #config: RobotConfig;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.paths = dataPaths(dir);
    this.#config = this.#read();
  }

  get config(): RobotConfig {
    return this.#config;
  }

  update(change: Partial<RobotConfig>): RobotConfig {
    this.#config = { ...this.#config, ...change };
    writeFileSafely(this.paths.config, `${JSON.stringify(this.#config, null, 2)}\n`);
    return this.#config;
  }

  setPin(pin: string): void {
    this.update({ pinHash: hashPin(pin) });
  }

  checkPin(pin: string): boolean {
    return this.#config.pinHash !== null && verifyPin(pin, this.#config.pinHash);
  }

  #read(): RobotConfig {
    const text = readFileOrNull(this.paths.config);
    if (!text) return DEFAULT_CONFIG;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return DEFAULT_CONFIG; // damaged: start afresh (setup asks again)
    }
    const keys = (raw.keys ?? {}) as Record<string, unknown>;
    const buttons = (raw.buttons ?? {}) as Record<string, unknown>;
    const pins = Array.isArray(buttons.pins) ? buttons.pins.filter((p): p is number => Number.isInteger(p) && p >= 0 && p <= 27) : null;
    return {
      name: str(raw.name, 40) ?? DEFAULT_CONFIG.name,
      pinHash: typeof raw.pinHash === 'string' && raw.pinHash.startsWith('scrypt$') ? raw.pinHash : null,
      keys: { openrouter: str(keys.openrouter), klipy: str(keys.klipy) },
      model: str(raw.model, 100),
      voice: raw.voice === true,
      calibration: parseCalibration(raw.calibration),
      buttons: { pins: pins ?? DEFAULT_CONFIG.buttons.pins, activeLow: buttons.activeLow === true },
      wakeWords: Array.isArray(raw.wakeWords) ? raw.wakeWords.filter((w): w is string => typeof w === 'string' && !!w.trim()) : null,
    };
  }
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(pin, Buffer.from(salt, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A PIN people can type on a phone: 4 to 8 digits. */
export function validPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
}
