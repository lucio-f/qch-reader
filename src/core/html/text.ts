import { decodeEntities } from './entities';
import { type HtmlToken, getAttribute, tokenizeHtml } from './tokenizer';

export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'caption',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const SKIPPED_ELEMENTS = new Set(['head', 'nav', 'template', 'select', 'button']);

/** Boilerplate containers of Qt and Doxygen pages that would only add noise to search. */
const BOILERPLATE = /(?:^|\s)(?:footer|navigationbar|navpath|nav-path|sidebar)(?:\s|$)/i;

export interface ExtractedText {
  readonly title: string;
  readonly text: string;
}

function isBoilerplate(token: Extract<HtmlToken, { type: 'startTag' }>): boolean {
  if (SKIPPED_ELEMENTS.has(token.name)) {
    return true;
  }
  const className = getAttribute(token, 'class') ?? '';
  const id = getAttribute(token, 'id') ?? '';
  return BOILERPLATE.test(className) || BOILERPLATE.test(id);
}

/** Extracts the title and the readable text of an HTML page (whitespace-collapsed). */
export function extractText(html: string): ExtractedText {
  const parts: string[] = [];
  let title = '';
  let skipTag: string | undefined;
  let skipDepth = 0;

  for (const token of tokenizeHtml(html)) {
    switch (token.type) {
      case 'startTag':
        if (skipTag !== undefined) {
          if (token.name === skipTag && !token.selfClosing) {
            skipDepth++;
          }
        } else if (!VOID_ELEMENTS.has(token.name) && !token.selfClosing && isBoilerplate(token)) {
          skipTag = token.name;
          skipDepth = 1;
        } else if (BLOCK_ELEMENTS.has(token.name)) {
          parts.push(' ');
        }
        break;
      case 'endTag':
        if (skipTag !== undefined) {
          if (token.name === skipTag && --skipDepth === 0) {
            skipTag = undefined;
          }
        } else if (BLOCK_ELEMENTS.has(token.name)) {
          parts.push(' ');
        }
        break;
      case 'rawText':
        if (token.parent === 'title' && title === '') {
          title = decodeEntities(token.raw).replace(/\s+/g, ' ').trim();
        }
        break;
      case 'text':
        if (skipTag === undefined) {
          parts.push(decodeEntities(token.raw));
        }
        break;
      case 'comment':
      case 'doctype':
        break;
    }
  }
  return { title, text: parts.join('').replace(/\s+/g, ' ').trim() };
}

export interface Brief {
  /** Text of the heading the anchor points at (e.g. a function signature), if any. */
  readonly heading: string;
  readonly summary: string;
}

const HEADING = /^h[1-6]$/;

/**
 * Extracts a short description for a keyword: the heading the anchor points at plus the
 * paragraphs that follow it, or — without an anchor — the first paragraph after the `<h1>`.
 */
export function extractBrief(html: string, anchor: string, maxLength = 500): Brief {
  const tokens = [...tokenizeHtml(html)];
  let start = -1;
  if (anchor) {
    start = tokens.findIndex(
      (token) =>
        token.type === 'startTag' &&
        (getAttribute(token, 'id') === anchor ||
          (token.name === 'a' && getAttribute(token, 'name') === anchor)),
    );
  }
  if (start < 0) {
    const h1 = tokens.findIndex((token) => token.type === 'endTag' && token.name === 'h1');
    start = h1 < 0 ? 0 : h1 + 1;
    anchor = '';
  }

  let heading = '';
  let index = start;
  const startToken = tokens[start];
  if (anchor && startToken?.type === 'startTag') {
    // The anchor may sit on the heading itself or on an <a> right before/inside it.
    let headingStart = HEADING.test(startToken.name) ? start : -1;
    if (headingStart < 0) {
      for (let i = start + 1; i < Math.min(tokens.length, start + 4); i++) {
        const token = tokens[i];
        if (token?.type === 'startTag' && HEADING.test(token.name)) {
          headingStart = i;
          break;
        }
        if (token?.type === 'text' && token.raw.trim() !== '') {
          break;
        }
      }
    }
    if (headingStart >= 0) {
      const headingName = (tokens[headingStart] as { name: string }).name;
      const parts: string[] = [];
      let i = headingStart + 1;
      for (; i < tokens.length; i++) {
        const token = tokens[i];
        if (token?.type === 'endTag' && token.name === headingName) {
          break;
        }
        if (token?.type === 'text') {
          parts.push(decodeEntities(token.raw));
        }
      }
      heading = parts.join('').replace(/\s+/g, ' ').trim();
      index = i + 1;
    }
  }

  const summary: string[] = [];
  let length = 0;
  let inParagraph = false;
  let paragraphs = 0;
  let skipTag: string | undefined;
  let skipDepth = 0;
  for (let i = index; i < tokens.length && length < maxLength; i++) {
    const token = tokens[i];
    if (!token) {
      break;
    }
    if (token.type === 'startTag') {
      if (skipTag !== undefined) {
        if (token.name === skipTag) {
          skipDepth++;
        }
        continue;
      }
      if (HEADING.test(token.name) && (paragraphs > 0 || anchor)) {
        break;
      }
      if (token.name === 'p') {
        inParagraph = true;
      } else if (!VOID_ELEMENTS.has(token.name) && !token.selfClosing && isBoilerplate(token)) {
        skipTag = token.name;
        skipDepth = 1;
      }
    } else if (token.type === 'endTag') {
      if (skipTag !== undefined) {
        if (token.name === skipTag && --skipDepth === 0) {
          skipTag = undefined;
        }
        continue;
      }
      if (token.name === 'p' && inParagraph) {
        inParagraph = false;
        paragraphs++;
        summary.push(' ');
        if (paragraphs >= 2 || (!anchor && paragraphs >= 1)) {
          break;
        }
      }
    } else if (token.type === 'text' && inParagraph && skipTag === undefined) {
      const text = decodeEntities(token.raw);
      summary.push(text);
      length += text.length;
    }
  }
  let text = summary.join('').replace(/\s+/g, ' ').trim();
  text = text.replace(/\s*More\.\.\.$/, '');
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength).replace(/\s+\S*$/, '')}…`;
  }
  return { heading, summary: text };
}
