import { describeDuration, type Alarm, type Alarms } from './alarms.ts';
import type { Memory } from './memory.ts';
import type { ToolSpec } from './openrouter.ts';
import type { Weather } from './weather.ts';

/**
 * Tools the model can use before it answers (the time, timers, reminders, the weather). Each describes itself to
 * the model and runs when called; whatever it returns, including a problem ("error: …"), goes back to the model.
 */
export interface ToolContext {
  readonly now: Date;
  readonly signal: AbortSignal;
}

export interface BrainTool {
  readonly spec: ToolSpec;
  /** What it lets Peeqo do, for its instructions ("look up the weather"); left out for helpers like list_timers. */
  readonly ability?: string;
  run(args: Readonly<Record<string, unknown>>, context: ToolContext): Promise<string> | string;
}

function spec(name: string, description: string, properties: Record<string, unknown>, required: readonly string[] = []): ToolSpec {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const timeOfDay = (date: Date) => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayOf = (date: Date) => date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

/** When an alarm goes off, as words: "in 5 minutes (at 2:46 PM)", naming the day if it is not today. */
function when(alarm: Alarm, now: Date): string {
  const due = new Date(alarm.dueMs);
  const sameDay = due.toDateString() === now.toDateString();
  return `in ${describeDuration(alarm.dueMs - now.getTime())} (at ${timeOfDay(due)}${sameDay ? '' : ` on ${dayOf(due)}`})`;
}

export const clockTool: BrainTool = {
  spec: spec('get_time', 'The current date, time and time zone where you are.', {}),
  ability: 'check the date and time',
  run: (_args, { now }) =>
    `${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (time zone ${
      Intl.DateTimeFormat().resolvedOptions().timeZone
    })`,
};

/** Timers and reminders, kept by an Alarms (which announces them when due). */
export function alarmTools(alarms: Alarms): BrainTool[] {
  return [
    {
      ability: 'set, list and cancel timers',
      spec: spec('set_timer', 'Start a countdown timer (up to 24 hours). You will announce it when it ends.', {
        hours: { type: 'number', minimum: 0 },
        minutes: { type: 'number', minimum: 0 },
        seconds: { type: 'number', minimum: 0 },
        label: { type: 'string', description: 'What it is for, e.g. "pasta" (optional)' },
      }),
      run: (args, { now }) => {
        const ms = (number(args.hours) * 3600 + number(args.minutes) * 60 + number(args.seconds)) * 1000;
        if (!(ms >= 1000)) return 'error: give the timer a length (hours, minutes or seconds)';
        if (ms > 24 * 3600_000) return 'error: timers go up to 24 hours; use a reminder for longer';
        const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : `${describeDuration(ms)} timer`;
        try {
          const alarm = alarms.set('timer', label, now.getTime() + ms);
          return `timer ${alarm.id} "${alarm.label}" set; it goes off ${when(alarm, now)}`;
        } catch (error) {
          return `error: ${(error as Error).message}`;
        }
      },
    },
    {
      ability: 'set reminders',
      spec: spec(
        'set_reminder',
        'Remind the person about something at a given time, or after a while. You will say the reminder when it is due.',
        {
          text: { type: 'string', description: 'What to remind them about, e.g. "call Mum"' },
          at: { type: 'string', description: 'Local date and time, as YYYY-MM-DDTHH:MM (24-hour clock)' },
          in_minutes: { type: 'number', minimum: 1, description: 'Or: how many minutes from now' },
        },
        ['text'],
      ),
      run: (args, { now }) => {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return 'error: say what the reminder is for';
        let dueMs: number;
        if (typeof args.at === 'string' && args.at.trim()) {
          // A date and time without an offset is local time.
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(args.at.trim())) return 'error: give the time as YYYY-MM-DDTHH:MM';
          dueMs = new Date(args.at.trim()).getTime();
        } else if (number(args.in_minutes) > 0) {
          dueMs = now.getTime() + number(args.in_minutes) * 60_000;
        } else {
          return 'error: give a time (at) or a delay (in_minutes)';
        }
        try {
          const alarm = alarms.set('reminder', text, dueMs);
          return `reminder ${alarm.id} "${alarm.label}" set for ${when(alarm, now)}`;
        } catch (error) {
          return `error: ${(error as Error).message}`;
        }
      },
    },
    {
      spec: spec('list_timers', 'The timers and reminders that are still to go off, and how long is left.', {}),
      run: (_args, { now }) => {
        const pending = alarms.list();
        if (pending.length === 0) return 'no timers or reminders';
        return pending.map((a) => `${a.id}: ${a.kind} "${a.label}", ${when(a, now)}`).join('; ');
      },
    },
    {
      spec: spec('cancel_timer', 'Cancel timers or reminders: by id (like t1 or r2), by what they are for, or all of them.', {
        id: { type: 'string' },
        label: { type: 'string', description: 'Part of what it is for, e.g. "pasta"' },
        all: { type: 'boolean', description: 'Cancel every timer and reminder' },
      }),
      run: (args) => {
        const gone = alarms.cancel({
          ...(typeof args.id === 'string' ? { id: args.id } : {}),
          ...(typeof args.label === 'string' ? { label: args.label } : {}),
          ...(args.all === true ? { all: 'both' as const } : {}),
        });
        return gone.length === 0 ? 'nothing matched; nothing was cancelled' : `cancelled ${gone.map((a) => `${a.id} "${a.label}"`).join(', ')}`;
      },
    },
  ];
}

export function weatherTool(weather: Weather): BrainTool {
  return {
    ability: 'look up the weather',
    spec: spec(
      'get_weather',
      "The weather now and for the next two days, in both °C and °F. If they don't name a place, use where they live, if you remember it.",
      { place: { type: 'string', description: 'A town or city, optionally with its country, e.g. "Pune, India".' } },
    ),
    run: async (args, { signal }) => {
      try {
        return await weather.report(typeof args.place === 'string' ? args.place : null, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return `error: the weather service could not be reached (${(error as Error).message})`;
      }
    },
  };
}

/** Remembering and forgetting facts about the person, kept by a Memory (Brain adds these when it has one). */
export function memoryTools(memory: Memory): BrainTool[] {
  return [
    {
      spec: spec(
        'remember',
        'Save a lasting fact about the person you live with, as a short sentence (e.g. "Lives in Pune, India.", "Has a sister called Priya.", ' +
          '"Exam on 10 October 2026."). To update something you already remember, give that fact in replaces.',
        {
          fact: { type: 'string', maxLength: 200 },
          replaces: { type: 'string', description: 'The fact this one updates, as you remember it (optional)' },
        },
        ['fact'],
      ),
      run: (args) => memory.remember(typeof args.fact === 'string' ? args.fact : '', typeof args.replaces === 'string' ? args.replaces : undefined),
    },
    {
      spec: spec('forget', 'Forget a fact, when they ask you to or it is no longer true; or everything you remember about them, if they ask.', {
        fact: { type: 'string', description: 'The fact to forget, as you remember it' },
        all: { type: 'boolean', description: 'Forget everything' },
      }),
      run: (args) => memory.forget(typeof args.fact === 'string' ? args.fact : null, args.all === true),
    },
  ];
}
