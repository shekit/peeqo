import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLEARANCE,
  DEFAULT_SAFETY_LIMITS,
  HEAD_ANIMATIONS,
  HEAD_ANIMATION_NAMES,
  HeadAnimator,
  MonotoneCurve,
  MotionGovernor,
  SecondOrder,
  checkPose,
  gestureSize,
  type Pose,
} from '../src/index.ts';

const neutral = new MotionGovernor().neutral;
const DT = 0.01;
const offsetPose = (o: readonly number[], k = 1): Pose => ({
  pitchDeg: neutral.pitchDeg + k * o[0]!,
  rollDeg: neutral.rollDeg + k * o[1]!,
  heaveMm: neutral.heaveMm + k * o[2]!,
});

describe('SecondOrder', () => {
  const stepResponse = (zeta: number) => {
    const s = new SecondOrder(2, zeta, 0, [0]);
    let peak = 0;
    let last = 0;
    for (let t = 0; t < 6; t += 0.001) {
      last = s.update(0.001, [1])[0]!;
      peak = Math.max(peak, last);
    }
    return { peak, last };
  };

  it('settles on its target without overshoot when critically damped', () => {
    const { peak, last } = stepResponse(1);
    expect(peak).toBeLessThanOrEqual(1 + 1e-6);
    expect(last).toBeCloseTo(1, 6);
  });

  it('overshoots as theory predicts when underdamped, then settles', () => {
    const { peak, last } = stepResponse(0.6);
    // exp(−πζ/√(1−ζ²)) = 9.5% for ζ = 0.6.
    expect(peak - 1).toBeCloseTo(Math.exp((-Math.PI * 0.6) / Math.sqrt(1 - 0.36)), 2);
    expect(last).toBeCloseTo(1, 6);
  });

  it('stays stable with a time step far longer than its period', () => {
    const s = new SecondOrder(10, 0.5, 0, [0]);
    for (let i = 0; i < 100; i++) s.update(0.2, [1]);
    expect(s.value[0]).toBeCloseTo(1, 3);
  });
});

describe('MonotoneCurve', () => {
  const times = [0, 0.3, 0.5, 1.0, 1.2, 2.0];
  const values = [0, 3, 2.5, -1, -1, 0];
  const curve = new MonotoneCurve(times, values);

  it('passes through every key', () => {
    times.forEach((t, i) => expect(curve.at(t)).toBeCloseTo(values[i]!, 12));
  });

  it('never overshoots its neighbouring keys', () => {
    for (let i = 0; i < times.length - 1; i++) {
      const lo = Math.min(values[i]!, values[i + 1]!);
      const hi = Math.max(values[i]!, values[i + 1]!);
      for (let t = times[i]!; t <= times[i + 1]!; t += 0.001) {
        const v = curve.at(t);
        expect(v).toBeGreaterThanOrEqual(lo - 1e-12);
        expect(v).toBeLessThanOrEqual(hi + 1e-12);
      }
    }
  });

  it('starts and ends at rest, and moves without kinks', () => {
    const slope = (t: number) => (curve.at(t + 1e-6) - curve.at(t - 1e-6)) / 2e-6;
    expect(Math.abs(curve.at(1e-6) - values[0]!) / 1e-6).toBeLessThan(1e-3);
    expect(Math.abs(curve.at(2 - 1e-6) - values[5]!) / 1e-6).toBeLessThan(1e-3);
    for (const t of times.slice(1, -1)) expect(Math.abs(slope(t + 1e-4) - slope(t - 1e-4))).toBeLessThan(0.05);
  });

  it('rejects keys out of time order', () => {
    expect(() => new MonotoneCurve([0, 1, 1], [0, 1, 2])).toThrow(/increasing time/);
  });
});

