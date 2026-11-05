import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const route = await jiti.import("../app/api/web-settings/route.ts");
const { recordRunningSessions } = await jiti.import("./session-resume.ts");
const { saveWebServerSettings } = await jiti.import("./web-settings.ts");
const { SECRET_MASK } = await jiti.import("./secret-mask.ts");

function withSettings(agentEnv, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const path = join(dir, "omp-web-settings.json");
  writeFileSync(path, JSON.stringify({ autoResumeSessions: false, agentToolsEnabled: false, agentEnv }), "utf8");
  return Promise.resolve(run(() => JSON.parse(readFileSync(path, "utf8")).agentEnv)).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  });
}

const put = (body) => route.PUT(new Request("http://localhost/api/web-settings", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

const STORED = { OBSIDIAN_API_KEY: "key-123", GITHUB_TOKEN: "ghp_abc", HTTPS_PROXY: "http://proxy:3128", DB_PASSWORD: "pw" };

test("GET masks credential-looking variables and shows the rest", async () => {
  await withSettings(STORED, async () => {
    const body = await (await route.GET()).json();
    assert.deepEqual(body.agentEnv, {
      OBSIDIAN_API_KEY: SECRET_MASK,
      GITHUB_TOKEN: SECRET_MASK,
      HTTPS_PROXY: "http://proxy:3128",
      DB_PASSWORD: SECRET_MASK,
    });
  });
});

test("saving the masked text unchanged keeps the stored secrets", async () => {
  await withSettings(STORED, async (stored) => {
    const { agentEnv } = await (await route.GET()).json();
    const text = Object.entries(agentEnv).map(([name, value]) => `${name}=${value}`).join("\n");
    const res = await put({ agentEnv: text });
    assert.equal(res.status, 200);
    assert.deepEqual(stored(), STORED);
    assert.doesNotMatch(JSON.stringify(await res.json()), /key-123|ghp_abc/);
  });
});

test("a replaced value is stored, a removed line is deleted, an unchanged line is kept", async () => {
  await withSettings(STORED, async (stored) => {
    const text = [`OBSIDIAN_API_KEY=key-456`, `GITHUB_TOKEN=${SECRET_MASK}`, "HTTPS_PROXY=http://proxy:3128"].join("\n");
    const res = await put({ agentEnv: text });
    assert.equal(res.status, 200);
    assert.deepEqual(stored(), { OBSIDIAN_API_KEY: "key-456", GITHUB_TOKEN: "ghp_abc", HTTPS_PROXY: "http://proxy:3128" });
  });
});

test("the placeholder for a variable that has no stored value is refused", async () => {
  await withSettings(STORED, async (stored) => {
    const res = await put({ agentEnv: `OTHER_API_KEY=${SECRET_MASK}` });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "secret_placeholder_unresolved");
    assert.deepEqual(stored(), STORED);
  });
});

test("the object form of agentEnv honours the placeholder too", async () => {
  await withSettings(STORED, async (stored) => {
    const res = await put({ agentEnv: { GITHUB_TOKEN: SECRET_MASK, EXTRA: "1" } });
    assert.equal(res.status, 200);
    assert.deepEqual(stored(), { GITHUB_TOKEN: "ghp_abc", EXTRA: "1" });
  });
});

test("GET reports a revision that changes with the stored environment", async () => {
  await withSettings(STORED, async () => {
    const first = await (await route.GET()).json();
    assert.match(first.agentEnvRevision, /^[0-9a-f]{64}$/);
    assert.equal((await (await route.GET()).json()).agentEnvRevision, first.agentEnvRevision);
    const saved = await (await put({ agentEnv: "HTTPS_PROXY=http://other:3128" })).json();
    assert.notEqual(saved.agentEnvRevision, first.agentEnvRevision);
  });
});

test("a save based on an outdated revision is refused with 409 and stores nothing", async () => {
  await withSettings(STORED, async (stored) => {
    const { agentEnvRevision: loaded } = await (await route.GET()).json();
    // Another tab saves first.
    assert.equal((await put({ agentEnv: "ONLY=1", agentEnvRevision: loaded })).status, 200);

    const stale = await put({ agentEnv: "MINE=2", agentEnvRevision: loaded });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "agent_env_conflict");
    assert.deepEqual(stored(), { ONLY: "1" });
  });
});

test("a save with the current revision succeeds and returns the next one", async () => {
  await withSettings(STORED, async (stored) => {
    const { agentEnvRevision } = await (await route.GET()).json();
    const res = await put({ agentEnv: "A=1", agentEnvRevision });
    assert.equal(res.status, 200);
    assert.deepEqual(stored(), { A: "1" });
    const next = (await res.json()).agentEnvRevision;
    assert.equal((await put({ agentEnv: "A=2", agentEnvRevision: next })).status, 200);
  });
});

test("reserved or invalid variables are reported per line and nothing is persisted", async () => {
  await withSettings(STORED, async (stored) => {
    const res = await put({ agentEnv: "GOOD=1\nPATH=/evil\n9BAD=x" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_agent_env");
    assert.equal(body.errors.length, 2);
    assert.deepEqual(stored(), STORED);
  });
});

test("each setting is optional: saving one leaves the others as they were", async () => {
  await withSettings(STORED, async (stored) => {
    assert.equal((await put({ autoResumeSessions: true })).status, 200);
    assert.deepEqual(stored(), STORED);
    const body = await (await route.GET()).json();
    assert.equal(body.autoResumeSessions, true);

    assert.equal((await put({ agentEnv: "A=1" })).status, 200);
    assert.equal((await (await route.GET()).json()).autoResumeSessions, true);
    assert.equal((await put({ autoResumeSessions: "yes" })).status, 400);
  });
});

test("live sessions are re-synced only when autoResumeSessions is part of the save", async () => {
  await withSettings(STORED, async () => {
    const tracked = { id: "01a0e6b0-d916-7610-8343-f4a766ba005a", advisor: "inherit" };
    const trackerSize = () => globalThis.__ompResumeTracker?.sessions.size ?? 0;
    try {
      // Resume is on and one session is tracked, then the flag is switched off behind the
      // route's back: the tracker only drops the session when something re-syncs it.
      saveWebServerSettings({ autoResumeSessions: true });
      recordRunningSessions([tracked], () => true);
      assert.equal(trackerSize(), 1);
      saveWebServerSettings({ autoResumeSessions: false });

      await put({ agentEnv: "A=1" });
      await put({ agentToolsEnabled: true });
      assert.equal(trackerSize(), 1, "saves that do not carry autoResumeSessions must not re-sync");

      await put({ autoResumeSessions: false });
      assert.equal(trackerSize(), 0, "a save carrying autoResumeSessions re-syncs live sessions");
    } finally {
      for (const timer of globalThis.__ompResumeTracker?.drops.values() ?? []) clearTimeout(timer);
      globalThis.__ompResumeTracker = undefined;
    }
  });
});
