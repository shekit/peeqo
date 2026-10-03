/** Timers and reminders: what Peeqo has promised to tell you, and when. */
export interface Alarm {
  /** Short and speakable, so the model can refer to it: t1, t2 for timers, r1, r2 for reminders. */
  readonly id: string;
  readonly kind: 'timer' | 'reminder';
  /** What it is for ("pasta", "call mom"). */
  readonly label: string;
  /** When it goes off (ms since the epoch). */
  readonly dueMs: number;
  readonly createdMs: number;
}

/** Optional persistence, so alarms survive a restart (a file on the robot, browser storage in the simulator). */
export interface AlarmStore {
  load(): readonly Alarm[] | null;
  save(alarms: readonly Alarm[]): void;
}

export interface AlarmsOptions {
  readonly now?: () => number;
  readonly store?: AlarmStore;
  /** Called for each alarm when it goes off (also for ones that came due while nothing was running). */
  readonly onDue?: (alarm: Alarm) => void;
}

/** At most this many alarms at once, and this far ahead. */
export const MAX_ALARMS = 20;
export const MAX_AHEAD_MS = 366 * 24 * 3600_000;

/** Pending timers and reminders. Call update() regularly (every second is plenty); due ones fire then. */
export class Alarms {
  readonly #now: () => number;
  readonly #store: AlarmStore | undefined;
  #onDue: (alarm: Alarm) => void;
  #alarms: Alarm[];

  constructor(options: AlarmsOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#store = options.store;
    this.#onDue = options.onDue ?? (() => undefined);
    const stored = (() => {
      try {
        return options.store?.load() ?? [];
      } catch {
        return []; // damaged storage: start afresh
      }
    })();
    this.#alarms = stored.filter(isAlarm);
  }

  /** Who hears about due alarms (the app wires this to Peeqo announcing them). */
  set onDue(handler: (alarm: Alarm) => void) {
    this.#onDue = handler;
  }

  /** Pending alarms, soonest first. */
  list(): readonly Alarm[] {
    return [...this.#alarms].sort((a, b) => a.dueMs - b.dueMs);
  }

  /** Adds an alarm; throws if it is not in the future (within a year) or there are too many. */
  set(kind: Alarm['kind'], label: string, dueMs: number): Alarm {
    const now = this.#now();
    if (!Number.isFinite(dueMs) || dueMs <= now) throw new Error('That time has already passed');
    if (dueMs - now > MAX_AHEAD_MS) throw new Error('That is more than a year away');
    if (this.#alarms.length >= MAX_ALARMS) throw new Error(`There are already ${MAX_ALARMS} timers and reminders`);
    const prefix = kind === 'timer' ? 't' : 'r';
    let n = 1;
    while (this.#alarms.some((a) => a.id === `${prefix}${n}`)) n++;
    const alarm: Alarm = { id: `${prefix}${n}`, kind, label: label.trim().slice(0, 80), dueMs: Math.round(dueMs), createdMs: now };
    this.#alarms.push(alarm);
    this.#save();
    return alarm;
  }

  /** Cancels by id ("t1"), by label (case-insensitive, matching part of it), or all of a kind; returns what went. */
  cancel(match: { id?: string; label?: string; all?: Alarm['kind'] | 'both' }): readonly Alarm[] {
    const label = match.label?.trim().toLowerCase();
    const gone = this.#alarms.filter(
      (a) =>
        (match.id !== undefined && a.id === match.id.trim().toLowerCase()) ||
        (label !== undefined && label !== '' && a.label.toLowerCase().includes(label)) ||
        match.all === 'both' ||
        match.all === a.kind,
    );
    if (gone.length > 0) {
      this.#alarms = this.#alarms.filter((a) => !gone.includes(a));
      this.#save();
    }
    return gone;
  }

  /** Fires every alarm that is due, soonest first; returns them. */
  update(): readonly Alarm[] {
    const now = this.#now();
    const due = this.list().filter((a) => a.dueMs <= now);
    if (due.length === 0) return due;
    this.#alarms = this.#alarms.filter((a) => !due.includes(a));
    this.#save();
    for (const alarm of due) this.#onDue(alarm);
    return due;
  }

  #save(): void {
    try {
      this.#store?.save(this.list());
    } catch {
      // Storage full or unavailable: the alarms still work until a restart.
    }
  }
}

function isAlarm(value: unknown): value is Alarm {
  const a = value as Partial<Alarm> | null;
  return (
    !!a &&
    typeof a.id === 'string' &&
    (a.kind === 'timer' || a.kind === 'reminder') &&
    typeof a.label === 'string' &&
    typeof a.dueMs === 'number' &&
    Number.isFinite(a.dueMs) &&
    typeof a.createdMs === 'number'
  );
}

/** "5 minutes", "1 hour 30 minutes", "45 seconds". */
export function describeDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (n: number, unit: string) => (n > 0 ? `${n} ${unit}${n === 1 ? '' : 's'}` : '');
  return [part(h, 'hour'), part(m, 'minute'), h === 0 ? part(s, 'second') : ''].filter(Boolean).join(' ') || '0 seconds';
}
