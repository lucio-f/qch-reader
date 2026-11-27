import * as vscode from 'vscode';
import type { Disposable } from './disposable';
import {
  type QtHelpUrl,
  formatQtHelpUrl,
  pageKey,
  parseQtHelpUrl,
  withFragment,
} from '../core/library/qthelpUrl';
import type {
  Appearance,
  DocViewFromWebview,
  DocViewState,
  DocViewToWebview,
  HighlightTerm,
  NavigationState,
} from '../shared/protocol';
import type { FilterService } from './filterService';
import type { LibraryService } from './libraryService';
import { type PageService, shortTitle } from './pageService';
import { webviewResourceRoots, webviewShell } from './webviewHtml';

export const INFO_URL_PREFIX = 'qch-info:';

export interface OpenOptions {
  readonly newPanel?: boolean;
  readonly side?: boolean;
  readonly preserveFocus?: boolean;
  readonly highlights?: readonly HighlightTerm[];
}

export interface ViewerSettings {
  readonly zoom: number;
  readonly appearance: Appearance;
  readonly onDidChange: vscode.Event<{ readonly appearanceChanged: boolean }>;
  setZoom(zoom: number): void;
  toggleAppearance(): Promise<void>;
}

export interface ViewerServices {
  readonly extensionUri: vscode.Uri;
  readonly library: LibraryService;
  readonly filters: FilterService;
  readonly pages: PageService;
  readonly settings: ViewerSettings;
  readonly log: vscode.LogOutputChannel;
  open(url: string, options: OpenOptions): Promise<void>;
  revealInContents(url: QtHelpUrl): Promise<void>;
  searchText(text: string): Promise<void>;
  setFocused(viewer: DocViewer, focused: boolean): void;
}

interface HistoryEntry {
  url: string;
  scrollY: number | undefined;
  readonly highlights: readonly HighlightTerm[];
}

const MAX_HISTORY = 200;
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto']);

/** Documentation browser bound to one webview panel (a regular panel or a .qch editor). */
export class DocViewer implements vscode.Disposable {
  private history: HistoryEntry[] = [];
  private position = -1;
  private ready = false;
  private renderedKey: string | undefined;
  private renderToken = 0;
  private disposed = false;
  private readonly disposables: Disposable[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly navigateEmitter = new vscode.EventEmitter<string>();

  public readonly onDidDispose = this.disposeEmitter.event;
  public readonly onDidNavigate = this.navigateEmitter.event;

  public constructor(
    public readonly panel: vscode.WebviewPanel,
    private readonly services: ViewerServices,
    public readonly isEditor: boolean,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: webviewResourceRoots(services.extensionUri),
    };
    panel.iconPath = {
      light: vscode.Uri.joinPath(services.extensionUri, 'media', 'book-light.svg'),
      dark: vscode.Uri.joinPath(services.extensionUri, 'media', 'book-dark.svg'),
    };
    panel.webview.html = webviewShell(panel.webview, services.extensionUri, {
      title: 'Documentation',
      bundle: 'docView',
      body: '',
      remoteImages: true,
    });
    this.disposables.push(
      this.disposeEmitter,
      this.navigateEmitter,
      panel.webview.onDidReceiveMessage((message: DocViewFromWebview) => {
        void this.onMessage(message).catch((error: unknown) => {
          services.log.error(`Viewer message ${message.type} failed: ${String(error)}`);
        });
      }),
      panel.onDidDispose(() => {
        this.dispose();
      }),
      services.settings.onDidChange(({ appearanceChanged }) => {
        this.post({
          type: 'settings',
          zoom: services.settings.zoom,
          appearance: services.settings.appearance,
        });
        if (appearanceChanged) {
          this.renderedKey = undefined;
          void this.render();
        }
      }),
      services.library.onDidChange(() => {
        // Pages may now resolve differently (documents added or removed).
        this.renderedKey = undefined;
        void this.render();
      }),
    );
  }

  public get currentUrl(): string | undefined {
    return this.history[this.position]?.url;
  }

  public get currentQtHelpUrl(): QtHelpUrl | undefined {
    const url = this.currentUrl;
    return url ? parseQtHelpUrl(url) : undefined;
  }

  private get navigation(): NavigationState {
    return { canGoBack: this.position > 0, canGoForward: this.position < this.history.length - 1 };
  }

  private post(message: DocViewToWebview): void {
    if (this.ready) {
      void this.panel.webview.postMessage(message);
    }
  }

  /** Opens a URL in this viewer, adding a history entry. */
  public async navigate(
    url: string,
    options: { readonly highlights?: readonly HighlightTerm[]; readonly scrollY?: number } = {},
  ): Promise<void> {
    this.history = this.history.slice(0, this.position + 1);
    this.history.push({ url, scrollY: options.scrollY, highlights: options.highlights ?? [] });
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
    this.position = this.history.length - 1;
    await this.render();
  }

  public async back(): Promise<void> {
    if (this.position > 0) {
      this.position--;
      await this.render();
    }
  }

  public async forward(): Promise<void> {
    if (this.position < this.history.length - 1) {
      this.position++;
      await this.render();
    }
  }

  public async home(): Promise<void> {
    const library = this.services.library.current;
    const current = this.currentUrl;
    const namespace = current?.startsWith(INFO_URL_PREFIX)
      ? current.slice(INFO_URL_PREFIX.length)
      : this.currentQtHelpUrl?.namespace;
    const document =
      (namespace !== undefined ? library.getDocument(namespace) : undefined) ??
      library.documents[0];
    const home = document ? library.homePage(document, this.services.filters.matcher) : undefined;
    if (home) {
      await this.navigate(formatQtHelpUrl(home));
    }
  }

  public find(): void {
    this.post({ type: 'find' });
  }

