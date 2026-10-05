import type { Pose, ServoIndex, Triple } from '@peeqo/core';
import {
  HORN_RANGE_DEG,
  PRIOR_CALIBRATION,
  REST_US,
  channelPulses,
  hornAngles,
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
 * 2. arms: for each arm, they press + once and say whether it went up or down; then nudge it until it points level.
 *    That gives each servo's direction and level pulse.
 * 3. level: Peeqo rises to its neutral pose; with a level app on its head, they trim the tilt to zero.
 * 4. check: Peeqo tilts back 3°; they read the level, which corrects the scale (microseconds per degree).
 * 5. save.
 *
 * Every move is a raw pulse near the 2019 resting pulse (1500 µs, where the 2019 software always put the servos),
 * made slowly by ServoOutput, and arms may only go a little below where they started (they rest near their holders).
 */
export type CalibrationStep = 'off' | 'identify' | 'arms' | 'level' | 'check' | 'done';

export interface CalibrationView {
  readonly step: CalibrationStep;
  /** identify: the channel being wiggled (0–2). */
  readonly channel: number;
  /** Which servo each channel drives (null: not yet known). */
  readonly channelServo: readonly (ServoIndex | null)[];
  /** arms: the servo being set up. */
  readonly servo: ServoIndex;
  readonly directions: readonly (1 | -1 | null)[];
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
  /** Store the result and hand the servos back to the governor. */
  readonly save: (calibration: Calibration) => void;
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
/** How far below where it started (the resting pulse) an arm may be moved: about 10°. */
export const MAX_DOWN_US = 114;
/** How far from the resting pulse an arm may be nudged by hand (about 35°). */
export const ARM_RANGE_US = 400;
/** The tilt check. */
export const CHECK_TILT_DEG = 3;

export class CalibrationSession {
  readonly #deps: CalibrationDeps;
  #step: CalibrationStep = 'off';
  #channel = 0;
  #channelServo: (ServoIndex | null)[] = [null, null, null];
  #servo: ServoIndex = 0;
  #directions: (1 | -1 | null)[] = [null, null, null];
  #levelUs: (number | null)[] = [null, null, null];
  #pulses: number[] = [REST_US, REST_US, REST_US];
  #working: Calibration | null = null;
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
      directions: [...this.#directions],
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
    this.#directions = [null, null, null];
    this.#levelUs = [null, null, null];
    this.#working = null;
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
    pattern.forEach((us, i) => this.#timers.push(setTimeout(() => this.#send(at(us)), i * 350)));
  }

  /** identify: the arm that moved. */
  identified(servo: ServoIndex): void {
    if (this.#step !== 'identify') return;
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
  }

  /** arms: one press of + on the current arm, to see which way it turns. */
  probe(): void {
    if (this.#step !== 'arms') return;
    const channel = this.#channelOf(this.#servo);
    this.#send(this.#pulses.map((p, c) => (c === channel ? p + PROBE_US : p)));
  }

  /** arms: which way the + press moved the arm. */
  plusMoved(up: boolean): void {
    if (this.#step !== 'arms') return;
    this.#directions[this.#servo] = up ? 1 : -1;
    const known = this.#directions.filter((d): d is 1 | -1 => d !== null);
    this.#message = new Set(known).size > 1 ? 'The arms turn different ways, which is unusual for this neck (they are mounted alike). Check before going on.' : null;
  }

  /** arms: moves the current arm up (+) or down (−) by `steps` nudges; down only a little below where it started. */
  nudge(steps: number): void {
    if (this.#step !== 'arms' || !Number.isFinite(steps)) return;
    const direction = this.#directions[this.#servo];
    if (direction !== 1 && direction !== -1) return; // the + test comes first
    const channel = this.#channelOf(this.#servo);
    // Measured upward from the resting pulse: no more than MAX_DOWN_US below it, nor ARM_RANGE_US above.
    const wantedUp = (this.#pulses[channel]! - REST_US) * direction + Math.round(steps) * NUDGE_US;
    const up = Math.min(ARM_RANGE_US, Math.max(-MAX_DOWN_US, wantedUp));
    const limited = REST_US + up * direction;
    this.#message =
      wantedUp < -MAX_DOWN_US ? 'That is as low as the arm may go here (it is close to its holder).' : wantedUp > ARM_RANGE_US ? 'That is as high as the arm may go while calibrating.' : null;
    this.#send(this.#pulses.map((p, c) => (c === channel ? limited : p)));
  }

  /** arms: the current arm points level. */
  armLevel(): void {
    if (this.#step !== 'arms' || this.#directions[this.#servo] === null) return;
    this.#levelUs[this.#servo] = this.#pulses[this.#channelOf(this.#servo)]!;
    if (this.#servo < 2) {
      this.#servo = (this.#servo + 1) as ServoIndex;
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
    this.#clearTimers();
    this.#deps.save(this.#working);
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
    this.#send(pulses);
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
