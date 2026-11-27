import { describe, expect, it } from 'vitest';
import { ALL_MATCHER, FilterMatcher, NO_FILTER } from '../src/core/library/filters';
import type { QchLibrary } from '../src/core/library/library';
import { extractText } from '../src/core/html/text';
import { FullTextIndex, FullTextIndexBuilder } from '../src/core/search/fullTextIndex';
import { searchFullText } from '../src/core/search/fullTextSearch';
import { buildFullTextIndex } from '../src/core/search/indexBuilder';
import { KeywordIndex } from '../src/core/search/keywordSearch';
import { parseQuery } from '../src/core/search/queryParser';
import { highlight, makeSnippet } from '../src/core/search/snippet';
import { forEachIndexTerm, identifierParts, normalizeWord } from '../src/core/search/tokenize';
import type { QchFile } from '../src/core/qch/qchFile';
import { fixtureLibrary } from './helpers';

describe('tokenization', () => {
  it('normalizes words and splits identifiers', () => {
    expect(normalizeWord('Résumé')).toBe('resume');
    expect(identifierParts('QStringList')).toEqual(['string', 'list']);
    expect(identifierParts('setText')).toEqual(['set', 'text']);
    expect(identifierParts('QT_VERSION_STR')).toEqual(['qt', 'version', 'str']);
    expect(identifierParts('XMLHttpRequest')).toEqual(['xml', 'http', 'request']);
    const terms: string[] = [];
    const count = forEachIndexTerm('Call QString::setText() twice', (t) => terms.push(t));
    expect(count).toBe(4);
    expect(terms).toEqual(['call', 'qstring', 'string', 'settext', 'set', 'text', 'twice']);
  });
});

describe('query parser', () => {
  it('parses terms, phrases, prefixes, negation, OR, groups and fields', () => {
    expect(parseQuery('signal slot').root).toEqual({
      kind: 'and',
      children: [
        { kind: 'term', term: 'signal', prefix: false, field: 'any' },
        { kind: 'term', term: 'slot', prefix: false, field: 'any' },
      ],
    });
    expect(parseQuery('"implicitly shared"').root).toEqual({
      kind: 'phrase',
      terms: ['implicitly', 'shared'],
      field: 'any',
    });
    expect(parseQuery('regul*').root).toEqual({
      kind: 'term',
      term: 'regul',
      prefix: true,
      field: 'any',
    });
    expect(parseQuery('QString::append').root).toEqual({
      kind: 'phrase',
      terms: ['qstring', 'append'],
      field: 'any',
    });
    expect(parseQuery('a OR b -c').root).toEqual({
      kind: 'or',
      children: [
        { kind: 'term', term: 'a', prefix: false, field: 'any' },
        {
          kind: 'and',
          children: [
            { kind: 'term', term: 'b', prefix: false, field: 'any' },
            { kind: 'not', child: { kind: 'term', term: 'c', prefix: false, field: 'any' } },
          ],
        },
      ],
    });
    expect(parseQuery('(a OR b) NOT c').root?.kind).toBe('and');
    expect(parseQuery('title:"model view" doc:qtcore in:"Qt GUI"')).toEqual({
      root: { kind: 'phrase', terms: ['model', 'view'], field: 'title' },
      scopes: ['qtcore', 'Qt GUI'],
      highlights: [
        { term: 'model', prefix: false },
        { term: 'view', prefix: false },
      ],
    });
    expect(parseQuery('').root).toBeUndefined();
    expect(parseQuery(':: ++ )(').root).toBeUndefined();
    expect(parseQuery('-only').highlights).toEqual([]);
  });
});

describe('full-text index', () => {
  it('serializes and deserializes losslessly', () => {
    const builder = new FullTextIndexBuilder();
    builder.addDocument(10, 'alpha beta beta gamma');
    builder.addDocument(20, 'beta delta 日本');
    builder.addDocument(30, 'gamma gamma gamma');
    const index = builder.build();
    const copy = FullTextIndex.deserialize(index.serialize());
    expect(copy).toBeDefined();
    expect(copy?.terms).toEqual(index.terms);
    expect([...(copy?.fileIds ?? [])]).toEqual([10, 20, 30]);
    const postings: [number, number][] = [];
    copy?.forEachPosting(copy.findTerm('beta'), (doc, tf) => postings.push([doc, tf]));
    expect(postings).toEqual([
      [0, 2],
      [1, 1],
    ]);
    expect(copy?.documentFrequency(copy.findTerm('gamma'))).toBe(2);
    expect(copy?.termsWithPrefix('g', 10).map((i) => copy.terms[i])).toEqual(['gamma']);
    expect(copy?.findTerm('missing')).toBe(-1);
    expect(FullTextIndex.deserialize(new Uint8Array(10))).toBeUndefined();
    const corrupted = index.serialize();
    corrupted[4] = 99;
    expect(FullTextIndex.deserialize(corrupted)).toBeUndefined();
  });
});

