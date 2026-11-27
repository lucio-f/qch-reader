import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteDatabase } from '../src/core/sqlite/database';
import { FileByteSource, MemoryByteSource } from '../src/core/sqlite/pageSource';
import { type SqlValue, decodeRecord, readVarint } from '../src/core/sqlite/record';
import { parseCreateTable } from '../src/core/sqlite/schema';
import { FIXTURES, externalQchFiles, nodeSqlite } from './helpers';

function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `blob:${Buffer.from(value).toString('hex')}`;
  }
  if (
    typeof value === 'bigint' &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return value;
}

/** Compares every table of a database file with Node's built-in SQLite. */
async function compareWithReference(file: string): Promise<number> {
  if (!nodeSqlite) {
    throw new Error('node:sqlite unavailable');
  }
  const reference = new nodeSqlite.DatabaseSync(file, { readOnly: true });
  const db = await SqliteDatabase.open(await FileByteSource.open(file));
  let rows = 0;
  try {
    const allTables = reference
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string; sql: string }[];
    expect(db.tableNames.filter((name) => !name.startsWith('sqlite_')).sort()).toEqual(
      allTables
        .map((t) => t.name)
        .filter((name) => !name.startsWith('sqlite_'))
        .sort(),
    );
    const tables = allTables.filter((t) => !/WITHOUT\s+ROWID/i.test(t.sql));
    for (const { name } of tables) {
      const columns = (
        reference.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
      ).map((c) => c.name);
      const statement = reference.prepare(
        `SELECT rowid AS __rowid, * FROM "${name}" ORDER BY rowid`,
      );
      statement.setReadBigInts(true);
      const expected = (statement.all() as Record<string, unknown>[]).map((row) => [
        normalize(row['__rowid']),
        ...columns.map((column) => normalize(row[column])),
      ]);
      const actual: unknown[][] = [];
      await db.forEach(name, columns, (values, rowid) => {
        actual.push([rowid, ...values.map(normalize)]);
      });
      expect(actual, `table ${name}`).toEqual(expected);
      rows += actual.length;

      // Random access by rowid must agree with the scan.
      for (const row of expected.filter((_, i) => i % 7 === 0)) {
        const found = await db.getByRowid(name, row[0] as number, columns);
        expect(found?.map(normalize)).toEqual(row.slice(1));
      }
    }
  } finally {
    reference.close();
    await db.close();
  }
  return rows;
}

describe('varint and record decoding', () => {
  it('decodes varints of every length', () => {
    expect(readVarint(Uint8Array.of(0x00), 0)).toEqual([0, 1]);
    expect(readVarint(Uint8Array.of(0x7f), 0)).toEqual([127, 1]);
    expect(readVarint(Uint8Array.of(0x81, 0x00), 0)).toEqual([128, 2]);
    expect(readVarint(Uint8Array.of(0x82, 0x80, 0x00), 0)).toEqual([32768, 3]);
    const nine = Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01);
    expect(readVarint(nine, 0)).toEqual([1, 9]);
    expect(() => readVarint(Uint8Array.of(0x80), 0)).toThrow();
  });

  it('decodes all serial types', () => {
    // header: size 8, types: NULL, int8, int16, 0, 1, text(2), blob(1)
    const record = Uint8Array.of(8, 0, 1, 2, 8, 9, 17, 14, 0xff, 0x01, 0x00, 0x68, 0x69, 0xab);
    const values: SqlValue[] = decodeRecord(record, 'utf-8');
    expect(values).toEqual([null, -1, 256, 0, 1, 'hi', Uint8Array.of(0xab)]);
  });
});

describe('CREATE TABLE parsing', () => {
  it('finds columns and the rowid alias', () => {
    const definition = parseCreateTable(
      'CREATE TABLE FolderTable(Id INTEGER PRIMARY KEY, Name Text, NamespaceID INTEGER )',
    );
    expect(definition.columns.map((c) => c.name)).toEqual(['Id', 'Name', 'NamespaceID']);
    expect(definition.rowidColumn).toBe(0);
    expect(definition.withoutRowid).toBe(false);
  });

  it('handles quoting, constraints, table-level keys and WITHOUT ROWID', () => {
    const quoted = parseCreateTable(
      'CREATE TABLE "t" ("a b" TEXT NOT NULL DEFAULT \'x,y\', [c] VARCHAR(10, 2), `d` INTEGER, PRIMARY KEY(`d`))',
    );
    expect(quoted.columns).toEqual([
      { name: 'a b', type: 'TEXT' },
      { name: 'c', type: 'VARCHAR(10,2)' },
      { name: 'd', type: 'INTEGER' },
    ]);
    expect(quoted.rowidColumn).toBe(2);
    expect(parseCreateTable('CREATE TABLE t (id INTEGER PRIMARY KEY DESC, v)').rowidColumn).toBe(
      -1,
    );
    expect(parseCreateTable('CREATE TABLE t (id INT PRIMARY KEY, v)').rowidColumn).toBe(-1);
    expect(parseCreateTable('CREATE TABLE t (a PRIMARY KEY, b) WITHOUT ROWID').withoutRowid).toBe(
      true,
    );
    expect(parseCreateTable('CREATE TABLE t -- comment (x)\n (a /* c */ INTEGER)').columns).toEqual(
      [{ name: 'a', type: 'INTEGER' }],
    );
  });
});