describe('head gestures', () => {
  it('are all distinct, described, and start and end at neutral', () => {
    expect(new Set(HEAD_ANIMATION_NAMES).size).toBe(HEAD_ANIMATION_NAMES.length);
    expect(HEAD_ANIMATION_NAMES.length).toBeGreaterThanOrEqual(15);
    for (const clip of HEAD_ANIMATIONS.values()) {
      expect(clip.description.length, clip.name).toBeGreaterThan(10);
      expect(clip.at(0)).toEqual([0, 0, 0]);
      expect(clip.at(clip.duration)).toEqual([0, 0, 0]);
      expect(clip.duration, clip.name).toBeGreaterThan(0.8);
      expect(clip.duration, clip.name).toBeLessThan(3.6);
    }
  });

  it('move visibly', () => {
    for (const clip of HEAD_ANIMATIONS.values()) {
      let tilt = 0;
      let heave = 0;
      for (let t = 0; t <= clip.duration; t += 0.005) {
        const o = clip.at(t);
        tilt = Math.max(tilt, Math.hypot(o[0], o[1]));
        heave = Math.max(heave, Math.abs(o[2]));
      }
      expect(tilt >= 2 || heave >= 1, `${clip.name}: ${tilt.toFixed(2)}° / ${heave.toFixed(2)} mm`).toBe(true);
    }
  });

  it('leave at least 30% of the neck’s room to spare at every frame', () => {
    for (const clip of HEAD_ANIMATIONS.values()) {
      for (let t = 0; t <= clip.duration; t += 0.01) {
        const pose = offsetPose(clip.at(t), 1.3);
        expect(checkPose(pose).ok, `${clip.name} at ${t.toFixed(2)} s, scaled 1.3: ${JSON.stringify(pose)}`).toBe(true);
      }
    }
  });
});

