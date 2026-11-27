import { findMatches } from '../../core/search/snippet';
import type {
  Appearance,
  Breadcrumb,
  DocViewFromWebview,
  DocViewState,
  DocViewToWebview,
  HighlightTerm,
  NavigationState,
} from '../../shared/protocol';
import { debounce, h, icon, iconButton } from '../shared/dom';
import baseCss from './page-base.css?inline';
import themedCss from './page-themed.css?inline';

const vscode = acquireVsCodeApi<DocViewState>();
const post = (message: DocViewFromWebview): void => {
  vscode.postMessage(message);
};

const MAX_HIGHLIGHTS = 5000;
const supportsHighlights = typeof Highlight !== 'undefined' && 'highlights' in CSS;

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

const backButton = iconButton('back', 'arrow-left', 'Back (Alt+Left)');
const forwardButton = iconButton('forward', 'arrow-right', 'Forward (Alt+Right)');
const homeButton = iconButton('home', 'home', 'Start page of this document');
const breadcrumbs = h('nav', { class: 'breadcrumbs', 'aria-label': 'Location' });
const highlightChip = h('button', {
  class: 'chip',
  type: 'button',
  hidden: true,
  title: 'Clear search highlights',
});
const findButton = iconButton('find', 'search', 'Find in page (Ctrl+F)');
const syncButton = iconButton('sync', 'list-tree', 'Reveal in Contents');
const appearanceButton = iconButton(
  'appearance',
  'symbol-color',
  'Toggle themed / original page style',
);
const zoomOutButton = iconButton('zoomOut', 'zoom-out', 'Zoom out (Ctrl+-)');
const zoomLabel = h(
  'button',
  { class: 'zoom-label', type: 'button', title: 'Reset zoom (Ctrl+0)' },
  '100%',
);
const zoomInButton = iconButton('zoomIn', 'zoom-in', 'Zoom in (Ctrl+=)');
const copyButton = iconButton('copy', 'link', 'Copy link to this page');

const toolbar = h(
  'header',
  { class: 'toolbar', role: 'toolbar', 'aria-label': 'Documentation navigation' },
  backButton,
  forwardButton,
  homeButton,
  h('span', { class: 'separator' }),
  breadcrumbs,
  highlightChip,
  findButton,
  syncButton,
  appearanceButton,
  h('span', { class: 'separator' }),
  zoomOutButton,
  zoomLabel,
  zoomInButton,
  h('span', { class: 'separator' }),
  copyButton,
);
const progress = h('div', {
  class: 'progress',
  hidden: true,
  role: 'progressbar',
  'aria-label': 'Loading',
});

const findInput = h('input', {
  type: 'text',
  class: 'find-input',
  placeholder: 'Find',
  'aria-label': 'Find in page',
  spellcheck: 'false',
});
const findCount = h('span', { class: 'find-count', 'aria-live': 'polite' });
const findCase = iconButton('findCase', 'case-sensitive', 'Match case');
const findWord = iconButton('findWord', 'whole-word', 'Match whole word');
const findPrevious = iconButton('findPrevious', 'arrow-up', 'Previous match (Shift+Enter)');
const findNext = iconButton('findNext', 'arrow-down', 'Next match (Enter)');
const findClose = iconButton('findClose', 'close', 'Close (Escape)');
findCase.setAttribute('aria-pressed', 'false');
findWord.setAttribute('aria-pressed', 'false');
const findBar = h(
  'div',
  { class: 'findbar', hidden: true, role: 'search' },
  findInput,
  findCase,
  findWord,
  findCount,
  findPrevious,
  findNext,
  findClose,
);

const host = h('main', { id: 'page', tabindex: '-1' });
const shadow = host.attachShadow({ mode: 'open' });
const linkPreview = h('div', { class: 'link-preview', 'aria-hidden': 'true' });
const selectionButton = h(
  'button',
  { class: 'selection-search', type: 'button', hidden: true },
  icon('search'),
  ' Search docs',
);

document.body.append(toolbar, progress, findBar, host, linkPreview, selectionButton);

const baseSheet = new CSSStyleSheet();
baseSheet.replaceSync(baseCss);
const themedSheet = new CSSStyleSheet();
themedSheet.replaceSync(themedCss);

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

let currentUrl = vscode.getState()?.url ?? '';
let highlights: readonly HighlightTerm[] = [];
let zoom = 1;
let appearance: Appearance = 'themed';
let userScrolled = false;

interface TextIndex {
  readonly text: string;
  readonly nodes: readonly Text[];
  readonly starts: readonly number[];
}
let textIndex: TextIndex | undefined;

