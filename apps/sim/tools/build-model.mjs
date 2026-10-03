// Builds the simulator's robot model from the dev kit's Fusion 360 assembly.
//
//   npm run build:model -w @peeqo/sim -- <path/to/peeqo-assembly.stp> [output.glb]
//
// Every part of the assembly is kept and attached to the rigid body it moves with:
//   static      table frame (origin on the table under the centre)
//   horn-<k>    leg k's custom horn and servo hubs; origin on its servo shaft, axes: x outward, y along the
//               shaft, z up. Turns about +y.
//   leg-<k>     leg k's two arms and rod-end eye; origin on its horn pin (at home), same axes. Swings about +y.
//   platform    plates, head, top, LED ring, rod-end balls; origin at the centre of the ball-joint plane.
// All frames: +X forward, +Y Peeqo's left, +Z up, millimetres. Leg k sits at 120°·k around the centre.
//
// Structural parts are assigned by name. Fasteners and connectors are assigned by contact: a part touching a
// body (within 0.3 mm) joins it, repeatedly, so a nut on a screw follows the screw. Parts that touch nothing
// are loose in the CAD (they float outside the robot in Fusion too) and are left out and listed.
// The CAD has only one servo and two rod ends; the missing ones are copied from another leg and say so.
// The joint positions are re-measured and must match DEV_KIT_GEOMETRY in packages/core, or this script fails.
// Fusion exports no part colours, so the palette below is ours.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import occtimportjs from 'occt-import-js';
import { Document, NodeIO } from '@gltf-transform/core';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { DEV_KIT_GEOMETRY } from '../../../packages/core/src/geometry.ts';
import { DEFAULT_SAFETY_LIMITS } from '../../../packages/core/src/limits.ts';

const [stepPath, outArg] = process.argv.slice(2);
if (!stepPath) {
  console.error('Usage: node tools/build-model.mjs <peeqo-assembly.stp> [output.glb]');
  process.exit(1);
}
const outPath = outArg ?? fileURLToPath(new URL('../src/assets/peeqo-devkit.glb', import.meta.url));
const fail = (message) => {
  console.error(`build-model: ${message}`);
  process.exit(1);
};

const occt = await occtimportjs();
const result = occt.ReadStepFile(new Uint8Array(fs.readFileSync(stepPath)), {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.0008,
  angularDeflection: 0.5,
});
if (!result.success) fail('OpenCascade could not read the STEP file');
const assembly = result.root.children?.[0];
if (!assembly?.children?.length) fail('no assembly found in the STEP file');

