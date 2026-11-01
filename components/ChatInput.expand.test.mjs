import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft } = await jiti.import("@/lib/draft-store");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // jsdom has no layout; the slash menu scrolls its active row into view.
  window.HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  delete window.HTMLElement.prototype.scrollIntoView;
  clearDraft("new:unassigned");
  localStorage.clear();
  delete window.matchMedia;
});

function mount({ onAbort = () => {} } = {}) {
  const sent = [];
  render(React.createElement(ChatInput, {
    onSend: async (text) => { sent.push(text); return { status: "accepted" }; },
    onAbort,
    isStreaming: false,
  }));
  return sent;
}

const expandButton = () => screen.getByRole("button", { name: "Expand editor" });

test("expanding turns the composer into a modal dialog around the same draft", async () => {
  const user = userEvent.setup();
  mount();
  await user.type(screen.getByRole("textbox"), "long draft");
  assert.equal(screen.queryByRole("dialog"), null);

  await user.click(expandButton());
  const dialog = screen.getByRole("dialog", { name: "Compose message" });
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.getAttribute("data-composer-expanded"), "true");
  const textarea = screen.getByRole("textbox");
  assert.equal(textarea.value, "long draft");
  assert.ok(dialog.contains(textarea));
  assert.equal(document.activeElement, textarea);
  assert.ok(screen.getByRole("button", { name: "Collapse editor" }));
});

test("Escape collapses the editor, keeps the draft and does not stop the agent", async () => {
  const user = userEvent.setup();
  let aborted = 0;
  mount({ onAbort: () => { aborted += 1; } });
  await user.type(screen.getByRole("textbox"), "keep me");
  await user.click(expandButton());

  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(screen.getByRole("textbox").value, "keep me");
  assert.equal(document.activeElement, screen.getByRole("textbox"));
  assert.equal(aborted, 0);
});

test("the collapse button returns to the compact composer", async () => {
  const user = userEvent.setup();
  mount();
  await user.click(expandButton());
  await user.click(screen.getByRole("button", { name: "Collapse editor" }));
  assert.equal(screen.queryByRole("dialog"), null);
  assert.ok(screen.getByRole("group", { name: "Message composer" }));
});

test("in the expanded editor Enter inserts a newline and Ctrl+Enter sends and collapses", async () => {
  const user = userEvent.setup();
  const sent = mount();
  await user.type(screen.getByRole("textbox"), "first");
  await user.click(expandButton());

  await user.keyboard("{Enter}second");
  assert.deepEqual(sent, []);
  assert.equal(screen.getByRole("textbox").value, "first\nsecond");

  await user.keyboard("{Control>}{Enter}{/Control}");
  assert.deepEqual(sent, ["first\nsecond"]);
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(screen.getByRole("textbox").value, "");
});

test("the compact composer still sends on a bare Enter", async () => {
  const user = userEvent.setup();
  const sent = mount();
  await user.type(screen.getByRole("textbox"), "quick");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await screen.findByRole("textbox");
  assert.deepEqual(sent, ["quick"]);
});

test("Escape in the expanded editor closes an open slash menu before the editor", async () => {
  const user = userEvent.setup();
  mount();
  await user.click(expandButton());
  await user.type(screen.getByRole("textbox"), "/");
  assert.ok(screen.getByRole("listbox"));

  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("listbox"), null);
  assert.ok(screen.getByRole("dialog"));

  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("dialog"), null);
});
