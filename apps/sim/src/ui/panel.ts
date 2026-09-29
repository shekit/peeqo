import {
  CLASSIC_LED_ANIMATIONS,
  CLASSIC_LED_COLORS,
  HOME_POSE,
  SERVO_TO_CHANNEL,
  hornDegToPulseUs,
  isClassicLedColor,
  type ClassicLedAnimation,
  type ClassicLedColor,
  type GovernorOutput,
  type PlatformGeometry,
  type Pose,
  type SafetyLimits,
} from '@peeqo/core';
import { VIEWS, type ViewName } from '../scene/stage.ts';
import { EnvelopePlot } from './envelopePlot.ts';

export interface PanelCallbacks {
  onTarget(pose: Pose): void;
  onAnimation(name: string): void;
  onReaction(name: string): void;
  onLeds(animation: ClassicLedAnimation, color: ClassicLedColor): void;
  onGlasses(name: string | null): void;
  onBlink(): void;
  onView(name: ViewName): void;
  onShowRequested(show: boolean): void;
}

export interface PanelOptions {
  readonly geometry: PlatformGeometry;
  readonly limits: SafetyLimits;
  readonly animations: readonly string[];
  readonly reactions: readonly string[];
  readonly glasses: readonly string[];
  readonly initialGlasses: string | null;
}

export interface Panel {
  /** Refreshes readouts; call once per frame. */
  update(output: GovernorOutput, playing: string | null): void;
  /** Moves the sliders to show a target (without triggering onTarget). */
  showTarget(pose: Pose): void;
}

type Attrs = Record<string, string | number | boolean>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = String(value);
    else if (typeof value === 'boolean') {
      if (value) node.setAttribute(key, '');
    } else node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}

function section(title: string, ...children: (Node | string)[]): HTMLElement {
  return el('section', {}, el('h2', { text: title }), ...children);
}

const fmt = (value: number, digits = 1) => (Object.is(Math.round(value * 10 ** digits), -0) ? 0 : value).toFixed(digits);

