import { describe, expect, it } from 'vitest';
import {
  FilterMatcher,
  NO_FILTER,
  collectDeclaredFilters,
  compareVersions,
} from '../src/core/library/filters';
import {
  formatQtHelpUrl,
  makeQtHelpUrl,
  parseQtHelpUrl,
  resolveReference,
  splitVirtualFolder,
} from '../src/core/library/qthelpUrl';
import { fixtureLibrary } from './helpers';

describe('qthelp URLs', () => {
  it('parses and formats', () => {
    const url = parseQtHelpUrl(
      'qthelp://org.qt-project.qtcore.642/qtcore/./images/../qstring.html?x=1#append',
    );
    expect(url).toEqual({
      namespace: 'org.qt-project.qtcore.642',
      path: 'qtcore/qstring.html',
      fragment: 'append',
    });
    expect(formatQtHelpUrl(url!)).toBe(
      'qthelp://org.qt-project.qtcore.642/qtcore/qstring.html#append',
    );
    expect(parseQtHelpUrl('qthelp://ns/a%20b/c%23d.html')?.path).toBe('a b/c#d.html');
    expect(formatQtHelpUrl({ namespace: 'ns', path: 'a b/c#d.html', fragment: '' })).toBe(
      'qthelp://ns/a%20b/c%23d.html',
    );
    expect(parseQtHelpUrl('https://example.com')).toBeUndefined();
    expect(parseQtHelpUrl('qthelp:///path')).toBeUndefined();
    expect(splitVirtualFolder('qtcore/sub/x.html')).toEqual(['qtcore', 'sub/x.html']);
    expect(makeQtHelpUrl('ns', 'folder', 'a/../b.html#frag')).toEqual({
      namespace: 'ns',
      path: 'folder/b.html',
      fragment: 'frag',
    });
  });

  it('resolves references like a browser', () => {
    const base = parseQtHelpUrl('qthelp://ns/qtgui/sub/page.html#top')!;
    expect(resolveReference(base, 'other.html')).toEqual({
      kind: 'qthelp',
      url: { namespace: 'ns', path: 'qtgui/sub/other.html', fragment: '' },
    });
    expect(resolveReference(base, '../../qtcore/qstring.html#arg')).toEqual({
      kind: 'qthelp',
      url: { namespace: 'ns', path: 'qtcore/qstring.html', fragment: 'arg' },
    });
    expect(resolveReference(base, '/qtcore/x.html')).toMatchObject({
      url: { path: 'qtcore/x.html' },
    });
    expect(resolveReference(base, '#details')).toEqual({ kind: 'fragment', fragment: 'details' });
    expect(resolveReference(base, 'qthelp://other/f/p.html')).toMatchObject({
      url: { namespace: 'other' },
    });
    expect(resolveReference(base, 'https://qt.io')).toEqual({
      kind: 'external',
      href: 'https://qt.io',
    });
    expect(resolveReference(base, '//cdn.example.com/x.png')).toEqual({
      kind: 'external',
      href: 'https://cdn.example.com/x.png',
    });
    expect(resolveReference(base, 'javascript:alert(1)')).toEqual({
      kind: 'unsupported',
      href: 'javascript:alert(1)',
    });
    expect(resolveReference(base, '?query')).toMatchObject({
      url: { path: 'qtgui/sub/page.html' },
    });
  });
});

describe('filters', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('5.15.2', '6.4.0')).toBeLessThan(0);
    expect(compareVersions('6.10.0', '6.9.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0', '1.0')).toBe(0);
  });

  it('matches documents by component, version and attributes', async () => {
    const library = await fixtureLibrary();
    const [alpha, beta] = [
      library.getDocument('org.example.alpha.100')!,
      library.getDocument('org.example.beta.200')!,
    ];
    const byComponent = new FilterMatcher({ ...NO_FILTER, id: 'c', components: ['BETA'] });
    expect(byComponent.matchesDocument(alpha)).toBe(false);
    expect(byComponent.matchesDocument(beta)).toBe(true);
    const byVersion = new FilterMatcher({ ...NO_FILTER, id: 'v', versions: ['1.0.0'] });
    expect([alpha, beta].map((d) => byVersion.matchesDocument(d))).toEqual([true, false]);

    const [declared] = collectDeclaredFilters(library.documents);
    expect(declared?.label).toBe('Alpha 1.0');
    const legacy = new FilterMatcher(declared!);
    expect(legacy.matchesDocument(alpha)).toBe(true);
    expect(legacy.matchesDocument(beta)).toBe(false);
    const sections = alpha.contents.map((section) => legacy.matchesItem(section.attributes));
    expect(sections.filter(Boolean)).toHaveLength(1);
  });
});

describe('QchLibrary', () => {
  it('orders documents and resolves cross-document links', async () => {
    const library = await fixtureLibrary();
    expect(library.documents.map((d) => d.title)).toEqual(['Alpha Manual', 'Beta']);

    const widget = parseQtHelpUrl('qthelp://org.example.alpha.100/alpha/widget.html#paint')!;
    expect(library.resolve(widget)?.entry.path).toBe('widget.html');

    // A relative link into another module resolves through the virtual folder.
    const relative = resolveReference(widget, '../beta/beta-index.html#intro');
    expect(relative.kind).toBe('qthelp');
    const resolved = relative.kind === 'qthelp' ? library.resolve(relative.url) : undefined;
    expect(resolved?.document.namespace).toBe('org.example.beta.200');
    expect(formatQtHelpUrl(resolved!.url)).toBe(
      'qthelp://org.example.beta.200/beta/beta-index.html#intro',
    );

    // A namespace that is not loaded still resolves when the folder exists elsewhere.
    const foreign = parseQtHelpUrl('qthelp://org.example.beta.199/beta/guide.html')!;
    expect(library.resolve(foreign)?.document.namespace).toBe('org.example.beta.200');
    expect(
      library.resolve(parseQtHelpUrl('qthelp://org.example.alpha.100/alpha/nope.html')!),
    ).toBeUndefined();
  });

  it('serves start pages, tables of contents and cached file data', async () => {
    const library = await fixtureLibrary();
    const alpha = library.getDocument('org.example.alpha.100')!;
    expect(formatQtHelpUrl(library.homePage(alpha)!)).toBe(
      'qthelp://org.example.alpha.100/alpha/index.html',
    );

    const all = library.getToc(alpha);
    expect(all.map((n) => n.title)).toEqual(['Alpha Manual', 'Extra Section']);
    const filtered = library.getToc(
      alpha,
      new FilterMatcher(collectDeclaredFilters(library.documents)[0]!),
    );
    expect(filtered.map((n) => n.title)).toEqual(['Alpha Manual']);

    const install = parseQtHelpUrl('qthelp://org.example.alpha.100/alpha/start.html#install')!;
    const [node] = library.findTocNodes(install);
    expect(node?.title).toBe('Installing');
    expect(node?.parent?.title).toBe('Getting Started');

    const page = library.resolve(install)!;
    const first = await library.readFile(page);
    expect(await library.readFile(page)).toBe(first);
    expect(await library.readText(page)).toContain('Getting Started');
  });
});
