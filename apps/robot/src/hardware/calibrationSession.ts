import type { Pose, ServoIndex, Triple } from '@peeqo/core';
import {
  HORN_RANGE_DEG,
  MIN_RANGE_US,
  PRIOR_CALIBRATION,
  REST_US,
  SERVO_NAMES,
  channelPulses,
  hornAngles,
  hornRanges,
  pulseForHorn,
  rescaled,
  trimmed,
  type Calibration,
} from './calibration.ts';
import { RAW_RANGE_US } from './servoOutput.ts';

/**
 * The guided calibration, done with someone watching (the cloth cover off, so the three servo arms show):
 *
 * 1. identify: each channel wiggles its arm a little (±1.3°) and they say which arm moved.
 * 2. arms, for each arm in turn:
 *    - direction: they press + once and say whether it went up or down;
 *    - lowest: they nudge it down until it is just short of touching anything, and mark it;
 *    - highest: they nudge it up until it is as high as it should go (just short of binding), and mark it;
 *    - level: they nudge it (within what they marked) until it points level.
 *    That gives each servo's direction, measured range and level pulse.
 * 3. level: Peeqo rises to its neutral pose; with a level app on its head, they trim the tilt to zero.
 * 4. check: Peeqo tilts back 3°; they read the level, which corrects the scale (microseconds per degree).
 * 5. save. From then on nothing is ever sent outside the measured ranges, and the motion governor keeps a margin
 *    inside them.
 *
 * Every move is a raw pulse near the 2019 resting pulse (1500 µs, where the 2019 software always put the servos),
 * made slowly by ServoOutput in small steps, with someone watching.
 */
export type CalibrationStep = 'off' | 'identify' | 'arms' | 'level' | 'check' | 'done';
/** Where the current arm is in the arms step. */
export type ArmPhase = 'direction' | 'lowest' | 'highest' | 'level';

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
  /** Each servo's measured range, [smaller, larger] µs (null until both ends are marked). */
  readonly rangeUs: readonly (readonly [number, number] | null)[];
  readonly levelUs: readonly (number | null)[];
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
  readonly now?: () => number;
}

