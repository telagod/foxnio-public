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
const route = await jiti.import("../app/api/models-config/route.ts");
const testRoute = await jiti.import("../app/api/models-config/test/route.ts");
const { SECRET_MASK } = await jiti.import("./secret-mask.ts");

const STORED = `providers:
  work:
    baseUrl: https://proxy.internal/v1
    apiKey: sk-live-123
    api: openai-completions
    headers:
      Authorization: Bearer abc
      X-Team: platform
    models:
      - id: gpt
`;

function withModelsFile(contents, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-models-route-"));
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, xdg: process.env.XDG_DATA_HOME };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.XDG_DATA_HOME;
  const path = join(dir, "models.yml");
  if (contents !== undefined) writeFileSync(path, contents, "utf8");
  return Promise.resolve(run(path)).finally(() => {
    for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.agentDir], ["XDG_DATA_HOME", previous.xdg]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

const put = (body, query = "") => route.PUT(new Request(`http://localhost/api/models-config${query}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

test("GET hides secrets and reports the revision of the file", async () => {
  await withModelsFile(STORED, async () => {
    const body = await (await route.GET()).json();
    assert.match(body.revision, /^[0-9a-f]{64}$/);
    assert.equal(body.providers.work.apiKey, SECRET_MASK);
    assert.deepEqual(body.providers.work.headers, { Authorization: SECRET_MASK, "X-Team": "platform" });
    assert.doesNotMatch(JSON.stringify(body), /sk-live-123|Bearer abc/);
  });
});

test("GET of a missing file has a stable revision a first save can use", async () => {
  await withModelsFile(undefined, async (path) => {
    const body = await (await route.GET()).json();
    assert.equal(body.revision, "missing");
    const res = await put({ revision: body.revision, config: { providers: { a: { baseUrl: "https://x/v1", apiKey: "K", api: "openai-completions" } } } });
    assert.equal(res.status, 200);
    assert.match(readFileSync(path, "utf8"), /apiKey: K/);
  });
});

test("saving the GET response unchanged keeps every stored secret", async () => {
  await withModelsFile(STORED, async (path) => {
    const { revision, ...config } = await (await route.GET()).json();
    const res = await put({ revision, config });
    assert.equal(res.status, 200);
    assert.equal(readFileSync(path, "utf8"), STORED);
  });
});

test("an edited secret replaces the stored value and a cleared one removes it", async () => {
  await withModelsFile(STORED, async (path) => {
    const { revision, ...config } = await (await route.GET()).json();
    config.providers.work.headers.Authorization = "Bearer new";
    delete config.providers.work.apiKey;
    config.providers.work.auth = "none";
    const res = await put({ revision, config });
    assert.equal(res.status, 200);
    const saved = readFileSync(path, "utf8");
    assert.match(saved, /Authorization: Bearer new/);
    assert.doesNotMatch(saved, /sk-live-123/);
  });
});

test("a renamed provider keeps its hidden key when renamedFrom is sent", async () => {
  await withModelsFile(STORED, async (path) => {
    const { revision, providers } = await (await route.GET()).json();
    const config = { providers: { moved: providers.work } };

    const refused = await put({ revision, config });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).code, "secret_placeholder_unresolved");
    assert.equal(readFileSync(path, "utf8"), STORED);

    const res = await put({ revision, config, renamedFrom: { moved: "work" } });
    assert.equal(res.status, 200);
    assert.match(readFileSync(path, "utf8"), /moved:[\s\S]*apiKey: sk-live-123/);
  });
});

test("a stale revision is refused with 409 and the file is left alone", async () => {
  await withModelsFile(STORED, async (path) => {
    const { revision, ...config } = await (await route.GET()).json();
    // The omp CLI (or another tab) changes the file after the editor loaded it.
    const concurrent = `${STORED}  other:\n    baseUrl: https://o/v1\n    apiKey: K2\n    api: openai-completions\n    models:\n      - id: m\n`;
    writeFileSync(path, concurrent, "utf8");

    config.providers.work.baseUrl = "https://edited/v1";
    const res = await put({ revision, config });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "models_config_conflict");
    assert.equal(readFileSync(path, "utf8"), concurrent);
  });
});

test("a PUT without a revision is refused instead of overwriting blindly", async () => {
  await withModelsFile(STORED, async (path) => {
    const res = await put({ config: { providers: {} } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "models_config_revision_required");
    assert.equal(readFileSync(path, "utf8"), STORED);
  });
});

test("an unparseable file reports its revision, and is not overwritten without ?overwrite=true", async () => {
  await withModelsFile("providers: [unclosed\n", async (path) => {
    const body = await (await route.GET()).json();
    assert.equal(body.code, "models_config_unparseable");
    assert.match(body.revision, /^[0-9a-f]{64}$/);

    const refused = await put({ revision: body.revision, config: { providers: {} } });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "models_config_unparseable");
    assert.equal(readFileSync(path, "utf8"), "providers: [unclosed\n");

    const res = await put({ revision: body.revision, config: { providers: {} } }, "?overwrite=true");
    assert.equal(res.status, 200);
    assert.equal(readFileSync(`${path}.bak`, "utf8"), "providers: [unclosed\n");
  });
});

test("Test refuses a placeholder it cannot resolve before starting omp", async () => {
  await withModelsFile(STORED, async () => {
    const res = await testRoute.POST(new Request("http://localhost/api/models-config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerName: "unsaved",
        provider: { baseUrl: "https://x/v1", apiKey: SECRET_MASK, api: "openai-completions" },
        model: { id: "m" },
      }),
    }));
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "secret_placeholder_unresolved");
  });
});
