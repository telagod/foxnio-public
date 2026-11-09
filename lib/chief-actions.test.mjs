import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./chief-store.ts");
const { evaluateFoxAction, foxActionTask } = await jiti.import("./chief-actions.ts");

function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "chief-actions-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  store.closeChiefStore();
  t.after(() => {
    store.closeChiefStore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

const request = (overrides = {}) => ({
  toolName: "new_session",
  args: { cwd: "/work/a", prompt: "Fix the flaky test" },
  sourceSessionId: "fox-session",
  sourceCwd: "/home/telagod/.omp/agent/omp-web/fox",
  projectRef: "/work/a",
  ...overrides,
});

test("suggest mode creates one ticket and one pending approval for retries", (t) => {
  isolated(t);
  const first = evaluateFoxAction(request());
  assert.equal(first.allowed, false);
  assert.equal(first.autonomy, "suggest");
  assert.match(first.message, /Approval required/);
  assert.ok(first.ticketId);
  assert.ok(first.approvalId);

  const retry = evaluateFoxAction(request());
  assert.equal(retry.approvalId, first.approvalId);
  assert.equal(store.listApprovals("pending").length, 1);
  assert.equal(store.listTickets().length, 1);
});

test("observe records no action and auto allows it", (t) => {
  isolated(t);
  store.setAutonomy("/work/a", "observe");
  const observed = evaluateFoxAction(request());
  assert.equal(observed.allowed, false);
  assert.match(observed.message, /observe mode/);
  assert.equal(store.listApprovals("pending").length, 0);

  store.setAutonomy("/work/a", "auto");
  const allowed = evaluateFoxAction(request({ args: { cwd: "/work/a", prompt: "Different task" } }));
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.autonomy, "auto");
});

test("action titles use the prompt or message", () => {
  assert.equal(foxActionTask("new_session", { prompt: "  Fix\n  tests " }), "Fix tests");
  assert.equal(foxActionTask("send_to_session", { message: "Run the release check" }), "Run the release check");
});
