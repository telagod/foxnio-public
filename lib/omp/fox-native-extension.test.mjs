import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
const { guardFoxDispatch } = await createJiti(import.meta.url, { tryNative: false }).import("./fox-native-extension.mjs");
const { readFoxNativePolicy } = await createJiti(import.meta.url, { tryNative: false }).import("./fox-goal-extension.mjs");
import { FoxDispatchReceipts } from "./fox-dispatch-guard.mjs";
import { comparableProjectPath } from "../comparable-path.ts";
const { foxDispatchProjectKey } = await createJiti(import.meta.url).import("../fox-service-config.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "fox-native-guard-"));
  const project = join(root, "project");
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const asks = [];
  const notices = [];
  const ctx = {
    cwd: root, hasUI: true, sessionManager: { getSessionId: () => "fox" },
    ui: { confirm: async (...args) => { asks.push(args); return true; }, notify: (message) => notices.push(message) },
  };
  const event = { toolName: "new_session", toolCallId: "call-1", projectKey: comparableProjectPath(realpathSync.native(project)), input: { cwd: project, prompt: "Inspect this fixture" } };
  return { root, project, ctx, event, asks, notices };
}

test("a native confirmation produces a receipt bound to the precise action", async (t) => {
  const f = fixture(t);
  assert.equal(await guardFoxDispatch(f.event, f.ctx, false), undefined);
  assert.equal(f.asks.length, 1);
  const receipts = new FoxDispatchReceipts();
  receipts.capture({ type: "extension_ui_request", method: "notify", message: f.notices[0] });
  assert.equal(receipts.take({ ...f.event, sessionId: "fox" }, true), true);
});

test("Windows manual short-path dispatch receipts match the host native project identity", { skip: process.platform !== "win32" }, async (t) => {
  const f = fixture(t);
  const longPath = realpathSync.native(f.project);
  const shortPath = execFileSync("cmd.exe", ["/d", "/c", "for %I in (\"%FOX_TEST_PROJECT%\") do @echo %~sI"], {
    encoding: "utf8", windowsVerbatimArguments: true, env: { ...process.env, FOX_TEST_PROJECT: longPath },
  }).trim();
  assert.notEqual(comparableProjectPath(shortPath), comparableProjectPath(longPath));
  f.event.input.cwd = shortPath;
  assert.equal(await guardFoxDispatch(f.event, f.ctx, false), undefined);
  const receipts = new FoxDispatchReceipts();
  receipts.capture({ type: "extension_ui_request", method: "notify", message: f.notices[0] });
  assert.equal(receipts.take({ ...f.event, sessionId: "fox", projectKey: foxDispatchProjectKey(longPath) }, true), true);
});

test("denial, cancellation and a missing UI never yield execution consent", async (t) => {
  for (const answer of [false, undefined]) {
    const f = fixture(t);
    f.ctx.ui.confirm = async () => answer;
    assert.equal((await guardFoxDispatch(f.event, f.ctx, false)).block, true);
    assert.equal(f.notices.length, 0);
  }
  const f = fixture(t);
  f.ctx.hasUI = false;
  assert.equal((await guardFoxDispatch(f.event, f.ctx, false)).block, true);
  assert.equal(f.notices.length, 0);
});

test("observation turns and observe-only projects cannot dispatch or ask permission", async (t) => {
  const f = fixture(t);
  assert.equal((await guardFoxDispatch(f.event, f.ctx, true)).block, true);
  assert.equal((await guardFoxDispatch({ ...f.event, toolName: "ask" }, f.ctx, true)).block, true);
  assert.equal((await guardFoxDispatch(f.event, f.ctx, false, () => "observe")).block, true);
  assert.equal(f.asks.length, 0);
  assert.equal(f.notices.length, 0);
});

test("native auto-added or extension tools cannot bypass the coordinator's scope", async (t) => {
  const f = fixture(t);
  for (const toolName of ["bash", "edit", "write", "task", "manage_skill", "unknown_mcp_mutation"]) {
    assert.equal((await guardFoxDispatch({ ...f.event, toolName }, f.ctx, false)).block, true);
  }
  for (const toolName of ["todo", "read", "recall", "retain"]) {
    assert.equal(await guardFoxDispatch({ ...f.event, toolName }, f.ctx, false), undefined);
  }
});

test("automatic mode skips a dialog but still binds execution to a native call", async (t) => {
  const f = fixture(t);
  assert.equal(await guardFoxDispatch(f.event, f.ctx, false, () => "auto"), undefined);
  assert.equal(f.asks.length, 0);
  const receipts = new FoxDispatchReceipts();
  receipts.capture({ type: "extension_ui_request", method: "notify", message: f.notices[0] });
  assert.equal(receipts.take({ ...f.event, sessionId: "fox" }, false), true);
});

test("a policy read failure cannot turn an observe project into an allowed one", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "service.json"), "invalid JSON");
  assert.throws(() => readFoxNativePolicy(f.root, f.project), /could not be read/);
  assert.equal((await guardFoxDispatch(f.event, f.ctx, false)).block, true);
  assert.equal(f.asks.length, 0);
});

test("changing arguments while a native confirmation is open invalidates its receipt", async (t) => {
  const f = fixture(t);
  f.ctx.ui.confirm = async () => {
    f.event.input.prompt = "A different task";
    return true;
  };
  await guardFoxDispatch(f.event, f.ctx, false);
  const receipts = new FoxDispatchReceipts();
  receipts.capture({ type: "extension_ui_request", method: "notify", message: f.notices[0] });
  assert.equal(receipts.take({ ...f.event, sessionId: "fox" }, true), false);
});

test("changing a project symlink while confirmation is open invalidates consent", async (t) => {
  const f = fixture(t);
  const alias = join(f.root, "alias");
  const other = join(f.root, "other");
  mkdirSync(other);
  symlinkSync(f.project, alias, "junction");
  f.event.input.cwd = alias;
  f.ctx.ui.confirm = async (_title, message) => {
    assert.match(message, /Resolved project:/);
    unlinkSync(alias);
    symlinkSync(other, alias, "junction");
    return true;
  };
  await guardFoxDispatch(f.event, f.ctx, false);
  const receipts = new FoxDispatchReceipts();
  receipts.capture({ type: "extension_ui_request", method: "notify", message: f.notices[0] });
  assert.equal(receipts.take({ ...f.event, sessionId: "fox", projectKey: comparableProjectPath(realpathSync.native(alias)) }, true), false);
});