export function createPanel(host: HTMLElement, options: PanelOptions, callbacks: PanelCallbacks): Panel {
  const { limits } = options;
  host.replaceChildren();

  // ---- header with the safety status ----
  const status = el('span', { class: 'status ok', text: 'SAFE' });
  host.append(el('header', {}, el('h1', { text: 'Peeqo sim' }), status));

  // ---- head pose ----
  const axes = [
    { key: 'pitchDeg', label: 'Pitch (look up +)', unit: '°', min: -limits.maxAbsPitchDeg, max: limits.maxAbsPitchDeg },
    { key: 'rollDeg', label: 'Roll (tilt to its right +)', unit: '°', min: -limits.maxAbsRollDeg, max: limits.maxAbsRollDeg },
    { key: 'heaveMm', label: 'Height', unit: ' mm', min: limits.minHeaveMm, max: limits.maxHeaveMm },
  ] as const;
  const sliders = new Map<keyof Pose, { input: HTMLInputElement; target: HTMLElement; actual: HTMLElement }>();
  const target: { -readonly [K in keyof Pose]: number } = { ...HOME_POSE };
  const rows = axes.map((axis) => {
    const input = el('input', { type: 'range', min: axis.min, max: axis.max, step: 0.1, value: 0, 'aria-label': axis.label });
    const targetText = el('span', { class: 'mono', text: `0.0${axis.unit}` });
    const actualText = el('span', { class: 'mono muted', text: `0.0${axis.unit}` });
    input.addEventListener('input', () => {
      target[axis.key] = Number(input.value);
      targetText.textContent = `${fmt(target[axis.key])}${axis.unit}`;
      callbacks.onTarget({ ...target });
    });
    sliders.set(axis.key, { input, target: targetText, actual: actualText });
    return el(
      'div',
      { class: 'slider' },
      el('div', { class: 'slider-label' }, el('span', { text: axis.label }), el('span', {}, targetText, ' → ', actualText)),
      input,
    );
  });
  const home = el('button', { type: 'button', text: 'Home' });
  home.addEventListener('click', () => callbacks.onTarget({ ...HOME_POSE }));
  host.append(section('Head pose (target → actual)', ...rows, el('div', { class: 'row' }, home)));

  // ---- safe range ----
  const plotCanvas = el('canvas', { class: 'envelope', width: 480, height: 480 });
  const plot = new EnvelopePlot(plotCanvas, options.geometry, limits);
  const notes = el('ul', { class: 'notes' });
  const ghostToggle = el('input', { type: 'checkbox', checked: true });
  ghostToggle.addEventListener('change', () => callbacks.onShowRequested(ghostToggle.checked));
  host.append(
    section(
      'Safe range at this height',
      plotCanvas,
      el('p', { class: 'legend' }, el('span', { class: 'swatch safe' }), ' safe  ○ requested  ◆ goal  ● now'),
      el('label', { class: 'check' }, ghostToggle, ' Show requested pose in red when it is unsafe'),
      notes,
    ),
  );

  // ---- servos ----
  const servoRows = [0, 1, 2].map((channel) => {
    const horn = el('td', { class: 'mono' });
    const pulse = el('td', { class: 'mono' });
    const fill = el('div', { class: 'fill' });
    const servo = SERVO_TO_CHANNEL.indexOf(channel as 0 | 1 | 2);
    const tr = el('tr', {}, el('td', { text: `CH${channel}` }), el('td', { class: 'muted', text: `servo ${servo}` }), horn, pulse, el('td', {}, el('div', { class: 'bar' }, fill)));
    return { tr, horn, pulse, fill, servo };
  });
  host.append(
    section(
      'Servos (PCA9685)',
      el(
        'table',
        { class: 'servos' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Ch' }), el('th', { text: '' }), el('th', { text: 'Horn' }), el('th', { text: 'Pulse' }), el('th', { text: `${limits.hornMinDeg}° … ${limits.hornMaxDeg}°` }))),
        el('tbody', {}, ...servoRows.map((r) => r.tr)),
      ),
    ),
  );

  // ---- motion ----
  const buttonRow = (names: readonly string[], onClick: (name: string) => void) =>
    el(
      'div',
      { class: 'buttons' },
      ...names.map((name) => {
        const b = el('button', { type: 'button', text: name, 'data-name': name });
        b.addEventListener('click', () => onClick(name));
        return b;
      }),
    );
  const animationButtons = buttonRow(options.animations, callbacks.onAnimation);
  host.append(section('2019 head animations', animationButtons));
  host.append(
    section(
      '2019 reactions',
      buttonRow(options.reactions, callbacks.onReaction),
      el('p', { class: 'muted small', text: 'Motion, lights and sound from responses.js. Their GIFs/videos are not played yet.' }),
    ),
  );

  // ---- LEDs ----
  const ledAnim = el('select', { 'aria-label': 'LED animation' }, ...CLASSIC_LED_ANIMATIONS.map((a) => el('option', { value: a, text: a })));
  const ledColor = el(
    'select',
    { 'aria-label': 'LED colour' },
    ...Object.keys(CLASSIC_LED_COLORS)
      .filter((c) => c !== 'black')
      .map((c) => el('option', { value: c, text: c })),
  );
  ledColor.value = 'aqua';
  const ledPlay = el('button', { type: 'button', text: 'Play' });
  ledPlay.addEventListener('click', () => {
    const color = ledColor.value;
    const animation = CLASSIC_LED_ANIMATIONS.find((a) => a === ledAnim.value);
    if (animation && isClassicLedColor(color)) callbacks.onLeds(animation, color);
  });
  host.append(section('LED ring (2019 animations)', el('div', { class: 'row' }, ledAnim, ledColor, ledPlay)));

  // ---- face ----
  const glasses = el('select', { 'aria-label': 'Glasses' }, el('option', { value: '', text: 'no glasses' }), ...options.glasses.map((g) => el('option', { value: g, text: g })));
  glasses.value = options.initialGlasses ?? '';
  glasses.addEventListener('change', () => callbacks.onGlasses(glasses.value || null));
  const blink = el('button', { type: 'button', text: 'Blink' });
  blink.addEventListener('click', () => callbacks.onBlink());
  host.append(section('Face', el('div', { class: 'row' }, glasses, blink)));

  // ---- view ----
  host.append(section('View', buttonRow(Object.keys(VIEWS), (name) => callbacks.onView(name as ViewName))));

  host.append(
    el(
      'footer',
      {},
      el('p', { text: 'Neck geometry: 2019 ServoSimulator values (not yet measured on the dev kit). Head: 2016 v1 CAD as a stand-in. LED order and servo left/right are assumptions to confirm on the robot.' }),
    ),
  );

  const showTarget = (pose: Pose): void => {
    for (const axis of axes) {
      const s = sliders.get(axis.key);
      if (!s) continue;
      target[axis.key] = pose[axis.key];
      s.input.value = String(pose[axis.key]);
      s.target.textContent = `${fmt(pose[axis.key])}${axis.unit}`;
    }
  };

  let lastNotes = '';
  const update = (output: GovernorOutput, playing: string | null): void => {
    status.className = `status ${output.status}`;
    status.textContent = output.status === 'ok' ? 'SAFE' : output.status === 'limited' ? 'LIMITED' : 'BLOCKED';
    for (const axis of axes) {
      const s = sliders.get(axis.key);
      if (s) s.actual.textContent = `${fmt(output.pose[axis.key])}${axis.unit}`;
    }
    for (const row of servoRows) {
      const horn = output.hornDeg[row.servo as 0 | 1 | 2];
      row.horn.textContent = `${fmt(horn)}°`;
      row.pulse.textContent = `${Math.round(hornDegToPulseUs(horn))} µs`;
      const fraction = (horn - limits.hornMinDeg) / (limits.hornMaxDeg - limits.hornMinDeg);
      row.fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      row.fill.classList.toggle('near', fraction < 0.05 || fraction > 0.95);
    }
    const text = output.notes.join('\n');
    if (text !== lastNotes) {
      notes.replaceChildren(...output.notes.map((n) => el('li', { text: n })));
      lastNotes = text;
    }
    for (const b of animationButtons.querySelectorAll('button')) b.classList.toggle('active', b.dataset.name === playing);
    plot.draw(output);
  };

  return { update, showTarget };
}
