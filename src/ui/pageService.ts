import { escapeHtml } from '../core/html/entities';
import { preparePage } from '../core/html/rewrite';
import { extractText } from '../core/html/text';
import { decodeHtml } from '../core/library/library';
import { isImagePath, mimeTypeForPath, toDataUri } from '../core/library/mime';
import { type QtHelpUrl, formatQtHelpUrl } from '../core/library/qthelpUrl';
import { type QchFile, type QchFileEntry, isHtmlPath } from '../core/qch/qchFile';
import { LruCache } from '../core/util/lru';
import type { Appearance, Breadcrumb } from '../shared/protocol';
import type { FilterService } from './filterService';
import type { LibraryService } from './libraryService';

export type RenderResult =
  | {
      readonly kind: 'page';
      readonly url: QtHelpUrl;
      readonly title: string;
      readonly html: string;
      readonly document: QchFile;
    }
  | { readonly kind: 'notFound'; readonly message: string };

const TEXT_EXTENSIONS =
  /\.(?:txt|css|js|mjs|json|xml|qml|qmldir|cpp|cxx|cc|c|h|hpp|hxx|py|pro|pri|cmake|md|qdoc|ui|qrc|svg)$/i;
const MAX_TEXT_PREVIEW = 2 * 1024 * 1024;

/** Shortens titles such as "QString Class | Qt Core 6.4.2" to "QString Class". */
export function shortTitle(title: string): string {
  const separator = title.indexOf(' | ');
  return (separator > 0 ? title.slice(0, separator) : title).trim();
}

/** Renders documentation pages for the viewer and provides page text for search. */
export class PageService {
  private readonly textCache = new LruCache<string, string>(
    24 * 1024 * 1024,
    (text) => text.length * 2,
  );

  public constructor(
    private readonly library: LibraryService,
    private readonly filters: FilterService,
  ) {}

  public async render(url: QtHelpUrl, appearance: Appearance): Promise<RenderResult> {
    const library = this.library.current;
    const resolved = library.resolve(url, this.filters.matcher);
    if (!resolved) {
      const known = library.getDocument(url.namespace);
      return {
        kind: 'notFound',
        message: known
          ? `The page "${url.path}" does not exist in ${known.title}.`
          : `No loaded documentation provides "${url.path}" (namespace ${url.namespace}).`,
      };
    }
    const { document, entry } = resolved;
    const title = shortTitle(entry.title) || entry.path;
    if (!isHtmlPath(entry.path)) {
      const data = await library.readFile(resolved);
      let body: string;
      if (isImagePath(entry.path)) {
        body = `<div class="qch-media"><img alt="${escapeHtml(entry.path)}" src="${toDataUri(data, mimeTypeForPath(entry.path))}"></div>`;
      } else if (TEXT_EXTENSIONS.test(entry.path) && data.byteLength <= MAX_TEXT_PREVIEW) {
        body = `<h1>${escapeHtml(entry.path)}</h1><pre>${escapeHtml(new TextDecoder().decode(data))}</pre>`;
      } else {
        return {
          kind: 'notFound',
          message: `"${entry.path}" is a binary file and cannot be displayed.`,
        };
      }
      return {
        kind: 'page',
        url: resolved.url,
        title,
        document,
        html: `<div class="qch-html"><div class="qch-body">${body}</div></div>`,
      };
    }

    const html = await library.readText(resolved);
    const prepared = await preparePage(
      html,
      resolved.url,
      {
        load: async (resource) => {
          const target = library.resolve(resource, this.filters.matcher);
          return target ? { url: target.url, data: await library.readFile(target) } : undefined;
        },
      },
      { includeDocumentStyles: appearance === 'original' },
    );
    return {
      kind: 'page',
      url: resolved.url,
      title: shortTitle(prepared.title) || title,
      html: prepared.html,
      document,
    };
  }

  /** Plain text of a page (cached), used for snippets and phrase verification. */
  public async pageText(document: QchFile, entry: QchFileEntry): Promise<string> {
    const key = `${document.namespace}\u0000${String(entry.fileId)}`;
    const cached = this.textCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const data = await document.readFileData(entry.fileId);
    const text = extractText(decodeHtml(data)).text;
    this.textCache.set(key, text);
    return text;
  }

  public breadcrumbs(url: QtHelpUrl): Breadcrumb[] {
    const library = this.library.current;
    const document = library.getDocument(url.namespace);
    if (!document) {
      return [];
    }
    const [node] = library.findTocNodes(url, this.filters.matcher);
    const trail: Breadcrumb[] = [];
    for (let current = node?.parent; current; current = current.parent) {
      if (current.url) {
        trail.unshift({ title: current.title, url: formatQtHelpUrl(current.url) });
      }
    }
    const home = library.homePage(document, this.filters.matcher);
    if (home && trail[0]?.url !== formatQtHelpUrl(home)) {
      trail.unshift({ title: document.title, url: formatQtHelpUrl(home) });
    }
    return trail;
  }

  /** A generated page describing a document (metadata, filters, statistics). */
  public infoPage(document: QchFile, location: string): { title: string; html: string } {
    const library = this.library.current;
    const home = library.homePage(document);
    const pages = document.files.filter((file) => isHtmlPath(file.path)).length;
    const row = (label: string, value: string): string =>
      `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
    const list = (values: readonly string[]): string =>
      values.length === 0
        ? '<em>none</em>'
        : values.map((v) => `<code>${escapeHtml(v)}</code>`).join(' ');
    const metadata = [...document.metadata]
      .map(([name, value]) => row(name, escapeHtml(value)))
      .join('');
    const filters = document.customFilters
      .map((filter) => row(filter.name, list(filter.attributes)))
      .join('');
    const html = `<div class="qch-html"><div class="qch-body qch-info">
<h1>${escapeHtml(document.title)}</h1>
<p>${home ? `<a href="${escapeHtml(formatQtHelpUrl(home))}">Open the start page</a>` : 'This document has no start page.'}</p>
<h2>Document</h2>
<table class="qch-props">
${row('Namespace', `<code>${escapeHtml(document.namespace)}</code>`)}
${row('Version', escapeHtml(document.version || 'unknown'))}
${row('Virtual folders', list(document.folders))}
${row('File', `<code>${escapeHtml(location)}</code>`)}
${row('Pages', pages.toLocaleString())}
${row('Stored files', document.files.length.toLocaleString())}
${row('Keywords', document.keywords.length.toLocaleString())}
${row('Filter attributes', list(document.filterAttributes))}
</table>
${filters ? `<h2>Custom filters</h2><table class="qch-props">${filters}</table>` : ''}
${metadata ? `<h2>Metadata</h2><table class="qch-props">${metadata}</table>` : ''}
</div></div>`;
    return { title: `${document.title} — Information`, html };
  }
}
