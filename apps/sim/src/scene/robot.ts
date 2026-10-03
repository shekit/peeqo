import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  SERVO_INDICES,
  platformTransform,
  solveIk,
  type IkSolution,
  type LedPixel,
  type Mat3,
  type PlatformGeometry,
  type Pose,
  type Vec3,
} from '@peeqo/core';
import { FACE_HEIGHT, FACE_WIDTH } from '@peeqo/face';
import modelUrl from '../assets/peeqo-devkit.glb?url';
import { createLedRingMaterial } from './ledRingMaterial.ts';

/** Measurements stored in the model by tools/build-model.mjs (see that file for the body frames). */
interface ModelInfo {
  shaftHeightMm: number;
  jointHeightMm: number;
  legAnglesDeg: number[];
  measured: Record<string, number>;
  screenWindow: { frontXMm: number; centerYMm: number; centerZMm: number; widthMm: number; heightMm: number };
  looseInCad: string[];
  copies: string[];
}

export type BodyName = 'static' | 'horn-0' | 'horn-1' | 'horn-2' | 'leg-0' | 'leg-1' | 'leg-2' | 'platform';

export interface RobotView {
  /** Add to the scene. Converts Peeqo's Z-up frame to three.js Y-up. */
  readonly root: THREE.Group;
  readonly faceTexture: THREE.CanvasTexture;
  readonly info: ModelInfo;
  /** The rigid bodies as drawn (each holds its parts as child meshes with userData.role). */
  readonly bodies: Readonly<Record<BodyName, THREE.Object3D>>;
  /** Poses the mechanism: horns, legs, platform and head. Returns the IK used. */
  update(pose: Pose): IkSolution;
  /** Shows a red outline where the head was asked to go, or hides it (null). */
  setRequested(pose: Pose | null): void;
  setLeds(pixels: readonly LedPixel[]): void;
  /** Consistency checks for tests: where the drawn joints are, in the kinematics' frame (mm). */
  drawnHornTips(): Vec3[];
  drawnLegTops(): Vec3[];
}

function matrixFromMat3(m: Mat3, position: Vec3): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    m[0], m[1], m[2], position[0],
    m[3], m[4], m[5], position[1],
    m[6], m[7], m[8], position[2],
    0, 0, 0, 1,
  );
}

