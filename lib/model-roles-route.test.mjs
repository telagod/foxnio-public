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
const route = await jiti.import("../app/api/model-roles/route.ts");

function withConfig(contents, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-roles-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const path = join(dir, "config.yml");
  writeFileSync(path, contents, "utf8");
  return Promise.resolve(run(path)).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

const put = (body) => route.PUT(new Request("http://localhost/api/model-roles", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

test("PUT merges the changed roles into what is on disk and returns the result", async () => {
  await withConfig("modelRoles:\n  default: a/one\n  plan: a/plan\n", async () => {
    const res = await put({ changes: { default: "b/two", smol: "b/small" } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).roles, { default: "b/two", plan: "a/plan", smol: "b/small" });
    assert.deepEqual((await (await route.GET()).json()).roles, { default: "b/two", plan: "a/plan", smol: "b/small" });
  });
});

test("an empty selector removes a role", async () => {
  await withConfig("modelRoles:\n  default: a/one\n  plan: a/plan\n", async () => {
    const res = await put({ changes: { plan: "" } });
    assert.deepEqual((await res.json()).roles, { default: "a/one" });
  });
});

test("the old whole-map body and malformed changes are refused without touching the file", async () => {
  const source = "modelRoles:\n  default: a/one\n";
  await withConfig(source, async (path) => {
    for (const body of [{ roles: { default: "x/y" } }, { changes: [] }, { changes: { default: 5 } }, { changes: { " ": "a/b" } }, null]) {
      const res = await put(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(readFileSync(path, "utf8"), source);
  });
});
