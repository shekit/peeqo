import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_LIMITS,
  HOME_POSE,
  SERVO_SIMULATOR_2019_GEOMETRY,
  LEGACY_FRAME_MS,
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

  it('home in the 2019 sketch matches the recorded neutral pulse of 1518 µs', () => {
    const homeHornDeg = (solveIk(HOME_POSE, SERVO_SIMULATOR_2019_GEOMETRY).legs[0].hornRad * 180) / Math.PI;
    expect(legacyHornDegToPulse(homeHornDeg)).toBe(1518);
    expect(legacyPulseToHornDeg(1518)).toBe(0.5);
  });

  it('decode to poses that re-encode to exactly the recorded pulses', () => {
    let frames = 0;
    for (const [name, { frames: recorded, poses }] of Object.entries(animations)) {
      poses.forEach((pose, i) => {
        const legs = solveIk(pose, SERVO_SIMULATOR_2019_GEOMETRY).legs;
        const deg = (rad: number) => (rad * 180) / Math.PI;
        const pulses = servoToChannelOrder([
          legacyHornDegToPulse(deg(legs[0].hornRad)),
          legacyHornDegToPulse(deg(legs[1].hornRad)),
          legacyHornDegToPulse(deg(legs[2].hornRad)),
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
    expect(maxPitch).toBeCloseTo(7.01, 2);
    expect(Math.max(...lookUp.map((p) => Math.abs(p.rollDeg)))).toBeLessThan(0.01);

    const jiggle = animations.jiggle!.poses;
    const [minRoll, maxRoll] = range(jiggle, 'rollDeg');
    expect(minRoll).toBeCloseTo(-4.03, 2);
    expect(maxRoll).toBeCloseTo(3.04, 2);
    expect(Math.max(...jiggle.map((p) => Math.abs(p.pitchDeg)))).toBeLessThan(0.1);

    const alert = animations.alert!.poses;
    const [, maxHeave] = range(alert, 'heaveMm');
    expect(maxHeave).toBeCloseTo(7.19, 2);
    expect(Math.max(...alert.map((p) => Math.abs(p.pitchDeg) + Math.abs(p.rollDeg)))).toBeLessThan(0.01);
  });

  it('use horn angles of −22.5° to +57.5° in the 2019 sketch', () => {
    // The 2019 pulses only mean something on the sketch's geometry; on the dev kit they are replayed as poses.
    const all = Object.values(animations).flatMap((a) => a.poses);
    const horns = all.flatMap((pose) => solveIk(pose, SERVO_SIMULATOR_2019_GEOMETRY).legs.map((l) => (l.hornRad * 180) / Math.PI));
    expect(Math.min(...horns)).toBeCloseTo(-22.5, 6);
    expect(Math.max(...horns)).toBeCloseTo(57.5, 6);
  });

  it('move no faster than the default pose speed caps', () => {
    const dt = LEGACY_FRAME_MS / 1000;
    let angular = 0;
    let heave = 0;
    for (const { poses } of Object.values(animations)) {
      for (let i = 1; i < poses.length; i++) {
        const a = poses[i - 1]!;
        const b = poses[i]!;
        angular = Math.max(angular, Math.abs(b.pitchDeg - a.pitchDeg) / dt, Math.abs(b.rollDeg - a.rollDeg) / dt);
        heave = Math.max(heave, Math.abs(b.heaveMm - a.heaveMm) / dt);
      }
    }
    expect(angular).toBeLessThan(DEFAULT_SAFETY_LIMITS.maxAngularSpeedDegPerS);
    expect(heave).toBeLessThan(DEFAULT_SAFETY_LIMITS.maxHeaveSpeedMmPerS);
  });

  it('rejects malformed animation files', () => {
    expect(() => parseLegacyAnimation([])).toThrow();
    expect(() => parseLegacyAnimation([[1500, 1500]])).toThrow();
    expect(() => parseLegacyAnimation([[1500, 1500, 9999]])).toThrow();
    expect(() => parseLegacyAnimation([[1500, 'x', 1500]])).toThrow();
  });
});
