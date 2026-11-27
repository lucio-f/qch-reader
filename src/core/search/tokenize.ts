/** Matches a word: letters, digits and underscores (Unicode-aware). */
export const WORD_PATTERN = /[\p{L}\p{N}_]+/gu;
export const MAX_TERM_LENGTH = 64;
const NON_ASCII = /[\u0080-\uffff]/;
const CAMEL_BOUNDARY = /(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u;

/** Lower-cases a word and strips diacritics so that `résumé` matches `resume`. */
export function normalizeWord(word: string): string {
  const lower = word.toLowerCase();
  return NON_ASCII.test(lower) ? lower.normalize('NFKD').replace(/\p{M}/gu, '') : lower;
}

/**
 * Splits an identifier into its camelCase / snake_case parts (`QStringList` → `string`,
 * `list`; `QT_VERSION` → `qt`, `version`). Parts shorter than two characters are dropped.
 */
export function identifierParts(word: string): string[] {
  const parts: string[] = [];
  for (const piece of word.split('_')) {
    for (const part of piece.split(CAMEL_BOUNDARY)) {
      if (part.length >= 2) {
        parts.push(normalizeWord(part));
      }
    }
  }
  return parts;
}

/**
 * Emits the search terms of a text: every word, plus the parts of compound identifiers.
 * Returns the number of words (the document length used for ranking).
 */
export function forEachIndexTerm(text: string, emit: (term: string) => void): number {
  let words = 0;
  for (const match of text.matchAll(WORD_PATTERN)) {
    const word = match[0];
    if (word.length > MAX_TERM_LENGTH) {
      continue;
    }
    words++;
    const term = normalizeWord(word);
    emit(term);
    if (word.length > 3 && (word.includes('_') || CAMEL_BOUNDARY.test(word))) {
      for (const part of identifierParts(word)) {
        if (part !== term) {
          emit(part);
        }
      }
    }
  }
  return words;
}

/** Splits text into normalized words (no identifier parts). */
export function words(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    if (match[0].length <= MAX_TERM_LENGTH) {
      result.push(normalizeWord(match[0]));
    }
  }
  return result;
}
