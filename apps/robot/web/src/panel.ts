import { api, el } from './dom.ts';
import { startFace } from './faceView.ts';
import { calibrationCard, type CalibrationView } from './calibrationCard.ts';
import { expressionsCard } from './expressionsCard.ts';
import './style.css';

interface PanelState {
  robot: {
    name: string;
    character: { state: string; expression: string | null; move: string | null; lights: string | null };
    brain: { model: string; live: boolean; gifs: boolean; voice: boolean };
    hardware: { servos: boolean; leds: boolean; buttons: number[]; fake: boolean } | null;
    servos: { mode: string; pulsesUs: number[] | null; calibrated: boolean; fault: string | null };
    motion: { status: string; notes: string[]; pose: { pitchDeg: number; rollDeg: number; heaveMm: number } };
    listening: { wakeWord: boolean; microphone: boolean; recording: boolean };
    memory: string[];
    timers: { id: string; kind: string; label: string; inMs: number }[];
    health: { tempC: number | null; underVoltage: boolean; underVoltageSeen: boolean; slowedForHeat: boolean; throttled: boolean } | null;
  };
  settings: { name: string; model: string | null; voice: boolean; keys: { openrouter: boolean; klipy: boolean } };
  calibration: CalibrationView;
  setup: { open: boolean; phase: string };
  transcript: { at: number; who: 'you' | 'peeqo' | 'note'; text: string }[];
  logs: string[];
}

interface Info {
  name: string;
  setup: boolean;
  hasPin: boolean;
  authed: boolean;
  fake: boolean;
}

const app = document.getElementById('app')!;

async function start(): Promise<void> {
  const { data: info } = await api<Info>('/api/info');
  document.title = info.name;
  if (!info.authed) return login(info);
  dashboard(info);
}

function login(info: Info): void {
  const pin = el('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 8, placeholder: 'PIN', autocomplete: 'current-password', autofocus: true });
  const message = el('p', { class: 'message error', hidden: true });
  const form = el('form', { class: 'card', style: 'max-width: 360px; margin: 10vh auto' }, el('h1', { text: info.name, style: 'margin-top: 0' }), info.hasPin ? null : el('p', { class: 'message', text: 'No PIN yet: ' }, el('a', { href: '/setup', text: 'set one up' })), el('div', { class: 'row' }, pin, el('button', { class: 'primary', text: 'Sign in' })), message);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void api<{ error?: string }>('/api/login', { pin: pin.value }).then(({ ok, data }) => {
      if (ok) return void start();
      message.hidden = false;
      message.textContent = data.error ?? 'That did not work.';
      pin.value = '';
    });
  });
  app.replaceChildren(form);
}

