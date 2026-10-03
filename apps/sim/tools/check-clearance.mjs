// Independent check of the collision tables, through the core's own safety check.
//
//   npm run check:clearance -w @peeqo/sim
//
// Samples poses the core accepts (checkPose ok): random ones across the covered range, and ones on the edge of
// the safe range, where the governor stops unsafe requests and parts come closest. At each, every pair of rigid
// bodies is posed from the core's own joint values (not the table builder's) and the exact mesh-to-mesh gap is
// measured. Fails if any measured gap is below what the core promised for that pair: its table reading at that
// pose, or the pair's verified minimum (either is at least the 0.5 mm margin). Leg ↔ platform gets 0.25 mm of
// slack: the tables pose that pair exactly about the rod end's ball, while posing the two bodies separately from
// the kinematic model carries its 0.2 mm error.

import { fileURLToPath } from 'node:url';
import { loadParts, bvhOf, gap, poser } from './lib/bodies.mjs';
import { DEV_KIT_GEOMETRY, checkPose, clampToSafe, findNeutralPose } from '../../../packages/core/src/index.ts';
import { DEV_KIT_CLEARANCE_DATA } from '../../../packages/core/src/devKitClearance.ts';

const glbPath = fileURLToPath(new URL('../src/assets/peeqo-devkit.glb', import.meta.url));
const RANDOM_POSES = 250;
const EDGE_POSES = 250;
const CAP_MM = 3;
const MODEL_SLACK_MM = 0.25;

const { info, parts } = await loadParts(glbPath);
const geometry = { ...DEV_KIT_GEOMETRY, legAnglesDeg: info.legAnglesDeg, shaftHeightMm: info.shaftHeightMm };
const P = poser(geometry);
const pick = (f) => bvhOf(parts.filter(f));
const isJointOf = (p, k) => (p.role === 'rod-end-ball' || p.role === 'rod-end-screw') && p.leg === k;

// Same pairs and joint exclusions as tools/build-clearance.mjs and the sim's collision probe.
const geoms = {
  static: pick((p) => p.body === 'static'),
  'static-no-servo': pick((p) => p.body === 'static' && p.role !== 'servo-body'),
  platform: pick((p) => p.body === 'platform'),
};
const pairs = [];
for (const k of [0, 1, 2]) {
  geoms[`horn-${k}`] = pick((p) => p.body === `horn-${k}`);
  geoms[`horn-${k}-main`] = pick((p) => p.body === `horn-${k}` && p.role !== 'servo-hub');
  geoms[`horn-${k}-hubs`] = pick((p) => p.body === `horn-${k}` && p.role === 'servo-hub');
  geoms[`leg-${k}`] = pick((p) => p.body === `leg-${k}`);
  geoms[`leg-${k}-no-pin`] = pick((p) => p.body === `leg-${k}` && p.role !== 'pin');
  geoms[`platform-no-joint-${k}`] = pick((p) => p.body === 'platform' && !isJointOf(p, k));
  pairs.push(
    [`horn-${k}-main`, `horn-${k}`, 'static', 'static', `horn ${k} and the base`, 0, null],
    [`horn-${k}-hubs`, `horn-${k}`, 'static-no-servo', 'static', `horn ${k} hubs and the base`, 0, null],
    [`leg-${k}`, `leg-${k}`, 'static', 'static', `leg ${k} and the base`, 0, null],
    [`leg-${k}-no-pin`, `leg-${k}`, `horn-${k}`, `horn-${k}`, `leg ${k} and its horn`, 0, `leg-${k}|horn-${k}`],
    [`leg-${k}`, `leg-${k}`, `platform-no-joint-${k}`, 'platform', `leg ${k} and the platform`, MODEL_SLACK_MM, null],
    [`horn-${k}`, `horn-${k}`, 'platform', 'platform', `horn ${k} and the platform`, 0, `platform|horn-${k}`],
  );
}
for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
  pairs.push(
    [`horn-${i}`, `horn-${i}`, `horn-${j}`, `horn-${j}`, `horns ${i} and ${j}`, 0, null],
    [`leg-${i}`, `leg-${i}`, `leg-${j}`, `leg-${j}`, `legs ${i} and ${j}`, 0, `leg-${i}|leg-${j}`],
    [`leg-${i}`, `leg-${i}`, `horn-${j}`, `horn-${j}`, `leg ${i} and horn ${j}`, 0, `leg-${i}|horn-${j}`],
    [`leg-${j}`, `leg-${j}`, `horn-${i}`, `horn-${i}`, `leg ${j} and horn ${i}`, 0, `leg-${j}|horn-${i}`],
  );
}
pairs.push(['static', 'static', 'platform', 'platform', 'the head and the base', 0, 'static|platform']);
for (const p of pairs) if (p[6] !== null && !(p[6] in DEV_KIT_CLEARANCE_DATA.verifiedMm)) throw new Error(`no verified clearance for ${p[6]}`);
if (pairs.length !== 31) throw new Error(`expected 31 checks (28 body pairs, hubs split out), got ${pairs.length}`);

