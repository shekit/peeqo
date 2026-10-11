import { api, el } from './dom.ts';

interface Playable {
  name: string;
  description: string;
}
interface Repertoire {
  expressions: Playable[];
  moves: Playable[];
  lights: Playable[];
}
type Kind = 'expression' | 'move' | 'lights';
export type Playing = Record<Kind, string | null>;

const GROUPS: readonly [Kind, keyof Repertoire, string][] = [
  ['expression', 'expressions', 'Expressions: face, head, lights and sound together'],
  ['move', 'moves', 'Head moves'],
  ['lights', 'lights', 'Lights'],
];

/**
 * The Expressions card: everything Peeqo can play, to try on the robot. The head moves through the motion governor,
 * inside the calibrated ranges, like every move. Returns a function that marks what is playing now.
 */
export function expressionsCard(card: HTMLElement): (playing: Playing) => void {
  const buttons: { kind: Kind; name: string; button: HTMLButtonElement }[] = [];
  const title = el('h2', { text: 'Expressions' });
  card.replaceChildren(title, el('p', { class: 'muted small', text: 'Loading…' }));
  void api<Repertoire>('/api/expressions').then(({ ok, data }) => {
    if (!ok) {
      card.replaceChildren(title, el('p', { class: 'muted small', text: 'Could not load them. Reload the page to try again.' }));
      return;
    }
    card.replaceChildren(
      title,
      el('p', { class: 'muted small', text: 'Click one to play it on Peeqo. The head stays inside the ranges you marked.' }),
      ...GROUPS.flatMap(([kind, key, heading]) => [
        el('h3', { text: heading }),
        el(
          'div',
          { class: 'buttons' },
          ...data[key].map(({ name, description }) => {
            const button = el('button', { text: name, title: description });
            button.addEventListener('click', () => void api('/api/play', { kind, name }));
            buttons.push({ kind, name, button });
            return button;
          }),
        ),
      ]),
    );
  });
  return (playing) => {
    for (const { kind, name, button } of buttons) button.classList.toggle('active', playing[kind] === name);
  };
}
