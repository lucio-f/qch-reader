import type { FilterMatcher } from '../library/filters';
import type { QchFile, QchFileEntry } from '../qch/qchFile';
import type { FullTextIndex } from './fullTextIndex';
import type { KeywordIndex } from './keywordSearch';
import type { ParsedQuery, QueryNode } from './queryParser';
import { words } from './tokenize';

export interface FullTextHit {
  readonly document: QchFile;
  readonly entry: QchFileEntry;
  readonly score: number;
}

export interface FullTextResult {
  readonly hits: readonly FullTextHit[];
  /** Number of matching pages (after phrase verification). */
  readonly total: number;
  /** True when phrase verification stopped early; `total` is then a lower bound. */
  readonly truncated: boolean;
}

export interface FullTextSearchOptions {
  readonly matcher: FilterMatcher;
  readonly limit: number;
  /** Restrict to one document namespace. */
  readonly namespace?: string | undefined;
  /** Used to boost pages that are the target of an exactly matching keyword. */
  readonly keywords?: KeywordIndex | undefined;
  /** Loads a page's plain text; required to verify phrases. */
  readonly loadText?: ((document: QchFile, entry: QchFileEntry) => Promise<string>) | undefined;
  /** Maximum number of candidate pages whose text is loaded to verify phrases. */
  readonly maxPhraseChecks?: number;
}

const K1 = 1.2;
const B = 0.75;
const TITLE_FIELD_SCORE = 8;
const MAX_PREFIX_EXPANSION = 64;

type Scores = Map<number, number>;

interface IndexContext {
  readonly document: QchFile;
  readonly index: FullTextIndex;
  readonly entries: readonly (QchFileEntry | undefined)[];
  readonly allowed: Uint8Array;
  titleWords?: readonly (readonly string[])[];
}

class Evaluator {
  private readonly globalFrequency = new Map<string, number>();
  private readonly totalDocuments: number;
  private readonly averageLength: number;
  public readonly requiredPhrases: string[][] = [];

  public constructor(private readonly contexts: readonly IndexContext[]) {
    let documents = 0;
    let words = 0;
    for (const { index } of contexts) {
      documents += index.documentCount;
      words += index.averageLength * index.documentCount;
    }
    this.totalDocuments = Math.max(documents, 1);
    this.averageLength = documents > 0 ? words / documents : 1;
  }

  private documentFrequency(term: string): number {
    let frequency = this.globalFrequency.get(term);
    if (frequency === undefined) {
      frequency = 0;
      for (const { index } of this.contexts) {
        const termIndex = index.findTerm(term);
        if (termIndex >= 0) {
          frequency += index.documentFrequency(termIndex);
        }
      }
      this.globalFrequency.set(term, frequency);
    }
    return frequency;
  }

  private idf(term: string): number {
    const df = this.documentFrequency(term);
    return Math.log(1 + (this.totalDocuments - df + 0.5) / (df + 0.5));
  }

  private titleWords(context: IndexContext): readonly (readonly string[])[] {
    context.titleWords ??= context.entries.map((entry) => words(entry?.title ?? ''));
    return context.titleWords;
  }

  private universe(context: IndexContext): Scores {
    const scores: Scores = new Map();
    context.allowed.forEach((allowed, docIndex) => {
      if (allowed) {
        scores.set(docIndex, 0.001);
      }
    });
    return scores;
  }

  public evaluate(node: QueryNode, context: IndexContext, required: boolean): Scores {
    switch (node.kind) {
      case 'term':
        return node.field === 'title'
          ? this.titleTerm(node.term, node.prefix, context)
          : this.term(node.term, node.prefix, context);
      case 'phrase': {
        if (node.field === 'title') {
          const phrase = ` ${node.terms.join(' ')} `;
          const scores: Scores = new Map();
          this.titleWords(context).forEach((title, docIndex) => {
            if (context.allowed[docIndex] && ` ${title.join(' ')} `.includes(phrase)) {
              scores.set(docIndex, TITLE_FIELD_SCORE * node.terms.length);
            }
          });
          return scores;
        }
        if (required && !this.requiredPhrases.some((p) => p.join(' ') === node.terms.join(' '))) {
          this.requiredPhrases.push([...node.terms]);
        }
        return this.intersect(node.terms.map((term) => this.term(term, false, context)));
      }
      case 'and': {
        const positive: Scores[] = [];
        const negative: Scores[] = [];
        for (const child of node.children) {
          if (child.kind === 'not') {
            negative.push(this.evaluate(child.child, context, false));
          } else {
            positive.push(this.evaluate(child, context, required));
          }
        }
        const result = positive.length > 0 ? this.intersect(positive) : this.universe(context);
        for (const excluded of negative) {
          for (const docIndex of excluded.keys()) {
            result.delete(docIndex);
          }
        }
        return result;
      }
      case 'or': {
        const result: Scores = new Map();
        for (const child of node.children) {
          for (const [docIndex, score] of this.evaluate(child, context, false)) {
            result.set(docIndex, (result.get(docIndex) ?? 0) + score);
          }
        }
        return result;
      }
      case 'not': {
        const result = this.universe(context);
        for (const docIndex of this.evaluate(node.child, context, false).keys()) {
          result.delete(docIndex);
        }
        return result;
      }
    }
  }

