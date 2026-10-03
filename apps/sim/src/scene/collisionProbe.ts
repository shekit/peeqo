import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { BodyName } from './robot.ts';

/**
 * Measures real mesh-to-mesh gaps between the drawn bodies, independently of the precomputed collision
 * tables. Same pairs and joint exclusions as tools/build-clearance.mjs. Slow (hundreds of ms): for tests and
 * on-demand checks, not every frame.
 */
export interface ProbeResult {
  /** Smallest gap found, mm (capped at the cap passed to measure). */
  readonly minMm: number;
  readonly between: string;
  readonly pairs: Readonly<Record<string, number>>;
}

type Keep = (mesh: THREE.Mesh) => boolean;

/** One BVH over a body's selected parts, in the body's own frame. */
function merged(body: THREE.Object3D, keep: Keep): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const indices: number[] = [];
  body.updateWorldMatrix(true, true);
  const toBody = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const v = new THREE.Vector3();
  body.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !keep(o)) return;
    const g = o.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    const index = g.getIndex();
    const toBodyFrame = new THREE.Matrix4().multiplyMatrices(toBody, o.matrixWorld);
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toBodyFrame);
      positions.push(v.x, v.y, v.z);
    }
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) indices.push(base + i);
  });
  if (indices.length === 0) return null;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setIndex(indices);
  (out as THREE.BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = new MeshBVH(out);
  return out;
}

const role = (m: THREE.Mesh): string => (m.userData.role as string | undefined) ?? 'part';
const legOf = (m: THREE.Mesh): number | undefined => m.userData.leg as number | undefined;

export function createCollisionProbe(bodies: Readonly<Record<BodyName, THREE.Object3D>>) {
  const all: Keep = () => true;
  const geoms: Record<string, { body: BodyName; geometry: THREE.BufferGeometry }> = {};
  const add = (key: string, body: BodyName, keep: Keep) => {
    const g = merged(bodies[body], keep);
    if (g) geoms[key] = { body, geometry: g };
  };
  add('static', 'static', all);
  add('static-no-servo', 'static', (m) => role(m) !== 'servo-body');
  add('platform', 'platform', all);
  for (const k of [0, 1, 2] as const) {
    add(`horn-${k}`, `horn-${k}`, all);
    add(`horn-${k}-main`, `horn-${k}`, (m) => role(m) !== 'servo-hub');
    add(`horn-${k}-hubs`, `horn-${k}`, (m) => role(m) === 'servo-hub');
    add(`leg-${k}`, `leg-${k}`, all);
    add(`leg-${k}-no-pin`, `leg-${k}`, (m) => role(m) !== 'pin');
    add(`platform-no-joint-${k}`, 'platform', (m) => !((role(m) === 'rod-end-ball' || role(m) === 'rod-end-screw') && legOf(m) === k));
  }
  const pairs: [string, string, string][] = [];
  for (const k of [0, 1, 2]) {
    pairs.push([`horn-${k}-main`, 'static', `horn ${k} and the base`]);
    pairs.push([`horn-${k}-hubs`, 'static-no-servo', `horn ${k} hubs and the base`]);
    pairs.push([`leg-${k}`, 'static', `leg ${k} and the base`]);
    pairs.push([`leg-${k}-no-pin`, `horn-${k}`, `leg ${k} and its horn`]);
    pairs.push([`leg-${k}`, `platform-no-joint-${k}`, `leg ${k} and the platform`]);
    pairs.push([`horn-${k}`, 'platform', `horn ${k} and the platform`]);
  }
  for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
    pairs.push([`horn-${i}`, `horn-${j}`, `horns ${i} and ${j}`]);
    pairs.push([`leg-${i}`, `leg-${j}`, `legs ${i} and ${j}`]);
    pairs.push([`leg-${i}`, `horn-${j}`, `leg ${i} and horn ${j}`]);
    pairs.push([`leg-${j}`, `horn-${i}`, `leg ${j} and horn ${i}`]);
  }
  pairs.push(['static', 'platform', 'the head and the base']);

  const hitA = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const hitB = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const measure = (capMm = 5): ProbeResult => {
    for (const b of Object.values(bodies)) b.updateWorldMatrix(true, false);
    const out: Record<string, number> = {};
    let minMm = capMm;
    let between = '';
    for (const [a, b, label] of pairs) {
      const A = geoms[a];
      const B = geoms[b];
      if (!A || !B) continue;
      const bToA = new THREE.Matrix4().copy(bodies[A.body].matrixWorld).invert().multiply(bodies[B.body].matrixWorld);
      const bvh = (A.geometry as THREE.BufferGeometry & { boundsTree: MeshBVH }).boundsTree;
      const hit = bvh.closestPointToGeometry(B.geometry, bToA, hitA, hitB, 0, capMm);
      // The search only prunes beyond capMm; a reported distance can still exceed it.
      const d = hit && hit.distance < capMm ? hit.distance : capMm;
      out[label] = d;
      if (d < minMm) {
        minMm = d;
        between = label;
      }
    }
    return { minMm, between, pairs: out };
  };
  return { measure };
}
