import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "./omp/paths";
import { foxWorkspaceDir } from "./fox-workspace";
import { isRecord } from "./type-guards";

/**
 * FOX's control plane: tickets, approvals, autonomy, preferences and audit.
 * OMP remains authoritative for sessions, projects and transcripts; this
 * store only holds decisions foxnio must own. It is deliberately small and
 * queryable (SQLite) rather than a second task/session database.
 */
export type ChiefAutonomy = "observe" | "suggest" | "approve" | "auto";
export type ChiefTicketState =
  | "inbox"
  | "assessing"
  | "queued"
  | "working"
  | "waiting_human"
  | "review"
  | "done"
  | "dropped";

export interface ChiefMandate {
  kind: "explicit" | "rule";
  requestedBy: string;
  ruleId?: string;
  scope: string;
  policyVersion: string;
}

export interface ChiefTicket {
  id: string;
  projectRef: string;
  projectName: string;
  triggerId?: string;
  title: string;
  state: ChiefTicketState;
  mandate: ChiefMandate;
  assigneeSessionId?: string;
  proposal?: string;
  artifacts: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChiefApproval {
  id: string;
  ticketId: string;
  projectRef: string;
  projectName: string;
  title: string;
  action: Record<string, unknown>;
  evidence: string;
  state: "pending" | "approved" | "denied" | "blocked";
  createdAt: string;
  decidedAt: string | null;
  error?: string;
}

export interface ChiefEvent {
  key: string;
  kind: string;
  projectRef: string;
  sessionId: string;
  sessionName: string | null;
  detail?: string;
  at: string;
  disposition: "observed" | "ticketed" | "ignored" | "unavailable";
  ticketId?: string;
}

export interface ChiefPreference {
  id: string;
  text: string;
  scope: string;
  confidence: number;
  source: "explicit" | "observed";
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface ChiefAuditEntry {
  id: number;
  at: string;
  kind: string;
  detail: string;
}

const MAX_TICKETS = 200;
const MAX_APPROVALS = 100;
const MAX_AUDIT = 500;
const DEFAULT_AUTONOMY: ChiefAutonomy = "suggest";
const AUTONOMY: Record<ChiefAutonomy, true> = { observe: true, suggest: true, approve: true, auto: true };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  project_ref TEXT NOT NULL,
  project_name TEXT NOT NULL,
  trigger_id TEXT,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  mandate_json TEXT NOT NULL,
  assignee_session_id TEXT,
  proposal TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_trigger ON tickets(project_ref, trigger_id) WHERE trigger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tickets_updated ON tickets(updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_ref TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_name TEXT,
  detail TEXT,
  at INTEGER NOT NULL,
  disposition TEXT NOT NULL,
  ticket_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  project_ref TEXT NOT NULL,
  project_name TEXT NOT NULL,
  title TEXT NOT NULL,
  action_json TEXT NOT NULL,
  evidence TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS approvals_state ON approvals(state, created_at DESC);

CREATE TABLE IF NOT EXISTS autonomy (
  project_ref TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  scope TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

declare global {
  var __ompChiefStore: { path: string; db: DatabaseSync } | undefined;
}

export function chiefDbPath(): string {
  return join(getAgentDir(), "omp-web", "chief.db");
}

function db(): DatabaseSync {
  const path = chiefDbPath();
  if (globalThis.__ompChiefStore?.path === path) return globalThis.__ompChiefStore.db;
  globalThis.__ompChiefStore?.db.close();
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec(SCHEMA);
  globalThis.__ompChiefStore = { path, db: database };
  return database;
}

/** Tests and the supervisor use this to drop the cached handle. */
export function closeChiefStore(): void {
  globalThis.__ompChiefStore?.db.close();
  globalThis.__ompChiefStore = undefined;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function asJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function oneLine(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function ticketFromRow(row: Record<string, unknown>): ChiefTicket {
  const mandate = parseJson(row.mandate_json);
  const artifacts = parseJson(row.artifacts_json);
  return {
    id: String(row.id),
    projectRef: String(row.project_ref),
    projectName: String(row.project_name),
    ...(typeof row.trigger_id === "string" && row.trigger_id ? { triggerId: row.trigger_id } : {}),
    title: String(row.title),
    state: row.state as ChiefTicketState,
    mandate: isRecord(mandate) ? mandate as unknown as ChiefMandate : { kind: "rule", requestedBy: "fox", scope: "project", policyVersion: "1" },
    ...(typeof row.assignee_session_id === "string" && row.assignee_session_id ? { assigneeSessionId: row.assignee_session_id } : {}),
    ...(typeof row.proposal === "string" && row.proposal ? { proposal: row.proposal } : {}),
    artifacts: Array.isArray(artifacts) ? artifacts.filter((item): item is string => typeof item === "string") : [],
    createdAt: iso(Number(row.created_at)),
    updatedAt: iso(Number(row.updated_at)),
  };
}

function approvalFromRow(row: Record<string, unknown>): ChiefApproval {
  const action = parseJson(row.action_json);
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    projectRef: String(row.project_ref),
    projectName: String(row.project_name),
    title: String(row.title),
    action: isRecord(action) ? action : {},
    evidence: String(row.evidence),
    state: row.state as ChiefApproval["state"],
    createdAt: iso(Number(row.created_at)),
    decidedAt: row.decided_at === null || row.decided_at === undefined ? null : iso(Number(row.decided_at)),
    ...(typeof row.error === "string" && row.error ? { error: row.error } : {}),
  };
}

export function audit(kind: string, detail: string): void {
  const database = db();
  database.prepare("INSERT INTO audit (at, kind, detail) VALUES (?, ?, ?)").run(Date.now(), oneLine(kind, 80), oneLine(detail, 2_000));
  database.prepare("DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT ?)").run(MAX_AUDIT);
}

export function listAudit(limit = 30): ChiefAuditEntry[] {
  const rows = db().prepare("SELECT id, at, kind, detail FROM audit ORDER BY id DESC LIMIT ?").all(Math.min(MAX_AUDIT, Math.max(1, limit))) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    at: iso(Number(row.at)),
    kind: String(row.kind),
    detail: String(row.detail),
  }));
}

export function getAutonomy(projectRef: string): ChiefAutonomy {
  const row = db().prepare("SELECT level FROM autonomy WHERE project_ref = ?").get(projectRef) as { level?: string } | undefined;
  return row && Object.hasOwn(AUTONOMY, row.level as ChiefAutonomy) ? row.level as ChiefAutonomy : DEFAULT_AUTONOMY;
}

export function setAutonomy(projectRef: string, level: ChiefAutonomy): void {
  if (!Object.hasOwn(AUTONOMY, level)) throw new Error("Invalid autonomy level");
  db().prepare(`INSERT INTO autonomy (project_ref, level, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (project_ref) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`)
    .run(projectRef, level, Date.now());
  audit("autonomy", `${projectRef}: ${level}`);
}

export function listAutonomy(): Record<string, ChiefAutonomy> {
  const rows = db().prepare("SELECT project_ref, level FROM autonomy").all() as { project_ref: string; level: string }[];
  const result: Record<string, ChiefAutonomy> = {};
  for (const row of rows) if (Object.hasOwn(AUTONOMY, row.level as ChiefAutonomy)) result[row.project_ref] = row.level as ChiefAutonomy;
  return result;
}

export interface TicketInput {
  projectRef: string;
  projectName: string;
  title: string;
  triggerId?: string;
  state?: ChiefTicketState;
  mandate?: Partial<ChiefMandate>;
  assigneeSessionId?: string;
  proposal?: string;
  artifacts?: string[];
}

/** Idempotent for a `(project, trigger)` pair; explicit tickets have no trigger. */
export function createTicket(input: TicketInput): ChiefTicket {
  const database = db();
  const now = Date.now();
  if (input.triggerId) {
    const existing = database.prepare("SELECT * FROM tickets WHERE project_ref = ? AND trigger_id = ?").get(input.projectRef, input.triggerId) as Record<string, unknown> | undefined;
    if (existing) return ticketFromRow(existing);
  }
  const id = randomUUID();
  const mandate: ChiefMandate = {
    kind: input.mandate?.kind === "explicit" ? "explicit" : "rule",
    requestedBy: input.mandate?.requestedBy ?? "fox",
    ...(input.mandate?.ruleId ? { ruleId: input.mandate.ruleId } : {}),
    scope: input.mandate?.scope ?? "project",
    policyVersion: input.mandate?.policyVersion ?? "1",
  };
  database.prepare(`INSERT INTO tickets
    (id, project_ref, project_name, trigger_id, title, state, mandate_json, assignee_session_id, proposal, artifacts_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      input.projectRef,
      oneLine(input.projectName, 200),
      input.triggerId ?? null,
      oneLine(input.title, 500),
      input.state ?? "inbox",
      asJson(mandate),
      input.assigneeSessionId ?? null,
      input.proposal ?? null,
      asJson(input.artifacts ?? []),
      now,
      now,
    );
  database.prepare("DELETE FROM tickets WHERE id NOT IN (SELECT id FROM tickets ORDER BY updated_at DESC LIMIT ?)").run(MAX_TICKETS);
  audit("ticket", `${id} ${input.title}`);
  return getTicket(id)!;
}

export function getTicket(id: string): ChiefTicket | null {
  const row = db().prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? ticketFromRow(row) : null;
}

export function listTickets(limit = 30): ChiefTicket[] {
  const rows = db().prepare("SELECT * FROM tickets ORDER BY updated_at DESC LIMIT ?").all(Math.min(MAX_TICKETS, Math.max(1, limit))) as Record<string, unknown>[];
  return rows.map(ticketFromRow);
}

export function updateTicket(id: string, patch: { state?: ChiefTicketState; assigneeSessionId?: string | null; proposal?: string | null }): ChiefTicket | null {
  const rows: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.state) { rows.push("state = ?"); args.push(patch.state); }
  if (patch.assigneeSessionId !== undefined) { rows.push("assignee_session_id = ?"); args.push(patch.assigneeSessionId); }
  if (patch.proposal !== undefined) { rows.push("proposal = ?"); args.push(patch.proposal); }
  if (rows.length === 0) return getTicket(id);
  rows.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);
  db().prepare(`UPDATE tickets SET ${rows.join(", ")} WHERE id = ?`).run(...args);
  return getTicket(id);
}

/** Event tickets disappear when their attention item resolves; dispatch tickets are separate. */
export function closeResolvedEventTickets(activeKeys: readonly string[]): void {
  const database = db();
  const base = "UPDATE tickets SET state = 'done', updated_at = ? WHERE trigger_id IS NOT NULL AND trigger_id NOT LIKE 'dispatch:%' AND state NOT IN ('done', 'dropped')";
  const result = activeKeys.length > 0
    ? database.prepare(`${base} AND trigger_id NOT IN (${activeKeys.map(() => "?").join(", ")})`).run(Date.now(), ...activeKeys)
    : database.prepare(base).run(Date.now());
  if (Number(result.changes) > 0) audit("ticket", `closed ${result.changes} resolved event ticket(s)`);
}

/**
 * A dispatched worker that has replied and is no longer running moves its
 * ticket to review. A worker waiting for human input is not finished: its
 * ticket stays in `waiting_human` until the dialog is answered. This is a
 * read-side reconciliation; it never resumes or edits the worker session.
 */
export function reconcileAssignedTickets(
  sessions: readonly { id: string; messageCount: number; lastMessageAt?: string }[],
  live: readonly { id: string; running: boolean; pendingInput?: number }[],
): void {
  const rows = db().prepare("SELECT id, state, assignee_session_id FROM tickets WHERE state IN ('working', 'waiting_human') AND assignee_session_id IS NOT NULL").all() as { id: string; state: ChiefTicketState; assignee_session_id: string }[];
  if (rows.length === 0) return;
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const liveById = new Map(live.map((item) => [item.id, item]));
  for (const row of rows) {
    const current = liveById.get(row.assignee_session_id);
    if (current?.running) continue;
    if ((current?.pendingInput ?? 0) > 0) {
      if (row.state !== "waiting_human") updateTicket(row.id, { state: "waiting_human" });
      continue;
    }
    const session = sessionById.get(row.assignee_session_id);
    if (session && (session.messageCount > 0 || session.lastMessageAt)) updateTicket(row.id, { state: "review" });
  }
}

export function recordEvent(event: Omit<ChiefEvent, "disposition"> & { disposition: ChiefEvent["disposition"]; ticketId?: string }): void {
  const now = Date.now();
  db().prepare(`INSERT INTO events (key, kind, project_ref, session_id, session_name, detail, at, disposition, ticket_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET disposition = excluded.disposition, ticket_id = excluded.ticket_id, updated_at = excluded.updated_at`)
    .run(
      event.key,
      event.kind,
      event.projectRef,
      event.sessionId,
      event.sessionName,
      event.detail ?? null,
      Date.parse(event.at) || now,
      event.disposition,
      event.ticketId ?? null,
      now,
    );
}

export interface ApprovalInput {
  ticketId: string;
  projectRef: string;
  projectName: string;
  title: string;
  action: Record<string, unknown>;
  evidence: string;
}

export function createApproval(input: ApprovalInput): ChiefApproval {
  const id = randomUUID();
  db().prepare(`INSERT INTO approvals (id, ticket_id, project_ref, project_name, title, action_json, evidence, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(id, input.ticketId, input.projectRef, input.projectName, oneLine(input.title), asJson(input.action), oneLine(input.evidence, 2_000), Date.now());
  db().prepare("DELETE FROM approvals WHERE id NOT IN (SELECT id FROM approvals ORDER BY created_at DESC LIMIT ?)").run(MAX_APPROVALS);
  audit("approval", `${id} ${input.title}`);
  return getApproval(id)!;
}

export function getApproval(id: string): ChiefApproval | null {
  const row = db().prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? approvalFromRow(row) : null;
}

export function listApprovals(state?: ChiefApproval["state"], limit = 50): ChiefApproval[] {
  const rows = state
    ? db().prepare("SELECT * FROM approvals WHERE state = ? ORDER BY created_at DESC LIMIT ?").all(state, Math.min(MAX_APPROVALS, Math.max(1, limit))) as Record<string, unknown>[]
    : db().prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?").all(Math.min(MAX_APPROVALS, Math.max(1, limit))) as Record<string, unknown>[];
  return rows.map(approvalFromRow);
}

export function decideApproval(id: string, state: "approved" | "denied" | "blocked", error?: string): ChiefApproval | null {
  db().prepare("UPDATE approvals SET state = ?, decided_at = ?, error = ? WHERE id = ?").run(state, Date.now(), error ?? null, id);
  audit("approval", `${id} ${state}${error ? `: ${error}` : ""}`);
  return getApproval(id);
}

export function listPreferences(): ChiefPreference[] {
  const rows = db().prepare("SELECT * FROM preferences ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    text: String(row.text),
    scope: String(row.scope),
    confidence: Number(row.confidence),
    source: row.source === "observed" ? "observed" : "explicit",
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: iso(Number(row.created_at)),
    updatedAt: iso(Number(row.updated_at)),
  }));
}

export function addPreference(text: string, scope = "global", source: "explicit" | "observed" = "explicit"): ChiefPreference {
  const now = Date.now();
  const id = randomUUID();
  db().prepare(`INSERT INTO preferences (id, text, scope, confidence, source, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(id, oneLine(text, 500), oneLine(scope, 100) || "global", source === "observed" ? 0.6 : 1, source, now, now);
  syncPreferencesFile();
  audit("preference", text);
  return listPreferences().find((item) => item.id === id)!;
}

export function removePreference(id: string): void {
  db().prepare("DELETE FROM preferences WHERE id = ?").run(id);
  syncPreferencesFile();
  audit("preference", `removed ${id}`);
}

/** Readable file for the FOX session; the database remains the query source. */
export function syncPreferencesFile(): void {
  try {
    const dir = foxWorkspaceDir();
    const active = listPreferences().filter((preference) => preference.status === "active");
    const body = active.length
      ? active.map((preference) => `- ${preference.text} (${preference.scope}, ${preference.source})`).join("\n")
      : "- No active user preferences yet.";
    const path = join(dir, "PREFERENCES.md");
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `# FOX Preferences\n\nThese are explicit, user-visible rules.\n\n${body}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Preferences are advisory; a failed mirror must not break the write.
  }
}

export interface ChiefState {
  tickets: ChiefTicket[];
  approvals: ChiefApproval[];
  preferences: ChiefPreference[];
  autonomy: Record<string, ChiefAutonomy>;
  audit: ChiefAuditEntry[];
  truncated?: boolean;
}

export function getChiefState(): ChiefState {
  const tickets = listTickets(MAX_TICKETS);
  const approvals = listApprovals("pending", MAX_APPROVALS);
  return {
    tickets,
    approvals,
    preferences: listPreferences(),
    autonomy: listAutonomy(),
    audit: listAudit(20),
    ...(tickets.length === MAX_TICKETS || approvals.length === MAX_APPROVALS ? { truncated: true } : {}),
  };
}

export function readPreferenceText(): string {
  try {
    return readFileSync(join(foxWorkspaceDir(), "PREFERENCES.md"), "utf8").slice(0, 4_000);
  } catch {
    return "";
  }
}
