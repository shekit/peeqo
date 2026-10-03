import type { DotstarStrip } from './dotstar.ts';
import { seededRandom, smoothWander } from './motion.ts';

/**
 * Where the 12 LEDs sit around the ring, in Peeqo's frame (degrees from straight ahead, + toward Peeqo's left).
 * Assumed until checked on the robot: LED 0 just to the right of the front, numbering on toward Peeqo's right.
 */
export const LED_RING_LAYOUT = { count: 12, firstLedDeg: -15, stepDeg: -30 } as const;

export type Rgb = readonly [number, number, number];

/** Named colours (0–255): the 2019 palette plus a few softer ones. */
export const LED_COLORS = Object.freeze({
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  aqua: [0, 255, 255],
  purple: [190, 64, 242],
  orange: [239, 75, 36],
  yellow: [255, 215, 18],
  pink: [244, 52, 239],
  white: [255, 255, 255],
  warm: [255, 160, 70],
  mint: [70, 255, 160],
  sky: [60, 160, 255],
} as const satisfies Record<string, Rgb>);
export type LedColorName = keyof typeof LED_COLORS;

export function isLedColorName(name: string): name is LedColorName {
  return Object.hasOwn(LED_COLORS, name);
}

interface PatternSpec {
  readonly description: string;
  readonly color: LedColorName;
  /** Seconds for a one-shot; null for patterns that loop until changed. */
  readonly duration: number | null;
}

const PATTERNS = {
  off: { description: 'Fades out', color: 'white', duration: null },
  glow: { description: 'A steady soft light', color: 'warm', duration: null },
  breathe: { description: 'Slow breathing, lingering dim: resting or asleep', color: 'sky', duration: null },
  heartbeat: { description: 'A double pulse about once a second: affection', color: 'pink', duration: null },
  spin: { description: 'A comet circling the ring: thinking or working', color: 'aqua', duration: null },
  listen: { description: 'Gentle ripples running to the front: listening', color: 'aqua', duration: null },
  speak: { description: 'Light that swells from the front with the voice: talking', color: 'mint', duration: null },
  rainbow: { description: 'A rainbow turning around the ring: celebration', color: 'white', duration: null },
  sparkle: { description: 'Random twinkles: excitement, magic', color: 'yellow', duration: null },
  success: { description: 'Fills from the front around both sides, then fades: done', color: 'green', duration: 1.5 },
  error: { description: 'Two quick flashes, then fades: something went wrong', color: 'red', duration: 1.3 },
  wake: { description: 'A burst from the front that settles: hello, I am here', color: 'aqua', duration: 1.3 },
} as const satisfies Record<string, PatternSpec>;

export type LedPatternName = keyof typeof PATTERNS;
export const LED_PATTERN_NAMES = Object.keys(PATTERNS) as LedPatternName[];

export function isLedPatternName(name: string): name is LedPatternName {
  return Object.hasOwn(PATTERNS, name);
}

export function describeLedPattern(name: LedPatternName): string {
  return PATTERNS[name].description;
}

export interface LedPlayOptions {
  /** A named colour or an RGB triple (0–255); each pattern has a default. */
  readonly color?: LedColorName | Rgb;
  /** Speed of the pattern, 0.25…3 (1 = normal). */
  readonly speed?: number;
  /** Overall brightness, 0…1. */
  readonly brightness?: number;
  /** For one-shots: what to show afterwards (default: the looping pattern that was showing before). */
  readonly then?: LedPatternName;
}

interface Playing {
  readonly name: LedPatternName;
  readonly color: Rgb;
  readonly speed: number;
  readonly brightness: number;
  readonly startS: number;
  readonly then: LedPatternName | null;
}

/** Crossfade between patterns (s). */
const FADE_S = 0.3;
/** Perceived intensity → LED drive (LEDs are linear; eyes are not). */
const GAMMA = 2.2;
const TAU = 2 * Math.PI;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (u: number) => {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
};
/** Signed angular difference a − b in degrees, in −180…180. */
const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const pulse = (x: number, centre: number, width: number) => Math.exp(-(((x - centre) / width) ** 2));

function hsv(h: number, s: number, v: number): Rgb {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const k = ((i % 6) + 6) % 6;
  return ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]] as const)[k]!;
}

/**
 * The ring's light as smooth, time-based patterns. Patterns crossfade into each other; one-shots (success, error,
 * wake) return to whatever was looping before. Output is gamma-corrected and uses both the LEDs' 5-bit global
 * brightness and their 8-bit colour, so fades stay smooth even when dim. Call update() every frame.
 */
