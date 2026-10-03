// The simulator's voice channel: a WebSocket at /api/voice. The page streams its microphone (16 kHz, 16-bit mono
// PCM, binary messages) and gets the wake word detector's events back as JSON text messages ({type: 'ready' |
// 'vad' | 'wake' | 'error', …}; see @peeqo/wakeword). Each connection has its own detector.

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WakeWordDetector, wakeWordReady, type WakeWordEvent } from '@peeqo/wakeword';
import { WebSocketServer } from 'ws';
import { fromThisPage } from './api.ts';

export interface VoiceOptions {
  /** Wake words (openWakeWord names or model files); default hey_jarvis. */
  readonly words?: readonly string[];
}

export function attachVoice(server: Server, options: VoiceOptions = {}): void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/voice') return; // Vite's own sockets pass through
    if (!fromThisPage(req)) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const send = (event: WakeWordEvent) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      };
      if (!wakeWordReady()) {
        send({ type: 'error', message: 'The wake word detector is not set up: run npm run setup -w @peeqo/wakeword' });
        ws.close();
        return;
      }
      const detector = new WakeWordDetector(options.words ? { words: options.words } : {}, send);
      detector.start().catch((error: unknown) => {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        ws.close();
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary && Buffer.isBuffer(data) && data.length % 2 === 0) detector.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });
      ws.on('close', () => detector.stop());
      ws.on('error', () => detector.stop());
    });
  });
}
