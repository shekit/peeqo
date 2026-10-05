import { DEFAULT_GEOMETRY, RAD_TO_DEG, SERVO_TO_CHANNEL, solveIk, type PlatformGeometry, type Pose, type ServoIndex, type Triple } from '@peeqo/core';

/**
 * How each servo's horn angle becomes the pulse that puts it there: pulse = levelUs + direction · usPerDeg · angle,
 * with the servo on its own PCA9685 channel. Found by the guided calibration (calibrationSession.ts), saved in the
 * robot's config. Servo order is the geometry's: 0 at the front, 1 at Peeqo's left (back left, seen from behind it),
 * 2 at Peeqo's right.
 */
export interface Calibration {
  readonly version: 1;
  /** PCA9685 channel driving each servo: channels 0–2, as wired in 2019. */
  readonly channels: Triple<number>;
  /** Which way the pulse moves for the horn to rise: +1 or −1. */
  readonly directions: Triple<1 | -1>;
  /** The pulse (µs) at which each horn would be level (0°). Level itself may be out of reach; it is a reference. */
  readonly levelUs: Triple<number>;
  /** Microseconds per degree of horn travel. */
  readonly usPerDeg: number;
  /** Whether usPerDeg was checked against a level (the tilt check). */
  readonly checked: boolean;
}

export const SERVO_NAMES: Triple<string> = ['front', "Peeqo's left", "Peeqo's right"];

/** Where the 2019 software put every servo at start-up and after every animation, on this very robot. */
export const REST_US = 1500;

/**
 * Before calibration, the best guess: the 2019 software's mapping (ServoSimulator/Platform.pde: servo angle = 90° −
 * horn angle, 0–180° over 500–2560 µs, so the pulse falls as the horn rises, 11.44 µs per degree, level at 1530 µs)
 * and its channel order (servo.ts SERVO_TO_CHANNEL).
 */
export const PRIOR_CALIBRATION: Calibration = Object.freeze<Calibration>({
  version: 1,
  channels: SERVO_TO_CHANNEL,
  directions: [-1, -1, -1],
  levelUs: [1530, 1530, 1530],
  usPerDeg: 2060 / 180,
  checked: false,
});

/**
 * Horn angles the real robot keeps to (the motion governor's limits on the robot, and calibration's pose moves): off
 * the servo holders, which the horns near at about +1°, with room for calibration error; and below the neck's top.
 */
export const HORN_RANGE_DEG = [5, 55] as const;

/** Bounds a saved calibration must fall within (anything else is a damaged file, not a robot). */
const LEVEL_US_RANGE = [1000, 2100] as const;
const US_PER_DEG_RANGE = [8, 15] as const;

/** Horn angles (degrees, servo order) for a pose. Throws for a pose the neck cannot reach. */
export function hornAngles(pose: Pose, geometry: PlatformGeometry = DEFAULT_GEOMETRY): Triple {
  const ik = solveIk(pose, geometry);
  if (!ik.reachable) throw new Error('That pose is out of reach');
  return [ik.legs[0].hornRad * RAD_TO_DEG, ik.legs[1].hornRad * RAD_TO_DEG, ik.legs[2].hornRad * RAD_TO_DEG];
}

export function pulseForHorn(calibration: Calibration, servo: ServoIndex, hornDeg: number): number {
  return calibration.levelUs[servo] + calibration.directions[servo] * calibration.usPerDeg * hornDeg;
}

/** The horn angle a pulse puts a servo at. */
export function hornForPulse(calibration: Calibration, servo: ServoIndex, pulseUs: number): number {
  return (pulseUs - calibration.levelUs[servo]) / (calibration.directions[servo] * calibration.usPerDeg);
}

/** Pulses by channel (index = PCA9685 channel 0–2). */
export function channelPulses(calibration: Calibration, perServoUs: Triple): number[] {
  const pulses = [0, 0, 0];
  for (const servo of [0, 1, 2] as const) pulses[calibration.channels[servo]] = perServoUs[servo];
  return pulses;
}

/**
 * The calibration after moving the head by `move` from where commanding `at` puts it: each level pulse shifts so
 * that commanding `at` gives the horn angles of `at + move`. (The level step: "tilt back a little".)
 */
export function trimmed(calibration: Calibration, at: Pose, move: Pose, geometry: PlatformGeometry = DEFAULT_GEOMETRY): Calibration {
  const now = hornAngles(at, geometry);
  const before = hornAngles({ pitchDeg: at.pitchDeg - move.pitchDeg, rollDeg: at.rollDeg - move.rollDeg, heaveMm: at.heaveMm - move.heaveMm }, geometry);
  const levelUs = [0, 1, 2].map((s) => {
    const servo = s as ServoIndex;
    return calibration.levelUs[servo] + calibration.directions[servo] * calibration.usPerDeg * (now[servo] - before[servo]);
  }) as unknown as Triple;
  return { ...calibration, levelUs };
}

/**
 * The tilt check: Peeqo was asked to tilt by `askedDeg` and a level showed `measuredDeg`. The servos turn
 * askedDeg / measuredDeg times as far per microsecond as assumed, so usPerDeg scales by that. Refuses readings that
 * are off by more than a quarter (more likely a misreading than a different servo).
 */
export function rescaled(calibration: Calibration, askedDeg: number, measuredDeg: number): Calibration | null {
  const ratio = askedDeg / measuredDeg;
  if (!Number.isFinite(ratio) || ratio < 0.8 || ratio > 1.25) return null;
  return { ...calibration, usPerDeg: calibration.usPerDeg * ratio, checked: true };
}

/** A rescale that keeps the pulses at `at` unchanged (so the head stays put when the scale is corrected). */
export function rescaledAround(calibration: Calibration, at: Pose, askedDeg: number, measuredDeg: number, geometry: PlatformGeometry = DEFAULT_GEOMETRY): Calibration | null {
  const scaled = rescaled(calibration, askedDeg, measuredDeg);
  if (!scaled) return null;
  const horns = hornAngles(at, geometry);
  const levelUs = [0, 1, 2].map((s) => {
    const servo = s as ServoIndex;
    const pulse = pulseForHorn(calibration, servo, horns[servo]);
    return pulse - scaled.directions[servo] * scaled.usPerDeg * horns[servo];
  }) as unknown as Triple;
  return { ...scaled, levelUs };
}

/** A calibration read back from the config, or null if it is missing or not believable. */
export function parseCalibration(value: unknown): Calibration | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const triple = (v: unknown, ok: (x: unknown) => boolean): boolean => Array.isArray(v) && v.length === 3 && v.every(ok);
  const channels = c.channels;
  if (c.version !== 1) return null;
  if (!triple(channels, (x) => x === 0 || x === 1 || x === 2) || new Set(channels as number[]).size !== 3) return null;
  if (!triple(c.directions, (x) => x === 1 || x === -1)) return null;
  if (!triple(c.levelUs, (x) => typeof x === 'number' && x >= LEVEL_US_RANGE[0] && x <= LEVEL_US_RANGE[1])) return null;
  if (!(typeof c.usPerDeg === 'number' && c.usPerDeg >= US_PER_DEG_RANGE[0] && c.usPerDeg <= US_PER_DEG_RANGE[1])) return null;
  return {
    version: 1,
    channels: channels as unknown as Triple<number>,
    directions: c.directions as unknown as Triple<1 | -1>,
    levelUs: c.levelUs as unknown as Triple,
    usPerDeg: c.usPerDeg,
    checked: c.checked === true,
  };
}
