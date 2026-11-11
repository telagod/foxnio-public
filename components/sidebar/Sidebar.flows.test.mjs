import "../../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { createSessionStore } = await jiti.import("@/lib/session-store.ts");
const { createDataStore } = await jiti.import("@/lib/data-store.ts");
const { Sidebar } = await jiti.import("./Sidebar.tsx");

// ---------------------------------------------------------------------------
// Harness: a tiny server behind fetch, a real session store, the real Sidebar.
// ---------------------------------------------------------------------------

const APP = "/w/app";
const LIB = "/w/lib";

const info = (id, overrides = {}) => ({
  id,
  path: `/sessions/${id}.jsonl`,
  cwd: APP,
  projectRoot: APP,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-02T00:00:00.000Z",
  messageCount: 2,
  firstMessage: `First ${id}`,
  name: `Session ${id}`,
  ...overrides,
});

function createServer({ sessions, projects = [{ path: APP }], worktrees = { error: "Not a git repository" } }) {
  const state = {
    sessions: [...sessions],
    projects: projects.map((project) => ({ addedAt: "2026-01-01T00:00:00.000Z", hidden: false, ...project })),
    pinned: [], calls: [], worktrees, revision: 1, changes: [],
  };
  const cursor = () => ({ generation: "sidebar-fixture", revision: state.revision });
  const changed = (topic, keys) => state.changes.push({ revision: ++state.revision, topic, keys });
  const find = (method, path) => state.calls.filter((call) => call.method === method && call.path === path);
  const json = (body, status = 200) => Response.json(body, { status });

  async function fetchFn(url, init = {}) {
    const [path, queryString = ""] = String(url).split("?");
    const query = Object.fromEntries(new URLSearchParams(queryString));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, path, query, body });
    await Promise.resolve();

    const sessionRoute = /^\/api\/sessions\/([^/]+)(\/archive)?$/.exec(path);
    if (path === "/api/data/snapshot") {
      if (method === "DELETE") return json({ ok: true });
      if (method === "GET") return json({
        token: `reader-${state.revision}`, next: false, cursor: cursor(), complete: true, staleSources: [], warnings: [],
        data: {
          sessions: state.sessions, projects: state.projects, pins: state.pinned.map((id) => ({ id, at: 1 })),
          notifications: [], foxWorkspace: "/w/fox", foxPointer: { sessionId: null, resetAt: null },
          foxObservation: { version: 1, seeded: false, seen: {}, daily: {} },
        },
      });
    }
    if (method === "GET" && path === "/api/data/changes") {
      const before = JSON.parse(query.cursor);
      const through = query.through ? JSON.parse(query.through) : cursor();
      if (before.generation !== through.generation || before.revision > through.revision) return json({ code: "reset_required" }, 409);
      return json({ cursor: through, through, changes: state.changes.filter((change) => change.revision > before.revision && change.revision <= through.revision), hasMore: false });
    }
    if (method === "GET" && path === "/api/sessions/search") return new Response('{"scores":{}}\n', { headers: { "Content-Type": "application/x-ndjson" } });
    if (method === "PATCH" && path === "/api/session-ui") {
      state.pinned = state.pinned.filter((id) => !(body.unpin ?? []).includes(id));
      for (const id of body.pin ?? []) state.pinned.unshift(id);
      changed("pins", [...(body.pin ?? []), ...(body.unpin ?? [])]);
      return json({ pinned: state.pinned.map((id) => ({ id, at: 1 })) });
    }
    if (method === "GET" && path === "/api/worktrees") return json(state.worktrees);
    if (method === "POST" && path === "/api/worktrees") {
      const created = `${body.cwd}-${body.branch}`;
      state.worktrees.worktrees.push({ path: created, branch: body.branch, isMain: false });
      return json({ path: created });
    }
    if (method === "DELETE" && path === "/api/worktrees") {
      if (!body.force) return json({ dirty: true, error: "dirty" }, 409);
      state.worktrees.worktrees = state.worktrees.worktrees.filter((entry) => entry.path !== body.path);
      return json({});
    }
    if (method === "POST" && path === "/api/projects") {
      const project = { path: body.cwd, addedAt: "2026-01-02T00:00:00.000Z", hidden: false };
      state.projects = [project, ...state.projects.filter((entry) => entry.path !== body.cwd)];
      changed("projects", [body.cwd]);
      return json({ project });
    }
    if (method === "DELETE" && path === "/api/projects") {
      state.projects = state.projects.map((project) => project.path === body.cwd ? { ...project, hidden: true } : project);
      changed("projects", [body.cwd]);
      return json({ success: true });
    }
    if (sessionRoute && method === "PATCH") {
      const target = state.sessions.find((entry) => entry.id === decodeURIComponent(sessionRoute[1]));
      if (target) target.name = body.name;
      changed("sessions", [decodeURIComponent(sessionRoute[1])]);
      return json({ success: true });
    }
    if (sessionRoute && (method === "DELETE" || method === "POST")) {
      state.sessions = state.sessions.filter((entry) => entry.id !== decodeURIComponent(sessionRoute[1]));
      changed("sessions", [decodeURIComponent(sessionRoute[1])]);
      return json({ success: true });
    }
    return json({ error: "not found" }, 404);
  }
  return { state, fetchFn, find, changed };
}

