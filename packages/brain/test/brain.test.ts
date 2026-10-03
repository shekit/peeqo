import { describe, expect, it, vi } from 'vitest';
import { EXPRESSION_NAMES, type CharacterState, type ExpressionName } from '@peeqo/character';
import {
  Brain,
  EXPRESS_TOOL,
  GifBudgetError,
  KlipyClient,
  ModelError,
  OpenRouterModel,
  ScriptedModel,
  systemPrompt,
  type BrainBody,
  type ChatModel,
  type ChatReply,
  type ChatRequest,
  type CachedSearch,
  type Gif,
  respondTool,
} from '../src/index.ts';

const KEY = 'sk-test-SECRET-123';

/** A fetch that records requests and answers from a queue. */
function fakeFetch(responses: (Response | ((url: string, init: RequestInit) => Promise<Response>))[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return typeof next === 'function' ? next(url, init) : next;
  }) as typeof fetch;
  return { fn, requests };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const completion = (message: Record<string, unknown>, finish = 'stop') => json({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

const klipyResults = (n: number) => ({
  results: Array.from({ length: n }, (_, i) => ({
    id: `g${i}`,
    title: `gif ${i}`,
    media_formats: {
      mp4: { url: `https://static.klipy.com/${i}.mp4`, dims: [640, 414] },
      mediumgif: { url: `https://static.klipy.com/${i}.gif`, dims: [640, 414] },
    },
  })),
  next: '8',
});

describe('OpenRouterModel', () => {
  it('sends a chat completion with the tools and reads back words and tool calls', async () => {
    const { fn, requests } = fakeFetch([
      completion({ content: 'Hi!', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'express', arguments: '{"expression":"hello"}' } }] }, 'tool_calls'),
    ]);
    const model = new OpenRouterModel({ apiKey: KEY, fetch: fn });
    const reply = await model.complete({ messages: [{ role: 'user', content: 'hey' }], tools: [EXPRESS_TOOL] });
    expect(requests[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(requests[0]!.init.body));
    expect(body).toMatchObject({ model: 'google/gemini-3.8-flash', tool_choice: 'auto', max_tokens: 400 });
    expect(body.tools[0].function.name).toBe('express');
    expect(reply.message.content).toBe('Hi!');
    expect(reply.message.tool_calls?.[0]?.function.name).toBe('express');
    expect(reply.finishReason).toBe('tool_calls');
    expect(reply.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it('goes through a proxy without a key, and can make the model call a given tool', async () => {
    const { fn, requests } = fakeFetch([completion({ content: 'ok' })]);
    await new OpenRouterModel({ baseUrl: '/api/openrouter/', fetch: fn }).complete({ messages: [{ role: 'user', content: 'x' }], tools: [EXPRESS_TOOL], toolChoice: 'express' });
    expect(requests[0]!.url).toBe('/api/openrouter/chat/completions');
    expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(requests[0]!.init.body)).tool_choice).toEqual({ type: 'function', function: { name: 'express' } });
  });

  it('retries once on a rate limit, then gives a clear error without the key', async () => {
    const ok = fakeFetch([new Response('slow down', { status: 429 }), completion({ content: 'second time lucky' })]);
    expect((await new OpenRouterModel({ apiKey: KEY, fetch: ok.fn }).complete({ messages: [] })).message.content).toBe('second time lucky');
    const bad = fakeFetch([new Response(`invalid key ${KEY}`, { status: 401 })]);
    const error = await new OpenRouterModel({ apiKey: KEY, fetch: bad.fn }).complete({ messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).status).toBe(401);
    expect((error as ModelError).message).not.toContain(KEY);
  });

  it('times out instead of hanging', async () => {
    const hang = fakeFetch([(_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))]);
    const error = await new OpenRouterModel({ apiKey: KEY, fetch: hang.fn, timeoutMs: 30 }).complete({ messages: [] }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/took longer than/);
  });
});

