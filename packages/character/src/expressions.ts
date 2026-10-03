import type { HeadAnimationName, LedColorName, LedPatternName } from '@peeqo/core';
import type { Emotion } from '@peeqo/face';
import type { SoundName } from './sounds.ts';

/**
 * Peeqo's expressions: short performances that move the head, eyes, LED ring and voice together. Each is a few
 * timed steps; anything a step leaves out keeps doing what it was doing. When an expression ends, Peeqo returns
 * to its current state (idle, listening, thinking, speaking, sleeping).
 */
export interface ExpressionStep {
  /** Seconds from the start of the expression. */
  readonly at: number;
  readonly face?: Emotion;
  /** Face intensity, 0…1 (default 1). */
  readonly faceIntensity?: number;
  /** Where the eyes look (−1…1, +x to the screen's right, +y down), or null to let them wander. */
  readonly look?: readonly [number, number] | null;
  readonly head?: HeadAnimationName;
  readonly headIntensity?: number;
  readonly headSpeed?: number;
  readonly leds?: LedPatternName;
  readonly ledColor?: LedColorName;
  readonly sound?: SoundName;
}

export interface ExpressionSpec {
  /** What it looks like and when to use it (also what the AI reads when choosing one). */
  readonly description: string;
  readonly steps: readonly ExpressionStep[];
  /** Seconds until Peeqo returns to its state. */
  readonly duration: number;
}

