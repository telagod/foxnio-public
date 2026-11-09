import { clampLimit, CUSTOM_STORAGE_KEY, DEFAULT_LIMIT, DEFAULT_PRESET, resolvePresetLimit, STORAGE_KEY, type RecentRunsLimitPreset } from "../hooks/useRecentRunsLimit";
import { comparableProjectPath } from "./comparable-path";
import type { ProjectSortMode } from "./project-ordering";
import type { SidebarSectionId, SidebarUiState } from "./sidebar-types";

// ============================================================================
// Persisted sidebar UI state: load/save against a Storage-like object plus the
// pure reducers the sidebar container applies. No React, no DOM, no clock:
// the container owns the state, the scheduler is injected.
//
// Persisted: collapsed workspaces, collapsed sections and the sort mode.
// Workspace expansion itself is derived from activity (see sidebar-model), so
// it is not persisted; the recent-runs limit is owned by the settings hook
// (`hooks/useRecentRunsLimit`); it is only read here. Everything else (extra
// rows, folded forks, sticky workspaces, frozen order, running-only) lives for
// the page's life.
// ============================================================================

export const COLLAPSED_PROJECTS_STORAGE_KEY = "omp-web:collapsed-projects";
export const COLLAPSED_SECTIONS_STORAGE_KEY = "omp-web:sidebar-collapsed-sections";
export const PROJECT_SORT_STORAGE_KEY = "omp-web:project-sort";

/** Rows revealed by one "Show more". */
export const SHOW_MORE_STEP = 20;
export const PERSIST_DEBOUNCE_MS = 250;

export interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SidebarUiStateScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** `ui.extraRows` key of a section's "show more" (workspace keys are absolute paths, so they never collide). */
export function sectionExtraRowsKey(section: SidebarSectionId): string {
  return `section:${section}`;
}

export function createDefaultSidebarUiState(): SidebarUiState {
  return {
    sortMode: "updated",
    runningOnly: false,
    recentRunsLimit: DEFAULT_LIMIT,
    collapsedProjects: new Set(),
    collapsedSections: new Set(),
    extraRows: new Map(),
    collapsedForks: new Set(),
    stickyOpenProjects: new Set(),
    orderFrozen: false,
  };
}

// ---- Loading ----------------------------------------------------------------

