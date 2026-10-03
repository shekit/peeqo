// Computes collision-clearance tables for the dev kit from its CAD meshes and writes them into the core.
//
//   npm run build:clearance -w @peeqo/sim
//
// Reads src/assets/peeqo-devkit.glb (made by build-model.mjs) and writes packages/core/src/devKitClearance.ts.
//
// Method. The mechanism is posed by a few joint values per leg k: the horn angle α (servo), the leg's swing λ
// about its horn pin, and the leg's rotation relative to the platform at the rod end (swing μ about the screw,
// tilt τ about the radial axis, twist ω about the leg). Every pair of rigid bodies that can meet depends on
// only some of these, so clearance is tabulated per pair:
//   horn k  ↔ static     over α               (1-D)
//   leg k   ↔ static     over (α, λ)          (2-D)
//   leg k   ↔ platform   over (μ, τ), worst case over the twist range seen in the workspace
//   leg k   ↔ horn k     over α + λ           (verified everywhere; no table needed if never close)
//   horn i  ↔ horn j     over (α_i, α_j)      (neighbouring U-horns pass close to each other)
//   all other pairs (head ↔ base, leg ↔ other legs, …) are verified over every joint value the tables admit.
// Distances are exact triangle-to-triangle distances (three-mesh-bvh), measured in parallel worker threads
// (tools/lib/clearance.mjs). Each table cell stores a GUARANTEED clearance for any joint values inside the cell:
// the smallest distance measured at its corners minus the most any point can move between a corner and anywhere
// in the cell. Joint hardware is excluded from its own joint (the rod-end ball and screw from their eye; the
// servo hubs from the servo body they bear on).

import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import * as THREE from 'three';
import { loadParts, poser } from './lib/bodies.mjs';
import { BODY_AXIS, DEG, legSplit, reach } from './lib/clearance.mjs';
import { DEV_KIT_GEOMETRY } from '../../../packages/core/src/geometry.ts';
import { platformTransform, solveIk } from '../../../packages/core/src/kinematics.ts';
import { DEFAULT_SAFETY_LIMITS } from '../../../packages/core/src/limits.ts';

const glbPath = fileURLToPath(new URL('../src/assets/peeqo-devkit.glb', import.meta.url));
const outPath = fileURLToPath(new URL('../../../packages/core/src/devKitClearance.ts', import.meta.url));
const fail = (message) => {
  console.error(`build-clearance: ${message}`);
  process.exit(1);
};
const log = (message) => console.log(`[${(performance.now() / 1000).toFixed(0)} s] ${message}`);

/** Every pair of bodies must stay at least this far apart (mm). */
const MARGIN_MM = 0.5;

const { info, parts } = await loadParts(glbPath);
const glbHash = createHash('sha256').update(fs.readFileSync(glbPath)).digest('hex').slice(0, 16);
const geometry = { ...DEV_KIT_GEOMETRY, legAnglesDeg: info.legAnglesDeg, shaftHeightMm: info.shaftHeightMm };
for (const key of ['baseRadiusMm', 'hornLengthMm', 'platformRadiusMm', 'legLengthMm', 'homeHeightMm']) {
  if (Math.abs(info.measured[key] - DEV_KIT_GEOMETRY[key]) > 0.01) fail(`model ${key} ${info.measured[key]} does not match DEV_KIT_GEOMETRY`);
}
const P = poser(geometry);
const I = P.identity;
const H = geometry.hornLengthMm;
const select = (f) => parts.filter(f);

