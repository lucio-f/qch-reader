import * as vscode from 'vscode';
import type { Disposable } from './disposable';
import type { QchLibrary, TocNode } from '../core/library/library';
import { type QtHelpUrl, formatQtHelpUrl } from '../core/library/qthelpUrl';
import { type QchFile, isHtmlPath } from '../core/qch/qchFile';
import type { FilterService } from './filterService';
import type { LibraryService } from './libraryService';

export type ContentsNode =
  | { readonly kind: 'document'; readonly document: QchFile }
  | { readonly kind: 'toc'; readonly toc: TocNode };

/** Table of contents of all loaded documents, honoring the active filter. */
export class ContentsTreeProvider
  implements vscode.TreeDataProvider<ContentsNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<ContentsNode | undefined>();
  private readonly documentNodes = new Map<QchFile, ContentsNode>();
  private readonly tocNodes = new Map<TocNode, ContentsNode>();
  private readonly view: vscode.TreeView<ContentsNode>;
  private readonly disposables: Disposable[];

  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly library: LibraryService,
    private readonly filters: FilterService,
  ) {
    this.view = vscode.window.createTreeView('qchReader.contents', {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables = [
      this.emitter,
      this.view,
      library.onDidChange(() => {
        this.refresh();
      }),
      filters.onDidChange(() => {
        this.refresh();
      }),
    ];
    this.updateDescription();
  }

  private get current(): QchLibrary {
    return this.library.current;
  }

  public refresh(): void {
    this.documentNodes.clear();
    this.tocNodes.clear();
    this.updateDescription();
    this.emitter.fire(undefined);
  }

  private updateDescription(): void {
    const filter = this.filters.filter;
    this.view.description = filter.id === 'all' ? '' : filter.label;
  }

  private documentNode(document: QchFile): ContentsNode {
    let node = this.documentNodes.get(document);
    if (!node) {
      node = { kind: 'document', document };
      this.documentNodes.set(document, node);
    }
    return node;
  }

  private tocNode(toc: TocNode): ContentsNode {
    let node = this.tocNodes.get(toc);
    if (!node) {
      node = { kind: 'toc', toc };
      this.tocNodes.set(toc, node);
    }
    return node;
  }

  /** A document whose contents have a single root shows that root's children directly. */
  private documentRoots(document: QchFile): readonly TocNode[] {
    const roots = this.current.getToc(document, this.filters.matcher);
    const [only] = roots;
    return roots.length === 1 && only ? only.children : roots;
  }

  private isFlattenedRoot(toc: TocNode): boolean {
    if (toc.parent) {
      return false;
    }
    return this.current.getToc(toc.document, this.filters.matcher).length === 1;
  }

  public getChildren(element?: ContentsNode): ContentsNode[] {
    if (!element) {
      return this.current.documents
        .filter((document) => this.filters.matcher.matchesDocument(document))
        .map((document) => this.documentNode(document));
    }
    const children =
      element.kind === 'document' ? this.documentRoots(element.document) : element.toc.children;
    return children.map((child) => this.tocNode(child));
  }

  public getParent(element: ContentsNode): ContentsNode | undefined {
    if (element.kind === 'document') {
      return undefined;
    }
    const parent = element.toc.parent;
    if (!parent || this.isFlattenedRoot(parent)) {
      return this.documentNode(element.toc.document);
    }
    return this.tocNode(parent);
  }

  public getTreeItem(element: ContentsNode): vscode.TreeItem {
    if (element.kind === 'document') {
      const { document } = element;
      const item = new vscode.TreeItem(document.title, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `doc:${document.namespace}`;
      item.description = document.version;
      item.iconPath = new vscode.ThemeIcon('book');
      item.contextValue = 'qchDocument';
      const pages = document.files.filter((file) => isHtmlPath(file.path)).length;
      const tooltip = new vscode.MarkdownString(undefined, true);
      tooltip.appendMarkdown(`**${document.title}** ${document.version}\n\n`);
      tooltip.appendMarkdown(`$(symbol-namespace) \`${document.namespace}\`\n\n`);
      tooltip.appendMarkdown(
        `$(file) ${pages.toLocaleString()} pages · ${document.keywords.length.toLocaleString()} keywords\n\n`,
      );
      tooltip.appendText(document.location);
      item.tooltip = tooltip;
      return item;
    }
    const { toc } = element;
    const item = new vscode.TreeItem(
      toc.title,
      toc.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = toc.id;
    item.contextValue = 'qchPage';
    if (toc.url) {
      item.tooltip = `${toc.title}\n${toc.url.path}${toc.url.fragment ? `#${toc.url.fragment}` : ''}`;
      item.command = {
        command: 'qchReader.openUrl',
        title: 'Open',
        arguments: [formatQtHelpUrl(toc.url), { preserveFocus: true }],
      };
    }
    return item;
  }

  /** The URL a node opens (the start page for documents). */
  public urlOf(node: ContentsNode): QtHelpUrl | undefined {
    return node.kind === 'document'
      ? this.current.homePage(node.document, this.filters.matcher)
      : node.toc.url;
  }

  public get selection(): readonly ContentsNode[] {
    return this.view.selection;
  }

  /** Selects the contents entry of a page, expanding its ancestors. */
  public async reveal(url: QtHelpUrl, focus = false): Promise<boolean> {
    const [toc] = this.current.findTocNodes(url, this.filters.matcher);
    if (!toc) {
      return false;
    }
    const node = this.isFlattenedRoot(toc) ? this.documentNode(toc.document) : this.tocNode(toc);
    await this.view.reveal(node, { select: true, focus, expand: false });
    return true;
  }

  public dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
