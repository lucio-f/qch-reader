// A small in-memory implementation of the parts of the `vscode` API used by the extension,
// so that activation and the main user flows can be exercised without launching VS Code.
// Vitest aliases the `vscode` module to this file (see vitest.config.mts).
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Listener<T> = (value: T) => unknown;

export class Disposable {
  public constructor(private readonly callback?: () => unknown) {}

  public static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const item of items) {
        item.dispose();
      }
    });
  }

  public dispose(): void {
    this.callback?.();
  }
}

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];

  public readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  };

  public fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  public dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly path: string,
    public readonly query = '',
  ) {}

  public get fsPath(): string {
    return this.path;
  }

  public static file(fsPath: string): Uri {
    return new Uri('file', path.resolve(fsPath));
  }

  public static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, path.join(base.path, ...segments));
  }

  public static parse(value: string): Uri {
    if (value.startsWith('file://')) {
      return Uri.file(fileURLToPath(value));
    }
    const match = /^([a-z][\w+.-]*):(.*)$/i.exec(value);
    const [, scheme = 'file', rest = value] = match ?? [];
    const [pathPart = '', query = ''] = rest.split('?');
    return new Uri(scheme, pathPart, query);
  }

  public toString(): string {
    return this.scheme === 'file'
      ? pathToFileURL(this.path).toString()
      : `${this.scheme}:${this.path}`;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
}
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export class ThemeIcon {
  public constructor(public readonly id: string) {}
}

export class TreeItem {
  public id?: string;
  public description?: string;
  public tooltip?: unknown;
  public iconPath?: unknown;
  public contextValue?: string;
  public command?: { command: string; title: string; arguments?: unknown[] };
  public constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class MarkdownString {
  public isTrusted: unknown;
  public constructor(
    public value = '',
    public supportThemeIcons = false,
  ) {}

  public appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }

  public appendText(text: string): this {
    this.value += text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
    return this;
  }

  public appendCodeblock(code: string, language = ''): this {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

export class Position {
  public constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}

  public translate(lineDelta: number, characterDelta: number): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
}

export class Range {
  public constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class Selection extends Range {
  public get active(): Position {
    return this.end;
  }
}

export class Hover {
  public constructor(
    public readonly contents: MarkdownString,
    public readonly range?: Range,
  ) {}
}

export class DocumentLink {
  public tooltip?: string;
  public constructor(
    public readonly range: Range,
    public readonly target?: Uri,
  ) {}
}

export class RelativePattern {
  public constructor(
    public readonly base: unknown,
    public readonly pattern: string,
  ) {}
}

// ---------------------------------------------------------------------------------------------
// State inspected by tests
// ---------------------------------------------------------------------------------------------

export const state = {
  configuration: new Map<string, unknown>(),
  contexts: new Map<string, unknown>(),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  treeProviders: new Map<string, unknown>(),
  webviewViewProviders: new Map<string, unknown>(),
  hoverProviders: [] as { provideHover: (...args: unknown[]) => unknown }[],
  linkProviders: [] as { provideDocumentLinks: (...args: unknown[]) => unknown }[],
  panels: [] as FakePanel[],
  messages: [] as string[],
  clipboard: '',
  logs: [] as string[],
  activeTextEditor: undefined as unknown,
};

const configurationEmitter = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();

export class FakeWebview {
  public options: unknown = {};
  public html = '';
  public readonly cspSource = 'vscode-webview:';
  public readonly posted: { type: string; [key: string]: unknown }[] = [];
  private readonly receiveEmitter = new EventEmitter<unknown>();
  public readonly onDidReceiveMessage = this.receiveEmitter.event;

  public asWebviewUri(uri: Uri): Uri {
    return uri;
  }

  public async postMessage(message: { type: string }): Promise<boolean> {
    this.posted.push(message);
    return Promise.resolve(true);
  }

  /** Simulates a message sent by the webview script. */
  public receive(message: unknown): void {
    this.receiveEmitter.fire(message);
  }
}

export class FakePanel {
  public readonly webview = new FakeWebview();
  public iconPath: unknown;
  public active = true;
  public visible = true;
  public viewColumn = ViewColumn.One;
  private readonly disposeEmitter = new EventEmitter<undefined>();
  private readonly viewStateEmitter = new EventEmitter<unknown>();
  public readonly onDidDispose = this.disposeEmitter.event;
  public readonly onDidChangeViewState = this.viewStateEmitter.event;

  public constructor(
    public readonly viewType: string,
    public title: string,
  ) {}

  public reveal(): void {
    this.active = true;
  }