// ---------- worker pool ----------
const WORKERS = Math.max(1, os.availableParallelism() - 1);
const workers = Array.from({ length: WORKERS }, () => new Worker(new URL('./lib/clearance-worker.mjs', import.meta.url), { workerData: { glbPath } }));
const idle = [...workers];
const queue = [];
const pending = new Map();
let nextId = 0;
function dispatch() {
  while (idle.length && queue.length) {
    const worker = idle.pop();
    const job = queue.shift();
    pending.set(job.id, job);
    worker.postMessage({ id: job.id, kind: job.kind, args: job.args });
  }
}
for (const worker of workers) {
  worker.on('message', ({ id, values, error }) => {
    const job = pending.get(id);
    pending.delete(id);
    if (error) fail(`a worker failed: ${error}`);
    idle.push(worker);
    dispatch();
    job.resolve(values);
  });
  worker.on('error', (error) => fail(`a worker crashed: ${error.stack ?? error}`));
}
/** Measures sample points in parallel; `args(chunk)` gives the measurer's arguments for a chunk of points. */
async function measure(kind, points, args) {
  const size = Math.max(1, Math.ceil(points.length / (WORKERS * 2)));
  const chunks = [];
  for (let s = 0; s < points.length; s += size) {
    const chunk = points.slice(s, s + size);
    chunks.push(new Promise((resolve) => queue.push({ id: nextId++, kind, args: args(chunk), resolve })));
  }
  dispatch();
  return (await Promise.all(chunks)).flat();
}

// ---------- grids ----------
const axisPoints = (range, step) => Array.from({ length: Math.round((range[1] - range[0]) / step) + 1 }, (_, i) => range[0] + i * step);
const gridPoints = (rangeA, stepA, rangeB, stepB) => axisPoints(rangeA, stepA).flatMap((a) => axisPoints(rangeB, stepB).map((b) => [a, b]));
/** 1-D guaranteed clearances: each cell is the smaller of its end samples less the motion over half a step. */
function cells1(range, step, samples, motionPerDeg) {
  const slack = motionPerDeg * (step / 2);
  return { start: range[0], step, n: samples.length, cells: Array.from({ length: samples.length - 1 }, (_, i) => Math.min(samples[i], samples[i + 1]) - slack) };
}
/** 2-D guaranteed clearances: each cell is the smallest of its corner samples less `slack`. */
function cells2(rangeA, stepA, rangeB, stepB, samples, slack) {
  const na = axisPoints(rangeA, stepA).length;
  const nb = axisPoints(rangeB, stepB).length;
  if (samples.length !== na * nb) fail(`grid has ${samples.length} samples, expected ${na * nb}`);
  const cells = [];
  for (let i = 0; i < na - 1; i++) {
    for (let j = 0; j < nb - 1; j++) {
      cells.push(Math.min(samples[i * nb + j], samples[(i + 1) * nb + j], samples[i * nb + j + 1], samples[(i + 1) * nb + j + 1]) - slack);
    }
  }
  return { startA: rangeA[0], stepA, na, startB: rangeB[0], stepB, nb, cells };
}
const pad = (r, by) => [Math.floor(r[0] - by), Math.ceil(r[1] + by)];

// ---------- workspace: every pose the kinematics allow, generously ----------
// Horns −6°…104°, reach ratio up to 0.99 and rod-end misalignment up to 30°: wider than anything the safety
// limits allow, so every safe pose lies within half a grid step of a sampled one.
log(`mapping the workspace (${WORKERS} worker threads)`);
const legYaw = (k) => geometry.legAnglesDeg[k] * DEG;
function jointValues(pose) {
  const ik = solveIk(pose, DEV_KIT_GEOMETRY);
  if (!ik.reachable) return null;
  const R = new THREE.Matrix4().set(...ik.rotation.slice(0, 3), 0, ...ik.rotation.slice(3, 6), 0, ...ik.rotation.slice(6, 9), 0, 0, 0, 0, 1);
  return [0, 1, 2].map((k) => {
    const leg = ik.legs[k];
    const yaw = new THREE.Matrix4().makeRotationZ(legYaw(k));
    const d = new THREE.Vector3(...leg.platformJoint).sub(new THREE.Vector3(...leg.hornTip)).applyMatrix4(new THREE.Matrix4().makeRotationZ(-legYaw(k)));
    const lambda = Math.atan2(d.x, d.z);
    const legFrame = yaw.clone().multiply(new THREE.Matrix4().makeRotationY(lambda));
    const platFrame = R.clone().multiply(yaw);
    const rel = platFrame.clone().invert().multiply(legFrame);
    const e = new THREE.Euler().setFromRotationMatrix(rel, 'YXZ');
    return { alpha: leg.hornRad / DEG, lambda: lambda / DEG, mu: e.y / DEG, tau: e.x / DEG, omega: e.z / DEG, ratio: Math.abs(leg.reachRatio) };
  });
}
const ranges = { alpha: [Infinity, -Infinity], lambda: [Infinity, -Infinity], mu: [Infinity, -Infinity], tau: [Infinity, -Infinity], omega: [Infinity, -Infinity] };
const workspace = [];
const keyOf = (p, r, h) => `${p},${r},${h}`;
const byKey = new Map();
for (let pitch = -40; pitch <= 40; pitch += 1) {
  for (let roll = -40; roll <= 40; roll += 1) {
    for (let heave = -8; heave <= 12; heave += 1) {
      const j = jointValues({ pitchDeg: pitch, rollDeg: roll, heaveMm: heave });
      if (!j) continue;
      if (j.some((v) => v.alpha < -6 || v.alpha > 104 || v.ratio > 0.99 || Math.hypot(v.tau, v.omega) > 30)) continue;
      const w = { pitch, roll, heave, j };
      workspace.push(w);
      byKey.set(keyOf(pitch, roll, heave), w);
      for (const v of j) for (const key of Object.keys(ranges)) ranges[key] = [Math.min(ranges[key][0], v[key]), Math.max(ranges[key][1], v[key])];
    }
  }
}
log(`workspace: ${workspace.length} poses (pitch ${Math.min(...workspace.map((w) => w.pitch))}…${Math.max(...workspace.map((w) => w.pitch))}°, roll ±${Math.max(...workspace.map((w) => w.roll))}°, heave ${Math.min(...workspace.map((w) => w.heave))}…${Math.max(...workspace.map((w) => w.heave))} mm); ${Object.entries(ranges).map(([k, [a, b]]) => `${k} ${a.toFixed(1)}…${b.toFixed(1)}°`).join(', ')}`);