// ---------- geometry helpers (CAD frame: +Y up, +Z front, +X Peeqo's left) ----------
// Fusion's export puts stray control characters in some names (e.g. "Unáša\rč").
const clean = (text) => (text ?? '').replace(/[\u0000-\u001f]/g, '').normalize('NFC').replace(/\s+v\d+$/, '').trim();
function bounds(meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const p = m.attributes.position.array;
    for (let k = 0; k < p.length; k += 3) for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[k + a]);
      max[a] = Math.max(max[a], p[k + a]);
    }
  }
  return { min, max, center: min.map((v, a) => (v + max[a]) / 2) };
}
function faces(mesh) {
  const p = mesh.attributes.position.array;
  const idx = mesh.index.array;
  return mesh.brep_faces.map((f) => {
    const set = new Set();
    for (let t = f.first; t <= f.last; t++) for (let k = 0; k < 3; k++) set.add(idx[3 * t + k]);
    return [...set].map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]);
  });
}
function solve(A, B) {
  const n = B.length;
  const a = A.map((row) => [...row]);
  const b = [...B];
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    [b[i], b[pivot]] = [b[pivot], b[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r][i] / a[i][i];
      for (let c = i; c < n; c++) a[r][c] -= f * a[i][c];
      b[r] -= f * b[i];
    }
  }
  return b.map((v, i) => v / a[i][i]);
}
function fitCylinder(points, axis) {
  const [u, v] = [0, 1, 2].filter((a) => a !== axis);
  const rows = points.map((p) => [2 * p[u], 2 * p[v], 1]);
  const rhs = points.map((p) => p[u] ** 2 + p[v] ** 2);
  const AtA = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const Atb = [0, 1, 2].map((i) => rows.reduce((s, r, k) => s + r[i] * rhs[k], 0));
  const [cu, cv, k] = solve(AtA, Atb);
  const r = Math.sqrt(k + cu * cu + cv * cv);
  const residual = Math.max(...points.map((p) => Math.abs(Math.hypot(p[u] - cu, p[v] - cv) - r)));
  const along = points.map((p) => p[axis]);
  return { cu, cv, r, residual, extent: Math.max(...along) - Math.min(...along) };
}
function fitSphere(points) {
  const rows = points.map((p) => [2 * p[0], 2 * p[1], 2 * p[2], 1]);
  const rhs = points.map((p) => p[0] ** 2 + p[1] ** 2 + p[2] ** 2);
  const AtA = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const Atb = [0, 1, 2, 3].map((i) => rows.reduce((s, r, k) => s + r[i] * rhs[k], 0));
  const [a, b, c, k] = solve(AtA, Atb);
  const r = Math.sqrt(k + a * a + b * b + c * c);
  const residual = Math.max(...points.map((p) => Math.abs(Math.hypot(p[0] - a, p[1] - b, p[2] - c) - r)));
  return { center: [a, b, c], r, residual };
}
/** Cylindrical faces whose axis runs along CAD X with the given radius; returns axis positions (y, z). */
function xCylinders(mesh, radius) {
  const found = [];
  for (const pts of faces(mesh)) {
    if (pts.length < 8) continue;
    const c = fitCylinder(pts, 0);
    if (c.residual < 0.02 && Math.abs(c.r - radius) < 0.02 && c.extent > 0.3) found.push({ y: c.cu, z: c.cv });
  }
  return found;
}
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------- parts ----------
const LEG_ANGLES = [0, 120, 240];
/** Robot-frame angle (degrees, from +X toward +Y) of a CAD point: Peeqo X = CAD z, Y = CAD x. */
const angleOf = (c) => (Math.atan2(c[0], c[2]) * 180) / Math.PI;
const nearestLeg = (c) => {
  const a = ((angleOf(c) % 360) + 360) % 360;
  let best = 0;
  for (const k of [0, 1, 2]) {
    const d = Math.abs(((a - LEG_ANGLES[k] + 540) % 360) - 180);
    if (d < Math.abs(((a - LEG_ANGLES[best] + 540) % 360) - 180)) best = k;
  }
  return best;
};

/** Every mesh of the assembly as a part: { id, name, mesh, body, role, leg }. */
const parts = [];
for (const node of assembly.children) {
  for (const i of node.meshes) {
    parts.push({ id: i, name: clean(node.name), sub: clean(result.meshes[i].name), mesh: result.meshes[i], body: null, role: null });
  }
}
const assign = (part, body, role = null) => {
  part.body = body;
  part.role = role;
};
const startsWith = (part, prefix) => part.name.startsWith(prefix);
const servoParts = parts.filter((p) => startsWith(p, 'servo') && !startsWith(p, 'servo-horn'));
const servoNames = new Set(servoParts.map((p) => p.sub));
for (const required of ['Telo', 'Hriadel', 'Kolečko', 'Unášač', 'center-screw-head']) {
  if (!servoNames.has(required)) fail(`servo has no "${required}" body`);
}
const servoLeg = nearestLeg(bounds(servoParts.map((p) => p.mesh)).center);
for (const p of parts) {
  const c = bounds([p.mesh]).center;
  if (startsWith(p, 'base') || startsWith(p, 'cloth-ring') || startsWith(p, 'Servoholder') || startsWith(p, 'circuit-servo')) assign(p, 'static');
  else if (servoParts.includes(p)) {
    if (p.sub === 'Telo') assign(p, 'static', 'servo-body');
    // The output hub, rear wheel, shaft and hub screw turn with the custom horn fastened to them.
    else assign(p, `horn-${servoLeg}`, 'servo-hub');
  } else if (startsWith(p, 'servo-horn-custom-alt')) assign(p, `horn-${nearestLeg(c)}`);
  else if (startsWith(p, 'servo-horn-custom-fin')) assign(p, `leg-${nearestLeg(c)}`);
  else if (startsWith(p, 'top-platform') || startsWith(p, 'head') || startsWith(p, 'top-head')) assign(p, 'platform');
  else if (startsWith(p, 'led-ring')) assign(p, 'platform', 'led-ring');
}
// Rod ends: the eye (socket body) swings with the leg; the ball is clamped to the platform.
for (const name of new Set(parts.filter((p) => startsWith(p, 'ball-socket')).map((p) => p.name))) {
  const group = parts.filter((p) => p.name === name);
  for (const nodePart of [...new Set(group)]) void nodePart;
}
for (const node of assembly.children.filter((n) => clean(n.name).startsWith('ball-socket'))) {
  const meshes = node.meshes.map((i) => parts.find((p) => p.id === i));
  const [eye, ball] = [...meshes].sort((a, b) => b.mesh.attributes.position.array.length - a.mesh.attributes.position.array.length);
  const leg = nearestLeg(bounds([eye.mesh]).center);
  assign(eye, `leg-${leg}`, 'rod-end-eye');
  assign(ball, 'platform', 'rod-end-ball');
  ball.leg = leg;
}

