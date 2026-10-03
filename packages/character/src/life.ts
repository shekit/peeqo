import { seededRandom } from '@peeqo/core';
import type { Character } from './character.ts';
import type { ExpressionName } from './expressions.ts';

export interface LifeOptions {
  readonly seed?: number;
  /** Quiet time before Peeqo nods off (default 5 minutes). */
  readonly sleepAfterMs?: number;
  /** Range of the pause between little things it does on its own while awake and idle (default 25–80 s). */
  readonly everyMs?: readonly [number, number];
}

interface Habit {
  readonly expression: ExpressionName;
  readonly intensity: number;
  readonly weight: number;
  /** Only once it has been quiet this long (ms). */
  readonly afterQuietMs: number;
}

// Small things Peeqo does on its own. The longer it is left alone, the more its habits drift toward boredom.
const HABITS: readonly Habit[] = [
  { expression: 'curious', intensity: 0.6, weight: 3, afterQuietMs: 0 },
  { expression: 'wonder', intensity: 0.6, weight: 2, afterQuietMs: 0 },
  { expression: 'happy', intensity: 0.5, weight: 2, afterQuietMs: 0 },
  { expression: 'thinking', intensity: 0.5, weight: 1, afterQuietMs: 30_000 },
  { expression: 'sigh', intensity: 0.6, weight: 2, afterQuietMs: 90_000 },
  { expression: 'sleepy', intensity: 0.7, weight: 2, afterQuietMs: 150_000 },
];

/**
 * Peeqo's own life between conversations. While awake and idle it now and then does something small on its own (a
 * curious look, a little wonder, later a sigh or a yawn). After a quiet spell it falls asleep, and anything that
 * involves it (being spoken to, the mic opening, a button) wakes it with a start. It only acts while the character
 * is idle (or asleep), so it never interrupts listening, thinking or speaking. Call update() every frame.
 */
export class Life {
  enabled = true;
  readonly #character: Character;
  readonly #random: () => number;
  readonly #sleepAfterMs: number;
  readonly #every: readonly [number, number];
  #lastPokeMs: number | null = null;
  #nextHabitMs: number | null = null;

  constructor(character: Character, options: LifeOptions = {}) {
    this.#character = character;
    this.#random = seededRandom(options.seed ?? 1);
    this.#sleepAfterMs = options.sleepAfterMs ?? 300_000;
    this.#every = options.everyMs ?? [25_000, 80_000];
  }

  /** Something involved Peeqo: it wakes if asleep, and the quiet clock restarts. */
  poke(nowMs: number): void {
    this.#lastPokeMs = nowMs;
    this.#nextHabitMs = nowMs + this.#pause();
    if (this.#character.state === 'sleeping') {
      this.#character.setState('idle');
      this.#character.express('surprised', { intensity: 0.6 });
    }
  }

  update(nowMs: number): void {
    if (this.#lastPokeMs === null) this.poke(nowMs); // the clock starts with the first frame
    if (!this.enabled) return;
    const character = this.#character;
    if (character.state !== 'idle' || character.expression !== null) {
      // Busy (talking, thinking, playing an expression): it is not bored.
      if (character.state !== 'sleeping' && character.state !== 'idle') this.#lastPokeMs = nowMs;
      return;
    }
    const quietMs = nowMs - this.#lastPokeMs!;
    if (quietMs >= this.#sleepAfterMs) {
      character.setState('sleeping');
      return;
    }
    if (nowMs >= this.#nextHabitMs!) {
      const habit = this.#pick(quietMs);
      if (habit) character.express(habit.expression, { intensity: habit.intensity });
      this.#nextHabitMs = nowMs + this.#pause();
    }
  }

  #pause(): number {
    const [lo, hi] = this.#every;
    return lo + this.#random() * (hi - lo);
  }

  #pick(quietMs: number): Habit | null {
    const open = HABITS.filter((h) => quietMs >= h.afterQuietMs);
    const total = open.reduce((sum, h) => sum + h.weight, 0);
    let r = this.#random() * total;
    for (const habit of open) {
      r -= habit.weight;
      if (r < 0) return habit;
    }
    return open[open.length - 1] ?? null;
  }
}