const noEnvironment = {
  onVisibilityChange: () => () => {},
  onOnline: () => () => {},
  onPageHide: () => () => {},
};

const fakeStream = (channel) => {
  const stream = { channel, readyState: 1, onopen: null, onmessage: null, onerror: null, close() { this.readyState = 2; } };
  queueMicrotask(() => { if (stream.readyState === 1) stream.onopen?.(); });
  return stream;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Let effects, promises and the store's microtasks settle. */
async function settle() {
  await act(async () => {
    await sleep(15);
  });
}

async function until(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message ?? "condition not reached");
    await settle();
  }
}

let cleanups = [];
afterEach(() => {
  cleanup();
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

function mount({ sessions = [info("A"), info("B", { name: "Session B" })], server: serverInit, props = {} } = {}) {
  window.localStorage.clear();
  const server = createServer({ sessions, ...serverInit });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = server.fetchFn;
  const dataStore = createDataStore({ fetch: server.fetchFn, openStream: fakeStream });
  const store = createSessionStore({ dataStore, fetch: server.fetchFn, openStream: fakeStream, storage: null, env: noEnvironment });
  globalThis.__ompSessionStore = store;
  store.retain();
  cleanups.push(() => {
    store.release();
    delete globalThis.__ompSessionStore;
    globalThis.fetch = previousFetch;
  });

  const events = { selected: [], created: [], deleted: [], cwd: [], workspaces: [], worktrees: [], restoreDone: 0 };
  const callbacks = {
    onSelectSession: (session, isRestore) => events.selected.push([session.id, isRestore]),
    onNewSession: (id, cwd) => events.created.push([id, cwd]),
    onSessionDeleted: (id) => events.deleted.push(id),
    onCwdChange: (cwd, root) => events.cwd.push([cwd, root]),
    onWorkspaceOptionsChange: (projects, selected, cwd) => events.workspaces.push([projects.map((project) => project.path), selected, cwd]),
    onWorktreeContextChange: (context) => events.worktrees.push(context),
    onInitialRestoreDone: () => events.restoreDone++,
  };
  function Host() {
    const [addProjectOpen, setAddProjectOpen] = useState(false);
    return React.createElement(Sidebar, { selectedSessionId: null, usageVisible: false, ...callbacks, ...props, addProjectOpen, setAddProjectOpen });
  }
  render(React.createElement(Host));
  return { server, store, events };
}

const treeitems = () => screen.queryAllByRole("treeitem");
const rowOf = (text) => treeitems().find((item) => item.textContent.includes(text));
const link = (name) => screen.queryByRole("link", { name });

// ---------------------------------------------------------------------------

test("the top workspace is selected and clicking a session opens it", async () => {
  const { events } = mount();
  const alpha = await until(() => link(/Session A/), "the session list renders under the selected workspace");
  assert.deepEqual(events.cwd.at(-1), [APP, APP], "the shell learns the effective cwd and its workspace root");
  assert.deepEqual(events.workspaces.at(-1), [[APP], APP, APP]);

  fireEvent.click(alpha);
  assert.deepEqual(events.selected, [["A", undefined]]);
});

test("a workspace folds and unfolds from its row", async () => {
  mount();
  await until(() => link(/Session A/));
  fireEvent.click(screen.getByRole("button", { name: "Collapse app" }));
  await until(() => screen.queryByRole("button", { name: "Expand app" }));
  assert.equal(link(/Session A/), null);
  fireEvent.click(screen.getByRole("button", { name: "Expand app" }));
  await until(() => link(/Session A/));
});

test("opening FOX does not collapse the selected project or write collapsed state", async () => {
  mount({ props: { foxOpen: true } });
  await until(() => link(/Session A/), "the selected project's sessions stay reachable in FOX");
  assert.ok(screen.getByRole("button", { name: "Collapse app" }));
});

test("renaming sends the trimmed title and the list shows the server's answer", async () => {
  const { server } = mount();
  await until(() => link(/Session A/));
  const row = rowOf("Session A");
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "F2" });
  const input = screen.getByRole("textbox", { name: "Rename" });
  fireEvent.change(input, { target: { value: "  Renamed  " } });
  fireEvent.keyDown(input, { key: "Enter" });

  await until(() => link(/Renamed/), "the refreshed list carries the new name");
  assert.deepEqual(server.find("PATCH", "/api/sessions/A").map((call) => call.body), [{ name: "Renamed" }]);
});

