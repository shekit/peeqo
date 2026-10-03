import { describe, expect, it } from 'vitest';
import { DotstarStrip, LED_PATTERN_NAMES, LED_RING_LAYOUT, LedAnimator, type LedPatternName } from '../src/index.ts';

const FRAME_MS = 1000 / 60;

function setup(seed = 1) {
  const strip = new DotstarStrip(LED_RING_LAYOUT.count);
  return { strip, leds: new LedAnimator(strip, { seed }) };
}

/** Advances `seconds` at 60 fps, calling `each` with the shown pixels after every frame. */
function run(leds: LedAnimator, fromMs: number, seconds: number, each?: () => void): number {
  let now = fromMs;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    now += FRAME_MS;
    leds.update(now);
    each?.();
  }
  return now;
}

/** Light of each LED as the 0–1 drive level the strip shows (colour × global brightness). */
const levels = (strip: DotstarStrip) => strip.shown.map((p) => (Math.max(p.r, p.g, p.b) / 255) * (p.brightness / 31));

describe('LedAnimator', () => {
  it('drives every pattern with valid values only', () => {
    for (const name of LED_PATTERN_NAMES) {
      const { strip, leds } = setup();
      leds.play(name);
      run(leds, 0, 4, () => {
        for (const p of strip.shown) {
          for (const v of [p.r, p.g, p.b]) expect(Number.isInteger(v) && v >= 0 && v <= 255, `${name}: ${v}`).toBe(true);
          expect(p.brightness >= 0 && p.brightness <= 31, name).toBe(true);
        }
      });
    }
  });

  it('crossfades between patterns instead of jumping', () => {
    const { strip, leds } = setup();
    leds.play('glow');
    let now = run(leds, 0, 1);
    leds.play('off');
    let previous = levels(strip);
    let largest = 0;
    now = run(leds, now, 0.6, () => {
      const current = levels(strip);
      largest = Math.max(largest, ...current.map((v, i) => Math.abs(v - previous[i]!)));
      previous = current;
    });
    expect(largest).toBeLessThan(0.15);
    expect(levels(strip).every((v) => v === 0)).toBe(true);
  });

  it('returns to what was looping after a one-shot, or to what it is told', () => {
    const { leds } = setup();
    leds.play('listen');
    let now = run(leds, 0, 0.5);
    leds.play('success');
    expect(leds.pattern).toBe('success');
    now = run(leds, now, 1.7);
    expect(leds.pattern).toBe('listen');
    leds.play('error', { then: 'breathe' });
    run(leds, now, 1.5);
    expect(leds.pattern).toBe('breathe');
  });

  it('keeps dim moments smooth: breathing never drops to a hard off', () => {
    const { strip, leds } = setup();
    leds.play('breathe');
    const now = run(leds, 0, 0.5); // past the fade-in from off
    let lowest = 1;
    let highest = 0;
    run(leds, now, 9, () => {
      const v = Math.max(...levels(strip));
      lowest = Math.min(lowest, v);
      highest = Math.max(highest, v);
    });
    expect(lowest).toBeGreaterThan(0);
    expect(highest).toBeGreaterThan(0.8);
  });

  it('spins a comet all the way round the ring', () => {
    const { strip, leds } = setup();
    leds.play('spin');
    const headsSeen = new Set<number>();
    run(leds, 0, 1.4, () => {
      const v = levels(strip);
      headsSeen.add(v.indexOf(Math.max(...v)));
    });
    expect(headsSeen.size).toBe(LED_RING_LAYOUT.count);
  });

  it('listens brightest at the front', () => {
    const { strip, leds } = setup();
    leds.play('listen');
    const sums = new Array<number>(12).fill(0);
    run(leds, 0, 5, () => levels(strip).forEach((v, i) => (sums[i]! += v)));
    // LEDs 0 and 11 flank the front; 5 and 6 the back.
    expect(sums[0]! + sums[11]!).toBeGreaterThan(1.5 * (sums[5]! + sums[6]!));
  });

  it('follows a given voice level when speaking', () => {
    const { strip, leds } = setup();
    leds.play('speak');
    leds.setLevel(0);
    let now = run(leds, 0, 1);
    const quiet = levels(strip).filter((v) => v > 0.05).length;
    leds.setLevel(1);
    run(leds, now, 1);
    const loud = levels(strip).filter((v) => v > 0.05).length;
    expect(quiet).toBeLessThanOrEqual(2);
    expect(loud).toBe(12);
  });

  it('leaves the strip alone once stopped', () => {
    const { strip, leds } = setup();
    leds.play('rainbow');
    let now = run(leds, 0, 0.5);
    leds.stop();
    const version = strip.version;
    now = run(leds, now, 1);
    expect(strip.version).toBe(version);
    leds.play('glow');
    run(leds, now, 0.1);
    expect(strip.version).toBeGreaterThan(version);
  });

  it('takes the strip back properly from something else that wrote to it', () => {
    const strip = new DotstarStrip(12);
    let stopped = 0;
    const leds = new LedAnimator(strip, { onPlay: () => stopped++ });
    leds.play('off');
    let now = run(leds, 0, 0.5);
    leds.stop();
    strip.all(255, 255, 255, 1); // the 2019 animations light the ring
    strip.sync();
    leds.play('off'); // same dark frame as before, but the strip is lit: it must still be written
    run(leds, now, 0.5);
    expect(levels(strip).every((v) => v === 0)).toBe(true);
    expect(stopped).toBe(2);
  });

  it('gives a follow-up pattern its own colour', () => {
    const { strip, leds } = setup();
    leds.play('error', { then: 'breathe' });
    run(leds, 0, 4);
    const lit = strip.shown.filter((p) => p.brightness > 0);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.every((p) => p.b > p.r)).toBe(true); // breathe's sky blue, not error's red
  });

  it('replays sparkles exactly with the same seed', () => {
    const trace = (seed: number) => {
      const { strip, leds } = setup(seed);
      leds.play('sparkle');
      const out: number[] = [];
      run(leds, 0, 3, () => out.push(...levels(strip)));
      return out;
    };
    expect(trace(3)).toEqual(trace(3));
    expect(trace(3)).not.toEqual(trace(4));
  });

  it('rejects unknown patterns and bad colours', () => {
    const { leds } = setup();
    expect(() => leds.play('disco' as LedPatternName)).toThrow(/Unknown LED pattern/);
    expect(() => leds.play('glow', { color: [300, 0, 0] })).toThrow(/colour/);
  });
});
