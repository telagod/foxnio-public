import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { isMap, isScalar, isSeq, parseDocument, stringify, type Document } from "yaml";
import { writeFileAtomic } from "../fs-atomic";
import {
  isSensitiveHeaderName,
  maskStringRecord,
  restoreStringRecord,
  SECRET_MASK,
  UnresolvedSecretError,
} from "../secret-mask";
import { getModelsConfigPath } from "./paths";
import { isRecord } from "../type-guards";

/**
 * Direct YAML access to omp's custom-models file (~/.omp/agent/models.yml).
 * Types and validation mirror the minimal subset of
 * oh-my-pi/packages/coding-agent/src/config/models-config(-schema).ts that the
 * web editor round-trips; unknown fields are preserved untouched.
 */

export interface ModelThinkingConfig {
  mode?: string;
  efforts?: string[];
  defaultLevel?: string;
  effortMap?: Record<string, string>;
  [key: string]: unknown;
}

export interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinking?: ModelThinkingConfig;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  auth?: "apiKey" | "none" | "oauth";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelsFileConfig {
  providers?: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

/** Mirrors validateProviderConfiguration(mode: "models-config") closely enough
 * to reject configs omp itself would refuse to load. Throws on failure. */
export function validateModelsConfig(config: ModelsFileConfig): void {
  if (!isRecord(config)) throw new Error("Config must be an object");
  config = sanitizeModelsConfig(config);
  const providers = config.providers ?? {};
  if (!isRecord(providers)) throw new Error('"providers" must be an object');
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) throw new Error(`Provider ${providerName}: must be an object`);
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (models.length > 0) {
      if (!provider.baseUrl) {
        throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
      }
      if (!provider.apiKey && (provider.auth ?? "apiKey") !== "none") {
        throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models unless auth is "none".`);
      }
    }
    for (const model of models) {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) {
        throw new Error(`Provider ${providerName}: model missing "id"`);
      }
      if (!provider.api && !model.api) {
        throw new Error(`Provider ${providerName}, model ${model.id}: no "api" specified. Set at provider or model level.`);
      }
      if (typeof model.contextWindow === "number" && model.contextWindow <= 0) {
        throw new Error(`Provider ${providerName}, model ${model.id}: invalid contextWindow`);
      }
      if (typeof model.maxTokens === "number" && model.maxTokens <= 0) {
        throw new Error(`Provider ${providerName}, model ${model.id}: invalid maxTokens`);
      }
      // omp's schema requires all four cost fields whenever cost is present
      // (partial costs make omp reject the whole file), so refuse to write one.
      if (isRecord(model.cost)) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = model.cost[key];
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Provider ${providerName}, model ${model.id}: cost.${key} is required (cost needs input, output, cacheRead, and cacheWrite)`);
          }
        }
      }
    }
  }
}

/** Thrown when models.yml exists but cannot be parsed. Overwriting such a file
 * would silently delete every provider the user hand-wrote, so writes refuse
 * unless the caller explicitly opts in. */
export class ModelsConfigParseError extends Error {
  readonly path: string;
  readonly detail: string;
  constructor(path: string, detail: string) {
    super(`${path} is not valid YAML: ${detail}`);
    this.name = "ModelsConfigParseError";
    this.path = path;
    this.detail = detail;
  }
}

/** Revision of a models.yml that does not exist yet. */
export const MISSING_REVISION = "missing";
/** Revision of a models.yml that exists but could not be read. */
const UNREADABLE_REVISION = "unreadable";

