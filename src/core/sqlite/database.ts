import type { ByteSource } from './pageSource';
import {
  type SqlValue,
  type TextEncoding,
  SqliteFormatError,
  decodeRecord,
  readUint16,
  readUint32,
  readVarint,
} from './record';
import { type TableDefinition, parseCreateTable } from './schema';

export interface TableInfo {
  readonly name: string;
  readonly rootPage: number;
  readonly definition: TableDefinition;
}

export interface SqliteOpenOptions {
  /** Maximum number of b-tree pages kept in memory. */
  readonly cachePages?: number;
}

const HEADER_MAGIC = 'SQLite format 3\u0000';
const PAGE_INTERIOR_TABLE = 0x05;
const PAGE_LEAF_TABLE = 0x0d;
const MAX_TREE_DEPTH = 64;

interface LeafCell {
  readonly rowid: number;
  readonly payload: Uint8Array;
}

/**
 * A minimal, read-only SQLite 3 database reader written in plain TypeScript.
 *
 * It supports everything needed to read rowid tables of a database file produced by SQLite:
 * table b-trees, overflow pages, all record serial types and the three text encodings.
 * Indexes, WITHOUT ROWID tables and the write-ahead log are not supported.
 */
export class SqliteDatabase {
  private readonly pageCache = new Map<number, Promise<Uint8Array>>();
  private readonly tables = new Map<string, TableInfo>();

  private constructor(
    private readonly source: ByteSource,
    public readonly pageSize: number,
    public readonly usableSize: number,
    public readonly pageCount: number,
    public readonly encoding: TextEncoding,
    private readonly cacheLimit: number,
  ) {}

  public static async open(
    source: ByteSource,
    options: SqliteOpenOptions = {},
  ): Promise<SqliteDatabase> {
    if (source.size < 512) {
      throw new SqliteFormatError('File is too small to be a SQLite database');
    }
    const header = await source.read(0, 100);
    const magic = String.fromCharCode(...header.subarray(0, 16));
    if (magic !== HEADER_MAGIC) {
      throw new SqliteFormatError('Not a SQLite 3 database');
    }
    const rawPageSize = readUint16(header, 16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new SqliteFormatError(`Invalid page size ${rawPageSize}`);
    }
    const readVersion = header[19] ?? 0;
    if (readVersion > 2) {
      throw new SqliteFormatError(`Unsupported file format read version ${readVersion}`);
    }
    const reserved = header[20] ?? 0;
    const changeCounter = readUint32(header, 24);
    const headerPageCount = readUint32(header, 28);
    const versionValidFor = readUint32(header, 92);
    const filePageCount = Math.floor(source.size / pageSize);
    const pageCount =
      headerPageCount > 0 && changeCounter === versionValidFor
        ? Math.min(headerPageCount, filePageCount)
        : filePageCount;

    const encodingCode = readUint32(header, 56);
    const encoding: TextEncoding =
      encodingCode === 2 ? 'utf-16le' : encodingCode === 3 ? 'utf-16be' : 'utf-8';

    const db = new SqliteDatabase(
      source,
      pageSize,
      pageSize - reserved,
      pageCount,
      encoding,
      options.cachePages ?? 1024,
    );
    await db.loadSchema();
    return db;
  }

  public async close(): Promise<void> {
    this.pageCache.clear();
    await this.source.close();
  }

  public get tableNames(): string[] {
    return [...this.tables.values()].map((t) => t.name);
  }

  public getTable(name: string): TableInfo | undefined {
    return this.tables.get(name.toLowerCase());
  }

  /** Reads the given columns of every row of a table (missing columns read as null). */
  public async select(table: string, columns: readonly string[]): Promise<SqlValue[][]> {
    const rows: SqlValue[][] = [];
    await this.forEach(table, columns, (row) => {
      rows.push(row);
    });
    return rows;
  }

