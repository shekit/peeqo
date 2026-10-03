import { describe, expect, it } from 'vitest';
import {
  Alarms,
  Brain,
  ScriptedModel,
  Weather,
  alarmTools,
  clockTool,
  describeDuration,
  weatherTool,
  type Alarm,
  type BrainBody,
  type BrainTool,
  type ChatModel,
  type ChatReply,
  type ChatRequest,
  type ToolContext,
} from '../src/index.ts';

const NOW = new Date(2026, 9, 3, 14, 0, 0); // Saturday 3 October 2026, 2:00 PM local
const context = (now = NOW): ToolContext => ({ now, signal: new AbortController().signal });
const tool = (tools: BrainTool[], name: string) => tools.find((t) => t.spec.function.name === name)!;

describe('Alarms', () => {
  it('keeps timers and reminders in order, with short ids, and fires them when due', () => {
    let now = NOW.getTime();
    const fired: Alarm[] = [];
    const alarms = new Alarms({ now: () => now, onDue: (a) => fired.push(a) });
    const pasta = alarms.set('timer', 'pasta', now + 10 * 60_000);
    const tea = alarms.set('timer', 'tea', now + 3 * 60_000);
    const call = alarms.set('reminder', 'call Mum', now + 60 * 60_000);
    expect([pasta.id, tea.id, call.id]).toEqual(['t1', 't2', 'r1']);
    expect(alarms.list().map((a) => a.label)).toEqual(['tea', 'pasta', 'call Mum']);
    now += 3 * 60_000;
    expect(alarms.update().map((a) => a.id)).toEqual(['t2']);
    expect(fired.map((a) => a.label)).toEqual(['tea']);
    expect(alarms.set('timer', 'eggs', now + 1000).id).toBe('t2'); // ids are reused once free
    now += 2 * 3600_000;
    expect(alarms.update().map((a) => a.label)).toEqual(['eggs', 'pasta', 'call Mum']);
    expect(alarms.list()).toHaveLength(0);
  });

  it('refuses the past, the far future and too many', () => {
    const now = NOW.getTime();
    const alarms = new Alarms({ now: () => now });
    expect(() => alarms.set('timer', 'x', now - 1)).toThrow(/already passed/);
    expect(() => alarms.set('reminder', 'x', now + 400 * 24 * 3600_000)).toThrow(/more than a year/);
    for (let i = 0; i < 20; i++) alarms.set('timer', `t${i}`, now + 60_000);
    expect(() => alarms.set('timer', 'one more', now + 60_000)).toThrow(/already 20/);
  });

  it('cancels by id, by label or all, and survives a restart (ignoring damaged storage)', () => {
    const now = NOW.getTime();
    let saved: readonly Alarm[] = [];
    const store = { load: () => saved, save: (a: readonly Alarm[]) => void (saved = a) };
    const alarms = new Alarms({ now: () => now, store });
    alarms.set('timer', 'Pasta water', now + 60_000);
    alarms.set('reminder', 'call Mum', now + 120_000);
    expect(alarms.cancel({ label: 'pasta' }).map((a) => a.id)).toEqual(['t1']);
    expect(new Alarms({ now: () => now, store }).list().map((a) => a.label)).toEqual(['call Mum']);
    expect(alarms.cancel({ all: 'both' })).toHaveLength(1);
    const broken = new Alarms({ store: { load: () => [{ id: 1 }] as unknown as Alarm[], save: () => undefined } });
    expect(broken.list()).toHaveLength(0);
    const throwing = new Alarms({ store: { load: () => { throw new Error('corrupt'); }, save: () => undefined } });
    expect(throwing.list()).toHaveLength(0);
  });

  it('describes durations the way people say them', () => {
    expect(describeDuration(5 * 60_000)).toBe('5 minutes');
    expect(describeDuration(90_000)).toBe('1 minute 30 seconds');
    expect(describeDuration(3600_000 + 60_000)).toBe('1 hour 1 minute');
    expect(describeDuration(1000)).toBe('1 second');
  });
});

