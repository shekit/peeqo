import { checkPose, describeViolations, summarizeViolations, type PoseCheck } from './check.ts';
import { clampToSafe, lerpPose } from './envelope.ts';
import { PEEQO_2019_GEOMETRY, type PlatformGeometry } from './geometry.ts';
import { HOME_POSE, type Pose } from './kinematics.ts';
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
  /** Where the governor is heading: the request, pulled back toward home if it was unsafe. */
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

/**
 * The only path to the servos. Targets from anywhere are clamped to the safe range, then followed with
 * speed and acceleration limits, and every commanded pose is re-checked before it is used.
 * Call step() at a fixed rate; each call returns the pose and horn angles to send.
 */
export class MotionGovernor {
  readonly geometry: PlatformGeometry;
  readonly limits: SafetyLimits;
  #pose: Pose;
  #rates: [number, number, number] = [0, 0, 0];
  #hornDeg: Triple;
  #requested: Pose;
  #goal: Pose;
  #goalNotes: string[] = [];
  #rejectedInput = false;
  #last: GovernorOutput;

  constructor(
    geometry: PlatformGeometry = PEEQO_2019_GEOMETRY,
    limits: SafetyLimits = DEFAULT_SAFETY_LIMITS,
    start: Pose = HOME_POSE,
  ) {
    this.geometry = geometry;
    this.limits = limits;
    const home = checkPose(HOME_POSE, geometry, limits);
    if (!home.ok) {
      throw new Error(`The home pose breaks the safety limits: ${describeViolations(home.violations).join('; ')}`);
    }
    const initial = checkPose(start, geometry, limits);
    if (!initial.ok) {
      throw new Error(`The start pose breaks the safety limits: ${describeViolations(initial.violations).join('; ')}`);
    }
    this.#pose = { ...start };
    this.#hornDeg = initial.hornDeg;
    this.#requested = { ...start };
    this.#goal = { ...start };
    this.#last = this.#makeOutput('ok', []);
  }

  /** The most recent output (what is being commanded now). */
  get output(): GovernorOutput {
    return this.#last;
  }

  /** Sets where to go. Unsafe targets are pulled back toward home; non-numeric targets are ignored. */
  setTarget(target: Pose): void {
    if (!isFinitePose(target)) {
      this.#rejectedInput = true;
      return;
    }
    this.#rejectedInput = false;
    this.#requested = { pitchDeg: target.pitchDeg, rollDeg: target.rollDeg, heaveMm: target.heaveMm };
    const { pose, clamped } = clampToSafe(this.#requested, this.geometry, this.limits);
    this.#goal = pose;
    if (clamped) {
      const why = summarizeViolations(checkPose(this.#requested, this.geometry, this.limits).violations);
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
    const maxSpeed = [L.maxAngularSpeedDegPerS, L.maxAngularSpeedDegPerS, L.maxHeaveSpeedMmPerS] as const;
    const maxAccel = [L.maxAngularAccelDegPerS2, L.maxAngularAccelDegPerS2, L.maxHeaveAccelMmPerS2] as const;
    const current = asArray(this.#pose);
    const goal = asArray(this.#goal);

    // Per axis: head for the goal as fast as the caps allow while still being able to stop on it.
    const proposed: [number, number, number] = [0, 0, 0];
    for (const j of [0, 1, 2] as const) {
      const error = goal[j] - current[j];
      const a = maxAccel[j];
      const brakingSpeed = a * dt * (Math.sqrt(0.25 + (2 * Math.abs(error)) / (a * dt * dt)) - 0.5);
      const desired = Math.sign(error) * Math.min(maxSpeed[j], brakingSpeed, Math.abs(error) / dt);
      const change = Math.max(-a * dt, Math.min(a * dt, desired - this.#rates[j]));
      proposed[j] = current[j] + (this.#rates[j] + change) * dt;
    }
    const candidate = asPose(proposed);

    // Take the largest fraction of that step that is safe and keeps every servo under its speed cap.
    const accept = (fraction: number): { pose: Pose; check: PoseCheck } | null => {
      const pose = lerpPose(this.#pose, candidate, fraction);
      const check = checkPose(pose, this.geometry, this.limits);
      if (!check.ok) return null;
      for (const s of [0, 1, 2] as const) {
        if (Math.abs(check.hornDeg[s] - this.#hornDeg[s]) / dt > L.maxServoSpeedDegPerS) return null;
      }
      return { pose, check };
    };
    let chosen = accept(1);
    const notes = [...this.#goalNotes];
    if (chosen === null) {
      notes.push(
        checkPose(candidate, this.geometry, this.limits).ok
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
      const atGoal = current.every((v, j) => Math.abs(v - goal[j]!) < 1e-9);
      status = atGoal ? (notes.length > 0 ? 'limited' : 'ok') : 'blocked';
      if (!atGoal) notes.push('holding still: no safe step toward the goal');
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
