// Shared pieces of the collision-table builder (tools/build-clearance.mjs) and its worker threads:
// geometry splits, reach, and the distance measurements the tables are built from.

import * as THREE from 'three';
import { loadParts, bvhOf, gap, poser } from './bodies.mjs';
import { DEV_KIT_GEOMETRY } from '../../../../packages/core/src/geometry.ts';
import { solveIk, HOME_POSE } from '../../../../packages/core/src/kinematics.ts';

export const DEG = Math.PI / 180;
/** Distances beyond this are recorded as this (plenty above the margin). */
export const CAP = 5;
/** Horns turn about their shaft axis and legs about their pin axis: the y axis of each body frame. */
export const BODY_AXIS = new THREE.Vector3(0, 1, 0);
/** Split radius around a leg's pin axis, and around its rod-end ball. */
export const SPLIT_RADIUS_MM = 25;

// ---------- geometry splits for tight error bounds ----------
// Distances are taken from a point, or from the line through `centre` along `axis` when one is given (a leg
// turns about its pin's axis, which runs the full width of the leg).
/** Projects `v` onto the plane through `centre` normal to `axis` (no-op without an axis). */
const flatten = (v, centre, axis) => (axis ? v.sub(centre).projectOnPlane(axis).add(centre) : v);
const SPLIT_EDGE_MM = 1;

/**
 * Splits parts' triangles into those within `radius` of `centre` (in the parts' own frame) and the rest.
 * Triangles crossing the boundary are subdivided until their edges are at most SPLIT_EDGE_MM, and pieces still
 * crossing it go to the near side: near geometry lies within radius + SPLIT_EDGE_MM, far geometry beyond radius.
 * Each side comes back as one part (a triangle soup). (Only the bounds' tightness depends on the split: each
 * side's slack comes from its own measured reach.)
 */
export function split(selected, centre, radius, axis = null) {
  const near = [];
  const far = [];
  const tri = new THREE.Triangle();
  const segment = new THREE.Line3();
  const closest = new THREE.Vector3();
  const [fa, fb, fc] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const finiteMin = (d, x) => (Number.isFinite(x) ? Math.min(d, x) : d);
  /** Distance from centre to the flattened triangle, also when flattening collapses it to a segment or point. */
  const nearest = () => {
    let d = Math.min(fa.distanceTo(centre), fb.distanceTo(centre), fc.distanceTo(centre));
    for (const [p, q] of [[fa, fb], [fb, fc], [fc, fa]]) d = finiteMin(d, segment.set(p, q).closestPointToPoint(centre, true, closest).distanceTo(centre));
    return finiteMin(d, tri.set(fa, fb, fc).closestPointToPoint(centre, closest).distanceTo(centre));
  };
  const visit = (a, b, c) => {
    flatten(fa.copy(a), centre, axis);
    flatten(fb.copy(b), centre, axis);
    flatten(fc.copy(c), centre, axis);
    if (Math.max(fa.distanceTo(centre), fb.distanceTo(centre), fc.distanceTo(centre)) <= radius) return void near.push(a, b, c);
    if (nearest() > radius) return void far.push(a, b, c);
    if (Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) <= SPLIT_EDGE_MM) return void near.push(a, b, c);
    const ab = a.clone().lerp(b, 0.5);
    const bc = b.clone().lerp(c, 0.5);
    const ca = c.clone().lerp(a, 0.5);
    visit(a, ab, ca);
    visit(ab, b, bc);
    visit(ca, bc, c);
    visit(ab, bc, ca);
  };
  for (const p of selected) {
    for (let t = 0; t < p.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((j) => new THREE.Vector3().fromArray(p.positions, 3 * p.indices[t + j]));
      visit(a, b, c);
    }
  }
  if (!near.length || !far.length) throw new Error(`a geometry split left one side empty (${near.length / 3} near, ${far.length / 3} far triangles)`);
  const soup = (vertices) => ({ positions: Float32Array.from(vertices.flatMap((v) => [v.x, v.y, v.z])), indices: Uint32Array.from(vertices.keys()) });
  return { near: [soup(near)], far: [soup(far)] };
}

/** Largest distance from `centre` (or from the axis through it) of any vertex used by the parts' triangles. */
export function reach(selected, centre, axis = null) {
  let r = 0;
  const v = new THREE.Vector3();
  for (const p of selected) for (const i of p.indices) r = Math.max(r, flatten(v.fromArray(p.positions, 3 * i), centre, axis).distanceTo(centre));
  return r;
}

/** Where the splits of leg k are centred: its pin axis, or its rod-end ball (leg frame). */
export function legSplit(parts, k, around, legLengthMm) {
  const legParts = parts.filter((p) => p.body === `leg-${k}`);
  if (around === 'pin') {
    const centre = new THREE.Vector3();
    const s = split(legParts, centre, SPLIT_RADIUS_MM, BODY_AXIS);
    return { ...s, nearReach: reach(s.near, centre, BODY_AXIS), farReach: reach(s.far, centre, BODY_AXIS) };
  }
  const centre = new THREE.Vector3(0, 0, legLengthMm);
  const s = split(legParts, centre, SPLIT_RADIUS_MM);
  return { ...s, nearReach: reach(s.near, centre), farReach: reach(s.far, centre) };
}

const isJointOf = (p, k) => (p.role === 'rod-end-ball' || p.role === 'rod-end-screw') && p.leg === k;

