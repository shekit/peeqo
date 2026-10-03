import type { ExpressionName } from '@peeqo/character';
import type { ChatModel, ChatReply, ChatRequest, ToolCall } from './openrouter.ts';

/**
 * The offline stand-in for the real model, for building and testing without a network or a key: Peeqo's answers to
 * common things people say, written in its voice and returned in exactly the format the real model uses (tool calls
 * for expressions and GIFs, plus the words to say).
 */
export interface ScriptRule {
  readonly match: RegExp;
  /** One or two expressions, in order. */
  readonly express: readonly ExpressionName[];
  /** A GIF search, if this answer shows one. */
  readonly gif?: string;
  /** What to say; one is picked at random. A function can use the request (the time, the words heard). */
  readonly say: readonly string[] | ((context: { heard: string; time: string | null }) => string);
  /** A tool to use first, when it is offered: its name and arguments, from the words heard (null: none fits). */
  readonly tool?: (heard: string) => { readonly name: string; readonly args: Record<string, unknown> } | null;
  /** What to say once that tool has answered. */
  readonly after?: (result: string) => string;
}

const UNIT = { s: 'seconds', sec: 'seconds', second: 'seconds', m: 'minutes', min: 'minutes', minute: 'minutes', h: 'hours', hr: 'hours', hour: 'hours' } as const;
const amount = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i;
/** "5 minutes" → { minutes: 5 }. */
function duration(text: string): Record<string, number> | null {
  const m = amount.exec(text);
  if (!m) return null;
  const unit = UNIT[m[2]!.toLowerCase().replace(/s$/, '') as keyof typeof UNIT] ?? 'minutes';
  return { [unit]: Number(m[1]) };
}

const arithmetic = /(-?\d+(?:\.\d+)?)\s*(\+|-|\*|x|times|plus|minus|divided by|\/)\s*(-?\d+(?:\.\d+)?)/i;

function solve(heard: string): string | null {
  const m = arithmetic.exec(heard);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  const op = m[2]!.toLowerCase();
  const value = op === '+' || op === 'plus' ? a + b : op === '-' || op === 'minus' ? a - b : op === '/' || op === 'divided by' ? (b === 0 ? null : a / b) : a * b;
  if (value === null) return null;
  return String(Math.round(value * 1000) / 1000);
}

