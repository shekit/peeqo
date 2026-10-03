import type { Triple } from './math.ts';

/**
 * Dimensions of Peeqo's neck: three servos on the base, each turning a horn that pushes a leg up to the
 * platform the head sits on (a rotary 3-RSS platform).
 *
 * Frame used everywhere in the core: +X forward (the way the face looks), +Y Peeqo's left, +Z up,
 * millimetres. The origin is the centre of the horizontal plane that contains the three servo shafts.
 */
export interface PlatformGeometry {
  /** Distance from the centre to the point where each servo shaft crosses its horn's plane. */
  readonly baseRadiusMm: number;
  /** Distance from the platform centre to each leg's upper ball joint. */
  readonly platformRadiusMm: number;
  /** Horn length, from the shaft axis to the horn's joint with the leg. */
  readonly hornLengthMm: number;
  /** Leg length, from the horn joint to the upper ball joint. */
  readonly legLengthMm: number;
  /** Height of the upper ball joints above the shaft plane at the home pose. */
  readonly homeHeightMm: number;
  /** Where each servo sits around the base, degrees from +X toward +Y. Index = servo number. */
  readonly baseAnglesDeg: Triple;
  /** Where each leg attaches around the platform, degrees from +X toward +Y. */
  readonly platformAnglesDeg: Triple;
  /** Horizontal direction each horn points when level, degrees from +X toward +Y. */
  readonly hornAnglesDeg: Triple;
}

/**
 * The 2019 dev kit, measured from its Fusion 360 assembly (peeqo-assembly.stp): servo shafts 27.32 mm from
 * the centre and 42 mm above the table; legs pinned to the custom horns 7 mm from the shaft; ball joints
 * 34.32 mm from the centre and 100.1 mm above the table. At home every horn is level and every leg vertical.
 * apps/sim/tools/build-model.mjs re-measures these from the CAD and fails if they drift.
 */
export const DEV_KIT_GEOMETRY: PlatformGeometry = Object.freeze<PlatformGeometry>({
  baseRadiusMm: 27.32,
  platformRadiusMm: 34.32,
  hornLengthMm: 7,
  legLengthMm: 58.1,
  homeHeightMm: 58.1,
  baseAnglesDeg: [0, 120, 240],
  platformAnglesDeg: [0, 120, 240],
  hornAnglesDeg: [0, 120, 240],
});

/**
 * The geometry in the 2019 ServoSimulator (ServoSimulator/Platform.pde), which recorded the 2019 servo
 * animations. It is a different, larger neck than the dev kit; kept to decode and test against that sketch.
 */
export const SERVO_SIMULATOR_2019_GEOMETRY: PlatformGeometry = Object.freeze<PlatformGeometry>({
  baseRadiusMm: 65,
  platformRadiusMm: 85,
  hornLengthMm: 13,
  legLengthMm: 125,
  homeHeightMm: 125,
  baseAnglesDeg: [0, 120, 240],
  platformAnglesDeg: [0, 120, 240],
  hornAnglesDeg: [0, 120, 240],
});

/** The geometry everything uses unless told otherwise: the real robot. */
export const DEFAULT_GEOMETRY = DEV_KIT_GEOMETRY;
