import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, render as renderView, waitFor } from "@testing-library/react/pure.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { FileExplorer } = await jiti.import("./FileExplorer.tsx");

afterEach(() => cleanup());

function renderStatic(props = {}) {
  return renderToStaticMarkup(
    React.createElement(FileExplorer, {
      cwd: "/tmp/project",
      onOpenFile() {},
      ...props,
    }),
  );
}

function pointer(target, type, x, y) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    detail: type === "click" ? 1 : 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "touch" },
  });
  act(() => target.dispatchEvent(event));
}

async function mountLoadedExplorer(onOpenFile) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/files/")) {
      return { ok: true, json: async () => ({ entries: [
        { name: "README.md", isDir: false, size: 1, modified: "" },
        { name: "CHANGELOG.md", isDir: false, size: 1, modified: "" },
      ] }) };
    }
    return { ok: true, json: async () => ({ isGitRepository: false, files: [] }) };
  };
  try {
    const view = renderView(React.createElement(FileExplorer, {
      cwd: "/tmp/project",
      onOpenFile,
    }));
    await waitFor(() => assert.ok(view.container.querySelector('[role="treeitem"]')));
    return view;
  } finally {
    globalThis.fetch = previousFetch;
  }
}
test("renders the search input only while the search panel is open", () => {
  const closed = renderStatic();
  assert.doesNotMatch(closed, /aria-label="(Search files|fileExplorer\.searchFiles)"/);

  const open = renderStatic({ fileSearchOpen: true });
  assert.match(open, /aria-label="(Search files|fileExplorer\.searchFiles)"/);
  assert.match(open, /placeholder="(Search files\.\.\.|fileExplorer\.searchPlaceholder)"/);
});

test("keeps the regular file tree visible while the search query is empty", () => {
  // An open panel with no query must not hide the tree behind an empty
  // search-results state.
  const open = renderStatic({ fileSearchOpen: true });
  assert.match(open, /role="tree"/);
  assert.match(open, /(Loading files\.\.\.|fileExplorer\.loadingFiles)/);
  assert.doesNotMatch(open, /(No matching files|fileExplorer\.noMatchingFiles)/);
});

test("does not open a file when a touch drag crosses rows", async () => {
  const opened = [];
  const view = await mountLoadedExplorer((path) => opened.push(path));
  const rows = view.container.querySelectorAll('[role="treeitem"]');
  const first = rows[0];
  const second = rows[1];
  pointer(first, "pointerdown", 10, 10);
  pointer(second, "pointermove", 10, 30);
  pointer(second, "click", 10, 30);
  assert.deepEqual(opened, []);

  pointer(first, "pointerdown", 10, 10);
  pointer(first, "click", 10, 10);
  await waitFor(() => assert.deepEqual(opened, ["/tmp/project/README.md"]));

  act(() => first.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(opened, ["/tmp/project/README.md", "/tmp/project/README.md"]);
});