  public dispose(): void {
    this.disposeEmitter.fire(undefined);
  }
}

const noopEvent = (): Disposable => new Disposable();

export const window = {
  createOutputChannel: () => ({
    info: (message: string) => state.logs.push(`info ${message}`),
    warn: (message: string) => state.logs.push(`warn ${message}`),
    error: (message: string) => state.logs.push(`error ${message}`),
    debug: (message: string) => state.logs.push(`debug ${message}`),
    show: () => undefined,
    dispose: () => undefined,
  }),
  createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
    state.treeProviders.set(id, options.treeDataProvider);
    return {
      description: '',
      selection: [],
      reveal: async () => Promise.resolve(),
      dispose: () => undefined,
    };
  },
  createStatusBarItem: () => ({
    text: '',
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  registerWebviewViewProvider: (id: string, provider: unknown) => {
    state.webviewViewProviders.set(id, provider);
    return new Disposable();
  },
  registerWebviewPanelSerializer: () => new Disposable(),
  registerCustomEditorProvider: () => new Disposable(),
  registerUriHandler: () => new Disposable(),
  createWebviewPanel: (viewType: string, title: string) => {
    const panel = new FakePanel(viewType, title);
    state.panels.push(panel);
    return panel;
  },
  showInformationMessage: async (message: string) => {
    state.messages.push(message);
    return Promise.resolve(undefined);
  },
  showWarningMessage: async (message: string) => {
    state.messages.push(message);
    return Promise.resolve(undefined);
  },
  showErrorMessage: async (message: string) => {
    state.messages.push(message);
    return Promise.resolve(undefined);
  },
  setStatusBarMessage: () => new Disposable(),
  withProgress: async <T>(_options: unknown, task: (progress: { report(): void }) => Promise<T>) =>
    task({ report: () => undefined }),
  showQuickPick: async () => Promise.resolve(undefined),
  showInputBox: async () => Promise.resolve(undefined),
  showOpenDialog: async () => Promise.resolve(undefined),
  get activeTextEditor(): unknown {
    return state.activeTextEditor;
  },
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: (section: string) => ({
    get: <T>(key: string, fallback?: T): T | undefined =>
      (state.configuration.get(`${section}.${key}`) as T | undefined) ?? fallback,
    inspect: (key: string) => ({ globalValue: state.configuration.get(`${section}.${key}`) }),
    update: async (key: string, value: unknown) => {
      state.configuration.set(`${section}.${key}`, value);
      configurationEmitter.fire({
        affectsConfiguration: (name) => `${section}.${key}`.startsWith(name),
      });
      return Promise.resolve();
    },
  }),
  onDidChangeConfiguration: configurationEmitter.event,
  onDidChangeWorkspaceFolders: noopEvent,
  onDidGrantWorkspaceTrust: noopEvent,
  findFiles: async () => Promise.resolve([]),
  createFileSystemWatcher: () => ({
    onDidCreate: noopEvent,
    onDidChange: noopEvent,
    onDidDelete: noopEvent,
    dispose: () => undefined,
  }),
  fs: {
    stat: async (uri: Uri) => {
      const info = await stat(uri.fsPath);
      return {
        type: info.isDirectory() ? FileType.Directory : FileType.File,
        size: info.size,
        mtime: info.mtimeMs,
        ctime: info.ctimeMs,
      };
    },
    readDirectory: async (uri: Uri) =>
      (await readdir(uri.fsPath, { withFileTypes: true })).map((entry) => [
        entry.name,
        entry.isDirectory() ? FileType.Directory : FileType.File,
      ]),
    readFile: async (uri: Uri) => new Uint8Array(await readFile(uri.fsPath)),
    writeFile: async (uri: Uri, data: Uint8Array) => {
      await writeFile(uri.fsPath, data);
    },
    createDirectory: async (uri: Uri) => {
      await mkdir(uri.fsPath, { recursive: true });
    },
    delete: async (uri: Uri) => {
      await rm(uri.fsPath, { recursive: true, force: true });
    },
  },
};

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
    state.commands.set(id, handler);
    return new Disposable(() => state.commands.delete(id));
  },
  executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
    if (id === 'setContext') {
      state.contexts.set(String(args[0]), args[1]);
      return undefined;
    }
    return state.commands.get(id)?.(...args);
  },
};

export const languages = {
  registerHoverProvider: (
    _selector: unknown,
    provider: { provideHover: (...args: unknown[]) => unknown },
  ) => {
    state.hoverProviders.push(provider);
    return new Disposable(() => {
      state.hoverProviders = state.hoverProviders.filter((p) => p !== provider);
    });
  },
  registerDocumentLinkProvider: (
    _selector: unknown,
    provider: { provideDocumentLinks: (...args: unknown[]) => unknown },
  ) => {
    state.linkProviders.push(provider);
    return new Disposable(() => {
      state.linkProviders = state.linkProviders.filter((p) => p !== provider);
    });
  },
};

export const env = {
  clipboard: {
    writeText: async (text: string) => {
      state.clipboard = text;
      return Promise.resolve();
    },
  },
  openExternal: async () => Promise.resolve(true),
};

/** A minimal TextDocument over a string. */
export function textDocument(text: string, languageId = 'cpp'): unknown {
  const lines = text.split('\n');
  const offsetAt = (position: Position): number =>
    lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) +
    position.character;
  const positionAt = (offset: number): Position => {
    let remaining = offset;
    for (let line = 0; line < lines.length; line++) {
      const length = (lines[line] ?? '').length + 1;
      if (remaining < length) {
        return new Position(line, remaining);
      }
      remaining -= length;
    }
    return new Position(lines.length - 1, (lines.at(-1) ?? '').length);
  };
  return {
    languageId,
    getText: (range?: Range) =>
      range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
    positionAt,
    getWordRangeAtPosition: (position: Position, pattern: RegExp) => {
      const line = lines[position.line] ?? '';
      const global = new RegExp(pattern.source, 'g');
      for (const match of line.matchAll(global)) {
        if (
          match.index <= position.character &&
          position.character <= match.index + match[0].length
        ) {
          return new Range(
            new Position(position.line, match.index),
            new Position(position.line, match.index + match[0].length),
          );
        }
      }
      return undefined;
    },
  };
}
