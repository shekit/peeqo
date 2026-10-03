// Loads the robot model's rigid bodies for collision checks, and poses them from joint angles.
// Frames are documented in tools/build-model.mjs. All results are in the table frame, millimetres.

import { NodeIO } from '@gltf-transform/core';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export const BODY_NAMES = ['static', 'horn-0', 'horn-1', 'horn-2', 'leg-0', 'leg-1', 'leg-2', 'platform'];

/** Reads every part: { body, name, role, leg, positions, indices }. */
export async function loadParts(glbPath) {
  const doc = await new NodeIO().read(glbPath);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const info = scene.getExtras();
  const parts = [];
  for (const bodyNode of scene.listChildren()) {
    for (const child of bodyNode.listChildren()) {
      const prim = child.getMesh().listPrimitives()[0];
      const extras = child.getExtras() ?? {};
      parts.push({
        body: bodyNode.getName(),
        name: child.getName(),
        role: extras.role ?? 'part',
        leg: extras.leg,
        positions: prim.getAttribute('POSITION').getArray(),
        indices: prim.getIndices().getArray(),
      });
    }
  }
  return { info, parts };
}

/** One BVH over the selected parts (in their body frame). */
export function bvhOf(parts) {
  const total = parts.reduce((n, p) => n + p.positions.length, 0);
  const positions = new Float32Array(total);
  const indices = [];
  let offset = 0;
  for (const p of parts) {
    positions.set(p.positions, offset);
    const base = offset / 3;
    for (const i of p.indices) indices.push(i + base);
    offset += p.positions.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.boundsTree = new MeshBVH(g);
  return g;
}

/**
 * Smallest distance between two posed geometries (each with a boundsTree), or `limit` if they are at least
 * that far apart. 0 means touching or intersecting.
 */
export function gap(a, poseA, b, poseB, limit) {
  const bToA = new THREE.Matrix4().copy(poseA).invert().multiply(poseB);
  const hit = a.boundsTree.closestPointToGeometry(b, bToA, {}, {}, 0, limit);
  // The search only prunes beyond `limit`; a reported distance can still exceed it.
  return hit && hit.distance < limit ? hit.distance : limit;
}

const DEG = Math.PI / 180;

/** Poses from joint values; geometry = { baseRadiusMm, hornLengthMm, legAnglesDeg, shaftHeightMm }. */
export function poser(geometry) {
  const R = geometry.baseRadiusMm;
  const H = geometry.hornLengthMm;
  const z0 = geometry.shaftHeightMm;
  const yaw = (k) => new THREE.Matrix4().makeRotationZ(geometry.legAnglesDeg[k] * DEG);
  const shaft = (k) => new THREE.Vector3(R, 0, 0).applyMatrix4(yaw(k)).add(new THREE.Vector3(0, 0, z0));
  return {
    /** Horn k turned by alphaDeg (+ lifts the pin). */
    horn(k, alphaDeg) {
      const s = shaft(k);
      return new THREE.Matrix4().makeTranslation(s.x, s.y, s.z).multiply(yaw(k)).multiply(new THREE.Matrix4().makeRotationY(-alphaDeg * DEG));
    },
    /** Leg k hanging from horn angle alphaDeg, swung by lambdaDeg about its pin (+ tips its top outward). */
    leg(k, alphaDeg, lambdaDeg) {
      const pin = new THREE.Vector3(H, 0, 0).applyMatrix4(this.horn(k, alphaDeg));
      return new THREE.Matrix4().makeTranslation(pin.x, pin.y, pin.z).multiply(yaw(k)).multiply(new THREE.Matrix4().makeRotationY(lambdaDeg * DEG));
    },
    /** Platform frame from a row-major rotation and the platform centre (neck frame, as solveIk returns). */
    platform(rotation, position) {
      const m = rotation;
      return new THREE.Matrix4().set(
        m[0], m[1], m[2], position[0],
        m[3], m[4], m[5], position[1],
        m[6], m[7], m[8], position[2] + z0,
        0, 0, 0, 1,
      );
    },
    identity: new THREE.Matrix4(),
  };
}
