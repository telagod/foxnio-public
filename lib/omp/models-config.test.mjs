import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MISSING_REVISION,
  ModelsConfigConflictError,
  ModelsConfigParseError,
  maskModelsConfigSecrets,
  readModelsConfigFile,
  restoreModelsConfigSecrets,
  serializeModelsConfig,
  validateModelsConfig,
  writeModelsConfig,
} = await jiti.import("./models-config.ts");
const { SECRET_MASK } = await jiti.import("../secret-mask.ts");

// A hand-edited models.yml: comments, blank lines and quoting that a
// parse+stringify round trip would silently throw away.
const HAND_EDITED = `# Custom providers for omp.
# Keep the local llama entry first.

providers:
  local-llama:
    baseUrl: http://127.0.0.1:8080/v1 # llama.cpp server
    apiKey: LLAMA_API_KEY
    api: openai-completions
    models:
      # 70B, quantized
      - id: llama-3.3-70b
        name: "Llama 3.3 70B"
        contextWindow: 131072
        maxTokens: 8192
      # small, fast
      - id: llama-3.2-3b
        name: Llama 3.2 3B
        contextWindow: 32768

  work-proxy:
    baseUrl: https://proxy.internal/v1
    apiKey: "!op read op://work/openai/key"
    api: openai-responses
    models:
      - id: gpt-5
        reasoning: true
`;

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-models-config-"));
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    xdg: process.env.XDG_DATA_HOME,
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.XDG_DATA_HOME;
  try {
    run(dir, join(dir, "models.yml"));
  } finally {
    for (const [key, value] of [
      ["PI_CODING_AGENT_DIR", previous.agentDir],
      ["XDG_DATA_HOME", previous.xdg],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("round-trips a hand-edited models.yml without losing comments", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");

    const file = readModelsConfigFile();
    assert.equal(file.parseError, undefined);
    assert.deepEqual(Object.keys(file.config.providers), ["local-llama", "work-proxy"]);

    // Edit exactly what the editor would: bump a model's maxTokens.
    file.config.providers["local-llama"].models[0].maxTokens = 16384;
    writeModelsConfig(file.config);

    const written = readFileSync(path, "utf8");
    assert.match(written, /# Custom providers for omp\./);
    assert.match(written, /# Keep the local llama entry first\./);
    assert.match(written, /# llama\.cpp server/);
    assert.match(written, /# 70B, quantized/);
    assert.match(written, /maxTokens: 16384/);
    assert.match(written, /apiKey: "!op read op:\/\/work\/openai\/key"/);
    assert.equal(readModelsConfigFile().config.providers["local-llama"].models[0].maxTokens, 16384);
  });
});

test("a save with no edits leaves the file byte-identical", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");
    writeModelsConfig(readModelsConfigFile().config);
    assert.equal(readFileSync(path, "utf8"), HAND_EDITED);
  });
});

test("keeps a model's comments with the model when siblings are removed", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");

    const { config } = readModelsConfigFile();
    // Drop the first model: with positional merging the 3B entry would inherit
    // the 70B node and "# small, fast" would be dropped with it.
    config.providers["local-llama"].models.splice(0, 1);
    writeModelsConfig(config);

    const written = readFileSync(path, "utf8");
    assert.match(written, /# small, fast\n\s+- id: llama-3\.2-3b/);
    assert.doesNotMatch(written, /llama-3\.3-70b/);
    // "# 70B, quantized" preceded the first item, so YAML attaches it to the
    // sequence rather than the item — it survives the deletion by design.
  });
});

test("adds and removes providers", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HAND_EDITED, "utf8");

    const { config } = readModelsConfigFile();
    delete config.providers["work-proxy"];
    config.providers["new-provider"] = {
      baseUrl: "https://api.example.com/v1",
      apiKey: "EXAMPLE_KEY",
      api: "openai-completions",
      models: [{ id: "example-1", contextWindow: 8000 }],
    };
    writeModelsConfig(config);

    const reread = readModelsConfigFile();
    assert.deepEqual(Object.keys(reread.config.providers), ["local-llama", "new-provider"]);
    assert.equal(reread.config.providers["new-provider"].models[0].contextWindow, 8000);
    assert.match(readFileSync(path, "utf8"), /# Custom providers for omp\./);
  });
});

test("reports a parse error instead of an empty config", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "providers:\n  broken: [unclosed\n", "utf8");

    const file = readModelsConfigFile();
    assert.ok(file.parseError, "expected a parse error");
    assert.deepEqual(file.config, { providers: {} });
  });
});

