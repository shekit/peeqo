import { legJoints, type ClearanceModel, type ClearanceReading, type LegJoints } from './clearance.ts';
import { DEFAULT_CLEARANCE } from './devKit.ts';
import { DEFAULT_GEOMETRY, type PlatformGeometry } from './geometry.ts';
import { shaftAxis, solveIk, type IkSolution, type Pose } from './kinematics.ts';
import {
  RAD_TO_DEG,
  SERVO_INDICES,
  dot,
  length,
  mapTriple,
  mulMat3Vec3,
  type ServoIndex,
  type Triple,
} from './math.ts';
import { DEFAULT_SAFETY_LIMITS, type SafetyLimits } from './limits.ts';

export type ViolationKind =
  | 'non-finite'
  | 'pose-range'
  | 'unreachable'
  | 'near-singular'
  | 'horn-range'
  | 'rod-end-tilt'
  | 'collision';

export interface Violation {
  readonly kind: ViolationKind;
  /** Servo the violation belongs to, or null for whole-pose problems. */
  readonly servo: ServoIndex | null;
  readonly value: number;
  readonly limit: number;
  /** For collisions: which parts. */
  readonly between?: string;
}

export interface PoseCheck {
  readonly ok: boolean;
  readonly ik: IkSolution;
  /** Horn angles in degrees (+ = tip up); NaN where a leg cannot reach. */
  readonly hornDeg: Triple;
  /**
   * How far each top rod end is tilted off its screw, degrees. The leg turns only about its pin (parallel to
   * its servo shaft), so the rod end's eye keeps that direction; the ball's screw is fixed to the platform and
   * turns with it. Turning about the screw is free; tilting off it is limited by the eye meeting the lugs.
   */
  readonly rodEndTiltDeg: Triple;
  /** Joint values of each leg (only when every leg can reach). */
  readonly joints: Triple<LegJoints> | null;
  /** Smallest guaranteed gap between any two parts, from the CAD collision tables (null if not checked). */
  readonly clearance: ClearanceReading | null;
  readonly violations: readonly Violation[];
}

/** Angle between two unit vectors, degrees (atan2 form, accurate for small angles). */
function angleBetweenDeg(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as const;
  return Math.atan2(length(cross), dot(a, b)) * RAD_TO_DEG;
}

/**
 * Decides whether a pose is safe to command. This is the single definition of "safe" used by the governor,
 * the envelope clamp and the simulator's display.
 */
export function checkPose(
  pose: Pose,
  geometry: PlatformGeometry = DEFAULT_GEOMETRY,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
  clearance: ClearanceModel | null = DEFAULT_CLEARANCE,
): PoseCheck {
  if (clearance && !clearance.fits(geometry)) {
    throw new Error('The collision tables were made for a different geometry; pass the matching tables or null.');
  }
  const violations: Violation[] = [];
  const finite = Number.isFinite(pose.pitchDeg) && Number.isFinite(pose.rollDeg) && Number.isFinite(pose.heaveMm);
  if (!finite) violations.push({ kind: 'non-finite', servo: null, value: Number.NaN, limit: 0 });

  if (Math.abs(pose.pitchDeg) > limits.maxAbsPitchDeg) {
    violations.push({ kind: 'pose-range', servo: null, value: pose.pitchDeg, limit: limits.maxAbsPitchDeg });
  }
  if (Math.abs(pose.rollDeg) > limits.maxAbsRollDeg) {
    violations.push({ kind: 'pose-range', servo: null, value: pose.rollDeg, limit: limits.maxAbsRollDeg });
  }
  if (pose.heaveMm < limits.minHeaveMm || pose.heaveMm > limits.maxHeaveMm) {
    const limit = pose.heaveMm < limits.minHeaveMm ? limits.minHeaveMm : limits.maxHeaveMm;
    violations.push({ kind: 'pose-range', servo: null, value: pose.heaveMm, limit });
  }

  const ik = solveIk(pose, geometry);
  const hornDeg = mapTriple(ik.legs, (leg) => leg.hornRad * RAD_TO_DEG);
  const rodEndTiltDeg = mapTriple(SERVO_INDICES, (servo) => {
    const eyeAxis = shaftAxis(servo, geometry);
    return angleBetweenDeg(eyeAxis, mulMat3Vec3(ik.rotation, eyeAxis));
  });

  for (const servo of SERVO_INDICES) {
    const leg = ik.legs[servo];
    if (!Number.isFinite(leg.hornRad)) {
      violations.push({ kind: 'unreachable', servo, value: leg.reachRatio, limit: 1 });
      continue;
    }
    if (Math.abs(leg.reachRatio) > limits.maxReachRatio) {
      violations.push({ kind: 'near-singular', servo, value: Math.abs(leg.reachRatio), limit: limits.maxReachRatio });
    }
    const horn = hornDeg[servo];
    const own = limits.hornRangesDeg?.[servo];
    const hornMin = own ? Math.max(limits.hornMinDeg, own[0]) : limits.hornMinDeg;
    const hornMax = own ? Math.min(limits.hornMaxDeg, own[1]) : limits.hornMaxDeg;
    if (horn < hornMin) violations.push({ kind: 'horn-range', servo, value: horn, limit: hornMin });
    if (horn > hornMax) violations.push({ kind: 'horn-range', servo, value: horn, limit: hornMax });
    if (rodEndTiltDeg[servo] > limits.maxRodEndTiltDeg) {
      violations.push({ kind: 'rod-end-tilt', servo, value: rodEndTiltDeg[servo], limit: limits.maxRodEndTiltDeg });
    }
  }

  let joints: Triple<LegJoints> | null = null;
  let reading: ClearanceReading | null = null;
  if (ik.reachable && finite) {
    joints = legJoints(ik, geometry);
    if (clearance) {
      reading = clearance.read(pose, joints);
      if (!(reading.minMm >= clearance.marginMm)) {
        violations.push({ kind: 'collision', servo: null, value: reading.minMm, limit: clearance.marginMm, between: reading.between });
      }
    }
  }

  return { ok: violations.length === 0, ik, hornDeg, rodEndTiltDeg, joints, clearance: reading, violations };
}

