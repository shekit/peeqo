import { checkPose } from './check.ts';
import { PEEQO_2019_GEOMETRY, type PlatformGeometry } from './geometry.ts';
import { HOME_POSE, type Pose } from './kinematics.ts';
import { DEFAULT_SAFETY_LIMITS, type SafetyLimits } from './limits.ts';

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    pitchDeg: a.pitchDeg + (b.pitchDeg - a.pitchDeg) * t,
    rollDeg: a.rollDeg + (b.rollDeg - a.rollDeg) * t,
    heaveMm: a.heaveMm + (b.heaveMm - a.heaveMm) * t,
  };
}

/**
 * The farthest safe pose on the straight line from home toward `target`. The line is checked at `samples`
 * evenly spaced points (so everything between home and the result is safe at that spacing) and the edge is
 * then refined by bisection. Throws if home itself is unsafe, since then nothing can be trusted.
 */
export function clampToSafe(
  target: Pose,
  geometry: PlatformGeometry = PEEQO_2019_GEOMETRY,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
  samples = 64,
): { pose: Pose; clamped: boolean } {
  const safe = (pose: Pose): boolean => checkPose(pose, geometry, limits).ok;
  if (!safe(HOME_POSE)) throw new Error('The home pose breaks the safety limits; fix the geometry or limits.');
  const finite = Number.isFinite(target.pitchDeg) && Number.isFinite(target.rollDeg) && Number.isFinite(target.heaveMm);
  if (!finite) return { pose: HOME_POSE, clamped: true };
  if (safe(target)) return { pose: target, clamped: false };

  let lo = 0;
  let hi = 1;
  for (let k = 1; k <= samples; k++) {
    const t = k / samples;
    if (!safe(lerpPose(HOME_POSE, target, t))) {
      hi = t;
      break;
    }
    lo = t;
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (safe(lerpPose(HOME_POSE, target, mid))) lo = mid;
    else hi = mid;
  }
  return { pose: lerpPose(HOME_POSE, target, lo), clamped: true };
}
