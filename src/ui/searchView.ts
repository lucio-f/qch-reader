import * as vscode from 'vscode';
import type { Disposable } from './disposable';
import { formatQtHelpUrl } from '../core/library/qthelpUrl';
import { type FullTextHit, searchFullText } from '../core/search/fullTextSearch';
import { type ParsedQuery, parseQuery } from '../core/search/queryParser';
import { highlight, makeSnippet, toSegments } from '../core/search/snippet';
import type {
  HighlightTerm,
  SearchMode,
  SearchResultItem,
  SearchViewFromWebview,
  SearchViewToWebview,
} from '../shared/protocol';
import { readConfig } from './config';
import type { DocPanelManager } from './docPanelManager';
import type { FilterService } from './filterService';
import type { IndexService } from './indexService';
import type { LibraryService } from './libraryService';
import { type PageService, shortTitle } from './pageService';
import { webviewResourceRoots, webviewShell } from './webviewHtml';

const PAGE_SIZE = 50;

interface CachedFullText {
  readonly key: string;
  readonly hits: readonly FullTextHit[];
  readonly total: number;
  readonly truncated: boolean;
  readonly query: ParsedQuery;
}

/** The "Search" sidebar view: keyword index lookup and full-text search. */
export class SearchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'qchReader.search';
  private view: vscode.WebviewView | undefined;
  private latestRequest = 0;
  private cache: CachedFullText | undefined;
  private pendingQuery: Extract<SearchViewToWebview, { type: 'setQuery' }> | undefined;
  private readonly disposables: Disposable[];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly library: LibraryService,
    private readonly filters: FilterService,
    private readonly indexes: IndexService,
    private readonly pages: PageService,
    private readonly panels: DocPanelManager,
  ) {
    const invalidate = (): void => {
      this.cache = undefined;
      this.postState();
    };
    this.disposables = [
      vscode.window.registerWebviewViewProvider(SearchViewProvider.viewId, this),
      library.onDidChange(invalidate),
      filters.onDidChange(invalidate),
      indexes.onDidChangeStatus((status) => {
        if (status.state !== 'building' || status.done % 5 === 0) {
          this.cache = undefined;
        }
        this.postState();
      }),
    ];
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: webviewResourceRoots(this.extensionUri),
    };
    view.webview.html = webviewShell(view.webview, this.extensionUri, {
      title: 'Search',
      bundle: 'searchView',
      body: '',
    });
    view.webview.onDidReceiveMessage((message: SearchViewFromWebview) => {
      void this.onMessage(message);
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Reveals the view and runs a query. */
  public async show(query: string, mode?: SearchMode, scope?: string): Promise<void> {
    this.pendingQuery = {
      type: 'setQuery',
      query,
      ...(mode ? { mode } : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
    await vscode.commands.executeCommand(`${SearchViewProvider.viewId}.focus`);
    this.flushPendingQuery();
  }

  private flushPendingQuery(): void {
    if (this.view && this.pendingQuery) {
      void this.view.webview.postMessage(this.pendingQuery);
      this.pendingQuery = undefined;
    }
  }

  private post(message: SearchViewToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private postState(): void {
    this.post({
      type: 'state',
      documents: this.library.current.documents
        .filter((document) => this.filters.matcher.matchesDocument(document))
        .map((document) => ({
          namespace: document.namespace,
          title: document.title,
          version: document.version,
        })),
      filterLabel: this.filters.filter.label,
      filtered: this.filters.filter.id !== 'all',
      index: this.indexes.status,
      loading: this.library.loading,
    });
  }

  private async onMessage(message: SearchViewFromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postState();
        this.flushPendingQuery();
        break;
      case 'search':
        await this.search(
          message.requestId,
          message.query,
          message.mode,
          message.scope,
          message.offset,
        );
        break;
      case 'open':
        await this.panels.open(message.url, {
          side: message.side,
          newPanel: message.side,
          highlights: message.highlights,
        });
        break;
      case 'selectFilter':
        await vscode.commands.executeCommand('qchReader.selectFilter');
        break;
      case 'buildIndex':
        await this.indexes.ensure();
        break;
      case 'addFolder':
        await vscode.commands.executeCommand('qchReader.addFolder');
        break;
    }
  }

  private async search(
    requestId: number,
    query: string,
    mode: SearchMode,
    scope: string,
    offset: number,
  ): Promise<void> {
    this.latestRequest = requestId;
    const started = performance.now();
    const namespace = scope === '' ? undefined : scope;
    try {
      if (mode === 'index') {
        this.searchIndex(requestId, query, namespace, offset, started);
      } else {
        await this.searchFullText(requestId, query, namespace, offset, started);
      }
    } catch (error) {
      this.post({
        type: 'results',
        requestId,
        mode,
        items: [],
        highlights: [],
        total: 0,
        truncated: false,
        elapsedMs: performance.now() - started,
        append: offset > 0,
        hasMore: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private searchIndex(
    requestId: number,
    query: string,
    namespace: string | undefined,
    offset: number,
    started: number,
  ): void {
    const library = this.library.current;
    const result = this.library.keywords.search(query, {
      matcher: this.filters.matcher,
      limit: readConfig().maxResults,
      namespace,
    });
    const items: SearchResultItem[] = [];
    for (const hit of result.hits.slice(offset, offset + PAGE_SIZE)) {
      const { document, keyword } = hit.entry;
      const url = library.urlForKeyword(document, keyword);
      if (!url) {
        continue;
      }
      const entry = document.getFile(keyword.fileId);
      const title =
        hit.matchStart >= 0
          ? toSegments(keyword.name, [
              { start: hit.matchStart, end: hit.matchStart + hit.matchLength, term: '' },
            ])
          : [{ text: keyword.name, match: false }];
      items.push({
        url: formatQtHelpUrl(url),
        title,
        subtitle:
          keyword.identifier !== keyword.name ? keyword.identifier : shortTitle(entry?.title ?? ''),
        detail: `${document.title} ${document.version}`.trim(),
      });
    }
    this.post({
      type: 'results',
      requestId,
      mode: 'index',
      items,
      highlights: [],
      total: result.total,
      truncated: result.total > result.hits.length,
      elapsedMs: performance.now() - started,
      append: offset > 0,
      hasMore: offset + PAGE_SIZE < result.hits.length,
    });
  }

  private async searchFullText(
    requestId: number,
    query: string,
    namespace: string | undefined,
    offset: number,
    started: number,
  ): Promise<void> {
    if (this.indexes.status.state === 'idle') {
      void this.indexes.ensure();
    }
    const key = `${query}\u0000${namespace ?? ''}`;
    let cached = this.cache?.key === key ? this.cache : undefined;
    if (!cached || offset === 0) {
      const parsed = parseQuery(query);
      const result = await searchFullText(this.indexes.available, parsed, {
        matcher: this.filters.matcher,
        limit: readConfig().maxResults,
        namespace,
        keywords: this.library.keywords,
        loadText: async (document, entry) => this.pages.pageText(document, entry),
      });
      cached = {
        key,
        hits: result.hits,
        total: result.total,
        truncated: result.truncated,
        query: parsed,
      };
      this.cache = cached;
    }
    if (requestId !== this.latestRequest) {
      return;
    }
    const library = this.library.current;
    const highlights: readonly HighlightTerm[] = cached.query.highlights;
    const items = await Promise.all(
      cached.hits.slice(offset, offset + PAGE_SIZE).map(async (hit): Promise<SearchResultItem> => {
        const text = await this.pages.pageText(hit.document, hit.entry);
        return {
          url: formatQtHelpUrl(library.urlForFile(hit.document, hit.entry)),
          title: highlight(shortTitle(hit.entry.title) || hit.entry.path, highlights),
          subtitle: `${hit.document.title} ${hit.document.version}`.trim(),
          detail: hit.entry.path,
          snippet: makeSnippet(text, highlights),
        };
      }),
    );
    if (requestId !== this.latestRequest) {
      return;
    }
    this.post({
      type: 'results',
      requestId,
      mode: 'fulltext',
      items,
      highlights,
      total: cached.total,
      truncated: cached.truncated,
      elapsedMs: performance.now() - started,
      append: offset > 0,
      hasMore: offset + PAGE_SIZE < cached.hits.length,
    });
  }

  public dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
