import { DEG_TO_RAD, solveFk, type Pose, type ServoIndex, type Triple } from '@peeqo/core';
import {
  BOARD_NUMBERS,
  PRIOR_CALIBRATION,
  RANGE_MARGIN_DEG,
  REST_US,
  SERVO_NAMES,
  SERVO_TRAVEL_US,
  channelPulses,
  hornAngles,
  hornForPulse,
  hornRanges,
  pulseForHorn,
  rescaled,
  trimmed,
  type Calibration,
} from './calibration.ts';

/**
 * The guided calibration, done with someone watching (the cloth cover off, so the three servo arms show). The person
 * sets the limits: calibration has none of its own beyond the servos' travel (SERVO_TRAVEL_US). Every move is a small
 * step they ask for, made slowly (ServoOutput), and they stop before anything touches. The arms are linked through
 * the platform, so an arm moved on its own tilts the head: the range is measured with the whole head moving together.
 *
 * 1. identify, for each plug (channel) in turn: they tap ▲, moving its arm about 1° a tap the way the 2019 software
 *    raised it, until they see which arm moves; then say which arm it was and whether it went up or down.
 *    That gives each servo's channel and direction. (The horns are short, 7 mm: a degree is a sixth of a millimetre at
 *    the tip, so it takes a few taps to see.)
 * 2. arms, for each arm in turn (in the order the board numbers them): they nudge it until it points level. That gives
 *    each servo's level pulse.
 * 3. range: the whole head moves up and down, staying level (all three arms always at the same angle, stepped by
 *    half a degree, so the steps are as small at the top as at the bottom). They lower it until something is just
 *    about to touch and mark it, then raise it until it is as high as it should go and mark it. Each servo's pulses
 *    at those two points become its range: nothing is ever sent outside it, and the motion governor keeps a margin
 *    inside it.
 * 4. level: Peeqo goes to its neutral pose; with a level app on its head, they trim the tilt to zero.
 * 5. check: Peeqo tilts back 3°; they read the level, which corrects the scale (microseconds per degree).
 * 6. save.
 *
 * It starts from the 2019 resting pulse (1500 µs, where the 2019 software always put the servos).
 */
export type CalibrationStep = 'off' | 'identify' | 'arms' | 'range' | 'level' | 'check' | 'done';
/** Which end of the range is being looked for. */
export type RangePhase = 'lowest' | 'highest';

