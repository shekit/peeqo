import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_LIMITS,
  HOME_POSE,
  LEGACY_FRAME_MS,
  MotionGovernor,
  PoseTrackPlayer,
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

/** Every output must be a safe pose reached within the speed caps. */
function expectSafeTransition(prev: GovernorOutput, next: GovernorOutput, dt: number): void {
  const check = checkPose(next.pose);
  expect(check.ok, JSON.stringify(check.violations)).toBe(true);
  for (const s of [0, 1, 2] as const) {
    expect(Math.abs(next.hornDeg[s] - prev.hornDeg[s]) / dt).toBeLessThanOrEqual(L.maxServoSpeedDegPerS + EPS);
    expect(next.hornDeg[s]).toBeCloseTo(check.hornDeg[s], 9);
  }
  expect(Math.abs(next.rates.pitchDegPerS)).toBeLessThanOrEqual(L.maxAngularSpeedDegPerS + EPS);
  expect(Math.abs(next.rates.rollDegPerS)).toBeLessThanOrEqual(L.maxAngularSpeedDegPerS + EPS);
  expect(Math.abs(next.rates.heaveMmPerS)).toBeLessThanOrEqual(L.maxHeaveSpeedMmPerS + EPS);
}

function run(governor: MotionGovernor, seconds: number, dt = 0.01): GovernorOutput {
  let out = governor.output;
  for (let t = 0; t < seconds; t += dt) {
    const next = governor.step(dt);
    expectSafeTransition(out, next, dt);
    out = next;
  }
  return out;
}

describe('MotionGovernor', () => {
  it('never commands an unsafe pose or breaks a speed or acceleration cap, whatever it is asked', () => {
    const rand = mulberry32(42);
    const governor = new MotionGovernor();
    let out = governor.output;
    const wild = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e9, -1e9];
    for (let n = 0; n < 4000; n++) {
      if (n % 15 === 0) {
        const pick = () => (rand() < 0.05 ? wild[Math.floor(rand() * wild.length)]! : (rand() - 0.5) * 80);
        governor.setTarget({ pitchDeg: pick(), rollDeg: pick(), heaveMm: pick() });
      }
      const dt = rand() < 0.1 ? rand() * 0.2 : 0.005 + rand() * 0.02;
      const prevRates = out.rates;
      const next = governor.step(dt);
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
    const governor = new MotionGovernor();
    const target: Pose = { pitchDeg: 3, rollDeg: -2, heaveMm: 2 };
    governor.setTarget(target);
    const out = run(governor, 1.5);
    expect(out.status).toBe('ok');
    expect(out.pose.pitchDeg).toBeCloseTo(3, 9);
    expect(out.pose.rollDeg).toBeCloseTo(-2, 9);
    expect(out.pose.heaveMm).toBeCloseTo(2, 9);
  });

  it('stops an unsafe target at the edge of the safe range and says so', () => {
    const governor = new MotionGovernor();
    governor.setTarget({ pitchDeg: 20, rollDeg: 0, heaveMm: 0 });
    const out = run(governor, 1.5);
    expect(out.status).toBe('limited');
    expect(out.notes.join(' ')).toMatch(/outside the safe range/);
    expect(out.pose.pitchDeg).toBeGreaterThan(6.9);
    expect(out.pose.pitchDeg).toBeLessThan(7.1);
    // Just past where it stopped is unsafe: it really is at the edge.
    expect(checkPose({ ...out.pose, pitchDeg: out.pose.pitchDeg + 0.01 }).ok).toBe(false);
    expect(out.goal.pitchDeg).toBeCloseTo(clampToSafe({ pitchDeg: 20, rollDeg: 0, heaveMm: 0 }).pose.pitchDeg, 12);
  });

  it('ignores non-numeric targets and holds position', () => {
    const governor = new MotionGovernor();
    governor.setTarget({ pitchDeg: 2, rollDeg: 0, heaveMm: 0 });
    run(governor, 1);
    const before = governor.output.pose;
    governor.setTarget({ pitchDeg: Number.NaN, rollDeg: 0, heaveMm: 0 });
    const out = governor.step(0.01);
    expect(out.status).toBe('blocked');
    expect(out.pose.pitchDeg).toBeCloseTo(before.pitchDeg, 12);
    expect(out.requested.pitchDeg).toBe(2);
  });

  it('ignores zero, negative and non-numeric time steps', () => {
    const governor = new MotionGovernor();
    governor.setTarget({ pitchDeg: 5, rollDeg: 0, heaveMm: 0 });
    for (const dt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(governor.step(dt).pose).toEqual(HOME_POSE);
  });

  it('refuses to start when home breaks the limits', () => {
    expect(() => new MotionGovernor(undefined, { ...L, hornMinDeg: 5 })).toThrow(/home pose/);
  });

  it('plays the 2019 animations safely and close to how they were recorded', () => {
    const dir = fileURLToPath(new URL('../../../electron/app/media/servo_anims/', import.meta.url));
    for (const name of ['alert', 'jiggle', 'look-up', 'look-up-slow']) {
      const frames = parseLegacyAnimation(JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8')), name);
      const poses = legacyAnimationToPoses(frames);
      const player = new PoseTrackPlayer({ name, frameMs: LEGACY_FRAME_MS, poses }, 0);
      const governor = new MotionGovernor();
      let out = governor.output;
      let worstAngle = 0;
      let worstHeave = 0;
      const dt = 0.01;
      for (let t = 0; t <= player.durationMs / 1000 + 0.5; t += dt) {
        const target = player.poseAt(t * 1000) ?? HOME_POSE;
        governor.setTarget(target);
        const next = governor.step(dt);
        expectSafeTransition(out, next, dt);
        expect(next.status, `${name} at ${t.toFixed(2)} s: ${next.notes.join('; ')}`).not.toBe('blocked');
        out = next;
        // Compare with where the recording was one frame ago (the governor needs a moment to follow a step).
        const lagged = player.poseAt(t * 1000 - LEGACY_FRAME_MS) ?? HOME_POSE;
        worstAngle = Math.max(worstAngle, Math.abs(next.pose.pitchDeg - lagged.pitchDeg), Math.abs(next.pose.rollDeg - lagged.rollDeg));
        worstHeave = Math.max(worstHeave, Math.abs(next.pose.heaveMm - lagged.heaveMm));
      }
      expect(worstAngle, name).toBeLessThan(2.5);
      expect(worstHeave, name).toBeLessThan(4);
      expect(out.pose.pitchDeg).toBeCloseTo(0, 6);
      expect(out.pose.heaveMm).toBeCloseTo(0, 6);
    }
  });
});
