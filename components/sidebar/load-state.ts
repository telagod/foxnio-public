import type { LoadStatus } from "@/lib/session-store";

export interface LoadStateInput {
  readonly sessionsStatus: LoadStatus;
  readonly sessionsError: string | null;
  readonly projectsStatus: LoadStatus;
  readonly projectsError: string | null;
}

/**
 * One status and message for the model, which knows a single load state: the
 * session list's failure wins over the project list's. A failed background
 * refresh keeps the data on screen next to the error row.
 */
export function combineLoadState(
  input: LoadStateInput,
  message: (key: "sessionSidebar.loadFailed" | "projects.loadFailed", detail: string) => string,
): { status: LoadStatus; error: string | undefined } {
  if (input.sessionsStatus === "error") return { status: "error", error: message("sessionSidebar.loadFailed", input.sessionsError ?? "") };
  if (input.projectsStatus === "error") return { status: "error", error: message("projects.loadFailed", input.projectsError ?? "") };
  return { status: input.sessionsStatus, error: undefined };
}
