import {
  CLASSIC_LED_ANIMATIONS,
  CLASSIC_LED_COLORS,
  SERVO_TO_CHANNEL,
  hornDegToPulseUs,
  isClassicLedColor,
  type ClassicLedAnimation,
  type ClassicLedColor,
  type ClearanceReading,
  type GovernorOutput,
  type PlatformGeometry,
  type Pose,
  type SafetyLimits,
} from '@peeqo/core';
import { VIEWS, type ViewName } from '../scene/stage.ts';
import { el, section } from './dom.ts';
import { EnvelopePlot } from './envelopePlot.ts';

export interface PanelCallbacks {
  onTarget(pose: Pose): void;
  /** Back to the neutral pose, idling (or still, with idle off). */
  onNeutral(): void;
  onHeadAnimation(name: string): void;
  onIdle(on: boolean): void;
  onEnergy(energy: number): void;
  onAnimation(name: string): void;
  onReaction(name: string): void;
  onLeds(animation: ClassicLedAnimation, color: ClassicLedColor): void;
  onLedPattern(name: string, color: string | undefined): void;
  onExpression(name: string): void;
  onState(state: string): void;
  onMute(muted: boolean): void;
  onLife(on: boolean): void;
  onGlasses(name: string | null): void;
  onBlink(): void;
  onFaceStyle(style: 'expressive' | 'classic'): void;
  onEmotion(name: string): void;
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
  /** The governor's neutral pose: where "Neutral" goes and the sliders start. */
  readonly neutral: Pose;
  readonly headAnimations: readonly { readonly name: string; readonly description: string }[];
  /** Whether the idle layer starts on. */
  readonly idle: boolean;
  readonly emotions: readonly string[];
  readonly faceStyle: 'expressive' | 'classic';
  readonly ledPatterns: readonly { readonly name: string; readonly description: string }[];
  readonly ledColors: readonly string[];
  readonly expressions: readonly { readonly name: string; readonly description: string }[];
  readonly states: readonly string[];
  /** Whether Peeqo starts living on its own (little moves, sleeping when left alone). */
  readonly life: boolean;
}

export interface Panel {
  /** Refreshes readouts; call once per frame. */
  update(output: GovernorOutput, playing: string | null, clearance: ClearanceReading | null, gesture: string | null, expression: string | null, state: string): void;
  /** Moves the sliders to show a target (without triggering onTarget). */
  showTarget(pose: Pose): void;
}

const fmt = (value: number, digits = 1) => (Object.is(Math.round(value * 10 ** digits), -0) ? 0 : value).toFixed(digits);

