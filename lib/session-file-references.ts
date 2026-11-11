import { resolveSessionPath } from "./session-reader";
import { requestSessionHistory } from "./session-history-queue";
import { isValidSessionId } from "./session-file-references-core";

export { isFilePathReferencedByEntries } from "./session-file-references-core";

async function isPathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  bashOutput: boolean,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return await requestSessionHistory({ operation: "reference", filePath: sessionPath, target: filePath, bashOutput });
  } catch {
    return false;
  }
}

export function isFilePathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  return isPathReferencedBySession(filePath, sessionId, false);
}

export function isBashOutputPathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  return isPathReferencedBySession(filePath, sessionId, true);
}
