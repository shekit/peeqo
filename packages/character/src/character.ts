import type { HeadAnimationName, HeadAnimator, LedAnimator, LedColorName, LedPatternName } from '@peeqo/core';
import type { Emotion, ExpressiveFace } from '@peeqo/face';
import { expressionSpec, isExpressionName, type ExpressionName, type ExpressionStep } from './expressions.ts';
import type { SoundName, SoundPlayer } from './sounds.ts';

export const CHARACTER_STATES = ['idle', 'listening', 'thinking', 'speaking', 'sleeping'] as const;
export type CharacterState = (typeof CHARACTER_STATES)[number];

export function isCharacterState(name: string): name is CharacterState {
  return (CHARACTER_STATES as readonly string[]).includes(name);
}

interface StateSpec {
  readonly description: string;
  readonly face: Emotion;
  readonly faceIntensity?: number;
  /** Where the eyes rest (null: they wander). */
  readonly look: readonly [number, number] | null;
  readonly leds: LedPatternName;
  readonly ledColor?: LedColorName;
  /** Liveliness of the idle head motion, 0…1. */
  readonly energy: number;
  /** Played once on entering the state (unless an expression is running). */
  readonly enter?: { readonly head?: HeadAnimationName; readonly sound?: SoundName };
}

const STATES: Record<CharacterState, StateSpec> = {
  idle: { description: 'Awake and alive, nothing in particular going on', face: 'neutral', look: null, leds: 'off', energy: 0.8 },
  listening: {
    description: 'Paying attention to someone talking',
    face: 'listening',
    look: [0, -0.1],
    leds: 'listen',
    ledColor: 'aqua',
    energy: 0.45,
    enter: { head: 'listen' },
  },
  thinking: { description: 'Working out a reply', face: 'thinking', look: null, leds: 'spin', ledColor: 'aqua', energy: 0.4, enter: { head: 'think' } },
  speaking: { description: 'Talking', face: 'happy', faceIntensity: 0.3, look: [0, -0.05], leds: 'speak', ledColor: 'mint', energy: 1 },
  sleeping: {
    description: 'Asleep: eyes shut, slow breathing glow',
    face: 'asleep',
    look: null,
    leds: 'breathe',
    ledColor: 'sky',
    energy: 0,
    enter: { head: 'sigh', sound: 'yawn' },
  },
};

export function describeState(state: CharacterState): string {
  return STATES[state].description;
}

export interface CharacterParts {
  readonly head: HeadAnimator;
  readonly face: ExpressiveFace;
  readonly leds: LedAnimator;
  readonly sound?: SoundPlayer | null;
}

interface Running {
  readonly name: ExpressionName;
  readonly intensity: number;
  readonly startMs: number;
  next: number;
  touched: { face: boolean; look: boolean; leds: boolean };
}

/**
 * Peeqo as a character. It is always in a state (idle, listening, thinking, speaking or sleeping), which sets the
 * resting face, gaze, LED ring and how lively the head is. Expressions play over the state: timed steps that move
 * the head, eyes, ring and voice together. When an expression ends, whatever it changed returns to the state.
 * Call update() every frame with the current time.
 */
export class Character {
  readonly #parts: CharacterParts;
  #state: CharacterState = 'idle';
  #running: Running | null = null;
  #nowMs = 0;

  constructor(parts: CharacterParts) {
    this.#parts = parts;
    this.#applyState(STATES.idle, false);
  }

  get state(): CharacterState {
    return this.#state;
  }

  /** The expression playing now, or null. */
  get expression(): ExpressionName | null {
    return this.#running?.name ?? null;
  }

  /** Changes state. While an expression plays, the new state's look waits until it ends. */
  setState(state: CharacterState): void {
    if (!isCharacterState(state)) throw new Error(`Unknown state "${String(state)}"`);
    if (state === this.#state) return;
    this.#state = state;
    const spec = STATES[state];
    if (this.#running) {
      // The new state's whole look (face, gaze, ring) takes over when the expression ends.
      this.#running.touched = { face: true, look: true, leds: true };
      this.#parts.head.setEnergy(spec.energy);
      return;
    }
    this.#applyState(spec, true);
  }

  /** Plays an expression now, replacing any that is playing. Intensity 0…1 scales the face and head. */
  express(name: ExpressionName, options: { intensity?: number } = {}): void {
    if (!isExpressionName(name)) throw new Error(`Unknown expression "${String(name)}"`);
    const intensity = options.intensity !== undefined && Number.isFinite(options.intensity) ? Math.min(1, Math.max(0, options.intensity)) : 1;
    const previous = this.#running;
    this.#running = {
      name,
      intensity,
      startMs: this.#nowMs,
      next: 0,
      touched: { face: previous?.touched.face ?? false, look: previous?.touched.look ?? false, leds: previous?.touched.leds ?? false },
    };
    this.#runDueSteps();
  }

  /** Ends the expression now; Peeqo returns to its state. */
  stop(): void {
    if (this.#running) this.#finish();
  }

  update(nowMs: number): void {
    this.#nowMs = nowMs;
    if (!this.#running) return;
    this.#runDueSteps();
    const running = this.#running;
    if (running && nowMs - running.startMs >= expressionSpec(running.name).duration * 1000) this.#finish();
  }

  #runDueSteps(): void {
    const running = this.#running;
    if (!running) return;
    const steps = expressionSpec(running.name).steps;
    while (running.next < steps.length && this.#nowMs - running.startMs >= steps[running.next]!.at * 1000) {
      this.#runStep(steps[running.next]!, running);
      running.next++;
    }
  }

  #runStep(step: ExpressionStep, running: Running): void {
    const { head, face, leds, sound } = this.#parts;
    const k = running.intensity;
    if (step.face) {
      face.setEmotion(step.face, (step.faceIntensity ?? 1) * k);
      running.touched.face = true;
    }
    if (step.look !== undefined) {
      face.lookAt(step.look);
      running.touched.look = true;
    }
    if (step.head) {
      const options = step.headSpeed === undefined ? { intensity: (step.headIntensity ?? 1) * k } : { intensity: (step.headIntensity ?? 1) * k, speed: step.headSpeed };
      head.play(step.head, options);
    }
    if (step.leds) {
      leds.play(step.leds, step.ledColor === undefined ? {} : { color: step.ledColor });
      running.touched.leds = true;
    }
    if (step.sound) sound?.play(step.sound);
  }

  #finish(): void {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    const spec = STATES[this.#state];
    const { face, leds } = this.#parts;
    // Steps not yet reached are dropped; whatever the expression changed returns to the state.
    if (running.touched.face) face.setEmotion(spec.face, spec.faceIntensity ?? 1);
    if (running.touched.look) face.lookAt(spec.look);
    if (running.touched.leds) leds.play(spec.leds, spec.ledColor === undefined ? {} : { color: spec.ledColor });
  }

  #applyState(spec: StateSpec, enter: boolean): void {
    const { head, face, leds, sound } = this.#parts;
    face.setEmotion(spec.face, spec.faceIntensity ?? 1);
    face.lookAt(spec.look);
    leds.play(spec.leds, spec.ledColor === undefined ? {} : { color: spec.ledColor });
    head.setEnergy(spec.energy); // whether the idle layer runs at all is a setting, left as it is
    if (enter && spec.enter?.head) head.play(spec.enter.head, { intensity: 0.8 });
    if (enter && spec.enter?.sound) sound?.play(spec.enter.sound);
  }
}
