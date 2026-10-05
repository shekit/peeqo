import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** What the detector reports. */
export type WakeWordEvent =
  | { readonly type: 'ready'; readonly words: readonly string[] }
  /** Every 80 ms of audio: how likely it is that someone is speaking, 0…1. */
  | { readonly type: 'vad'; readonly speech: number }
  | { readonly type: 'wake'; readonly word: string; readonly score: number }
  | { readonly type: 'error'; readonly message: string };

export interface WakeWordOptions {
  /** Wake words: pre-trained openWakeWord names (default hey_jarvis) or model files. */
  readonly words?: readonly string[];
  /** Score a wake word must exceed (default 0.5). */
  readonly threshold?: number;
  /** 80 ms chunks in a row it must stay above the threshold (default 3: look-alike phrases only spike for one). */
  readonly patience?: number;
  /** Python to run (default: the environment made by `npm run setup -w @peeqo/wakeword`). */
  readonly python?: string;
  /** The detector script (default: python/detector.py in this package; the robot keeps its own copy). */
  readonly script?: string;
}

/** Audio the detector expects: 16 kHz, mono, 16-bit. */
export const WAKEWORD_SAMPLE_RATE = 16000;

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_PYTHON = `${PACKAGE_DIR}.venv/bin/python`;
const SCRIPT = `${PACKAGE_DIR}python/detector.py`;

/** True if `npm run setup -w @peeqo/wakeword` has been run. */
export function wakeWordReady(python = DEFAULT_PYTHON): boolean {
  return existsSync(python);
}

/**
 * openWakeWord in a helper process: write audio with write(), hear about wake words and speech through the callback.
 * start() resolves once the models are loaded.
 */
export class WakeWordDetector {
  readonly #options: WakeWordOptions;
  readonly #onEvent: (event: WakeWordEvent) => void;
  #child: ChildProcessWithoutNullStreams | null = null;
  #stderr = '';

  constructor(options: WakeWordOptions, onEvent: (event: WakeWordEvent) => void) {
    this.#options = options;
    this.#onEvent = onEvent;
  }

  get running(): boolean {
    return this.#child !== null;
  }

  start(): Promise<readonly string[]> {
    if (this.#child) throw new Error('The wake word detector is already running');
    const python = this.#options.python ?? DEFAULT_PYTHON;
    if (!existsSync(python)) {
      return Promise.reject(new Error('The wake word detector is not set up: run `npm run setup -w @peeqo/wakeword`'));
    }
    const args = [this.#options.script ?? SCRIPT];
    for (const word of this.#options.words ?? ['hey_jarvis']) args.push('--word', word);
    args.push('--threshold', String(this.#options.threshold ?? 0.5), '--patience', String(this.#options.patience ?? 3));
    const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-2000);
    });
    child.stdin.on('error', () => undefined); // writes after it has gone are reported through 'exit'
    return new Promise((resolve, reject) => {
      let ready = false;
      createInterface({ input: child.stdout }).on('line', (line) => {
        let event: WakeWordEvent;
        try {
          event = JSON.parse(line) as WakeWordEvent;
        } catch {
          return; // not ours (a library printing to stdout)
        }
        if (event.type === 'ready' && !ready) {
          ready = true;
          resolve(event.words);
        }
        if (event.type === 'error' && !ready) reject(new Error(event.message));
        this.#onEvent(event);
      });
      child.on('exit', (code) => {
        this.#child = null;
        const message = `The wake word detector stopped (exit ${code})${this.#stderr ? `: ${this.#stderr.trim().split('\n').at(-1)}` : ''}`;
        if (!ready) reject(new Error(message));
        else if (code !== 0 && code !== null) this.#onEvent({ type: 'error', message });
      });
      child.on('error', (error) => {
        this.#child = null;
        if (!ready) reject(error);
        else this.#onEvent({ type: 'error', message: error.message });
      });
    });
  }

  /** Feeds audio: 16 kHz, mono, 16-bit samples (little-endian bytes are accepted as they are). */
  write(samples: Int16Array | Uint8Array): void {
    this.#child?.stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  stop(): void {
    this.#child?.stdin.end();
    this.#child = null;
  }
}
