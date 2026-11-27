export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
}

export interface TableDefinition {
  readonly columns: readonly ColumnInfo[];
  /** Index of the `INTEGER PRIMARY KEY` column that aliases the rowid, or -1. */
  readonly rowidColumn: number;
  readonly withoutRowid: boolean;
}

const CONSTRAINT_KEYWORDS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'NOT',
  'NULL',
  'UNIQUE',
  'CHECK',
  'DEFAULT',
  'COLLATE',
  'REFERENCES',
  'GENERATED',
  'AS',
]);

const TABLE_CONSTRAINT_KEYWORDS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN']);

/** Splits SQL into identifier/keyword/punctuation tokens, keeping quoted identifiers intact. */
function tokenizeSql(sql: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '-' && sql.charAt(i + 1) === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (ch === '/' && sql.charAt(i + 1) === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (ch === '"' || ch === '`' || ch === "'" || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === close) {
          if (close !== ']' && sql.charAt(j + 1) === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      tokens.push(sql.slice(i, j + 1));
      i = j + 1;
    } else if (/[\w$]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[\w$]/.test(sql.charAt(j))) {
        j++;
      }
      tokens.push(sql.slice(i, j));
      i = j;
    } else {
      tokens.push(ch);
      i++;
    }
  }
  return tokens;
}

function unquoteIdentifier(token: string): string {
  const first = token.charAt(0);
  if (first === '[') {
    return token.slice(1, -1);
  }
  if (first === '"' || first === '`' || first === "'") {
    return token.slice(1, -1).replaceAll(first + first, first);
  }
  return token;
}

/** Splits a token list at top-level commas. */
function splitTopLevel(tokens: readonly string[]): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token === '(') {
      depth++;
    } else if (token === ')') {
      depth--;
    } else if (token === ',' && depth === 0) {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

/**
 * Parses the column list of a `CREATE TABLE` statement as stored in `sqlite_schema.sql`.
 * Only what is needed to decode rows is extracted: column names/types, rowid alias and
 * whether the table is `WITHOUT ROWID`.
 */
export function parseCreateTable(sql: string): TableDefinition {
  const tokens = tokenizeSql(sql);
  const open = tokens.indexOf('(');
  if (open < 0) {
    // CREATE TABLE ... AS SELECT: no column list available.
    return { columns: [], rowidColumn: -1, withoutRowid: false };
  }
  let depth = 0;
  let close = -1;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i] === '(') {
      depth++;
    } else if (tokens[i] === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) {
    close = tokens.length;
  }

  const columns: ColumnInfo[] = [];
  const integerPrimaryKeys: number[] = [];
  let tablePrimaryKey: string[] | undefined;

  for (const definition of splitTopLevel(tokens.slice(open + 1, close))) {
    const head = definition[0];
    if (head === undefined) {
      continue;
    }
    const keyword = head.toUpperCase();
    if (TABLE_CONSTRAINT_KEYWORDS.has(keyword) && !/^["`[']/.test(head)) {
      const primary = definition.findIndex((t) => t.toUpperCase() === 'PRIMARY');
      if (primary >= 0 && definition[primary + 1]?.toUpperCase() === 'KEY') {
        const start = definition.indexOf('(', primary);
        const end = definition.indexOf(')', start);
        if (start >= 0 && end > start) {
          tablePrimaryKey = splitTopLevel(definition.slice(start + 1, end)).map((part) =>
            unquoteIdentifier(part[0] ?? '').toLowerCase(),
          );
        }
      }
      continue;
    }

    const name = unquoteIdentifier(head);
    const typeTokens: string[] = [];
    let index = 1;
    while (index < definition.length) {
      const token = definition[index] ?? '';
      if (CONSTRAINT_KEYWORDS.has(token.toUpperCase())) {
        break;
      }
      typeTokens.push(token);
      index++;
    }
    const type = typeTokens.join(' ').replace(/\s*([(),])\s*/g, '$1');
    const rest = definition.slice(index).map((t) => t.toUpperCase());
    const primary = rest.indexOf('PRIMARY');
    if (
      primary >= 0 &&
      rest[primary + 1] === 'KEY' &&
      rest[primary + 2] !== 'DESC' &&
      type.toUpperCase() === 'INTEGER'
    ) {
      integerPrimaryKeys.push(columns.length);
    }
    columns.push({ name, type });
  }

  let rowidColumn = integerPrimaryKeys[0] ?? -1;
  if (rowidColumn < 0 && tablePrimaryKey?.length === 1) {
    const keyName = tablePrimaryKey[0];
    const candidate = columns.findIndex((c) => c.name.toLowerCase() === keyName);
    if (candidate >= 0 && columns[candidate]?.type.toUpperCase() === 'INTEGER') {
      rowidColumn = candidate;
    }
  }

  const trailing = tokens
    .slice(close + 1)
    .map((t) => t.toUpperCase())
    .join(' ');
  const withoutRowid = /\bWITHOUT ROWID\b/.test(trailing);
  return { columns, rowidColumn: withoutRowid ? -1 : rowidColumn, withoutRowid };
}
