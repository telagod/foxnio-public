// Pure presentation metrics for the FOX resident-chief workspace.
//
// The briefing already owns the facts (projects, live runs, attention items,
// hourly pulse). This module only ranks and normalizes them for the dashboard;
// it performs no I/O and never hides a warning or an attention item.

import type { Briefing, ProjectBriefing } from "./briefing";

export type FoxProjectState = "critical" | "waiting" | "active" | "quiet";

/** localStorage key for the one persistent FOX conversation. */
export const FOX_SESSION_STORAGE_KEY = "foxnio.fox.session-id";

/**
 * True for OMP's resident-chief cwd. The FOX session is a normal OMP session,
 * but it is the chief itself, not a project the sidebar or briefing should
 * manage.
 */
export function isFoxWorkspacePath(path: string | null | undefined): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.endsWith("/.omp/agent/omp-web/fox");
}

/**
 * FOX is a coordinator, not a worker. Its session may read the portfolio and
 * the briefing, but it must not have the tools that edit files or run commands:
 * project work is dispatched through `send_to_session` / `new_session`.
 *
 * OMP's native memory tools own durable preferences. The native goal tool is
 * installed by OMP goal mode; its lifecycle/evidence gate remains mandatory.
 */
export const FOX_TOOL_NAMES = ["read", "grep", "glob", "todo", "ask"] as const;
export const FOX_OPTIONAL_TOOL_NAMES = ["recall", "retain", "reflect", "memory_edit", "goal"] as const;

/** True when the wrapper was started with exactly FOX's resident toolset. */
export function isFoxToolPolicy(toolNames: readonly string[] | null | undefined): boolean {
  if (!toolNames || toolNames.length !== FOX_TOOL_NAMES.length) return false;
  return FOX_TOOL_NAMES.every((name) => toolNames.includes(name));
}

/**
 * The effective builtin toolset for a session cwd. FOX's cwd is special even
 * when the client asks for the global "full" preset; every other cwd keeps the
 * caller's choice.
 */
export function effectiveToolNamesForCwd(cwd: string, requested?: readonly string[]): string[] | undefined {
  return isFoxWorkspacePath(cwd) ? [...FOX_TOOL_NAMES] : requested ? [...requested] : undefined;
}

const FOX_BRIEFING_LIMIT = 180;

function oneLine(value: unknown, max = FOX_BRIEFING_LIMIT): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The same 7-day snapshot the dashboard renders, written next to FOX's persona
 * so the chat can ground status answers in the user's view instead of counting
 * every historical session file it finds.
 */
