import { describe, expect, it } from 'vitest';
import {
  Brain,
  Memory,
  ScriptedModel,
  Weather,
  parseFacts,
  weatherTool,
  type BrainBody,
  type ChatMessage,
  type ChatModel,
  type ChatReply,
  type ChatRequest,
  type SavedConversation,
} from '../src/index.ts';

const NOW = new Date(2026, 9, 3, 14, 0, 0);

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

/** A model that answers from a list of replies, recording what it was asked. */
function listModel(replies: Partial<ChatReply['message']>[], requests: ChatRequest[] = []): ChatModel {
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

describe('Memory', () => {
  it('remembers, updates, skips duplicates and forgets, saving Markdown in order', async () => {
    const saves: string[] = [];
    const memory = new Memory({ store: { load: () => null, save: (md) => void saves.push(md) } });
    await memory.load();
    expect(memory.remember('  - Lives in   Pune, India. ')).toBe('remembered "Lives in Pune, India."');
    expect(memory.remember('lives in pune india')).toBe('already remembered: "lives in pune india"');
    memory.remember('Has a sister called Priya.');
    expect(memory.remember('Lives in Mumbai.', 'Lives in Pune, India.')).toBe('updated "Lives in Pune, India." to "Lives in Mumbai."');
    expect(memory.facts).toEqual(['Lives in Mumbai.', 'Has a sister called Priya.']);
    expect(memory.remember('Loves cats.', 'something never said')).toMatch(/^remembered "Loves cats." \(nothing matched/);
    expect(memory.forget('sister')).toBe('forgot "Has a sister called Priya."');
    expect(memory.forget('dogs')).toMatch(/^nothing matched/);
    expect(memory.forget(null)).toMatch(/^error/);
    expect(memory.remember('   ')).toMatch(/^error/);
    await memory.flush();
    expect(saves).toHaveLength(5); // every change, none for the refusals
    expect(saves.at(-1)).toBe(memory.markdown());
    expect(memory.markdown()).toMatch(/^# What Peeqo remembers\n[\s\S]*\n- Lives in Mumbai\.\n- Loves cats\.\n$/);
    expect(memory.forget(null, true)).toBe('forgot all 2 facts');
    expect(memory.forget(null, true)).toBe('there was nothing to forget');
  });

  it('reads the facts from a hand-edited file, and stops at its limit', async () => {
    const markdown = '# My notes\n\nSome text that is not a fact.\n\n- Name is Abhi\n* Likes chai\n+ likes chai\n  - Birthday: 3 March\n';
    expect(parseFacts(markdown)).toEqual(['Name is Abhi', 'Likes chai', 'Birthday: 3 March']);
    const memory = new Memory({ store: { load: () => markdown, save: () => undefined }, maxFacts: 2 });
    await memory.load();
    expect(memory.facts).toEqual(['Name is Abhi', 'Likes chai']);
    expect(memory.remember('Has a dog.')).toMatch(/^error: your memory is full \(2 facts\)/);
    expect(memory.remember('Name is Abhishek, called Abhi.', 'Name is Abhi')).toMatch(/^updated/); // updating is always allowed
  });

  it('keeps going when saving fails, and tells someone', async () => {
    const errors: unknown[] = [];
    const memory = new Memory({ store: { load: () => null, save: () => Promise.reject(new Error('disk full')) }, onError: (e) => errors.push(e) });
    memory.remember('Loves cats.');
    await memory.flush();
    expect(errors).toHaveLength(1);
    expect(memory.facts).toEqual(['Loves cats.']);
  });
});

describe('Brain with memory', () => {
  it('sees what it remembers, and saves new facts in the same round trip as its answer', async () => {
    const { body } = fakeBody();
    const requests: ChatRequest[] = [];
    const memory = new Memory();
    memory.remember('Their name is Abhi.');
    const model = listModel(
      [{ tool_calls: [call('m', 'remember', { fact: 'Lives in Pune, India.' }), call('r', 'respond', { expressions: ['happy'], say: 'Pune! Lovely.' })] }],
      requests,
    );
    const brain = new Brain({ model, body, memory, voice: true, now: () => NOW });
    const turn = await brain.hear('I live in Pune');
    expect(turn.reply).toBe('Pune! Lovely.');
    expect(requests).toHaveLength(1);
    expect(memory.facts).toEqual(['Their name is Abhi.', 'Lives in Pune, India.']);
    const tools = requests[0]!.tools!.map((t) => t.function.name);
    expect(tools).toEqual(['respond', 'remember', 'forget']);
    const system = String(requests[0]!.messages[0]!.content);
    expect(system).toMatch(/save it with remember/);
    expect(system).toMatch(/What you remember about them:\n- Their name is Abhi\./);
  });

  it('carries the conversation over a restart, and knows how long it has been', async () => {
    const { body } = fakeBody();
    const disk: { saved: SavedConversation | null } = { saved: null };
    const store = { load: () => disk.saved, save: (c: SavedConversation) => void (disk.saved = c) };
    let now = NOW;
    const first = new Brain({ model: new ScriptedModel({ random: () => 0 }), body, conversation: store, now: () => now });
    await first.hear('hello');
    await first.flush();
    expect(disk.saved?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(disk.saved?.lastTalkMs).toBe(NOW.getTime());

    now = new Date(NOW.getTime() + 5 * 3600_000);
    const requests: ChatRequest[] = [];
    const second = new Brain({ model: listModel([{ content: 'Welcome back!' }], requests), body, conversation: store, now: () => now });
    await second.restore();
    expect(second.history).toEqual(first.history);
    await second.hear('hi again');
    expect(requests[0]!.messages.slice(1, 4)).toEqual(first.history);
    expect(String(requests[0]!.messages[0]!.content)).toMatch(/You last talked 5 hours ago \(at 2:00 PM\)/);
    // Within half an hour, it is one conversation: no gap to mention.
    const third = new Brain({ model: listModel([{ content: 'Yes?' }], requests), body, conversation: store, now: () => new Date(now.getTime() + 60_000) });
    await third.restore();
    await third.hear('one more thing');
    expect(String(requests[1]!.messages[0]!.content)).not.toMatch(/You last talked/);
  });

  it('drops a damaged saved conversation instead of sending it', async () => {
    const { body } = fakeBody();
    const broken: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [call('x', 'respond', { say: 'Hey' })] }, // its result is missing
      { role: 'user', content: 'hello?' },
    ];
    const brain = new Brain({ model: new ScriptedModel(), body, conversation: { load: () => ({ messages: broken, lastTalkMs: 1 }), save: () => undefined } });
    await brain.restore();
    expect(brain.history).toHaveLength(0);
  });

  it('hands older exchanges to memory a few at a time, saving what lasts', async () => {
    const { body } = fakeBody();
    const requests: ChatRequest[] = [];
    const memory = new Memory();
    // Replies to the turns, then (once older exchanges drop out) to the tidy-up.
    const reply = (n: number) => ({ tool_calls: [call(`r${n}`, 'respond', { expressions: ['happy'], say: `Reply ${n}` })] });
    const model = listModel([reply(1), reply(2), reply(3), reply(4), reply(5), { tool_calls: [call('t', 'remember', { fact: 'Has a cat called Miso.' })] }], requests);
    const brain = new Brain({ model, body, memory, recentTurns: 3, voice: true, now: () => NOW });
    for (const text of ['My cat Miso is sick', 'what should I do', 'ok thanks', 'see you']) await brain.hear(text);
    expect(requests).toHaveLength(4); // 3 exchanges, plus 1 to spare: nothing has dropped out yet
    await brain.hear('bye');
    await new Promise((r) => setTimeout(r, 10));
    expect(requests).toHaveLength(6);
    const tidy = requests[5]!;
    expect(tidy.tools!.map((t) => t.function.name)).toEqual(['remember', 'forget']);
    expect(String(tidy.messages[0]!.content)).toMatch(/You are the memory of Peeqo/);
    expect(String(tidy.messages[1]!.content)).toMatch(/\(nothing yet\)\n\nThe older conversation:\nThem: My cat Miso is sick\nPeeqo: Reply 1\nThem: what should I do\nPeeqo: Reply 2$/);
    expect(memory.facts).toEqual(['Has a cat called Miso.']);
    expect(brain.history.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['ok thanks', 'see you', 'bye']);
  });

  it('remembers offline too: names, home, and forgetting', async () => {
    const { body } = fakeBody();
    const memory = new Memory();
    const weather = new Weather({
      fetch: (async (url: string) =>
        new Response(
          url.includes('geocoding')
            ? JSON.stringify({ results: [{ name: 'Pune', admin1: 'Maharashtra', country: 'India', latitude: 18.5, longitude: 73.9 }] })
            : JSON.stringify({
                current: { temperature_2m: 27, apparent_temperature: 29, weather_code: 3, wind_speed_10m: 8 },
                daily: { weather_code: [3, 61, 2], temperature_2m_max: [30, 28, 29], temperature_2m_min: [21, 21, 20], precipitation_probability_max: [20, 80, 10] },
              }),
        )) as unknown as typeof fetch,
    });
    const brain = new Brain({ model: new ScriptedModel({ random: () => 0 }), body, memory, tools: [weatherTool(weather)], voice: true, now: () => NOW });
    expect((await brain.hear("What's my name?")).reply).toMatch(/haven't told me/);
    expect((await brain.hear('My name is sam')).reply).toBe('Nice to meet you, Sam!');
    expect((await brain.hear("What's my name?")).reply).toBe("You're Sam! I'd never forget.");
    expect((await brain.hear('Call me Samwise')).reply).toBe('Nice to meet you, Samwise!');
    expect((await brain.hear('I live in Pune')).reply).toBe('Pune! Noted.');
    expect(memory.facts).toEqual(['Their name is Samwise.', 'Lives in Pune.']);
    expect((await brain.hear("what's the weather like?")).reply).toBe('In Pune right now: overcast, 27°C (81°F), feels like 29°C (84°F), wind 8 km/h.');
    expect((await brain.hear('remember that my sister is Priya')).reply).toBe("Got it, I'll remember!");
    expect(memory.facts).toContain('Their sister is Priya.');
    expect((await brain.hear('forget where I live')).reply).toBe('Done, forgotten.');
    expect((await brain.hear('Where do I live?')).reply).toMatch(/haven't told me/);
    expect((await brain.hear('forget everything')).reply).toBe('Done, forgotten.');
    expect(memory.facts).toEqual([]);
  });
});
