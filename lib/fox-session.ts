import { storageRequest, storageRoots } from "./storage/client";
import { StorageError } from "./storage/protocol";

/** Authoritative installation-wide FOX conversation and reset epoch. */
export interface FoxSessionRecord {
  sessionId: string | null;
  resetAt: string | null;
  revokedSessionId: string | null;
}

const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

export function readFoxSessionRecord(home?: string): Promise<FoxSessionRecord> {
  return storageRequest({ operation: "foxPointer.get" }, storageRoots(home));
}

export async function readFoxSessionId(home?: string): Promise<string | null> {
  return (await readFoxSessionRecord(home)).sessionId;
}

export async function writeFoxSessionId(sessionId: string, home?: string): Promise<void> {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("Invalid FOX session id");
  const current = await readFoxSessionRecord(home);
  if (!await compareAndSetFoxSessionId(sessionId, current, home)) {
    throw new StorageError("storage_conflict", "FOX conversation changed before registration");
  }
}

export async function compareAndSetFoxSessionId(sessionId: string, expected: FoxSessionRecord, home?: string): Promise<FoxSessionRecord | null> {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("Invalid FOX session id");
  return storageRequest({ operation: "foxPointer.cas", expected, next: { ...expected, sessionId } }, storageRoots(home));
}

/** Native authorization must be revoked before a caller resets an active pointer. */
export function clearFoxSessionId(home?: string, expected?: FoxSessionRecord): Promise<FoxSessionRecord> {
  return storageRequest({ operation: "foxPointer.reset", ...(expected ? { expected } : {}) }, storageRoots(home));
}
