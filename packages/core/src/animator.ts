import { checkPose } from './check.ts';
import type { ClearanceModel } from './clearance.ts';
import { DEFAULT_GEOMETRY, type PlatformGeometry } from './geometry.ts';
import { HEAD_ANIMATIONS, HEAD_ANIMATION_NAMES, type HeadAnimationName, type HeadClip } from './headAnimations.ts';
import type { Pose } from './kinematics.ts';
import type { SafetyLimits } from './limits.ts';
import { MonotoneCurve, SecondOrder, seededRandom, smoothWander } from './motion.ts';

type Offset = [number, number, number]; // [pitch°, roll°, heave mm] from neutral

export interface HeadPlayOptions {
  /** How big the gesture is, 0…1 (1 = as authored). */
  readonly intensity?: number;
  /** Playback speed, 0.5…1.5 (1 = as authored). */
  readonly speed?: number;
}

export interface HeadAnimatorOptions {
  /** Seed for the random variation, so a run can be replayed exactly. */
  readonly seed?: number;
  /** Start with the idle layer on (default true). */
  readonly idle?: boolean;
}

// Follow-through: everything passes through a slightly underdamped spring, so moves carry a little weight and
// settle instead of stopping dead. Quick enough to keep gestures crisp (Peeqo is playful).
const SPRING_HZ = 3.4;
const SPRING_DAMPING = 0.6;
// Each play varies a little, so a gesture never repeats exactly.
const AMPLITUDE_VARIATION = 0.08;
const TIMING_VARIATION = 0.06;
/** How long an interrupted gesture takes to hand over to the next. */
const HANDOVER_S = 0.3;
/** The sizes setSize allows. */
const SIZE_RANGE = [0, 4] as const;
/** How quickly the idle layer fades in and out (time constant, s). */
const IDLE_BLEND_S = 0.35;
/** The idle layer's share while a gesture plays (breathing carries on underneath). */
const IDLE_UNDER_GESTURE = 0.25;
/** How quickly the idle layer follows a change of energy (time constant, s). */
const ENERGY_GLIDE_S = 1.5;
// Idle layer. At full energy it stays within about 2.7° of tilt and 0.8 mm of height, about half the room at
// neutral, so glances never come near the edge.
const BREATH = { hz: 0.21, heaveMm: 0.3, pitchDeg: 0.25 };
const WANDER = { hz: 0.06, pitchDeg: 0.4, rollDeg: 0.5, heaveMm: 0.12 };
const GLANCE = { tiltDeg: 2.0, heaveMm: 0.3, everyS: [3.5, 8] as const, quietAfterGestureS: 1.2 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (u: number) => u * u * (3 - 2 * u);
const add = (a: Offset, b: readonly number[], k = 1): Offset => [a[0] + k * b[0]!, a[1] + k * b[1]!, a[2] + k * b[2]!];

/**
 * Turns gestures and an idle layer into a smooth stream of target poses for the governor. Call update() at a fixed
 * rate (the governor's 100 Hz) and feed each result to MotionGovernor.setTarget.
 *
 * Layers, summed then passed through the follow-through spring:
 * - the current gesture (HEAD_ANIMATIONS), scaled by intensity and slightly varied each time;
 * - when a gesture is interrupted, a crossfade over HANDOVER_S from what was showing to the new gesture (a blend
 *   of two in-range poses, never their sum, so an interruption cannot push the head further than either);
 * - the idle layer: breathing, a slow wander, and now and then a glance or a curious tilt. Its size and pace follow
 *   `energy` (0 = drowsy and still, 1 = lively); it shrinks to a quarter under gestures and can be switched off.
 */
export class HeadAnimator {
  readonly neutral: Pose;
  readonly #random: () => number;
  readonly #spring: SecondOrder;
  readonly #wander: readonly [(t: number) => number, (t: number) => number, (t: number) => number];
  #breathAngle: number;
  #time = 0;
  #idleOn: boolean;
  #idleWeight: number;
  #energy = 1;
  /** How big gestures and glances are, relative to how they were written (see setSize). */
  #size = 1;
  /** Energy as the idle layer feels it: glides toward #energy so changes never jolt the head. */
  #liveliness = 1;
  #gesture: { clip: HeadClip; start: number; amplitude: number; timeScale: number } | null = null;
  #handover: { from: Offset; start: number } | null = null;
  #glance: { curves: readonly [MonotoneCurve, MonotoneCurve, MonotoneCurve]; start: number } | null = null;
  #nextGlance: number;
  #lastGestureEnd = Number.NEGATIVE_INFINITY;
  #pose: Pose;

  constructor(neutral: Pose, options: HeadAnimatorOptions = {}) {
    this.neutral = { pitchDeg: neutral.pitchDeg, rollDeg: neutral.rollDeg, heaveMm: neutral.heaveMm };
    this.#random = seededRandom(options.seed ?? 1);
    this.#spring = new SecondOrder(SPRING_HZ, SPRING_DAMPING, 0, [0, 0, 0]);
    this.#wander = [smoothWander(this.#random, WANDER.hz), smoothWander(this.#random, WANDER.hz * 0.8), smoothWander(this.#random, WANDER.hz * 1.3)];
    this.#breathAngle = this.#random() * 2 * Math.PI;
    this.#idleOn = options.idle ?? true;
    this.#idleWeight = this.#idleOn ? 1 : 0;
    this.#nextGlance = this.#glanceDelay();
    this.#pose = { ...this.neutral };
  }

  /** The gesture playing now, or null. */
  get playing(): HeadAnimationName | null {
    return this.#gesture?.clip.name ?? null;
  }

  get idle(): boolean {
    return this.#idleOn;
  }

  get energy(): number {
    return this.#energy;
  }

  /** The most recent target pose. */
  get pose(): Pose {
    return this.#pose;
  }

  setIdle(on: boolean): void {
    this.#idleOn = on;
  }

  /** How lively the idle layer is, 0…1. */
  setEnergy(energy: number): void {
    if (Number.isFinite(energy)) this.#energy = clamp(energy, 0, 1);
  }

  /**
   * How big gestures and glances are, relative to how they were written (for the CAD's room around the simulator's
   * neutral pose): a neck with more room gets bigger moves (see gestureSize). Breathing and wander stay as they are.
   */
  setSize(size: number): void {
    if (Number.isFinite(size)) this.#size = clamp(size, SIZE_RANGE[0], SIZE_RANGE[1]);
  }

  get size(): number {
    return this.#size;
  }

  /** Starts a gesture, handing over smoothly from whatever was playing. */
  play(name: HeadAnimationName, options: HeadPlayOptions = {}): void {
    const clip = HEAD_ANIMATIONS.get(name);
    if (!clip) throw new Error(`Unknown head animation "${name}"`);
    this.#handOver();
    const vary = (by: number) => 1 + (this.#random() * 2 - 1) * by;
    this.#gesture = {
      clip,
      start: this.#time,
      amplitude: clamp(Number.isFinite(options.intensity) ? options.intensity! : 1, 0, 1) * vary(AMPLITUDE_VARIATION),
      timeScale: clamp(Number.isFinite(options.speed) ? options.speed! : 1, 0.5, 1.5) * vary(TIMING_VARIATION),
    };
  }

  /** Stops the gesture; the head eases back. */
  stop(): void {
    this.#handOver();
    this.#gesture = null;
    this.#lastGestureEnd = this.#time;
  }

  /** Restarts from where the head actually is (after something else moved it), easing back from there. */
  resetFrom(pose: Pose): void {
    this.#gesture = null;
    this.#handover = null;
    this.#glance = null;
    this.#lastGestureEnd = this.#time;
    this.#spring.reset([pose.pitchDeg - this.neutral.pitchDeg, pose.rollDeg - this.neutral.rollDeg, pose.heaveMm - this.neutral.heaveMm]);
    this.#pose = { pitchDeg: pose.pitchDeg, rollDeg: pose.rollDeg, heaveMm: pose.heaveMm };
  }

  /** Advances by dt seconds and returns the target pose. */
  update(dt: number): Pose {
    if (!(dt > 0) || !Number.isFinite(dt)) return this.#pose;
    this.#time += dt;
    const t = this.#time;

    let total: Offset = this.#gestureLayer(t);
    if (this.#gesture && (t - this.#gesture.start) * this.#gesture.timeScale >= this.#gesture.clip.duration) {
      this.#gesture = null;
      this.#lastGestureEnd = t;
    }

    const idleTarget = !this.#idleOn ? 0 : this.#gesture ? IDLE_UNDER_GESTURE : 1;
    this.#idleWeight += (idleTarget - this.#idleWeight) * (1 - Math.exp(-dt / IDLE_BLEND_S));
    this.#liveliness += (this.#energy - this.#liveliness) * (1 - Math.exp(-dt / ENERGY_GLIDE_S));
    this.#breathAngle += 2 * Math.PI * BREATH.hz * (0.8 + 0.4 * this.#liveliness) * dt;
    this.#scheduleGlance(t);
    total = add(total, this.#idleOffset(t), this.#idleWeight);

    const s = this.#spring.update(dt, total);
    this.#pose = { pitchDeg: this.neutral.pitchDeg + s[0]!, rollDeg: this.neutral.rollDeg + s[1]!, heaveMm: this.neutral.heaveMm + s[2]! };
    return this.#pose;
  }

  #gestureOffset(t: number): Offset {
    const g = this.#gesture;
    if (!g) return [0, 0, 0];
    const at = g.clip.at((t - g.start) * g.timeScale);
    const k = g.amplitude * this.#size;
    return [at[0] * k, at[1] * k, at[2] * k];
  }

  /** How far the current handover has got: 0 = all of what was interrupted, 1 = all new (also when there is none). */
  #handoverProgress(t: number): number {
    const h = this.#handover;
    if (!h) return 1;
    const u = (t - h.start) / HANDOVER_S;
    if (u >= 1) {
      this.#handover = null;
      return 1;
    }
    return smoothstep(Math.max(0, u));
  }

  /** The gesture layer: the gesture, crossfading in from whatever it interrupted. */
  #gestureLayer(t: number): Offset {
    const k = this.#handoverProgress(t);
    const g = this.#gestureOffset(t);
    const h = this.#handover;
    if (!h || k >= 1) return g;
    return [g[0] * k + h.from[0] * (1 - k), g[1] * k + h.from[1] * (1 - k), g[2] * k + h.from[2] * (1 - k)];
  }

  #glanceOffset(t: number): Offset {
    const g = this.#glance;
    if (!g) return [0, 0, 0];
    const local = t - g.start;
    if (local >= g.curves[0].duration) {
      this.#glance = null;
      this.#nextGlance = t + this.#glanceDelay();
      return [0, 0, 0];
    }
    return [g.curves[0].at(local), g.curves[1].at(local), g.curves[2].at(local)];
  }

  /** What is showing now (gesture layer, glance) becomes what the next thing crossfades from. */
  #handOver(): void {
    const t = this.#time;
    const from = add(this.#gestureLayer(t), this.#glanceOffset(t), this.#idleWeight);
    this.#glance = null;
    this.#nextGlance = t + this.#glanceDelay();
    this.#handover = from.some((v) => v !== 0) ? { from, start: t } : null;
  }

  #idleOffset(t: number): Offset {
    const e = this.#liveliness;
    const breath = Math.sin(this.#breathAngle);
    const breathLag = Math.sin(this.#breathAngle - 0.7); // the tilt trails the rise a little
    const breathSize = 0.6 + 0.4 * e;
    const offset: Offset = [
      BREATH.pitchDeg * breathSize * breathLag + WANDER.pitchDeg * e * this.#wander[0](t),
      WANDER.rollDeg * e * this.#wander[1](t),
      BREATH.heaveMm * breathSize * breath + WANDER.heaveMm * e * this.#wander[2](t),
    ];
    return add(offset, this.#glanceOffset(t));
  }

  #glanceDelay(): number {
    const [lo, hi] = GLANCE.everyS;
    // Livelier means more frequent glances.
    return (lo + this.#random() * (hi - lo)) / (0.5 + 0.5 * this.#liveliness);
  }

  #scheduleGlance(t: number): void {
    if (!this.#idleOn || this.#gesture || this.#glance || t < this.#nextGlance) return;
    if (t - this.#lastGestureEnd < GLANCE.quietAfterGestureS || this.#liveliness < 0.15) {
      this.#nextGlance = t + 1;
      return;
    }
    // A look in a random direction, or (one time in four) a curious tilt; size follows energy.
    const size = GLANCE.tiltDeg * this.#size * (0.4 + 0.6 * this.#liveliness) * (0.55 + 0.45 * this.#random());
    const rise = GLANCE.heaveMm * this.#size;
    const curious = this.#random() < 0.25;
    const angle = this.#random() * 2 * Math.PI;
    const target: Offset = curious
      ? [size * 0.3, (this.#random() < 0.5 ? -1 : 1) * size * 0.95, -rise * 0.5]
      : [size * Math.sin(angle) * 0.8, size * Math.cos(angle), rise * (this.#random() * 2 - 1)];
    const reach = 0.28 + this.#random() * 0.2;
    const hold = reach + 0.6 + this.#random() * (curious ? 1.4 : 1.0);
    const back = hold + 0.45 + this.#random() * 0.3;
    const times = [0, reach, hold, back];
    this.#glance = {
      curves: [0, 1, 2].map((axis) => new MonotoneCurve(times, [0, target[axis]!, target[axis]! * 0.9, 0])) as unknown as readonly [MonotoneCurve, MonotoneCurve, MonotoneCurve],
      start: t,
    };
  }
}

/**
 * How big the gestures can be on a neck (HeadAnimator.setSize): the largest size at which every gesture, every
 * 20 ms, still fits inside these limits around this neutral pose with a tenth of the room to spare (for each play's
 * variation, up to 8%, and the idle layer underneath). The gestures were written using about three quarters of the
 * CAD's room around the simulator's neutral, so this is a little over 1 there; more on a neck with more room. At
 * most 4.
 */
export function gestureSize(neutral: Pose, limits: SafetyLimits, geometry: PlatformGeometry = DEFAULT_GEOMETRY, clearance: ClearanceModel | null = null): number {
  const HEADROOM = 1.1;
  const frames: Offset[] = [];
  for (const name of HEAD_ANIMATION_NAMES) {
    const clip = HEAD_ANIMATIONS.get(name)!;
    for (let t = 0; t <= clip.duration + 1e-9; t += 0.02) frames.push(clip.at(t));
  }
  // Glances (their biggest, in any direction) are smaller than the gestures, but are checked too.
  for (let a = 0; a < 360; a += 30) {
    const r = (a * Math.PI) / 180;
    frames.push([GLANCE.tiltDeg * Math.sin(r) * 0.8, GLANCE.tiltDeg * Math.cos(r), GLANCE.heaveMm * (a < 180 ? 1 : -1)]);
  }
  const fits = (size: number) =>
    frames.every((f) => {
      const k = size * HEADROOM;
      return checkPose({ pitchDeg: neutral.pitchDeg + f[0] * k, rollDeg: neutral.rollDeg + f[1] * k, heaveMm: neutral.heaveMm + f[2] * k }, geometry, limits, clearance).ok;
    });
  let lo = 0;
  let hi: number = SIZE_RANGE[1];
  if (fits(hi)) return hi;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 20) / 20;
}
