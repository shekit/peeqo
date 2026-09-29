export interface LedPixel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** APA102 global brightness, 0–31. */
  readonly brightness: number;
}

const DARK: LedPixel = Object.freeze({ r: 0, g: 0, b: 0, brightness: 0 });

function toPixel(r: number, g: number, b: number, a: number): LedPixel {
  for (const [name, v] of [['red', r], ['green', g], ['blue', b]] as const) {
    if (!(v >= 0 && v <= 255)) throw new RangeError(`LED ${name} must be 0–255, got ${v}`);
  }
  if (!(a >= 0 && a <= 1)) throw new RangeError(`LED brightness must be 0–1, got ${a}`);
  // Same encoding as electron/app/js/lib/dotstar.js: 5-bit brightness = floor(31 · a).
  return { r: Math.floor(r), g: Math.floor(g), b: Math.floor(b), brightness: Math.floor(31 * a) };
}

/**
 * Model of the APA102 (DotStar) strip driver in electron/app/js/lib/dotstar.js: set/all/clear change a
 * pending buffer and sync() shows it. The simulator draws `shown`; on the robot the same calls go to SPI.
 */
export class DotstarStrip {
  readonly length: number;
  #pending: LedPixel[];
  #shown: LedPixel[];
  #version = 0;

  constructor(length = 12) {
    if (!Number.isInteger(length) || length <= 0) throw new RangeError(`Strip length must be a positive integer, got ${length}`);
    this.length = length;
    this.#pending = Array.from({ length }, () => DARK);
    this.#shown = Array.from({ length }, () => DARK);
  }

  /** Pixels currently lit (as of the last sync). */
  get shown(): readonly LedPixel[] {
    return this.#shown;
  }

  /** Increments whenever what is shown changes, so renderers can skip redundant work. */
  get version(): number {
    return this.#version;
  }

  set(led: number, r: number, g: number, b: number, a = 1): void {
    if (!Number.isInteger(led) || led < 0) throw new RangeError(`LED index must be a non-negative integer, got ${led}`);
    // The 2019 driver accepted index === length and silently wrote nothing; keep that behaviour.
    if (led > this.length) throw new RangeError(`LED index ${led} is beyond the strip (length ${this.length})`);
    if (led === this.length) return;
    this.#pending[led] = toPixel(r, g, b, a);
  }

  all(r: number, g: number, b: number, a = 1): void {
    const pixel = toPixel(r, g, b, a);
    this.#pending = this.#pending.map(() => pixel);
  }

  clear(): void {
    this.#pending = this.#pending.map(() => DARK);
  }

  sync(): void {
    this.#shown = [...this.#pending];
    this.#version++;
  }

  /** Blanks the LEDs without touching the pending buffer (dotstar.js off()). */
  off(): void {
    this.#shown = this.#shown.map(() => DARK);
    this.#version++;
  }
}
