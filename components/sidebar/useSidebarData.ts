"use client";

import { useMemo } from "react";
import { useSessionStoreSelector } from "@/hooks/useSessionStore";
import { isFoxWorkspacePath } from "@/lib/fox";
import { shallowEqualSet, type LoadStatus, type SessionStoreSnapshot } from "@/lib/session-store";
import type { ExitedRpcSession, ManagedProject, SessionInfo } from "@/lib/types";
import { hasPendingNewSession } from "./pending-order";

// Narrow selectors: the sidebar re-renders only when one of these slices
// changes, never for the rest of the snapshot.
const selectSessions = (s: SessionStoreSnapshot) => s.sessions;
const selectProjects = (s: SessionStoreSnapshot) => s.projects;
const selectSessionsStatus = (s: SessionStoreSnapshot) => s.sessionsStatus;
const selectSessionsError = (s: SessionStoreSnapshot) => s.sessionsError;
const selectProjectsStatus = (s: SessionStoreSnapshot) => s.projectsStatus;
const selectProjectsError = (s: SessionStoreSnapshot) => s.projectsError;
const selectRunning = (s: SessionStoreSnapshot) => s.running;
const selectRunningCwd = (s: SessionStoreSnapshot) => s.runningCwd;
const selectExited = (s: SessionStoreSnapshot) => s.exited;
const selectUnread = (s: SessionStoreSnapshot) => s.unread;
const selectRecentlyCompleted = (s: SessionStoreSnapshot) => s.recentlyCompleted;
const selectPinned = (s: SessionStoreSnapshot) => s.pinnedSessionIds;

export interface SidebarData {
  readonly sessions: readonly SessionInfo[];
  readonly projects: readonly ManagedProject[];
  readonly sessionsStatus: LoadStatus;
  readonly sessionsError: string | null;
  readonly projectsStatus: LoadStatus;
  readonly projectsError: string | null;
  readonly running: ReadonlySet<string>;
  readonly runningCwd: ReadonlyMap<string, string>;
  readonly exited: ReadonlyMap<string, ExitedRpcSession>;
  readonly unread: ReadonlySet<string>;
  readonly recentlyCompleted: ReadonlySet<string>;
  readonly pinnedSessionIds: readonly string[];
  readonly unlistedLive: boolean;
}

/** The store slices the sidebar shows, each under its own selector. */
export function useSidebarData(): SidebarData {
  const rawSessions = useSessionStoreSelector(selectSessions);
  const rawSessionsStatus = useSessionStoreSelector(selectSessionsStatus);
  const rawSessionsError = useSessionStoreSelector(selectSessionsError);
  const rawProjects = useSessionStoreSelector(selectProjects);
  const rawProjectsStatus = useSessionStoreSelector(selectProjectsStatus);
  const rawProjectsError = useSessionStoreSelector(selectProjectsError);
  const rawRunning = useSessionStoreSelector(selectRunning, shallowEqualSet);
  const rawRunningCwd = useSessionStoreSelector(selectRunningCwd);
  const rawExited = useSessionStoreSelector(selectExited);
  const rawUnread = useSessionStoreSelector(selectUnread, shallowEqualSet);
  const rawRecentlyCompleted = useSessionStoreSelector(selectRecentlyCompleted, shallowEqualSet);
  const rawPinnedSessionIds = useSessionStoreSelector(selectPinned);

  return useMemo(() => {
    // FOX's resident conversation is an ordinary OMP session, but it is not a
    // project the sidebar manages. Hide it from every slice so neither the
    // workspace tree nor an "unlisted live" placeholder can resurrect it.
    const hiddenIds = new Set<string>();
    for (const session of rawSessions) {
      if (isFoxWorkspacePath(session.cwd) || isFoxWorkspacePath(session.projectRoot)) hiddenIds.add(session.id);
    }
    const hiddenLive = (id: string, cwd?: string | null) => hiddenIds.has(id) || isFoxWorkspacePath(cwd);

    const sessions = rawSessions.filter((session) => !hiddenIds.has(session.id));
    const projects = rawProjects.filter((project) => !isFoxWorkspacePath(project.path));
    const running = new Set([...rawRunning].filter((id) => !hiddenLive(id, rawRunningCwd.get(id))));
    const runningCwd = new Map([...rawRunningCwd].filter(([id, cwd]) => !hiddenLive(id, cwd)));
    const exited = new Map([...rawExited].filter(([id, exit]) => !hiddenLive(id, exit.cwd)));
    const unread = new Set([...rawUnread].filter((id) => !hiddenIds.has(id)));
    const recentlyCompleted = new Set([...rawRecentlyCompleted].filter((id) => !hiddenIds.has(id)));
    const pinnedSessionIds = rawPinnedSessionIds.filter((id) => !hiddenIds.has(id));
    const listedIds = new Set(sessions.map((session) => session.id));
    const unlistedLive = hasPendingNewSession({
      optimistic: false,
      liveIds: [...running, ...exited.keys()],
      isListed: (id) => listedIds.has(id),
    });

    return {
      sessions,
      projects,
      sessionsStatus: rawSessionsStatus,
      sessionsError: rawSessionsError,
      projectsStatus: rawProjectsStatus,
      projectsError: rawProjectsError,
      running,
      runningCwd,
      exited,
      unread,
      recentlyCompleted,
      pinnedSessionIds,
      unlistedLive,
    };
  }, [rawSessions, rawSessionsStatus, rawSessionsError, rawProjects, rawProjectsStatus, rawProjectsError, rawRunning, rawRunningCwd, rawExited, rawUnread, rawRecentlyCompleted, rawPinnedSessionIds]);
}
