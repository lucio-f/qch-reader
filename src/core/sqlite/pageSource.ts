import { open, type FileHandle } from 'node:fs/promises';

/** Random-access byte source backing a SQLite database. */
export interface ByteSource {
  /** Total size in bytes. */
  readonly size: number;
  /** Reads exactly `length` bytes starting at `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** A byte source over an in-memory buffer (used for virtual file systems and tests). */
export class MemoryByteSource implements ByteSource {
  public constructor(private readonly data: Uint8Array) {}

  public get size(): number {
    return this.data.byteLength;
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset + length > this.data.byteLength) {
      throw new RangeError(`Read beyond end of data (${offset}+${length})`);
    }
    return this.data.subarray(offset, offset + length);
  }

  public async close(): Promise<void> {
    // Nothing to release.
  }
}

/** A byte source reading lazily from a file on disk. */
export class FileByteSource implements ByteSource {
  private constructor(
    private readonly handle: FileHandle,
    public readonly size: number,
  ) {}

  public static async open(filePath: string): Promise<FileByteSource> {
    const handle = await open(filePath, 'r');
    try {
      const stat = await handle.stat();
      return new FileByteSource(handle, stat.size);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    const buffer = new Uint8Array(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await this.handle.read(buffer, total, length - total, offset + total);
      if (bytesRead === 0) {
        throw new RangeError(`Unexpected end of file at offset ${offset + total}`);
      }
      total += bytesRead;
    }
    return buffer;
  }

  public async close(): Promise<void> {
    await this.handle.close();
  }
}
