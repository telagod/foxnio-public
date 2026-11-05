import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { INITIAL_RESTORE_MAX_ATTEMPTS, INITIAL_RESTORE_RETRY_MS, nextRestoreStep } = await jiti.import("./restore-plan.ts");
const {
  keepOpenWhenLeaving,
  planDefaultWorkspace,
  planGroupClick,
  resolveProjectRoot,
  selectionAfterRemoval,
  topWorkspacePath,
} = await jiti.import("./workspace-selection.ts");
const {
  MAX_PROJECT_UPDATES,
  addProject,
  batchUpdates,
  moveWorkspacePath,
  orderUpdates,
  persistOrder,
  pinUpdate,
  removeProject,
  reorderableWorkspacePaths,
  updateProject,
} = await jiti.import("./project-requests.ts");
const {
  NO_WORKTREE_STATES,
  buildWorktreeContext,
  hasWorktreeSwitcher,
  withCreatedWorktree,
  withFetchedWorktreeState,
  withoutWorktree,
} = await jiti.import("./worktree-state.ts");
const { createWorktree, fetchWorktrees, removeWorktree } = await jiti.import("./worktree-api.ts");
const { frozenOrderFor, hasPendingNewSession, orderingKey } = await jiti.import("./pending-order.ts");
const { isEditableTarget, shouldFocusSearch } = await jiti.import("./global-keys.ts");
const { combineLoadState } = await jiti.import("./load-state.ts");
const { recentRunsChoice } = await jiti.import("./recent-runs-choice.ts");
const {
  archiveSessionRequest,
  deleteSessionRequest,
  fetchTranscript,
  hasForkChildren,
  importSessionRequest,
  placeholderSession,
  renameSessionRequest,
} = await jiti.import("./session-requests.ts");
const { createDefaultSidebarUiState, toggleProject } = await jiti.import("@/lib/sidebar-ui-state.ts");

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A fetch that answers from `answers` in order and records the calls. */
function fakeFetch(...answers) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchFn, calls };
}

// ---- Restore -------------------------------------------------------------------

test("a missing session is looked up again once a second, for up to eight retries", () => {
  for (let failed = 1; failed <= INITIAL_RESTORE_MAX_ATTEMPTS; failed++) {
    assert.deepEqual(nextRestoreStep(failed), { action: "retry", delayMs: INITIAL_RESTORE_RETRY_MS });
  }
  assert.deepEqual(nextRestoreStep(INITIAL_RESTORE_MAX_ATTEMPTS + 1), { action: "give-up" });
  assert.equal(INITIAL_RESTORE_MAX_ATTEMPTS, 8);
  assert.equal(INITIAL_RESTORE_RETRY_MS, 1000);
});

// ---- Workspace selection ---------------------------------------------------------

test("a worktree resolves to the repository whose Git state lists it, not to another one", () => {
  const states = [
    { projectRoot: "/w/other", worktrees: [{ path: "/w/other", branch: "main", isMain: true }] },
    { projectRoot: "/w/app", worktrees: [{ path: "/w/app", branch: "main", isMain: true }, { path: "/w/app-feature", branch: "feature", isMain: false }] },
  ];
  const root = resolveProjectRoot("/w/app-feature/", { worktreeStates: states, projects: [], sessions: [] });
  assert.equal(root, "/w/app");
});

test("without Git state a cwd resolves through the registry, then a session, then itself", () => {
  const projects = [{ path: "C:\\Work\\App" }];
  const sessions = [{ cwd: "/w/lib/sub", projectRoot: "/w/lib" }];
  const sources = { worktreeStates: [], projects, sessions };
  assert.equal(resolveProjectRoot(null, sources), null);
  assert.equal(resolveProjectRoot("c:/work/app", sources), "C:\\Work\\App", "Windows-form paths compare case-folded and return the registered spelling");
  assert.equal(resolveProjectRoot("/w/lib/sub", sources), "/w/lib");
  assert.equal(resolveProjectRoot("/w/unknown", sources), "/w/unknown");
});

test("the top workspace is returned with its registered spelling", () => {
  const projects = [{ path: "C:\\Work\\App" }];
  assert.equal(topWorkspacePath(["c:/work/app", "/x"], projects), "C:\\Work\\App");
  assert.equal(topWorkspacePath(["/live/only"], projects), "/live/only");
  assert.equal(topWorkspacePath([], projects), null);
});