describe('HeadAnimator', () => {
  /** Runs an animator into a governor; returns the worst status and largest lag behind the targets. */
  function drive(animator: HeadAnimator, seconds: number, governor = new MotionGovernor()) {
    let worst = 'ok';
    let lag = 0;
    for (let t = 0; t < seconds; t += DT) {
      const target = animator.update(DT);
      expect(checkPose(target).ok, JSON.stringify(target)).toBe(true);
      governor.setTarget(target);
      const out = governor.step(DT);
      if (out.status !== 'ok' && worst === 'ok') worst = `${out.status} at ${t.toFixed(2)} s: ${out.notes.join('; ')}`;
      lag = Math.max(lag, Math.abs(out.pose.pitchDeg - target.pitchDeg), Math.abs(out.pose.rollDeg - target.rollDeg), Math.abs(out.pose.heaveMm - target.heaveMm));
    }
    return { worst, lag, governor };
  }

  it('plays every gesture, with idle and variation, without the governor ever holding it back', () => {
    for (const name of HEAD_ANIMATION_NAMES) {
      const clip = HEAD_ANIMATIONS.get(name)!;
      for (const seed of [1, 2, 3, 4]) {
        for (const speed of [1, 1.5]) {
          const animator = new HeadAnimator(neutral, { seed });
          const warm = drive(animator, 1.5);
          animator.play(name, { speed });
          expect(animator.playing).toBe(name);
          const { worst, lag } = drive(animator, clip.duration / (speed * 0.94) + 1, warm.governor);
          expect(worst, `${name} seed ${seed} speed ${speed}`).toBe('ok');
          expect(lag, `${name} seed ${seed} speed ${speed}`).toBeLessThan(0.15);
          expect(animator.playing).toBeNull();
        }
      }
    }
  });

  it('never needs holding back when one gesture interrupts another, at any point', () => {
    for (const first of HEAD_ANIMATION_NAMES) {
      for (const second of HEAD_ANIMATION_NAMES) {
        for (const after of [0.15, 0.45]) {
          const animator = new HeadAnimator(neutral, { seed: 2 });
          const { governor } = drive(animator, 0.5);
          animator.play(first);
          const one = drive(animator, after, governor);
          animator.play(second);
          const two = drive(animator, HEAD_ANIMATIONS.get(second)!.duration / 0.94 + 0.5, governor);
          expect([one.worst, two.worst], `${first} interrupted by ${second} after ${after} s`).toEqual(['ok', 'ok']);
        }
      }
    }
  }, 120_000);

  it('keeps every servo well under its speed cap', () => {
    for (const name of HEAD_ANIMATION_NAMES) {
      const animator = new HeadAnimator(neutral, { seed: 9, idle: false });
      const governor = new MotionGovernor();
      animator.play(name, { speed: 1.5 });
      let previous = governor.output.hornDeg;
      for (let t = 0; t < 3; t += DT) {
        governor.setTarget(animator.update(DT));
        const out = governor.step(DT);
        for (const s of [0, 1, 2] as const) {
          expect(Math.abs(out.hornDeg[s] - previous[s]) / DT, name).toBeLessThan(DEFAULT_SAFETY_LIMITS.maxServoSpeedDegPerS * 0.7);
        }
        previous = out.hornDeg;
      }
    }
  });

  it('idles safely: breathing and glancing at full energy, nearly still at none', () => {
    for (const [energy, minTilt, maxTilt] of [
      [1, 0.8, 3],
      [0, 0, 0.3],
    ] as const) {
      const animator = new HeadAnimator(neutral, { seed: 5 });
      animator.setEnergy(energy);
      let tilt = 0;
      let heave = 0;
      const governor = new MotionGovernor();
      for (let t = 0; t < 60; t += DT) {
        const p = animator.update(DT);
        governor.setTarget(p);
        expect(governor.step(DT).status).toBe('ok');
        if (t > 8) {
          tilt = Math.max(tilt, Math.hypot(p.pitchDeg - neutral.pitchDeg, p.rollDeg - neutral.rollDeg));
          heave = Math.max(heave, Math.abs(p.heaveMm - neutral.heaveMm));
        }
      }
      expect(tilt, `energy ${energy}`).toBeGreaterThanOrEqual(minTilt);
      expect(tilt, `energy ${energy}`).toBeLessThanOrEqual(maxTilt);
      expect(heave, `energy ${energy}`).toBeLessThan(1);
    }
  });

  it('holds exactly at neutral with idle off and nothing playing', () => {
    const animator = new HeadAnimator(neutral, { idle: false });
    for (let i = 0; i < 100; i++) expect(animator.update(DT)).toEqual(neutral);
  });

  it('hands over smoothly when a gesture is interrupted or stopped', () => {
    /** Per-step change of the target (velocity) and its change (acceleration), under a script of commands. */
    const run = (script: (a: HeadAnimator, step: number) => void) => {
      const a = new HeadAnimator(neutral, { seed: 3, idle: false });
      const poses = [a.update(DT)];
      for (let i = 1; i < 400; i++) {
        script(a, i);
        poses.push(a.update(DT));
      }
      const v = poses.slice(1).map((p, i) => [p.pitchDeg - poses[i]!.pitchDeg, p.rollDeg - poses[i]!.rollDeg, p.heaveMm - poses[i]!.heaveMm]);
      const accel = v.slice(1).map((d, i) => Math.hypot(d[0]! - v[i]![0]!, d[1]! - v[i]![1]!, d[2]! - v[i]![2]!));
      return { accel, last: poses[poses.length - 1]!, animator: a };
    };
    // How sharply the gestures themselves change speed, played uninterrupted.
    const own = Math.max(...['look-up', 'shake'].flatMap((name) => run((a, i) => i === 1 && a.play(name as 'look-up')).accel));
    // Interrupt look-up with shake, then stop shake midway: neither moment may jolt more than the gestures do.
    const cut = run((a, i) => {
      if (i === 1) a.play('look-up');
      if (i === 51) a.play('shake');
      if (i === 91) a.stop();
    });
    for (const at of [51, 91]) expect(Math.max(...cut.accel.slice(at - 2, at + 12)), `at step ${at}`).toBeLessThanOrEqual(own);
    expect(cut.animator.playing).toBeNull();
    expect(Math.abs(cut.last.pitchDeg - neutral.pitchDeg) + Math.abs(cut.last.rollDeg - neutral.rollDeg)).toBeLessThan(0.02);
  });

  it('picks up from wherever the head was put', () => {
    const animator = new HeadAnimator(neutral, { idle: false });
    const elsewhere = { pitchDeg: neutral.pitchDeg + 3, rollDeg: neutral.rollDeg - 2, heaveMm: neutral.heaveMm + 0.5 };
    animator.resetFrom(elsewhere);
    const first = animator.update(DT);
    expect(Math.abs(first.pitchDeg - elsewhere.pitchDeg)).toBeLessThan(0.05);
    for (let i = 0; i < 300; i++) animator.update(DT);
    expect(animator.pose.pitchDeg).toBeCloseTo(neutral.pitchDeg, 3);
  });

  it('replays exactly with the same seed, and varies with another', () => {
    const run = (seed: number) => {
      const a = new HeadAnimator(neutral, { seed });
      a.play('nod');
      return Array.from({ length: 150 }, () => a.update(DT).pitchDeg);
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  it('sizes gestures to the neck’s room: as written for the CAD’s, bigger with more, and scaled exactly', () => {
    // Written using about three quarters of the CAD's room: a tenth spare is a little bigger than written.
    const cad = gestureSize(neutral, DEFAULT_SAFETY_LIMITS, undefined, DEFAULT_CLEARANCE);
    expect(cad).toBeGreaterThanOrEqual(1.05);
    expect(cad).toBeLessThanOrEqual(1.3);
    // Without the CAD's collision tables, around its home pose (arms level), there is more than twice the room, and
    // at that size every gesture still keeps a tenth of it spare.
    const home: Pose = { pitchDeg: 0, rollDeg: 0, heaveMm: 0 };
    const size = gestureSize(home, DEFAULT_SAFETY_LIMITS);
    expect(size).toBeGreaterThan(2.2);
    for (const name of HEAD_ANIMATION_NAMES) {
      const clip = HEAD_ANIMATIONS.get(name)!;
      for (let t = 0; t <= clip.duration; t += 0.01) {
        const o = clip.at(t).map((v) => v * size * 1.1);
        expect(checkPose({ pitchDeg: o[0]!, rollDeg: o[1]!, heaveMm: o[2]! }, undefined, DEFAULT_SAFETY_LIMITS, null).ok, `${name} at ${t}`).toBe(true);
      }
    }
    // setSize scales a gesture exactly (the spring is linear), and is capped.
    const peak = (s: number) => {
      const a = new HeadAnimator(neutral, { seed: 3, idle: false });
      a.setSize(s);
      a.play('nod');
      let p = a.update(DT);
      for (let i = 0; i < 40; i++) p = a.update(DT);
      return p;
    };
    const [one, two] = [peak(1), peak(2)];
    expect(Math.abs(one.pitchDeg - neutral.pitchDeg)).toBeGreaterThan(0.5);
    expect(two.pitchDeg - neutral.pitchDeg).toBeCloseTo(2 * (one.pitchDeg - neutral.pitchDeg), 9);
    expect(two.heaveMm - neutral.heaveMm).toBeCloseTo(2 * (one.heaveMm - neutral.heaveMm), 9);
    const capped = new HeadAnimator(neutral);
    capped.setSize(100);
    expect(capped.size).toBe(4);
  });

  it('caps intensity and speed to what the gestures were designed for', () => {
    const big = new HeadAnimator(neutral, { seed: 1, idle: false });
    big.play('look-up', { intensity: 5, speed: 9 });
    const governor = new MotionGovernor();
    for (let t = 0; t < 3; t += DT) {
      governor.setTarget(big.update(DT));
      expect(governor.step(DT).status).toBe('ok');
    }
    expect(() => new HeadAnimator(neutral).play('moonwalk' as never)).toThrow(/Unknown head animation/);
  });
});