export interface CalibrationView {
  readonly step: CalibrationStep;
  /** identify: the channel (plug) being found (0–2), and how far its arm has been moved from rest (degrees, roughly). */
  readonly channel: number;
  readonly movedDeg: number;
  /** Which servo each channel drives (null: not yet known). */
  readonly channelServo: readonly (ServoIndex | null)[];
  /** arms: the servo being levelled. */
  readonly servo: ServoIndex;
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

/** identify: one tap moves the plug's arm this much (about 1°), toward a smaller pulse (up, in the 2019 software). */
export const FIND_STEP_US = 12;
/** One press of + or − on a single arm. */
export const NUDGE_US = 5;
/** One press of ▲/▼ in the range step: all three arms, by this much. */
export const RAISE_DEG = 0.5;
/** Less room than this between the marks is a mistake in marking them (normal motion uses up to 50°). */
export const MIN_SWEEP_DEG = 20;
/** The tilt check. */
export const CHECK_TILT_DEG = 3;
/** The order the arms are set up in: as the board numbers them. */
const ARM_ORDER = ([0, 1, 2] as const).slice().sort((a, b) => BOARD_NUMBERS[a] - BOARD_NUMBERS[b]) as ServoIndex[];
const END_OF_TRAVEL = "That is the end of the servo's travel.";

export class CalibrationSession {
  readonly #deps: CalibrationDeps;
  #step: CalibrationStep = 'off';
  #channel = 0;
  #channelServo: (ServoIndex | null)[] = [null, null, null];
  #movedUs = 0;
  #servo: ServoIndex = 0;
  #directions: (1 | -1 | null)[] = [null, null, null];
  #levelUs: (number | null)[] = [null, null, null];
  #rangePhase: RangePhase = 'lowest';
  #sweepDeg = 0;
  #lowestDeg: number | null = null;
  #highestDeg: number | null = null;
  #rangeUs: ([number, number] | null)[] = [null, null, null];
  #pulses: number[] = [REST_US, REST_US, REST_US];
  #working: Calibration | null = null;
  #message: string | null = null;

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
      movedDeg: Math.round((this.#movedUs / PRIOR_CALIBRATION.usPerDeg) * 10) / 10,
      channelServo: [...this.#channelServo],
      servo: this.#servo,
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
    this.#step = 'identify';
    this.#channel = 0;
    this.#movedUs = 0;
    this.#channelServo = [null, null, null];
    this.#servo = 0;
    this.#directions = [null, null, null];
    this.#levelUs = [null, null, null];
    this.#rangePhase = 'lowest';
    this.#sweepDeg = 0;
    this.#lowestDeg = null;
    this.#highestDeg = null;
    this.#rangeUs = [null, null, null];
    this.#working = null;
    this.#message = null;
    this.#send([REST_US, REST_US, REST_US]);
  }

  /** identify: moves the current plug's arm by `steps` taps (▲ +, ▼ − back toward rest), within the servo's travel. */
  move(steps: number): void {
    if (this.#step !== 'identify' || !Number.isFinite(steps)) return;
    const most = Math.floor((REST_US - SERVO_TRAVEL_US[0]) / FIND_STEP_US) * FIND_STEP_US;
    const wanted = this.#movedUs + Math.round(steps) * FIND_STEP_US;
    this.#movedUs = Math.min(most, Math.max(0, wanted));
    this.#message = wanted > most ? END_OF_TRAVEL : null;
    this.#send(this.#pulses.map((p, c) => (c === this.#channel ? REST_US - this.#movedUs : p)));
  }

  /** identify: the arm that moved, and which way (then it goes back to rest, and on to the next plug). */
  identified(servo: ServoIndex, up: boolean): void {
    if (this.#step !== 'identify') return;
    if (this.#movedUs === 0) {
      this.#message = 'Tap ▲ first, until you see an arm move.';
      return;
    }
    if (this.#channelServo.includes(servo)) {
      this.#message = 'That arm was already matched to another plug. Watch closely and try again, or go back.';
      return;
    }
    this.#channelServo[this.#channel] = servo;
    // It moved for a smaller pulse: if that was up, the pulse falls as the arm rises.
    this.#directions[servo] = up ? -1 : 1;
    const known = this.#directions.filter((d): d is 1 | -1 => d !== null);
    this.#message = new Set(known).size > 1 ? 'The arms turn different ways, which is unusual for this neck (they are mounted alike). Check before going on.' : null;
    this.#movedUs = 0;
    this.#send(this.#pulses.map((p, c) => (c === this.#channel ? REST_US : p)));
    if (this.#channel < 2) {
      this.#channel++;
      return;
    }
    this.#step = 'arms';
    this.#servo = ARM_ORDER[0]!;
  }

  /** identify: back to the previous plug, forgetting what was said about it. */
  back(): void {
    if (this.#step !== 'identify' || this.#channel === 0) return;
    this.#send(this.#pulses.map((p, c) => (c === this.#channel ? REST_US : p)));
    this.#channel--;
    const servo = this.#channelServo[this.#channel];
    if (servo !== null && servo !== undefined) this.#directions[servo] = null;
    this.#channelServo[this.#channel] = null;
    this.#movedUs = 0;
    this.#message = null;
  }

  /** arms: moves the current arm up (+) or down (−) by `steps` nudges, within the servo's travel. */
  nudge(steps: number): void {
    if (this.#step !== 'arms' || !Number.isFinite(steps)) return;
    const direction = this.#directions[this.#servo];
    if (direction !== 1 && direction !== -1) return;
    const channel = this.#channelOf(this.#servo);
    // Measured upward from the resting pulse, in whole nudges (so it always comes back to rest exactly).
    const [a, b] = SERVO_TRAVEL_US.map((us) => (us - REST_US) * direction) as [number, number];
    const lowest = Math.ceil(Math.min(a, b) / NUDGE_US) * NUDGE_US;
    const highest = Math.floor(Math.max(a, b) / NUDGE_US) * NUDGE_US;
    const wantedUp = (this.#pulses[channel]! - REST_US) * direction + Math.round(steps) * NUDGE_US;
    const up = Math.min(highest, Math.max(lowest, wantedUp));
    this.#message = wantedUp < lowest || wantedUp > highest ? END_OF_TRAVEL : null;
    this.#send(this.#pulses.map((p, c) => (c === channel ? REST_US + up * direction : p)));
  }

  /** arms: the current arm points level (then the next arm, or after the third, the range step). */
  armLevel(): void {
    if (this.#step !== 'arms') return;
    this.#levelUs[this.#servo] = this.#pulses[this.#channelOf(this.#servo)]!;
    const next = ARM_ORDER[ARM_ORDER.indexOf(this.#servo) + 1];
    if (next !== undefined) {
      this.#servo = next;
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
          : END_OF_TRAVEL
        : wanted > top + 1e-9
          ? END_OF_TRAVEL
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
    this.#sendPose(this.#deps.neutral);
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
    // One tap is a small step.
    const step = {
      pitchDeg: clamp(move.pitchDeg, -1, 1),
      rollDeg: clamp(move.rollDeg, -1, 1),
      heaveMm: clamp(move.heaveMm, -0.5, 0.5),
    };
    const before = this.#working;
    this.#working = trimmed(this.#working, this.#deps.neutral, step);
    if (!this.#sendPose(this.#deps.neutral)) {
      this.#working = before; // (the marks do not allow it: nothing moved)
      return;
    }
    this.#message = null;
    this.#step = 'level';
  }

  /** check: tilts back CHECK_TILT_DEG for a reading. */
  tilt(): void {
    if ((this.#step !== 'level' && this.#step !== 'done' && this.#step !== 'check') || !this.#working) return;
    const n = this.#deps.neutral;
    if (this.#sendPose({ ...n, pitchDeg: n.pitchDeg + CHECK_TILT_DEG })) this.#step = 'check';
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
    if (!this.#sendPose(this.#deps.neutral)) {
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
    this.#step = 'off';
    return true;
  }

  cancel(): void {
    if (this.#step === 'off') return;
    this.#step = 'off';
    this.#deps.cancel();
  }

  #channelOf(servo: ServoIndex): number {
    const channel = this.#channelServo.indexOf(servo);
    if (channel < 0) throw new Error('That servo has not been identified');
    return channel;
  }

  /** range: the arm angles the sweep may use, on the grid of presses: every servo within its travel. */
  #sweepBounds(working: Calibration): readonly [number, number] {
    let lo = -Infinity;
    let hi = Infinity;
    for (const servo of [0, 1, 2] as const) {
      const a = hornForPulse(working, servo, SERVO_TRAVEL_US[0]);
      const b = hornForPulse(working, servo, SERVO_TRAVEL_US[1]);
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
    if (pulses.some((us) => us < SERVO_TRAVEL_US[0] || us > SERVO_TRAVEL_US[1])) {
      this.#message = END_OF_TRAVEL;
      return false;
    }
    this.#send(pulses);
    return true;
  }

  /**
   * Moves to a pose with the working calibration (the level and check steps, near Peeqo's normal pose), if allowed:
   * inside the marks. Says why not, and returns false, if not (nothing moves then).
   */
  #sendPose(pose: Pose): boolean {
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
    if (pulses.some((us) => us < SERVO_TRAVEL_US[0] || us > SERVO_TRAVEL_US[1])) {
      this.#message = END_OF_TRAVEL;
      return false;
    }
    const ranges = hornRanges(working);
    const outside = ranges ? horns.findIndex((h, s) => h < ranges[s as ServoIndex][0] || h > ranges[s as ServoIndex][1]) : -1;
    if (ranges && outside >= 0) {
      const r = ranges[outside as ServoIndex];
      this.#message = `That needs the ${SERVO_NAMES[outside as ServoIndex]} arm (${BOARD_NUMBERS[outside as ServoIndex]}) at ${horns[outside as ServoIndex].toFixed(1)}°, outside the range you marked (${r[0].toFixed(1)}° to ${r[1].toFixed(1)}° with the margin).`;
      return false;
    }
    this.#send(pulses);
    return true;
  }

  #send(pulses: readonly number[]): void {
    this.#pulses = [...pulses];
    this.#deps.raw(this.#pulses);
  }
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

/** The head's height (mm above the arms-level height, by the CAD) with all three arms at `angle`; null if unreachable. */
function sweepHeight(angle: number): number | null {
  const pose = solveFk([angle * DEG_TO_RAD, angle * DEG_TO_RAD, angle * DEG_TO_RAD]);
  return pose ? Math.round(pose.heaveMm * 100) / 100 : null;
}
