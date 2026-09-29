import { PEEQO_2019_GEOMETRY, type PlatformGeometry } from './geometry.ts';
import {
  DEG_TO_RAD,
  SERVO_INDICES,
  add,
  dot,
  mapTriple,
  mulMat3Vec3,
  rotationZYX,
  solve3,
  sub,
  type Mat3,
  type ServoIndex,
  type Triple,
  type Vec3,
} from './math.ts';

/**
 * Head pose. Like the 2019 ServoSimulator, the platform only pitches, rolls and moves up and down;
 * sideways shift and yaw are held at zero.
 */
export interface Pose {
  /** Face up (+) or down (−), degrees. */
  readonly pitchDeg: number;
  /** Tilt about the forward axis, degrees. + tips Peeqo toward its own right (right side down). */
  readonly rollDeg: number;
  /** Up (+) or down (−) from the home height, millimetres. */
  readonly heaveMm: number;
}

export const HOME_POSE: Pose = Object.freeze({ pitchDeg: 0, rollDeg: 0, heaveMm: 0 });

export interface LegSolution {
  /** Horn angle in radians, + = horn tip up. NaN when this leg cannot reach. */
  readonly hornRad: number;
  /**
   * L / √(M² + N²) from the closed-form solution. The leg reaches only when |reachRatio| ≤ 1; at ±1 the
   * horn and leg line up, which is a singular (unstable, high-force) configuration.
   */
  readonly reachRatio: number;
  /** Where the servo shaft crosses the horn plane. */
  readonly shaft: Vec3;
  /** Horn tip = lower ball joint. NaN components when the leg cannot reach. */
  readonly hornTip: Vec3;
  /** Upper ball joint. */
  readonly platformJoint: Vec3;
}

export interface IkSolution {
  readonly legs: Triple<LegSolution>;
  /** Platform orientation (row-major). */
  readonly rotation: Mat3;
  /** Platform centre: the middle of the plane through the upper ball joints. */
  readonly position: Vec3;
  /** True when all three legs can reach. */
  readonly reachable: boolean;
}

export function platformTransform(
  pose: Pose,
  geometry: PlatformGeometry = PEEQO_2019_GEOMETRY,
): { rotation: Mat3; position: Vec3 } {
  // Positive rotation about +Y lowers the front (+X) edge, so looking up is a negative Y rotation.
  const rotation = rotationZYX(pose.rollDeg * DEG_TO_RAD, -pose.pitchDeg * DEG_TO_RAD, 0);
  return { rotation, position: [0, 0, geometry.homeHeightMm + pose.heaveMm] };
}

function unitAt(angleDeg: number): Vec3 {
  const a = angleDeg * DEG_TO_RAD;
  return [Math.cos(a), Math.sin(a), 0];
}

/** Servo shaft point for a servo, on the shaft plane (z = 0). */
export function shaftPoint(servo: ServoIndex, geometry: PlatformGeometry = PEEQO_2019_GEOMETRY): Vec3 {
  const u = unitAt(geometry.baseAnglesDeg[servo]);
  return [u[0] * geometry.baseRadiusMm, u[1] * geometry.baseRadiusMm, 0];
}

/** Upper ball joint of a leg in the platform's own frame. */
export function platformJointLocal(servo: ServoIndex, geometry: PlatformGeometry = PEEQO_2019_GEOMETRY): Vec3 {
  const u = unitAt(geometry.platformAnglesDeg[servo]);
  return [u[0] * geometry.platformRadiusMm, u[1] * geometry.platformRadiusMm, 0];
}

/** Unit vector along a servo's shaft: square to its horn's plane. */
export function shaftAxis(servo: ServoIndex, geometry: PlatformGeometry = PEEQO_2019_GEOMETRY): Vec3 {
  const b = geometry.hornAnglesDeg[servo] * DEG_TO_RAD;
  return [-Math.sin(b), Math.cos(b), 0];
}

/** Horn tip position for a given horn angle (radians). */
export function hornTipPoint(servo: ServoIndex, hornRad: number, geometry: PlatformGeometry = PEEQO_2019_GEOMETRY): Vec3 {
  const shaft = shaftPoint(servo, geometry);
  const b = geometry.hornAnglesDeg[servo] * DEG_TO_RAD;
  const a = geometry.hornLengthMm;
  return [
    a * Math.cos(hornRad) * Math.cos(b) + shaft[0],
    a * Math.cos(hornRad) * Math.sin(b) + shaft[1],
    a * Math.sin(hornRad) + shaft[2],
  ];
}

