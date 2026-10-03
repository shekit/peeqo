import type { PlatformGeometry } from './geometry.ts';
import type { IkSolution, Pose } from './kinematics.ts';
import { DEG_TO_RAD, RAD_TO_DEG, mapTriple, SERVO_INDICES, type Mat3, type ServoIndex, type Triple } from './math.ts';

/** Joint values of one leg, degrees. */
export interface LegJoints {
  /** Horn angle (+ lifts the leg's pin). */
  readonly hornDeg: number;
  /** Leg swing about its horn pin, from vertical (+ tips its top outward). */
  readonly legDeg: number;
  /** The leg relative to the platform at its rod end: swing about the screw (free)… */
  readonly rodSwingDeg: number;
  /** …tilt about the radial axis… */
  readonly rodTiltDeg: number;
  /** …and twist about the leg. */
  readonly rodTwistDeg: number;
}

const rotZ = (rad: number): Mat3 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
const rotY = (rad: number): Mat3 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
function mul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
    }
  }
  return r as unknown as Mat3;
}

/**
 * Joint values for every leg at a solved pose. The leg is taken in its pin's plane (the pin only lets it
 * swing there); the rod-end values are the YXZ Euler angles of the leg relative to the platform, in the
 * leg's own axes (x outward, y along the screw, z along the leg).
 */
export function legJoints(ik: IkSolution, geometry: PlatformGeometry): Triple<LegJoints> {
  return mapTriple(SERVO_INDICES, (k) => {
    const leg = ik.legs[k];
    const yaw = geometry.baseAnglesDeg[k] * DEG_TO_RAD;
    const dx = leg.platformJoint[0] - leg.hornTip[0];
    const dy = leg.platformJoint[1] - leg.hornTip[1];
    const dz = leg.platformJoint[2] - leg.hornTip[2];
    const outward = Math.cos(yaw) * dx + Math.sin(yaw) * dy;
    const lambda = Math.atan2(outward, dz);
    // Leg relative to the platform, both seen from the leg's yawed axes.
    const rel = mul(mul(mul(rotZ(-yaw), transpose(ik.rotation)), rotZ(yaw)), rotY(lambda));
    const tilt = Math.asin(Math.max(-1, Math.min(1, -rel[5])));
    return {
      hornDeg: leg.hornRad * RAD_TO_DEG,
      legDeg: lambda * RAD_TO_DEG,
      rodSwingDeg: Math.atan2(rel[2], rel[8]) * RAD_TO_DEG,
      rodTiltDeg: tilt * RAD_TO_DEG,
      rodTwistDeg: Math.atan2(rel[3], rel[4]) * RAD_TO_DEG,
    };
  });
}

// ---------- tables ----------

interface Table1Data {
  readonly start: number;
  readonly step: number;
  readonly n: number;
  readonly cells: string;
}
interface Table2Data {
  readonly startA: number;
  readonly stepA: number;
  readonly na: number;
  readonly startB: number;
  readonly stepB: number;
  readonly nb: number;
  readonly cells: string;
}
/** Shape of the generated data (see devKitClearance.ts). */
export interface ClearanceData {
  readonly modelSha256: string;
  readonly marginMm: number;
  readonly legAnglesDeg: readonly number[];
  /** The neck dimensions the tables were computed for. */
  readonly geometry?: Readonly<Record<string, number>>;
  readonly maxTwistDeg: number;
  readonly horn: readonly Table1Data[];
  readonly legStatic: readonly Table2Data[];
  readonly hornPair: readonly Table2Data[];
  readonly legPlatform: readonly Table2Data[];
  readonly cover: { readonly pitch: readonly number[]; readonly roll: readonly number[]; readonly heave: readonly number[]; readonly bits: string };
  readonly verifiedMm: Readonly<Record<string, number>>;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = BASE64.indexOf(ch);
    if (v < 0) throw new Error('Clearance data is not valid base64');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}
/** Cells are little-endian int16, hundredths of a millimetre. */
function decodeCells(text: string): Float64Array {
  const bytes = decodeBase64(text);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cells = new Float64Array(bytes.byteLength / 2);
  for (let i = 0; i < cells.length; i++) cells[i] = view.getInt16(i * 2, true) / 100;
  return cells;
}