const EXPRESSIONS = {
  happy: {
    description: 'Beams and bounces with a chirp: glad, pleased, that is nice',
    steps: [{ at: 0, face: 'happy', head: 'bounce', leds: 'glow', ledColor: 'warm', sound: 'chirp' }],
    duration: 2.2,
  },
  excited: {
    description: 'Wiggles, sparkles and squeaks: thrilled, can not wait, amazing news',
    steps: [
      { at: 0, face: 'excited', head: 'wiggle', leds: 'sparkle', ledColor: 'yellow', sound: 'wow' },
      { at: 1.1, head: 'bounce' },
    ],
    duration: 2.6,
  },
  laugh: {
    description: 'Giggles and bounces: that is funny',
    steps: [
      { at: 0, face: 'happy', head: 'bounce', headSpeed: 1.3, leds: 'sparkle', ledColor: 'warm', sound: 'giggle' },
      { at: 0.9, head: 'bounce', headIntensity: 0.7, headSpeed: 1.3 },
    ],
    duration: 2.1,
  },
  love: {
    description: 'Heart eyes, a heartbeat glow and a coo: affection, thank you, you are sweet',
    steps: [
      { at: 0, face: 'love', leds: 'heartbeat', ledColor: 'pink' },
      { at: 0.1, sound: 'coo' },
      { at: 0.2, head: 'tilt' },
    ],
    duration: 3.0,
  },
  sad: {
    description: 'Droops with sad eyes and an aww: sorry, that is a shame, bad news',
    steps: [
      { at: 0, face: 'sad', head: 'droop', leds: 'breathe', ledColor: 'blue' },
      { at: 0.2, sound: 'aww' },
    ],
    duration: 3.6,
  },
  grumpy: {
    description: 'Narrowed eyes, a grumble and a shake: annoyed, not happy about that',
    steps: [
      { at: 0, face: 'angry', leds: 'glow', ledColor: 'orange', sound: 'grumble' },
      { at: 0.15, head: 'shake', headIntensity: 0.7 },
    ],
    duration: 2.2,
  },
  surprised: {
    description: 'Eyes pop and it jumps: whoa, really? unexpected',
    steps: [
      { at: 0, face: 'surprised', head: 'startle', leds: 'wake', sound: 'whoa' },
      { at: 1.4, face: 'curious', faceIntensity: 0.6 },
    ],
    duration: 2.6,
  },
  scared: {
    description: 'Jumps, eyes darting, with an eep: frightened, nervous',
    steps: [
      { at: 0, face: 'scared', head: 'startle', leds: 'wake', ledColor: 'purple', sound: 'eep' },
      { at: 0.9, head: 'shake', headIntensity: 0.5 },
    ],
    duration: 2.4,
  },
  sleepy: {
    description: 'Yawns and nods off: tired, it is late',
    steps: [
      { at: 0, face: 'sleepy', leds: 'breathe', ledColor: 'sky', sound: 'yawn' },
      { at: 0.3, head: 'doze' },
    ],
    duration: 3.6,
  },
  curious: {
    description: 'Tilts its head with a hmm: interested, what is that? tell me more',
    steps: [
      { at: 0, face: 'curious', head: 'tilt', leds: 'glow', ledColor: 'aqua' },
      { at: 0.15, sound: 'hmm' },
    ],
    duration: 2.4,
  },
  confused: {
    description: 'Puzzled tilt and a little shake: huh? I do not understand',
    steps: [
      { at: 0, face: 'confused', head: 'tilt', leds: 'spin', ledColor: 'orange' },
      { at: 0.1, sound: 'huh' },
      { at: 1.2, head: 'shake', headIntensity: 0.5 },
    ],
    duration: 2.8,
  },
  thinking: {
    description: 'Looks up and away, ring circling: let me think',
    steps: [
      { at: 0, face: 'thinking', head: 'think', leds: 'spin', ledColor: 'aqua' },
      { at: 0.3, sound: 'ponder' },
    ],
    duration: 3.2,
  },
  yes: {
    description: 'Nods happily with a ding: yes, agreed, done',
    steps: [
      { at: 0, face: 'happy', faceIntensity: 0.7, head: 'nod', leds: 'success' },
      { at: 0.1, sound: 'ding' },
    ],
    duration: 1.6,
  },
  no: {
    description: 'Rocks side to side with a bonk: no, nope, I can not',
    steps: [{ at: 0, face: 'skeptical', head: 'shake', leds: 'error', sound: 'bonk' }],
    duration: 1.8,
  },
  hello: {
    description: 'Pops up with a friendly tilt: hi! greeting someone',
    steps: [{ at: 0, face: 'happy', head: 'hello', leds: 'wake', sound: 'hello' }],
    duration: 2.0,
  },
  bye: {
    description: 'A fond nod and a wink as the light fades: goodbye, see you',
    steps: [
      { at: 0, face: 'happy', faceIntensity: 0.8, head: 'nod', headIntensity: 0.6, headSpeed: 0.8, leds: 'glow', ledColor: 'warm', sound: 'bye' },
      { at: 1.0, face: 'wink' },
      { at: 1.6, leds: 'off' },
    ],
    duration: 2.4,
  },
  shy: {
    description: 'Looks down bashfully with a soft coo: flattered, embarrassed',
    steps: [
      { at: 0, face: 'shy', head: 'look-down', leds: 'glow', ledColor: 'pink' },
      { at: 0.3, sound: 'coo' },
    ],
    duration: 2.6,
  },
  wink: {
    description: 'A cheeky wink and a click: joking, our secret',
    steps: [{ at: 0, face: 'wink', head: 'tilt', headIntensity: 0.6, leds: 'sparkle', ledColor: 'warm', sound: 'click' }],
    duration: 1.6,
  },
  celebrate: {
    description: 'Dances under a rainbow with a fanfare: woohoo, congratulations',
    steps: [{ at: 0, face: 'excited', head: 'groove', leds: 'rainbow', sound: 'fanfare' }],
    duration: 3.4,
  },
  alert: {
    description: 'Perks up, eyes wide, ring bursting: I heard you, I am listening',
    steps: [{ at: 0, face: 'listening', head: 'perk-up', leds: 'wake', sound: 'bloop', look: [0, -0.1] }],
    duration: 1.8,
  },
  oops: {
    description: 'A sheepish shake: oops, my mistake, something went wrong',
    steps: [{ at: 0, face: 'confused', faceIntensity: 0.7, head: 'shake', headIntensity: 0.6, leds: 'error', sound: 'bonk' }],
    duration: 1.8,
  },
  sigh: {
    description: 'A big sigh: oh well, tired of that',
    steps: [{ at: 0, face: 'sad', faceIntensity: 0.5, head: 'sigh', leds: 'breathe', ledColor: 'sky', sound: 'sigh' }],
    duration: 3.0,
  },
  wonder: {
    description: 'Gazes upward in wonder: wow, look at that, imagine',
    steps: [
      { at: 0, face: 'surprised', faceIntensity: 0.45, head: 'look-up', look: [0, -0.8], leds: 'glow', ledColor: 'sky' },
      { at: 2.2, look: null },
    ],
    duration: 2.6,
  },
} as const satisfies Record<string, ExpressionSpec>;

export type ExpressionName = keyof typeof EXPRESSIONS;
export const EXPRESSION_NAMES = Object.keys(EXPRESSIONS) as ExpressionName[];

export function isExpressionName(name: string): name is ExpressionName {
  return Object.hasOwn(EXPRESSIONS, name);
}

export function expressionSpec(name: ExpressionName): ExpressionSpec {
  return EXPRESSIONS[name];
}
