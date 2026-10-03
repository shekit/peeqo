/**
 * The microphone, for talking to Peeqo out loud. Audio is taken at 16 kHz in 80 ms chunks and streamed to the dev
 * server's voice channel (/api/voice), where openWakeWord listens for the wake word and reports how likely each
 * chunk is to be speech. An utterance (after the wake word, or after pressing Mic) is recorded until a short silence
 * and handed over as a WAV recording, which goes to the model as it is. Without the voice channel, pressing Mic
 * still works, with a simple loudness check deciding when you have stopped.
 */
const SAMPLE_RATE = 16000;
const CHUNK = 1280; // 80 ms
/** Kept from before a recording starts, so its first sound is not clipped (Mic). */
const PREROLL_CHUNKS = 4;
/** After a wake word, only a little: the wake word itself is not part of what was said. */
const WAKE_PREROLL_CHUNKS = 1;
/** This much quiet after speech ends the recording. */
const END_QUIET_CHUNKS = 10; // 0.8 s
/** Give up if no speech starts within this. */
const NO_SPEECH_CHUNKS = 60; // 4.8 s
const MAX_CHUNKS = 125; // 10 s

export type VoiceState = 'off' | 'waiting' | 'recording';

export interface VoiceCallbacks {
  /** The wake word was heard; a recording has started. */
  onWake(word: string): void;
  /** A finished recording: WAV, base64. */
  onUtterance(wav: string): void;
  /** A recording ended without speech. */
  onNothing(): void;
  onState(state: VoiceState): void;
  onError(message: string): void;
}

// Copies each block of microphone samples to the main thread.
const TAP_WORKLET = `
class PeeqoTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('peeqo-tap', PeeqoTap);
`;

export class VoiceInput {
  readonly #callbacks: VoiceCallbacks;
  #context: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #socket: WebSocket | null = null;
  #wakeWord = false;
  /** The voice channel is answering (its speech scores are used). */
  #channelReady = false;
  #speech = 0;
  #noise = 0.004;
  #carry: number[] = [];
  #preroll: Int16Array[] = [];
  #recording: { chunks: Int16Array[]; spoke: boolean; speechRun: number; quiet: number } | null = null;
  /** While Peeqo talks it does not listen (it would hear itself). */
  #deaf = false;

  constructor(callbacks: VoiceCallbacks) {
    this.#callbacks = callbacks;
  }

  get state(): VoiceState {
    return this.#recording ? 'recording' : this.#context ? 'waiting' : 'off';
  }

  /** Opens the microphone; with `wakeWord`, keeps listening for it. */
  async open(wakeWord: boolean): Promise<void> {
    this.#wakeWord = wakeWord;
    if (!this.#context) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'text/javascript' }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const tap = new AudioWorkletNode(context, 'peeqo-tap');
      tap.port.onmessage = (event: MessageEvent<Float32Array>) => this.#samples(event.data, context.sampleRate);
      context.createMediaStreamSource(stream).connect(tap);
      this.#context = context;
      this.#stream = stream;
    }
    this.#connect();
    this.#callbacks.onState(this.state);
  }

  /** Stops listening for the wake word (the microphone stays open only while recording). */
  setWakeWord(on: boolean): void {
    this.#wakeWord = on;
    if (!on && !this.#recording) this.close();
  }

  /** Starts recording now (the Mic button). */
  record(): void {
    if (!this.#context) return;
    this.#startRecording(PREROLL_CHUNKS);
  }

  /** While Peeqo is talking, ignore what the microphone hears. */
  setDeaf(deaf: boolean): void {
    this.#deaf = deaf;
  }

  close(): void {
    this.#recording = null;
    this.#socket?.close();
    this.#socket = null;
    this.#channelReady = false;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    void this.#context?.close();
    this.#context = null;
    this.#stream = null;
    this.#callbacks.onState('off');
  }

  #connect(): void {
    if (this.#socket) return;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice`);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: { type: string; speech?: number; word?: string; message?: string };
      try {
        message = JSON.parse(event.data) as typeof message;
      } catch {
        return;
      }
      if (message.type === 'ready') this.#channelReady = true;
      else if (message.type === 'vad') this.#speech = message.speech ?? 0;
      else if (message.type === 'wake' && this.#wakeWord && !this.#recording && !this.#deaf) {
        this.#callbacks.onWake(message.word ?? 'wake word');
        this.#startRecording(WAKE_PREROLL_CHUNKS);
      } else if (message.type === 'error') this.#callbacks.onError(message.message ?? 'The voice channel failed');
    };
    socket.onclose = () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#channelReady = false;
        if (this.#wakeWord && this.#context) this.#callbacks.onError('The voice channel closed; the wake word is off');
      }
    };
  }

  /** Collects microphone samples into 80 ms chunks of 16-bit audio. */
  #samples(block: Float32Array, rate: number): void {
    // The context runs at 16 kHz where the browser allows; otherwise this resamples.
    const step = rate / SAMPLE_RATE;
    if (step === 1) for (const v of block) this.#carry.push(v);
    else for (let t = 0; t < block.length; t += step) this.#carry.push(block[Math.floor(t)]!);
    while (this.#carry.length >= CHUNK) {
      const chunk = new Int16Array(CHUNK);
      let energy = 0;
      for (let i = 0; i < CHUNK; i++) {
        const v = Math.max(-1, Math.min(1, this.#carry[i]!));
        chunk[i] = Math.round(v * 32767);
        energy += v * v;
      }
      this.#carry.splice(0, CHUNK);
      this.#chunk(chunk, Math.sqrt(energy / CHUNK));
    }
  }

  #chunk(chunk: Int16Array<ArrayBuffer>, rms: number): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(chunk);
    // Without the voice channel's scores, judge speech by loudness against a slowly learned noise floor.
    const loudness = Math.max(0, Math.min(1, (rms - this.#noise * 2) / (this.#noise * 6)));
    const speech = this.#channelReady ? this.#speech : loudness;
    if (!this.#recording) {
      this.#noise = Math.max(0.001, this.#noise + (rms - this.#noise) * (rms < this.#noise ? 0.2 : 0.01));
      this.#preroll.push(chunk);
      if (this.#preroll.length > PREROLL_CHUNKS) this.#preroll.shift();
      return;
    }
    const r = this.#recording;
    r.chunks.push(chunk);
    r.speechRun = speech > 0.5 ? r.speechRun + 1 : 0;
    if (r.speechRun >= 2) r.spoke = true;
    r.quiet = r.spoke && speech < 0.3 ? r.quiet + 1 : 0;
    if ((r.spoke && r.quiet >= END_QUIET_CHUNKS) || r.chunks.length >= MAX_CHUNKS) {
      this.#recording = null;
      this.#callbacks.onUtterance(wavBase64(r.chunks));
      this.#afterRecording();
    } else if (!r.spoke && r.chunks.length >= NO_SPEECH_CHUNKS) {
      this.#recording = null;
      this.#callbacks.onNothing();
      this.#afterRecording();
    }
  }

  #startRecording(preroll: number): void {
    if (this.#recording) return;
    this.#recording = { chunks: this.#preroll.slice(-preroll), spoke: false, speechRun: 0, quiet: 0 };
    this.#callbacks.onState('recording');
  }

  #afterRecording(): void {
    if (this.#wakeWord) this.#callbacks.onState('waiting');
    else this.close();
  }
}

/** 16 kHz mono 16-bit WAV, base64. */
export function wavBase64(chunks: readonly Int16Array[]): string {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  let at = 44;
  for (const chunk of chunks) {
    for (const v of chunk) {
      view.setInt16(at, v, true);
      at += 2;
    }
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
