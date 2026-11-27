import { SqliteDatabase } from '../sqlite/database';
import type { ByteSource } from '../sqlite/pageSource';
import type { SqlValue } from '../sqlite/record';
import { qUncompress, qUncompressSync } from './decompress';
import { decodeContents } from './qdatastream';

/** An interned, immutable set of legacy filter attribute names. */
export type AttributeSet = ReadonlySet<string>;

export const EMPTY_ATTRIBUTES: AttributeSet = new Set<string>();

export interface QchFileEntry {
  /** Row id in FileDataTable. */
  readonly fileId: number;
  /** Virtual folder the file lives in. */
  readonly folder: string;
  /** Path relative to the virtual folder, e.g. `qstring.html` or `images/logo.png`. */
  readonly path: string;
  readonly title: string;
  readonly attributes: AttributeSet;
}

export interface QchKeyword {
  /** Display name in the keyword index (e.g. `append`). */
  readonly name: string;
  /** Unique identifier (e.g. `QString::append`); may equal `name`. */
  readonly identifier: string;
  readonly fileId: number;
  readonly anchor: string;
  readonly attributes: AttributeSet;
}

export interface TocItem {
  readonly title: string;
  /** Reference relative to the virtual folder root, possibly with a `#fragment`. */
  readonly ref: string;
  readonly children: readonly TocItem[];
}

export interface QchContentsSection {
  readonly attributes: AttributeSet;
  readonly items: readonly TocItem[];
}

export interface QchCustomFilter {
  readonly name: string;
  readonly attributes: readonly string[];
}

export class QchFormatError extends Error {
  public override readonly name = 'QchFormatError';
}

const REQUIRED_TABLES = ['NamespaceTable', 'FolderTable', 'FileNameTable', 'FileDataTable'];

function asString(value: SqlValue | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

function asNumber(value: SqlValue | undefined): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Normalizes a stored file path: forward slashes, no leading `./` or `/`, no empty segments. */
export function normalizeStoredPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

export function isHtmlPath(path: string): boolean {
  return /\.(?:x?html?|xht)$/i.test(path);
}

/**
 * Port of Qt's `QHelpDBReader::qtVersionHeuristic()`: derives a version such as `6.4.2` from
 * namespaces like `org.qt-project.qtcore.642`.
 */
export function versionFromNamespace(namespace: string): string {
  if (!namespace.startsWith('org.qt-project.')) {
    return '';
  }
  let tail = '';
  for (let i = namespace.length - 1; i >= 0; i--) {
    const ch = namespace.charAt(i);
    if (/[0-9.]/.test(ch)) {
      tail = ch + tail;
    } else if (/\p{L}/u.test(ch)) {
      break;
    }
  }
  if (!tail.startsWith('.') && tail.split('.').length === 2) {
    tail = tail.slice(tail.indexOf('.') + 1);
  }
  if (tail.startsWith('.')) {
    tail = tail.slice(1);
  }
  if (!/^\d+$/.test(tail)) {
    return '';
  }
  switch (tail.length) {
    case 3:
      return `${tail[0]}.${tail[1]}.${tail[2]}`;
    case 4:
      return `${tail[0]}.${tail.slice(1, 3)}.${tail[3]}`;
    case 5:
      return `${tail[0]}.${tail.slice(1, 3)}.${tail.slice(3)}`;
    default:
      return '';
  }
}

/** Builds a tree from the depth-annotated flat list stored in ContentsTable. */
export function buildToc(
  entries: readonly { depth: number; ref: string; title: string }[],
): TocItem[] {
  interface MutableItem {
    title: string;
    ref: string;
    children: MutableItem[];
  }
  const roots: MutableItem[] = [];
  const stack: MutableItem[] = [];
  for (const entry of entries) {
    const item: MutableItem = { title: entry.title, ref: entry.ref, children: [] };
    while (stack.length > entry.depth) {
      stack.pop();
    }
    const parent = stack.at(-1);
    if (entry.depth === 0 || !parent) {
      roots.push(item);
    } else {
      parent.children.push(item);
    }
    stack.push(item);
  }
  return roots;
}

class AttributeInterner {
  private readonly sets = new Map<string, AttributeSet>([['', EMPTY_ATTRIBUTES]]);

  public intern(names: Iterable<string>): AttributeSet {
    const sorted = [...new Set(names)].sort();
    const key = sorted.join('\u0000');
    let set = this.sets.get(key);
    if (!set) {
      set = new Set(sorted);
      this.sets.set(key, set);
    }
    return set;
  }
}

function groupAttributes(
  rows: readonly SqlValue[][],
  attributeNames: ReadonlyMap<number, string>,
): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const [attributeId, itemId] of rows) {
    const name = attributeNames.get(asNumber(attributeId));
    if (name === undefined) {
      continue;
    }
    const id = asNumber(itemId);
    const list = grouped.get(id);
    if (list) {
      list.push(name);
    } else {
      grouped.set(id, [name]);
    }
  }
  return grouped;
}

