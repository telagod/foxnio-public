import { comparableProjectPath } from "./comparable-path";
import { groupSessionsByProject, orderProjects } from "./project-ordering";
import { buildSessionTree, flattenSessionTree, projectLabel, sessionDisplayTitle } from "./session-tree";
import { sectionExtraRowsKey } from "./sidebar-ui-state";
import type {
  SidebarGroupRow,
  SidebarModel,
  SidebarModelInput,
  SidebarPlaceholderRow,
  SidebarPlaceholderVariant,
  SidebarRow,
  SidebarSectionId,
  SidebarSessionRow,
  SidebarSessionStatus,
} from "./sidebar-types";
import type { ManagedProject, SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

// ============================================================================
// Pure sidebar model: session/project data + UI state -> flat `SidebarRow[]`.
// No React, no DOM, no clock: every time-based decision comes from the input.
// Cost: O(sessions) for indexing and counting, O(groups log groups) for
// ordering, and tree work only for expanded workspaces.
// ============================================================================

/** Rows a workspace shows before "Show more". */
export const WORKSPACE_BASE_ROWS = 5;
/** Only sessions within the first roots can raise the cut line of a workspace. */
export const WATERMARK_SCAN_ROOTS = 50;
/** Rows an Active/Pinned section shows before "Show more". */
export const SECTION_BASE_ROWS = 6;
/**
 * Timestamp of sessions that exist only because they are live (their JSONL
 * is not on disk yet): they sort first and read as "now".
 */
export const LIVE_PLACEHOLDER_TIMESTAMP = "9999-12-31T23:59:59.999Z";

/** What is known about a live session that has no entry in the session list yet. */
export interface SidebarLiveHint {
  /** Directory (preferably the workspace root) the session runs in. */
  readonly cwd?: string;
  /** Stable ISO timestamp for the placeholder (defaults to `LIVE_PLACEHOLDER_TIMESTAMP`). */
  readonly since?: string;
}

export interface SidebarModelExtras {
  /** Cwd/timestamp of running sessions that are not in `sessions` yet. Without a hint the selected workspace is assumed. */
  readonly liveHints?: ReadonlyMap<string, SidebarLiveHint>;
  /**
   * Workspace order to keep while `ui.orderFrozen` (the `projectOrder` of an
   * earlier model). Workspaces that are not listed are appended.
   */
  readonly frozenOrder?: readonly string[];
}

export interface SidebarModelResult extends SidebarModel {
  /** Comparable keys of every workspace in display order, before any filter. Feed back as `frozenOrder`. */
  readonly projectOrder: readonly string[];
}

interface Workspace {
  readonly project: ManagedProject;
  readonly key: string;
  readonly label: string;
  readonly sessions: SessionInfo[];
}

interface LiveSessions {
  readonly sessions: SessionInfo[];
  readonly projects: ManagedProject[];
  readonly byId: Map<string, SessionInfo>;
}

/**
 * The session list plus the in-memory sessions the server does not list yet
 * (the optimistic new session and running/exited sessions without a JSONL),
 * and the workspaces those need. Written once for both.
 */
function withLiveSessions(input: SidebarModelInput, hints: ReadonlyMap<string, SidebarLiveHint> | undefined): LiveSessions {
  const sessions = input.sessions.slice();
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) byId.set(session.id, session);

  const projects: ManagedProject[] = [];
  const pathByKey = new Map<string, string>();
  for (const project of input.projects) {
    const key = comparableProjectPath(project.path);
    if (pathByKey.has(key)) continue;
    pathByKey.set(key, project.path);
    projects.push(project);
  }
  const rootFor = (cwd: string): string => pathByKey.get(comparableProjectPath(cwd)) ?? cwd;
  const addProject = (path: string) => {
    const key = comparableProjectPath(path);
    if (pathByKey.has(key)) return;
    pathByKey.set(key, path);
    projects.push({ path });
  };

  const optimistic = input.optimisticSession;
  if (optimistic && !byId.has(optimistic.id)) {
    const root =
      optimistic.projectRoot ||
      (optimistic.projectKey ? rootFor(optimistic.projectKey) : "") ||
      (optimistic.cwd ? rootFor(optimistic.cwd) : "");
    if (root) {
      addProject(root);
      const session: SessionInfo = { ...optimistic, projectRoot: root, projectKey: comparableProjectPath(root) };
      sessions.push(session);
      byId.set(session.id, session);
    }
  }

  const selectedPath = input.selectedProjectKey ? (pathByKey.get(comparableProjectPath(input.selectedProjectKey)) ?? input.selectedProjectKey) : "";
  const placeholderFor = (id: string) => {
    if (byId.has(id)) return;
    const hint = hints?.get(id);
    const cwd = hint?.cwd ?? input.exited.get(id)?.cwd ?? selectedPath;
    if (!cwd) return;
    const root = rootFor(cwd);
    addProject(root);
    const timestamp = hint?.since ?? LIVE_PLACEHOLDER_TIMESTAMP;
    const session: SessionInfo = {
      id,
      path: "",
      cwd,
      created: timestamp,
      modified: timestamp,
      messageCount: 1,
      firstMessage: "",
      projectRoot: root,
      projectKey: comparableProjectPath(root),
    };
    sessions.push(session);
    byId.set(id, session);
  };
  for (const id of input.running) placeholderFor(id);
  for (const id of input.exited.keys()) placeholderFor(id);

  return { sessions, projects, byId };
}