test("the automatic workspace pick waits for a restore, respects the user and re-picks while provisional", () => {
  const base = { selectedCwd: null, provisional: false, topPath: "/w/app", sessionsEmpty: false, restorePending: false, skipInitialSelection: false };
  assert.deepEqual(planDefaultWorkspace(base), { cwd: "/w/app", provisional: false });
  assert.deepEqual(planDefaultWorkspace({ ...base, sessionsEmpty: true }), { cwd: "/w/app", provisional: true }, "picked before the sessions arrived");
  assert.equal(planDefaultWorkspace({ ...base, restorePending: true }), null);
  assert.equal(planDefaultWorkspace({ ...base, skipInitialSelection: true }), null);
  assert.equal(planDefaultWorkspace({ ...base, topPath: null }), null);
  assert.equal(planDefaultWorkspace({ ...base, selectedCwd: "/w/mine" }), null, "a chosen workspace stays");
  assert.deepEqual(planDefaultWorkspace({ ...base, selectedCwd: "/w/auto", provisional: true, topPath: "/w/better" }), { cwd: "/w/better", provisional: false });
});

test("clicking an unselected workspace selects and opens it; clicking the selected one toggles", () => {
  assert.equal(planGroupClick({ selected: false, expanded: true }), "select-and-open");
  assert.equal(planGroupClick({ selected: false, expanded: false }), "select-and-open");
  assert.equal(planGroupClick({ selected: true, expanded: true }), "toggle");
  assert.equal(planGroupClick({ selected: true, expanded: false }), "toggle");
});

test("the workspace being left stays open unless the user folded it", () => {
  const ui = createDefaultSidebarUiState();
  assert.ok(keepOpenWhenLeaving(ui, "/w/app").stickyOpenProjects.has("/w/app"));
  const folded = toggleProject(ui, "/w/app", true);
  assert.equal(keepOpenWhenLeaving(folded, "/w/app"), folded);
  assert.ok(keepOpenWhenLeaving(ui, "C:\\Work\\App").stickyOpenProjects.has("c:/work/app"), "stored in comparable form");
});

test("removing the selected workspace moves the selection to another one", () => {
  const paths = ["/w/a", "/w/b", "/w/c"];
  assert.equal(selectionAfterRemoval("/w/a", "/w/a", paths), "/w/b");
  assert.equal(selectionAfterRemoval("/w/b", "/w/b", paths), "/w/a");
  assert.equal(selectionAfterRemoval("/w/a", "/w/a", ["/w/a"]), null);
  assert.equal(selectionAfterRemoval("/w/c", "/w/a", paths), undefined, "another workspace was removed");
  assert.equal(selectionAfterRemoval(null, "/w/a", paths), undefined);
  assert.equal(selectionAfterRemoval("c:/work/app", "C:\\Work\\App", ["C:\\Work\\App", "/w/b"]), "/w/b", "compared case-folded");
});

// ---- Workspace ordering requests ---------------------------------------------------

test("reorderable workspaces are all of them in manual mode and only the pinned ones while a sort is active", () => {
  const projects = [{ path: "/w/a", pinOrder: 1 }, { path: "/w/b" }, { path: "/w/c", pinOrder: 0 }];
  const order = ["/w/c", "/w/a", "/w/b", "/live"];
  assert.deepEqual(reorderableWorkspacePaths(order, projects, false), ["/w/c", "/w/a", "/w/b", "/live"]);
  assert.deepEqual(reorderableWorkspacePaths(order, projects, true), ["/w/c", "/w/a"]);
});

test("a workspace moves one step; edges and unknown workspaces do not move", () => {
  const paths = ["/w/a", "/w/b", "/w/c"];
  assert.deepEqual(moveWorkspacePath(paths, "/w/b", -1), ["/w/b", "/w/a", "/w/c"]);
  assert.deepEqual(moveWorkspacePath(paths, "/w/b", 1), ["/w/a", "/w/c", "/w/b"]);
  assert.equal(moveWorkspacePath(paths, "/w/a", -1), null);
  assert.equal(moveWorkspacePath(paths, "/w/c", 1), null);
  assert.equal(moveWorkspacePath(paths, "/w/zzz", 1), null);
  assert.deepEqual(paths, ["/w/a", "/w/b", "/w/c"], "the input is not mutated");
});

