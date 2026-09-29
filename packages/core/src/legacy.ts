import { PEEQO_2019_GEOMETRY, type PlatformGeometry } from './geometry.ts';
import { solveFk, type Pose } from './kinematics.ts';
import { DEG_TO_RAD, mapTriple, type Triple } from './math.ts';
import { channelToServoOrder, pulseUsToServoDeg } from './servo.ts';

/** Frame period of the 2019 servo animations (playbackRate in electron/app/js/senses/servo.js). */
export const LEGACY_FRAME_MS = 33;

/**
 * Horn angle (degrees) for a pulse recorded by the 2019 ServoSimulator.
 *
 * The simulator truncated the servo angle to whole degrees before converting it to microseconds, so each
 * recorded pulse stands for a 1° band of horn angles, (89 − k, 90 − k] for recorded servo degree k.
 * This returns the middle of that band.
 */
export function legacyPulseToHornDeg(pulseUs: number): number {
  const recordedServoDeg = Math.round(pulseUsToServoDeg(pulseUs));
  return 89.5 - recordedServoDeg;
}

/**
 * The pulse the 2019 ServoSimulator would have recorded for a horn angle. Reproduces Platform.pde exactly,
 * including Processing's 32-bit float map() and int() truncation.
 */
export function legacyHornDegToPulse(hornDeg: number): number {
  const recordedServoDeg = Math.trunc(hornDeg <= 0 ? 90 + Math.abs(hornDeg) : 90 - hornDeg);
  const f = Math.fround;
  const fraction = f(f(recordedServoDeg) / f(180));
  return Math.trunc(f(500 + f(f(2060) * fraction)));
}

/** One 2019 animation frame: pulse widths in PCA9685 channel order [ch0, ch1, ch2]. */
export type LegacyFrame = Triple;

/** Checks and normalises the contents of a 2019 servo animation file (electron/app/media/servo_anims/*.json). */
export function parseLegacyAnimation(json: unknown, name = 'animation'): LegacyFrame[] {
  if (!Array.isArray(json) || json.length === 0) throw new Error(`${name}: expected a non-empty array of frames`);
  return json.map((frame: unknown, index): LegacyFrame => {
    if (
      !Array.isArray(frame) ||
      frame.length !== 3 ||
      !frame.every((v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 500 && v <= 2560)
    ) {
      throw new Error(`${name}: frame ${index} must be three pulse widths between 500 and 2560 µs, got ${JSON.stringify(frame)}`);
    }
    return [frame[0] as number, frame[1] as number, frame[2] as number];
  });
}

/** Horn angles in radians, servo order, for one 2019 frame. */
export function legacyFrameToHornRad(frame: LegacyFrame): Triple {
  return mapTriple(channelToServoOrder(frame), (pulse) => legacyPulseToHornDeg(pulse) * DEG_TO_RAD);
}

/** Converts a 2019 animation into head poses, one per 33 ms frame. Throws if a frame has no matching pose. */
export function legacyAnimationToPoses(
  frames: readonly LegacyFrame[],
  geometry: PlatformGeometry = PEEQO_2019_GEOMETRY,
  name = 'animation',
): Pose[] {
  const poses: Pose[] = [];
  let previous: Pose | undefined;
  frames.forEach((frame, index) => {
    const pose = solveFk(legacyFrameToHornRad(frame), geometry, previous ? { initial: previous } : {});
    if (pose === null) throw new Error(`${name}: frame ${index} (${frame.join(', ')} µs) matches no reachable pose`);
    poses.push(pose);
    previous = pose;
  });
  return poses;
}