describe('KlipyClient', () => {
  it('searches with the key and safe settings, preferring video, skipping results without media', async () => {
    const results = klipyResults(2);
    (results.results as unknown[]).push({ id: 'empty', media_formats: {} });
    const { fn, requests } = fakeFetch([json(results, 200, { 'x-ratelimit-remaining': '97' })]);
    const klipy = new KlipyClient({ apiKey: KEY, fetch: fn });
    const gifs = await klipy.search('  High   Five ');
    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.klipy.com/v2/search');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: 'high five', key: KEY, contentfilter: 'high', media_filter: 'mp4,mediumgif,gif' });
    expect(gifs).toHaveLength(2);
    expect(gifs[0]).toEqual({ id: 'g0', title: 'gif 0', mp4: 'https://static.klipy.com/0.mp4', gif: 'https://static.klipy.com/0.gif', width: 640, height: 414 });
    expect(klipy.remaining).toBe(89); // its own budget (90) minus one; the server has 97 left
  });

  it('answers repeated searches from its cache and saves it', async () => {
    const saved: Record<string, CachedSearch>[] = [];
    const store = { load: () => null, save: (data: Record<string, CachedSearch>) => saved.push(data) };
    const { fn, requests } = fakeFetch([json(klipyResults(3))]);
    const klipy = new KlipyClient({ apiKey: KEY, fetch: fn, store });
    await klipy.search('cute cat');
    expect(await klipy.search('Cute  CAT')).toHaveLength(3);
    expect(requests).toHaveLength(1);
    expect(Object.keys(saved[0]!)).toEqual(['cute cat']);
    const again = new KlipyClient({ apiKey: KEY, fetch: fakeFetch([]).fn, store: { load: () => saved[0]!, save: () => undefined } });
    expect(await again.search('cute cat')).toHaveLength(3);
  });

  it('stops at its hourly budget, and when the server says it is out', async () => {
    let now = 0;
    const { fn } = fakeFetch([json(klipyResults(1)), json(klipyResults(1)), json(klipyResults(1)), json(klipyResults(1), 200, { 'x-ratelimit-remaining': '0' })]);
    const klipy = new KlipyClient({ apiKey: KEY, fetch: fn, perHour: 2, now: () => now });
    await klipy.search('a');
    await klipy.search('b');
    await expect(klipy.search('c')).rejects.toBeInstanceOf(GifBudgetError);
    now += 3600_001;
    await klipy.search('c');
    await klipy.search('d'); // the server now reports 0 left
    await expect(klipy.search('e')).rejects.toBeInstanceOf(GifBudgetError);
  });
});

/** Records what the brain does with the body. */
function fakeBody() {
  const log: string[] = [];
  const states: CharacterState[] = [];
  const gifs: Gif[] = [];
  const body: BrainBody = {
    setState: (s) => {
      states.push(s);
      log.push(`state:${s}`);
    },
    express: (name, intensity) => log.push(`express:${name}:${intensity}`),
    showGif: async (gif) => {
      gifs.push(gif);
      log.push(`gif:${gif.id}`);
    },
    say: async (text, voice, signal) => {
      log.push(`say${voice ? '' : '(caption)'}:${text}${signal ? '' : ' (no signal)'}`);
    },
  };
  return { body, log, states, gifs };
}

/** A model that answers from a list of replies. */
function listModel(replies: (Partial<ChatReply['message']> | Error)[], requests: ChatRequest[] = []): ChatModel {
  return {
    name: 'list',
    complete: async (request) => {
      requests.push(request);
      const next = replies.shift();
      if (!next) throw new Error('no more replies');
      if (next instanceof Error) throw next;
      return { message: { role: 'assistant', content: null, ...next }, finishReason: 'stop' };
    },
  };
}

