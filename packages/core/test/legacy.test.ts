import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_LIMITS,
  HOME_POSE,
  LEGACY_FRAME_MS,
  checkPose,
  legacyAnimationToPoses,
  legacyHornDegToPulse,
  legacyPulseToHornDeg,
  parseLegacyAnimation,
  servoToChannelOrder,
  solveIk,
  type Pose,
} from '../src/index.ts';

const animationsDir = fileURLToPath(new URL('../../../electron/app/media/servo_anims/', import.meta.url));
const animations = Object.fromEntries(
  readdirSync(animationsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const frames = parseLegacyAnimation(JSON.parse(readFileSync(animationsDir + f, 'utf8')), f);
      return [f.replace(/\.json$/, ''), { frames, poses: legacyAnimationToPoses(frames, undefined, f) }];
    }),
);

const range = (poses: Pose[], key: keyof Pose) => [
  Math.min(...poses.map((p) => p[key])),
  Math.max(...poses.map((p) => p[key])),
];

describe('2019 servo animations', () => {
  it('are all present', () => {
    expect(Object.keys(animations).sort()).toEqual(['alert', 'jiggle', 'look-up', 'look-up-slow']);
  });

  it('home matches the recorded neutral pulse of 1518 µs', () => {
    const homeHornDeg = (solveIk(HOME_POSE).legs[0].hornRad * 180) / Math.PI;
    expect(legacyHornDegToPulse(homeHornDeg)).toBe(1518);
    expect(legacyPulseToHornDeg(1518)).toBe(0.5);
  });

  it('decode to poses that re-encode to exactly the recorded pulses', () => {
    let frames = 0;
    for (const [name, { frames: recorded, poses }] of Object.entries(animations)) {
      poses.forEach((pose, i) => {
        const hornDeg = checkPose(pose).hornDeg;
        const pulses = servoToChannelOrder([
          legacyHornDegToPulse(hornDeg[0]),
          legacyHornDegToPulse(hornDeg[1]),
          legacyHornDegToPulse(hornDeg[2]),
        ]);
        expect(pulses, `${name} frame ${i}`).toEqual(recorded[i]);
        frames++;
      });
    }
    expect(frames).toBe(232);
  });

  it('move the way their names say (confirms channel mapping and face direction)', () => {
    const lookUp = animations['look-up']!.poses;
    const [, maxPitch] = range(lookUp, 'pitchDeg');
    expect(maxPitch).toBeGreaterThan(6.5);
    expect(Math.max(...lookUp.map((p) => Math.abs(p.rollDeg)))).toBeLessThan(0.01);

    const jiggle = animations.jiggle!.poses;
    const [minRoll, maxRoll] = range(jiggle, 'rollDeg');
    expect(minRoll).toBeLessThan(-3.5);
    expect(maxRoll).toBeGreaterThan(2.5);
    expect(Math.max(...jiggle.map((p) => Math.abs(p.pitchDeg)))).toBeLessThan(0.1);

    const alert = animations.alert!.poses;
    const [, maxHeave] = range(alert, 'heaveMm');
    expect(maxHeave).toBeGreaterThan(7);
    expect(Math.max(...alert.map((p) => Math.abs(p.pitchDeg) + Math.abs(p.rollDeg)))).toBeLessThan(0.01);
  });

  it('stay inside the default safety limits, with the margins documented in limits.ts', () => {
    const all = Object.values(animations).flatMap((a) => a.poses);
    let hornMin = Infinity;
    let hornMax = -Infinity;
    let reach = 0;
    let tilt = 0;
    for (const pose of all) {
      const check = checkPose(pose);
      expect(check.ok, JSON.stringify(check.violations)).toBe(true);
      hornMin = Math.min(hornMin, ...check.hornDeg);
      hornMax = Math.max(hornMax, ...check.hornDeg);
      reach = Math.max(reach, ...check.ik.legs.map((l) => Math.abs(l.reachRatio)));
      tilt = Math.max(tilt, ...check.jointTiltDeg.lower, ...check.jointTiltDeg.upper);
    }
    expect(hornMin).toBeCloseTo(-22.5, 6);
    expect(hornMax).toBeCloseTo(57.5, 6);
    expect(hornMin).toBeGreaterThanOrEqual(DEFAULT_SAFETY_LIMITS.hornMinDeg);
    expect(hornMax).toBeLessThanOrEqual(DEFAULT_SAFETY_LIMITS.hornMaxDeg);
    expect(reach).toBeLessThan(0.92);
    expect(tilt).toBeLessThan(6.5);
  });

  it('move no faster than the default speed caps', () => {
    const dt = LEGACY_FRAME_MS / 1000;
    let angular = 0;
    let heave = 0;
    let servo = 0;
    for (const { poses } of Object.values(animations)) {
      for (let i = 1; i < poses.length; i++) {
        const a = poses[i - 1]!;
        const b = poses[i]!;
        angular = Math.max(angular, Math.abs(b.pitchDeg - a.pitchDeg) / dt, Math.abs(b.rollDeg - a.rollDeg) / dt);
        heave = Math.max(heave, Math.abs(b.heaveMm - a.heaveMm) / dt);
        const ha = checkPose(a).hornDeg;
        const hb = checkPose(b).hornDeg;
        for (const s of [0, 1, 2] as const) servo = Math.max(servo, Math.abs(hb[s] - ha[s]) / dt);
      }
    }
    expect(angular).toBeLessThan(DEFAULT_SAFETY_LIMITS.maxAngularSpeedDegPerS);
    expect(heave).toBeLessThan(DEFAULT_SAFETY_LIMITS.maxHeaveSpeedMmPerS);
    expect(servo).toBeLessThan(DEFAULT_SAFETY_LIMITS.maxServoSpeedDegPerS);
  });

  it('rejects malformed animation files', () => {
    expect(() => parseLegacyAnimation([])).toThrow();
    expect(() => parseLegacyAnimation([[1500, 1500]])).toThrow();
    expect(() => parseLegacyAnimation([[1500, 1500, 9999]])).toThrow();
    expect(() => parseLegacyAnimation([[1500, 'x', 1500]])).toThrow();
  });
});
