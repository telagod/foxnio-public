import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { FoxWorkerReport } = await jiti.import("./FoxWorkerReport.tsx");
const { isGroupAnchor, planTranscriptRows } = await jiti.import("../lib/chat-transcript-plan.ts");
const report = {
  version: 1, id: "worker-one:1", sourceSessionId: "worker-one", parentSessionId: "parent-one",
  sequence: 1, cwd: "/projects/app", at: "2026-11-08T12:00:00Z",
  source: "agent", status: "result", summary: "Fixed the fixture.", evidence: ["Regression passed"],
};

test("native reports stay visible instead of folding into the previous turn's hidden activity", () => {
  const message = { role: "custom", customType: "fox-worker-report-received", display: true, content: report.summary, details: { report } };
  assert.equal(isGroupAnchor(message), true);
  assert.equal(isGroupAnchor({ ...message, display: false }), false);
  const plan = planTranscriptRows([{ role: "user", content: "Delegate" }, { role: "assistant", content: [{ type: "text", text: "Delegated" }] }, message]);
  assert.ok(plan.some((row) => row.index === 2 || row.userIndex === 2));
});

test("a worker report is identified as unverified agent evidence and opens its source session", () => {
  const opened = [];
  const listener = (event) => opened.push(event.detail);
  window.addEventListener("omp-open-session", listener);
  try {
    render(React.createElement(FoxWorkerReport, { report }));
    assert.ok(screen.getByText("Fixed the fixture."));
    assert.ok(screen.getByText("Regression passed"));
    assert.ok(screen.getByText(/not independent acceptance verification/));
    fireEvent.click(screen.getByRole("button", { name: "Open worker conversation" }));
    assert.deepEqual(opened, ["worker-one"]);
  } finally {
    cleanup();
    window.removeEventListener("omp-open-session", listener);
  }
});
