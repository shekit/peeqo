import './styles.css';
import {
  ClassicLeds,
  DEFAULT_SAFETY_LIMITS,
  DEV_KIT_CLEARANCE,
  DotstarStrip,
  MotionGovernor,
  DEV_KIT_GEOMETRY,
  PoseTrackPlayer,
  VirtualScheduler,
  aroundNeutral,
  checkPose,
  clampToSafe,
  solveIk,
  type ClassicLedAnimation,
  type ClassicLedColor,
  type GovernorOutput,
  type Pose,
} from '@peeqo/core';
import { CLASSIC_GLASSES_CYCLE, ClassicFace, FACE_HEIGHT, FACE_WIDTH } from '@peeqo/face';
import { GLASSES_URLS, LEGACY_REACTIONS, LEGACY_TRACKS, SOUND_URLS } from './content.ts';
import { createCollisionProbe } from './scene/collisionProbe.ts';
import { createRobot } from './scene/robot.ts';
import { createStage, type ViewName } from './scene/stage.ts';
import { createPanel } from './ui/panel.ts';

/** The governor runs at a fixed 100 Hz, independent of the display frame rate. */
const STEP_S = 0.01;
const MAX_STEPS_PER_FRAME = 10;

declare global {
  interface Window {
    /** Hooks for scripts/verify.mjs and for poking at the sim from the console. */
    __peeqo?: unknown;
    __ready?: boolean;
  }
}

