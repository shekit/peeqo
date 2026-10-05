import { spawn } from 'node:child_process';
import { SOUND_SAMPLE_RATE, renderSound, type SoundName, type SoundPlayer } from '@peeqo/character';
import { toInt16, wavBytes } from './wav.ts';

/**
 * Peeqo's little sounds through the speaker: rendered once (the same synthesis as the simulator), then played with
 * ALSA's aplay. In fake mode (no hardware) it only counts them.
 */
export class Speaker implements SoundPlayer {
  readonly #fake: boolean;
  readonly #device: string | null;
  readonly #cache = new Map<SoundName, Buffer>();
  muted = false;
  played = 0;

  constructor(options: { fake?: boolean; device?: string | null } = {}) {
    this.#fake = options.fake ?? false;
    this.#device = options.device ?? null;
  }

  play(name: SoundName): void {
    if (this.muted) return;
    this.played++;
    if (this.#fake) return;
    let wav = this.#cache.get(name);
    if (!wav) {
      wav = wavBytes(toInt16(renderSound(name)), SOUND_SAMPLE_RATE);
      this.#cache.set(name, wav);
    }
    const player = spawn('aplay', ['-q', ...(this.#device ? ['-D', this.#device] : []), '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
    player.on('error', () => undefined); // no aplay: no sound, nothing else breaks
    player.stdin.on('error', () => undefined);
    player.stdin.end(wav);
  }
}
