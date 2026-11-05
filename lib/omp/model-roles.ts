import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { isMap, parseDocument } from "yaml";
import { writeFileAtomic } from "../fs-atomic";
import { getAgentDir } from "./paths";
import { isRecord } from "../type-guards";

export type ModelRoles = Record<string, string>;

function configPath(): string {
  return join(getAgentDir(), "config.yml");
}

/** Reads the native OMP role selectors from config.yml without touching other settings. */
export function readModelRoles(): { path: string; roles: ModelRoles } {
  const path = configPath();
  if (!existsSync(path)) return { path, roles: {} };
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  const data = doc.toJS();
  if (!isRecord(data) || !isRecord(data.modelRoles)) return { path, roles: {} };
  return {
    path,
    roles: Object.fromEntries(Object.entries(data.modelRoles).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

/**
 * Applies role changes to modelRoles inside one read-modify-write of config.yml:
 * a non-empty selector sets a role, an empty one removes it, and every role not
 * named in `changes` keeps whatever is on disk now (another tab, the omp CLI).
 * Returns the resulting roles. The user's remaining native OMP config and
 * comments are preserved.
 */
export function updateModelRoles(changes: ModelRoles): ModelRoles {
  const path = configPath();
  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
  if (!isMap(doc.get("modelRoles", true))) doc.set("modelRoles", doc.createNode({}));
  for (const [role, selector] of Object.entries(changes)) {
    if (selector.trim()) doc.setIn(["modelRoles", role], selector.trim());
    else doc.deleteIn(["modelRoles", role]);
  }
  writeFileAtomic(path, doc.toString());
  return readModelRoles().roles;
}

export function readDisabledProviders(): Set<string> {
  const path = configPath();
  if (!existsSync(path)) return new Set();
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  const data = doc.toJS();
  if (!isRecord(data) || !Array.isArray(data.disabledProviders)) return new Set();
  return new Set(data.disabledProviders.filter((provider): provider is string => typeof provider === "string"));
}

/** Re-enable a provider after a successful native OMP login. */
export function enableProvider(provider: string): void {
  const path = configPath();
  if (!existsSync(path)) return;
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
  const data = doc.toJS();
  const disabled = isRecord(data) && Array.isArray(data.disabledProviders)
    ? data.disabledProviders.filter((value): value is string => typeof value === "string")
    : [];
  const next = disabled.filter((value) => value !== provider);
  if (next.length === disabled.length) return;
  doc.set("disabledProviders", next);
  writeFileAtomic(path, doc.toString());
}
