import type { BrainBody, Gif } from '@peeqo/brain';
import type { Character, CharacterState, ExpressionName } from '@peeqo/character';
import type { MirroredFace } from './mirroredFace.ts';

/** How long a GIF stays on the face screen (longer if its caption needs it), as in the simulator. */
export const GIF_MS = 4200;
/** How long to wait for a screen to load a GIF before going on without it. */
const GIF_LOAD_MS = 6000;

export interface RobotBodyParts {
  readonly character: Character;
  readonly face: MirroredFace;
  readonly now: () => number;
  /** What Peeqo says, for the panel's transcript. */
  readonly caption?: (text: string) => void;
}

/**
 * The brain's hands on the robot, as SimBody is in the simulator: expressions and states go to the Character, GIFs
 * and captions to the face screen (through the mirrored face). There is no voice yet: with the voice on, the words
 * are captioned too.
 */
export class RobotBody implements BrainBody {
  readonly #parts: RobotBodyParts;
  #nextId = 1;
  readonly #waiting = new Map<number, { gif: Gif; done: (shown: boolean) => void }>();
  #showing: { readonly stop: () => void } | null = null;

  constructor(parts: RobotBodyParts) {
    this.#parts = parts;
  }

  setState(state: CharacterState): void {
    this.#parts.character.setState(state);
  }

  express(name: ExpressionName, intensity: number): void {
    this.#parts.character.express(name, { intensity });
  }

  /** Asks the face screen to show the GIF; resolves once it is showing, failed, or no screen answered in time. */
  async showGif(gif: Gif, signal?: AbortSignal): Promise<void> {
    const face = this.#parts.face;
    const url = gif.mp4 ?? gif.gif;
    if (!url || face.screens === 0 || signal?.aborted) return;
    const id = this.#nextId++;
    const media = { url, video: gif.mp4 !== null, width: gif.width, height: gif.height };
    const shown = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), GIF_LOAD_MS);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.#waiting.delete(id);
        signal?.removeEventListener('abort', abort);
        resolve(ok);
      };
      const abort = () => finish(false);
      this.#waiting.set(id, { gif, done: finish });
      signal?.addEventListener('abort', abort, { once: true });
      face.offerGif(id, media, GIF_MS);
    });
    if (signal?.aborted || !shown) {
      face.cancelMedia(id, this.#parts.now()); // (a screen still loading it must not show it later)
      return;
    }
    face.mediaShown(id, media, this.#parts.now(), GIF_MS);
    // A turn cut short takes its GIF down (not a newer one).
    signal?.addEventListener('abort', () => face.cancelMedia(id, this.#parts.now()), { once: true });
  }

  /** A screen answered about a GIF. */
  mediaReply(id: number, shown: boolean): void {
    this.#waiting.get(id)?.done(shown);
  }

  say(text: string, _voice: boolean, signal?: AbortSignal): Promise<void> {
    if (!text.trim() || signal?.aborted) return Promise.resolve();
    this.#parts.caption?.(text);
    this.#showing?.stop();
    const face = this.#parts.face;
    const now = this.#parts.now();
    const gone = face.showCaption(text, now, 1200 + text.length * 55);
    return new Promise((resolve) => {
      const finish = (stopped: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (this.#showing === entry) this.#showing = null;
        if (stopped) face.hideCaption(this.#parts.now(), text);
        resolve();
      };
      const stop = () => finish(true);
      const entry = { stop };
      const timer = setTimeout(() => finish(false), Math.max(0, gone - now));
      this.#showing = entry;
      signal?.addEventListener('abort', stop, { once: true });
    });
  }

  /** Clears the screen back to the eyes (when someone starts talking to Peeqo). */
  hush(): void {
    this.#showing?.stop();
    const now = this.#parts.now();
    this.#parts.face.hideCaption(now);
    this.#parts.face.hideMedia(now);
    for (const waiting of this.#waiting.values()) waiting.done(false);
  }
}
