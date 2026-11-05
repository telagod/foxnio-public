import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { CommandPalette } = await jiti.import("./CommandPalette.tsx");

const EMPTY = { sessions: [], sessionsStatus: "loading" };

/** A stand-in for the page-wide session store that `getSessionStore()` hands out. */
function installStore(initial) {
  let snapshot = { ...EMPTY, ...initial };
  const listeners = new Set();
  globalThis.__ompSessionStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    publish(next) {
      snapshot = { ...snapshot, ...next };
      for (const listener of [...listeners]) listener();
    },
  };
  return globalThis.__ompSessionStore;
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  delete globalThis.__ompSessionStore;
  delete globalThis.ResizeObserver;
  delete window.matchMedia;
  delete window.HTMLElement.prototype.scrollIntoView;
  globalThis.fetch = originalFetch;
});

const session = (id, name) => ({ id, name, cwd: "/work", modified: new Date().toISOString() });
const mount = () => render(React.createElement(CommandPalette, { onSelectSession() {}, onNewSession() {}, initialOpen: true }));

test("lists the sessions of the shared store without fetching them", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw new Error("the palette must not fetch");
  };
  installStore({ sessions: [session("a", "Fix the build"), session("b", "Write docs")], sessionsStatus: "ready" });
  mount();
  await act(async () => {});
  assert.ok(screen.getByText("Fix the build"));
  assert.ok(screen.getByText("Write docs"));
  assert.deepEqual(requests, []);
});

test("follows later changes of the store while open", async () => {
  const store = installStore({ sessions: [], sessionsStatus: "ready" });
  mount();
  await act(async () => {});
  assert.equal(screen.queryByText("Late arrival"), null);
  await act(async () => store.publish({ sessions: [session("c", "Late arrival")] }));
  assert.ok(screen.getByText("Late arrival"));
});
