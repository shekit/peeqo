import { fileURLToPath } from 'node:url';
import { DEG_TO_RAD, MotionGovernor, legacyHornDegToPulse, solveFk, type Pose, type Triple } from '@peeqo/core';
import { describe, expect, it } from 'vitest';
import { apa102Frame } from '../src/hardware/apa102.ts';
import {
  PRIOR_CALIBRATION,
  REST_US,
  channelPulses,
  hornAngles,
  hornForPulse,
  parseCalibration,
  pulseForHorn,
  rescaledAround,
  trimmed,
  type Calibration,
} from '../src/hardware/calibration.ts';
import { HardwareLink } from '../src/hardware/link.ts';
import { HORN_GUARD_DEG, RAW_RANGE_US, RAW_RATE_US_PER_S, ServoOutput } from '../src/hardware/servoOutput.ts';

const SCRIPT = fileURLToPath(new URL('../python/hardware.py', import.meta.url));

/** Records what the servo output sends. */
function fakeLink() {
  const sent: number[][] = [];
  return { link: { servos: (p: readonly number[]) => void sent.push([...p]) }, sent };
}

/** The head's real pose, for a robot whose true calibration is `truth`, when sent these channel pulses. */
function realPose(truth: Calibration, channelUs: readonly number[]): Pose {
  const horns = [0, 1, 2].map((s) => hornForPulse(truth, s as 0 | 1 | 2, channelUs[truth.channels[s as 0 | 1 | 2]]!) * DEG_TO_RAD) as unknown as Triple;
  const pose = solveFk(horns);
  if (!pose) throw new Error('unreachable');
  return pose;
}

describe('LED frames', () => {
  it('are the 2019 dotstar.js bytes: brightness, blue, green, red', () => {
    expect([...apa102Frame([{ r: 255, g: 128, b: 1, brightness: 15 }, { r: 0, g: 0, b: 0, brightness: 0 }])]).toEqual([0xef, 1, 128, 255, 0xe0, 0, 0, 0]);
    expect([...apa102Frame([{ r: 300, g: -4, b: 9.6, brightness: 99 }])]).toEqual([0xff, 10, 0, 255]); // clamped
  });
});