function pageBase(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function saveState(scrollY = window.scrollY): void {
  vscode.setState({ url: currentUrl, scrollY });
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function applySettings(): void {
  shadow.adoptedStyleSheets = appearance === 'themed' ? [themedSheet, baseSheet] : [baseSheet];
  host.classList.toggle('original', appearance === 'original');
  appearanceButton.setAttribute('aria-pressed', String(appearance === 'original'));
  host.style.setProperty('zoom', String(zoom));
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function updateNavigation(navigation: NavigationState): void {
  backButton.disabled = !navigation.canGoBack;
  forwardButton.disabled = !navigation.canGoForward;
}

function renderBreadcrumbs(trail: readonly Breadcrumb[], title: string): void {
  const items: Node[] = [];
  for (const crumb of trail) {
    const link = h('a', { href: crumb.url, title: crumb.title }, crumb.title);
    link.addEventListener('click', (event) => {
      event.preventDefault();
      post({
        type: 'navigate',
        href: crumb.url,
        newTab: event.ctrlKey || event.metaKey,
        side: event.altKey,
      });
    });
    items.push(link, icon('chevron-right'));
  }
  items.push(h('span', { class: 'current', title }, title));
  breadcrumbs.replaceChildren(...items);
}

function afterLayout(callback: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
}

function findAnchorTarget(fragment: string): Element | null {
  if (!fragment) {
    return null;
  }
  return (
    shadow.getElementById(fragment) ?? shadow.querySelector(`[name="${CSS.escape(fragment)}"]`)
  );
}

function scrollToFragment(fragment: string, smooth = false): boolean {
  const target = findAnchorTarget(fragment);
  if (!target) {
    return false;
  }
  target.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'instant' });
  const flash = target.closest('h1, h2, h3, h4, h5, h6, dt, tr, p, div') ?? target;
  flash.classList.remove('qch-target-flash');
  flash.getBoundingClientRect(); // Restart the animation.
  flash.classList.add('qch-target-flash');
  return true;
}

function restoreScroll(fragment: string, scrollY: number | undefined): void {
  userScrolled = false;
  const apply = (): void => {
    if (userScrolled) {
      return;
    }
    if (scrollY !== undefined) {
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    } else if (fragment && scrollToFragment(fragment)) {
      // Done.
    } else if (!scrollToFirstHighlight()) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    userScrolled = false;
  };
  apply();
  afterLayout(apply);
  // Images decode asynchronously and may shift the layout: re-apply once they are ready.
  const images = [...shadow.querySelectorAll('img')].filter((image) => !image.complete);
  if (images.length > 0) {
    void Promise.race([
      Promise.allSettled(images.map(async (image) => image.decode())),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).then(() => {
      afterLayout(apply);
    });
  }
}

function showPage(message: Extract<DocViewToWebview, { type: 'page' }>): void {
  progress.hidden = true;
  currentUrl = message.url;
  appearance = message.appearance;
  applySettings();
  shadow.innerHTML = message.html;
  textIndex = undefined;
  document.title = message.title;
  updateNavigation(message.navigation);
  renderBreadcrumbs(message.breadcrumbs, message.title);
  syncButton.disabled = !message.url.startsWith('qthelp:');
  homeButton.disabled = false;
  highlights = message.highlights;
  applySearchHighlights();
  if (!findBar.hidden) {
    runFind(false);
  }
  restoreScroll(message.fragment, message.scrollY);
  saveState(message.scrollY ?? 0);
}

function showNotFound(message: Extract<DocViewToWebview, { type: 'notFound' }>): void {
  progress.hidden = true;
  currentUrl = message.url;
  textIndex = undefined;
  applySettings();
  const back = h(
    'button',
    { class: 'button', type: 'button', disabled: !message.navigation.canGoBack },
    'Go Back',
  );
  back.addEventListener('click', () => {
    post({ type: 'back' });
  });
  const container = h(
    'div',
    { class: 'qch-html' },
    h(
      'div',
      { class: 'qch-body qch-notfound' },
      h('div', { class: 'qch-notfound-icon' }, icon('book')),
      h('h1', {}, 'Page not found'),
      h('p', {}, message.message),
      h('p', {}, h('code', {}, message.url)),
      back,
    ),
  );
  shadow.replaceChildren(container);
  document.title = 'Page not found';
  updateNavigation(message.navigation);
  renderBreadcrumbs([], 'Page not found');
  syncButton.disabled = true;
  homeButton.disabled = false;
  window.scrollTo({ top: 0, behavior: 'instant' });
  saveState(0);
}

// ---------------------------------------------------------------------------------------------
// Text ranges, search highlights and find-in-page
// ---------------------------------------------------------------------------------------------

function getTextIndex(): TextIndex {
  if (textIndex) {
    return textIndex;
  }
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = document.createTreeWalker(shadow, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('style, script')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = (node as Text).data;
    if (value === '') {
      continue;
    }
    nodes.push(node as Text);
    starts.push(text.length);
    text += value;
  }
  textIndex = { text, nodes, starts };
  return textIndex;
}

function locate(
  index: TextIndex,
  offset: number,
  isEnd: boolean,
): { node: Text; offset: number } | undefined {
  let lo = 0;
  let hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const start = index.starts[mid] ?? 0;
    if (start < offset || (!isEnd && start === offset)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const node = index.nodes[lo];
  const start = index.starts[lo];
  return node && start !== undefined
    ? { node, offset: Math.min(offset - start, node.length) }
    : undefined;
}

function makeRange(index: TextIndex, start: number, end: number): Range | undefined {
  const from = locate(index, start, false);
  const to = locate(index, end, true);
  if (!from || !to) {
    return undefined;
  }
  const range = new Range();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

let searchRanges: Range[] = [];

function applySearchHighlights(): void {
  searchRanges = [];
  if (supportsHighlights) {
    CSS.highlights.delete('qch-search');
  }
  if (highlights.length === 0) {
    highlightChip.hidden = true;
    return;
  }
  const index = getTextIndex();
  for (const match of findMatches(index.text, highlights).slice(0, MAX_HIGHLIGHTS)) {
    const range = makeRange(index, match.start, match.end);
    if (range) {
      searchRanges.push(range);
    }
  }
  if (supportsHighlights && searchRanges.length > 0) {
    CSS.highlights.set('qch-search', new Highlight(...searchRanges));
  }
  highlightChip.replaceChildren(
    icon('filter'),
    ` ${searchRanges.length} match${searchRanges.length === 1 ? '' : 'es'} `,
    icon('close'),
  );
  highlightChip.title = `Highlighting: ${highlights.map((h) => h.term + (h.prefix ? '*' : '')).join(' ')} — click to clear`;
  highlightChip.hidden = false;
}

function clearSearchHighlights(): void {
  highlights = [];
  applySearchHighlights();
}

function scrollRangeIntoView(range: Range): void {
  const rect = range.getBoundingClientRect();
  const top = toolbar.offsetHeight + (findBar.hidden ? 0 : findBar.offsetHeight) + 16;
  if (rect.top < top || rect.bottom > window.innerHeight - 16) {
    window.scrollBy({ top: rect.top - window.innerHeight / 3, behavior: 'instant' });
  }
}

function scrollToFirstHighlight(): boolean {
  const [first] = searchRanges;
  if (!first) {
    return false;
  }
  scrollRangeIntoView(first);
  return true;
}

let findRanges: Range[] = [];
let findIndex = -1;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runFind(reveal: boolean): void {
  const query = findInput.value;
  findRanges = [];
  findIndex = -1;
  if (supportsHighlights) {
    CSS.highlights.delete('qch-find');
    CSS.highlights.delete('qch-find-current');
  }
  if (query === '') {
    findCount.textContent = '';
    findBar.classList.remove('no-results');
    return;
  }
  const wholeWord = findWord.getAttribute('aria-pressed') === 'true';
  const matchCase = findCase.getAttribute('aria-pressed') === 'true';
  const body = escapeRegExp(query);
  const pattern = new RegExp(
    wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body,
    `gu${matchCase ? '' : 'i'}`,
  );
  const index = getTextIndex();
  for (const match of index.text.matchAll(pattern)) {
    if (findRanges.length >= MAX_HIGHLIGHTS || match[0].length === 0) {
      break;
    }
    const range = makeRange(index, match.index, match.index + match[0].length);
    if (range) {
      findRanges.push(range);
    }
  }
  findBar.classList.toggle('no-results', findRanges.length === 0);
  if (findRanges.length === 0) {
    findCount.textContent = 'No results';
    return;
  }
  if (supportsHighlights) {
    CSS.highlights.set('qch-find', new Highlight(...findRanges));
  }
  // Start at the first match below the top of the viewport.
  const top = toolbar.offsetHeight;
  const firstVisible = findRanges.findIndex((range) => range.getBoundingClientRect().top >= top);
  gotoFind(firstVisible < 0 ? 0 : firstVisible, reveal);
}

function gotoFind(index: number, reveal = true): void {
  if (findRanges.length === 0) {
    return;
  }
  findIndex = (index + findRanges.length) % findRanges.length;
  const range = findRanges[findIndex];
  if (!range) {
    return;
  }
  if (supportsHighlights) {
    CSS.highlights.set('qch-find-current', new Highlight(range));
  }
  findCount.textContent = `${findIndex + 1} of ${findRanges.length}${findRanges.length >= MAX_HIGHLIGHTS ? '+' : ''}`;
  if (reveal) {
    scrollRangeIntoView(range);
  }
}

function openFind(): void {
  findBar.hidden = false;
  const selection = window.getSelection()?.toString().trim() ?? '';
  if (selection && selection.length < 100 && !selection.includes('\n')) {
    findInput.value = selection;
  }
  findInput.focus();
  findInput.select();
  runFind(true);
}

function closeFind(): void {
  findBar.hidden = true;
  findRanges = [];
  if (supportsHighlights) {
    CSS.highlights.delete('qch-find');
    CSS.highlights.delete('qch-find-current');
  }
  host.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

function anchorFromEvent(event: Event): HTMLAnchorElement | HTMLAreaElement | undefined {
  for (const target of event.composedPath()) {
    if (
      (target instanceof HTMLAnchorElement || target instanceof HTMLAreaElement) &&
      target.hasAttribute('href')
    ) {
      return target;
    }
  }
  return undefined;
}

function followLink(href: string, newTab: boolean, side: boolean): void {
  if (href.startsWith('#')) {
    const fragment = decodeFragment(href.slice(1));
    if (scrollToFragment(fragment, true)) {
      post({ type: 'fragment', fragment });
    }
    return;
  }
  if (/^qthelp:/i.test(href)) {
    const hash = href.indexOf('#');
    const fragment = hash < 0 ? '' : decodeFragment(href.slice(hash + 1));
    if (!newTab && !side && pageBase(href) === pageBase(currentUrl)) {
      if (
        fragment
          ? scrollToFragment(fragment, true)
          : (window.scrollTo({ top: 0, behavior: 'smooth' }), true)
      ) {
        post({ type: 'fragment', fragment });
      }
      return;
    }
    post({ type: 'navigate', href, newTab, side });
    return;
  }
  if (/^(?:https?|mailto):/i.test(href)) {
    post({ type: 'openExternal', href });
  }
}

shadow.addEventListener('click', (event) => {
  if (!(event instanceof MouseEvent)) {
    return;
  }
  const anchor = anchorFromEvent(event);
  const href = anchor?.getAttribute('href');
  if (href === null || href === undefined) {
    return;
  }
  event.preventDefault();
  followLink(href, event.ctrlKey || event.metaKey, event.altKey || event.shiftKey);
});

shadow.addEventListener('auxclick', (event) => {
  if (!(event instanceof MouseEvent) || event.button !== 1) {
    return;
  }
  const href = anchorFromEvent(event)?.getAttribute('href');
  if (href) {
    event.preventDefault();
    followLink(href, true, false);
  }
});

shadow.addEventListener('mouseover', (event) => {
  const href = anchorFromEvent(event)?.getAttribute('href');
  if (href && !href.startsWith('#')) {
    linkPreview.textContent = href.replace(/^qthelp:\/\/[^/]+\//, '');
    linkPreview.classList.add('visible');
  }
});

shadow.addEventListener('mouseout', (event) => {
  if (anchorFromEvent(event)) {
    linkPreview.classList.remove('visible');
  }
});

// ---------------------------------------------------------------------------------------------
// Selection search
// ---------------------------------------------------------------------------------------------

function selectedText(): string {
  const selection = document.getSelection();
  return selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
}

host.addEventListener('mouseup', () => {
  setTimeout(() => {
    const text = selectedText();
    const selection = document.getSelection();
    if (text.length < 2 || text.length > 120 || !selection || selection.rangeCount === 0) {
      selectionButton.hidden = true;
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    selectionButton.style.top = `${Math.max(toolbar.offsetHeight + 4, rect.top - 34)}px`;
    selectionButton.style.left = `${Math.min(window.innerWidth - 140, Math.max(4, rect.left))}px`;
    selectionButton.hidden = false;
  }, 0);
});

selectionButton.addEventListener('mousedown', (event) => {
  event.preventDefault();
});

selectionButton.addEventListener('click', () => {
  const text = selectedText();
  selectionButton.hidden = true;
  if (text) {
    post({ type: 'searchText', text });
  }
});

document.addEventListener('selectionchange', () => {
  if (selectedText() === '') {
    selectionButton.hidden = true;
  }
});

// ---------------------------------------------------------------------------------------------
// Toolbar and keyboard
// ---------------------------------------------------------------------------------------------

backButton.addEventListener('click', () => {
  post({ type: 'back' });
});
forwardButton.addEventListener('click', () => {
  post({ type: 'forward' });
});
homeButton.addEventListener('click', () => {
  post({ type: 'home' });
});
syncButton.addEventListener('click', () => {
  post({ type: 'syncContents' });
});
appearanceButton.addEventListener('click', () => {
  post({ type: 'toggleAppearance' });
});
copyButton.addEventListener('click', () => {
  post({ type: 'copyUrl', href: currentUrl || undefined });
});
zoomInButton.addEventListener('click', () => {
  post({ type: 'zoom', zoom: zoom + 0.1 });
});
zoomOutButton.addEventListener('click', () => {
  post({ type: 'zoom', zoom: zoom - 0.1 });
});
zoomLabel.addEventListener('click', () => {
  post({ type: 'zoom', zoom: 1 });
});
highlightChip.addEventListener('click', clearSearchHighlights);
findButton.addEventListener('click', () => {
  if (findBar.hidden) {
    openFind();
  } else {
    closeFind();
  }
});

const rerunFind = debounce(() => {
  runFind(true);
}, 120);
findInput.addEventListener('input', rerunFind);
for (const toggle of [findCase, findWord]) {
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'));
    runFind(true);
  });
}
findNext.addEventListener('click', () => {
  gotoFind(findIndex + 1);
});
findPrevious.addEventListener('click', () => {
  gotoFind(findIndex - 1);
});
findClose.addEventListener('click', closeFind);

findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    gotoFind(findIndex + (event.shiftKey ? -1 : 1));
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeFind();
  }
  // Keep plain typing (including Alt+arrows) inside the input instead of VS Code keybindings.
  if (!event.ctrlKey && !event.metaKey) {
    event.stopPropagation();
  }
});

window.addEventListener('keydown', (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openFind();
  } else if (event.key === 'Escape') {
    if (!findBar.hidden) {
      closeFind();
    } else if (highlights.length > 0) {
      clearSearchHighlights();
    }
  } else if (event.key === 'F3') {
    event.preventDefault();
    if (findBar.hidden) {
      openFind();
    } else {
      gotoFind(findIndex + (event.shiftKey ? -1 : 1));
    }
  }
});

window.addEventListener('mouseup', (event) => {
  if (event.button === 3) {
    event.preventDefault();
    post({ type: 'back' });
  } else if (event.button === 4) {
    event.preventDefault();
    post({ type: 'forward' });
  }
});

window.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
      post({ type: 'zoom', zoom: zoom + (event.deltaY < 0 ? 0.1 : -0.1) });
    }
  },
  { passive: false },
);

