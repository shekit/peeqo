/**
 * The chat model behind Peeqo's mind. OpenRouter speaks the OpenAI chat-completions format, including tool calls;
 * the same types describe the offline stand-in (ScriptedModel) used for building and testing.
 */
export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

/** Part of a person's message: words, or a recording of them speaking (audio-capable models only). */
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'input_audio'; readonly input_audio: { readonly data: string; readonly format: 'wav' | 'mp3' } };

export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string | readonly ContentPart[] }
  | { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export interface ToolSpec {
  readonly type: 'function';
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> };
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  /** Make the model call this tool (default: it chooses). */
  readonly toolChoice?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface ChatReply {
  readonly message: Extract<ChatMessage, { role: 'assistant' }>;
  /** Why the model stopped: 'stop', 'tool_calls', 'length', … */
  readonly finishReason: string;
  readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
}

export interface ChatModel {
  /** Which model answers (for logs and the UI). */
  readonly name: string;
  complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatReply>;
}

export class ModelError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
  }
}

export interface OpenRouterOptions {
  /** OpenRouter model id (default: Gemini 3.8 Flash, which also understands speech). */
  readonly model?: string;
  /** API key. Leave out when calling through a proxy that adds it (the simulator's dev server does). */
  readonly apiKey?: string;
  /** Default https://openrouter.ai/api/v1; the simulator uses its local proxy, /api/openrouter. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** Hears speech directly (no transcribing first), calls tools, and answers quickly. */
export const DEFAULT_MODEL = 'google/gemini-3.8-flash';
const RETRY_DELAY_MS = 800;

/** Chat completions through OpenRouter, with a timeout and one retry on rate limits or server errors. */
export class OpenRouterModel implements ChatModel {
  readonly name: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenRouterOptions = {}) {
    this.name = options.model ?? DEFAULT_MODEL;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.#timeoutMs = options.timeoutMs ?? 30000;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatReply> {
    const body = JSON.stringify({
      model: this.name,
      messages: request.messages,
      ...(request.tools && request.tools.length > 0
        ? { tools: request.tools, tool_choice: request.toolChoice ? { type: 'function', function: { name: request.toolChoice } } : 'auto' }
        : {}),
      temperature: request.temperature ?? 0.8,
      max_tokens: request.maxTokens ?? 400,
    });
    for (let attempt = 0; ; attempt++) {
      const response = await this.#post(body, signal);
      if (response.ok) return parseReply(await response.json());
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt === 0) {
        await sleep(RETRY_DELAY_MS, signal);
        continue;
      }
      throw new ModelError(`The model service answered ${response.status}: ${this.#redact(await safeText(response))}`, response.status);
    }
  }

  async #post(body: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Title': 'Peeqo',
      'HTTP-Referer': 'https://github.com/shekit/peeqo',
    };
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
    try {
      return await this.#fetch(`${this.#baseUrl}/chat/completions`, { method: 'POST', headers, body, signal: combined });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new ModelError(`The model took longer than ${this.#timeoutMs / 1000} s to answer`);
      throw new ModelError(`Could not reach the model service: ${this.#redact(String(error))}`);
    }
  }

  #redact(text: string): string {
    const key = this.#apiKey;
    return (key ? text.split(key).join('[key]') : text).slice(0, 300);
  }
}

function parseReply(json: unknown): ChatReply {
  const data = json as {
    choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  if (data.error) throw new ModelError(`The model service reported: ${String(data.error.message ?? 'an error')}`);
  const choice = data.choices?.[0];
  if (!choice?.message) throw new ModelError('The model service sent no answer');
  const content = typeof choice.message.content === 'string' ? choice.message.content : null;
  const calls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
  const toolCalls: ToolCall[] = calls
    .filter((c): c is { id: string; function: { name: string; arguments?: string } } => typeof c?.id === 'string' && typeof c?.function?.name === 'string')
    .map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : '{}' } }));
  const usage = data.usage ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 } : undefined;
  return {
    message: { role: 'assistant', content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
    ...(usage ? { usage } : {}),
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
