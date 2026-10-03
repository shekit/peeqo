// The simulator's local API, served by the Vite dev server (never part of the built page). It holds the API keys
// from the repo's .env so they never reach the browser:
//   POST /api/openrouter/chat/completions   the model (OpenRouter), key added here
//   GET  /api/gifs/search?q=…               Klipy GIF search: cached on disk, hourly budget, media URLs made local
//   GET  /api/gifs/media?u=…                fetches Klipy media (same-origin, so the face can draw it), cached
//   GET  /api/status                        what is available

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { GifBudgetError, KlipyClient, type CachedSearch, type Gif } from '@peeqo/brain';

export interface ApiOptions {
  readonly openRouterKey?: string | undefined;
  readonly klipyKey?: string | undefined;
  /** Where searches and media are cached (gitignored). */
  readonly cacheDir: string;
}

type Next = (error?: unknown) => void;
const MAX_BODY = 1_000_000;
const MEDIA_HOSTS = new Set(['static.klipy.com']);
/** Models the proxy will pay for, and the longest reply it allows. */
const ALLOWED_MODEL = /^anthropic\/claude-[\w.-]+$/;
const MAX_TOKENS = 1000;
const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * Only the simulator page itself may use the API. Browsers say where a request comes from (Sec-Fetch-Site, Origin);
 * a request from another site (another tab trying to spend the keys) is refused. Requests without those headers
 * are not from a web page (curl, scripts on this machine) and are allowed.
 */
function fromThisPage(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createApi(options: ApiOptions): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  fs.mkdirSync(path.join(options.cacheDir, 'media'), { recursive: true });
  const searchFile = path.join(options.cacheDir, 'klipy-searches.json');
  const klipy = options.klipyKey
    ? new KlipyClient({
        apiKey: options.klipyKey,
        perHour: 90,
        store: {
          load: () => {
            try {
              return fs.existsSync(searchFile) ? (JSON.parse(fs.readFileSync(searchFile, 'utf8')) as Record<string, CachedSearch>) : null;
            } catch {
              return null; // a damaged cache is simply started afresh
            }
          },
          save: (data) => {
            // Written to a temporary file then renamed, so a crash mid-write cannot leave a damaged cache.
            const temp = `${searchFile}.${process.pid}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(data));
            fs.renameSync(temp, searchFile);
          },
        },
      })
    : null;
  const secrets = [options.openRouterKey, options.klipyKey].filter((k): k is string => !!k);
  const redact = (text: string) => secrets.reduce((t, key) => t.split(key).join('[key]'), text);

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      next();
      return;
    }
    if (!fromThisPage(req)) {
      sendJson(res, 403, { error: 'The Peeqo API only answers the simulator page' });
      return;
    }
    handle(url, req, res).catch((error: unknown) => sendJson(res, 502, { error: redact(error instanceof Error ? error.message : String(error)) }));
  };

  async function handle(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (url.pathname === '/api/status') {
      sendJson(res, 200, { model: !!options.openRouterKey, gifs: !!klipy, gifsLeft: klipy?.remaining ?? 0 });
      return;
    }
    if (url.pathname === '/api/openrouter/chat/completions' && req.method === 'POST') {
      if (!options.openRouterKey) return sendJson(res, 503, { error: 'OPENROUTER_API_KEY is not set in .env' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return sendJson(res, 415, { error: 'Send JSON' });
      let asked: Record<string, unknown>;
      try {
        asked = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return sendJson(res, 400, { error: 'The request was not valid JSON' });
      }
      if (typeof asked.model !== 'string' || !ALLOWED_MODEL.test(asked.model)) return sendJson(res, 400, { error: 'That model is not allowed here' });
      // Only what Peeqo uses is passed on, with the reply length capped.
      const body = JSON.stringify({
        model: asked.model,
        messages: asked.messages,
        ...(asked.tools ? { tools: asked.tools } : {}),
        ...(asked.tool_choice ? { tool_choice: asked.tool_choice } : {}),
        ...(typeof asked.temperature === 'number' ? { temperature: asked.temperature } : {}),
        max_tokens: Math.min(MAX_TOKENS, typeof asked.max_tokens === 'number' && asked.max_tokens > 0 ? asked.max_tokens : 400),
        stream: false,
      });
      // Gives up after a minute, or as soon as the page stops waiting (an interrupted turn should not run on).
      const abandon = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abandon.abort();
      });
      const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.openRouterKey}`, 'X-Title': 'Peeqo sim', 'HTTP-Referer': 'https://github.com/shekit/peeqo' },
        body,
        signal: AbortSignal.any([abandon.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      });
      const text = await upstream.text(); // read fully before answering, so a failure here can still be reported
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(redact(text));
      return;
    }
    if (url.pathname === '/api/gifs/search') {
      if (!klipy) return sendJson(res, 503, { error: 'KLIPY_API is not set in .env' });
      let gifs: readonly Gif[];
      try {
        gifs = await klipy.search(url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 8));
      } catch (error) {
        if (error instanceof GifBudgetError) return sendJson(res, 429, { error: error.message });
        throw error;
      }
      // Answer in Klipy's own format, with media served from here.
      const local = (u: string | null) => (u ? `/api/gifs/media?u=${encodeURIComponent(u)}` : null);
      const results = gifs.map((g) => ({
        id: g.id,
        title: g.title,
        media_formats: {
          ...(g.mp4 ? { mp4: { url: local(g.mp4), dims: [g.width, g.height] } } : {}),
          ...(g.gif ? { mediumgif: { url: local(g.gif), dims: [g.width, g.height] } } : {}),
        },
      }));
      res.setHeader('x-ratelimit-remaining', String(klipy.remaining));
      sendJson(res, 200, { results, next: '' });
      return;
    }
    if (url.pathname === '/api/gifs/media') {
      const target = new URL(url.searchParams.get('u') ?? '');
      if (target.protocol !== 'https:' || !MEDIA_HOSTS.has(target.hostname)) return sendJson(res, 400, { error: 'Only Klipy media can be fetched' });
      const ext = path.extname(target.pathname).toLowerCase() === '.gif' ? '.gif' : '.mp4';
      const file = path.join(options.cacheDir, 'media', createHash('sha1').update(target.href).digest('hex') + ext);
      if (!fs.existsSync(file)) {
        const upstream = await fetch(target);
        if (!upstream.ok) return sendJson(res, 502, { error: `Media fetch failed (${upstream.status})` });
        fs.writeFileSync(file, Buffer.from(await upstream.arrayBuffer()));
      }
      res.writeHead(200, { 'Content-Type': ext === '.gif' ? 'image/gif' : 'video/mp4', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
      return;
    }
    sendJson(res, 404, { error: 'Unknown API route' });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    // Too late for a proper error: end what was started.
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