// ---------- fasteners and connectors: attach by contact ----------
const geometryOf = (meshList) => {
  const positions = [];
  const indices = [];
  for (const m of meshList) {
    const offset = positions.length / 3;
    positions.push(...m.attributes.position.array);
    for (const v of m.index.array) indices.push(v + offset);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  return g;
};
const TOUCH_MM = 0.3;
const identity = new THREE.Matrix4();
const distance = (bvh, geometry, limit) => {
  const hit = bvh.closestPointToGeometry(geometry, identity, {}, {}, 0, limit);
  // The search only prunes beyond `limit`; a reported distance can still exceed it.
  return hit && hit.distance < limit ? hit.distance : Infinity;
};
const BODY_NAMES = ['static', 'horn-0', 'horn-1', 'horn-2', 'leg-0', 'leg-1', 'leg-2', 'platform'];
const unassigned = () => parts.filter((p) => p.body === null);
for (let pass = 0; pass < 6 && unassigned().length > 0; pass++) {
  const bvhs = Object.fromEntries(
    BODY_NAMES.map((b) => [b, new MeshBVH(geometryOf(parts.filter((p) => p.body === b).map((p) => p.mesh)))]),
  );
  let changed = false;
  for (const p of unassigned()) {
    const g = geometryOf([p.mesh]);
    const touching = BODY_NAMES.filter((b) => distance(bvhs[b], g, TOUCH_MM) < TOUCH_MM);
    if (touching.length === 0) continue;
    const legs = touching.filter((b) => b.startsWith('leg-'));
    const horns = touching.filter((b) => b.startsWith('horn-'));
    let body;
    if (touching.length === 1) body = touching[0];
    else if (touching.includes('platform') && legs.length === 1 && touching.length === 2) body = 'platform'; // rod-end screw
    else if (legs.length === 1 && horns.length === 1 && touching.length === 2 && legs[0].slice(-1) === horns[0].slice(-1)) body = legs[0]; // pin
    else fail(`${p.name} #${p.id} touches ${touching.join(' + ')}; no rule decides which body it belongs to`);
    assign(p, body);
    changed = true;
  }
  if (!changed) break;
}
const floating = unassigned();

// ---------- measure the joints (front leg) and check the other legs match ----------
const frontHorn = parts.find((p) => p.body === 'horn-0' && startsWith(p, 'servo-horn-custom-alt'));
const frontArms = parts.filter((p) => p.body === 'leg-0' && startsWith(p, 'servo-horn-custom-fin'));
if (!frontHorn || frontArms.length !== 2) fail('front leg parts not found');
const shafts = xCylinders(frontHorn.mesh, 4);
if (shafts.length === 0) fail('could not find the servo shaft bore on the front horn');
const shaft = shafts[0];
const pins = frontArms.flatMap((p) => xCylinders(p.mesh, 1.5)).filter((h) => h.y < 50);
if (pins.length === 0) fail('could not find the leg pin on the front arm');
const pin = pins[0];
if (!near(pin.y, shaft.y)) fail(`pin height ${pin.y} differs from shaft height ${shaft.y}: the horn is not level in the CAD`);
const balls = parts
  .filter((p) => p.role === 'rod-end-ball')
  .flatMap((p) => faces(p.mesh).filter((f) => f.length >= 12).map((f) => ({ fit: fitSphere(f), part: p })))
  .filter((s) => s.fit.residual < 0.02 && s.fit.r < 6);
if (balls.length === 0) fail('could not find a ball joint');
const ballCentre = balls[0].fit.center;
const ballRadial = Math.hypot(ballCentre[0], ballCentre[2]);
for (const s of balls) {
  if (!near(Math.hypot(s.fit.center[0], s.fit.center[2]), ballRadial) || !near(s.fit.center[1], ballCentre[1])) {
    fail('the ball joints are not all at the same radius and height');
  }
}
const measured = {
  baseRadiusMm: shaft.z,
  hornLengthMm: pin.z - shaft.z,
  platformRadiusMm: ballRadial,
  legLengthMm: ballCentre[1] - pin.y,
  homeHeightMm: ballCentre[1] - shaft.y,
};
const shaftHeight = shaft.y;
const jointHeight = ballCentre[1];
for (const [key, value] of Object.entries(measured)) {
  if (!near(value, DEV_KIT_GEOMETRY[key])) fail(`${key} measures ${value.toFixed(4)} mm in the CAD but DEV_KIT_GEOMETRY says ${DEV_KIT_GEOMETRY[key]}`);
}
for (const s of balls) {
  const k = nearestLeg(s.fit.center);
  if (!near(angleOf(s.fit.center), LEG_ANGLES[k] > 180 ? LEG_ANGLES[k] - 360 : LEG_ANGLES[k], 0.05)) fail(`ball joint ${k} is not at ${LEG_ANGLES[k]}°`);
}

// ---------- frames ----------
// CAD (x, y, z) → Peeqo (X, Y, Z) = (z, x, y): a cyclic permutation, so winding and normals stay valid.
const toPeeqo = (x, y, z) => [z, x, y];
const rotZ = (deg) => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return ([X, Y, Z]) => [X * c - Y * s, X * s + Y * c, Z];
};
const R = DEV_KIT_GEOMETRY.baseRadiusMm;
const H = DEV_KIT_GEOMETRY.hornLengthMm;
const legOrigin = (k, radius) => [radius * Math.cos((LEG_ANGLES[k] * Math.PI) / 180), radius * Math.sin((LEG_ANGLES[k] * Math.PI) / 180), shaftHeight];
/** Peeqo-frame point → body frame. */
const bodyFrame = (body) => {
  if (body === 'static') return (p) => p;
  if (body === 'platform') return ([X, Y, Z]) => [X, Y, Z - jointHeight];
  const k = Number(body.slice(-1));
  const o = legOrigin(k, body.startsWith('horn-') ? R : R + H);
  const turn = rotZ(-LEG_ANGLES[k]);
  return ([X, Y, Z]) => turn([X - o[0], Y - o[1], Z - o[2]]);
};
/** Body frame of leg `from` → body frame of the same body type on leg `to` (identical by symmetry). */
const sameLocal = (p) => p;

