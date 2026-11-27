import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import type { Disposable } from './disposable';
import type { QchFile } from '../core/qch/qchFile';
import { FullTextIndex, INDEX_FORMAT_VERSION } from '../core/search/fullTextIndex';
import { buildFullTextIndex } from '../core/search/indexBuilder';
import type { IndexStatus } from '../shared/protocol';
import type { IndexWorkerRequest, IndexWorkerResponse } from '../shared/workerProtocol';
import { SECTION, readConfig } from './config';
import type { LibraryService } from './libraryService';

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** A small pool of worker threads that build indexes off the main thread. */
class WorkerPool implements vscode.Disposable {
  private readonly idle: Worker[] = [];
  private readonly all = new Set<Worker>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly script: string,
    public readonly size: number,
  ) {}

  public async run(filePath: string): Promise<Uint8Array> {
    clearTimeout(this.idleTimer);
    const worker = this.idle.pop() ?? this.spawn();
    const id = this.nextId++;
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        const onMessage = (response: IndexWorkerResponse): void => {
          if (response.id !== id) {
            return;
          }
          if (response.kind === 'done') {
            cleanup();
            resolve(response.bytes);
          } else if (response.kind === 'error') {
            cleanup();
            reject(new Error(response.message));
          }
        };
        const onError = (error: Error): void => {
          cleanup();
          this.all.delete(worker);
          reject(error);
        };
        const onExit = (code: number): void => {
          cleanup();
          this.all.delete(worker);
          reject(new Error(`Index worker exited with code ${code}`));
        };
        const cleanup = (): void => {
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        };
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
        worker.postMessage({ id, path: filePath } satisfies IndexWorkerRequest);
      });
    } finally {
      if (this.all.has(worker)) {
        this.idle.push(worker);
      }
      // Free the threads (and their memory) when indexing is over.
      this.idleTimer = setTimeout(() => {
        this.dispose();
      }, 30_000);
    }
  }

  private spawn(): Worker {
    const worker = new Worker(this.script);
    worker.unref();
    this.all.add(worker);
    return worker;
  }

  public dispose(): void {
    clearTimeout(this.idleTimer);
    for (const worker of this.all) {
      void worker.terminate();
    }
    this.all.clear();
    this.idle.length = 0;
  }
}

/** Builds, caches and serves the full-text indexes of the loaded documents. */
export class IndexService implements vscode.Disposable {
  private indexes = new Map<QchFile, FullTextIndex>();
  private readonly failed = new WeakSet<QchFile>();
  private readonly emitter = new vscode.EventEmitter<IndexStatus>();
  private readonly pool: WorkerPool;
  private readonly disposables: Disposable[];
  private building: Promise<void> | undefined;
  private generation = 0;
  private statusValue: IndexStatus = { state: 'idle', done: 0, total: 0 };