  /** Calls `visitor` for every row of a table, in rowid order. */
  public async forEach(
    table: string,
    columns: readonly string[],
    visitor: (row: SqlValue[], rowid: number) => void | Promise<void>,
  ): Promise<void> {
    const info = this.requireTable(table);
    const project = this.projector(info, columns);
    const stack: { page: number; depth: number }[] = [{ page: info.rootPage, depth: 0 }];
    let visited = 0;
    while (stack.length > 0) {
      const { page: pageNumber, depth } = stack.pop() ?? { page: 0, depth: 0 };
      if (depth > MAX_TREE_DEPTH || ++visited > this.pageCount) {
        throw new SqliteFormatError(`Corrupt b-tree in table ${info.name}`);
      }
      const page = await this.readPage(pageNumber);
      const header = pageNumber === 1 ? 100 : 0;
      const type = page[header];
      const cellCount = readUint16(page, header + 3);
      if (type === PAGE_LEAF_TABLE) {
        for (let i = 0; i < cellCount; i++) {
          const cell = await this.readLeafCell(page, readUint16(page, header + 8 + 2 * i));
          await visitor(project(cell), cell.rowid);
        }
      } else if (type === PAGE_INTERIOR_TABLE) {
        stack.push({ page: readUint32(page, header + 8), depth: depth + 1 });
        for (let i = cellCount - 1; i >= 0; i--) {
          const cellOffset = readUint16(page, header + 12 + 2 * i);
          stack.push({ page: readUint32(page, cellOffset), depth: depth + 1 });
        }
      } else {
        throw new SqliteFormatError(
          `Unexpected page type ${String(type)} on page ${pageNumber} of table ${info.name}`,
        );
      }
    }
  }

