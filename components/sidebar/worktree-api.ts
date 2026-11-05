import { formatApiError } from "@/lib/i18n/api-error";
import type { FetchLike } from "@/lib/session-store";
import type { WorktreeResponse } from "./worktree-state";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** `null` when the request or the body failed: the cached state stays and is refetched on demand. */
export async function fetchWorktrees(fetchFn: FetchLike, cwd: string): Promise<WorktreeResponse | null> {
  try {
    const response = await fetchFn(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`);
    return await response.json() as WorktreeResponse;
  } catch {
    return null;
  }
}

/** Creates the branch's worktree in the repository at `root`; rejects with a user-facing Error. */
export async function createWorktree(fetchFn: FetchLike, root: string, branch: string): Promise<string> {
  const response = await fetchFn("/api/worktrees", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cwd: root, branch }),
  });
  const data = await response.json().catch(() => ({})) as { path?: string; error?: string; code?: string };
  if (!response.ok || data.error || !data.path) {
    throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }));
  }
  return data.path;
}

/**
 * Removes a worktree. "dirty" means the server refused because of uncommitted
 * changes and `force` was false: the caller asks the user to confirm.
 */
export async function removeWorktree(fetchFn: FetchLike, root: string, path: string, force: boolean): Promise<"removed" | "dirty"> {
  const response = await fetchFn("/api/worktrees", {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cwd: root, path, force }),
  });
  const data = await response.json().catch(() => ({})) as { error?: string; dirty?: boolean; code?: string };
  if (!response.ok) {
    if (data.dirty && !force) return "dirty";
    throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }));
  }
  return "removed";
}
