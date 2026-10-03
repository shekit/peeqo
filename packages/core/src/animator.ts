import { HEAD_ANIMATIONS, type HeadAnimationName, type HeadClip } from './headAnimations.ts';
import type { Pose } from './kinematics.ts';
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
 * - the remains of an interrupted gesture, fading out over HANDOVER_S;
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

    let total: Offset = this.#gestureOffset(t);
    if (this.#gesture && (t - this.#gesture.start) * this.#gesture.timeScale >= this.#gesture.clip.duration) {
      this.#gesture = null;
      this.#lastGestureEnd = t;
    }
    total = add(total, this.#handoverOffset(t));

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
    return [at[0] * g.amplitude, at[1] * g.amplitude, at[2] * g.amplitude];
  }

  #handoverOffset(t: number): Offset {
    const h = this.#handover;
    if (!h) return [0, 0, 0];
    const u = (t - h.start) / HANDOVER_S;
    if (u >= 1) {
      this.#handover = null;
      return [0, 0, 0];
    }
    const k = 1 - smoothstep(Math.max(0, u));
    return [h.from[0] * k, h.from[1] * k, h.from[2] * k];
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

  /** What is moving now (gesture, handover, glance) becomes a handover that fades as the next thing starts. */
  #handOver(): void {
    const t = this.#time;
    let from = add(this.#gestureOffset(t), this.#handoverOffset(t));
    from = add(from, this.#glanceOffset(t), this.#idleWeight);
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
    const size = GLANCE.tiltDeg * (0.4 + 0.6 * this.#liveliness) * (0.55 + 0.45 * this.#random());
    const curious = this.#random() < 0.25;
    const angle = this.#random() * 2 * Math.PI;
    const target: Offset = curious
      ? [size * 0.3, (this.#random() < 0.5 ? -1 : 1) * size * 0.95, -GLANCE.heaveMm * 0.5]
      : [size * Math.sin(angle) * 0.8, size * Math.cos(angle), GLANCE.heaveMm * (this.#random() * 2 - 1)];
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