const tables = { horn: [], legStatic: [], legPlatform: [], hornPair: [] };
const verified = {};
const lookup1 = (t, x) => {
  const i = Math.floor((x - t.start) / t.step);
  return i >= 0 && i < t.cells.length ? t.cells[i] : -Infinity;
};

// ---------- 1. horn k ↔ static, over α ----------
// The hubs bear on the servo body by design (they turn in place on it), so they are checked against the rest.
const hornReachAll = Math.max(...[0, 1, 2].map((k) => reach(select((p) => p.body === `horn-${k}`), new THREE.Vector3(), BODY_AXIS)));
const hornRange = pad(ranges.alpha, 1);
const hornSamples = await Promise.all([0, 1, 2].map((k) => measure('horn', axisPoints(hornRange, 0.1), (chunk) => [k, chunk])));
for (const k of [0, 1, 2]) {
  tables.horn[k] = cells1(hornRange, 0.1, hornSamples[k], hornReachAll * DEG);
  const free = tables.horn[k].cells.flatMap((c, i) => (c >= MARGIN_MM ? [hornRange[0] + i * 0.1] : []));
  const end = Math.max(...free) + 0.1;
  log(`leg ${k}: horn↔base table done; horn is clear from ${Math.min(...free).toFixed(1)}° to ${end.toFixed(1)}°${end >= hornRange[1] - 1e-6 ? ' (the end of the table)' : ''}`);
}