test("order updates carry the absolute position: pinOrder while a sort is active, else sortOrder", () => {
  assert.deepEqual(orderUpdates(["/a", "/b"], false), [{ cwd: "/a", sortOrder: 0 }, { cwd: "/b", sortOrder: 1 }]);
  assert.deepEqual(orderUpdates(["/a", "/b"], true), [{ cwd: "/a", pinOrder: 0 }, { cwd: "/b", pinOrder: 1 }]);
});

test("updates are split into batches the server accepts", () => {
  const updates = Array.from({ length: 1201 }, (_, index) => index);
  const batches = batchUpdates(updates);
  assert.deepEqual(batches.map((batch) => batch.length), [500, 500, 201]);
  assert.deepEqual(batches.flat(), updates);
  assert.deepEqual(batchUpdates([]), []);
  assert.equal(MAX_PROJECT_UPDATES, 500);
});

test("persisting an order sends every batch and stops at the first refusal", async () => {
  const updates = Array.from({ length: 1200 }, (_, index) => ({ cwd: `/w/${index}`, sortOrder: index }));
  const ok = fakeFetch(json({}));
  assert.equal(await persistOrder(ok.fetchFn, updates), true);
  assert.deepEqual(ok.calls.map((call) => call.body.updates.length), [500, 500, 200]);
  assert.ok(ok.calls.every((call) => call.method === "PATCH" && call.url === "/api/projects"));

  const refused = fakeFetch(json({}), json({}, 500), json({}));
  assert.equal(await persistOrder(refused.fetchFn, updates), false);
  assert.equal(refused.calls.length, 2);
});

test("pinning places a workspace after the pinned ones; unpinning clears the order", () => {
  const projects = [{ path: "/a", pinOrder: 0 }, { path: "/b", pinOrder: 3 }, { path: "/c" }];
  assert.deepEqual(pinUpdate({ path: "/c" }, projects, true), { cwd: "/c", pinOrder: 4 });
  assert.deepEqual(pinUpdate({ path: "/a" }, projects, false), { cwd: "/a", pinOrder: null });
  assert.deepEqual(pinUpdate({ path: "/c" }, [{ path: "/c" }], true), { cwd: "/c", pinOrder: 0 });
});

test("project requests post the documented bodies and report failures", async () => {
  const patch = fakeFetch(json({}));
  assert.equal(await updateProject(patch.fetchFn, "/w/a", { alias: "A" }), true);
  assert.deepEqual(patch.calls, [{ url: "/api/projects", method: "PATCH", body: { cwd: "/w/a", alias: "A" } }]);
  assert.equal(await updateProject(fakeFetch(json({}, 500)).fetchFn, "/w/a", { alias: "A" }), false);

  const added = fakeFetch(json({ project: { path: "/w/a" } }));
  assert.deepEqual(await addProject(added.fetchFn, "/w/a", { advisor: true }), { ok: true, value: { path: "/w/a" } });
  assert.deepEqual(added.calls[0].body, { cwd: "/w/a", launchConfig: { advisor: true } });
  const refused = await addProject(fakeFetch(json({ error: "Not a directory" }, 400)).fetchFn, "/nope");
  assert.deepEqual(refused, { ok: false, error: "Not a directory" });
  assert.deepEqual(await addProject(fakeFetch(json({}, 500)).fetchFn, "/nope"), { ok: false, error: "HTTP 500" });

  const removed = fakeFetch(json({ success: true }));
  assert.deepEqual(await removeProject(removed.fetchFn, "/w/a"), { ok: true, value: true });
  assert.deepEqual(removed.calls, [{ url: "/api/projects", method: "DELETE", body: { cwd: "/w/a" } }]);
  assert.equal((await removeProject(fakeFetch(json({ success: false }, 200)).fetchFn, "/w/a")).ok, false);
});

// ---- Worktrees ---------------------------------------------------------------------

const repo = (overrides = {}) => ({
  projectRoot: "/w/app",
  isGit: true,
  isTopLevel: true,
  worktrees: [{ path: "/w/app", branch: "main", isMain: true }],
  ...overrides,
});

