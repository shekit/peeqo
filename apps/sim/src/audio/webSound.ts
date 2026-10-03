import { SOUND_SAMPLE_RATE, renderSound, type SoundName, type SoundPlayer } from '@peeqo/character';

/** Plays Peeqo's synthesized sounds through Web Audio (rendered once, then cached). */
export class WebSoundPlayer implements SoundPlayer {
  #context: AudioContext | null = null;
  #gain: GainNode | null = null;
  readonly #buffers = new Map<SoundName, AudioBuffer>();
  muted = false;

  play(name: SoundName): void {
    if (this.muted) return;
    // Browsers only allow audio after the page has been interacted with; until then this quietly does nothing.
    this.#context ??= new AudioContext();
    const context = this.#context;
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    if (!this.#gain) {
      this.#gain = context.createGain();
      this.#gain.gain.value = 0.5;
      this.#gain.connect(context.destination);
    }
    let buffer = this.#buffers.get(name);
    if (!buffer) {
      const samples = renderSound(name);
      buffer = context.createBuffer(1, samples.length, SOUND_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      this.#buffers.set(name, buffer);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gain);
    source.start();
  }
}
