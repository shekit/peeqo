/** The browser's speech recognition (Chrome, Edge, Safari), as a push-to-talk microphone. */
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionConstructor = new () => Recognition;

export interface MicCallbacks {
  /** Listening has begun (Peeqo should pay attention). */
  onStart(): void;
  onText(text: string): void;
  onState(state: 'idle' | 'listening' | 'unsupported'): void;
  onError(message: string): void;
}

export function createMic(callbacks: MicCallbacks): { toggle(): void } {
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  const Constructor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Constructor) {
    callbacks.onState('unsupported');
    return { toggle: () => undefined };
  }
  let active: Recognition | null = null;
  return {
    toggle() {
      if (active) {
        active.stop();
        return;
      }
      const recognition = new Constructor();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => {
        callbacks.onState('listening');
        callbacks.onStart();
      };
      recognition.onresult = (event) => {
        const text = event.results[0]?.[0]?.transcript?.trim();
        if (text) callbacks.onText(text);
      };
      recognition.onerror = (event) => {
        if (event.error !== 'no-speech' && event.error !== 'aborted') callbacks.onError(`Microphone: ${event.error}`);
      };
      recognition.onend = () => {
        active = null;
        callbacks.onState('idle');
      };
      active = recognition;
      recognition.start();
    },
  };
}