export class LedAnimator {
  readonly strip: DotstarStrip;
  readonly #random: () => number;
  readonly #angles: readonly number[];
  readonly #voice: (t: number) => number;
  #playing: Playing;
  #base: Playing;
  #from: Rgb[] | null = null;
  #fadeStartS = 0;
  #frame: Rgb[];
  #nowS = 0;
  /** Seconds since the previous update (for random events, so their rate does not depend on frame rate). */
  #dtS = 0;
  #active = true;
  #level: number | null = null;
  #twinkles: number[];
  #lastWritten = '';

  constructor(strip: DotstarStrip, options: { seed?: number } = {}) {
    this.strip = strip;
    this.#random = seededRandom(options.seed ?? 1);
    this.#angles = Array.from({ length: strip.length }, (_, i) => LED_RING_LAYOUT.firstLedDeg + i * LED_RING_LAYOUT.stepDeg);
    this.#voice = smoothWander(this.#random, 0.7);
    this.#twinkles = Array.from({ length: strip.length }, () => Number.NEGATIVE_INFINITY);
    this.#frame = Array.from({ length: strip.length }, () => [0, 0, 0] as Rgb);
    this.#playing = this.#make('off', {});
    this.#base = this.#playing;
  }

  /** The pattern showing now. */
  get pattern(): LedPatternName {
    return this.#playing.name;
  }

  /** Whether this animator is driving the strip (stop() hands it to something else). */
  get active(): boolean {
    return this.#active;
  }

  play(name: LedPatternName, options: LedPlayOptions = {}): void {
    if (!isLedPatternName(name)) throw new Error(`Unknown LED pattern "${String(name)}"`);
    const next = this.#make(name, options);
    this.#from = this.#frame.map((c) => [...c] as unknown as Rgb);
    this.#fadeStartS = this.#nowS;
    if (PATTERNS[name].duration === null) this.#base = next;
    this.#playing = next;
    this.#active = true;
  }

  /** Stops driving the strip, leaving it to something else (the 2019 animations). */
  stop(): void {
    this.#active = false;
  }

  /** Voice level for the speak pattern, 0…1, or null to make one up. */
  setLevel(level: number | null): void {
    this.#level = level === null || !Number.isFinite(level) ? null : clamp01(level);
  }

  /** Advances to nowMs and shows the frame. */
  update(nowMs: number): void {
    this.#dtS = Math.min(0.1, Math.max(0, nowMs / 1000 - this.#nowS));
    this.#nowS = nowMs / 1000;
    const p = this.#playing;
    const duration = PATTERNS[p.name].duration;
    if (duration !== null && this.#nowS - p.startS >= duration / p.speed) {
      const after = p.then ? this.#make(p.then, { color: p.color, speed: p.speed, brightness: p.brightness }) : { ...this.#base, startS: this.#nowS };
      this.#from = this.#frame.map((c) => [...c] as unknown as Rgb);
      this.#fadeStartS = this.#nowS;
      this.#playing = after;
      if (PATTERNS[after.name].duration === null) this.#base = after;
    }
    const target = this.#render(this.#playing);
    const k = this.#from ? smoothstep((this.#nowS - this.#fadeStartS) / FADE_S) : 1;
    if (k >= 1) this.#from = null;
    const from = this.#from;
    this.#frame = target.map((c, i) => (from ? (c.map((v, j) => from[i]![j]! + (v - from[i]![j]!) * k) as unknown as Rgb) : c));
    if (this.#active) this.#write();
  }

  #make(name: LedPatternName, options: LedPlayOptions): Playing {
    const color = options.color === undefined ? LED_COLORS[PATTERNS[name].color] : typeof options.color === 'string' ? LED_COLORS[options.color] : options.color;
    if (!color || color.length !== 3 || color.some((v) => !(v >= 0 && v <= 255))) throw new Error('LED colour must be a known name or three values 0–255');
    const finiteOr = (v: number | undefined, d: number) => (v !== undefined && Number.isFinite(v) ? v : d);
    return {
      name,
      color,
      speed: Math.min(3, Math.max(0.25, finiteOr(options.speed, 1))),
      brightness: clamp01(finiteOr(options.brightness, 1)),
      startS: this.#nowS,
      then: options.then ?? null,
    };
  }

