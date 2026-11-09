import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { foxWorkspaceDir } from "./fox-workspace";
import { writeFileAtomic } from "./fs-atomic";

/**
 * Server-side pointer to the FOX session the browser is using. The browser
 * still owns a cached id in localStorage, but the server record is
 * authoritative: a reset writes `resetAt` and forgets the active id, so every
 * tab/browser ignores an older saved session instead of reviving it.
 */
const FILE = "session.json";
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T/;

export interface FoxSessionRecord {
  sessionId: string | null;
  resetAt: string | null;
  revokedSessionId: string | null;
}

export function foxSessionRecordPath(home?: string): string {
  return join(foxWorkspaceDir(home), FILE);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

export function readFoxSessionRecord(home?: string): FoxSessionRecord {
  try {
    const parsed = JSON.parse(readFileSync(foxSessionRecordPath(home), "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || parsed.sessionId != null && !validSessionId(parsed.sessionId)
      || parsed.resetAt != null && (typeof parsed.resetAt !== "string" || !ISO.test(parsed.resetAt) || !Number.isFinite(Date.parse(parsed.resetAt)))
      || parsed.revokedSessionId != null && !validSessionId(parsed.revokedSessionId)) {
      throw new Error("Invalid FOX session record");
    }
    return {
      sessionId: validSessionId(parsed.sessionId) ? parsed.sessionId : null,
      resetAt: typeof parsed.resetAt === "string" && ISO.test(parsed.resetAt) ? parsed.resetAt : null,
      revokedSessionId: validSessionId(parsed.revokedSessionId) ? parsed.revokedSessionId : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessionId: null, resetAt: null, revokedSessionId: null };
    throw error;
  }
}

export function readFoxSessionId(home?: string): string | null {
  return readFoxSessionRecord(home).sessionId;
}

function writeRecord(record: FoxSessionRecord, home?: string): void {
  const path = foxSessionRecordPath(home);
  mkdirSync(foxWorkspaceDir(home), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }));
}

export function writeFoxSessionId(sessionId: string, home?: string): void {
  if (!validSessionId(sessionId)) throw new Error("Invalid FOX session id");
  const current = readFoxSessionRecord(home);
  writeRecord({ sessionId, resetAt: current.resetAt, revokedSessionId: current.revokedSessionId }, home);
}

export function compareAndSetFoxSessionId(sessionId: string, expected: FoxSessionRecord, home?: string): FoxSessionRecord | null {
  if (!validSessionId(sessionId)) throw new Error("Invalid FOX session id");
  const current = readFoxSessionRecord(home);
  if (current.resetAt !== expected.resetAt || current.sessionId !== expected.sessionId || current.revokedSessionId !== expected.revokedSessionId) return null;
  const record = { ...current, sessionId };
  writeRecord(record, home);
  return record;
}

/** Forget the active conversation while keeping the reset epoch. */
export function clearFoxSessionId(home?: string): FoxSessionRecord {
  const current = readFoxSessionRecord(home);
  const record: FoxSessionRecord = {
    sessionId: null,
    resetAt: new Date(Math.max(Date.now(), (Date.parse(current.resetAt ?? "") || 0) + 1)).toISOString(),
    revokedSessionId: current.sessionId ?? current.revokedSessionId,
  };
  writeRecord(record, home);
  return record;
}
