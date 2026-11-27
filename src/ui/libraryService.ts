import * as vscode from 'vscode';
import type { Disposable } from './disposable';
import { QchLibrary } from '../core/library/library';
import { QchFile } from '../core/qch/qchFile';
import { KeywordIndex } from '../core/search/keywordSearch';
import { FileByteSource, MemoryByteSource } from '../core/sqlite/pageSource';
import { SECTION, expandConfiguredPath, readConfig } from './config';

interface LoadedFile {
  readonly uri: vscode.Uri;
  readonly document: QchFile;
  /** Identifies the file content: location, size and modification time. */
  readonly stamp: string;
}

const MAX_SCAN_DEPTH = 8;
const LOAD_CONCURRENCY = 6;
const RELOAD_DELAY_MS = 1500;
const CLOSE_DELAY_MS = 15_000;

function uriKey(uri: vscode.Uri): string {
  return uri.scheme === 'file' && process.platform !== 'linux'
    ? uri.fsPath.toLowerCase()
    : uri.toString();
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Discovers, loads and watches the configured .qch files. */
export class LibraryService implements vscode.Disposable {
  private library = new QchLibrary([]);
  private keywordIndex: KeywordIndex | undefined;
  private loaded = new Map<string, LoadedFile>();
  private readonly adHoc = new Map<string, vscode.Uri>();
  private readonly emitter = new vscode.EventEmitter<QchLibrary>();
  private readonly disposables: Disposable[] = [this.emitter];
  private watchers: vscode.Disposable[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private reloadRequests = 0;
  private readonly readyPromise: Promise<void>;
  private loadingState = false;

  public readonly onDidChange = this.emitter.event;

  public constructor(private readonly log: vscode.LogOutputChannel) {
    this.readyPromise = this.reload();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`${SECTION}.folders`) ||
          event.affectsConfiguration(`${SECTION}.recursive`) ||
          event.affectsConfiguration(`${SECTION}.includeWorkspaceFiles`)
        ) {
          void this.reload();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.reload();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.reload();
      }),
    );
  }

  public get current(): QchLibrary {
    return this.library;
  }

  public get loading(): boolean {
    return this.loadingState;
  }

  /** The combined keyword index of the current library (built lazily). */
  public get keywords(): KeywordIndex {
    this.keywordIndex ??= new KeywordIndex(this.library);
    return this.keywordIndex;
  }

  /** Resolves once the initial load has finished. */
  public async whenReady(): Promise<QchLibrary> {
    await this.readyPromise;
    return this.library;
  }

  public stampOf(
    document: QchFile,
  ): { readonly path: string | undefined; readonly stamp: string } | undefined {
    for (const file of this.loaded.values()) {
      if (file.document === document) {
        return {
          path: file.uri.scheme === 'file' ? file.uri.fsPath : undefined,
          stamp: file.stamp,
        };
      }
    }
    return undefined;
  }

  public uriOf(document: QchFile): vscode.Uri | undefined {
    for (const file of this.loaded.values()) {
      if (file.document === document) {
        return file.uri;
      }
    }
    return undefined;
  }

  /** Makes sure a specific .qch file (e.g. opened from the Explorer) is part of the library. */
  public async include(uri: vscode.Uri): Promise<QchFile | undefined> {
    await this.readyPromise;
    const key = uriKey(uri);
    const existing = this.loaded.get(key);
    if (existing) {
      return existing.document;
    }
    this.adHoc.set(key, uri);
    await this.reload();
    return this.loaded.get(key)?.document;
  }

  public scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), RELOAD_DELAY_MS);
  }

  /** Re-scans the configured locations. Concurrent calls are coalesced. */
  public async reload(): Promise<void> {
    this.reloadRequests++;
    if (this.running) {
      return this.running;
    }
    this.running = (async () => {
      let handled: number;
      do {
        handled = this.reloadRequests;
        await this.doReload();
      } while (handled !== this.reloadRequests);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private setLoading(loading: boolean): void {
    this.loadingState = loading;
    void vscode.commands.executeCommand('setContext', 'qchReader.loading', loading);
  }

  private async doReload(): Promise<void> {
    this.setLoading(true);
    try {
      const config = readConfig();
      const { uris, directories } = await this.discover(
        config.folders,
        config.recursive,
        config.includeWorkspaceFiles,
      );
      this.watch(directories, config.recursive, config.includeWorkspaceFiles);

      const next = new Map<string, LoadedFile>();
      const failures: string[] = [];
      await mapLimit(uris, LOAD_CONCURRENCY, async (uri) => {
        const key = uriKey(uri);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          const stamp = `${uri.toString()}|${stat.size}|${stat.mtime}`;
          const previous = this.loaded.get(key);
          if (previous?.stamp === stamp) {
            next.set(key, previous);
            return;
          }
          const source =
            uri.scheme === 'file'
              ? await FileByteSource.open(uri.fsPath)
              : new MemoryByteSource(await vscode.workspace.fs.readFile(uri));
          const location = uri.scheme === 'file' ? uri.fsPath : uri.toString();
          const document = await QchFile.open(source, location);
          next.set(key, { uri, document, stamp });
          this.log.info(
            `Loaded ${location} (${document.namespace}, ${document.files.length} files, ${document.keywords.length} keywords)`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${uri.scheme === 'file' ? uri.fsPath : uri.toString()}: ${message}`);
          this.log.warn(`Failed to load ${uri.toString()}: ${message}`);
        }
      });

      const ordered = uris
        .map((uri) => next.get(uriKey(uri)))
        .filter((f): f is LoadedFile => f !== undefined);
      const library = new QchLibrary(ordered.map((file) => file.document));
      for (const file of ordered) {
        if (!library.documents.includes(file.document)) {
          this.log.warn(
            `Skipping ${file.document.location}: namespace ${file.document.namespace} is already loaded`,
          );
        }
      }

      const stale = [...this.loaded.values()].filter((file) => ![...next.values()].includes(file));
      this.loaded = next;
      this.library = library;
      this.keywordIndex = undefined;
      // Pages may still be rendering from replaced files: close them a little later.
      setTimeout(() => {
        for (const file of stale) {
          void file.document.close();
        }
      }, CLOSE_DELAY_MS);

      void vscode.commands.executeCommand(
        'setContext',
        'qchReader.hasDocumentation',
        !library.isEmpty,
      );
      this.log.info(`Library ready: ${library.documents.length} document(s)`);
      if (failures.length > 0) {
        void vscode.window
          .showWarningMessage(`QCH Reader could not load ${failures.length} file(s).`, 'Show Log')
          .then((choice) => {
            if (choice) {
              this.log.show(true);
            }
          });
      }
      this.emitter.fire(library);
    } finally {
      this.setLoading(false);
    }
  }

  private async discover(
    folders: readonly string[],
    recursive: boolean,
    includeWorkspace: boolean,
  ): Promise<{ uris: vscode.Uri[]; directories: vscode.Uri[] }> {
    const found = new Map<string, vscode.Uri>();
    const directories: vscode.Uri[] = [];
    const add = (uri: vscode.Uri): void => {
      found.set(uriKey(uri), uri);
    };

    const walk = async (directory: vscode.Uri, depth: number): Promise<void> => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(directory);
      } catch (error) {
        this.log.warn(`Cannot read folder ${directory.fsPath}: ${String(error)}`);
        return;
      }
      await Promise.all(
        entries.map(async ([name, type]) => {
          const child = vscode.Uri.joinPath(directory, name);
          if (type & vscode.FileType.Directory) {
            if (
              recursive &&
              depth < MAX_SCAN_DEPTH &&
              !name.startsWith('.') &&
              name !== 'node_modules'
            ) {
              await walk(child, depth + 1);
            }
          } else if (name.toLowerCase().endsWith('.qch')) {
            add(child);
          }
        }),
      );
    };

    for (const configured of folders) {
      for (const fsPath of expandConfiguredPath(configured)) {
        const uri = vscode.Uri.file(fsPath);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type & vscode.FileType.Directory) {
            directories.push(uri);
            await walk(uri, 0);
          } else if (fsPath.toLowerCase().endsWith('.qch')) {
            add(uri);
          }
        } catch {
          this.log.warn(`Configured documentation path does not exist: ${fsPath}`);
        }
      }
    }

    if (includeWorkspace && (vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      for (const uri of await vscode.workspace.findFiles('**/*.qch', '**/node_modules/**', 5000)) {
        add(uri);
      }
    }
    for (const uri of this.adHoc.values()) {
      add(uri);
    }
    const uris = [...found.values()].sort((a, b) => a.toString().localeCompare(b.toString()));
    return { uris, directories };
  }

  private watch(
    directories: readonly vscode.Uri[],
    recursive: boolean,
    includeWorkspace: boolean,
  ): void {
    vscode.Disposable.from(...this.watchers).dispose();
    this.watchers = [];
    const pattern = recursive ? '**/*.qch' : '*.qch';
    const watchers = directories.map((directory) =>
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, pattern)),
    );
    if (includeWorkspace) {
      watchers.push(vscode.workspace.createFileSystemWatcher('**/*.qch'));
    }
    for (const watcher of watchers) {
      this.watchers.push(
        watcher,
        watcher.onDidCreate(() => {
          this.scheduleReload();
        }),
        watcher.onDidChange(() => {
          this.scheduleReload();
        }),
        watcher.onDidDelete(() => {
          this.scheduleReload();
        }),
      );
    }
  }

  public dispose(): void {
    clearTimeout(this.reloadTimer);
    vscode.Disposable.from(...this.watchers, ...this.disposables).dispose();
    for (const file of this.loaded.values()) {
      void file.document.close();
    }
    this.loaded.clear();
  }
}
