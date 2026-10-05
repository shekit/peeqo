import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export const MIC_SAMPLE_RATE = 16000;
/** 80 ms: what the wake word detector takes at a time. */
export const MIC_CHUNK = 1280;

/**
 * The microphone, through ALSA's arecord: 16 kHz, 16-bit mono, handed on in 80 ms chunks. The device is the default
 * capture device unless one is named (as the 2019 software did).
 */
export class Microphone {
  readonly #device: string | null;
  readonly #onChunk: (samples: Int16Array) => void;
  readonly #onError: (message: string) => void;
  #child: ChildProcessWithoutNullStreams | null = null;
  #carry = Buffer.alloc(0);

  constructor(options: { device?: string | null; onChunk: (samples: Int16Array) => void; onError?: (message: string) => void }) {
    this.#device = options.device ?? null;
    this.#onChunk = options.onChunk;
    this.#onError = options.onError ?? (() => undefined);
  }

  get running(): boolean {
    return this.#child !== null;
  }

  start(): void {
    if (this.#child) return;
    const args = ['-q', ...(this.#device ? ['-D', this.#device] : []), '-f', 'S16_LE', '-r', String(MIC_SAMPLE_RATE), '-c', '1', '-t', 'raw'];
    const child = spawn('arecord', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-500)));
    child.stdout.on('data', (data: Buffer) => this.#data(data));
    child.on('error', (error) => {
      if (this.#child === child) this.#child = null;
      this.#onError(`The microphone could not start: ${error.message}`);
    });
    child.on('exit', (code) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#onError(`The microphone stopped (exit ${code})${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`);
    });
  }

  stop(): void {
    const child = this.#child;
    this.#child = null;
    child?.kill();
  }

  #data(data: Buffer): void {
    let buffer = this.#carry.length > 0 ? Buffer.concat([this.#carry, data]) : data;
    const bytes = MIC_CHUNK * 2;
    while (buffer.length >= bytes) {
      const chunk = new Int16Array(MIC_CHUNK);
      for (let i = 0; i < MIC_CHUNK; i++) chunk[i] = buffer.readInt16LE(i * 2);
      buffer = buffer.subarray(bytes);
      this.#onChunk(chunk);
    }
    this.#carry = Buffer.from(buffer);
  }
}
