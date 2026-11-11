// Kept as a real runtime asset (lib/**/* ships in npm and desktop packages).
// Node loads this ESM bootstrap directly; jiti handles the pure-Node TS engine
// without importing the Bun-only OMP SDK or relying on Next's chunk paths.
import { parentPort } from "node:worker_threads";
import { createJiti } from "jiti";
import { homedir } from "node:os";
if (!parentPort) throw new Error("Session history worker requires a parent port");
const jiti = createJiti(import.meta.url, { tryNative: false });
const ready = Promise.all([
  jiti.import("./session-history-engine.ts"),
  jiti.import("./omp/session-files.ts"),
  jiti.import("./subagent-history.ts"),
  jiti.import("./session-file-references-core.ts"),
]);

ready.then(([engine, files, subagents, references]) => {
  parentPort.on("message", ({ id, request, environment, invalidations }) => {
    try {
      for (const [key, value] of Object.entries(environment || {})) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (invalidations === null) engine.invalidateSessionEntriesCache();
      else for (const file of invalidations || []) engine.invalidateSessionEntriesCache(file);
      const { operation, filePath, options, leafId } = request;
      let value;
      switch (operation) {
        case "entries": value = engine.getSessionEntries(filePath); break;
        case "displayEntries": value = engine.getSessionEntriesForDisplay(filePath, options); break;
        case "boundary": value = engine.getSessionContextBoundary(filePath); break;
        case "page": value = engine.getSessionHistoryPage(filePath, request.cursor, request.limit, leafId, options); break;
        case "display": value = engine.getSessionDisplay(filePath, options); break;
        case "context": value = engine.getSessionContextForDisplay(filePath, leafId, options); break;
        case "loadError": value = files.loadSessionFile(filePath).error; break;
        case "subagents": value = subagents.extractSubagentHistoryFromEntries(filePath, engine.getSessionEntries(filePath)); break;
        case "entry": value = engine.getSessionEntries(filePath).find((entry) => entry.id === request.entryId); break;
        case "reference": value = request.bashOutput
          ? references.isBashOutputPathReferencedByEntries(request.target, engine.getSessionEntries(filePath))
          : references.isFilePathReferencedByEntries(request.target, engine.getSessionEntries(filePath), homedir()); break;
        default: throw new Error("Unknown history operation");
      }
      parentPort.postMessage({ id, value });
    } catch (error) {
      parentPort.postMessage({ id, error: { name: error?.name, message: String(error?.message || error), code: error?.code } });
    }
  });
}).catch((error) => { setImmediate(() => { throw error; }); });
