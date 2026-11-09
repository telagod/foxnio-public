import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { nativeEnvironment, writeInertAgentConfig } from "./omp-native-env.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveOmpBin } = await jiti.import("../lib/omp/omp-cli.ts");
const binary = process.env.OMP_WEB_OMP_BIN || resolveOmpBin();
if (!binary) throw new Error("Install omp or set OMP_WEB_OMP_BIN");
const root = mkdtempSync(join(tmpdir(), "fox-workflow-"));
const agentDir = join(root, "agent");
const environment = nativeEnvironment(root, agentDir);
const project = join(root, "project");
mkdirSync(project);
const provider = "fox-workflow-fixture";
const model = "offline-fixture";
writeInertAgentConfig(agentDir, { provider, model, api: "openai-completions", apiKey: "inert-fixture-key" });
appendFileSync(join(agentDir, "config.yml"), `modelRoles:\n  default: ${provider}/${model}\n  smol: ${provider}/${model}\n`);
writeFileSync(join(agentDir, "omp-web-settings.json"), JSON.stringify({ autoResumeSessions: false, agentToolsEnabled: true }), { mode: 0o600 });
const fox = join(environment.HOME, ".omp", "agent", "omp-web", "fox");
mkdirSync(fox, { recursive: true });
writeFileSync(join(fox, "service.json"), JSON.stringify({ enabled: false, nativePolicyVersion: 1, dispatchPolicies: {} }), { mode: 0o600 });
const requests = [];
let holdWorkers = false;
let holdCoordinators = false;
let restarting = false;
const held = [];
let next;
const server = createServer(async (request, response) => {
  if (request.url === "/fixture") {
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (typeof input.holdWorkers === "boolean") holdWorkers = input.holdWorkers;
      if (typeof input.holdCoordinators === "boolean") holdCoordinators = input.holdCoordinators;
      for (let index = held.length - 1; index >= 0; index--) {
        const item = held[index];
        if (item.worker ? !holdWorkers : !holdCoordinators) {
          held.splice(index, 1);
          item.send();
        }
      }
      if (input.restartWeb === true) {
        restarting = true;
        try {
          const target = next;
          const exited = new Promise((resolve) => target.once("exit", resolve));
          const timer = setTimeout(() => { try { process.kill(-target.pid, "SIGKILL"); } catch {} }, 5000);
          try {
            process.kill(-target.pid, "SIGTERM");
            await exited;
          } finally {
            clearTimeout(timer);
          }
          startWeb();
        } finally {
          restarting = false;
        }
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ root, project, provider, model, requests, held: held.length }));
    return;
  }
  if (request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const tools = body.tools?.map((tool) => tool.function?.name) ?? [];
  const worker = tools.includes("report_to_parent");
  requests.push({ messages: body.messages, tools, worker });
  const last = body.messages?.at(-1);
  const user = body.messages?.findLast((message) => message.role === "user");
  const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
  const lastCall = body.messages?.findLast((message) => message.role === "assistant" && message.tool_calls?.length)?.tool_calls?.at(-1)?.function?.name;
  let action;
  if (last?.role === "user" && worker && text?.includes("WORKER_FAIL_FIXTURE")) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Isolated fixture provider failure", type: "invalid_request_error" } }));
    return;
  }
  if (last?.role === "user" && worker) {
    action = text?.includes("WORKER_ASK_FIXTURE")
      ? { name: "ask", args: { questions: [{ id: "fixture-choice", header: "隔离验证", question: "请选择本次隔离验证的目标", options: [{ label: "目标 A" }, { label: "目标 B" }] }] } }
      : { name: "report_to_parent", args: { status: "result", summary: text?.includes("WORKER_LATE_FIXTURE") ? "重置前派发的项目已返回迟到汇报。" : text?.includes("WORKER_RESTART_FIXTURE") ? "服务重启后的待送汇报已恢复。" : "项目 agent 已主动返回隔离验证结果。", evidence: ["Native report_to_parent was called by the project agent.", "No project files or external services were changed."] } };
  } else if (worker && lastCall === "ask" && last?.role === "tool") {
    action = { name: "report_to_parent", args: { status: "result", summary: "项目 agent 已收到原生选择，隔离验证结束。", evidence: ["The real native ask dialog was answered.", "No project files were changed."] } };
  } else if (last?.role === "user" && tools.includes("new_session") && /DELEGATE_(?:ASK_|FAIL_|LATE_|RESTART_)?FIXTURE/.test(text)) {
    const kind = text.includes("DELEGATE_ASK") ? "ASK" : text.includes("DELEGATE_FAIL") ? "FAIL" : text.includes("DELEGATE_LATE") ? "LATE" : text.includes("DELEGATE_RESTART") ? "RESTART" : "RESULT";
    action = { name: "new_session", args: { cwd: project, name: `FOX · ${kind} 隔离任务`, prompt: `WORKER_${kind}_FIXTURE: only exercise native reporting; do not change project files.`, provider, modelId: model } };
  }
  const number = requests.length;
  const send = () => {
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `fixture-${number}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
    const delta = action
      ? { role: "assistant", tool_calls: [{ index: 0, id: `fixture-call-${number}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] }
      : { role: "assistant", content: "Fixture response from real OMP." };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: action ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  if (worker && holdWorkers || !worker && tools.includes("new_session") && holdCoordinators) held.push({ worker, send });
  else send();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const modelFile = join(agentDir, "models.yml");
writeFileSync(modelFile, readFileSync(modelFile, "utf8").replace("http://127.0.0.1:1/v1", `http://127.0.0.1:${port}/v1`).replace("8192", "131072"));
writeFileSync(join(root, "fixture.json"), JSON.stringify({ root, project, fox, provider, model, providerPort: port, webPort: 30178 }));
console.log(`FIXTURE=${join(root, "fixture.json")}`);
function startWeb() {
  next = spawn(process.execPath, [join(repo, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", "30178"], {
    cwd: repo,
    env: { ...environment, OMP_WEB_OMP_BIN: binary, NEXT_TELEMETRY_DISABLED: "1" },
    detached: true,
    stdio: "inherit",
  });
  next.on("exit", (code) => {
    if (restarting) return;
    server.closeAllConnections();
    server.close();
    process.exitCode = code ?? 0;
  });
}
startWeb();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  process.kill(-next.pid, "SIGTERM");
  setTimeout(() => {
    try { process.kill(-next.pid, "SIGKILL"); } catch {}
    process.exit(0);
  }, 5000).unref();
});