async function searchSetup(): Promise<{
  library: QchLibrary;
  indexes: Map<QchFile, FullTextIndex>;
  keywords: KeywordIndex;
  run: (query: string, matcher?: FilterMatcher) => Promise<string[]>;
}> {
  const library = await fixtureLibrary();
  const indexes = new Map<QchFile, FullTextIndex>();
  for (const document of library.documents) {
    indexes.set(document, await buildFullTextIndex(document));
  }
  const keywords = new KeywordIndex(library);
  const run = async (query: string, matcher = ALL_MATCHER): Promise<string[]> => {
    const result = await searchFullText(indexes, parseQuery(query), {
      matcher,
      limit: 50,
      keywords,
      loadText: async (document, entry) =>
        extractText(new TextDecoder().decode(await document.readFileData(entry.fileId))).text,
    });
    return result.hits.map((hit) => hit.entry.path);
  };
  return { library, indexes, keywords, run };
}

describe('full-text search', () => {
  it('ranks, combines and filters results', async () => {
    const { run } = await searchSetup();
    expect((await run('widget'))[0]).toBe('widget.html');
    expect(await run('zeppelin')).toEqual(expect.arrayContaining(['big.html', 'beta-index.html']));
    expect(await run('zeppelin doc:beta')).toEqual(['beta-index.html']);
    expect(await run('zeppelin -alpha')).toEqual([]);
    expect(await run('zeppelin -extends')).toEqual(['big.html']);
    expect(await run('"implicitly shared"')).toEqual(['start.html']);
    expect(await run('"shared implicitly"')).toEqual([]);
    expect(await run('title:gadget')).toEqual(['gadget.html']);
    expect(await run('repaint*')).toEqual(['widget.html']);
    expect((await run('resume cafe')).at(0)).toBe('unicode.html');
    expect(await run('zeppelin OR repainting')).toHaveLength(3);
    // Identifier parts: "paint" finds the Widget::paint() mention in start.html.
    expect(await run('paint')).toEqual(
      expect.arrayContaining(['widget.html', 'gadget.html', 'start.html']),
    );
    // Boilerplate footers are not indexed.
    expect(await run('copyright boilerplate')).toEqual([]);
  });

  it('honors filters', async () => {
    const { run } = await searchSetup();
    const onlyBeta = new FilterMatcher({ ...NO_FILTER, id: 'b', components: ['beta'] });
    expect(await run('zeppelin', onlyBeta)).toEqual(['beta-index.html']);
    const extra = new FilterMatcher({ ...NO_FILTER, id: 'x', attributes: ['extra'] });
    expect(await run('widget', extra)).toEqual([]);
  });

  it('builds highlighted snippets around the matches', () => {
    const terms = [{ term: 'zeppelin', prefix: false }];
    const text = `${'filler '.repeat(100)}The zeppelin flies. ${'more '.repeat(100)}`;
    const snippet = makeSnippet(text, terms, 80);
    expect(snippet[0]).toEqual({ text: '…', match: false });
    expect(snippet.filter((s) => s.match).map((s) => s.text)).toEqual(['zeppelin']);
    expect(highlight('call setText now', [{ term: 'text', prefix: false }])).toEqual([
      { text: 'call set', match: false },
      { text: 'Text', match: true },
      { text: ' now', match: false },
    ]);
  });
});

describe('keyword index', () => {
  it('ranks exact, prefix and substring matches', async () => {
    const { keywords } = await searchSetup();
    const names = (query: string): string[] =>
      keywords
        .search(query, { matcher: ALL_MATCHER, limit: 5 })
        .hits.map((h) => h.entry.keyword.identifier);
    expect(names('paint')).toEqual(['Beta::paint', 'Gadget::paint', 'Widget::paint']);
    expect(names('widget')[0]).toBe('Widget');
    expect(names('Widget::pa')).toEqual(['Widget::paint']);
    expect(names('method4?')).toEqual([
      'Widget::method40',
      'Widget::method41',
      'Widget::method42',
      'Widget::method43',
      'Widget::method44',
    ]);
    expect(names('started')).toEqual(['Getting Started']);
    expect(keywords.search('method', { matcher: ALL_MATCHER, limit: 5 }).total).toBe(450);
    expect(
      keywords.search('paint', {
        matcher: ALL_MATCHER,
        limit: 5,
        namespace: 'org.example.beta.200',
      }).total,
    ).toBe(1);
  });

  it('looks up symbols for context help', async () => {
    const { keywords } = await searchSetup();
    expect(keywords.lookup('Widget::paint', ALL_MATCHER).map((e) => e.keyword.identifier)).toEqual([
      'Widget::paint',
    ]);
    expect(keywords.lookup('paint', ALL_MATCHER)).toHaveLength(3);
    expect(keywords.lookup('WIDGET', ALL_MATCHER).map((e) => e.keyword.identifier)).toEqual([
      'Widget',
    ]);
    const onlyBeta = new FilterMatcher({ ...NO_FILTER, id: 'b', components: ['beta'] });
    expect(keywords.lookup('paint', onlyBeta).map((e) => e.keyword.identifier)).toEqual([
      'Beta::paint',
    ]);
  });
});
