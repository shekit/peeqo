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

/** How long a GIF stays on the face screen (longer if its caption needs it). */
const GIF_MS = 4200;

/**
 * The brain's hands in the simulator: expressions and states go to the Character, GIFs play on the face screen,
 * and words are captioned on the face (over the GIF, if one is showing) or, with the voice on, spoken with the
 * browser's voice (pitched up a little). Everything also goes to the transcript.
 */
export class SimBody implements BrainBody {
  readonly #parts: SimBodyParts;
  /** The words being spoken or shown, and how to stop them. */
  #showing: { readonly stop: () => void } | null = null;

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
    const source = await this.#showMedia(gif, signal);
    // A turn cut short takes its GIF down (not a newer one).
    if (source) signal?.addEventListener('abort', () => this.#parts.face.hideMedia(performance.now(), source), { once: true });
  }

  async #showMedia(gif: Gif, signal?: AbortSignal): Promise<CanvasImageSource | null> {
    const face = this.#parts.face;
    if (gif.mp4) {
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.src = gif.mp4;
      if (!(await loaded(video, 'loadeddata', 5000)) || signal?.aborted) {
        release(video);
        return null;
      }
      await video.play().catch(() => undefined);
      if (signal?.aborted) {
        release(video);
        return null;
      }
      face.showMedia({ source: video, width: video.videoWidth || gif.width, height: video.videoHeight || gif.height }, performance.now(), GIF_MS);
      // Freed once it is off the screen (a caption can keep it up for longer).
      const free = () => {
        const left = face.mediaEndMs(video) - performance.now();
        if (left > 0) setTimeout(free, left + 100);
        else release(video);
      };
      setTimeout(free, GIF_MS + 600);
      return video;
    }
    if (gif.gif) {
      const image = new Image();
      image.src = gif.gif;
      const ok = await image.decode().then(
        () => true,
        () => false,
      );
      if (!ok || signal?.aborted) return null;
      face.showMedia({ source: image, width: image.naturalWidth || gif.width, height: image.naturalHeight || gif.height }, performance.now(), GIF_MS);
      return image;
    }
    return null;
  }

  say(text: string, voice: boolean, signal?: AbortSignal): Promise<void> {
    if (!text.trim() || signal?.aborted) return Promise.resolve();
    this.#parts.caption(text);
    this.#showing?.stop();
    if (voice && typeof speechSynthesis !== 'undefined') return this.#speak(text, signal);
    // On the face: over the GIF showing (which stays until the words are read), otherwise above the eyes.
    const face = this.#parts.face;
    const now = performance.now();
    const gone = face.showCaption(text, now, 1200 + text.length * 55);
    return this.#hold(gone - now, signal, () => face.hideCaption(performance.now(), text));
  }

  /** Waits `ms`, or until stopped (by hush or the signal), calling `onStop` then. */
  #hold(ms: number, signal: AbortSignal | undefined, onStop: () => void): Promise<void> {
    return new Promise((resolve) => {
      const finish = (stopped: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (this.#showing === entry) this.#showing = null;
        if (stopped) onStop();
        resolve();
      };
      const stop = () => finish(true);
      const entry = { stop };
      const timer = setTimeout(() => finish(false), Math.max(0, ms));
      this.#showing = entry;
      signal?.addEventListener('abort', stop, { once: true });
    });
  }

  #speak(text: string, signal?: AbortSignal): Promise<void> {
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
        signal?.removeEventListener('abort', stop);
        if (this.#showing === entry) this.#showing = null;
        resolve();
      };
      const stop = () => {
        if (!finished) speechSynthesis.cancel();
        done();
      };
      const entry = { stop };
      // Some browsers never fire 'end' (no voices installed, background tabs): don't wait forever.
      const fallback = setTimeout(done, 2500 + text.length * 90);
      utterance.onend = done;
      utterance.onerror = done;
      this.#showing = entry;
      signal?.addEventListener('abort', stop, { once: true });
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    });
  }

  /** Stops talking and clears the screen back to the eyes (when someone cuts in). */
  hush(): void {
    this.#showing?.stop();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    const now = performance.now();
    this.#parts.face.hideCaption(now);
    this.#parts.face.hideMedia(now);
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