// ---------- 2. candidate poses: horns clear of the base, within reach, rod ends within their tilt limit ----------
// (Computed here from the kinematics rather than with checkPose, which itself uses these tables.)
const rodEndTiltDeg = (ik, k) => {
  const b = legYaw(k);
  const n = [-Math.sin(b), Math.cos(b), 0];
  const m = ik.rotation;
  const rn = [m[0] * n[0] + m[1] * n[1] + m[2] * n[2], m[3] * n[0] + m[4] * n[1] + m[5] * n[2], m[6] * n[0] + m[7] * n[1] + m[8] * n[2]];
  const cross = [n[1] * rn[2] - n[2] * rn[1], n[2] * rn[0] - n[0] * rn[2], n[0] * rn[1] - n[1] * rn[0]];
  return Math.atan2(Math.hypot(...cross), n[0] * rn[0] + n[1] * rn[1] + n[2] * rn[2]) / DEG;
};
const candidates = workspace.filter((w) => {
  if (!w.j.every((v, k) => lookup1(tables.horn[k], v.alpha) >= MARGIN_MM)) return false;
  const ik = solveIk({ pitchDeg: w.pitch, rollDeg: w.roll, heaveMm: w.heave }, DEV_KIT_GEOMETRY);
  return [0, 1, 2].every((k) => Math.abs(ik.legs[k].reachRatio) <= DEFAULT_SAFETY_LIMITS.maxReachRatio && rodEndTiltDeg(ik, k) <= DEFAULT_SAFETY_LIMITS.maxRodEndTiltDeg);
});
// Tables must also cover every pose within a grid step of a candidate.
const covered = new Set();
for (const w of candidates) {
  for (let dp = -1; dp <= 1; dp++) for (let dr = -1; dr <= 1; dr++) for (let dh = -1; dh <= 1; dh++) {
    const n = byKey.get(keyOf(w.pitch + dp, w.roll + dr, w.heave + dh));
    if (n) covered.add(n);
  }
}
const cover = [...covered];
const span = { alpha: [Infinity, -Infinity], lambda: [Infinity, -Infinity], mu: [Infinity, -Infinity], tau: [Infinity, -Infinity], omega: [Infinity, -Infinity] };
for (const w of cover) for (const v of w.j) for (const key of Object.keys(span)) span[key] = [Math.min(span[key][0], v[key]), Math.max(span[key][1], v[key])];
log(`candidates: ${candidates.length} poses (${cover.length} with neighbours); ${Object.entries(span).map(([k, [a, b]]) => `${k} ${a.toFixed(1)}…${b.toFixed(1)}°`).join(', ')}`);

// ---------- 3. per-leg tables over the candidate ranges ----------
const omegaMax = Math.max(Math.abs(span.omega[0]), Math.abs(span.omega[1])) + 0.5;
const twistStep = omegaMax / 2;
const alphaRange = pad(span.alpha, 2);
const lambdaRange = pad(span.lambda, 2);
// Poses outside the leg↔base table are refused, so leg ↔ own horn is verified over every α + λ it admits.
const relRange = [alphaRange[0] + lambdaRange[0], alphaRange[1] + lambdaRange[1]];
const muRange = pad(span.mu, 2);
const tauRange = pad(span.tau, 2);
async function legTables(k) {
  // Leg ↔ static: fine near the pin, the rest certified on a coarse grid. λ turns the leg about its pin axis;
  // α only moves the pin, by at most H per radian.
  const pin = legSplit(parts, k, 'pin', geometry.legLengthMm);
  // Leg ↔ platform: about the rod-end ball. Rotation (μ, τ, ω) moves a point at most its distance from the ball
  // times |Δμ| + |Δτ| + |Δω|.
  const top = legSplit(parts, k, 'top', geometry.legLengthMm);
  const [staticFar, staticNear, horn, platformFar, platformNear] = await Promise.all([
    measure('legStatic', gridPoints(alphaRange, 2, lambdaRange, 2), (chunk) => [k, 'far', chunk]),
    measure('legStatic', gridPoints(alphaRange, 0.5, lambdaRange, 0.25), (chunk) => [k, 'near', chunk]),
    measure('legHorn', axisPoints(relRange, 0.5), (chunk) => [k, chunk]),
    measure('legPlatform', gridPoints(muRange, 2, tauRange, 2), (chunk) => [k, 'far', chunk, omegaMax, omegaMax]),
    measure('legPlatform', gridPoints(muRange, 0.5, tauRange, 0.5), (chunk) => [k, 'near', chunk, omegaMax, twistStep]),
  ]);

  const farMin = Math.min(...cells2(alphaRange, 2, lambdaRange, 2, staticFar, (pin.farReach * 1 + H * 1) * DEG).cells);
  if (farMin < MARGIN_MM) fail(`leg ${k}: the part of the leg away from its pin may come within ${farMin.toFixed(2)} mm of the base`);
  tables.legStatic[k] = cells2(alphaRange, 0.5, lambdaRange, 0.25, staticNear, (pin.nearReach * 0.125 + H * 0.25) * DEG);
  log(`leg ${k}: leg↔base table done (near part within ${pin.nearReach.toFixed(1)} mm of the pin axis; the rest, within ${pin.farReach.toFixed(1)} mm, guaranteed ≥ ${farMin.toFixed(2)} mm)`);

  const legPinReach = reach(select((p) => p.body === `leg-${k}`), new THREE.Vector3(), BODY_AXIS);
  const relMin = Math.min(...cells1(relRange, 0.5, horn, legPinReach * DEG).cells);
  if (relMin < MARGIN_MM) fail(`leg ${k} may come within ${relMin.toFixed(2)} mm of its horn; a leg↔horn table is needed`);
  verified[`leg-${k}|horn-${k}`] = relMin;
  log(`leg ${k}: leg↔own horn guaranteed ≥ ${relMin.toFixed(2)} mm (α + λ ${relRange[0]}…${relRange[1]}°)`);

  const farTopMin = Math.min(...cells2(muRange, 2, tauRange, 2, platformFar, top.farReach * (1 + 1 + omegaMax / 2) * DEG).cells);
  if (farTopMin < MARGIN_MM) fail(`leg ${k}: the lower leg may come within ${farTopMin.toFixed(2)} mm of the platform`);
  tables.legPlatform[k] = cells2(muRange, 0.5, tauRange, 0.5, platformNear, top.nearReach * (0.25 + 0.25 + twistStep / 2) * DEG);
  log(`leg ${k}: leg↔platform table done (twist up to ±${omegaMax.toFixed(2)}°; near part within ${top.nearReach.toFixed(1)} mm of the ball; the rest, within ${top.farReach.toFixed(1)} mm, guaranteed ≥ ${farTopMin.toFixed(2)} mm)`);
}