test("deleting asks inline, deletes on the server, removes the row and tells the shell", async () => {
  const { server, events } = mount();
  await until(() => link(/Session A/));
  const row = rowOf("Session A");
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "Delete" });
  assert.equal(server.find("DELETE", "/api/sessions/A").length, 0, "nothing is sent before the confirmation");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  await until(() => link(/Session A/) === null, "the row is gone");
  assert.equal(server.find("DELETE", "/api/sessions/A").length, 1);
  assert.deepEqual(events.deleted, ["A"]);
  assert.ok(link(/Session B/));
});

test("a failed delete keeps the row and does not tell the shell", async () => {
  const { server, events } = mount();
  await until(() => link(/Session A/));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (init?.method === "DELETE" ? Response.json({}, { status: 500 }) : originalFetch(url, init));
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
  });
  const row = rowOf("Session A");
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "Delete" });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await settle();
  await settle();
  assert.deepEqual(events.deleted, []);
  assert.ok(link(/Session A/));
  assert.equal(server.state.sessions.length, 2);
});

test("pinning a session shows it in the Pinned section and stores the pin on the server", async () => {
  const { server } = mount();
  await until(() => link(/Session A/));
  assert.equal(screen.queryAllByRole("link", { name: /Session A/ }).length, 1);
  fireEvent.click(within(rowOf("Session A")).getByRole("button", { name: "Pin" }));

  await until(() => screen.queryAllByRole("link", { name: /Session A/ }).length === 2, "listed under Pinned and under its workspace");
  await until(() => server.find("PATCH", "/api/session-ui").length === 1);
  assert.deepEqual(server.find("PATCH", "/api/session-ui")[0].body, { pin: ["A"] });
});

test("typing in the search box narrows the list and starts the transcript search", async () => {
  const { server } = mount({ sessions: [info("A", { name: "Alpha release" }), info("B", { name: "Beta fix" })] });
  await until(() => link(/Alpha release/));
  const box = screen.getByRole("textbox", { name: "Search sessions" });
  fireEvent.change(box, { target: { value: "alpha" } });

  await until(() => link(/Beta fix/) === null, "only matching sessions stay");
  assert.ok(link(/Alpha release/));
  await until(() => server.find("GET", "/api/sessions/search").length === 1, "the debounced server search runs");
  assert.equal(server.find("GET", "/api/sessions/search")[0].query.q, "alpha");

  fireEvent.keyDown(box, { key: "Escape" });
  await until(() => link(/Beta fix/), "clearing the query restores the tree");
});

test("`/` focuses the search box unless the user is typing", async () => {
  mount();
  await until(() => link(/Session A/));
  const box = screen.getByRole("textbox", { name: "Search sessions" });
  fireEvent.keyDown(document.body, { key: "/" });
  assert.ok(document.activeElement === box);

  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  fireEvent.keyDown(other, { key: "/" });
  assert.ok(document.activeElement === other, "typing elsewhere keeps its slash");
  other.remove();
});

test("Add workspace opens the directory picker through the shell's open state", async () => {
  mount();
  await until(() => link(/Session A/));
  assert.equal(screen.queryByRole("dialog"), null);
  fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));
  await until(() => screen.queryByRole("dialog", { name: "Select directory" }));
});

test("New session from a workspace row starts a session in that workspace", async () => {
  const { events } = mount({ server: { projects: [{ path: APP }, { path: LIB }] }, sessions: [info("A"), info("L", { cwd: LIB, projectRoot: LIB, name: "Lib one" })] });
  await until(() => link(/Session A/));

  const libGroup = treeitems().find((item) => item.textContent.includes("lib") && item.querySelector('button[aria-label="New session here"]'));
  fireEvent.click(within(libGroup).getByRole("button", { name: "New session here" }));
  assert.equal(events.created.length, 1);
  assert.equal(events.created[0][1], LIB);
  assert.match(events.created[0][0], /^[0-9a-f-]{20,}$/i);
  await until(() => events.cwd.at(-1)?.[0] === LIB, "the new session's workspace becomes the selection");
});

test("clicking another workspace selects it without folding the open one", async () => {
  const { events } = mount({ server: { projects: [{ path: APP }, { path: LIB }] }, sessions: [info("A"), info("L", { cwd: LIB, projectRoot: LIB, name: "Lib one" })] });
  await until(() => link(/Session A/));
  fireEvent.click(screen.getByRole("button", { name: /Expand lib|Collapse lib/ }));
  await until(() => link(/Lib one/), "the clicked workspace opens");
  assert.equal(events.cwd.at(-1)[0], LIB);
  assert.ok(link(/Session A/), "the workspace that was left stays open so rows do not jump");
});

