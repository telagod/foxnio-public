"use client";

import { useMemo, useRef } from "react";
import { toast } from "@/components/ui/toast";
import { getSessionStore } from "@/hooks/useSessionStore";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/lib/i18n";
import { sessionDisplayTitle } from "@/lib/session-tree";
import { transcriptToMarkdown } from "@/lib/transcript";
import type { SessionInfo } from "@/lib/types";
import { clearLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { sessionHref } from "./session-href";
import {
  archiveSessionRequest,
  deleteSessionRequest,
  fetchTranscript,
  hasForkChildren,
  importSessionRequest,
  placeholderSession,
  renameSessionRequest,
} from "./session-requests";
import type { SidebarActions } from "./types";

type SessionActionNames = "openSession" | "pinSession" | "renameSession" | "archiveSession" | "deleteSession" | "copyTranscript" | "copySessionId";

export interface SessionActions extends Pick<SidebarActions, SessionActionNames> {
  /** Read a picked `.jsonl` file and import it. */
  importFile(file: File | null): Promise<void>;
}

export interface SessionActionsOptions {
  /** Move the sidebar's cwd to the session's worktree. */
  readonly selectCwd: (cwd: string) => void;
  /** Reveal the session's workspace in the list. */
  readonly openWorkspace: (workspaceKey: string) => void;
  readonly projectRootFor: (cwd: string | null) => string | null;
  readonly onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  readonly onSessionDeleted?: (sessionId: string) => void;
  readonly optimisticSession: SessionInfo | null | undefined;
}

/** Everything a session row can ask for. One stable object; changing inputs are read at call time. */
export function useSessionActions(options: SessionActionsOptions): SessionActions {
  const { t } = useI18n();
  const live = useRef({ options, t });
  live.current = { options, t };

  return useMemo<SessionActions>(() => {
    const store = getSessionStore();
    const busy = new Set<string>();
    let importing = false;

    /** The session after it was deleted or archived: forget it everywhere, then let the shell react. */
    const forget = (id: string, session: SessionInfo | undefined) => {
      if (session) clearLastOpenSession(workspaceKeyOf(session));
      store.removeSession(id);
      live.current.options.onSessionDeleted?.(id);
      void store.refresh();
    };

    /** One destructive request per session at a time. */
    const removeWith = async (id: string, request: (id: string) => Promise<boolean>, failure: "sessionSidebar.deleteFailed" | "sessionSidebar.archiveFailed") => {
      if (busy.has(id)) return;
      busy.add(id);
      const session = store.getSession(id);
      try {
        if (!(await request(id))) throw new Error(failure);
        forget(id, session);
      } catch {
        toast.error(live.current.t(failure));
      } finally {
        busy.delete(id);
      }
    };

    return {
      openSession(id, openOptions) {
        if (openOptions?.newTab) {
          window.open(sessionHref(id), "_blank", "noopener,noreferrer");
          return;
        }
        const { options: current } = live.current;
        const optimistic = current.optimisticSession?.id === id ? current.optimisticSession : undefined;
        let session = store.getSession(id) ?? optimistic;
        if (!session) {
          // Running in another tab before its file exists: open it from what the store knows of its cwd.
          const snapshot = store.getSnapshot();
          const cwd = snapshot.runningCwd.get(id) ?? snapshot.exited.get(id)?.cwd;
          if (!cwd) return;
          session = placeholderSession(id, cwd, current.projectRootFor(cwd));
        }
        if (session.cwd) current.selectCwd(session.cwd);
        current.openWorkspace(workspaceKeyOf(session));
        current.onSelectSession(session);
      },

      async pinSession(id, pinned) {
        const done = await (pinned ? store.pin(id) : store.unpin(id));
        if (!done) toast.error(live.current.t("sidebar.pinFailed"));
      },

      async renameSession(id, title) {
        try {
          await renameSessionRequest(fetch, id, title);
        } catch {
          // The refresh below shows what the server kept.
        }
        void store.refresh();
      },

      async archiveSession(id) {
        if (hasForkChildren(store.getSnapshot().sessions, id)) {
          toast.error(live.current.t("sessionSidebar.archiveLeafOnly"));
          return;
        }
        await removeWith(id, (target) => archiveSessionRequest(fetch, target), "sessionSidebar.archiveFailed");
      },

      async deleteSession(id) {
        await removeWith(id, (target) => deleteSessionRequest(fetch, target), "sessionSidebar.deleteFailed");
      },

      async copyTranscript(id) {
        const key = `transcript:${id}`;
        if (busy.has(key)) return;
        busy.add(key);
        const session = store.getSession(id);
        try {
          const transcript = await fetchTranscript(fetch, id);
          const markdown = transcriptToMarkdown(transcript.messages, {
            title: session ? sessionDisplayTitle(session) : undefined,
            cwd: transcript.cwd ?? session?.cwd,
          });
          await copyText(markdown);
          toast.success(live.current.t("sessionSidebar.copyTranscriptCopied"));
        } catch {
          toast.error(live.current.t("sessionSidebar.copyTranscriptFailed"));
        } finally {
          busy.delete(key);
        }
      },

      async copySessionId(id) {
        try {
          await copyText(id);
          toast.success(live.current.t("archiveBrowser.copied"));
        } catch {
          // Clipboard access can be refused; nothing else to show.
        }
      },

      async importFile(file) {
        if (!file || importing) return;
        importing = true;
        try {
          const result = await importSessionRequest(fetch, file.name, await file.text());
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          toast.success(live.current.t("sessionSidebar.imported"));
          void store.refresh({ projects: true });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          importing = false;
        }
      },
    };
  }, []);
}
