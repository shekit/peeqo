import { expressionSpec, isExpressionName, type CharacterState, type ExpressionName } from '@peeqo/character';
import { GifBudgetError, type Gif, type KlipyClient } from './klipy.ts';
import type { Memory } from './memory.ts';
import type { ChatMessage, ChatModel, ToolCall } from './openrouter.ts';
import { respondTool, systemPrompt, tidyPrompt } from './persona.ts';
import { memoryTools, type BrainTool } from './tools.ts';

/** Something said out loud: a recording, sent to the model as it is (no transcribing first). */
export interface Utterance {
  /** WAV audio, base64-encoded (16 kHz mono is plenty). */
  readonly audio: string;
}

/** What the brain can do with the body (the simulator and the robot each provide one). */
export interface BrainBody {
  setState(state: CharacterState): void;
  express(name: ExpressionName, intensity: number): void;
  /**
   * Shows a GIF on the face screen; resolves once it is showing (or could not be loaded). Skips it if `signal`
   * aborts first, and takes it down if `signal` aborts while it shows.
   */
  showGif(gif: Gif, signal?: AbortSignal): Promise<void>;
  /**
   * Speaks the text aloud (voice on), or shows it on the face screen as a caption: over the GIF if one is showing
   * (which then stays until it has been read), otherwise above the eyes. Resolves when finished, or as soon as
   * `signal` aborts (stopping it).
   */
  say(text: string, voice: boolean, signal?: AbortSignal): Promise<void>;
}

export interface AnnounceOptions {
  /** How Peeqo shows it (default alert). */
  readonly expression?: ExpressionName;
  /** A GIF search to show with it, when Peeqo answers in GIFs (voice off). */
  readonly gif?: string;
}

/** The recent conversation, as saved between runs. */
export interface SavedConversation {
  readonly messages: readonly ChatMessage[];
  /** When they last talked (ms since 1970), or null. */
  readonly lastTalkMs: number | null;
}

export interface ConversationStore {
  load(): Promise<SavedConversation | null> | SavedConversation | null;
  save(conversation: SavedConversation): Promise<void> | void;
}

export type BrainEvent =
  | { readonly type: 'heard'; readonly text: string }
  /** What the model heard in a recording (it writes it down as it answers). */
  | { readonly type: 'understood'; readonly text: string }
  /** Peeqo spoke up unprompted (a timer, a reminder). */
  | { readonly type: 'announced'; readonly text: string }
  | { readonly type: 'tool'; readonly name: string; readonly args: string; readonly result: string }
  | { readonly type: 'reply'; readonly text: string; readonly model: string; readonly ms: number }
  | { readonly type: 'error'; readonly message: string };

export interface BrainOptions {
  readonly model: ChatModel;
  readonly body: BrainBody;
  /** GIF search, or null to go without. */
  readonly gifs?: KlipyClient | null;
  /**
   * Speak replies aloud. Off (the default, as Peeqo has always been), it answers with GIFs: one every turn, with a
   * short caption over it (just the caption when there are no GIFs).
   */
  readonly voice?: boolean;
  /**
   * How many recent exchanges the model sees word for word (default 12). Older ones drop out a few at a time, and
   * anything lasting in them is saved to `memory` first.
   */
  readonly recentTurns?: number;
  /** What Peeqo remembers about its person between conversations; gives the model the remember and forget tools. */
  readonly memory?: Memory | null;
  /** Where the recent conversation is saved, so it carries on after a restart (see restore()). */
  readonly conversation?: ConversationStore | null;
  /** What else it can do before answering (the time, timers, reminders, the weather). */
  readonly tools?: readonly BrainTool[];
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly onEvent?: (event: BrainEvent) => void;
}

export interface TurnResult {
  readonly reply: string;
  /** What was said: the text, or for a recording, what the model heard (null if it did not say). */
  readonly heard: string | null;
  readonly expressions: readonly ExpressionName[];
  readonly gif: Gif | null;
  readonly error: string | null;
  /** True if a newer turn interrupted this one. */
  readonly interrupted: boolean;
}

