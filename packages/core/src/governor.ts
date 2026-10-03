import { checkPose, describeViolations, summarizeViolations, type PoseCheck } from './check.ts';
import type { ClearanceModel } from './clearance.ts';
import { DEFAULT_CLEARANCE } from './devKit.ts';
import { clampToSafe, findNeutralPose, lerpPose } from './envelope.ts';
import { DEFAULT_GEOMETRY, type PlatformGeometry } from './geometry.ts';
import type { Pose } from './kinematics.ts';
import { DEFAULT_SAFETY_LIMITS, type SafetyLimits } from './limits.ts';
import type { Triple } from './math.ts';

export type GovernorStatus = 'ok' | 'limited' | 'blocked';

/** Rates of change of a pose: degrees per second for pitch and roll, millimetres per second for heave. */
export interface PoseRates {
  readonly pitchDegPerS: number;
  readonly rollDegPerS: number;
  readonly heaveMmPerS: number;
}

export interface GovernorOutput {
  /** The latest target, as asked for. */
  readonly requested: Pose;
  /** Where the governor is heading: the request, pulled back toward the neutral pose if it was unsafe. */
  readonly goal: Pose;
  /** The pose commanded this tick. Always passes checkPose. */
  readonly pose: Pose;
  readonly rates: PoseRates;
  /** Horn angles for `pose`, degrees, servo order. */
  readonly hornDeg: Triple;
  readonly status: GovernorStatus;
  /** Why the status is not 'ok'. */
  readonly notes: readonly string[];
}

/** Longest time step integrated at once; longer gaps (a stalled loop) are treated as this. */
export const MAX_GOVERNOR_STEP_S = 0.05;

const asArray = (p: Pose): [number, number, number] => [p.pitchDeg, p.rollDeg, p.heaveMm];
const asPose = (v: readonly [number, number, number]): Pose => ({ pitchDeg: v[0], rollDeg: v[1], heaveMm: v[2] });
const isFinitePose = (p: Pose): boolean =>
  Number.isFinite(p.pitchDeg) && Number.isFinite(p.rollDeg) && Number.isFinite(p.heaveMm);
const isAt = (a: readonly number[], b: readonly number[]): boolean => a.every((v, j) => Math.abs(v - b[j]!) < 1e-9);

/**
 * The only path to the servos. Targets from anywhere are clamped to the safe range, then followed in straight
 * lines with speed and acceleration limits, and every commanded pose is re-checked before it is used. The safe
 * range is not convex, so a straight line between two safe poses can cross an unsafe pocket: when that blocks
 * the way, the governor goes round by the neutral pose (every goal is reached in a straight line from there).
 * Call step() at a fixed rate; each call returns the pose and horn angles to send.
 */
export class MotionGovernor {
  readonly geometry: PlatformGeometry;
  readonly limits: SafetyLimits;
  readonly clearance: ClearanceModel | null;
  /** Where the governor starts, and the pose unsafe targets are pulled back toward. */
  readonly neutral: Pose;
  #pose: Pose;
  #rates: [number, number, number] = [0, 0, 0];
  #hornDeg: Triple;
  #requested: Pose;
  #goal: Pose;
  #goalNotes: string[] = [];
  /** Heading back to the neutral pose because the straight path to the goal was blocked. */
  #detour = false;
  #rejectedInput = false;
  #last: GovernorOutput;

  /**
   * @param start the starting (and neutral) pose; by default the neutral pose found for this robot
   * @param clearance collision tables for this geometry, or null to skip collision checks (other robots only)
   */
  constructor(
    geometry: PlatformGeometry = DEFAULT_GEOMETRY,
    limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
    start: Pose | null = null,
    clearance: ClearanceModel | null = DEFAULT_CLEARANCE,
  ) {
    this.geometry = geometry;
    this.limits = limits;
    this.clearance = clearance;
    const neutral = start ?? findNeutralPose(geometry, limits, clearance);
    if (!neutral) throw new Error('No level pose is safe with these limits; check the geometry, limits and collision tables.');
    const initial = checkPose(neutral, geometry, limits, clearance);
    if (!initial.ok) {
      throw new Error(`The start pose breaks the safety limits: ${describeViolations(initial.violations).join('; ')}`);
    }
    this.neutral = { pitchDeg: neutral.pitchDeg, rollDeg: neutral.rollDeg, heaveMm: neutral.heaveMm };
    this.#pose = { ...this.neutral };
    this.#hornDeg = initial.hornDeg;
    this.#requested = { ...this.neutral };
    this.#goal = { ...this.neutral };
    this.#last = this.#makeOutput('ok', []);
  }

  /** The most recent output (what is being commanded now). */
  get output(): GovernorOutput {
    return this.#last;
  }

