import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const ui = await jiti.import("./sidebar-ui-state.ts");
const {
  COLLAPSED_PROJECTS_STORAGE_KEY,
  COLLAPSED_SECTIONS_STORAGE_KEY,
  EXPANDED_PROJECTS_STORAGE_KEY,
  PERSIST_DEBOUNCE_MS,
  PROJECT_SORT_STORAGE_KEY,
  SHOW_MORE_STEP,
  createDefaultSidebarUiState,
  createSidebarUiStatePersister,
  loadSidebarUiState,
  markStickyOpen,
  openProject,
  pruneProjects,
  sectionExtraRowsKey,
  setOrderFrozen,
  setRecentRunsLimit,
  setRunningOnly,
  setSortMode,
  showLess,
  showMore,
  toggleFork,
  toggleProject,
  toggleSection,
} = ui;

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  return {
    data,
    writes,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem(key, value) {
      writes.push(["set", key]);
      data.set(key, value);
    },
    removeItem(key) {
      writes.push(["remove", key]);
      data.delete(key);
    },
  };
}

function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pending: () => timers.size,
  };
}

test("defaults apply for empty or unavailable storage", () => {
  const defaults = createDefaultSidebarUiState();
  assert.deepEqual(loadSidebarUiState(null), defaults);
  assert.deepEqual(loadSidebarUiState(undefined), defaults);
  assert.deepEqual(loadSidebarUiState(fakeStorage()), defaults);
  assert.equal(defaults.sortMode, "none");
  assert.equal(defaults.recentRunsLimit, 10);
  assert.equal(defaults.orderFrozen, false);
});

test("loads the existing storage formats", () => {
  const storage = fakeStorage({
    [EXPANDED_PROJECTS_STORAGE_KEY]: JSON.stringify(["/home/me/app", "c:/work/api"]),
    [PROJECT_SORT_STORAGE_KEY]: "updated",
    "omp-recent-runs-limit": "custom",
    "omp-recent-runs-custom-limit": "37",
  });
  const state = loadSidebarUiState(storage);
  assert.deepEqual([...state.expandedProjects], ["/home/me/app", "c:/work/api"]);
  assert.equal(state.sortMode, "updated");
  assert.equal(state.recentRunsLimit, 37);
});

test("recent-runs limit follows the preset, clamps custom values and survives bad values", () => {
  const limitOf = (values) => loadSidebarUiState(fakeStorage(values)).recentRunsLimit;
  assert.equal(limitOf({ "omp-recent-runs-limit": "15" }), 15);
  assert.equal(limitOf({ "omp-recent-runs-limit": "20", "omp-recent-runs-custom-limit": "50" }), 20);
  assert.equal(limitOf({ "omp-recent-runs-limit": "custom", "omp-recent-runs-custom-limit": "9999" }), 100);
  assert.equal(limitOf({ "omp-recent-runs-limit": "custom", "omp-recent-runs-custom-limit": "0" }), 1);
  assert.equal(limitOf({ "omp-recent-runs-limit": "custom", "omp-recent-runs-custom-limit": "abc" }), 10);
  assert.equal(limitOf({ "omp-recent-runs-limit": "bogus" }), 10);
});

test("expanded keys written in raw spellings are migrated to comparable keys", () => {
  const storage = fakeStorage({
    [EXPANDED_PROJECTS_STORAGE_KEY]: JSON.stringify(["C:\\Work\\App\\", "c:/work/app", "/home/me/App/", ""]),
    [COLLAPSED_PROJECTS_STORAGE_KEY]: JSON.stringify(["D:\\Old"]),
  });
  const state = loadSidebarUiState(storage);
  assert.deepEqual([...state.expandedProjects], ["c:/work/app", "/home/me/App"]);
  assert.deepEqual([...state.collapsedProjects], ["d:/old"]);
});

