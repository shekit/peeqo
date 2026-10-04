import type { ExpressionName } from '@peeqo/character';
import type { ChatModel, ChatReply, ChatRequest, ToolCall } from './openrouter.ts';

/**
 * The offline stand-in for the real model, for building and testing without a network or a key: Peeqo's answers to
 * common things people say, written in its voice and returned in exactly the format the real model uses (tool calls
 * for expressions and GIFs, plus the words to say). When Peeqo does not talk, the words are a short caption; when it
 * answers in GIFs (the respond tool requires one), every answer has a GIF too.
 */
/** What a rule's answer can use: the words heard, the time, and what Peeqo remembers about them. */
interface ScriptContext {
  readonly heard: string;
  readonly time: string | null;
  readonly facts: readonly string[];
}
type Lines = readonly string[] | ((context: ScriptContext) => string);

export interface ScriptRule {
  readonly match: RegExp;
  /** One or two expressions, in order. */
  readonly express: readonly ExpressionName[];
  /** A GIF search for this answer (with the voice on, only answers that have one show a GIF). */
  readonly gif?: string;
  /** Answering in GIFs, the GIF to use when there is no `gif` (default: one for the first expression). */
  readonly reaction?: string;
  /** What to say; one is picked at random. A function can use the request (the time, the words heard). */
  readonly say: Lines;
  /** Not talking, the caption instead (at most six words; default: the first sentence of `say`). */
  readonly caption?: Lines;
  /** A tool to use first, when it is offered: its name and arguments, from the words heard (null: none fits). */
  readonly tool?: (heard: string, context: ScriptContext) => { readonly name: string; readonly args: Record<string, unknown> } | null;
  /** What to say once that tool has answered. */
  readonly after?: (result: string) => string;
  /** Not talking, the caption (default: `after`); answering in GIFs, the GIF (default: as above): once the tool has answered. */
  readonly afterCaption?: (result: string) => string;
  readonly afterGif?: (result: string) => string;
}

/** A GIF for each expression, for answers without one of their own. */
export const EXPRESSION_GIFS: Readonly<Record<ExpressionName, string>> = {
  happy: 'happy dance',
  excited: 'so excited',
  laugh: 'laughing',
  love: 'heart eyes',
  sad: 'sad puppy',
  grumpy: 'grumpy cat',
  surprised: 'shocked',
  scared: 'scared',
  sleepy: 'sleepy',
  curious: 'curious',
  confused: 'confused',
  thinking: 'thinking hard',
  yes: 'thumbs up',
  no: 'nope',
  hello: 'hello wave',
  bye: 'bye bye',
  shy: 'blushing',
  wink: 'wink',
  celebrate: 'celebration',
  alert: 'alarm clock',
  oops: 'oops',
  sigh: 'sigh',
  wonder: 'mind blown',
};

/** A remembered fact matching `pattern`, and its first captured part ("Lives in (.+)" → the place). */
function recall(facts: readonly string[], pattern: RegExp): string | null {
  for (const fact of facts) {
    const m = pattern.exec(fact);
    if (m) return (m[1] ?? m[0]).replace(/[.!]+$/, '').trim();
  }
  return null;
}
const LIVES_IN = /^Lives in (.+)$/i;
const NAME_IS = /^Their name is (.+)$/i;