/** Model calls allowed per turn: tools first (each answered), then the reply; a reply without words gets a follow-up. */
const MAX_CALLS = 4;
/** A gap after which the model is told when they last talked. */
const GAP_MS = 30 * 60_000;
/** Announcements the model is told about, so it knows what just happened ("thanks!" after a timer). */
const RECENT_EVENTS = 3;
const RECENT_EVENT_MS = 30 * 60_000;
/** A second expression starts once the first has had its moment (or after this long, whichever is sooner). */
const SECOND_EXPRESSION_MAX_DELAY_MS = 1600;
const FALLBACK_REPLY = 'Oops, my thoughts got tangled. Try me again?';

/**
 * Peeqo's mind. hear() runs one turn, from typed words or a recording of speech (sent to the model as it is): Peeqo
 * thinks (the model is asked, with the conversation so far; it may use tools such as the weather first, then
 * answers by calling respond: one or two expressions, a GIF and a caption, or with the voice on, its words and now
 * and then a GIF), shows how it feels, then shows the GIF with its caption over it (or speaks while any GIF plays).
 * It sets the character's state as it goes: thinking while the model works, idle once it answers (speaking while it
 * talks, with the voice on). A new turn interrupts one still in progress, as a person cutting in would. announce()
 * lets it speak up unprompted, for timers and reminders. (Separate express and show_gif tools are still understood.)
 */
