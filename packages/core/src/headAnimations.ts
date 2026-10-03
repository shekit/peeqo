import { MonotoneCurve } from './motion.ts';

/**
 * Peeqo's head gestures, authored for the dev kit's neck. Values are offsets from the neutral pose: pitch
 * (degrees, + looks up), roll (degrees, + tips toward Peeqo's right) and heave (millimetres, + rises).
 *
 * The neck's room is a double cone: about ±5° of tilt at the neutral height, shrinking to nothing 3 mm above or
 * below it. Tilting up has the most room with the head about 1 mm lower, tilting down about 1 mm higher, so the
 * gestures mix in height to look bigger (looking up sinks a little, perking up tilts back). Every key stays within
 * about 75% of the room at its height; the tests check every frame, with the idle layer and random variation on
 * top, against the real safety check, and that the governor never has to hold anything back.
 *
 * Between keys the motion follows a curve that eases into and out of every turning point and never overshoots
 * a key; the animator's spring then adds the follow-through. Small opposite moves before big ones are anticipation.
 */
export interface HeadKey {
  /** Seconds from the start of the gesture. */
  readonly t: number;
  /** Offsets from neutral. An axis left out keeps its value from the previous key. */
  readonly pitch?: number;
  readonly roll?: number;
  readonly heave?: number;
}

export interface HeadClipSpec {
  readonly name: string;
  /** What it looks like, for people and for the AI choosing it. */
  readonly description: string;
  readonly keys: readonly HeadKey[];
}

const SPECS = [
  {
    name: 'nod',
    description: 'A happy double nod: yes, yes!',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.1, pitch: 0.9, heave: 0.2 },
      { t: 0.28, pitch: -3.4, heave: -0.3 },
      { t: 0.46, pitch: 0.8, heave: 0.2 },
      { t: 0.62, pitch: -2.6, heave: -0.2 },
      { t: 0.8, pitch: 0.4, heave: 0.1 },
      { t: 1.05, pitch: 0, heave: 0 },
    ],
  },
  {
    name: 'shake',
    description: 'A side-to-side wobble that means no (the head cannot turn, so it rocks)',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.1, roll: -0.8, pitch: -0.3 },
      { t: 0.27, roll: 3.4, pitch: -0.8 },
      { t: 0.46, roll: -3.0 },
      { t: 0.64, roll: 2.2 },
      { t: 0.82, roll: -1.2 },
      { t: 1.0, roll: 0.4, pitch: -0.4 },
      { t: 1.25, roll: 0, pitch: 0 },
    ],
  },
  {
    name: 'tilt',
    description: 'A curious puppy head tilt that lingers, then comes back',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.12, roll: -0.6 },
      { t: 0.5, roll: 3.3, pitch: 0.9, heave: -0.3 },
      { t: 0.85, roll: 3.0, pitch: 1.0 },
      { t: 1.55, roll: 3.2, pitch: 0.8 },
      { t: 2.1, roll: 0, pitch: 0, heave: 0 },
    ],
  },
  {
    name: 'look-up',
    description: 'Looks up with interest, sinking back a little: ooh, what is that?',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.14, pitch: -0.7, heave: 0.2 },
      { t: 0.55, pitch: 4.4, heave: -0.8 },
      { t: 0.95, pitch: 4.7, heave: -0.9 },
      { t: 1.6, pitch: 4.5, heave: -0.8 },
      { t: 2.3, pitch: 0, heave: 0 },
    ],
  },
  {
    name: 'look-down',
    description: 'A bashful look down with a small shy tilt',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.16, pitch: 0.5 },
      { t: 0.65, pitch: -3.8, heave: 0.5 },
      { t: 1.5, pitch: -3.6, roll: 0.8 },
      { t: 2.2, pitch: 0, roll: 0, heave: 0 },
    ],
  },
  {
    name: 'droop',
    description: 'Slowly sinks and looks down, sad',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 1.1, pitch: -1.8, roll: -0.5, heave: -0.9 },
      { t: 2.3, pitch: -2.0, roll: -0.6, heave: -1.0 },
      { t: 3.3, pitch: 0, roll: 0, heave: 0 },
    ],
  },
  {
    name: 'perk-up',
    description: 'Crouches for an instant, then pops up alert and interested',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.1, heave: -0.4, pitch: -0.5 },
      { t: 0.3, heave: 1.7, pitch: 0.8 },
      { t: 1.1, heave: 1.6, pitch: 0.9 },
      { t: 1.8, heave: 0, pitch: 0 },
    ],
  },
  {
    name: 'bounce',
    description: 'Three happy bounces, swaying side to side',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.12, heave: -0.5 },
      { t: 0.28, heave: 1.5, roll: 1.4 },
      { t: 0.44, heave: -0.2, roll: 0 },
      { t: 0.6, heave: 1.3, roll: -1.3 },
      { t: 0.76, heave: -0.2, roll: 0 },
      { t: 0.92, heave: 0.9, roll: 0.8 },
      { t: 1.2, heave: 0, roll: 0 },
    ],
  },
  {
    name: 'wiggle',
    description: 'A fast excited wiggle with a little lift',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.08, roll: 2.4, heave: 0.4 },
      { t: 0.2, roll: -2.4 },
      { t: 0.32, roll: 2.2, heave: 0.6 },
      { t: 0.44, roll: -2.0 },
      { t: 0.56, roll: 1.6, heave: 0.4 },
      { t: 0.68, roll: -1.2 },
      { t: 0.82, roll: 0.5, heave: 0.2 },
      { t: 1.05, roll: 0, heave: 0 },
    ],
  },
  {
    name: 'think',
    description: 'Ponders, looking up and off to one side',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.7, pitch: 2.3, roll: -2.3, heave: -0.4 },
      { t: 1.5, pitch: 2.6, roll: -2.1, heave: -0.5 },
      { t: 2.4, pitch: 2.4, roll: -2.3, heave: -0.4 },
      { t: 3.1, pitch: 0, roll: 0, heave: 0 },
    ],
  },
  {
    name: 'listen',
    description: 'Leans in with a tilt, paying attention',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.45, pitch: -1.4, roll: 2.2, heave: 0.3 },
      { t: 1.4, pitch: -1.6, roll: 2.4 },
      { t: 2.2, pitch: -1.4, roll: 2.1 },
      { t: 2.8, pitch: 0, roll: 0, heave: 0 },
    ],
  },
  {
    name: 'doze',
    description: 'Nods off, sinking slowly, then catches itself with a start',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 1.4, pitch: -1.8, heave: -0.9 },
      { t: 2.0, pitch: -2.1, heave: -1.0 },
      { t: 2.25, pitch: 0.6, heave: 0.3 },
      { t: 2.6, pitch: 0.2, heave: 0.1 },
      { t: 3.2, pitch: 0, heave: 0 },
    ],
  },
  {
    name: 'sigh',
    description: 'A big breath in, then a slow sigh out',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.9, heave: 1.1, pitch: 1.2 },
      { t: 1.2, heave: 1.15, pitch: 1.3 },
      { t: 2.2, heave: -0.8, pitch: -1.6 },
      { t: 3.0, heave: 0, pitch: 0 },
    ],
  },
  {
    name: 'startle',
    description: 'A quick jump back: eep!',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.12, heave: 1.2, pitch: 1.3 },
      { t: 0.45, heave: 1.05, pitch: 1.1 },
      { t: 1.1, heave: 0, pitch: 0 },
    ],
  },
  {
    name: 'groove',
    description: 'Dances to a beat: sways side to side, bouncing on each step',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      ...[0, 1, 2].flatMap((beat) => [
        { t: beat + 0.25, roll: 2.4, heave: 0.8 },
        { t: beat + 0.5, roll: 0, heave: 0 },
        { t: beat + 0.75, roll: -2.4, heave: 0.8 },
        { t: beat + 1, roll: 0, heave: 0 },
      ]),
    ],
  },
  {
    name: 'hello',
    description: 'A perky greeting: pops up with a friendly tilt one way, then the other',
    keys: [
      { t: 0, pitch: 0, roll: 0, heave: 0 },
      { t: 0.1, heave: -0.4 },
      { t: 0.3, heave: 1.4, pitch: 1.2, roll: 1.7 },
      { t: 0.6, heave: 1.0, pitch: 1.0, roll: -1.6 },
      { t: 0.9, heave: 1.1, roll: 1.2 },
      { t: 1.3, heave: 0, pitch: 0, roll: 0 },
    ],
  },
] as const satisfies readonly HeadClipSpec[];

