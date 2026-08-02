// The worker staging runs in, and it exists for exactly one API.
//
// `FileSystemFileHandle.createSyncAccessHandle()` is only exposed to workers.
// On the main thread the only way to write an OPFS file is `createWritable()`,
// which Chrome implements by writing a temporary swap file and renaming it into
// place on close — roughly twice the I/O per file, plus a rename, and a Celeste
// install is ~1,240 files. The sync handle writes into the file itself.
//
// Nothing here decides anything: `stageInto` is the same function the main
// thread would have called, and the only difference is that the handles it
// resolves in this realm can be opened the fast way. That is why the request
// crosses as data — `FileSystemHandle` is structured-cloneable, so the picked
// folder and the OPFS root arrive as themselves rather than as paths this side
// would have to re-resolve.

import { stageInto, type StageProgress, type StageRequest } from './celeste.opfs.js';

/** What the main thread sends. One message, and then this worker is done. */
export interface StageWorkerRequest {
  request: StageRequest;
}

export type StageWorkerMessage =
  | { type: 'progress'; progress: StageProgress }
  | { type: 'done'; written: number }
  | { type: 'error'; message: string };

/** `DedicatedWorkerGlobalScope`, which a DOM-lib compile does not have. */
interface WorkerScope {
  postMessage(message: StageWorkerMessage): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const scope = self as unknown as WorkerScope;

/**
 * Progress is a percentage on a bar, so the ~1,240 updates a staging run
 * produces are worth far more messages than the UI can use. One every 50 ms is
 * already faster than a player can read; the last one is always sent, because
 * "99%" left on screen while the runtime downloads looks like a stall.
 */
const PROGRESS_INTERVAL_MS = 50;

scope.addEventListener('message', (event: MessageEvent) => {
  const { request } = event.data as StageWorkerRequest;
  let lastSentAt = 0;

  void stageInto(request, (progress) => {
    const now = Date.now();
    if (progress.done < progress.total && now - lastSentAt < PROGRESS_INTERVAL_MS) return;
    lastSentAt = now;
    scope.postMessage({ type: 'progress', progress });
  }).then(
    (written) => scope.postMessage({ type: 'done', written }),
    (error: unknown) =>
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});
