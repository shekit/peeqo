// Talks to the real model (and Klipy, and Open-Meteo) for a few turns, printing what Peeqo would do and what it
// remembers. Uses the keys in the repo's .env (OPENROUTER_API_KEY, KLIPY_API). Costs a few cents and a few GIF
// searches; run it by hand:
//
//   node packages/brain/scripts/live-check.ts ["something to say" …]
//   node packages/brain/scripts/live-check.ts --speak ["something to say" …]   (macOS: says it, sends the recording)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Alarms, Brain, KlipyClient, Memory, OpenRouterModel, Weather, alarmTools, clockTool, weatherTool, type BrainBody } from '../src/index.ts';

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!.replace(/^["']|["']$/g, '')]),
);
if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set in .env');

const speak = process.argv.includes('--speak');
const lines = process.argv.slice(2).filter((a) => a !== '--speak');

/** macOS `say` → 16 kHz mono WAV, base64. */
function recording(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'peeqo-say-'));
  try {
    execFileSync('say', ['-v', 'Samantha', '-o', path.join(dir, 'a.aiff'), text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path.join(dir, 'a.aiff'), path.join(dir, 'a.wav')]);
    return readFileSync(path.join(dir, 'a.wav')).toString('base64');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const body: BrainBody = {
  setState: (state) => console.log(`  [state] ${state}`),
  express: (name, intensity) => console.log(`  [express] ${name} ${intensity}`),
  showGif: async (gif) => console.log(`  [gif] ${gif.title || gif.id} (${gif.mp4 ? 'mp4' : 'gif'} ${gif.width}×${gif.height})`),
  say: async (text, voice) => console.log(`  [${voice ? 'say' : 'caption'}] ${text}`),
};
const alarms = new Alarms({ onDue: (alarm) => console.log(`  [alarm due] ${alarm.label}`) });
const gifs = env.KLIPY_API ? new KlipyClient({ apiKey: env.KLIPY_API, perHour: 5 }) : null;
const memory = new Memory(); // just for this run
const brain = new Brain({
  model: new OpenRouterModel({ apiKey: env.OPENROUTER_API_KEY, ...(env.PEEQO_MODEL ? { model: env.PEEQO_MODEL } : {}) }),
  body,
  gifs,
  memory,
  tools: [clockTool, ...alarmTools(alarms), weatherTool(new Weather())],
  onEvent: (e) => {
    if (e.type === 'reply') console.log(`  (${e.model}, ${e.ms} ms)`);
    if (e.type === 'tool') console.log(`  [tool ${e.name}] ${e.args} -> ${e.result.slice(0, 160)}`);
    if (e.type === 'understood') console.log(`  [heard] ${e.text}`);
    if (e.type === 'error') console.log(`  ERROR ${e.message}`);
  },
});
const turns = lines.length > 0 ? lines : ['Hi Peeqo! I just finished building you.', 'Tell me a joke.', 'Show me something that sums up Mondays.'];
for (const line of turns) {
  console.log(`> ${speak ? '(spoken) ' : ''}${line}`);
  const turn = await brain.hear(speak ? { audio: recording(line) } : line);
  if (turn.error) process.exitCode = 1;
}
console.log(`history: ${brain.history.map((m) => m.role).join(' ')}; timers: ${alarms.list().map((a) => `${a.id} ${a.label}`).join(', ') || 'none'}`);
console.log(`remembers: ${memory.facts.map((f) => `"${f}"`).join(', ') || 'nothing'}`);
