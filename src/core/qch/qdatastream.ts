/** Reader for the subset of Qt's QDataStream binary format used by .qch files (big-endian). */
export class QDataStreamReader {
  private offset = 0;

  public constructor(private readonly data: Uint8Array) {}

  public get remaining(): number {
    return this.data.byteLength - this.offset;
  }

  public readUint32(): number {
    if (this.remaining < 4) {
      throw new RangeError('QDataStream: unexpected end of data');
    }
    const d = this.data;
    const o = this.offset;
    this.offset += 4;
    return (
      (((d[o] ?? 0) << 24) | ((d[o + 1] ?? 0) << 16) | ((d[o + 2] ?? 0) << 8) | (d[o + 3] ?? 0)) >>>
      0
    );
  }

  public readInt32(): number {
    return this.readUint32() | 0;
  }

  /** Reads a QString: a uint32 byte length (0xFFFFFFFF for null) followed by UTF-16BE data. */
  public readQString(): string | null {
    const byteLength = this.readUint32();
    if (byteLength === 0xffffffff) {
      return null;
    }
    if (byteLength > this.remaining || byteLength % 2 !== 0) {
      throw new RangeError('QDataStream: invalid QString length');
    }
    const d = this.data;
    const codes = new Array<number>(byteLength / 2);
    for (let i = 0; i < codes.length; i++) {
      const o = this.offset + i * 2;
      codes[i] = ((d[o] ?? 0) << 8) | (d[o + 1] ?? 0);
    }
    this.offset += byteLength;
    let result = '';
    const chunk = 8192;
    for (let i = 0; i < codes.length; i += chunk) {
      result += String.fromCharCode(...codes.slice(i, i + chunk));
    }
    return result;
  }
}

export interface RawContentsEntry {
  readonly depth: number;
  readonly ref: string;
  readonly title: string;
}

/**
 * Decodes a `ContentsTable.Data` blob: a flat sequence of (qint32 depth, QString ref,
 * QString title) triples written by qhelpgenerator in depth-first order.
 * Decoding stops gracefully at the first malformed entry.
 */
export function decodeContents(data: Uint8Array): RawContentsEntry[] {
  const reader = new QDataStreamReader(data);
  const entries: RawContentsEntry[] = [];
  try {
    while (reader.remaining >= 12) {
      const depth = reader.readInt32();
      const ref = reader.readQString() ?? '';
      const title = reader.readQString() ?? '';
      if (depth < 0) {
        break;
      }
      entries.push({ depth, ref, title });
    }
  } catch {
    // Truncated or malformed data: keep what was decoded so far.
  }
  return entries;
}