// ---------- copies for parts the CAD has only once ----------
const exported = []; // { name, body, role, source, positions(Float32 in body frame), normals, indices }
function exportPart(part, body, place, note = null) {
  const p = part.mesh.attributes.position.array;
  const n = part.mesh.attributes.normal?.array;
  if (!n || n.length !== p.length) fail(`${part.name}: no per-vertex normals`);
  const positions = new Float32Array(p.length);
  const normals = new Float32Array(p.length);
  const zero = place([0, 0, 0]);
  for (let k = 0; k < p.length; k += 3) {
    positions.set(place(toPeeqo(p[k], p[k + 1], p[k + 2])), k);
    const q = place(toPeeqo(n[k], n[k + 1], n[k + 2]));
    normals.set([q[0] - zero[0], q[1] - zero[1], q[2] - zero[2]], k);
  }
  exported.push({ name: `${part.sub && part.sub !== part.name ? `${part.name}/${part.sub}` : part.name} #${part.id}${note ? ` (${note})` : ''}`, body, role: part.role, part, positions, normals, indices: part.mesh.index.array });
}
for (const part of parts) if (part.body) exportPart(part, part.body, bodyFrame(part.body));
const copies = [];
// Servo body: copied into the static frame, turned to each leg that has none.
const telo = parts.find((p) => p.role === 'servo-body');
for (const k of [0, 1, 2]) {
  if (k === servoLeg) continue;
  exportPart(telo, 'static', rotZ(LEG_ANGLES[k] - LEG_ANGLES[servoLeg]), `copy for leg ${k}`);
  copies.push(`servo body for leg ${k}`);
}
// Servo hubs: same local frame on every horn.
for (const k of [0, 1, 2]) {
  if (k === servoLeg) continue;
  for (const hub of parts.filter((p) => p.role === 'servo-hub')) {
    exportPart(hub, `horn-${k}`, (pt) => sameLocal(bodyFrame(`horn-${servoLeg}`)(pt)), `copy for leg ${k}`);
  }
  copies.push(`servo hubs for leg ${k}`);
}
// Rod ends: legs without an eye get a copy of another leg's eye (local frame) and ball (turned in the platform).
const eyeLegs = new Set(parts.filter((p) => p.role === 'rod-end-eye').map((p) => Number(p.body.slice(-1))));
const sourceEye = parts.find((p) => p.role === 'rod-end-eye');
const sourceBall = parts.find((p) => p.role === 'rod-end-ball' && p.leg === Number(sourceEye.body.slice(-1)));
for (const k of [0, 1, 2]) {
  if (eyeLegs.has(k)) continue;
  const from = Number(sourceEye.body.slice(-1));
  exportPart(sourceEye, `leg-${k}`, (pt) => sameLocal(bodyFrame(`leg-${from}`)(pt)), `copy for leg ${k}`);
  exportPart(sourceBall, 'platform', (pt) => rotZ(LEG_ANGLES[k] - LEG_ANGLES[from])(bodyFrame('platform')(pt)), `copy for leg ${k}`);
  exported[exported.length - 1].legOverride = k;
  copies.push(`rod end for leg ${k}`);
}

