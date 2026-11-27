import { forEachIndexTerm } from './tokenize';

/** Bump whenever tokenization or the binary layout changes; cached indexes are rebuilt. */
export const INDEX_FORMAT_VERSION = 3;
const MAGIC = 0x49544651; // "QFTI" little-endian

class ByteWriter {
  private buffer = new Uint8Array(1 << 16);
  private length = 0;

  private ensure(extra: number): void {
    if (this.length + extra > this.buffer.byteLength) {
      let size = this.buffer.byteLength * 2;
      while (size < this.length + extra) {
        size *= 2;
      }
      const next = new Uint8Array(size);
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
  }

  public get size(): number {
    return this.length;
  }

  public varint(value: number): void {
    this.ensure(5);
    let v = value >>> 0;
    while (v >= 0x80) {
      this.buffer[this.length++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buffer[this.length++] = v;
  }

  public bytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** Accumulates documents and produces an immutable {@link FullTextIndex}. */
export class FullTextIndexBuilder {
  /** term → flattened [docIndex, tf, docIndex, tf, …] in increasing docIndex order. */
  private readonly postings = new Map<string, number[]>();
  private readonly fileIds: number[] = [];
  private readonly lengths: number[] = [];

  public get documentCount(): number {
    return this.fileIds.length;
  }

  public addDocument(fileId: number, text: string): void {
    const docIndex = this.fileIds.length;
    const frequencies = new Map<string, number>();
    const length = forEachIndexTerm(text, (term) => {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    });
    for (const [term, tf] of frequencies) {
      const list = this.postings.get(term);
      if (list) {
        list.push(docIndex, tf);
      } else {
        this.postings.set(term, [docIndex, tf]);
      }
    }
    this.fileIds.push(fileId);
    this.lengths.push(length);
  }

  public build(): FullTextIndex {
    const terms = [...this.postings.keys()].sort();
    const offsets = new Uint32Array(terms.length + 1);
    const frequencies = new Uint32Array(terms.length);
    const writer = new ByteWriter();
    terms.forEach((term, termIndex) => {
      offsets[termIndex] = writer.size;
      const list = this.postings.get(term) ?? [];
      frequencies[termIndex] = list.length / 2;
      let previous = 0;
      for (let i = 0; i < list.length; i += 2) {
        const docIndex = list[i] ?? 0;
        writer.varint(docIndex - previous);
        writer.varint(list[i + 1] ?? 0);
        previous = docIndex;
      }
    });
    offsets[terms.length] = writer.size;
    return new FullTextIndex(
      Uint32Array.from(this.fileIds),
      Uint32Array.from(this.lengths),
      terms,
      frequencies,
      offsets,
      writer.bytes(),
    );
  }
}

/**
 * An inverted index over the HTML pages of one .qch file. Terms are kept sorted so exact and
 * prefix lookups are binary searches; postings are delta/varint-encoded.
 */
export class FullTextIndex {
  public readonly averageLength: number;

  public constructor(
    /** FileDataTable ids, by document index. */
    public readonly fileIds: Uint32Array,
    /** Number of words per document. */
    public readonly lengths: Uint32Array,
    public readonly terms: readonly string[],
    private readonly frequencies: Uint32Array,
    private readonly offsets: Uint32Array,
    private readonly postings: Uint8Array,
  ) {
    let total = 0;
    for (const length of lengths) {
      total += length;
    }
    this.averageLength = lengths.length > 0 ? total / lengths.length : 0;
  }

  public get documentCount(): number {
    return this.fileIds.length;
  }

  private lowerBound(term: string): number {
    let lo = 0;
    let hi = this.terms.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.terms[mid] ?? '') < term) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Index of a term, or -1. */
  public findTerm(term: string): number {
    const index = this.lowerBound(term);
    return this.terms[index] === term ? index : -1;
  }

  /** Term indexes starting with `prefix`, most frequent first, at most `limit`. */
  public termsWithPrefix(prefix: string, limit: number): number[] {
    const result: number[] = [];
    for (let i = this.lowerBound(prefix); i < this.terms.length; i++) {
      if (!(this.terms[i] ?? '').startsWith(prefix)) {
        break;
      }
      result.push(i);
    }
    if (result.length > limit) {
      result.sort((a, b) => this.documentFrequency(b) - this.documentFrequency(a));
      result.length = limit;
    }
    return result;
  }

  public documentFrequency(termIndex: number): number {
    return this.frequencies[termIndex] ?? 0;
  }

  public forEachPosting(termIndex: number, visit: (docIndex: number, tf: number) => void): void {
    const end = this.offsets[termIndex + 1] ?? 0;
    let position = this.offsets[termIndex] ?? end;
    let docIndex = 0;
    const data = this.postings;
    const read = (): number => {
      let value = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = data[position++] ?? 0;
        value |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80 && shift < 35);
      return value >>> 0;
    };
    while (position < end) {
      docIndex += read();
      visit(docIndex, read());
    }
  }

  public serialize(): Uint8Array {
    const termBytes = new TextEncoder().encode(this.terms.join('\n'));
    const documentCount = this.fileIds.length;
    const termCount = this.terms.length;
    const headerSize = 24;
    const size =
      headerSize +
      documentCount * 8 +
      termCount * 4 +
      (termCount + 1) * 4 +
      termBytes.byteLength +
      this.postings.byteLength;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let offset = 0;
    const u32 = (value: number): void => {
      view.setUint32(offset, value, true);
      offset += 4;
    };
    u32(MAGIC);
    u32(INDEX_FORMAT_VERSION);
    u32(documentCount);
    u32(termCount);
    u32(termBytes.byteLength);
    u32(this.postings.byteLength);
    this.fileIds.forEach(u32);
    this.lengths.forEach(u32);
    this.frequencies.forEach(u32);
    this.offsets.forEach(u32);
    out.set(termBytes, offset);
    offset += termBytes.byteLength;
    out.set(this.postings, offset);
    return out;
  }

  /** Parses a serialized index; returns undefined if the data is invalid or outdated. */
  public static deserialize(data: Uint8Array): FullTextIndex | undefined {
    if (data.byteLength < 24) {
      return undefined;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    const u32 = (): number => {
      const value = view.getUint32(offset, true);
      offset += 4;
      return value;
    };
    if (u32() !== MAGIC || u32() !== INDEX_FORMAT_VERSION) {
      return undefined;
    }
    const documentCount = u32();
    const termCount = u32();
    const termBytesLength = u32();
    const postingsLength = u32();
    const expected = 24 + documentCount * 8 + termCount * 8 + 4 + termBytesLength + postingsLength;
    if (data.byteLength !== expected) {
      return undefined;
    }
    const readArray = (count: number): Uint32Array => {
      const array = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        array[i] = u32();
      }
      return array;
    };
    const fileIds = readArray(documentCount);
    const lengths = readArray(documentCount);
    const frequencies = readArray(termCount);
    const offsets = readArray(termCount + 1);
    const termText = new TextDecoder().decode(data.subarray(offset, offset + termBytesLength));
    offset += termBytesLength;
    const terms = termCount === 0 ? [] : termText.split('\n');
    if (terms.length !== termCount) {
      return undefined;
    }
    const postings = data.slice(offset, offset + postingsLength);
    return new FullTextIndex(fileIds, lengths, terms, frequencies, offsets, postings);
  }
}
