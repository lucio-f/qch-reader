// Worker thread entry point: builds the full-text index of one .qch file off the extension
// host's main thread and transfers the serialized index back.
import { type MessagePort, parentPort } from 'node:worker_threads';
import { QchFile } from '../core/qch/qchFile';
import { buildFullTextIndex } from '../core/search/indexBuilder';
import { FileByteSource } from '../core/sqlite/pageSource';
import type { IndexWorkerRequest, IndexWorkerResponse } from '../shared/workerProtocol';

function requirePort(): MessagePort {
  if (!parentPort) {
    throw new Error('indexWorker must run in a worker thread');
  }
  return parentPort;
}

const port = requirePort();

async function build(request: IndexWorkerRequest): Promise<IndexWorkerResponse> {
  let document: QchFile | undefined;
  try {
    document = await QchFile.open(await FileByteSource.open(request.path), request.path);
    const index = await buildFullTextIndex(document, (done, total) => {
      if (done % 50 === 0 || done === total) {
        port.postMessage({
          id: request.id,
          kind: 'progress',
          done,
          total,
        } satisfies IndexWorkerResponse);
      }
    });
    return { id: request.id, kind: 'done', bytes: index.serialize() };
  } catch (error) {
    return {
      id: request.id,
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await document?.close();
  }
}

port.on('message', (request: IndexWorkerRequest) => {
  void build(request).then((response) => {
    port.postMessage(
      response,
      response.kind === 'done' ? [response.bytes.buffer as ArrayBuffer] : [],
    );
  });
});
