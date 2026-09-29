// Builds the simulator's stand-in head model from the 2016 Peeqo CAD assembly.
//
//   npm run build:head-model -w @peeqo/sim -- <path/to/peeqo_design.iges> [output.glb]
//
// Source: peeqo-robot-hardware/3d_design/peeqo_design.iges (exported 2016-12-01, the v1 robot). Only the head
// parts are kept (shell, side grilles, dome cap, LED diffuser); the neck in that file is the v1 design and is
// replaced in the simulator by the 2019 platform geometry. The output GLB is in Peeqo's head frame:
// +X forward, +Y Peeqo's left, +Z up, millimetres, origin at the bottom centre of the head shell.
// Measurements the simulator needs (screen window, LED ring) are stored in the scene's extras.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import occtimportjs from 'occt-import-js';
import { Document, NodeIO } from '@gltf-transform/core';

const [igesPath, outArg] = process.argv.slice(2);
if (!igesPath) {
  console.error('Usage: node tools/build-head-model.mjs <peeqo_design.iges> [output.glb]');
  process.exit(1);
}
const outPath = outArg ?? fileURLToPath(new URL('../src/assets/peeqo-v1-head.glb', import.meta.url));

function fail(message) {
  console.error(`build-head-model: ${message}`);
  process.exit(1);
}

const occt = await occtimportjs();
const result = occt.ReadIgesFile(new Uint8Array(fs.readFileSync(igesPath)), {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
});
if (!result.success) fail('OpenCascade could not read the IGES file');

const named = new Map((result.root.children ?? []).map((node) => [node.name, node]));
for (const name of ['head', 'ASSEMBLY']) if (!named.has(name)) fail(`assembly has no "${name}" component`);

// ---- helpers over occt meshes (IGES frame: +Y up, +Z front, X to Peeqo's left) ----
const meshInfo = (index) => {
  const mesh = result.meshes[index];
  const p = mesh.attributes.position.array;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let rMin = Infinity;
  let rMax = 0;
  for (let k = 0; k < p.length; k += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[k + a]);
      max[a] = Math.max(max[a], p[k + a]);
    }
    const r = Math.hypot(p[k], p[k + 2]);
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
  }
  return { index, mesh, min, max, rMin, rMax, triangles: mesh.index.array.length / 3 };
};
const byTriangles = (a, b) => b.triangles - a.triangles;

const headMeshes = named.get('head').meshes.map(meshInfo).sort(byTriangles);
const capMeshes = named.get('ASSEMBLY').meshes.map(meshInfo).sort(byTriangles);

const shell = headMeshes[0];
const grilles = headMeshes.filter((m) => m.min[0] >= 61.9 || m.max[0] <= -61.9);
const cap = capMeshes[0];
const diffusers = capMeshes.filter(
  (m) => Math.abs(m.rMin - 25) < 0.5 && Math.abs(m.rMax - 30) < 0.5 && Math.abs(m.max[1] - m.min[1] - 3.63) < 0.2,
);
if (!shell || shell.max[2] < 74) fail('could not identify the head shell');
if (grilles.length !== 2) fail(`expected 2 side grilles, found ${grilles.length}`);
if (!cap || cap.rMax < 80) fail('could not identify the dome cap');
if (diffusers.length !== 1) fail(`expected 1 LED diffuser ring, found ${diffusers.length}`);

const bottomY = shell.min[1];

