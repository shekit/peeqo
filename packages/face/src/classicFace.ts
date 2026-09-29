/** Screen size of Peeqo's display, in pixels. */
export const FACE_WIDTH = 800;
export const FACE_HEIGHT = 480;

/** Order the 2019 "change glasses" command cycles through (glasses.js); glass-star.png was never in it. */
export const CLASSIC_GLASSES_CYCLE = [
  'glass-regular',
  'glass-pointy',
  'glass-square',
  'glass-circle',
  'glass-rectangle',
  'glass-rayban',
] as const;

interface Tween {
  readonly from: number;
  readonly to: number;
  readonly startMs: number;
  readonly durationMs: number;
  readonly onDone: (() => void) | null;
}

function tweenValue(t: Tween, nowMs: number): number {
  const progress = Math.min(1, Math.max(0, (nowMs - t.startMs) / t.durationMs));
  return t.from + (t.to - t.from) * progress;
}

export interface ClassicFaceOptions {
  /** Random source for blink timing; defaults to Math.random. */
  readonly random?: () => number;
}

/**
 * Port of the 2019 face (electron/app/js/face/eyes.js and glasses.js): two black eyes on white that blink
 * at random intervals, with a glasses overlay. Time is passed in, so it can be driven by any clock.
 *
 * The 2019 code passed mina.elastic() and mina.easein() (function calls that return NaN) as easings, so
 * Snap.svg fell back to linear. This port animates linearly to match what the robot actually showed.
 */
export class ClassicFace {
  static readonly LEFT_EYE_X = 202.5;
  static readonly RIGHT_EYE_X = 604.5;
  static readonly EYE_Y = 330;
  static readonly EYE_SIZE = 87.5;
  static readonly CLOSED_EYE = 1;
  static readonly BLINK_MS = 120;
  static readonly TRANSITION_SIZE = 1000;
  static readonly TRANSITION_MS = 100;
  static readonly BLINK_INTERVALS_MS = [4000, 6000, 10000, 1000, 500, 8000] as const;

  readonly #random: () => number;
  #rx = ClassicFace.EYE_SIZE;
  #ry = ClassicFace.EYE_SIZE;
  #rxTween: Tween | null = null;
  #ryTween: Tween | null = null;
  #nextBlinkMs: number | null = null;
  #glasses: CanvasImageSource | null = null;
  #dirty = true;

  constructor(options: ClassicFaceOptions = {}) {
    this.#random = options.random ?? Math.random;
  }

  get isBlinking(): boolean {
    return this.#nextBlinkMs !== null;
  }

  /** Current eye radii, for tests and debugging. */
  get eyeRadii(): { rx: number; ry: number } {
    return { rx: this.#rx, ry: this.#ry };
  }

  setGlasses(image: CanvasImageSource | null): void {
    this.#glasses = image;
    this.#dirty = true;
  }

  startBlinking(nowMs: number): void {
    this.#nextBlinkMs = nowMs + this.#randomInterval();
  }

  stopBlinking(): void {
    this.#nextBlinkMs = null;
  }

  /** Closes and reopens the eyes (120 ms each way), like eyes.js blink(). */
  blink(nowMs: number): void {
    this.#ryTween = {
      from: this.#ry,
      to: ClassicFace.CLOSED_EYE,
      startMs: nowMs,
      durationMs: ClassicFace.BLINK_MS,
      onDone: () => {
        const openAt = nowMs + ClassicFace.BLINK_MS;
        this.#ryTween = { from: this.#ry, to: ClassicFace.EYE_SIZE, startMs: openAt, durationMs: ClassicFace.BLINK_MS, onDone: null };
      },
    };
    if (this.#nextBlinkMs !== null) this.#nextBlinkMs = nowMs + this.#randomInterval();
  }

  /** Grows the eyes until they fill the screen (before showing media), then calls onDone. */
  transitionAway(nowMs: number, onDone?: () => void): void {
    this.stopBlinking();
    this.#rxTween = { from: this.#rx, to: ClassicFace.TRANSITION_SIZE, startMs: nowMs, durationMs: ClassicFace.TRANSITION_MS, onDone: null };
    this.#ryTween = {
      from: this.#ry,
      to: ClassicFace.TRANSITION_SIZE,
      startMs: nowMs,
      durationMs: ClassicFace.TRANSITION_MS,
      onDone: onDone ?? null,
    };
  }

  /** Shrinks the eyes back to normal and resumes blinking. */
  transitionBack(nowMs: number, onDone?: () => void): void {
    this.#rxTween = { from: this.#rx, to: ClassicFace.EYE_SIZE, startMs: nowMs, durationMs: ClassicFace.TRANSITION_MS, onDone: null };
    this.#ryTween = {
      from: this.#ry,
      to: ClassicFace.EYE_SIZE,
      startMs: nowMs,
      durationMs: ClassicFace.TRANSITION_MS,
      onDone: () => {
        this.startBlinking(nowMs + ClassicFace.TRANSITION_MS);
        onDone?.();
      },
    };
  }

  /** Advances animations to nowMs. Returns true if the face needs redrawing. */
  update(nowMs: number): boolean {
    if (this.#nextBlinkMs !== null && nowMs >= this.#nextBlinkMs) this.blink(this.#nextBlinkMs);
    if (this.#rxTween) {
      this.#rx = tweenValue(this.#rxTween, nowMs);
      this.#dirty = true;
      if (nowMs >= this.#rxTween.startMs + this.#rxTween.durationMs) {
        const done = this.#rxTween.onDone;
        this.#rxTween = null;
        done?.();
      }
    }
    if (this.#ryTween) {
      this.#ry = tweenValue(this.#ryTween, nowMs);
      this.#dirty = true;
      if (nowMs >= this.#ryTween.startMs + this.#ryTween.durationMs) {
        const done = this.#ryTween.onDone;
        this.#ryTween = null;
        done?.();
        // A follow-on tween (the eye reopening) may already be due.
        if (this.#ryTween) this.#ry = tweenValue(this.#ryTween, nowMs);
      }
    }
    const dirty = this.#dirty;
    this.#dirty = false;
    return dirty;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
    ctx.fillStyle = '#000000';
    for (const x of [ClassicFace.LEFT_EYE_X, ClassicFace.RIGHT_EYE_X]) {
      ctx.beginPath();
      ctx.ellipse(x, ClassicFace.EYE_Y, Math.max(0, this.#rx), Math.max(0, this.#ry), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.#glasses) ctx.drawImage(this.#glasses, 0, 0, FACE_WIDTH, FACE_HEIGHT);
  }

  #randomInterval(): number {
    const list = ClassicFace.BLINK_INTERVALS_MS;
    return list[Math.min(list.length - 1, Math.floor(list.length * this.#random()))] ?? 4000;
  }
}
