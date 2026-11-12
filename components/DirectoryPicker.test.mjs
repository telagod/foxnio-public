import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { DirectoryPicker } = await jiti.import("./DirectoryPicker.tsx");
const listing = (path, names = []) => ({ path, parentPath: path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/", directories: names.map((name) => ({ name, path: `${path === "/" ? "" : path}/${name}` })) });
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

async function mount(overrides = {}, start = "/projects") {
  const selected = [];
  const calls = [];
  const directories = new Map([
    ["/", listing("/", ["projects"])],
    ["/projects", listing("/projects", ["alpha", "beta"])],
    ["/projects/alpha", listing("/projects/alpha", ["inside-alpha"])],
    ["/projects/beta", listing("/projects/beta", ["inside-beta"])],
  ]);
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url), "https://omp.test").searchParams.get("path") || start;
    calls.push({ path, init });
    if (overrides.respond) return overrides.respond(url, init);
    if (overrides[path]) return overrides[path](init);
    return Response.json(directories.get(path) ?? { error: "Missing directory", code: "directory_not_found" });
  };
  function Host() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(React.Fragment, null,
      React.createElement("button", { onClick: () => setOpen(true) }, "Add workspace"),
      open && React.createElement(DirectoryPicker, { onCancel: () => setOpen(false), onSelect: (...args) => selected.push(args) }),
    );
  }
  await act(async () => { render(React.createElement(Host)); });
  const opener = screen.getByRole("button", { name: "Add workspace" });
  opener.focus();
  fireEvent.click(opener);
  await waitFor(() => assert.equal(document.querySelector("#directory-path")?.value, start));
  return { selected, calls, opener, path: () => document.querySelector("#directory-path"), confirm: () => screen.getByRole("button", { name: "Select this folder" }) };
}

// Removing the request identity check would let alpha replace the later beta
// selection and open the wrong project when the first request settles last.
test("a late directory listing cannot replace a newer selection", async () => {
  let resolveAlpha;
  const alpha = new Promise((resolve) => { resolveAlpha = resolve; });
  const ui = await mount({ "/projects/alpha": () => alpha });
  fireEvent.click(screen.getByTitle("/projects/alpha"));
  fireEvent.click(screen.getByTitle("/projects/beta"));
  await waitFor(() => assert.equal(ui.path().value, "/projects/beta"));
  await act(async () => { resolveAlpha(Response.json(listing("/projects/alpha", ["inside-alpha"]))); });
  assert.equal(ui.path().value, "/projects/beta");
  assert.ok(screen.getByTitle("/projects/beta/inside-beta"));
  fireEvent.click(ui.confirm());
  assert.equal(ui.selected[0]?.[0], "/projects/beta");
});

test("editing a path supersedes navigation without losing the new draft", async () => {
  let resolveAlpha;
  const alpha = new Promise((resolve) => { resolveAlpha = resolve; });
  const ui = await mount({ "/projects/alpha": () => alpha });
  fireEvent.change(ui.path(), { target: { value: "/projects/alpha" } });
  fireEvent.submit(ui.path().closest("form"));
  fireEvent.change(ui.path(), { target: { value: "/projects/new-draft" } });
  await act(async () => { resolveAlpha(Response.json(listing("/projects/alpha"))); });
  assert.equal(ui.path().value, "/projects/new-draft");
  assert.equal(ui.confirm().disabled, true);
  assert.deepEqual(ui.selected, []);
});

test("final adoption stays disabled while the chosen directory is loading", async () => {
  let resolveAlpha;
  const alpha = new Promise((resolve) => { resolveAlpha = resolve; });
  const ui = await mount({ "/projects/alpha": () => alpha });
  fireEvent.click(screen.getByTitle("/projects/alpha"));
  assert.equal(ui.confirm().disabled, true);
  fireEvent.click(ui.confirm());
  assert.deepEqual(ui.selected, []);
  await act(async () => { resolveAlpha(Response.json(listing("/projects/alpha"))); });
  assert.equal(ui.confirm().disabled, false);
});