/** Inverse kinematics: horn angles that put the platform at `pose`. Same closed form as Platform.pde (calcAlpha). */
export function solveIk(pose: Pose, geometry: PlatformGeometry = PEEQO_2019_GEOMETRY): IkSolution {
  const { rotation, position } = platformTransform(pose, geometry);
  const legs = mapTriple(SERVO_INDICES, (servo): LegSolution => {
    const shaft = shaftPoint(servo, geometry);
    const platformJoint = add(mulMat3Vec3(rotation, platformJointLocal(servo, geometry)), position);
    const leg = sub(platformJoint, shaft);
    const a = geometry.hornLengthMm;
    const s = geometry.legLengthMm;
    const b = geometry.hornAnglesDeg[servo] * DEG_TO_RAD;
    const L = dot(leg, leg) - (s * s - a * a);
    const M = 2 * a * leg[2];
    const N = 2 * a * (Math.cos(b) * leg[0] + Math.sin(b) * leg[1]);
    const denominator = Math.hypot(M, N);
    const reachRatio = denominator > 0 ? L / denominator : Number.POSITIVE_INFINITY;
    const hornRad = Math.abs(reachRatio) <= 1 ? Math.asin(reachRatio) - Math.atan2(N, M) : Number.NaN;
    const hornTip: Vec3 = Number.isFinite(hornRad)
      ? hornTipPoint(servo, hornRad, geometry)
      : [Number.NaN, Number.NaN, Number.NaN];
    return { hornRad, reachRatio, shaft, hornTip, platformJoint };
  });
  const reachable = legs.every((leg) => Number.isFinite(leg.hornRad));
  return { legs, rotation, position, reachable };
}

export interface FkOptions {
  /** Starting guess; defaults to home. */
  readonly initial?: Pose;
  /** Largest allowed horn-angle error, radians. */
  readonly toleranceRad?: number;
  readonly maxIterations?: number;
}

/**
 * Forward kinematics: the pose whose inverse kinematics gives these horn angles (radians, servo order),
 * found by damped Newton iteration. Returns null if no reachable pose matches.
 */
export function solveFk(
  hornRad: Triple,
  geometry: PlatformGeometry = PEEQO_2019_GEOMETRY,
  options: FkOptions = {},
): Pose | null {
  if (!hornRad.every(Number.isFinite)) return null;
  const tolerance = options.toleranceRad ?? 1e-10;
  const maxIterations = options.maxIterations ?? 60;

  const toPose = (u: Vec3): Pose => ({ pitchDeg: u[0], rollDeg: u[1], heaveMm: u[2] });
  const residual = (u: Vec3): Vec3 | null => {
    const ik = solveIk(toPose(u), geometry);
    if (!ik.reachable) return null;
    return [ik.legs[0].hornRad - hornRad[0], ik.legs[1].hornRad - hornRad[1], ik.legs[2].hornRad - hornRad[2]];
  };
  const size = (r: Vec3): number => Math.max(Math.abs(r[0]), Math.abs(r[1]), Math.abs(r[2]));

  const start = options.initial ?? { pitchDeg: 0, rollDeg: 0, heaveMm: 0 };
  let u: Vec3 = [start.pitchDeg, start.rollDeg, start.heaveMm];
  let r = residual(u);
  if (r === null) {
    u = [0, 0, 0];
    r = residual(u);
    if (r === null) return null;
  }

  const h = 1e-5;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (size(r) < tolerance) return toPose(u);

    // Numerical Jacobian, one column per unknown (central differences, one-sided at the reach limit).
    const columns: Vec3[] = [];
    for (const k of SERVO_INDICES) {
      const plus: Vec3 = [u[0] + (k === 0 ? h : 0), u[1] + (k === 1 ? h : 0), u[2] + (k === 2 ? h : 0)];
      const minus: Vec3 = [u[0] - (k === 0 ? h : 0), u[1] - (k === 1 ? h : 0), u[2] - (k === 2 ? h : 0)];
      const rp = residual(plus);
      const rm = residual(minus);
      if (rp && rm) columns.push([(rp[0] - rm[0]) / (2 * h), (rp[1] - rm[1]) / (2 * h), (rp[2] - rm[2]) / (2 * h)]);
      else if (rp) columns.push([(rp[0] - r[0]) / h, (rp[1] - r[1]) / h, (rp[2] - r[2]) / h]);
      else if (rm) columns.push([(r[0] - rm[0]) / h, (r[1] - rm[1]) / h, (r[2] - rm[2]) / h]);
      else return null;
    }
    const [c0, c1, c2] = columns as [Vec3, Vec3, Vec3];
    const jacobian: Mat3 = [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
    const step = solve3(jacobian, [-r[0], -r[1], -r[2]]);
    if (step === null) return null;

    // Backtracking line search: accept the first step length that lowers the error.
    let accepted = false;
    for (let lambda = 1; lambda > 1e-6; lambda /= 2) {
      const candidate: Vec3 = [u[0] + lambda * step[0], u[1] + lambda * step[1], u[2] + lambda * step[2]];
      const rc = residual(candidate);
      if (rc !== null && size(rc) < size(r)) {
        u = candidate;
        r = rc;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  return size(r) < tolerance ? toPose(u) : null;
}
