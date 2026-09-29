/**
 * Safety limits enforced by the motion governor. Everything the robot is asked to do (sliders, animations,
 * AI) passes through these; nothing drives the servos directly.
 */
export interface SafetyLimits {
  /** Horn angle range for every servo, degrees (+ = horn tip up). */
  readonly hornMinDeg: number;
  readonly hornMaxDeg: number;
  /** Largest allowed |reachRatio|. At 1 the horn and leg line up: a singular, high-force position. */
  readonly maxReachRatio: number;
  /** Largest ball-joint tilt out of the plane square to its stud, degrees. */
  readonly maxJointTiltDeg: number;
  /** Hard box on poses, checked before the geometry. */
  readonly maxAbsPitchDeg: number;
  readonly maxAbsRollDeg: number;
  readonly minHeaveMm: number;
  readonly maxHeaveMm: number;
  /** Speed and acceleration caps on the commanded pose (pitch and roll share the angular caps). */
  readonly maxAngularSpeedDegPerS: number;
  readonly maxAngularAccelDegPerS2: number;
  readonly maxHeaveSpeedMmPerS: number;
  readonly maxHeaveAccelMmPerS2: number;
  /** Fastest any servo may be asked to turn. */
  readonly maxServoSpeedDegPerS: number;
}

/**
 * Conservative defaults. The horn range, speeds and accelerations are set just above what the four 2019
 * servo animations (which ran on the real robot) use: across their 232 frames, horn angles of −22.5° to
 * +57.5°, 92°/s and 2,800°/s² of pitch/roll, 115 mm/s and 3,500 mm/s² of heave, and 545°/s at a servo
 * (checked in packages/core/test/legacy.test.ts). The reach-ratio and joint-tilt caps are generic mechanical
 * margins; inside this horn range the 2019 animations peak at 0.911 and 6.2°. Widen anything only after
 * checking clearances on the physical robot.
 */
export const DEFAULT_SAFETY_LIMITS: SafetyLimits = Object.freeze({
  hornMinDeg: -23,
  hornMaxDeg: 58,
  maxReachRatio: 0.95,
  maxJointTiltDeg: 30,
  maxAbsPitchDeg: 25,
  maxAbsRollDeg: 25,
  minHeaveMm: -20,
  maxHeaveMm: 20,
  maxAngularSpeedDegPerS: 120,
  maxAngularAccelDegPerS2: 4000,
  maxHeaveSpeedMmPerS: 150,
  maxHeaveAccelMmPerS2: 4500,
  // Roughly the no-load speed of a micro servo at 5 V (0.1 s per 60°).
  maxServoSpeedDegPerS: 600,
});