// ---- measure the screen window: rasterise the frontmost face of the shell and find the hole ----
function measureWindow(info) {
  const p = info.mesh.attributes.position.array;
  const idx = info.mesh.index.array;
  const front = info.max[2];
  const res = 0.25;
  const x0 = -70;
  const y0 = bottomY - 5;
  const W = Math.round(140 / res);
  const H = Math.round((info.max[1] - bottomY + 10) / res);
  const grid = new Uint8Array(W * H);
  const v = (i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
  const edge = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let t = 0; t < idx.length; t += 3) {
    const a = v(idx[t]);
    const b = v(idx[t + 1]);
    const c = v(idx[t + 2]);
    if (Math.min(a[2], b[2], c[2]) < front - 0.05) continue;
    const gx0 = Math.floor((Math.min(a[0], b[0], c[0]) - x0) / res);
    const gx1 = Math.ceil((Math.max(a[0], b[0], c[0]) - x0) / res);
    const gy0 = Math.floor((Math.min(a[1], b[1], c[1]) - y0) / res);
    const gy1 = Math.ceil((Math.max(a[1], b[1], c[1]) - y0) / res);
    for (let gy = Math.max(0, gy0); gy <= Math.min(H - 1, gy1); gy++) {
      for (let gx = Math.max(0, gx0); gx <= Math.min(W - 1, gx1); gx++) {
        const q = [x0 + (gx + 0.5) * res, y0 + (gy + 0.5) * res];
        const d1 = edge(a, b, q);
        const d2 = edge(b, c, q);
        const d3 = edge(c, a, q);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) grid[gy * W + gx] = 1;
      }
    }
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      if (!grid[gy * W + gx]) continue;
      minX = Math.min(minX, gx); maxX = Math.max(maxX, gx); minY = Math.min(minY, gy); maxY = Math.max(maxY, gy);
    }
  }
  const cx = Math.round((minX + maxX) / 2);
  const cy = Math.round((minY + maxY) / 2);
  if (grid[cy * W + cx]) fail('the front face has no opening at its centre');
  const walk = (dx, dy) => {
    let x = cx;
    let y = cy;
    while (x >= 0 && y >= 0 && x < W && y < H && !grid[y * W + x]) { x += dx; y += dy; }
    return { x: x0 + x * res, y: y0 + y * res };
  };
  const left = walk(-1, 0).x + res; // first filled cell's near edge
  const right = walk(1, 0).x;
  const bottom = walk(0, -1).y + res;
  const top = walk(0, 1).y;
  return { front, left, right, bottom, top };
}
const win = measureWindow(shell);
const windowWidth = win.right - win.left;
const windowHeight = win.top - win.bottom;
if (!(windowWidth > 80 && windowWidth < 110 && windowHeight > 50 && windowHeight < 70)) {
  fail(`screen window measured ${windowWidth.toFixed(2)} × ${windowHeight.toFixed(2)} mm, which is not plausible`);
}

// ---- convert to the head frame and write the GLB ----
// IGES (x, y, z) → head (X, Y, Z) = (z, x, y − bottomY). A cyclic permutation, so triangle winding is preserved.
const toHead = (x, y, z) => [z, x, y - bottomY];

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('peeqo-v1-head');

function material(name, rgb, roughness) {
  return doc.createMaterial(name).setBaseColorFactor([...rgb, 1]).setRoughnessFactor(roughness).setMetallicFactor(0);
}
const materials = {
  shell: material('head-shell', [0.86, 0.86, 0.84], 0.55),
  grille: material('grille', [0.62, 0.64, 0.67], 0.6),
  cap: material('head-cap', [0.9, 0.89, 0.87], 0.5),
  diffuser: material('led-diffuser', [0.8, 0.8, 0.82], 0.35),
};

function addPart(name, info, mat) {
  const src = info.mesh.attributes.position.array;
  const nrm = info.mesh.attributes.normal?.array;
  if (!nrm || nrm.length !== src.length) fail(`${name}: mesh has no per-vertex normals`);
  const positions = new Float32Array(src.length);
  const normals = new Float32Array(src.length);
  for (let k = 0; k < src.length; k += 3) {
    positions.set(toHead(src[k], src[k + 1], src[k + 2]), k);
    normals.set([nrm[k + 2], nrm[k], nrm[k + 1]], k);
  }
  const vertexCount = src.length / 3;
  const indices = vertexCount < 65536 ? new Uint16Array(info.mesh.index.array) : new Uint32Array(info.mesh.index.array);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
    .setMaterial(mat);
  scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
}

addPart('head-shell', shell, materials.shell);
for (const g of grilles) addPart(g.min[0] >= 61.9 ? 'grille-left' : 'grille-right', g, materials.grille);
addPart('head-cap', cap, materials.cap);
addPart('led-diffuser', diffusers[0], materials.diffuser);

const round = (n) => Math.round(n * 100) / 100;
const diffuser = diffusers[0];
const extras = {
  frame: '+X forward, +Y Peeqo left, +Z up, millimetres; origin at the bottom centre of the head shell',
  source: `${path.basename(igesPath)} (Peeqo v1 CAD, 2016-12-01), converted with occt-import-js`,
  screenWindow: {
    frontXMm: round(win.front),
    centerYMm: round((win.left + win.right) / 2),
    centerZMm: round((win.bottom + win.top) / 2 - bottomY),
    widthMm: round(windowWidth),
    heightMm: round(windowHeight),
  },
  ledRing: {
    innerRadiusMm: round(diffuser.rMin),
    outerRadiusMm: round(diffuser.rMax),
    topZMm: round(diffuser.max[1] - bottomY),
  },
  heightMm: round(cap.max[1] - bottomY),
};
scene.setExtras(extras);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, await new NodeIO().writeBinary(doc));
console.log(`Wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(2)} MB)`);
console.log(JSON.stringify(extras, null, 2));
