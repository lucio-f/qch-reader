import {
  type QchFile,
  type QchFileEntry,
  type QchKeyword,
  type TocItem,
  isHtmlPath,
} from '../qch/qchFile';
import { LruCache } from '../util/lru';
import { ALL_MATCHER, type FilterMatcher, compareVersions } from './filters';
import {
  type QtHelpUrl,
  makeQtHelpUrl,
  pageKey,
  splitVirtualFolder,
  withFragment,
} from './qthelpUrl';

export interface ResolvedPage {
  readonly document: QchFile;
  readonly entry: QchFileEntry;
  /** Canonical URL of the resolved file (namespace may differ from the requested one). */
  readonly url: QtHelpUrl;
}

export interface TocNode {
  readonly id: string;
  readonly title: string;
  readonly url: QtHelpUrl | undefined;
  readonly children: readonly TocNode[];
  readonly parent: TocNode | undefined;
  readonly document: QchFile;
}

interface TocIndex {
  readonly roots: readonly TocNode[];
  readonly byPage: ReadonlyMap<string, readonly TocNode[]>;
}

const FILE_CACHE_BYTES = 48 * 1024 * 1024;

/** Detects the character set declared in an HTML document's `<meta>` tags. */
export function detectCharset(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const match = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return match?.[1]?.toLowerCase() ?? 'utf-8';
}

