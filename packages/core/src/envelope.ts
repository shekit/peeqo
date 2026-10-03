import { checkPose } from './check.ts';
import type { ClearanceModel } from './clearance.ts';
import { DEFAULT_CLEARANCE } from './devKit.ts';
import { DEFAULT_GEOMETRY, type PlatformGeometry } from './geometry.ts';
import type { Pose } from './kinematics.ts';
import { DEFAULT_SAFETY_LIMITS, type SafetyLimits } from './limits.ts';

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    pitchDeg: a.pitchDeg + (b.pitchDeg - a.pitchDeg) * t,
    rollDeg: a.rollDeg + (b.rollDeg - a.rollDeg) * t,
    heaveMm: a.heaveMm + (b.heaveMm - a.heaveMm) * t,
  };
}

/**
 * The farthest safe pose on the straight line from `centre` (a safe pose, normally the neutral pose) toward
 * `target`. The line is checked at `samples` evenly spaced points (so everything between the centre and the
 * result is safe at that spacing) and the edge is then refined by bisection. Throws if the centre is unsafe.
 */
export function clampToSafe(
  target: Pose,
  centre: Pose,
  geometry: PlatformGeometry = DEFAULT_GEOMETRY,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
  clearance: ClearanceModel | null = DEFAULT_CLEARANCE,
  samples = 64,
): { pose: Pose; clamped: boolean } {
  const safe = (pose: Pose): boolean => checkPose(pose, geometry, limits, clearance).ok;
  if (!safe(centre)) throw new Error('The centre pose breaks the safety limits; nothing can be clamped toward it.');
  const finite = Number.isFinite(target.pitchDeg) && Number.isFinite(target.rollDeg) && Number.isFinite(target.heaveMm);
  if (!finite) return { pose: centre, clamped: true };
  if (safe(target)) return { pose: target, clamped: false };

  let lo = 0;
  let hi = 1;
  for (let k = 1; k <= samples; k++) {
    const t = k / samples;
    if (!safe(lerpPose(centre, target, t))) {
      hi = t;
      break;
    }
    lo = t;
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (safe(lerpPose(centre, target, mid))) lo = mid;
    else hi = mid;
  }
  return { pose: lerpPose(centre, target, lo), clamped: true };
}

/**
 * The neutral pose: level, at the height that leaves the most room to move. For each candidate height the
 * reach is measured along ±pitch and ±roll; the height whose smallest reach is largest wins (lowest on ties).
 * Returns null if no level pose is safe.
 */
export function findNeutralPose(
  geometry: PlatformGeometry = DEFAULT_GEOMETRY,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
  clearance: ClearanceModel | null = DEFAULT_CLEARANCE,
  stepMm = 0.1,
): Pose | null {
  const safe = (pose: Pose): boolean => checkPose(pose, geometry, limits, clearance).ok;
  const reachAlong = (centre: Pose, toward: Pose): number => {
    let lo = 0;
    let hi = 1;
    if (safe(toward)) return 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (safe(lerpPose(centre, toward, mid))) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  let best: { pose: Pose; score: number } | null = null;
  for (let heave = limits.minHeaveMm; heave <= limits.maxHeaveMm + 1e-9; heave += stepMm) {
    const centre: Pose = { pitchDeg: 0, rollDeg: 0, heaveMm: Math.round(heave * 1000) / 1000 };
    if (!safe(centre)) continue;
    const span = 20;
    const score = Math.min(
      reachAlong(centre, { ...centre, pitchDeg: span }),
      reachAlong(centre, { ...centre, pitchDeg: -span }),
      reachAlong(centre, { ...centre, rollDeg: span }),
      reachAlong(centre, { ...centre, rollDeg: -span }),
    );
    if (!best || score > best.score + 1e-9) best = { pose: centre, score };
  }
  return best?.pose ?? null;
}
