/**
 * Reaction GIFs from Klipy (a Tenor-compatible API: GET /v2/search?q=…&key=…). Searches are cached, and an hourly
 * budget keeps under the key's limit (the testing key allows 100 an hour); the server's own count, sent back in
 * x-ratelimit-remaining, is respected too.
 */
export interface Gif {
  readonly id: string;
  readonly title: string;
  /** Video version (preferred: a fraction of the GIF's size and smoother), or null. */
  readonly mp4: string | null;
  /** GIF version, or null. */
  readonly gif: string | null;
  readonly width: number;
  readonly height: number;
}

export interface CachedSearch {
  readonly at: number;
  readonly gifs: readonly Gif[];
}

/** Optional persistence for the cache (the robot and the simulator's proxy keep it in a file). */
export interface GifStore {
  load(): Record<string, CachedSearch> | null;
  save(data: Record<string, CachedSearch>): void;
}

export class GifBudgetError extends Error {
  constructor() {
    super('GIF searches are used up for this hour');
    this.name = 'GifBudgetError';
  }
}

export interface KlipyOptions {
  /** API key; leave out when calling through a proxy that adds it. */
  readonly apiKey?: string;
  /** Default https://api.klipy.com/v2; the simulator uses its local proxy, /api/gifs. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Searches allowed per hour (default 90, under the testing key's 100). */
  readonly perHour?: number;
  /** Klipy content filter (default 'high': safe for everyone). */
  readonly contentFilter?: 'off' | 'low' | 'medium' | 'high';
  readonly locale?: string;
  /** How long a search stays cached (default 24 h). */
  readonly cacheHours?: number;
  readonly store?: GifStore;
  readonly now?: () => number;
}

const HOUR_MS = 3600_000;

export function normalizeGifQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
}

export class KlipyClient {
  readonly #options: Required<Omit<KlipyOptions, 'apiKey' | 'store'>> & Pick<KlipyOptions, 'apiKey' | 'store'>;
  readonly #cache = new Map<string, CachedSearch>();
  #requests: number[] = [];
  #serverRemaining: number | null = null;
  #serverWindowStart: number | null = null;

  constructor(options: KlipyOptions = {}) {
    this.#options = {
      baseUrl: (options.baseUrl ?? 'https://api.klipy.com/v2').replace(/\/$/, ''),
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      perHour: options.perHour ?? 90,
      contentFilter: options.contentFilter ?? 'high',
      locale: options.locale ?? 'en_US',
      cacheHours: options.cacheHours ?? 24,
      now: options.now ?? Date.now,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.store ? { store: options.store } : {}),
    };
    const stored = options.store?.load();
    if (stored) for (const [q, entry] of Object.entries(stored)) this.#cache.set(q, entry);
  }

  /** Searches left this hour. */
  get remaining(): number {
    this.#prune();
    const ours = this.#options.perHour - this.#requests.length;
    return Math.max(0, this.#serverRemaining === null ? ours : Math.min(ours, this.#serverRemaining));
  }

  /** GIFs for a query, from the cache when possible. Throws GifBudgetError when the hour's searches are used up. */
  async search(query: string, limit = 8, signal?: AbortSignal): Promise<readonly Gif[]> {
    const q = normalizeGifQuery(query);
    if (!q) return [];
    const now = this.#options.now();
    const cached = this.#cache.get(q);
    if (cached && now - cached.at < this.#options.cacheHours * HOUR_MS) return cached.gifs;
    if (this.remaining <= 0) throw new GifBudgetError();

    const url = new URL(`${this.#options.baseUrl}/search`, 'http://localhost');
    const params: Record<string, string> = {
      q,
      limit: String(Math.max(1, Math.min(20, Math.round(limit)))),
      media_filter: 'mp4,mediumgif,gif',
      contentfilter: this.#options.contentFilter,
      locale: this.#options.locale,
    };
    if (this.#options.apiKey) params.key = this.#options.apiKey;
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const target = this.#options.baseUrl.startsWith('http') ? url.toString() : `${url.pathname}${url.search}`;

    this.#requests.push(now);
    const response = await this.#options.fetch(target, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    if (response.headers.has('x-ratelimit-remaining') && Number.isFinite(remaining)) {
      if (this.#serverWindowStart === null || now - this.#serverWindowStart >= HOUR_MS) this.#serverWindowStart = now;
      this.#serverRemaining = remaining;
    }
    if (response.status === 429) {
      this.#serverRemaining = 0;
      this.#serverWindowStart = now;
      throw new GifBudgetError();
    }
    if (!response.ok) throw new Error(`GIF search failed (${response.status})`);
    const gifs = parseResults(await response.json());
    this.#cache.set(q, { at: now, gifs });
    this.#options.store?.save(Object.fromEntries(this.#cache));
    return gifs;
  }

  #prune(): void {
    const now = this.#options.now();
    this.#requests = this.#requests.filter((t) => now - t < HOUR_MS);
    if (this.#serverWindowStart !== null && now - this.#serverWindowStart >= HOUR_MS) {
      this.#serverRemaining = null;
      this.#serverWindowStart = null;
    }
  }
}

function parseResults(json: unknown): Gif[] {
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error('GIF search sent an unexpected answer');
  const gifs: Gif[] = [];
  for (const r of results as { id?: unknown; title?: unknown; content_description?: unknown; media_formats?: Record<string, { url?: unknown; dims?: unknown }> }[]) {
    const formats = r.media_formats ?? {};
    const pick = (name: string) => (typeof formats[name]?.url === 'string' ? (formats[name]!.url as string) : null);
    const mp4 = pick('mp4');
    const gif = pick('mediumgif') ?? pick('gif');
    const dims = (formats.mp4?.dims ?? formats.mediumgif?.dims ?? formats.gif?.dims) as unknown;
    const [width, height] = Array.isArray(dims) && dims.length === 2 ? (dims as number[]) : [0, 0];
    if ((!mp4 && !gif) || !(width! > 0 && height! > 0)) continue;
    gifs.push({
      id: String(r.id ?? ''),
      title: typeof r.title === 'string' && r.title ? r.title : typeof r.content_description === 'string' ? r.content_description : '',
      mp4,
      gif,
      width: width!,
      height: height!,
    });
  }
  return gifs;
}
