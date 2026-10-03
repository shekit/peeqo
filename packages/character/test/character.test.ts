import { describe, expect, it } from 'vitest';
import {
  DotstarStrip,
  HEAD_ANIMATIONS,
  HeadAnimator,
  LED_PATTERN_NAMES,
  LedAnimator,
  MotionGovernor,
  checkPose,
  isLedColorName,
} from '@peeqo/core';
import { EMOTIONS, ExpressiveFace } from '@peeqo/face';
import {
  CHARACTER_STATES,
  Character,
  EXPRESSION_NAMES,
  Life,
  SOUND_NAMES,
  SOUND_SAMPLE_RATE,
  expressionSpec,
  renderSound,
  type ExpressionName,
  type SoundName,
} from '../src/index.ts';

const neutral = new MotionGovernor().neutral;

function build(seed = 1) {
  const head = new HeadAnimator(neutral, { seed });
  const face = new ExpressiveFace({ seed });
  const leds = new LedAnimator(new DotstarStrip(12), { seed });
  const played: SoundName[] = [];
  const character = new Character({ head, face, leds, sound: { play: (name) => played.push(name) } });
  return { head, face, leds, played, character };
}

/** Runs everything for `seconds` at 100 Hz (head into the governor), from `fromMs`. */
function run(parts: ReturnType<typeof build>, fromMs: number, seconds: number, governor?: MotionGovernor, each?: () => void): number {
  let now = fromMs;
  for (let i = 0; i < Math.round(seconds * 100); i++) {
    now += 10;
    parts.character.update(now);
    const target = parts.head.update(0.01);
    parts.face.update(now);
    parts.leds.update(now);
    if (governor) {
      governor.setTarget(target);
      governor.step(0.01);
    }
    each?.();
  }
  return now;
}

describe('sounds', () => {
  it('render cleanly: no clipping, no clicks, sensible lengths', () => {
    for (const name of SOUND_NAMES) {
      const samples = renderSound(name);
      const seconds = samples.length / SOUND_SAMPLE_RATE;
      expect(seconds, name).toBeGreaterThan(0.02);
      expect(seconds, name).toBeLessThan(1.5);
      let peak = 0;
      for (const v of samples) {
        expect(Number.isFinite(v), name).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak, name).toBeGreaterThan(0.69);
      expect(peak, name).toBeLessThanOrEqual(0.7 + 1e-6);
      // Fades in and out, so nothing clicks.
      expect(Math.abs(samples[0]!), name).toBeLessThan(0.02);
      expect(Math.abs(samples[samples.length - 1]!), name).toBeLessThan(0.02);
    }
  });
});

describe('expressions', () => {
  it('only use real emotions, gestures, LED patterns, colours and sounds, in time order', () => {
    expect(EXPRESSION_NAMES.length).toBeGreaterThanOrEqual(20);
    for (const name of EXPRESSION_NAMES) {
      const spec = expressionSpec(name);
      expect(spec.description.length, name).toBeGreaterThan(15);
      expect(spec.duration, name).toBeGreaterThanOrEqual(1);
      expect(spec.duration, name).toBeLessThanOrEqual(4);
      let last = 0;
      for (const step of spec.steps) {
        expect(step.at, name).toBeGreaterThanOrEqual(last);
        expect(step.at, name).toBeLessThan(spec.duration);
        last = step.at;
        if (step.face) expect(EMOTIONS, name).toContain(step.face);
        if (step.head) expect(HEAD_ANIMATIONS.has(step.head), name).toBe(true);
        if (step.leds) expect(LED_PATTERN_NAMES, name).toContain(step.leds);
        if (step.ledColor) expect(isLedColorName(step.ledColor), name).toBe(true);
        if (step.sound) expect(SOUND_NAMES, name).toContain(step.sound);
      }
    }
  });
});

