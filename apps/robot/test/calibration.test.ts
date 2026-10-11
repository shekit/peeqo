import { DEG_TO_RAD, solveFk, type Pose, type ServoIndex, type Triple } from '@peeqo/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIOR_CALIBRATION, RANGE_MARGIN_DEG, REST_US, channelPulses, hornAngles, hornForPulse, hornRanges, pulseForHorn, type Calibration } from '../src/hardware/calibration.ts';
import { ARM_RANGE_US, CHECK_TILT_DEG, CalibrationSession, MAX_DOWN_US, MIN_SWEEP_DEG, RAISE_DEG, SWEEP_DEG, WIGGLE_US } from '../src/hardware/calibrationSession.ts';
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

/**
 * Where each real arm touches something below it, and binds above (degrees of horn). At rest the arms sit at about
 * +1.1°, −1.6° and +2.5°, a few degrees clear of touching (the wiggle goes 1.4° either way).
 */
const TRUE_LIMITS: readonly (readonly [number, number])[] = [
  [-3.5, 59],
  [-4.6, 61],
  [-4.1, 60],
];

const servoOnChannel = (channel: number) => TRUTH.channels.indexOf(channel) as ServoIndex;
const trueHorn = (servo: ServoIndex, channelUs: readonly number[]) => hornForPulse(TRUTH, servo, channelUs[TRUTH.channels[servo]]!);
const trueHorns = (channelUs: readonly number[]) => [0, 1, 2].map((s) => trueHorn(s as ServoIndex, channelUs));
function realPose(channelUs: readonly number[]): Pose {
  const pose = solveFk(trueHorns(channelUs).map((h) => h * DEG_TO_RAD) as unknown as Triple);
  if (!pose) throw new Error('unreachable');
  return pose;
}
/** How close the real arms are to touching (below) and binding (above), degrees: the smallest gap either way. */
const gaps = (channelUs: readonly number[]) => {
  const h = trueHorns(channelUs);
  return {
    below: Math.min(...h.map((x, s) => x - TRUE_LIMITS[s]![0])),
    above: Math.min(...h.map((x, s) => TRUE_LIMITS[s]![1] - x)),
  };
};

/** A session up to the range step: arms matched, directions found (the 2019 way round), arms left at rest. */
function toRange(sent: number[][], save: (c: Calibration) => string | null = () => null) {
  const session = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save, cancel: () => undefined });
  session.start();
  for (const servo of [0, 1, 2] as const) session.identified(servo);
  for (let s = 0; s < 3; s++) {
    session.probe();
    session.plusMoved(false);
    session.nudge(4); // back down the 20 µs of the + test: level at rest
    session.armLevel();
  }
  return session;
}

