import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ToolPresetStatus } = await jiti.import("./ToolPresetStatus.tsx");

function renderStatus(props) {
  return renderToStaticMarkup(React.createElement(ToolPresetStatus, { onChange() {}, ...props }));
}

test("shows the full CLI tool preset for new sessions without a warning", () => {
  const html = renderStatus({ selectedPreset: "full", activeToolset: null, hasSession: false });
  assert.match(html, /New-session tools/);
  assert.match(html, /All tools, including subagents/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("warns before a restricted preset is used for a new session", () => {
  const html = renderStatus({ selectedPreset: "default", activeToolset: null, hasSession: false });
  assert.match(html, /role="alert"/);
  assert.match(html, /limited to read, bash, edit and write/);
  assert.match(html, /Choose full/);
});

test("reports a restricted active session separately from the next-session preset", () => {
  const html = renderStatus({ selectedPreset: "full", activeToolset: { running: true, preset: "none" }, hasSession: true });
  assert.match(html, /Current session: No tools \(0 tools\)/);
  assert.match(html, /This running session has OMP tools disabled/);
  assert.match(html, /New-session tools/);
});

test("does not guess the tool preset of a resumed session when the server reports unknown", () => {
  const html = renderStatus({ selectedPreset: "full", activeToolset: { running: true, preset: null }, hasSession: true });
  assert.match(html, /Current session: tool preset unknown/);
  assert.doesNotMatch(html, /Current session: full OMP toolset/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("distinguishes a stopped session from an active toolset", () => {
  const html = renderStatus({ selectedPreset: "full", activeToolset: { running: false, preset: null }, hasSession: true });
  assert.match(html, /No live OMP process/);
});