function isClamped(out: GovernorOutput): boolean {
  return (
    Math.abs(out.requested.pitchDeg - out.goal.pitchDeg) > 1e-6 ||
    Math.abs(out.requested.rollDeg - out.goal.rollDeg) > 1e-6 ||
    Math.abs(out.requested.heaveMm - out.goal.heaveMm) > 1e-6
  );
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

async function main(): Promise<void> {
  const canvas = document.querySelector('#scene');
  const panelHost = document.querySelector('#panel');
  if (!(canvas instanceof HTMLCanvasElement) || !(panelHost instanceof HTMLElement)) throw new Error('Page is missing #scene or #panel');

  const stage = createStage(canvas);
  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = FACE_WIDTH;
  faceCanvas.height = FACE_HEIGHT;
  const faceContext = faceCanvas.getContext('2d');
  if (!faceContext) throw new Error('Canvas 2D is not available');
  const robot = await createRobot(DEV_KIT_GEOMETRY, faceCanvas);
  stage.scene.add(robot.root);

  const glasses = new Map(await Promise.all([...GLASSES_URLS].map(async ([name, url]) => [name, await loadImage(url)] as const)));
  const face = new ClassicFace();
  const initialGlasses = glasses.has(CLASSIC_GLASSES_CYCLE[0]) ? CLASSIC_GLASSES_CYCLE[0] : null;
  face.setGlasses(initialGlasses ? (glasses.get(initialGlasses) ?? null) : null);
  face.startBlinking(performance.now());

  // Starts at the dev kit's neutral pose (level, at the height with the most room to move) and checks every
  // commanded pose against the CAD collision tables.
  const governor = new MotionGovernor(DEV_KIT_GEOMETRY, DEFAULT_SAFETY_LIMITS, null, DEV_KIT_CLEARANCE);
  const neutral = governor.neutral;
  const probe = createCollisionProbe(robot.bodies);
  const strip = new DotstarStrip(12);
  const timers = new VirtualScheduler(performance.now());
  const leds = new ClassicLeds(strip, timers);
  const sounds = { alert: new Audio(SOUND_URLS.alert) };

  let player: PoseTrackPlayer | null = null;
  let showRequested = true;

  const setTarget = (pose: Pose): void => {
    player = null;
    governor.setTarget(pose);
    panel.showTarget(pose);
  };
  const playAnimation = (name: string): void => {
    const track = LEGACY_TRACKS.get(name);
    if (!track) throw new Error(`Unknown animation "${name}"`);
    // The 2019 animations are motions around level; play them around the neutral pose.
    player = new PoseTrackPlayer({ ...track, poses: aroundNeutral(track.poses, neutral) }, performance.now());
  };
  const playLeds = (animation: ClassicLedAnimation, color: ClassicLedColor): void => leds.play(animation, color);
  const playSound = (name: keyof typeof sounds): void => {
    const audio = sounds[name];
    audio.currentTime = 0;
    audio.volume = 0.4; // the 2019 app's volume
    audio.play().catch((error: unknown) => console.info(`Sound "${name}" not played: ${String(error)}`));
  };
  const react = (name: string): void => {
    const reaction = LEGACY_REACTIONS.find((r) => r.name === name);
    if (!reaction) throw new Error(`Unknown reaction "${name}"`);
    if (reaction.sound) playSound(reaction.sound);
    playLeds(reaction.led.animation, reaction.led.color);
    if (reaction.servo) playAnimation(reaction.servo);
  };

  const panel = createPanel(
    panelHost,
    {
      geometry: DEV_KIT_GEOMETRY,
      limits: DEFAULT_SAFETY_LIMITS,
      animations: [...LEGACY_TRACKS.keys()],
      reactions: LEGACY_REACTIONS.map((r) => r.name),
      glasses: [...glasses.keys()],
      initialGlasses,
      neutral,
    },
    {
      onTarget: setTarget,
      onAnimation: playAnimation,
      onReaction: react,
      onLeds: playLeds,
      onGlasses: (name) => face.setGlasses(name ? (glasses.get(name) ?? null) : null),
      onBlink: () => face.blink(performance.now()),
      onView: (name) => stage.setView(name),
      onShowRequested: (show) => {
        showRequested = show;
      },
    },
  );

  window.__peeqo = {
    state: () => ({
      output: governor.output,
      playing: player?.track.name ?? null,
      litLeds: strip.shown.flatMap((p, i) => (p.brightness > 0 && (p.r || p.g || p.b) ? [i] : [])),
      eyes: face.eyeRadii,
    }),
    /** Largest gap (mm) between the drawn horn tips and the kinematics, to prove the model matches the maths. */
    hornTipError: () => {
      const ik = solveIk(governor.output.pose, DEV_KIT_GEOMETRY);
      return Math.max(
        ...robot.drawnHornTips().map((tip, i) => {
          const leg = ik.legs[i as 0 | 1 | 2];
          return Math.hypot(tip[0] - leg.hornTip[0], tip[1] - leg.hornTip[1], tip[2] - leg.hornTip[2]);
        }),
      );
    },
    /** Largest gap (mm) between the drawn leg tops and the ball joints; the legs stay in their pin plane, so this shows the kinematic model's small sideways error. */
    legTopError: () => {
      const ik = solveIk(governor.output.pose, DEV_KIT_GEOMETRY);
      return Math.max(
        ...robot.drawnLegTops().map((top, i) => {
          const joint = ik.legs[i as 0 | 1 | 2].platformJoint;
          return Math.hypot(top[0] - joint[0], top[1] - joint[1], top[2] - joint[2]);
        }),
      );
    },
    /** The safe edge the governor should stop at for a target (for checks). */
    safeEdge: (target: Pose) => clampToSafe(target, neutral, DEV_KIT_GEOMETRY, DEFAULT_SAFETY_LIMITS, DEV_KIT_CLEARANCE).pose,
    neutral: () => neutral,
    /** Guaranteed clearance from the collision tables at the commanded pose. */
    tableClearance: () => checkPose(governor.output.pose, DEV_KIT_GEOMETRY, DEFAULT_SAFETY_LIMITS, DEV_KIT_CLEARANCE).clearance,
    /** Smallest clearance among the pairs verified once over every admitted pose (they have no per-pose table). */
    verifiedClearance: () => Math.min(...Object.values(DEV_KIT_CLEARANCE.verifiedMm)),
    /** Measured mesh-to-mesh gaps at the drawn pose (independent of the tables; slow). */
    probeCollisions: () => probe.measure(),
    setTarget,
    playAnimation,
    playLeds,
    react,
    setView: (name: ViewName) => stage.setView(name),
  };

  let last = performance.now();
  let accumulator = 0;
  let ledVersion = -1;
  let first = true;
  const frame = (now: number): void => {
    accumulator += Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;

    if (player) {
      const target = player.poseAt(now);
      if (target) {
        governor.setTarget(target);
        panel.showTarget(target);
      } else {
        player = null;
        governor.setTarget(neutral);
        panel.showTarget(neutral);
      }
    }
    let steps = 0;
    while (accumulator >= STEP_S && steps < MAX_STEPS_PER_FRAME) {
      governor.step(STEP_S);
      accumulator -= STEP_S;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // fell behind; do not try to catch up in a burst

    const out = governor.output;
    robot.update(out.pose);
    robot.setRequested(showRequested && isClamped(out) ? out.requested : null);
    timers.advanceTo(now);
    if (strip.version !== ledVersion) {
      robot.setLeds(strip.shown);
      ledVersion = strip.version;
    }
    if (face.update(now)) {
      face.draw(faceContext);
      robot.faceTexture.needsUpdate = true;
    }
    panel.update(out, player?.track.name ?? null, checkPose(out.pose, DEV_KIT_GEOMETRY, DEFAULT_SAFETY_LIMITS, DEV_KIT_CLEARANCE).clearance);
    stage.render();

    if (first) {
      first = false;
      document.querySelector('#loading')?.classList.add('hidden');
      window.__ready = true;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((error: unknown) => {
  console.error(error);
  const loading = document.querySelector('#loading');
  if (loading) {
    loading.classList.add('error');
    loading.textContent = `The simulator failed to start:\n${error instanceof Error ? error.message : String(error)}`;
  }
});
