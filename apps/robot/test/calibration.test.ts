import { DEG_TO_RAD, solveFk, type Pose, type ServoIndex, type Triple } from '@peeqo/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIOR_CALIBRATION, REST_US, channelPulses, hornAngles, hornForPulse, pulseForHorn, type Calibration } from '../src/hardware/calibration.ts';
import { ARM_RANGE_US, CHECK_TILT_DEG, CalibrationSession, MAX_DOWN_US, WIGGLE_US } from '../src/hardware/calibrationSession.ts';
import { RAW_RANGE_US } from '../src/hardware/servoOutput.ts';

const NEUTRAL: Pose = { pitchDeg: 0, rollDeg: 0, heaveMm: 3.2 };

/** A robot nobody has measured: wired, fitted and geared differently from the 2019 guess. */
const TRUTH: Calibration = {
  version: 1,
  channels: [2, 0, 1],
  directions: [1, 1, 1],
  levelUs: [1488, 1517, 1473],
  usPerDeg: PRIOR_CALIBRATION.usPerDeg * 0.93,
  checked: true,
};

const servoOnChannel = (channel: number) => TRUTH.channels.indexOf(channel) as ServoIndex;
const trueHorn = (servo: ServoIndex, channelUs: readonly number[]) => hornForPulse(TRUTH, servo, channelUs[TRUTH.channels[servo]]!);
function realPose(channelUs: readonly number[]): Pose {
  const pose = solveFk([0, 1, 2].map((s) => trueHorn(s as ServoIndex, channelUs) * DEG_TO_RAD) as unknown as Triple);
  if (!pose) throw new Error('unreachable');
  return pose;
}

