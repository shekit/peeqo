import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFileOrNull, validPin, writeFileSafely } from '../config.ts';
import type { FaceMessage, FaceReply } from '../face/mirroredFace.ts';
import type { CalibrationSession } from '../hardware/calibrationSession.ts';
import type { SetupController } from '../net/setup.ts';
import type { Robot } from '../robot.ts';

/**
 * The robot's web server: the face page (shown full screen on the robot by its browser), the panel (from a laptop or
 * phone on the same Wi-Fi, behind the PIN), and the setup page with its captive portal (only while setting up).
 *
 *   GET  /face  /  /setup         the pages (built into dist/web)
 *   GET  /api/info                name, whether setup is open, whether a PIN is set, whether this browser is in
 *   POST /api/login {pin}         a session cookie (5 wrong PINs: wait 5 minutes)
 *   GET  /api/state               everything the panel shows
 *   POST /api/say, /api/listen, /api/settings, /api/memory/forget, /api/chat/clear, /api/calibration, /api/power
 *   GET/POST /api/setup           the setup page (only while setting up, or before a PIN exists)
 *   WS   /ws/face                 face commands (this robot's own screen, or a signed-in panel)
 *   WS   /ws/panel                state, transcript and log, for a signed-in panel
 *
 * Changes need a same-origin request (Origin matching Host), and sessions are HttpOnly, SameSite=Strict cookies.
 */
export interface ServerOptions {
  readonly robot: Robot;
  readonly setup: SetupController;
  readonly calibration: CalibrationSession;
  /** The built pages. */
  readonly webDir: string;
  readonly port: number;
  readonly host?: string;
  /** The setup network's address (captive portal redirects go there). */
  readonly setupAddress?: string;
  /** Where signed-in sessions are kept (hashed), so a restart does not sign everyone out. */
  readonly sessionsFile?: string;
}

