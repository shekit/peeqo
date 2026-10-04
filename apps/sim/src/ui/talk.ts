import { el, section } from './dom.ts';

export type BrainMode = 'offline' | 'live';

export interface TalkCallbacks {
  onSay(text: string): void;
  /** Record what is said next and send it, as audio. */
  onMic(): void;
  /** Keep listening for the wake word. */
  onWakeWord(on: boolean): void;
  onVoice(on: boolean): void;
  onBrain(mode: BrainMode): void;
  /** Start the conversation afresh (Peeqo keeps what it remembers). */
  onClearChat(): void;
  /** Peeqo forgets everything it remembers about you. */
  onForgetAll(): void;
}

export interface TalkPanel {
  addLine(who: 'you' | 'peeqo' | 'note', text: string): void;
  setStatus(text: string): void;
  /** Whether the live brain (OpenRouter, through the dev server) can be chosen. */
  setLive(available: boolean, label: string): void;
  setMic(state: 'idle' | 'listening' | 'unsupported'): void;
  /** Whether the wake word can be used (the dev server's voice channel is set up). */
  setWakeWord(available: boolean): void;
  /** What Peeqo remembers about you. */
  setMemory(facts: readonly string[]): void;
}

const MAX_LINES = 40;

/** "Talk to Peeqo": a transcript, a text box, the mic, and which brain answers. Goes just under the panel's header. */
export function createTalkPanel(host: HTMLElement, callbacks: TalkCallbacks): TalkPanel {
  const transcript = el('div', { class: 'transcript', 'aria-live': 'polite' });
  const input = el('input', { type: 'text', placeholder: 'Say something to Peeqo…', 'aria-label': 'Message', maxlength: 500 });
  const send = el('button', { type: 'button', text: 'Send' });
  const mic = el('button', { type: 'button', text: 'Mic', title: 'Say something: it is recorded and sent to the model as it is' });
  const voice = el('input', { type: 'checkbox' });
  const wake = el('input', { type: 'checkbox', disabled: true });
  const wakeLabel = el('label', { class: 'check', title: 'Needs npm run sim and npm run setup -w @peeqo/wakeword' }, wake, ' Wake word ("hey jarvis")');
  wake.addEventListener('change', () => callbacks.onWakeWord(wake.checked));
  const brain = el(
    'select',
    { 'aria-label': 'Brain' },
    el('option', { value: 'offline', text: 'offline brain (scripted)' }),
    el('option', { value: 'live', text: 'live brain (OpenRouter)', disabled: true }),
  );
  const status = el('p', { class: 'muted small talk-status', text: 'Offline brain: scripted answers, no network.' });
  const memorySummary = el('summary', { text: 'What Peeqo remembers (0)' });
  const memoryList = el('ul');
  const clearChat = el('button', { type: 'button', text: 'Clear chat', title: 'Start the conversation afresh; Peeqo keeps what it remembers' });
  const forgetAll = el('button', { type: 'button', text: 'Forget everything', title: 'Peeqo forgets everything it remembers about you' });
  clearChat.addEventListener('click', () => callbacks.onClearChat());
  forgetAll.addEventListener('click', () => callbacks.onForgetAll());
  const memory = el(
    'details',
    { class: 'memory' },
    memorySummary,
    memoryList,
    el('p', { class: 'muted small', text: 'Kept in apps/sim/.data/memory.md (with npm run sim). Tell Peeqo things about you, or ask it to forget them.' }),
    el('div', { class: 'row' }, clearChat, forgetAll),
  );

  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    callbacks.onSay(text);
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  mic.addEventListener('click', () => callbacks.onMic());
  voice.addEventListener('change', () => callbacks.onVoice(voice.checked));
  brain.addEventListener('change', () => callbacks.onBrain(brain.value === 'live' ? 'live' : 'offline'));

  const header = host.querySelector('header');
  const place = (node: HTMLElement) => (header ? header.after(node) : host.prepend(node));
  place(
    section(
      'Talk to Peeqo',
      transcript,
      el('div', { class: 'talk-row' }, input, send, mic),
      el('div', { class: 'row talk-options' }, el('label', { class: 'check', title: 'Off: Peeqo answers with GIFs and captions, as it always has' }, voice, ' Speak aloud'), wakeLabel, brain),
      status,
      memory,
    ),
  );

  return {
    addLine(who, text) {
      const line = el('p', { class: `line ${who}` }, el('b', { text: who === 'you' ? 'You' : who === 'peeqo' ? 'Peeqo' : '·' }), ` ${text}`);
      transcript.append(line);
      while (transcript.childElementCount > MAX_LINES) transcript.firstElementChild?.remove();
      transcript.scrollTop = transcript.scrollHeight;
    },
    setStatus(text) {
      status.textContent = text;
    },
    setLive(available, label) {
      const option = brain.querySelector('option[value="live"]') as HTMLOptionElement;
      option.disabled = !available;
      option.textContent = available ? `live brain (${label})` : 'live brain (needs npm run sim and an OpenRouter key)';
    },
    setWakeWord(available) {
      wake.disabled = !available;
      wakeLabel.title = available ? 'Keep the microphone open and listen for "hey jarvis"' : 'Needs npm run sim and npm run setup -w @peeqo/wakeword';
    },
    setMemory(facts) {
      memorySummary.textContent = `What Peeqo remembers (${facts.length})`;
      memoryList.replaceChildren(...(facts.length > 0 ? facts.map((fact) => el('li', { text: fact })) : [el('li', { class: 'muted', text: 'Nothing yet.' })]));
    },
    setMic(state) {
      mic.disabled = state === 'unsupported';
      mic.classList.toggle('active', state === 'listening');
      mic.textContent = state === 'listening' ? 'Listening…' : 'Mic';
      if (state === 'unsupported') mic.title = 'Speech recognition is not available in this browser';
    },
  };
}
