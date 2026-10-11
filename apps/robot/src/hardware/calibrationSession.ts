import { DEG_TO_RAD, solveFk, type Pose, type ServoIndex, type Triple } from '@peeqo/core';
import {
  HORN_RANGE_DEG,
  PRIOR_CALIBRATION,
  RANGE_MARGIN_DEG,
  REST_US,
  SERVO_NAMES,
  channelPulses,
  hornAngles,
  hornForPulse,
  hornRanges,
  pulseForHorn,
  rescaled,
  trimmed,
  type Calibration,
} from './calibration.ts';
import { RAW_RANGE_US } from './servoOutput.ts';

/**
 * The guided calibration, done with someone watching (the cloth cover off, so the three servo arms show). The arms
 * are linked through the platform, so an arm moved on its own tilts the head: arms only ever move a little on their
 * own, and the range is measured with the whole head moving together.
 *
 * 1. identify: each channel wiggles its arm a little (±1.3°) and they say which arm moved.
 * 2. arms, for each arm in turn: they press + once and say whether it went up or down, then nudge it (a little, on
 *    its own) until it points level. That gives each servo's direction and level pulse.
 * 3. range: the whole head moves up and down, staying level (all three arms always at the same angle, stepped by
 *    half a degree, so the steps are as small at the top as at the bottom). They lower it until something is just
 *    about to touch and mark it, then raise it until it is as high as it should go and mark it. Each servo's pulses
 *    at those two points become its range: nothing is ever sent outside it, and the motion governor keeps a margin
 *    inside it.
 * 4. level: Peeqo goes to its neutral pose; with a level app on its head, they trim the tilt to zero.
 * 5. check: Peeqo tilts back 3°; they read the level, which corrects the scale (microseconds per degree).
 * 6. save.
 *
 * Every move is a raw pulse near the 2019 resting pulse (1500 µs, where the 2019 software always put the servos),
 * made slowly by ServoOutput in small steps, with someone watching.
 */
export type CalibrationStep = 'off' | 'identify' | 'arms' | 'range' | 'level' | 'check' | 'done';
/** Where the current arm is in the arms step. */
export type ArmPhase = 'direction' | 'level';
/** Which end of the range is being looked for. */
export type RangePhase = 'lowest' | 'highest';

export interface CalibrationView {
  readonly step: CalibrationStep;
  /** identify: the channel being wiggled (0–2). */
  readonly channel: number;
  /** Which servo each channel drives (null: not yet known). */
  readonly channelServo: readonly (ServoIndex | null)[];
  /** arms: the servo being set up, and how far it has got. */
  readonly servo: ServoIndex;
  readonly armPhase: ArmPhase;
  readonly directions: readonly (1 | -1 | null)[];
  readonly levelUs: readonly (number | null)[];
  /**
   * range: which end is being looked for; the arms' angle now (degrees above level, all three the same) and the
   * head's height that gives (mm above the arms-level height, by the CAD); and the marks.
   */
  readonly rangePhase: RangePhase;
  readonly sweepDeg: number;
  readonly heightMm: number | null;
  readonly lowestDeg: number | null;
  readonly highestDeg: number | null;
  /** Each servo's measured range, [smaller, larger] µs (null until both ends are marked). */
  readonly rangeUs: readonly (readonly [number, number] | null)[];
  /** Pulses being commanded, by channel. */
  readonly pulsesUs: readonly number[];
  /** Microseconds per degree, as it stands. */
  readonly usPerDeg: number;
  readonly checked: boolean;
  readonly message: string | null;
}

export interface CalibrationDeps {
  /** Raw pulses for channels 0–2 (ServoOutput.raw: clamped and slow). */
  readonly raw: (pulsesUs: readonly number[]) => void;
  /** The governor's neutral pose. */
  readonly neutral: Pose;
  /** Store the result and hand the servos back to the governor; returns why not, if it cannot be used. */
  readonly save: (calibration: Calibration) => string | null;
  /** Leave calibration without saving (back to the old calibration, or holding at rest). */
  readonly cancel: () => void;
}

/** A small wiggle, both ways (direction is not known yet): about 1.3° of horn. */
export const WIGGLE_US = 15;
/** One press of + or − on a single arm. */
export const NUDGE_US = 5;
/** The direction test: one press of +. */
export const PROBE_US = 20;
/** On its own, an arm may go this far below where it started (it rests near its holder): about 10°. */
export const MAX_DOWN_US = 114;
/** And this far above (more on its own would tilt the head too far): about 17°. */
export const ARM_RANGE_US = 200;
/** One press of ▲/▼ in the range step: all three arms, by this much. */
export const RAISE_DEG = 0.5;
/**
 * How far the range step may move the arms, from level (the CAD's home pose): the CAD has the horns meeting their
 * holders just below level, and the neck near its top at about 62°. A little beyond both is allowed, as the real
 * robot may differ; the person watching stops it. (No servo goes further from rest than RAW_RANGE_US, either.)
 */