test("refuses to overwrite an unparseable models.yml", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    const broken = "providers:\n  broken: [unclosed\n";
    writeFileSync(path, broken, "utf8");

    assert.throws(
      () => writeModelsConfig({ providers: {} }),
      (error) => error instanceof ModelsConfigParseError,
    );
    assert.equal(readFileSync(path, "utf8"), broken, "the broken file must be left untouched");

    writeModelsConfig({ providers: { a: { baseUrl: "https://x/v1", apiKey: "K", api: "openai-completions" } } }, { overwriteUnparseable: true });
    assert.deepEqual(Object.keys(readModelsConfigFile().config.providers), ["a"]);
  });
});

test("treats a non-mapping models.yml as unparseable", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "- one\n- two\n", "utf8");
    assert.ok(readModelsConfigFile().parseError);
  });
});

test("writes a fresh file when none exists", () => {
  withAgentDir((dir, path) => {
    const file = readModelsConfigFile();
    assert.equal(file.exists, false);
    writeModelsConfig({ providers: { p: { baseUrl: "https://x/v1", apiKey: "K", api: "openai-completions", models: [{ id: "m" }] } } });
    assert.match(readFileSync(path, "utf8"), /id: m/);
  });
});

test("serializeModelsConfig without a source still emits plain YAML", () => {
  const text = serializeModelsConfig({ providers: { p: { api: "openai-completions" } } });
  assert.match(text, /providers:\n {2}p:\n {4}api: openai-completions/);
});

test("validation rejects partial model cost but accepts a complete one", () => {
  const base = {
    providers: {
      p: {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        auth: "none",
        models: [{ id: "m", cost: { input: 1, output: 2 } }],
      },
    },
  };

  assert.throws(
    () => validateModelsConfig(base),
    /cost\.cacheRead is required/,
  );

  validateModelsConfig({
    ...base,
    providers: {
      p: {
        ...base.providers.p,
        models: [{ id: "m", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 2 } }],
      },
    },
  });
});

test("ignores blank model rows while preserving non-empty rows", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "providers:\n  p:\n    models:\n      - id: \"\"\n      - id: \"   \"\n      - id: valid\n", "utf8");

    const file = readModelsConfigFile();
    assert.deepEqual(file.config.providers.p.models.map((model) => model.id), ["valid"]);
    writeModelsConfig(file.config);
    assert.deepEqual(readModelsConfigFile().config.providers.p.models.map((model) => model.id), ["valid"]);
  });
});

const SECRET_YAML = `providers:
  work:
    baseUrl: https://proxy.internal/v1
    apiKey: sk-live-123
    api: openai-completions
    headers:
      Authorization: Bearer abc
      X-Team: platform
    models:
      - id: gpt
        headers:
          X-Api-Key: model-secret
          Accept: application/json
    modelOverrides:
      other:
        headers:
          Cookie: session=1
`;

test("masking hides API keys and credential headers only, without mutating the input", () => {
  withAgentDir((dir, path) => {
    writeFileSync(path, SECRET_YAML, "utf8");
    const { config } = readModelsConfigFile();
    const masked = maskModelsConfigSecrets(config);
    const work = masked.providers.work;
    assert.equal(work.apiKey, SECRET_MASK);
    assert.deepEqual(work.headers, { Authorization: SECRET_MASK, "X-Team": "platform" });
    assert.deepEqual(work.models[0].headers, { "X-Api-Key": SECRET_MASK, Accept: "application/json" });
    assert.deepEqual(work.modelOverrides.other.headers, { Cookie: SECRET_MASK });
    assert.equal(config.providers.work.apiKey, "sk-live-123");
    assert.doesNotMatch(JSON.stringify(masked), /sk-live-123|Bearer abc|model-secret|session=1/);
  });
});

test("env-var and command forms of apiKey are masked like any other key", () => {
  const masked = maskModelsConfigSecrets({ providers: { a: { apiKey: "OPENAI_API_KEY" }, b: { apiKey: "!op read op://k" }, c: { apiKey: "" } } });
  assert.equal(masked.providers.a.apiKey, SECRET_MASK);
  assert.equal(masked.providers.b.apiKey, SECRET_MASK);
  assert.equal(masked.providers.c.apiKey, "");
});