export function decodeHtml(bytes: Uint8Array): string {
  const charset = detectCharset(bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** A set of loaded .qch documents with cross-document URL resolution. */
export class QchLibrary {
  public readonly documents: readonly QchFile[];
  private readonly byNamespace = new Map<string, QchFile>();
  private readonly byLowerNamespace = new Map<string, QchFile>();
  private readonly byFolder = new Map<string, QchFile[]>();
  private readonly fileCache = new LruCache<string, Uint8Array>(
    FILE_CACHE_BYTES,
    (data) => data.byteLength,
  );
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  private readonly tocCache = new WeakMap<QchFile, Map<string, TocIndex>>();

  public constructor(documents: readonly QchFile[]) {
    const unique: QchFile[] = [];
    for (const document of documents) {
      if (this.byNamespace.has(document.namespace)) {
        continue;
      }
      unique.push(document);
      this.byNamespace.set(document.namespace, document);
      this.byLowerNamespace.set(document.namespace.toLowerCase(), document);
      for (const folder of document.folders) {
        const list = this.byFolder.get(folder.toLowerCase());
        if (list) {
          list.push(document);
        } else {
          this.byFolder.set(folder.toLowerCase(), [document]);
        }
      }
    }
    this.documents = unique.sort(
      (a, b) => a.title.localeCompare(b.title) || compareVersions(b.version, a.version),
    );
  }

  public get isEmpty(): boolean {
    return this.documents.length === 0;
  }

  public getDocument(namespace: string): QchFile | undefined {
    return this.byNamespace.get(namespace) ?? this.byLowerNamespace.get(namespace.toLowerCase());
  }

  public urlForFile(document: QchFile, entry: QchFileEntry, fragment = ''): QtHelpUrl {
    return makeQtHelpUrl(
      document.namespace,
      entry.folder,
      entry.path + (fragment ? `#${fragment}` : ''),
    );
  }

  public urlForKeyword(document: QchFile, keyword: QchKeyword): QtHelpUrl | undefined {
    const entry = document.getFile(keyword.fileId);
    return entry ? this.urlForFile(document, entry, keyword.anchor) : undefined;
  }

  /**
   * Resolves a URL to a stored file. Mirrors Qt Assistant: when the file is not in the
   * requested namespace, other namespaces exposing the same virtual folder are searched
   * (this is how cross-module links such as `../qtgui/qwindow.html` work).
   */
  public resolve(url: QtHelpUrl, matcher: FilterMatcher = ALL_MATCHER): ResolvedPage | undefined {
    const [folder, path] = splitVirtualFolder(url.path);
    const origin = this.getDocument(url.namespace);
    const found = (document: QchFile, entry: QchFileEntry): ResolvedPage => ({
      document,
      entry,
      url: this.urlForFile(document, entry, url.fragment),
    });

    if (origin) {
      const entry = origin.findFile(folder, path);
      if (entry) {
        return found(origin, entry);
      }
      if (!origin.folders.some((f) => f.toLowerCase() === folder.toLowerCase())) {
        // Some generators omit the virtual folder in links: try the path as-is.
        const direct = origin.findFile(origin.component, url.path);
        if (direct) {
          return found(origin, direct);
        }
      }
    }

    const candidates = [...(this.byFolder.get(folder.toLowerCase()) ?? [])]
      .filter((document) => document !== origin)
      .sort((a, b) => {
        const filtered = Number(matcher.matchesDocument(b)) - Number(matcher.matchesDocument(a));
        if (filtered !== 0) {
          return filtered;
        }
        if (origin) {
          const sameVersion =
            Number(b.version === origin.version) - Number(a.version === origin.version);
          if (sameVersion !== 0) {
            return sameVersion;
          }
        }
        return compareVersions(b.version, a.version);
      });
    for (const document of candidates) {
      const entry = document.findFile(folder, path);
      if (entry) {
        return found(document, entry);
      }
    }
    return undefined;
  }

  /** The start page of a document: its first table-of-contents entry, or `index.html`. */
  public homePage(document: QchFile, matcher: FilterMatcher = ALL_MATCHER): QtHelpUrl | undefined {
    for (const node of this.getToc(document, matcher)) {
      if (node.url) {
        return node.url;
      }
    }
    const index =
      document.findFile(document.component, 'index.html') ??
      document.files.find((file) => isHtmlPath(file.path));
    return index ? this.urlForFile(document, index) : undefined;
  }

  /** Reads a file's decompressed content, with an LRU cache. */
  public async readFile(page: ResolvedPage): Promise<Uint8Array> {
    const key = pageKey(withFragment(page.url, ''));
    const cached = this.fileCache.get(key);
    if (cached) {
      return cached;
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = page.document.readFileData(page.entry.fileId).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, pending);
    }
    const data = await pending;
    this.fileCache.set(key, data);
    return data;
  }

  public async readText(page: ResolvedPage): Promise<string> {
    return decodeHtml(await this.readFile(page));
  }

  /** Table of contents of a document, restricted to the sections matching the filter. */
  public getToc(document: QchFile, matcher: FilterMatcher = ALL_MATCHER): readonly TocNode[] {
    return this.getTocIndex(document, matcher).roots;
  }

  /** Finds the table-of-contents nodes pointing at a page, best match first. */
  public findTocNodes(url: QtHelpUrl, matcher: FilterMatcher = ALL_MATCHER): readonly TocNode[] {
    const document = this.getDocument(url.namespace);
    if (!document) {
      return [];
    }
    const nodes = this.getTocIndex(document, matcher).byPage.get(pageKey(withFragment(url, '')));
    if (!nodes) {
      return [];
    }
    return [...nodes].sort(
      (a, b) =>
        Number(b.url?.fragment === url.fragment) - Number(a.url?.fragment === url.fragment) ||
        Number(!a.url?.fragment) - Number(!b.url?.fragment),
    );
  }

  private getTocIndex(document: QchFile, matcher: FilterMatcher): TocIndex {
    let perFilter = this.tocCache.get(document);
    if (!perFilter) {
      perFilter = new Map();
      this.tocCache.set(document, perFilter);
    }
    const cached = perFilter.get(matcher.filter.id);
    if (cached) {
      return cached;
    }
    const byPage = new Map<string, TocNode[]>();
    const folder = document.component;
    const build = (
      items: readonly TocItem[],
      parent: TocNode | undefined,
      idPrefix: string,
    ): TocNode[] =>
      items.map((item, index) => {
        const url = item.ref ? makeQtHelpUrl(document.namespace, folder, item.ref) : undefined;
        const node: { -readonly [K in keyof TocNode]: TocNode[K] } = {
          id: `${idPrefix}.${index}`,
          title: item.title || item.ref,
          url,
          children: [],
          parent,
          document,
        };
        node.children = build(item.children, node, node.id);
        if (url) {
          const key = pageKey(withFragment(url, ''));
          const list = byPage.get(key);
          if (list) {
            list.push(node);
          } else {
            byPage.set(key, [node]);
          }
        }
        return node;
      });

    const roots: TocNode[] = [];
    document.contents.forEach((section, sectionIndex) => {
      if (matcher.matchesItem(section.attributes)) {
        roots.push(...build(section.items, undefined, `${document.namespace}:${sectionIndex}`));
      }
    });
    const index: TocIndex = { roots, byPage };
    perFilter.set(matcher.filter.id, index);
    return index;
  }

  public async close(): Promise<void> {
    this.fileCache.clear();
    await Promise.allSettled(this.documents.map(async (document) => document.close()));
  }
}