class Table1 {
  readonly #d: Table1Data;
  readonly #cells: Float64Array;
  constructor(d: Table1Data) {
    this.#d = d;
    this.#cells = decodeCells(d.cells);
    if (this.#cells.length !== d.n - 1) throw new Error('Clearance table has the wrong number of cells');
  }
  /** Guaranteed clearance anywhere in the cell containing x; -Infinity outside the table. */
  at(x: number): number {
    const i = Math.floor((x - this.#d.start) / this.#d.step);
    return Number.isFinite(x) && i >= 0 && i < this.#cells.length ? this.#cells[i]! : Number.NEGATIVE_INFINITY;
  }
}
class Table2 {
  readonly #d: Table2Data;
  readonly #cells: Float64Array;
  constructor(d: Table2Data) {
    this.#d = d;
    this.#cells = decodeCells(d.cells);
    if (this.#cells.length !== (d.na - 1) * (d.nb - 1)) throw new Error('Clearance table has the wrong number of cells');
  }
  at(a: number, b: number): number {
    const i = Math.floor((a - this.#d.startA) / this.#d.stepA);
    const j = Math.floor((b - this.#d.startB) / this.#d.stepB);
    if (!Number.isFinite(a) || !Number.isFinite(b) || i < 0 || j < 0 || i >= this.#d.na - 1 || j >= this.#d.nb - 1) {
      return Number.NEGATIVE_INFINITY;
    }
    return this.#cells[i * (this.#d.nb - 1) + j]!;
  }
}

export interface ClearanceReading {
  /** Smallest guaranteed gap between any two parts at this pose, mm (-Infinity if outside the checked range). */
  readonly minMm: number;
  /** Which parts that gap is between. */
  readonly between: string;
}

/**
 * Collision clearance for one robot model, from tables computed offline from its CAD meshes
 * (apps/sim/tools/build-clearance.mjs). Every value is a guaranteed lower bound on the real gap.
 */
export class ClearanceModel {
  readonly marginMm: number;
  readonly maxTwistDeg: number;
  readonly modelSha256: string;
  readonly verifiedMm: Readonly<Record<string, number>>;
  readonly #legAnglesDeg: readonly number[];
  readonly #geometry: Readonly<Record<string, number>> | undefined;
  readonly #horn: Table1[];
  readonly #legStatic: Table2[];
  readonly #legPlatform: Table2[];
  readonly #hornPair: Table2[];
  readonly #cover: ClearanceData['cover'];
  readonly #coverBits: Uint8Array;

  constructor(data: ClearanceData) {
    this.marginMm = data.marginMm;
    this.maxTwistDeg = data.maxTwistDeg;
    this.modelSha256 = data.modelSha256;
    this.verifiedMm = data.verifiedMm;
    this.#legAnglesDeg = data.legAnglesDeg;
    this.#geometry = data.geometry;
    this.#horn = data.horn.map((d) => new Table1(d));
    this.#legStatic = data.legStatic.map((d) => new Table2(d));
    this.#legPlatform = data.legPlatform.map((d) => new Table2(d));
    this.#hornPair = data.hornPair.map((d) => new Table2(d));
    this.#cover = data.cover;
    this.#coverBits = decodeBase64(data.cover.bits);
    if (this.#horn.length !== 3 || this.#legStatic.length !== 3 || this.#legPlatform.length !== 3 || this.#hornPair.length !== 3) {
      throw new Error('Clearance data must have tables for all three legs');
    }
  }

  /** True if these tables were made for this geometry. */
  fits(geometry: PlatformGeometry): boolean {
    const anglesMatch = SERVO_INDICES.every(
      (k) =>
        Math.abs(geometry.baseAnglesDeg[k] - (this.#legAnglesDeg[k] ?? Number.NaN)) < 1e-9 &&
        geometry.platformAnglesDeg[k] === geometry.baseAnglesDeg[k] &&
        geometry.hornAnglesDeg[k] === geometry.baseAnglesDeg[k],
    );
    const dims = this.#geometry;
    const dimsMatch =
      dims === undefined ||
      (['baseRadiusMm', 'platformRadiusMm', 'hornLengthMm', 'legLengthMm', 'homeHeightMm'] as const).every(
        (key) => Math.abs((dims[key] ?? Number.NaN) - geometry[key]) < 1e-9,
      );
    return anglesMatch && dimsMatch;
  }

  /** Whether the pair checks (head ↔ base, leg ↔ other legs, …) were verified around this pose. */
  covers(pose: Pose): boolean {
    const p = Math.round(pose.pitchDeg);
    const r = Math.round(pose.rollDeg);
    const h = Math.round(pose.heaveMm);
    const c = this.#cover;
    const [p0, p1] = c.pitch as [number, number];
    const [r0, r1] = c.roll as [number, number];
    const [h0, h1] = c.heave as [number, number];
    if (!(p >= p0 && p <= p1 && r >= r0 && r <= r1 && h >= h0 && h <= h1)) return false;
    const index = ((p - p0) * (r1 - r0 + 1) + (r - r0)) * (h1 - h0 + 1) + (h - h0);
    return ((this.#coverBits[index >> 3]! >> (index & 7)) & 1) === 1;
  }

  /** Smallest guaranteed clearance at a pose with these joint values. */
  read(pose: Pose, joints: Triple<LegJoints>): ClearanceReading {
    let minMm = Number.POSITIVE_INFINITY;
    let between = '';
    const consider = (mm: number, what: string) => {
      if (mm < minMm || Number.isNaN(mm)) {
        minMm = Number.isNaN(mm) ? Number.NEGATIVE_INFINITY : mm;
        between = what;
      }
    };
    if (!this.covers(pose)) consider(Number.NEGATIVE_INFINITY, 'outside the poses checked for collisions');
    for (const k of SERVO_INDICES) {
      const j = joints[k];
      consider(this.#horn[k]!.at(j.hornDeg), `horn ${k} and the base`);
      consider(this.#legStatic[k]!.at(j.hornDeg, j.legDeg), `leg ${k} and the base`);
      if (Math.abs(j.rodTwistDeg) > this.maxTwistDeg) consider(Number.NEGATIVE_INFINITY, `rod end ${k} twisted beyond the checked range`);
      consider(this.#legPlatform[k]!.at(j.rodSwingDeg, j.rodTiltDeg), `leg ${k} and the platform`);
    }
    const pairs: Triple<readonly [ServoIndex, ServoIndex]> = [[0, 1], [1, 2], [2, 0]];
    pairs.forEach(([a, b], i) => consider(this.#hornPair[i]!.at(joints[a].hornDeg, joints[b].hornDeg), `horns ${a} and ${b}`));
    return { minMm, between };
  }
}
