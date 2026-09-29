import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  SERVO_INDICES,
  platformJointLocal,
  platformTransform,
  shaftAxis,
  shaftPoint,
  solveIk,
  type IkSolution,
  type LedPixel,
  type Mat3,
  type PlatformGeometry,
  type Pose,
  type Vec3,
} from '@peeqo/core';
import { FACE_HEIGHT, FACE_WIDTH } from '@peeqo/face';
import headModelUrl from '../assets/peeqo-v1-head.glb?url';
import { createLedRingMaterial } from './ledRingMaterial.ts';

/**
 * Visual-only dimensions (mm). The kinematics come from PlatformGeometry; these only decide how the base,
 * servos and plate look. The head is the 2016 v1 CAD, standing in until the dev-kit CAD is available.
 */
const BASE_RADIUS = 100;
const BASE_HEIGHT = 26;
/** Height of the servo shaft plane (the kinematics' origin) above the table. */
export const SHAFT_PLANE_HEIGHT = BASE_HEIGHT + 16;
const PLATE_BOTTOM = 4;
const PLATE_TOP = 8;
/** Micro servo (SG90/MG90S class) body: radial length, length along the shaft, height. */
const SERVO_BODY = { radial: 22.5, alongShaft: 22.7, height: 12.2, shaftFromOuterEnd: 5.9 } as const;

interface ScreenWindow {
  frontXMm: number;
  centerYMm: number;
  centerZMm: number;
  widthMm: number;
  heightMm: number;
}

export interface RobotView {
  /** Add to the scene. Converts Peeqo's Z-up frame to three.js Y-up. */
  readonly root: THREE.Group;
  readonly faceTexture: THREE.CanvasTexture;
  /** Poses the mechanism: horns, legs, platform and head. Returns the IK used. */
  update(pose: Pose): IkSolution;
  /** Shows a red outline where the head was asked to go, or hides it (null). */
  setRequested(pose: Pose | null): void;
  setLeds(pixels: readonly LedPixel[]): void;
  /** World-space horn tip positions as drawn, in Peeqo's frame (for consistency checks). */
  drawnHornTips(): Vec3[];
}

function matrixFromMat3(m: Mat3, position: Vec3): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    m[0], m[1], m[2], position[0],
    m[3], m[4], m[5], position[1],
    m[6], m[7], m[8], position[2],
    0, 0, 0, 1,
  );
}

/** A cylinder whose axis runs along +Z (three.js cylinders run along +Y). */
function zCylinder(radiusTop: number, radiusBottom: number, height: number, segments = 48): THREE.CylinderGeometry {
  const g = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
  g.rotateX(Math.PI / 2);
  return g;
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, shadows = true): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

