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
const responseMediaFiles = import.meta.glob<string>('../../../electron/app/media/responses/*/*.{mp4,gif,png,jpg,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** Local media for each 2019 response folder (responses/<folder>/…), as URLs. */
function responseMedia(folder: string): readonly string[] {
  return Object.entries(responseMediaFiles)
    .filter(([file]) => file.split('/').at(-2) === folder)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, url]) => url);
}

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
  /** The reaction's local GIFs, videos and pictures (one is shown at random). */
  readonly media: readonly string[];
}

/**
 * The 2019 reactions from electron/app/js/responses/responses.js: head motion, LEDs, sound and their local media
 * (the online searches they also made are left out).
 */
export const LEGACY_REACTIONS: readonly LegacyReaction[] = [
  { name: 'wakeword', servo: 'alert', led: { animation: 'circle', color: 'aqua' }, sound: 'alert', media: [] },
  { name: 'greeting', servo: 'look-up', led: { animation: 'blink', color: 'green' }, sound: null, media: responseMedia('greeting') },
  { name: 'ok', servo: 'look-up', led: { animation: 'blink', color: 'green' }, sound: null, media: responseMedia('ok') },
  { name: 'bye', servo: 'look-up-slow', led: { animation: 'blink', color: 'blue' }, sound: null, media: responseMedia('bye') },
  { name: 'confused', servo: null, led: { animation: 'blink', color: 'orange' }, sound: null, media: responseMedia('confused') },
  { name: 'alarm', servo: 'jiggle', led: { animation: 'blink', color: 'yellow' }, sound: null, media: responseMedia('alarm') },
];