test("a fetched answer is cached per repository; failures and non-repos change nothing", () => {
  const cached = withFetchedWorktreeState(NO_WORKTREE_STATES, "/w/app", repo());
  assert.equal(cached["/w/app"].forCwd, "/w/app");
  assert.equal(withFetchedWorktreeState(cached, "/w/x", { error: "boom" }), cached);
  assert.equal(withFetchedWorktreeState(cached, "/w/x", { isGit: false }), cached);
  const second = withFetchedWorktreeState(cached, "/w/lib", repo({ projectRoot: "/w/lib" }));
  assert.deepEqual(Object.keys(second).sort(), ["/w/app", "/w/lib"]);
  assert.equal(second["/w/app"], cached["/w/app"], "the other repository keeps its entry");
});

test("a created worktree is registered against its own repository only", () => {
  const states = withFetchedWorktreeState(withFetchedWorktreeState(NO_WORKTREE_STATES, "/w/app", repo()), "/w/lib", repo({ projectRoot: "/w/lib", worktrees: [] }));
  const next = withCreatedWorktree(states, "/w/app", "/w/app-x", "x");
  assert.deepEqual(next["/w/app"].worktrees.map((entry) => entry.path), ["/w/app", "/w/app-x"]);
  assert.equal(next["/w/app"].forCwd, "/w/app-x");
  assert.equal(next["/w/lib"], states["/w/lib"]);
  assert.equal(withCreatedWorktree(states, "/w/unknown", "/p", "b"), states);
});

test("a removed worktree leaves the list and the cwd falls back to the root when it pointed there", () => {
  const withTwo = withCreatedWorktree(withFetchedWorktreeState(NO_WORKTREE_STATES, "/w/app", repo()), "/w/app", "/w/app-x", "x");
  const removedSelected = withoutWorktree(withTwo, "/w/app", "/w/app-x", "/w/app-x");
  assert.deepEqual(removedSelected["/w/app"].worktrees.map((entry) => entry.path), ["/w/app"]);
  assert.equal(removedSelected["/w/app"].forCwd, "/w/app");
  assert.equal(withoutWorktree(withTwo, "/w/app", "/w/app-x", "/w/app")["/w/app"].forCwd, "/w/app-x");
});

test("the file panel gets a context only for a Git top-level repo that is the selected workspace", () => {
  const actions = { select() {}, async create() {}, async remove() { return "removed"; } };
  const states = withCreatedWorktree(withFetchedWorktreeState(NO_WORKTREE_STATES, "/w/app", repo()), "/w/app", "/w/app-x", "x");
  const context = buildWorktreeContext(states, "/w/app-x", "/w/app", actions);
  assert.equal(context.projectRoot, "/w/app");
  assert.equal(context.currentPath, "/w/app-x");
  assert.equal(buildWorktreeContext(states, "/w/app", "/w/app", actions).currentPath, "/w/app");
  assert.equal(buildWorktreeContext(states, "/w/elsewhere", "/w/app", actions).currentPath, "/w/app", "falls back to the main worktree");

  const subdir = withFetchedWorktreeState(NO_WORKTREE_STATES, "/w/app/sub", repo({ isTopLevel: false }));
  assert.equal(buildWorktreeContext(subdir, "/w/app/sub", "/w/app", actions), null);
  const notGit = withFetchedWorktreeState(NO_WORKTREE_STATES, "/w/app", repo({ isGit: false }));
  assert.equal(buildWorktreeContext(notGit, "/w/app", "/w/app", actions), null);
  assert.equal(buildWorktreeContext(states, null, "/w/app", actions), null);
  assert.equal(buildWorktreeContext(states, "/w/app", null, actions), null);
  assert.equal(buildWorktreeContext(NO_WORKTREE_STATES, "/w/app", "/w/app", actions), null);
  assert.equal(hasWorktreeSwitcher(states["/w/app"], "/w/app", "/w/other"), false, "the selected workspace is a different project");
  assert.equal(hasWorktreeSwitcher(withFetchedWorktreeState(NO_WORKTREE_STATES, "C:\\App", repo({ projectRoot: "C:\\App" }))["c:/app"], "C:\\App\\", "c:/app"), true, "case-folded");
});