describe('Brain', () => {
  it('with the voice on: thinks, expresses, speaks, then rests, remembering the exchange', async () => {
    const { body, log } = fakeBody();
    const brain = new Brain({ model: new ScriptedModel({ random: () => 0 }), body, voice: true });
    const turn = await brain.hear('Hello Peeqo!');
    expect(turn.expressions).toEqual(['hello']);
    expect(log).toEqual(['state:thinking', 'express:hello:1', 'state:speaking', `say:${turn.reply}`, 'state:idle']);
    expect(brain.history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('finds and shows a GIF when the model asks for one', async () => {
    const { body, log, gifs } = fakeBody();
    const klipy = new KlipyClient({ apiKey: KEY, fetch: fakeFetch([json(klipyResults(6))]).fn });
    const brain = new Brain({ model: new ScriptedModel({ random: () => 0 }), body, gifs: klipy, random: () => 0.99 });
    const turn = await brain.hear('show me a cat');
    expect(turn.gif?.id).toBe('g4'); // one of the best five
    expect(gifs).toHaveLength(1);
    expect(log.slice(-3)).toEqual(['gif:g4', 'state:idle', 'say(caption):Cat!!']); // the GIF, then its caption over it
  });

  it('answers in GIFs by default: a GIF every turn with a caption over it, and no talking', async () => {
    const { body, log } = fakeBody();
    const requests: ChatRequest[] = [];
    const klipy = new KlipyClient({ apiKey: KEY, fetch: fakeFetch([json(klipyResults(3)), json(klipyResults(3))]).fn });
    const reply = (id: string, args: Record<string, unknown>) => ({ tool_calls: [{ id, type: 'function' as const, function: { name: 'respond', arguments: JSON.stringify(args) } }] });
    const model = listModel([reply('a', { expressions: ['excited'], gif: 'high five', say: 'You did it!' }), reply('b', { expressions: ['laugh'], gif: 'ba dum tss', say: '' })], requests);
    const brain = new Brain({ model, body, gifs: klipy, random: () => 0 });
    expect(brain.voice).toBe(false);
    await brain.hear('I passed my exam!');
    const respond = requests[0]!.tools![0]!.function.parameters as { required: string[] };
    expect(respond.required).toEqual(['expressions', 'gif', 'say']);
    expect(requests[0]!.messages[0]!.content).toMatch(/You don't talk: you answer with GIFs/);
    expect(log).toEqual(['state:thinking', 'express:excited:1', 'gif:g0', 'state:idle', 'say(caption):You did it!']);
    // A GIF alone is a whole answer: no caption, and no second call to ask for words.
    log.length = 0;
    const turn = await brain.hear('tell me a joke');
    expect(requests).toHaveLength(2);
    expect(turn.reply).toBe('');
    expect(log).toEqual(['state:thinking', 'express:laugh:1', 'gif:g0', 'state:idle']);
  });

  it('announces with a GIF when answering in GIFs, and a new turn cuts the announcement short', async () => {
    const log: string[] = [];
    let stopped = 0;
    const body: BrainBody = {
      setState: (s) => log.push(`state:${s}`),
      express: (name) => log.push(`express:${name}`),
      showGif: async (gif) => void log.push(`gif:${gif.id}`),
      // Stays up until the signal says to stop.
      say: (text, _voice, signal) =>
        new Promise<void>((resolve) => {
          log.push(`caption:${text}`);
          signal?.addEventListener('abort', () => {
            stopped++;
            resolve();
          });
        }),
    };
    const klipy = new KlipyClient({ apiKey: KEY, fetch: fakeFetch([json(klipyResults(2))]).fn });
    const brain = new Brain({ model: new ScriptedModel({ random: () => 0 }), body, gifs: klipy, random: () => 0 });
    const announced = brain.announce('Ding! Your pasta timer is done!', { gif: 'times up' });
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(['express:alert', 'gif:g0', 'state:idle', 'caption:Ding! Your pasta timer is done!']);
    const turn = brain.hear('thanks!');
    await announced;
    expect(stopped).toBe(1);
    expect(log[4]).toBe('state:thinking'); // the new turn, straight after the cut-short announcement
    brain.interrupt(); // (the turn's own caption would otherwise wait for a signal forever)
    await turn;
  });

  it('answers in one round trip, playing a second expression once the first has had its moment', async () => {
    vi.useFakeTimers();
    try {
      const { body, log } = fakeBody();
      const requests: ChatRequest[] = [];
      const respond = { id: 'r1', type: 'function' as const, function: { name: 'respond', arguments: JSON.stringify({ expressions: ['surprised', 'happy', 'moonwalk'], intensity: 0.6, say: 'Whoa, really?' }) } };
      const brain = new Brain({ model: listModel([{ tool_calls: [respond] }], requests), body });
      const turn = await brain.hear('I won!');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.tools?.map((t) => t.function.name)).toEqual(['respond']);
      expect(turn.reply).toBe('Whoa, really?');
      expect(log.filter((l) => l.startsWith('express:'))).toEqual(['express:surprised:0.6']);
      vi.advanceTimersByTime(1700);
      expect(log.filter((l) => l.startsWith('express:'))).toEqual(['express:surprised:0.6', 'express:happy:0.6']);
      expect(brain.history.at(-1)).toEqual({ role: 'tool', tool_call_id: 'r1', content: 'done, except: there is no expression called "moonwalk"' });
      // A second expression still waiting when the next turn starts is dropped, not played over it.
      const again = { ...respond, id: 'r2' };
      const brain2 = new Brain({ model: listModel([{ tool_calls: [again] }, { content: 'Next!' }]), body });
      await brain2.hear('one');
      const before = log.filter((l) => l === 'express:happy:0.6').length;
      await brain2.hear('two');
      vi.advanceTimersByTime(5000);
      expect(log.filter((l) => l === 'express:happy:0.6').length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again for words when a reply only used tools', async () => {
    const { body, log } = fakeBody();
    const requests: ChatRequest[] = [];
    const model = listModel([{ tool_calls: [{ id: 't1', type: 'function', function: { name: 'express', arguments: '{"expression":"surprised","intensity":0.5}' } }] }, { content: 'Whoa!' }], requests);
    const turn = await new Brain({ model, body }).hear('guess what');
    expect(turn.reply).toBe('Whoa!');
    expect(log).toContain('express:surprised:0.5');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 't1', content: 'done' });
  });

  it('reports bad tool calls back to the model instead of acting on them', async () => {
    const { body, log } = fakeBody();
    const requests: ChatRequest[] = [];
    const model = listModel(
      [
        {
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'express', arguments: '{"expression":"moonwalk"}' } },
            { id: 'b', type: 'function', function: { name: 'express', arguments: 'not json' } },
            { id: 'c', type: 'function', function: { name: 'launch_rocket', arguments: '{}' } },
            { id: 'd', type: 'function', function: { name: 'show_gif', arguments: '{"query":"x"}' } },
          ],
        },
        { content: 'Never mind!' },
      ],
      requests,
    );
    await new Brain({ model, body }).hear('do something');
    expect(log.some((l) => l.startsWith('express:'))).toBe(false);
    const results = requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(results).toEqual([
      'error: there is no expression called "moonwalk"',
      'error: the arguments were not valid JSON',
      'error: there is no tool called "launch_rocket"',
      'error: GIFs are not available right now',
    ]);
  });

  it('recovers from a model failure with an oops', async () => {
    const { body, log } = fakeBody();
    const brain = new Brain({ model: listModel([new ModelError('service down', 503)]), body, voice: true });
    const turn = await brain.hear('hello?');
    expect(turn.error).toBe('service down');
    expect(log).toEqual(['state:thinking', 'express:oops:0.8', 'state:speaking', 'say:Oops, my thoughts got tangled. Try me again?', 'state:idle']);
    expect(brain.history).toHaveLength(0);
    const quiet = fakeBody();
    await new Brain({ model: listModel([new ModelError('service down', 503)]), body: quiet.body }).hear('hello?');
    expect(quiet.log).toEqual(['state:thinking', 'express:oops:0.8', 'state:idle', 'say(caption):Oops!']);
  });

  it('lets a new turn cut in on one still thinking', async () => {
    const { body, states } = fakeBody();
    const slow = new ScriptedModel({ delayMs: 200, random: () => 0 });
    const brain = new Brain({ model: slow, body });
    const first = brain.hear('tell me a joke');
    await new Promise((r) => setTimeout(r, 20));
    const second = await brain.hear('hello');
    expect((await first).interrupted).toBe(true);
    expect(second.expressions).toEqual(['hello']);
    expect(states.at(-1)).toBe('idle');
    expect(brain.history.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['hello']);
  });

  it('pays attention when someone starts talking, and relaxes if they say nothing', async () => {
    const { body, states } = fakeBody();
    const brain = new Brain({ model: new ScriptedModel({ delayMs: 50, random: () => 0 }), body });
    brain.attend();
    brain.dismiss();
    expect(states).toEqual(['listening', 'idle']);
    const turn = brain.hear('hello');
    brain.attend(); // the mic opens mid-turn: Peeqo drops the turn and listens
    expect((await turn).interrupted).toBe(true);
    expect(states).toEqual(['listening', 'idle', 'thinking', 'listening']);
    brain.dismiss();
    expect(states.at(-1)).toBe('idle');
  });

  it('never shows the GIF of a turn that was cut off', async () => {
    const { log } = fakeBody();
    let release: () => void = () => undefined;
    const slowBody: BrainBody = {
      setState: (s) => log.push(`state:${s}`),
      express: (name) => log.push(`express:${name}`),
      // The GIF takes a while to load; it must not appear if the turn was abandoned meanwhile.
      showGif: async (gif, signal) => {
        await new Promise<void>((r) => (release = r));
        if (!signal?.aborted) log.push(`gif:${gif.id}`);
      },
      say: async () => undefined,
    };
    const klipy = new KlipyClient({ apiKey: KEY, fetch: fakeFetch([json(klipyResults(3))]).fn });
    const brain = new Brain({ model: new ScriptedModel({ random: () => 0 }), body: slowBody, gifs: klipy });
    const turn = brain.hear('show me a cat');
    await new Promise((r) => setTimeout(r, 20)); // the GIF is loading
    brain.attend();
    release();
    expect((await turn).interrupted).toBe(true);
    expect(log.some((l) => l.startsWith('gif:'))).toBe(false);
  });

  it('remembers only the last few exchanges, cutting at a turn', async () => {
    const { body } = fakeBody();
    const brain = new Brain({ model: new ScriptedModel({ random: () => 0 }), body, memory: 2 });
    for (const text of ['hello', 'tell me a joke', 'thanks', 'bye']) await brain.hear(text);
    const users = brain.history.filter((m) => m.role === 'user').map((m) => m.content);
    expect(users).toEqual(['thanks', 'bye']);
    expect(brain.history[0]!.role).toBe('user');
  });

  it('answers in short captions when it cannot speak', async () => {
    const { body, log } = fakeBody();
    const requests: ChatRequest[] = [];
    const model = listModel([{ content: 'Yay!' }], requests);
    const brain = new Brain({ model, body, voice: false });
    await brain.hear('hi');
    expect(requests[0]!.messages[0]!.content).toMatch(/cannot speak right now/);
    expect(log).toContain('say(caption):Yay!');
  });
});