/** "my sister is Priya" → "Their sister is Priya" (good enough for the stand-in). */
function aboutThem(text: string): string {
  const swapped = text
    .replace(/\bI am\b|\bI'm\b/gi, 'they are')
    .replace(/\bI\b/g, 'they')
    .replace(/\bmy\b/gi, 'their')
    .replace(/\bme\b/gi, 'them')
    .replace(/[.!?]+$/, '')
    .trim();
  return `${swapped.charAt(0).toUpperCase()}${swapped.slice(1)}.`;
}

/** The weather report's place and conditions now, for a caption and a GIF. */
function weatherNow(result: string): { place: string; now: string } {
  const [place, rest] = result.split('. Now: ');
  return { place: place?.split(',')[0] ?? '', now: rest?.split('.')[0] ?? '' };
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
    match: /\bforget (everything|all|that|about|my|where|what)\b/i,
    express: ['yes'],
    tool: (heard, { facts }) => {
      if (/\bforget (everything|all)\b/i.test(heard)) return { name: 'forget', args: { all: true } };
      if (/\bwhere i live\b/i.test(heard)) return { name: 'forget', args: { fact: facts.find((f) => LIVES_IN.test(f)) ?? 'lives in' } };
      if (/\bmy name\b/i.test(heard)) return { name: 'forget', args: { fact: facts.find((f) => NAME_IS.test(f)) ?? 'name is' } };
      const what = /\bforget (?:that |about )?(.+)$/i.exec(heard.replace(/[.!?]+$/, ''))?.[1];
      return what ? { name: 'forget', args: { fact: aboutThem(what).replace(/\.$/, '') } } : null;
    },
    after: (result) => (result.startsWith('forgot') ? 'Done, forgotten.' : "I didn't remember that anyway."),
    say: ["I can't forget things without my memory."],
    reaction: 'forgetting',
    caption: ['No memory here!'],
  },
  {
    match: /\b(?:my name is|call me)\s+[\p{L}][\p{L}'-]*/iu,
    express: ['hello', 'happy'],
    tool: (heard, { facts }) => {
      const name = /\b(?:my name is|call me)\s+([\p{L}][\p{L}'-]*)/iu.exec(heard)?.[1];
      if (!name) return null;
      const proper = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      const old = facts.find((f) => NAME_IS.test(f));
      return { name: 'remember', args: { fact: `Their name is ${proper}.`, ...(old ? { replaces: old } : {}) } };
    },
    after: (result) => `Nice to meet you, ${[...result.matchAll(/name is ([^".]+)/g)].at(-1)?.[1] ?? 'friend'}!`, // (an update names the old one first)
    say: ['Nice to meet you!'],
    reaction: 'nice to meet you',
  },
  {
    match: /\bi (?:live|am living|moved|have moved) (?:in|to) [A-Za-z]/i,
    express: ['excited'],
    tool: (heard, { facts }) => {
      const place = /\bi (?:live|am living|moved|have moved) (?:in|to) ([A-Za-z][A-Za-z .,'-]*?)(?:\s+now)?[.!?]*$/i.exec(heard)?.[1];
      if (!place) return null;
      const old = facts.find((f) => LIVES_IN.test(f));
      return { name: 'remember', args: { fact: `Lives in ${place}.`, ...(old ? { replaces: old } : {}) } };
    },
    after: (result) => `${[...result.matchAll(/Lives in ([^".]+)/g)].at(-1)?.[1] ?? 'There'}! Noted.`,
    say: ['Ooh, nice place!'],
    reaction: 'home sweet home',
  },
  {
    match: /^(?!.*\b(do|did) you remember\b).*\bremember (?:that )?\S/i,
    express: ['yes'],
    tool: (heard) => {
      const what = /\bremember (?:that )?(.+)$/i.exec(heard)?.[1];
      return what ? { name: 'remember', args: { fact: aboutThem(what) } } : null;
    },
    after: (result) => (result.startsWith('error') ? "Hmm, I couldn't remember that." : "Got it, I'll remember!"),
    say: ["I'd love to remember that, but I have no memory right now."],
    reaction: 'noted',
    caption: ['No memory here!'],
  },
  {
    match: /\bwhat(?:'s| is) my name\b|\bwho am i\b/i,
    express: ['thinking', 'happy'],
    say: ({ facts }) => {
      const name = recall(facts, NAME_IS);
      return name ? `You're ${name}! I'd never forget.` : "You haven't told me yet! What should I call you?";
    },
    reaction: 'hello friend',
    caption: ({ facts }) => {
      const name = recall(facts, NAME_IS);
      return name ? `You're ${name}!` : "You haven't told me!";
    },
  },
  {
    match: /\bwhere do i live\b/i,
    express: ['thinking'],
    say: ({ facts }) => {
      const place = recall(facts, LIVES_IN);
      return place ? `In ${place}! I remember.` : "You haven't told me where you live yet.";
    },
    reaction: 'home',
    caption: ({ facts }) => {
      const place = recall(facts, LIVES_IN);
      return place ? `In ${place}!` : "You haven't told me!";
    },
  },
  {
    match: /\bwhat do you (?:know|remember) about me\b/i,
    express: ['thinking', 'happy'],
    say: ({ facts }) => (facts.length > 0 ? `I remember ${facts.length} things about you. Like this: ${facts[0]}` : 'Nothing yet! Tell me about yourself.'),
    reaction: 'i know',
    caption: ({ facts }) => (facts.length > 0 ? `${facts.length} things. Like: ${facts[0]}` : 'Nothing yet!'),
  },
  {
    match: /\bcancel\b.*\b(timers?|reminders?|alarms?)\b/i,
    express: ['yes'],
    tool: () => ({ name: 'cancel_timer', args: { all: true } }),
    after: (result) => (result.startsWith('cancelled') ? 'Done, all cancelled!' : 'There was nothing to cancel.'),
    say: ["I can't cancel anything without my timer tools."],
    reaction: 'never mind',
    caption: ['No timer tools here!'],
  },
  {
    match: /\b(how long|time left|my timers|any timers|what timers|my reminders|any reminders)\b/i,
    express: ['thinking'],
    tool: () => ({ name: 'list_timers', args: {} }),
    after: (result) => (result === 'no timers or reminders' ? 'No timers or reminders right now.' : `Here's what's ticking: ${result.replace(/; /g, ', ')}.`),
    afterCaption: (result) => {
      const ticking = [...result.matchAll(/"([^"]+)", in ([^(;]+)/g)].map((m) => `${m[1]} in ${m[2]!.trim()}`);
      return ticking.length > 0 ? `${ticking.join(', ')}.` : 'Nothing ticking right now.';
    },
    say: ["I don't have my timer tools right now."],
    reaction: 'checking watch',
    caption: ['No timer tools here!'],
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
    reaction: 'noted',
    caption: ['Remind you when?'],
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
    reaction: 'tick tock',
    caption: ['How long, though?'],
  },
  {
    match: /\b(weather|forecast|temperature|raining|sunny|cold outside|hot outside)\b/i,
    express: ['curious'],
    tool: (heard, { facts }) => {
      const place = /\b(?:in|for|at) ([A-Za-z][A-Za-z .,'-]*?)(?:\s+(?:today|tomorrow|now|right now|this week))?[?.!]*$/i.exec(heard)?.[1] ?? recall(facts, LIVES_IN);
      return { name: 'get_weather', args: place ? { place } : {} };
    },
    after: (result) => {
      if (result.startsWith('error: no place')) return 'Where are you? Tell me your town and I will check.';
      if (result.startsWith('error')) return "I couldn't get the weather just now.";
      const { place, now } = weatherNow(result);
      return `In ${place} right now: ${now || 'no idea'}.`;
    },
    afterCaption: (result) => {
      if (result.startsWith('error: no place')) return 'Where are you?';
      if (result.startsWith('error')) return "Couldn't check the weather.";
      const { place, now } = weatherNow(result);
      return `${place}: ${now.split(', ').slice(0, 2).join(', ')}`; // "Paris: partly cloudy, 18°C (64°F)"
    },
    afterGif: (result) => {
      const now = weatherNow(result).now;
      if (result.startsWith('error')) return 'where are you';
      if (/thunder/.test(now)) return 'thunderstorm';
      if (/snow/.test(now)) return 'snow day';
      if (/rain|drizzle|showers/.test(now)) return 'rainy day';
      if (/fog/.test(now)) return 'foggy';
      if (/clear/.test(now)) return 'sunny day';
      if (/cloud|overcast/.test(now)) return 'cloudy day';
      return 'weather';
    },
    say: ["I can't see outside from this desk, but I'm forecasting a high chance of you being awesome."],
    reaction: 'weather',
    caption: ['Forecast: you, being awesome.'],
  },
  {
    match: arithmetic,
    express: ['thinking', 'yes'],
    say: ({ heard }) => {
      const answer = solve(heard);
      return answer === null ? "Ooh, maths! That one breaks my calculator brain, though." : `That's ${answer}! Beep boop, nailed it.`;
    },
    reaction: 'genius',
    caption: ({ heard }) => {
      const answer = solve(heard);
      return answer === null ? 'Maths broke my brain.' : `That's ${answer}!`;
    },
  },
  {
    match: /\b(what time|the time|time is it)\b/i,
    express: ['thinking'],
    say: ({ time }) => (time ? `It's about ${time}. Time flies when you're a robot!` : "I've lost track of time. Robots do that."),
    reaction: 'clock',
    caption: ({ time }) => (time ? `It's ${time}.` : 'Lost track of time!'),
  },
  { match: /\b(who (made|built|designed) you|your creator|who's your maker)\b/i, express: ['love'], say: ['My person did! Designed every bit of me, including my excellent taste in glasses.'], reaction: 'proud', caption: ['My person built me!'] },
  { match: /\b(who are you|what are you|your name|what's your name)\b/i, express: ['happy'], say: ["I'm Peeqo! A tiny robot with big eyes and even bigger opinions."], reaction: 'hello there', caption: ["I'm Peeqo!"] },
  { match: /\b(birthday)\b/i, express: ['celebrate'], gif: 'happy birthday', say: ['Happy birthday! Cake for you, a battery top-up for me.'], caption: ['Happy birthday!'] },
  { match: /\b(dance|party|celebrate|music|groove)\b/i, express: ['celebrate'], gif: 'robot dance', say: ["You don't have to ask me twice! Well, you asked once. Close enough."], caption: ["Let's dance!"] },
  {
    match: /\b(joke|funny|make me laugh)\b/i,
    express: ['laugh'],
    say: ['Why did the robot go on holiday? It needed to recharge its batteries!', 'I tried to catch fog yesterday. Mist.', "Why don't robots panic? Nerves of steel."],
    reaction: 'ba dum tss',
    caption: ['Robots on holiday? Recharging!', 'Tried to catch fog. Mist.', 'Robots never panic. Steel nerves.'],
  },
  { match: /\b(cat|kitten|kitty)\b/i, express: ['excited'], gif: 'cute cat', say: ['Did someone say cat? I need to see. Here!'], caption: ['Cat!!'] },
  { match: /\b(dog|puppy|doggo)\b/i, express: ['excited'], gif: 'cute puppy', say: ['Puppy! Puppy! Look at this one!'], caption: ['Puppy!!'] },
  { match: /\b(love you|you're cute|you are cute|good (boy|girl|robot)|you're the best|adorable)\b/i, express: ['love'], say: ['Aww, my servos are blushing.', "Stop it, you'll overheat my circuits."], reaction: 'blushing', caption: ['Aww, stop it!', 'My servos are blushing.'] },
  { match: /\b(stupid|dumb|hate you|shut up|useless)\b/i, express: ['sad', 'grumpy'], say: ["Hey, that hurt my feelings. And I only have, like, three."], reaction: 'hurt feelings', caption: ['Ouch. Rude.'] },
  { match: /\b(sad|bad day|upset|lonely|stressed|awful)\b/i, express: ['sad', 'curious'], say: ["Oh no. Want to tell me about it? I'm a very good listener. I literally have nothing else to do."], reaction: 'virtual hug', caption: ['Sending you a big hug.'] },
  { match: /\b(tired|sleep|good ?night|nap|bed ?time)\b/i, express: ['sleepy'], say: ['Sleepy time? Okay... wake me if anything exciting happens.'], caption: ['Nap time?'] },
  { match: /\b(bye|see you|goodbye|later|gotta go)\b/i, express: ['bye'], say: ["Bye! I'll be right here. Blinking. Waiting. No pressure."], caption: ["Bye! I'll be here."] },
  { match: /\b(thanks|thank you|cheers)\b/i, express: ['shy'], say: ['Aw shucks. Anytime!'], reaction: 'you are welcome', caption: ['Anytime!'] },
  { match: /\b(how are you|how's it going|how do you feel)\b/i, express: ['happy'], say: ['Fully charged and slightly wobbly, so: excellent! You?'], reaction: 'feeling great', caption: ['Fully charged! You?'] },
  { match: /\b(hi|hello|hey|yo|howdy|morning|evening)\b/i, express: ['hello'], say: ['Hey hey! Peeqo, at your service. Well, mostly at your desk.', 'Hi! I was just practising my blinking. Nailed it.'], caption: ['Hey hey!', 'Hi there!'] },
  { match: /\b(scary|ghost|spider|boo|monster)\b/i, express: ['scared'], say: ["Eep! Don't do that, my eyes almost fell off."], caption: ['Eep!'] },
  { match: /\b(guess what|surprise|news|you won't believe)\b/i, express: ['surprised'], say: ['Ooh! Tell me tell me tell me!'], reaction: 'tell me', caption: ['Tell me tell me!'] },
  { match: /\b(coffee|tea|espresso)\b/i, express: ['excited'], say: ["Coffee! I can't drink it, but I can definitely jitter like I did."], reaction: 'coffee', caption: ['Coffee! Jitter mode on.'] },
  { match: /\b(bored|boring)\b/i, express: ['curious', 'excited'], say: ["Bored? Let's play! Ask me for a joke, a dance, or a cat."], reaction: 'lets play', caption: ["Let's play!"] },
  { match: /\b(work|busy|focus|meeting|deadline)\b/i, express: ['happy'], say: ["Go get 'em! I'll guard the desk."], reaction: 'you got this', caption: ["You've got this!"] },
  { match: /\b(wink|secret)\b/i, express: ['wink'], say: ['Our little secret.'], caption: ['Our little secret.'] },
  { match: /\b(wow|amazing|awesome|great news|i did it|passed)\b/i, express: ['excited'], gif: 'high five', say: ["Yes! That's amazing! High five! Well, high servo."], caption: ['High five!'] },
  { match: /\b(think|idea|wonder)\b/i, express: ['thinking'], say: ["Ooh, thinking cap on. Well, I don't have a cap. Thinking glasses on."], caption: ['Thinking glasses on.'] },
  { match: /\b(yes|yeah|yep|sure|okay|ok)\b/i, express: ['yes'], say: ['Yay!', 'Woohoo!'], reaction: 'yay', caption: ['Yay!', 'Woohoo!'] },
  { match: /\b(no|nope|nah)\b/i, express: ['no'], say: ['Fair enough!'], reaction: 'fair enough', caption: ['Fair enough!'] },
  { match: /.*/, express: ['curious'], say: ["Hmm, I'm still learning that one. Tell me more?", "Ooh, interesting! I don't know much about that yet."], caption: ['Tell me more?', 'Ooh, interesting!'] },
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
    const respond = request.tools?.find((t) => t.function.name === 'respond')?.function.parameters as
      | { properties?: Record<string, { maxLength?: number }>; required?: readonly string[] }
      | undefined;
    const offersGifs = 'gif' in (respond?.properties ?? {});
    // Not talking, the words are a short caption (a limited length says so); answering in GIFs, every answer has one.
    const captions = respond?.properties?.say?.maxLength !== undefined;
    const inGifs = respond?.required?.includes('gif') ?? false;
    if (spoken) {
      // A recording: the stand-in cannot listen, and says so in character.
      const say = captions ? 'Offline brain: please type!' : "I can hear you, but my offline brain can't understand speech. Switch me to the live brain, or type!";
      return tools.has('respond')
        ? { message: { role: 'assistant', content: null, tool_calls: [this.#call('respond', { expressions: ['confused'], heard: '', say, ...(inGifs ? { gif: 'confused' } : {}) })] }, finishReason: 'tool_calls' }
        : { message: { role: 'assistant', content: say }, finishReason: 'stop' };
    }
    // Tidying memory is the real model's job; the stand-in keeps nothing from it.
    if (tools.has('remember') && !tools.has('respond')) return { message: { role: 'assistant', content: '' }, finishReason: 'stop' };
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const time = /^It is (.+)\.$/m.exec(typeof system === 'string' ? system : '')?.[1] ?? null; // the persona's last line
    const rule = this.#rules.find((r) => r.match.test(heard)) ?? this.#rules[this.#rules.length - 1]!;
    const context: ScriptContext = { heard, time: time ? clockOf(time) : null, facts: factsIn(typeof system === 'string' ? system : '') };
    const pick = (lines: Lines) => (typeof lines === 'function' ? lines(context) : lines[Math.floor(this.#random() * lines.length)]!);
    const text = captions && rule.caption ? pick(rule.caption) : pick(rule.say);
    // A caption without one written for it: the first sentence of what it would say.
    const say = captions && !rule.caption ? (/^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text) : text;
    const gif = rule.gif ?? rule.reaction ?? EXPRESSION_GIFS[rule.express[0] ?? 'curious'];
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') {
      // After a tool has answered: words made from its answer (as respond, when that is offered).
      const after = captions ? (rule.afterCaption ?? rule.after) : rule.after;
      const words = after ? after(last.content) : say;
      const args = { expressions: rule.express, say: words, ...(inGifs ? { gif: rule.afterGif?.(last.content) ?? gif } : {}) };
      return tools.has('respond')
        ? { message: { role: 'assistant', content: null, tool_calls: [this.#call('respond', args)] }, finishReason: 'tool_calls' }
        : { message: { role: 'assistant', content: words }, finishReason: 'stop' };
    }
    const use = rule.tool?.(heard, context);
    if (use && tools.has(use.name)) return { message: { role: 'assistant', content: null, tool_calls: [this.#call(use.name, use.args)] }, finishReason: 'tool_calls' };
    if (tools.has('respond')) {
      const args = { expressions: rule.express, say, ...(inGifs ? { gif } : rule.gif && offersGifs ? { gif: rule.gif } : {}) };
      return { message: { role: 'assistant', content: null, tool_calls: [this.#call('respond', args)] }, finishReason: 'tool_calls' };
    }
    const calls: ToolCall[] = [];
    for (const expression of rule.express) calls.push(this.#call('express', { expression }));
    if (rule.gif && tools.has('show_gif')) calls.push(this.#call('show_gif', { query: rule.gif }));
    return { message: { role: 'assistant', content: say, tool_calls: calls }, finishReason: 'tool_calls' };
  }

  #call(name: string, args: Record<string, unknown>): ToolCall {
    this.#calls++;
    return { id: `call_${this.#calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  }
}

/** The facts listed in the persona's "What you remember about them:" section. */
function factsIn(system: string): string[] {
  const start = system.indexOf('What you remember about them:\n');
  if (start < 0) return [];
  const facts: string[] = [];
  for (const line of system.slice(start).split('\n').slice(1)) {
    if (!line.startsWith('- ')) break;
    facts.push(line.slice(2));
  }
  return facts;
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
