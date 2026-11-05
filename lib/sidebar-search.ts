import { comparableProjectPath } from "./comparable-path";
import {
  compileSearchQuery,
  FIRST_MESSAGE_WEIGHT,
  scoreSearchFields,
  searchField,
  TITLE_WEIGHT,
  type CompiledSearchQuery,
  type SearchField,
} from "./session-search";
import type { SidebarSearchHit, SidebarSearchState } from "./sidebar-types";
import type { ManagedProject, SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

// Sidebar search controller. Stage 1 scores title, first message and workspace
// name/alias locally and synchronously on every keystroke. Stage 2 streams
// `GET /api/sessions/search` (NDJSON, one `{ scores: { [sessionId]: number } }`
// line per scanned batch) after a debounce and merges the transcript-aware
// scores into the same ranking. The route returns scores only, so hits never
// carry a snippet.

/** Server limit (`app/api/sessions/search/route.ts`); longer queries get HTTP 400. */
export const MAX_SEARCH_QUERY_LENGTH = 500;
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MERGE_INTERVAL_MS = 200;
export const MAX_SEARCH_HITS = 200;

/** A workspace name only breaks ties below title matches: one workspace can hold hundreds of sessions. */
const WORKSPACE_WEIGHT = FIRST_MESSAGE_WEIGHT;

export interface SidebarSearchDeps {
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  /** Field builder; injectable so tests can count how often fields are rebuilt. */
  searchField(text: string, weight: number): SearchField;
}

export interface SidebarSearch {
  /** Replace the searchable sessions and workspaces. Only changed sessions are re-indexed. */
  setSessions(sessions: readonly SessionInfo[], projects: readonly ManagedProject[]): void;
  /** Local hits update synchronously; the transcript stream starts after the debounce. */
  setQuery(raw: string): void;
  /** User pressed Stop: abort the stream, keep the hits found so far. */
  stop(): void;
  /** `null` while there is nothing to search for. Identity only changes when the state does. */
  getSnapshot(): SidebarSearchState | null;
  subscribe(listener: () => void): () => void;
  /**
   * Abort the stream, cancel timers and drop every listener. The controller
   * stays usable (React Strict Mode re-runs effects on the same instance).
   */
  dispose(): void;
}

interface SessionFields {
  modified: string;
  name: string | undefined;
  firstMessage: string;
  workspaceKey: string;
  comparableWorkspaceKey: string;
  own: SearchField[];
  workspace: readonly SearchField[] | undefined;
  /** `own` plus the workspace fields. */
  fields: SearchField[];
  scoredFor: CompiledSearchQuery | null;
  score: number | null;
  pass: number;
}

interface WorkspaceFields {
  path: string;
  alias: string | undefined;
  fields: readonly SearchField[];
}

const defaultDeps: SidebarSearchDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  now: () => Date.now(),
  searchField,
};

/** Trim and cap at the server limit without leaving a dangling high surrogate (it would break `encodeURIComponent`). */
export function normalizeSearchQuery(raw: string): string {
  let query = raw.trim();
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    query = query.slice(0, MAX_SEARCH_QUERY_LENGTH);
    const last = query.charCodeAt(query.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) query = query.slice(0, -1);
    query = query.trimEnd();
  }
  return query;
}

/** Final folder name of a project path, portable across / and \ separators. */
function workspaceLabel(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function sameHits(a: readonly SidebarSearchHit[], b: readonly SidebarSearchHit[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].sessionId !== b[i].sessionId || a[i].score !== b[i].score || a[i].snippet !== b[i].snippet) return false;
  }
  return true;
}

function compareByRank(a: { score: number; modified: string }, b: { score: number; modified: string }): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.modified === b.modified) return 0;
  return a.modified < b.modified ? 1 : -1;
}

