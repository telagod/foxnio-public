import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./chief-store.ts");

function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "chief-store-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  store.closeChiefStore();
  t.after(() => {
    store.closeChiefStore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("autonomy defaults to suggest and round-trips", (t) => {
  isolated(t);
  assert.equal(store.getAutonomy("/work/a"), "suggest");
  store.setAutonomy("/work/a", "auto");
  assert.equal(store.getAutonomy("/work/a"), "auto");
  assert.deepEqual(store.listAutonomy(), { "/work/a": "auto" });
  assert.throws(() => store.setAutonomy("/work/a", "bad"), /Invalid/);
});

test("tickets are idempotent by trigger and update their assignee", (t) => {
  isolated(t);
  const first = store.createTicket({
    projectRef: "/work/a",
    projectName: "a",
    title: "Fix the flaky test",
    triggerId: "session-a:error",
    state: "inbox",
  });
  const second = store.createTicket({
    projectRef: "/work/a",
    projectName: "a",
    title: "Fix the flaky test",
    triggerId: "session-a:error",
    state: "inbox",
  });
  assert.equal(first.id, second.id);
  assert.equal(first.state, "inbox");
  assert.equal(store.listTickets().length, 1);

  const working = store.updateTicket(first.id, { state: "working", assigneeSessionId: "worker-1" });
  assert.equal(working.state, "working");
  assert.equal(working.assigneeSessionId, "worker-1");

  store.reconcileAssignedTickets(
    [{ id: "worker-1", messageCount: 0, lastMessageAt: "2026-11-08T00:00:00.000Z" }],
    [{ id: "worker-1", running: false }],
  );
  assert.equal(store.getTicket(first.id).state, "review");
});

test("a worker waiting for input stays in waiting_human", (t) => {
  isolated(t);
  const ticket = store.createTicket({
    projectRef: "/work/a",
    projectName: "a",
    title: "Waiting on the user",
    state: "working",
    assigneeSessionId: "worker-1",
  });

  store.reconcileAssignedTickets(
    [{ id: "worker-1", messageCount: 1, lastMessageAt: "2026-11-08T00:00:00.000Z" }],
    [{ id: "worker-1", running: false, pendingInput: 1 }],
  );
  assert.equal(store.getTicket(ticket.id).state, "waiting_human");

  store.reconcileAssignedTickets(
    [{ id: "worker-1", messageCount: 1, lastMessageAt: "2026-11-08T00:00:00.000Z" }],
    [{ id: "worker-1", running: false, pendingInput: 0 }],
  );
  assert.equal(store.getTicket(ticket.id).state, "review");
});

test("explicit tickets are separate and approvals are decidable", (t) => {
  isolated(t);
  const one = store.createTicket({ projectRef: "/work/a", projectName: "a", title: "One" });
  const two = store.createTicket({ projectRef: "/work/a", projectName: "a", title: "Two" });
  assert.notEqual(one.id, two.id);

  const approval = store.createApproval({
    ticketId: one.id,
    projectRef: "/work/a",
    projectName: "a",
    title: "Spawn a worker",
    action: { toolName: "new_session", args: { cwd: "/work/a" } },
    evidence: "test",
  });
  assert.equal(store.listApprovals("pending").length, 1);
  assert.equal(store.getApproval(approval.id).state, "pending");
  const decided = store.decideApproval(approval.id, "approved");
  assert.equal(decided.state, "approved");
  assert.equal(store.listApprovals("pending").length, 0);
  assert.ok(store.listAudit().some((entry) => entry.kind === "approval"));
});