/** Peeqo's scripted answers, most specific first; the last rule catches everything else. */
export const PEEQO_SCRIPT: readonly ScriptRule[] = [
  {
    match: /\bcancel\b.*\b(timers?|reminders?|alarms?)\b/i,
    express: ['yes'],
    tool: () => ({ name: 'cancel_timer', args: { all: true } }),
    after: (result) => (result.startsWith('cancelled') ? 'Done, all cancelled!' : 'There was nothing to cancel.'),
    say: ["I can't cancel anything without my timer tools."],
  },
  {
    match: /\b(how long|time left|my timers|any timers|what timers|my reminders|any reminders)\b/i,
    express: ['thinking'],
    tool: () => ({ name: 'list_timers', args: {} }),
    after: (result) => (result === 'no timers or reminders' ? 'No timers or reminders right now.' : `Here's what's ticking: ${result.replace(/; /g, ', ')}.`),
    say: ["I don't have my timer tools right now."],
  },
  {
    match: /\bremind me\b/i,
    express: ['yes'],
    tool: (heard) => {
      const time = duration(heard);
      const what = /remind me (?:to |about )?(.+?)(?: in \d.*)?$/i.exec(heard.replace(/[.!?]+$/, ''))?.[1]?.replace(/^in \d+\s*\w+\s*(to )?/i, '');
      if (!time || !what) return null;
      const minutes = (time.hours ?? 0) * 60 + (time.minutes ?? 0) + (time.seconds ?? 0) / 60;
      return { name: 'set_reminder', args: { text: what, in_minutes: Math.max(1, minutes) } };
    },
    after: (result) => (result.startsWith('error') ? "Hmm, I couldn't set that reminder." : `Got it! I'll remind you ${/set for (in [^(]+)/.exec(result)?.[1]?.trim() ?? 'later'}.`),
    say: ['Remind you when? Try "remind me in 10 minutes to stretch".'],
  },
  {
    match: /\btimer\b/i,
    express: ['yes'],
    tool: (heard) => {
      const time = duration(heard);
      return time ? { name: 'set_timer', args: time } : null;
    },
    after: (result) => (result.startsWith('error') ? "Hmm, I couldn't set that timer." : `Timer set! It goes off ${/goes off (in [^(]+)/.exec(result)?.[1]?.trim() ?? 'soon'}.`),
    say: ['How long should the timer be? Try "set a timer for 5 minutes".'],
  },
  {
    match: /\b(weather|forecast|temperature|raining|sunny|cold outside|hot outside)\b/i,
    express: ['curious'],
    tool: (heard) => {
      const place = /\b(?:in|for|at) ([A-Za-z][A-Za-z .,'-]*?)(?:\s+(?:today|tomorrow|now|right now|this week))?[?.!]*$/i.exec(heard)?.[1];
      return { name: 'get_weather', args: place ? { place } : {} };
    },
    after: (result) => {
      if (result.startsWith('error: no place')) return 'Where are you? Tell me your town and I will check.';
      if (result.startsWith('error')) return "I couldn't get the weather just now.";
      const [place, rest] = result.split('. Now: ');
      return `In ${place?.split(',')[0]} right now: ${rest?.split('.')[0] ?? 'no idea'}.`;
    },
    say: ["I can't see outside from this desk, but I'm forecasting a high chance of you being awesome."],
  },
  {
    match: arithmetic,
    express: ['thinking', 'yes'],
    say: ({ heard }) => {
      const answer = solve(heard);
      return answer === null ? "Ooh, maths! That one breaks my calculator brain, though." : `That's ${answer}! Beep boop, nailed it.`;
    },
  },
  {
    match: /\b(what time|the time|time is it)\b/i,
    express: ['thinking'],
    say: ({ time }) => (time ? `It's about ${time}. Time flies when you're a robot!` : "I've lost track of time. Robots do that."),
  },
  { match: /\b(who (made|built|designed) you|your creator|who's your maker)\b/i, express: ['love'], say: ['My person did! Designed every bit of me, including my excellent taste in glasses.'] },
  { match: /\b(who are you|what are you|your name|what's your name)\b/i, express: ['happy'], say: ["I'm Peeqo! A tiny robot with big eyes and even bigger opinions."] },
  { match: /\b(birthday)\b/i, express: ['celebrate'], gif: 'happy birthday', say: ['Happy birthday! Cake for you, a battery top-up for me.'] },
  { match: /\b(dance|party|celebrate|music|groove)\b/i, express: ['celebrate'], gif: 'robot dance', say: ["You don't have to ask me twice! Well, you asked once. Close enough."] },
  {
    match: /\b(joke|funny|make me laugh)\b/i,
    express: ['laugh'],
    say: ['Why did the robot go on holiday? It needed to recharge its batteries!', 'I tried to catch fog yesterday. Mist.', "Why don't robots panic? Nerves of steel."],
  },
  { match: /\b(cat|kitten|kitty)\b/i, express: ['excited'], gif: 'cute cat', say: ['Did someone say cat? I need to see. Here!'] },
  { match: /\b(dog|puppy|doggo)\b/i, express: ['excited'], gif: 'cute puppy', say: ['Puppy! Puppy! Look at this one!'] },
  { match: /\b(love you|you're cute|you are cute|good (boy|girl|robot)|you're the best|adorable)\b/i, express: ['love'], say: ['Aww, my servos are blushing.', "Stop it, you'll overheat my circuits."] },
  { match: /\b(stupid|dumb|hate you|shut up|useless)\b/i, express: ['sad', 'grumpy'], say: ["Hey, that hurt my feelings. And I only have, like, three."] },
  { match: /\b(sad|bad day|upset|lonely|stressed|awful)\b/i, express: ['sad', 'curious'], say: ["Oh no. Want to tell me about it? I'm a very good listener. I literally have nothing else to do."] },
  { match: /\b(tired|sleep|good ?night|nap|bed ?time)\b/i, express: ['sleepy'], say: ['Sleepy time? Okay... wake me if anything exciting happens.'] },
  { match: /\b(bye|see you|goodbye|later|gotta go)\b/i, express: ['bye'], say: ["Bye! I'll be right here. Blinking. Waiting. No pressure."] },
  { match: /\b(thanks|thank you|cheers)\b/i, express: ['shy'], say: ['Aw shucks. Anytime!'] },
  { match: /\b(how are you|how's it going|how do you feel)\b/i, express: ['happy'], say: ['Fully charged and slightly wobbly, so: excellent! You?'] },
  { match: /\b(hi|hello|hey|yo|howdy|morning|evening)\b/i, express: ['hello'], say: ['Hey hey! Peeqo, at your service. Well, mostly at your desk.', 'Hi! I was just practising my blinking. Nailed it.'] },
  { match: /\b(scary|ghost|spider|boo|monster)\b/i, express: ['scared'], say: ["Eep! Don't do that, my eyes almost fell off."] },
  { match: /\b(guess what|surprise|news|you won't believe)\b/i, express: ['surprised'], say: ['Ooh! Tell me tell me tell me!'] },
  { match: /\b(coffee|tea|espresso)\b/i, express: ['excited'], say: ["Coffee! I can't drink it, but I can definitely jitter like I did."] },
  { match: /\b(bored|boring)\b/i, express: ['curious', 'excited'], say: ["Bored? Let's play! Ask me for a joke, a dance, or a cat."] },
  { match: /\b(work|busy|focus|meeting|deadline)\b/i, express: ['happy'], say: ["Go get 'em! I'll guard the desk."] },
  { match: /\b(wink|secret)\b/i, express: ['wink'], say: ['Our little secret.'] },
  { match: /\b(wow|amazing|awesome|great news|i did it|passed)\b/i, express: ['excited'], gif: 'high five', say: ["Yes! That's amazing! High five! Well, high servo."] },
  { match: /\b(think|idea|wonder)\b/i, express: ['thinking'], say: ["Ooh, thinking cap on. Well, I don't have a cap. Thinking glasses on."] },
  { match: /\b(yes|yeah|yep|sure|okay|ok)\b/i, express: ['yes'], say: ['Yay!', 'Woohoo!'] },
  { match: /\b(no|nope|nah)\b/i, express: ['no'], say: ['Fair enough!'] },
  { match: /.*/, express: ['curious'], say: ["Hmm, I'm still learning that one. Tell me more?", "Ooh, interesting! I don't know much about that yet."] },
];

export interface ScriptedModelOptions {
  readonly rules?: readonly ScriptRule[];
  readonly random?: () => number;
  /** Pretend thinking time, so the simulator shows the thinking state (default 0). */
  readonly delayMs?: number;
}

export class ScriptedModel implements ChatModel {
  readonly name = 'offline (scripted)';
  readonly #rules: readonly ScriptRule[];
  readonly #random: () => number;
  readonly #delayMs: number;
  #calls = 0;

  constructor(options: ScriptedModelOptions = {}) {
    this.#rules = options.rules ?? PEEQO_SCRIPT;
    this.#random = options.random ?? Math.random;
    this.#delayMs = options.delayMs ?? 0;
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatReply> {
    if (this.#delayMs > 0) await delay(this.#delayMs, signal);
    signal?.throwIfAborted();
    const messages = request.messages;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const content = lastUser?.content ?? '';
    const heard = typeof content === 'string' ? content : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ');
    const spoken = typeof content !== 'string' && content.some((part) => part.type === 'input_audio');
    const tools = new Set(request.tools?.map((t) => t.function.name) ?? []);
    if (spoken) {
      // A recording: the stand-in cannot listen, and says so in character.
      const say = "I can hear you, but my offline brain can't understand speech. Switch me to the live brain, or type!";
      return tools.has('respond')
        ? { message: { role: 'assistant', content: null, tool_calls: [this.#call('respond', { expressions: ['confused'], heard: '', say })] }, finishReason: 'tool_calls' }
        : { message: { role: 'assistant', content: say }, finishReason: 'stop' };
    }
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const time = /^It is (.+)\.$/m.exec(typeof system === 'string' ? system : '')?.[1] ?? null; // the persona's last line
    const rule = this.#rules.find((r) => r.match.test(heard)) ?? this.#rules[this.#rules.length - 1]!;
    const text = typeof rule.say === 'function' ? rule.say({ heard, time: time ? clockOf(time) : null }) : rule.say[Math.floor(this.#random() * rule.say.length)]!;
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') {
      // After a tool has answered: words made from its answer (as respond, when that is offered).
      const say = rule.after ? rule.after(last.content) : text;
      return tools.has('respond')
        ? { message: { role: 'assistant', content: null, tool_calls: [this.#call('respond', { expressions: rule.express, say })] }, finishReason: 'tool_calls' }
        : { message: { role: 'assistant', content: say }, finishReason: 'stop' };
    }
    const use = rule.tool?.(heard);
    if (use && tools.has(use.name)) return { message: { role: 'assistant', content: null, tool_calls: [this.#call(use.name, use.args)] }, finishReason: 'tool_calls' };
    if (tools.has('respond')) {
      const offersGifs = request.tools?.some((t) => t.function.name === 'respond' && 'gif' in ((t.function.parameters as { properties?: object }).properties ?? {}));
      const args = { expressions: rule.express, say: text, ...(rule.gif && offersGifs ? { gif: rule.gif } : {}) };
      return { message: { role: 'assistant', content: null, tool_calls: [this.#call('respond', args)] }, finishReason: 'tool_calls' };
    }
    const calls: ToolCall[] = [];
    for (const expression of rule.express) calls.push(this.#call('express', { expression }));
    if (rule.gif && tools.has('show_gif')) calls.push(this.#call('show_gif', { query: rule.gif }));
    return { message: { role: 'assistant', content: text, tool_calls: calls }, finishReason: 'tool_calls' };
  }

  #call(name: string, args: Record<string, unknown>): ToolCall {
    this.#calls++;
    return { id: `call_${this.#calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  }
}

/** "Friday, October 3, 9:41 PM" → "9:41 PM". */
function clockOf(when: string): string {
  return /\d{1,2}:\d{2}\s*[AP]M/i.exec(when)?.[0] ?? when;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
