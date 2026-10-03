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

export function createApi(options: ApiOptions): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  fs.mkdirSync(path.join(options.cacheDir, 'media'), { recursive: true });
  const searchFile = path.join(options.cacheDir, 'klipy-searches.json');
  const klipy = options.klipyKey
    ? new KlipyClient({
        apiKey: options.klipyKey,
        perHour: 90,
        store: {
          load: () => (fs.existsSync(searchFile) ? (JSON.parse(fs.readFileSync(searchFile, 'utf8')) as Record<string, CachedSearch>) : null),
          save: (data) => fs.writeFileSync(searchFile, JSON.stringify(data)),
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
    handle(url, req, res).catch((error: unknown) => sendJson(res, 502, { error: redact(error instanceof Error ? error.message : String(error)) }));
  };

  async function handle(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (url.pathname === '/api/status') {
      sendJson(res, 200, { model: !!options.openRouterKey, gifs: !!klipy, gifsLeft: klipy?.remaining ?? 0 });
      return;
    }
    if (url.pathname === '/api/openrouter/chat/completions' && req.method === 'POST') {
      if (!options.openRouterKey) return sendJson(res, 503, { error: 'OPENROUTER_API_KEY is not set in .env' });
      const body = await readBody(req);
      const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.openRouterKey}`, 'X-Title': 'Peeqo sim', 'HTTP-Referer': 'https://github.com/shekit/peeqo' },
        body,
      });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(redact(await upstream.text()));
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
      fs.createReadStream(file).pipe(res);
      return;
    }
    sendJson(res, 404, { error: 'Unknown API route' });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
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