  /** Sets where to go. Unsafe targets are pulled back toward the neutral pose; non-numeric targets are ignored. */
  setTarget(target: Pose): void {
    if (!isFinitePose(target)) {
      this.#rejectedInput = true;
      return;
    }
    this.#rejectedInput = false;
    this.#requested = { pitchDeg: target.pitchDeg, rollDeg: target.rollDeg, heaveMm: target.heaveMm };
    const { pose, clamped } = clampToSafe(this.#requested, this.neutral, this.geometry, this.limits, this.clearance);
    this.#goal = pose;
    if (clamped) {
      const why = summarizeViolations(checkPose(this.#requested, this.geometry, this.limits, this.clearance).violations);
      this.#goalNotes = [`target outside the safe range: ${why}. Holding the nearest safe pose toward it.`];
    } else {
      this.#goalNotes = [];
    }
  }

  /** Advances by dtS seconds and returns the new command. */
  step(dtS: number): GovernorOutput {
    if (!(dtS > 0) || !Number.isFinite(dtS)) return this.#last;
    const dt = Math.min(dtS, MAX_GOVERNOR_STEP_S);
    const L = this.limits;
    const current = asArray(this.#pose);
    const neutral = asArray(this.neutral);
    if (this.#detour && isAt(current, neutral)) this.#detour = false; // back at neutral: head out to the goal
    const aim = this.#detour ? neutral : asArray(this.#goal);
    const candidate = asPose(this.#stepToward(current, aim, dt));

    // Take the largest fraction of that step that is safe and keeps every servo under its speed cap.
    const accept = (fraction: number): { pose: Pose; check: PoseCheck } | null => {
      const pose = lerpPose(this.#pose, candidate, fraction);
      const check = checkPose(pose, this.geometry, this.limits, this.clearance);
      if (!check.ok) return null;
      for (const s of [0, 1, 2] as const) {
        if (Math.abs(check.hornDeg[s] - this.#hornDeg[s]) / dt > L.maxServoSpeedDegPerS) return null;
      }
      return { pose, check };
    };
    let chosen = accept(1);
    const notes = [...this.#goalNotes];
    if (this.#detour) notes.push('going round by the neutral pose: the straight path to the goal is blocked');
    if (chosen === null) {
      notes.push(
        checkPose(candidate, this.geometry, this.limits, this.clearance).ok
          ? 'servo speed capped'
          : 'motion stopped at the edge of the safe range',
      );
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const attempt = accept(mid);
        if (attempt) {
          lo = mid;
          chosen = attempt;
        } else {
          hi = mid;
        }
      }
    }

    let status: GovernorStatus;
    if (chosen === null) {
      this.#rates = [0, 0, 0];
      if (isAt(current, aim)) {
        status = notes.length > 0 ? 'limited' : 'ok';
      } else if (!this.#detour && !isAt(current, neutral)) {
        // Blocked on the way to the goal: go round by the neutral pose, starting next step.
        this.#detour = true;
        notes.push('the straight path to the goal is blocked: going round by the neutral pose');
        status = 'limited';
      } else {
        notes.push(this.#detour ? 'holding still: no safe step toward the neutral pose' : 'holding still at the neutral pose: no straight safe path to the goal');
        status = 'blocked';
      }
    } else {
      const next = asArray(chosen.pose);
      this.#rates = [(next[0] - current[0]) / dt, (next[1] - current[1]) / dt, (next[2] - current[2]) / dt];
      this.#pose = chosen.pose;
      this.#hornDeg = chosen.check.hornDeg;
      status = notes.length > 0 ? 'limited' : 'ok';
    }
    if (this.#rejectedInput) {
      notes.push('ignored a target with non-numeric values');
      status = 'blocked';
    }
    this.#last = this.#makeOutput(status, notes);
    return this.#last;
  }

  /**
   * One step toward `aim` along the straight line to it: as fast as the speed caps allow while every axis can
   * still stop on it, changing the velocity no faster than the acceleration caps allow (the whole change is scaled
   * together, so from rest the path stays on the line).
   */
  #stepToward(current: readonly [number, number, number], aim: readonly [number, number, number], dt: number): [number, number, number] {
    const L = this.limits;
    const maxSpeed = [L.maxAngularSpeedDegPerS, L.maxAngularSpeedDegPerS, L.maxHeaveSpeedMmPerS] as const;
    const maxAccel = [L.maxAngularAccelDegPerS2, L.maxAngularAccelDegPerS2, L.maxHeaveAccelMmPerS2] as const;
    const error = [aim[0] - current[0], aim[1] - current[1], aim[2] - current[2]] as const;
    const distance = Math.hypot(...error);
    let speed = 0;
    if (distance > 0) {
      speed = Number.POSITIVE_INFINITY;
      for (const j of [0, 1, 2] as const) {
        const remaining = Math.abs(error[j]);
        if (remaining === 0) continue;
        // Fastest speed from which this axis can still stop within `remaining`: a·dt·(√(¼ + x) − ½), written as
        // below so it stays exact for tiny distances (the difference form cancels to 0 and would freeze every axis).
        const x = (2 * remaining) / (maxAccel[j] * dt * dt);
        const brakingSpeed = (2 * remaining) / dt / (Math.sqrt(0.25 + x) + 0.5);
        speed = Math.min(speed, (Math.min(maxSpeed[j], brakingSpeed, remaining / dt) * distance) / remaining);
      }
    }
    const change = error.map((e, j) => (distance > 0 ? (e / distance) * speed : 0) - this.#rates[j]!);
    let scale = 1;
    for (const j of [0, 1, 2] as const) {
      const most = maxAccel[j] * dt;
      if (Math.abs(change[j]!) > most) scale = Math.min(scale, most / Math.abs(change[j]!));
    }
    return [0, 1, 2].map((j) => current[j]! + (this.#rates[j]! + change[j]! * scale) * dt) as [number, number, number];
  }

  #makeOutput(status: GovernorStatus, notes: readonly string[]): GovernorOutput {
    return {
      requested: this.#requested,
      goal: this.#goal,
      pose: this.#pose,
      rates: { pitchDegPerS: this.#rates[0], rollDegPerS: this.#rates[1], heaveMmPerS: this.#rates[2] },
      hornDeg: this.#hornDeg,
      status,
      notes,
    };
  }
}
