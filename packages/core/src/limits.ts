import type { Triple } from './math.ts';

/**
 * Safety limits enforced by the motion governor. Everything the robot is asked to do (sliders, animations,
 * AI) passes through these; nothing drives the servos directly.
 */
export interface SafetyLimits {
  /** Horn angle range for every servo, degrees (+ = horn tip up). */
  readonly hornMinDeg: number;
  readonly hornMaxDeg: number;
  /**
   * Each servo's own range, degrees, servo order (optional): measured on the robot when it is calibrated. A horn
   * must be inside both this and the range above.
   */
  readonly hornRangesDeg?: Triple<readonly [number, number]>;
  /** Largest allowed |reachRatio|. At 1 the horn and leg line up: a singular, high-force position. */
  readonly maxReachRatio: number;
  /** Largest tilt of a top rod end off its screw, degrees (turning about the screw is free). */
  readonly maxRodEndTiltDeg: number;
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
 * Defaults for the dev kit. Collisions between parts are checked separately against the CAD (see
 * clearance.ts); these cover what the CAD cannot:
 * - Horn range: ±90° about the assembled position, the travel of a standard servo. The collision tables
 *   already keep each horn between about +1° (its U-horn meets the servo holder below that) and its upper
 *   reach; the real servo limits are set when the servos are calibrated.
 * - Reach ratio: keeps horn and leg away from lining up (a singular, high-force position).
 * - Rod ends: each eye is 3.3 mm thick between platform lugs 3.52 mm either side of the leg's centre plane,
 *   so it first touches a lug at 23.7° of tilt (re-measured by apps/sim/tools/build-model.mjs, which fails
 *   if this limit comes within 5° of it). The collision tables enforce the same contact with a 0.5 mm gap.
 * - Speeds: pose rates enough for the 2019 animations as designed (92°/s and 115 mm/s at most), and no servo
 *   faster than a micro servo's no-load speed.
 */
export const DEFAULT_SAFETY_LIMITS: SafetyLimits = Object.freeze({
  hornMinDeg: -90,
  hornMaxDeg: 90,
  maxReachRatio: 0.95,
  maxRodEndTiltDeg: 18,
  maxAbsPitchDeg: 25,
  maxAbsRollDeg: 25,
  minHeaveMm: -20,
  maxHeaveMm: 20,
  maxAngularSpeedDegPerS: 150,
  maxAngularAccelDegPerS2: 4500,
  maxHeaveSpeedMmPerS: 150,
  maxHeaveAccelMmPerS2: 4500,
  // Roughly the no-load speed of a hobby servo at 5 V (0.1 s per 60°).
  maxServoSpeedDegPerS: 600,
});
