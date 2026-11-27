import { mimeTypeForPath, toDataUri } from '../library/mime';
import {
  type QtHelpUrl,
  formatQtHelpUrl,
  pageKey,
  resolveReference,
  withFragment,
} from '../library/qthelpUrl';
import { escapeHtml } from './entities';
import { type HtmlAttribute, type HtmlToken, getAttribute, tokenizeHtml } from './tokenizer';

/** Loads files referenced by a page (images, stylesheets) from the documentation library. */
export interface ResourceLoader {
  load(url: QtHelpUrl): Promise<{ readonly url: QtHelpUrl; readonly data: Uint8Array } | undefined>;
}

export interface PrepareOptions {
  /** Keep the page's own stylesheets (inlined); otherwise all document CSS is dropped. */
  readonly includeDocumentStyles: boolean;
  /** Images larger than this are not inlined. */
  readonly maxInlineBytes?: number;
}

export interface PreparedPage {
  readonly title: string;
  /** Sanitized markup intended for a shadow root; contains `<style>` blocks when styles are kept. */
  readonly html: string;
}

const DROPPED_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'noembed',
  'noframes',
  'title',
  'template',
]);
const DROPPED_TAGS = new Set([
  'html',
  'head',
  'body',
  'meta',
  'base',
  'link',
  'noscript',
  'object',
  'embed',
  'applet',
  'param',
]);
const URL_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  img: ['src'],
  image: ['href', 'xlink:href'],
  input: ['src'],
  video: ['poster'],
  source: ['src'],
  track: ['src'],
  audio: ['src'],
};
const LINK_ELEMENTS = new Set(['a', 'area']);
const DEFAULT_MAX_INLINE_BYTES = 8 * 1024 * 1024;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^)'";\s]+))\s*\)?[^;]*;/gi;

