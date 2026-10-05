import { ExpressiveFace, type Emotion } from '@peeqo/face';

/**
 * What the face screen is told (the face page, and the panel's copy of the face, over a WebSocket). The page runs
 * its own ExpressiveFace and does as it is told; blinks and glances it works out for itself.
 */
export type FaceMessage =
  | { readonly t: 'emotion'; readonly emotion: Emotion; readonly intensity: number }
  | { readonly t: 'look'; readonly target: readonly [number, number] | null }
  | { readonly t: 'blink' }
  | { readonly t: 'blinking'; readonly on: boolean }
  /** Load this GIF and show it for durationMs once it has loaded; answer mediaShown or mediaFailed with the id. */
  | { readonly t: 'media'; readonly id: number; readonly url: string; readonly video: boolean; readonly width: number; readonly height: number; readonly durationMs: number }
  | { readonly t: 'hideMedia'; readonly id?: number }
  | { readonly t: 'caption'; readonly text: string; readonly durationMs: number }
  | { readonly t: 'hideCaption'; readonly text?: string }
  | { readonly t: 'screen'; readonly screen: FaceScreen | null };

/** What the face page tells the service. */
export type FaceReply = { readonly t: 'mediaShown'; readonly id: number } | { readonly t: 'mediaFailed'; readonly id: number };

/** A screen of information over the face: setup instructions with a QR code, the robot's address, a warning. */
export interface FaceScreen {
  readonly title: string;
  readonly lines: readonly string[];
  /** Text to show as a QR code (a Wi-Fi network to join, a link). */
  readonly qr?: string;
  readonly tone?: 'info' | 'warn';
}

export interface GifMedia {
  readonly url: string;
  readonly video: boolean;
  readonly width: number;
  readonly height: number;
}

/** A stand-in for the picture in the service's own copy of the face (only its timing matters here). */
const PLACEHOLDER = {} as CanvasImageSource;

/**
 * The face, run in the service as Character and the brain expect, and mirrored to every face screen: each change is
 * also sent as a FaceMessage. The service's copy keeps the timing (how long a GIF and its caption stay up), so the
 * brain can wait for them exactly as in the simulator. snapshot() brings a newly connected screen up to date.
 */
export class MirroredFace extends ExpressiveFace {
  readonly #listeners = new Set<(message: FaceMessage) => void>();
  #emotion: { emotion: Emotion; intensity: number } = { emotion: 'neutral', intensity: 1 };
  #look: readonly [number, number] | null = null;
  #blinking = true;
  #media: { id: number; gif: GifMedia; endMs: number } | null = null;
  #caption: { text: string; endMs: number } | null = null;
  #screen: FaceScreen | null = null;
  #nowMs = 0;

  /** Sends every change to `listener` until the returned function is called. */
  subscribe(listener: (message: FaceMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get screens(): number {
    return this.#listeners.size;
  }

  get screen(): FaceScreen | null {
    return this.#screen;
  }

  override setEmotion(emotion: Emotion, intensity = 1): void {
    super.setEmotion(emotion, intensity);
    this.#emotion = { emotion, intensity };
    this.#emit({ t: 'emotion', emotion, intensity });
  }

  override lookAt(target: readonly [number, number] | null): void {
    super.lookAt(target);
    this.#look = target;
    this.#emit({ t: 'look', target });
  }

  override blink(nowMs: number): void {
    super.blink(nowMs);
    this.#emit({ t: 'blink' });
  }

  override setBlinking(on: boolean): void {
    super.setBlinking(on);
    this.#blinking = on;
    this.#emit({ t: 'blinking', on });
  }

  /** Asks the screens to load and show a GIF (they answer when it is showing, see mediaShown). */
  offerGif(id: number, gif: GifMedia, durationMs: number): void {
    this.#emit({ t: 'media', id, ...gif, durationMs });
  }

  /** A screen is showing the GIF: start its clock here too (captions then keep it up as on the screen). */
  mediaShown(id: number, gif: GifMedia, nowMs: number, durationMs: number): void {
    super.showMedia({ source: PLACEHOLDER, width: Math.max(1, gif.width), height: Math.max(1, gif.height) }, nowMs, durationMs);
    this.#media = { id, gif, endMs: nowMs + durationMs };
  }

  /** Stops one GIF: still loading on the screens, or showing (a newer one is left alone). */
  cancelMedia(id: number, nowMs: number): void {
    if (this.#media?.id === id) {
      super.hideMedia(nowMs);
      this.#media = { ...this.#media, endMs: Math.min(this.#media.endMs, nowMs) };
    }
    this.#emit({ t: 'hideMedia', id });
  }

  override hideMedia(nowMs: number, source?: CanvasImageSource): void {
    super.hideMedia(nowMs, source);
    if (this.#media) this.#media = { ...this.#media, endMs: Math.min(this.#media.endMs, nowMs) };
    this.#emit({ t: 'hideMedia' });
  }

  override showCaption(text: string, nowMs: number, durationMs: number): number {
    const gone = super.showCaption(text, nowMs, durationMs);
    if (this.#media && this.#media.endMs > nowMs) this.#media = { ...this.#media, endMs: Math.max(this.#media.endMs, nowMs + durationMs) };
    this.#caption = { text, endMs: gone };
    this.#emit({ t: 'caption', text, durationMs });
    return gone;
  }

  override hideCaption(nowMs: number, text?: string): void {
    super.hideCaption(nowMs, text);
    if (this.#caption && (text === undefined || this.#caption.text === text)) this.#caption = { ...this.#caption, endMs: Math.min(this.#caption.endMs, nowMs) };
    this.#emit(text === undefined ? { t: 'hideCaption' } : { t: 'hideCaption', text });
  }

  setScreen(screen: FaceScreen | null): void {
    this.#screen = screen;
    this.#emit({ t: 'screen', screen });
  }

  override update(nowMs: number): boolean {
    this.#nowMs = nowMs;
    return super.update(nowMs);
  }

  /** Everything a screen that has just connected needs to show the face as it is now. */
  snapshot(): FaceMessage[] {
    const now = this.#nowMs;
    const messages: FaceMessage[] = [
      { t: 'emotion', ...this.#emotion },
      { t: 'look', target: this.#look },
      { t: 'blinking', on: this.#blinking },
      { t: 'screen', screen: this.#screen },
    ];
    if (this.#media && this.#media.endMs > now + 300) messages.push({ t: 'media', id: this.#media.id, ...this.#media.gif, durationMs: this.#media.endMs - now });
    if (this.#caption && this.#caption.endMs > now + 300) messages.push({ t: 'caption', text: this.#caption.text, durationMs: this.#caption.endMs - now - 280 });
    return messages;
  }

  #emit(message: FaceMessage): void {
    for (const listener of this.#listeners) listener(message);
  }
}
