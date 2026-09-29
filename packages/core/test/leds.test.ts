import { describe, expect, it } from 'vitest';
import { ClassicLeds, DotstarStrip, VirtualScheduler, type LedPixel } from '../src/index.ts';

const lit = (pixels: readonly LedPixel[]) =>
  pixels.flatMap((p, i) => (p.brightness > 0 && (p.r || p.g || p.b) ? [i] : []));

function setup() {
  const strip = new DotstarStrip(12);
  const timers = new VirtualScheduler(0);
  return { strip, timers, leds: new ClassicLeds(strip, timers) };
}

describe('VirtualScheduler', () => {
  it('runs timeouts and intervals in time order and supports clearing from inside a callback', () => {
    const timers = new VirtualScheduler(0);
    const log: string[] = [];
    timers.setTimeout(() => log.push('t150'), 150);
    let n = 0;
    const id = timers.setInterval(() => {
      log.push(`i${timers.now()}`);
      if (++n === 3) timers.clear(id);
    }, 100);
    timers.advanceTo(1000);
    expect(log).toEqual(['i100', 't150', 'i200', 'i300']);
    expect(timers.now()).toBe(1000);
  });
});

describe('DotstarStrip', () => {
  it('encodes brightness like the 2019 driver and only shows changes after sync', () => {
    const strip = new DotstarStrip(12);
    strip.set(3, 255, 0, 0, 0.5);
    expect(lit(strip.shown)).toEqual([]);
    strip.sync();
    expect(strip.shown[3]).toEqual({ r: 255, g: 0, b: 0, brightness: 15 });
    strip.set(12, 1, 1, 1); // accepted and ignored, as in 2019
    expect(() => strip.set(13, 1, 1, 1)).toThrow(RangeError);
    expect(() => strip.all(256, 0, 0)).toThrow(RangeError);
  });
});

describe('ClassicLeds (2019 animations)', () => {
  it('blink: on at 0.5 s, 1.5 s and 2.5 s, off at 1, 2 and 3 s, then stops', () => {
    const { strip, timers, leds } = setup();
    leds.blink('green');
    const states: number[] = [];
    for (let t = 250; t <= 4000; t += 500) {
      timers.advanceTo(t);
      states.push(lit(strip.shown).length);
    }
    // Sampled at 0.25, 0.75, 1.25 … 3.75 s.
    expect(states).toEqual([0, 12, 0, 12, 0, 12, 0, 0]);
  });

  it('circle: two three-LED trails sweep from LEDs 0/11 to 5/6, come back, and everything is off at 2.5 s', () => {
    const { strip, timers, leds } = setup();
    leds.circle('aqua');
    timers.advanceTo(100);
    expect(lit(strip.shown)).toEqual([0, 11]);
    timers.advanceTo(300);
    expect(lit(strip.shown)).toEqual([0, 1, 2, 9, 10, 11]);
    timers.advanceTo(600);
    expect(lit(strip.shown)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(strip.shown[4]).toEqual({ r: 0, g: 255, b: 255, brightness: 15 });
    timers.advanceTo(1050);
    expect(lit(strip.shown)).toEqual([]);
    timers.advanceTo(2400);
    expect(lit(strip.shown)).toEqual([0, 1, 2, 9, 10, 11]);
    timers.advanceTo(2500);
    expect(lit(strip.shown)).toEqual([]);
  });

  it('fadeOutError: full ring dims in 0.1 steps and clears after the brightness drops below zero', () => {
    const { strip, timers, leds } = setup();
    leds.fadeOutError('red');
    expect(strip.shown[0]!.brightness).toBe(15);
    const levels: number[] = [];
    for (let t = 100; t <= 800; t += 100) {
      timers.advanceTo(t);
      levels.push(strip.shown[0]!.brightness);
    }
    // floor(31 × 0.5, 0.4, 0.3, 0.2, 0.1, ~0) then cleared.
    expect(levels).toEqual([15, 12, 9, 6, 3, 0, 0, 0]);
    expect(lit(strip.shown)).toEqual([]);
  });
});
