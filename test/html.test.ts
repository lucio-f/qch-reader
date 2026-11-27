import { describe, expect, it } from 'vitest';
import { decodeEntities, escapeHtml } from '../src/core/html/entities';
import { preparePage, scopeDocumentSelectors } from '../src/core/html/rewrite';
import { extractBrief, extractText } from '../src/core/html/text';
import { tokenizeHtml } from '../src/core/html/tokenizer';
import type { QchLibrary } from '../src/core/library/library';
import { parseQtHelpUrl } from '../src/core/library/qthelpUrl';
import { fixtureLibrary } from './helpers';

describe('entities', () => {
  it('decodes named and numeric references', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#x41;&#66; &nbsp;&copy; &unknown; &#0;')).toBe(
      'a & b <c> AB  © &unknown; �',
    );
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe('tokenizer', () => {
  it('splits tags, attributes, text, comments and raw text', () => {
    const tokens = [
      ...tokenizeHtml(
        '<!DOCTYPE html><p class="a" data-x=\'1\' hidden id=b>Hi &amp; <b>there</b></p><!-- c --><script>if (a < b) {}</script><br/>x < y',
      ),
    ];
    expect(tokens.map((t) => t.type)).toEqual([
      'doctype',
      'startTag',
      'text',
      'startTag',
      'text',
      'endTag',
      'endTag',
      'comment',
      'startTag',
      'rawText',
      'endTag',
      'startTag',
      'text',
    ]);
    const p = tokens[1];
    expect(p?.type === 'startTag' && p.attributes).toEqual([
      { name: 'class', value: 'a' },
      { name: 'data-x', value: '1' },
      { name: 'hidden', value: '' },
      { name: 'id', value: 'b' },
    ]);
    const br = tokens[11];
    expect(br?.type === 'startTag' && br.selfClosing).toBe(true);
    expect(tokens.at(-1)).toEqual({ type: 'text', raw: 'x < y' });
  });

  it('survives malformed markup', () => {
    const tokens = [...tokenizeHtml('<p title="unterminated>text<</p')];
    expect(tokens.length).toBeGreaterThan(0);
    expect([...tokenizeHtml('<style>unclosed')].map((t) => t.type)).toEqual([
      'startTag',
      'rawText',
    ]);
  });
});

describe('text extraction', () => {
  it('extracts readable text without boilerplate', () => {
    const { title, text } =
      extractText(`<html><head><title>T &amp; U</title><style>p{}</style></head>
<body><div class="navigationbar">Nav</div><h1>Head</h1><p>One<span>Two</span></p><p>Three</p>
<div class="sidebar"><div>toc</div></div><script>x()</script><div class="footer">Foot</div></body></html>`);
    expect(title).toBe('T & U');
    expect(text).toBe('Head OneTwo Three');
  });

  it('extracts briefs for anchors and for class pages', async () => {
    const library = await fixtureLibrary();
    const page = library.resolve(
      parseQtHelpUrl('qthelp://org.example.alpha.100/alpha/widget.html')!,
    )!;
    const html = await library.readText(page);
    expect(extractBrief(html, 'paint')).toEqual({
      heading: 'void Widget::paint(Painter *painter)',
      summary:
        'Paints the widget using painter. This function is called whenever the widget needs repainting. Second paragraph about painting.',
    });
    expect(extractBrief(html, '')).toEqual({
      heading: '',
      summary: 'The Widget class is the base of all visual elements.',
    });
    expect(extractBrief(html, 'legacy-anchor').heading).toBe('Legacy anchor');
    expect(extractBrief(html, 'missing').summary).toContain('base of all visual elements');
  });
});

async function prepare(
  library: QchLibrary,
  url: string,
  includeDocumentStyles: boolean,
): Promise<string> {
  const pageUrl = parseQtHelpUrl(url)!;
  const page = library.resolve(pageUrl)!;
  const prepared = await preparePage(
    await library.readText(page),
    page.url,
    {
      load: async (resource) => {
        const target = library.resolve(resource);
        return target ? { url: target.url, data: await library.readFile(target) } : undefined;
      },
    },
    { includeDocumentStyles },
  );
  return prepared.html;
}

describe('page preparation', () => {
  it('makes links absolute and removes active content', async () => {
    const library = await fixtureLibrary();
    const html = await prepare(library, 'qthelp://org.example.alpha.100/alpha/start.html', false);
    expect(html).toContain('href="qthelp://org.example.alpha.100/alpha/widget.html"');
    expect(html).toContain('href="https://www.qt.io/"');
    expect(html).not.toContain('target=');
    expect(html).not.toContain('javascript:');
    expect(html).not.toMatch(/<script|<link|<meta|<title|<style/);
    expect(html.startsWith('<div class="qch-html"><div class="qch-body" class="alpha-page">')).toBe(
      true,
    );

    const index = await prepare(library, 'qthelp://org.example.alpha.100/alpha/index.html', false);
    expect(index).toMatch(
      /<img src="data:image\/png;base64,[A-Za-z0-9+/=]{30000,}" alt="Alpha logo">/,
    );
    expect(index).not.toContain('onerror');
    expect(index).not.toContain('<iframe');

    const widget = await prepare(
      library,
      'qthelp://org.example.alpha.100/alpha/widget.html',
      false,
    );
    expect(widget).toContain('href="qthelp://org.example.alpha.100/beta/beta-index.html#intro"');
    expect(widget).toContain('href="qthelp://org.example.beta.200/beta/guide.html"');
    expect(widget).toContain('href="#details"');
  });

  it('inlines and scopes document stylesheets in the original appearance', async () => {
    const library = await fixtureLibrary();
    const html = await prepare(library, 'qthelp://org.example.alpha.100/alpha/index.html', true);
    expect(html).toMatch(/^<style>\.qch-body \{ background: url\("data:image\/png;base64,/);
    expect(html).toContain('.qch-html, .qch-body { margin: 0; }');
    expect(html).toContain('@media print { .qch-body { color: black; } }');
  });

  it('scopes html/body selectors only in selector positions', () => {
    expect(scopeDocumentSelectors('body{a:1} div.body, html > p:hover {b:2} .tbody td{}')).toBe(
      '.qch-body{a:1} div.body, .qch-html > p:hover {b:2} .tbody td{}',
    );
  });
});
