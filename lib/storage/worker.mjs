// Real runtime asset: Node owns SQLite; jiti loads the worker-only TypeScript engine.
import { parentPort, workerData } from 'node:worker_threads';
import { createJiti } from 'jiti';
if (!parentPort) throw new Error('Storage worker requires a parent port');
const jiti = createJiti(import.meta.url, { tryNative: false });
const { StorageEngine } = await jiti.import('./engine.ts');
const { isStorageMutation } = await jiti.import('./protocol.ts');
const engine = new StorageEngine(workerData.roots, workerData.identity);
let chain = Promise.resolve();
parentPort.on('message', ({ id, request }) => {
  chain = chain.then(async () => {
    try {
      const value = await engine.request(request);
      let head;
      if (isStorageMutation(request)) {
        // Publish only after the operation has committed. A head lookup failure
        // cannot turn an acknowledged commit into a retryable write error.
        try { head = await engine.request({ operation: 'head' }); } catch {}
      }
      parentPort.postMessage({ id, value, ...(head ? { head } : {}) });
    } catch (error) {
      parentPort.postMessage({ id, error: { code: error.code || 'storage_unavailable', message: error.message || String(error), outcome: error.outcome } });
    }
  });
});
parentPort.on('close', () => { void chain.finally(() => engine.close()); });
