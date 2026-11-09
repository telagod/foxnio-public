import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { FOX_REPORT_COMMAND, FOX_REPORT_REPLY_PREFIX } from "./fox-reports.mjs";

const { deliverNativeFoxReport, FoxReportAgentInvocationError } = await createJiti(import.meta.url).import("./fox-report-delivery.ts");
const report = {
  version: 1, id: "worker-one:1", sourceSessionId: "worker-one", parentSessionId: "parent-one",
  sequence: 1, cwd: "/project", at: "2026-11-08T10:00:00.000Z", source: "agent",
  status: "result", summary: "Fixture evidence", evidence: [],
};

function wire(run, catalog = { commands: [{ name: FOX_REPORT_COMMAND, source: "extension" }] }) {
  const listeners = new Set();
  const calls = [];
  const emit = (frame) => { for (const listener of listeners) listener(frame); };
  return {
    calls, listeners,
    onFrame(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    async sendCommand(command) {
      calls.push(command);
      if (command.type === "get_available_commands") return catalog;
      const request = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
      const reply = (extra = {}) => emit({
        type: "extension_ui_request", method: "notify",
        message: FOX_REPORT_REPLY_PREFIX + JSON.stringify({
          requestId: request.requestId, sessionId: report.parentSessionId, reportId: report.id, ...extra,
        }),
      });
      return await run({ request, reply, emit });
    },
  };
}

test("delivery uses the registered native command and only a correlated receipt confirms it", async () => {
  const proc = wire(({ request, reply }) => {
    assert.equal(request.parentFile, "/parent.jsonl");
    assert.deepEqual(request.report, report);
    reply({ requestId: "unrelated-reply", sessionId: "wrong-parent" });
    reply();
    return { agentInvoked: false };
  });
  await deliverNativeFoxReport(proc, report, "/parent.jsonl");
  assert.deepEqual(proc.calls.map((call) => call.type), ["get_available_commands", "prompt"]);
  assert.equal(proc.listeners.size, 0);
});

test("missing or malformed native command catalogs cannot fall back to a model prompt", async () => {
  for (const catalog of [null, {}, { commands: {} }, { commands: [{ name: FOX_REPORT_COMMAND, source: "builtin" }] }]) {
    const proc = wire(() => assert.fail("No prompt may be sent"), catalog);
    await assert.rejects(deliverNativeFoxReport(proc, report, "/parent.jsonl"), /unavailable.*restart/);
    assert.equal(proc.calls.length, 1);
  }
});

test("an input hook invoking the model is detected without waiting for a stuck prompt acknowledgement", async () => {
  const proc = wire(({ emit }) => {
    emit({ type: "agent_start" });
    return new Promise(() => {});
  });
  await assert.rejects(Promise.race([
    deliverNativeFoxReport(proc, report, "/parent.jsonl"),
    delay(250).then(() => { throw new Error("Did not detect invocation promptly"); }),
  ]), FoxReportAgentInvocationError);
  assert.equal(proc.listeners.size, 0);
});

test("an invocation acknowledgement is rejected even when the start event was lost", async () => {
  const proc = wire(() => ({ agentInvoked: true }));
  await assert.rejects(deliverNativeFoxReport(proc, report, "/parent.jsonl"), FoxReportAgentInvocationError);
  assert.equal(proc.listeners.size, 0);
});

test("a persistence failure cannot succeed or finish before the command acknowledgement", async () => {
  let acknowledged = false;
  const proc = wire(async ({ emit, reply }) => {
    emit({ type: "notice", source: "session-persistence", level: "error", message: "Fixture persistence failure" });
    reply();
    await delay(20);
    acknowledged = true;
    return {};
  });
  await assert.rejects(deliverNativeFoxReport(proc, report, "/parent.jsonl"), /Fixture persistence failure/);
  assert.equal(acknowledged, true);
  assert.equal(proc.listeners.size, 0);
});

test("wrong identities and native handler failures are not delivery confirmations", async () => {
  for (const [payload, pattern] of [
    [{ sessionId: "wrong-parent" }, /wrong identity/],
    [{ reportId: "worker-two:1" }, /wrong identity/],
    [{ error: "The coordinator is busy" }, /coordinator is busy/],
  ]) {
    const proc = wire(({ reply }) => { reply(payload); return {}; });
    await assert.rejects(deliverNativeFoxReport(proc, report, "/parent.jsonl"), pattern);
    assert.equal(proc.listeners.size, 0);
  }
});

test("a transport acknowledgement without the native receipt times out and releases its listener", async () => {
  const proc = wire(({ reply }) => { reply({ requestId: "another-request" }); return {}; });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(deliverNativeFoxReport(proc, report, "/parent.jsonl", 20), /timed out/);
    assert.equal(proc.listeners.size, 0);
  } finally {
    clearTimeout(keepAlive);
  }
});