export function createPanel(host: HTMLElement, options: PanelOptions, callbacks: PanelCallbacks): Panel {
  const { limits } = options;
  host.replaceChildren();

  // ---- header with the safety status ----
  const status = el('span', { class: 'status ok', text: 'SAFE' });
  host.append(el('header', {}, el('h1', { text: 'Peeqo sim' }), status));

  // ---- character: expressions over a state ----
  const expressionButtons = el(
    'div',
    { class: 'buttons' },
    ...options.expressions.map(({ name, description }) => {
      const b = el('button', { type: 'button', text: name, title: description, 'data-name': name });
      b.addEventListener('click', () => callbacks.onExpression(name));
      return b;
    }),
  );
  const stateButtons = el(
    'div',
    { class: 'buttons states' },
    ...options.states.map((name) => {
      const b = el('button', { type: 'button', text: name, 'data-name': name });
      b.addEventListener('click', () => callbacks.onState(name));
      return b;
    }),
  );
  const mute = el('input', { type: 'checkbox' });
  mute.addEventListener('change', () => callbacks.onMute(mute.checked));
  const lifeToggle = el('input', { type: 'checkbox', checked: options.life });
  lifeToggle.addEventListener('change', () => callbacks.onLife(lifeToggle.checked));
  host.append(
    section(
      'Expressions',
      expressionButtons,
      el('p', { class: 'muted small state-label', text: 'State:' }),
      stateButtons,
      el('label', { class: 'check mute' }, lifeToggle, ' Lives on its own (little moves; sleeps when left alone)'),
      el('label', { class: 'check' }, mute, ' Mute sounds'),
    ),
  );

  // ---- head pose ----
  const axes = [
    { key: 'pitchDeg', label: 'Pitch (look up +)', unit: '°', min: -limits.maxAbsPitchDeg, max: limits.maxAbsPitchDeg },
    { key: 'rollDeg', label: 'Roll (tilt to its right +)', unit: '°', min: -limits.maxAbsRollDeg, max: limits.maxAbsRollDeg },
    { key: 'heaveMm', label: 'Height', unit: ' mm', min: limits.minHeaveMm, max: limits.maxHeaveMm },
  ] as const;
  const sliders = new Map<keyof Pose, { input: HTMLInputElement; target: HTMLElement; actual: HTMLElement }>();
  const target: { -readonly [K in keyof Pose]: number } = { ...options.neutral };
  const rows = axes.map((axis) => {
    const start = options.neutral[axis.key];
    const input = el('input', { type: 'range', min: axis.min, max: axis.max, step: 0.1, value: start, 'aria-label': axis.label });
    const targetText = el('span', { class: 'mono', text: `${fmt(start)}${axis.unit}` });
    const actualText = el('span', { class: 'mono muted', text: `${fmt(start)}${axis.unit}` });
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
  const home = el('button', { type: 'button', text: 'Neutral' });
  home.addEventListener('click', () => callbacks.onNeutral());
  host.append(section('Head pose (target → actual)', ...rows, el('div', { class: 'row' }, home)));

  // ---- head motion: gestures over the idle layer ----
  const gestureButtons = el(
    'div',
    { class: 'buttons' },
    ...options.headAnimations.map(({ name, description }) => {
      const b = el('button', { type: 'button', text: name, title: description, 'data-name': name });
      b.addEventListener('click', () => callbacks.onHeadAnimation(name));
      return b;
    }),
  );
  const idleToggle = el('input', { type: 'checkbox', checked: options.idle });
  idleToggle.addEventListener('change', () => callbacks.onIdle(idleToggle.checked));
  const energy = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Energy' });
  energy.addEventListener('input', () => callbacks.onEnergy(Number(energy.value)));
  host.append(
    section(
      'Head motion',
      gestureButtons,
      el(
        'div',
        { class: 'row idle-row' },
        el('label', { class: 'check' }, idleToggle, ' Alive (breathing, glances)'),
        el('label', { class: 'check' }, 'Energy ', energy),
      ),
    ),
  );

  // ---- safe range ----
  const plotCanvas = el('canvas', { class: 'envelope', width: 480, height: 480 });
  const plot = new EnvelopePlot(plotCanvas, options.geometry, limits);
  const notes = el('ul', { class: 'notes' });
  const clearanceText = el('p', { class: 'clearance mono' });
  const ghostToggle = el('input', { type: 'checkbox', checked: true });
  ghostToggle.addEventListener('change', () => callbacks.onShowRequested(ghostToggle.checked));
  host.append(
    section(
      'Safe range at this height',
      plotCanvas,
      el('p', { class: 'legend' }, el('span', { class: 'swatch safe' }), ' safe  ○ requested  ◆ goal  ● now'),
      el('label', { class: 'check' }, ghostToggle, ' Show requested pose in red when it is unsafe'),
      clearanceText,
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
        el('thead', {}, el('tr', {}, el('th', { text: 'Ch' }), el('th', { text: '' }), el('th', { text: 'Horn' }), el('th', { text: 'Pulse (2019 map)', title: 'The 2019 pulse mapping; the dev kit servos still need calibrating' }), el('th', { text: `${limits.hornMinDeg}° … ${limits.hornMaxDeg}°` }))),
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
  const patternColor = el('select', { 'aria-label': 'Pattern colour' }, el('option', { value: '', text: 'its own colour' }), ...options.ledColors.map((c) => el('option', { value: c, text: c })));
  const patternButtons = el(
    'div',
    { class: 'buttons' },
    ...options.ledPatterns.map(({ name, description }) => {
      const b = el('button', { type: 'button', text: name, title: description, 'data-name': name });
      b.addEventListener('click', () => callbacks.onLedPattern(name, patternColor.value || undefined));
      return b;
    }),
  );
  host.append(
    section(
      'LED ring',
      patternButtons,
      el('div', { class: 'row led-row' }, patternColor),
      el('p', { class: 'muted small', text: '2019 animations:' }),
      el('div', { class: 'row' }, ledAnim, ledColor, ledPlay),
    ),
  );

  // ---- face ----
  const glasses = el('select', { 'aria-label': 'Glasses' }, el('option', { value: '', text: 'no glasses' }), ...options.glasses.map((g) => el('option', { value: g, text: g })));
  glasses.value = options.initialGlasses ?? '';
  glasses.addEventListener('change', () => callbacks.onGlasses(glasses.value || null));
  const blink = el('button', { type: 'button', text: 'Blink' });
  blink.addEventListener('click', () => callbacks.onBlink());
  const style = el('select', { 'aria-label': 'Face style' }, el('option', { value: 'expressive', text: 'expressive eyes' }), el('option', { value: 'classic', text: '2019 eyes' }));
  style.value = options.faceStyle;
  const emotionButtons = el(
    'div',
    { class: 'buttons' },
    ...options.emotions.map((name) => {
      const b = el('button', { type: 'button', text: name, 'data-name': name });
      b.addEventListener('click', () => {
        for (const other of emotionButtons.querySelectorAll('button')) other.classList.toggle('active', other === b);
        callbacks.onEmotion(name);
      });
      return b;
    }),
  );
  emotionButtons.querySelector('button[data-name="neutral"]')?.classList.add('active');
  const syncStyle = () => emotionButtons.classList.toggle('disabled', style.value !== 'expressive');
  style.addEventListener('change', () => {
    callbacks.onFaceStyle(style.value === 'classic' ? 'classic' : 'expressive');
    syncStyle();
  });
  syncStyle();
  host.append(section('Face', el('div', { class: 'row' }, style, glasses, blink), el('div', { class: 'face-emotions' }, emotionButtons)));

  // ---- view ----
  host.append(section('View', buttonRow(Object.keys(VIEWS), (name) => callbacks.onView(name as ViewName))));

  host.append(
    el(
      'footer',
      {},
      el('p', { text: 'Model, neck geometry and collision checks: the dev kit Fusion 360 assembly (every pose keeps all parts at least 0.5 mm apart). To confirm on the robot: servo calibration (pulse to angle), which PCA9685 channel drives which rear servo, and where LED 0 sits.' }),
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
  const update = (output: GovernorOutput, playing: string | null, clearance: ClearanceReading | null, gesture: string | null, expression: string | null, state: string): void => {
    for (const b of expressionButtons.querySelectorAll('button')) b.classList.toggle('active', b.dataset.name === expression);
    for (const b of stateButtons.querySelectorAll('button')) b.classList.toggle('active', b.dataset.name === state);
    clearanceText.textContent = clearance
      ? `Closest parts: ${Number.isFinite(clearance.minMm) ? clearance.minMm.toFixed(2) : '—'} mm (${clearance.between})`
      : 'Collision check: off';
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
    for (const b of gestureButtons.querySelectorAll('button')) b.classList.toggle('active', b.dataset.name === gesture);
    plot.draw(output);
  };

  return { update, showTarget };
}
