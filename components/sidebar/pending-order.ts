import type { ProjectSortMode } from "@/lib/project-ordering";
import type { ManagedProject } from "@/lib/types";

// While a new session is pending (it exists in memory or runs, but its JSONL is
// not listed yet) the workspace order is frozen so the new workspace row does
// not flicker from its optimistic to its confirmed position. A user ordering
// action (sort mode, pin, manual order) changes the ordering key and ends the
// freeze; the frozen rows still show fresh data.

/** True while some live session (running, exited, or the optimistic one) is not in the list yet. */
export function hasPendingNewSession(input: {
  readonly optimistic: boolean;
  readonly liveIds: Iterable<string>;
  readonly isListed: (id: string) => boolean;
}): boolean {
  if (input.optimistic) return true;
  for (const id of input.liveIds) if (!input.isListed(id)) return true;
  return false;
}

/** Everything that decides the workspace order besides the sessions themselves. */
export function orderingKey(sortMode: ProjectSortMode, projects: readonly ManagedProject[]): string {
  return [sortMode, ...projects.map((project) => `${project.path}\t${project.sortOrder ?? ""}\t${project.pinOrder ?? ""}`)].join("\n");
}

export interface OrderSnapshot {
  readonly key: string;
  readonly order: readonly string[];
}

/** The order to keep, or undefined when the order is free to change. */
export function frozenOrderFor(snapshot: OrderSnapshot | null, pending: boolean, key: string): readonly string[] | undefined {
  return pending && snapshot !== null && snapshot.key === key ? snapshot.order : undefined;
}
