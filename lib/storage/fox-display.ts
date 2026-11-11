import { stat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { createHash } from "node:crypto";
import type { FoxGoalSnapshot } from "../fox-goal-types";
import type { FoxReportView } from "../fox-report-types";
import type { StorageRoots } from "./protocol";
import { nativeSessionFamily, nativeSessionLineage } from "../omp/session-lineage";
import { readSessionHeaderSync } from "../omp/session-files";
import { readFoxGoalJournal } from "../fox-goal-journal";
import { projectFoxGoal, nativeFoxGoalFromEntries, foxGoalTodo } from "../omp/fox-goals.mjs";
import { foxWorkerReportView } from "../fox-report-store";

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
async function checkedPath(filePath: string, roots: StorageRoots): Promise<string> {
  const [file, root] = await Promise.all([realpath(filePath), realpath(roots.sessionsDir)]);
  if (!within(root, file)) throw new Error("FOX display source is outside native sessions");
  return file;
}
async function sourceVersion(files: string[]): Promise<string> {
  const hash = createHash("sha256");
  const sources = [...new Set(files.flatMap((file) => [file, dirname(file)]))].sort();
  for (const file of sources) {
    const info = await stat(file);
    hash.update(JSON.stringify([file, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]));
  }
  return hash.digest("hex");
}
function currentBranch(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<unknown>();
  const branch: Record<string, unknown>[] = [];
  let entry = entries.at(-1);
  while (entry) {
    if (seen.has(entry.id)) throw new Error("Native display branch is cyclic");
    seen.add(entry.id);
    branch.push(entry);
    if (!entry.parentId) break;
    entry = byId.get(entry.parentId);
    if (!entry) throw new Error("Native display branch is incomplete");
  }
  return branch.reverse();
}

/** Worker-only derived view. Never call this from a permission/control path. */
export async function readGoalDisplay(
  request: { filePath: string }, roots: StorageRoots, lookup?: (version: string) => unknown | null,
): Promise<{ value: FoxGoalSnapshot; sourceVersion: string }> {
  const file = await checkedPath(request.filePath, roots);
  const family = nativeSessionFamily(file);
  const version = await sourceVersion(family);
  const cached = lookup?.(version);
  if (cached) return { value: cached as FoxGoalSnapshot, sourceVersion: version };
  const journal = await readFoxGoalJournal(file);
  const ignored = new Set(journal.ignoredEntryIds);
  const branch = currentBranch(journal.currentEntries).filter((entry) => !ignored.has(String(entry.id)));
  const plan = foxGoalTodo(branch);
  const value = projectFoxGoal(journal.entries, nativeFoxGoalFromEntries(branch), plan.todoPhases) as FoxGoalSnapshot;
  if (journal.entries.some((entry) => entry.customType === "fox-goal" && entry.data && typeof entry.data === "object"
    && !journal.sessionIds.includes(String((entry.data as Record<string, unknown>).sessionId)))) throw new Error("Foreign FOX authority is not a display grant");
  value.planEntryId = plan.planEntryId;
  value.planReferences = plan.planReferences;
  value.inheritedGoalIds = journal.inheritedGoalIds;
  if (value.goal && journal.inheritedGoalIds.includes(value.goal.goal.id)) value.goal = null;
  if (await sourceVersion(nativeSessionFamily(file)) !== version) throw new Error("FOX display source changed while projecting");
  return { value, sourceVersion: version };
}

export async function readReportDisplay(
  request: { filePath: string }, roots: StorageRoots, lookup?: (version: string) => unknown | null,
): Promise<{ value: FoxReportView; sourceVersion: string }> {
  const file = await checkedPath(request.filePath, roots);
  const lineage = nativeSessionLineage(file);
  const parent = lineage?.at(-1)?.header.parentSession;
  const files = lineage?.map((link) => link.file) ?? [file];
  if (typeof parent === "string" && isAbsolute(parent)) {
    const parentFile = await checkedPath(parent, roots);
    files.push(...nativeSessionFamily(parentFile));
  }
  const version = await sourceVersion(files);
  const cached = lookup?.(version);
  if (cached) return { value: cached as FoxReportView, sourceVersion: version };
  if (!readSessionHeaderSync(file)) throw new Error("Native worker display source is unavailable");
  const value = await foxWorkerReportView(file);
  if (await sourceVersion(files) !== version) throw new Error("Native report display source changed while projecting");
  return { value, sourceVersion: version };
}

/** Read-only evidence of a host-submitted observation, not permission to replay. */
export async function readObservationEvidence(
  request: { filePath: string; wakeId: string }, roots: StorageRoots,
): Promise<{ submittedAt: string | null }> {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(request.wakeId)) throw new Error("Invalid observation wake identity");
  const file = await checkedPath(request.filePath, roots);
  const journal = await readFoxGoalJournal(file);
  const suffix = `[FOX observation wake: ${request.wakeId}]`;
  for (const entry of journal.entries) {
    const message = entry.message as { role?: string; attribution?: string; synthetic?: boolean; content?: unknown } | undefined;
    if (entry.type !== "message" || message?.role !== "user" || message.attribution === "agent" || message.synthetic) continue;
    const content = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map((block) => block && typeof block === "object" && "text" in block ? String(block.text) : "").join("\n") : "";
    if (content.startsWith("[FOX proactive check") && content.trimEnd().endsWith(suffix) && typeof entry.timestamp === "string") {
      return { submittedAt: entry.timestamp };
    }
  }
  return { submittedAt: null };
}
