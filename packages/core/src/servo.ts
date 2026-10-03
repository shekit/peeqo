import { mapTriple, type ServoIndex, type Triple } from './math.ts';

/**
 * How horn angles become servo commands, as in the 2019 ServoSimulator (Platform.pde):
 * servo angle = 90° − horn angle, and 0–180° is spread linearly over 500–2560 µs.
 * Not yet confirmed for the dev kit: before driving it, measure for each servo which pulse puts its horn level
 * and which way it turns.
 */
export interface PulseRange {
  readonly at0DegUs: number;
  readonly at180DegUs: number;
}

export const LEGACY_PULSE_RANGE: PulseRange = Object.freeze({ at0DegUs: 500, at180DegUs: 2560 });

export function hornDegToServoDeg(hornDeg: number): number {
  return 90 - hornDeg;
}

export function servoDegToHornDeg(servoDeg: number): number {
  return 90 - servoDeg;
}

export function servoDegToPulseUs(servoDeg: number, range: PulseRange = LEGACY_PULSE_RANGE): number {
  return range.at0DegUs + (servoDeg / 180) * (range.at180DegUs - range.at0DegUs);
}

export function pulseUsToServoDeg(pulseUs: number, range: PulseRange = LEGACY_PULSE_RANGE): number {
  return ((pulseUs - range.at0DegUs) / (range.at180DegUs - range.at0DegUs)) * 180;
}

export function hornDegToPulseUs(hornDeg: number, range: PulseRange = LEGACY_PULSE_RANGE): number {
  return servoDegToPulseUs(hornDegToServoDeg(hornDeg), range);
}

/**
 * PCA9685 channel wired to each servo (index = servo number). From ServoSimulator/format_anim_json.js, whose
 * transformation marked "THIS IS THE RIGHT TRANSFORMATION" swaps the first two servos.
 */
export const SERVO_TO_CHANNEL: Triple<ServoIndex> = [1, 0, 2];

function assertPermutation(map: Triple<ServoIndex>): void {
  if (new Set(map).size !== 3) throw new Error(`Servo-to-channel map must use each channel once, got [${map.join(', ')}]`);
}

/** Reorders per-servo values into PCA9685 channel order (result[channel]). */
export function servoToChannelOrder<T>(perServo: Triple<T>, map: Triple<ServoIndex> = SERVO_TO_CHANNEL): Triple<T> {
  assertPermutation(map);
  const servoOnChannel = (channel: ServoIndex): ServoIndex => (map[0] === channel ? 0 : map[1] === channel ? 1 : 2);
  return [perServo[servoOnChannel(0)], perServo[servoOnChannel(1)], perServo[servoOnChannel(2)]];
}

/** Reorders per-channel values (result[servo]) back into servo order. */
export function channelToServoOrder<T>(perChannel: Triple<T>, map: Triple<ServoIndex> = SERVO_TO_CHANNEL): Triple<T> {
  assertPermutation(map);
  return mapTriple(map, (channel) => perChannel[channel]);
}
