import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  Alarms,
  Brain,
  KlipyClient,
  Memory,
  OpenRouterModel,
  ScriptedModel,
  Weather,
  alarmTools,
  clockTool,
  weatherTool,
  type Alarm,
  type CachedSearch,
  type ChatModel,
  type SavedConversation,
} from '@peeqo/brain';
import { Character, Life } from '@peeqo/character';
import { DEFAULT_SAFETY_LIMITS, DotstarStrip, HeadAnimator, LedAnimator, MotionGovernor, findNeutralPose, type SafetyLimits } from '@peeqo/core';
import { WakeWordDetector, wakeWordReady } from '@peeqo/wakeword';
import { MIC_CHUNK, Microphone } from './audio/microphone.ts';
import { PREROLL_CHUNKS, UtteranceRecorder, WAKE_PREROLL_CHUNKS } from './audio/recorder.ts';
import { Speaker } from './audio/speaker.ts';
import { ButtonGestures } from './buttons.ts';
import { ConfigStore, readFileOrNull, writeFileSafely } from './config.ts';
import { MirroredFace, type FaceScreen } from './face/mirroredFace.ts';
import { RobotBody } from './face/robotBody.ts';
import { apa102Frame } from './hardware/apa102.ts';
import { HORN_RANGE_DEG } from './hardware/calibration.ts';
import { HardwareLink, type HardwareOutputs, type HardwareStatus } from './hardware/link.ts';
import { ServoOutput, type ServoState } from './hardware/servoOutput.ts';

/**
 * The real robot's limits: the simulator's, keeping more room at the edges for calibration error (arms levelled by
 * eye are good to a few degrees). No horn goes below 5° (the CAD tables already keep them off their servo holders,
 * which they near at about +1°) or above 55° (the neck's top is near 65°), and the head stays between 1 and 5.4 mm
 * (it reaches 0.1–6.2 mm). Gestures stay within 70% of the neck's range, so they are hardly touched by this.
 */
export const ROBOT_LIMITS: SafetyLimits = Object.freeze({ ...DEFAULT_SAFETY_LIMITS, hornMinDeg: HORN_RANGE_DEG[0], hornMaxDeg: HORN_RANGE_DEG[1], minHeaveMm: 1, maxHeaveMm: 5.4 });
/** The simulator's neutral pose (level, 3.2 mm up: the most room to move), which gestures are designed around. */
const NEUTRAL = findNeutralPose();

const STEP_S = 0.01;
const MAX_STEPS_PER_TICK = 10;
const TRANSCRIPT_LINES = 100;
const LOG_LINES = 300;

export interface RobotOptions {
  /** Where config, memory, the conversation and timers are kept (~/.peeqo). */
  readonly dataDir: string;
  /** No hardware (a laptop): the helper pretends, there is no microphone or speaker. */
  readonly fake: boolean;
  /** The folder holding python/hardware.py (and, beside it, the wake word detector's script). */
  readonly appDir: string;
  /** openWakeWord's Python and script (default: the @peeqo/wakeword package's own environment). */
  readonly wakeWord?: { readonly python: string; readonly script: string } | null;
  readonly micDevice?: string | null;
  readonly speakerDevice?: string | null;
  /** Run a command as root (shutdown); default sudo. Replaced in tests. */
  readonly system?: (command: readonly string[]) => Promise<void>;
  readonly log?: (line: string) => void;
}

export interface TranscriptLine {
  readonly at: number;
  readonly who: 'you' | 'peeqo' | 'note';
  readonly text: string;
}

export interface RobotState {
  readonly name: string;
  readonly character: { readonly state: string; readonly expression: string | null };
  readonly brain: { readonly model: string; readonly live: boolean; readonly gifs: boolean; readonly voice: boolean };
  readonly hardware: HardwareStatus | null;
  readonly servos: ServoState;
  readonly motion: { readonly status: string; readonly notes: readonly string[]; readonly pose: { pitchDeg: number; rollDeg: number; heaveMm: number } };
  readonly listening: { readonly wakeWord: boolean; readonly microphone: boolean; readonly recording: boolean };
  readonly memory: readonly string[];
  readonly timers: readonly { readonly id: string; readonly kind: string; readonly label: string; readonly inMs: number }[];
  readonly screens: number;
}

