import { comparableProjectPath } from "@/lib/comparable-path";
import { formatApiError } from "@/lib/i18n/api-error";
import { nextPinOrder } from "@/lib/project-ordering";
import type { FetchLike } from "@/lib/session-store";
import type { ManagedProject, ProjectLaunchConfig } from "@/lib/types";

/** `PATCH /api/projects` accepts at most this many entries in one batch. */
export const MAX_PROJECT_UPDATES = 500;

const JSON_HEADERS = { "Content-Type": "application/json" };

export interface ProjectPresentationUpdate {
  alias?: string | null;
  sortOrder?: number | null;
  pinOrder?: number | null;
  launchConfig?: ProjectLaunchConfig | null;
}

export interface ProjectOrderUpdate {
  cwd: string;
  sortOrder?: number;
  pinOrder?: number;
}

// ---- Ordering (pure) ---------------------------------------------------------

/**
 * Paths Move up/down can reorder: every workspace in manual mode, only the
 * pinned ones while a sort is active (the rest follow the sort). `order` holds
 * comparable keys in display order (`SidebarModelResult.projectOrder`); keys
 * of workspaces that are not registered (in-memory ones) are used as paths.
 */
export function reorderableWorkspacePaths(order: readonly string[], projects: readonly ManagedProject[], pinsActive: boolean): string[] {
  const byKey = new Map<string, ManagedProject>();
  for (const project of projects) byKey.set(comparableProjectPath(project.path), project);
  const paths: string[] = [];
  for (const key of order) {
    const project = byKey.get(key);
    if (pinsActive && project?.pinOrder === undefined) continue;
    paths.push(project?.path ?? key);
  }
  return paths;
}

/** `paths` with the workspace moved one step, or null when it cannot move that way. */
export function moveWorkspacePath(paths: readonly string[], path: string, direction: -1 | 1): string[] | null {
  const folded = comparableProjectPath(path);
  const index = paths.findIndex((candidate) => comparableProjectPath(candidate) === folded);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= paths.length) return null;
  const next = [...paths];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** One entry per workspace carrying its new position: `pinOrder` among pinned workspaces while a sort is active, else `sortOrder`. */
export function orderUpdates(paths: readonly string[], pinsActive: boolean): ProjectOrderUpdate[] {
  return paths.map((cwd, index) => (pinsActive ? { cwd, pinOrder: index } : { cwd, sortOrder: index }));
}

/** Split into requests the server accepts. Every entry carries its absolute position, so batches are independent. */
export function batchUpdates<T>(updates: readonly T[], size: number = MAX_PROJECT_UPDATES): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < updates.length; start += size) batches.push(updates.slice(start, start + size));
  return batches;
}

/** Pin to the end of the pinned group, or unpin. */
export function pinUpdate(project: Pick<ManagedProject, "path">, projects: readonly ManagedProject[], pinned: boolean): { cwd: string; pinOrder: number | null } {
  return { cwd: project.path, pinOrder: pinned ? nextPinOrder([...projects]) : null };
}

// ---- Requests ----------------------------------------------------------------

/** Apply one presentation change (alias, launch config, pin). Resolves false when the server refuses. */
export async function updateProject(fetchFn: FetchLike, cwd: string, update: ProjectPresentationUpdate): Promise<boolean> {
  const response = await fetchFn("/api/projects", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ cwd, ...update }) });
  return response.ok;
}

/**
 * Persist a whole-list order. The server applies each batch in one atomic
 * registry save, so writers can never interleave inside a batch. Stops at the
 * first refused batch.
 */
export async function persistOrder(fetchFn: FetchLike, updates: readonly ProjectOrderUpdate[]): Promise<boolean> {
  for (const batch of batchUpdates(updates)) {
    const response = await fetchFn("/api/projects", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ updates: batch }) });
    if (!response.ok) return false;
  }
  return true;
}

export type ProjectResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function addProject(fetchFn: FetchLike, cwd: string, launchConfig?: ProjectLaunchConfig): Promise<ProjectResult<ManagedProject>> {
  const response = await fetchFn("/api/projects", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd, launchConfig }) });
  const data = await response.json().catch(() => ({})) as { project?: ManagedProject; error?: string; code?: string };
  if (!response.ok || data.error || !data.project) {
    return { ok: false, error: formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }) };
  }
  return { ok: true, value: data.project };
}

export async function removeProject(fetchFn: FetchLike, cwd: string): Promise<ProjectResult<true>> {
  const response = await fetchFn("/api/projects", { method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ cwd }) });
  const data = await response.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
  if (!response.ok || !data.success) {
    return { ok: false, error: formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }) };
  }
  return { ok: true, value: true };
}