test("IME Enter does not navigate a partially composed directory path", async () => {
  const ui = await mount();
  const count = ui.calls.length;
  fireEvent.compositionStart(ui.path());
  fireEvent.change(ui.path(), { target: { value: "/projects/半成品" } });
  fireEvent.keyDown(ui.path(), { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
  fireEvent.submit(ui.path().closest("form"));
  assert.equal(ui.calls.length, count);
  assert.deepEqual(ui.selected, []);
  fireEvent.compositionEnd(ui.path());
});

test("creation uses the chosen parent and a conflict can recover without adopting early", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-picker-create-")));
  try {
    await mkdir(path.join(root, "existing"));
    await writeFile(path.join(root, "existing", "keep.txt"), "untouched");
    const route = await jiti.import("../app/api/cwd/browse/route.ts");
    const ui = await mount({ respond: async (url, init) => {
      const target = new URL(String(url), "http://localhost");
      if (!target.searchParams.has("path")) target.searchParams.set("path", root);
      return init.method === "POST" ? route.POST(new Request(target, init)) : route.GET({ nextUrl: target });
    } }, root);
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const dialog = screen.getByRole("dialog", { name: "New folder" });
    assert.ok(dialog.textContent.includes(root));
    const name = screen.getByRole("textbox", { name: "Folder name" });
    fireEvent.change(name, { target: { value: "draft" } });
    fireEvent.compositionStart(name);
    fireEvent.keyDown(name, { key: "Enter", keyCode: 229, isComposing: true });
    fireEvent.submit(name.closest("form"));
    await act(async () => {});
    assert.deepEqual(await readdir(root), ["existing"], "IME confirmation must not create a folder");
    fireEvent.compositionEnd(name);
    fireEvent.change(name, { target: { value: "existing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await screen.findByRole("alert");
    assert.ok(screen.getByRole("dialog", { name: "New folder" }));
    assert.equal(await readFile(path.join(root, "existing", "keep.txt"), "utf8"), "untouched");
    assert.deepEqual(ui.selected, []);
    fireEvent.change(name, { target: { value: "新项目" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => {
      assert.equal(ui.path().value, path.join(root, "新项目"));
      assert.equal(ui.confirm().disabled, false);
    });
    assert.equal(screen.queryByRole("dialog", { name: "New folder" }), null);
    await waitFor(() => {
      const focused = document.activeElement;
      assert.ok(screen.getByRole("dialog", { name: "Select directory" }).contains(focused), "successful creation keeps keyboard focus inside the parent picker");
      assert.equal(focused.matches(":disabled, [inert]"), false);
    });
    assert.deepEqual(await readdir(path.join(root, "新项目")), []);
    assert.deepEqual(ui.selected, []);
    fireEvent.click(ui.confirm());
    assert.equal(ui.selected[0]?.[0], path.join(root, "新项目"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clearing the selected row falls back to its current level", async () => {
  const ui = await mount();
  fireEvent.click(screen.getByTitle("/projects/alpha"));
  await waitFor(() => assert.equal(ui.path().value, "/projects/alpha"));
  fireEvent.click(document.querySelector('.directory-picker-entry[aria-pressed="true"]'));
  await waitFor(() => assert.equal(ui.path().value, "/projects"));
  assert.equal(document.querySelectorAll(".directory-picker-column").length, 1);
  fireEvent.click(ui.confirm());
  assert.equal(ui.selected[0]?.[0], "/projects");
});

// Losing the nested opener (autoFocus runs before the shared hook's effect)
// strands keyboard and screen-reader users on BODY after dismissing the child.
for (const dismissal of ["Escape", "Cancel", "mask"]) {
  test(`nested ${dismissal} returns focus to its parent trigger and parent close returns to its opener`, async () => {
    const ui = await mount();
    const trigger = screen.getByRole("button", { name: "New folder" });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole("textbox", { name: "Folder name" });
    assert.equal(document.activeElement === input, true);
    fireEvent.change(input, { target: { value: "cancel-this-draft" } });
    if (dismissal === "Escape") fireEvent.keyDown(input, { key: "Escape" });
    else if (dismissal === "Cancel") fireEvent.click(document.querySelector('.directory-picker-create-panel button[type="button"]'));
    else fireEvent.click(document.querySelector(".directory-picker-create-backdrop"));
    assert.equal(screen.queryByRole("dialog", { name: "New folder" }), null);
    assert.ok(screen.getByRole("dialog", { name: "Select directory" }));
    await waitFor(() => assert.equal(document.activeElement === trigger, true));
    assert.equal(trigger.disabled, false);
    assert.equal(ui.path().value, "/projects");
    assert.deepEqual(ui.selected, []);
    assert.equal(ui.calls.some((call) => call.init.method === "POST"), false);
    fireEvent.keyDown(trigger, { key: "Escape" });
    assert.equal(screen.queryByRole("dialog"), null);
    await waitFor(() => assert.equal(document.activeElement === ui.opener, true));
  });
}

test("closing the whole picker restores the original opener after initial path focus", async () => {
  const ui = await mount();
  assert.equal(document.activeElement === ui.path(), true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.equal(screen.queryByRole("dialog"), null);
  await waitFor(() => assert.equal(document.activeElement === ui.opener, true));
});