test("corrupt values fall back to defaults silently", () => {
  const cases = [
    { [EXPANDED_PROJECTS_STORAGE_KEY]: "{not json" },
    { [EXPANDED_PROJECTS_STORAGE_KEY]: JSON.stringify({ a: 1 }) },
    { [EXPANDED_PROJECTS_STORAGE_KEY]: JSON.stringify([1, null, {}]) },
    { [COLLAPSED_SECTIONS_STORAGE_KEY]: "nope" },
    { [PROJECT_SORT_STORAGE_KEY]: "sideways" },
  ];
  for (const values of cases) {
    const state = loadSidebarUiState(fakeStorage(values));
    assert.equal(state.expandedProjects.size, 0);
    assert.equal(state.collapsedSections.size, 0);
    assert.equal(state.sortMode, "none");
  }
});

test("a storage that throws on read yields defaults", () => {
  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {},
    removeItem() {},
  };
  assert.deepEqual(loadSidebarUiState(throwing), createDefaultSidebarUiState());
});

test("only collapsible sections are accepted from storage", () => {
  const storage = fakeStorage({ [COLLAPSED_SECTIONS_STORAGE_KEY]: JSON.stringify(["active", "workspaces", "pinned", "x"]) });
  assert.deepEqual([...loadSidebarUiState(storage).collapsedSections].sort(), ["active", "pinned"]);
});

test("persister debounces writes and writes only the latest state", () => {
  const storage = fakeStorage();
  const scheduler = fakeScheduler();
  const persister = createSidebarUiStatePersister(storage, scheduler);
  let state = createDefaultSidebarUiState();

  state = toggleProject(state, "/a", false);
  persister.schedule(state);
  scheduler.advance(PERSIST_DEBOUNCE_MS - 1);
  assert.equal(storage.writes.length, 0);

  state = toggleProject(state, "/b", false);
  persister.schedule(state);
  scheduler.advance(PERSIST_DEBOUNCE_MS - 1);
  assert.equal(storage.writes.length, 0, "a newer schedule restarts the debounce");

  scheduler.advance(1);
  assert.deepEqual(JSON.parse(storage.data.get(EXPANDED_PROJECTS_STORAGE_KEY)), ["/a", "/b"]);
  assert.equal(PERSIST_DEBOUNCE_MS, 250);
  assert.equal(scheduler.pending(), 0);
});

test("flush writes immediately and cancels the timer; flush without a queue is a no-op", () => {
  const storage = fakeStorage();
  const scheduler = fakeScheduler();
  const persister = createSidebarUiStatePersister(storage, scheduler);

  persister.flush();
  assert.equal(storage.writes.length, 0);

  persister.schedule(setSortMode(createDefaultSidebarUiState(), "alphabetical"));
  persister.flush();
  assert.equal(storage.data.get(PROJECT_SORT_STORAGE_KEY), "alphabetical");
  assert.equal(scheduler.pending(), 0);

  storage.writes.length = 0;
  persister.flush();
  scheduler.advance(1000);
  assert.equal(storage.writes.length, 0);
});

test("cancel drops the queued state", () => {
  const storage = fakeStorage();
  const scheduler = fakeScheduler();
  const persister = createSidebarUiStatePersister(storage, scheduler);
  persister.schedule(toggleProject(createDefaultSidebarUiState(), "/a", false));
  persister.cancel();
  scheduler.advance(1000);
  persister.flush();
  assert.equal(storage.writes.length, 0);
});

test("default values remove keys; unchanged keys are not rewritten", () => {
  const storage = fakeStorage({ [PROJECT_SORT_STORAGE_KEY]: "updated", [COLLAPSED_SECTIONS_STORAGE_KEY]: JSON.stringify(["active"]) });
  const persister = createSidebarUiStatePersister(storage, fakeScheduler());
  const loaded = loadSidebarUiState(storage);

  persister.schedule(loaded);
  persister.flush();
  assert.deepEqual(storage.writes, [], "state equal to storage causes no writes");

  persister.schedule(toggleSection(setSortMode(loaded, "none"), "active"));
  persister.flush();
  assert.equal(storage.data.has(PROJECT_SORT_STORAGE_KEY), false);
  assert.equal(storage.data.has(COLLAPSED_SECTIONS_STORAGE_KEY), false);
});