describe('persona and the offline stand-in', () => {
  it('offers exactly the character’s expressions, and knows the time', () => {
    const params = EXPRESS_TOOL.function.parameters as { properties: { expression: { enum: readonly ExpressionName[] } } };
    expect(params.properties.expression.enum).toEqual(EXPRESSION_NAMES);
    const respond = respondTool(true).function.parameters as { properties: Record<string, { items?: { enum: readonly string[] } }> };
    expect(respond.properties.expressions!.items!.enum).toEqual(EXPRESSION_NAMES);
    expect('gif' in respond.properties).toBe(true);
    expect('gif' in (respondTool(false).function.parameters as { properties: object }).properties).toBe(false);
    expect((respondTool(true).function.parameters as { required: string[] }).required).toEqual(['expressions', 'say']);
    expect((respondTool(true, false).function.parameters as { required: string[] }).required).toEqual(['expressions', 'gif', 'say']);
    const prompt = systemPrompt({ now: new Date(2026, 9, 3, 21, 41), voice: true, gifs: true });
    expect(prompt).toMatch(/You are Peeqo/);
    expect(prompt).toMatch(/9:41/);
    expect(prompt).toMatch(/A GIF shows on your face screen/);
    expect(systemPrompt({ now: new Date(), voice: true, gifs: false })).not.toMatch(/GIF/);
    expect(systemPrompt({ now: new Date(), voice: false, gifs: true })).toMatch(/Captions are at most six words/);
    expect(systemPrompt({ now: new Date(), voice: false, gifs: false })).toMatch(/cannot speak right now/);
  });

  it('answers in GIFs offline too: every answer has a GIF and a caption of at most six words', async () => {
    const requests: ChatRequest[] = [];
    const model = new ScriptedModel({ random: () => 0 });
    const tools = [respondTool(true, false)];
    const ask = async (heard: string) => {
      const request: ChatRequest = { messages: [{ role: 'system', content: 'It is Saturday, October 3, 9:41 PM.' }, { role: 'user', content: heard }], tools };
      requests.push(request);
      const reply = await model.complete(request);
      return JSON.parse(reply.message.tool_calls![0]!.function.arguments) as { gif: string; say: string };
    };
    const inputs = ['hello', 'who are you', 'tell me a joke', 'what time is it', 'what is 6 x 7', 'I love you', 'bad day', 'good night', 'bye', 'thanks', 'how are you', 'boo!', 'guess what', 'coffee?', 'so bored', 'big deadline', 'secret', 'I did it!', 'idea', 'ok', 'nope', 'zebras', 'birthday', 'dance', 'cat', 'puppy', 'you are useless', 'who made you'];
    for (const heard of inputs) {
      const answer = await ask(heard);
      expect(answer.gif, heard).toMatch(/\w/);
      expect(answer.say.split(/\s+/).length, `${heard}: ${answer.say}`).toBeLessThanOrEqual(6);
    }
    expect((await ask('what time is it')).say).toBe("It's 9:41 PM.");
    expect((await ask('what is 6 x 7')).say).toBe("That's 42!");
  });

  it('does sums, tells the time and falls back gracefully', async () => {
    const { body } = fakeBody();
    const brain = new Brain({ model: new ScriptedModel({ random: () => 0 }), body, now: () => new Date(2026, 9, 3, 21, 41) });
    expect((await brain.hear('what is 12 + 30?')).reply).toMatch(/42/);
    expect((await brain.hear('what time is it?')).reply).toMatch(/9:41/);
    const unknown = await brain.hear('explain quantum chromodynamics');
    expect(unknown.expressions).toEqual(['curious']);
  });

  it('only asks for GIFs when they are available', async () => {
    const reply = await new ScriptedModel({ random: () => 0 }).complete({ messages: [{ role: 'user', content: 'a cat please' }], tools: [EXPRESS_TOOL] });
    expect(reply.message.tool_calls?.map((c) => c.function.name)).toEqual(['express']);
  });
});
