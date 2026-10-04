import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wakeWordReady } from '@peeqo/wakeword';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { createApi } from './server/api.ts';
import { attachVoice } from './server/voice.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The local API (model, GIFs, memory) for the dev and preview servers; keys stay in this Node process. */
function peeqoApi(mode: string): Plugin {
  const env = loadEnv(mode, repoRoot, ''); // the repo's .env; nothing here is exposed to the page
  const api = createApi({
    openRouterKey: env.OPENROUTER_API_KEY,
    klipyKey: env.KLIPY_API,
    voice: wakeWordReady(),
    cacheDir: path.join(repoRoot, 'apps/sim/.cache'),
    dataDir: path.join(repoRoot, 'apps/sim/.data'),
  });
  const words = env.PEEQO_WAKE_WORDS ? env.PEEQO_WAKE_WORDS.split(',').map((w) => w.trim()) : undefined;
  return {
    name: 'peeqo-api',
    configureServer: (server) => {
      server.middlewares.use(api);
      if (server.httpServer) attachVoice(server.httpServer as import('node:http').Server, words ? { words } : {});
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(api);
      attachVoice(server.httpServer as import('node:http').Server, words ? { words } : {});
    },
  };
}

// The 2019 content (servo animations, glasses, sounds) is read in place from electron/app/media. Vite already
// serves files anywhere in the workspace root (this repo), so no extra server.fs.allow entry is needed.
export default defineConfig(({ mode }) => ({
  plugins: [peeqoApi(mode)],
  build: {
    target: 'es2022',
    // three.js alone is ~700 kB; this is a local tool, not a website.
    chunkSizeWarningLimit: 1500,
  },
}));
