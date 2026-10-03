import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_LIMITS,
  DEV_KIT_CLEARANCE,
  DEV_KIT_GEOMETRY,
  LEGACY_FRAME_MS,
  MotionGovernor,
  PoseTrackPlayer,
  aroundNeutral,
  checkPose,
  clampToSafe,
  legacyAnimationToPoses,
  parseLegacyAnimation,
  type GovernorOutput,
  type Pose,
} from '../src/index.ts';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const L = DEFAULT_SAFETY_LIMITS;
const EPS = 1e-9;
const governor = () => new MotionGovernor();
const neutral = governor().neutral;

/** Every output must be a safe pose (including collision clearance) reached within the speed caps. */
function expectSafeTransition(prev: GovernorOutput, next: GovernorOutput, dt: number): void {
  const check = checkPose(next.pose);
  expect(check.ok, JSON.stringify(check.violations)).toBe(true);
  expect(check.clearance!.minMm).toBeGreaterThanOrEqual(DEV_KIT_CLEARANCE.marginMm);
  for (const s of [0, 1, 2] as const) {
    expect(Math.abs(next.hornDeg[s] - prev.hornDeg[s]) / dt).toBeLessThanOrEqual(L.maxServoSpeedDegPerS + EPS);
    expect(next.hornDeg[s]).toBeCloseTo(check.hornDeg[s], 9);
  }
  expect(Math.abs(next.rates.pitchDegPerS)).toBeLessThanOrEqual(L.maxAngularSpeedDegPerS + EPS);
  expect(Math.abs(next.rates.rollDegPerS)).toBeLessThanOrEqual(L.maxAngularSpeedDegPerS + EPS);
  expect(Math.abs(next.rates.heaveMmPerS)).toBeLessThanOrEqual(L.maxHeaveSpeedMmPerS + EPS);
}

function run(g: MotionGovernor, seconds: number, dt = 0.01): GovernorOutput {
  let out = g.output;
  for (let t = 0; t < seconds; t += dt) {
    const next = g.step(dt);
    expectSafeTransition(out, next, dt);
    out = next;
  }
  return out;
}

