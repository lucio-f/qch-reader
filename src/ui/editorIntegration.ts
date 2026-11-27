import * as vscode from 'vscode';
import type { Disposable } from './disposable';
import { extractBrief } from '../core/html/text';
import { formatQtHelpUrl } from '../core/library/qthelpUrl';
import type { KeywordEntry } from '../core/search/keywordSearch';
import { readConfig } from './config';
import type { DocPanelManager } from './docPanelManager';
import type { FilterService } from './filterService';
import type { LibraryService } from './libraryService';
import { shortTitle } from './pageService';

interface KeywordPickItem extends vscode.QuickPickItem {
  readonly url?: string;
}

const SYMBOL_PATTERN = /[A-Za-z_~][A-Za-z0-9_]*(?:::[A-Za-z_~][A-Za-z0-9_]*)*/;
const QTHELP_LINK = /qthelp:\/\/[^\s"'<>()[\]{}`]+/g;
const OPEN_TO_SIDE: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('split-horizontal'),
  tooltip: 'Open to the Side',
};

/** Keyword lookup, context help, hovers and qthelp:// links in text editors. */
export class EditorIntegration implements vscode.Disposable {
  private readonly disposables: Disposable[] = [];
  private hoverRegistration: vscode.Disposable | undefined;
  private linkRegistration: vscode.Disposable | undefined;

