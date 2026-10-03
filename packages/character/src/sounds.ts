/**
 * Peeqo's voice before it talks: short synthesized chirps, coos and bloops, written as notes and rendered to
 * samples in plain TypeScript. The simulator plays the samples through Web Audio; the robot can play the same
 * samples through its speaker, so both sound identical.
 */
export interface Note {
  /** Start, seconds from the beginning of the sound. */
  readonly at: number;
  /** Length in seconds. */
  readonly dur: number;
  /** Pitch at the start, Hz. */
  readonly from: number;
  /** Pitch at the end (an exponential glide), Hz; default: no glide. */
  readonly to?: number;
  /** Loudness, 0…1 (default 1). */
  readonly gain?: number;
  /** Wobble in pitch: rate in Hz, depth as a fraction of the pitch. */
  readonly vibrato?: { readonly rate: number; readonly depth: number };
  /** Frequency modulation for a bubbly or growly timbre: modulator-to-carrier ratio, modulation index. */
  readonly fm?: { readonly ratio: number; readonly index: number };
  /** Harmonic colour: pure sine, soft (a little warmth) or bright. */
  readonly tone?: 'sine' | 'soft' | 'bright';
  /** Fade-in and fade-out in seconds (defaults 8 ms and 40 ms), so nothing clicks. */
  readonly attack?: number;
  readonly release?: number;
}

export interface SoundSpec {
  readonly description: string;
  readonly notes: readonly Note[];
}

const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;

const SOUNDS = {
  chirp: {
    description: 'Three quick rising chirps: happy',
    notes: [
      { at: 0, dur: 0.07, from: 1046, to: 1318, tone: 'soft' },
      { at: 0.08, dur: 0.07, from: 1318, to: 1568, tone: 'soft' },
      { at: 0.16, dur: 0.14, from: 1568, to: 2093, tone: 'soft', vibrato: { rate: 18, depth: 0.02 } },
    ],
  },
  wow: {
    description: 'A fast rising sparkle: excited',
    notes: [
      { at: 0, dur: 0.06, from: 784, tone: 'soft' },
      { at: 0.06, dur: 0.06, from: 988, tone: 'soft' },
      { at: 0.12, dur: 0.06, from: 1175, tone: 'soft' },
      { at: 0.18, dur: 0.26, from: 1568, to: 1760, tone: 'soft', vibrato: { rate: 14, depth: 0.025 } },
    ],
  },
  giggle: {
    description: 'A little bubbly laugh',
    notes: [0, 1, 2, 3, 4].map((i) => ({
      at: i * 0.09,
      dur: 0.06,
      from: i % 2 ? 1400 : 1200,
      to: i % 2 ? 1150 : 1500,
      gain: 1 - i * 0.12,
      tone: 'soft' as const,
      vibrato: { rate: 30, depth: 0.03 },
    })),
  },
  whoa: {
    description: 'A sliding whoa: surprised',
    notes: [
      { at: 0, dur: 0.28, from: 420, to: 1250, tone: 'soft', vibrato: { rate: 6, depth: 0.03 } },
      { at: 0.28, dur: 0.22, from: 1250, to: 950, tone: 'soft' },
    ],
  },
  aww: {
    description: 'A slow falling aww: sad',
    notes: [{ at: 0, dur: 0.6, from: 880, to: 330, vibrato: { rate: 5, depth: 0.025 }, release: 0.18 }],
  },
  coo: {
    description: 'A soft up-and-down coo: affection',
    notes: [
      { at: 0, dur: 0.35, from: 620, to: 760, vibrato: { rate: 6, depth: 0.02 } },
      { at: 0.38, dur: 0.45, from: 760, to: 560, vibrato: { rate: 5, depth: 0.03 }, release: 0.15 },
    ],
  },
  grumble: {
    description: 'A low growly grumble: cross',
    notes: [{ at: 0, dur: 0.45, from: 190, to: 160, tone: 'bright', fm: { ratio: 1.5, index: 2.5 }, vibrato: { rate: 9, depth: 0.06 }, gain: 0.8 }],
  },
  eep: {
    description: 'Two tiny high blips: scared',
    notes: [
      { at: 0, dur: 0.07, from: 1800, to: 2500 },
      { at: 0.1, dur: 0.06, from: 2100, to: 2600 },
    ],
  },
  yawn: {
    description: 'A long sinking yawn: sleepy',
    notes: [{ at: 0, dur: 0.9, from: 700, to: 280, tone: 'soft', vibrato: { rate: 4, depth: 0.03 }, attack: 0.15, release: 0.3, gain: 0.8 }],
  },
  hmm: {
    description: 'A curious rising hmm?',
    notes: [
      { at: 0, dur: 0.18, from: 480, to: 500, tone: 'soft', gain: 0.8 },
      { at: 0.2, dur: 0.28, from: 520, to: 700, tone: 'soft', vibrato: { rate: 6, depth: 0.02 } },
    ],
  },
  huh: {
    description: 'A questioning huh: confused',
    notes: [
      { at: 0, dur: 0.12, from: 600, to: 560, tone: 'soft' },
      { at: 0.16, dur: 0.3, from: 500, to: 820, tone: 'soft', vibrato: { rate: 7, depth: 0.03 } },
    ],
  },
  ponder: {
    description: 'A quiet thinking mmm',
    notes: [{ at: 0, dur: 0.5, from: 520, tone: 'soft', vibrato: { rate: 3, depth: 0.015 }, gain: 0.55, attack: 0.08, release: 0.15 }],
  },
  ding: {
    description: 'A bright bell: yes, done',
    notes: [{ at: 0, dur: 0.7, from: 1320, fm: { ratio: 3.5, index: 1.2 }, attack: 0.003, release: 0.55 }],
  },
  bonk: {
    description: 'A soft double bonk: no, oops',
    notes: [
      { at: 0, dur: 0.18, from: 330, to: 150, fm: { ratio: 1.4, index: 3 }, attack: 0.004 },
      { at: 0.2, dur: 0.22, from: 260, to: 120, fm: { ratio: 1.4, index: 3 }, attack: 0.004 },
    ],
  },
  hello: {
    description: 'A friendly hel-lo',
    notes: [
      { at: 0, dur: 0.14, from: 600, to: 900, tone: 'soft' },
      { at: 0.17, dur: 0.26, from: 820, to: 700, tone: 'soft', vibrato: { rate: 6, depth: 0.02 } },
    ],
  },
  bye: {
    description: 'A falling bye-bye',
    notes: [
      { at: 0, dur: 0.16, from: 900, to: 760, tone: 'soft' },
      { at: 0.2, dur: 0.32, from: 700, to: 420, tone: 'soft', vibrato: { rate: 5, depth: 0.025 }, release: 0.12 },
    ],
  },
  bloop: {
    description: 'A water-drop bloop: I heard you',
    notes: [
      { at: 0, dur: 0.12, from: 1250, to: 620, attack: 0.002 },
      { at: 0.13, dur: 0.12, from: 900, to: 1400 },
    ],
  },
  fanfare: {
    description: 'A tiny fanfare: celebration',
    notes: [
      { at: 0, dur: 0.1, from: C5, tone: 'bright', gain: 0.7 },
      { at: 0.11, dur: 0.1, from: E5, tone: 'bright', gain: 0.7 },
      { at: 0.22, dur: 0.1, from: G5, tone: 'bright', gain: 0.7 },
      { at: 0.33, dur: 0.45, from: C6, tone: 'bright', vibrato: { rate: 6, depth: 0.015 }, gain: 0.8, release: 0.2 },
    ],
  },
  click: {
    description: 'A tiny click: a wink',
    notes: [{ at: 0, dur: 0.03, from: 3000, to: 2400, attack: 0.001, release: 0.02, gain: 0.6 }],
  },
  sigh: {
    description: 'A breath in and a long breath out',
    notes: [
      { at: 0, dur: 0.4, from: 500, to: 620, tone: 'soft', gain: 0.45, attack: 0.12 },
      { at: 0.45, dur: 0.8, from: 620, to: 300, tone: 'soft', gain: 0.55, release: 0.3 },
    ],
  },
} as const satisfies Record<string, SoundSpec>;

