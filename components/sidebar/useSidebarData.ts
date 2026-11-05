"use client";

import { useSessionStoreSelector } from "@/hooks/useSessionStore";
import { selectSession, shallowEqualSet, type LoadStatus, type SessionStoreSnapshot } from "@/lib/session-store";
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
/** A running or exited session whose file is not in the list yet. */
const selectUnlistedLive = (s: SessionStoreSnapshot) =>
  hasPendingNewSession({
    optimistic: false,
    liveIds: (function* () {
      yield* s.running;
      yield* s.exited.keys();
    })(),
    isListed: (id) => selectSession(s, id) !== undefined,
  });

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
  return {
    sessions: useSessionStoreSelector(selectSessions),
    projects: useSessionStoreSelector(selectProjects),
    sessionsStatus: useSessionStoreSelector(selectSessionsStatus),
    sessionsError: useSessionStoreSelector(selectSessionsError),
    projectsStatus: useSessionStoreSelector(selectProjectsStatus),
    projectsError: useSessionStoreSelector(selectProjectsError),
    running: useSessionStoreSelector(selectRunning, shallowEqualSet),
    runningCwd: useSessionStoreSelector(selectRunningCwd),
    exited: useSessionStoreSelector(selectExited),
    unread: useSessionStoreSelector(selectUnread, shallowEqualSet),
    recentlyCompleted: useSessionStoreSelector(selectRecentlyCompleted, shallowEqualSet),
    pinnedSessionIds: useSessionStoreSelector(selectPinned),
    unlistedLive: useSessionStoreSelector(selectUnlistedLive),
  };
}