export function createSidebarSearch(overrides: Partial<SidebarSearchDeps> = {}): SidebarSearch {
  const deps: SidebarSearchDeps = { ...defaultDeps, ...overrides };

  let sessions: readonly SessionInfo[] = [];
  let projects: readonly ManagedProject[] = [];
  const sessionFields = new Map<string, SessionFields>();
  let workspaceFields = new Map<string, WorkspaceFields>();
  let pass = 0;

  let query = "";
  let compiled: CompiledSearchQuery | null = null;
  let searching = false;
  /** Transcript scores of the current query, already merged. */
  let serverScores = new Map<string, number>();
  /** Streamed scores waiting for the next merge. */
  let pending = new Map<string, number>();
  let lastMerge = Number.NEGATIVE_INFINITY;
  let debounceTimer: unknown = null;
  let mergeTimer: unknown = null;
  let stream: AbortController | null = null;

  let rankedHits: readonly SidebarSearchHit[] | null = null;
  let snapshot: SidebarSearchState | null = null;
  const listeners = new Set<() => void>();

  function fieldsFor(session: SessionInfo): SessionFields {
    const workspaceKey = workspaceKeyOf(session);
    let entry = sessionFields.get(session.id);
    if (!entry || entry.modified !== session.modified || entry.name !== session.name || entry.firstMessage !== session.firstMessage) {
      const own = [deps.searchField(session.name ?? "", TITLE_WEIGHT), deps.searchField(session.firstMessage, FIRST_MESSAGE_WEIGHT)];
      entry = {
        modified: session.modified,
        name: session.name,
        firstMessage: session.firstMessage,
        workspaceKey,
        comparableWorkspaceKey: comparableProjectPath(workspaceKey),
        own,
        workspace: undefined,
        fields: own,
        scoredFor: null,
        score: null,
        pass,
      };
      sessionFields.set(session.id, entry);
    } else if (entry.workspaceKey !== workspaceKey) {
      entry.workspaceKey = workspaceKey;
      entry.comparableWorkspaceKey = comparableProjectPath(workspaceKey);
    }
    entry.pass = pass;
    const workspace = workspaceFields.get(entry.comparableWorkspaceKey)?.fields;
    if (workspace !== entry.workspace) {
      entry.workspace = workspace;
      entry.fields = workspace ? [...entry.own, ...workspace] : entry.own;
      entry.scoredFor = null;
    }
    return entry;
  }

  function localScore(entry: SessionFields, q: CompiledSearchQuery): number | null {
    if (entry.scoredFor !== q) {
      entry.score = scoreSearchFields(entry.fields, q);
      entry.scoredFor = q;
    }
    return entry.score;
  }

  /** Local score and transcript score both cover title and first message; the transcript one adds the content, the local one the workspace. Best wins. */
  function rank(q: CompiledSearchQuery): SidebarSearchHit[] {
    pass += 1;
    const matches: { sessionId: string; score: number; modified: string }[] = [];
    for (const session of sessions) {
      let score = localScore(fieldsFor(session), q);
      const remote = serverScores.get(session.id);
      if (remote !== undefined && (score === null || remote > score)) score = remote;
      if (score !== null) matches.push({ sessionId: session.id, score, modified: session.modified });
    }
    if (sessionFields.size > sessions.length) {
      for (const [id, entry] of sessionFields) if (entry.pass !== pass) sessionFields.delete(id);
    }
    matches.sort(compareByRank);
    return matches.slice(0, MAX_SEARCH_HITS).map(({ sessionId, score }) => ({ sessionId, score, snippet: undefined }));
  }

  function publish(): void {
    let next: SidebarSearchState | null = null;
    if (compiled) {
      const hits = (rankedHits ??= rank(compiled));
      if (snapshot && snapshot.query === query && snapshot.searching === searching && sameHits(snapshot.hits, hits)) return;
      next = { query, hits: snapshot && sameHits(snapshot.hits, hits) ? snapshot.hits : hits, searching };
    } else if (snapshot === null) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  /** Move streamed scores into the ranking; the caller publishes. */
  function mergePending(): void {
    if (mergeTimer !== null) {
      deps.clearTimeout(mergeTimer);
      mergeTimer = null;
    }
    if (pending.size === 0) return;
    for (const [id, score] of pending) serverScores.set(id, score);
    pending = new Map();
    lastMerge = deps.now();
    rankedHits = null;
  }

  function scheduleMerge(): void {
    if (pending.size === 0 || mergeTimer !== null) return;
    const wait = SEARCH_MERGE_INTERVAL_MS - (deps.now() - lastMerge);
    if (wait <= 0) {
      mergePending();
      publish();
      return;
    }
    mergeTimer = deps.setTimeout(() => {
      mergeTimer = null;
      mergePending();
      publish();
    }, wait);
  }

  function collect(line: string): void {
    const text = line.trim();
    if (!text) return;
    const parsed: unknown = JSON.parse(text);
    const scores = typeof parsed === "object" && parsed !== null && "scores" in parsed ? parsed.scores : undefined;
    if (typeof scores !== "object" || scores === null || Array.isArray(scores)) return;
    for (const [id, score] of Object.entries(scores)) {
      if (typeof score === "number" && Number.isFinite(score)) pending.set(id, score);
    }
  }

  async function consume(q: string, signal: AbortSignal): Promise<void> {
    const response = await deps.fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`, { signal });
    const body = response.body;
    // A login page or proxy error answers 200 HTML: not a result stream.
    const ndjson = (response.headers.get("content-type") ?? "").toLowerCase().includes("ndjson");
    if (!response.ok || !body || !ndjson) {
      void body?.cancel().catch(() => undefined);
      return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (signal.aborted) return;
        if (done) {
          buffered += decoder.decode();
          collect(buffered);
          return;
        }
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) collect(line);
        scheduleMerge();
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }

  async function runStream(q: string, controller: AbortController): Promise<void> {
    try {
      await consume(q, controller.signal);
    } catch {
      // Network failure, abort or a malformed line: the hits found so far stay.
    }
    if (controller.signal.aborted) return;
    stream = null;
    searching = false;
    mergePending();
    publish();
  }

  function startStream(): void {
    debounceTimer = null;
    const controller = new AbortController();
    stream = controller;
    void runStream(query, controller);
  }

  /** Abort the stream and drop timers and unmerged scores; `searching` is left to the caller. */
  function cancelStream(): void {
    if (debounceTimer !== null) deps.clearTimeout(debounceTimer);
    if (mergeTimer !== null) deps.clearTimeout(mergeTimer);
    debounceTimer = null;
    mergeTimer = null;
    stream?.abort();
    stream = null;
  }

  function projectFields(): Map<string, WorkspaceFields> {
    const next = new Map<string, WorkspaceFields>();
    for (const project of projects) {
      const key = comparableProjectPath(project.path);
      const previous = workspaceFields.get(key);
      if (previous && previous.path === project.path && previous.alias === project.alias) {
        next.set(key, previous);
        continue;
      }
      const fields = [deps.searchField(workspaceLabel(project.path), WORKSPACE_WEIGHT)];
      if (project.alias) fields.push(deps.searchField(project.alias, WORKSPACE_WEIGHT));
      next.set(key, { path: project.path, alias: project.alias, fields });
    }
    return next;
  }

  return {
    setSessions(nextSessions, nextProjects) {
      if (nextSessions === sessions && nextProjects === projects) return;
      if (nextProjects !== projects) {
        projects = nextProjects;
        workspaceFields = projectFields();
      }
      sessions = nextSessions;
      rankedHits = null;
      publish();
    },

    setQuery(raw) {
      const next = normalizeSearchQuery(raw);
      if (next === query) return;
      cancelStream();
      query = next;
      compiled = compileSearchQuery(next);
      serverScores = new Map();
      pending = new Map();
      rankedHits = null;
      searching = compiled !== null;
      if (compiled) debounceTimer = deps.setTimeout(startStream, SEARCH_DEBOUNCE_MS);
      publish();
    },

    stop() {
      if (!searching) return;
      cancelStream();
      mergePending();
      searching = false;
      publish();
    },

    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      cancelStream();
      pending = new Map();
      listeners.clear();
      searching = false;
    },
  };
}