/** Keep the earlier order of known workspaces; new ones follow in their computed order. */
function applyFrozenOrder(ordered: ManagedProject[], frozen: readonly string[]): ManagedProject[] {
  const byKey = new Map<string, ManagedProject>();
  for (const project of ordered) byKey.set(comparableProjectPath(project.path), project);
  const placed = new Set<string>();
  const result: ManagedProject[] = [];
  for (const key of frozen) {
    const project = byKey.get(key);
    if (!project || placed.has(key)) continue;
    placed.add(key);
    result.push(project);
  }
  for (const project of ordered) {
    if (!placed.has(comparableProjectPath(project.path))) result.push(project);
  }
  return result;
}

/**
 * Ids of the `limit` most recently modified sessions that are not running and
 * have content (or were seen completing): what the "running only" filter keeps
 * besides running sessions. Bounded insertion keeps this O(n) for small limits.
 */
function recentRunIds(
  sessions: readonly SessionInfo[],
  running: ReadonlySet<string>,
  recentlyCompleted: ReadonlySet<string>,
  limit: number,
): Set<string> {
  const top: { id: string; time: number }[] = [];
  if (limit < 1) return new Set();
  for (const session of sessions) {
    if (running.has(session.id)) continue;
    const hasContent = (session.firstMessage && session.firstMessage !== "(no messages)") || session.messageCount > 0 || Boolean(session.name);
    if (!hasContent && !recentlyCompleted.has(session.id)) continue;
    const parsed = Date.parse(session.modified);
    const time = Number.isFinite(parsed) ? parsed : 0;
    if (top.length >= limit && time <= top[top.length - 1].time) continue;
    let low = 0;
    let high = top.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (top[mid].time >= time) low = mid + 1;
      else high = mid;
    }
    top.splice(low, 0, { id: session.id, time });
    if (top.length > limit) top.pop();
  }
  return new Set(top.map((entry) => entry.id));
}

function placeholderRow(variant: SidebarPlaceholderVariant, projectKey?: string, detail?: string): SidebarPlaceholderRow {
  return {
    kind: "placeholder",
    key: projectKey === undefined ? `placeholder:${variant}` : `placeholder:${variant}:${projectKey}`,
    variant,
    projectKey,
    detail,
  };
}

/**
 * Rows for the sidebar list. `extras` is part of the contract and optional:
 * `liveHints` places running sessions that have no JSONL yet, and
 * `frozenOrder` (an earlier result's `projectOrder`) keeps the workspace order
 * while `input.ui.orderFrozen` is set. Pure; the inputs are not mutated.
 */