/** Saved by HardwareLink until it starts; the servo output and LEDs can be given commands before then. */
class QueuedOutputs implements HardwareOutputs {
  link: HardwareLink | null = null;
  servos(pulsesUs: readonly number[]): void {
    this.link?.servos(pulsesUs);
  }
  leds(frame: Uint8Array): void {
    this.link?.leds(frame);
  }
}

/**
 * Peeqo on the robot: the same brain, character, animation and safety governor as the simulator, driving the real
 * servos (through ServoOutput, only once calibrated), the LED ring, the face screen (MirroredFace, shown by the face
 * page), the speaker and the microphone (wake word, then the recording goes to the model as it is). The web server
 * (web/server.ts) shows it on the panel and lets people talk to it; setup and calibration hang off it too.
 */
export class Robot {
  readonly options: RobotOptions;
  readonly config: ConfigStore;
  readonly face: MirroredFace;
  readonly governor: MotionGovernor;
  readonly animator: HeadAnimator;
  readonly strip = new DotstarStrip(12);
  readonly leds: LedAnimator;
  readonly speaker: Speaker;
  readonly character: Character;
  readonly life: Life;
  readonly body: RobotBody;
  readonly memory: Memory;
  readonly alarms: Alarms;
  readonly brain: Brain;
  readonly servos: ServoOutput;
  readonly buttons: ButtonGestures;
  readonly recorder: UtteranceRecorder;
  /** While true, the calibration tool drives the servos and the governor's poses are not sent. */
  calibrating = false;
  #outputs = new QueuedOutputs();
  #link: HardwareLink | null = null;
  #hardware: HardwareStatus | null = null;
  #mic: Microphone | null = null;
  #wakeWord: WakeWordDetector | null = null;
  #speech: number | null = null;
  #offline = new ScriptedModel({ delayMs: 300 });
  #live: ChatModel | null = null;
  #transcript: TranscriptLine[] = [];
  #logs: string[] = [];
  readonly #transcriptListeners = new Set<(line: TranscriptLine) => void>();
  readonly #logListeners = new Set<(line: string) => void>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #last = 0;
  #accumulator = 0;
  #ledVersion = -1;
  #lastAlarmCheck = 0;
  #stopping = false;

