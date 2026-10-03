/** Tiny DOM helpers for the panels. */

export type Attrs = Record<string, string | number | boolean>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
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

export function section(title: string, ...children: (Node | string)[]): HTMLElement {
  return el('section', {}, el('h2', { text: title }), ...children);
}
