import { PEEQO_2019_GEOMETRY, type PlatformGeometry } from './geometry.ts';
import { shaftAxis, solveIk, type IkSolution, type Pose } from './kinematics.ts';
import {
  RAD_TO_DEG,
  SERVO_INDICES,
  dot,
  length,
  mapTriple,
  mulMat3Vec3,
  sub,
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
  | 'joint-tilt';

export interface Violation {
  readonly kind: ViolationKind;
  /** Servo the violation belongs to, or null for whole-pose problems. */
  readonly servo: ServoIndex | null;
  readonly value: number;
  readonly limit: number;
}

export interface PoseCheck {
  readonly ok: boolean;
  readonly ik: IkSolution;
  /** Horn angles in degrees (+ = tip up); NaN where a leg cannot reach. */
  readonly hornDeg: Triple;
  /** Ball-joint tilt out of the plane square to its stud, degrees: lower = horn end, upper = platform end. */
  readonly jointTiltDeg: { readonly lower: Triple; readonly upper: Triple };
  readonly violations: readonly Violation[];
}

function tiltDeg(legDirection: readonly [number, number, number], studAxis: readonly [number, number, number]): number {
  const len = length(legDirection);
  if (!(len > 0)) return Number.NaN;
  return Math.asin(Math.min(1, Math.abs(dot(legDirection, studAxis)) / len)) * RAD_TO_DEG;
}

/**
 * Decides whether a pose is safe to command. This is the single definition of "safe" used by the governor,
 * the envelope clamp and the simulator's display.
 */
export function checkPose(
  pose: Pose,
  geometry: PlatformGeometry = PEEQO_2019_GEOMETRY,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
): PoseCheck {
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
  const lower = mapTriple(SERVO_INDICES, (servo) => {
    const leg = ik.legs[servo];
    return tiltDeg(sub(leg.platformJoint, leg.hornTip), shaftAxis(servo, geometry));
  });
  const upper = mapTriple(SERVO_INDICES, (servo) => {
    const leg = ik.legs[servo];
    // Assumes each upper stud is fitted parallel to its servo's shaft when the platform is level.
    const stud = mulMat3Vec3(ik.rotation, shaftAxis(servo, geometry));
    return tiltDeg(sub(leg.platformJoint, leg.hornTip), stud);
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
    if (horn < limits.hornMinDeg) violations.push({ kind: 'horn-range', servo, value: horn, limit: limits.hornMinDeg });
    if (horn > limits.hornMaxDeg) violations.push({ kind: 'horn-range', servo, value: horn, limit: limits.hornMaxDeg });
    const worstTilt = Math.max(lower[servo], upper[servo]);
    if (worstTilt > limits.maxJointTiltDeg) {
      violations.push({ kind: 'joint-tilt', servo, value: worstTilt, limit: limits.maxJointTiltDeg });
    }
  }

  return { ok: violations.length === 0, ik, hornDeg, jointTiltDeg: { lower, upper }, violations };
}

/** One short line naming what is wrong, grouped by kind (e.g. "leg can't reach (servos 1, 2)"). */
export function summarizeViolations(violations: readonly Violation[]): string {
  const labels: Record<ViolationKind, string> = {
    'non-finite': 'non-numeric values',
    'pose-range': 'beyond the pose limits',
    unreachable: "leg can't reach",
    'near-singular': 'horn and leg nearly in line',
    'horn-range': 'horn past its limit',
    'joint-tilt': 'ball joint tilted too far',
  };
  const servosByKind = new Map<ViolationKind, Set<number>>();
  for (const v of violations) {
    const set = servosByKind.get(v.kind) ?? new Set<number>();
    if (v.servo !== null) set.add(v.servo);
    servosByKind.set(v.kind, set);
  }
  return [...servosByKind]
    .map(([kind, servos]) => {
      const list = [...servos].sort();
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
      case 'joint-tilt':
        return `${who}: ball joint tilted ${v.value.toFixed(1)}° > ${v.limit}°`;
    }
  });
}