// ---------- 4. neighbouring horns, over (α_i, α_j) ----------
// Adjacent U-horns pass within a couple of millimetres of each other, so each neighbouring pair gets a table.
const hornPairList = [[0, 1], [1, 2], [2, 0]];
const alphaPairRange = pad(span.alpha, 1);
async function hornPairTable(n) {
  const [i, j] = hornPairList[n];
  const samples = await measure('hornPair', gridPoints(alphaPairRange, 0.5, alphaPairRange, 0.5), (chunk) => [i, j, chunk]);
  tables.hornPair[n] = cells2(alphaPairRange, 0.5, alphaPairRange, 0.5, samples, hornReachAll * (0.25 + 0.25) * DEG);
  log(`horns ${i}↔${j}: table done (closest ${Math.min(...samples).toFixed(2)} mm at the grid points)`);
}

// ---------- 5. every other pair, over everything the tables admit ----------
// A commanded pose is refused unless every joint value lies inside the tables above, so the remaining pairs are
// verified over all of those values, with exact motion bounds: a horn turned by δ moves its points at most
// (reach from its shaft axis)·δ; a leg swung by δ about its pin moves at most (reach from its pin axis)·δ, and its
// pin moves at most H·δ when its horn turns by δ. The head moves only with the pose (its place needs no IK), so
// pairs with the head are checked at every grid pose in a box two steps beyond the workspace, against every
// admitted horn angle; within half a grid step the head moves at most its reach·1° + 0.5 mm. The grid poses where
// they hold make up the covered region, and a pose is only commanded if its nearest grid pose is covered.
const admittedAlpha = [Math.max(hornRange[0], alphaRange[0], alphaPairRange[0]), Math.min(hornRange[1], alphaRange[1], alphaPairRange[1])];
const STEP = 2; // degrees: every admitted value lies within 1° of a sample
const steps = (range) => Array.from({ length: Math.ceil((range[1] - range[0]) / STEP - 1e-9) + 1 }, (_, i) => range[0] + i * STEP);
const alphas = steps(admittedAlpha);
const lambdas = steps(lambdaRange);
const legReachPin = Math.max(...[0, 1, 2].map((k) => reach(select((p) => p.body === `leg-${k}`), new THREE.Vector3(), BODY_AXIS)));
const platformReach = reach(select((p) => p.body === 'platform'), new THREE.Vector3());
const hornSlack = hornReachAll * (STEP / 2) * DEG;
const legSlack = (legReachPin + H) * (STEP / 2) * DEG;
const platformSlack = platformReach * (0.5 + 0.5) * DEG + 0.5;
/** Measures every sample (capped at margin + slack + 1 mm) and records the guaranteed minimum for the pair. */
async function verify(key, kind, points, args, slack) {
  const limit = MARGIN_MM + slack + 1;
  const measured = Math.min(...(await measure(kind, points, (chunk) => args(chunk, limit))));
  const d = measured - slack;
  if (d < MARGIN_MM) fail(`${key} may come within ${d.toFixed(2)} mm (${measured.toFixed(2)} mm at a sample, less ${slack.toFixed(2)} mm of motion between samples)`);
  verified[key] = d;
}
const extent = (key) => [Math.min(...workspace.map((w) => w[key])) - 2, Math.max(...workspace.map((w) => w[key])) + 2];
const coverBox = { pitch: extent('pitch'), roll: extent('roll'), heave: extent('heave') };
const gridPoses = [];
for (let pitch = coverBox.pitch[0]; pitch <= coverBox.pitch[1]; pitch++) {
  for (let roll = coverBox.roll[0]; roll <= coverBox.roll[1]; roll++) {
    for (let heave = coverBox.heave[0]; heave <= coverBox.heave[1]; heave++) gridPoses.push({ pitch, roll, heave });
  }
}
let headCover = [];
async function headPairs() {
  const platformPoses = gridPoses.map((w) => {
    const t = platformTransform({ pitchDeg: w.pitch, rollDeg: w.roll, heaveMm: w.heave }, DEV_KIT_GEOMETRY);
    return P.platform(t.rotation, t.position).elements;
  });
  const hornLimit = MARGIN_MM + platformSlack + hornSlack + 1;
  const [toStatic, ...toHorns] = await Promise.all([
    measure('platformStatic', platformPoses, (chunk) => [chunk, MARGIN_MM + platformSlack + 1]),
    ...[0, 1, 2].map((k) => measure('platformHorn', platformPoses.flatMap((pose) => alphas.map((alpha) => [pose, alpha])), (chunk) => [k, chunk, hornLimit])),
  ]);
  const guaranteed = gridPoses.map((_, n) => ({
    static: toStatic[n] - platformSlack,
    horns: toHorns.map((d) => Math.min(...d.slice(n * alphas.length, (n + 1) * alphas.length)) - platformSlack - hornSlack),
  }));
  const ok = guaranteed.map((g) => g.static >= MARGIN_MM && g.horns.every((h) => h >= MARGIN_MM));
  headCover = gridPoses.filter((_, n) => ok[n]);
  const kept = guaranteed.filter((_, n) => ok[n]);
  if (!candidates.every((w) => ok[gridPoses.findIndex((g) => g.pitch === w.pitch && g.roll === w.roll && g.heave === w.heave)])) {
    log('note: the head comes close to the base or a horn at some candidate poses; those poses are refused');
  }
  verified['static|platform'] = Math.min(...kept.map((g) => g.static));
  for (const k of [0, 1, 2]) verified[`platform|horn-${k}`] = Math.min(...kept.map((g) => g.horns[k]));
  log(`head pairs: hold at ${headCover.length} of ${gridPoses.length} grid poses (pitch ${coverBox.pitch.join('…')}°, roll ${coverBox.roll.join('…')}°, heave ${coverBox.heave.join('…')} mm)`);
}
async function otherPairs() {
  const legHornPoints = alphas.flatMap((ai) => lambdas.flatMap((li) => alphas.map((aj) => [ai, li, aj])));
  const legLegPoints = alphas.flatMap((ai) => lambdas.flatMap((li) => alphas.flatMap((aj) => lambdas.map((lj) => [ai, li, aj, lj]))));
  const others = [0, 1, 2].flatMap((i) => [0, 1, 2].filter((j) => j !== i).map((j) => [i, j]));
  await Promise.all([
    headPairs(),
    ...others.map(([i, j]) => verify(`leg-${i}|horn-${j}`, 'legOtherHorn', legHornPoints, (chunk, limit) => [i, j, chunk, limit], legSlack + hornSlack)),
    ...[[0, 1], [1, 2], [2, 0]].map(([i, j]) => verify(`leg-${i}|leg-${j}`, 'legLeg', legLegPoints, (chunk, limit) => [i, j, chunk, limit], 2 * legSlack)),
  ]);
  const keys = ['static|platform', ...[0, 1, 2].map((k) => `platform|horn-${k}`), ...others.map(([i, j]) => `leg-${i}|horn-${j}`), 'leg-0|leg-1', 'leg-1|leg-2', 'leg-2|leg-0'];
  const closest = keys.reduce((a, b) => (verified[a] <= verified[b] ? a : b));
  log(`other pairs: guaranteed ≥ ${verified[closest].toFixed(2)} mm (${closest}) over every admitted joint value (α ${admittedAlpha[0]}…${admittedAlpha[1]}°, λ ${lambdaRange[0]}…${lambdaRange[1]}°); each recorded as at least that, up to margin + 1 mm`);
}