export type SoundName = keyof typeof SOUNDS;
export const SOUND_NAMES = Object.keys(SOUNDS) as SoundName[];

export function isSoundName(name: string): name is SoundName {
  return Object.hasOwn(SOUNDS, name);
}

export function describeSound(name: SoundName): string {
  return SOUNDS[name].description;
}

/** Plays sounds; the simulator and the robot each provide one. */
export interface SoundPlayer {
  play(name: SoundName): void;
}

export const SOUND_SAMPLE_RATE = 22050;
/** Loudest sample after rendering (headroom for small speakers). */
const PEAK = 0.7;

/** Renders a sound to mono samples in −1…1 at SOUND_SAMPLE_RATE (or the rate given). */
export function renderSound(name: SoundName, sampleRate = SOUND_SAMPLE_RATE): Float32Array<ArrayBuffer> {
  const spec: SoundSpec = SOUNDS[name];
  const end = Math.max(...spec.notes.map((n) => n.at + n.dur));
  const out = new Float32Array(Math.ceil(end * sampleRate) + 1);
  for (const note of spec.notes) renderNote(note, out, sampleRate);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i]! * PEAK) / peak;
  return out;
}

function renderNote(note: Note, out: Float32Array, sampleRate: number): void {
  const start = Math.round(note.at * sampleRate);
  const count = Math.round(note.dur * sampleRate);
  const attack = Math.max(1 / sampleRate, note.attack ?? 0.008);
  const release = Math.max(1 / sampleRate, Math.min(note.dur / 2, note.release ?? 0.04));
  const to = note.to ?? note.from;
  const gain = note.gain ?? 1;
  let phase = 0;
  let modPhase = 0;
  for (let i = 0; i < count && start + i < out.length; i++) {
    const t = i / sampleRate;
    const u = count > 1 ? i / (count - 1) : 0;
    let f = note.from * (to / note.from) ** u;
    if (note.vibrato) f *= 1 + note.vibrato.depth * Math.sin(2 * Math.PI * note.vibrato.rate * t);
    phase += (2 * Math.PI * f) / sampleRate;
    let carrier = phase;
    if (note.fm) {
      modPhase += (2 * Math.PI * f * note.fm.ratio) / sampleRate;
      carrier += note.fm.index * Math.sin(modPhase);
    }
    const s = Math.sin(carrier);
    const wave =
      note.tone === 'bright'
        ? s + 0.5 * Math.sin(2 * carrier) + 0.33 * Math.sin(3 * carrier) + 0.2 * Math.sin(4 * carrier)
        : note.tone === 'soft'
          ? s + 0.25 * Math.sin(2 * carrier) + 0.08 * Math.sin(3 * carrier)
          : s;
    const envelope = Math.min(1, t / attack) * Math.min(1, (note.dur - t) / release);
    out[start + i]! += gain * Math.max(0, envelope) * wave;
  }
}