describe('the guided calibration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('finds a robot it has never seen, with someone watching, and keeps every move small and near rest', () => {
    const sent: number[][] = [];
    let saved: Calibration | null = null;
    const session = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save: (c) => void (saved = c), cancel: () => undefined });
    const last = () => sent.at(-1)!;
    session.start();
    expect(last()).toEqual([REST_US, REST_US, REST_US]);

    // 1. Which arm moves? (The person watches the arms; here: whichever channel's pulse changed.)
    for (let i = 0; i < 3; i++) {
      const before = sent.length;
      session.wiggle();
      vi.advanceTimersByTime(3000);
      const moved = sent.slice(before).flatMap((p) => p.flatMap((us, c) => (us !== REST_US ? [c] : [])));
      expect(new Set(moved).size).toBe(1);
      expect(Math.max(...sent.slice(before).flat().map((us) => Math.abs(us - REST_US)))).toBe(WIGGLE_US);
      session.identified(servoOnChannel(moved[0]!));
    }
    expect(session.view().channelServo).toEqual([1, 2, 0]);
    expect(session.view().step).toBe('arms');

    // 2. Each arm: which way does + go, then level it by eye (to within a quarter of a degree).
    for (let s = 0; s < 3; s++) {
      const servo = s as ServoIndex;
      expect(session.view().servo).toBe(servo);
      const before = trueHorn(servo, last());
      session.probe();
      session.plusMoved(trueHorn(servo, last()) > before);
      for (let press = 0; press < 400 && Math.abs(trueHorn(servo, last())) > 0.25; press++) session.nudge(trueHorn(servo, last()) > 0 ? -1 : 1);
      expect(Math.abs(trueHorn(servo, last()))).toBeLessThanOrEqual(0.25);
      session.armLevel();
    }
    expect(session.view().directions).toEqual([1, 1, 1]);
    expect(session.view().step).toBe('level');

    // 3. Level the head with a level app: quarter-degree taps.
    for (let tap = 0; tap < 100; tap++) {
      const real = realPose(last());
      const pitch = Math.abs(real.pitchDeg) >= 0.125 ? -Math.sign(real.pitchDeg) * 0.25 : 0;
      const roll = Math.abs(real.rollDeg) >= 0.125 ? -Math.sign(real.rollDeg) * 0.25 : 0;
      if (!pitch && !roll) break;
      session.trim({ pitchDeg: pitch, rollDeg: roll, heaveMm: 0 });
    }
    const level = realPose(last());
    expect(Math.abs(level.pitchDeg)).toBeLessThan(0.13);
    expect(Math.abs(level.rollDeg)).toBeLessThan(0.13);
    expect(Math.abs(level.heaveMm - NEUTRAL.heaveMm)).toBeLessThan(0.3); // the height is off by the scale error until the check

    // 4. The tilt check, and save.
    session.tilt();
    session.reading(30); // a misreading is refused
    expect(session.view().message).toMatch(/too far/);
    session.reading(realPose(last()).pitchDeg - level.pitchDeg);
    expect(session.view().step).toBe('done');
    expect(session.save()).toBe(true);
    const result = saved as Calibration | null;
    if (!result) throw new Error('not saved');
    expect(result.checked).toBe(true);

    // The robot now goes where it is told.
    for (const pose of [NEUTRAL, { ...NEUTRAL, pitchDeg: 3 }, { ...NEUTRAL, rollDeg: -3.5 }, { ...NEUTRAL, pitchDeg: -2, rollDeg: 2.5, heaveMm: 2.4 }]) {
      const us = channelPulses(result, hornAngles(pose).map((h, s) => pulseForHorn(result, s as ServoIndex, h)) as unknown as Triple);
      const real = realPose(us);
      expect(Math.abs(real.pitchDeg - pose.pitchDeg)).toBeLessThan(0.2);
      expect(Math.abs(real.rollDeg - pose.rollDeg)).toBeLessThan(0.2);
      expect(Math.abs(real.heaveMm - pose.heaveMm)).toBeLessThan(0.2);
    }
    // Nothing ever went further from rest than calibration allows.
    expect(Math.max(...sent.flat().map((us) => Math.abs(us - REST_US)))).toBeLessThanOrEqual(RAW_RANGE_US);
  });

  it('will not take an arm far below where it started (it rests near its holder), and wants the + test first', () => {
    const sent: number[][] = [];
    const session = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save: () => undefined, cancel: () => undefined });
    session.start();
    for (const servo of [0, 1, 2] as const) session.identified(servo);
    session.nudge(-10);
    expect(sent.at(-1)).toEqual([REST_US, REST_US, REST_US]); // no + test yet: nothing moves
    session.probe();
    session.plusMoved(false); // + moved it down: down is +pulse
    session.nudge(-1000);
    expect(sent.at(-1)![0]).toBe(REST_US + MAX_DOWN_US);
    expect(session.view().message).toMatch(/as low as/);
    session.nudge(1000);
    expect(sent.at(-1)![0]).toBe(REST_US - ARM_RANGE_US); // and only so far up
    expect(session.view().message).toMatch(/as high/);
    session.nudge(-2);
    expect(sent.at(-1)![0]).toBe(REST_US - ARM_RANGE_US + 10);
    expect(session.view().message).toBeNull();
  });

  it('caps the total level correction (more means the arms were not level)', () => {
    const sent: number[][] = [];
    const session = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save: () => undefined, cancel: () => undefined });
    session.start();
    for (const servo of [0, 1, 2] as const) session.identified(servo);
    for (let s = 0; s < 3; s++) {
      session.probe();
      session.plusMoved(false);
      session.armLevel();
    }
    for (let i = 0; i < 12; i++) session.trim({ pitchDeg: 0.25, rollDeg: 0, heaveMm: 0 }); // 3° in all: allowed
    expect(session.view().message).toBeNull();
    const before = sent.length;
    session.trim({ pitchDeg: 0.25, rollDeg: 0, heaveMm: 0 });
    expect(session.view().message).toMatch(/more correction/);
    expect(sent.length).toBe(before); // and nothing moved
  });

  it('refuses the same arm twice, warns about arms turning different ways, and cancels cleanly', () => {
    let cancelled = 0;
    const session = new CalibrationSession({ raw: () => undefined, neutral: NEUTRAL, save: () => undefined, cancel: () => void cancelled++ });
    session.start();
    session.identified(0);
    session.identified(0);
    expect(session.view().message).toMatch(/already matched/);
    session.identified(1);
    session.identified(2);
    session.probe();
    session.plusMoved(true);
    session.armLevel();
    session.probe();
    session.plusMoved(false);
    expect(session.view().message).toMatch(/different ways/);
    expect(session.save()).toBe(false); // not far enough to save
    session.cancel();
    expect(cancelled).toBe(1);
    expect(session.active).toBe(false);
    expect(CHECK_TILT_DEG).toBe(3);
  });
});