describe('Character', () => {
  it('performs an expression in time, then returns to its state', () => {
    const parts = build();
    const { character, face, leds, head, played } = parts;
    let now = run(parts, 0, 0.5);
    character.express('surprised');
    expect(face.emotion).toBe('surprised');
    expect(head.playing).toBe('startle');
    expect(leds.pattern).toBe('wake');
    expect(played).toEqual(['whoa']);
    now = run(parts, now, 1.5);
    expect(face.emotion).toBe('curious');
    expect(character.expression).toBe('surprised');
    now = run(parts, now, 1.3);
    expect(character.expression).toBeNull();
    expect(face.emotion).toBe('neutral');
    expect(leds.pattern).toBe('off');
  });

  it('sets the look of each state and greets it with a gesture', () => {
    const parts = build();
    const { character, face, leds, head, played } = parts;
    run(parts, 0, 0.2);
    character.setState('listening');
    expect([face.emotion, leds.pattern, head.playing, head.energy]).toEqual(['listening', 'listen', 'listen', 0.45]);
    character.setState('sleeping');
    expect([face.emotion, leds.pattern, head.energy]).toEqual(['asleep', 'breathe', 0]);
    expect(played).toContain('yawn');
    expect(() => character.setState('dancing' as never)).toThrow(/Unknown state/);
    expect(CHARACTER_STATES).toContain('speaking');
  });

  it('returns to the state it is in when the expression ends, even if that changed meanwhile', () => {
    const parts = build();
    const { character, face, leds } = parts;
    character.setState('thinking');
    let now = run(parts, 0, 0.5);
    character.express('yes');
    character.setState('speaking'); // e.g. the reply arrives mid-expression
    expect(face.emotion).toBe('happy'); // still the expression's face
    now = run(parts, now, 2);
    expect(face.emotion).toBe('happy'); // speaking's resting face (a light smile)
    expect(leds.pattern).toBe('speak');
    character.express('sad');
    character.stop();
    expect(face.emotion).toBe('happy');
    expect(leds.pattern).toBe('speak');
    run(parts, now, 0.1);
  });

  it('scales an expression by intensity', () => {
    const parts = build();
    parts.character.express('happy', { intensity: 0.4 });
    expect(parts.face.state().intensity).toBeCloseTo(0.4, 9);
  });

  it('keeps the head safe through every expression, from every state', () => {
    for (const state of ['idle', 'listening', 'speaking'] as const) {
      for (const name of EXPRESSION_NAMES) {
        for (const seed of [1, 2]) {
          const parts = build(seed);
          const governor = new MotionGovernor();
          parts.character.setState(state);
          let now = run(parts, 0, 1, governor);
          parts.character.express(name as ExpressionName);
          let worst = 'ok';
          now = run(parts, now, expressionSpec(name).duration + 1, governor, () => {
            const out = governor.output;
            if (out.status !== 'ok' && worst === 'ok') worst = `${out.status}: ${out.notes.join('; ')}`;
            expect(checkPose(out.pose).ok).toBe(true);
          });
          expect(worst, `${name} from ${state}, seed ${seed}`).toBe('ok');
        }
      }
    }
  });

  it('rejects unknown expressions', () => {
    expect(() => build().character.express('moonwalk' as ExpressionName)).toThrow(/Unknown expression/);
  });
});

describe('Life', () => {
  it('falls asleep after a quiet spell, and wakes with a start when someone comes by', () => {
    const parts = build();
    const life = new Life(parts.character, { sleepAfterMs: 10_000, everyMs: [1e9, 1e9] });
    let now = 0;
    for (; now < 9_000; now += 100) life.update(now);
    expect(parts.character.state).toBe('idle');
    for (; now < 11_000; now += 100) life.update(now);
    expect(parts.character.state).toBe('sleeping');
    expect(parts.face.emotion).toBe('asleep');
    life.poke(now);
    expect(parts.character.state).toBe('idle');
    expect(parts.character.expression).toBe('surprised');
  });

  it('does little things on its own while idle, drifting toward boredom', () => {
    const parts = build();
    const life = new Life(parts.character, { sleepAfterMs: 1e9, everyMs: [5_000, 5_000], seed: 3 });
    const seen: { at: number; name: string }[] = [];
    for (let now = 0; now < 240_000; now += 50) {
      parts.character.update(now);
      life.update(now);
      const name = parts.character.expression;
      if (name && seen.at(-1)?.name !== name) seen.push({ at: now, name });
      if (!name && seen.at(-1)?.name !== '-') seen.push({ at: now, name: '-' });
    }
    const played = seen.filter((s) => s.name !== '-');
    expect(played.length).toBeGreaterThan(30);
    expect(played.filter((p) => p.at < 30_000).every((p) => ['curious', 'wonder', 'happy'].includes(p.name))).toBe(true);
    expect(played.some((p) => p.name === 'sleepy' || p.name === 'sigh')).toBe(true);
  });

  it('never interrupts listening, thinking or speaking, and can be switched off', () => {
    const parts = build();
    const life = new Life(parts.character, { sleepAfterMs: 1_000, everyMs: [100, 100] });
    parts.character.setState('speaking');
    for (let now = 0; now < 20_000; now += 50) life.update(now);
    expect(parts.character.state).toBe('speaking');
    expect(parts.character.expression).toBeNull();
    parts.character.setState('idle');
    life.enabled = false;
    for (let now = 20_000; now < 40_000; now += 50) life.update(now);
    expect(parts.character.state).toBe('idle');
    expect(parts.character.expression).toBeNull();
  });
});