test("the session named in the URL is restored once the list has it", async () => {
  const { events } = mount({ props: { initialSessionId: "B" } });
  await until(() => events.selected.length === 1, "restore runs after the first load");
  assert.deepEqual(events.selected[0], ["B", true]);
  assert.equal(events.cwd.at(-1)[0], APP);
  assert.equal(events.restoreDone, 0);
});

test("a session whose file appears a moment later is restored by the retry", async () => {
  const { server, events } = mount({ props: { initialSessionId: "NEW" } });
  await settle();
  assert.deepEqual(events.selected, []);
  server.state.sessions.push(info("NEW", { name: "Fresh" }));
  server.changed("sessions", ["NEW"]);
  await until(() => events.selected.length === 1, "found on the 1 s retry", 4000);
  assert.deepEqual(events.selected[0], ["NEW", true]);
});

test("a shell that asked for a specific cwd gets no restore and no automatic pick", async () => {
  const { events } = mount({ props: { initialSessionId: "B", skipInitialProjectSelection: true } });
  await until(() => treeitems().length > 0);
  await settle();
  assert.deepEqual(events.selected, []);
  assert.deepEqual(events.cwd, []);
});

test("the shell's cwd moves the selection and opens that workspace", async () => {
  const { events } = mount({
    server: { projects: [{ path: APP }, { path: LIB }] },
    sessions: [info("A"), info("L", { cwd: LIB, projectRoot: LIB, name: "Lib one" })],
    props: { selectedCwd: LIB },
  });
  await until(() => link(/Lib one/));
  assert.equal(events.cwd.at(-1)[0], LIB);
  assert.equal(link(/Session A/), null, "nothing but the selected workspace opened itself");
});

test("an in-memory session is shown and handed to the store", async () => {
  const optimistic = { id: "N", path: "", cwd: APP, created: "2026-02-01T00:00:00.000Z", modified: "2026-02-01T00:00:00.000Z", messageCount: 1, firstMessage: "Brand new", projectRoot: APP };
  const { store } = mount({ props: { optimisticSession: optimistic, selectedSessionId: "N" } });
  await until(() => rowOf("Brand new"));
  assert.equal(store.getSnapshot().optimisticSession?.id, "N");
});

test("removing a workspace asks inline, deletes it and moves the selection to another one", async () => {
  const { server, events } = mount({ server: { projects: [{ path: APP }, { path: LIB }] }, sessions: [info("A"), info("L", { cwd: LIB, projectRoot: LIB, name: "Lib one" })] });
  await until(() => link(/Session A/));
  fireEvent.contextMenu(treeitems().find((item) => item.textContent.includes("app") && !item.textContent.includes("Session")), { clientX: 5, clientY: 5 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove workspace" }));
  assert.equal(server.find("DELETE", "/api/projects").length, 0);
  fireEvent.click(within(screen.getByRole("group", { name: "Remove project app" })).getByRole("button", { name: "Remove" }));

  await until(() => server.find("DELETE", "/api/projects").length === 1);
  assert.deepEqual(server.find("DELETE", "/api/projects")[0].body, { cwd: APP });
  await until(() => events.cwd.at(-1)?.[0] === LIB, "the next workspace is selected");
});

test("the file panel gets the worktree context and creating one selects it inside the same project", async () => {
  const repo = { projectRoot: APP, isGit: true, isTopLevel: true, worktrees: [{ path: APP, branch: "main", isMain: true }] };
  const { server, events } = mount({ server: { worktrees: repo } });
  const context = await until(() => events.worktrees.find(Boolean), "the Git state of the selected workspace is fetched");
  assert.equal(context.projectRoot, APP);
  assert.equal(context.currentPath, APP);

  await act(async () => {
    await context.create("feat");
  });
  assert.deepEqual(server.find("POST", "/api/worktrees")[0].body, { cwd: APP, branch: "feat" });
  await until(() => events.cwd.at(-1)?.[0] === `${APP}-feat`);
  assert.equal(events.cwd.at(-1)[1], APP, "the new worktree resolves to the main repository");

  const latest = await until(() => events.worktrees.at(-1)?.currentPath === `${APP}-feat` && events.worktrees.at(-1));
  assert.equal(await act(() => latest.remove(`${APP}-feat`, false)), "dirty");
  assert.equal(await act(() => latest.remove(`${APP}-feat`, true)), "removed");
  assert.deepEqual(server.find("DELETE", "/api/worktrees").map((call) => call.body.force), [false, true]);
  await until(() => events.cwd.at(-1)?.[0] === APP, "removing the selected worktree falls back to the root");
});
