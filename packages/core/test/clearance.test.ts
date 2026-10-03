import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_LIMITS,
  DEV_KIT_CLEARANCE,
  DEV_KIT_GEOMETRY,
  HOME_POSE,
  MotionGovernor,
  SERVO_SIMULATOR_2019_GEOMETRY,
  checkPose,
  legJoints,
  solveIk,
} from '../src/index.ts';

describe('dev kit collision tables', () => {
  it('belong to the dev kit geometry and refuse any other', () => {
    expect(DEV_KIT_CLEARANCE.fits(DEV_KIT_GEOMETRY)).toBe(true);
    expect(DEV_KIT_CLEARANCE.fits(SERVO_SIMULATOR_2019_GEOMETRY)).toBe(false);
    expect(() => checkPose(HOME_POSE, SERVO_SIMULATOR_2019_GEOMETRY, DEFAULT_SAFETY_LIMITS, DEV_KIT_CLEARANCE)).toThrow(/different geometry/);
    expect(DEV_KIT_CLEARANCE.marginMm).toBe(0.5);
  });

  it('were made from the current robot model', () => {
    const glb = readFileSync(fileURLToPath(new URL('../../../apps/sim/src/assets/peeqo-devkit.glb', import.meta.url)));
    expect(createHash('sha256').update(glb).digest('hex').slice(0, 16), 'model changed: run npm run build:clearance -w @peeqo/sim').toBe(
      DEV_KIT_CLEARANCE.modelSha256,
    );
  });

  it('read zero joint angles at the assembled pose (horns level, legs vertical)', () => {
    for (const j of legJoints(solveIk(HOME_POSE, DEV_KIT_GEOMETRY), DEV_KIT_GEOMETRY)) {
      expect(j.hornDeg).toBeCloseTo(0, 9);
      expect(j.legDeg).toBeCloseTo(0, 9);
      expect(j.rodSwingDeg).toBeCloseTo(0, 9);
      expect(j.rodTiltDeg).toBeCloseTo(0, 9);
      expect(j.rodTwistDeg).toBeCloseTo(0, 9);
    }
  });

  it('see the U-horns resting just above their holders at the assembled pose', () => {
    // The CAD gap there is 0.38 mm: below the 0.5 mm margin, so the assembled pose is not commandable.
    const reading = checkPose(HOME_POSE).clearance!;
    expect(reading.minMm).toBeLessThan(0.5);
    expect(reading.minMm).toBeGreaterThan(0.2);
    expect(reading.between).toMatch(/horn \d and the base/);
  });

  it('treat anything outside the checked range as unsafe', () => {
    const far = checkPose({ pitchDeg: 0, rollDeg: 0, heaveMm: 15 });
    expect(far.ok).toBe(false);
    const lifted = checkPose({ pitchDeg: 0, rollDeg: 0, heaveMm: 6.9 });
    expect(lifted.ok).toBe(false);
  });

  it('leave the neutral pose with every part at least the margin apart', () => {
    const neutral = new MotionGovernor().neutral;
    const reading = checkPose(neutral).clearance!;
    expect(reading.minMm).toBeGreaterThanOrEqual(DEV_KIT_CLEARANCE.marginMm);
  });

  it('record the pairs verified over everything the tables admit, each at least the margin', () => {
    const verified = Object.values(DEV_KIT_CLEARANCE.verifiedMm);
    expect(verified.length).toBeGreaterThan(10);
    for (const mm of verified) expect(mm).toBeGreaterThanOrEqual(DEV_KIT_CLEARANCE.marginMm);
  });
});
