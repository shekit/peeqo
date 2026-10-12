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

/** A stand-in 2D context that records what is drawn (and the words written) and fails on bad numbers. */
function recordingContext() {
  const calls: string[] = [];
  const texts: { text: string; x: number; y: number }[] = [];
  const check = (name: string, args: unknown[]) => {
    for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${name} got ${a}`);
    calls.push(name);
    if (name === 'fillText') texts.push({ text: String(args[0]), x: Number(args[1]), y: Number(args[2]) });
  };
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'calls'
          ? calls
          : prop === 'texts'
            ? texts
            : prop === 'measureText'
              ? (text: string) => ({ width: text.length * 26 }) // about right for bold 46 px type
              : (...args: unknown[]) => check(String(prop), args),
      set: () => true,
    },
  ) as CanvasRenderingContext2D & { calls: string[]; texts: { text: string; x: number; y: number }[] };
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

  it('captions media along its bottom, keeping it up until the words are read', () => {
    const face = new ExpressiveFace({ seed: 7 });
    let now = run(face, 0, 0.2);
    const media = { source: {} as CanvasImageSource, width: 640, height: 414 };
    face.showMedia(media, now, 1000);
    now = run(face, now, 0.3);
    const gone = face.showCaption('  Eighteen   degrees and sunny! ', now, 3000); // longer than the media had left
    expect(face.mediaEndMs()).toBe(now + 3000 + 280);
    expect(face.mediaEndMs(media.source)).toBe(now + 3000 + 280);
    expect(face.mediaEndMs({} as CanvasImageSource)).toBe(0); // not what is showing
    expect(gone).toBe(now + 3000 + 280);
    now = run(face, now, 0.5);
    expect(face.caption).toBe('Eighteen degrees and sunny!');
    const ctx = recordingContext();
    face.draw(ctx);
    expect(ctx.calls).toContain('strokeText'); // outlined, meme style
    expect(ctx.texts.map((t) => t.text).join(' ')).toBe('Eighteen degrees and sunny!');
    expect(Math.min(...ctx.texts.map((t) => t.y))).toBeGreaterThan(FACE_HEIGHT / 2);
    now = run(face, now, 2.4); // past the media's own end: both still up
    expect(face.showingMedia && face.caption !== null).toBe(true);
    run(face, now, 0.5);
    expect(face.showingMedia || face.caption !== null).toBe(false);
  });

  it('captions the face above the eyes when nothing else is showing, fitting long words onto the screen', () => {
    const face = new ExpressiveFace({ seed: 3 });
    let now = run(face, 0, 0.2);
    face.showCaption('It is 9:41 PM', now, 1500);
    now = run(face, now, 0.4);
    let ctx = recordingContext();
    face.draw(ctx);
    expect(ctx.calls).not.toContain('strokeText');
    const top = ctx.texts.map((t) => t.y);
    expect(Math.max(...top)).toBeLessThan(ExpressiveFace.EYE_Y - ExpressiveFace.EYE_RADIUS - 40);
    // Far too long: shrunk, wrapped and cut with an ellipsis, every line inside the screen.
    face.showCaption('supercalifragilisticexpialidocious '.repeat(8), now, 1500);
    now = run(face, now, 0.4);
    ctx = recordingContext();
    face.draw(ctx);
    expect(ctx.texts.length).toBeLessThanOrEqual(3);
    expect(ctx.texts.at(-1)!.text.endsWith('…')).toBe(true);
    for (const t of ctx.texts) expect(t.text.length * 26).toBeLessThanOrEqual(FACE_WIDTH - 80);
    face.hideCaption(now, 'something else'); // not what is showing: stays
    now = run(face, now, 0.4);
    expect(face.caption).not.toBeNull();
    face.hideCaption(now);
    run(face, now, 0.4);
    expect(face.caption).toBeNull();
    expect(() => face.showCaption('   ', now, 1000)).toThrow(/words/);
  });

  it('rejects unknown emotions', () => {
    expect(() => new ExpressiveFace().setEmotion('smug' as Emotion)).toThrow(/Unknown emotion/);
  });

  it('skips drawing a picture identical to the last one, and draws every one that moves', () => {
    const face = new ExpressiveFace({ seed: 4 });
    const ctx = recordingContext();
    face.setBlinking(false);
    let now = run(face, 0, 3); // settled, between glances
    expect(face.drawIfChanged(ctx)).toBe(true);
    face.update(now); // no time has passed: the same picture
    expect(face.drawIfChanged(ctx)).toBe(false);
    // Over a few seconds of glances and small eye movements, it draws whenever something moved, and only then.
    let drawn = 0;
    let skipped = 0;
    now = run(face, now, 4, () => (face.drawIfChanged(ctx) ? drawn++ : skipped++));
    expect(drawn).toBeGreaterThan(20);
    expect(skipped).toBeGreaterThan(20);
    // A blink is always drawn; a caption too.
    face.setBlinking(true);
    face.blink(now);
    face.update(now + 40);
    expect(face.drawIfChanged(ctx)).toBe(true);
    face.showCaption('Hello!', now + 40, 2000);
    face.update(now + 300);
    expect(face.drawIfChanged(ctx)).toBe(true);
  });
});