function serializeAttributes(attributes: readonly HtmlAttribute[]): string {
  return attributes
    .map(({ name, value }) =>
      value === '' && name !== 'alt' ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`,
    )
    .join('');
}

/** Scopes `html`/`body` selectors so document CSS keeps working inside a shadow root. */
export function scopeDocumentSelectors(css: string): string {
  let result = '';
  let selectorStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css.charAt(i);
    if (ch === '{') {
      const prelude = css.slice(selectorStart, i);
      result += prelude.trimStart().startsWith('@')
        ? prelude
        : prelude.replace(
            /(^|[\s,>+~(])(html|body)(?=$|[\s,.#:[>+~{)])/gi,
            (_m, before: string, tag: string) => `${before}.qch-${tag.toLowerCase()}`,
          );
      result += ch;
      selectorStart = i + 1;
    } else if (ch === '}') {
      result += css.slice(selectorStart, i + 1);
      selectorStart = i + 1;
    }
  }
  return result + css.slice(selectorStart);
}

class PageRewriter {
  private readonly dataUris = new Map<string, string | undefined>();
  private readonly inlineStyles = new Map<string, string>();
  private readonly maxInlineBytes: number;

  public constructor(
    private readonly loader: ResourceLoader,
    private readonly options: PrepareOptions,
  ) {
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  }

  /** Inlines `url(...)` references and `@import`s of a stylesheet. */
  public async processCss(css: string, base: QtHelpUrl, depth = 0): Promise<string> {
    const imports: { match: string; url: QtHelpUrl }[] = [];
    for (const match of css.matchAll(CSS_IMPORT)) {
      const href = match[1] ?? match[2] ?? match[3] ?? '';
      const resolved = resolveReference(base, href);
      if (resolved.kind === 'qthelp') {
        imports.push({ match: match[0], url: resolved.url });
      }
    }
    for (const { match, url } of imports) {
      let replacement = '';
      if (depth < 4) {
        const loaded = await this.loader.load(url);
        if (loaded) {
          replacement = await this.processCss(
            new TextDecoder().decode(loaded.data),
            loaded.url,
            depth + 1,
          );
        }
      }
      css = css.replace(match, () => replacement);
    }

    const references = new Map<string, QtHelpUrl>();
    for (const match of css.matchAll(CSS_URL)) {
      const href = match[1] ?? match[2] ?? match[3] ?? '';
      const resolved = resolveReference(base, href);
      if (resolved.kind === 'qthelp' && !href.startsWith('data:')) {
        references.set(href, resolved.url);
      }
    }
    await Promise.all([...references.values()].map(async (url) => this.dataUri(url)));
    return css.replace(CSS_URL, (whole, a?: string, b?: string, c?: string) => {
      const href = a ?? b ?? c ?? '';
      const url = references.get(href);
      if (!url) {
        return whole;
      }
      const uri = this.dataUris.get(pageKey(withFragment(url, '')));
      return uri ? `url("${uri}")` : 'none';
    });
  }

  public async dataUri(url: QtHelpUrl): Promise<string | undefined> {
    const key = pageKey(withFragment(url, ''));
    if (this.dataUris.has(key)) {
      return this.dataUris.get(key);
    }
    const loaded = await this.loader.load(url);
    const uri =
      loaded && loaded.data.byteLength <= this.maxInlineBytes
        ? toDataUri(loaded.data, mimeTypeForPath(loaded.url.path))
        : undefined;
    this.dataUris.set(key, uri);
    return uri;
  }

  public async prepare(html: string, pageUrl: QtHelpUrl): Promise<PreparedPage> {
    const tokens = [...tokenizeHtml(html)];
    const styles: Promise<string>[] = [];
    const resources: Promise<unknown>[] = [];
    let title = '';
    let bodyAttributes: HtmlAttribute[] = [];

    // First pass: collect resources so they can be loaded in parallel.
    for (const token of tokens) {
      if (token.type === 'rawText' && token.parent === 'title' && !title) {
        title = token.raw.replace(/\s+/g, ' ').trim();
      } else if (
        token.type === 'rawText' &&
        token.parent === 'style' &&
        this.options.includeDocumentStyles
      ) {
        styles.push(this.processCss(token.raw, pageUrl));
      } else if (token.type === 'startTag') {
        if (token.name === 'body') {
          bodyAttributes = token.attributes.filter((a) => a.name === 'class' || a.name === 'id');
        } else if (token.name === 'link' && this.options.includeDocumentStyles) {
          const rel = (getAttribute(token, 'rel') ?? '').toLowerCase().split(/\s+/);
          const href = getAttribute(token, 'href');
          if (rel.includes('stylesheet') && !rel.includes('alternate') && href) {
            styles.push(this.loadStylesheet(pageUrl, href));
          }
        }
        for (const attribute of URL_ATTRIBUTES[token.name] ?? []) {
          const value = getAttribute(token, attribute);
          if (value && !value.startsWith('data:')) {
            const resolved = resolveReference(pageUrl, value);
            if (resolved.kind === 'qthelp') {
              resources.push(this.dataUri(resolved.url));
            }
          }
        }
        const style = getAttribute(token, 'style');
        if (style?.includes('url(') && this.options.includeDocumentStyles) {
          resources.push(
            this.processCss(style, pageUrl).then((processed) => {
              this.inlineStyles.set(style, processed);
            }),
          );
        }
      }
    }
    const [styleTexts] = await Promise.all([Promise.all(styles), Promise.all(resources)]);

    // Second pass: serialize the sanitized body.
    const out: string[] = [];
    for (const css of styleTexts) {
      out.push(`<style>${scopeDocumentSelectors(css).replaceAll('</style', '<\\/style')}</style>`);
    }
    out.push(`<div class="qch-html"><div class="qch-body"${serializeAttributes(bodyAttributes)}>`);
    let inHead = false;
    let droppedParent: string | undefined;
    for (const token of tokens) {
      if (droppedParent !== undefined) {
        if (token.type === 'endTag' && token.name === droppedParent) {
          droppedParent = undefined;
        }
        continue;
      }
      switch (token.type) {
        case 'doctype':
        case 'comment':
          break;
        case 'text':
        case 'rawText':
          if (!inHead) {
            out.push(token.raw);
          }
          break;
        case 'endTag':
          if (token.name === 'head') {
            inHead = false;
          } else if (!inHead && !DROPPED_TAGS.has(token.name)) {
            out.push(`</${token.name}>`);
          }
          break;
        case 'startTag':
          if (token.name === 'head') {
            inHead = true;
          } else if (token.name === 'body') {
            inHead = false;
          } else if (DROPPED_WITH_CONTENT.has(token.name)) {
            // Styles were hoisted to the top in the first pass.
            if (!token.selfClosing) {
              droppedParent = token.name;
            }
          } else if (!inHead && !DROPPED_TAGS.has(token.name)) {
            out.push(this.rewriteTag(token, pageUrl));
          }
          break;
      }
    }
    out.push('</div></div>');
    return { title, html: out.join('') };
  }

  private async loadStylesheet(pageUrl: QtHelpUrl, href: string): Promise<string> {
    const resolved = resolveReference(pageUrl, href);
    if (resolved.kind !== 'qthelp') {
      return '';
    }
    let target = resolved.url;
    // Qt's offline pages link offline-simple.css (for QTextBrowser) and switch to the richer
    // offline.css with a script. Scripts do not run here, so pick offline.css directly.
    if (/(?:^|\/)offline-simple\.css$/.test(target.path)) {
      const rich = { ...target, path: target.path.replace(/offline-simple\.css$/, 'offline.css') };
      if (await this.loader.load(rich)) {
        target = rich;
      }
    }
    const loaded = await this.loader.load(target);
    return loaded ? this.processCss(new TextDecoder().decode(loaded.data), loaded.url) : '';
  }

  private rewriteTag(token: Extract<HtmlToken, { type: 'startTag' }>, pageUrl: QtHelpUrl): string {
    const urlAttributes = URL_ATTRIBUTES[token.name] ?? [];
    const attributes: HtmlAttribute[] = [];
    for (const attribute of token.attributes) {
      const { name, value } = attribute;
      if (
        name.startsWith('on') ||
        name === 'target' ||
        name === 'formaction' ||
        name === 'srcdoc' ||
        name === 'srcset' ||
        name === 'ping'
      ) {
        continue;
      }
      if (LINK_ELEMENTS.has(token.name) && name === 'href') {
        const resolved = resolveReference(pageUrl, value);
        switch (resolved.kind) {
          case 'qthelp':
            attributes.push({ name, value: formatQtHelpUrl(resolved.url) });
            break;
          case 'fragment':
            attributes.push({ name, value: `#${resolved.fragment}` });
            break;
          case 'external':
            attributes.push({ name, value: resolved.href });
            break;
          case 'unsupported':
            break;
        }
        continue;
      }
      if (urlAttributes.includes(name)) {
        if (value.startsWith('data:')) {
          attributes.push(attribute);
          continue;
        }
        const resolved = resolveReference(pageUrl, value);
        if (resolved.kind === 'qthelp') {
          const uri = this.dataUris.get(pageKey(withFragment(resolved.url, '')));
          if (uri) {
            attributes.push({ name, value: uri });
          } else {
            attributes.push({ name: 'data-qch-missing', value: formatQtHelpUrl(resolved.url) });
          }
        } else if (resolved.kind === 'external') {
          attributes.push({ name, value: resolved.href });
        }
        continue;
      }
      if (name === 'style') {
        if (value.includes('url(')) {
          const processed = this.inlineStyles.get(value);
          if (this.options.includeDocumentStyles && processed !== undefined) {
            attributes.push({ name, value: processed });
          }
          continue;
        }
        if (!this.options.includeDocumentStyles) {
          continue;
        }
      }
      if (name === 'action' && token.name === 'form') {
        continue;
      }
      attributes.push(attribute);
    }
    return `<${token.name}${serializeAttributes(attributes)}${token.selfClosing ? ' /' : ''}>`;
  }
}

/**
 * Turns a stored HTML page into self-contained, script-free markup for the documentation
 * viewer: images and stylesheets are inlined as data URIs, links are made absolute
 * (`qthelp://…`), and scripts, frames and event handlers are removed.
 */
export async function preparePage(
  html: string,
  pageUrl: QtHelpUrl,
  loader: ResourceLoader,
  options: PrepareOptions,
): Promise<PreparedPage> {
  return new PageRewriter(loader, options).prepare(html, pageUrl);
}
