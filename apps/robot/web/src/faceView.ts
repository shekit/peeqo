import { ExpressiveFace, FACE_HEIGHT, FACE_WIDTH } from '@peeqo/face';
import qrcode from 'qrcode-generator';
import glassesUrl from '../../../../electron/app/media/imgs/glasses/glass-regular.png';

/** What the service sends (see src/face/mirroredFace.ts). */
type FaceMessage =
  | { t: 'emotion'; emotion: Parameters<ExpressiveFace['setEmotion']>[0]; intensity: number }
  | { t: 'look'; target: [number, number] | null }
  | { t: 'blink' }
  | { t: 'blinking'; on: boolean }
  | { t: 'media'; id: number; url: string; video: boolean; width: number; height: number; durationMs: number }
  | { t: 'hideMedia'; id?: number }
  | { t: 'caption'; text: string; durationMs: number }
  | { t: 'hideCaption'; text?: string }
  | { t: 'screen'; screen: { title: string; lines: string[]; qr?: string; tone?: 'info' | 'warn' } | null };

const MEDIA_LOAD_MS = 6000;

/**
 * Peeqo's face, drawn from the service's commands: its own ExpressiveFace (blinks and glances happen here), GIFs it
 * loads and reports back on, captions, and screens of information over the face (setup QR codes, its address).
 * The robot's screen shows it full size; the panel shows a small copy.
 */
export function startFace(canvas: HTMLCanvasElement, overlay: HTMLElement, options: { onConnection?: (connected: boolean) => void; fps?: number } = {}): void {
  canvas.width = FACE_WIDTH;
  canvas.height = FACE_HEIGHT;
  const context = canvas.getContext('2d')!;
  const face = new ExpressiveFace({ seed: (Math.random() * 2 ** 32) >>> 0 });
  const glasses = new Image();
  glasses.src = glassesUrl;
  void glasses.decode().then(
    () => face.setGlasses(glasses),
    () => undefined,
  );
  let socket: WebSocket | null = null;
  let activeId: number | null = null;
  const pending = new Map<number, () => void>();

  const reply = (t: 'mediaShown' | 'mediaFailed', id: number) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t, id }));
  };

  const showMedia = (m: Extract<FaceMessage, { t: 'media' }>) => {
    let done = false;
    let video: HTMLVideoElement | null = null;
    const finish = (ok: boolean, source?: CanvasImageSource, width?: number, height?: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pending.delete(m.id);
      if (!ok || !source) {
        release();
        reply('mediaFailed', m.id);
        return;
      }
      face.showMedia({ source, width: width || m.width, height: height || m.height }, performance.now(), m.durationMs);
      activeId = m.id;
      reply('mediaShown', m.id);
      // Freed once it is off the screen (a caption can keep it up for longer).
      const free = () => {
        const left = face.mediaEndMs(source) - performance.now();
        if (left > 0) setTimeout(free, left + 100);
        else release();
      };
      setTimeout(free, m.durationMs + 400);
    };
    const release = () => {
      if (!video) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
      video = null;
    };
    const timer = setTimeout(() => finish(false), MEDIA_LOAD_MS);
    pending.set(m.id, () => finish(false));
    if (m.video) {
      video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.src = m.url; // (from Klipy's servers: drawing it marks the canvas, which nothing reads back)
      video.addEventListener('loadeddata', () => {
        if (!video) return;
        void video.play().catch(() => undefined);
        finish(true, video, video.videoWidth, video.videoHeight);
      });
      video.addEventListener('error', () => finish(false));
    } else {
      const image = new Image();
      image.src = m.url;
      image.decode().then(
        () => finish(true, image, image.naturalWidth, image.naturalHeight),
        () => finish(false),
      );
    }
  };

  const showScreen = (screen: Extract<FaceMessage, { t: 'screen' }>['screen']) => {
    overlay.replaceChildren();
    overlay.hidden = screen === null;
    if (!screen) return;
    overlay.dataset.tone = screen.tone ?? 'info';
    const text = document.createElement('div');
    text.className = 'screen-text';
    const title = document.createElement('h1');
    title.textContent = screen.title;
    text.append(title, ...screen.lines.map((line) => Object.assign(document.createElement('p'), { textContent: line })));
    overlay.append(text);
    if (screen.qr) {
      const qr = qrcode(0, 'M');
      qr.addData(screen.qr);
      qr.make();
      const holder = document.createElement('div');
      holder.className = 'screen-qr';
      holder.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      overlay.append(holder);
    }
  };

  const handle = (m: FaceMessage) => {
    const now = performance.now();
    switch (m.t) {
      case 'emotion':
        face.setEmotion(m.emotion, m.intensity);
        break;
      case 'look':
        face.lookAt(m.target);
        break;
      case 'blink':
        face.blink(now);
        break;
      case 'blinking':
        face.setBlinking(m.on);
        break;
      case 'media':
        showMedia(m);
        break;
      case 'hideMedia':
        if (m.id === undefined) {
          for (const cancel of [...pending.values()]) cancel();
          face.hideMedia(now);
        } else {
          pending.get(m.id)?.();
          if (activeId === m.id) face.hideMedia(now);
        }
        break;
      case 'caption':
        if (m.text.trim() && m.durationMs > 0) face.showCaption(m.text, now, m.durationMs);
        break;
      case 'hideCaption':
        face.hideCaption(now, m.text);
        break;
      case 'screen':
        showScreen(m.screen);
        break;
    }
  };

  let retry = 500;
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/face`);
    socket = ws;
    ws.onopen = () => {
      retry = 500;
      options.onConnection?.(true);
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        handle(JSON.parse(event.data) as FaceMessage);
      } catch {
        // not for us
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      options.onConnection?.(false);
      setTimeout(connect, retry);
      retry = Math.min(5000, retry * 2);
    };
  };
  connect();

  // Drawn at most `fps` times a second (the robot's small Pi draws 30; the eyes' timing does not depend on it).
  const interval = 1000 / Math.min(60, Math.max(10, options.fps ?? 60));
  let lastDraw = -Infinity;
  const frame = (now: number) => {
    if (now - lastDraw >= interval - 4) {
      lastDraw = now;
      if (face.update(now)) face.draw(context);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
