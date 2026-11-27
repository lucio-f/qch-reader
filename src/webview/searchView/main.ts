import type {
  HighlightTerm,
  IndexStatus,
  SearchMode,
  SearchResultItem,
  SearchViewFromWebview,
  SearchViewToWebview,
} from '../../shared/protocol';
import { debounce, h, icon, iconButton, renderSegments } from '../shared/dom';

interface ViewState {
  readonly query: string;
  readonly mode: SearchMode;
  readonly scope: string;
}

const vscode = acquireVsCodeApi<ViewState>();
const post = (message: SearchViewFromWebview): void => {
  vscode.postMessage(message);
};
const saved = vscode.getState();

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

const queryInput = h('input', {
  type: 'text',
  class: 'query',
  placeholder: 'Search documentation',
  'aria-label': 'Search documentation',
  spellcheck: 'false',
  autocomplete: 'off',
});
const clearButton = iconButton('clear', 'close', 'Clear');
const helpButton = iconButton('help', 'question', 'Search syntax');
helpButton.setAttribute('aria-expanded', 'false');
const fullTextTab = h(
  'button',
  { class: 'tab', role: 'tab', type: 'button', id: 'tab-fulltext' },
  'Full Text',
);
const indexTab = h(
  'button',
  { class: 'tab', role: 'tab', type: 'button', id: 'tab-index' },
  'Index',
);
const scopeSelect = h('select', { class: 'scope', 'aria-label': 'Search in document' });
const filterButton = h('button', {
  class: 'filter-chip',
  type: 'button',
  title: 'Change the documentation filter',
});

const helpPanel = h(
  'div',
  { class: 'help', hidden: true },
  h('p', {}, h('strong', {}, 'Full text'), ' — all words must match:'),
  h(
    'table',
    {},
    ...(
      [
        ['signal slot', 'pages containing both words'],
        ['"implicitly shared"', 'exact phrase'],
        ['regul*', 'words starting with “regul”'],
        ['thread -signal', 'exclude pages with “signal”'],
        ['utf8 OR latin1', 'either word'],
        ['title:model', 'word in the page title'],
        ['doc:qtcore', 'only documents matching “qtcore”'],
      ] as const
    ).map(([syntax, meaning]) =>
      h('tr', {}, h('td', {}, h('code', {}, syntax)), h('td', {}, meaning)),
    ),
  ),
  h(
    'p',
    {},
    h('strong', {}, 'Index'),
    ' — keywords by name (e.g. ',
    h('code', {}, 'QString::arg'),
    '); use ',
    h('code', {}, '*'),
    ' and ',
    h('code', {}, '?'),
    ' as wildcards.',
  ),
);

const indexStatus = h('div', { class: 'index-status', hidden: true });
const summary = h('div', { class: 'summary', 'aria-live': 'polite' });
const results = h('ul', {
  class: 'results',
  role: 'listbox',
  'aria-label': 'Search results',
  tabindex: '-1',
});
const moreButton = h(
  'button',
  { class: 'more', type: 'button', hidden: true },
  'Show more results',
);
const emptyState = h('div', { class: 'empty', hidden: true });

document.body.append(
  h(
    'div',
    { class: 'header' },
    h('div', { class: 'input-row' }, icon('search'), queryInput, clearButton, helpButton),
    h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': 'Search mode' },
      fullTextTab,
      indexTab,
    ),
    h('div', { class: 'options-row' }, scopeSelect, filterButton),
    helpPanel,
    indexStatus,
  ),
  summary,
  results,
  moreButton,
  emptyState,
);

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

let mode: SearchMode = saved?.mode ?? 'fulltext';
let scope = saved?.scope ?? '';
let requestId = 0;
let offset = 0;
let selected = -1;
let items: SearchResultItem[] = [];
let highlights: readonly HighlightTerm[] = [];
let index: IndexStatus = { state: 'idle', done: 0, total: 0 };
let hasDocuments = true;
let loading = false;
queryInput.value = saved?.query ?? '';

function saveState(): void {
  vscode.setState({ query: queryInput.value, mode, scope });
}

function updateTabs(): void {
  fullTextTab.setAttribute('aria-selected', String(mode === 'fulltext'));
  indexTab.setAttribute('aria-selected', String(mode === 'index'));
  queryInput.placeholder =
    mode === 'fulltext' ? 'Search all pages' : 'Find a keyword (class, function, …)';
  updateIndexStatus();
}

