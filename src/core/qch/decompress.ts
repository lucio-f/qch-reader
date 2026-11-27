import { promisify } from 'node:util';
import { inflate, inflateRawSync, inflateSync } from 'node:zlib';

const inflateAsync = promisify(inflate);
const EMPTY = new Uint8Array(0);

function expectedSize(data: Uint8Array): number {
  return (
    (((data[0] ?? 0) << 24) | ((data[1] ?? 0) << 16) | ((data[2] ?? 0) << 8) | (data[3] ?? 0)) >>> 0
  );
}

/**
 * Decompresses data produced by Qt's `qCompress()`: a 4-byte big-endian length followed by
 * a zlib stream.
 */
export async function qUncompress(data: Uint8Array): Promise<Uint8Array> {
  if (data.byteLength <= 4 || expectedSize(data) === 0) {
    return EMPTY;
  }
  const body = data.subarray(4);
  try {
    return await inflateAsync(body);
  } catch {
    return inflateRawSync(body);
  }
}

/** Synchronous variant of {@link qUncompress} for worker threads. */
export function qUncompressSync(data: Uint8Array): Uint8Array {
  if (data.byteLength <= 4 || expectedSize(data) === 0) {
    return EMPTY;
  }
  const body = data.subarray(4);
  try {
    return inflateSync(body);
  } catch {
    return inflateRawSync(body);
  }
}
