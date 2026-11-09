import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_NAMES,
  AgentToolGuard,
  executeAgentTool,
  formatAttributedMessage,
} = await jiti.import("./agent-tools.ts");

function fakeOps(overrides = {}) {
  const calls = { list: 0, create: [], deliver: [] };
  return {
    calls,
    async listSessions() {
      calls.list += 1;
      return [{ id: "target-1", name: "Release", cwd: "/tmp/release", running: false }];
    },
    async createSession(input) {
      calls.create.push(input);
      return { sessionId: "new-1" };
    },
    async deliver(input) {
      calls.deliver.push(input);
      return { accepted: true, targetSessionId: input.sessionId, delivery: input.delivery, waited: false, responseText: null };
    },
    ...overrides,
  };
}

const ctx = (overrides = {}) => ({
  sourceSessionId: "source-1",
  sourceCwd: "/tmp/source",
  enabled: true,
  guard: new AgentToolGuard(),
  ...overrides,
});

test("agent tools only bridge cross-project sessions; native tools own plans and memory (#275)", () => {
  assert.deepEqual(
    [...AGENT_TOOL_NAMES].sort(),
    ["list_sessions", "new_session", "send_to_session"],
  );
  assert.deepEqual(
    AGENT_TOOL_DEFINITIONS.map((t) => t.name).sort(),
    ["list_sessions", "new_session", "send_to_session"],
  );
  const send = AGENT_TOOL_DEFINITIONS.find((t) => t.name === "send_to_session");
  assert.deepEqual(send.parameters.required, ["sessionId", "message"]);
  assert.deepEqual(send.parameters.properties.delivery.enum, ["prompt", "steer", "followUp"]);
});

test("agent tools refuse every call while the Settings gate is off (#275)", async () => {
  const off = ctx({ enabled: false });
  await assert.rejects(() => executeAgentTool("list_sessions", {}, fakeOps(), off), /disabled/);
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, fakeOps(), off),
    /disabled/,
  );
});

test("retired chief tools cannot write a parallel store", async () => {
  await assert.rejects(
    () => executeAgentTool("chief_remember", { text: "Prefer short updates" }, fakeOps(), ctx()),
    /Unknown agent tool/,
  );
  await assert.rejects(
    () => executeAgentTool("chief_ticket_create", { title: "Track this" }, fakeOps(), ctx()),
    /Unknown agent tool/,
  );
});

test("list_sessions returns the sessions the ops layer reports (#275)", async () => {
  const ops = fakeOps();
  const result = await executeAgentTool("list_sessions", {}, ops, ctx());
  assert.deepEqual(result, { sessions: [{ id: "target-1", name: "Release", cwd: "/tmp/release", running: false }] });
  assert.equal(ops.calls.list, 1);
});

test("new_session defaults cwd, attributes the prompt, and splits provider/model (#275)", async () => {
  const ops = fakeOps();
  const result = await executeAgentTool(
    "new_session",
    { prompt: "Do the release checklist", model: "anthropic/claude-sonnet-4-5", name: "Release worker" },
    ops,
    ctx(),
  );
  assert.deepEqual(result, { sessionId: "new-1" });
  assert.equal(ops.calls.create.length, 1);
  const input = ops.calls.create[0];
  assert.equal(input.cwd, "/tmp/source");
  assert.equal(input.prompt, "[From session source-1 via foxnio agent tools]: Do the release checklist");
  assert.equal(input.provider, "anthropic");
  assert.equal(input.modelId, "claude-sonnet-4-5");
  assert.equal(input.name, "Release worker");
});

test("new_session without a prompt creates an idle session, and bad models are rejected (#275)", async () => {
  const ops = fakeOps();
  await executeAgentTool("new_session", { cwd: "/tmp/other" }, ops, ctx());
  assert.equal(ops.calls.create[0].prompt, null);
  assert.equal(ops.calls.create[0].cwd, "/tmp/other");
  await assert.rejects(() => executeAgentTool("new_session", { model: "no-slash" }, fakeOps(), ctx()), /provider\/modelId/);
  await assert.rejects(
    () => executeAgentTool("new_session", { provider: "anthropic" }, fakeOps(), ctx()),
    /together/,
  );
  await assert.rejects(() => executeAgentTool("new_session", {}, fakeOps(), ctx({ sourceCwd: "" })), /cwd/);
});

test("send_to_session attributes, defaults to prompt, and passes wait through (#275)", async () => {
  const ops = fakeOps();
  const result = await executeAgentTool(
    "send_to_session",
    { sessionId: "target-1", message: "The build passed", wait: true, waitTimeoutMs: 5000 },
    ops,
    ctx(),
  );
  assert.equal(ops.calls.deliver.length, 1);
  const input = ops.calls.deliver[0];
  assert.equal(input.message, "[From session source-1 via foxnio agent tools]: The build passed");
  assert.equal(input.delivery, "prompt");
  assert.equal(input.wait, true);
  assert.equal(input.waitTimeoutMs, 5000);
  assert.equal(result.targetSessionId, "target-1");
});

