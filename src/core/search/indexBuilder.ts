import { extractText } from '../html/text';
import { decodeHtml } from '../library/library';
import { type QchFile, isHtmlPath } from '../qch/qchFile';
import { type FullTextIndex, FullTextIndexBuilder } from './fullTextIndex';

const YIELD_EVERY = 16;

/**
 * Builds the full-text index of every HTML page stored in a .qch file.
 * With `cooperative`, the event loop is yielded to regularly so the build can run on a
 * thread that has other work to do.
 */
export async function buildFullTextIndex(
  document: QchFile,
  onProgress?: (done: number, total: number) => void,
  cooperative = false,
): Promise<FullTextIndex> {
  const pages = new Map<number, string>();
  for (const file of document.files) {
    if (isHtmlPath(file.path) && !pages.has(file.fileId)) {
      pages.set(file.fileId, file.title);
    }
  }
  const builder = new FullTextIndexBuilder();
  let done = 0;
  await document.forEachFileData(
    async (fileId, data) => {
      const { title, text } = extractText(decodeHtml(data));
      const storedTitle = pages.get(fileId) ?? '';
      builder.addDocument(fileId, `${storedTitle !== '' ? storedTitle : title} ${text}`);
      onProgress?.(++done, pages.size);
      if (cooperative && done % YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    (fileId) => pages.has(fileId),
  );
  return builder.build();
}