export function formatFoxBriefing(briefing: Briefing): string {
  const totals = briefing.totals ?? { projects: 0, sessions: 0, running: 0, waiting: 0, unread: 0 };
  const lines = [
    "# FOX project context",
    `Updated: ${oneLine(briefing.generatedAt, 40)}`,
    "Project activity window: last 7 days. Workers are direct native children of the current FOX session.",
    `Totals: ${totals.projects} projects, ${totals.sessions} sessions, ${totals.running} running, ${totals.waiting} waiting, ${totals.unread} unread.`,
    "",
    "## Needs you",
  ];

  if (briefing.needsYou.length === 0) lines.push("No attention items were observed in the available sources.");
  else {
    for (const item of briefing.needsYou.slice(0, 20)) {
      lines.push(`- ${item.kind}: ${oneLine(item.sessionName ?? item.sessionId, 80)} (${oneLine(item.projectName, 80)})${item.detail ? ` — ${oneLine(item.detail)}` : ""}`);
    }
  }

  lines.push("", "## Active work");
  if (!briefing.active || briefing.active.length === 0) lines.push("No agent is running.");
  else {
    for (const item of briefing.active.slice(0, 12)) {
      lines.push(`- ${oneLine(item.sessionName ?? item.sessionId, 80)} [${item.sessionId}] (${oneLine(item.projectName, 80)}): ${oneLine(item.detail ?? "running", 120)}`);
    }
  }

  lines.push("", "## Native workers");
  if (!briefing.workers?.length) lines.push("No direct workers are recorded for the current FOX conversation.");
  else {
    lines.push("Follow up using the exact sessionId and cwd. Use project-agent reports for progress; inspect the worker only to verify evidence or recover missing reports. Idle is not task completion.");
    for (const item of briefing.workers.slice(0, 24)) {
      lines.push(`- ${item.state}: ${oneLine(item.title, 160)} [${item.sessionId}] cwd=${JSON.stringify(item.cwd)}; updated ${item.at}${item.detail ? ` — ${oneLine(item.detail)}` : ""}`);
      lines.push(item.report
        ? `  Report ${item.report.id} (${item.report.source}, ${item.report.status}, ${item.reportDelivery ?? "unknown"}): ${oneLine(item.report.summary, 1200)}${item.report.evidence.length ? ` Evidence: ${item.report.evidence.map((evidence) => oneLine(evidence, 300)).join("; ")}` : ""}`
        : "  No project-agent report is available. Progress and completion are unverified.");
      if (item.reportError) lines.push(`  Reporting problem: ${oneLine(item.reportError, 300)}`);
    }
    if (briefing.workers.length > 24) lines.push(`Showing 24 of ${briefing.workers.length} workers. Use list_sessions for the remainder.`);
  }
  if (briefing.historicalWorkers?.length) {
    lines.push("", "## Workers owned by other FOX conversations", "These are not your direct workers. Open their original coordinator for follow-up; never adopt them by project name or cwd.");
    for (const item of briefing.historicalWorkers.slice(0, 24)) {
      lines.push(`- [${item.sessionId}] original FOX=[${item.parentSessionId}] cwd=${JSON.stringify(item.cwd)}; ${item.report ? `${item.report.status}: ${oneLine(item.report.summary, 500)}` : "No project report available."}`);
    }
  }

  lines.push("", "## Portfolio");
  if (briefing.projects.length === 0) lines.push("No active projects.");
  else {
    for (const project of briefing.projects.slice(0, 30)) {
      lines.push(`- ${oneLine(project.name, 80)} cwd=${JSON.stringify(project.path)}: ${project.sessions} sessions, ${project.running} running, ${project.waiting} waiting, ${project.errors} errors; last activity ${oneLine(project.lastActivity ?? "unknown", 40)}`);
    }
  }

  lines.push("", "## Recent activity");
  if (briefing.recent.length === 0) lines.push("No recent activity.");
  else {
    for (const item of briefing.recent.slice(0, 20)) {
      lines.push(`- ${oneLine(item.sessionName ?? item.sessionId, 80)} (${oneLine(item.projectName, 80)}) at ${oneLine(item.at, 40)}`);
    }
  }

  if (briefing.warnings && briefing.warnings.length > 0) {
    lines.push("", `Warnings: ${briefing.warnings.map((warning) => oneLine(warning, 40)).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface FoxProjectSignal {
  project: ProjectBriefing;
  state: FoxProjectState;
  /** Higher is more urgent. Used only for ordering, never shown as a number. */
  score: number;
}

export interface FoxMetrics {
  distribution: {
    running: number;
    waiting: number;
    errors: number;
    quiet: number;
    total: number;
  };
  /** 0–100. Errors and waiting sessions lower it; an empty portfolio is 100. */
  health: number;
  activeProjects: number;
  attention: number;
  focus: FoxProjectSignal | null;
  projects: FoxProjectSignal[];
}

function stateOf(project: ProjectBriefing): FoxProjectState {
  if (project.errors > 0) return "critical";
  if (project.waiting > 0) return "waiting";
  if (project.running > 0) return "active";
  return "quiet";
}

function scoreOf(project: ProjectBriefing, state: FoxProjectState): number {
  const urgency = state === "critical" ? 1000 : state === "waiting" ? 100 : state === "active" ? 10 : 0;
  return urgency + Math.min(project.sessions, 9);
}

export function buildFoxMetrics(briefing: Briefing): FoxMetrics {
  const projects = briefing.projects
    .map((project) => {
      const state = stateOf(project);
      return { project, state, score: scoreOf(project, state) };
    })
    .sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name));

  const errors = briefing.projects.reduce((sum, project) => sum + project.errors, 0);
  const total = briefing.totals.sessions;
  const quiet = Math.max(0, total - briefing.totals.running - briefing.totals.waiting - errors);
  const health = Math.max(0, 100 - errors * 18 - briefing.totals.waiting * 7);

  return {
    distribution: {
      running: briefing.totals.running,
      waiting: briefing.totals.waiting,
      errors,
      quiet,
      total,
    },
    health,
    activeProjects: briefing.projects.filter((project) => project.running > 0 || project.waiting > 0).length,
    attention: briefing.needsYou.length,
    focus: projects[0] ?? null,
    projects,
  };
}
