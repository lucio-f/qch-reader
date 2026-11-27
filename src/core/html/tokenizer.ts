import { decodeEntities } from './entities';

export interface HtmlAttribute {
  /** Lower-cased attribute name. */
  readonly name: string;
  /** Decoded value; empty string for boolean attributes. */
  readonly value: string;
}

export type HtmlToken =
  | { readonly type: 'text'; readonly raw: string }
  | {
      readonly type: 'startTag';
      /** Lower-cased tag name. */
      readonly name: string;
      readonly attributes: readonly HtmlAttribute[];
      readonly selfClosing: boolean;
      readonly raw: string;
    }
  | { readonly type: 'endTag'; readonly name: string; readonly raw: string }
  /** Content of raw-text elements such as `<script>` and `<style>`. */
  | { readonly type: 'rawText'; readonly parent: string; readonly raw: string }
  | { readonly type: 'comment'; readonly raw: string }
  | { readonly type: 'doctype'; readonly raw: string };

const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
]);

function isNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

/**
 * A small, forgiving HTML tokenizer. It does not build a tree; it splits markup into tags,
 * text, comments and raw-text element contents, which is all that link rewriting and text
 * extraction need. Malformed markup degrades to text instead of throwing.
 */
export function* tokenizeHtml(html: string): Generator<HtmlToken> {
  const length = html.length;
  let position = 0;
  let textStart = 0;

  while (position < length) {
    const lt = html.indexOf('<', position);
    if (lt < 0) {
      break;
    }
    const next = html.charCodeAt(lt + 1);
    let tokenEnd = -1;
    let token: HtmlToken | undefined;

    if (next === 0x21 /* ! */) {
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        tokenEnd = close < 0 ? length : close + 3;
        token = { type: 'comment', raw: html.slice(lt, tokenEnd) };
      } else {
        const close = html.indexOf('>', lt + 2);
        tokenEnd = close < 0 ? length : close + 1;
        token = { type: 'doctype', raw: html.slice(lt, tokenEnd) };
      }
    } else if (next === 0x3f /* ? */) {
      const close = html.indexOf('>', lt + 2);
      tokenEnd = close < 0 ? length : close + 1;
      token = { type: 'comment', raw: html.slice(lt, tokenEnd) };
    } else if (next === 0x2f /* / */ && isNameStart(html.charCodeAt(lt + 2))) {
      const close = html.indexOf('>', lt + 2);
      tokenEnd = close < 0 ? length : close + 1;
      const name = /^[^\s/>]+/.exec(html.slice(lt + 2, tokenEnd))?.[0] ?? '';
      token = { type: 'endTag', name: name.toLowerCase(), raw: html.slice(lt, tokenEnd) };
    } else if (isNameStart(next)) {
      const parsed = parseStartTag(html, lt);
      tokenEnd = parsed.end;
      token = parsed.token;
    }

    if (!token) {
      position = lt + 1;
      continue;
    }
    if (lt > textStart) {
      yield { type: 'text', raw: html.slice(textStart, lt) };
    }
    yield token;
    position = tokenEnd;
    textStart = tokenEnd;

    if (token.type === 'startTag' && !token.selfClosing && RAW_TEXT_ELEMENTS.has(token.name)) {
      const closePattern = new RegExp(`</${token.name}[\\s/>]`, 'ig');
      closePattern.lastIndex = position;
      const close = closePattern.exec(html);
      const contentEnd = close ? close.index : length;
      if (contentEnd > position) {
        yield { type: 'rawText', parent: token.name, raw: html.slice(position, contentEnd) };
      }
      position = contentEnd;
      textStart = contentEnd;
    }
  }
  if (textStart < length) {
    yield { type: 'text', raw: html.slice(textStart) };
  }
}

function parseStartTag(html: string, start: number): { token: HtmlToken; end: number } {
  const length = html.length;
  let i = start + 1;
  while (i < length) {
    const code = html.charCodeAt(i);
    if (isSpace(code) || code === 0x2f || code === 0x3e) {
      break;
    }
    i++;
  }
  const name = html.slice(start + 1, i).toLowerCase();
  const attributes: HtmlAttribute[] = [];
  let selfClosing = false;

  while (i < length) {
    while (i < length && isSpace(html.charCodeAt(i))) {
      i++;
    }
    const code = html.charCodeAt(i);
    if (i >= length) {
      break;
    }
    if (code === 0x3e /* > */) {
      i++;
      return {
        token: { type: 'startTag', name, attributes, selfClosing, raw: html.slice(start, i) },
        end: i,
      };
    }
    if (code === 0x2f /* / */) {
      i++;
      if (html.charCodeAt(i) === 0x3e) {
        selfClosing = true;
      }
      continue;
    }
    const nameStart = i;
    while (i < length) {
      const c = html.charCodeAt(i);
      if (isSpace(c) || c === 0x3d || c === 0x3e || (c === 0x2f && i > nameStart)) {
        break;
      }
      i++;
    }
    const attributeName = html.slice(nameStart, i).toLowerCase();
    while (i < length && isSpace(html.charCodeAt(i))) {
      i++;
    }
    let value = '';
    if (html.charCodeAt(i) === 0x3d /* = */) {
      i++;
      while (i < length && isSpace(html.charCodeAt(i))) {
        i++;
      }
      const quote = html.charCodeAt(i);
      if (quote === 0x22 || quote === 0x27) {
        const close = html.indexOf(String.fromCharCode(quote), i + 1);
        const valueEnd = close < 0 ? length : close;
        value = html.slice(i + 1, valueEnd);
        i = close < 0 ? length : close + 1;
      } else {
        const valueStart = i;
        while (i < length && !isSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== 0x3e) {
          i++;
        }
        value = html.slice(valueStart, i);
      }
    }
    if (attributeName !== '' && !attributes.some((a) => a.name === attributeName)) {
      attributes.push({ name: attributeName, value: decodeEntities(value) });
    }
  }
  return {
    token: { type: 'startTag', name, attributes, selfClosing, raw: html.slice(start) },
    end: length,
  };
}

export function getAttribute(
  token: { readonly attributes: readonly HtmlAttribute[] },
  name: string,
): string | undefined {
  return token.attributes.find((attribute) => attribute.name === name)?.value;
}