const SESSION_COOKIE = 'peeqo_session';
const SESSION_MS = 30 * 24 * 3600_000;
const MAX_BODY = 64_000;
const LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 5 * 60_000;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export class RobotServer {
  readonly #o: ServerOptions;
  readonly #server: http.Server;
  readonly #sessions = new Map<string, number>();
  readonly #failures = new Map<string, { count: number; until: number }>();
  readonly #faceSockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  readonly #panelSockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  constructor(options: ServerOptions) {
    this.#o = options;
    if (options.sessionsFile) {
      try {
        const saved = JSON.parse(readFileOrNull(options.sessionsFile) ?? '{}') as Record<string, number>;
        for (const [hash, until] of Object.entries(saved)) if (typeof until === 'number' && until > Date.now()) this.#sessions.set(hash, until);
      } catch {
        // damaged: everyone signs in again
      }
    }
    this.#server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        options.robot.log(`web: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) json(res, 500, { error: 'Something went wrong' });
        else res.destroy();
      });
    });
    this.#server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      const local = isLoopback(req);
      if (pathname === '/ws/face' && (local || this.#authed(req)) && sameOrigin(req)) {
        this.#faceSockets.handleUpgrade(req, socket, head, (ws) => this.#face(ws));
      } else if (pathname === '/ws/panel' && this.#authed(req) && sameOrigin(req)) {
        this.#panelSockets.handleUpgrade(req, socket, head, (ws) => this.#panel(ws));
      } else {
        socket.destroy();
      }
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#o.port, this.#o.host ?? '0.0.0.0', () => resolve());
    });
  }

  get port(): number {
    const address = this.#server.address();
    return typeof address === 'object' && address ? address.port : this.#o.port;
  }

  close(): Promise<void> {
    for (const ws of [...this.#faceSockets.clients, ...this.#panelSockets.clients]) ws.terminate();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { robot, setup } = this.#o;
    const url = new URL(req.url ?? '/', 'http://x');
    const pathname = url.pathname;
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // While setting up, every page a phone checks (captive.apple.com, connectivitycheck…) leads to the setup page.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (setup.open && this.#o.setupAddress && host && host !== this.#o.setupAddress && !host.endsWith('.local') && !isLoopbackHost(host)) {
      res.writeHead(302, { Location: `http://${this.#o.setupAddress}/setup`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (!pathname.startsWith('/api/')) return this.#static(pathname, res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Not from this page' });

    if (pathname === '/api/info') {
      return json(res, 200, { name: robot.config.config.name, setup: setup.open, hasPin: robot.config.config.pinHash !== null, authed: this.#authed(req), fake: robot.options.fake });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '?';
      const lock = this.#failures.get(ip);
      if (lock && lock.count >= LOGIN_FAILURES && lock.until > Date.now()) return json(res, 429, { error: 'Too many wrong PINs. Wait a few minutes.' });
      const body = await readJson(req);
      if (typeof body.pin !== 'string' || !robot.config.checkPin(body.pin)) {
        const count = lock && lock.until > Date.now() ? lock.count + 1 : 1;
        this.#failures.set(ip, { count, until: Date.now() + LOGIN_LOCK_MS });
        return json(res, 401, { error: robot.config.config.pinHash === null ? 'No PIN has been set yet: open the setup page.' : 'That PIN is not right.' });
      }
      this.#failures.delete(ip);
      const token = randomBytes(32).toString('hex');
      this.#sessions.set(hashToken(token), Date.now() + SESSION_MS);
      this.#saveSessions();
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = cookie(req, SESSION_COOKIE);
      if (token && this.#sessions.delete(hashToken(token))) this.#saveSessions();
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/setup') {
      // Open while setting up, or before there is a PIN (a robot set up over a cable, or a laptop).
      if (!setup.open && robot.config.config.pinHash !== null && !this.#authed(req)) return json(res, 403, { error: 'Setup is not open. Hold a button on Peeqo for 10 seconds to start it.' });
      if (req.method === 'GET') return json(res, 200, { ...setup.view(), networks: await setup.networks() });
      if (req.method === 'POST') {
        const body = await readJson(req);
        const result = await setup.submit({
          ...(typeof body.ssid === 'string' ? { ssid: body.ssid } : {}),
          ...(typeof body.password === 'string' ? { password: body.password } : {}),
          ...(typeof body.pin === 'string' ? { pin: body.pin } : {}),
          ...(typeof body.openrouter === 'string' ? { openrouter: body.openrouter } : {}),
          ...(typeof body.klipy === 'string' ? { klipy: body.klipy } : {}),
        });
        return json(res, result.ok ? 200 : 400, result);
      }
    }

    // Everything below needs the PIN.
    if (!this.#authed(req)) return json(res, 401, { error: 'Sign in with the PIN' });
    if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, this.#state());
    if (req.method !== 'POST') return json(res, 404, { error: 'Unknown API route' });
    const body = await readJson(req);
    switch (pathname) {
      case '/api/say':
        if (typeof body.text === 'string') robot.say(body.text);
        return json(res, 200, { ok: true });
      case '/api/listen':
        robot.listen();
        return json(res, 200, { ok: true });
      case '/api/settings':
        return this.#settings(body, res);
      case '/api/memory/forget':
        return json(res, 200, { result: robot.memory.forget(typeof body.fact === 'string' ? body.fact : null, body.all === true) });
      case '/api/chat/clear':
        robot.body.hush();
        robot.brain.reset();
        return json(res, 200, { ok: true });
      case '/api/calibration':
        return this.#calibrate(body, res);
      case '/api/power': {
        const action = body.action;
        json(res, 200, { ok: true });
        if (action === 'shutdown') void robot.shutdown();
        else if (action === 'reboot') void robot.reboot();
        else if (action === 'restart') setTimeout(() => process.exit(0), 300); // the service manager starts it again
        else if (action === 'setup') void setup.enter('asked on the panel');
        return;
      }
      case '/api/button':
        if (typeof body.pin === 'number') robot.pressButton(body.pin, body.pressed === true);
        return json(res, 200, { ok: true });
      default:
        return json(res, 404, { error: 'Unknown API route' });
    }
  }

  #settings(body: Record<string, unknown>, res: ServerResponse): void {
    const { robot } = this.#o;
    const config = robot.config.config;
    const keys = { ...config.keys };
    // Keys are write-only: a value replaces it, an empty string removes it, leaving it out keeps it.
    if (typeof body.openrouter === 'string') keys.openrouter = body.openrouter.trim() || null;
    if (typeof body.klipy === 'string') keys.klipy = body.klipy.trim() || null;
    if (body.pin !== undefined) {
      if (!validPin(body.pin)) return json(res, 400, { error: 'The PIN must be 4 to 8 digits.' });
      robot.config.setPin(body.pin);
    }
    robot.config.update({
      keys,
      ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim().slice(0, 40) } : {}),
      ...(typeof body.model === 'string' ? { model: body.model.trim() || null } : {}),
      ...(typeof body.voice === 'boolean' ? { voice: body.voice } : {}),
    });
    robot.applySettings();
    json(res, 200, { ok: true });
  }

  #calibrate(body: Record<string, unknown>, res: ServerResponse): void {
    const session = this.#o.calibration;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const servo = (v: unknown) => (v === 0 || v === 1 || v === 2 ? v : null);
    switch (body.action) {
      case 'start':
        this.#o.robot.calibrating = true;
        session.start();
        break;
      case 'wiggle':
        session.wiggle();
        break;
      case 'identified': {
        const s = servo(body.servo);
        if (s !== null) session.identified(s);
        break;
      }
      case 'probe':
        session.probe();
        break;
      case 'plusMoved':
        session.plusMoved(body.up === true);
        break;
      case 'nudge':
        session.nudge(n(body.steps));
        break;
      case 'armLevel':
        session.armLevel();
        break;
      case 'trim':
        session.trim({ pitchDeg: n(body.pitchDeg), rollDeg: n(body.rollDeg), heaveMm: n(body.heaveMm) });
        break;
      case 'tilt':
        session.tilt();
        break;
      case 'reading':
        session.reading(n(body.deg));
        break;
      case 'save':
        if (!session.save()) return json(res, 400, { error: 'Not ready to save yet.', view: session.view() });
        break;
      case 'cancel':
        session.cancel();
        break;
      default:
        return json(res, 400, { error: 'Unknown calibration step' });
    }
    json(res, 200, { view: session.view() });
  }

  #state(): object {
    const { robot, setup, calibration } = this.#o;
    const config = robot.config.config;
    return {
      robot: robot.state(),
      settings: { name: config.name, model: config.model, voice: config.voice, keys: { openrouter: config.keys.openrouter !== null, klipy: config.keys.klipy !== null } },
      calibration: calibration.view(),
      setup: { open: setup.open, phase: setup.view().phase },
      transcript: robot.transcript.slice(-40),
      logs: robot.logs.slice(-80),
    };
  }

  #face(ws: WebSocket): void {
    const { robot } = this.#o;
    const send = (message: FaceMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    for (const message of robot.face.snapshot()) send(message);
    const unsubscribe = robot.face.subscribe(send);
    ws.on('message', (data) => {
      let reply: FaceReply;
      try {
        reply = JSON.parse(String(data)) as FaceReply;
      } catch {
        return;
      }
      if ((reply.t === 'mediaShown' || reply.t === 'mediaFailed') && typeof reply.id === 'number') robot.body.mediaReply(reply.id, reply.t === 'mediaShown');
    });
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  }

  #panel(ws: WebSocket): void {
    const { robot } = this.#o;
    const send = (message: object) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    send({ t: 'state', ...this.#state() });
    const timer = setInterval(() => send({ t: 'state', ...this.#state() }), 500);
    const offLine = robot.onTranscript((line) => send({ t: 'line', line }));
    const offLog = robot.onLog((line) => send({ t: 'log', line }));
    const stop = () => {
      clearInterval(timer);
      offLine();
      offLog();
    };
    ws.on('close', stop);
    ws.on('error', stop);
  }

  #static(pathname: string, res: ServerResponse): void {
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const page = pathname === '/' ? 'index.html' : pathname === '/face' ? 'face.html' : pathname === '/setup' ? 'setup.html' : pathname.slice(1);
    const file = path.resolve(this.#o.webDir, page);
    if (!file.startsWith(path.resolve(this.#o.webDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(fs.existsSync(path.join(this.#o.webDir, 'index.html')) ? 'Not found' : 'The pages are not built: run npm run build -w @peeqo/robot');
      return;
    }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': page.startsWith('assets/') ? 'max-age=31536000, immutable' : 'no-cache' });
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  #authed(req: IncomingMessage): boolean {
    const token = cookie(req, SESSION_COOKIE);
    if (!token) return false;
    const hash = hashToken(token);
    const until = this.#sessions.get(hash);
    if (!until || until < Date.now()) {
      if (this.#sessions.delete(hash)) this.#saveSessions();
      return false;
    }
    return true;
  }

  #saveSessions(): void {
    if (this.#o.sessionsFile) writeFileSafely(this.#o.sessionsFile, JSON.stringify(Object.fromEntries(this.#sessions)));
  }
}

/** Sessions are kept as hashes: the file alone cannot be used to sign in. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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
    req.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

/** Changes must come from a page served here: the browser's Origin must match the Host it asked. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin' || req.headers['sec-fetch-site'] === 'none';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