export function buildSidebarModel(input: SidebarModelInput, extras: SidebarModelExtras = {}): SidebarModelResult {
  const { ui } = input;
  const { sessions, projects, byId } = withLiveSessions(input, extras.liveHints);

  // ---- Workspaces: order, group ------------------------------------------------
  const labelOf = (project: ManagedProject): string => project.alias || projectLabel(project.path) || project.path;
  let ordered = orderProjects(projects, ui.sortMode, ui.sortMode === "updated" ? sessions : [], labelOf);
  if (ui.orderFrozen && extras.frozenOrder) ordered = applyFrozenOrder(ordered, extras.frozenOrder);
  const grouped = groupSessionsByProject(ordered, sessions);
  const workspaces: Workspace[] = ordered.map((project) => ({
    project,
    key: comparableProjectPath(project.path),
    label: labelOf(project),
    sessions: grouped.get(project.path) ?? [],
  }));
  const workspaceByKey = new Map<string, Workspace>();
  for (const workspace of workspaces) workspaceByKey.set(workspace.key, workspace);
  const workspaceOf = (session: SessionInfo): Workspace | undefined => workspaceByKey.get(comparableProjectPath(workspaceKeyOf(session)));

  // ---- Per-session facts -------------------------------------------------------
  const pinned = new Set(input.pinnedSessionIds);
  const selectedId = input.selectedSessionId;
  const statusOf = (id: string): SidebarSessionStatus =>
    input.waiting.has(id) ? "waiting"
      : input.running.has(id) ? "running"
        : input.exited.has(id) ? "exited"
          : input.unread.has(id) ? "unread"
            : input.recentlyCompleted.has(id) ? "completed"
              : "idle";
  const sessionRow = (
    session: SessionInfo,
    workspace: Workspace,
    key: string,
    context: SidebarSessionRow["context"],
    options: { depth?: number; hasChildren?: boolean; expanded?: boolean; snippet?: string } = {},
  ): SidebarSessionRow => ({
    kind: "session",
    key,
    sessionId: session.id,
    projectKey: workspace.key,
    depth: options.depth ?? 0,
    status: statusOf(session.id),
    title: sessionDisplayTitle(session),
    timestamp: session.lastMessageAt ?? session.modified,
    worktreeBranch: session.worktreeBranch,
    selected: session.id === selectedId,
    pinned: pinned.has(session.id),
    hasChildren: options.hasChildren ?? false,
    expanded: options.expanded ?? false,
    context,
    workspaceLabel: context === "tree" ? undefined : workspace.label,
    snippet: options.snippet,
    optimistic: session.path === "",
  });

  const rows: SidebarRow[] = [];

  function buildBrowseRows(): void {
    if (input.sessionsStatus === "error") rows.push(placeholderRow("error", undefined, input.sessionsError));

    // Active and Pinned: flat, cross-workspace.
    const activeEntries: { session: SessionInfo; workspace: Workspace; time: number }[] = [];
    const queued = new Set<string>();
    const queue = (ids: Iterable<string>) => {
      for (const id of ids) {
        if (queued.has(id)) continue;
        queued.add(id);
        const session = byId.get(id);
        const workspace = session && workspaceOf(session);
        if (!session || !workspace) continue;
        const parsed = Date.parse(session.lastMessageAt ?? session.modified);
        activeEntries.push({ session, workspace, time: Number.isFinite(parsed) ? parsed : 0 });
      }
    };
    queue(input.waiting);
    queue(input.running);
    queue(input.exited.keys());
    queue(input.unread);
    activeEntries.sort((a, b) => b.time - a.time || (a.session.id < b.session.id ? -1 : 1));

    const pinnedEntries: { session: SessionInfo; workspace: Workspace }[] = [];
    const pinSeen = new Set<string>();
    for (const id of input.pinnedSessionIds) {
      if (pinSeen.has(id)) continue;
      pinSeen.add(id);
      const session = byId.get(id);
      const workspace = session && workspaceOf(session);
      if (session && workspace) pinnedEntries.push({ session, workspace });
    }

    const pushFlatSection = (
      section: Exclude<SidebarSectionId, "workspaces">,
      entries: readonly { session: SessionInfo; workspace: Workspace }[],
    ) => {
      if (entries.length === 0) return;
      const collapsed = ui.collapsedSections.has(section);
      rows.push({ kind: "section", key: `section:${section}`, section, count: entries.length, collapsed, collapsible: true });
      if (collapsed) return;
      const extraKey = sectionExtraRowsKey(section);
      const extra = ui.extraRows.get(extraKey) ?? 0;
      const shown = Math.min(entries.length, SECTION_BASE_ROWS + extra);
      for (let i = 0; i < shown; i++) {
        const { session, workspace } = entries[i];
        rows.push(sessionRow(session, workspace, `${section}:${session.id}`, section));
      }
      const hidden = entries.length - shown;
      const canCollapse = extra > 0 && entries.length > SECTION_BASE_ROWS;
      if (hidden > 0 || canCollapse) rows.push({ kind: "more", key: `more:${extraKey}`, projectKey: extraKey, hidden, canCollapse });
    };
    pushFlatSection("active", activeEntries);
    pushFlatSection("pinned", pinnedEntries);

    // Workspaces.
    if (workspaces.length === 0) {
      if (input.sessionsStatus === "loading") rows.push(placeholderRow("loading"));
      else if (input.sessionsStatus !== "error") rows.push(placeholderRow("no-workspaces"));
      return;
    }

    const recent = ui.runningOnly ? recentRunIds(sessions, input.running, input.recentlyCompleted, ui.recentRunsLimit) : null;
    const pinsActive = ui.sortMode !== "none";
    const selectedKey = input.selectedProjectKey ? comparableProjectPath(input.selectedProjectKey) : null;
    const reorderable = workspaces.filter((workspace) => !pinsActive || workspace.project.pinOrder !== undefined);
    const reorderIndex = new Map<string, number>();
    reorderable.forEach((workspace, index) => reorderIndex.set(workspace.key, index));

    const shownWorkspaces: { workspace: Workspace; sessions: SessionInfo[] }[] = [];
    for (const workspace of workspaces) {
      const list = recent ? workspace.sessions.filter((s) => input.running.has(s.id) || recent.has(s.id)) : workspace.sessions;
      if (recent && list.length === 0) continue;
      shownWorkspaces.push({ workspace, sessions: list });
    }

    rows.push({ kind: "section", key: "section:workspaces", section: "workspaces", count: shownWorkspaces.length, collapsed: false, collapsible: false });
    if (shownWorkspaces.length === 0) {
      rows.push(placeholderRow("no-matches"));
      return;
    }

    const isFlagged = (session: SessionInfo): boolean => {
      if (session.id === selectedId) return true;
      const status = statusOf(session.id);
      return status === "waiting" || status === "running" || status === "exited" || status === "unread";
    };

    shownWorkspaces.forEach(({ workspace, sessions: list }, index) => {
      const { key } = workspace;
      const counts = { total: workspace.sessions.length, running: 0, waiting: 0, unread: 0, exited: 0 };
      for (const session of workspace.sessions) {
        const status = statusOf(session.id);
        if (status === "running") counts.running++;
        else if (status === "waiting") counts.waiting++;
        else if (status === "unread") counts.unread++;
        else if (status === "exited") counts.exited++;
      }
      const selected = key === selectedKey;
      const expanded = ui.stickyOpenProjects.has(key) || (!ui.collapsedProjects.has(key) && (ui.expandedProjects.has(key) || selected));
      const position = reorderIndex.get(key);
      const group: SidebarGroupRow = {
        kind: "group",
        key: `group:${key}`,
        projectKey: key,
        path: workspace.project.path,
        label: workspace.label,
        alias: workspace.project.alias,
        expanded,
        selected,
        pinned: pinsActive && workspace.project.pinOrder !== undefined,
        hasLaunchConfig: Boolean(workspace.project.launchConfig),
        counts,
        canMoveUp: position !== undefined && position > 0,
        canMoveDown: position !== undefined && position < reorderable.length - 1,
        index,
        setSize: shownWorkspaces.length,
      };
      rows.push(group);
      if (!expanded) return;
      if (list.length === 0) {
        rows.push(placeholderRow("empty-workspace", key));
        return;
      }

      const flat = flattenSessionTree(buildSessionTree(list), ui.collapsedForks);
      let cut = flat.length;
      let hidden = 0;
      let canCollapse = false;
      // Without a filter: first rows, raised so that attention-worthy sessions among the first roots stay visible.
      if (!ui.runningOnly) {
        let lastFlagged = -1;
        for (let i = 0; i < flat.length && flat[i].rootIndex < WATERMARK_SCAN_ROOTS; i++) {
          if (isFlagged(flat[i].session)) lastFlagged = i;
        }
        const floor = Math.max(WORKSPACE_BASE_ROWS, lastFlagged + 1);
        const extra = ui.extraRows.get(key) ?? 0;
        cut = Math.min(flat.length, floor + extra);
        hidden = flat.length - cut;
        canCollapse = extra > 0 && flat.length > floor;
      }
      for (let i = 0; i < cut; i++) {
        const node = flat[i];
        rows.push(
          sessionRow(node.session, workspace, `ws:${key}:${node.session.id}`, "tree", {
            depth: node.depth,
            hasChildren: node.hasChildren,
            expanded: node.hasChildren && !node.folded,
          }),
        );
      }
      if (hidden > 0 || canCollapse) rows.push({ kind: "more", key: `more:${key}`, projectKey: key, hidden, canCollapse });
    });
  }

  if (input.search) {
    const seen = new Set<string>();
    for (const hit of input.search.hits) {
      if (seen.has(hit.sessionId)) continue;
      const session = byId.get(hit.sessionId);
      const workspace = session && workspaceOf(session);
      if (!session || !workspace) continue;
      seen.add(hit.sessionId);
      rows.push(sessionRow(session, workspace, `search:${session.id}`, "search", { snippet: hit.snippet }));
    }
    if (rows.length === 0 && !input.search.searching) rows.push(placeholderRow("no-matches"));
    if (input.search.searching) rows.push(placeholderRow("searching"));
  } else {
    buildBrowseRows();
  }

  // ---- Indexes -------------------------------------------------------------------
  const sessionRowIndex = new Map<string, number>();
  const groupRowIndex = new Map<string, number>();
  const indexedInTree = new Set<string>();
  rows.forEach((row, index) => {
    if (row.kind === "group") {
      groupRowIndex.set(row.projectKey, index);
    } else if (row.kind === "session") {
      // The first row wins, except that the workspace-tree row beats a flat one.
      const isTree = row.context === "tree";
      if (!sessionRowIndex.has(row.sessionId) || (isTree && !indexedInTree.has(row.sessionId))) {
        sessionRowIndex.set(row.sessionId, index);
        if (isTree) indexedInTree.add(row.sessionId);
      }
    }
  });

  return { rows, sessionRowIndex, groupRowIndex, projectOrder: workspaces.map((workspace) => workspace.key) };
}