export const SWEEP_DEG = [-8, 65] as const;
/** Less room than this between the marks is a mistake in marking them (normal motion uses up to 50°). */
export const MIN_SWEEP_DEG = 20;
/** The tilt check. */
export const CHECK_TILT_DEG = 3;
/** The most the level step may correct, in all: more means the arms were not levelled (start over instead). */
export const MAX_TRIM = { pitchDeg: 3, rollDeg: 3, heaveMm: 1.5 } as const;

export class CalibrationSession {
  readonly #deps: CalibrationDeps;
  #step: CalibrationStep = 'off';
  #channel = 0;
  #channelServo: (ServoIndex | null)[] = [null, null, null];
  #servo: ServoIndex = 0;
  #armPhase: ArmPhase = 'direction';
  #directions: (1 | -1 | null)[] = [null, null, null];
  #levelUs: (number | null)[] = [null, null, null];
  #rangePhase: RangePhase = 'lowest';
  #sweepDeg = 0;
  #lowestDeg: number | null = null;
  #highestDeg: number | null = null;
  #rangeUs: ([number, number] | null)[] = [null, null, null];
  #pulses: number[] = [REST_US, REST_US, REST_US];
  #working: Calibration | null = null;
  /** How far the level step has corrected so far. */
  #trimmed = { pitchDeg: 0, rollDeg: 0, heaveMm: 0 };
  #message: string | null = null;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(deps: CalibrationDeps) {
    this.#deps = deps;
  }

  get active(): boolean {
    return this.#step !== 'off';
  }

  view(): CalibrationView {
    return {
      step: this.#step,
      channel: this.#channel,
      channelServo: [...this.#channelServo],
      servo: this.#servo,
      armPhase: this.#armPhase,
      directions: [...this.#directions],
      levelUs: [...this.#levelUs],
      rangePhase: this.#rangePhase,
      sweepDeg: this.#sweepDeg,
      heightMm: sweepHeight(this.#sweepDeg),
      lowestDeg: this.#lowestDeg,
      highestDeg: this.#highestDeg,
      rangeUs: this.#rangeUs.map((r) => (r ? ([r[0], r[1]] as const) : null)),
      pulsesUs: [...this.#pulses],
      usPerDeg: this.#working?.usPerDeg ?? PRIOR_CALIBRATION.usPerDeg,
      checked: this.#working?.checked ?? false,
      message: this.#message,
    };
  }

  /** Starts over: all servos to the resting pulse. */
  start(): void {
    this.#clearTimers();
    this.#step = 'identify';
    this.#channel = 0;
    this.#channelServo = [null, null, null];
    this.#servo = 0;
    this.#armPhase = 'direction';
    this.#directions = [null, null, null];
    this.#levelUs = [null, null, null];
    this.#rangePhase = 'lowest';
    this.#sweepDeg = 0;
    this.#lowestDeg = null;
    this.#highestDeg = null;
    this.#rangeUs = [null, null, null];
    this.#working = null;
    this.#trimmed = { pitchDeg: 0, rollDeg: 0, heaveMm: 0 };
    this.#message = null;
    this.#send([REST_US, REST_US, REST_US]);
  }

  /** identify: wiggles the current channel's arm three times. */
  wiggle(): void {
    if (this.#step !== 'identify') return;
    this.#clearTimers();
    const channel = this.#channel;
    const at = (us: number) => this.#pulses.map((p, c) => (c === channel ? us : p));
    const base = REST_US;
    const pattern = [base + WIGGLE_US, base - WIGGLE_US, base + WIGGLE_US, base - WIGGLE_US, base + WIGGLE_US, base - WIGGLE_US, base];
    pattern.forEach((us, i) =>
      this.#timers.push(
        setTimeout(() => {
          // Only while still looking at this channel (an answer before the wiggle ends stops it).
          if (this.#step === 'identify' && this.#channel === channel) this.#send(at(us));
        }, i * 350),
      ),
    );
  }

  /** identify: the arm that moved. */
  identified(servo: ServoIndex): void {
    if (this.#step !== 'identify') return;
    this.#clearTimers();
    if (this.#channelServo.includes(servo)) {
      this.#message = 'That arm was already matched to another channel. Watch closely and try again, or start over.';
      return;
    }
    this.#message = null;
    this.#channelServo[this.#channel] = servo;
    this.#send(this.#pulses.map((p, c) => (c === this.#channel ? REST_US : p)));
    if (this.#channel < 2) {
      this.#channel++;
      return;
    }
    this.#step = 'arms';
    this.#servo = 0;
    this.#armPhase = 'direction';
  }

  /** arms: one press of + on the current arm, to see which way it turns. */
  probe(): void {
    if (this.#step !== 'arms' || this.#armPhase !== 'direction') return;
    const channel = this.#channelOf(this.#servo);
    this.#send(this.#pulses.map((p, c) => (c === channel ? p + PROBE_US : p)));
  }

  /** arms: which way the + press moved the arm (then: level it). */
  plusMoved(up: boolean): void {
    if (this.#step !== 'arms' || this.#armPhase !== 'direction') return;
    this.#directions[this.#servo] = up ? 1 : -1;
    const known = this.#directions.filter((d): d is 1 | -1 => d !== null);
    this.#message = new Set(known).size > 1 ? 'The arms turn different ways, which is unusual for this neck (they are mounted alike). Check before going on.' : null;
    this.#armPhase = 'level';
  }

  /** arms: moves the current arm up (+) or down (−) by `steps` nudges, a little either side of where it started. */
  nudge(steps: number): void {
    if (this.#step !== 'arms' || this.#armPhase !== 'level' || !Number.isFinite(steps)) return;
    const direction = this.#directions[this.#servo];
    if (direction !== 1 && direction !== -1) return;
    const channel = this.#channelOf(this.#servo);
    // Measured upward from the resting pulse: no more than MAX_DOWN_US below it, nor ARM_RANGE_US above.
    const wantedUp = (this.#pulses[channel]! - REST_US) * direction + Math.round(steps) * NUDGE_US;
    const up = Math.min(ARM_RANGE_US, Math.max(-MAX_DOWN_US, wantedUp));
    this.#message =
      wantedUp < -MAX_DOWN_US
        ? 'That is as low as one arm may go on its own (it is close to its holder).'
        : wantedUp > ARM_RANGE_US
          ? 'That is as far as one arm may go on its own (more would tilt the head too far).'
          : null;
    this.#send(this.#pulses.map((p, c) => (c === channel ? REST_US + up * direction : p)));
  }

  /** arms: the current arm points level (then the next arm, or after the third, the range step). */
  armLevel(): void {
    if (this.#step !== 'arms' || this.#armPhase !== 'level') return;
    this.#levelUs[this.#servo] = this.#pulses[this.#channelOf(this.#servo)]!;
    if (this.#servo < 2) {
      this.#servo = (this.#servo + 1) as ServoIndex;
      this.#armPhase = 'direction';
      return;
    }
    const channels = [0, 1, 2].map((s) => this.#channelOf(s as ServoIndex)) as unknown as Triple<number>;
    this.#working = {
      version: 1,
      channels,
      directions: this.#directions as unknown as Triple<1 | -1>,
      levelUs: this.#levelUs as unknown as Triple,
      usPerDeg: PRIOR_CALIBRATION.usPerDeg,
      checked: false,
    };
    // All arms level is the CAD's home pose: the range step starts there.
    this.#step = 'range';
    this.#rangePhase = 'lowest';
    this.#sweepDeg = 0;
    this.#sendSweep(0);
  }

  /** range: moves the whole head up (+) or down (−) by `steps` presses, staying level (as far as allowed). */
  raise(steps: number): void {
    if (this.#step !== 'range' || !this.#working || !Number.isFinite(steps)) return;
    const [bottom, top] = this.#sweepBounds(this.#working);
    // Looking for the highest point, never below the lowest one.
    const lowest = this.#rangePhase === 'highest' && this.#lowestDeg !== null ? this.#lowestDeg : bottom;
    const wanted = this.#sweepDeg + Math.round(steps) * RAISE_DEG;
    const angle = Math.round(Math.min(top, Math.max(lowest, wanted)) * 1000) / 1000;
    if (!this.#sendSweep(angle)) return;
    this.#sweepDeg = angle;
    this.#message =
      wanted < lowest - 1e-9
        ? this.#rangePhase === 'highest'
          ? 'That is the lowest point you marked.'
          : 'That is as low as calibration goes.'
        : wanted > top + 1e-9
          ? 'That is as high as calibration goes.'
          : null;
  }

  /** range: the head is just short of anything touching (and below Peeqo's normal height). */
  markLowest(): void {
    if (this.#step !== 'range' || this.#rangePhase !== 'lowest') return;
    const neutral = Math.min(...hornAngles(this.#deps.neutral));
    if (this.#sweepDeg + RANGE_MARGIN_DEG > neutral) {
      this.#message = `That is not below Peeqo's normal height (arms at ${neutral.toFixed(1)}°): lower it to just before anything touches.`;
      return;
    }
    this.#lowestDeg = this.#sweepDeg;
    this.#rangePhase = 'highest';
    this.#message = null;
  }

  /**
   * range: the head is as high as it should go. Each servo's pulses at the two marks become its range; then Peeqo
   * goes to its neutral pose (which must be inside, with the governor's margin).
   */
  markHighest(): void {
    if (this.#step !== 'range' || this.#rangePhase !== 'highest' || this.#lowestDeg === null || !this.#working) return;
    if (this.#sweepDeg < this.#lowestDeg + MIN_SWEEP_DEG - 1e-9) {
      this.#message = `Raise it at least ${MIN_SWEEP_DEG}° of arm above the lowest point first.`;
      return;
    }
    const working = this.#working;
    const at = (angle: number) => [0, 1, 2].map((s) => pulseForHorn(working, s as ServoIndex, angle));
    const low = at(this.#lowestDeg);
    const high = at(this.#sweepDeg);
    const rangeUs = [0, 1, 2].map((s) => [Math.min(low[s]!, high[s]!), Math.max(low[s]!, high[s]!)] as const) as unknown as Triple<readonly [number, number]>;
    const candidate: Calibration = { ...working, rangeUs };
    // Neutral must fit, a margin inside each range, before anything moves there.
    const horns = hornAngles(this.#deps.neutral);
    const ranges = hornRanges(candidate)!;
    if (horns.some((h, s) => h < ranges[s as ServoIndex][0] || h > ranges[s as ServoIndex][1])) {
      this.#message = `The highest point must be above Peeqo's normal height (arms at ${Math.max(...horns).toFixed(1)}°), with ${RANGE_MARGIN_DEG}° to spare: raise it higher.`;
      return;
    }
    this.#highestDeg = this.#sweepDeg;
    this.#rangeUs = rangeUs.map((r) => [r[0], r[1]]);
    this.#working = candidate;
    this.#step = 'level';
    this.#message = null;
    this.#sendPose(this.#deps.neutral, 'normal');
  }

  /** range: forget the marks and look for the lowest point again. */
  remark(): void {
    if (this.#step !== 'range') return;
    this.#rangePhase = 'lowest';
    this.#lowestDeg = null;
    this.#message = null;
  }

  /** level: moves the head by a little (from where it is): "tilt back", "tilt to its left", "up". */
  trim(move: Pose): void {
    if ((this.#step !== 'level' && this.#step !== 'done') || !this.#working) return;
    const limited = {
      pitchDeg: clamp(move.pitchDeg, -1, 1),
      rollDeg: clamp(move.rollDeg, -1, 1),
      heaveMm: clamp(move.heaveMm, -0.5, 0.5),
    };
    const total = {
      pitchDeg: this.#trimmed.pitchDeg + limited.pitchDeg,
      rollDeg: this.#trimmed.rollDeg + limited.rollDeg,
      heaveMm: this.#trimmed.heaveMm + limited.heaveMm,
    };
    if (Math.abs(total.pitchDeg) > MAX_TRIM.pitchDeg || Math.abs(total.rollDeg) > MAX_TRIM.rollDeg || Math.abs(total.heaveMm) > MAX_TRIM.heaveMm) {
      this.#message = 'That is more correction than levelling should need: the arms were probably not level. Start over and level them again.';
      return;
    }
    const before = this.#working;
    this.#working = trimmed(this.#working, this.#deps.neutral, limited);
    if (!this.#sendPose(this.#deps.neutral, 'normal')) {
      this.#working = before; // (the measured ranges do not allow it: nothing moved)
      return;
    }
    this.#trimmed = total;
    this.#step = 'level';
  }

  /** check: tilts back CHECK_TILT_DEG for a reading. */
  tilt(): void {
    if ((this.#step !== 'level' && this.#step !== 'done' && this.#step !== 'check') || !this.#working) return;
    const n = this.#deps.neutral;
    if (this.#sendPose({ ...n, pitchDeg: n.pitchDeg + CHECK_TILT_DEG }, 'normal')) this.#step = 'check';
  }

  /** check: the level's reading while tilted (relative to its reading at level). */
  reading(deg: number): void {
    if (this.#step !== 'check' || !this.#working) return;
    // The level pulses were measured directly (arms levelled by eye), so the scale changes about them: the neutral
    // pose's height comes out right too. (The measured ranges are pulses, so they stay as measured.)
    const better = rescaled(this.#working, CHECK_TILT_DEG, deg);
    if (!better) {
      this.#message = `A reading of ${deg}° is too far from ${CHECK_TILT_DEG}° to be right. Check the level and try again.`;
      return;
    }
    const before = this.#working;
    this.#working = better;
    if (!this.#sendPose(this.#deps.neutral, 'normal')) {
      this.#working = before;
      return;
    }
    this.#message = null;
    this.#step = 'done';
  }

  /** Saves (from the level or done step: the tilt check is recommended, not required). */
  save(): boolean {
    if ((this.#step !== 'level' && this.#step !== 'done') || !this.#working) return false;
    const problem = this.#deps.save(this.#working);
    if (problem) {
      this.#message = problem;
      return false;
    }
    this.#clearTimers();
    this.#step = 'off';
    return true;
  }

  cancel(): void {
    if (this.#step === 'off') return;
    this.#clearTimers();
    this.#step = 'off';
    this.#deps.cancel();
  }

  #channelOf(servo: ServoIndex): number {
    const channel = this.#channelServo.indexOf(servo);
    if (channel < 0) throw new Error('That servo has not been identified');
    return channel;
  }

  /**
   * range: the arm angles the sweep may use, on the grid of presses: within SWEEP_DEG, and no servo further from rest
   * than RAW_RANGE_US.
   */
  #sweepBounds(working: Calibration): readonly [number, number] {
    let lo: number = SWEEP_DEG[0];
    let hi: number = SWEEP_DEG[1];
    for (const servo of [0, 1, 2] as const) {
      const a = hornForPulse(working, servo, REST_US - RAW_RANGE_US);
      const b = hornForPulse(working, servo, REST_US + RAW_RANGE_US);
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
    }
    return [Math.ceil(lo / RAISE_DEG - 1e-9) * RAISE_DEG, Math.floor(hi / RAISE_DEG + 1e-9) * RAISE_DEG];
  }

  /** range: all three arms at `angle` above level (the head stays level). */
  #sendSweep(angle: number): boolean {
    const working = this.#working;
    if (!working) return false;
    const pulses = channelPulses(working, [0, 1, 2].map((s) => pulseForHorn(working, s as ServoIndex, angle)) as unknown as Triple);
    if (pulses.some((us) => Math.abs(us - REST_US) > RAW_RANGE_US)) {
      this.#message = 'That is further from rest than calibration allows; the arms may not have been level. Start over and check them.';
      return false;
    }
    this.#send(pulses);
    return true;
  }

  /**
   * Moves to a pose with the working calibration, if allowed: only inside the robot's horn range and the measured
   * ranges. Says why not, and returns false, if it is not allowed (nothing moves then).
   */
  #sendPose(pose: Pose, limits: 'normal'): boolean {
    const working = this.#working;
    if (!working) return false;
    let horns: Triple;
    try {
      horns = hornAngles(pose);
    } catch {
      this.#message = 'The neck cannot reach that.';
      return false;
    }
    const pulses = channelPulses(working, horns.map((h, s) => pulseForHorn(working, s as ServoIndex, h)) as unknown as Triple);
    const [lo, hi] = HORN_RANGE_DEG;
    if (horns.some((h) => h < lo || h > hi) || pulses.some((us) => Math.abs(us - REST_US) > RAW_RANGE_US)) {
      this.#message = 'That move is outside what calibration allows; the arms may not have been level. Start over and check them.';
      return false;
    }
    if (limits === 'normal') {
      const ranges = hornRanges(working);
      const outside = ranges ? horns.findIndex((h, s) => h < ranges[s as ServoIndex][0] || h > ranges[s as ServoIndex][1]) : -1;
      if (ranges && outside >= 0) {
        const r = ranges[outside as ServoIndex];
        this.#message = `That needs ${SERVO_NAMES[outside as ServoIndex]} arm at ${horns[outside as ServoIndex].toFixed(1)}°, outside its measured range (${r[0].toFixed(1)}° to ${r[1].toFixed(1)}° with the margin).`;
        return false;
      }
    }
    this.#send(pulses);
    return true;
  }

  #send(pulses: readonly number[]): void {
    this.#pulses = [...pulses];
    this.#deps.raw(this.#pulses);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
  }
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

/** The head's height (mm above the arms-level height, by the CAD) with all three arms at `angle`; null if unreachable. */
function sweepHeight(angle: number): number | null {
  const pose = solveFk([angle * DEG_TO_RAD, angle * DEG_TO_RAD, angle * DEG_TO_RAD]);
  return pose ? Math.round(pose.heaveMm * 100) / 100 : null;
}