export class Brain {
  voice: boolean;
  #model: ChatModel;
  readonly #body: BrainBody;
  #gifs: KlipyClient | null;
  readonly #recentTurns: number;
  readonly #memory: Memory | null;
  readonly #conversation: ConversationStore | null;
  #lastTalkMs: number | null = null;
  /** Saves of the conversation happen one after another, in order. */
  #saving: Promise<void> = Promise.resolve();
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #onEvent: (event: BrainEvent) => void;
  #history: ChatMessage[] = [];
  #turn: AbortController | null = null;
  /** Settles when the turn under way ends (announcements wait for it). */
  #turnDone: Promise<void> = Promise.resolve();
  readonly #tools: ReadonlyMap<string, BrainTool>;
  /** Recent announcements, for the model's context. */
  #recent: { readonly atMs: number; readonly text: string }[] = [];
  /** Second expressions waiting for their moment; a new turn cancels them. */
  readonly #pending = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: BrainOptions) {
    this.#model = options.model;
    this.#body = options.body;
    this.#gifs = options.gifs ?? null;
    this.voice = options.voice ?? false;
    this.#recentTurns = Math.max(1, options.recentTurns ?? 12);
    this.#memory = options.memory ?? null;
    this.#conversation = options.conversation ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#onEvent = options.onEvent ?? (() => undefined);
    const tools = [...(options.tools ?? []), ...(this.#memory ? memoryTools(this.#memory) : [])];
    this.#tools = new Map(tools.map((tool) => [tool.spec.function.name, tool]));
  }

  /** Loads what was saved: the memory, and the recent conversation (a damaged one is dropped). */
  async restore(): Promise<void> {
    await this.#memory?.load();
    const saved = await this.#conversation?.load();
    if (!saved || !Array.isArray(saved.messages)) return;
    const messages = saved.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'));
    if (!wellFormed(messages) || this.#history.length > 0) return; // (a turn that already started keeps its own)
    this.#history = this.#trim([...messages]);
    this.#lastTalkMs = typeof saved.lastTalkMs === 'number' && Number.isFinite(saved.lastTalkMs) ? saved.lastTalkMs : null;
  }

  get modelName(): string {
    return this.#model.name;
  }

  /** The conversation the model sees (without the system prompt). */
  get history(): readonly ChatMessage[] {
    return this.#history;
  }

  /** Switches which model answers; the conversation carries on. */
  useModel(model: ChatModel): void {
    this.#model = model;
  }

  /** Switches GIF search on (with a client) or off (null). */
  useGifs(gifs: KlipyClient | null): void {
    this.#gifs = gifs;
  }

  /** Someone has started talking to Peeqo (a wake word, the mic opening): it stops what it was doing and listens. */
  attend(): void {
    this.interrupt();
    this.#body.setState('listening');
  }

  /** They stopped without saying anything: unless a turn is under way, Peeqo goes back to idle. */
  dismiss(): void {
    if (!this.#turn) this.#body.setState('idle');
  }

  /** Abandons the turn under way, if any (its words, GIF and second expression), without changing state. */
  interrupt(): void {
    this.#turn?.abort();
    this.#turn = null;
    this.#cancelPending();
  }

  /** Forgets the conversation (not the memory). */
  reset(): void {
    this.#turn?.abort();
    this.#cancelPending();
    this.#history = [];
    this.#lastTalkMs = null;
    this.#save();
  }

  #cancelPending(): void {
    for (const timer of this.#pending) clearTimeout(timer);
    this.#pending.clear();
  }

  async hear(input: string | Utterance): Promise<TurnResult> {
    const spoken = typeof input !== 'string';
    const said = spoken ? '' : input.trim().slice(0, 1000);
    const result = {
      reply: '',
      heard: spoken ? null : said,
      expressions: [] as ExpressionName[],
      gif: null as Gif | null,
      error: null as string | null,
      interrupted: false,
    };
    if (spoken ? !input.audio : !said) return result;
    this.#turn?.abort();
    this.#cancelPending();
    const turn = new AbortController();
    this.#turn = turn;
    let settle: () => void = () => undefined;
    this.#turnDone = new Promise((resolve) => (settle = resolve));
    if (!spoken) this.#onEvent({ type: 'heard', text: said });
    this.#body.setState('thinking');
    const started = Date.now();
    const messages: ChatMessage[] = [
      ...this.#history,
      spoken
        ? { role: 'user', content: [{ type: 'text', text: 'They said this out loud:' }, { type: 'input_audio', input_audio: { data: input.audio, format: 'wav' } }] }
        : { role: 'user', content: said },
    ];
    const asked = messages.length - 1;
    // Peeqo does not talk: it answers with a GIF every turn, with a caption over it.
    const inGifs = !this.voice && this.#gifs !== null;
    let rested = false;
    try {
      const tools = [respondTool(this.#gifs !== null, this.voice), ...[...this.#tools.values()].map((tool) => tool.spec)];
      const abilities = [...this.#tools.values()].flatMap((tool) => (tool.ability ? [tool.ability] : []));
      let reply = '';
      let gifShowing: Promise<void> | null = null;
      for (let call = 0; call < MAX_CALLS; call++) {
        const now = this.#now();
        const system: ChatMessage = {
          role: 'system',
          content: systemPrompt({
            now,
            voice: this.voice,
            gifs: this.#gifs !== null,
            tools: abilities,
            recent: this.#recentEvents(),
            ...(this.#memory ? { memory: this.#memory.facts } : {}),
            lastTalk: this.#lastTalkMs !== null && now.getTime() - this.#lastTalkMs > GAP_MS ? new Date(this.#lastTalkMs) : null,
          }),
        };
        // Tools are offered and the model chooses (newer Claude models on OpenRouter reject a forced tool_choice).
        const response = await this.#model.complete({ messages: [system, ...messages], tools }, turn.signal);
        if (turn.signal.aborted) return { ...result, interrupted: true };
        messages.push(response.message);
        const calls = response.message.tool_calls ?? [];
        for (const toolCall of calls) {
          if (toolCall.function.name === 'respond') {
            const outcome = this.#respond(toolCall, result, turn.signal);
            reply ||= outcome.say;
            gifShowing ??= outcome.gif;
            if (spoken && result.heard === null && outcome.heard) {
              result.heard = outcome.heard;
              this.#onEvent({ type: 'understood', text: outcome.heard });
            }
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: outcome.report });
          } else if (this.#tools.has(toolCall.function.name)) {
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: await this.#runRegistered(toolCall, turn.signal) });
          } else {
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: await this.#runTool(toolCall, result, turn.signal) });
          }
          if (turn.signal.aborted) return { ...result, interrupted: true };
        }
        reply ||= (response.message.content ?? '').trim();
        // Words arrived, or a GIF when answering in GIFs (or there is nothing left to do): the turn is complete.
        // Otherwise (tools were used) go on.
        if (reply || (inGifs && gifShowing) || calls.length === 0) break;
      }
      if (turn.signal.aborted) return { ...result, interrupted: true };
      // The recording is not kept: the conversation remembers what was heard, which is all a later turn needs.
      if (spoken) messages[asked] = { role: 'user', content: result.heard || '(something I could not make out)' };
      this.#history = this.#trim(messages);
      this.#lastTalkMs = this.#now().getTime();
      this.#save();
      result.reply = reply;
      this.#onEvent({ type: 'reply', text: reply, model: this.#model.name, ms: Date.now() - started });
      if (this.voice) {
        if (reply) {
          this.#body.setState('speaking');
          await this.#body.say(reply, true, turn.signal);
        }
        if (gifShowing) await gifShowing;
      } else {
        // The GIF first, then its caption over it.
        if (gifShowing) await gifShowing;
        if (turn.signal.aborted) return { ...result, interrupted: true };
        this.#body.setState('idle');
        rested = true;
        if (reply) await this.#body.say(reply, false, turn.signal);
      }
      if (turn.signal.aborted) return { ...result, interrupted: true };
    } catch (error) {
      if (turn.signal.aborted) return { ...result, interrupted: true };
      result.error = error instanceof Error ? error.message : String(error);
      this.#onEvent({ type: 'error', message: result.error });
      this.#body.express('oops', 0.8);
      this.#body.setState(this.voice ? 'speaking' : 'idle');
      rested = !this.voice;
      await this.#body.say(this.voice ? FALLBACK_REPLY : 'Oops!', this.voice, turn.signal);
    } finally {
      if (this.#turn === turn) {
        this.#turn = null;
        if (!rested) this.#body.setState('idle');
      }
      settle();
    }
    return result;
  }

  /**
   * Speaks up unprompted (a timer going off, a reminder), with an expression (and a GIF, when answering in GIFs),
   * once any turn under way has finished. A new turn cuts it short. The model is told about it on the next turns,
   * so "thanks!" makes sense to it.
   */
  async announce(text: string, options: AnnounceOptions = {}): Promise<void> {
    while (this.#turn) await this.#turnDone;
    const turn = new AbortController();
    this.#turn = turn;
    let settle: () => void = () => undefined;
    this.#turnDone = new Promise((resolve) => (settle = resolve));
    try {
      this.#recent.push({ atMs: this.#now().getTime(), text });
      this.#recent = this.#recent.slice(-RECENT_EVENTS);
      this.#onEvent({ type: 'announced', text });
      this.#body.express(options.expression ?? 'alert', 1);
      const query = options.gif?.trim().slice(0, 60);
      if (!this.voice && this.#gifs && query) await this.#findAndShowGif(query, { gif: null }, turn.signal);
      if (turn.signal.aborted) return;
      this.#body.setState(this.voice ? 'speaking' : 'idle');
      await this.#body.say(text, this.voice, turn.signal);
    } finally {
      if (this.#turn === turn) {
        this.#turn = null;
        if (this.voice) this.#body.setState('idle');
      }
      settle();
    }
  }

  #recentEvents(): string[] {
    const now = this.#now().getTime();
    return this.#recent.filter((e) => now - e.atMs < RECENT_EVENT_MS).map((e) => `at ${new Date(e.atMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} you announced: "${e.text}"`);
  }

  async #runRegistered(call: ToolCall, signal: AbortSignal): Promise<string> {
    const tool = this.#tools.get(call.function.name)!;
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return this.#report(call, 'error: the arguments were not valid JSON');
    }
    try {
      return this.#report(call, String(await tool.run(args, { now: this.#now(), signal })).slice(0, 2000));
    } catch (error) {
      if (signal.aborted) throw error;
      return this.#report(call, `error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Acts on a respond call: expressions now (a second one once the first has had its moment), a GIF searched and
   * shown in the background. Returns the words to say and a note for the conversation history.
   */
  #respond(
    call: ToolCall,
    result: { expressions: ExpressionName[]; gif: Gif | null },
    signal: AbortSignal,
  ): { say: string; heard: string; gif: Promise<void> | null; report: string } {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { say: '', heard: '', gif: null, report: this.#report(call, 'error: the arguments were not valid JSON') };
    }
    const notes: string[] = [];
    const asked = Array.isArray(args.expressions) ? args.expressions.map(String) : typeof args.expressions === 'string' ? [args.expressions] : [];
    const names = asked.filter((name): name is ExpressionName => isExpressionName(name)).slice(0, 2);
    for (const name of asked) if (!isExpressionName(name)) notes.push(`there is no expression called "${name.slice(0, 40)}"`);
    const intensity = typeof args.intensity === 'number' && Number.isFinite(args.intensity) ? Math.min(1, Math.max(0.2, args.intensity)) : 1;
    const [first, second] = names;
    if (first) {
      this.#body.express(first, intensity);
      result.expressions.push(first);
    }
    if (first && second) {
      const delay = Math.min(SECOND_EXPRESSION_MAX_DELAY_MS, expressionSpec(first).duration * 1000 * 0.7);
      const timer = setTimeout(() => {
        this.#pending.delete(timer);
        if (!signal.aborted) this.#body.express(second, intensity);
      }, delay);
      this.#pending.add(timer);
      result.expressions.push(second);
    }
    let gif: Promise<void> | null = null;
    const query = typeof args.gif === 'string' ? args.gif.trim().slice(0, 60) : '';
    if (query) {
      if (this.#gifs) gif = this.#findAndShowGif(query, result, signal);
      else notes.push('GIFs are not available right now');
    }
    const say = typeof args.say === 'string' ? args.say.trim() : '';
    const heard = typeof args.heard === 'string' ? args.heard.trim().slice(0, 1000) : '';
    return { say, heard, gif, report: this.#report(call, notes.length > 0 ? `done, except: ${notes.join('; ')}` : 'done') };
  }

  /** Searches for a GIF and shows one of the best few; failures only mean no GIF this time. */
  async #findAndShowGif(query: string, result: { gif: Gif | null }, signal: AbortSignal): Promise<void> {
    try {
      const gifs = (await this.#gifs?.search(query, 8, signal)) ?? [];
      if (gifs.length === 0 || signal.aborted) return;
      const gif = gifs[Math.floor(this.#random() * Math.min(5, gifs.length))]!;
      await this.#body.showGif(gif, signal);
      if (signal.aborted) return;
      result.gif = gif;
      this.#onEvent({ type: 'tool', name: 'show_gif', args: JSON.stringify({ query }), result: `showing ${gif.title || gif.id}` });
    } catch (error) {
      if (!signal.aborted) this.#onEvent({ type: 'tool', name: 'show_gif', args: JSON.stringify({ query }), result: error instanceof GifBudgetError ? 'no more GIFs this hour' : 'the GIF search failed' });
    }
  }

  async #runTool(call: ToolCall, result: { expressions: ExpressionName[]; gif: Gif | null }, signal: AbortSignal): Promise<string> {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return this.#report(call, 'error: the arguments were not valid JSON');
    }
    switch (call.function.name) {
      case 'express': {
        const name = String(args.expression ?? '');
        if (!isExpressionName(name)) return this.#report(call, `error: there is no expression called "${name.slice(0, 40)}"`);
        const intensity = typeof args.intensity === 'number' && Number.isFinite(args.intensity) ? Math.min(1, Math.max(0.2, args.intensity)) : 1;
        this.#body.express(name, intensity);
        result.expressions.push(name);
        return this.#report(call, 'done');
      }
      case 'show_gif': {
        if (!this.#gifs) return this.#report(call, 'error: GIFs are not available right now');
        const query = String(args.query ?? '').slice(0, 60);
        let gifs: readonly Gif[];
        try {
          gifs = await this.#gifs.search(query, 8, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          return this.#report(call, error instanceof GifBudgetError ? 'error: no more GIFs this hour; use your expressions instead' : 'error: the GIF search failed');
        }
        if (gifs.length === 0) return this.#report(call, 'no GIF found for that');
        // One of the best few, so the same query does not always show the same GIF.
        const gif = gifs[Math.floor(this.#random() * Math.min(5, gifs.length))]!;
        await this.#body.showGif(gif, signal);
        result.gif = gif;
        return this.#report(call, `showing a GIF${gif.title ? `: ${gif.title.slice(0, 80)}` : ''}`);
      }
      default:
        return this.#report(call, `error: there is no tool called "${call.function.name.slice(0, 40)}"`);
    }
  }

  #report(call: ToolCall, result: string): string {
    this.#onEvent({ type: 'tool', name: call.function.name, args: call.function.arguments, result });
    return result;
  }

  /**
   * Keeps the recent exchanges, cutting only at a person's turn so tool calls stay with their results. A few extra
   * are kept before cutting, so older exchanges go to memory a few at a time rather than one every turn.
   */
  #trim(messages: ChatMessage[]): ChatMessage[] {
    const starts = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
    const slack = Math.max(1, Math.round(this.#recentTurns / 3));
    if (starts.length <= this.#recentTurns + slack) return messages;
    const cut = starts[starts.length - this.#recentTurns]!;
    void this.#tidy(messages.slice(0, cut));
    return messages.slice(cut);
  }

  #save(): void {
    const store = this.#conversation;
    if (!store) return;
    const conversation: SavedConversation = { messages: this.#history, lastTalkMs: this.#lastTalkMs };
    this.#saving = this.#saving
      .then(() => store.save(conversation))
      .catch((error: unknown) => this.#onEvent({ type: 'error', message: `The conversation could not be saved: ${error instanceof Error ? error.message : String(error)}` }));
  }

  /** Settles once every save of the conversation so far has finished. */
  flush(): Promise<void> {
    return Promise.all([this.#saving, this.#memory?.flush()]).then(() => undefined);
  }

  /** Older exchanges are dropping out of the conversation: the model saves anything lasting from them first. */
  async #tidy(dropped: readonly ChatMessage[]): Promise<void> {
    const memory = this.#memory;
    const transcript = transcriptOf(dropped);
    if (!memory || !transcript) return;
    const tools = memoryTools(memory);
    try {
      const facts = memory.facts.map((fact) => `- ${fact}`).join('\n') || '(nothing yet)';
      const response = await this.#model.complete({
        messages: [
          { role: 'system', content: tidyPrompt() },
          { role: 'user', content: `What you remember about them:\n${facts}\n\nThe older conversation:\n${transcript}` },
        ],
        tools: tools.map((tool) => tool.spec),
      });
      for (const call of response.message.tool_calls ?? []) {
        const tool = tools.find((t) => t.spec.function.name === call.function.name);
        if (!tool) continue;
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.function.arguments || '{}');
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        this.#report(call, String(await tool.run(args, { now: this.#now(), signal: new AbortController().signal })));
      }
    } catch (error) {
      this.#onEvent({ type: 'error', message: `Tidying memory failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
}

/** What was said, as plain lines ("Them: …", "Peeqo: …"), for tidying memory; the most recent 6000 characters. */
function transcriptOf(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push(`Them: ${typeof m.content === 'string' ? m.content : m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(' ')}`);
    if (m.role !== 'assistant') continue;
    if (m.content) lines.push(`Peeqo: ${m.content}`);
    for (const call of m.tool_calls ?? []) {
      if (call.function.name !== 'respond') continue;
      try {
        const say = (JSON.parse(call.function.arguments) as { say?: unknown }).say;
        if (typeof say === 'string' && say.trim()) lines.push(`Peeqo: ${say.trim()}`);
      } catch {
        // not worth keeping
      }
    }
  }
  return lines.join('\n').slice(-6000);
}

/**
 * A conversation the model will accept: it starts with the person, and every tool call is answered (an edited or
 * damaged file might break that).
 */
function wellFormed(messages: readonly ChatMessage[]): boolean {
  if (messages.length > 0 && messages[0]!.role !== 'user') return false;
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'user' && open.size > 0) return false;
    if (m.role === 'user' && typeof m.content !== 'string') return false;
    if (m.role === 'assistant') {
      if (open.size > 0) return false;
      for (const call of m.tool_calls ?? []) open.add(call.id);
    }
    if (m.role === 'tool' && !open.delete(m.tool_call_id)) return false;
  }
  return open.size === 0;
}