export type HeadAnimationName = (typeof SPECS)[number]['name'];

/** A gesture ready to play: one smooth curve per axis. */
export class HeadClip {
  readonly name: HeadAnimationName;
  readonly description: string;
  readonly duration: number;
  readonly #curves: readonly [MonotoneCurve, MonotoneCurve, MonotoneCurve];

  constructor(spec: HeadClipSpec & { name: HeadAnimationName }) {
    const keys = spec.keys;
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (!first || first.t !== 0 || first.pitch !== 0 || first.roll !== 0 || first.heave !== 0) {
      throw new Error(`Gesture "${spec.name}" must start at t = 0 with every axis at 0`);
    }
    const values: [number[], number[], number[]] = [[], [], []];
    let current = [0, 0, 0];
    for (const key of keys) {
      current = [key.pitch ?? current[0]!, key.roll ?? current[1]!, key.heave ?? current[2]!];
      for (let axis = 0; axis < 3; axis++) values[axis]!.push(current[axis]!);
    }
    if (current.some((v) => v !== 0)) throw new Error(`Gesture "${spec.name}" must end with every axis back at 0`);
    const times = keys.map((k) => k.t);
    this.name = spec.name;
    this.description = spec.description;
    this.duration = last!.t;
    this.#curves = [new MonotoneCurve(times, values[0]), new MonotoneCurve(times, values[1]), new MonotoneCurve(times, values[2])];
  }

  /** Offsets [pitch°, roll°, heave mm] at a time in seconds (held at the end values outside the clip). */
  at(time: number): [number, number, number] {
    return [this.#curves[0].at(time), this.#curves[1].at(time), this.#curves[2].at(time)];
  }
}

export const HEAD_ANIMATIONS: ReadonlyMap<HeadAnimationName, HeadClip> = new Map(SPECS.map((spec) => [spec.name, new HeadClip(spec)]));
export const HEAD_ANIMATION_NAMES: readonly HeadAnimationName[] = SPECS.map((spec) => spec.name);

export function isHeadAnimationName(name: string): name is HeadAnimationName {
  return HEAD_ANIMATIONS.has(name as HeadAnimationName);
}
