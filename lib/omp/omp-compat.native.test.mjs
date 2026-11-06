import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { nativeEnvironment, within, writeInertAgentConfig } from "../../tests/omp-native-env.mjs";

// foxnio's contract with the omp executable (OMP_WEB_OMP_BIN, else PATH),
// exercised through foxnio's own code paths and without any model call. Opt-in
// like session-edit.native.test.mjs: `npm test` discovers this file but never
// launches omp. The omp tracking workflow runs it against each new omp release.
const enabled = process.env.OMP_WEB_TEST_NATIVE_COMPAT === "1";
const nativeOptions = {
  skip: !enabled && "set OMP_WEB_TEST_NATIVE_COMPAT=1 to check the installed OMP executable",
  timeout: 120_000,
};

const PROVIDER = "omp-web-compat-fixture";
const MODEL = "offline-compat";
const API = "openai-completions";

let binary;
let root;
let agentDir;
let home;
let m;

if (enabled) {
  const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../../", import.meta.url)) } });
  // Resolve against the real HOME first: ~/.bun/bin and ~/.local/bin installs need not be on PATH.
  const { resolveOmpBin } = await jiti.import("./omp-cli.ts");
  binary = process.env.OMP_WEB_OMP_BIN || resolveOmpBin();
  if (!binary) throw new Error("No omp executable found: install omp or set OMP_WEB_OMP_BIN");
  root = mkdtempSync(join(tmpdir(), "omp-web-compat-"));
  agentDir = join(root, "agent");
  // This process spawns omp through foxnio's real paths, which inherit its
  // environment: replace all of it, so no credential, config or endpoint of
  // this machine reaches the child.
  const isolated = nativeEnvironment(root, agentDir);
  for (const key of Object.keys(process.env)) if (key !== "NODE_TEST_CONTEXT") delete process.env[key];
  Object.assign(process.env, isolated, { OMP_WEB_OMP_BIN: binary });
  home = isolated.HOME;
  writeInertAgentConfig(agentDir, { provider: PROVIDER, model: MODEL, api: API, apiKey: "compat-fixture-inert-key" });
  m = {
    cli: await jiti.import("./omp-cli.ts"),
    files: await jiti.import("./session-files.ts"),
    paths: await jiti.import("./paths.ts"),
    process: await jiti.import("./rpc-process.ts"),
    reader: await jiti.import("../session-reader.ts"),
    rpc: await jiti.import("../rpc-manager.ts"),
    skills: await jiti.import("../skills-service.ts"),
    exportRoute: await jiti.import("../../app/api/sessions/[id]/export/route.ts"),
  };
  test.after(() => {
    globalThis.__ompNotificationStore?.db.close();
    globalThis.__ompNotificationStore = undefined;
    rmSync(root, { recursive: true, force: true });
  });
}

