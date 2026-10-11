import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WakeWordDetector, wakeWordReady, type WakeWordEvent } from '../src/index.ts';

// Speech is made with macOS `say`, so these run where both it and the detector's environment exist.
const canSpeak = process.platform === 'darwin' && existsSync('/usr/bin/say') && existsSync('/usr/bin/afconvert');
const dir = canSpeak ? mkdtempSync(path.join(tmpdir(), 'peeqo-wakeword-')) : '';
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Speech as 16 kHz mono 16-bit samples, with a second of silence either side. */
function speak(text: string): Int16Array {
  const aiff = path.join(dir, 'speech.aiff');
  const wav = path.join(dir, 'speech.wav');
  execFileSync('say', ['-v', 'Samantha', '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  const data = readFileSync(wav);
  const pcm = data.subarray(data.indexOf('data') + 8); // after the WAV header's data chunk id and size
  const speech = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1)));
  const silence = new Int16Array(16000);
  const all = new Int16Array(silence.length * 2 + speech.length);
  all.set(silence, 0);
  all.set(speech, silence.length);
  return all;
}

/** Runs audio through a fresh detector and returns what it reported. */
async function detect(samples: Int16Array): Promise<WakeWordEvent[]> {
  const events: WakeWordEvent[] = [];
  const detector = new WakeWordDetector({}, (e) => events.push(e));
  await detector.start();
  // Plus half a second of silence so the last chunk is processed (in one write: a second while the first is still
  // queued would be dropped, as audio is when the detector falls behind).
  const all = new Int16Array(samples.length + 8000);
  all.set(samples, 0);
  detector.write(all);
  const expected = Math.floor(all.length / 1280);
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (events.filter((e) => e.type === 'vad').length >= expected) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 20000) {
        clearInterval(timer);
        reject(new Error('the detector did not keep up'));
      }
    }, 50);
  });
  detector.stop();
  return events;
}

describe.skipIf(!canSpeak || !wakeWordReady())('WakeWordDetector (openWakeWord)', () => {
  it('wakes once on its wake word, and hears the speech', async () => {
    const events = await detect(speak('Hey Jarvis, what time is it?'));
    const wakes = events.filter((e) => e.type === 'wake');
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ word: 'hey_jarvis' });
    const speech = events.flatMap((e) => (e.type === 'vad' ? [e.speech] : []));
    expect(Math.max(...speech)).toBeGreaterThan(0.8); // someone is talking…
    expect(speech.slice(0, 8).every((s) => s < 0.3)).toBe(true); // …but not in the silence before
  }, 30000);

  it('does not wake on a look-alike phrase', async () => {
    const events = await detect(speak('Hey Jack, pass me the jar of jam'));
    expect(events.filter((e) => e.type === 'wake')).toHaveLength(0);
  }, 30000);
});

describe('WakeWordDetector', () => {
  it('says how to set it up when its environment is missing', async () => {
    const detector = new WakeWordDetector({ python: '/nonexistent/python' }, () => undefined);
    await expect(detector.start()).rejects.toThrow(/npm run setup -w @peeqo\/wakeword/);
  });

  it.skipIf(!existsSync('/usr/bin/python3'))('drops audio rather than queue it up when the detector falls behind', async () => {
    // A detector that never reads.
    const slow = path.join(mkdtempSync(path.join(tmpdir(), 'peeqo-slow-')), 'slow.py');
    writeFileSync(slow, 'import json, time\nprint(json.dumps({"type": "ready", "words": ["x"]}), flush=True)\ntime.sleep(30)\n');
    const detector = new WakeWordDetector({ python: '/usr/bin/python3', script: slow }, () => undefined);
    await detector.start();
    for (let i = 0; i < 200; i++) detector.write(new Int16Array(1280)); // 16 s of audio, all at once
    expect(detector.dropped).toBeGreaterThan(150);
    detector.stop();
    rmSync(path.dirname(slow), { recursive: true, force: true });
  });
});