  constructor(options: RobotOptions) {
    this.options = options;
    this.config = new ConfigStore(options.dataDir);
    const paths = this.config.paths;
    const seed = () => (Math.random() * 2 ** 32) >>> 0;
    this.face = new MirroredFace({ seed: seed() });
    this.governor = new MotionGovernor(undefined, ROBOT_LIMITS, NEUTRAL);
    this.animator = new HeadAnimator(this.governor.neutral, { seed: seed() });
    this.leds = new LedAnimator(this.strip, { seed: seed() });
    this.speaker = new Speaker({ fake: options.fake, device: options.speakerDevice ?? null });
    this.character = new Character({ head: this.animator, face: this.face, leds: this.leds, sound: this.speaker });
    this.life = new Life(this.character, { seed: seed() });
    this.body = new RobotBody({ character: this.character, face: this.face, now: () => performance.now(), caption: (text) => this.#line('peeqo', text) });
    this.servos = new ServoOutput(this.#outputs, this.config.config.calibration);

    this.memory = new Memory({
      store: { load: () => readFileOrNull(paths.memory), save: (markdown) => writeFileSafely(paths.memory, markdown) },
      onError: (error) => this.log(`memory could not be saved: ${String(error)}`),
    });
    this.alarms = new Alarms({
      store: {
        load: () => {
          try {
            return JSON.parse(readFileOrNull(paths.alarms) ?? 'null') as Alarm[] | null;
          } catch {
            return null;
          }
        },
        save: (list) => writeFileSafely(paths.alarms, JSON.stringify(list)),
      },
      onDue: (alarm) => {
        this.poke();
        void this.brain.announce(alarm.kind === 'timer' ? `Ding! Your ${alarm.label} is done!` : `Reminder: ${alarm.label}!`, {
          gif: alarm.kind === 'timer' ? 'times up' : 'dont forget',
        });
      },
    });
    this.brain = new Brain({
      model: this.#offline,
      body: this.body,
      voice: this.config.config.voice,
      memory: this.memory,
      conversation: {
        load: () => {
          try {
            return JSON.parse(readFileOrNull(paths.conversation) ?? 'null') as SavedConversation | null;
          } catch {
            return null;
          }
        },
        save: (conversation) => writeFileSafely(paths.conversation, JSON.stringify(conversation)),
      },
      tools: [clockTool, ...alarmTools(this.alarms), weatherTool(new Weather())],
      onEvent: (event) => {
        if (event.type === 'understood') this.#line('you', `${event.text} (spoken)`);
        if (event.type === 'error') this.#line('note', event.message);
        if (event.type === 'tool' && event.name !== 'respond') this.#line('note', `${event.name}: ${event.result.slice(0, 160)}`);
        if (event.type === 'reply') this.log(`reply from ${event.model} in ${(event.ms / 1000).toFixed(1)} s`);
      },
    });
    this.applySettings();

    this.recorder = new UtteranceRecorder({
      onUtterance: (wav) => {
        this.poke();
        if (this.brain.modelName === this.#offline.name) this.#line('note', 'The offline brain cannot understand speech; add an OpenRouter key.');
        void this.brain.hear({ audio: wav });
      },
      onNothing: () => this.brain.dismiss(),
    });
    this.buttons = new ButtonGestures({
      tap: () => this.listen(),
      medium: () => this.onShowAddress?.(),
      holding: (_pin, stage) => {
        if (stage === 'shutdown') this.face.setScreen({ title: 'Let go to shut down', lines: ['Keep holding for setup mode (10 s).'], tone: 'warn' });
        else if (stage === null && this.face.screen?.title === 'Let go to shut down') this.face.setScreen(null);
      },
      shutdown: () => void this.shutdown(),
      setup: () => this.onSetupRequested?.(),
    });
  }

  /** Called when someone holds a button for setup mode (the network module takes it from there). */
  onSetupRequested: (() => void) | null = null;
  /** Called when someone asks where to find Peeqo (a medium press). */
  onShowAddress: (() => void) | null = null;

  /** Rebuilds the brain's model and GIF search from the config (after setup or a change of keys). */
  applySettings(): void {
    const config = this.config.config;
    const paths = this.config.paths;
    this.#live = config.keys.openrouter ? new OpenRouterModel({ apiKey: config.keys.openrouter, ...(config.model ? { model: config.model } : {}) }) : null;
    this.brain.useModel(this.#live ?? this.#offline);
    this.brain.voice = config.voice;
    this.brain.useGifs(
      config.keys.klipy
        ? new KlipyClient({
            apiKey: config.keys.klipy,
            store: {
              load: () => {
                try {
                  return JSON.parse(readFileOrNull(paths.gifSearches) ?? 'null') as Record<string, CachedSearch> | null;
                } catch {
                  return null;
                }
              },
              save: (data) => writeFileSafely(paths.gifSearches, JSON.stringify(data)),
            },
          })
        : null,
    );
  }

  async start(): Promise<void> {
    await this.brain.restore().catch((error: unknown) => this.log(`could not load memory: ${String(error)}`));
    // The hardware helper: servos, LEDs, buttons.
    const config = this.config.config;
    const link = new HardwareLink({
      script: path.join(this.options.appDir, 'python', 'hardware.py'),
      fake: this.options.fake,
      buttons: config.buttons.pins,
      activeLow: config.buttons.activeLow,
      onButton: (pin, pressed) => {
        this.log(`button ${pin} ${pressed ? 'pressed' : 'released'}`);
        this.buttons.change(pin, pressed);
      },
      onError: (message) => this.log(`hardware: ${message}`),
      onExit: (message) => {
        this.log(message);
        this.#hardware = null;
      },
    });
    try {
      this.#hardware = await link.start();
      this.#link = link;
      this.#outputs.link = link;
      this.buttons.arm(this.#hardware.buttons);
      this.log(`hardware: servos ${this.#hardware.servos ? 'ok' : 'missing'}, LEDs ${this.#hardware.leds ? 'ok' : 'missing'}${this.#hardware.fake ? ' (fake)' : ''}`);
    } catch (error) {
      this.log(`the hardware helper did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Listening: the microphone, the wake word detector beside it.
    if (!this.options.fake) this.#startListening();
    this.#last = performance.now();
    this.#timer = setInterval(() => this.#tick(), STEP_S * 1000);
    if (!this.servos.calibration) this.log('not calibrated yet: the servos stay still until calibration (on the panel)');
    else this.servos.horns(this.governor.output.hornDeg); // eases up from the resting pulse
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#mic?.stop();
    this.#wakeWord?.stop();
    this.#link?.stop();
    await this.brain.flush();
  }

  /** Someone typed to Peeqo (the panel). */
  say(text: string): void {
    const words = text.trim().slice(0, 500);
    if (!words) return;
    this.poke();
    this.#line('you', words);
    this.body.hush();
    void this.brain.hear(words);
  }

  /** Listen now, as after the wake word (a button tap). */
  listen(): void {
    this.poke();
    this.body.hush();
    this.brain.attend();
    if (this.#mic?.running) this.recorder.start(PREROLL_CHUNKS);
    else this.#line('note', 'There is no microphone to listen with.');
  }

  poke(): void {
    this.life.poke(performance.now());
  }

  /** Shows a screen over the face (setup instructions, an address), or clears it. */
  showScreen(screen: FaceScreen | null): void {
    this.face.setScreen(screen);
  }

  async shutdown(): Promise<void> {
    this.log('shutting down');
    this.face.setScreen({ title: 'Shutting down…', lines: ['Wait for the screen to go dark before unplugging.'] });
    await this.brain.flush();
    await this.#system(['systemctl', 'poweroff']);
  }

  async reboot(): Promise<void> {
    this.log('rebooting');
    this.face.setScreen({ title: 'Restarting…', lines: [] });
    await this.brain.flush();
    await this.#system(['systemctl', 'reboot']);
  }

  get transcript(): readonly TranscriptLine[] {
    return this.#transcript;
  }

  get logs(): readonly string[] {
    return this.#logs;
  }

  onTranscript(listener: (line: TranscriptLine) => void): () => void {
    this.#transcriptListeners.add(listener);
    return () => this.#transcriptListeners.delete(listener);
  }

  onLog(listener: (line: string) => void): () => void {
    this.#logListeners.add(listener);
    return () => this.#logListeners.delete(listener);
  }

  log(line: string): void {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.#logs = [...this.#logs.slice(-(LOG_LINES - 1)), stamped];
    (this.options.log ?? console.log)(stamped);
    for (const listener of this.#logListeners) listener(stamped);
  }

  state(): RobotState {
    const out = this.governor.output;
    const config = this.config.config;
    return {
      name: config.name,
      character: { state: this.character.state, expression: this.character.expression },
      brain: { model: this.brain.modelName, live: this.#live !== null, gifs: config.keys.klipy !== null, voice: this.brain.voice },
      hardware: this.#hardware,
      servos: this.servos.state,
      motion: { status: out.status, notes: out.notes, pose: { ...out.pose } },
      listening: { wakeWord: this.#wakeWord?.running ?? false, microphone: this.#mic?.running ?? false, recording: this.recorder.recording },
      memory: [...this.memory.facts],
      timers: this.alarms.list().map((a) => ({ id: a.id, kind: a.kind, label: a.label, inMs: a.dueMs - Date.now() })),
      screens: this.face.screens,
    };
  }

  /** Fake mode: press a button (the panel's stand-in for the hardware). */
  pressButton(pin: number, pressed: boolean): void {
    if (this.options.fake) this.#link?.press(pin, pressed);
  }

  #startListening(): void {
    const wake = this.options.wakeWord ?? null;
    const python = wake?.python;
    if (wakeWordReady(python)) {
      const words = this.config.config.wakeWords ?? undefined;
      const detector = new WakeWordDetector({ ...(python ? { python } : {}), ...(wake?.script ? { script: wake.script } : {}), ...(words ? { words } : {}) }, (event) => {
        if (event.type === 'vad') this.#speech = event.speech;
        else if (event.type === 'wake' && !this.recorder.recording && !this.recorder.deaf) {
          this.log(`wake word: ${event.word} (${event.score.toFixed(2)})`);
          this.poke();
          this.body.hush();
          this.brain.attend();
          this.recorder.start(WAKE_PREROLL_CHUNKS);
        } else if (event.type === 'error') this.log(`wake word: ${event.message}`);
      });
      detector.start().then(
        (words) => this.log(`listening for ${words.join(', ')}`),
        (error: unknown) => this.log(`the wake word detector did not start: ${error instanceof Error ? error.message : String(error)}`),
      );
      this.#wakeWord = detector;
    } else {
      this.log('no wake word detector (run npm run setup -w @peeqo/wakeword); a button tap still listens');
    }
    const mic = new Microphone({
      device: this.options.micDevice ?? null,
      onChunk: (samples) => {
        if (samples.length !== MIC_CHUNK) return;
        this.#wakeWord?.write(samples);
        this.recorder.chunk(samples, this.#wakeWord?.running ? this.#speech : null);
      },
      onError: (message) => {
        this.log(message);
        // Try again in a while (a USB microphone plugged back in, a busy device).
        if (!this.#stopping) setTimeout(() => !this.#stopping && mic.start(), 5000);
      },
    });
    mic.start();
    this.#mic = mic;
  }

  #tick(): void {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    this.#accumulator += dt;
    let steps = 0;
    while (this.#accumulator >= STEP_S && steps < MAX_STEPS_PER_TICK) {
      this.governor.setTarget(this.animator.update(STEP_S));
      this.governor.step(STEP_S);
      this.#accumulator -= STEP_S;
      steps++;
    }
    if (steps === MAX_STEPS_PER_TICK) this.#accumulator = 0; // fell behind: no burst to catch up
    if (!this.calibrating && this.servos.calibration) this.servos.horns(this.governor.output.hornDeg);
    this.servos.update(dt);
    this.character.update(now);
    this.life.update(now);
    this.recorder.deaf = this.character.state === 'speaking';
    if (now - this.#lastAlarmCheck > 250) {
      this.#lastAlarmCheck = now;
      this.alarms.update();
    }
    this.leds.update(now);
    if (this.strip.version !== this.#ledVersion) {
      this.#ledVersion = this.strip.version;
      this.#outputs.leds(apa102Frame(this.strip.shown));
    }
    this.face.update(now);
  }

  #line(who: TranscriptLine['who'], text: string): void {
    const line = { at: Date.now(), who, text };
    this.#transcript = [...this.#transcript.slice(-(TRANSCRIPT_LINES - 1)), line];
    for (const listener of this.#transcriptListeners) listener(line);
  }

  async #system(command: readonly string[]): Promise<void> {
    if (this.options.system) return this.options.system(command);
    if (this.options.fake) {
      this.log(`(fake) would run: sudo ${command.join(' ')}`);
      return;
    }
    await new Promise<void>((resolve) => {
      execFile('sudo', ['-n', ...command], (error) => {
        if (error) this.log(`${command.join(' ')} failed: ${error.message}`);
        resolve();
      });
    });
  }
}
