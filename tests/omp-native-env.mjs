import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Isolation for the opt-in tests that launch the real omp executable
// (`lib/omp/*.native.test.mjs`): no credentials, config or provider endpoints
// of the developer's machine may reach the child.

// OMP 18.12.6's supported disabledProviders setting gates implicit probes,
// built-in managers AND credential-free catalog refreshes. Keep the complete
// catalog list (packages/catalog/src/compat/provider-ids.ts), plus llama.cpp,
// rather than merely disabling the three usual localhost inference engines.
export const DISABLED_PROVIDERS = [
  "abliteration", "aiand", "aimlapi", "alibaba-coding-plan", "alibaba-token-plan", "amazon-bedrock",
  "anthropic", "apple", "azure", "baseten", "bedrock-mantle", "cerebras", "charm-hyper", "cline-pass",
  "cloudflare-ai-gateway", "cloudflare-workers-ai", "commandcode", "coralbricks", "coreweave", "cursor",
  "deepinfra", "deepseek", "devin", "factory-droid", "firepass", "fireworks", "github-copilot",
  "gitlab-duo", "gitlab-duo-agent", "gmi-cloud", "google", "google-antigravity", "google-gemini-cli",
  "google-vertex", "groq", "helmcode", "huggingface", "inception", "kilo", "kimi-code", "litellm",
  "llama.cpp", "lm-studio", "local", "meta", "minimax", "minimax-code", "minimax-code-cn", "mistral",
  "moonshot", "muse-code", "nanogpt", "novita", "nvidia", "ollama", "ollama-cloud", "openai",
  "openai-codex", "opencode-go", "opencode-zen", "openrouter", "qianfan", "qwen-portal", "sakana",
  "sambanova", "siliconflow", "siliconflow-cn", "singularityapi-dev", "singularityapi-tech", "snowflake",
  "stepfun", "synthetic", "together", "typesafe", "umans", "venice", "vercel-ai-gateway", "vllm",
  "wafer-serverless", "web", "xai", "xai-oauth", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp", "yolo-auto", "zai", "zenmux", "zhipu-coding-plan",
];

/** The complete environment of an omp child confined to `root`, with `agentDir` as its agent directory. */
export function nativeEnvironment(root, agentDir) {
  // A replacement, not an overlay: an ever-growing credential/endpoint denylist
  // would still leak new providers, auth brokers, proxies or config overlays.
  const env = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, directory] of [
    ["HOME", "home"], ["USERPROFILE", "home"], ["XDG_CONFIG_HOME", "config"],
    ["XDG_CACHE_HOME", "cache"], ["XDG_DATA_HOME", "data"], ["XDG_STATE_HOME", "state"],
    ["TMPDIR", "tmp"], ["TMP", "tmp"], ["TEMP", "tmp"],
  ]) {
    env[key] = join(root, directory);
    mkdirSync(env[key], { recursive: true });
  }
  return { ...env, PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", PI_PROFILE: "" };
}

/**
 * An agent directory whose only model is unreachable: every catalog provider
 * is disabled and the one configured provider points at a closed port, so even
 * a regression that dispatches a prompt cannot reach a real service.
 */
export function writeInertAgentConfig(agentDir, { provider, model, api, apiKey }) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "config.yml"), `disabledProviders: ${JSON.stringify(DISABLED_PROVIDERS)}\n`);
  writeFileSync(join(agentDir, "models.yml"), `providers:
  ${provider}:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: ${apiKey}
    api: ${api}
    models:
      - id: ${model}
        contextWindow: 8192
        maxTokens: 1024
`);
}

export async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