describe('SqliteDatabase', () => {
  it('rejects files that are not SQLite databases', async () => {
    await expect(SqliteDatabase.open(new MemoryByteSource(new Uint8Array(1024)))).rejects.toThrow(
      /Not a SQLite/,
    );
    await expect(SqliteDatabase.open(new MemoryByteSource(new Uint8Array(10)))).rejects.toThrow(
      /too small/,
    );
  });

  it('reads tables from memory and from disk identically', async () => {
    const file = path.join(FIXTURES, 'beta.qch');
    const fromDisk = await SqliteDatabase.open(await FileByteSource.open(file));
    const fromMemory = await SqliteDatabase.open(new MemoryByteSource(readFileSync(file)));
    const columns = ['Name', 'FileId', 'Title'];
    expect(await fromMemory.select('FileNameTable', columns)).toEqual(
      await fromDisk.select('FileNameTable', columns),
    );
    await expect(fromDisk.select('NoSuchTable', ['x'])).rejects.toThrow(/No such table/);
    expect(await fromDisk.getByRowid('FileDataTable', 999_999, ['Data'])).toBeUndefined();
    await fromDisk.close();
    await fromMemory.close();
  });
});

describe.skipIf(!nodeSqlite)('SqliteDatabase against node:sqlite', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'qch-sqlite-'));
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it.each(['alpha.qch', 'beta.qch'])('reads every row of %s', async (name) => {
    expect(await compareWithReference(path.join(FIXTURES, name))).toBeGreaterThan(0);
  });

  it.each([
    [512, 'UTF-8'],
    [1024, 'UTF-16le'],
    [4096, 'UTF-16be'],
    [65536, 'UTF-8'],
  ])('reads a synthetic database (page size %i, %s)', async (pageSize, encoding) => {
    if (!nodeSqlite) {
      return;
    }
    const file = path.join(work, `synthetic-${pageSize}-${encoding}.db`);
    const db = new nodeSqlite.DatabaseSync(file);
    db.exec(`PRAGMA page_size = ${pageSize}; PRAGMA encoding = '${encoding}';`);
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, amount, payload BLOB)');
    db.exec('CREATE TABLE "odd name" (x, y)');
    db.exec('CREATE TABLE keyed (k TEXT PRIMARY KEY, v) WITHOUT ROWID');
    const insert = db.prepare('INSERT INTO items (id, label, amount, payload) VALUES (?, ?, ?, ?)');
    const integers = [
      0,
      1,
      -1,
      127,
      -128,
      32767,
      -32768,
      8388607,
      -8388608,
      2 ** 31 - 1,
      -(2 ** 31),
      2 ** 47 - 1,
      -(2 ** 47),
      2 ** 53 - 1,
    ];
    const bigIntegers = [2n ** 62n, -(2n ** 63n)];
    let id = 1;
    db.exec('BEGIN');
    for (const value of [...integers, ...bigIntegers, 3.25, -1e300, null, 'text value é日本']) {
      insert.run(id++, `label ${id} ✓`, value, null);
    }
    // Payloads around the overflow thresholds and much larger than a page.
    for (const size of [0, 1, pageSize - 40, pageSize - 35, pageSize, pageSize * 3 + 17, 100_000]) {
      const payload = new Uint8Array(size).map((_, i) => (i * 31 + size) & 0xff);
      insert.run(id++, 'x'.repeat(size % 997), size, payload);
    }
    // Enough rows for several b-tree levels.
    for (let i = 0; i < 3000; i++) {
      insert.run(id++ * 3, `row ${i}`, i * 1.5, null);
    }
    db.exec('COMMIT');
    db.exec('DELETE FROM items WHERE id % 11 = 0');
    db.exec('ALTER TABLE items ADD COLUMN note TEXT');
    db.exec("INSERT INTO items (label, note) VALUES ('after alter', 'note')");
    db.exec('INSERT INTO "odd name" VALUES (1, 2), (3, 4)');
    db.close();

    expect(await compareWithReference(file)).toBeGreaterThan(2500);

    const ours = await SqliteDatabase.open(await FileByteSource.open(file));
    await expect(ours.select('keyed', ['k'])).rejects.toThrow(/WITHOUT ROWID/);
    await ours.close();
  });
});

const external = externalQchFiles();
describe.skipIf(!nodeSqlite || external.length === 0)('real .qch files (QCH_TEST_DIRS)', () => {
  it.each(external)('reads %s like SQLite does', async (file) => {
    expect(await compareWithReference(file)).toBeGreaterThan(0);
  });
});