test("worktree requests use the documented bodies, surface errors and report a dirty tree", async () => {
  const get = fakeFetch(json(repo()));
  assert.equal((await fetchWorktrees(get.fetchFn, "/w/a b")).projectRoot, "/w/app");
  assert.equal(get.calls[0].url, "/api/worktrees?cwd=%2Fw%2Fa%20b");
  assert.equal(await fetchWorktrees(fakeFetch(new Error("offline")).fetchFn, "/w/a"), null);

  const created = fakeFetch(json({ path: "/w/app-x" }));
  assert.equal(await createWorktree(created.fetchFn, "/w/app", "x"), "/w/app-x");
  assert.deepEqual(created.calls[0], { url: "/api/worktrees", method: "POST", body: { cwd: "/w/app", branch: "x" } });
  await assert.rejects(createWorktree(fakeFetch(json({ error: "Branch exists" }, 409)).fetchFn, "/w/app", "x"), /Branch exists/);

  const removed = fakeFetch(json({}));
  assert.equal(await removeWorktree(removed.fetchFn, "/w/app", "/w/app-x", true), "removed");
  assert.deepEqual(removed.calls[0], { url: "/api/worktrees", method: "DELETE", body: { cwd: "/w/app", path: "/w/app-x", force: true } });
  assert.equal(await removeWorktree(fakeFetch(json({ dirty: true }, 409)).fetchFn, "/w/app", "/p", false), "dirty");
  await assert.rejects(removeWorktree(fakeFetch(json({ dirty: true, error: "dirty" }, 409)).fetchFn, "/w/app", "/p", true), /dirty/, "a forced removal never reports dirty");
});

// ---- Order freeze ------------------------------------------------------------------

test("a new session is pending while it is in memory or live without a listed file", () => {
  const listed = new Set(["a"]);
  const isListed = (id) => listed.has(id);
  assert.equal(hasPendingNewSession({ optimistic: false, liveIds: ["a"], isListed }), false);
  assert.equal(hasPendingNewSession({ optimistic: true, liveIds: [], isListed }), true);
  assert.equal(hasPendingNewSession({ optimistic: false, liveIds: ["a", "b"], isListed }), true);
  assert.equal(hasPendingNewSession({ optimistic: false, liveIds: [], isListed }), false);
});

test("the frozen order applies only while pending and only for the ordering it was taken under", () => {
  const projects = [{ path: "/a", sortOrder: 0 }, { path: "/b", pinOrder: 1 }];
  const key = orderingKey("none", projects);
  const snapshot = { key, order: ["/a", "/b"] };
  assert.deepEqual(frozenOrderFor(snapshot, true, key), ["/a", "/b"]);
  assert.equal(frozenOrderFor(snapshot, false, key), undefined);
  assert.equal(frozenOrderFor(null, true, key), undefined);
  assert.notEqual(orderingKey("alphabetical", projects), key, "a sort change ends the freeze");
  assert.notEqual(orderingKey("none", [{ path: "/a", sortOrder: 1 }, projects[1]]), key, "a manual reorder ends the freeze");
  assert.notEqual(orderingKey("none", [projects[0], { path: "/b" }]), key, "a pin change ends the freeze");
  assert.equal(frozenOrderFor(snapshot, true, orderingKey("none", [projects[0]])), undefined);
});

// ---- Keyboard ----------------------------------------------------------------------

test("`/` focuses the search unless the user is typing or the key belongs to a shortcut", () => {
  const key = (overrides = {}) => ({ key: "/", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: { tagName: "BODY" }, ...overrides });
  assert.equal(shouldFocusSearch(key()), true);
  assert.equal(shouldFocusSearch(key({ key: "a" })), false);
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) assert.equal(shouldFocusSearch(key({ [modifier]: true })), false);
  assert.equal(shouldFocusSearch(key({ defaultPrevented: true })), false);
  assert.equal(shouldFocusSearch(key({ isComposing: true })), false);
  for (const tagName of ["INPUT", "textarea", "SELECT"]) assert.equal(shouldFocusSearch(key({ target: { tagName } })), false);
  assert.equal(shouldFocusSearch(key({ target: { tagName: "DIV", isContentEditable: true } })), false);
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget({}), false);
});

// ---- Small decisions ---------------------------------------------------------------

