import { api, el } from './dom.ts';
import './style.css';

interface SetupState {
  phase: 'off' | 'hotspot' | 'connecting' | 'failed';
  error: string | null;
  networks: { ssid: string; signal: number; secure: boolean }[];
  hasPin: boolean;
}

/**
 * The setup page a phone opens on Peeqo's setup network: choose the home Wi-Fi, a PIN for the panel and, if wanted,
 * the API keys. Peeqo then joins the network and shows its new address on its face.
 */
const app = document.getElementById('app')!;

async function start(): Promise<void> {
  const { ok, data } = await api<SetupState & { error?: string }>('/api/setup');
  if (!ok) {
    app.replaceChildren(el('h1', { text: 'Set up Peeqo' }), el('p', { class: 'message', text: data.error ?? 'Setup is not open.' }));
    return;
  }
  render(data);
}

function render(state: SetupState): void {
  const needWifi = state.phase !== 'off';
  const picked = { ssid: state.networks[0]?.ssid ?? '', secure: state.networks[0]?.secure ?? true };
  const password = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Wi-Fi password' });
  const passwordRow = el('label', { class: 'field' }, el('span', { text: 'Password' }), password);
  const other = el('input', { type: 'text', placeholder: 'Network name', autocapitalize: 'off', autocomplete: 'off' });
  const otherRow = el('label', { class: 'field', hidden: true }, el('span', { text: 'Other network' }), other);
  const list = el('div', { class: 'networks' });
  const choose = (ssid: string, secure: boolean) => {
    picked.ssid = ssid;
    picked.secure = secure;
    otherRow.hidden = ssid !== '';
    passwordRow.hidden = !secure;
  };
  for (const network of state.networks) {
    const radio = el('input', { type: 'radio', name: 'ssid', checked: network.ssid === picked.ssid });
    radio.addEventListener('change', () => choose(network.ssid, network.secure));
    list.append(el('label', { class: 'row', style: 'padding: 6px 0' }, radio, el('span', { class: 'grow', text: network.ssid }), el('span', { class: 'muted small', text: `${network.secure ? '🔒 ' : ''}${bars(network.signal)}` })));
  }
  const otherRadio = el('input', { type: 'radio', name: 'ssid', checked: state.networks.length === 0 });
  otherRadio.addEventListener('change', () => choose('', true));
  list.append(el('label', { class: 'row', style: 'padding: 6px 0' }, otherRadio, el('span', { text: 'Another network…' })));
  if (state.networks.length === 0) choose('', true);
  else choose(picked.ssid, picked.secure);

  const pin = el('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 8, placeholder: '4 to 8 digits', autocomplete: 'new-password' });
  const openrouter = el('input', { type: 'password', placeholder: 'sk-or-…', autocomplete: 'off' });
  const klipy = el('input', { type: 'password', placeholder: 'Klipy key', autocomplete: 'off' });
  const status = el('p', { class: 'message', hidden: !state.error, text: state.error ?? '' });
  if (state.error) status.classList.add('error');
  const submit = el('button', { class: 'primary', type: 'submit', text: needWifi ? 'Connect' : 'Save' });
  const form = el(
    'form',
    {},
    needWifi ? el('section', { class: 'card' }, el('h2', { text: '1. Your Wi-Fi' }), list, otherRow, passwordRow) : null,
    el(
      'section',
      { class: 'card', style: 'margin-top: 12px' },
      el('h2', { text: `${needWifi ? '2. ' : ''}A PIN for the panel` }),
      el('p', { class: 'muted small', text: state.hasPin ? 'Leave empty to keep the PIN you have.' : 'So only you can control Peeqo from your phone or laptop.' }),
      pin,
    ),
    el(
      'details',
      { class: 'card', style: 'margin-top: 12px' },
      el('summary', { text: `${needWifi ? '3. ' : ''}API keys (optional, you can add them later)` }),
      el('label', { class: 'field' }, el('span', { text: 'OpenRouter key (the AI brain)' }), openrouter),
      el('label', { class: 'field' }, el('span', { text: 'Klipy key (GIFs)' }), klipy),
    ),
    status,
    el('p', {}, submit),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const ssid = picked.ssid || other.value.trim();
    submit.disabled = true;
    status.hidden = false;
    status.classList.remove('error');
    status.textContent = 'Saving…';
    void api<{ ok: boolean; message: string; error?: string }>('/api/setup', {
      ...(needWifi ? { ssid, password: picked.secure || !picked.ssid ? password.value : '' } : {}),
      pin: pin.value,
      openrouter: openrouter.value,
      klipy: klipy.value,
    }).then(({ ok, data }) => {
      status.textContent = data.message ?? data.error ?? (ok ? 'Done.' : 'Something went wrong.');
      status.classList.toggle('error', !ok);
      submit.disabled = ok && needWifi;
      if (!ok) submit.disabled = false;
    });
  });
  app.replaceChildren(el('h1', { text: 'Set up Peeqo' }), el('p', { class: 'muted', text: needWifi ? 'Choose the Wi-Fi Peeqo should join.' : 'Peeqo is online. Choose a PIN for its panel.' }), form);
}

function bars(signal: number): string {
  return signal > 75 ? '▂▄▆█' : signal > 50 ? '▂▄▆' : signal > 25 ? '▂▄' : '▂';
}

void start();