/** A small wiggle, both ways (direction is not known yet): about 1.3° of horn. */
export const WIGGLE_US = 15;
/** One press of + or −. */
export const NUDGE_US = 5;
/** The direction test: one press of +. */
export const PROBE_US = 20;
/** Looking for an arm's lowest point: how far from the resting pulse it may be nudged, either way (about 35°). */
export const ARM_RANGE_US = 400;
/** Looking for its highest point: how far above the resting pulse (about 61°: the most calibration can drive). */
export const HIGHEST_US = RAW_RANGE_US;
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
  /** The current arm's marks, as "up" from the resting pulse (µs, positive = horn up). */
  #lowestUp = 0;
  #rangeUs: ([number, number] | null)[] = [null, null, null];
  #directions: (1 | -1 | null)[] = [null, null, null];
  #levelUs: (number | null)[] = [null, null, null];
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
      rangeUs: this.#rangeUs.map((r) => (r ? ([r[0], r[1]] as const) : null)),
      levelUs: [...this.#levelUs],
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
    this.#lowestUp = 0;
    this.#rangeUs = [null, null, null];
    this.#directions = [null, null, null];
    this.#levelUs = [null, null, null];
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

  /** arms: which way the + press moved the arm (then: find its lowest point). */
  plusMoved(up: boolean): void {
    if (this.#step !== 'arms' || this.#armPhase !== 'direction') return;
    this.#directions[this.#servo] = up ? 1 : -1;
    const known = this.#directions.filter((d): d is 1 | -1 => d !== null);
    this.#message = new Set(known).size > 1 ? 'The arms turn different ways, which is unusual for this neck (they are mounted alike). Check before going on.' : null;
    this.#armPhase = 'lowest';
  }

  /**
   * arms: moves the current arm up (+) or down (−) by `steps` nudges, within what this phase allows: looking for its
   * lowest point, ARM_RANGE_US either side of rest; for its highest, from above its lowest up to HIGHEST_US;
   * levelling, between the two marks.
   */
  nudge(steps: number): void {
    if (this.#step !== 'arms' || this.#armPhase === 'direction' || !Number.isFinite(steps)) return;
    const direction = this.#directions[this.#servo];
    if (direction !== 1 && direction !== -1) return;
    const channel = this.#channelOf(this.#servo);
    const range = this.#rangeUs[this.#servo];
    const [low, high] =
      this.#armPhase === 'lowest'
        ? [-ARM_RANGE_US, ARM_RANGE_US]
        : this.#armPhase === 'highest'
          ? [this.#lowestUp + MIN_RANGE_US, HIGHEST_US]
          : range
            ? this.#upRange(range, direction)
            : [0, 0];
    const wantedUp = (this.#pulses[channel]! - REST_US) * direction + Math.round(steps) * NUDGE_US;
    const up = Math.min(high, Math.max(low, wantedUp));
    this.#message =
      wantedUp < low
        ? this.#armPhase === 'level'
          ? 'That is the lowest point you marked.'
          : this.#armPhase === 'highest'
            ? 'That is as close to its lowest mark as the highest can be.'
            : 'That is as far down as calibration goes.'
        : wantedUp > high
          ? this.#armPhase === 'level'
            ? 'That is the highest point you marked.'
            : 'That is as far up as calibration goes.'
          : null;
    this.#send(this.#pulses.map((p, c) => (c === channel ? REST_US + up * direction : p)));
  }

  /** arms: the current arm is just short of touching anything below it. */
  markLowest(): void {
    if (this.#step !== 'arms' || this.#armPhase !== 'lowest') return;
    const direction = this.#directions[this.#servo]!;
    this.#lowestUp = (this.#pulses[this.#channelOf(this.#servo)]! - REST_US) * direction;
    this.#armPhase = 'highest';
    this.#message = null;
  }

  /** arms: the current arm is as high as it should go. */
  markHighest(): void {
    if (this.#step !== 'arms' || this.#armPhase !== 'highest') return;
    const direction = this.#directions[this.#servo]!;
    const highestUp = (this.#pulses[this.#channelOf(this.#servo)]! - REST_US) * direction;
    if (highestUp < this.#lowestUp + MIN_RANGE_US) {
      this.#message = 'Move it up from its lowest point first.';
      return;
    }
    const a = REST_US + this.#lowestUp * direction;
    const b = REST_US + highestUp * direction;
    this.#rangeUs[this.#servo] = [Math.min(a, b), Math.max(a, b)];
    this.#armPhase = 'level';
    this.#message = null;
  }

  /** arms: the current arm points level (then the next arm, or, after the third, Peeqo rises). */
  armLevel(): void {
    if (this.#step !== 'arms' || this.#armPhase !== 'level') return;
    this.#levelUs[this.#servo] = this.#pulses[this.#channelOf(this.#servo)]!;
    if (this.#servo < 2) {
      this.#servo = (this.#servo + 1) as ServoIndex;
      this.#armPhase = 'direction';
      return;
    }
    // All three: Peeqo rises to its neutral pose.
    const channels = [0, 1, 2].map((s) => this.#channelOf(s as ServoIndex)) as unknown as Triple<number>;
    this.#working = {
      version: 1,
      channels,
      directions: this.#directions as unknown as Triple<1 | -1>,
      levelUs: this.#levelUs as unknown as Triple,
      usPerDeg: PRIOR_CALIBRATION.usPerDeg,
      checked: false,
      rangeUs: this.#rangeUs.map((r) => [r![0], r![1]] as const) as unknown as Triple<readonly [number, number]>,
    };
    this.#step = 'level';
    this.#sendPose(this.#deps.neutral);
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
    this.#trimmed = total;
    this.#working = trimmed(this.#working, this.#deps.neutral, limited);
    this.#step = 'level';
    this.#sendPose(this.#deps.neutral);
  }

  /** check: tilts back CHECK_TILT_DEG for a reading. */
  tilt(): void {
    if ((this.#step !== 'level' && this.#step !== 'done' && this.#step !== 'check') || !this.#working) return;
    this.#step = 'check';
    const n = this.#deps.neutral;
    this.#sendPose({ ...n, pitchDeg: n.pitchDeg + CHECK_TILT_DEG });
  }

  /** check: the level's reading while tilted (relative to its reading at level). */
  reading(deg: number): void {
    if (this.#step !== 'check' || !this.#working) return;
    // The level pulses were measured directly (arms levelled by eye), so the scale changes about them: the neutral
    // pose's height comes out right too.
    const better = rescaled(this.#working, CHECK_TILT_DEG, deg);
    if (!better) {
      this.#message = `A reading of ${deg}° is too far from ${CHECK_TILT_DEG}° to be right. Check the level and try again.`;
      return;
    }
    this.#message = null;
    this.#working = better;
    this.#step = 'done';
    this.#sendPose(this.#deps.neutral);
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

  #sendPose(pose: Pose): void {
    const working = this.#working;
    if (!working) return;
    const horns = hornAngles(pose);
    const pulses = channelPulses(working, horns.map((h, s) => pulseForHorn(working, s as ServoIndex, h)) as unknown as Triple);
    if (horns.some((h) => h < HORN_RANGE_DEG[0] || h > HORN_RANGE_DEG[1]) || pulses.some((us) => Math.abs(us - REST_US) > RAW_RANGE_US)) {
      this.#message = 'That move is outside what calibration allows; the arms may not have been level. Start over and check them.';
      return;
    }
    // Inside each arm's measured range, with the governor's margin.
    const ranges = hornRanges(working);
    const outside = ranges ? horns.findIndex((h, s) => h < ranges[s as ServoIndex][0] || h > ranges[s as ServoIndex][1]) : -1;
    if (ranges && outside >= 0) {
      const r = ranges[outside as ServoIndex];
      this.#message = `That needs ${SERVO_NAMES[outside as ServoIndex]} arm at ${horns[outside as ServoIndex].toFixed(1)}°, outside the range you marked for it (${r[0].toFixed(1)}° to ${r[1].toFixed(1)}° with a margin). Check its marks and start over.`;
      return;
    }
    this.#send(pulses);
  }

  /** A measured range as "up" from the resting pulse, [lowest, highest]. */
  #upRange(range: readonly [number, number], direction: 1 | -1): [number, number] {
    const a = (range[0] - REST_US) * direction;
    const b = (range[1] - REST_US) * direction;
    return [Math.min(a, b), Math.max(a, b)];
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
