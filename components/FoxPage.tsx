"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Brain,
  FolderKanban,
  LoaderCircle,
  MessageSquarePlus,
  Settings2,
  ListTodo,
  Target,
} from "lucide-react";
import FoxLogo from "@/components/FoxLogo";
import { ChatWindow } from "@/components/ChatWindow";
import { FoxActivity } from "@/components/FoxActivity";
import { FoxSettings } from "@/components/FoxSettings";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/primitives";
import type { ChatInputHandle } from "@/components/ChatInput";
import { getSessionStore, useSessionStoreSelector } from "@/hooks/useSessionStore";
import { useBriefing } from "@/hooks/useBriefing";
import { useFoxService } from "@/hooks/useFoxService";
import { useFoxGoal } from "@/hooks/useFoxGoal";
import { useIsMobile } from "@/hooks/useIsMobile";
import { refreshBriefing } from "@/lib/briefing-events";
import { comparableProjectPath } from "@/lib/comparable-path";
import { getDataStore, subscribeDataTopics } from "@/lib/data-store";
import { FOX_SESSION_STORAGE_KEY } from "@/lib/fox";
import { FOX_ASK_EVENT, type FoxAskDetail } from "@/lib/fox-events";
import { useI18n } from "@/lib/i18n";
import type { SessionInfo } from "@/lib/types";

export interface FoxPageProps {
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Reports FOX's cwd so the shell can point the file panel at it. */
  onWorkspaceReady?: (cwd: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenUrl?: (url: string) => string;
  modelsRefreshKey?: number;
  toolCallsDefaultCollapsed?: boolean;
  hideToolActivity?: boolean;
  foldCompletedTurns?: boolean;
  expandThinkingByDefault?: boolean;
  hideThinkingBlock?: boolean;
}

/** The server-side resident service needs the same conversation id the browser stores. */
async function rememberFoxSession(sessionId: string, record: FoxSessionPointer): Promise<FoxSessionPointer> {
  const response = await fetch("/api/fox/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, resetAt: record.resetAt, expectedSessionId: record.sessionId }),
  });
  if (!response.ok) throw Object.assign(new Error("FOX registration failed"), { status: response.status });
  await getDataStore().refresh();
  return { sessionId, resetAt: record.resetAt };
}

interface FoxSessionPointer { sessionId: string | null; resetAt: string | null }

