import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFETY_LIMITS, HOME_POSE, checkPose, summarizeViolations } from '../src/index.ts';

describe('checkPose', () => {
  it('reads the rod ends untilted at the assembled pose, and refuses it only for its U-horn clearance', () => {
    // Horns level and legs vertical, as assembled: the U-horns sit 0.38 mm above their holders there.
    const check = checkPose(HOME_POSE);
    for (const t of check.rodEndTiltDeg) expect(t).toBeCloseTo(0, 9);
    expect(check.violations.map((v) => v.kind)).toEqual(['collision']);
  });

  it('tilts each rod end by the platform rotation seen across its screw', () => {
    // Rotating by θ about axis k tilts a screw along unit v by α with cos α = cos θ + (1 − cos θ)(v·k)².
    const alpha = (thetaDeg: number, vk2: number) => {
      const c = Math.cos((thetaDeg * Math.PI) / 180);
      return (Math.acos(c + (1 - c) * vk2) * 180) / Math.PI;
    };
    // Pitch turns about Y: the front screw lies along Y (free), the rear screws are 30° off X.
    const pitch = checkPose({ pitchDeg: 6, rollDeg: 0, heaveMm: 0 }).rodEndTiltDeg;
    expect(pitch[0]).toBeCloseTo(0, 9);
    expect(pitch[1]).toBeCloseTo(alpha(6, 0.25), 9);
    expect(pitch[2]).toBeCloseTo(alpha(6, 0.25), 9);
    // Roll turns about X: square to the front screw, and 60° from each rear screw.
    const roll = checkPose({ pitchDeg: 0, rollDeg: 4, heaveMm: 0 }).rodEndTiltDeg;
    expect(roll[0]).toBeCloseTo(4, 9);
    expect(roll[1]).toBeCloseTo(alpha(4, 0.75), 9);
    expect(roll[2]).toBeCloseTo(alpha(4, 0.75), 9);
  });

  it('names each problem once, with the servos or parts involved', () => {
    const check = checkPose({ pitchDeg: 20, rollDeg: 0, heaveMm: 3 });
    expect(check.ok).toBe(false);
    const summary = summarizeViolations(check.violations);
    expect(summary).toMatch(/leg can't reach \(servo \d/);
    expect(summary.split('; ').length).toBe(new Set(summary.split('; ')).size);
  });

  it('flags poses beyond the hard pose box and non-numeric poses', () => {
    expect(summarizeViolations(checkPose({ pitchDeg: 0, rollDeg: 0, heaveMm: DEFAULT_SAFETY_LIMITS.maxHeaveMm + 1 }).violations)).toContain(
      'beyond the pose limits',
    );
    expect(checkPose({ pitchDeg: Number.NaN, rollDeg: 0, heaveMm: 0 }).ok).toBe(false);
  });
});
