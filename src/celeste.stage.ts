// Choosing where staging runs.
//
// `celeste.stage.worker.ts` is where it should run — it is the only realm that
// gets `createSyncAccessHandle`, which is most of the difference between a copy
// that takes minutes and one that does not. But a worker is not always there to
// be had: a host that bundles this package without handling
// `new URL(..., import.meta.url)` will not have emitted the file, a strict CSP
// can refuse to load it, and a non-browser realm has no `Worker` at all.
//
// So every one of those failures falls back to running the same `stageInto` on
// this thread. Slower, and the page will judder while it runs, but the player
// still ends up with their game staged, which is the part that matters.

import { stageInto, type StageProgress, type StageRequest } from './celeste.opfs.js';
import type { StageWorkerMessage, StageWorkerRequest } from './celeste.stage.worker.js';

/** Sentinel, so the fallback is triggered by identity rather than by message. */
const UNUSABLE = Symbol('celeste: staging worker unavailable');

/**
 * Whether handing this request to a worker is worth it.
 *
 * A directory handle crosses `postMessage` as a reference and costs nothing. A
 * `Blob` is backed by the browser's blob store and crosses as a reference too.
 * A `Uint8Array` is neither: structured clone would copy the whole archive —
 * up to 1.3 GB — into the worker before a single file was written, which is
 * more than the fast writes save.
 */
function worthAWorker(request: StageRequest): boolean {
  if (typeof Worker === 'undefined') return false;
  return request.source.kind === 'directory' || request.source.archive instanceof Blob;
}

/**
 * Stage an install in a worker, or on this thread if there is no worker.
 *
 * Falling back after the worker has already written some of the install is
 * safe: the directory copy indexes what is in storage and skips whatever is
 * already there at the right size, and re-extracting a zip over itself is
 * wasteful but correct.
 *
 * A failure *inside* staging is a different thing from a failure to start a
 * worker, and only the second one falls back — retrying a copy that ran out of
 * quota just spends another few minutes arriving at the same error.
 */
export async function stageWithWorker(
  request: StageRequest,
  onProgress?: (progress: StageProgress) => void,
): Promise<number> {
  if (!worthAWorker(request)) return stageInto(request, onProgress);

  let worker: Worker;
  try {
    worker = new Worker(new URL('./celeste.stage.worker.js', import.meta.url), { type: 'module' });
  } catch {
    return stageInto(request, onProgress);
  }

  try {
    return await new Promise<number>((resolve, reject) => {
      // Distinguishes the two failure modes above: `unusable` means the worker
      // never got going, and the caller below turns it back into a local run.
      const unusable = (): void => reject(UNUSABLE);

      worker.addEventListener('message', (event: MessageEvent) => {
        const message = event.data as StageWorkerMessage;
        if (message.type === 'progress') onProgress?.(message.progress);
        else if (message.type === 'done') resolve(message.written);
        else reject(new Error(message.message));
      });
      // A worker that fails to load, and one that cannot read what was sent.
      worker.addEventListener('error', unusable);
      worker.addEventListener('messageerror', unusable);

      try {
        worker.postMessage({ request } satisfies StageWorkerRequest);
      } catch {
        // Throws synchronously when the handles are not cloneable, which is the
        // other way this realm can turn out not to support the worker route.
        unusable();
      }
    });
  } catch (error) {
    if (error !== UNUSABLE) throw error;
    return stageInto(request, onProgress);
  } finally {
    worker.terminate();
  }
}
