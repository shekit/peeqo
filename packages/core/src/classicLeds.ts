import type { DotstarStrip } from './dotstar.ts';
import type { VirtualScheduler } from './scheduler.ts';

/** Colours defined in electron/app/js/senses/leds.js. */
export const CLASSIC_LED_COLORS = Object.freeze({
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  aqua: [0, 255, 255],
  purple: [190, 64, 242],
  orange: [239, 75, 36],
  yellow: [255, 215, 18],
  pink: [244, 52, 239],
  black: [0, 0, 0],
} as const satisfies Record<string, readonly [number, number, number]>);

export type ClassicLedColor = keyof typeof CLASSIC_LED_COLORS;
export const CLASSIC_LED_ANIMATIONS = ['circle', 'circleOut', 'blink', 'fadeOutError', 'on', 'off'] as const;
export type ClassicLedAnimation = (typeof CLASSIC_LED_ANIMATIONS)[number];

export function isClassicLedColor(name: string): name is ClassicLedColor {
  return Object.hasOwn(CLASSIC_LED_COLORS, name);
}

/**
 * Line-for-line port of the 2019 LED animations (electron/app/js/senses/leds.js), including their timing
 * quirks, run on a VirtualScheduler instead of the global timers.
 */
export class ClassicLeds {
  readonly strip: DotstarStrip;
  readonly #timers: VirtualScheduler;

  constructor(strip: DotstarStrip, scheduler: VirtualScheduler) {
    this.strip = strip;
    this.#timers = scheduler;
  }

  /** Same as the 2019 playAnimation({anim, color}): runs the named animation with its default settings. */
  play(animation: ClassicLedAnimation, color: ClassicLedColor): void {
    switch (animation) {
      case 'circle':
        return this.circle(color);
      case 'circleOut':
        return this.circleOut(color);
      case 'blink':
        return this.blink(color);
      case 'fadeOutError':
        return this.fadeOutError(color);
      case 'on':
        return this.on(color);
      case 'off':
        return this.off();
    }
  }

  blink(color: ClassicLedColor = 'red', time = 500, count = 5, brightness = 0.5): void {
    let blinkCount = 0;
    const blinkInterval = this.#timers.setInterval(() => {
      if (blinkCount % 2 === 0) this.on(color, brightness);
      else this.off();
      blinkCount++;
      if (blinkCount > count) this.#timers.clear(blinkInterval);
    }, time);
  }

  circle(color: ClassicLedColor = 'aqua'): void {
    this.trail(color, 0, 5);
    this.trail(color, 11, 6);
    this.#timers.setTimeout(() => {
      this.trail(color, 5, 0, false);
      this.trail(color, 6, 11, false);
    }, 1000);
    this.#timers.setTimeout(() => this.off(), 2500);
  }

  circleOut(color: ClassicLedColor = 'green'): void {
    this.trail(color, 0, 5);
    this.trail(color, 11, 6);
  }

  trail(color: ClassicLedColor, start: number, finish: number, overshoot = true, brightness = 0.5, time = 100, trailLength = 3): void {
    const length = this.strip.length;
    // Same range check as 2019 (which allowed start/finish === length).
    if (start < 0 || finish < 0 || start > length || finish > length) return;
    let firstLed = start;
    const currentlyOn: number[] = [];
    const [r, g, b] = CLASSIC_LED_COLORS[color];
    const moveInterval = this.#timers.setInterval(() => {
      currentlyOn.push(firstLed);
      if (currentlyOn.length > trailLength) {
        const removeLed = currentlyOn.shift();
        if (removeLed !== undefined) this.strip.set(removeLed, 0, 0, 0, 0);
      }
      for (const led of currentlyOn) this.strip.set(led, r, g, b, brightness);
      this.strip.sync();

      if (start < finish) {
        firstLed++;
        if (firstLed > finish) {
          this.#timers.clear(moveInterval);
          if (overshoot) this.clearLedTrail(currentlyOn, time);
        }
      } else if (start > finish) {
        firstLed--;
        if (firstLed < finish) {
          this.#timers.clear(moveInterval);
          if (overshoot) this.clearLedTrail(currentlyOn, time);
        }
      }
    }, time);
  }

  fadeOutError(color: ClassicLedColor = 'red', time = 100): void {
    const increment = 0.1;
    let brightness = 0.5;
    const [r, g, b] = CLASSIC_LED_COLORS[color];
    this.on(color, brightness);
    const fadeOutInterval = this.#timers.setInterval(() => {
      this.strip.all(r, g, b, brightness);
      this.strip.sync();
      brightness -= increment;
      if (brightness < 0) {
        this.#timers.clear(fadeOutInterval);
        this.strip.clear();
        this.strip.sync();
      }
    }, time);
  }

  clearLedTrail(onLeds: number[], time = 100): void {
    const removeInterval = this.#timers.setInterval(() => {
      if (onLeds.length !== 0) {
        const offLed = onLeds.shift();
        if (offLed !== undefined) this.strip.set(offLed, 0, 0, 0, 0);
      } else {
        this.#timers.clear(removeInterval);
        // As in 2019, this clears the whole strip, including any other trail still running.
        this.strip.clear();
      }
      this.strip.sync();
    }, time);
  }

  on(color: ClassicLedColor, brightness = 0.5): void {
    const [r, g, b] = CLASSIC_LED_COLORS[color];
    this.strip.all(r, g, b, brightness);
    this.strip.sync();
  }

  off(): void {
    this.strip.clear();
    this.strip.sync();
  }
}