  public readonly onDidChangeStatus = this.emitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly library: LibraryService,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.pool = new WorkerPool(
      path.join(context.extensionUri.fsPath, 'dist', 'indexWorker.js'),
      Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
    );
    this.disposables = [
      this.emitter,
      this.pool,
      library.onDidChange(() => {
        this.onLibraryChanged();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${SECTION}.fullTextSearch`)) {
          this.onLibraryChanged();
        }
      }),
    ];
  }

  public get status(): IndexStatus {
    return this.statusValue;
  }

  /** Indexes that are ready, for documents of the current library. */
  public get available(): ReadonlyMap<QchFile, FullTextIndex> {
    return this.indexes;
  }

  private setStatus(status: IndexStatus): void {
    this.statusValue = status;
    this.emitter.fire(status);
  }

  private onLibraryChanged(): void {
    const documents = new Set(this.library.current.documents);
    this.indexes = new Map([...this.indexes].filter(([document]) => documents.has(document)));
    const config = readConfig();
    if (!config.fullTextEnabled) {
      this.generation++;
      this.setStatus({ state: 'disabled', done: 0, total: 0 });
      return;
    }
    this.updateIdleStatus();
    if (config.indexOnStartup) {
      void this.ensure();
    }
  }

  private updateIdleStatus(): void {
    const total = this.library.current.documents.length;
    const done = this.library.current.documents.filter((d) => this.indexes.has(d)).length;
    this.setStatus({ state: total > 0 && done === total ? 'ready' : 'idle', done, total });
  }

  /** Builds (or loads from cache) every missing index. Safe to call repeatedly. */
  public async ensure(): Promise<void> {
    if (!readConfig().fullTextEnabled) {
      return;
    }
    if (this.building) {
      return this.building;
    }
    const generation = this.generation;
    this.building = this.buildMissing(generation).finally(() => {
      this.building = undefined;
      // The library may have changed while building.
      if (
        generation !== this.generation ||
        this.library.current.documents.some((d) => !this.indexes.has(d) && !this.failed.has(d))
      ) {
        if (readConfig().fullTextEnabled && generation === this.generation) {
          void this.ensure();
        }
      }
    });
    return this.building;
  }

  /** Deletes all cached indexes and rebuilds them. */
  public async rebuild(): Promise<void> {
    this.generation++;
    await this.building?.catch(() => undefined);
    this.indexes.clear();
    try {
      await vscode.workspace.fs.delete(this.cacheDirectory, { recursive: true, useTrash: false });
    } catch {
      // Nothing cached yet.
    }
    await this.ensure();
  }

  private get cacheDirectory(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'fts');
  }

  private cacheFile(document: QchFile): vscode.Uri | undefined {
    const stamp = this.library.stampOf(document);
    if (!stamp) {
      return undefined;
    }
    const name = `${sha1(stamp.stamp.split('|')[0] ?? '').slice(0, 16)}-${sha1(`${stamp.stamp}|${INDEX_FORMAT_VERSION}`).slice(0, 12)}.idx`;
    return vscode.Uri.joinPath(this.cacheDirectory, name);
  }

  private async buildMissing(generation: number): Promise<void> {
    const documents = this.library.current.documents.filter(
      (d) => !this.indexes.has(d) && !this.failed.has(d),
    );
    if (documents.length === 0) {
      this.updateIdleStatus();
      return;
    }
    const total = this.library.current.documents.length;
    let done = total - documents.length;
    this.setStatus({ state: 'building', done, total });
    await vscode.workspace.fs.createDirectory(this.cacheDirectory);

    // Cached indexes first: they are cheap to load and make search usable quickly.
    const toBuild: QchFile[] = [];
    for (const document of documents) {
      const cached = await this.loadCached(document);
      if (generation !== this.generation) {
        return;
      }
      if (cached) {
        this.indexes.set(document, cached);
        this.setStatus({ state: 'building', done: ++done, total });
      } else {
        toBuild.push(document);
      }
    }

    if (toBuild.length > 0) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Indexing documentation' },
        async (progress) => {
          let next = 0;
          const runOne = async (): Promise<void> => {
            while (next < toBuild.length && generation === this.generation) {
              const document = toBuild[next++];
              if (!document) {
                break;
              }
              progress.report({ message: document.title });
              try {
                const index = await this.build(document);
                if (generation !== this.generation) {
                  return;
                }
                this.indexes.set(document, index);
              } catch (error) {
                this.failed.add(document);
                this.log.error(`Indexing ${document.location} failed: ${String(error)}`);
              }
              this.setStatus({ state: 'building', done: ++done, total });
            }
          };
          await Promise.all(Array.from({ length: this.pool.size }, runOne));
        },
      );
    }
    if (generation === this.generation) {
      this.updateIdleStatus();
      void this.pruneCache();
    }
  }

  private async loadCached(document: QchFile): Promise<FullTextIndex | undefined> {
    const file = this.cacheFile(document);
    if (!file) {
      return undefined;
    }
    try {
      return FullTextIndex.deserialize(await vscode.workspace.fs.readFile(file));
    } catch {
      return undefined;
    }
  }

  private async build(document: QchFile): Promise<FullTextIndex> {
    const started = Date.now();
    const stamp = this.library.stampOf(document);
    let bytes: Uint8Array;
    if (stamp?.path) {
      try {
        bytes = await this.pool.run(stamp.path);
      } catch (error) {
        this.log.warn(
          `Worker indexing failed for ${document.location}, retrying in-process: ${String(error)}`,
        );
        bytes = (await buildFullTextIndex(document, undefined, true)).serialize();
      }
    } else {
      bytes = (await buildFullTextIndex(document, undefined, true)).serialize();
    }
    const index = FullTextIndex.deserialize(bytes);
    if (!index) {
      throw new Error('The index produced by the worker is invalid');
    }
    const file = this.cacheFile(document);
    if (file) {
      await vscode.workspace.fs.writeFile(file, bytes);
    }
    this.log.info(
      `Indexed ${document.location}: ${index.documentCount} pages, ${index.terms.length} terms in ${Date.now() - started} ms`,
    );
    return index;
  }

  /** Removes cache files that no longer belong to a loaded document. */
  private async pruneCache(): Promise<void> {
    try {
      const keep = new Set(
        this.library.current.documents
          .map((d) => this.cacheFile(d)?.path.split('/').pop())
          .filter(Boolean),
      );
      const entries = await vscode.workspace.fs.readDirectory(this.cacheDirectory);
      const prefixes = new Set([...keep].map((name) => name?.split('-')[0]));
      await Promise.all(
        entries
          .filter(
            ([name]) =>
              name.endsWith('.idx') && !keep.has(name) && prefixes.has(name.split('-')[0]),
          )
          .map(async ([name]) =>
            vscode.workspace.fs.delete(vscode.Uri.joinPath(this.cacheDirectory, name)),
          ),
      );
    } catch (error) {
      this.log.debug(`Cache pruning skipped: ${String(error)}`);
    }
  }

  public dispose(): void {
    this.generation++;
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