  /** Perceived colour (0–1 per channel) of every LED for a pattern at the current time. */
  #render(p: Playing): Rgb[] {
    const t = (this.#nowS - p.startS) * p.speed;
    const [cr, cg, cb] = [p.color[0] / 255, p.color[1] / 255, p.color[2] / 255];
    const tint = (intensity: number): Rgb => {
      const i = clamp01(intensity) * p.brightness;
      return [cr * i, cg * i, cb * i];
    };
    return this.#angles.map((theta, led): Rgb => {
      const front = Math.abs(angleDiff(theta, 0)); // 0 at the front, 180 at the back
      switch (p.name) {
        case 'off':
          return [0, 0, 0];
        case 'glow':
          return tint(0.75);
        case 'breathe': {
          const b = 0.5 - 0.5 * Math.cos((TAU * t) / 4.2);
          return tint(0.06 + 0.94 * b ** 1.6);
        }
        case 'heartbeat': {
          const phase = t % 1.0;
          return tint(0.12 + 0.88 * Math.min(1, pulse(phase, 0.1, 0.05) + 0.7 * pulse(phase, 0.32, 0.05)));
        }
        case 'spin': {
          const head = (t * 330) % 360; // degrees, travelling toward increasing LED angle
          const behind = (((head - theta) % 360) + 360) % 360; // how far behind the head this LED is
          const ahead = 360 - behind;
          return tint(0.04 + 0.96 * Math.max(Math.exp(-behind / 55) * (behind < 300 ? 1 : 0), pulse(ahead, 0, 14)));
        }
        case 'listen': {
          // Ripples running from the back to the front, brightest in front.
          const ripple = 0.5 + 0.5 * Math.sin(TAU * 0.8 * t + (front / 180) * Math.PI * 1.5);
          return tint(0.18 + 0.5 * (1 - front / 180) ** 1.5 + 0.32 * ripple * (1 - front / 220));
        }
        case 'speak': {
          const level = this.#level ?? clamp01(0.2 + 0.8 * Math.max(0, Math.sin(TAU * 4.3 * t + 1.7 * Math.sin(TAU * 0.7 * t))) ** 0.7 * (0.65 + 0.35 * this.#voice(t)));
          // Light spreads from the front as the voice swells.
          const width = 25 + 155 * level;
          return tint((0.1 + 0.9 * level) * smoothstep((width - front) / 30 + 0.5));
        }
        case 'rainbow': {
          const c = hsv((((theta / 360 + 0.22 * t) % 1) + 1) % 1, 1, 0.9 * p.brightness);
          return c;
        }
        case 'sparkle': {
          if (this.#random() < 1.6 * p.speed * this.#dtS) this.#twinkles[led] = this.#nowS; // about 1.6 twinkles a second per LED
          const age = this.#nowS - this.#twinkles[led]!;
          const level = age < 0.04 ? age / 0.04 : Math.exp(-(age - 0.04) / 0.28);
          const white = level ** 2; // the brightest moment flashes toward white
          const i = clamp01(0.08 + level) * p.brightness;
          return [(cr + (1 - cr) * white) * i, (cg + (1 - cg) * white) * i, (cb + (1 - cb) * white) * i];
        }
        case 'success': {
          const reach = 180 * smoothstep(t / 0.55);
          const fill = smoothstep((reach - front) / 25 + 0.5);
          const fade = 1 - smoothstep((t - 0.85) / 0.65);
          return tint(fill * fade);
        }
        case 'error': {
          const flash = t < 0.15 || (t >= 0.3 && t < 0.45) ? 1 : 0;
          const fade = t >= 0.45 ? 1 - smoothstep((t - 0.45) / 0.85) : flash;
          return tint(t < 0.45 ? flash : fade * 0.9);
        }
        case 'wake': {
          const ring = 180 * smoothstep(t / 0.45);
          const burst = pulse(front, ring, 40) * (1 - smoothstep((t - 0.5) / 0.6));
          const settle = 0.35 * smoothstep((t - 0.3) / 0.6) * (1 - smoothstep((t - 0.9) / 0.4));
          return tint(Math.max(burst, settle));
        }
      }
    });
  }

  #write(): void {
    const values = this.#frame.map(([r, g, b]) => {
      const [pr, pg, pb] = [r ** GAMMA, g ** GAMMA, b ** GAMMA];
      const level = Math.max(pr, pg, pb);
      if (level < 1 / (255 * 31)) return [0, 0, 0, 0] as const;
      // Coarse level in the 5-bit global brightness, the rest in the 8-bit colour.
      const a = Math.ceil(31 * level) / 31;
      return [Math.min(255, Math.round((255 * pr) / a)), Math.min(255, Math.round((255 * pg) / a)), Math.min(255, Math.round((255 * pb) / a)), a] as const;
    });
    const key = values.map((v) => v.join(',')).join(';');
    if (key === this.#lastWritten) return;
    this.#lastWritten = key;
    values.forEach(([r, g, b, a], i) => this.strip.set(i, r, g, b, a));
    this.strip.sync();
  }
}
