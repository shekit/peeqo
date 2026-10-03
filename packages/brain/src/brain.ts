import { expressionSpec, isExpressionName, type CharacterState, type ExpressionName } from '@peeqo/character';
import { GifBudgetError, type Gif, type KlipyClient } from './klipy.ts';
import type { ChatMessage, ChatModel, ToolCall } from './openrouter.ts';
import { respondTool, systemPrompt } from './persona.ts';
import type { BrainTool } from './tools.ts';

/** Something said out loud: a recording, sent to the model as it is (no transcribing first). */
export interface Utterance {
  /** WAV audio, base64-encoded (16 kHz mono is plenty). */
  readonly audio: string;
}

/** What the brain can do with the body (the simulator and the robot each provide one). */
export interface BrainBody {
  setState(state: CharacterState): void;
  express(name: ExpressionName, intensity: number): void;
  /** Shows a GIF on the face screen; resolves once it is showing (or could not be loaded). Skips it if `signal` aborts first. */
  showGif(gif: Gif, signal?: AbortSignal): Promise<void>;
  /** Speaks the text aloud (voice on) or shows it as a caption; resolves when finished. */
  say(text: string, voice: boolean): Promise<void>;
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
  /** Speak replies aloud (default true); off, replies are short captions. */
  readonly voice?: boolean;
  /** How many past exchanges the model remembers (default 12). */
  readonly memory?: number;
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
/** Announcements the model is told about, so it knows what just happened ("thanks!" after a timer). */
const RECENT_EVENTS = 3;
const RECENT_EVENT_MS = 30 * 60_000;
/** A second expression starts once the first has had its moment (or after this long, whichever is sooner). */
const SECOND_EXPRESSION_MAX_DELAY_MS = 1600;
const FALLBACK_REPLY = 'Oops, my thoughts got tangled. Try me again?';

/**
 * Peeqo's mind. hear() runs one turn, from typed words or a recording of speech (sent to the model as it is): Peeqo
 * thinks (the model is asked, with the conversation so far; it may use tools such as the weather first, then
 * answers by calling respond: its words, one or two expressions and maybe a GIF), shows how it feels, then speaks
 * while any GIF plays. It sets the character's state as it goes: thinking while the model works, speaking while it
 * talks, idle after. A new turn interrupts one still in progress, as a person cutting in would. announce() lets it
 * speak up unprompted, for timers and reminders. (Separate express and show_gif tools are still understood.)
 */
export class Brain {
  voice: boolean;
  #model: ChatModel;
  readonly #body: BrainBody;
  #gifs: KlipyClient | null;
  readonly #memory: number;
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
    this.voice = options.voice ?? true;
    this.#memory = options.memory ?? 12;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#tools = new Map((options.tools ?? []).map((tool) => [tool.spec.function.name, tool]));
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

  /** Forgets the conversation. */
  reset(): void {
    this.#turn?.abort();
    this.#cancelPending();
    this.#history = [];
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
    try {
      const tools = [respondTool(this.#gifs !== null), ...[...this.#tools.values()].map((tool) => tool.spec)];
      const abilities = [...this.#tools.values()].flatMap((tool) => (tool.ability ? [tool.ability] : []));
      let reply = '';
      let gifShowing: Promise<void> | null = null;
      for (let call = 0; call < MAX_CALLS; call++) {
        const system: ChatMessage = {
          role: 'system',
          content: systemPrompt({ now: this.#now(), voice: this.voice, gifs: this.#gifs !== null, tools: abilities, recent: this.#recentEvents() }),
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
        // Words arrived (or there is nothing left to do): the turn is complete. Otherwise (tools were used) go on.
        if (reply || calls.length === 0) break;
      }
      if (turn.signal.aborted) return { ...result, interrupted: true };
      // The recording is not kept: the conversation remembers what was heard, which is all a later turn needs.
      if (spoken) messages[asked] = { role: 'user', content: result.heard || '(something I could not make out)' };
      this.#history = this.#trim(messages);
      result.reply = reply;
      this.#onEvent({ type: 'reply', text: reply, model: this.#model.name, ms: Date.now() - started });
      if (reply) {
        this.#body.setState('speaking');
        await this.#body.say(reply, this.voice);
      }
      if (gifShowing) await gifShowing;
      if (turn.signal.aborted) return { ...result, interrupted: true };
    } catch (error) {
      if (turn.signal.aborted) return { ...result, interrupted: true };
      result.error = error instanceof Error ? error.message : String(error);
      this.#onEvent({ type: 'error', message: result.error });
      this.#body.express('oops', 0.8);
      this.#body.setState('speaking');
      await this.#body.say(this.voice ? FALLBACK_REPLY : 'Oops!', this.voice);
    } finally {
      if (this.#turn === turn) {
        this.#turn = null;
        this.#body.setState('idle');
      }
      settle();
    }
    return result;
  }

  /**
   * Speaks up unprompted (a timer going off, a reminder), with an expression, once any turn under way has finished.
   * The model is told about it on the next turns, so "thanks!" makes sense to it.
   */
  async announce(text: string, expression: ExpressionName = 'alert'): Promise<void> {
    while (this.#turn) await this.#turnDone;
    this.#recent.push({ atMs: this.#now().getTime(), text });
    this.#recent = this.#recent.slice(-RECENT_EVENTS);
    this.#onEvent({ type: 'announced', text });
    this.#body.express(expression, 1);
    this.#body.setState('speaking');
    await this.#body.say(text, this.voice);
    if (!this.#turn) this.#body.setState('idle');
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

  /** Keeps the last `memory` exchanges, cutting only at a person's turn so tool calls stay with their results. */
  #trim(messages: ChatMessage[]): ChatMessage[] {
    const starts = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
    if (starts.length <= this.#memory) return messages;
    return messages.slice(starts[starts.length - this.#memory]);
  }
}