export async function createRobot(geometry: PlatformGeometry, faceCanvas: HTMLCanvasElement): Promise<RobotView> {
  if (faceCanvas.width !== FACE_WIDTH || faceCanvas.height !== FACE_HEIGHT) {
    throw new Error(`Face canvas must be ${FACE_WIDTH}×${FACE_HEIGHT}`);
  }
  const gltf = await new GLTFLoader().loadAsync(modelUrl);
  const model = gltf.scene;
  const info = model.userData as ModelInfo;
  // The drawing must use the same neck as the maths, or the picture would lie about what is safe.
  for (const key of ['baseRadiusMm', 'hornLengthMm', 'platformRadiusMm', 'legLengthMm', 'homeHeightMm'] as const) {
    const measured = info.measured?.[key];
    if (measured === undefined || Math.abs(measured - geometry[key]) > 0.01) {
      throw new Error(`Robot model ${key} is ${measured} mm but the kinematics use ${geometry[key]} mm`);
    }
  }
  // The dev kit is printed in black; the model keeps the CAD's light colours, so recolour them here (a dark
  // charcoal rather than pure black, so the shapes still read in the lighting).
  const recolour: Record<string, { color: string; roughness: number }> = {
    shell: { color: '#2b2d31', roughness: 0.42 },
    'printed-part': { color: '#313337', roughness: 0.48 },
    plate: { color: '#45484e', roughness: 0.5 },
  };
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !(o.material instanceof THREE.MeshStandardMaterial)) return;
    const look = recolour[o.material.name];
    if (look) {
      o.material.color.set(look.color);
      o.material.roughness = look.roughness;
    }
  });
  const body = (name: BodyName): THREE.Object3D => {
    const object = model.getObjectByName(name);
    if (!object) throw new Error(`Robot model has no "${name}" body; rebuild it with tools/build-model.mjs`);
    object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return object;
  };
  const bodies = {
    static: body('static'),
    'horn-0': body('horn-0'),
    'horn-1': body('horn-1'),
    'horn-2': body('horn-2'),
    'leg-0': body('leg-0'),
    'leg-1': body('leg-1'),
    'leg-2': body('leg-2'),
    platform: body('platform'),
  } satisfies Record<BodyName, THREE.Object3D>;

  // Peeqo's frame (+X forward, +Y left, +Z up) inside three.js (+Y up): rotate −90° about X.
  const root = new THREE.Group();
  root.name = 'peeqo';
  root.rotation.x = -Math.PI / 2;
  root.add(bodies.static);

  // The kinematics' origin: centre of the servo shaft plane.
  const mechanism = new THREE.Group();
  mechanism.position.z = info.shaftHeightMm;
  root.add(mechanism);

  const hornPivots: THREE.Group[] = [];
  const hornTips: THREE.Object3D[] = [];
  const legLinks: THREE.Group[] = [];
  const legTops: THREE.Object3D[] = [];
  const legYaw: number[] = [];
  for (const k of SERVO_INDICES) {
    const yaw = THREE.MathUtils.degToRad(geometry.baseAnglesDeg[k]);
    legYaw.push(yaw);
    const frame = new THREE.Group();
    frame.rotation.z = yaw;
    mechanism.add(frame);
    // Horn body: the U-horn with the servo hubs screwed to it; turns about the shaft (local +Y) only.
    const pivot = new THREE.Group();
    pivot.position.x = geometry.baseRadiusMm;
    pivot.add(bodies[`horn-${k}`]);
    const tip = new THREE.Object3D();
    tip.position.x = geometry.hornLengthMm;
    pivot.add(tip);
    frame.add(pivot);
    // Leg body: both arms and the rod-end eye; swings about its pin (local +Y), staying in this leg's plane.
    const link = new THREE.Group();
    link.add(bodies[`leg-${k}`]);
    const top = new THREE.Object3D();
    top.position.z = geometry.legLengthMm;
    link.add(top);
    frame.add(link);
    hornPivots.push(pivot);
    hornTips.push(tip);
    legLinks.push(link);
    legTops.push(top);
  }

  // ---- platform: plates, head, top, LED ring, rod-end balls and screws, and the face screen ----
  const platform = new THREE.Group();
  platform.matrixAutoUpdate = false;
  mechanism.add(platform);
  // Head outline for the "requested pose" ghost, measured before attaching so it is in the platform frame.
  const headBox = new THREE.Box3();
  bodies.platform.updateWorldMatrix(true, true);
  bodies.platform.traverse((o) => {
    if (o instanceof THREE.Mesh && /^(head|top-head|top-platform)/.test(o.name)) headBox.expandByObject(o, true);
  });
  platform.add(bodies.platform);
  let ring: THREE.Mesh | null = null;
  bodies.platform.traverse((o) => {
    if (o instanceof THREE.Mesh && o.userData.role === 'led-ring') ring = o;
  });
  if (!ring) throw new Error('Robot model has no LED ring');
  const ledRing = createLedRingMaterial();
  (ring as THREE.Mesh).material = ledRing.material;
  (ring as THREE.Mesh).castShadow = false;

  // Screen: the 800×480 (5:3) panel fitted to the bezel opening, on a black backing.
  const screen = info.screenWindow;
  const faceTexture = new THREE.CanvasTexture(faceCanvas);
  faceTexture.colorSpace = THREE.SRGBColorSpace;
  faceTexture.anisotropy = 4;
  // Plane axes: x → Peeqo's left (+Y, the viewer's right), y → up (+Z), normal → forward (+X).
  const facing = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
  const backing = new THREE.Mesh(new THREE.PlaneGeometry(screen.widthMm, screen.heightMm), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  backing.quaternion.setFromRotationMatrix(facing);
  backing.position.set(screen.frontXMm - 2.4, screen.centerYMm, screen.centerZMm);
  const displayHeight = Math.min(screen.heightMm, (screen.widthMm * FACE_HEIGHT) / FACE_WIDTH);
  const displayWidth = (displayHeight * FACE_WIDTH) / FACE_HEIGHT;
  const display = new THREE.Mesh(
    new THREE.PlaneGeometry(displayWidth, displayHeight),
    new THREE.MeshBasicMaterial({ map: faceTexture, toneMapped: false }),
  );
  display.name = 'face-display';
  display.quaternion.setFromRotationMatrix(facing);
  display.position.set(screen.frontXMm - 2.3, screen.centerYMm, screen.centerZMm);
  platform.add(backing, display);

  // ---- ghost: where the head was asked to go when that is outside the safe range ----
  const ghost = new THREE.Group();
  ghost.matrixAutoUpdate = false;
  ghost.visible = false;
  const size = headBox.getSize(new THREE.Vector3());
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
    new THREE.LineBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.9 }),
  );
  outline.position.copy(headBox.getCenter(new THREE.Vector3()));
  ghost.add(outline);
  mechanism.add(ghost);

  const toLegFrame = (v: Vec3, yaw: number): THREE.Vector3 => new THREE.Vector3(...v).applyAxisAngle(new THREE.Vector3(0, 0, 1), -yaw);

  const update = (pose: Pose): IkSolution => {
    const ik = solveIk(pose, geometry);
    if (!ik.reachable) throw new Error('RobotView.update was given an unreachable pose; only governor output may be drawn');
    platform.matrix.copy(matrixFromMat3(ik.rotation, ik.position));
    platform.matrixWorldNeedsUpdate = true;
    for (const k of SERVO_INDICES) {
      const solution = ik.legs[k];
      const yaw = legYaw[k]!;
      hornPivots[k]!.rotation.y = -solution.hornRad;
      // The leg hangs from the horn tip and points at its ball, turning only about its pin (local +Y).
      const tip = toLegFrame(solution.hornTip, yaw);
      const towardBall = toLegFrame(solution.platformJoint, yaw).sub(tip);
      const link = legLinks[k]!;
      link.position.copy(tip);
      link.rotation.set(0, Math.atan2(towardBall.x, towardBall.z), 0);
    }
    return ik;
  };

  const setRequested = (pose: Pose | null): void => {
    ghost.visible = pose !== null;
    if (!pose) return;
    const { rotation, position } = platformTransform(pose, geometry);
    ghost.matrix.copy(matrixFromMat3(rotation, position));
    ghost.matrixWorldNeedsUpdate = true;
  };

  const inMechanismFrame = (objects: THREE.Object3D[]): Vec3[] => {
    root.updateMatrixWorld(true);
    const toLocal = new THREE.Matrix4().copy(mechanism.matrixWorld).invert();
    return objects.map((o) => {
      const p = o.getWorldPosition(new THREE.Vector3()).applyMatrix4(toLocal);
      return [p.x, p.y, p.z];
    });
  };

  return {
    root,
    faceTexture,
    info,
    bodies,
    update,
    setRequested,
    setLeds: ledRing.setPixels,
    drawnHornTips: () => inMechanismFrame(hornTips),
    drawnLegTops: () => inMechanismFrame(legTops),
  };
}