function updateIndexStatus(): void {
  const building = index.state === 'building';
  const show =
    mode === 'fulltext' &&
    (building || index.state === 'idle' || index.state === 'disabled' || index.state === 'error');
  indexStatus.hidden = !show || !hasDocuments;
  if (indexStatus.hidden) {
    return;
  }
  if (building) {
    const percent = index.total > 0 ? Math.round((index.done / index.total) * 100) : 0;
    const bar = h(
      'div',
      { class: 'bar' },
      h('div', { class: 'fill', style: `width: ${percent}%` }),
    );
    indexStatus.replaceChildren(
      bar,
      h('span', {}, `Indexing documentation… ${index.done}/${index.total}`),
    );
  } else if (index.state === 'disabled') {
    indexStatus.replaceChildren(
      h('span', {}, 'Full-text search is disabled in the settings. The Index tab still works.'),
    );
  } else {
    const build = h('button', { class: 'link-button', type: 'button' }, 'Build the search index');
    build.addEventListener('click', () => {
      post({ type: 'buildIndex' });
    });
    indexStatus.replaceChildren(
      h(
        'span',
        {},
        index.state === 'error'
          ? (index.message ?? 'Indexing failed.')
          : 'Full-text search needs an index. ',
      ),
      build,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------------------------

function search(more = false): void {
  const query = queryInput.value.trim();
  saveState();
  clearButton.hidden = queryInput.value === '';
  if (!more) {
    offset = 0;
  }
  if (query === '') {
    requestId++;
    items = [];
    results.replaceChildren();
    summary.textContent = '';
    moreButton.hidden = true;
    showEmptyState();
    return;
  }
  requestId++;
  post({ type: 'search', requestId, query, mode, scope, offset });
}

const searchSoon = debounce(() => {
  search();
}, 180);

function showEmptyState(): void {
  if (!hasDocuments) {
    emptyState.replaceChildren(
      h('p', {}, loading ? 'Loading documentation…' : 'No documentation is loaded.'),
    );
    if (!loading) {
      const add = h('button', { class: 'button', type: 'button' }, 'Add Documentation Folder');
      add.addEventListener('click', () => {
        post({ type: 'addFolder' });
      });
      emptyState.append(add);
    }
    emptyState.hidden = false;
    return;
  }
  if (queryInput.value.trim() === '') {
    emptyState.replaceChildren(
      h(
        'p',
        {},
        mode === 'fulltext'
          ? 'Type to search the text of every page.'
          : 'Type to look up keywords in the index.',
      ),
    );
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;
}

function renderItem(item: SearchResultItem, position: number): HTMLLIElement {
  const title = h('div', { class: 'title' });
  renderSegments(title, item.title);
  const meta = h('div', { class: 'meta' }, h('span', { class: 'subtitle' }, item.subtitle));
  if (item.detail) {
    meta.append(h('span', { class: 'detail' }, item.detail));
  }
  const li = h(
    'li',
    {
      class: 'result',
      role: 'option',
      id: `result-${position}`,
      'aria-selected': 'false',
      title: item.url,
    },
    title,
    meta,
  );
  if (item.snippet && item.snippet.length > 0) {
    const snippet = h('div', { class: 'snippet' });
    renderSegments(snippet, item.snippet);
    li.append(snippet);
  }
  li.addEventListener('click', (event) => {
    select(position, false);
    open(position, event.ctrlKey || event.metaKey || event.altKey);
  });
  li.addEventListener('auxclick', (event) => {
    if (event.button === 1) {
      open(position, true);
    }
  });
  return li;
}

function select(position: number, reveal = true): void {
  const previous = results.children[selected];
  previous?.setAttribute('aria-selected', 'false');
  selected = Math.max(-1, Math.min(items.length - 1, position));
  const current = results.children[selected];
  if (current) {
    current.setAttribute('aria-selected', 'true');
    results.setAttribute('aria-activedescendant', current.id);
    if (reveal) {
      current.scrollIntoView({ block: 'nearest' });
    }
  }
}

function open(position: number, side: boolean): void {
  const item = items[position];
  if (item) {
    post({ type: 'open', url: item.url, side, highlights: mode === 'fulltext' ? highlights : [] });
  }
}

function showResults(message: Extract<SearchViewToWebview, { type: 'results' }>): void {
  if (message.requestId !== requestId) {
    return;
  }
  emptyState.hidden = true;
  highlights = message.highlights;
  if (!message.append) {
    items = [];
    results.replaceChildren();
    selected = -1;
    results.scrollTop = 0;
  }
  const start = items.length;
  items.push(...message.items);
  results.append(...message.items.map((item, i) => renderItem(item, start + i)));
  offset = items.length;
  moreButton.hidden = !message.hasMore;

  if (message.error) {
    summary.textContent = `Error: ${message.error}`;
    summary.classList.add('error');
    return;
  }
  summary.classList.remove('error');
  if (message.total === 0) {
    const building = message.mode === 'fulltext' && index.state === 'building';
    summary.textContent = building ? 'No results yet — indexing is still running.' : 'No results.';
    return;
  }
  const count = message.total.toLocaleString();
  summary.textContent = `${count}${message.truncated ? '+' : ''} result${message.total === 1 ? '' : 's'} · ${Math.max(1, Math.round(message.elapsedMs))} ms`;
}

function updateScopes(
  documents: Extract<SearchViewToWebview, { type: 'state' }>['documents'],
): void {
  const options = [h('option', { value: '' }, 'All documents')];
  for (const document of documents) {
    options.push(
      h('option', { value: document.namespace }, `${document.title} ${document.version}`.trim()),
    );
  }
  scopeSelect.replaceChildren(...options);
  if (scope !== '' && !documents.some((d) => d.namespace === scope)) {
    scope = '';
  }
  scopeSelect.value = scope;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

queryInput.addEventListener('input', () => {
  clearButton.hidden = queryInput.value === '';
  searchSoon();
});

queryInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (selected >= 0) {
      open(selected, event.ctrlKey || event.metaKey || event.altKey);
    } else if (items.length > 0 && !event.shiftKey) {
      open(0, event.ctrlKey || event.metaKey || event.altKey);
    } else {
      search();
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    select(selected + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    select(selected - 1);
  } else if (event.key === 'Escape' && queryInput.value !== '') {
    event.preventDefault();
    queryInput.value = '';
    search();
  }
});

results.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    select(selected + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (selected <= 0) {
      queryInput.focus();
      select(-1);
    } else {
      select(selected - 1);
    }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    open(selected, event.ctrlKey || event.metaKey || event.altKey);
  }
});

clearButton.addEventListener('click', () => {
  queryInput.value = '';
  queryInput.focus();
  search();
});

helpButton.addEventListener('click', () => {
  helpPanel.hidden = !helpPanel.hidden;
  helpButton.setAttribute('aria-expanded', String(!helpPanel.hidden));
});

for (const [tab, tabMode] of [
  [fullTextTab, 'fulltext'],
  [indexTab, 'index'],
] as const) {
  tab.addEventListener('click', () => {
    if (mode !== tabMode) {
      mode = tabMode;
      updateTabs();
      search();
    }
    queryInput.focus();
  });
}

scopeSelect.addEventListener('change', () => {
  scope = scopeSelect.value;
  search();
});

filterButton.addEventListener('click', () => {
  post({ type: 'selectFilter' });
});

moreButton.addEventListener('click', () => {
  search(true);
});

window.addEventListener('message', (event: MessageEvent<SearchViewToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'state': {
      const indexBecameReady = index.state !== 'ready' && message.index.state === 'ready';
      const progressed = message.index.done !== index.done;
      index = message.index;
      hasDocuments = message.documents.length > 0;
      loading = message.loading;
      updateScopes(message.documents);
      filterButton.replaceChildren(
        icon(message.filtered ? 'filter-filled' : 'filter'),
        h('span', {}, message.filterLabel),
      );
      filterButton.classList.toggle('active', message.filtered);
      updateIndexStatus();
      showEmptyState();
      // Refresh full-text results as more documents become searchable.
      if (
        mode === 'fulltext' &&
        queryInput.value.trim() !== '' &&
        (indexBecameReady || (progressed && offset <= 50))
      ) {
        searchSoon();
      }
      break;
    }
    case 'results':
      showResults(message);
      break;
    case 'setQuery':
      if (message.mode) {
        mode = message.mode;
      }
      if (message.scope !== undefined) {
        scope = message.scope;
        scopeSelect.value = scope;
      }
      updateTabs();
      if (message.query) {
        queryInput.value = message.query;
      }
      queryInput.focus();
      queryInput.select();
      search();
      break;
  }
});

updateTabs();
clearButton.hidden = queryInput.value === '';
post({ type: 'ready' });
queryInput.focus();
if (queryInput.value.trim() !== '') {
  search();
} else {
  showEmptyState();
}
