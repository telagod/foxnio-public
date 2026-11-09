import assert from "node:assert/strict";
import test from "node:test";
import { FOX_DISPATCH_RECEIPT_PREFIX, FoxDispatchReceipts, foxActionFingerprint } from "./fox-dispatch-guard.mjs";

const action = {
  sessionId: "fox-parent",
  toolCallId: "call-one",
  toolName: "new_session",
  projectKey: "/projects/app",
  input: { cwd: "/projects/app", prompt: "Fix the bug", model: "fixture/test" },
};
const receipt = (value = action, confirmation = "confirmed") => ({
  type: "extension_ui_request",
  method: "notify",
  message: FOX_DISPATCH_RECEIPT_PREFIX + JSON.stringify({
    sessionId: value.sessionId,
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    projectKey: value.projectKey,
    fingerprint: foxActionFingerprint(value),
    confirmation,
  }),
});

test("native consent is consumed once and applies only to the exact pending tool call", () => {
  const receipts = new FoxDispatchReceipts();
  assert.equal(receipts.take(action, true), false);
  assert.equal(receipts.capture(receipt()), true);
  assert.equal(receipts.take(action, true), true);
  assert.equal(receipts.take(action, true), false);
});

test("changes to the approved destination, prompt or model fail closed", () => {
  for (const patch of [
    { cwd: "/projects/other" },
    { prompt: "Do something else" },
    { model: "other/model" },
  ]) {
    const receipts = new FoxDispatchReceipts();
    receipts.capture(receipt());
    assert.equal(receipts.take({ ...action, input: { ...action.input, ...patch } }, true), false);
    assert.equal(receipts.take(action, true), false);
  }
});

test("receipts cannot authorize another source session, tool or call", () => {
  for (const patch of [
    { sessionId: "another-fox" },
    { toolName: "send_to_session" },
    { toolCallId: "different-call" },
    { projectKey: "/a/different/symlink/target" },
  ]) {
    const receipts = new FoxDispatchReceipts();
    receipts.capture(receipt());
    assert.equal(receipts.take({ ...action, ...patch }, true), false);
  }
});

test("JSON property order does not change the meaning of approval", () => {
  const reordered = { ...action, input: { model: "fixture/test", prompt: "Fix the bug", cwd: "/projects/app" } };
  assert.equal(foxActionFingerprint(action), foxActionFingerprint(reordered));
  assert.notEqual(foxActionFingerprint({ ...action, input: { "0": "test" } }), foxActionFingerprint({ ...action, input: [["0", "test"]] }));
});

test("an automatic dispatch cannot pass after policy tightens to confirmation", () => {
  const receipts = new FoxDispatchReceipts();
  receipts.capture(receipt(action, "automatic"));
  assert.equal(receipts.take(action, true), false);
  receipts.capture(receipt(action, "automatic"));
  assert.equal(receipts.take(action, false), true);
});

test("expired receipts and receipts from a disposed process cannot execute", () => {
  let now = 1000;
  const receipts = new FoxDispatchReceipts({ now: () => now, maxAgeMs: 60_000 });
  receipts.capture(receipt());
  now += 60_001;
  assert.equal(receipts.take(action, true), false);
  receipts.capture(receipt());
  receipts.clear();
  assert.equal(receipts.take(action, true), false);
});

test("ordinary model output cannot masquerade as the native approval event", () => {
  const receipts = new FoxDispatchReceipts();
  assert.equal(receipts.capture({ ...receipt(), type: "message_update" }), false);
  assert.equal(receipts.capture({ ...receipt(), method: "setStatus" }), false);
  assert.equal(receipts.capture({ type: "extension_ui_request", method: "notify", message: "normal notice" }), false);
  assert.equal(receipts.capture({ ...receipt(), message: FOX_DISPATCH_RECEIPT_PREFIX + "not JSON" }), true);
  assert.equal(receipts.take(action, true), false);
});
