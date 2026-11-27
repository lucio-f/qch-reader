import type { HighlightTerm } from './queryParser';
import { MAX_TERM_LENGTH, WORD_PATTERN, identifierParts, normalizeWord } from './tokenize';

/** A piece of text that is either plain or a highlighted match. */
export interface TextSegment {
  readonly text: string;
  readonly match: boolean;
}

interface MatchRange {
  readonly start: number;
  readonly end: number;
  readonly term: string;
}

function termMatches(word: string, term: HighlightTerm): boolean {
  return term.prefix ? word.startsWith(term.term) : word === term.term;
}

/** Finds the ranges of `text` matching the terms (whole words or identifier parts). */
export function findMatches(text: string, terms: readonly HighlightTerm[]): MatchRange[] {
  if (terms.length === 0) {
    return [];
  }
  const ranges: MatchRange[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const word = match[0];
    if (word.length > MAX_TERM_LENGTH) {
      continue;
    }
    const start = match.index;
    const normalized = normalizeWord(word);
    const whole = terms.find((term) => termMatches(normalized, term));
    if (whole) {
      ranges.push({ start, end: start + word.length, term: whole.term });
      continue;
    }
    if (word.length <= 3) {
      continue;
    }
    // Highlight identifier parts, e.g. "Text" inside "setText".
    let searchFrom = 0;
    const lowerWord = word.toLowerCase();
    for (const part of identifierParts(word)) {
      const offset = lowerWord.indexOf(part, searchFrom);
      if (offset < 0) {
        continue;
      }
      searchFrom = offset + part.length;
      const term = terms.find((t) => termMatches(part, t));
      if (term) {
        ranges.push({ start: start + offset, end: start + offset + part.length, term: term.term });
      }
    }
  }
  return ranges;
}

export function toSegments(text: string, ranges: readonly MatchRange[]): TextSegment[] {
  const segments: TextSegment[] = [];
  let position = 0;
  for (const range of ranges) {
    if (range.start < position) {
      continue;
    }
    if (range.start > position) {
      segments.push({ text: text.slice(position, range.start), match: false });
    }
    segments.push({ text: text.slice(range.start, range.end), match: true });
    position = range.end;
  }
  if (position < text.length) {
    segments.push({ text: text.slice(position), match: false });
  }
  return segments;
}

export function highlight(text: string, terms: readonly HighlightTerm[]): TextSegment[] {
  return toSegments(text, findMatches(text, terms));
}

/**
 * Picks the window of `text` (about `length` characters) containing the most distinct
 * query terms and returns it as highlighted segments, with ellipses where cut.
 */
export function makeSnippet(
  text: string,
  terms: readonly HighlightTerm[],
  length = 240,
): TextSegment[] {
  const matches = findMatches(text, terms);
  let start = 0;
  if (matches.length > 0) {
    let bestScore = -1;
    let right = 0;
    const counts = new Map<string, number>();
    for (let left = 0; left < matches.length; left++) {
      const leftMatch = matches[left];
      if (!leftMatch) {
        break;
      }
      while (
        right < matches.length &&
        (matches[right]?.end ?? 0) - leftMatch.start <= length * 0.8
      ) {
        const term = matches[right]?.term ?? '';
        counts.set(term, (counts.get(term) ?? 0) + 1);
        right++;
      }
      const score = counts.size * 1000 + (right - left);
      if (score > bestScore) {
        bestScore = score;
        start = leftMatch.start;
      }
      const term = leftMatch.term;
      const remaining = (counts.get(term) ?? 1) - 1;
      if (remaining === 0) {
        counts.delete(term);
      } else {
        counts.set(term, remaining);
      }
    }
    // Leave some context before the first match.
    start = Math.max(0, start - Math.floor(length * 0.2));
  }
  let end = Math.min(text.length, start + length);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space >= 0 && space - start < 20) {
      start = space + 1;
    }
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > start + length / 2) {
      end = space;
    }
  }
  const window = text.slice(start, end);
  const segments = highlight(window, terms);
  if (start > 0) {
    segments.unshift({ text: '…', match: false });
  }
  if (end < text.length) {
    segments.push({ text: '…', match: false });
  }
  return segments;
}