/** A Qt Compressed Help (.qch) file: a SQLite database holding compressed documentation. */
export class QchFile {
  private readonly filesById = new Map<number, QchFileEntry>();
  private readonly filesByPath = new Map<string, QchFileEntry>();
  private readonly filesByLowerPath = new Map<string, QchFileEntry>();

  private constructor(
    private readonly db: SqliteDatabase,
    /** Where the file was loaded from (file system path or URI string). */
    public readonly location: string,
    public readonly namespace: string,
    public readonly folders: readonly string[],
    public readonly metadata: ReadonlyMap<string, string>,
    public readonly filterAttributes: readonly string[],
    public readonly customFilters: readonly QchCustomFilter[],
    public readonly files: readonly QchFileEntry[],
    public readonly keywords: readonly QchKeyword[],
    public readonly contents: readonly QchContentsSection[],
  ) {
    for (const file of files) {
      this.filesById.set(file.fileId, file);
      const key = `${file.folder}/${file.path}`;
      if (!this.filesByPath.has(key)) {
        this.filesByPath.set(key, file);
      }
      const lower = key.toLowerCase();
      if (!this.filesByLowerPath.has(lower)) {
        this.filesByLowerPath.set(lower, file);
      }
    }
  }

  public static async open(source: ByteSource, location: string): Promise<QchFile> {
    const db = await SqliteDatabase.open(source);
    try {
      return await QchFile.load(db, location);
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  private static async load(db: SqliteDatabase, location: string): Promise<QchFile> {
    for (const table of REQUIRED_TABLES) {
      if (!db.getTable(table)) {
        throw new QchFormatError(`Not a Qt Compressed Help file (missing ${table})`);
      }
    }
    const optional = async (table: string, columns: readonly string[]): Promise<SqlValue[][]> =>
      db.getTable(table) ? db.select(table, columns) : [];

    const [
      namespaceRows,
      folderRows,
      metadataRows,
      attributeRows,
      filterNameRows,
      filterRows,
      fileNameRows,
      fileFilterRows,
      indexRows,
      indexFilterRows,
      contentsRows,
      contentsFilterRows,
    ] = await Promise.all([
      db.select('NamespaceTable', ['Id', 'Name']),
      db.select('FolderTable', ['Id', 'Name', 'NamespaceId']),
      optional('MetaDataTable', ['Name', 'Value']),
      optional('FilterAttributeTable', ['Id', 'Name']),
      optional('FilterNameTable', ['Id', 'Name']),
      optional('FilterTable', ['NameId', 'FilterAttributeId']),
      db.select('FileNameTable', ['FolderId', 'Name', 'FileId', 'Title']),
      optional('FileFilterTable', ['FilterAttributeId', 'FileId']),
      optional('IndexTable', ['Id', 'Name', 'Identifier', 'NamespaceId', 'FileId', 'Anchor']),
      optional('IndexFilterTable', ['FilterAttributeId', 'IndexId']),
      optional('ContentsTable', ['Id', 'NamespaceId', 'Data']),
      optional('ContentsFilterTable', ['FilterAttributeId', 'ContentsId']),
    ]);

    const namespaceRow = namespaceRows[0];
    const namespace = asString(namespaceRow?.[1]).trim();
    if (!namespace) {
      throw new QchFormatError('The help file does not declare a namespace');
    }

    const folderNames = new Map<number, string>();
    for (const [id, name] of folderRows) {
      folderNames.set(asNumber(id), normalizeStoredPath(asString(name)));
    }

    const metadata = new Map<string, string>();
    for (const [name, value] of metadataRows) {
      metadata.set(asString(name), asString(value));
    }

    const attributeNames = new Map<number, string>();
    for (const [id, name] of attributeRows) {
      attributeNames.set(asNumber(id), asString(name));
    }

    const filterNames = new Map<number, string>();
    for (const [id, name] of filterNameRows) {
      filterNames.set(asNumber(id), asString(name));
    }
    const customFilterAttributes = groupAttributes(
      filterRows.map(([nameId, attributeId]) => [attributeId ?? null, nameId ?? null]),
      attributeNames,
    );
    const customFilters: QchCustomFilter[] = [...filterNames]
      .map(([id, name]) => ({ name, attributes: customFilterAttributes.get(id)?.sort() ?? [] }))
      .filter((filter) => filter.name !== '')
      .sort((a, b) => a.name.localeCompare(b.name));

    const interner = new AttributeInterner();
    const fileAttributes = groupAttributes(fileFilterRows, attributeNames);
    const files: QchFileEntry[] = [];
    for (const [folderId, name, fileId, title] of fileNameRows) {
      const folder = folderNames.get(asNumber(folderId));
      const path = normalizeStoredPath(asString(name));
      if (folder === undefined || path === '') {
        continue;
      }
      const id = asNumber(fileId);
      files.push({
        fileId: id,
        folder,
        path,
        title: asString(title).trim(),
        attributes: interner.intern(fileAttributes.get(id) ?? []),
      });
    }

    const keywordAttributes = groupAttributes(indexFilterRows, attributeNames);
    const keywords: QchKeyword[] = [];
    for (const [id, name, identifier, , fileId, anchor] of indexRows) {
      const keywordName = asString(name);
      const keywordIdentifier = asString(identifier);
      if (!keywordName && !keywordIdentifier) {
        continue;
      }
      keywords.push({
        name: keywordName || keywordIdentifier,
        identifier: keywordIdentifier || keywordName,
        fileId: asNumber(fileId),
        anchor: asString(anchor),
        attributes: interner.intern(keywordAttributes.get(asNumber(id)) ?? []),
      });
    }

    const contentsAttributes = groupAttributes(contentsFilterRows, attributeNames);
    const contents: QchContentsSection[] = [];
    for (const [id, , data] of contentsRows) {
      if (!(data instanceof Uint8Array)) {
        continue;
      }
      contents.push({
        attributes: interner.intern(contentsAttributes.get(asNumber(id)) ?? []),
        items: buildToc(decodeContents(data)),
      });
    }

    return new QchFile(
      db,
      location,
      namespace,
      [...folderNames.values()].filter((name) => name !== ''),
      metadata,
      [...new Set(attributeNames.values())].sort(),
      customFilters,
      files,
      keywords,
      contents,
    );
  }

  /** The primary virtual folder, which Qt's filter engine calls the "component". */
  public get component(): string {
    return this.folders[0] ?? '';
  }

  public get version(): string {
    const declared = this.metadata.get('version')?.trim() ?? '';
    return declared !== '' ? declared : versionFromNamespace(this.namespace);
  }

  /** A human-readable title: the first top-level table-of-contents entry, or the namespace. */
  public get title(): string {
    for (const section of this.contents) {
      const first = section.items[0]?.title.trim();
      if (first) {
        return first;
      }
    }
    return this.namespace;
  }

  public getFile(fileId: number): QchFileEntry | undefined {
    return this.filesById.get(fileId);
  }

  /** Finds a file by virtual folder and path (case-sensitive first, then case-insensitive). */
  public findFile(folder: string, path: string): QchFileEntry | undefined {
    const key = `${folder}/${path}`;
    return this.filesByPath.get(key) ?? this.filesByLowerPath.get(key.toLowerCase());
  }

  /** Reads and decompresses a file's content. */
  public async readFileData(fileId: number): Promise<Uint8Array> {
    const row = await this.db.getByRowid('FileDataTable', fileId, ['Data']);
    const data = row?.[0];
    return data instanceof Uint8Array ? qUncompress(data) : new Uint8Array(0);
  }

  /** Streams every stored file (decompressed synchronously; intended for worker threads). */
  public async forEachFileData(
    visitor: (fileId: number, data: Uint8Array) => void | Promise<void>,
    accept: (fileId: number) => boolean = () => true,
  ): Promise<void> {
    await this.db.forEach('FileDataTable', ['Data'], async (row, rowid) => {
      const data = row[0];
      if (data instanceof Uint8Array && accept(rowid)) {
        await visitor(rowid, qUncompressSync(data));
      }
    });
  }

  public async close(): Promise<void> {
    await this.db.close();
  }
}