/** One short line naming what is wrong, grouped by kind (e.g. "leg can't reach (servos 1, 2)"). */
export function summarizeViolations(violations: readonly Violation[]): string {
  const labels: Record<ViolationKind, string> = {
    'non-finite': 'non-numeric values',
    'pose-range': 'beyond the pose limits',
    unreachable: "leg can't reach",
    'near-singular': 'horn and leg nearly in line',
    'horn-range': 'horn past its limit',
    'rod-end-tilt': 'rod end tilted too far',
    collision: 'parts too close',
  };
  const servosByKind = new Map<ViolationKind, Set<number>>();
  const collisions = [...new Set(violations.filter((v) => v.kind === 'collision').map((v) => v.between ?? 'unknown parts'))];
  for (const v of violations) {
    const set = servosByKind.get(v.kind) ?? new Set<number>();
    if (v.servo !== null) set.add(v.servo);
    servosByKind.set(v.kind, set);
  }
  return [...servosByKind]
    .map(([kind, servos]) => {
      const list = [...servos].sort();
      if (kind === 'collision') return `${labels[kind]} (${collisions.join('; ')})`;
      if (list.length === 0) return labels[kind];
      return `${labels[kind]} (servo${list.length > 1 ? 's' : ''} ${list.join(', ')})`;
    })
    .join('; ');
}

/** Human-readable detail of each violation, for logs. */
export function describeViolations(violations: readonly Violation[]): string[] {
  return violations.map((v) => {
    const who = v.servo === null ? 'pose' : `servo ${v.servo}`;
    switch (v.kind) {
      case 'non-finite':
        return 'pose has non-numeric values';
      case 'pose-range':
        return `pose value ${v.value.toFixed(1)} beyond ±${Math.abs(v.limit).toFixed(1)}`;
      case 'unreachable':
        return `${who}: leg cannot reach`;
      case 'near-singular':
        return `${who}: horn and leg nearly in line (${v.value.toFixed(3)} > ${v.limit})`;
      case 'horn-range':
        return `${who}: horn ${v.value.toFixed(1)}° outside ${v.limit.toFixed(1)}°`;
      case 'rod-end-tilt':
        return `${who}: rod end tilted ${v.value.toFixed(1)}° > ${v.limit}°`;
      case 'collision':
        return Number.isFinite(v.value)
          ? `${v.between}: ${v.value.toFixed(2)} mm apart, need ${v.limit} mm`
          : `${v.between ?? 'collision'}: not covered by the collision check`;
    }
  });
}
