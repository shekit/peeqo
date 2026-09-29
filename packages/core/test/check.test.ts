import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFETY_LIMITS, HOME_POSE, checkPose, summarizeViolations } from '../src/index.ts';

describe('checkPose', () => {
  it('passes home with zero joint tilt', () => {
    const check = checkPose(HOME_POSE);
    expect(check.ok).toBe(true);
    for (const t of [...check.jointTiltDeg.lower, ...check.jointTiltDeg.upper]) expect(t).toBeCloseTo(0, 9);
  });

  it('names each problem once, with the servos involved', () => {
    const check = checkPose({ pitchDeg: 20, rollDeg: 0, heaveMm: 0 });
    expect(check.ok).toBe(false);
    expect(summarizeViolations(check.violations)).toBe(
      "leg can't reach (servo 0); horn and leg nearly in line (servos 1, 2); horn past its limit (servos 1, 2)",
    );
  });

  it('flags poses beyond the hard pose box and non-numeric poses', () => {
    expect(summarizeViolations(checkPose({ pitchDeg: 0, rollDeg: 0, heaveMm: DEFAULT_SAFETY_LIMITS.maxHeaveMm + 1 }).violations)).toContain(
      'beyond the pose limits',
    );
    expect(checkPose({ pitchDeg: Number.NaN, rollDeg: 0, heaveMm: 0 }).ok).toBe(false);
  });
});
