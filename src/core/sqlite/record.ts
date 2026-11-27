/** A value stored in a SQLite record. Integers beyond 2^53 are returned as bigint. */
export type SqlValue = null | number | bigint | string | Uint8Array;

export class SqliteFormatError extends Error {
  public override readonly name = 'SqliteFormatError';
}

/**
 * Reads a SQLite variable-length integer (1–9 bytes, big-endian, 7 bits per byte except the 9th).
 * Returns the value and the offset just past it. Values are exact up to 2^53.
 */
export function readVarint(data: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = data[offset + i];
    if (byte === undefined) {
      throw new SqliteFormatError('Truncated varint');
    }
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return [value, offset + i + 1];
    }
  }
  const last = data[offset + 8];
  if (last === undefined) {
    throw new SqliteFormatError('Truncated varint');
  }
  return [value * 256 + last, offset + 9];
}

export function readUint16(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
}

export function readUint32(data: Uint8Array, offset: number): number {
  return (
    (((data[offset] ?? 0) << 24) |
      ((data[offset + 1] ?? 0) << 16) |
      ((data[offset + 2] ?? 0) << 8) |
      (data[offset + 3] ?? 0)) >>>
    0
  );
}

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

const utf8Decoder = new TextDecoder('utf-8');
const utf16leDecoder = new TextDecoder('utf-16le');

export function decodeText(bytes: Uint8Array, encoding: TextEncoding): string {
  switch (encoding) {
    case 'utf-8':
      return utf8Decoder.decode(bytes);
    case 'utf-16le':
      return utf16leDecoder.decode(bytes);
    case 'utf-16be': {
      const swapped = new Uint8Array(bytes.byteLength & ~1);
      for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
        swapped[i] = bytes[i + 1] ?? 0;
        swapped[i + 1] = bytes[i] ?? 0;
      }
      return utf16leDecoder.decode(swapped);
    }
  }
}

/** Byte length of the value encoded by a record serial type. */
function serialTypeLength(serialType: number): number {
  switch (serialType) {
    case 0:
    case 8:
    case 9:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 6;
    case 6:
    case 7:
      return 8;
    case 10:
    case 11:
      throw new SqliteFormatError(`Reserved serial type ${serialType}`);
    default:
      return Math.floor((serialType - (serialType % 2 === 0 ? 12 : 13)) / 2);
  }
}

function readSignedInteger(data: Uint8Array, offset: number, length: number): number | bigint {
  if (length === 8) {
    const view = new DataView(data.buffer, data.byteOffset + offset, 8);
    const big = view.getBigInt64(0);
    return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(big)
      : big;
  }
  let value = 0;
  for (let i = 0; i < length; i++) {
    value = value * 256 + (data[offset + i] ?? 0);
  }
  const limit = 2 ** (length * 8);
  return value >= limit / 2 ? value - limit : value;
}

/**
 * Decodes a record (row payload) into its column values.
 * See https://www.sqlite.org/fileformat2.html#record_format
 */
export function decodeRecord(payload: Uint8Array, encoding: TextEncoding): SqlValue[] {
  const [headerSize, headerStart] = readVarint(payload, 0);
  if (headerSize > payload.byteLength) {
    throw new SqliteFormatError('Record header exceeds payload');
  }
  const serialTypes: number[] = [];
  let cursor = headerStart;
  while (cursor < headerSize) {
    const [serialType, next] = readVarint(payload, cursor);
    serialTypes.push(serialType);
    cursor = next;
  }

  const values: SqlValue[] = [];
  let offset = headerSize;
  for (const serialType of serialTypes) {
    const length = serialTypeLength(serialType);
    if (offset + length > payload.byteLength) {
      throw new SqliteFormatError('Record value exceeds payload');
    }
    switch (serialType) {
      case 0:
        values.push(null);
        break;
      case 8:
        values.push(0);
        break;
      case 9:
        values.push(1);
        break;
      case 7:
        values.push(new DataView(payload.buffer, payload.byteOffset + offset, 8).getFloat64(0));
        break;
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
        values.push(readSignedInteger(payload, offset, length));
        break;
      default: {
        const bytes = payload.subarray(offset, offset + length);
        values.push(serialType % 2 === 0 ? bytes : decodeText(bytes, encoding));
      }
    }
    offset += length;
  }
  return values;
}
