/** Small fixed-size vector and matrix helpers for the kinematics. */

export type Triple<T = number> = readonly [T, T, T];
export type Vec3 = Triple<number>;
/** Row-major 3×3 matrix. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export type ServoIndex = 0 | 1 | 2;
export const SERVO_INDICES: Triple<ServoIndex> = [0, 1, 2];

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

export function mapTriple<T, U>(t: Triple<T>, fn: (value: T, index: ServoIndex) => U): Triple<U> {
  return [fn(t[0], 0), fn(t[1], 1), fn(t[2], 2)];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** R = Rz(rz) · Ry(ry) · Rx(rx): the rotation the 2019 ServoSimulator applies in Platform.pde (calcQ). */
export function rotationZYX(rx: number, ry: number, rz: number): Mat3 {
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

export function mulMat3Vec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function det3(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** Solves A·x = b by Cramer's rule. Returns null when A is singular or badly conditioned. */
export function solve3(a: Mat3, b: Vec3): Vec3 | null {
  const d = det3(a);
  const rowNorms =
    Math.hypot(a[0], a[1], a[2]) * Math.hypot(a[3], a[4], a[5]) * Math.hypot(a[6], a[7], a[8]);
  if (!Number.isFinite(d) || rowNorms === 0 || Math.abs(d) < 1e-12 * rowNorms) return null;
  const x = det3([b[0], a[1], a[2], b[1], a[4], a[5], b[2], a[7], a[8]]) / d;
  const y = det3([a[0], b[0], a[2], a[3], b[1], a[5], a[6], b[2], a[8]]) / d;
  const z = det3([a[0], a[1], b[0], a[3], a[4], b[1], a[6], a[7], b[2]]) / d;
  return [x, y, z];
}