/** Thrown when models.yml changed after the caller loaded it. */
export class ModelsConfigConflictError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} changed since it was loaded`);
    this.name = "ModelsConfigConflictError";
    this.path = path;
  }
}

export interface ModelsConfigFile {
  path: string;
  exists: boolean;
  /** sha256 of the file bytes (MISSING_REVISION when absent). A write based on a
   * different revision would silently discard the newer edits. */
  revision: string;
  /** Raw file text, kept so writes can merge into the original document. */
  source?: string;
  /** Empty when `parseError` is set — never write this back over the file. */
  config: ModelsFileConfig;
  parseError?: string;
}

/** Drop empty model rows produced by blank YAML sequence entries or an empty
 * `id`. Malformed non-empty rows are retained so validation can report them. */
function sanitizeModelsConfig(config: ModelsFileConfig): ModelsFileConfig {
  if (!isRecord(config.providers)) return config;
  const providers = Object.fromEntries(Object.entries(config.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));
  return { ...config, providers };
}

/** Read models.yml, reporting rather than swallowing parse failures. */
export function readModelsConfigFile(): ModelsConfigFile {
  const path = getModelsConfigPath();
  if (!existsSync(path)) return { path, exists: false, revision: MISSING_REVISION, config: { providers: {} } };

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { path, exists: true, revision: UNREADABLE_REVISION, config: { providers: {} }, parseError: String(error) };
  }
  const revision = createHash("sha256").update(bytes).digest("hex");
  const source = bytes.toString("utf8");

  // parseDocument collects syntax errors instead of throwing on the first one.
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return { path, exists: true, revision, source, config: { providers: {} }, parseError: doc.errors[0].message };
  }
  const parsed = doc.toJS() as unknown;
  if (parsed === null || parsed === undefined) {
    return { path, exists: true, revision, source, config: { providers: {} } };
  }
  if (!isRecord(parsed)) {
    return {
      path,
      exists: true,
      revision,
      source,
      config: { providers: {} },
      parseError: "the top level of models.yml must be a mapping",
    };
  }
  return { path, exists: true, revision, source, config: sanitizeModelsConfig(parsed as ModelsFileConfig) };
}

/** Tolerant read for consumers that only inspect the config (a broken file
 * reads as empty). Anything that writes the file back must go through
 * readModelsConfigFile()/writeModelsConfig() so a parse error blocks the write. */
export function readModelsConfig(): ModelsFileConfig {
  return readModelsConfigFile().config;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Comments live on the node they follow/precede, so a replaced node has to
 * inherit them or the user's annotations drift onto the wrong key. */
function carryComments(from: unknown, to: unknown): void {
  if (!from || !to || typeof from !== "object" || typeof to !== "object") return;
  const src = from as { comment?: string | null; commentBefore?: string | null; spaceBefore?: boolean };
  const dst = to as { comment?: string | null; commentBefore?: string | null; spaceBefore?: boolean };
  if (src.comment != null) dst.comment = src.comment;
  if (src.commentBefore != null) dst.commentBefore = src.commentBefore;
  if (src.spaceBefore) dst.spaceBefore = src.spaceBefore;
}

function scalarKey(key: unknown): string | undefined {
  if (isScalar(key) && (typeof key.value === "string" || typeof key.value === "number")) {
    return String(key.value);
  }
  return typeof key === "string" ? key : undefined;
}

function itemId(item: unknown): string | undefined {
  if (!isMap(item)) return undefined;
  const value = item.get("id");
  return typeof value === "string" ? value : undefined;
}

/** Rewrite `node` so it represents `value`, reusing the existing AST wherever
 * old and new agree — that reuse is what preserves comments and layout. */
function mergeNode(doc: Document, node: unknown, value: unknown): unknown {
  if (isMap(node) && isPlainRecord(value)) {
    const wanted = new Map(Object.entries(value).filter(([, v]) => v !== undefined));
    // Keys with non-scalar (complex) keys are left alone rather than dropped.
    node.items = node.items.filter((pair) => {
      const key = scalarKey(pair.key);
      return key === undefined || wanted.has(key);
    });
    for (const [key, v] of wanted) {
      const pair = node.items.find((p) => scalarKey(p.key) === key);
      if (pair) pair.value = mergeNode(doc, pair.value, v);
      else node.set(doc.createNode(key), doc.createNode(v));
    }
    return node;
  }

  if (isSeq(node) && Array.isArray(value)) {
    const previous = [...node.items];
    // Match by `id` first: the editor reorders/removes models, and positional
    // matching would move a model's comments onto its neighbour.
    const byId = new Map<string, unknown>();
    for (const item of previous) {
      const id = itemId(item);
      if (id !== undefined && !byId.has(id)) byId.set(id, item);
    }
    node.items = value.map((entry, index) => {
      const id = isPlainRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
      let old: unknown;
      if (id !== undefined) {
        old = byId.get(id);
        if (old !== undefined) byId.delete(id);
      } else {
        old = previous[index];
      }
      return mergeNode(doc, old, entry);
    }) as typeof node.items;
    return node;
  }

  if (isScalar(node) && !isPlainRecord(value) && !Array.isArray(value)) {
    // Keep the original scalar (and its quoting style) only for same-typed
    // values — reusing a quoted string node for a number would re-quote it.
    if (typeof node.value === typeof value) {
      node.value = value;
      return node;
    }
  }

  const created = doc.createNode(value);
  carryComments(node, created);
  return created;
}

/** Serialize a config. When `existingSource` is a parseable document the edit
 * is applied onto it so hand-written comments and formatting survive. */
export function serializeModelsConfig(config: ModelsFileConfig, existingSource?: string): string {
  if (existingSource === undefined || existingSource.trim() === "") return stringify(config);
  const doc = parseDocument(existingSource);
  if (doc.errors.length > 0) return stringify(config);
  if (!isMap(doc.contents)) {
    // Comment-only or non-mapping document: replacing contents still keeps the
    // file's leading comments (they hang off the document, not the node).
    doc.contents = doc.createNode(config) as unknown as typeof doc.contents;
    return doc.toString();
  }
  mergeNode(doc, doc.contents, config);
  return doc.toString();
}

export interface WriteModelsConfigOptions {
  /** Replace an unparseable models.yml instead of refusing — destroys whatever
   * the user has in the file, so only pass it on an explicit user request. */
  overwriteUnparseable?: boolean;
  /** Revision the caller's edit was based on (from readModelsConfigFile()).
   * The write is refused when the file has changed since. */
  expectedRevision?: string;
}

export function writeModelsConfig(config: ModelsFileConfig, options: WriteModelsConfigOptions = {}): void {
  const current = readModelsConfigFile();
  if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
    throw new ModelsConfigConflictError(current.path);
  }
  if (current.parseError && !options.overwriteUnparseable) {
    throw new ModelsConfigParseError(current.path, current.parseError);
  }
  const text = serializeModelsConfig(sanitizeModelsConfig(config), current.parseError ? undefined : current.source);
  // Atomic replace: a crash mid-write must not leave models.yml truncated, which
  // would disable every custom model until the user repairs it by hand. The
  // previous contents stay in models.yml.bak.
  writeFileAtomic(current.path, text, { backup: true });
}

/** Providers' secret-bearing fields, as the models.yml schema defines them:
 * `apiKey`, plus `headers` at provider, model and model-override level. */
interface SecretRewriter {
  apiKey(value: unknown, stored: unknown, location: string): unknown;
  headers(value: Record<string, unknown>, stored: unknown, location: string): Record<string, unknown>;
}

function rewriteProviderSecrets(
  config: ModelsFileConfig,
  stored: ModelsFileConfig | undefined,
  renamedFrom: Record<string, string>,
  rewriter: SecretRewriter,
): ModelsFileConfig {
  if (!isRecord(config.providers)) return config;
  const storedProviders = isRecord(stored?.providers) ? stored.providers : {};
  const providers = Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => {
    if (!isRecord(provider)) return [name, provider];
    const originalName = Object.hasOwn(renamedFrom, name) ? renamedFrom[name] : name;
    const previousProvider = Object.hasOwn(storedProviders, originalName) ? storedProviders[originalName] : undefined;
    const previous: Record<string, unknown> = isRecord(previousProvider) ? previousProvider : {};
    const where = `providers.${name}`;
    const next: Record<string, unknown> = { ...provider };
    if (next.apiKey !== undefined) next.apiKey = rewriter.apiKey(next.apiKey, previous.apiKey, `${where}.apiKey`);
    if (isRecord(next.headers)) next.headers = rewriter.headers(next.headers, previous.headers, `${where}.headers`);
    if (Array.isArray(next.models)) {
      const previousModels = Array.isArray(previous.models) ? previous.models : [];
      next.models = next.models.map((model: unknown) => {
        if (!isRecord(model) || !isRecord(model.headers)) return model;
        const previousModel = previousModels.find((candidate) => isRecord(candidate) && candidate.id === model.id);
        const previousHeaders = isRecord(previousModel) ? previousModel.headers : undefined;
        return { ...model, headers: rewriter.headers(model.headers, previousHeaders, `${where}.models.${String(model.id)}.headers`) };
      });
    }
    if (isRecord(next.modelOverrides)) {
      const previousOverrides = isRecord(previous.modelOverrides) ? previous.modelOverrides : {};
      next.modelOverrides = Object.fromEntries(Object.entries(next.modelOverrides).map(([modelId, override]) => {
        if (!isRecord(override) || !isRecord(override.headers)) return [modelId, override];
        const previousOverride = Object.hasOwn(previousOverrides, modelId) ? previousOverrides[modelId] : undefined;
        const previousHeaders = isRecord(previousOverride) ? previousOverride.headers : undefined;
        return [modelId, { ...override, headers: rewriter.headers(override.headers, previousHeaders, `${where}.modelOverrides.${modelId}.headers`) }];
      }));
    }
    return [name, next];
  }));
  return { ...config, providers };
}

/** Copy of `config` that is safe to send to the browser: every API key and every
 * credential-looking header value is replaced by SECRET_MASK. */
export function maskModelsConfigSecrets(config: ModelsFileConfig): ModelsFileConfig {
  return rewriteProviderSecrets(config, undefined, {}, {
    apiKey: (value) => (typeof value === "string" && value !== "" ? SECRET_MASK : value),
    headers: (value) => maskStringRecord(value, isSensitiveHeaderName),
  });
}

/**
 * Inverse of maskModelsConfigSecrets: every SECRET_MASK in `config` becomes the
 * value `stored` holds for the same field. `renamedFrom` maps a provider's new
 * name to the name it had in `stored`. Throws UnresolvedSecretError when a
 * placeholder has no stored counterpart.
 */
export function restoreModelsConfigSecrets(
  config: ModelsFileConfig,
  stored: ModelsFileConfig,
  renamedFrom: Record<string, string> = {},
): ModelsFileConfig {
  return rewriteProviderSecrets(config, stored, renamedFrom, {
    apiKey: (value, previous, location) => {
      if (value !== SECRET_MASK) return value;
      if (typeof previous !== "string") throw new UnresolvedSecretError(location);
      return previous;
    },
    headers: (value, previous, location) => restoreStringRecord(value, previous, location),
  });
}