/** A project directory under HOME, where real projects live (omp names its session directory after it). */
function project(name) {
  const cwd = join(home, "projects", name);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

/** A saved v3 session in the sessions directory omp uses for `cwd`, whose model is the inert fixture. */
function writeFixtureSession(cwd) {
  const id = randomUUID();
  const dir = join(m.paths.getSessionsDir(), m.paths.getSessionDirNameForCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  writeFileSync(file, [
    { type: "session", version: 3, id, cwd, timestamp },
    { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "compat question", timestamp: 1 } },
    {
      type: "message", id: "a1", parentId: "u1", timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "compat answer" }], timestamp: 2, api: API, provider: PROVIDER, model: MODEL, stopReason: "stop", usage },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { id, file };
}

function sessionHeader(file) {
  return JSON.parse(readFileSync(file, "utf8").split("\n").find((line) => line.includes('"type":"session"')));
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label}: not reached within ${timeoutMs}ms`);
    await sleep(50);
  }
}

test("the installed omp reports a version foxnio can read", nativeOptions, async () => {
  assert.match(await m.cli.getOmpVersion() ?? "", /^omp\/\d+\.\d+\.\d+/);
});

test("a new session runs a shell turn and plans its file where foxnio lists sessions", nativeOptions, async (t) => {
  const cwd = project("new-session");
  const { session } = await m.rpc.startRpcSession(`__new__${randomUUID()}`, "", cwd);
  t.after(() => session.destroyAndWait());

  const result = await session.send({ type: "bash", command: "echo foxnio-compat" });
  assert.match(result.output, /foxnio-compat/);
  assert.equal(result.exitCode, 0);
  assert.equal(result.cancelled, false);
  // omp writes a new session's file with its first model turn, which this test
  // never runs, so only the planned path can be compared.
  assert.equal(dirname(session.sessionFile), join(m.paths.getSessionsDir(), m.paths.getSessionDirNameForCwd(cwd)),
    "omp files the session under the directory foxnio derives for its cwd");
});

test("a resumed session reports the state foxnio reads and still knows foxnio's commands", nativeOptions, async (t) => {
  const cwd = project("resume");
  const { id, file } = writeFixtureSession(cwd);
  const { session, realSessionId } = await m.rpc.startRpcSession(id, file, cwd);
  t.after(() => session.destroyAndWait());
  assert.equal(realSessionId, id);
  assert.equal(session.sessionFile, file);

  const state = await session.send({ type: "get_state" });
  assert.equal(state.sessionId, id);
  assert.equal(state.sessionFile, file);
  assert.equal(state.isStreaming, false);
  assert.equal(typeof state.isCompacting, "boolean");
  assert.equal(state.messageCount, 2);
  assert.deepEqual([state.model?.provider, state.model?.id], [PROVIDER, MODEL], "the saved model is restored");
  assert.equal(typeof state.thinkingLevel === "string" || state.thinkingLevel === undefined, true);
  assert.ok(["all", "one-at-a-time"].includes(state.steeringMode), `steeringMode ${state.steeringMode}`);
  assert.ok(["all", "one-at-a-time"].includes(state.followUpMode), `followUpMode ${state.followUpMode}`);
  assert.ok(["immediate", "wait"].includes(state.interruptMode), `interruptMode ${state.interruptMode}`);
  assert.equal(typeof state.autoCompactionEnabled, "boolean");
  assert.equal(typeof state.queuedMessageCount, "number");
  assert.ok(Array.isArray(state.todoPhases));

  // Read-only commands foxnio sends. Each may fail for its own reasons here
  // (no credentials, no subagents), but omp must still know it.
  for (const type of [
    "get_messages", "get_session_stats", "get_last_assistant_text", "get_available_commands", "get_available_models",
    "get_subagents", "get_btw_history", "get_login_providers", "get_logout_accounts",
  ]) {
    try {
      await session.send({ type });
    } catch (error) {
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), /Unknown command/i, type);
    }
  }

  await session.send({ type: "set_session_name", name: "Compat smoke" });
  assert.equal(m.files.loadSessionFile(file).titleSlot?.title, "Compat smoke", "foxnio reads the title omp wrote");

  await session.send({ type: "bash", command: "echo foxnio-compat" });
  await waitFor(() => readFileSync(file, "utf8").includes("bashExecution"), "shell turn persisted");
  const turn = m.reader.getSessionEntries(file).find((entry) => entry.type === "message" && entry.message?.role === "bashExecution");
  assert.equal(turn?.message.command, "echo foxnio-compat", "foxnio reads the shell turn omp persisted");
  assert.ok((await m.files.listSessionFiles(m.paths.getSessionsDir())).includes(file), "foxnio lists the session");
});

// omp >= 18.13.2 resumes the newest copy of a conversation that went on in another file.
test("a resume that omp follows to a continuation copy stays on one foxnio child", nativeOptions, async (t) => {
  const cwd = project("continuation");
  const { id, file } = writeFixtureSession(cwd);
  // Another omp (a terminal session) writes first, so it owns the file.
  const owner = new m.process.RpcProcess({
    cwd,
    extraArgs: ["--resume", file, "--no-tools", "--no-rules", "--no-skills", "--no-extensions", "--no-title"],
  });
  t.after(() => within(owner.dispose(500), 5_000, "owner disposal"));
  await owner.negotiateProtocol(await owner.waitReady(60_000));
  await owner.sendCommand({ type: "bash", command: "echo owner-turn" }, 30_000);

  // foxnio's child writes too, so omp moves it to a continuation file.
  const first = await m.rpc.startRpcSession(id, file, cwd);
  await first.session.send({ type: "bash", command: "echo foxnio-turn" });
  await waitFor(() => first.session.sessionId !== id, "move to a continuation file");
  const continued = first.session.sessionId;
  assert.equal(sessionHeader(first.session.sessionFile).continuationOf, id);
  assert.equal(m.rpc.getRpcSession(id), first.session, "the moved child keeps serving the original id");
  await first.session.destroyAndWait();

  // Opening the original again lands on the continuation; foxnio keeps one child for it.
  const reopened = await m.rpc.startRpcSession(id, file, cwd);
  t.after(() => reopened.session.destroyAndWait());
  assert.equal(reopened.realSessionId, continued);
  assert.equal(m.rpc.getRpcSession(id), reopened.session);
  assert.equal((await m.rpc.startRpcSession(id, file, cwd)).session, reopened.session);
});

test("omp's skill listing parses into foxnio's skill list", nativeOptions, () => {
  const skillDir = join(agentDir, "skills", "compat-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: compat-skill\ndescription: Checks the skill listing contract.\n---\n\nBody.\n");
  const stdout = execFileSync(binary, ["skill", "list", "--json"], { cwd: project("skills"), encoding: "utf8", timeout: 60_000 });
  const listed = m.skills.skillsFromCliPayload(JSON.parse(stdout));
  assert.ok(listed, "foxnio accepts the payload shape");
  const skill = listed.skills.find((entry) => entry.name === "compat-skill");
  assert.ok(skill, "the agent-dir skill is listed");
  assert.equal(skill.description, "Checks the skill listing contract.");
});

test("foxnio's export route serves the page omp --export renders", nativeOptions, async () => {
  const { id } = writeFixtureSession(project("export"));
  const response = await m.exportRoute.GET(
    new Request(`http://localhost/api/sessions/${id}/export?inline=1`),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox /);
  assert.match(await response.text(), /<\/html>\s*$/i);
});