// ---------- joint hardware (tagged after the copies, in the final body frames) ----------
// Leg parts touching their own horn sit on the horn pin; platform parts touching a leg's rod-end ball are its
// screw. Collision checks skip those pairs: each joint itself is checked separately.
{
  const geometryFrom = (entries, transform = null) => {
    const total = entries.reduce((n, e) => n + e.positions.length, 0);
    const positions = new Float32Array(total);
    const indices = [];
    let offset = 0;
    for (const e of entries) {
      positions.set(e.positions, offset);
      const base = offset / 3;
      for (const i of e.indices) indices.push(i + base);
      offset += e.positions.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(indices);
    if (transform) g.applyMatrix4(transform);
    return g;
  };
  for (const k of [0, 1, 2]) {
    // The leg frame is the horn frame moved out to the pin (at home).
    const hornBvh = new MeshBVH(geometryFrom(exported.filter((e) => e.body === `horn-${k}`)));
    const toHorn = new THREE.Matrix4().makeTranslation(H, 0, 0);
    for (const e of exported.filter((x) => x.body === `leg-${k}` && x.role === null)) {
      if (distance(hornBvh, geometryFrom([e], toHorn), TOUCH_MM) < TOUCH_MM) e.role = 'pin';
    }
    const ballEntries = exported.filter((x) => x.role === 'rod-end-ball' && (x.legOverride ?? x.part.leg) === k);
    if (ballEntries.length !== 1) fail(`leg ${k} should have exactly one rod-end ball, found ${ballEntries.length}`);
    const ballBvh = new MeshBVH(geometryFrom(ballEntries));
    // Only fasteners: the plates also touch the ball (they clamp it), and the eye must still be kept off them.
    const isFastener = (x) => /screw|washer|nut|spacer/i.test(x.part.name);
    for (const e of exported.filter((x) => x.body === 'platform' && x.role === null && isFastener(x))) {
      if (distance(ballBvh, geometryFrom([e]), TOUCH_MM) < TOUCH_MM) {
        e.role = 'rod-end-screw';
        e.legOverride = k;
      }
    }
  }
  for (const k of [0, 1, 2]) {
    const pins = exported.filter((e) => e.body === `leg-${k}` && e.role === 'pin').length;
    const screws = exported.filter((e) => e.role === 'rod-end-screw' && e.legOverride === k).length;
    // Pin hardware is optional: the CAD's pin screws are loose or missing, and the pin axis comes from the
    // coaxial holes measured above, not from the hardware.
    void pins;
    if (screws === 0) fail(`leg ${k} has no rod-end screw through its ball`);
  }
}

// ---------- rod end tilt limit (analytic cross-check of the mesh clearance) ----------
function measureRodEnd() {
  const eyePart = sourceEye;
  const k = Number(eyePart.body.slice(-1));
  const ball = balls.find((s) => nearestLeg(s.fit.center) === k) ?? balls[0];
  const C = ball.fit.center;
  const radial = [C[0] / Math.hypot(C[0], C[2]), 0, C[2] / Math.hypot(C[0], C[2])];
  const axis = [-radial[2], 0, radial[0]];
  const local = (x, y, z) => {
    const v = [x - C[0], y - C[1], z - C[2]];
    const along = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
    const off = Math.hypot(v[0] - along * axis[0], v[1] - along * axis[1], v[2] - along * axis[2]);
    return { along, off, up: v[1], radial: v[0] * radial[0] + v[2] * radial[2] };
  };
  const bp = eyePart.mesh.attributes.position.array;
  const bi = eyePart.mesh.index.array;
  const inEye = (q) => q.up >= -5 && q.up <= 6;
  const eye = [];
  for (let i = 0; i < bp.length; i += 3) {
    const q = local(bp[i], bp[i + 1], bp[i + 2]);
    if (inEye(q)) eye.push(q);
  }
  const eyeHalf = Math.max(...eye.map((q) => Math.abs(q.along)));
  const res = 0.1;
  const r0 = -10;
  const u0 = -8;
  const N = 200;
  const cellOf = (rad, up) => {
    const i = Math.floor((rad - r0) / res);
    const j = Math.floor((up - u0) / res);
    return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i;
  };
  const eyeGrid = new Uint8Array(N * N);
  const edge = (p, q, x, y) => (q.radial - p.radial) * (y - p.up) - (q.up - p.up) * (x - p.radial);
  for (let t = 0; t < bi.length; t += 3) {
    const tri = [0, 1, 2].map((j) => local(bp[3 * bi[t + j]], bp[3 * bi[t + j] + 1], bp[3 * bi[t + j] + 2]));
    if (!tri.every(inEye)) continue;
    const [a, b, c] = tri;
    for (let y = Math.min(a.up, b.up, c.up); y <= Math.max(a.up, b.up, c.up) + res; y += res / 2) {
      for (let x = Math.min(a.radial, b.radial, c.radial); x <= Math.max(a.radial, b.radial, c.radial) + res; x += res / 2) {
        const d1 = edge(a, b, x, y);
        const d2 = edge(b, c, x, y);
        const d3 = edge(c, a, x, y);
        if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
        const cell = cellOf(x, y);
        if (cell >= 0) eyeGrid[cell] = 1;
      }
    }
  }
  const walls = [];
  for (const plate of parts.filter((p) => startsWith(p, 'top-platform'))) {
    const pp = plate.mesh.attributes.position.array;
    const ii = plate.mesh.index.array;
    for (let t = 0; t < ii.length; t += 3) {
      const [A, B, D] = [0, 1, 2].map((j) => [pp[3 * ii[t + j]], pp[3 * ii[t + j] + 1], pp[3 * ii[t + j] + 2]]);
      const n = 10;
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) {
          const w = [i / n, j / n, (n - i - j) / n];
          const q = local(A[0] * w[0] + B[0] * w[1] + D[0] * w[2], A[1] * w[0] + B[1] * w[1] + D[1] * w[2], A[2] * w[0] + B[2] * w[1] + D[2] * w[2]);
          if (Math.abs(q.along) <= eyeHalf || Math.abs(q.along) > 6) continue;
          const cell = cellOf(q.radial, q.up);
          if (cell >= 0 && eyeGrid[cell]) walls.push({ along: Math.abs(q.along), cell });
        }
      }
    }
  }
  if (walls.length === 0) fail('found no platform lugs beside the rod end');
  const gap = Math.min(...walls.map((w) => w.along));
  const lugGrid = new Uint8Array(N * N);
  for (const w of walls) if (w.along < gap + 0.5) lugGrid[w.cell] = 1;
  let contact = 90;
  for (const q of eye) {
    const cell = cellOf(q.radial, q.up);
    let facesLug = false;
    for (let dj = -2; dj <= 2 && !facesLug; dj++) for (let di = -2; di <= 2 && !facesLug; di++) facesLug = lugGrid[cell + dj * N + di] === 1;
    if (!facesLug) continue;
    const a = Math.abs(q.along);
    const reach = Math.hypot(a, q.off);
    if (reach <= gap) continue;
    contact = Math.min(contact, ((Math.atan2(q.off, a) - Math.acos(gap / reach)) * 180) / Math.PI);
  }
  const lugCells = [...lugGrid.keys()].filter((i) => lugGrid[i]);
  const lugReach = Math.max(...lugCells.map((i) => Math.hypot(r0 + ((i % N) + 0.5) * res, u0 + (Math.floor(i / N) + 0.5) * res)));
  const bound = ((Math.atan2(lugReach, eyeHalf) - Math.acos(gap / Math.hypot(lugReach, eyeHalf))) * 180) / Math.PI;
  return { eyeHalfThicknessMm: eyeHalf, lugOffsetMm: gap, lugReachMm: lugReach, contactTiltDeg: Math.min(contact, bound) };
}
const rodEnd = measureRodEnd();
if (DEFAULT_SAFETY_LIMITS.maxRodEndTiltDeg > rodEnd.contactTiltDeg - 5) {
  fail(`rod ends touch their lugs at ${rodEnd.contactTiltDeg.toFixed(1)}°, too close to the ${DEFAULT_SAFETY_LIMITS.maxRodEndTiltDeg}° limit`);
}

