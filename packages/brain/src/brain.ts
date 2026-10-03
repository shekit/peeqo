import { expressionSpec, isExpressionName, type CharacterState, type ExpressionName } from '@peeqo/character';
import { GifBudgetError, type Gif, type KlipyClient } from './klipy.ts';
import type { ChatMessage, ChatModel, ToolCall } from './openrouter.ts';
import { respondTool, systemPrompt } from './persona.ts';

/** What the brain can do with the body (the simulator and the robot each provide one). */
export interface BrainBody {
  setState(state: CharacterState): void;
  express(name: ExpressionName, intensity: number): void;
  /** Shows a GIF on the face screen; resolves once it is showing (or could not be loaded). */
  showGif(gif: Gif): Promise<void>;
  /** Speaks the text aloud (voice on) or shows it as a caption; resolves when finished. */
  say(text: string, voice: boolean): Promise<void>;
}

export type BrainEvent =
  | { readonly type: 'heard'; readonly text: string }
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
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly onEvent?: (event: BrainEvent) => void;
}

export interface TurnResult {
  readonly reply: string;
  readonly expressions: readonly ExpressionName[];
  readonly gif: Gif | null;
  readonly error: string | null;
  /** True if a newer turn interrupted this one. */
  readonly interrupted: boolean;
}

/** Model calls allowed per turn (a reply without words gets a follow-up). */
const MAX_CALLS = 3;
/** A second expression starts once the first has had its moment (or after this long, whichever is sooner). */
const SECOND_EXPRESSION_MAX_DELAY_MS = 1600;
const FALLBACK_REPLY = 'Oops, my thoughts got tangled. Try me again?';

/**
 * Peeqo's mind. hear() runs one turn: Peeqo thinks (the model is asked, with the conversation so far, and answers by
 * calling respond, its only tool: its words, one or two expressions and maybe a GIF, in one round trip), shows how it feels,
 * then speaks while any GIF plays. It sets the character's state as it goes: thinking while the model works,
 * speaking while it talks, idle after. A new turn interrupts one still in progress, as a person cutting in would.
 * (The separate express and show_gif tools are still understood, should a model use them.)
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

  /** Someone has started talking to Peeqo (a wake word, the mic opening): it pays attention. */
  attend(): void {
    if (!this.#turn) this.#body.setState('listening');
  }

  /** They stopped without saying anything: unless a turn is under way, Peeqo goes back to idle. */
  dismiss(): void {
    if (!this.#turn) this.#body.setState('idle');
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

  async hear(text: string): Promise<TurnResult> {
    const said = text.trim().slice(0, 1000);
    const result = { reply: '', expressions: [] as ExpressionName[], gif: null as Gif | null, error: null as string | null, interrupted: false };
    if (!said) return result;
    this.#turn?.abort();
    this.#cancelPending();
    const turn = new AbortController();
    this.#turn = turn;
    this.#onEvent({ type: 'heard', text: said });
    this.#body.setState('thinking');
    const started = Date.now();
    const messages: ChatMessage[] = [...this.#history, { role: 'user', content: said }];
    try {
      const tools = [respondTool(this.#gifs !== null)];
      let reply = '';
      let gifShowing: Promise<void> | null = null;
      for (let call = 0; call < MAX_CALLS; call++) {
        const system: ChatMessage = { role: 'system', content: systemPrompt({ now: this.#now(), voice: this.voice, gifs: this.#gifs !== null }) };
        // respond is the only tool, so the model answers with it in one call. (Forcing the choice would be neater, but
        // newer Claude models on OpenRouter reject a forced tool_choice.)
        const response = await this.#model.complete({ messages: [system, ...messages], tools }, turn.signal);
        if (turn.signal.aborted) return { ...result, interrupted: true };
        messages.push(response.message);
        const calls = response.message.tool_calls ?? [];
        for (const toolCall of calls) {
          if (toolCall.function.name === 'respond') {
            const outcome = this.#respond(toolCall, result, turn.signal);
            reply ||= outcome.say;
            gifShowing ??= outcome.gif;
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: outcome.report });
          } else {
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: await this.#runTool(toolCall, result, turn.signal) });
          }
        }
        reply ||= (response.message.content ?? '').trim();
        // Words arrived (or there is nothing left to do): the turn is complete. Otherwise ask again for the words.
        if (reply || calls.length === 0) break;
      }
      if (turn.signal.aborted) return { ...result, interrupted: true };
      this.#history = this.#trim(messages);
      result.reply = reply;
      this.#onEvent({ type: 'reply', text: reply, model: this.#model.name, ms: Date.now() - started });
      if (reply) {
        this.#body.setState('speaking');
        await this.#body.say(reply, this.voice);
      }
      if (gifShowing) await gifShowing;
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
    }
    return result;
  }

  /**
   * Acts on a respond call: expressions now (a second one once the first has had its moment), a GIF searched and
   * shown in the background. Returns the words to say and a note for the conversation history.
   */
  #respond(call: ToolCall, result: { expressions: ExpressionName[]; gif: Gif | null }, signal: AbortSignal): { say: string; gif: Promise<void> | null; report: string } {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { say: '', gif: null, report: this.#report(call, 'error: the arguments were not valid JSON') };
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
    return { say, gif, report: this.#report(call, notes.length > 0 ? `done, except: ${notes.join('; ')}` : 'done') };
  }

  /** Searches for a GIF and shows one of the best few; failures only mean no GIF this time. */
  async #findAndShowGif(query: string, result: { gif: Gif | null }, signal: AbortSignal): Promise<void> {
    try {
      const gifs = (await this.#gifs?.search(query, 8, signal)) ?? [];
      if (gifs.length === 0 || signal.aborted) return;
      const gif = gifs[Math.floor(this.#random() * Math.min(5, gifs.length))]!;
      await this.#body.showGif(gif);
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
        await this.#body.showGif(gif);
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
