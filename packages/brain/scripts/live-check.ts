// Talks to the real model (and Klipy) for a few turns, printing what Peeqo would do. Uses the keys in the repo's
// .env (OPENROUTER_API_KEY, KLIPY_API). Costs a few cents and a few GIF searches; run it by hand:
//
//   node packages/brain/scripts/live-check.ts ["something to say" …]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Brain, KlipyClient, OpenRouterModel, type BrainBody } from '../src/index.ts';

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!.replace(/^["']|["']$/g, '')]),
);
if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set in .env');

const body: BrainBody = {
  setState: (state) => console.log(`  [state] ${state}`),
  express: (name, intensity) => console.log(`  [express] ${name} ${intensity}`),
  showGif: async (gif) => console.log(`  [gif] ${gif.title || gif.id} (${gif.mp4 ? 'mp4' : 'gif'} ${gif.width}×${gif.height})`),
  say: async (text, voice) => console.log(`  [${voice ? 'say' : 'caption'}] ${text}`),
};
const gifs = env.KLIPY_API ? new KlipyClient({ apiKey: env.KLIPY_API, perHour: 5 }) : null;
const brain = new Brain({
  model: new OpenRouterModel({ apiKey: env.OPENROUTER_API_KEY }),
  body,
  gifs,
  onEvent: (e) => {
    if (e.type === 'reply') console.log(`  (${e.model}, ${e.ms} ms)`);
    if (e.type === 'tool') console.log(`  [tool ${e.name}] ${e.args} -> ${e.result}`);
    if (e.type === 'error') console.log(`  ERROR ${e.message}`);
  },
});
const lines = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['Hi Peeqo! I just finished building you.', 'Tell me a joke.', 'Show me something that sums up Mondays.'];
for (const line of lines) {
  console.log(`> ${line}`);
  const turn = await brain.hear(line);
  if (turn.error) process.exitCode = 1;
}
console.log(`history: ${brain.history.map((m) => m.role).join(' ')}; GIF searches left this hour (this run's budget): ${gifs?.remaining ?? 'n/a'}`);