export async function createRobot(geometry: PlatformGeometry, faceCanvas: HTMLCanvasElement): Promise<RobotView> {
  if (faceCanvas.width !== FACE_WIDTH || faceCanvas.height !== FACE_HEIGHT) {
    throw new Error(`Face canvas must be ${FACE_WIDTH}×${FACE_HEIGHT}`);
  }
  const materials = {
    shell: new THREE.MeshStandardMaterial({ color: 0xdcdcd6, roughness: 0.55 }),
    plate: new THREE.MeshStandardMaterial({ color: 0xc3c7cd, roughness: 0.6 }),
    servo: new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.45 }),
    bracket: new THREE.MeshStandardMaterial({ color: 0x9da3ab, roughness: 0.7 }),
    horn: new THREE.MeshStandardMaterial({ color: 0xf3f3ef, roughness: 0.5 }),
    leg: new THREE.MeshStandardMaterial({ color: 0xb9bfc7, metalness: 0.85, roughness: 0.3 }),
    joint: new THREE.MeshStandardMaterial({ color: 0x4b5058, metalness: 0.3, roughness: 0.4 }),
    ghost: new THREE.LineBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.9 }),
  };

  // Peeqo's frame (+X forward, +Y left, +Z up) inside three.js (+Y up): rotate −90° about X.
  const root = new THREE.Group();
  root.name = 'peeqo';
  root.rotation.x = -Math.PI / 2;

  // ---- base ----
  const base = mesh(zCylinder(BASE_RADIUS, BASE_RADIUS + 2, BASE_HEIGHT, 96), materials.shell);
  base.position.z = BASE_HEIGHT / 2;
  root.add(base);

  // Everything kinematic lives in this group, whose origin is the shaft plane centre (the core's origin).
  const mechanism = new THREE.Group();
  mechanism.position.z = SHAFT_PLANE_HEIGHT;
  root.add(mechanism);

  // ---- servos and horns ----
  const hornPivots: THREE.Group[] = [];
  const hornTipMarkers: THREE.Object3D[] = [];
  for (const servo of SERVO_INDICES) {
    const beta = THREE.MathUtils.degToRad(geometry.hornAnglesDeg[servo]);
    const radial = new THREE.Vector3(Math.cos(beta), Math.sin(beta), 0);
    const axis = new THREE.Vector3(...shaftAxis(servo, geometry));
    const up = new THREE.Vector3(0, 0, 1);
    // Local frame: x = horn direction when level, y = shaft axis, z = up.
    const frame = new THREE.Group();
    frame.position.set(...shaftPoint(servo, geometry));
    frame.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(radial, axis, up));
    mechanism.add(frame);

    const bodyX = -(SERVO_BODY.radial / 2 - SERVO_BODY.shaftFromOuterEnd);
    const bodyY = -4 - SERVO_BODY.alongShaft / 2;
    const body = mesh(new THREE.BoxGeometry(SERVO_BODY.radial, SERVO_BODY.alongShaft, SERVO_BODY.height), materials.servo);
    body.position.set(bodyX, bodyY, 0);
    const tabs = mesh(new THREE.BoxGeometry(SERVO_BODY.radial + 9.7, 2.5, SERVO_BODY.height), materials.servo);
    tabs.position.set(bodyX, -8.5, 0);
    const bracketHeight = SHAFT_PLANE_HEIGHT - BASE_HEIGHT - SERVO_BODY.height / 2;
    const bracket = mesh(new THREE.BoxGeometry(SERVO_BODY.radial, SERVO_BODY.alongShaft, bracketHeight), materials.bracket);
    bracket.position.set(bodyX, bodyY, -SERVO_BODY.height / 2 - bracketHeight / 2);
    const spline = mesh(new THREE.CylinderGeometry(2.4, 2.4, 3, 20), materials.horn);
    spline.position.set(0, -2.5, 0);
    frame.add(body, tabs, bracket, spline);

    // The horn turns about the shaft (local y); + angle lifts its tip.
    const pivot = new THREE.Group();
    frame.add(pivot);
    const arm = mesh(new THREE.BoxGeometry(geometry.hornLengthMm + 7, 2, 5), materials.horn);
    arm.position.x = (geometry.hornLengthMm + 7) / 2 - 4;
    const hub = mesh(new THREE.CylinderGeometry(3.6, 3.6, 2.4, 24), materials.horn);
    const tip = mesh(new THREE.SphereGeometry(3, 20, 14), materials.joint);
    tip.position.x = geometry.hornLengthMm;
    pivot.add(arm, hub, tip);
    hornPivots.push(pivot);
    hornTipMarkers.push(tip);
  }

  // ---- legs (re-aimed every frame) ----
  const legs = SERVO_INDICES.map(() => {
    const leg = mesh(new THREE.CylinderGeometry(1.6, 1.6, 1, 16), materials.leg);
    mechanism.add(leg);
    return leg;
  });

  // ---- platform, head and face ----
  const platform = new THREE.Group();
  platform.matrixAutoUpdate = false;
  mechanism.add(platform);
  for (const servo of SERVO_INDICES) {
    const joint = platformJointLocal(servo, geometry);
    const ball = mesh(new THREE.SphereGeometry(3.2, 20, 14), materials.joint);
    ball.position.set(...joint);
    const stud = mesh(zCylinder(1.5, 1.5, PLATE_BOTTOM, 16), materials.joint);
    stud.position.set(joint[0], joint[1], PLATE_BOTTOM / 2);
    platform.add(ball, stud);
  }
  const plateRadius = geometry.platformRadiusMm + 7;
  const plate = mesh(zCylinder(plateRadius, plateRadius, PLATE_TOP - PLATE_BOTTOM, 96), materials.plate);
  plate.position.z = (PLATE_TOP + PLATE_BOTTOM) / 2;
  platform.add(plate);

  const gltf = await new GLTFLoader().loadAsync(headModelUrl);
  const head = gltf.scene;
  const screen = head.userData.screenWindow as ScreenWindow | undefined;
  if (!screen || !(screen.widthMm > 0) || !(screen.heightMm > 0)) throw new Error('Head model has no screen window measurements');
  head.position.z = PLATE_TOP;
  head.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  const diffuser = head.getObjectByName('led-diffuser');
  if (!(diffuser instanceof THREE.Mesh)) throw new Error('Head model has no LED diffuser');
  const ledRing = createLedRingMaterial();
  diffuser.material = ledRing.material;
  diffuser.castShadow = false;
  // Measured before the head is attached, so the box is in the platform's frame.
  const headBox = new THREE.Box3().setFromObject(head, true);
  platform.add(head);

  // Screen: an 800×480 (5:3) panel filling the window's width, on a black backing that fills the opening.
  const faceTexture = new THREE.CanvasTexture(faceCanvas);
  faceTexture.colorSpace = THREE.SRGBColorSpace;
  faceTexture.anisotropy = 4;
  // Plane axes: x → Peeqo's left (+Y, the viewer's right), y → up (+Z), normal → forward (+X).
  const facing = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
  const backing = new THREE.Mesh(new THREE.PlaneGeometry(screen.widthMm, screen.heightMm), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  backing.quaternion.setFromRotationMatrix(facing);
  backing.position.set(screen.frontXMm - 3, screen.centerYMm, screen.centerZMm);
  const displayHeight = Math.min(screen.heightMm, (screen.widthMm * FACE_HEIGHT) / FACE_WIDTH);
  const displayWidth = (displayHeight * FACE_WIDTH) / FACE_HEIGHT;
  const display = new THREE.Mesh(
    new THREE.PlaneGeometry(displayWidth, displayHeight),
    new THREE.MeshBasicMaterial({ map: faceTexture, toneMapped: false }),
  );
  display.name = 'face-display';
  display.quaternion.setFromRotationMatrix(facing);
  display.position.set(screen.frontXMm - 2.9, screen.centerYMm, screen.centerZMm);
  head.add(backing, display);

  // ---- ghost: where the head was asked to go when that is outside the safe range ----
  const ghost = new THREE.Group();
  ghost.matrixAutoUpdate = false;
  ghost.visible = false;
  const headSize = headBox.getSize(new THREE.Vector3());
  const headCenter = headBox.getCenter(new THREE.Vector3());
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(headSize.x, headSize.y, headSize.z)), materials.ghost);
  outline.position.copy(headCenter);
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 96 }, (_, i) => {
        const a = (i / 96) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * plateRadius, Math.sin(a) * plateRadius, PLATE_TOP);
      }),
    ),
    materials.ghost,
  );
  ghost.add(outline, ring);
  mechanism.add(ghost);

  const up = new THREE.Vector3(0, 1, 0);
  const update = (pose: Pose): IkSolution => {
    const ik = solveIk(pose, geometry);
    if (!ik.reachable) throw new Error('RobotView.update was given an unreachable pose; only governor output may be drawn');
    platform.matrix.copy(matrixFromMat3(ik.rotation, ik.position));
    platform.matrixWorldNeedsUpdate = true;
    for (const servo of SERVO_INDICES) {
      const leg = ik.legs[servo];
      hornPivots[servo]!.rotation.y = -leg.hornRad;
      const a = new THREE.Vector3(...leg.hornTip);
      const b = new THREE.Vector3(...leg.platformJoint);
      const along = b.clone().sub(a);
      const legMesh = legs[servo]!;
      legMesh.position.copy(a).addScaledVector(along, 0.5);
      legMesh.scale.set(1, along.length(), 1);
      legMesh.quaternion.setFromUnitVectors(up, along.normalize());
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

  const drawnHornTips = (): Vec3[] => {
    root.updateMatrixWorld(true);
    const toPeeqo = new THREE.Matrix4().copy(mechanism.matrixWorld).invert();
    return hornTipMarkers.map((tip) => {
      const p = tip.getWorldPosition(new THREE.Vector3()).applyMatrix4(toPeeqo);
      return [p.x, p.y, p.z];
    });
  };

  return { root, faceTexture, update, setRequested, setLeds: ledRing.setPixels, drawnHornTips };
}
