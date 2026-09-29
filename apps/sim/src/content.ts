import { LEGACY_FRAME_MS, legacyAnimationToPoses, parseLegacyAnimation, type ClassicLedAnimation, type ClassicLedColor, type PoseTrack } from '@peeqo/core';
import alertSoundUrl from '../../../electron/app/media/sounds/alert.wav?url';

// 2019 content is read in place from the original app, so there is one copy of it.
const servoAnimationFiles = import.meta.glob<unknown>('../../../electron/app/media/servo_anims/*.json', {
  eager: true,
  import: 'default',
});
const glassesFiles = import.meta.glob<string>('../../../electron/app/media/imgs/glasses/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
const byName = <T>(entries: [string, T][]): [string, T][] => entries.sort(([a], [b]) => a.localeCompare(b));

/** The 2019 servo animations, converted to head poses (one per 33 ms frame). */
export const LEGACY_TRACKS: ReadonlyMap<string, PoseTrack> = new Map(
  byName(
    Object.entries(servoAnimationFiles).map(([file, json]): [string, PoseTrack] => {
      const name = baseName(file);
      const poses = legacyAnimationToPoses(parseLegacyAnimation(json, name), undefined, name);
      return [name, { name, frameMs: LEGACY_FRAME_MS, poses }];
    }),
  ),
);

/** Glasses overlays (800×480 PNGs) by file name. */
export const GLASSES_URLS: ReadonlyMap<string, string> = new Map(
  byName(Object.entries(glassesFiles).map(([file, url]): [string, string] => [baseName(file), url])),
);

export const SOUND_URLS = { alert: alertSoundUrl } as const;

export interface LegacyReaction {
  readonly name: string;
  readonly servo: string | null;
  readonly led: { readonly animation: ClassicLedAnimation; readonly color: ClassicLedColor };
  readonly sound: keyof typeof SOUND_URLS | null;
}

/**
 * The 2019 reactions from electron/app/js/responses/responses.js: head motion, LEDs and sound.
 * Their GIF/video media is not played yet.
 */
export const LEGACY_REACTIONS: readonly LegacyReaction[] = [
  { name: 'wakeword', servo: 'alert', led: { animation: 'circle', color: 'aqua' }, sound: 'alert' },
  { name: 'greeting', servo: 'look-up', led: { animation: 'blink', color: 'green' }, sound: null },
  { name: 'ok', servo: 'look-up', led: { animation: 'blink', color: 'green' }, sound: null },
  { name: 'bye', servo: 'look-up-slow', led: { animation: 'blink', color: 'blue' }, sound: null },
  { name: 'confused', servo: null, led: { animation: 'blink', color: 'orange' }, sound: null },
  { name: 'alarm', servo: 'jiggle', led: { animation: 'blink', color: 'yellow' }, sound: null },
];
