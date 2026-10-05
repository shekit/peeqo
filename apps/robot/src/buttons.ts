/** Held this long and let go: shut down. */
export const SHUTDOWN_HOLD_MS = 3000;
/** Held this long: setup mode (join a new Wi-Fi network). */
export const SETUP_HOLD_MS = 10000;
/** Shorter than this is a tap. */
const TAP_MS = 1000;

export interface ButtonActions {
  /** A tap: talk to Peeqo (it listens, as after its wake word). */
  tap(pin: number): void;
  /** A press of 1–3 s: show where to find Peeqo (its address, or how to set it up). */
  medium(pin: number): void;
  /** Feedback while held: 'shutdown' once letting go would shut down, 'setup' once setup mode has started, null when let go early. */
  holding(pin: number, stage: 'shutdown' | 'setup' | null): void;
  shutdown(): void;
  setup(): void;
}

/**
 * The buttons: tap to talk; press for a second or two to see Peeqo's address; hold 3 s and let go to shut down (as the
 * 2019 rear button did); keep holding to 10 s for setup mode. A button only counts once it has been seen released, so one stuck down (or wired differently) at
 * start-up cannot shut Peeqo down.
 */
export class ButtonGestures {
  readonly #actions: ButtonActions;
  readonly #now: () => number;
  readonly #armed = new Set<number>();
  readonly #pressed = new Map<number, { atMs: number; stage: 'shutdown' | 'setup' | null; timers: ReturnType<typeof setTimeout>[] }>();

  constructor(actions: ButtonActions, now: () => number = () => Date.now()) {
    this.#actions = actions;
    this.#now = now;
  }

  /** Buttons that are not pressed at start-up can be used straight away. */
  arm(pins: readonly number[]): void {
    for (const pin of pins) this.#armed.add(pin);
  }

  change(pin: number, pressed: boolean): void {
    if (!pressed) {
      const press = this.#pressed.get(pin);
      this.#pressed.delete(pin);
      const wasArmed = this.#armed.has(pin);
      this.#armed.add(pin);
      if (!press || !wasArmed) return;
      for (const timer of press.timers) clearTimeout(timer);
      const held = this.#now() - press.atMs;
      if (press.stage === 'setup') return; // already done
      if (press.stage === 'shutdown') {
        this.#actions.shutdown();
        return;
      }
      if (held < TAP_MS) this.#actions.tap(pin);
      else this.#actions.medium(pin);
      return;
    }
    if (!this.#armed.has(pin) || this.#pressed.has(pin)) return;
    const press: { atMs: number; stage: 'shutdown' | 'setup' | null; timers: ReturnType<typeof setTimeout>[] } = { atMs: this.#now(), stage: null, timers: [] };
    press.timers.push(
      setTimeout(() => {
        press.stage = 'shutdown';
        this.#actions.holding(pin, 'shutdown');
      }, SHUTDOWN_HOLD_MS),
      setTimeout(() => {
        press.stage = 'setup';
        this.#actions.holding(pin, 'setup');
        this.#actions.setup();
      }, SETUP_HOLD_MS),
    );
    this.#pressed.set(pin, press);
  }
}