test("send_to_session rejects self-targets, bad deliveries, and bad waits (#275)", async () => {
  const base = ctx();
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "source-1", message: "hi" }, fakeOps(), base),
    /itself/,
  );
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi", delivery: "shout" }, fakeOps(), ctx()),
    /delivery/,
  );
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi", wait: "yes" }, fakeOps(), ctx()),
    /wait/,
  );
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t" }, fakeOps(), ctx()),
    /message/,
  );
});

test("send_to_session awaits the native lineage and cwd check before delivering", async () => {
  const ops = fakeOps();
  const restricted = ctx({
    allowSendTarget: async (id, cwd) => id === "worker-1" && cwd === "/worker-project",
  });
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "random-project-session", message: "hi" }, ops, restricted),
    /not a direct worker/,
  );
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "worker-1", message: "hi" }, ops, restricted),
    /not a direct worker/,
    "a FOX follow-up without its exact cwd is rejected",
  );
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "worker-1", cwd: "/other-project", message: "hi" }, ops, restricted),
    /not a direct worker/,
    "the approved cwd must match the worker target",
  );
  assert.equal(ops.calls.deliver.length, 0, "rejected targets are never delivered");
  const result = await executeAgentTool(
    "send_to_session",
    { sessionId: "worker-1", cwd: "/worker-project", message: "hi" },
    ops,
    restricted,
  );
  assert.equal(result.targetSessionId, "worker-1");
  assert.equal(ops.calls.deliver.length, 1);
});

test("send_to_session wait timeout defaults and caps (#275)", async () => {
  const ops = fakeOps();
  await executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, ops, ctx());
  assert.equal(ops.calls.deliver[0].wait, false);
  assert.equal(ops.calls.deliver[0].waitTimeoutMs, 120000);
  const capped = fakeOps();
  await executeAgentTool("send_to_session", { sessionId: "t", message: "hi", waitTimeoutMs: 9999999 }, capped, ctx());
  assert.equal(capped.calls.deliver[0].waitTimeoutMs, 300000);
});

test("attribution format keeps the full source ID for sidebar lookup (#275)", () => {
  assert.equal(
    formatAttributedMessage("019c625b-b900-7000-8000-000000000277", "hello"),
    "[From session 019c625b-b900-7000-8000-000000000277 via foxnio agent tools]: hello",
  );
});

test("chain depth stops a loop and a failed delivery does not advance it (#275)", async () => {
  const guard = new AgentToolGuard();
  guard.setDepth("source-1", 5);
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, fakeOps(), ctx({ guard })),
    /chain depth/,
  );

  const failing = fakeOps({
    async deliver() {
      throw new Error("target vanished");
    },
  });
  const guard2 = new AgentToolGuard();
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, failing, ctx({ guard: guard2 })),
    /target vanished/,
  );
  assert.equal(guard2.depthFor("t"), 0);

  const ok = fakeOps();
  await executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, ok, ctx({ guard: guard2 }));
  assert.equal(guard2.depthFor("t"), 1);
});

test("a waited delivery records the target depth before awaiting, so nested deliveries hit the cap (#275)", async () => {
  const guard = new AgentToolGuard();
  // Each hop's deliver() runs while the previous hop is still awaiting, the
  // way a target that messages onward during a waited turn does.
  let hops = 0;
  const ops = fakeOps({
    async deliver(input) {
      hops += 1;
      await executeAgentTool(
        "send_to_session",
        { sessionId: `hop-${hops + 1}`, message: "next", wait: true },
        ops,
        ctx({ sourceSessionId: input.sessionId, guard }),
      );
      return { accepted: true, targetSessionId: input.sessionId, delivery: input.delivery, waited: true, responseText: null };
    },
  });
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "hop-1", message: "go", wait: true }, ops, ctx({ guard })),
    /chain depth/,
  );
  assert.equal(hops, 5, "the sixth nested delivery is refused");
  for (let i = 1; i <= 6; i += 1) assert.equal(guard.depthFor(`hop-${i}`), 0, "failed deliveries roll their depth back");
});

test("rate limit caps a source at 20 agent tool calls per minute (#275)", async () => {
  const guard = new AgentToolGuard();
  const ops = fakeOps();
  for (let i = 0; i < 20; i++) {
    await executeAgentTool("list_sessions", {}, ops, ctx({ guard }));
  }
  await assert.rejects(() => executeAgentTool("list_sessions", {}, ops, ctx({ guard })), /rate limit/);
});

test("unknown agent tools are rejected (#275)", async () => {
  await assert.rejects(() => executeAgentTool("delete_everything", {}, fakeOps(), ctx()), /Unknown agent tool/);
});
