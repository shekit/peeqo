import { describe, expect, it } from 'vitest';
import { ClassicFace } from '../src/index.ts';

describe('ClassicFace (2019 eyes)', () => {
  it('blinks linearly: closes over 120 ms, reopens over the next 120 ms', () => {
    const face = new ClassicFace({ random: () => 0 }); // always the first interval: 4000 ms
    face.startBlinking(0);
    face.update(3999);
    expect(face.eyeRadii.ry).toBe(87.5);
    face.update(4060);
    expect(face.eyeRadii.ry).toBeCloseTo(87.5 + (1 - 87.5) * 0.5, 9);
    face.update(4120);
    expect(face.eyeRadii.ry).toBeCloseTo(1, 9);
    face.update(4180);
    expect(face.eyeRadii.ry).toBeCloseTo(1 + (87.5 - 1) * 0.5, 9);
    face.update(4240);
    face.update(4241);
    expect(face.eyeRadii).toEqual({ rx: 87.5, ry: 87.5 });
  });

  it('schedules the next blink one random interval after each blink starts', () => {
    const picks = [0, 1 / 6, 0.99]; // 4000, 6000, 8000 ms
    let i = 0;
    const face = new ClassicFace({ random: () => picks[i++ % picks.length]! });
    face.startBlinking(0); // first blink at 4000
    const closedAt: number[] = [];
    let wasOpen = true;
    for (let t = 0; t <= 20000; t += 10) {
      face.update(t);
      const closed = face.eyeRadii.ry < 2;
      if (closed && wasOpen) closedAt.push(t);
      wasOpen = !closed;
    }
    // Blinks start at 4000, 10000 (+6000) and 18000 (+8000); eyes are fully shut 120 ms after each.
    expect(closedAt).toEqual([4120, 10120, 18120]);
  });

  it('transitions away to cover the screen and back, then resumes blinking', () => {
    const face = new ClassicFace({ random: () => 0 });
    face.startBlinking(0);
    let away = false;
    face.transitionAway(1000, () => (away = true));
    expect(face.isBlinking).toBe(false);
    face.update(1100);
    expect(away).toBe(true);
    expect(face.eyeRadii).toEqual({ rx: 1000, ry: 1000 });
    face.transitionBack(2000);
    face.update(2100);
    expect(face.eyeRadii).toEqual({ rx: 87.5, ry: 87.5 });
    expect(face.isBlinking).toBe(true);
  });
});