test("one load state is shown: the session list's failure wins over the project list's", () => {
  const message = (key, detail) => `${key}:${detail}`;
  const ok = { sessionsStatus: "ready", sessionsError: null, projectsStatus: "ready", projectsError: null };
  assert.deepEqual(combineLoadState(ok, message), { status: "ready", error: undefined });
  assert.deepEqual(combineLoadState({ ...ok, sessionsStatus: "loading", projectsStatus: "loading" }, message), { status: "loading", error: undefined });
  assert.deepEqual(combineLoadState({ ...ok, projectsStatus: "error", projectsError: "HTTP 500" }, message), { status: "error", error: "projects.loadFailed:HTTP 500" });
  assert.deepEqual(
    combineLoadState({ sessionsStatus: "error", sessionsError: "HTTP 502", projectsStatus: "error", projectsError: "HTTP 500" }, message),
    { status: "error", error: "sessionSidebar.loadFailed:HTTP 502" },
  );
});

test("a chosen recent-runs limit is stored as a preset when it equals one, else as the custom value", () => {
  assert.deepEqual(recentRunsChoice(10), { preset: "10", custom: undefined });
  assert.deepEqual(recentRunsChoice(20), { preset: "20", custom: undefined });
  assert.deepEqual(recentRunsChoice(12), { preset: "custom", custom: 12 });
  assert.deepEqual(recentRunsChoice(5000), { preset: "custom", custom: 100 });
});

// ---- Session requests --------------------------------------------------------------

test("only sessions without forks can be archived", () => {
  const sessions = [{ id: "a" }, { id: "b", parentSessionId: "a" }];
  assert.equal(hasForkChildren(sessions, "a"), true);
  assert.equal(hasForkChildren(sessions, "b"), false);
});

test("a live session without a file opens from a placeholder in its cwd", () => {
  const session = placeholderSession("id-1", "/w/app-x", "/w/app", new Date("2026-01-01T00:00:00Z"));
  assert.equal(session.path, "", "the empty path marks a session that exists in memory only");
  assert.equal(session.cwd, "/w/app-x");
  assert.equal(session.projectRoot, "/w/app");
  assert.equal(placeholderSession("id-1", "/w/app", null).projectRoot, "/w/app");
});

test("session requests address the session by an encoded id", async () => {
  const id = "a/b c";
  const rename = fakeFetch(json({}));
  assert.equal(await renameSessionRequest(rename.fetchFn, id, "New"), true);
  assert.deepEqual(rename.calls[0], { url: "/api/sessions/a%2Fb%20c", method: "PATCH", body: { name: "New" } });
  const archive = fakeFetch(json({}));
  assert.equal(await archiveSessionRequest(archive.fetchFn, id), true);
  assert.deepEqual(archive.calls[0], { url: "/api/sessions/a%2Fb%20c/archive", method: "POST", body: undefined });
  const del = fakeFetch(json({}, 500));
  assert.equal(await deleteSessionRequest(del.fetchFn, id), false);
  assert.deepEqual(del.calls[0], { url: "/api/sessions/a%2Fb%20c", method: "DELETE", body: undefined });
});

test("a transcript is read from the session endpoint and a refusal rejects", async () => {
  const ok = fakeFetch(json({ context: { messages: [{ role: "user" }] }, info: { cwd: "/w/app" } }));
  assert.deepEqual(await fetchTranscript(ok.fetchFn, "s1"), { messages: [{ role: "user" }], cwd: "/w/app" });
  assert.deepEqual(await fetchTranscript(fakeFetch(json({})).fetchFn, "s1"), { messages: [], cwd: undefined });
  await assert.rejects(fetchTranscript(fakeFetch(json({}, 404)).fetchFn, "s1"));
});

test("importing posts the file and reports the server's reason", async () => {
  const ok = fakeFetch(json({ success: true }));
  assert.deepEqual(await importSessionRequest(ok.fetchFn, "s.jsonl", "{}\n"), { ok: true });
  assert.deepEqual(ok.calls[0], { url: "/api/sessions/import", method: "POST", body: { fileName: "s.jsonl", content: "{}\n" } });
  assert.deepEqual(await importSessionRequest(fakeFetch(json({ error: "Empty session file" }, 400)).fetchFn, "s.jsonl", ""), { ok: false, error: "Empty session file" });
  assert.deepEqual(await importSessionRequest(fakeFetch(json({}, 500)).fetchFn, "s.jsonl", "x"), { ok: false, error: "HTTP 500" });
});