describe('the guided calibration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('finds a robot it has never seen, measures its range with the head moving together, and keeps every move near rest', () => {
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

    // 2. Each arm: which way does + go, then level it by eye (to within a quarter of a degree), a little on its own.
    for (let s = 0; s < 3; s++) {
      const servo = s as ServoIndex;
      expect(session.view().armPhase).toBe('direction');
      session.nudge(-5); // nothing moves before the + test
      const before = trueHorn(servo, last());
      session.probe();
      session.plusMoved(trueHorn(servo, last()) > before);
      for (let press = 0; press < 200 && Math.abs(trueHorn(servo, last())) > 0.25; press++) session.nudge(trueHorn(servo, last()) > 0 ? -1 : 1);
      expect(Math.abs(trueHorn(servo, last()))).toBeLessThanOrEqual(0.25);
      session.armLevel();
    }
    expect(session.view().directions).toEqual([1, 1, 1]);
    expect(session.view().step).toBe('range');

    // 3. Range: the whole head down, step by step, until something is within a degree of touching; then up until
    //    something is within a degree of binding. The real arms never get there (one step is about half a degree).
    const sweep = (way: 1 | -1, near: () => boolean) => {
      for (let press = 0; press < 300; press++) {
        const before = last();
        session.raise(way);
        if (near()) {
          session.raise(-way); // one step back
          expect(last()).toEqual(before);
          return;
        }
      }
      throw new Error('never got near');
    };
    sweep(-1, () => gaps(last()).below < 1);
    session.markLowest();
    sweep(1, () => gaps(last()).above < 1);
    expect(gaps(last()).below).toBeGreaterThan(1);
    session.markHighest();
    expect(session.view().step).toBe('level');
    const { lowestDeg, highestDeg } = session.view();
    expect(lowestDeg).toBeLessThan(0);
    expect(highestDeg).toBeGreaterThan(50);
    for (const p of sent) {
      const g = gaps(p);
      expect(g.below).toBeGreaterThan(0.4);
      expect(g.above).toBeGreaterThan(0.4);
    }

    // 4. Level the head with a level app: quarter-degree taps.
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

    // 5. The tilt check, and save.
    session.tilt();
    session.reading(30); // a misreading is refused
    expect(session.view().message).toMatch(/too far/);
    session.reading(realPose(last()).pitchDeg - level.pitchDeg);
    expect(session.view().step).toBe('done');
    expect(session.save()).toBe(true);
    const result = saved as Calibration | null;
    if (!result) throw new Error('not saved');
    expect(result.checked).toBe(true);

    // The ranges, as the governor uses them: its ends, back in pulses, are a margin inside the marks, and the real
    // arms there are clear of touching and binding.
    const ranges = hornRanges(result)!;
    for (const servo of [0, 1, 2] as const) {
      const [bottom, top] = TRUE_LIMITS[servo]!;
      const ends = ranges[servo].map((h) => pulseForHorn(result, servo, h)).sort((a, b) => a - b);
      const marks = result.rangeUs![servo];
      expect(ends[0]! - marks[0]).toBeCloseTo(RANGE_MARGIN_DEG * result.usPerDeg, 6);
      expect(marks[1] - ends[1]!).toBeCloseTo(RANGE_MARGIN_DEG * result.usPerDeg, 6);
      const real = ends.map((us) => hornForPulse(TRUTH, servo, us)).sort((a, b) => a - b);
      expect(real[0]!).toBeGreaterThan(bottom + 1);
      expect(real[1]!).toBeLessThan(top - 1);
    }
    // Every gesture's extremes fit inside them.
    for (const pose of [NEUTRAL, { ...NEUTRAL, pitchDeg: 3.6 }, { ...NEUTRAL, pitchDeg: -3.6 }, { ...NEUTRAL, rollDeg: 4.1 }, { ...NEUTRAL, rollDeg: -4.1 }]) {
      hornAngles(pose).forEach((h, s) => {
        expect(h).toBeGreaterThan(ranges[s as ServoIndex][0]);
        expect(h).toBeLessThan(ranges[s as ServoIndex][1]);
      });
    }
    // The robot goes where it is told.
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

  it('moves one arm only a little on its own, and the whole head only within the sweep', () => {
    const sent: number[][] = [];
    const session = new CalibrationSession({ raw: (p) => void sent.push([...p]), neutral: NEUTRAL, save: () => null, cancel: () => undefined });
    session.start();
    for (const servo of [0, 1, 2] as const) session.identified(servo);
    session.probe();
    session.plusMoved(false); // + moved it down: up is a smaller pulse
    session.nudge(-1000);
    expect(sent.at(-1)![0]).toBe(REST_US + MAX_DOWN_US);
    expect(session.view().message).toMatch(/as low as one arm/);
    session.nudge(1000);
    expect(sent.at(-1)![0]).toBe(REST_US - ARM_RANGE_US);
    expect(session.view().message).toMatch(/tilt the head/);

    const swept: number[][] = [];
    const range = toRange(swept);
    const from = swept.length;
    range.raise(-1000);
    expect(range.view().sweepDeg).toBe(SWEEP_DEG[0]);
    expect(range.view().message).toMatch(/as low as calibration goes/);
    // Level at rest, up a smaller pulse: 61.2° up is as far from rest as calibration ever drives a servo.
    range.raise(1000);
    expect(range.view().sweepDeg).toBe(61);
    expect(range.view().message).toMatch(/as high as calibration goes/);
    expect(swept.at(-1)!.every((us) => REST_US - us <= RAW_RANGE_US && REST_US - us > RAW_RANGE_US - RAISE_DEG * PRIOR_CALIBRATION.usPerDeg)).toBe(true);
    // Every step keeps the head level (here, with the arms alike: all three pulses the same).
    for (const p of swept.slice(from)) expect(new Set(p).size).toBe(1);
    range.raise(-1000);
    range.markLowest();
    range.raise(-5);
    expect(range.view().sweepDeg).toBe(SWEEP_DEG[0]);
    expect(range.view().message).toMatch(/lowest point you marked/);
    range.raise(10);
    range.markHighest();
    expect(range.view().message).toMatch(new RegExp(`at least ${MIN_SWEEP_DEG}°`));
    range.raise(50);
    range.markHighest();
    expect(range.view().step).toBe('range'); // neutral (arms at 27.3°) is not inside yet
    expect(range.view().message).toMatch(/normal height/);
    range.raise(30);
    range.markHighest();
    expect(range.view().step).toBe('level');
    expect(range.view()).toMatchObject({ lowestDeg: SWEEP_DEG[0], highestDeg: 37 });
    for (const r of range.view().rangeUs) {
      expect(r![0]).toBeCloseTo(REST_US - 37 * PRIOR_CALIBRATION.usPerDeg, 6);
      expect(r![1]).toBeCloseTo(REST_US + 8 * PRIOR_CALIBRATION.usPerDeg, 6);
    }
  });

  it('can mark the lowest point again, and refuses one above Peeqo’s normal height', () => {
    const range = toRange([]);
    range.raise(60);
    range.markLowest();
    expect(range.view().rangePhase).toBe('lowest');
    expect(range.view().message).toMatch(/not below Peeqo's normal height/);
    range.raise(-62);
    range.markLowest();
    expect(range.view()).toMatchObject({ rangePhase: 'highest', lowestDeg: -1 });
    range.remark();
    expect(range.view()).toMatchObject({ rangePhase: 'lowest', lowestDeg: null });
    range.raise(-1);
    range.markLowest();
    expect(range.view().lowestDeg).toBe(-1.5);
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
    const session = toRange(sent);
    session.raise(-2);
    session.markLowest();
    session.raise(120);
    session.markHighest();
    expect(session.view().step).toBe('level');
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
