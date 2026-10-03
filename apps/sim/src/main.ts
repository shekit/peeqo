import './styles.css';
import {
  ClassicLeds,
  DEFAULT_SAFETY_LIMITS,
  DEV_KIT_CLEARANCE,
  DotstarStrip,
  HEAD_ANIMATIONS,
  HEAD_ANIMATION_NAMES,
  HeadAnimator,
  LED_COLORS,
  LED_PATTERN_NAMES,
  LedAnimator,
  MotionGovernor,
  DEV_KIT_GEOMETRY,
  PoseTrackPlayer,
  VirtualScheduler,
  aroundNeutral,
  checkPose,
  clampToSafe,
  isHeadAnimationName,
  isLedColorName,
  isLedPatternName,
  describeLedPattern,
  solveIk,
  type ClassicLedAnimation,
  type ClassicLedColor,
  type GovernorOutput,
  type Pose,
} from '@peeqo/core';
import { CHARACTER_STATES, Character, EXPRESSION_NAMES, expressionSpec, isCharacterState, isExpressionName } from '@peeqo/character';
import { CLASSIC_GLASSES_CYCLE, ClassicFace, EMOTIONS, ExpressiveFace, FACE_HEIGHT, FACE_WIDTH, isEmotion } from '@peeqo/face';
import { WebSoundPlayer } from './audio/webSound.ts';
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

  // URL options: ?idle=0 starts with the alive layer off, ?face=classic with the 2019 eyes.
  const params = new URLSearchParams(window.location.search);
  const stage = createStage(canvas);
  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = FACE_WIDTH;
  faceCanvas.height = FACE_HEIGHT;
  const faceContext = faceCanvas.getContext('2d');
  if (!faceContext) throw new Error('Canvas 2D is not available');
  const robot = await createRobot(DEV_KIT_GEOMETRY, faceCanvas);
  stage.scene.add(robot.root);

  const glasses = new Map(await Promise.all([...GLASSES_URLS].map(async ([name, url]) => [name, await loadImage(url)] as const)));
  // The expressive eyes by default; the 2019 eyes stay available for comparison. Glasses fit both.
  const expressive = new ExpressiveFace({ seed: (Math.random() * 2 ** 32) >>> 0 });
  const classic = new ClassicFace();
  let faceStyle: 'expressive' | 'classic' = params.get('face') === 'classic' ? 'classic' : 'expressive';
  const face = (): ExpressiveFace | ClassicFace => (faceStyle === 'expressive' ? expressive : classic);
  const initialGlasses = glasses.has(CLASSIC_GLASSES_CYCLE[0]) ? CLASSIC_GLASSES_CYCLE[0] : null;
  const setGlasses = (name: string | null): void => {
    const image = name ? (glasses.get(name) ?? null) : null;
    expressive.setGlasses(image);
    classic.setGlasses(image);
  };
  setGlasses(initialGlasses);
  classic.startBlinking(performance.now());
  const setEmotion = (name: string, intensity = 1): void => {
    if (!isEmotion(name)) throw new Error(`Unknown emotion "${name}"`);
    expressive.setEmotion(name, intensity);
  };

  // Starts at the dev kit's neutral pose (level, at the height with the most room to move) and checks every
  // commanded pose against the CAD collision tables.
  const governor = new MotionGovernor(DEV_KIT_GEOMETRY, DEFAULT_SAFETY_LIMITS, null, DEV_KIT_CLEARANCE);
  const neutral = governor.neutral;
  // Head motion comes from one of three places: the animator (gestures over the idle layer; the default), the
  // sliders (manual), or a 2019 animation track (legacy). The animator takes over again from wherever the head is.
  const animator = new HeadAnimator(neutral, { seed: (Math.random() * 2 ** 32) >>> 0, idle: params.get('idle') !== '0' });
  let mode: 'animator' | 'manual' | 'legacy' = 'animator';
  const toAnimator = (): void => {
    if (mode !== 'animator') animator.resetFrom(governor.output.pose);
    mode = 'animator';
  };
  const probe = createCollisionProbe(robot.bodies);
  const strip = new DotstarStrip(12);
  const timers = new VirtualScheduler(performance.now());
  const leds = new ClassicLeds(strip, timers);
  // The new LED patterns and the 2019 animations share the strip; whichever was started last drives it.
  const ledAnimator = new LedAnimator(strip, { seed: (Math.random() * 2 ** 32) >>> 0 });
  // Peeqo as a character: states and expressions that move the head, eyes, ring and voice together.
  const voice = new WebSoundPlayer();
  const character = new Character({ head: animator, face: expressive, leds: ledAnimator, sound: voice });
  const sounds = { alert: new Audio(SOUND_URLS.alert) };

  let player: PoseTrackPlayer | null = null;
  let showRequested = true;

  const setTarget = (pose: Pose): void => {
    player = null;
    mode = 'manual';
    governor.setTarget(pose);
    panel.showTarget(pose);
  };
  const goNeutral = (): void => {
    player = null;
    toAnimator();
    animator.stop();
  };
  const playAnimation = (name: string): void => {
    const track = LEGACY_TRACKS.get(name);
    if (!track) throw new Error(`Unknown animation "${name}"`);
    // The 2019 animations are motions around level; play them around the neutral pose.
    player = new PoseTrackPlayer({ ...track, poses: aroundNeutral(track.poses, neutral) }, performance.now());
    mode = 'legacy';
  };
  const express = (name: string): void => {
    if (!isExpressionName(name)) throw new Error(`Unknown expression "${name}"`);
    player = null;
    toAnimator();
    faceStyle = 'expressive';
    character.express(name);
  };
  const setCharacterState = (state: string): void => {
    if (!isCharacterState(state)) throw new Error(`Unknown state "${state}"`);
    player = null;
    toAnimator();
    character.setState(state);
  };
  const playHead = (name: string): void => {
    if (!isHeadAnimationName(name)) throw new Error(`Unknown head animation "${name}"`);
    player = null;
    toAnimator();
    animator.play(name);
  };
  const playLeds = (animation: ClassicLedAnimation, color: ClassicLedColor): void => {
    ledAnimator.stop();
    leds.play(animation, color);
  };
  const playLedPattern = (name: string, color?: string): void => {
    if (!isLedPatternName(name)) throw new Error(`Unknown LED pattern "${name}"`);
    if (color !== undefined && !isLedColorName(color)) throw new Error(`Unknown LED colour "${color}"`);
    timers.clearAll(); // stops any 2019 animation still running
    ledAnimator.play(name, color === undefined ? {} : { color });
  };
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
      headAnimations: HEAD_ANIMATION_NAMES.map((name) => ({ name, description: HEAD_ANIMATIONS.get(name)!.description })),
      idle: animator.idle,
      emotions: EMOTIONS,
      faceStyle,
      ledPatterns: LED_PATTERN_NAMES.map((name) => ({ name, description: describeLedPattern(name) })),
      expressions: EXPRESSION_NAMES.map((name) => ({ name, description: expressionSpec(name).description })),
      states: CHARACTER_STATES,
      ledColors: Object.keys(LED_COLORS),
    },
    {
      onTarget: setTarget,
      onNeutral: goNeutral,
      onHeadAnimation: playHead,
      onIdle: (on) => animator.setIdle(on),
      onEnergy: (energy) => animator.setEnergy(energy),
      onAnimation: playAnimation,
      onReaction: react,
      onLeds: playLeds,
      onLedPattern: playLedPattern,
      onExpression: express,
      onState: setCharacterState,
      onMute: (muted) => {
        voice.muted = muted;
      },
      onGlasses: setGlasses,
      onBlink: () => face().blink(performance.now()),
      onFaceStyle: (style) => {
        faceStyle = style;
      },
      onEmotion: (name) => setEmotion(name),
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
      mode,
      gesture: animator.playing,
      idle: animator.idle,
      litLeds: strip.shown.flatMap((p, i) => (p.brightness > 0 && (p.r || p.g || p.b) ? [i] : [])),
      faceStyle,
      eyes: faceStyle === 'classic' ? classic.eyeRadii : expressive.state().eyes[0],
      emotion: expressive.emotion,
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
    goNeutral,
    playAnimation,
    playHead,
    headAnimations: () => HEAD_ANIMATION_NAMES.map((name) => ({ name, durationS: HEAD_ANIMATIONS.get(name)!.duration })),
    setIdle: (on: boolean) => animator.setIdle(on),
    setEnergy: (energy: number) => animator.setEnergy(energy),
    setEmotion,
    /** The face as drawn right now, as a PNG data URL. */
    faceImage: () => faceCanvas.toDataURL('image/png'),
    lookAt: (target: [number, number] | null) => expressive.lookAt(target),
    setFaceStyle: (style: 'expressive' | 'classic') => {
      faceStyle = style;
    },
    playLeds,
    playLedPattern,
    ledPattern: () => (ledAnimator.active ? ledAnimator.pattern : null),
    express,
    setCharacterState,
    character: () => ({ state: character.state, expression: character.expression }),
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

    if (mode === 'legacy' && player) {
      const target = player.poseAt(now);
      if (target) {
        governor.setTarget(target);
        panel.showTarget(target);
      } else {
        player = null;
        toAnimator();
      }
    }
    let steps = 0;
    while (accumulator >= STEP_S && steps < MAX_STEPS_PER_FRAME) {
      if (mode === 'animator') governor.setTarget(animator.update(STEP_S));
      governor.step(STEP_S);
      accumulator -= STEP_S;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // fell behind; do not try to catch up in a burst
    if (mode === 'animator') panel.showTarget(animator.pose);

    const out = governor.output;
    robot.update(out.pose);
    robot.setRequested(showRequested && isClamped(out) ? out.requested : null);
    timers.advanceTo(now);
    character.update(now);
    ledAnimator.update(now);
    if (strip.version !== ledVersion) {
      robot.setLeds(strip.shown);
      ledVersion = strip.version;
    }
    if (face().update(now)) {
      face().draw(faceContext);
      robot.faceTexture.needsUpdate = true;
    }
    panel.update(out, player?.track.name ?? null, checkPose(out.pose, DEV_KIT_GEOMETRY, DEFAULT_SAFETY_LIMITS, DEV_KIT_CLEARANCE).clearance, animator.playing, character.expression, character.state);
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
