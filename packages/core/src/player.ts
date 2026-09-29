import type { Pose } from './kinematics.ts';

export interface PoseTrack {
  readonly name: string;
  readonly frameMs: number;
  readonly poses: readonly Pose[];
}

/**
 * Plays a pose track in real time, one frame per frameMs with no interpolation (as the 2019 player did).
 * It only produces targets; the governor decides what actually moves.
 */
export class PoseTrackPlayer {
  readonly track: PoseTrack;
  readonly startMs: number;

  constructor(track: PoseTrack, startMs: number) {
    if (!(track.frameMs > 0) || track.poses.length === 0) {
      throw new Error(`Pose track "${track.name}" needs frames and a positive frame time`);
    }
    this.track = track;
    this.startMs = startMs;
  }

  get durationMs(): number {
    return this.track.poses.length * this.track.frameMs;
  }

  /** Target pose at nowMs, or null once the track has finished. */
  poseAt(nowMs: number): Pose | null {
    const index = Math.floor((nowMs - this.startMs) / this.track.frameMs);
    if (index >= this.track.poses.length) return null;
    return this.track.poses[Math.max(0, index)] ?? null;
  }
}
