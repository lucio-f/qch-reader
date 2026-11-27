// Activates the real extension against the in-memory VS Code API of vscode-mock.ts and drives
// the main user flows: loading, contents, viewer navigation, search, hovers, links and
// context help.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import type { DocViewToWebview, SearchViewToWebview } from '../src/shared/protocol';
import { FIXTURES } from './helpers';
import * as mock from './vscode-mock';

const root = path.resolve(FIXTURES, '..', '..');

async function until(condition: () => boolean, timeout = 20_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function memento(): {
  get: (key: string) => unknown;
  update: (key: string, value: unknown) => Promise<void>;
} {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    update: async (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

interface TreeProvider {
  getChildren(element?: unknown): unknown[];
  getTreeItem(element: unknown): mock.TreeItem;
  getParent(element: unknown): unknown;
}

function lastOf<T extends { type: string }, K extends T['type']>(
  messages: readonly T[],
  type: K,
): Extract<T, { type: K }> | undefined {
  return messages.filter((m): m is Extract<T, { type: K }> => m.type === type).at(-1);
}

describe('extension with a mocked VS Code', () => {
  const subscriptions: { dispose(): unknown }[] = [];

  beforeAll(async () => {
    mock.state.configuration.set('qchReader.folders', [FIXTURES]);
    activate({
      subscriptions,
      extensionUri: mock.Uri.file(root),
      globalStorageUri: mock.Uri.file(mkdtempSync(path.join(tmpdir(), 'qch-storage-'))),
      workspaceState: memento(),
      globalState: memento(),
    } as never);
    await until(() => mock.state.contexts.get('qchReader.hasDocumentation') === true);
  });

  afterAll(() => {
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  });

  it('registers every contributed command', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      contributes: { commands: { command: string }[] };
    };
    const contributed = manifest.contributes.commands.map((c) => c.command).sort();
    expect(
      [...mock.state.commands.keys()].filter((id) => id.startsWith('qchReader.')).sort(),
    ).toEqual(contributed);
    expect(mock.state.contexts.get('qchReader.loading')).toBe(false);
  });

  it('lists documents and their contents', () => {
    const tree = mock.state.treeProviders.get('qchReader.contents') as TreeProvider;
    const documents = tree.getChildren();
    expect(documents.map((d) => tree.getTreeItem(d).label)).toEqual(['Alpha Manual', 'Beta']);
    const [alpha, beta] = documents;
    expect(tree.getTreeItem(alpha).description).toBe('1.0.0');
    // Alpha has two contents sections; Beta's single root is flattened.
    expect(tree.getChildren(alpha).map((n) => tree.getTreeItem(n).label)).toEqual([
      'Alpha Manual',
      'Extra Section',
    ]);
    const betaChildren = tree.getChildren(beta);
    expect(betaChildren.map((n) => tree.getTreeItem(n).label)).toEqual(['Introduction', 'Guide']);
    expect(tree.getParent(betaChildren[0])).toBe(beta);
    const item = tree.getTreeItem(betaChildren[1]);
    expect(item.command?.arguments?.[0]).toBe('qthelp://org.example.beta.200/beta/guide.html');
  });

  it('opens pages, follows cross-links and keeps history', async () => {
    await mock.commands.executeCommand(
      'qchReader.openUrl',
      'qthelp://org.example.alpha.100/alpha/widget.html',
    );
    const panel = mock.state.panels.at(-1)!;
    expect(panel.viewType).toBe('qchReader.docView');
    expect(panel.webview.html).toContain("script-src 'nonce-");
    const posted = panel.webview.posted as DocViewToWebview[];

    panel.webview.receive({ type: 'ready' });
    await until(() => posted.some((m) => m.type === 'page'));
    const first = lastOf(posted, 'page')!;
    expect(first.title).toBe('Widget Class');
    expect(panel.title).toBe('Widget Class');
    expect(first.html).toContain('id="paint"');
    expect(first.breadcrumbs.map((b) => b.title)).toEqual(['Alpha Manual', 'API Reference']);

    // A relative cross-module link resolves into the Beta namespace.
    panel.webview.receive({
      type: 'navigate',
      href: 'qthelp://org.example.alpha.100/beta/beta-index.html#intro',
      newTab: false,
      side: false,
    });
    await until(() => lastOf(posted, 'page')?.title === 'Beta Home');
    const second = lastOf(posted, 'page')!;
    expect(second.url).toBe('qthelp://org.example.beta.200/beta/beta-index.html#intro');
    expect(second.fragment).toBe('intro');
    expect(second.navigation).toEqual({ canGoBack: true, canGoForward: false });

    panel.webview.receive({ type: 'back' });
    await until(
      () => lastOf(posted, 'page')?.title === 'Widget Class' && posted.at(-1)?.type === 'page',
    );
    expect(lastOf(posted, 'page')?.navigation).toEqual({ canGoBack: false, canGoForward: true });

    // In-page anchors are recorded without re-rendering.
    const pages = posted.filter((m) => m.type === 'page').length;
    panel.webview.receive({ type: 'fragment', fragment: 'resize' });
    await until(() => lastOf(posted, 'navigation')?.url.endsWith('#resize') === true);
    expect(posted.filter((m) => m.type === 'page')).toHaveLength(pages);

    panel.webview.receive({ type: 'copyUrl', href: undefined });
    await until(() => mock.state.clipboard !== '');
    expect(mock.state.clipboard).toBe('qthelp://org.example.alpha.100/alpha/widget.html#resize');

    panel.webview.receive({
      type: 'navigate',
      href: 'qthelp://org.example.alpha.100/alpha/missing.html',
      newTab: false,
      side: false,
    });
    await until(() => posted.at(-1)?.type === 'notFound');
  });

  it('shows document information', async () => {
    const tree = mock.state.treeProviders.get('qchReader.contents') as TreeProvider;
    const [alpha] = tree.getChildren();
    await mock.commands.executeCommand('qchReader.showDocumentInfo', alpha);
    const posted = mock.state.panels.at(-1)!.webview.posted as DocViewToWebview[];
    await until(() => lastOf(posted, 'page')?.url === 'qch-info:org.example.alpha.100');
    expect(lastOf(posted, 'page')?.html).toContain('org.example.alpha.100');
  });

  it('searches the keyword index and the full text', async () => {
    const provider = mock.state.webviewViewProviders.get('qchReader.search') as {
      resolveWebviewView(view: unknown): void;
    };
    const webview = new mock.FakeWebview();
    provider.resolveWebviewView({ webview, onDidDispose: () => new mock.Disposable() });
    expect(webview.html).toContain('searchView.js');
    webview.receive({ type: 'ready' });
    const posted = webview.posted as SearchViewToWebview[];
    await until(() => lastOf(posted, 'state')?.index.state === 'ready');
    expect(lastOf(posted, 'state')?.documents.map((d) => d.title)).toEqual([
      'Alpha Manual',
      'Beta',
    ]);

    webview.receive({
      type: 'search',
      requestId: 1,
      query: 'paint',
      mode: 'index',
      scope: '',
      offset: 0,
    });
    await until(() => lastOf(posted, 'results')?.requestId === 1);
    const index = lastOf(posted, 'results')!;
    expect(index.total).toBe(3);
    expect(index.items.map((i) => i.subtitle)).toEqual([
      'Beta::paint',
      'Gadget::paint',
      'Widget::paint',
    ]);
    expect(index.items[0]?.title).toEqual([{ text: 'paint', match: true }]);

    webview.receive({
      type: 'search',
      requestId: 2,
      query: 'zeppelin',
      mode: 'fulltext',
      scope: '',
      offset: 0,
    });
    await until(() => lastOf(posted, 'results')?.requestId === 2);
    const fullText = lastOf(posted, 'results')!;
    expect(fullText.items.map((i) => i.detail).sort()).toEqual(['beta-index.html', 'big.html']);
    expect(
      fullText.items[0]?.snippet?.some((s) => s.match && s.text.toLowerCase() === 'zeppelin'),
    ).toBe(true);
    expect(fullText.highlights).toEqual([{ term: 'zeppelin', prefix: false }]);

    webview.receive({
      type: 'search',
      requestId: 3,
      query: 'zeppelin',
      mode: 'fulltext',
      scope: 'org.example.beta.200',
      offset: 0,
    });
    await until(() => lastOf(posted, 'results')?.requestId === 3);
    expect(lastOf(posted, 'results')?.items.map((i) => i.detail)).toEqual(['beta-index.html']);
  });

  it('provides hovers, qthelp links and context help', async () => {
    const document = mock.textDocument(
      'void f() { Widget::paint(p); }\n// see qthelp://org.example.beta.200/beta/guide.html.',
    );
    const [hoverProvider] = mock.state.hoverProviders;
    const hover = (await hoverProvider?.provideHover(document, new mock.Position(0, 22), {
      isCancellationRequested: false,
    })) as mock.Hover | undefined;
    expect(hover?.contents.value).toContain('void Widget::paint(Painter *painter)');
    expect(hover?.contents.value).toContain('command:qchReader.openUrl');
    const plain = await hoverProvider?.provideHover(document, new mock.Position(0, 6), {
      isCancellationRequested: false,
    });
    expect(plain).toBeUndefined();

    const [linkProvider] = mock.state.linkProviders;
    const links = (await linkProvider?.provideDocumentLinks(document)) as mock.DocumentLink[];
    expect(links).toHaveLength(1);
    expect(decodeURIComponent(links[0]?.target?.query ?? '')).toBe(
      '["qthelp://org.example.beta.200/beta/guide.html"]',
    );

    const cursor = new mock.Position(0, 22);
    mock.state.activeTextEditor = { document, selection: new mock.Selection(cursor, cursor) };
    await mock.commands.executeCommand('qchReader.lookupSymbol');
    const posted = mock.state.panels.at(-1)!.webview.posted as DocViewToWebview[];
    await until(
      () =>
        lastOf(posted, 'navigation')?.url.endsWith('widget.html#paint') === true ||
        lastOf(posted, 'page')?.url.endsWith('widget.html#paint') === true,
    );
  });

  describe('documentation locations in settings', () => {
    const tree = (): TreeProvider =>
      mock.state.treeProviders.get('qchReader.contents') as TreeProvider;
    const reload = async (): Promise<string[]> => {
      await mock.commands.executeCommand('qchReader.refresh');
      return tree()
        .getChildren()
        .map((node) => tree().getTreeItem(node).label);
    };
    const singleFolder = (): void => {
      mock.state.workspaceFile = undefined;
      mock.state.workspaceFolders = [{ uri: mock.Uri.file(root), name: 'qch-reader', index: 0 }];
    };

    afterAll(() => {
      mock.state.workspaceFolders = undefined;
      mock.state.workspaceFile = undefined;
      mock.state.isTrusted = true;
    });

    it('loads paths committed in workspace settings, relative to the workspace', async () => {
      singleFolder();
      mock.state.configuration.set('qchReader.folders', []);
      mock.state.workspaceConfiguration.set('qchReader.folders', ['test/fixtures']);
      expect(await reload()).toEqual(['Alpha Manual', 'Beta']);
    });

    it('ignores workspace settings until the workspace is trusted', async () => {
      mock.state.isTrusted = false;
      mock.state.messages.length = 0;
      expect(await reload()).toEqual([]);
      expect(mock.state.messages.join('\n')).toContain('once you trust this workspace');
      mock.state.isTrusted = true;
      expect(await reload()).toEqual(['Alpha Manual', 'Beta']);
    });

    it('combines user and workspace locations', async () => {
      mock.state.configuration.set('qchReader.folders', [path.join(FIXTURES, 'beta.qch')]);
      mock.state.workspaceConfiguration.set('qchReader.folders', ['test/fixtures/alpha.qch']);
      expect(await reload()).toEqual(['Alpha Manual', 'Beta']);
      mock.state.configuration.set('qchReader.folders', []);
      expect(await reload()).toEqual(['Alpha Manual']);
    });

    it('reads folder settings and named folders in multi-root workspaces', async () => {
      mock.state.workspaceFile = mock.Uri.file(path.join(root, 'project.code-workspace'));
      mock.state.workspaceFolders = [
        { uri: mock.Uri.file(root), name: 'repo', index: 0 },
        { uri: mock.Uri.file(FIXTURES), name: 'fixtures', index: 1 },
      ];
      mock.state.workspaceConfiguration.set('qchReader.folders', [
        '${workspaceFolder:fixtures}/alpha.qch',
      ]);
      mock.state.folderConfiguration.set(
        mock.Uri.file(FIXTURES).fsPath,
        new Map([['qchReader.folders', ['beta.qch']]]),
      );
      expect(await reload()).toEqual(['Alpha Manual', 'Beta']);
      mock.state.folderConfiguration.clear();
      expect(await reload()).toEqual(['Alpha Manual']);
    });

    it('adds folders to the chosen settings file as portable paths', async () => {
      singleFolder();
      mock.state.workspaceConfiguration.delete('qchReader.folders');
      mock.state.openDialogAnswer = [mock.Uri.file(FIXTURES)];
      mock.state.quickPickAnswer = (items) =>
        items.find((item) => item.label.includes('Workspace Settings'));
      await mock.commands.executeCommand('qchReader.addFolder');
      expect(mock.state.workspaceConfiguration.get('qchReader.folders')).toEqual(['test/fixtures']);
      expect(await reload()).toEqual(['Alpha Manual', 'Beta']);

      // In a multi-root workspace the folder containing the selection is offered first.
      mock.state.workspaceFile = mock.Uri.file(path.join(root, 'project.code-workspace'));
      mock.state.workspaceFolders = [
        { uri: mock.Uri.file(root), name: 'repo', index: 0 },
        { uri: mock.Uri.file(FIXTURES), name: 'fixtures', index: 1 },
      ];
      mock.state.openDialogAnswer = [mock.Uri.file(path.join(FIXTURES, 'beta.qch'))];
      mock.state.quickPickAnswer = (items) => items[0];
      await mock.commands.executeCommand('qchReader.addFolder');
      expect(
        mock.state.folderConfiguration
          .get(mock.Uri.file(FIXTURES).fsPath)
          ?.get('qchReader.folders'),
      ).toEqual(['beta.qch']);
    });

    it('removes locations from any settings file', async () => {
      singleFolder();
      mock.state.quickPickAnswer = (items) =>
        items.filter((item) => item.label === 'test/fixtures');
      await mock.commands.executeCommand('qchReader.removeFolder');
      expect(mock.state.workspaceConfiguration.get('qchReader.folders')).toEqual([]);
      expect(await reload()).toEqual([]);
      mock.state.quickPickAnswer = undefined;
      mock.state.openDialogAnswer = undefined;
    });
  });
});
