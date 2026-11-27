import * as vscode from 'vscode';
import { formatQtHelpUrl, parseQtHelpUrl } from './core/library/qthelpUrl';
import type { QchFile } from './core/qch/qchFile';
import { type ContentsNode, ContentsTreeProvider } from './ui/contentsTree';
import { DocPanelManager } from './ui/docPanelManager';
import { INFO_URL_PREFIX, type OpenOptions } from './ui/docViewer';
import { EditorIntegration } from './ui/editorIntegration';
import { FilterService } from './ui/filterService';
import { IndexService } from './ui/indexService';
import { LibraryService } from './ui/libraryService';
import { addDocumentationLocations, removeDocumentationLocations } from './ui/locations';
import { PageService } from './ui/pageService';
import { QchEditorProvider } from './ui/qchEditorProvider';
import { SearchViewProvider } from './ui/searchView';

function isContentsNode(value: unknown): value is ContentsNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'document' || value.kind === 'toc')
  );
}

function toOpenOptions(value: unknown): OpenOptions {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record['side'] === 'boolean'
      ? { side: record['side'], newPanel: record['side'] }
      : {}),
    ...(typeof record['preserveFocus'] === 'boolean'
      ? { preserveFocus: record['preserveFocus'] }
      : {}),
    ...(typeof record['newPanel'] === 'boolean' ? { newPanel: record['newPanel'] } : {}),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('QCH Reader', { log: true });
  const library = new LibraryService(log);
  const filters = new FilterService(context, library);
  const indexes = new IndexService(context, library, log);
  const pages = new PageService(library, filters);

  const contents = new ContentsTreeProvider(library, filters);
  const deferred: { search?: SearchViewProvider } = {};
  const panels = new DocPanelManager({
    context,
    library,
    filters,
    pages,
    log,
    revealInContents: async (url) => {
      if (!(await contents.reveal(url, true))) {
        void vscode.window.setStatusBarMessage('This page is not listed in the contents', 3000);
      }
    },
    searchText: async (text) => deferred.search?.show(text, 'fulltext'),
  });
  const search = new SearchViewProvider(
    context.extensionUri,
    library,
    filters,
    indexes,
    pages,
    panels,
  );
  deferred.search = search;
  const editor = new EditorIntegration(library, filters, panels);

  context.subscriptions.push(log, library, filters, indexes, panels, contents, search, editor);
  context.subscriptions.push(QchEditorProvider.register(library, panels));

  const pickDocument = async (placeHolder: string): Promise<QchFile | undefined> => {
    await library.whenReady();
    const documents = library.current.documents.filter((document) =>
      filters.matcher.matchesDocument(document),
    );
    if (documents.length <= 1) {
      return documents[0];
    }
    const picked = await vscode.window.showQuickPick(
      documents.map((document) => ({
        label: document.title,
        description: document.version,
        detail: document.namespace,
        document,
      })),
      { placeHolder, matchOnDetail: true },
    );
    return picked?.document;
  };

  const nodeUrl = (node: unknown): string | undefined => {
    if (isContentsNode(node)) {
      const url = contents.urlOf(node);
      return url ? formatQtHelpUrl(url) : undefined;
    }
    return undefined;
  };

  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('qchReader.addFolder', addDocumentationLocations);
  register('qchReader.removeFolder', removeDocumentationLocations);

  register('qchReader.refresh', async () => library.reload());
  register('qchReader.selectFilter', async () => filters.pick());
  register('qchReader.createFilter', async () => filters.create());
  register('qchReader.goToKeyword', async (initial?: unknown) =>
    editor.goToKeyword(typeof initial === 'string' ? initial : ''),
  );
  register('qchReader.lookupSymbol', async () => editor.lookupSymbol());

  register('qchReader.search', async (query?: unknown) => {
    let text = typeof query === 'string' ? query : '';
    if (!text) {
      const active = vscode.window.activeTextEditor;
      text = active ? active.document.getText(active.selection).trim().slice(0, 200) : '';
    }
    await search.show(text);
  });

  register('qchReader.openUrl', async (target?: unknown, options?: unknown) => {
    let url = typeof target === 'string' ? target : nodeUrl(target);
    url ??= await vscode.window.showInputBox({
      title: 'Open qthelp:// URL',
      placeHolder: 'qthelp://org.qt-project.qtcore/qtcore/qstring.html',
      validateInput: (value) =>
        parseQtHelpUrl(value)
          ? undefined
          : 'Enter a URL of the form qthelp://namespace/folder/page.html',
    });
    if (url) {
      await panels.open(url, toOpenOptions(options));
    }
  });

  register('qchReader.openHome', async (node?: unknown) => {
    const url = nodeUrl(node);
    if (url) {
      await panels.open(url);
      return;
    }
    const document = await pickDocument('Open the start page of…');
    const home = document ? library.current.homePage(document, filters.matcher) : undefined;
    if (home) {
      await panels.open(formatQtHelpUrl(home));
    }
  });

  register('qchReader.openToSide', async (node?: unknown) => {
    const url = nodeUrl(node ?? contents.selection[0]);
    if (url) {
      await panels.open(url, { side: true, newPanel: true });
    }
  });

  register('qchReader.showDocumentInfo', async (node?: unknown) => {
    const document = isContentsNode(node)
      ? node.kind === 'document'
        ? node.document
        : node.toc.document
      : await pickDocument('Show information about…');
    if (document) {
      await panels.open(`${INFO_URL_PREFIX}${document.namespace}`);
    }
  });

  register('qchReader.searchInDocument', async (node?: unknown) => {
    const document =
      isContentsNode(node) && node.kind === 'document'
        ? node.document
        : await pickDocument('Search in…');
    if (document) {
      await search.show('', undefined, document.namespace);
    }
  });

  register('qchReader.revealQchFile', async (node?: unknown) => {
    if (isContentsNode(node) && node.kind === 'document') {
      const uri = library.uriOf(node.document);
      if (uri) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    }
  });

  register('qchReader.copyUrl', async (node?: unknown) => {
    const url = nodeUrl(node) ?? panels.commandTarget?.currentUrl;
    if (url) {
      await vscode.env.clipboard.writeText(url);
      void vscode.window.setStatusBarMessage('$(check) Link copied', 2000);
    }
  });

  register('qchReader.rebuildIndex', async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Rebuilding the documentation search index…',
      },
      async () => indexes.rebuild(),
    );
  });

  register('qchReader.syncContents', async () => {
    const url = panels.commandTarget?.currentQtHelpUrl;
    if (url && !(await contents.reveal(url, true))) {
      void vscode.window.setStatusBarMessage('This page is not listed in the contents', 3000);
    }
  });

  const viewerCommand = (
    command: string,
    action: (viewer: NonNullable<typeof panels.commandTarget>) => unknown,
  ): void => {
    register(command, () => {
      const viewer = panels.commandTarget;
      return viewer ? action(viewer) : undefined;
    });
  };
  viewerCommand('qchReader.viewer.back', async (viewer) => viewer.back());
  viewerCommand('qchReader.viewer.forward', async (viewer) => viewer.forward());
  viewerCommand('qchReader.viewer.find', (viewer) => {
    viewer.find();
  });
  viewerCommand('qchReader.viewer.zoomIn', () => {
    panels.settingsValue.setZoom(panels.settingsValue.zoom + 0.1);
  });
  viewerCommand('qchReader.viewer.zoomOut', () => {
    panels.settingsValue.setZoom(panels.settingsValue.zoom - 0.1);
  });
  viewerCommand('qchReader.viewer.zoomReset', () => {
    panels.settingsValue.setZoom(1);
  });
  viewerCommand('qchReader.viewer.toggleAppearance', async () =>
    panels.settingsValue.toggleAppearance(),
  );

  // vscode://lucio-f.qch-reader/open?url=qthelp://… and …/keyword?name=QString
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        const params = new URLSearchParams(uri.query);
        if (uri.path === '/open') {
          const url = params.get('url');
          if (url && parseQtHelpUrl(url)) {
            await panels.open(url);
          }
        } else if (uri.path === '/keyword') {
          await editor.goToKeyword(params.get('name') ?? '');
        } else if (uri.path === '/search') {
          await search.show(params.get('q') ?? '');
        }
      },
    }),
  );
}

export function deactivate(): void {
  // Everything is disposed through the extension context.
}
