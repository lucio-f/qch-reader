import type { FilterMatcher } from '../library/filters';
import type { QchLibrary } from '../library/library';
import type { QchFile, QchKeyword } from '../qch/qchFile';

export interface KeywordEntry {
  readonly document: QchFile;
  readonly keyword: QchKeyword;
  readonly lowerName: string;
  readonly lowerIdentifier: string;
}

export interface KeywordHit {
  readonly entry: KeywordEntry;
  /** Matched range within `keyword.name` (-1 when the identifier matched instead). */
  readonly matchStart: number;
  readonly matchLength: number;
  readonly rank: number;
}

export interface KeywordSearchOptions {
  readonly matcher: FilterMatcher;
  readonly limit: number;
  /** Restrict to one document namespace. */
  readonly namespace?: string | undefined;
}

export interface KeywordSearchResult {
  readonly hits: readonly KeywordHit[];
  readonly total: number;
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const before = text.charAt(index - 1);
  return !/[\p{L}\p{N}]/u.test(before);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}`, 'i');
}

/** The combined keyword index of all documents in a library (Qt Assistant's "Index"). */
export class KeywordIndex {
  public readonly entries: readonly KeywordEntry[];
  private exactMap: Map<string, KeywordEntry[]> | undefined;

  public constructor(library: QchLibrary) {
    const entries: KeywordEntry[] = [];
    for (const document of library.documents) {
      for (const keyword of document.keywords) {
        entries.push({
          document,
          keyword,
          lowerName: keyword.name.toLowerCase(),
          lowerIdentifier: keyword.identifier.toLowerCase(),
        });
      }
    }
    this.entries = entries;
  }

  private accepts(entry: KeywordEntry, options: KeywordSearchOptions): boolean {
    return (
      (options.namespace === undefined || entry.document.namespace === options.namespace) &&
      options.matcher.matchesDocument(entry.document) &&
      options.matcher.matchesItem(entry.keyword.attributes)
    );
  }

  /**
   * Finds keywords by name. Exact matches rank first, then prefix, word-boundary and
   * substring matches; identifiers (e.g. `QString::append`) are matched too.
   * `*` and `?` switch to wildcard ("starts with") matching.
   */
  public search(query: string, options: KeywordSearchOptions): KeywordSearchResult {
    const trimmed = query.trim();
    if (trimmed === '') {
      return { hits: [], total: 0 };
    }
    const hits: KeywordHit[] = [];
    if (/[*?]/.test(trimmed)) {
      const pattern = wildcardToRegExp(trimmed);
      for (const entry of this.entries) {
        if (this.accepts(entry, options)) {
          const match = pattern.exec(entry.keyword.name);
          if (match) {
            hits.push({ entry, matchStart: 0, matchLength: match[0].length, rank: 1 });
          }
        }
      }
    } else {
      const needle = trimmed.toLowerCase();
      for (const entry of this.entries) {
        const nameIndex = entry.lowerName.indexOf(needle);
        let rank: number;
        if (nameIndex === 0) {
          rank = entry.lowerName.length === needle.length ? 0 : 2;
        } else if (nameIndex > 0) {
          rank = isBoundary(entry.lowerName, nameIndex) ? 4 : 6;
        } else if (entry.lowerIdentifier !== entry.lowerName) {
          const identifierIndex = entry.lowerIdentifier.indexOf(needle);
          if (identifierIndex < 0) {
            continue;
          }
          rank =
            identifierIndex === 0
              ? entry.lowerIdentifier.length === needle.length
                ? 1
                : 3
              : isBoundary(entry.lowerIdentifier, identifierIndex)
                ? 5
                : 7;
        } else {
          continue;
        }
        if (!this.accepts(entry, options)) {
          continue;
        }
        if (rank <= 1 && entry.keyword.name.includes(trimmed)) {
          rank -= 0.5; // Exact case match first.
        }
        hits.push({
          entry,
          matchStart: nameIndex,
          matchLength: nameIndex >= 0 ? needle.length : 0,
          rank,
        });
      }
    }
    hits.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.entry.keyword.name.length - b.entry.keyword.name.length ||
        (a.entry.lowerName < b.entry.lowerName
          ? -1
          : a.entry.lowerName > b.entry.lowerName
            ? 1
            : 0) ||
        (a.entry.lowerIdentifier < b.entry.lowerIdentifier
          ? -1
          : a.entry.lowerIdentifier > b.entry.lowerIdentifier
            ? 1
            : 0) ||
        a.entry.document.title.localeCompare(b.entry.document.title),
    );
    return { hits: hits.slice(0, options.limit), total: hits.length };
  }

  /**
   * Keywords whose identifier or name equals `symbol` (case-sensitive matches first,
   * falling back to case-insensitive ones). Used for context help and hovers.
   */
  public lookup(symbol: string, matcher: FilterMatcher): KeywordEntry[] {
    if (!this.exactMap) {
      this.exactMap = new Map();
      for (const entry of this.entries) {
        for (const key of new Set([entry.lowerIdentifier, entry.lowerName])) {
          const list = this.exactMap.get(key);
          if (list) {
            list.push(entry);
          } else {
            this.exactMap.set(key, [entry]);
          }
        }
      }
    }
    const candidates = (this.exactMap.get(symbol.toLowerCase()) ?? []).filter(
      (entry) =>
        matcher.matchesDocument(entry.document) && matcher.matchesItem(entry.keyword.attributes),
    );
    const exactCase = candidates.filter(
      (entry) => entry.keyword.identifier === symbol || entry.keyword.name === symbol,
    );
    const result = exactCase.length > 0 ? exactCase : candidates;
    // Prefer identifier matches (they are unique), then entries without anchors (class pages).
    return result.sort(
      (a, b) =>
        Number(b.keyword.identifier === symbol) - Number(a.keyword.identifier === symbol) ||
        Number(a.keyword.anchor !== '') - Number(b.keyword.anchor !== ''),
    );
  }
}