describe('tools', () => {
  it('tells the time', () => {
    expect(clockTool.run({}, context())).toMatch(/Saturday, October 3, 2026 at 2:00 PM \(time zone /);
  });

  it('sets, lists and cancels timers, checking what it is given', () => {
    const alarms = new Alarms({ now: () => NOW.getTime() });
    const tools = alarmTools(alarms);
    expect(tool(tools, 'set_timer').run({ minutes: 5, label: 'pasta' }, context())).toBe('timer t1 "pasta" set; it goes off in 5 minutes (at 2:05 PM)');
    expect(tool(tools, 'set_timer').run({ seconds: 90 }, context())).toMatch(/timer t2 "1 minute 30 seconds timer" set/);
    expect(tool(tools, 'set_timer').run({}, context())).toMatch(/^error: give the timer a length/);
    expect(tool(tools, 'set_timer').run({ hours: 30 }, context())).toMatch(/^error: timers go up to 24 hours/);
    expect(tool(tools, 'list_timers').run({}, context())).toBe('t2: timer "1 minute 30 seconds timer", in 1 minute 30 seconds (at 2:01 PM); t1: timer "pasta", in 5 minutes (at 2:05 PM)');
    expect(tool(tools, 'cancel_timer').run({ id: 't1' }, context())).toBe('cancelled t1 "pasta"');
    expect(tool(tools, 'cancel_timer').run({ label: 'nothing like it' }, context())).toBe('nothing matched; nothing was cancelled');
  });

  it('sets reminders for a time or after a delay', () => {
    const alarms = new Alarms({ now: () => NOW.getTime() });
    const set = tool(alarmTools(alarms), 'set_reminder');
    expect(set.run({ text: 'call Mum', at: '2026-10-04T09:30' }, context())).toBe('reminder r1 "call Mum" set for in 19 hours 30 minutes (at 9:30 AM on Sunday, October 4)');
    expect(set.run({ text: 'stretch', in_minutes: 20 }, context())).toMatch(/^reminder r2 "stretch" set for in 20 minutes \(at 2:20 PM\)$/);
    expect(set.run({ text: 'x', at: 'tomorrow' }, context())).toMatch(/^error: give the time as YYYY-MM-DDTHH:MM/);
    expect(set.run({ text: 'x', at: '2026-10-01T09:00' }, context())).toBe('error: That time has already passed');
    expect(set.run({ in_minutes: 5 }, context())).toMatch(/^error: say what the reminder is for/);
  });

  it('reports the weather for a named place or home, and says when it cannot', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      if (url.includes('geocoding')) {
        const body = url.includes('Atlantis') ? {} : { results: [{ name: 'Pune', admin1: 'Maharashtra', country: 'India', latitude: 18.5, longitude: 73.9 }] };
        return new Response(JSON.stringify(body));
      }
      return new Response(
        JSON.stringify({
          current: { temperature_2m: 27.4, apparent_temperature: 29.1, weather_code: 61, wind_speed_10m: 11.6 },
          daily: { weather_code: [61, 3, 0], temperature_2m_max: [29.6, 30.2, 31], temperature_2m_min: [21.2, 21.9, 22], precipitation_probability_max: [80, 20, null] },
        }),
      );
    }) as unknown as typeof fetch;
    const weather = new Weather({ fetch: fakeFetch });
    const get = weatherTool(weather);
    const report = await get.run({ place: 'Pune, India' }, context());
    expect(report).toBe(
      'Pune, Maharashtra, India. Now: light rain, 27°C (81°F), feels like 29°C (84°F), wind 12 km/h. ' +
        'Today: light rain, high 30°C (85°F), low 21°C (70°F), 80% chance of rain or snow. ' +
        'Tomorrow: overcast, high 30°C (86°F), low 22°C (71°F), 20% chance of rain or snow. ' +
        'The day after: clear sky, high 31°C (88°F), low 22°C (72°F), 0% chance of rain or snow.',
    );
    expect(urls[1]).toContain('latitude=18.5&longitude=73.9');
    expect(await get.run({}, context())).toMatch(/^error: no place was named and no home is set/);
    weather.home = 'Pune';
    expect(await get.run({}, context())).toMatch(/^Pune, Maharashtra, India\. Now: light rain/);
    expect(await get.run({ place: 'Atlantis' }, context())).toBe('error: could not find a place called "Atlantis"');
    const down = weatherTool(new Weather({ fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch }));
    expect(await down.run({ place: 'Paris' }, context())).toMatch(/^error: the weather service could not be reached/);
  });
});

/** A model that answers from a list, recording each request. */
function listModel(replies: Partial<ChatReply['message']>[], requests: ChatRequest[]): ChatModel {
  return {
    name: 'list',
    complete: async (request) => {
      requests.push(request);
      const next = replies.shift();
      if (!next) throw new Error('no more replies');
      return { message: { role: 'assistant', content: null, ...next }, finishReason: 'stop' };
    },
  };
}