function readStringArray(storage: SidebarStorage, key: string): string[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

/** Project keys are stored in comparable form; older entries may carry raw spellings, so fold on read. */
function readProjectKeys(storage: SidebarStorage, key: string): Set<string> {
  return new Set(readStringArray(storage, key).map(comparableProjectPath));
}

function readSortMode(storage: SidebarStorage): ProjectSortMode {
  try {
    const raw = storage.getItem(PROJECT_SORT_STORAGE_KEY);
    return raw === "alphabetical" || raw === "none" ? raw : "updated";
  } catch {
    return "updated";
  }
}

function readRecentRunsLimit(storage: SidebarStorage): number {
  try {
    const rawPreset = storage.getItem(STORAGE_KEY);
    const preset: RecentRunsLimitPreset =
      rawPreset === "10" || rawPreset === "15" || rawPreset === "20" || rawPreset === "custom" ? rawPreset : DEFAULT_PRESET;
    const rawCustom = storage.getItem(CUSTOM_STORAGE_KEY);
    const custom = clampLimit(rawCustom !== null ? Number.parseInt(rawCustom, 10) : DEFAULT_LIMIT);
    return resolvePresetLimit(preset, custom);
  } catch {
    return DEFAULT_LIMIT;
  }
}

/**
 * Persisted state from `storage`. Missing keys, corrupt JSON and storage
 * errors fall back to the defaults silently. A null storage (server render,
 * blocked storage) yields the defaults.
 */
export function loadSidebarUiState(storage: SidebarStorage | null | undefined): SidebarUiState {
  const defaults = createDefaultSidebarUiState();
  if (!storage) return defaults;
  const sections = new Set<SidebarSectionId>();
  for (const id of readStringArray(storage, COLLAPSED_SECTIONS_STORAGE_KEY)) {
    if (id === "pinned") sections.add(id);
  }
  return {
    ...defaults,
    sortMode: readSortMode(storage),
    recentRunsLimit: readRecentRunsLimit(storage),
    collapsedProjects: readProjectKeys(storage, COLLAPSED_PROJECTS_STORAGE_KEY),
    collapsedSections: sections,
  };
}

// ---- Persisting -------------------------------------------------------------

/** Storage value per persisted key; null removes the key. */
function serialize(state: SidebarUiState): ReadonlyMap<string, string | null> {
  const list = (values: ReadonlySet<string>): string | null => (values.size === 0 ? null : JSON.stringify([...values]));
  return new Map<string, string | null>([
    [COLLAPSED_PROJECTS_STORAGE_KEY, list(state.collapsedProjects)],
    [COLLAPSED_SECTIONS_STORAGE_KEY, list(state.collapsedSections)],
    [PROJECT_SORT_STORAGE_KEY, state.sortMode === "updated" ? null : state.sortMode],
  ]);
}

function writeState(storage: SidebarStorage, state: SidebarUiState): void {
  for (const [key, value] of serialize(state)) {
    try {
      // Compare with what is stored so unchanged keys cost no write and a
      // corrupt stored value is replaced by the real state.
      if (storage.getItem(key) === value) continue;
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch {
      // Quota exceeded or private browsing: the sidebar works without persistence.
    }
  }
}

export interface SidebarUiStatePersister {
  /** Queue `state` for writing; the latest queued state is written after the debounce. */
  schedule(state: SidebarUiState): void;
  /** Write the queued state now (call on `pagehide`). No-op when nothing is queued. */
  flush(): void;
  /** Drop the queued state without writing (unmount after a flush). */
  cancel(): void;
}

const defaultScheduler: SidebarUiStateScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSidebarUiStatePersister(
  storage: SidebarStorage | null | undefined,
  scheduler: SidebarUiStateScheduler = defaultScheduler,
): SidebarUiStatePersister {
  let queued: SidebarUiState | null = null;
  let timer: unknown = null;

  const stopTimer = () => {
    if (timer === null) return;
    scheduler.clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    stopTimer();
    const state = queued;
    queued = null;
    if (state && storage) writeState(storage, state);
  };
  return {
    schedule(state) {
      queued = state;
      stopTimer();
      timer = scheduler.setTimeout(flush, PERSIST_DEBOUNCE_MS);
    },
    flush,
    cancel() {
      stopTimer();
      queued = null;
    },
  };
}

// ---- Reducers ---------------------------------------------------------------
// Pure and referentially stable: an action that changes nothing returns the
// same state object so React bails out of the render.

function withKey<T>(values: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (values.has(value)) return values;
  const next = new Set(values);
  next.add(value);
  return next;
}

function withoutKey<T>(values: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (!values.has(value)) return values;
  const next = new Set(values);
  next.delete(value);
  return next;
}

/**
 * The chevron of a workspace. `expanded` is what the row currently shows
 * (including auto-open); collapsing records an explicit collapse and ends
 * stickiness, expanding clears the collapse.
 */
export function toggleProject(state: SidebarUiState, projectKey: string, expanded: boolean): SidebarUiState {
  const key = comparableProjectPath(projectKey);
  if (expanded) {
    return {
      ...state,
      collapsedProjects: withKey(state.collapsedProjects, key),
      stickyOpenProjects: withoutKey(state.stickyOpenProjects, key),
    };
  }
  return {
    ...state,
    collapsedProjects: withoutKey(state.collapsedProjects, key),
    stickyOpenProjects: withKey(state.stickyOpenProjects, key),
  };
}

/** Open a workspace because the user navigated into it (selecting it overrides an earlier explicit collapse). */
export function openProject(state: SidebarUiState, projectKey: string): SidebarUiState {
  const key = comparableProjectPath(projectKey);
  if (!state.collapsedProjects.has(key)) return state;
  return { ...state, collapsedProjects: withoutKey(state.collapsedProjects, key) };
}

/** Section header chevron; `workspaces` is not collapsible. */
export function toggleSection(state: SidebarUiState, section: SidebarSectionId): SidebarUiState {
  if (section === "workspaces") return state;
  return {
    ...state,
    collapsedSections: state.collapsedSections.has(section) ? withoutKey(state.collapsedSections, section) : withKey(state.collapsedSections, section),
  };
}

/** "Show more" of a workspace (its key) or of a section (`sectionExtraRowsKey`). */
export function showMore(state: SidebarUiState, key: string, step: number = SHOW_MORE_STEP): SidebarUiState {
  const next = new Map(state.extraRows);
  next.set(key, (state.extraRows.get(key) ?? 0) + step);
  return { ...state, extraRows: next };
}

export function showLess(state: SidebarUiState, key: string): SidebarUiState {
  if (!state.extraRows.has(key)) return state;
  const next = new Map(state.extraRows);
  next.delete(key);
  return { ...state, extraRows: next };
}

/** Fold or unfold the fork children of a session. */
export function toggleFork(state: SidebarUiState, sessionId: string): SidebarUiState {
  return {
    ...state,
    collapsedForks: state.collapsedForks.has(sessionId) ? withoutKey(state.collapsedForks, sessionId) : withKey(state.collapsedForks, sessionId),
  };
}

/** A sort change is a user ordering action: it also ends the order freeze. */
export function setSortMode(state: SidebarUiState, sortMode: ProjectSortMode): SidebarUiState {
  if (state.sortMode === sortMode) return state;
  return { ...state, sortMode, orderFrozen: false };
}

export function setRunningOnly(state: SidebarUiState, runningOnly: boolean): SidebarUiState {
  return state.runningOnly === runningOnly ? state : { ...state, runningOnly };
}

export function setRecentRunsLimit(state: SidebarUiState, limit: number): SidebarUiState {
  const next = clampLimit(limit);
  return state.recentRunsLimit === next ? state : { ...state, recentRunsLimit: next };
}

/** Keep a workspace open after the user navigated away from it, so rows do not jump under the pointer. */
export function markStickyOpen(state: SidebarUiState, projectKey: string): SidebarUiState {
  const key = comparableProjectPath(projectKey);
  if (state.stickyOpenProjects.has(key)) return state;
  return { ...state, stickyOpenProjects: withKey(state.stickyOpenProjects, key) };
}

export function setOrderFrozen(state: SidebarUiState, orderFrozen: boolean): SidebarUiState {
  return state.orderFrozen === orderFrozen ? state : { ...state, orderFrozen };
}

/**
 * Drop workspace keys that no longer exist so the stored sets stay bounded.
 * `projectsLoaded` MUST be true only after the first projects fetch finished:
 * while the list is still loading it is empty and pruning would wipe the
 * stored expansion. Pass `SidebarModel.projectOrder` (or the registered
 * project paths plus any in-memory workspaces) as `knownProjects`.
 */
export function pruneProjects(state: SidebarUiState, knownProjects: Iterable<string>, projectsLoaded: boolean): SidebarUiState {
  if (!projectsLoaded) return state;
  const known = new Set<string>();
  for (const project of knownProjects) known.add(comparableProjectPath(project));
  const keep = (values: ReadonlySet<string>): ReadonlySet<string> => {
    for (const value of values) {
      if (!known.has(value)) return new Set([...values].filter((item) => known.has(item)));
    }
    return values;
  };
  const collapsedProjects = keep(state.collapsedProjects);
  const stickyOpenProjects = keep(state.stickyOpenProjects);
  let extraRows = state.extraRows;
  for (const key of state.extraRows.keys()) {
    if (key.startsWith("section:") || known.has(key)) continue;
    extraRows = new Map([...state.extraRows].filter(([item]) => item.startsWith("section:") || known.has(item)));
    break;
  }
  if (
    collapsedProjects === state.collapsedProjects &&
    stickyOpenProjects === state.stickyOpenProjects &&
    extraRows === state.extraRows
  ) {
    return state;
  }
  return { ...state, collapsedProjects, stickyOpenProjects, extraRows };
}