test("a corrupt stored value is replaced by the real state on the next write", () => {
  const storage = fakeStorage({ [EXPANDED_PROJECTS_STORAGE_KEY]: "{broken" });
  const persister = createSidebarUiStatePersister(storage, fakeScheduler());
  persister.schedule(toggleProject(loadSidebarUiState(storage), "/a", false));
  persister.flush();
  assert.deepEqual(JSON.parse(storage.data.get(EXPANDED_PROJECTS_STORAGE_KEY)), ["/a"]);
});

test("write errors (quota, private mode) are swallowed and later writes still happen", () => {
  const data = new Map();
  let failures = 1;
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem(key, value) {
      if (failures-- > 0) throw new Error("QuotaExceededError");
      data.set(key, value);
    },
    removeItem: (key) => data.delete(key),
  };
  const persister = createSidebarUiStatePersister(storage, fakeScheduler());
  const state = setSortMode(toggleProject(createDefaultSidebarUiState(), "/a", false), "updated");
  persister.schedule(state);
  assert.doesNotThrow(() => persister.flush());
  persister.schedule(state);
  persister.flush();
  assert.ok(data.has(PROJECT_SORT_STORAGE_KEY) || data.has(EXPANDED_PROJECTS_STORAGE_KEY));
});

test("a persister without storage does nothing", () => {
  const scheduler = fakeScheduler();
  const persister = createSidebarUiStatePersister(null, scheduler);
  persister.schedule(createDefaultSidebarUiState());
  assert.doesNotThrow(() => scheduler.advance(1000));
  assert.doesNotThrow(() => persister.flush());
});

test("persisting then loading round-trips the persisted fields only", () => {
  const storage = fakeStorage();
  const persister = createSidebarUiStatePersister(storage, fakeScheduler());
  let state = createDefaultSidebarUiState();
  state = toggleProject(state, "C:\\Work\\App", false);
  state = toggleProject(state, "/home/me/x", false);
  state = toggleProject(state, "/home/me/x", true);
  state = toggleSection(state, "pinned");
  state = setSortMode(state, "alphabetical");
  state = showMore(state, "c:/work/app");
  state = toggleFork(state, "s1");
  state = markStickyOpen(state, "/z");
  state = setRunningOnly(state, true);
  persister.schedule(state);
  persister.flush();

  const loaded = loadSidebarUiState(storage);
  assert.deepEqual([...loaded.expandedProjects], ["c:/work/app"]);
  assert.deepEqual([...loaded.collapsedProjects], ["/home/me/x"]);
  assert.deepEqual([...loaded.collapsedSections], ["pinned"]);
  assert.equal(loaded.sortMode, "alphabetical");
  assert.equal(loaded.extraRows.size, 0);
  assert.equal(loaded.collapsedForks.size, 0);
  assert.equal(loaded.stickyOpenProjects.size, 0);
  assert.equal(loaded.runningOnly, false);
});

test("toggleProject records explicit collapses and clears them on expand", () => {
  const start = createDefaultSidebarUiState();
  const opened = toggleProject(start, "/a", false);
  assert.deepEqual([...opened.expandedProjects], ["/a"]);
  const closed = toggleProject(opened, "/a", true);
  assert.equal(closed.expandedProjects.has("/a"), false);
  assert.equal(closed.collapsedProjects.has("/a"), true);
  const reopened = toggleProject(closed, "/a", false);
  assert.equal(reopened.collapsedProjects.has("/a"), false);
  assert.equal(reopened.expandedProjects.has("/a"), true);
  assert.equal(start.expandedProjects.size, 0, "inputs are not mutated");
});

test("collapsing a workspace ends its stickiness; Windows spellings share one key", () => {
  let state = markStickyOpen(createDefaultSidebarUiState(), "C:\\Work\\App");
  assert.equal(state.stickyOpenProjects.has("c:/work/app"), true);
  state = toggleProject(state, "c:/work/app", true);
  assert.equal(state.stickyOpenProjects.size, 0);
  assert.equal(state.collapsedProjects.has("c:/work/app"), true);
});

test("openProject clears an explicit collapse and is a no-op when already open", () => {
  const collapsed = toggleProject(toggleProject(createDefaultSidebarUiState(), "/a", false), "/a", true);
  const opened = openProject(collapsed, "/a");
  assert.equal(opened.expandedProjects.has("/a"), true);
  assert.equal(opened.collapsedProjects.has("/a"), false);
  assert.equal(openProject(opened, "/a"), opened);
});