describe('MotionGovernor (dev kit, with CAD collision tables)', () => {
  it('starts at a safe, level neutral pose with room to move', () => {
    expect(neutral.pitchDeg).toBe(0);
    expect(neutral.rollDeg).toBe(0);
    expect(neutral.heaveMm).toBeGreaterThan(0);
    expect(checkPose(neutral).ok).toBe(true);
    for (const toward of [{ pitchDeg: 2 }, { pitchDeg: -2 }, { rollDeg: 2 }, { rollDeg: -2 }]) {
      expect(checkPose({ ...neutral, ...toward }).ok, JSON.stringify(toward)).toBe(true);
    }
  });

  it('never commands an unsafe pose or breaks a speed or acceleration cap, whatever it is asked', () => {
    const rand = mulberry32(42);
    const g = governor();
    let out = g.output;
    const wild = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e9, -1e9];
    for (let n = 0; n < 3000; n++) {
      if (n % 15 === 0) {
        const pick = (span: number) => (rand() < 0.05 ? wild[Math.floor(rand() * wild.length)]! : (rand() - 0.5) * span);
        g.setTarget({ pitchDeg: pick(40), rollDeg: pick(40), heaveMm: pick(20) });
      }
      const dt = rand() < 0.1 ? rand() * 0.2 : 0.005 + rand() * 0.02;
      const prevRates = out.rates;
      const next = g.step(dt);
      const effectiveDt = Math.min(dt, 0.05);
      expectSafeTransition(out, next, effectiveDt);
      if (next.notes.every((note) => note.startsWith('target outside')) && next.status !== 'blocked') {
        // An unscaled step: acceleration must respect the caps too.
        expect(Math.abs(next.rates.pitchDegPerS - prevRates.pitchDegPerS) / effectiveDt).toBeLessThanOrEqual(L.maxAngularAccelDegPerS2 * (1 + 1e-9) + EPS);
        expect(Math.abs(next.rates.rollDegPerS - prevRates.rollDegPerS) / effectiveDt).toBeLessThanOrEqual(L.maxAngularAccelDegPerS2 * (1 + 1e-9) + EPS);
        expect(Math.abs(next.rates.heaveMmPerS - prevRates.heaveMmPerS) / effectiveDt).toBeLessThanOrEqual(L.maxHeaveAccelMmPerS2 * (1 + 1e-9) + EPS);
      }
      out = next;
    }
  });

  it('reaches a safe target exactly and reports ok', () => {
    const g = governor();
    const target: Pose = { pitchDeg: neutral.pitchDeg + 2, rollDeg: neutral.rollDeg - 1.5, heaveMm: neutral.heaveMm + 0.5 };
    expect(checkPose(target).ok).toBe(true);
    g.setTarget(target);
    const out = run(g, 1.5);
    expect(out.status).toBe('ok');
    expect(out.pose.pitchDeg).toBeCloseTo(target.pitchDeg, 9);
    expect(out.pose.rollDeg).toBeCloseTo(target.rollDeg, 9);
    expect(out.pose.heaveMm).toBeCloseTo(target.heaveMm, 9);
  });

  it('stops an unsafe target at the edge of the safe range and says so', () => {
    const g = governor();
    const target: Pose = { ...neutral, pitchDeg: 20 };
    g.setTarget(target);
    const out = run(g, 1.5);
    const edge = clampToSafe(target, neutral).pose;
    expect(out.status).toBe('limited');
    expect(out.notes.join(' ')).toMatch(/outside the safe range/);
    expect(out.pose.pitchDeg).toBeCloseTo(edge.pitchDeg, 6);
    // Just past where it stopped is unsafe: it really is at the edge.
    expect(checkPose({ ...out.pose, pitchDeg: out.pose.pitchDeg + 0.02 }).ok).toBe(false);
  });

  it('gets round unsafe pockets: every goal is reached, even when the straight path there is blocked', () => {
    // Targets far outside the safe range land on its edge, which is not convex: the straight path from one edge
    // pose to the next often leaves the safe range, and the governor must go round instead of stopping.
    const g = governor();
    const rand = mulberry32(12345);
    let out = g.output;
    let detours = 0;
    for (let n = 0; n < 40; n++) {
      g.setTarget({ pitchDeg: neutral.pitchDeg + (rand() - 0.5) * 30, rollDeg: neutral.rollDeg + (rand() - 0.5) * 30, heaveMm: neutral.heaveMm + (rand() - 0.5) * 10 });
      let settled = false;
      let detoured = false;
      for (let t = 0; t < 5 && !settled; t += 0.01) {
        const next = g.step(0.01);
        expectSafeTransition(out, next, 0.01);
        detoured ||= next.notes.some((note) => note.includes('going round by the neutral pose'));
        out = next;
        settled = (['pitchDeg', 'rollDeg', 'heaveMm'] as const).every((k) => Math.abs(out.pose[k] - out.goal[k]) < 1e-9);
      }
      expect(settled, `target ${n}: ${out.status}, ${out.notes.join('; ')}`).toBe(true);
      if (detoured) detours++;
    }
    expect(detours, 'the run should include blocked straight paths').toBeGreaterThan(0);
  });

  it('refuses the assembled pose (all horns level): the U-horns sit 0.38 mm from their holders there', () => {
    const check = checkPose({ pitchDeg: 0, rollDeg: 0, heaveMm: 0 });
    expect(check.ok).toBe(false);
    expect(check.violations.some((v) => v.kind === 'collision' && /horn \d and the base/.test(v.between ?? ''))).toBe(true);
  });

  it('still reaches a goal when one axis is off by only rounding error', () => {
    // A 1e-17 leftover on one axis once froze the whole straight-line move (its braking speed rounded to 0).
    for (const tiny of [1e-17, -3e-16, 1e-300]) {
      const g = governor();
      const target: Pose = { pitchDeg: neutral.pitchDeg + 0.002, rollDeg: neutral.rollDeg + tiny, heaveMm: neutral.heaveMm + 0.0058 };
      g.setTarget(target);
      const out = run(g, 0.5);
      expect(out.pose.pitchDeg).toBeCloseTo(target.pitchDeg, 12);
      expect(out.pose.heaveMm).toBeCloseTo(target.heaveMm, 12);
      g.setTarget(neutral);
      const back = run(g, 0.5);
      expect(back.pose.pitchDeg).toBeCloseTo(neutral.pitchDeg, 12);
      expect(back.pose.heaveMm).toBeCloseTo(neutral.heaveMm, 12);
    }
  });

  it('ignores non-numeric targets and holds position', () => {
    const g = governor();
    g.setTarget({ ...neutral, pitchDeg: neutral.pitchDeg + 1 });
    run(g, 1);
    const before = g.output.pose;
    g.setTarget({ pitchDeg: Number.NaN, rollDeg: 0, heaveMm: 0 });
    const out = g.step(0.01);
    expect(out.status).toBe('blocked');
    expect(out.pose.pitchDeg).toBeCloseTo(before.pitchDeg, 12);
  });

  it('ignores zero, negative and non-numeric time steps', () => {
    const g = governor();
    g.setTarget({ ...neutral, pitchDeg: 3 });
    for (const dt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(g.step(dt).pose).toEqual(neutral);
  });

  it('refuses to start when no level pose is safe', () => {
    expect(() => new MotionGovernor(DEV_KIT_GEOMETRY, { ...L, hornMinDeg: 80 })).toThrow(/No level pose is safe/);
  });

  it('plays the 2019 animations around neutral without ever leaving the safe range', () => {
    const dir = fileURLToPath(new URL('../../../electron/app/media/servo_anims/', import.meta.url));
    for (const name of ['alert', 'jiggle', 'look-up', 'look-up-slow']) {
      const frames = parseLegacyAnimation(JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8')), name);
      const poses = aroundNeutral(legacyAnimationToPoses(frames), neutral);
      const player = new PoseTrackPlayer({ name, frameMs: LEGACY_FRAME_MS, poses }, 0);
      const g = governor();
      let out = g.output;
      let moved = 0;
      const dt = 0.01;
      for (let t = 0; t <= player.durationMs / 1000 + 0.6; t += dt) {
        g.setTarget(player.poseAt(t * 1000) ?? neutral);
        const next = g.step(dt);
        expectSafeTransition(out, next, dt);
        moved = Math.max(
          moved,
          Math.abs(next.pose.pitchDeg - neutral.pitchDeg) + Math.abs(next.pose.rollDeg - neutral.rollDeg) + Math.abs(next.pose.heaveMm - neutral.heaveMm),
        );
        out = next;
      }
      expect(moved, `${name} should visibly move the head`).toBeGreaterThan(1);
      expect(out.pose.pitchDeg).toBeCloseTo(neutral.pitchDeg, 6);
      expect(out.pose.heaveMm).toBeCloseTo(neutral.heaveMm, 6);
    }
  });
});