  private term(term: string, prefix: boolean, context: IndexContext): Scores {
    const { index, allowed } = context;
    const scores: Scores = new Map();
    const termIndexes = prefix
      ? index.termsWithPrefix(term, MAX_PREFIX_EXPANSION)
      : [index.findTerm(term)].filter((i) => i >= 0);
    for (const termIndex of termIndexes) {
      const idf = this.idf(index.terms[termIndex] ?? term);
      // Expanded prefix terms count a little less than exact ones.
      const weight = prefix && index.terms[termIndex] !== term ? 0.8 : 1;
      index.forEachPosting(termIndex, (docIndex, tf) => {
        if (!allowed[docIndex]) {
          return;
        }
        const length = index.lengths[docIndex] ?? 0;
        const score =
          (weight * idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / this.averageLength));
        scores.set(docIndex, Math.max(scores.get(docIndex) ?? 0, score));
      });
    }
    return scores;
  }

  private titleTerm(term: string, prefix: boolean, context: IndexContext): Scores {
    const scores: Scores = new Map();
    this.titleWords(context).forEach((title, docIndex) => {
      if (
        context.allowed[docIndex] &&
        title.some((word) => (prefix ? word.startsWith(term) : word === term))
      ) {
        scores.set(docIndex, TITLE_FIELD_SCORE);
      }
    });
    return scores;
  }

  private intersect(sets: readonly Scores[]): Scores {
    const ordered = [...sets].sort((a, b) => a.size - b.size);
    const [smallest, ...rest] = ordered;
    const result: Scores = new Map();
    if (!smallest) {
      return result;
    }
    for (const [docIndex, score] of smallest) {
      let total = score;
      let matched = true;
      for (const other of rest) {
        const value = other.get(docIndex);
        if (value === undefined) {
          matched = false;
          break;
        }
        total += value;
      }
      if (matched) {
        result.set(docIndex, total);
      }
    }
    return result;
  }
}

function positiveTerms(node: QueryNode | undefined, out: string[] = []): string[] {
  if (!node) {
    return out;
  }
  switch (node.kind) {
    case 'term':
      out.push(node.term);
      break;
    case 'phrase':
      out.push(...node.terms);
      break;
    case 'and':
    case 'or':
      node.children.forEach((child) => positiveTerms(child, out));
      break;
    case 'not':
      break;
  }
  return out;
}

/** Normalizes text to space-separated lower-case words, for phrase matching. */
export function phraseText(text: string): string {
  return ` ${words(text).join(' ')} `;
}

export function documentMatchesScope(document: QchFile, scopes: readonly string[]): boolean {
  if (scopes.length === 0) {
    return true;
  }
  const haystacks = [document.namespace, document.title, document.component, document.location].map(
    (s) => s.toLowerCase(),
  );
  return scopes.every((scope) => {
    const needle = scope.toLowerCase();
    return haystacks.some((haystack) => haystack.includes(needle));
  });
}

/**
 * Runs a parsed query against the full-text indexes of the given documents and ranks the
 * matching pages with BM25 (global statistics across documents), boosting title and
 * keyword matches. Phrases are verified against the page text.
 */
export async function searchFullText(
  indexes: ReadonlyMap<QchFile, FullTextIndex>,
  query: ParsedQuery,
  options: FullTextSearchOptions,
): Promise<FullTextResult> {
  const root = query.root;
  if (!root) {
    return { hits: [], total: 0, truncated: false };
  }

  const contexts: IndexContext[] = [];
  for (const [document, index] of indexes) {
    if (
      (options.namespace !== undefined && document.namespace !== options.namespace) ||
      !options.matcher.matchesDocument(document) ||
      !documentMatchesScope(document, query.scopes)
    ) {
      continue;
    }
    const entries = Array.from(index.fileIds, (fileId) => document.getFile(fileId));
    const allowed = new Uint8Array(entries.length);
    entries.forEach((entry, docIndex) => {
      allowed[docIndex] = entry && options.matcher.matchesItem(entry.attributes) ? 1 : 0;
    });
    contexts.push({ document, index, entries, allowed });
  }

  const evaluator = new Evaluator(contexts);
  const terms = [...new Set(positiveTerms(root))];
  const queryText = terms.join(' ');
  const keywordTargets = new Set<string>();
  if (options.keywords && terms.length > 0) {
    const symbol = query.highlights.map((h) => h.term).join('::');
    for (const candidate of new Set([queryText, symbol, terms.join('')])) {
      for (const entry of options.keywords.lookup(candidate, options.matcher)) {
        keywordTargets.add(`${entry.document.namespace}\u0000${String(entry.keyword.fileId)}`);
      }
    }
  }

  const candidates: FullTextHit[] = [];
  for (const context of contexts) {
    const scores = evaluator.evaluate(root, context, true);
    for (const [docIndex, baseScore] of scores) {
      const entry = context.entries[docIndex];
      if (!entry) {
        continue;
      }
      let score = baseScore;
      const titleWords = words(entry.title);
      if (terms.length > 0 && terms.every((term) => titleWords.includes(term))) {
        score *= 1.6;
        if (titleWords.slice(0, terms.length).join(' ') === queryText) {
          score *= 1.4;
        }
      }
      if (keywordTargets.has(`${context.document.namespace}\u0000${String(entry.fileId)}`)) {
        score *= 2;
      }
      candidates.push({ document: context.document, entry, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));

  const phrases = evaluator.requiredPhrases.map((terms) => ` ${terms.join(' ')} `);
  if (phrases.length === 0 || !options.loadText) {
    return { hits: candidates.slice(0, options.limit), total: candidates.length, truncated: false };
  }

  const maxChecks = options.maxPhraseChecks ?? 400;
  const verified: FullTextHit[] = [];
  let checked = 0;
  for (const candidate of candidates) {
    if (checked >= maxChecks) {
      break;
    }
    checked++;
    const text = phraseText(await options.loadText(candidate.document, candidate.entry));
    if (phrases.every((phrase) => text.includes(phrase))) {
      verified.push(candidate);
    }
  }
  return {
    hits: verified.slice(0, options.limit),
    total: verified.length,
    truncated: checked < candidates.length,
  };
}