function dashboard(info: Info): void {
  // Face
  const canvas = el('canvas', { style: 'width: 100%; border-radius: 8px; background: #000; display: block' });
  const overlay = el('div', { hidden: true, style: 'position: absolute; inset: 0; background: rgba(255,255,255,.95); display: flex; gap: 8px; padding: 10px; font-size: 12px; overflow: hidden' });
  const faceLink = el('span', { class: 'chip', text: 'connecting…' });
  startFace(canvas, overlay, { onConnection: (on) => ((faceLink.textContent = on ? 'live' : 'reconnecting…'), faceLink.classList.toggle('ok', on)) });
  const chips = el('div', { class: 'chips' });

  // Talk
  const transcript = el('div', { style: 'height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px; font-size: 14px' });
  const input = el('input', { placeholder: 'Say something to Peeqo…', style: 'flex: 1', maxlength: 500 });
  const sayForm = el('form', { class: 'row', style: 'margin-top: 8px' }, input, el('button', { class: 'primary', text: 'Send' }));
  sayForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    void api('/api/say', { text: input.value });
    input.value = '';
  });
  const listen = el('button', { text: '🎤 Listen' });
  listen.addEventListener('click', () => void api('/api/listen', {}));

  // Memory and timers
  const memoryList = el('ul', { style: 'margin: 0; padding-left: 18px' });
  const timersList = el('ul', { style: 'margin: 0; padding-left: 18px' });
  const forgetAll = el('button', { class: 'danger', text: 'Forget everything' });
  forgetAll.addEventListener('click', () => confirm('Forget everything Peeqo remembers about you?') && void api('/api/memory/forget', { all: true }));
  const clearChat = el('button', { text: 'Clear chat' });
  clearChat.addEventListener('click', () => void api('/api/chat/clear', {}));

  // Settings
  const name = el('input', { placeholder: 'Name' });
  const model = el('input', { placeholder: 'default (google/gemini-3.8-flash)' });
  const openrouter = el('input', { type: 'password', placeholder: 'leave empty to keep', autocomplete: 'off' });
  const klipy = el('input', { type: 'password', placeholder: 'leave empty to keep', autocomplete: 'off' });
  const voice = el('input', { type: 'checkbox' });
  const newPin = el('input', { type: 'password', inputmode: 'numeric', maxlength: 8, placeholder: 'leave empty to keep', autocomplete: 'new-password' });
  const keyState = el('p', { class: 'muted small' });
  const settingsMessage = el('p', { class: 'message', hidden: true });
  const saveSettings = el('button', { class: 'primary', text: 'Save settings' });
  saveSettings.addEventListener('click', () => {
    const change: Record<string, unknown> = { name: name.value, model: model.value, voice: voice.checked };
    if (openrouter.value.trim()) change.openrouter = openrouter.value;
    if (klipy.value.trim()) change.klipy = klipy.value;
    if (newPin.value) change.pin = newPin.value;
    void api<{ error?: string }>('/api/settings', change).then(({ ok, data }) => {
      settingsMessage.hidden = false;
      settingsMessage.textContent = ok ? 'Saved.' : (data.error ?? 'Not saved.');
      settingsMessage.classList.toggle('error', !ok);
      openrouter.value = '';
      klipy.value = '';
      newPin.value = '';
    });
  });
  let settingsLoaded = false;

  // Power
  const power = (action: string, question: string) => () => confirm(question) && void api('/api/power', { action });
  const powerRow = el(
    'div',
    { class: 'row' },
    Object.assign(el('button', { text: 'Restart Peeqo' }), { onclick: power('restart', 'Restart Peeqo’s software?') }),
    Object.assign(el('button', { text: 'Reboot' }), { onclick: power('reboot', 'Reboot the robot?') }),
    Object.assign(el('button', { class: 'danger', text: 'Shut down' }), { onclick: power('shutdown', 'Shut Peeqo down? Wait for the screen to go dark before unplugging.') }),
    Object.assign(el('button', { text: 'Join another Wi-Fi…' }), { onclick: power('setup', 'Start setup mode? Peeqo leaves this Wi-Fi and shows a QR code on its face.') }),
  );
  const signOut = el('button', { text: 'Sign out' });
  signOut.addEventListener('click', () => void api('/api/logout', {}).then(() => location.reload()));

  // Pretend buttons (laptop only)
  const fakeButtons = info.fake
    ? el(
        'section',
        { class: 'card' },
        el('h2', { text: 'Pretend buttons (no hardware)' }),
        el('div', { class: 'row' }, ...[['Tap', 150], ['Show address (1.5 s)', 1500], ['Shut down (4 s)', 4000], ['Setup (11 s)', 11000]].map(([label, ms]) => Object.assign(el('button', { text: String(label) }), { onclick: () => pressFor(16, Number(ms)) }))),
      )
    : null;

  const log = el('pre', { style: 'max-height: 260px; overflow: auto; font-size: 12px; margin: 0; white-space: pre-wrap' });
  const calibration = el('section', { class: 'card' });
  const calibrate = calibrationCard(calibration);
  const expressions = el('section', { class: 'card wide' });
  const markPlaying = expressionsCard(expressions);

  app.replaceChildren(
    el('header', { class: 'top' }, el('h1', { text: info.name }), faceLink, el('span', { class: 'grow' }), signOut),
    el(
      'div',
      { class: 'grid' },
      el('section', { class: 'card' }, el('h2', { text: 'Face' }), el('div', { style: 'position: relative' }, canvas, overlay), el('div', { style: 'margin-top: 8px' }, chips)),
      el('section', { class: 'card' }, el('h2', { text: 'Talk' }), transcript, sayForm, el('div', { class: 'row', style: 'margin-top: 8px' }, listen)),
      el('section', { class: 'card' }, el('h2', { text: 'What Peeqo remembers' }), memoryList, el('div', { class: 'row', style: 'margin-top: 10px' }, clearChat, forgetAll), el('h2', { text: 'Timers', style: 'margin-top: 16px' }), timersList),
      expressions,
      calibration,
      el(
        'section',
        { class: 'card' },
        el('h2', { text: 'Settings' }),
        el('label', { class: 'field' }, el('span', { text: 'Name' }), name),
        el('label', { class: 'field' }, el('span', { text: 'OpenRouter key' }), openrouter),
        el('label', { class: 'field' }, el('span', { text: 'Klipy key' }), klipy),
        keyState,
        el('label', { class: 'field' }, el('span', { text: 'Model' }), model),
        el('label', { class: 'row' }, voice, el('span', { text: 'Speak aloud (off: GIFs and captions)' })),
        el('label', { class: 'field' }, el('span', { text: 'New PIN' }), newPin),
        saveSettings,
        settingsMessage,
      ),
      el('section', { class: 'card' }, el('h2', { text: 'Power' }), powerRow),
      fakeButtons,
      el('details', { class: 'card' }, el('summary', { text: 'Log' }), log),
    ),
  );

  const addLine = (line: PanelState['transcript'][number]) => {
    transcript.append(el('p', { style: `margin: 3px 0; ${line.who === 'note' ? 'color: var(--muted); font-size: 12px' : ''}` }, el('b', { text: line.who === 'you' ? 'You ' : line.who === 'peeqo' ? 'Peeqo ' : '· ' }), line.text));
    while (transcript.childElementCount > 120) transcript.firstElementChild?.remove();
    transcript.scrollTop = transcript.scrollHeight;
  };

  let firstState = true;
  let lastMemory = '';
  const showState = (s: PanelState) => {
    const r = s.robot;
    if (firstState) {
      firstState = false;
      for (const line of s.transcript) addLine(line);
      log.textContent = s.logs.join('\n');
    }
    if (!settingsLoaded) {
      settingsLoaded = true;
      name.value = s.settings.name;
      model.value = s.settings.model ?? '';
      voice.checked = s.settings.voice;
    }
    keyState.textContent = `OpenRouter key ${s.settings.keys.openrouter ? 'set' : 'not set (offline brain)'} · Klipy key ${s.settings.keys.klipy ? 'set' : 'not set (no GIFs)'}`;
    const chip = (text: string, tone?: 'ok' | 'warn') => el('span', { class: `chip ${tone ?? ''}`, text });
    chips.replaceChildren(
      chip(r.character.expression ? `${r.character.state} · ${r.character.expression}` : r.character.state),
      chip(r.brain.live ? r.brain.model : 'offline brain', r.brain.live ? 'ok' : undefined),
      chip(r.hardware ? (r.hardware.fake ? 'no hardware (laptop)' : `servos ${r.hardware.servos ? '✓' : '✗'} · LEDs ${r.hardware.leds ? '✓' : '✗'}`) : 'hardware helper not running', r.hardware && !r.hardware.fake && r.hardware.servos && r.hardware.leds ? 'ok' : 'warn'),
      chip(r.servos.calibrated ? `servos ${r.servos.mode}` : 'not calibrated', r.servos.calibrated ? 'ok' : 'warn'),
      chip(r.listening.microphone ? (r.listening.wakeWord ? 'listening for its wake word' : 'microphone on') : 'no microphone'),
      ...(r.health?.tempC != null ? [chip(`${r.health.tempC.toFixed(0)} °C${r.health.throttled ? ' · throttled' : r.health.slowedForHeat ? ' · slowed to cool' : ''}`, r.health.throttled ? 'warn' : undefined)] : []),
      ...(r.health?.underVoltage || r.health?.underVoltageSeen ? [chip(r.health.underVoltage ? 'power supply too weak' : 'power dipped since start-up', 'warn')] : []),
      ...(r.servos.fault ? [chip(r.servos.fault, 'warn')] : []),
      ...(r.motion.status !== 'ok' ? [chip(`motion ${r.motion.status}`, 'warn')] : []),
    );
    const memory = JSON.stringify(r.memory);
    if (memory !== lastMemory) {
      lastMemory = memory;
      memoryList.replaceChildren(
        ...(r.memory.length > 0
          ? r.memory.map((fact) => {
              const forget = el('button', { class: 'small', text: 'forget', style: 'margin-left: 6px; padding: 1px 7px' });
              forget.addEventListener('click', () => void api('/api/memory/forget', { fact }));
              return el('li', {}, fact, forget);
            })
          : [el('li', { class: 'muted', text: 'Nothing yet. Tell Peeqo about yourself.' })]),
      );
    }
    timersList.replaceChildren(...(r.timers.length > 0 ? r.timers.map((t) => el('li', { text: `${t.label} (${t.kind}) in ${Math.max(0, Math.round(t.inMs / 1000))} s` })) : [el('li', { class: 'muted', text: 'None.' })]));
    calibrate(s.calibration, r.servos.calibrated);
    markPlaying({ expression: r.character.expression, move: r.character.move, lights: r.character.lights });
  };

  let retry = 500;
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/panel`);
    ws.onopen = () => (retry = 500);
    ws.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as { t: string } & Record<string, unknown>;
      if (message.t === 'state') showState(message as unknown as PanelState);
      else if (message.t === 'line') addLine(message.line as PanelState['transcript'][number]);
      else if (message.t === 'log') {
        log.textContent = `${log.textContent ?? ''}\n${String(message.line)}`.split('\n').slice(-300).join('\n');
      }
    };
    ws.onclose = () => {
      setTimeout(() => void api<Info>('/api/info').then(({ data }) => (data.authed ? connect() : login(data))), retry);
      retry = Math.min(5000, retry * 2);
    };
  };
  connect();
}

function pressFor(pin: number, ms: number): void {
  void api('/api/button', { pin, pressed: true });
  setTimeout(() => void api('/api/button', { pin, pressed: false }), ms);
}

void start();
