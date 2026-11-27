import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as sqlite from 'node:sqlite';
import { QchLibrary } from '../src/core/library/library';
import { QchFile } from '../src/core/qch/qchFile';
import { FileByteSource } from '../src/core/sqlite/pageSource';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

const opened = new Set<QchFile>();

export async function openQch(filePath: string): Promise<QchFile> {
  const file = await QchFile.open(await FileByteSource.open(filePath), filePath);
  opened.add(file);
  return file;
}

/** Closes every file opened through these helpers (registered in test/setup.ts). */
export async function closeOpenedFiles(): Promise<void> {
  const files = [...opened];
  opened.clear();
  await Promise.allSettled(files.map(async (file) => file.close()));
}

export async function openFixture(name: 'alpha' | 'beta'): Promise<QchFile> {
  return openQch(path.join(FIXTURES, `${name}.qch`));
}

export async function fixtureLibrary(): Promise<QchLibrary> {
  return new QchLibrary([await openFixture('alpha'), await openFixture('beta')]);
}

type SqliteModule = typeof sqlite;

/** Node's built-in SQLite, used as the reference implementation (Node ≥ 22.13). */
export const nodeSqlite: SqliteModule | undefined = await import('node:sqlite').catch(
  () => undefined,
);

/** Extra directories with real .qch files to validate against (QCH_TEST_DIRS, path-separated). */
export function externalQchFiles(): string[] {
  const dirs = (process.env['QCH_TEST_DIRS'] ?? '').split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.qch'))
      .map((name) => path.join(dir, name)),
  );
}