function fakeBody() {
  const log: string[] = [];
  const body: BrainBody = {
    setState: (s) => log.push(`state:${s}`),
    express: (name) => log.push(`express:${name}`),
    showGif: async () => undefined,
    say: async (text) => void log.push(`say:${text}`),
  };
  return { body, log };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('Brain with tools', () => {
  it('uses a tool, then answers from what it found', async () => {
    const { body, log } = fakeBody();
    const requests: ChatRequest[] = [];
    const alarms = new Alarms({ now: () => NOW.getTime() });
    const model = listModel(
      [{ tool_calls: [call('a', 'set_timer', { minutes: 5, label: 'pasta' })] }, { tool_calls: [call('b', 'respond', { expressions: ['yes'], say: 'Pasta timer, five minutes!' })] }],
      requests,
    );
    const brain = new Brain({ model, body, tools: [clockTool, ...alarmTools(alarms)], now: () => NOW });
    const turn = await brain.hear('set a pasta timer for 5 minutes');
    expect(turn.reply).toBe('Pasta timer, five minutes!');
    expect(alarms.list().map((a) => a.label)).toEqual(['pasta']);
    expect(requests[0]!.tools!.map((t) => t.function.name)).toEqual(['respond', 'get_time', 'set_timer', 'set_reminder', 'list_timers', 'cancel_timer']);
    expect(requests[0]!.messages[0]!.content).toMatch(/You can also check the date and time, set, list and cancel timers, set reminders\./);
    expect(requests[1]!.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'a', content: 'timer t1 "pasta" set; it goes off in 5 minutes (at 2:05 PM)' });
    expect(log).toEqual(['state:thinking', 'express:yes', 'state:speaking', 'say:Pasta timer, five minutes!', 'state:idle']);
  });

  it('hears a recording directly, and remembers it as the words it heard', async () => {
    const { body } = fakeBody();
    const requests: ChatRequest[] = [];
    const events: string[] = [];
    const model = listModel([{ tool_calls: [call('r', 'respond', { expressions: ['happy'], heard: 'Good morning Peeqo', say: 'Morning!' })] }], requests);
    const brain = new Brain({ model, body, onEvent: (e) => events.push(e.type === 'understood' ? `understood:${e.text}` : e.type) });
    const turn = await brain.hear({ audio: 'UklGRg==' });
    expect(requests[0]!.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'They said this out loud:' },
        { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
      ],
    });
    expect(turn.heard).toBe('Good morning Peeqo');
    expect(events).toContain('understood:Good morning Peeqo');
    expect(brain.history[0]).toEqual({ role: 'user', content: 'Good morning Peeqo' }); // no audio kept
  });

  it('announces timers when they go off, after any turn in progress, and tells the model about it', async () => {
    const { body, log } = fakeBody();
    const requests: ChatRequest[] = [];
    let release: () => void = () => undefined;
    const slow: ChatModel = {
      name: 'slow',
      complete: async (request) => {
        requests.push(request);
        if (requests.length === 1) await new Promise<void>((r) => (release = r));
        return { message: { role: 'assistant', content: null, tool_calls: [call(`x${requests.length}`, 'respond', { expressions: ['happy'], say: 'Sure!' })] }, finishReason: 'stop' };
      },
    };
    const brain = new Brain({ model: slow, body, now: () => NOW });
    const turn = brain.hear('tell me something');
    await new Promise((r) => setTimeout(r, 5));
    const announced = brain.announce('Ding! Your pasta timer is done!');
    await new Promise((r) => setTimeout(r, 5));
    expect(log.some((l) => l.includes('pasta'))).toBe(false); // it waits for the turn
    release();
    await turn;
    await announced;
    expect(log.slice(-4)).toEqual(['express:alert', 'state:speaking', 'say:Ding! Your pasta timer is done!', 'state:idle']);
    await brain.hear('thanks!');
    expect(requests.at(-1)!.messages[0]!.content).toMatch(/Just now: at 2:00 PM you announced: "Ding! Your pasta timer is done!"\./);
  });

  it('works offline too: the stand-in sets timers and checks the weather with the real tools', async () => {
    const { body, log } = fakeBody();
    const alarms = new Alarms({ now: () => NOW.getTime() });
    const weather = new Weather({
      fetch: (async (url: string) =>
        new Response(
          url.includes('geocoding')
            ? JSON.stringify({ results: [{ name: 'Paris', admin1: 'Île-de-France', country: 'France', latitude: 48.85, longitude: 2.35 }] })
            : JSON.stringify({
                current: { temperature_2m: 18, apparent_temperature: 17, weather_code: 2, wind_speed_10m: 9 },
                daily: { weather_code: [2, 3, 61], temperature_2m_max: [20, 19, 17], temperature_2m_min: [11, 12, 12], precipitation_probability_max: [5, 30, 70] },
              }),
        )) as unknown as typeof fetch,
    });
    const brain = new Brain({ model: new ScriptedModel({ random: () => 0 }), body, tools: [clockTool, ...alarmTools(alarms), weatherTool(weather)], now: () => NOW });
    expect((await brain.hear('Set a timer for 10 minutes please')).reply).toBe('Timer set! It goes off in 10 minutes.');
    expect(alarms.list()).toHaveLength(1);
    expect((await brain.hear("What's the weather in Paris?")).reply).toBe('In Paris right now: partly cloudy, 18°C (64°F), feels like 17°C (63°F), wind 9 km/h.');
    expect((await brain.hear('remind me to stretch in 20 minutes')).reply).toBe("Got it! I'll remind you in 20 minutes.");
    expect((await brain.hear('cancel all my timers')).reply).toBe('Done, all cancelled!');
    expect(alarms.list()).toHaveLength(0);
    const spoken = await brain.hear({ audio: 'UklGRg==' });
    expect(spoken.reply).toMatch(/offline brain can't understand speech/);
    expect(log.filter((l) => l.startsWith('say:'))).toHaveLength(5);
  });
});
