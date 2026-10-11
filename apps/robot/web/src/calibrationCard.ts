import { api, el } from './dom.ts';

export interface CalibrationView {
  step: 'off' | 'identify' | 'arms' | 'range' | 'level' | 'check' | 'done';
  channel: number;
  channelServo: (0 | 1 | 2 | null)[];
  servo: 0 | 1 | 2;
  armPhase: 'direction' | 'level';
  directions: (1 | -1 | null)[];
  rangePhase: 'lowest' | 'highest';
  sweepDeg: number;
  heightMm: number | null;
  lowestDeg: number | null;
  highestDeg: number | null;
  rangeUs: ([number, number] | null)[];
  levelUs: (number | null)[];
  pulsesUs: number[];
  usPerDeg: number;
  checked: boolean;
  message: string | null;
}

const ARMS = ['the front arm (under the face)', 'the arm on Peeqo’s left', 'the arm on Peeqo’s right'];
const ARM_BUTTONS = ['Front', 'Peeqo’s left', 'Peeqo’s right'];

/** A top view of the three arms, so "Peeqo's left" is not confused with yours. */
function armsDiagram(highlight: number | null): HTMLElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '-50 -56 100 100');
  svg.setAttribute('width', '130');
  const add = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text) node.textContent = text;
    svg.append(node);
  };
  add('circle', { cx: 0, cy: 0, r: 40, fill: '#f4f5f7', stroke: '#c8cdd5' });
  add('text', { x: 0, y: -46, 'text-anchor': 'middle', 'font-size': 9, fill: '#667085' }, 'face (front)');
  // Seen from above with the face at the top: servo 0 at the front, 1 at Peeqo's left (the page's lower left: its
  // left is your right when you face it), 2 at its right.
  [-90, 150, 30].forEach((deg, servo) => {
    const x = Math.cos((deg * Math.PI) / 180) * 28;
    const y = Math.sin((deg * Math.PI) / 180) * 28;
    add('circle', { cx: x, cy: y, r: 9, fill: highlight === servo ? '#2563eb' : '#fff', stroke: '#2563eb' });
    add('text', { x, y: y + 3, 'text-anchor': 'middle', 'font-size': 8, fill: highlight === servo ? '#fff' : '#2563eb' }, String(servo + 1));
  });
  return el(
    'div',
    { style: 'display: grid; justify-items: center; gap: 2px; max-width: 170px' },
    svg as unknown as Node,
    el('span', { class: 'muted small', style: 'text-align: center; font-size: 11px', text: 'From above, face at the top. 2 is Peeqo’s left, 3 its right (as you face it: your right, your left).' }),
  );
}

/**
 * The calibration wizard on the panel: one step at a time, following the service's CalibrationSession. Returns a
 * function that updates the card with the latest view (it is only rebuilt when the view changes).
 */
