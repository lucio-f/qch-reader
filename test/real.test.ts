// End-to-end checks against real documentation. Enabled by setting QCH_TEST_DIRS to one or
// more directories containing .qch files (e.g. the Qt documentation of a Qt installation).
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { preparePage } from '../src/core/html/rewrite';
import { QchLibrary } from '../src/core/library/library';
import { parseQtHelpUrl, splitVirtualFolder } from '../src/core/library/qthelpUrl';
import { isHtmlPath } from '../src/core/qch/qchFile';
import { searchFullText } from '../src/core/search/fullTextSearch';
import { buildFullTextIndex } from '../src/core/search/indexBuilder';
import { KeywordIndex } from '../src/core/search/keywordSearch';
import { parseQuery } from '../src/core/search/queryParser';
import { ALL_MATCHER } from '../src/core/library/filters';
import { externalQchFiles, openQch } from './helpers';

const files = externalQchFiles();
const directories = [...new Set(files.map((file) => path.dirname(file)))];

describe.skipIf(files.length === 0)('real documentation sets', () => {
  it.each(directories)('renders pages and resolves cross-links in %s', async (directory) => {
    const documents = await Promise.all(
      files.filter((file) => path.dirname(file) === directory).map(async (file) => openQch(file)),
    );
    const library = new QchLibrary(documents);
    const loadedFolders = new Set(library.documents.flatMap((d) => d.folders));
    let pages = 0;
    let links = 0;
    const unresolved = new Set<string>();

    for (const document of library.documents) {
      const htmlFiles = document.files.filter((file) => isHtmlPath(file.path));
      // Every page of small documents, a sample of large ones.
      const step = Math.max(1, Math.floor(htmlFiles.length / 60));
      for (let i = 0; i < htmlFiles.length; i += step) {
        const entry = htmlFiles[i];
        if (!entry) {
          continue;
        }
        const page = { document, entry, url: library.urlForFile(document, entry) };
        const prepared = await preparePage(
          await library.readText(page),
          page.url,
          {
            load: async (resource) => {
              const target = library.resolve(resource);
              return target ? { url: target.url, data: await library.readFile(target) } : undefined;
            },
          },
          { includeDocumentStyles: i % 2 === 0 },
        );
        expect(prepared.html).not.toMatch(/<script\b/i);
        expect(prepared.html).not.toContain('data-qch-missing');
        pages++;
        for (const match of prepared.html.matchAll(/href="(qthelp:\/\/[^"]+)"/g)) {
          const url = parseQtHelpUrl(match[1]!.replaceAll('&amp;', '&'))!;
          links++;
          const [folder] = splitVirtualFolder(url.path);
          if (loadedFolders.has(folder) && !library.resolve(url)) {
            unresolved.add(url.path);
          }
        }
      }
    }
    expect(pages).toBeGreaterThan(0);
    // Links into loaded modules must resolve (a few dangling links exist in the Qt docs).
    expect(unresolved.size / Math.max(links, 1)).toBeLessThan(0.002);
  });

  it.each(directories)('searches %s', async (directory) => {
    const documents = await Promise.all(
      files.filter((file) => path.dirname(file) === directory).map(async (file) => openQch(file)),
    );
    const library = new QchLibrary(documents);
    const keywords = new KeywordIndex(library);
    const indexes = new Map(
      await Promise.all(
        library.documents.map(async (d) => [d, await buildFullTextIndex(d)] as const),
      ),
    );
    const result = await searchFullText(indexes, parseQuery('qobject'), {
      matcher: ALL_MATCHER,
      limit: 10,
      keywords,
    });
    if (library.documents.some((d) => d.component === 'qtcore')) {
      expect(result.hits[0]?.entry.title).toMatch(/^QObject Class/);
      expect(keywords.lookup('QObject::connect', ALL_MATCHER).length).toBeGreaterThan(0);
    } else {
      expect(result.total).toBeGreaterThanOrEqual(0);
    }
  });
});
