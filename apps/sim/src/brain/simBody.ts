import type { BrainBody, Gif } from '@peeqo/brain';
import type { Character, CharacterState, ExpressionName } from '@peeqo/character';
import type { ExpressiveFace } from '@peeqo/face';

export interface SimBodyParts {
  readonly character: Character;
  readonly face: ExpressiveFace;
  /** Called before anything moves the head, so the animator (not the sliders) is in control. */
  readonly takeHead: () => void;
  /** Shows the words Peeqo says (the talk panel's transcript). */
  readonly caption: (text: string) => void;
}

/** How long a GIF stays on the face screen. */
const GIF_MS = 4200;

/**
 * The brain's hands in the simulator: expressions and states go to the Character, GIFs play on the face screen,
 * and words are spoken with the browser's voice (pitched up a little) or, with the voice off, only captioned.
 */
export class SimBody implements BrainBody {
  readonly #parts: SimBodyParts;
  #speaking: { utterance: SpeechSynthesisUtterance; done: () => void } | null = null;

  constructor(parts: SimBodyParts) {
    this.#parts = parts;
  }

  setState(state: CharacterState): void {
    this.#parts.takeHead();
    this.#parts.character.setState(state);
  }

  express(name: ExpressionName, intensity: number): void {
    this.#parts.takeHead();
    this.#parts.character.express(name, { intensity });
  }

  async showGif(gif: Gif, signal?: AbortSignal): Promise<void> {
    const face = this.#parts.face;
    if (gif.mp4) {
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.src = gif.mp4;
      if (!(await loaded(video, 'loadeddata', 5000)) || signal?.aborted) return release(video);
      await video.play().catch(() => undefined);
      if (signal?.aborted) return release(video);
      face.showMedia({ source: video, width: video.videoWidth || gif.width, height: video.videoHeight || gif.height }, performance.now(), GIF_MS);
      setTimeout(() => release(video), GIF_MS + 600);
    } else if (gif.gif) {
      const image = new Image();
      image.src = gif.gif;
      const ok = await image.decode().then(
        () => true,
        () => false,
      );
      if (ok && !signal?.aborted) face.showMedia({ source: image, width: image.naturalWidth || gif.width, height: image.naturalHeight || gif.height }, performance.now(), GIF_MS);
    }
  }

  say(text: string, voice: boolean): Promise<void> {
    this.#parts.caption(text);
    // Without a voice (or speech support), give the caption time to be read.
    const readMs = 1200 + text.length * 55;
    if (!voice || typeof speechSynthesis === 'undefined') return delay(readMs);
    this.#speaking?.done();
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
      const preferred = voices.find((v) => /samantha|google us english|aria|jenny/i.test(v.name)) ?? voices[0];
      if (preferred) utterance.voice = preferred;
      utterance.pitch = 1.6;
      utterance.rate = 1.07;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(fallback);
        if (this.#speaking?.utterance === utterance) this.#speaking = null;
        resolve();
      };
      // Some browsers never fire 'end' (no voices installed, background tabs): don't wait forever.
      const fallback = setTimeout(done, 2500 + text.length * 90);
      utterance.onend = done;
      utterance.onerror = done;
      this.#speaking = { utterance, done };
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    });
  }

  /** Stops talking now (when someone cuts in). */
  hush(): void {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.#speaking?.done();
  }
}

/** Stops a video and lets the browser free it. */
function release(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function loaded(element: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      element.removeEventListener(event, onLoad);
      element.removeEventListener('error', onError);
      resolve(ok);
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    element.addEventListener(event, onLoad);
    element.addEventListener('error', onError);
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