export function FoxPage({
  onClose,
  onOpenSession,
  onWorkspaceReady,
  onOpenFile,
  onOpenUrl,
  modelsRefreshKey,
  toolCallsDefaultCollapsed = true,
  hideToolActivity = true,
  foldCompletedTurns = true,
  expandThinkingByDefault = false,
  hideThinkingBlock = false,
}: FoxPageProps) {
  const { t } = useI18n();
  const briefingState = useBriefing();
  const service = useFoxService();
  const isMobile = useIsMobile();
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [compactWorkspace, setCompactWorkspace] = useState(false);
  const activityOverlay = isMobile || compactWorkspace;
  const [cwd, setCwd] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState(false);
  const [booted, setBooted] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const goalState = useFoxGoal(session?.id ?? null);
  const refreshGoal = goalState.refresh;
  const [chatKey, setChatKey] = useState(0);
  const chatKeyRef = useRef(0);
  const aliveRef = useRef(false);
  const operationRef = useRef(0);
  const recordRef = useRef<FoxSessionPointer | null>(null);
  const registeringRef = useRef(false);
  const resettingRef = useRef(false);
  const registrationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [sessionProblem, setSessionProblem] = useState<"conflict" | "registrationFailed" | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const managedProjects = useSessionStoreSelector((snapshot) => snapshot.projects);
  const projects = useMemo(() => {
    const items = [...(briefingState.briefing?.projects ?? [])];
    const keys = new Set(items.map((project) => comparableProjectPath(project.path)));
    for (const project of managedProjects) {
      const key = comparableProjectPath(project.path);
      if (keys.has(key)) continue;
      keys.add(key);
      items.push({ key, path: project.path, name: project.alias || project.path.replace(/\\/g, "/").split("/").pop() || project.path, sessions: 0, running: 0, waiting: 0, errors: 0, unread: 0, lastActivity: null });
    }
    return items;
  }, [briefingState.briefing?.projects, managedProjects]);
  const attentionCount = briefingState.briefing?.needsYou.length ?? 0;
  const remountConversation = useCallback(() => setChatKey(++chatKeyRef.current), []);
  const registerSession = useCallback(async (sessionId: string, operation = operationRef.current) => {
    if (!aliveRef.current || operation !== operationRef.current || resettingRef.current || currentSessionIdRef.current !== sessionId || !recordRef.current) return;
    registeringRef.current = true;
    try {
      const record = await rememberFoxSession(sessionId, recordRef.current);
      if (!aliveRef.current || operation !== operationRef.current || currentSessionIdRef.current !== sessionId) return;
      recordRef.current = record;
      registeringRef.current = false;
      setSessionProblem(null);
    } catch (error) {
      if (!aliveRef.current || operation !== operationRef.current || currentSessionIdRef.current !== sessionId) return;
      const conflict = (error as { status?: number }).status === 409;
      if (conflict) registeringRef.current = false;
      setSessionProblem(conflict ? "conflict" : "registrationFailed");
    }
  }, []);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const update = () => setCompactWorkspace(workspace.clientWidth < 880);
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    update();
    return () => observer.disconnect();
  }, []);

  const loadWorkspace = useCallback(async () => {
    const operation = ++operationRef.current;
    const current = () => aliveRef.current && operation === operationRef.current;
    setWorkspaceError(false);
    try {
      const response = await fetch("/api/fox/workspace", { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { cwd?: string };
      if (!current()) return;
      if (!data.cwd) throw new Error("missing cwd");
      setCwd(data.cwd);
      onWorkspaceReady?.(data.cwd);

      let saved: string | null = null;
      try {
        saved = window.localStorage.getItem(FOX_SESSION_STORAGE_KEY);
      } catch {
        // private mode: no persisted Fox session, the first prompt creates one
      }

      const foxKey = comparableProjectPath(data.cwd);
      const adopt = async (sessionId: string): Promise<boolean> => {
        const found = await getSessionStore().ensureSession(sessionId).catch(() => null);
        if (!current()) return false;
        if (!found || comparableProjectPath(found.cwd) !== foxKey) return false;
        if (recordRef.current && recordRef.current.sessionId !== found.id) {
          const registered = await rememberFoxSession(found.id, recordRef.current);
          if (!current()) return false;
          recordRef.current = registered;
        }
        if (currentSessionIdRef.current !== found.id) remountConversation();
        currentSessionIdRef.current = found.id;
        setSession(found);
        registeringRef.current = false;
        setSessionProblem(null);
        try {
          window.localStorage.setItem(FOX_SESSION_STORAGE_KEY, found.id);
        } catch {
          // ignore storage errors
        }
        return true;
      };

      const durable = getDataStore();
      await durable.refresh();
      const state = durable.getSnapshot();
      if (state.status !== "ready" || !state.snapshot) throw new Error(state.error ?? "Could not read the active FOX conversation");
      const record = state.snapshot.data.foxPointer;
      const serverId = typeof record?.sessionId === "string" ? record.sessionId : null;
      const resetAt = typeof record?.resetAt === "string" ? record.resetAt : null;
      if (!current()) return;
      if (!record || record.sessionId !== null && typeof record.sessionId !== "string") throw new Error("Could not read the active FOX conversation");
      recordRef.current = { sessionId: serverId, resetAt };

      if (record && resetAt && !serverId) {
        // New/reset is authoritative for every tab: do not revive a saved
        // FOX conversation from before the reset.
        try {
          window.localStorage.removeItem(FOX_SESSION_STORAGE_KEY);
        } catch {
          // ignore
        }
        if (currentSessionIdRef.current !== null) remountConversation();
        currentSessionIdRef.current = null;
        setSession(null);
        registeringRef.current = false;
        setSessionProblem(null);
      } else if (serverId) {
        if (!(await adopt(serverId))) {
          try {
            window.localStorage.removeItem(FOX_SESSION_STORAGE_KEY);
          } catch {
            // ignore
          }
        }
      } else if (saved && await adopt(saved)) {
        // No server record/reset yet: migrate the browser's saved FOX id.
      } else {
        try {
          window.localStorage.removeItem(FOX_SESSION_STORAGE_KEY);
        } catch {
          // ignore
        }
      }
    } catch {
      if (current()) setWorkspaceError(true);
    } finally {
      if (current()) setBooted(true);
    }
  }, [onWorkspaceReady, remountConversation]);

  useEffect(() => {
    aliveRef.current = true;
    void loadWorkspace();
    return () => {
      aliveRef.current = false;
      operationRef.current += 1;
      clearTimeout(registrationTimer.current);
    };
  }, [loadWorkspace]);

  // The service can create a FOX session before the browser ever sends a
  // prompt. Adopt that server-side conversation instead of leaving the page on
  // an empty composer while a second FOX session runs elsewhere.
  const adoptServerSession = useCallback(async () => {
    if (!cwd || registeringRef.current || resettingRef.current) return;
    const operation = operationRef.current;
    const sessionId = currentSessionIdRef.current;
    const durable = getDataStore().getSnapshot();
    if (durable.status !== "ready") return;
    const record = durable.snapshot?.data.foxPointer;
    if (!record || !aliveRef.current || operation !== operationRef.current || currentSessionIdRef.current !== sessionId || registeringRef.current || resettingRef.current) return;
    if (record.sessionId !== recordRef.current?.sessionId || record.resetAt !== recordRef.current?.resetAt) setSessionProblem("conflict");
    else if (sessionId && record.sessionId === sessionId) {
      try {
        window.localStorage.setItem(FOX_SESSION_STORAGE_KEY, sessionId);
      } catch {
        // ignore storage errors
      }
    }
  }, [cwd]);

  useEffect(() => {
    if (!booted || !cwd) return;
    void adoptServerSession();
    return subscribeDataTopics(["fox-pointer"], () => { void adoptServerSession(); });
  }, [booted, cwd, adoptServerSession]);


  const startNewConversation = useCallback(async () => {
    if (resettingRef.current) return;
    resettingRef.current = true;
    const operation = ++operationRef.current;
    clearTimeout(registrationTimer.current);
    setResetting(true);
    setResetError(null);
    try {
      const response = await fetch("/api/fox/session/reset", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(recordRef.current),
      });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      const record = await response.json() as FoxSessionPointer;
      if (!aliveRef.current || operation !== operationRef.current) return;
      recordRef.current = record;
      await getDataStore().refresh();
    } catch (error) {
      // Keep the current conversation when the server reset fails.
      if (!aliveRef.current || operation !== operationRef.current) return;
      setResetError(t("fox.reset.failed"));
      setResetting(false);
      resettingRef.current = false;
      if ((error as { status?: number }).status === 409) {
        registeringRef.current = false;
        setSessionProblem("conflict");
      }
      return;
    }
    try {
      window.localStorage.removeItem(FOX_SESSION_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
    currentSessionIdRef.current = null;
    setSession(null);
    remountConversation();
    registeringRef.current = false;
    setSessionProblem(null);
    setResetOpen(false);
    setResetting(false);
    resettingRef.current = false;
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }, [t, remountConversation]);

  const handleSessionCreated = useCallback((created: SessionInfo) => {
    if (!aliveRef.current || resettingRef.current || chatKey !== chatKeyRef.current) return;
    currentSessionIdRef.current = created.id;
    setSession(created);
    try {
      window.localStorage.setItem(FOX_SESSION_STORAGE_KEY, created.id);
    } catch {
      // ignore storage errors
    }
    // The file may not exist until the first prompt is written; retry after
    // that turn as well as immediately.
    const operation = operationRef.current;
    void registerSession(created.id, operation);
    clearTimeout(registrationTimer.current);
    registrationTimer.current = setTimeout(() => { if (registeringRef.current) void registerSession(created.id, operation); }, 3_000);
  }, [chatKey, registerSession]);

  const handleAgentEnd = useCallback(() => {
    refreshBriefing();
    if (session) void registerSession(session.id);
    void refreshGoal();
  }, [session, registerSession, refreshGoal]);

  const suggest = useCallback((text: string) => {
    if (activityOverlay) setActivityOpen(false);
    requestAnimationFrame(() => {
      chatInputRef.current?.prependText(`${text}\n\n`);
      chatInputRef.current?.focus();
    });
  }, [activityOverlay]);

  // External FOX shortcuts seed the same composer through a window event
  // instead of a prop chain across the shell, preserving the current draft
  // when a project context panel is opened or closed.
  useEffect(() => {
    const onAsk = (event: Event) => {
      const prompt = (event as CustomEvent<FoxAskDetail>).detail?.prompt;
      if (typeof prompt === "string" && prompt.trim()) suggest(prompt);
    };
    window.addEventListener(FOX_ASK_EVENT, onAsk);
    return () => window.removeEventListener(FOX_ASK_EVENT, onAsk);
  }, [suggest]);

  const emptyIntro: ReactNode = (
    <div className="fox-native-intro">
      <div className="fox-native-intro-mark"><FoxLogo size={36} /></div>
      <h2>{t("fox.native.welcome")}</h2>
      <p>{t("fox.native.welcomeHint")}</p>
      <div className="fox-native-starters">
        {([
          ["delegate", FolderKanban],
          ["progress", ListTodo],
          ["preferences", Brain],
        ] as const).map(([intent, Icon]) => <button key={intent} type="button" onClick={() => suggest(t(`fox.native.prompt.${intent}`))}>
          <Icon size={18} aria-hidden="true" />
          <span><strong>{t(`fox.native.start.${intent}`)}</strong><small>{t(`fox.native.start.${intent}Hint`)}</small></span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </button>)}
      </div>
    </div>
  );

  const activity = <FoxActivity state={briefingState} goal={goalState} onOpenSession={onOpenSession} onDiscuss={suggest} onClose={() => setActivityOpen(false)} />;

  return (
    <div ref={workspaceRef} className="fox-native-workspace">
      <div className="fox-native-layout">
      <section className="fox-native-conversation" aria-label={t("fox.conversation")}>
      <header className="fox-native-header">
        <div className="fox-native-identity">
          <span className="fox-native-avatar">
            <FoxLogo size={24} />
          </span>
          <div><h1>FOX</h1><p title={t("fox.native.role")}>{t("fox.native.role")}</p></div>
        </div>
        <div className="fox-native-actions">
          <button type="button" className="fox-native-activity-toggle" onClick={() => setActivityOpen(!activityOpen)} aria-label={t("fox.native.activity")} aria-expanded={activityOpen} aria-controls="fox-native-context">
            <FolderKanban size={16} /><span>{t("fox.native.activity")}</span>{attentionCount > 0 && <b>{attentionCount}</b>}
          </button>
          <button type="button" className="fox-native-icon" onClick={() => setSettingsOpen(true)} title={t("fox.settings.title")} aria-label={t("fox.settings.title")}><Settings2 size={16} /></button>
          <button
            type="button"
            className="fox-native-icon"
            onClick={() => { setResetError(null); setResetOpen(true); }}
            title={t("fox.newConversation")}
            aria-label={t("fox.newConversation")}
          >
            <MessageSquarePlus size={16} />
          </button>
          <button type="button" className="fox-native-icon" onClick={onClose} title={t("fox.close")} aria-label={t("fox.close")}>
            <ArrowLeft size={16} />
          </button>
        </div>
      </header>

      {service.health === "error" && <div className="fox-native-capability-note" role="status" data-health="error"><AlertCircle size={15} /><span>{t("notifications.typeError")}: {service.status?.lastRunError}</span></div>}
      {service.status?.capabilities?.agentTools === false && <div className="fox-native-capability-note" role="status"><AlertCircle size={15} />{t("fox.native.toolsDisabled")}</div>}
      {sessionProblem && <div className="fox-native-capability-note" role="status"><AlertCircle size={15} /><span>{t(`fox.session.${sessionProblem}`)}</span><button type="button" className="fox-native-text-button" onClick={() => void loadWorkspace()}>{t("fox.retry")}</button></div>}
      {(goalState.snapshot?.goal || goalState.error) && <button type="button" className="fox-goal-summary" onClick={() => setActivityOpen(true)} aria-controls="fox-native-context" aria-expanded={activityOpen}>
        <Target size={16} aria-hidden="true" />
        <span><strong>{goalState.snapshot?.goal?.goal.objective || t("fox.goal.title")}</strong><small>{goalState.error ? t("fox.goal.unknown") : goalState.snapshot?.goal?.goal.status === "complete" ? t("fox.goal.nativeCompleted") : t(`fox.goal.recovery.${goalState.snapshot?.recovery}`)}</small></span>
        <ArrowUpRight size={15} aria-hidden="true" />
      </button>}
        {workspaceError ? (
          <div className="fox-chat-error">
            <AlertCircle size={20} aria-hidden="true" />
            <strong>{t("fox.workspaceFailed")}</strong>
            <button type="button" onClick={() => { setBooted(false); void loadWorkspace(); }}>{t("fox.retry")}</button>
          </div>
        ) : !booted || !cwd ? (
          <div className="fox-chat-loading" role="status">
            <LoaderCircle size={18} className="icon-spin" aria-hidden="true" />
            {t("fox.loading")}
          </div>
        ) : (
          <ChatWindow
            key={chatKey}
            session={session}
            newSessionCwd={session ? null : cwd}
            emptyHeader={<></>}
            emptyIntro={emptyIntro}
            onSessionCreated={handleSessionCreated}
            onAgentEnd={handleAgentEnd}
            chatInputRef={chatInputRef}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            modelsRefreshKey={modelsRefreshKey}
            toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
            hideToolActivity={hideToolActivity}
            foldCompletedTurns={foldCompletedTurns}
            expandThinkingByDefault={expandThinkingByDefault}
            hideThinkingBlock={hideThinkingBlock}
          />
        )}
      </section>
      {activityOpen && !activityOverlay && <aside id="fox-native-context" className="fox-native-context">{activity}</aside>}
      </div>
      <Dialog open={activityOpen && activityOverlay} onOpenChange={setActivityOpen}>
        <DialogContent className="fox-native-mobile-context">
          <DialogTitle><span className="sr-only">{t("fox.native.activity")}</span></DialogTitle>
          <div id={activityOverlay ? "fox-native-context" : undefined}>{activityOverlay && activity}</div>
        </DialogContent>
      </Dialog>
      {settingsOpen && <FoxSettings service={service} projects={projects} onClose={() => setSettingsOpen(false)} />}
      <Dialog open={resetOpen} onOpenChange={(open) => { if (!resetting) setResetOpen(open); }}>
        <DialogContent>
          <DialogTitle>{t("fox.newConversation")}</DialogTitle>
          <p className="fox-detail-explanation">{t("fox.reset.description")}</p>
          {(!goalState.snapshot || goalState.error || goalState.snapshot.assignments.some((item) => item.state !== "settled" && item.state !== "closed") || ["active", "paused"].includes(goalState.snapshot.goal?.goal.status ?? "") || briefingState.briefing?.workers?.some((worker) => worker.state === "running" || worker.state === "waiting")) && <p className="fox-inline-warning" role="status">{t("fox.goal.resetWarning")}</p>}
          {resetError && <p className="fox-inline-warning" role="alert">{resetError}</p>}
          <div className="fox-decision-buttons">
            <DialogClose className="fox-button" disabled={resetting}>{t("fox.cancel")}</DialogClose>
            <button type="button" className="fox-button fox-button-primary" disabled={resetting || Boolean(goalState.pending)} onClick={() => void startNewConversation()}>{t("fox.newConversation")}</button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