  public constructor(
    private readonly library: LibraryService,
    private readonly filters: FilterService,
    private readonly panels: DocPanelManager,
  ) {
    this.registerProviders();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('qchReader.hover') ||
          event.affectsConfiguration('qchReader.documentLinks')
        ) {
          this.registerProviders();
        }
      }),
    );
  }

  private registerProviders(): void {
    this.hoverRegistration?.dispose();
    this.linkRegistration?.dispose();
    this.hoverRegistration = undefined;
    this.linkRegistration = undefined;
    const config = readConfig();
    if (config.hoverEnabled && config.hoverLanguages.length > 0) {
      this.hoverRegistration = vscode.languages.registerHoverProvider(
        config.hoverLanguages.map((language) => ({ language })),
        {
          provideHover: async (document, position, token) =>
            this.provideHover(document, position, token),
        },
      );
    }
    if (config.documentLinksEnabled) {
      this.linkRegistration = vscode.languages.registerDocumentLinkProvider(
        [{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-notebook-cell' }],
        { provideDocumentLinks: (document) => this.provideDocumentLinks(document) },
      );
    }
  }

  private keywordItem(entry: KeywordEntry): KeywordPickItem {
    const { document, keyword } = entry;
    const url = this.library.current.urlForKeyword(document, keyword);
    const page = document.getFile(keyword.fileId);
    return {
      label: keyword.name,
      description: keyword.identifier !== keyword.name ? keyword.identifier : undefined,
      detail: `${shortTitle(page?.title ?? '')} — ${document.title} ${document.version}`.trim(),
      url: url ? formatQtHelpUrl(url) : undefined,
      buttons: [OPEN_TO_SIDE],
    } as KeywordPickItem;
  }

  /** Quick pick over the keyword index, updated as you type. */
  public async goToKeyword(initial = ''): Promise<void> {
    await this.library.whenReady();
    const quickPick = vscode.window.createQuickPick<KeywordPickItem>();
    quickPick.title = 'Go to Keyword in Documentation';
    quickPick.placeholder =
      'Type a class, function, property or topic (supports * and ? wildcards)';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = false;
    quickPick.value = initial;
    const update = (value: string): void => {
      const result = this.library.keywords.search(value, {
        matcher: this.filters.matcher,
        limit: 200,
      });
      quickPick.items = result.hits.map((hit) => ({
        ...this.keywordItem(hit.entry),
        alwaysShow: true,
      }));
      quickPick.title =
        value.trim() === ''
          ? 'Go to Keyword in Documentation'
          : `Go to Keyword in Documentation (${result.total.toLocaleString()} match${result.total === 1 ? '' : 'es'})`;
    };
    update(initial);
    quickPick.onDidChangeValue(update);
    quickPick.onDidTriggerItemButton(({ item }) => {
      if (item.url) {
        void this.panels.open(item.url, { side: true, newPanel: true });
        quickPick.hide();
      }
    });
    quickPick.onDidAccept(() => {
      const [item] = quickPick.selectedItems;
      if (item?.url) {
        void this.panels.open(item.url);
      }
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
    });
    quickPick.show();
  }

  private symbolAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const range = document.getWordRangeAtPosition(position, SYMBOL_PATTERN);
    return range ? document.getText(range) : undefined;
  }

  /** Finds keywords for a symbol, trying `A::B::c`, then `B::c`, then `c`. */
  private lookup(symbol: string): KeywordEntry[] {
    const parts = symbol.split('::');
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(i).join('::');
      const entries = this.library.keywords.lookup(candidate, this.filters.matcher);
      if (entries.length > 0) {
        return entries;
      }
    }
    return [];
  }

  /** Context help: opens the documentation of the symbol under the cursor (or selection). */
  public async lookupSymbol(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await this.goToKeyword();
      return;
    }
    await this.library.whenReady();
    const selection = editor.document.getText(editor.selection).trim();
    const symbol = selection || this.symbolAt(editor.document, editor.selection.active);
    if (!symbol) {
      await this.goToKeyword();
      return;
    }
    const entries = this.lookup(symbol);
    const unique = new Map(entries.map((entry) => [this.keywordItem(entry).url ?? '', entry]));
    unique.delete('');
    const [only] = unique.values();
    if (unique.size === 1 && only) {
      const url = this.library.current.urlForKeyword(only.document, only.keyword);
      if (url) {
        await this.panels.open(formatQtHelpUrl(url), { side: true, preserveFocus: true });
        return;
      }
    }
    if (unique.size > 1) {
      const picked = await vscode.window.showQuickPick(
        [...unique.values()].map((entry) => this.keywordItem(entry)),
        {
          title: `Documentation for ${symbol}`,
          placeHolder: 'Several topics match; choose one',
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (picked?.url) {
        await this.panels.open(picked.url, { side: true, preserveFocus: true });
      }
      return;
    }
    await this.goToKeyword(symbol);
  }

  private async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (this.library.current.isEmpty) {
      return undefined;
    }
    const range = document.getWordRangeAtPosition(position, SYMBOL_PATTERN);
    if (!range) {
      return undefined;
    }
    const symbol = document.getText(range);
    // Only exact, case-sensitive matches: hovering ordinary words should stay quiet.
    const entries = this.lookup(symbol).filter(
      (entry) =>
        entry.keyword.identifier === symbol ||
        entry.keyword.name === symbol ||
        symbol.endsWith(`::${entry.keyword.name}`),
    );
    const [entry] = entries;
    if (!entry) {
      return undefined;
    }
    const library = this.library.current;
    const url = library.urlForKeyword(entry.document, entry.keyword);
    if (!url) {
      return undefined;
    }
    const resolved = library.resolve(url);
    let brief = { heading: '', summary: '' };
    if (resolved) {
      try {
        brief = extractBrief(await library.readText(resolved), entry.keyword.anchor);
      } catch {
        // Show the hover without a summary.
      }
    }
    if (token.isCancellationRequested) {
      return undefined;
    }
    const href = formatQtHelpUrl(url);
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = { enabledCommands: ['qchReader.openUrl'] };
    if (brief.heading) {
      markdown.appendCodeblock(brief.heading, document.languageId);
    } else {
      markdown.appendMarkdown(`**${entry.keyword.identifier}**\n\n`);
    }
    if (brief.summary) {
      markdown.appendText(brief.summary);
      markdown.appendMarkdown('\n\n');
    }
    const args = encodeURIComponent(JSON.stringify([href, { side: true, preserveFocus: true }]));
    markdown.appendMarkdown(
      `[$(book) Open documentation](command:qchReader.openUrl?${args} "${href}") — ${entry.document.title} ${entry.document.version}`,
    );
    if (entries.length > 1) {
      markdown.appendMarkdown(
        ` · ${entries.length - 1} more topic${entries.length > 2 ? 's' : ''}`,
      );
    }
    return new vscode.Hover(markdown, range);
  }

  private provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const text = document.getText();
    if (!text.includes('qthelp://')) {
      return [];
    }
    const links: vscode.DocumentLink[] = [];
    for (const match of text.matchAll(QTHELP_LINK)) {
      const href = match[0].replace(/[.,;:]+$/, '');
      const start = document.positionAt(match.index);
      const range = new vscode.Range(start, start.translate(0, href.length));
      const args = encodeURIComponent(JSON.stringify([href]));
      const link = new vscode.DocumentLink(
        range,
        vscode.Uri.parse(`command:qchReader.openUrl?${args}`),
      );
      link.tooltip = 'Open in QCH Documentation Reader';
      links.push(link);
    }
    return links;
  }

  public dispose(): void {
    this.hoverRegistration?.dispose();
    this.linkRegistration?.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