  public clearHighlights(): void {
    this.post({ type: 'clearHighlights' });
  }

  private async render(): Promise<void> {
    const entry = this.history[this.position];
    if (!entry || !this.ready) {
      return;
    }
    const token = ++this.renderToken;
    this.navigateEmitter.fire(entry.url);

    if (entry.url.startsWith(INFO_URL_PREFIX)) {
      const namespace = entry.url.slice(INFO_URL_PREFIX.length);
      const document = this.services.library.current.getDocument(namespace);
      if (!document) {
        this.showNotFound(entry.url, `The document ${namespace} is no longer loaded.`);
        return;
      }
      const location = this.services.library.uriOf(document);
      const info = this.services.pages.infoPage(
        document,
        location?.scheme === 'file' ? location.fsPath : document.location,
      );
      this.renderedKey = entry.url;
      this.panel.title = info.title;
      this.post({
        type: 'page',
        url: entry.url,
        title: info.title,
        documentTitle: document.title,
        html: info.html,
        fragment: '',
        scrollY: entry.scrollY,
        highlights: [],
        breadcrumbs: [],
        navigation: this.navigation,
        appearance: 'themed',
      });
      return;
    }

    const url = parseQtHelpUrl(entry.url);
    if (!url) {
      this.showNotFound(entry.url, 'This is not a valid qthelp:// URL.');
      return;
    }
    const key = pageKey(withFragment(url, ''));
    if (key === this.renderedKey) {
      this.post({ type: 'navigation', url: entry.url, navigation: this.navigation });
      this.post({ type: 'scrollTo', fragment: url.fragment, scrollY: entry.scrollY });
      return;
    }

    this.post({ type: 'loading' });
    await this.services.library.whenReady();
    const appearance = this.services.settings.appearance;
    let result;
    try {
      result = await this.services.pages.render(url, appearance);
    } catch (error) {
      result = {
        kind: 'notFound' as const,
        message: `The page could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (token !== this.renderToken) {
      return;
    }
    if (result.kind === 'notFound') {
      this.showNotFound(entry.url, result.message);
      return;
    }
    // Canonicalize: cross-module links may resolve into another namespace.
    entry.url = formatQtHelpUrl(result.url);
    this.renderedKey = pageKey(withFragment(result.url, ''));
    this.panel.title = result.title;
    this.post({
      type: 'page',
      url: entry.url,
      title: result.title,
      documentTitle: `${result.document.title} ${result.document.version}`.trim(),
      html: result.html,
      fragment: result.url.fragment,
      scrollY: entry.scrollY,
      highlights: entry.highlights,
      breadcrumbs: this.services.pages.breadcrumbs(result.url),
      navigation: this.navigation,
      appearance,
    });
  }

  private showNotFound(url: string, message: string): void {
    this.renderedKey = undefined;
    this.panel.title = 'Page Not Found';
    this.post({ type: 'notFound', url, message, navigation: this.navigation });
  }

  private async onMessage(message: DocViewFromWebview): Promise<void> {
    switch (message.type) {
      case 'ready': {
        this.ready = true;
        this.renderedKey = undefined;
        this.post({
          type: 'settings',
          zoom: this.services.settings.zoom,
          appearance: this.services.settings.appearance,
        });
        await this.render();
        break;
      }
      case 'navigate': {
        if (message.newTab || message.side) {
          await this.services.open(message.href, { newPanel: true, side: message.side });
        } else {
          await this.navigate(message.href);
        }
        break;
      }
      case 'openExternal': {
        const uri = vscode.Uri.parse(message.href, true);
        if (EXTERNAL_SCHEMES.has(uri.scheme)) {
          await vscode.env.openExternal(uri);
        }
        break;
      }
      case 'fragment': {
        const url = this.currentQtHelpUrl;
        const entry = this.history[this.position];
        if (url && entry) {
          this.history = this.history.slice(0, this.position + 1);
          this.history.push({
            url: formatQtHelpUrl(withFragment(url, message.fragment)),
            scrollY: undefined,
            highlights: entry.highlights,
          });
          this.position = this.history.length - 1;
          this.post({
            type: 'navigation',
            url: this.currentUrl ?? '',
            navigation: this.navigation,
          });
          this.navigateEmitter.fire(this.currentUrl ?? '');
        }
        break;
      }
      case 'back':
        await this.back();
        break;
      case 'forward':
        await this.forward();
        break;
      case 'home':
        await this.home();
        break;
      case 'scroll': {
        const entry = this.history[this.position];
        if (entry) {
          entry.scrollY = message.scrollY;
        }
        break;
      }
      case 'syncContents': {
        const url = this.currentQtHelpUrl;
        if (url) {
          await this.services.revealInContents(url);
        }
        break;
      }
      case 'copyUrl': {
        const href = message.href ?? this.currentUrl;
        if (href) {
          await vscode.env.clipboard.writeText(href);
          void vscode.window.setStatusBarMessage('$(check) Link copied', 2000);
        }
        break;
      }
      case 'toggleAppearance':
        await this.services.settings.toggleAppearance();
        break;
      case 'zoom':
        this.services.settings.setZoom(message.zoom);
        break;
      case 'focus':
        this.services.setFocused(this, message.focused);
        break;
      case 'searchText':
        await this.services.searchText(message.text);
        break;
    }
  }

  /** State persisted by VS Code to restore the panel after a reload. */
  public static restoreUrl(state: unknown): string | undefined {
    if (typeof state === 'object' && state !== null && 'url' in state) {
      const { url } = state as DocViewState;
      return typeof url === 'string' && url !== '' ? url : undefined;
    }
    return undefined;
  }

  public get title(): string {
    return shortTitle(this.panel.title);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.renderToken++;
    this.disposeEmitter.fire();
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
