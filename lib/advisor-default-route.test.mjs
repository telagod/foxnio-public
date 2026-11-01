import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real GET /api/advisor-default handler against a throwaway home: a default
// agent dir (PI_CODING_AGENT_DIR), a project registry, and omp profiles.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const route = await jiti.import("../app/api/advisor-default/route.ts");

const home = mkdtempSync(join(tmpdir(), "omp-web-advisor-default-route-"));
const agentDir = join(home, "shared-agent");
mkdirSync(agentDir, { recursive: true });
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CONFIG_DIR: process.env.PI_CONFIG_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.PI_CONFIG_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const config = (enabled) => `advisor:\n  enabled: ${enabled}\n`;
function project(name, launchConfig) {
  const path = join(home, "work", name);
  mkdirSync(path, { recursive: true });
  return { path, entry: { path, addedAt: "2026-01-01T00:00:00.000Z", hidden: false, ...(launchConfig ? { launchConfig } : {}) } };
}
function profileConfig(name, enabled) {
  const dir = join(home, ".omp", "profiles", name, "agent");
  mkdirSync(dir, { recursive: true });
  if (enabled !== undefined) writeFileSync(join(dir, "config.yml"), config(enabled), "utf8");
}

const plain = project("plain");
const withProfile = project("profiled", { profile: "work" });
const profileAdvisor = project("profiled-advisor", { profile: "lab", advisor: true });
const missingProfile = project("missing-profile", { profile: "ghost" });
writeFileSync(join(agentDir, "projects.json"), JSON.stringify({
  version: 1,
  projects: [plain, withProfile, profileAdvisor, missingProfile].map((p) => p.entry),
}), "utf8");

const get = async (cwd) => {
  const response = route.GET(new Request(`http://localhost/api/advisor-default${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`));
  assert.equal(response.status, 200);
  return response.json();
};

test("a project without a profile reads the default agent config", async () => {
  writeFileSync(join(agentDir, "config.yml"), config(true), "utf8");
  assert.deepEqual(await get(plain.path), { enabled: true, ompConfig: true, project: false });
  assert.deepEqual(await get(), { enabled: true, ompConfig: true, project: false });
  writeFileSync(join(agentDir, "config.yml"), config(false), "utf8");
  assert.deepEqual(await get(plain.path), { enabled: false, ompConfig: false, project: false });
});

test("a project launched with --profile reads that profile's config, not the default one", async () => {
  // Default on, profile off: omp --profile work runs without the advisor.
  writeFileSync(join(agentDir, "config.yml"), config(true), "utf8");
  profileConfig("work", false);
  assert.deepEqual(await get(withProfile.path), { enabled: false, ompConfig: false, project: false });

  // Default off, profile on: the chat starts with the advisor.
  writeFileSync(join(agentDir, "config.yml"), config(false), "utf8");
  profileConfig("work", true);
  assert.deepEqual(await get(withProfile.path), { enabled: true, ompConfig: true, project: false });
});

test("a profile with no config does not inherit the default config's advisor", async () => {
  writeFileSync(join(agentDir, "config.yml"), config(true), "utf8");
  profileConfig("work");
  rmSync(join(home, ".omp", "profiles", "work", "agent", "config.yml"), { force: true });
  assert.deepEqual(await get(withProfile.path), { enabled: false, ompConfig: false, project: false });
  assert.deepEqual(await get(missingProfile.path), { enabled: false, ompConfig: false, project: false });
});

test("the project's own advisor flag still applies next to a profile config", async () => {
  profileConfig("lab", false);
  assert.deepEqual(await get(profileAdvisor.path), { enabled: true, ompConfig: false, project: true });
});