const reportScroll = debounce(() => {
  post({ type: 'scroll', scrollY: window.scrollY });
  saveState();
}, 250);
window.addEventListener('scroll', () => {
  userScrolled = true;
  selectionButton.hidden = true;
  reportScroll();
});

window.addEventListener('focus', () => {
  post({ type: 'focus', focused: true });
});
window.addEventListener('blur', () => {
  post({ type: 'focus', focused: false });
});

// ---------------------------------------------------------------------------------------------
// Messages from the extension
// ---------------------------------------------------------------------------------------------

let loadingTimer: ReturnType<typeof setTimeout> | undefined;

window.addEventListener('message', (event: MessageEvent<DocViewToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'page':
      clearTimeout(loadingTimer);
      showPage(message);
      break;
    case 'notFound':
      clearTimeout(loadingTimer);
      showNotFound(message);
      break;
    case 'loading':
      clearTimeout(loadingTimer);
      // Only show the progress bar for slow pages.
      loadingTimer = setTimeout(() => {
        progress.hidden = false;
      }, 150);
      break;
    case 'scrollTo':
      if (message.scrollY !== undefined) {
        window.scrollTo({ top: message.scrollY, behavior: 'instant' });
      } else if (!scrollToFragment(message.fragment, true)) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      break;
    case 'navigation':
      currentUrl = message.url;
      updateNavigation(message.navigation);
      saveState();
      break;
    case 'settings':
      zoom = message.zoom;
      appearance = message.appearance;
      applySettings();
      break;
    case 'find':
      openFind();
      break;
    case 'clearHighlights':
      clearSearchHighlights();
      break;
  }
});

applySettings();
backButton.disabled = true;
forwardButton.disabled = true;
homeButton.disabled = true;
syncButton.disabled = true;
post({ type: 'ready' });
if (document.hasFocus()) {
  post({ type: 'focus', focused: true });
}