describe('calibration', () => {
  it('starts from the 2019 mapping: the same pulses the 2019 simulator recorded', () => {
    for (const horn of [-30, -5, 0, 2.6, 15, 40]) {
      // The 2019 simulator truncated to whole degrees; the linear mapping is within a degree's worth of it.
      expect(Math.abs(pulseForHorn(PRIOR_CALIBRATION, 0, horn) - legacyHornDegToPulse(horn))).toBeLessThan(12);
    }
    expect(hornForPulse(PRIOR_CALIBRATION, 0, REST_US)).toBeCloseTo(2.6, 1); // the 2019 resting pulse: horns about level
    expect(channelPulses(PRIOR_CALIBRATION, [1000, 1100, 1200])).toEqual([1100, 1000, 1200]); // servo 0 is on channel 1
  });

  it('levels the head with trims, and fixes the scale with one tilt check, for a robot that differs from the guess', () => {
    const governor = new MotionGovernor();
    const neutral = governor.neutral;
    // The real robot: each arm fitted a few degrees off, by a different amount, and servos 8% slower than assumed.
    const truth: Calibration = { ...PRIOR_CALIBRATION, levelUs: [1555, 1500, 1531], usPerDeg: PRIOR_CALIBRATION.usPerDeg * 1.08 };
    let working: Calibration = { ...PRIOR_CALIBRATION };
    const command = (pose: Pose) => channelPulses(working, hornAngles(pose).map((h, s) => pulseForHorn(working, s as 0 | 1 | 2, h)) as unknown as Triple);
    // Level: read the tilt with a level, tap "tilt back"/"tilt left" in quarter degrees until it reads zero.
    for (let tap = 0; tap < 200; tap++) {
      const real = realPose(truth, command(neutral));
      const pitch = Math.abs(real.pitchDeg) >= 0.125 ? -Math.sign(real.pitchDeg) * 0.25 : 0;
      const roll = Math.abs(real.rollDeg) >= 0.125 ? -Math.sign(real.rollDeg) * 0.25 : 0;
      if (!pitch && !roll) break;
      working = trimmed(working, neutral, { pitchDeg: pitch, rollDeg: roll, heaveMm: 0 });
    }
    let real = realPose(truth, command(neutral));
    expect(Math.abs(real.pitchDeg)).toBeLessThan(0.13);
    expect(Math.abs(real.rollDeg)).toBeLessThan(0.13);
    // Tilt check: ask for 3° back, read the level.
    const asked = { ...neutral, pitchDeg: neutral.pitchDeg + 3 };
    const measured = realPose(truth, command(asked)).pitchDeg - real.pitchDeg;
    expect(measured).toBeLessThan(2.9); // the servos really are slower than assumed
    const before = command(neutral);
    working = rescaledAround(working, neutral, 3, measured)!;
    expect(working.checked).toBe(true);
    for (const [i, us] of command(neutral).entries()) expect(us).toBeCloseTo(before[i]!, 6); // the head stays put
    // Now tilts come out as asked.
    for (const pose of [asked, { ...neutral, rollDeg: -3 }, { ...neutral, pitchDeg: -2.5, rollDeg: 2 }]) {
      real = realPose(truth, command(pose));
      expect(Math.abs(real.pitchDeg - pose.pitchDeg)).toBeLessThan(0.2);
      expect(Math.abs(real.rollDeg - pose.rollDeg)).toBeLessThan(0.2);
    }
    expect(rescaledAround(working, neutral, 3, 1)).toBeNull(); // a misreading is refused
  });

  it('only believes a saved calibration that makes sense, measured ranges included', () => {
    expect(parseCalibration(PRIOR_CALIBRATION)).toEqual(PRIOR_CALIBRATION);
    const withRanges = { ...PRIOR_CALIBRATION, rangeUs: [[900, 1540], [910, 1530], [905, 1545]] };
    expect(parseCalibration(withRanges)).toEqual(withRanges);
    // A damaged range refuses the whole calibration (dropping just the range would lift the limits).
    for (const rangeUs of [[[900, 1540], [910, 1530]], [[900, 1540], [910, 1530], [1500, 1520]], [[900, 1540], [910, 1530], [600, 1545]], [[900, 1540], [910, 1530], ['x', 1545]]]) {
      expect(parseCalibration({ ...PRIOR_CALIBRATION, rangeUs })).toBeNull();
    }
    for (const broken of [
      null,
      { ...PRIOR_CALIBRATION, version: 2 },
      { ...PRIOR_CALIBRATION, channels: [0, 0, 1] },
      { ...PRIOR_CALIBRATION, channels: [0, 1, 7] },
      { ...PRIOR_CALIBRATION, directions: [1, 0, -1] },
      { ...PRIOR_CALIBRATION, levelUs: [1530, 1530, 3000] },
      { ...PRIOR_CALIBRATION, usPerDeg: 40 },
    ]) {
      expect(parseCalibration(broken)).toBeNull();
    }
  });
});

