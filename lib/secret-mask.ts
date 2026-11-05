/**
 * Placeholder protocol for secrets that the server stores but never sends back.
 *
 * GET endpoints replace a stored secret with SECRET_MASK. A PUT that echoes the
 * placeholder unchanged keeps the stored value; any other value replaces it, and
 * an empty value removes it. Free of Node built-ins so the browser can import
 * the sentinel.
 */
export const SECRET_MASK = "__foxnio_secret_unchanged__";

const SENSITIVE_HEADER = /authorization|api[-_]?key|token|secret|cookie/i;
const SENSITIVE_ENV = /key|token|secret|password|credential/i;

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER.test(name);
}

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV.test(name);
}

/** A PUT carried the placeholder for a secret the server has no stored value for
 * (renamed or newly created entry), so there is nothing to keep. */
export class UnresolvedSecretError extends Error {
  readonly code = "secret_placeholder_unresolved";
  readonly location: string;
  constructor(location: string) {
    super(`${location}: the stored secret is unavailable for this entry, enter the value again`);
    this.name = "UnresolvedSecretError";
    this.location = location;
  }
}

/** Name-based, so a route still recognizes the error when another copy of this module threw it (separate bundler layers, test loaders). */
export function isUnresolvedSecretError(error: unknown): error is UnresolvedSecretError {
  return error instanceof UnresolvedSecretError || (error instanceof Error && error.name === "UnresolvedSecretError");
}

/** Replace every non-empty value whose name is sensitive with the placeholder. */
export function maskStringRecord(record: Record<string, unknown>, isSensitive: (name: string) => boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([name, value]) => [
    name,
    typeof value === "string" && value !== "" && isSensitive(name) ? SECRET_MASK : value,
  ]));
}

/** Swap placeholders in `incoming` for the values in `stored`. */
export function restoreStringRecord(
  incoming: Record<string, unknown>,
  stored: unknown,
  location: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(incoming).map(([name, value]) => {
    if (value !== SECRET_MASK) return [name, value];
    const previous = typeof stored === "object" && stored !== null && Object.hasOwn(stored, name)
      ? (stored as Record<string, unknown>)[name]
      : undefined;
    if (typeof previous !== "string") throw new UnresolvedSecretError(`${location}.${name}`);
    return [name, previous];
  }));
}
