/** Smooth-motion building blocks for head animation: damped springs, keyframe curves, seeded noise. */

/**
 * Second-order dynamics (a damped spring) that follows a moving target, one value per channel.
 * - f: natural frequency in Hz (how quickly it responds);
 * - zeta: damping (1 = critically damped; below 1 overshoots a little and settles, which reads as weight);
 * - r: initial response (0 = starts gently; above 0 reacts at once; below 0 anticipates by moving away first).
 * Semi-implicit Euler with a stability bound (after t3ssel8r, "Giving personality to procedural animations").
 */
export class SecondOrder {
  readonly #k1: number;
  readonly #k2: number;
  readonly #k3: number;
  #previousTarget: number[];
  #value: number[];
  #velocity: number[];

  constructor(f: number, zeta: number, r: number, initial: readonly number[]) {
    if (!(f > 0) || !(zeta >= 0) || !Number.isFinite(r)) throw new Error('SecondOrder needs f > 0, zeta ≥ 0 and a finite r');
    this.#k1 = zeta / (Math.PI * f);
    this.#k2 = 1 / (2 * Math.PI * f) ** 2;
    this.#k3 = (r * zeta) / (2 * Math.PI * f);
    this.#previousTarget = [...initial];
    this.#value = [...initial];
    this.#velocity = initial.map(() => 0);
  }

  get value(): readonly number[] {
    return this.#value;
  }

  /** Jumps to `values`, at rest. */
  reset(values: readonly number[]): void {
    this.#previousTarget = [...values];
    this.#value = [...values];
    this.#velocity = values.map(() => 0);
  }

  /** Advances by dt seconds toward `target` and returns the new value. */
  update(dt: number, target: readonly number[]): readonly number[] {
    if (!(dt > 0)) return this.#value;
    // Keeps the integration stable for any time step.
    const k2 = Math.max(this.#k2, (dt * dt) / 2 + (dt * this.#k1) / 2, dt * this.#k1);
    for (let i = 0; i < this.#value.length; i++) {
      const x = target[i]!;
      const xd = (x - this.#previousTarget[i]!) / dt;
      this.#value[i]! += dt * this.#velocity[i]!;
      this.#velocity[i]! += (dt * (x + this.#k3 * xd - this.#value[i]! - this.#k1 * this.#velocity[i]!)) / k2;
      this.#previousTarget[i] = x;
    }
    return this.#value;
  }
}

/**
 * A smooth curve through keyframes (t, value) that never overshoots them: monotone cubic Hermite
 * (Fritsch–Butland tangents). It starts and ends at rest, eases into and out of every turning point, and stays
 * within the range of its neighbouring keys, so a curve's extremes are exactly its keys' extremes.
 */
export class MonotoneCurve {
  readonly #t: readonly number[];
  readonly #v: readonly number[];
  readonly #m: readonly number[];

  constructor(times: readonly number[], values: readonly number[]) {
    if (times.length !== values.length || times.length < 2) throw new Error('A curve needs at least two keys');
    for (let i = 1; i < times.length; i++) {
      if (!(times[i]! > times[i - 1]!)) throw new Error('Curve keys must be in increasing time order');
    }
    const n = times.length;
    const slope = (i: number) => (values[i + 1]! - values[i]!) / (times[i + 1]! - times[i]!);
    const m = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const d0 = slope(i - 1);
      const d1 = slope(i);
      if (d0 * d1 <= 0) continue; // a turning point (or flat): ease through it at rest
      const h0 = times[i]! - times[i - 1]!;
      const h1 = times[i + 1]! - times[i]!;
      m[i] = (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1);
    }
    this.#t = [...times];
    this.#v = [...values];
    this.#m = m;
  }

  get duration(): number {
    return this.#t[this.#t.length - 1]! - this.#t[0]!;
  }

  at(time: number): number {
    const t = this.#t;
    if (time <= t[0]!) return this.#v[0]!;
    if (time >= t[t.length - 1]!) return this.#v[t.length - 1]!;
    let i = 0;
    while (time > t[i + 1]!) i++;
    const h = t[i + 1]! - t[i]!;
    const s = (time - t[i]!) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * this.#v[i]! +
      (s3 - 2 * s2 + s) * h * this.#m[i]! +
      (-2 * s3 + 3 * s2) * this.#v[i + 1]! +
      (s3 - s2) * h * this.#m[i + 1]!
    );
  }
}

/** Seeded pseudo-random numbers in [0, 1) (mulberry32), so behaviour can be replayed exactly. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Smooth, never-repeating wander in [−1, 1]: three sines at unrelated frequencies with random phases.
 * `rate` is the main frequency in Hz.
 */
export function smoothWander(random: () => number, rate: number): (time: number) => number {
  const parts = [
    { f: rate, a: 0.55 },
    { f: rate * 1.618, a: 0.3 },
    { f: rate * 2.718, a: 0.15 },
  ].map((p) => ({ ...p, phase: random() * 2 * Math.PI }));
  return (time) => parts.reduce((sum, p) => sum + p.a * Math.sin(2 * Math.PI * p.f * time + p.phase), 0);
}
