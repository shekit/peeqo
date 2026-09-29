import { describe, expect, it } from 'vitest';
import { HOME_POSE, PEEQO_2019_GEOMETRY, solve3, solveFk, solveIk, type Pose } from '../src/index.ts';

/**
 * Verbatim transcription of ServoSimulator/Platform.pde (calcQ + calcAlpha) as an independent oracle.
 * rot = (rotX, rotY, rotZ) and trans = (x, y, z) exactly as the Processing sketch receives them.
 */
function processingAlphas(rot: [number, number, number], trans: [number, number, number]): number[] {
  const SCALE_INITIAL_HEIGHT = 125;
  const SCALE_BASE_RADIUS = 65;
  const SCALE_PLATFORM_RADIUS = 85;
  const SCALE_HORN_LENGTH = 13;
  const SCALE_LEG_LENGTH = 125;
  const baseAngles = [0, 120, 240];
  const platformAngles = [0, 120, 240];
  const beta = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
  const radians = (d: number) => (d * Math.PI) / 180;
  const [rx, ry, rz] = rot;
  const alpha: number[] = [];
  for (let i = 0; i < 3; i++) {
    const bx = SCALE_BASE_RADIUS * Math.cos(radians(baseAngles[i]!));
    const by = SCALE_BASE_RADIUS * Math.sin(radians(baseAngles[i]!));
    const bz = 0;
    const px = SCALE_PLATFORM_RADIUS * Math.cos(radians(platformAngles[i]!));
    const py = SCALE_PLATFORM_RADIUS * Math.sin(radians(platformAngles[i]!));
    const pz = 0;
    let qx = Math.cos(rz) * Math.cos(ry) * px +
      (-Math.sin(rz) * Math.cos(rx) + Math.cos(rz) * Math.sin(ry) * Math.sin(rx)) * py +
      (Math.sin(rz) * Math.sin(rx) + Math.cos(rz) * Math.sin(ry) * Math.cos(rx)) * pz;
    let qy = Math.sin(rz) * Math.cos(ry) * px +
      (Math.cos(rz) * Math.cos(rx) + Math.sin(rz) * Math.sin(ry) * Math.sin(rx)) * py +
      (-Math.cos(rz) * Math.sin(rx) + Math.sin(rz) * Math.sin(ry) * Math.cos(rx)) * pz;
    let qz = -Math.sin(ry) * px + Math.cos(ry) * Math.sin(rx) * py + Math.cos(ry) * Math.cos(rx) * pz;
    qx += trans[0];
    qy += trans[1];
    qz += trans[2] + SCALE_INITIAL_HEIGHT;
    const lx = qx - bx;
    const ly = qy - by;
    const lz = qz - bz;
    const L = lx * lx + ly * ly + lz * lz - SCALE_LEG_LENGTH * SCALE_LEG_LENGTH + SCALE_HORN_LENGTH * SCALE_HORN_LENGTH;
    const M = 2 * SCALE_HORN_LENGTH * (qz - bz);
    const N = 2 * SCALE_HORN_LENGTH * (Math.cos(beta[i]!) * (qx - bx) + Math.sin(beta[i]!) * (qy - by));
    alpha.push(Math.asin(L / Math.sqrt(M * M + N * N)) - Math.atan2(N, M));
  }
  return alpha;
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('inverse kinematics', () => {
  it('matches the 2019 Processing simulator for random poses', () => {
    const rand = mulberry32(1);
    let compared = 0;
    for (let n = 0; n < 5000; n++) {
      const pose: Pose = { pitchDeg: (rand() - 0.5) * 30, rollDeg: (rand() - 0.5) * 30, heaveMm: (rand() - 0.5) * 30 };
      const ours = solveIk(pose).legs.map((leg) => leg.hornRad);
      // Our pitch is a negative rotation about Y (face up); roll is rotation about X.
      const theirs = processingAlphas([(pose.rollDeg * Math.PI) / 180, (-pose.pitchDeg * Math.PI) / 180, 0], [0, 0, pose.heaveMm]);
      ours.forEach((alpha, i) => {
        if (Number.isNaN(theirs[i]!)) {
          expect(alpha).toBeNaN();
        } else {
          expect(alpha).toBeCloseTo(theirs[i]!, 12);
          compared++;
        }
      });
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('puts every horn at the closed-form home angle', () => {
    // At home each leg spans 20 mm outward and 125 mm up: L = 569, M = 3250, N = 520.
    const expected = Math.asin(569 / Math.hypot(3250, 520)) - Math.atan2(520, 3250);
    for (const leg of solveIk(HOME_POSE).legs) expect(leg.hornRad).toBeCloseTo(expected, 14);
    expect((expected * 180) / Math.PI).toBeCloseTo(0.8649, 4);
  });

  it('keeps every leg at its exact length', () => {
    const rand = mulberry32(2);
    for (let n = 0; n < 500; n++) {
      const ik = solveIk({ pitchDeg: (rand() - 0.5) * 12, rollDeg: (rand() - 0.5) * 8, heaveMm: (rand() - 0.5) * 10 });
      if (!ik.reachable) continue;
      for (const leg of ik.legs) {
        const d = Math.hypot(
          leg.platformJoint[0] - leg.hornTip[0],
          leg.platformJoint[1] - leg.hornTip[1],
          leg.platformJoint[2] - leg.hornTip[2],
        );
        expect(d).toBeCloseTo(PEEQO_2019_GEOMETRY.legLengthMm, 9);
      }
    }
  });

  it('reports unreachable poses as NaN horn angles', () => {
    const ik = solveIk({ pitchDeg: 0, rollDeg: 0, heaveMm: 40 });
    expect(ik.reachable).toBe(false);
    expect(ik.legs.every((leg) => Number.isNaN(leg.hornRad))).toBe(true);
  });
});

describe('forward kinematics', () => {
  it('inverts the inverse kinematics', () => {
    const rand = mulberry32(3);
    let solved = 0;
    for (let n = 0; n < 1000; n++) {
      const pose: Pose = { pitchDeg: (rand() - 0.5) * 16, rollDeg: (rand() - 0.5) * 12, heaveMm: (rand() - 0.5) * 16 };
      const ik = solveIk(pose);
      if (!ik.reachable) continue;
      const back = solveFk([ik.legs[0].hornRad, ik.legs[1].hornRad, ik.legs[2].hornRad]);
      expect(back).not.toBeNull();
      expect(back!.pitchDeg).toBeCloseTo(pose.pitchDeg, 7);
      expect(back!.rollDeg).toBeCloseTo(pose.rollDeg, 7);
      expect(back!.heaveMm).toBeCloseTo(pose.heaveMm, 7);
      solved++;
    }
    expect(solved).toBeGreaterThan(500);
  });

  it('returns null for horn angles no pose can produce', () => {
    expect(solveFk([Number.NaN, 0, 0])).toBeNull();
    expect(solveFk([Math.PI / 2, -Math.PI / 2, 0])).toBeNull();
  });
});

describe('solve3', () => {
  it('solves a linear system and rejects a singular one', () => {
    const x = solve3([2, 1, -1, -3, -1, 2, -2, 1, 2], [8, -11, -3]);
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(2, 12);
    expect(x![1]).toBeCloseTo(3, 12);
    expect(x![2]).toBeCloseTo(-1, 12);
    expect(solve3([1, 2, 3, 2, 4, 6, 1, 1, 1], [1, 2, 3])).toBeNull();
  });
});