describe('ServoOutput', () => {
  it('sends nothing until told, starts the calibration tool from the resting pulse, and moves slowly within range', () => {
    const { link, sent } = fakeLink();
    const out = new ServoOutput(link, null);
    out.update(0.02);
    expect(sent).toEqual([]);
    out.raw([1500 + 1000, 1500, 1500 - 40]);
    expect(out.target).toEqual([REST_US + RAW_RANGE_US, 1500, 1460]); // clamped
    out.update(0.02);
    // The furthest channel moves at the slow rate; the others in step with it (sent rounded to 0.1 µs).
    expect(sent[0]).toEqual([1500 + RAW_RATE_US_PER_S * 0.02, 1500, Math.round((1500 - (RAW_RATE_US_PER_S * 0.02 * 40) / RAW_RANGE_US) * 10) / 10]);
    for (let i = 0; i < 400; i++) out.update(0.02);
    expect(sent.at(-1)).toEqual([REST_US + RAW_RANGE_US, 1500, 1460]);
    // Never faster than the slow rate, and every channel arrives together.
    for (let i = 1; i < sent.length; i++) {
      const step = sent[i]!.map((us, c) => Math.abs(us - sent[i - 1]![c]!));
      expect(Math.max(...step)).toBeLessThanOrEqual(RAW_RATE_US_PER_S * 0.02 + 0.11);
    }
    out.off();
    expect(sent.at(-1)).toEqual([0, 0, 0]);
    expect(out.state.mode).toBe('off');
  });

  it('refuses poses until calibrated, and horn angles outside the guard, holding still', () => {
    const { link, sent } = fakeLink();
    const out = new ServoOutput(link, null);
    out.horns([20, 20, 20]);
    expect(out.state.fault).toMatch(/not calibrated/);
    out.update(0.02);
    expect(sent).toEqual([]);
    out.setCalibration(PRIOR_CALIBRATION);
    out.horns([20, 20, 20]);
    for (let i = 0; i < 300; i++) out.update(0.02);
    const settled = sent.at(-1)!;
    expect(settled).toEqual(channelPulses(PRIOR_CALIBRATION, [20, 20, 20].map((h) => Math.round(pulseForHorn(PRIOR_CALIBRATION, 0, h) * 10) / 10) as unknown as Triple));
    for (const bad of [HORN_GUARD_DEG[1] + 1, -10, Number.NaN]) {
      out.horns([20, bad, 20]);
      expect(out.state.fault).toMatch(/refused/);
    }
    for (let i = 0; i < 10; i++) out.update(0.02);
    expect(sent.at(-1)).toEqual(settled);
  });

  it('holds still rather than send a pulse outside a measured range', () => {
    const { link, sent } = fakeLink();
    const calibration: Calibration = { ...PRIOR_CALIBRATION, rangeUs: [[1100, 1520], [1100, 1520], [1100, 1520]] };
    const out = new ServoOutput(link, calibration);
    out.horns([20, 20, 20]); // 1301 µs: inside
    for (let i = 0; i < 300; i++) out.update(0.02);
    const settled = sent.at(-1)!;
    out.horns([20, 20, 40]); // 1072 µs on the last: past its measured top
    expect(out.state.fault).toMatch(/outside its measured range/);
    for (let i = 0; i < 20; i++) out.update(0.02);
    expect(sent.at(-1)).toEqual(settled);
    // Nor does the first pose after start-up go anywhere if it is outside.
    const fresh = fakeLink();
    const cold = new ServoOutput(fresh.link, calibration);
    cold.horns([20, 20, 40]);
    cold.update(0.02);
    expect(fresh.sent).toEqual([]);
    expect(cold.state.mode).toBe('off');
  });

  it('eases into the first pose from rest, then follows the governor at full speed', () => {
    const { link, sent } = fakeLink();
    const out = new ServoOutput(link, PRIOR_CALIBRATION);
    const governor = new MotionGovernor();
    out.horns(governor.output.hornDeg);
    out.update(0.02);
    expect(Math.max(...sent[0]!.map((us) => Math.abs(us - REST_US)))).toBeLessThanOrEqual(RAW_RATE_US_PER_S * 0.02 + 0.11);
    for (let i = 0; i < 400; i++) out.update(0.02);
    // Settled: now a quick head turn goes straight through.
    governor.setTarget({ ...governor.neutral, pitchDeg: governor.neutral.pitchDeg + 3 });
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      const o = governor.step(0.02);
      out.horns(o.hornDeg);
      out.update(0.02);
      const expected = channelPulses(PRIOR_CALIBRATION, o.hornDeg.map((h, s) => pulseForHorn(PRIOR_CALIBRATION, s as 0 | 1 | 2, h)) as unknown as Triple);
      worst = Math.max(worst, ...expected.map((us, c) => Math.abs(us - sent.at(-1)![c]!)));
    }
    expect(worst).toBeLessThan(0.11); // no lag beyond the 0.1 µs rounding
  });
});

describe('the hardware helper (fake mode, no hardware)', () => {
  it('turns pulses into PCA9685 steps exactly as the 2019 driver did', async () => {
    const { execFileSync } = await import('node:child_process');
    const pulses = [500, 1000, 1499.9, 1500, 1500.5, 1530, 2000, 2500];
    const python = `import sys; sys.path.insert(0, ${JSON.stringify(SCRIPT.replace(/hardware\.py$/, ''))}); import hardware; print([hardware.pulse_steps(u) for u in ${JSON.stringify(pulses)}])`;
    const steps = JSON.parse(execFileSync('python3', ['-c', python]).toString().replace(/'/g, '"')) as number[];
    // pca9685@4 (2019): Math.round(us / (1e6 / 50 / 4096)) - 1.
    expect(steps).toEqual(pulses.map((us) => Math.round(us / (1e6 / 50 / 4096)) - 1));
    expect(JSON.parse(execFileSync('python3', ['-c', python.replace(JSON.stringify(pulses), '[0, -5, 9000]')]).toString().replace(/None/g, 'null'))).toEqual([null, null, 511]);
  });

  it('starts, takes commands and reports button presses', async () => {
    const presses: string[] = [];
    const link = new HardwareLink({ script: SCRIPT, fake: true, onButton: (pin, pressed) => presses.push(`${pin}:${pressed}`) });
    const status = await link.start();
    expect(status).toEqual({ servos: true, leds: true, buttons: [4, 16, 17, 23], fake: true });
    link.servos([1500, 1520.25, 0]);
    link.leds(apa102Frame([{ r: 1, g: 2, b: 3, brightness: 31 }]));
    link.press(16, true);
    link.press(16, false);
    await new Promise((r) => setTimeout(r, 300));
    expect(presses).toEqual(['16:true', '16:false']);
    link.stop();
  });
});