await Promise.all([...[0, 1, 2].map(legTables), ...[0, 1, 2].map(hornPairTable), otherPairs()]);
for (const worker of workers) await worker.terminate();

// ---------- the region the head's pair checks cover, as a bitmap over the pose grid ----------
const dims = ['pitch', 'roll', 'heave'].map((k) => coverBox[k][1] - coverBox[k][0] + 1);
const bitArray = new Uint8Array(Math.ceil((dims[0] * dims[1] * dims[2]) / 8));
for (const w of headCover) {
  const index = ((w.pitch - coverBox.pitch[0]) * dims[1] + (w.roll - coverBox.roll[0])) * dims[2] + (w.heave - coverBox.heave[0]);
  bitArray[index >> 3] |= 1 << (index & 7);
}
const coverBits = Buffer.from(bitArray).toString('base64');

// ---------- write the core module ----------
const q = (v) => Math.floor(v * 100); // hundredths of a millimetre, rounded down: the values are lower bounds
const encode = (values) => Buffer.from(Int16Array.from(values.map((v) => Math.max(-32768, Math.min(32767, q(v))))).buffer).toString('base64');
const table2 = (t) => `{ startA: ${t.startA}, stepA: ${t.stepA}, na: ${t.na}, startB: ${t.startB}, stepB: ${t.stepB}, nb: ${t.nb}, cells: '${encode(t.cells)}' }`;
const header = `// Generated by apps/sim/tools/build-clearance.mjs from apps/sim/src/assets/peeqo-devkit.glb (sha256 ${glbHash}).
// Do not edit by hand. Regenerate after changing the robot model or the dev kit geometry.
`;
const body = `
/** Clearance tables for the dev kit; see apps/sim/tools/build-clearance.mjs for how they are made. */
export const DEV_KIT_CLEARANCE_DATA = {
  modelSha256: '${glbHash}',
  marginMm: ${MARGIN_MM},
  legAnglesDeg: [${geometry.legAnglesDeg.join(', ')}],
  geometry: ${JSON.stringify(Object.fromEntries(['baseRadiusMm', 'platformRadiusMm', 'hornLengthMm', 'legLengthMm', 'homeHeightMm'].map((k) => [k, DEV_KIT_GEOMETRY[k]])))},
  /** Largest rod-end twist the tables allow for (degrees). */
  maxTwistDeg: ${omegaMax.toFixed(3)},
  horn: [${tables.horn.map((t) => `{ start: ${t.start}, step: ${t.step}, n: ${t.n}, cells: '${encode(t.cells)}' }`).join(',\n    ')}],
  legStatic: [${tables.legStatic.map(table2).join(',\n    ')}],
  hornPair: [${tables.hornPair.map(table2).join(',\n    ')}],
  legPlatform: [${tables.legPlatform.map(table2).join(',\n    ')}],
  /**
   * Poses the head's pair checks cover: grid points (1° pitch and roll, 1 mm heave) as a bitmap. A pose is
   * covered when its nearest grid point is set.
   */
  cover: { pitch: [${coverBox.pitch.join(', ')}], roll: [${coverBox.roll.join(', ')}], heave: [${coverBox.heave.join(', ')}], bits: '${coverBits}' },
  /** Pairs verified over every admitted joint value and covered pose (guaranteed minimum clearance, mm). */
  verifiedMm: ${JSON.stringify(Object.fromEntries(Object.entries(verified).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, Math.floor(v * 100) / 100])))},
} as const;
`;
fs.writeFileSync(outPath, header + body);
log(`wrote ${outPath}`);
