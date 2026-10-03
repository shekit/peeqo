import { describe, expect, it } from 'vitest';
import { EMOTIONS, ExpressiveFace, FACE_HEIGHT, FACE_WIDTH, type Emotion } from '../src/index.ts';

/** Runs the face for `seconds` at 60 fps, calling `each` after every update. */
function run(face: ExpressiveFace, fromMs: number, seconds: number, each?: (nowMs: number) => void): number {
  let now = fromMs;
  for (let i = 0; i < seconds * 60; i++) {
    now += 1000 / 60;
    face.update(now);
    each?.(now);
  }
  return now;
}

/** A stand-in 2D context that records what is drawn and fails on bad numbers. */
function recordingContext() {
  const calls: string[] = [];
  const check = (name: string, args: unknown[]) => {
    for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${name} got ${a}`);
    calls.push(name);
  };
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => (prop === 'calls' ? calls : (...args: unknown[]) => check(String(prop), args)),
      set: () => true,
    },
  ) as CanvasRenderingContext2D & { calls: string[] };
  return ctx;
}

const settle = (emotion: Emotion, seed = 1) => {
  const face = new ExpressiveFace({ seed });
  face.setBlinking(false);
  face.setEmotion(emotion);
  run(face, 0, 1.5);
  return face.state();
};

describe('ExpressiveFace', () => {
  it('shapes each emotion as intended', () => {
    const neutral = settle('neutral');
    expect(neutral.eyes[0]!.rx).toBeCloseTo(ExpressiveFace.EYE_RADIUS, 0);
    expect(settle('surprised').eyes[0]!.rx).toBeGreaterThan(neutral.eyes[0]!.rx * 1.15);
    expect(settle('scared').eyes[0]!.rx).toBeLessThan(neutral.eyes[0]!.rx * 0.85);
    const wink = settle('wink');
    expect(wink.eyes[1]!.ry).toBeLessThan(1);
    expect(wink.eyes[0]!.ry).toBeGreaterThan(70);
    const curious = settle('curious');
    expect(curious.eyes[0]!.rx).toBeGreaterThan(curious.eyes[1]!.rx * 1.1);
  });

  it('looks where each emotion looks: down when sad, up and away when thinking', () => {
    const meanGaze = (emotion: Emotion) => {
      const face = new ExpressiveFace({ seed: 4 });
      face.setEmotion(emotion);
      let x = 0;
      let y = 0;
      let n = 0;
      run(face, 0, 20, () => {
        const g = face.state().gaze;
        x += g[0];
        y += g[1];
        n++;
      });
      return [x / n, y / n];
    };
    expect(meanGaze('sad')[1]).toBeGreaterThan(0.25);
    const thinking = meanGaze('thinking');
    expect(thinking[0]).toBeLessThan(-0.35);
    expect(thinking[1]).toBeLessThan(-0.35);
  });

  it('blinks at a natural rate, sometimes twice, and not at all when told not to', () => {
    const countBlinks = (face: ExpressiveFace, seconds: number) => {
      let blinks = 0;
      let shut = false;
      run(face, 0, seconds, () => {
        const nowShut = face.state().blink < 0.2;
        if (nowShut && !shut) blinks++;
        shut = nowShut;
      });
      return blinks;
    };
    const perMinute = countBlinks(new ExpressiveFace({ seed: 2 }), 60);
    expect(perMinute).toBeGreaterThanOrEqual(8);
    expect(perMinute).toBeLessThanOrEqual(35);
    const still = new ExpressiveFace({ seed: 2 });
    still.setBlinking(false);
    expect(countBlinks(still, 30)).toBe(0);
  });

  it('keeps the eyes on the screen and the gaze in range, whatever the emotion', () => {
    for (const emotion of EMOTIONS) {
      const face = new ExpressiveFace({ seed: 3 });
      face.setEmotion(emotion);
      run(face, 0, 8, () => {
        const s = face.state();
        expect(Math.abs(s.gaze[0])).toBeLessThanOrEqual(1.05);
        expect(Math.abs(s.gaze[1])).toBeLessThanOrEqual(1.05);
        s.eyes.forEach((eye, i) => {
          const x = ExpressiveFace.EYE_X[i as 0 | 1] + s.gaze[0] * 38;
          expect(x - eye.rx).toBeGreaterThan(0);
          expect(x + eye.rx).toBeLessThan(FACE_WIDTH);
          expect(ExpressiveFace.EYE_Y + eye.ry).toBeLessThan(FACE_HEIGHT + 40);
        });
      });
    }
  });

  it('looks where it is told, then wanders again when released', () => {
    const face = new ExpressiveFace({ seed: 5 });
    face.lookAt([0.8, -0.5]);
    run(face, 0, 0.6);
    const g = face.state().gaze;
    expect(g[0]).toBeCloseTo(0.8, 1);
    expect(g[1]).toBeCloseTo(-0.5, 1);
    face.lookAt(null);
    let moved = 0;
    run(face, 600, 10, () => {
      moved = Math.max(moved, Math.abs(face.state().gaze[0] - 0.8));
    });
    expect(moved).toBeGreaterThan(0.3);
  });

  it('draws every emotion, mid-blink too, with finite numbers only', () => {
    for (const emotion of EMOTIONS) {
      const face = new ExpressiveFace({ seed: 6 });
      face.setEmotion(emotion);
      let now = run(face, 0, 0.3);
      for (const extra of [0, 40, 90, 160]) {
        face.blink(now);
        now = run(face, now, extra / 1000 + 0.02);
        const ctx = recordingContext();
        face.draw(ctx);
        expect(ctx.calls.length, emotion).toBeGreaterThan(3);
      }
    }
  });

  it('replays exactly with the same seed', () => {
    const trace = (seed: number) => {
      const face = new ExpressiveFace({ seed });
      const out: number[] = [];
      run(face, 0, 5, () => out.push(face.state().gaze[0], face.state().blink));
      return out;
    };
    expect(trace(9)).toEqual(trace(9));
    expect(trace(9)).not.toEqual(trace(10));
  });

  it('shows media in place of the eyes, fading in and out', () => {
    const face = new ExpressiveFace({ seed: 7 });
    let now = run(face, 0, 0.2);
    const media = { source: {} as CanvasImageSource, width: 640, height: 414 };
    face.showMedia(media, now, 1000);
    expect(face.showingMedia).toBe(false); // starts fading in from the next update
    now = run(face, now, 0.5);
    expect(face.showingMedia).toBe(true);
    const ctx = recordingContext();
    face.draw(ctx);
    expect(ctx.calls).toContain('drawImage');
    now = run(face, now, 0.85);
    expect(face.showingMedia).toBe(false);
    face.showMedia(media, now, 5000);
    now = run(face, now, 0.3);
    face.hideMedia(now);
    run(face, now, 0.35);
    expect(face.showingMedia).toBe(false);
    expect(() => face.showMedia({ ...media, width: 0 }, now, 100)).toThrow(/size/);
  });

  it('rejects unknown emotions', () => {
    expect(() => new ExpressiveFace().setEmotion('smug' as Emotion)).toThrow(/Unknown emotion/);
  });
});