/** Every body's pose, from the core's IK and joint values. */
function bodyPoses(check) {
  const poses = { static: P.identity, platform: P.platform(check.ik.rotation, check.ik.position) };
  for (const k of [0, 1, 2]) {
    const j = check.joints[k];
    poses[`horn-${k}`] = P.horn(k, j.hornDeg);
    poses[`leg-${k}`] = P.leg(k, j.hornDeg, j.legDeg);
  }
  return poses;
}

// ---------- poses ----------
let seed = 20190601;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const neutral = findNeutralPose();
if (!neutral) throw new Error('no neutral pose');
const samples = [{ kind: 'neutral', pose: neutral }];
// The covered grid points, plus the half step around them that each one covers.
const { cover } = DEV_KIT_CLEARANCE_DATA;
const box = { pitch: [cover.pitch[0] - 0.5, cover.pitch[1] + 0.5], roll: [cover.roll[0] - 0.5, cover.roll[1] + 0.5], heave: [cover.heave[0] - 0.5, cover.heave[1] + 0.5] };
for (let tries = 0, kept = 0; kept < RANDOM_POSES; tries++) {
  if (tries > 200000) throw new Error(`only ${kept} safe random poses found`);
  const pose = {
    pitchDeg: box.pitch[0] + rand() * (box.pitch[1] - box.pitch[0]),
    rollDeg: box.roll[0] + rand() * (box.roll[1] - box.roll[0]),
    heaveMm: box.heave[0] + rand() * (box.heave[1] - box.heave[0]),
  };
  if (!checkPose(pose).ok) continue;
  samples.push({ kind: 'random', pose });
  kept++;
}
for (let n = 0; n < EDGE_POSES; n++) {
  // A random direction (degrees for pitch and roll, millimetres for heave), far enough to leave the safe range.
  const d = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
  const norm = Math.hypot(...d) || 1;
  const target = { pitchDeg: neutral.pitchDeg + (40 * d[0]) / norm, rollDeg: neutral.rollDeg + (40 * d[1]) / norm, heaveMm: neutral.heaveMm + (20 * d[2]) / norm };
  const { pose, clamped } = clampToSafe(target, neutral);
  if (clamped) samples.push({ kind: 'edge', pose });
}

// ---------- measure ----------
const started = performance.now();
const tightest = Object.fromEntries(pairs.map((p) => [p[4], { mm: Infinity, kind: '', pose: null }]));
const failures = [];
let worstMargin = { mm: Infinity, detail: '' };
for (const { kind, pose } of samples) {
  const check = checkPose(pose);
  if (!check.ok) {
    failures.push(`${kind} pose ${JSON.stringify(pose)} is not safe: ${check.violations.map((v) => v.kind).join(', ')}`);
    continue;
  }
  const poses = bodyPoses(check);
  for (const [a, aBody, b, bBody, label, slack, verifiedKey] of pairs) {
    // What the core promises for this pair here: its table reading (the smallest over all tables), or the
    // minimum verified for this pair over everything the tables admit.
    const promised = verifiedKey === null ? check.clearance.minMm : DEV_KIT_CLEARANCE_DATA.verifiedMm[verifiedKey];
    const d = gap(geoms[a], poses[aBody], geoms[b], poses[bBody], CAP_MM);
    if (d < tightest[label].mm) tightest[label] = { mm: d, kind, pose };
    const margin = d - (Math.min(promised, CAP_MM) - slack);
    if (margin < worstMargin.mm) worstMargin = { mm: margin, detail: `${label} ${d.toFixed(3)} mm vs ${promised.toFixed(3)} promised at ${kind} ${JSON.stringify(pose)}` };
    if (margin < 0) failures.push(`${label}: ${d.toFixed(3)} mm, below the ${promised.toFixed(3)} mm promised (less ${slack} mm), at ${kind} pose ${JSON.stringify(pose)}`);
  }
}

const counts = samples.reduce((c, s) => ({ ...c, [s.kind]: (c[s.kind] ?? 0) + 1 }), {});
console.log(`checked ${samples.length} safe poses (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}) in ${((performance.now() - started) / 1000).toFixed(0)} s; neutral ${JSON.stringify(neutral)}`);
console.log('closest each pair came (mm, capped at 3):');
for (const [label, t] of Object.entries(tightest).sort((x, y) => x[1].mm - y[1].mm)) {
  console.log(`  ${t.mm.toFixed(3).padStart(6)}  ${label}${t.mm < CAP_MM ? `  (${t.kind} ${JSON.stringify(t.pose, (_, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v))})` : ''}`);
}
console.log(`smallest measured-minus-promised: ${worstMargin.mm.toFixed(3)} mm (${worstMargin.detail})`);
if (failures.length) {
  console.error(`FAIL: ${failures.length} problems\n  ${failures.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log('PASS: every measured gap is at least what the core promised');