// ---------- screen window in the platform frame ----------
function measureWindow() {
  const tris = [];
  for (const p of parts.filter((q) => q.body === 'platform' && startsWith(q, 'head'))) {
    const pp = p.mesh.attributes.position.array;
    const idx = p.mesh.index.array;
    for (let t = 0; t < idx.length; t += 3) tris.push([0, 1, 2].map((k) => toPeeqo(pp[3 * idx[t + k]], pp[3 * idx[t + k] + 1], pp[3 * idx[t + k] + 2])));
  }
  const front = Math.max(...tris.flat().map((v) => v[0]));
  const res = 0.25;
  const y0 = -70;
  const z0 = 90;
  const W = Math.round(140 / res);
  const Hh = Math.round(100 / res);
  const grid = new Uint8Array(W * Hh);
  const edge = (a, b, c) => (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  for (const [a, b, c] of tris) {
    if (Math.min(a[0], b[0], c[0]) < front - 2.5) continue; // the stepped bezel face (next surface back is ~6 mm behind)
    for (let gz = Math.max(0, Math.floor((Math.min(a[2], b[2], c[2]) - z0) / res)); gz <= Math.min(Hh - 1, Math.ceil((Math.max(a[2], b[2], c[2]) - z0) / res)); gz++) {
      for (let gy = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - y0) / res)); gy <= Math.min(W - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - y0) / res)); gy++) {
        const q = [0, y0 + (gy + 0.5) * res, z0 + (gz + 0.5) * res];
        const d1 = edge(a, b, q);
        const d2 = edge(b, c, q);
        const d3 = edge(c, a, q);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) grid[gz * W + gy] = 1;
      }
    }
  }
  const zs = tris.flat().map((v) => v[2]);
  const zMid = (Math.min(...zs) + Math.max(...zs)) / 2;
  const cell = (y, z) => grid[Math.round((z - z0) / res) * W + Math.round((y - y0) / res)];
  const scan = (y, z, dy, dz) => {
    let k = 0;
    while (k < 400 && !cell(y + dy * k * res, z + dz * k * res)) k++;
    return k * res;
  };
  if (cell(0, zMid)) fail('the head has no screen opening at its centre');
  const halfWidth = Math.min(...[-14, -7, 7, 14].map((dz) => Math.min(scan(0, zMid + dz, -1, 0), scan(0, zMid + dz, 1, 0))));
  const below = Math.min(...[-20, 0, 20].map((y) => scan(y, zMid, 0, -1)));
  const above = Math.min(...[-20, 0, 20].map((y) => scan(y, zMid, 0, 1)));
  return { frontXMm: front, centerYMm: 0, centerZMm: zMid + (above - below) / 2 - jointHeight, widthMm: 2 * halfWidth, heightMm: above + below };
}
const screen = measureWindow();
if (!(screen.widthMm > 70 && screen.widthMm < 110 && screen.heightMm > 40 && screen.heightMm < 70)) {
  fail(`screen window measured ${screen.widthMm} × ${screen.heightMm} mm, which is not plausible`);
}