export function calibrationCard(card: HTMLElement): (view: CalibrationView, calibrated: boolean) => void {
  let last = '';
  const send = (action: string, extra: Record<string, unknown> = {}) => void api('/api/calibration', { action, ...extra });
  const button = (text: string, action: string, extra: Record<string, unknown> = {}, cls = '') => {
    const b = el('button', { text, class: cls });
    b.addEventListener('click', () => send(action, extra));
    return b;
  };
  return (view, calibrated) => {
    const key = JSON.stringify([view, calibrated]);
    if (key === last) return;
    last = key;
    const parts: (Node | null)[] = [el('h2', { text: 'Calibration' })];
    const message = view.message ? el('p', { class: 'message', text: view.message }) : null;
    switch (view.step) {
      case 'off':
        parts.push(
          el('p', { text: calibrated ? 'Peeqo is calibrated. Do it again if its head does not sit level, or after taking the neck apart.' : 'Peeqo’s servos stay still until it is calibrated. It takes about 10 minutes, once.' }),
          el('p', { class: 'muted small', text: 'Take off the cloth cover so you can see the three servo arms at the base, and keep fingers clear: Peeqo makes small, slow moves. You will move the whole head down and up and mark how low and how high it can safely go; Peeqo never goes outside those marks.' }),
          button(calibrated ? 'Calibrate again' : 'Start calibration', 'start', {}, 'primary'),
        );
        break;
      case 'identify': {
        const taken = new Set(view.channelServo.filter((s) => s !== null));
        parts.push(
          el('p', { text: `Channel ${view.channel + 1} of 3: press Wiggle, watch the arms, then tell Peeqo which one moved.` }),
          el('div', { class: 'row' }, button('Wiggle', 'wiggle', {}, 'primary'), armsDiagram(null)),
          el('div', { class: 'row' }, ...ARM_BUTTONS.map((label, servo) => Object.assign(button(label, 'identified', { servo }), { disabled: taken.has(servo as 0 | 1 | 2) }))),
        );
        break;
      }
      case 'arms': {
        parts.push(el('div', { class: 'row' }, armsDiagram(view.servo), el('p', { class: 'grow', text: `Now ${ARMS[view.servo]}.` })));
        if (view.armPhase === 'direction') {
          parts.push(el('p', { text: 'Press “+ once” and watch that arm.' }), el('div', { class: 'row' }, button('+ once', 'probe', {}, 'primary'), el('span', { class: 'muted', text: 'Did it go…' }), button('Up', 'plusMoved', { up: true }), button('Down', 'plusMoved', { up: false })));
        } else {
          parts.push(
            el('p', { text: 'Move it until it points straight out, level. Stop before it touches anything.' }),
            el('p', { class: 'muted small', text: 'It only moves a little on its own: the arms are linked, so one arm alone tilts the head.' }),
            el('div', { class: 'row' }, button('▲ up', 'nudge', { steps: 1 }), button('▲▲', 'nudge', { steps: 5 }), button('▼ down', 'nudge', { steps: -1 }), button('▼▼', 'nudge', { steps: -5 }), button('It’s level', 'armLevel', {}, 'primary')),
          );
        }
        break;
      }
      case 'range': {
        const lowest = view.rangePhase === 'lowest';
        parts.push(
          el('p', {
            text: lowest
              ? 'Now the whole head moves, staying level. Lower it until something is just about to touch (watch all three arms and the head), then mark it.'
              : 'Now raise it until it is as high as it should go: stop just before anything binds or a leg is fully straight, then mark it.',
          }),
          el('p', { class: 'muted small', text: `Arms at ${view.sweepDeg.toFixed(1)}°${view.heightMm !== null ? ` (head ${view.heightMm.toFixed(1)} mm up)` : ''}${view.lowestDeg !== null ? ` · lowest mark ${view.lowestDeg.toFixed(1)}°` : ''}. Each ▲/▼ moves the arms 0.5°; ▲▲/▼▼ move them 2.5°. Use single steps near the ends.` }),
          el('div', { class: 'row' }, button('▲ up', 'raise', { steps: 1 }), button('▲▲', 'raise', { steps: 5 }), button('▼ down', 'raise', { steps: -1 }), button('▼▼', 'raise', { steps: -5 })),
          el(
            'div',
            { class: 'row', style: 'margin-top: 8px' },
            lowest ? button('Mark lowest', 'markLowest', {}, 'primary') : button('Mark highest', 'markHighest', {}, 'primary'),
            lowest ? null : button('Mark the lowest again', 'remark'),
          ),
        );
        break;
      }
      case 'level':
      case 'done':
        parts.push(
          el('p', { text: view.step === 'done' ? 'Calibrated. Fine-tune if you like, then save.' : 'Peeqo is at its normal height. Put the cloth back if you like, then put your phone flat on top of its head with a level app open (iPhone: Measure → Level).' }),
          el('p', { class: 'muted small', text: 'Tap until the level reads 0° both ways (each tap is a quarter of a degree).' }),
          el(
            'div',
            { class: 'row' },
            button('Tilt back', 'trim', { pitchDeg: 0.25 }),
            button('Tilt forward', 'trim', { pitchDeg: -0.25 }),
            button('Tilt to its left', 'trim', { rollDeg: -0.25 }),
            button('Tilt to its right', 'trim', { rollDeg: 0.25 }),
          ),
          el('div', { class: 'row', style: 'margin-top: 10px' }, view.step === 'level' ? button('Next: check the tilt', 'tilt', {}, 'primary') : null, button('Save', 'save', {}, view.step === 'done' ? 'primary' : '')),
        );
        break;
      case 'check': {
        const reading = el('input', { type: 'number', step: '0.1', placeholder: 'e.g. 3.1', style: 'width: 110px' });
        const submit = el('button', { class: 'primary', text: 'Use reading' });
        submit.addEventListener('click', () => send('reading', { deg: Number(reading.value) }));
        parts.push(el('p', { text: 'Peeqo tilted back 3°. What does the level read now (how far from the 0° it showed before)?' }), el('div', { class: 'row' }, reading, el('span', { text: '°' }), submit));
        break;
      }
    }
    if (view.step !== 'off') parts.push(el('div', { class: 'row', style: 'margin-top: 12px' }, button('Cancel', 'cancel', {}, 'danger'), el('span', { class: 'muted small', text: `pulses ${view.pulsesUs.map((us) => Math.round(us)).join(' / ')} µs` })));
    card.replaceChildren(...parts.filter((p): p is Node => p !== null), ...(message ? [message] : []));
  };
}
