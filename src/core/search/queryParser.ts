import { MAX_TERM_LENGTH, WORD_PATTERN, normalizeWord } from './tokenize';

export type QueryField = 'any' | 'title';

export type QueryNode =
  | {
      readonly kind: 'term';
      readonly term: string;
      readonly prefix: boolean;
      readonly field: QueryField;
    }
  | { readonly kind: 'phrase'; readonly terms: readonly string[]; readonly field: QueryField }
  | { readonly kind: 'and'; readonly children: readonly QueryNode[] }
  | { readonly kind: 'or'; readonly children: readonly QueryNode[] }
  | { readonly kind: 'not'; readonly child: QueryNode };

export interface HighlightTerm {
  readonly term: string;
  readonly prefix: boolean;
}

export interface ParsedQuery {
  readonly root: QueryNode | undefined;
  /** Values of `doc:` / `in:` qualifiers restricting the searched documents. */
  readonly scopes: readonly string[];
  /** Positive terms, for highlighting results. */
  readonly highlights: readonly HighlightTerm[];
}

type Token =
  | { readonly kind: 'open' }
  | { readonly kind: 'close' }
  | { readonly kind: 'or' }
  | { readonly kind: 'not' }
  | { readonly kind: 'word'; readonly text: string; readonly field: string | undefined }
  | { readonly kind: 'phrase'; readonly text: string; readonly field: string | undefined };

const FIELD_PREFIX = /^([a-z]+):(.*)$/is;
const KNOWN_FIELDS = new Set(['title', 'intitle', 'doc', 'in']);

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'open' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'close' });
      i++;
      continue;
    }
    if ((ch === '-' || ch === '!') && i + 1 < input.length && !/\s/.test(input.charAt(i + 1))) {
      tokens.push({ kind: 'not' });
      i++;
      continue;
    }
    if (ch === '"') {
      const close = input.indexOf('"', i + 1);
      const end = close < 0 ? input.length : close;
      tokens.push({ kind: 'phrase', text: input.slice(i + 1, end), field: undefined });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < input.length && !/[\s()"]/.test(input.charAt(j))) {
      j++;
    }
    const text = input.slice(i, j);
    i = j;
    if (text === 'OR' || text === '|' || text === '||') {
      tokens.push({ kind: 'or' });
    } else if (text === 'NOT') {
      tokens.push({ kind: 'not' });
    } else if (text === 'AND' || text === '&&' || text === '+') {
      // Implicit.
    } else {
      const field = FIELD_PREFIX.exec(text);
      const name = field?.[1]?.toLowerCase();
      if (field && name && KNOWN_FIELDS.has(name)) {
        const value = field[2] ?? '';
        if (value === '' && input.charAt(i) === '"') {
          const close = input.indexOf('"', i + 1);
          const end = close < 0 ? input.length : close;
          tokens.push({ kind: 'phrase', text: input.slice(i + 1, end), field: name });
          i = end + 1;
        } else if (value !== '') {
          tokens.push({ kind: 'word', text: value, field: name });
        }
      } else {
        tokens.push({ kind: 'word', text: text.replace(/^\+/, ''), field: undefined });
      }
    }
  }
  return tokens;
}

function toField(field: string | undefined): QueryField {
  return field === 'title' || field === 'intitle' ? 'title' : 'any';
}

/** Builds a term or phrase node from free text (`QString::append` becomes a phrase). */
function textNode(text: string, field: QueryField, allowPrefix: boolean): QueryNode | undefined {
  const prefix = allowPrefix && text.endsWith('*');
  const terms: string[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    if (match[0].length <= MAX_TERM_LENGTH) {
      terms.push(normalizeWord(match[0]));
    }
  }
  const [first] = terms;
  if (first === undefined) {
    return undefined;
  }
  if (terms.length === 1) {
    return { kind: 'term', term: first, prefix, field };
  }
  return { kind: 'phrase', terms, field };
}

class Parser {
  private position = 0;
  public readonly scopes: string[] = [];

  public constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  public parse(): QueryNode | undefined {
    const nodes: QueryNode[] = [];
    while (this.position < this.tokens.length) {
      const node = this.parseOr();
      if (node) {
        nodes.push(node);
      }
      if (this.peek()?.kind === 'close') {
        this.position++; // Unbalanced ')': ignore.
      }
    }
    return combine('and', nodes);
  }

  private parseOr(): QueryNode | undefined {
    const children: QueryNode[] = [];
    const first = this.parseAnd();
    if (first) {
      children.push(first);
    }
    while (this.peek()?.kind === 'or') {
      this.position++;
      const next = this.parseAnd();
      if (next) {
        children.push(next);
      }
    }
    return combine('or', children);
  }

  private parseAnd(): QueryNode | undefined {
    const children: QueryNode[] = [];
    for (let token = this.peek(); token; token = this.peek()) {
      if (token.kind === 'close' || token.kind === 'or') {
        break;
      }
      const node = this.parseUnary();
      if (node) {
        children.push(node);
      }
    }
    return combine('and', children);
  }

  private parseUnary(): QueryNode | undefined {
    const token = this.peek();
    if (token?.kind === 'not') {
      this.position++;
      const child = this.parseUnary();
      return child ? { kind: 'not', child } : undefined;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): QueryNode | undefined {
    const token = this.peek();
    if (!token) {
      return undefined;
    }
    this.position++;
    switch (token.kind) {
      case 'open': {
        const node = this.parseOr();
        if (this.peek()?.kind === 'close') {
          this.position++;
        }
        return node;
      }
      case 'word':
        if (token.field === 'doc' || token.field === 'in') {
          this.scopes.push(token.text);
          return undefined;
        }
        return textNode(token.text, toField(token.field), true);
      case 'phrase': {
        if (token.field === 'doc' || token.field === 'in') {
          this.scopes.push(token.text);
          return undefined;
        }
        const node = textNode(token.text, toField(token.field), false);
        return node?.kind === 'term' ? { ...node, prefix: false } : node;
      }
      case 'close':
      case 'or':
      case 'not':
        return undefined;
    }
  }
}

function combine(kind: 'and' | 'or', children: QueryNode[]): QueryNode | undefined {
  if (children.length === 0) {
    return undefined;
  }
  if (children.length === 1) {
    return children[0];
  }
  // Flatten nested nodes of the same kind.
  const flat = children.flatMap((child) => (child.kind === kind ? child.children : [child]));
  return { kind, children: flat };
}

function collectHighlights(node: QueryNode | undefined, out: HighlightTerm[]): void {
  if (!node) {
    return;
  }
  switch (node.kind) {
    case 'term':
      out.push({ term: node.term, prefix: node.prefix });
      break;
    case 'phrase':
      out.push(...node.terms.map((term) => ({ term, prefix: false })));
      break;
    case 'and':
    case 'or':
      node.children.forEach((child) => {
        collectHighlights(child, out);
      });
      break;
    case 'not':
      break;
  }
}

/**
 * Parses a full-text query. Supported syntax:
 * `word`, `prefix*`, `"exact phrase"`, `-excluded` / `NOT word`, `a OR b`, `( … )`,
 * `title:word`, `title:"phrase"` and `doc:name` (restrict to matching documents).
 * Terms are combined with AND by default.
 */
export function parseQuery(input: string): ParsedQuery {
  const parser = new Parser(lex(input));
  const root = parser.parse();
  const highlights: HighlightTerm[] = [];
  collectHighlights(root, highlights);
  const unique = new Map(highlights.map((h) => [`${h.term}\u0000${String(h.prefix)}`, h]));
  return { root, scopes: parser.scopes, highlights: [...unique.values()] };
}