// ---------- write the GLB ----------
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('peeqo-devkit');
doc.getRoot().setDefaultScene(scene);
const material = (name, rgb, roughness, metallic = 0) =>
  doc.createMaterial(name).setBaseColorFactor([...rgb, 1]).setRoughnessFactor(roughness).setMetallicFactor(metallic);
const palette = {
  shell: material('shell', [0.88, 0.88, 0.86], 0.55),
  printed: material('printed-part', [0.93, 0.93, 0.91], 0.5),
  frame: material('plate', [0.62, 0.64, 0.68], 0.6),
  servo: material('servo', [0.09, 0.1, 0.11], 0.45),
  metal: material('metal', [0.72, 0.74, 0.78], 0.3, 0.85),
  cloth: material('cloth', [0.42, 0.44, 0.48], 0.9),
  pcb: material('pcb', [0.08, 0.32, 0.16], 0.5),
  component: material('component', [0.16, 0.17, 0.18], 0.4),
  ring: material('led-ring', [0.82, 0.82, 0.85], 0.35),
};
const materialFor = (e) => {
  const n = e.part.name;
  if (e.role === 'led-ring') return palette.ring;
  if (e.role === 'servo-body' || n.startsWith('servo v') || e.part.sub === 'Unášač' || e.part.sub === 'Kolečko') return palette.servo;
  if (e.part.sub === 'Hriadel' || e.part.sub === 'center-screw-head') return palette.metal;
  if (n.startsWith('circuit-servo')) return e.part.sub === 'Board' ? palette.pcb : palette.component;
  if (n.startsWith('cloth-ring')) return palette.cloth;
  if (n.startsWith('top-platform') || n.startsWith('Servoholder')) return palette.frame;
  if (n.startsWith('base') || n.startsWith('head') || n.startsWith('top-head')) return palette.shell;
  if (n.startsWith('servo-horn-custom') ) return palette.printed;
  if (n.startsWith('ball-socket')) return e.role === 'rod-end-ball' ? palette.metal : palette.printed;
  if (/^0220/.test(n)) return palette.component;
  return palette.metal; // screws, nuts, washers, spacers
};
const bodyNodes = Object.fromEntries(BODY_NAMES.map((b) => [b, doc.createNode(b)]));
for (const b of BODY_NAMES) scene.addChild(bodyNodes[b]);
for (const e of exported) {
  const count = e.positions.length / 3;
  const indices = count < 65536 ? new Uint16Array(e.indices) : new Uint32Array(e.indices);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(e.positions).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(e.normals).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
    .setMaterial(materialFor(e));
  const node = doc.createNode(e.name).setMesh(doc.createMesh(e.name).addPrimitive(prim));
  const leg = e.legOverride ?? e.part.leg;
  node.setExtras({ role: e.role ?? 'part', ...(leg !== undefined ? { leg } : {}) });
  bodyNodes[e.body].addChild(node);
}

const round = (n) => Math.round(n * 1000) / 1000;
const counts = Object.fromEntries(BODY_NAMES.map((b) => [b, exported.filter((e) => e.body === b).length]));
const extras = {
  frame: '+X forward, +Y Peeqo left, +Z up, millimetres; body frames are documented in tools/build-model.mjs',
  source: `${path.basename(stepPath)} (Peeqo dev kit Fusion 360 assembly)`,
  shaftHeightMm: round(shaftHeight),
  jointHeightMm: round(jointHeight),
  legAnglesDeg: LEG_ANGLES,
  measured: Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, round(v)])),
  rodEnd: Object.fromEntries(Object.entries(rodEnd).map(([k, v]) => [k, round(v)])),
  screenWindow: Object.fromEntries(Object.entries(screen).map(([k, v]) => [k, round(v)])),
  partsPerBody: counts,
  copies,
  looseInCad: floating.map((p) => `${p.name} #${p.id}`),
};
scene.setExtras(extras);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, await new NodeIO().writeBinary(doc));
console.log(`Wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(2)} MB)`);
console.log(JSON.stringify({ ...extras, looseInCad: `${floating.length} parts: ${extras.looseInCad.join(', ')}` }, null, 2));