test("sections toggle; the workspaces section is not collapsible", () => {
  const start = createDefaultSidebarUiState();
  const collapsed = toggleSection(start, "active");
  assert.deepEqual([...collapsed.collapsedSections], ["active"]);
  assert.deepEqual([...toggleSection(collapsed, "active").collapsedSections], []);
  assert.equal(toggleSection(start, "workspaces"), start);
});

test("showMore accumulates per key and showLess resets it", () => {
  let state = createDefaultSidebarUiState();
  state = showMore(state, "/a");
  state = showMore(state, "/a");
  state = showMore(state, sectionExtraRowsKey("active"), 3);
  assert.equal(state.extraRows.get("/a"), 2 * SHOW_MORE_STEP);
  assert.equal(SHOW_MORE_STEP, 20);
  assert.equal(state.extraRows.get("section:active"), 3);
  const less = showLess(state, "/a");
  assert.equal(less.extraRows.has("/a"), false);
  assert.equal(less.extraRows.get("section:active"), 3);
  assert.equal(showLess(less, "/a"), less);
});

test("toggleFork folds and unfolds", () => {
  const folded = toggleFork(createDefaultSidebarUiState(), "s1");
  assert.equal(folded.collapsedForks.has("s1"), true);
  assert.equal(toggleFork(folded, "s1").collapsedForks.size, 0);
});

test("simple setters return the same state when nothing changes", () => {
  const state = createDefaultSidebarUiState();
  assert.equal(setSortMode(state, "none"), state);
  assert.equal(setRunningOnly(state, false), state);
  assert.equal(setRecentRunsLimit(state, 10), state);
  assert.equal(setOrderFrozen(state, false), state);
  assert.equal(markStickyOpen(markStickyOpen(state, "/a"), "/a").stickyOpenProjects.size, 1);
  assert.equal(setRunningOnly(state, true).runningOnly, true);
  assert.equal(setOrderFrozen(state, true).orderFrozen, true);
});

test("setRecentRunsLimit clamps to the supported range", () => {
  const state = createDefaultSidebarUiState();
  assert.equal(setRecentRunsLimit(state, 0).recentRunsLimit, 1);
  assert.equal(setRecentRunsLimit(state, 1000).recentRunsLimit, 100);
  assert.equal(setRecentRunsLimit(state, 15.4).recentRunsLimit, 15);
});

test("changing the sort mode ends the order freeze", () => {
  const frozen = setOrderFrozen(createDefaultSidebarUiState(), true);
  const sorted = setSortMode(frozen, "updated");
  assert.equal(sorted.sortMode, "updated");
  assert.equal(sorted.orderFrozen, false);
});

test("pruneProjects never prunes before projects have loaded", () => {
  let state = createDefaultSidebarUiState();
  state = toggleProject(state, "/a", false);
  state = toggleProject(state, "/b", false);
  assert.equal(pruneProjects(state, [], false), state);
  assert.equal(pruneProjects(state, ["/a", "/b"], true), state);
});

test("pruneProjects drops stale keys everywhere but keeps section keys, comparing Windows paths case-insensitively", () => {
  let state = createDefaultSidebarUiState();
  state = toggleProject(state, "C:\\Work\\App", false);
  state = toggleProject(state, "/gone", false);
  state = toggleProject(state, "/gone2", true);
  state = markStickyOpen(state, "/gone");
  state = showMore(state, "/gone");
  state = showMore(state, "c:/work/app");
  state = showMore(state, sectionExtraRowsKey("pinned"));
  const pruned = pruneProjects(state, ["c:\\WORK\\app"], true);
  assert.deepEqual([...pruned.expandedProjects], ["c:/work/app"]);
  assert.equal(pruned.collapsedProjects.size, 0);
  assert.equal(pruned.stickyOpenProjects.size, 0);
  assert.deepEqual([...pruned.extraRows.keys()].sort(), ["c:/work/app", "section:pinned"]);
});
