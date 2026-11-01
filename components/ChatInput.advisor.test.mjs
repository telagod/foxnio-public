import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput } = await jiti.import("./ChatInput.tsx");

// jsdom 29 ships no matchMedia; the composer reads one at mount.
const previousMatchMedia = window.matchMedia;
const domWindow = window;
window.matchMedia = (media) => ({
  media,
  matches: false,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

after(() => {
  if (previousMatchMedia) domWindow.matchMedia = previousMatchMedia;
  else delete domWindow.matchMedia;
});
afterEach(() => cleanup());

const ADVISOR_ITEM = /Advisor|messageView\.advisorLabel/;

function renderComposer(props) {
  const changes = [];
  const prompts = [];
  render(React.createElement(ChatInput, {
    async onSend() { return { status: "accepted" }; },
    onAbort() {},
    onFollowUp() {},
    isStreaming: false,
    onAdvisorChange: (enabled) => changes.push(enabled),
    onPromptWithStreamingBehavior: async (text) => { prompts.push(text); return true; },
    ...props,
  }));
  return { changes, prompts };
}

async function openAdvisorRow(props) {
  const result = renderComposer(props);
  await act(async () => { screen.getByRole("button", { name: /More actions|chatInput\.plusMenu/ }).click(); });
  await act(async () => { screen.getByRole("menuitem", { name: ADVISOR_ITEM }).click(); });
  const rows = screen.getAllByRole("menuitem");
  return { ...result, row: rows[rows.length - 1] };
}

test("a chat whose default is off can turn the advisor on from the menu", async () => {
  const { changes, row } = await openAdvisorRow({ advisorEnabled: false, advisorDefaultSource: null });
  assert.equal(row.disabled, false);
  await act(async () => { row.click(); });
  assert.deepEqual(changes, [true]);
});

test("an omp-config default can be turned off for this chat, and the menu says it overrides the default", async () => {
  const { changes, row } = await openAdvisorRow({ advisorEnabled: true, advisorDefaultSource: "omp-config" });
  assert.equal(row.disabled, false);
  assert.match(row.textContent, /On by default for every chat \(omp config\)|chatInput\.advisorDefaultConfig/);
  await act(async () => { row.click(); });
  assert.deepEqual(changes, [false]);
});

test("a project launch default names the launch settings as its source", async () => {
  const { row } = await openAdvisorRow({ advisorEnabled: true, advisorDefaultSource: "project" });
  assert.equal(row.disabled, false);
  assert.match(row.textContent, /for this project \(launch settings\)|chatInput\.advisorDefaultProject/);
});
