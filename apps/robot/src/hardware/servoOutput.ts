import type { Triple } from '@peeqo/core';
import { REST_US, SERVO_TRAVEL_US, channelPulses, pulseForHorn, type Calibration } from './calibration.ts';
import type { HardwareOutputs } from './link.ts';

/** How fast the calibration tool's moves (and the first move after start-up) go: about 13° of horn a second. */
export const RAW_RATE_US_PER_S = 150;
/** The fastest a servo may be asked to turn in normal use (its own top speed). */
const MAX_SERVO_DEG_PER_S = 600;
/** How often pulses go to the servo board. */
export const SEND_HZ = 50;
/** The channels the 2019 wiring uses, which the calibration tool may drive. */
export const SERVO_CHANNELS = 3;

export type ServoMode = 'off' | 'raw' | 'pose';

export interface ServoState {
  readonly mode: ServoMode;
  /** Pulses being sent, by channel (null when off). */
  readonly pulsesUs: readonly number[] | null;
  readonly calibrated: boolean;
  /** Why the last request was refused, if it was. */
  readonly fault: string | null;
}

/**
 * The only way to the servos. Off at start-up (no pulses: the servos are limp). The calibration tool drives channels
 * directly ("raw"), slowly and only near the 2019 resting pulse. Once calibrated, it takes horn angles from the motion
 * governor ("pose") and refuses any outside the guard range, or any pulse outside a servo's measured range (the
 * governor keeps inside those, so this only ever catches a fault). Every change of position moves all channels together
 * (they arrive at the same moment, so the head moves in a straight line between the poses), and no faster than
 * allowed: slowly for the calibration tool and for the first move after start-up (from the resting pulse, where the
 * 2019 software always left the servos), at the servos' top speed after that (the governor keeps well under it).
 */
export class ServoOutput {
  readonly #link: Pick<HardwareOutputs, 'servos'>;
  #calibration: Calibration | null;
  #mode: ServoMode = 'off';
  /** Pulses by channel: where they are, and where they are heading. */
  #current: number[] | null = null;
  #target: number[] | null = null;
  /** Use the slow rate until the current move is done (calibration moves, and the first move after start-up). */
  #slow = true;
  #sinceSendS = 0;
  #sent: string | null = null;
  #fault: string | null = null;

  constructor(link: Pick<HardwareOutputs, 'servos'>, calibration: Calibration | null) {
    this.#link = link;
    this.#calibration = calibration;
  }

  get calibration(): Calibration | null {
    return this.#calibration;
  }

  get state(): ServoState {
    return { mode: this.#mode, pulsesUs: this.#current ? [...this.#current] : null, calibrated: this.#calibration !== null, fault: this.#fault };
  }

  /** Where the servos are heading (by channel), or null when off. */
  get target(): readonly number[] | null {
    return this.#target;
  }

  setCalibration(calibration: Calibration | null): void {
    this.#calibration = calibration;
    if (!calibration && this.#mode === 'pose') this.off();
  }

  /** No pulses: the servos go limp. */
  off(): void {
    this.#mode = 'off';
    this.#current = null;
    this.#target = null;
    this.#sent = null;
    this.#link.servos(new Array<number>(SERVO_CHANNELS).fill(0));
  }

  /**
   * The calibration tool: drive channels 0–2 directly, each kept within the servos' travel, moving slowly. From off,
   * the first move starts at the resting pulse (where the 2019 software left the servos).
   */
  raw(pulsesUs: readonly number[]): void {
    if (pulsesUs.length !== SERVO_CHANNELS || pulsesUs.some((us) => !Number.isFinite(us))) {
      this.#fault = 'raw pulses must be three numbers';
      return;
    }
    this.#fault = null;
    this.#start();
    this.#mode = 'raw';
    this.#slow = true;
    this.#target = pulsesUs.map((us) => Math.min(SERVO_TRAVEL_US[1], Math.max(SERVO_TRAVEL_US[0], us)));
  }

  /** Normal use: horn angles (degrees, servo order) from the motion governor. */
  horns(hornDeg: Triple): void {
    const calibration = this.#calibration;
    // The last line of defence: nothing outside the measured ranges (the marks made when calibrating), whatever asks.
    const range = calibration?.rangeUs;
    if (!calibration || !range) {
      this.#fault = 'not calibrated: the servos stay where they are';
      return;
    }
    const bad = hornDeg.find((h) => !Number.isFinite(h));
    if (bad !== undefined) {
      this.#fault = `refused a horn angle of ${String(bad)}°: holding still`;
      return;
    }
    const perServo: Triple = [0, 1, 2].map((s) => pulseForHorn(calibration, s as 0 | 1 | 2, hornDeg[s as 0 | 1 | 2])) as unknown as Triple;
    const outside = perServo.findIndex((us, s) => us < range[s as 0 | 1 | 2][0] || us > range[s as 0 | 1 | 2][1]);
    if (outside >= 0) {
      // Holding everything still keeps the head where it is; moving the others alone would put it somewhere unplanned.
      this.#fault = `refused ${perServo[outside]!.toFixed(0)} µs for servo ${outside}: outside its measured range, holding still`;
      return;
    }
    this.#fault = null;
    if (this.#mode !== 'pose') {
      this.#start();
      this.#slow = true; // a calmer first move (from rest, or from where calibration ended)
      this.#mode = 'pose';
    }
    this.#target = channelPulses(calibration, perServo);
  }

  /** Moves toward the target and sends the pulses (at SEND_HZ). Call every frame. */
  update(dtS: number): void {
    if (!(dtS > 0) || !this.#current || !this.#target) return;
    const current = this.#current;
    const target = this.#target;
    const rate = this.#slow ? RAW_RATE_US_PER_S : (this.#calibration?.usPerDeg ?? 11.44) * MAX_SERVO_DEG_PER_S;
    const furthest = Math.max(...target.map((t, i) => Math.abs(t - (current[i] ?? t))));
    // Everyone moves the same fraction of their way, so they all arrive together.
    const fraction = furthest === 0 ? 1 : Math.min(1, (rate * Math.min(dtS, 0.1)) / furthest);
    this.#current = target.map((t, i) => {
      const from = current[i] ?? t;
      return fraction >= 1 ? t : from + (t - from) * fraction;
    });
    if (fraction >= 1 && this.#mode === 'pose') this.#slow = false;
    this.#sinceSendS += dtS;
    if (this.#sinceSendS >= 1 / SEND_HZ - 1e-9) {
      this.#sinceSendS = 0;
      const pulses = this.#current.map((us) => Math.round(us * 10) / 10);
      const key = pulses.join(' ');
      if (key !== this.#sent) {
        this.#sent = key;
        this.#link.servos(pulses);
      }
    }
  }

  /** Coming from off, the servos start from the resting pulse. */
  #start(): void {
    if (this.#current) return;
    this.#current = new Array<number>(SERVO_CHANNELS).fill(REST_US);
    this.#target = [...this.#current];
    this.#sinceSendS = 1; // send straight away
  }
}
