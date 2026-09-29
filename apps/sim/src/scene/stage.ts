import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** Camera presets (three.js world: +Y up, Peeqo faces +X, Peeqo's left is −Z). Millimetres. */
export const VIEWS = {
  'three-quarter': { position: [560, 330, 330], target: [0, 150, 0] },
  front: { position: [720, 200, 0], target: [0, 165, 0] },
  side: { position: [0, 200, 720], target: [0, 150, 0] },
  top: { position: [0.01, 900, 0], target: [0, 150, 0] },
  face: { position: [330, 215, 0], target: [0, 212, 0] },
  neck: { position: [330, 120, 250], target: [0, 105, 0] },
} as const satisfies Record<string, { position: readonly number[]; target: readonly number[] }>;

export type ViewName = keyof typeof VIEWS;

export interface Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  setView(name: ViewName): void;
  render(): void;
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe4e7ec);
  // Fades the far edge of the floor into the background; the robot is well inside the fog's start.
  scene.fog = new THREE.Fog(0xe4e7ec, 1300, 2600);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8c919b, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(420, 760, 320);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -320;
  sun.shadow.camera.right = 320;
  sun.shadow.camera.top = 320;
  sun.shadow.camera.bottom = -320;
  sun.shadow.camera.near = 100;
  sun.shadow.camera.far = 2000;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(900, 96),
    new THREE.MeshStandardMaterial({ color: 0xd3d7dd, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(32, 1, 1, 6000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = 150;
  controls.maxDistance = 1800;
  controls.maxPolarAngle = Math.PI * 0.495;

  const setView = (name: ViewName): void => {
    const view = VIEWS[name];
    camera.position.set(view.position[0], view.position[1], view.position[2]);
    controls.target.set(view.target[0], view.target[1], view.target[2]);
    controls.update();
  };
  setView('three-quarter');

  const resize = (): void => {
    const { clientWidth, clientHeight } = canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  return {
    renderer,
    scene,
    camera,
    controls,
    setView,
    render: () => {
      controls.update();
      renderer.render(scene, camera);
    },
  };
}
