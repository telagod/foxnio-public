import { sessionTabTitle } from "./session-tabs";
import type { SessionInfo } from "./types";

// ============================================================================
// Pure session/workspace helpers shared by the sidebar model and its views:
// path labels, display titles, relative time and the fork tree
// (`parentSessionId`). No React, no DOM, no clock.
// ============================================================================

/** Normalize a repository/project path for use as a Git-state map key. The
 *  same physical repo may be reached via different path spellings (forward /
 *  back slashes, drive-letter casing); folding them makes distinct spellings
 *  resolve to one shared Git context, while genuinely different repos stay
 *  separate. */
export function normalizeProjectKey(value: string): string {
  // Clip trailing separators and unify separators. Fold case when the path is
  // Windows-style (drive-letter rooted or backslash-y) so Drive:\ vs C:\ and
  // path casing variants map to the same repository, while preserving
  // case-sensitivity for POSIX paths (client has no process.platform).
  const isWindowsPath = /^[a-zA-Z]:/.test(value) || value.includes("\\");
  const normalized = value.replace(/[\/]+$/, "").replace(/\\/g, "/");
  return isWindowsPath ? normalized.toLowerCase() : normalized;
}

/** Final folder name of a project path, portable across / and \ separators. */
export function projectLabel(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** Title shown for a session: its name, else its first message, else the id prefix. */
export function sessionDisplayTitle(session: Pick<SessionInfo, "id" | "name" | "firstMessage">): string {
  return sessionTabTitle(session) || session.id.slice(0, 12);
}

/** Compact age such as `now`, `5m`, `3h`, `2d`, `4mo`, `1y`; null when `value` is not a date. */
export function formatRelativeTime(value: string, _locale: string, now: number): string | null {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

/**
 * Nearest ancestor of every session that is itself in the list. A fork whose
 * parent is missing attaches to the next existing ancestor, else becomes a
 * root. Parent cycles (a session that is its own ancestor) are cut at the
 * first node met, so no session ever disappears from the tree.
 */
function resolveAncestors(byId: ReadonlyMap<string, unknown>, sessions: readonly SessionInfo[]): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  const resolved = new Map<string, string>();
  for (const id of byId.keys()) {
    let cur = parentOf.get(id);
    if (cur === undefined) continue;
    if (cur !== id && byId.has(cur)) {
      resolved.set(id, cur);
      continue;
    }
    // Slow path: the direct parent is missing (or the session is its own
    // parent); walk up the raw chain with a loop guard.
    const visited = new Set<string>([id]);
    while (cur !== undefined && !visited.has(cur)) {
      if (byId.has(cur)) {
        resolved.set(id, cur);
        break;
      }
      visited.add(cur);
      cur = parentOf.get(cur);
    }
  }

  // Cut cycles among existing sessions (A -> B -> A): walk each chain once.
  const done = new Set<string>();
  const onPath = new Set<string>();
  for (const start of resolved.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && !done.has(cur)) {
      if (onPath.has(cur)) {
        resolved.delete(cur);
        break;
      }
      onPath.add(cur);
      path.push(cur);
      cur = resolved.get(cur);
    }
    for (const id of path) {
      onPath.delete(id);
      done.add(id);
    }
  }
  return resolved;
}

/**
 * Fork tree of `sessions`, roots first. Every level is ordered by search score
 * (when `scores` is given), then newest `modified` first.
 */
export function buildSessionTree(sessions: readonly SessionInfo[], scores?: ReadonlyMap<string, number>): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  const ancestors = resolveAncestors(byId, sessions);
  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = ancestors.get(node.session.id);
    if (ancestor === undefined) roots.push(node);
    else byId.get(ancestor)!.children.push(node);
  }

  // ISO timestamps order identically by code unit and by locale; code-unit
  // comparison avoids the collator cost on large workspaces.
  const compare = (a: SessionTreeNode, b: SessionTreeNode): number => {
    const byScore = (scores?.get(b.session.id) ?? 0) - (scores?.get(a.session.id) ?? 0);
    if (byScore !== 0) return byScore;
    const am = a.session.modified;
    const bm = b.session.modified;
    return am === bm ? 0 : am < bm ? 1 : -1;
  };
  const pending: SessionTreeNode[][] = [roots];
  for (let list = pending.pop(); list; list = pending.pop()) {
    list.sort(compare);
    for (const node of list) {
      if (node.children.length > 1) pending.push(node.children);
    }
  }
  return roots;
}

export interface FlatSessionNode {
  readonly session: SessionInfo;
  /** Fork depth below the workspace row (0 for roots). */
  readonly depth: number;
  /** Position of the node's root among the roots. */
  readonly rootIndex: number;
  readonly hasChildren: boolean;
  /** The node has children and the user folded them. */
  readonly folded: boolean;
}

/**
 * Depth-first (pre-order) rows of a fork tree. The children of a folded
 * session are left out; the folded session itself stays.
 */
export function flattenSessionTree(roots: readonly SessionTreeNode[], foldedIds: ReadonlySet<string>): FlatSessionNode[] {
  const out: FlatSessionNode[] = [];
  const stack: { node: SessionTreeNode; depth: number; rootIndex: number }[] = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], depth: 0, rootIndex: i });
  for (let item = stack.pop(); item; item = stack.pop()) {
    const { node, depth, rootIndex } = item;
    const hasChildren = node.children.length > 0;
    const folded = hasChildren && foldedIds.has(node.session.id);
    out.push({ session: node.session, depth, rootIndex, hasChildren, folded });
    if (hasChildren && !folded) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1, rootIndex });
    }
  }
  return out;
}