/**
 * Loads the model and returns the distance measurements, each taking a list of sample points and returning
 * one distance per point (capped). Joint hardware is excluded from its own joint: the servo hubs from the
 * servo body they turn on, the leg's pin hardware from its horn, the rod-end ball and screw from their eye.
 */
export async function createMeasurer(glbPath) {
  const { info, parts } = await loadParts(glbPath);
  const geometry = { ...DEV_KIT_GEOMETRY, legAnglesDeg: info.legAnglesDeg, shaftHeightMm: info.shaftHeightMm };
  const P = poser(geometry);
  const I = P.identity;
  const cache = new Map();
  const cached = (key, make) => {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key);
  };
  const pick = (key, f) => cached(key, () => bvhOf(parts.filter(f)));
  const stat = () => pick('static', (p) => p.body === 'static');
  const statNoServo = () => pick('static-no-servo', (p) => p.body === 'static' && p.role !== 'servo-body');
  const body = (name) => pick(name, (p) => p.body === name);
  const legHalf = (k, around, side) => cached(`leg-${k}-${around}-${side}`, () => bvhOf(cached(`split-${k}-${around}`, () => legSplit(parts, k, around, geometry.legLengthMm))[side]));

  const home = solveIk(HOME_POSE, DEV_KIT_GEOMETRY);
  const platHome = P.platform(home.rotation, home.position);
  /** Leg k's pose with relative rotation (μ, τ, ω) to the level platform, about the shared ball centre. */
  const legRelative = (k, mu, tau, omega) => {
    const ball = new THREE.Vector3(...home.legs[k].platformJoint).add(new THREE.Vector3(0, 0, geometry.shaftHeightMm));
    const yaw = new THREE.Matrix4().makeRotationZ(geometry.legAnglesDeg[k] * DEG);
    const rel = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(tau * DEG, mu * DEG, omega * DEG, 'YXZ'));
    return new THREE.Matrix4()
      .makeTranslation(ball.x, ball.y, ball.z)
      .multiply(yaw)
      .multiply(rel)
      .multiply(yaw.clone().invert())
      .multiply(new THREE.Matrix4().makeTranslation(-ball.x, -ball.y, -ball.z))
      .multiply(P.leg(k, 0, 0));
  };

  return {
    /** Horn k ↔ static at each horn angle α. */
    horn(k, alphas) {
      const main = pick(`horn-${k}-main`, (p) => p.body === `horn-${k}` && p.role !== 'servo-hub');
      const hubs = pick(`horn-${k}-hubs`, (p) => p.body === `horn-${k}` && p.role === 'servo-hub');
      return alphas.map((alpha) => Math.min(gap(stat(), I, main, P.horn(k, alpha), CAP), gap(statNoServo(), I, hubs, P.horn(k, alpha), CAP)));
    },
    /** One side of leg k's pin split ↔ static, at each (α, λ). */
    legStatic(k, side, points) {
      const leg = legHalf(k, 'pin', side);
      return points.map(([alpha, lambda]) => gap(stat(), I, leg, P.leg(k, alpha, lambda), CAP));
    },
    /** Leg k ↔ its own horn at each relative angle α + λ. */
    legHorn(k, rels) {
      const leg = pick(`leg-${k}-no-pin`, (p) => p.body === `leg-${k}` && p.role !== 'pin');
      return rels.map((rel) => gap(body(`horn-${k}`), P.horn(k, 0), leg, P.leg(k, 0, rel), CAP));
    },
    /** One side of leg k's ball split ↔ platform at each (μ, τ): the worst over twists −ωmax…ωmax in steps. */
    legPlatform(k, side, points, omegaMax, stepOmega) {
      const leg = legHalf(k, 'top', side);
      const plat = pick(`platform-no-joint-${k}`, (p) => p.body === 'platform' && !isJointOf(p, k));
      return points.map(([mu, tau]) => {
        let d = CAP;
        for (let w = -omegaMax; w <= omegaMax + 1e-9; w += stepOmega) d = Math.min(d, gap(plat, platHome, leg, legRelative(k, mu, tau, w), CAP));
        return d;
      });
    },
    /** Horn i ↔ horn j at each (α_i, α_j). */
    hornPair(i, j, points) {
      return points.map(([ai, aj]) => gap(body(`horn-${i}`), P.horn(i, ai), body(`horn-${j}`), P.horn(j, aj), CAP));
    },
    /** Leg i ↔ another leg's horn j at each (α_i, λ_i, α_j). */
    legOtherHorn(i, j, points, limit) {
      return points.map(([ai, li, aj]) => gap(body(`leg-${i}`), P.leg(i, ai, li), body(`horn-${j}`), P.horn(j, aj), limit));
    },
    /** Leg i ↔ leg j at each (α_i, λ_i, α_j, λ_j). */
    legLeg(i, j, points, limit) {
      return points.map(([ai, li, aj, lj]) => gap(body(`leg-${i}`), P.leg(i, ai, li), body(`leg-${j}`), P.leg(j, aj, lj), limit));
    },
    /** The platform (posed by a column-major matrix) ↔ horn k at angle α, for each [pose, α]. */
    platformHorn(k, items, limit) {
      const M = new THREE.Matrix4();
      return items.map(([pose, alpha]) => gap(body('platform'), M.fromArray(pose), body(`horn-${k}`), P.horn(k, alpha), limit));
    },
    /** The platform (posed by a column-major matrix) ↔ the static base, for each pose. */
    platformStatic(poses, limit) {
      const M = new THREE.Matrix4();
      return poses.map((pose) => gap(stat(), I, body('platform'), M.fromArray(pose), limit));
    },
  };
}
