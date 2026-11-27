type Attributes = Readonly<Record<string, string | boolean | undefined>>;

/** Creates an element with attributes and children. Text is always inserted as text. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: (Node | string | undefined)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) {
      continue;
    }
    element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child !== undefined) {
      element.append(child);
    }
  }
  return element;
}

export function icon(name: string): HTMLElement {
  return h('i', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
}

export function iconButton(id: string, iconName: string, title: string): HTMLButtonElement {
  return h(
    'button',
    { id, class: 'icon-button', type: 'button', title, 'aria-label': title },
    icon(iconName),
  );
}

/** Renders highlighted segments into a container, using <mark> for matches. */
export function renderSegments(
  container: HTMLElement,
  segments: readonly { readonly text: string; readonly match: boolean }[],
): void {
  container.replaceChildren(
    ...segments.map((segment) =>
      segment.match ? h('mark', {}, segment.text) : document.createTextNode(segment.text),
    ),
  );
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
    }, delay);
  };
}
