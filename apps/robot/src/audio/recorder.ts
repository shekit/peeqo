import { MIC_CHUNK, MIC_SAMPLE_RATE } from './microphone.ts';
import { wavBytes } from './wav.ts';

/** Kept from before a recording starts, so its first sound is not clipped (a button press). */
export const PREROLL_CHUNKS = 4;
/** After a wake word, only a little: the wake word itself is not part of what was said. */
export const WAKE_PREROLL_CHUNKS = 1;
/** This much quiet after speech ends the recording. */
const END_QUIET_CHUNKS = 10; // 0.8 s
/** Give up if no speech starts within this. */
const NO_SPEECH_CHUNKS = 60; // 4.8 s
const MAX_CHUNKS = 125; // 10 s

export interface RecorderCallbacks {
  /** A finished recording: WAV, base64. */
  onUtterance(wav: string): void;
  /** A recording ended without speech. */
  onNothing(): void;
}

/**
 * Turns the microphone's 80 ms chunks into one utterance, as the simulator does: a recording starts (wake word or
 * button), runs until a short quiet after speech, and comes out as a WAV for the model. How likely each chunk is to be
 * speech comes from the wake word detector; without it, from loudness against a slowly learned noise floor.
 */
export class UtteranceRecorder {
  readonly #callbacks: RecorderCallbacks;
  #preroll: Int16Array[] = [];
  #recording: { chunks: Int16Array[]; spoke: boolean; speechRun: number; quiet: number } | null = null;
  #noise = 0.004;
  /** While true (Peeqo talking), it neither records nor learns the noise floor. */
  deaf = false;

  constructor(callbacks: RecorderCallbacks) {
    this.#callbacks = callbacks;
  }

  get recording(): boolean {
    return this.#recording !== null;
  }

  start(preroll = PREROLL_CHUNKS): void {
    if (this.#recording) return;
    this.#recording = { chunks: preroll > 0 ? this.#preroll.slice(-preroll) : [], spoke: false, speechRun: 0, quiet: 0 };
  }

  cancel(): void {
    this.#recording = null;
  }

  /** One chunk, with how likely it is to be speech (0…1), or null to judge by loudness. */
  chunk(samples: Int16Array, speech: number | null): void {
    if (samples.length !== MIC_CHUNK || this.deaf) return;
    let energy = 0;
    for (const v of samples) energy += (v / 32768) ** 2;
    const rms = Math.sqrt(energy / samples.length);
    const loudness = Math.max(0, Math.min(1, (rms - this.#noise * 2) / (this.#noise * 6)));
    const p = speech ?? loudness;
    if (!this.#recording) {
      this.#noise = Math.max(0.001, this.#noise + (rms - this.#noise) * (rms < this.#noise ? 0.2 : 0.01));
      this.#preroll.push(samples);
      if (this.#preroll.length > PREROLL_CHUNKS) this.#preroll.shift();
      return;
    }
    const r = this.#recording;
    r.chunks.push(samples);
    r.speechRun = p > 0.5 ? r.speechRun + 1 : 0;
    if (r.speechRun >= 2) r.spoke = true;
    r.quiet = r.spoke && p < 0.3 ? r.quiet + 1 : 0;
    if ((r.spoke && r.quiet >= END_QUIET_CHUNKS) || r.chunks.length >= MAX_CHUNKS) {
      this.#recording = null;
      const all = new Int16Array(r.chunks.length * MIC_CHUNK);
      r.chunks.forEach((c, i) => all.set(c, i * MIC_CHUNK));
      this.#callbacks.onUtterance(wavBytes(all, MIC_SAMPLE_RATE).toString('base64'));
    } else if (!r.spoke && r.chunks.length >= NO_SPEECH_CHUNKS) {
      this.#recording = null;
      this.#callbacks.onNothing();
    }
  }
}
