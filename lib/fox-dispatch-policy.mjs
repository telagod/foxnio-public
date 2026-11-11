import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { comparableProjectPath } from "./comparable-path.ts";

/** @param {string} cwd */
export function canonicalFoxProjectPath(cwd) {
  return comparableProjectPath(realpathSync.native(cwd));
}

/** Resolve stored aliases without rewriting operator policy or native grants. */
/** @param {unknown} policies @param {string} projectKey @returns {"observe" | "confirm" | "auto"} */
export function foxDispatchPolicyForKey(policies, projectKey) {
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) return "confirm";
  const values = policies;
  /** @param {unknown} value @returns {"observe" | "confirm" | "auto"} */
  const sanitize = (value) => value === "auto" || value === "confirm" ? value : "observe";
  const exact = Object.prototype.hasOwnProperty.call(values, projectKey) ? sanitize(values[projectKey]) : undefined;
  let result = exact;
  /** @type {"observe" | "confirm" | "auto" | undefined} */
  let unresolved;
  for (const [storedKey, value] of Object.entries(values)) {
    if (result === "observe") return result;
    let matches = comparableProjectPath(storedKey) === projectKey;
    if (!matches && isAbsolute(storedKey)) {
      try { matches = canonicalFoxProjectPath(storedKey) === projectKey; }
      catch {
        const policy = sanitize(value);
        if (policy === "observe" || unresolved === undefined || policy === "confirm" && unresolved === "auto") unresolved = policy;
        continue;
      }
    }
    if (!matches) continue;
    const policy = sanitize(value);
    if (policy === "observe" || result === undefined || policy === "confirm" && result === "auto") result = policy;
  }
  // Keep exact policy on lookup failure. Without it, an unverified restrictive
  // alias cannot be discarded to infer broader permission from another alias.
  if (exact === undefined && unresolved === "observe") return "observe";
  return result === "auto" && unresolved !== undefined && exact === undefined ? "confirm" : result ?? "confirm";
}
