import { DEG_TO_RAD, solveFk, type Pose, type ServoIndex, type Triple } from '@peeqo/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIOR_CALIBRATION, RANGE_MARGIN_DEG, REST_US, channelPulses, hornAngles, hornForPulse, hornRanges, pulseForHorn, type Calibration } from '../src/hardware/calibration.ts';
import { ARM_RANGE_US, CHECK_TILT_DEG, CalibrationSession, HIGHEST_US, WIGGLE_US } from '../src/hardware/calibrationSession.ts';
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

/** Where each real arm touches something below it, and binds above (degrees of horn). */
const TRUE_LIMITS: readonly (readonly [number, number])[] = [
  [-3.5, 56],
  [-2.8, 58],
  [-4.1, 57],
];

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
    const session = new CalibrationSession({
      raw: (p) => void sent.push([...p]),
      neutral: NEUTRAL,
      save: (c) => {
        saved = c;
        return null;
      },
      cancel: () => undefined,
    });
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

    // 2. Each arm: which way does + go; down until just short of touching, mark; up until just short of binding,
    //    mark; then level it by eye (to within a quarter of a degree). The real arm never goes past its limits.
    for (let s = 0; s < 3; s++) {
      const servo = s as ServoIndex;
      const [bottom, top] = TRUE_LIMITS[servo]!;
      const watch = () => {
        const h = trueHorn(servo, last());
        expect(h).toBeGreaterThan(bottom);
        expect(h).toBeLessThan(top);
        return h;
      };
      expect(session.view().servo).toBe(servo);
      expect(session.view().armPhase).toBe('direction');
      session.nudge(-5); // nothing moves before the + test
      const before = trueHorn(servo, last());
      session.probe();
      session.plusMoved(trueHorn(servo, last()) > before);
      expect(session.view().armPhase).toBe('lowest');
      for (let press = 0; press < 200 && watch() - 1 > bottom; press++) session.nudge(-1);
      session.markLowest();
      expect(session.view().armPhase).toBe('highest');
      for (let press = 0; press < 400 && watch() + 1 < top; press++) session.nudge(1);
      session.markHighest();
      expect(session.view().armPhase).toBe('level');
      const marked = session.view().rangeUs[servo]!;
      expect(hornForPulse(TRUTH, servo, marked[0])).toBeGreaterThan(bottom);
      expect(hornForPulse(TRUTH, servo, marked[1])).toBeLessThan(top);
      for (let press = 0; press < 400 && Math.abs(watch()) > 0.25; press++) session.nudge(trueHorn(servo, last()) > 0 ? -1 : 1);
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
    // The measured ranges, as the governor will use them. What keeps the arm safe is in pulses: the governor's ends
    // turn back into pulses a margin inside the marks, and the real arm there is clear of what it touches (by the
    // degree left when marking, plus the margin), while still using nearly all of its range.
    const ranges = hornRanges(result)!;
    for (const servo of [0, 1, 2] as const) {
      const [bottom, top] = TRUE_LIMITS[servo]!;
      const ends = ranges[servo].map((h) => pulseForHorn(result, servo, h)).sort((a, b) => a - b);
      const marks = result.rangeUs![servo];
      const marginUs = RANGE_MARGIN_DEG * result.usPerDeg;
      expect(ends[0]! - marks[0]).toBeCloseTo(marginUs, 6);
      expect(marks[1] - ends[1]!).toBeCloseTo(marginUs, 6);
      const real = ends.map((us) => hornForPulse(TRUTH, servo, us)).sort((a, b) => a - b);
      // (Marking stops within a degree of contact, in nudges of about half a degree: 0.5° to 1° short of it.)
      expect(real[0]!).toBeGreaterThan(bottom + 0.5 + RANGE_MARGIN_DEG * 0.9);
      expect(real[1]!).toBeLessThan(top - 0.5 - RANGE_MARGIN_DEG * 0.9);
      expect(real[1]! - real[0]!).toBeGreaterThan(top - bottom - 2 * (1.5 + RANGE_MARGIN_DEG + 0.5));
    }

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

  it('keeps each phase to its own limits: lowest near rest, highest above the lowest, levelling between the marks', () => {
    const sent: number[][] = [];
    const session = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save: () => null, cancel: () => undefined });
    session.start();
    for (const servo of [0, 1, 2] as const) session.identified(servo);
    session.probe();
    session.plusMoved(false); // + moved it down: up is a smaller pulse
    session.nudge(-1000);
    expect(sent.at(-1)![0]).toBe(REST_US + ARM_RANGE_US); // as far down as calibration goes
    expect(session.view().message).toMatch(/as far down/);
    session.nudge(70); // back up 350 µs: 50 µs below rest (its "up" is then -50)
    session.markLowest();
    session.nudge(-1000);
    expect(sent.at(-1)![0]).toBe(REST_US + 50 - 60); // the highest must be at least 60 µs above the lowest
    session.markHighest();
    expect(session.view().armPhase).toBe('level');
    expect(session.view().rangeUs[0]).toEqual([REST_US - 10, REST_US + 50]);
    session.nudge(1000);
    expect(sent.at(-1)![0]).toBe(REST_US - 10); // levelling stays between the marks
    expect(session.view().message).toMatch(/highest point you marked/);
    session.nudge(-1000);
    expect(sent.at(-1)![0]).toBe(REST_US + 50);
    expect(session.view().message).toMatch(/lowest point you marked/);
    // The highest end can go all the way up calibration allows.
    const fresh = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save: () => null, cancel: () => undefined });
    fresh.start();
    for (const servo of [0, 1, 2] as const) fresh.identified(servo);
    fresh.probe();
    fresh.plusMoved(true);
    fresh.markLowest();
    fresh.nudge(10000);
    expect(sent.at(-1)![0]).toBe(REST_US + HIGHEST_US);
  });

  it('refuses ranges that leave no room for its normal pose', () => {
    const sent: number[][] = [];
    const session = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save: () => null, cancel: () => undefined });
    session.start();
    for (const servo of [0, 1, 2] as const) session.identified(servo);
    for (let s = 0; s < 3; s++) {
      session.probe();
      session.plusMoved(false); // the 2019 direction
      session.nudge(-10); // lowest: 50 µs down
      session.markLowest();
      session.nudge(22); // highest: 60 µs up, only about 5° above level
      session.markHighest();
      session.nudge(-12); // level at rest
      session.armLevel();
    }
    // Its normal pose needs every horn near 27°, far above what was marked.
    expect(session.view().step).toBe('level');
    expect(session.view().message).toMatch(/outside the range you marked/);
  });

  it('stops a wiggle the moment the arm is named (its last steps never land on the next step)', () => {
    const sent: number[][] = [];
    const session = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save: () => null, cancel: () => undefined });
    session.start();
    session.wiggle();
    vi.advanceTimersByTime(400); // two of its seven steps
    session.identified(0);
    const after = sent.length;
    expect(sent.at(-1)).toEqual([REST_US, REST_US, REST_US]);
    vi.advanceTimersByTime(5000);
    expect(sent.length).toBe(after);
  });

  it('caps the total level correction (more means the arms were not level)', () => {
    const sent: number[][] = [];
    const session = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save: () => null, cancel: () => undefined });
    session.start();
    for (const servo of [0, 1, 2] as const) session.identified(servo);
    for (let s = 0; s < 3; s++) {
      session.probe();
      session.plusMoved(false);
      session.nudge(-10); // lowest: 50 µs down
      session.markLowest();
      session.nudge(130); // highest: 600 µs up
      session.markHighest();
      session.nudge(-120); // level at rest
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
    const session = new CalibrationSession({ raw: () => undefined, neutral: NEUTRAL, save: () => null, cancel: () => void cancelled++ });
    session.start();
    session.identified(0);
    session.identified(0);
    expect(session.view().message).toMatch(/already matched/);
    session.identified(1);
    session.identified(2);
    session.probe();
    session.plusMoved(true);
    session.markLowest();
    session.nudge(20);
    session.markHighest();
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
