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
  /** Horn length, from the shaft axis to the horn's ball joint. */
  readonly hornLengthMm: number;
  /** Leg length, between its two ball joints. */
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
 * The geometry in the 2019 ServoSimulator (ServoSimulator/Platform.pde, under "REAL MEASUREMENTS"), which
 * recorded every 2019 servo animation. Not yet checked against a physical dev kit.
 */
export const PEEQO_2019_GEOMETRY: PlatformGeometry = Object.freeze<PlatformGeometry>({
  baseRadiusMm: 65,
  platformRadiusMm: 85,
  hornLengthMm: 13,
  legLengthMm: 125,
  homeHeightMm: 125,
  baseAnglesDeg: [0, 120, 240],
  platformAnglesDeg: [0, 120, 240],
  hornAnglesDeg: [0, 120, 240],
});
