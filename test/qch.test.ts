import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeContents } from '../src/core/qch/qdatastream';
import {
  QchFile,
  buildToc,
  normalizeStoredPath,
  versionFromNamespace,
} from '../src/core/qch/qchFile';
import { MemoryByteSource } from '../src/core/sqlite/pageSource';
import { FIXTURES, openFixture } from './helpers';

/** Encodes (depth, ref, title) triples the way QDataStream does. */
function encodeContents(entries: readonly [number, string | null, string][]): Uint8Array {
  const parts: number[] = [];
  const u32 = (value: number): void => {
    parts.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  };
  for (const [depth, ref, title] of entries) {
    u32(depth);
    for (const text of [ref, title]) {
      if (text === null) {
        u32(0xffffffff);
        continue;
      }
      u32(text.length * 2);
      for (const ch of text) {
        const code = ch.charCodeAt(0);
        parts.push(code >> 8, code & 0xff);
      }
    }
  }
  return Uint8Array.from(parts);
}

describe('QDataStream contents', () => {
  it('decodes depth/ref/title triples including null strings', () => {
    const data = encodeContents([
      [0, 'index.html', 'Root'],
      [1, 'a.html', 'A é'],
      [2, null, 'No link'],
      [1, 'b.html#x', 'B'],
    ]);
    expect(decodeContents(data)).toEqual([
      { depth: 0, ref: 'index.html', title: 'Root' },
      { depth: 1, ref: 'a.html', title: 'A é' },
      { depth: 2, ref: '', title: 'No link' },
      { depth: 1, ref: 'b.html#x', title: 'B' },
    ]);
  });

  it('stops gracefully on truncated data', () => {
    const data = encodeContents([
      [0, 'index.html', 'Root'],
      [1, 'a.html', 'A'],
    ]);
    expect(decodeContents(data.subarray(0, data.length - 3))).toHaveLength(1);
  });

  it('builds a tree from depths', () => {
    const tree = buildToc([
      { depth: 0, ref: 'r', title: 'R' },
      { depth: 1, ref: 'a', title: 'A' },
      { depth: 2, ref: 'a1', title: 'A1' },
      { depth: 1, ref: 'b', title: 'B' },
      { depth: 0, ref: 's', title: 'S' },
    ]);
    expect(tree.map((n) => n.title)).toEqual(['R', 'S']);
    expect(tree[0]?.children.map((n) => n.title)).toEqual(['A', 'B']);
    expect(tree[0]?.children[0]?.children.map((n) => n.title)).toEqual(['A1']);
  });
});

describe('helpers', () => {
  it('derives Qt versions from namespaces', () => {
    expect(versionFromNamespace('org.qt-project.qtcore.642')).toBe('6.4.2');
    expect(versionFromNamespace('org.qt-project.qtcore.5152')).toBe('5.15.2');
    expect(versionFromNamespace('org.qt-project.qtcore.51513')).toBe('5.15.13');
    expect(versionFromNamespace('org.qt-project.qtquickcontrols2.5120')).toBe('5.12.0');
    expect(versionFromNamespace('org.example.foo.100')).toBe('');
  });

  it('normalizes stored paths', () => {
    expect(normalizeStoredPath('./a//b/../c.html')).toBe('a/c.html');
    expect(normalizeStoredPath('\\images\\x.png')).toBe('images/x.png');
  });
});

describe('QchFile', () => {
  it('reads namespace, folders, metadata and filters', async () => {
    const alpha = await openFixture('alpha');
    expect(alpha.namespace).toBe('org.example.alpha.100');
    expect(alpha.folders).toEqual(['alpha']);
    expect(alpha.component).toBe('alpha');
    expect(alpha.version).toBe('1.0.0');
    expect(alpha.metadata.get('author')).toBe('QCH Reader tests');
    expect(alpha.title).toBe('Alpha Manual');
    expect(alpha.filterAttributes).toEqual(['1.0', 'alpha', 'extra']);
    expect(alpha.customFilters).toEqual([{ name: 'Alpha 1.0', attributes: ['1.0', 'alpha'] }]);
    await alpha.close();
  });

  it('reads files, keywords and table of contents', async () => {
    const alpha = await openFixture('alpha');
    expect(alpha.files.map((f) => f.path).sort()).toEqual(
      [
        'api.html',
        'big.html',
        'gadget.html',
        'images/bg.png',
        'images/logo.png',
        'index.html',
        'start.html',
        'style/style.css',
        'unicode.html',
        'widget.html',
      ].sort(),
    );
    const widget = alpha.findFile('alpha', 'widget.html');
    expect(widget?.title).toBe('Widget Class | Alpha 1.0');
    expect([...(widget?.attributes ?? [])].sort()).toEqual(['1.0', 'alpha']);
    expect(alpha.findFile('ALPHA', 'Widget.HTML')).toBe(widget);
    expect(alpha.findFile('alpha', 'missing.html')).toBeUndefined();

    expect(alpha.keywords).toHaveLength(456);
    const paint = alpha.keywords.filter((k) => k.name === 'paint');
    expect(paint.map((k) => k.identifier).sort()).toEqual(['Gadget::paint', 'Widget::paint']);
    expect(paint.find((k) => k.identifier === 'Widget::paint')?.anchor).toBe('paint');
    const started = alpha.keywords.find((k) => k.name === 'Getting Started');
    expect(started?.identifier).toBe('Getting Started');

    expect(alpha.contents).toHaveLength(2);
    const main = alpha.contents.find((section) => section.attributes.has('1.0'));
    expect(main?.items[0]?.title).toBe('Alpha Manual');
    expect(main?.items[0]?.children.map((c) => c.title)).toEqual([
      'Getting Started',
      'API Reference',
      'Ünïcödé Pägé',
      'Big Page',
    ]);
    expect(main?.items[0]?.children[0]?.children[0]).toEqual({
      title: 'Installing',
      ref: 'start.html#install',
      children: [],
    });
    const extra = alpha.contents.find((section) => section.attributes.has('extra'));
    expect(extra?.items.map((i) => i.title)).toEqual(['Extra Section']);
    await alpha.close();
  });

  it('decompresses stored files, including ones spanning overflow pages', async () => {
    const alpha = await openFixture('alpha');
    const big = alpha.findFile('alpha', 'big.html');
    const logo = alpha.findFile('alpha', 'images/logo.png');
    expect(big && logo).toBeTruthy();
    const html = new TextDecoder().decode(await alpha.readFileData(big?.fileId ?? 0));
    expect(html).toContain('The very last paragraph mentions zeppelin exactly once.');
    const image = await alpha.readFileData(logo?.fileId ?? 0);
    expect(image.byteLength).toBe(24 * 1024);

    let streamed = 0;
    await alpha.forEachFileData(
      (fileId, data) => {
        if (fileId === logo?.fileId) {
          expect(Buffer.from(data).equals(Buffer.from(image))).toBe(true);
        }
        streamed++;
      },
      (fileId) => fileId !== 1,
    );
    expect(streamed).toBe(10);
    await alpha.close();
  });

  it('loads from memory and rejects non-QCH databases', async () => {
    const beta = await QchFile.open(
      new MemoryByteSource(readFileSync(`${FIXTURES}beta.qch`)),
      'beta.qch',
    );
    expect(beta.namespace).toBe('org.example.beta.200');
    expect(beta.version).toBe('2.0.0');
    expect(beta.filterAttributes).toEqual([]);
    expect(beta.customFilters).toEqual([]);
    await beta.close();

    await expect(QchFile.open(new MemoryByteSource(new Uint8Array(4096)), 'x')).rejects.toThrow();
  });
});