test("restoring a masked config returns the stored secrets; edits replace and clears remove", () => {
  withAgentDir((dir, path) => {
    writeFileSync(path, SECRET_YAML, "utf8");
    const stored = readModelsConfigFile().config;

    assert.deepEqual(restoreModelsConfigSecrets(maskModelsConfigSecrets(stored), stored), stored);

    const edited = maskModelsConfigSecrets(stored);
    edited.providers.work.headers.Authorization = "Bearer new";
    delete edited.providers.work.apiKey;
    const restored = restoreModelsConfigSecrets(edited, stored);
    assert.equal(restored.providers.work.headers.Authorization, "Bearer new");
    assert.equal(restored.providers.work.apiKey, undefined);
    assert.equal(restored.providers.work.models[0].headers["X-Api-Key"], "model-secret");

    const replaced = maskModelsConfigSecrets(stored);
    replaced.providers.work.apiKey = "sk-new";
    assert.equal(restoreModelsConfigSecrets(replaced, stored).providers.work.apiKey, "sk-new");
  });
});

test("a renamed provider keeps its secrets through renamedFrom; unknown placeholders are refused", () => {
  withAgentDir((dir, path) => {
    writeFileSync(path, SECRET_YAML, "utf8");
    const stored = readModelsConfigFile().config;
    const renamed = { providers: { moved: maskModelsConfigSecrets(stored).providers.work } };

    const restored = restoreModelsConfigSecrets(renamed, stored, { moved: "work" });
    assert.equal(restored.providers.moved.apiKey, "sk-live-123");
    assert.equal(restored.providers.moved.headers.Authorization, "Bearer abc");

    assert.throws(() => restoreModelsConfigSecrets(renamed, stored), { code: "secret_placeholder_unresolved" });
    const renamedModel = structuredClone(maskModelsConfigSecrets(stored));
    renamedModel.providers.work.models[0].id = "other-id";
    assert.throws(() => restoreModelsConfigSecrets(renamedModel, stored), { code: "secret_placeholder_unresolved" });
    assert.throws(
      () => restoreModelsConfigSecrets({ providers: { fresh: { apiKey: SECRET_MASK } } }, stored),
      { code: "secret_placeholder_unresolved" },
    );
  });
});

test("revision identifies the file bytes and guards writes against stale edits", () => {
  withAgentDir((dir, path) => {
    assert.equal(readModelsConfigFile().revision, MISSING_REVISION);

    writeFileSync(path, SECRET_YAML, "utf8");
    const loaded = readModelsConfigFile();
    assert.match(loaded.revision, /^[0-9a-f]{64}$/);
    assert.equal(readModelsConfigFile().revision, loaded.revision);

    // Someone else edits the file after the editor loaded it.
    writeFileSync(path, `${SECRET_YAML}  extra:\n    baseUrl: http://x/v1\n`, "utf8");
    const edited = { providers: { work: { ...loaded.config.providers.work, baseUrl: "https://other/v1" } } };
    assert.throws(
      () => writeModelsConfig(edited, { expectedRevision: loaded.revision }),
      (error) => error instanceof ModelsConfigConflictError,
    );
    assert.match(readFileSync(path, "utf8"), /extra:/);

    writeModelsConfig(edited, { expectedRevision: readModelsConfigFile().revision });
    assert.equal(readModelsConfigFile().config.providers.work.baseUrl, "https://other/v1");
  });
});

test("saving keeps the previous file as models.yml.bak", () => {
  withAgentDir((dir, path) => {
    writeFileSync(path, SECRET_YAML, "utf8");
    const { config } = readModelsConfigFile();
    writeModelsConfig({ providers: { work: { ...config.providers.work, baseUrl: "https://changed/v1" } } });
    assert.equal(readFileSync(`${path}.bak`, "utf8"), SECRET_YAML);
    assert.match(readFileSync(path, "utf8"), /https:\/\/changed\/v1/);
  });
});

test("saving keeps models.yml private", { skip: process.platform === "win32" }, () => {
  withAgentDir((dir, path) => {
    writeModelsConfig({ providers: { a: { baseUrl: "https://x/v1", apiKey: "K", api: "openai-completions" } } });
    assert.equal(statSync(path).mode & 0o777, 0o600);

    chmodSync(path, 0o640);
    writeModelsConfig({ providers: { a: { baseUrl: "https://y/v1", apiKey: "K", api: "openai-completions" } } });
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.equal(statSync(`${path}.bak`).mode & 0o777, 0o640);
  });
});