  /** Looks up a single row by rowid using the b-tree structure (O(log n) page reads). */
  public async getByRowid(
    table: string,
    rowid: number,
    columns: readonly string[],
  ): Promise<SqlValue[] | undefined> {
    const info = this.requireTable(table);
    let pageNumber = info.rootPage;
    for (let depth = 0; depth <= MAX_TREE_DEPTH; depth++) {
      const page = await this.readPage(pageNumber);
      const header = pageNumber === 1 ? 100 : 0;
      const type = page[header];
      const cellCount = readUint16(page, header + 3);
      if (type === PAGE_INTERIOR_TABLE) {
        let lo = 0;
        let hi = cellCount;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          const cellOffset = readUint16(page, header + 12 + 2 * mid);
          const [key] = readVarint(page, cellOffset + 4);
          if (key < rowid) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        pageNumber =
          lo < cellCount
            ? readUint32(page, readUint16(page, header + 12 + 2 * lo))
            : readUint32(page, header + 8);
      } else if (type === PAGE_LEAF_TABLE) {
        let lo = 0;
        let hi = cellCount - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const cellOffset = readUint16(page, header + 8 + 2 * mid);
          const [, afterSize] = readVarint(page, cellOffset);
          const [key] = readVarint(page, afterSize);
          if (key === rowid) {
            const cell = await this.readLeafCell(page, cellOffset);
            return this.projector(info, columns)(cell);
          }
          if (key < rowid) {
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        return undefined;
      } else {
        throw new SqliteFormatError(`Unexpected page type ${String(type)} on page ${pageNumber}`);
      }
    }
    throw new SqliteFormatError(`B-tree of table ${info.name} is too deep`);
  }

  private requireTable(name: string): TableInfo {
    const info = this.getTable(name);
    if (!info) {
      throw new SqliteFormatError(`No such table: ${name}`);
    }
    if (info.definition.withoutRowid) {
      throw new SqliteFormatError(`WITHOUT ROWID tables are not supported: ${name}`);
    }
    return info;
  }

  private projector(info: TableInfo, columns: readonly string[]): (cell: LeafCell) => SqlValue[] {
    const { definition } = info;
    const indexes = columns.map((column) => {
      const lower = column.toLowerCase();
      const index = definition.columns.findIndex((c) => c.name.toLowerCase() === lower);
      if (index >= 0 && index === definition.rowidColumn) {
        return -2;
      }
      if (index < 0 && (lower === 'rowid' || lower === 'oid' || lower === '_rowid_')) {
        return -2;
      }
      return index;
    });
    return (cell) => {
      const values = decodeRecord(cell.payload, this.encoding);
      return indexes.map((index) => (index === -2 ? cell.rowid : (values[index] ?? null)));
    };
  }

  private async loadSchema(): Promise<void> {
    const schemaInfo: TableInfo = {
      name: 'sqlite_schema',
      rootPage: 1,
      definition: {
        columns: [
          { name: 'type', type: 'TEXT' },
          { name: 'name', type: 'TEXT' },
          { name: 'tbl_name', type: 'TEXT' },
          { name: 'rootpage', type: 'INTEGER' },
          { name: 'sql', type: 'TEXT' },
        ],
        rowidColumn: -1,
        withoutRowid: false,
      },
    };
    this.tables.set('sqlite_schema', schemaInfo);
    this.tables.set('sqlite_master', schemaInfo);
    const rows = await this.select('sqlite_schema', ['type', 'name', 'rootpage', 'sql']);
    for (const [type, name, rootPage, sql] of rows) {
      if (
        type === 'table' &&
        typeof name === 'string' &&
        typeof rootPage === 'number' &&
        typeof sql === 'string' &&
        rootPage > 0
      ) {
        this.tables.set(name.toLowerCase(), {
          name,
          rootPage,
          definition: parseCreateTable(sql),
        });
      }
    }
  }

  private async readLeafCell(page: Uint8Array, cellOffset: number): Promise<LeafCell> {
    const [payloadSize, afterSize] = readVarint(page, cellOffset);
    const [rowid, payloadStart] = readVarint(page, afterSize);
    return { rowid, payload: await this.readPayload(page, payloadStart, payloadSize) };
  }

  /** Reassembles a table-leaf payload, following the overflow page chain when needed. */
  private async readPayload(page: Uint8Array, start: number, size: number): Promise<Uint8Array> {
    const usable = this.usableSize;
    const maxLocal = usable - 35;
    if (size <= maxLocal) {
      if (start + size > page.byteLength) {
        throw new SqliteFormatError('Cell payload exceeds page');
      }
      return page.subarray(start, start + size);
    }
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
    const candidate = minLocal + ((size - minLocal) % (usable - 4));
    const local = candidate <= maxLocal ? candidate : minLocal;

    const payload = new Uint8Array(size);
    payload.set(page.subarray(start, start + local));
    let written = local;
    let overflowPage = readUint32(page, start + local);
    let hops = 0;
    while (written < size) {
      if (overflowPage === 0 || overflowPage > this.pageCount || ++hops > this.pageCount) {
        throw new SqliteFormatError('Broken overflow page chain');
      }
      const overflow = await this.source.read((overflowPage - 1) * this.pageSize, this.pageSize);
      const chunk = Math.min(size - written, usable - 4);
      payload.set(overflow.subarray(4, 4 + chunk), written);
      written += chunk;
      overflowPage = readUint32(overflow, 0);
    }
    return payload;
  }

  private async readPage(pageNumber: number): Promise<Uint8Array> {
    if (pageNumber < 1 || pageNumber > this.pageCount) {
      throw new SqliteFormatError(`Page ${pageNumber} out of range`);
    }
    const cached = this.pageCache.get(pageNumber);
    if (cached) {
      // Refresh LRU position.
      this.pageCache.delete(pageNumber);
      this.pageCache.set(pageNumber, cached);
      return cached;
    }
    const pending = this.source.read((pageNumber - 1) * this.pageSize, this.pageSize);
    this.pageCache.set(pageNumber, pending);
    pending.catch(() => this.pageCache.delete(pageNumber));
    if (this.pageCache.size > this.cacheLimit) {
      const oldest = this.pageCache.keys().next();
      if (!oldest.done) {
        this.pageCache.delete(oldest.value);
      }
    }
    return pending;
  }
}
